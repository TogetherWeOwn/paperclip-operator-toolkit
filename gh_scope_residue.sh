#!/usr/bin/env bash
# ===========================================================================
# Board-side scope-residue check for gh-token-broker  (TOG-226 item 3)
#
# THE STANDING GATE THIS EXISTS FOR. The broker refuses to mint without a
# repository scope, and it derives that scope from the issue's project
# (`GH_APP_REPOS`). An issue with no `projectId` therefore gets
#
#     409 Refusing to mint: no repository scope could be derived
#
# which is harmless while `GH_APP_TOKEN_SOURCE=auto` still falls back to the
# PEM, and terminal the moment the PEM is unbound. TOG-226 item 3 says to
# "re-run the count before each unbind". This is that count, as a command.
#
# IT IS A STANDING CHECK, NOT A ONE-OFF. The 2026-08-23 sweep drove the
# residue to zero. Within five hours it was four again — TOG-289 and TOG-290
# were filed project-less, and TOG-289 had already pushed a branch to this
# repo. The residue regenerates every time an issue is filed without a
# project, so a number measured once proves nothing about the next unbind.
#
# WHAT COUNTS AS RESIDUE — and the over-count trap. Grepping open issues for
# git-ish words finds ~25 of 66; only 4 are real. The difference is whether
# the code the issue names is IN THE INSTALLATION:
#
#   in scope      an issue naming `paperclip-ops-tooling`, `two-bot`, …
#                 -> real residue, fix by attaching it to the project that
#                    pins that repo
#   out of scope  an issue naming Paperclip control-plane paths
#                 (`server/src/services/secrets.ts`), an upstream vendor
#                 (`omniroute@3.8.49`, `open-sse/…`), or an operator-side
#                 file (`/paperclip/operator-handoff/…`)
#                 -> NOT residue. No token in this installation can reach
#                    that code, so the 409 is the correct answer forever and
#                    attaching a project would only mint a useless token.
#   no git work   -> NOT residue. The 409 is correct.
#
# Counting class 2 as a gap is what makes this look six times worse than it
# is, and it sends you looking for a broker fix that cannot exist.
#
# WHY THERE ARE TWO DETECTORS. The obvious one — scan issue text for a repo
# name — MISSES the case that motivated this script. TOG-289 names no repo
# anywhere in its title or body, and it had a branch pushed to
# paperclip-ops-tooling. Text alone scores it clean. So:
#
#   --board     (default) scan open project-less issues for a repo in the
#               mintable set. No credential of any kind. Mints nothing.
#   --branches  additionally ask GitHub for `tog-<n>-*` branches in each
#               in-scope repo. A branch in repo R for issue N is proof that
#               N does git work in R, whatever its text says.
#
# Neither detector is complete on its own and the union is still a FLOOR, not
# a proof: an issue that will do git work, names no repo, and has not pushed
# yet is invisible to both. Treat a zero as "nothing known to be broken",
# never as "safe to unbind".
#
# THIS SCRIPT MINTS NOTHING, EVER. --branches uses a token the caller already
# has, from $GH_TOKEN. It will not call gh_token.sh or gh-app-token.js, so it
# is safe to run in a loop and in CI without widening any blast radius. It
# pairs with `gh-app-token.js scope-check` (TOG-238), which answers the other
# half — whether a given ENVIRONMENT survives strict mode — also without
# minting. This one answers whether the BOARD is ready.
#
# NO CREDENTIAL REACHES argv. Not $PAPERCLIP_API_KEY, not $GH_TOKEN.
# /proc/<pid>/cmdline is world-readable and this host is shared, so both
# bearers go into a 0600 `curl --config` file exactly as gh_token.sh does
# (TOG-200). Enforced by ./test_gh_scope_residue.sh against the kernel's own
# record of curl's argv.
#
# Exit status:  0 no residue    1 residue found    2 usage or config error
#
# Requires bash, curl, jq. No node. No GitHub credential unless --branches.
# ===========================================================================
set -uo pipefail

MODE_BRANCHES=0
OUTPUT=table
ONLY_REPOS=""

usage() {
  cat >&2 <<'EOF'
usage: gh_scope_residue.sh [--branches] [--repos a,b] [--json]

  --branches   also check GitHub for tog-<n>-* branches in the in-scope repos
               (requires $GH_TOKEN; this script never mints one itself)
  --repos a,b  limit the branch check to these repos. Use when your token is
               scoped to a subset — the result is then reported as PARTIAL
               and exits 3, because a partial sweep is not a gate pass.
  --json       emit the residue as JSON instead of a table

Reads the board through $PAPERCLIP_API_URL with $PAPERCLIP_API_KEY.

Exit 0 = gate passed (full coverage, no residue)
     1 = residue found
     2 = usage or config error, or a repo that could not be read
     3 = inconclusive: no residue seen, but coverage was partial
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branches) MODE_BRANCHES=1 ;;
    --board)    MODE_BRANCHES=0 ;;
    --repos)    shift; [[ $# -gt 0 ]] || { echo "ERROR: --repos needs a value" >&2; exit 2; }
                ONLY_REPOS="$1"; MODE_BRANCHES=1 ;;
    --json)     OUTPUT=json ;;
    -h|--help)  usage; exit 2 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool is required" >&2; exit 2; }
done

# --- offline seams ---------------------------------------------------------
# The suite has to exercise the real classifier, not a reimplementation of it,
# so the two HTTP reads are the only things it replaces. Point these at a file
# and no socket is opened. Unset in normal use.
PROJECTS_FIXTURE="${SCOPE_RESIDUE_PROJECTS_JSON:-}"
ISSUES_FIXTURE="${SCOPE_RESIDUE_ISSUES_JSON:-}"
BRANCHES_FIXTURE="${SCOPE_RESIDUE_BRANCHES_JSON:-}"

# --- credentials never reach argv (TOG-200) --------------------------------
# Same mechanism, and the same reasoning, as gh_token.sh: only the config
# PATH is in argv. One 0700 per-process directory created before any subshell
# exists, because a config file created inside a command substitution cannot
# be cleaned up by a trap in the parent — a subshell resets trapped signals to
# their default disposition, and every call below runs in a substitution.
CFG_DIR="$(umask 077; mktemp -d "${TMPDIR:-/tmp}/gh_scope_residue.XXXXXXXX")" \
  || { echo "ERROR: could not create a private temp directory" >&2; exit 2; }
cleanup_cfg() { rm -rf "$CFG_DIR"; return 0; }
trap 'cleanup_cfg' EXIT
trap 'cleanup_cfg; exit 130' INT
trap 'cleanup_cfg; exit 143' TERM
trap 'cleanup_cfg; exit 129' HUP

# curl_authed <bearer> <url> [extra headers...]
curl_authed() {
  local bearer="$1" url="$2"; shift 2
  local cfg rc h
  cfg="$(umask 077; mktemp "$CFG_DIR/curlcfg.XXXXXXXX")" \
    || { echo "ERROR: could not create a curl config file" >&2; exit 2; }
  chmod 0600 "$cfg"
  {
    printf 'url = "%s"\n' "$url"
    printf 'request = "GET"\n'
    printf 'header = "Authorization: Bearer %s"\n' "$bearer"
    for h in "$@"; do printf 'header = "%s"\n' "$h"; done
    printf 'silent\nshow-error\n'
  } > "$cfg"
  curl --config "$cfg"
  rc=$?
  rm -f "$cfg"
  return $rc
}

# --- board reads -----------------------------------------------------------
api_base() {
  local b="${PAPERCLIP_API_URL:-}"
  b="${b%/}"; b="${b%/api}"
  printf '%s' "$b"
}

fetch_projects() {
  if [[ -n "$PROJECTS_FIXTURE" ]]; then cat "$PROJECTS_FIXTURE"; return $?; fi
  : "${PAPERCLIP_API_KEY:?missing PAPERCLIP_API_KEY}"
  : "${PAPERCLIP_COMPANY_ID:?missing PAPERCLIP_COMPANY_ID}"
  curl_authed "$PAPERCLIP_API_KEY" "$(api_base)/api/companies/$PAPERCLIP_COMPANY_ID/projects"
}

fetch_issues() {
  if [[ -n "$ISSUES_FIXTURE" ]]; then cat "$ISSUES_FIXTURE"; return $?; fi
  : "${PAPERCLIP_API_KEY:?missing PAPERCLIP_API_KEY}"
  : "${PAPERCLIP_COMPANY_ID:?missing PAPERCLIP_COMPANY_ID}"
  curl_authed "$PAPERCLIP_API_KEY" "$(api_base)/api/companies/$PAPERCLIP_COMPANY_ID/issues"
}

# Both endpoints have been observed returning a bare array; tolerate the
# wrapped shapes too rather than silently reading zero rows off the wrong key.
unwrap() { jq 'if type=="array" then . else (.projects // .issues // .data // []) end'; }

# EVERYTHING BELOW GOES THROUGH FILES, NEVER --argjson.
#
# This is not style. The first live run of this script against the real board
# died with `jq: Argument list too long` — 300 issues with full descriptions
# blow past ARG_MAX — and then printed "no scope residue" and exited 0.
# It failed OPEN, on the exact path whose entire job is to gate a credential
# unbind, and it did so only at production size: the fixtures were small
# enough to pass. --slurpfile has no such ceiling.
#
# Paired with guard() below, because a jq that dies must never leave an empty
# residue looking like a clean board.
PROJECTS_FILE="$CFG_DIR/projects.json"
ISSUES_FILE="$CFG_DIR/issues.json"

fetch_projects | unwrap > "$PROJECTS_FILE" \
  || { echo "ERROR: could not read projects" >&2; exit 2; }
fetch_issues | unwrap > "$ISSUES_FILE" \
  || { echo "ERROR: could not read issues" >&2; exit 2; }

for f in "$PROJECTS_FILE" "$ISSUES_FILE"; do
  jq -e 'type=="array"' "$f" >/dev/null 2>&1 \
    || { echo "ERROR: unexpected response shape from $(basename "$f" .json)" >&2; exit 2; }
done

# guard <label> — run jq, and treat any failure as fatal rather than as an
# empty result. An empty result here reads as "clean board", which is the one
# answer this script must never give by accident.
guard() {
  local label="$1"; shift
  local out
  out="$("$@")" || { echo "ERROR: $label failed" >&2; exit 2; }
  [[ -n "$out" ]] || { echo "ERROR: $label produced nothing" >&2; exit 2; }
  printf '%s' "$out"
}

# repo -> project map. GH_APP_REPOS is a secret-ref object ({type,value}) on
# every project today, but accept a plain string so a future shape change
# degrades to "repo not in scope" rather than a jq type error mid-sweep.
REPO_MAP="$(guard 'repo map' jq -c '
  [ .[]
    | . as $p
    | ((.env.GH_APP_REPOS.value // .env.GH_APP_REPOS // "") | tostring)
    | select(length > 0)
    | split(",")[]
    | (. | gsub("^\\s+|\\s+$";""))
    | select(length > 0)
    | {repo: ., projectId: $p.id, project: $p.name}
  ]' "$PROJECTS_FILE")"

REPO_MAP_FILE="$CFG_DIR/repomap.json"
printf '%s' "$REPO_MAP" > "$REPO_MAP_FILE"

if [[ "$(printf '%s' "$REPO_MAP" | jq 'length')" -eq 0 ]]; then
  echo "ERROR: no project pins GH_APP_REPOS — nothing is mintable, refusing to report a clean sweep" >&2
  exit 2
fi

# --- detector 1: the issue names a repo in the mintable set ----------------
# Longest repo name first: `two-bot` must not shadow a hypothetical
# `two-bot-legacy`, and the broker would scope those differently.
NAMED="$(guard 'named detector' jq -c -n \
  --slurpfile issues "$ISSUES_FILE" \
  --slurpfile repos "$REPO_MAP_FILE" '
  ($issues[0]) as $issues | ($repos[0]) as $repos
  | ["todo","backlog","in_progress","in_review","blocked"] as $open
  | ($repos | sort_by(-(.repo|length))) as $r
  | [ $issues[]
      | select((.projectId // "") == "")
      | select(.status as $s | $open | index($s))
      | . as $i
      | (($i.title // "") + "\n" + ($i.description // "")) as $text
      | ( [ $r[] | . as $rr | select( $text | contains($rr.repo) ) ][0] ) as $hit
      | select($hit != null)
      | {issue: $i.issueNumber, status: $i.status, repo: $hit.repo,
         project: $hit.project, projectId: $hit.projectId, via: "named"}
    ]')"

# --- detector 2: a branch exists for the issue in an in-scope repo ---------
BRANCHED='[]'
if [[ "$MODE_BRANCHES" -eq 1 ]]; then
  fetch_branches() {
    local repo="$1"
    if [[ -n "$BRANCHES_FIXTURE" ]]; then
      jq -c --arg r "$repo" '.[$r] // []' "$BRANCHES_FIXTURE"; return $?
    fi
    : "${GH_TOKEN:?--branches needs \$GH_TOKEN (this script will not mint one)}"
    local org="${GH_APP_ORG:-TogetherWeOwn}" page=1 out='[]' body
    # Paginate to exhaustion. A truncated first page would silently under-report
    # exactly the branches filed most recently, which are the ones at issue.
    while :; do
      body="$(curl_authed "$GH_TOKEN" \
        "https://api.github.com/repos/$org/$repo/branches?per_page=100&page=$page" \
        "Accept: application/vnd.github+json" "X-GitHub-Api-Version: 2022-11-28")" || return 1
      printf '%s' "$body" | jq -e 'type=="array"' >/dev/null 2>&1 || return 1
      out="$(jq -c -n --argjson a "$out" --argjson b "$body" '$a + [$b[].name]')"
      [[ "$(printf '%s' "$body" | jq 'length')" -eq 100 ]] || break
      page=$((page+1))
    done
    printf '%s' "$out"
  }

  # WHY --repos EXISTS, AND WHY A PARTIAL SWEEP IS NOT A PASS.
  # Every agent's token is scoped to its own project's GH_APP_REPOS, so no
  # agent can list branches across all eight repos — and a token that could
  # is exactly the org-wide blast radius TOG-174 is removing. Measured: this
  # run is scoped to paperclip-ops-tooling and gets "Resource not accessible"
  # on kofra. So the full sweep belongs host-side (CI or the operator), and
  # an agent runs the slice it is scoped for. The union of slices is the gate.
  # Coverage is tracked and reported, because "no residue in the one repo I
  # could see" must never print the same as "no residue anywhere".
  ALL_REPOS="$(printf '%s' "$REPO_MAP" | jq -r '.[].repo' | sort -u)"
  REPOS_TOTAL="$(printf '%s\n' "$ALL_REPOS" | grep -c .)"

  if [[ -n "$ONLY_REPOS" ]]; then
    SELECTED="$(printf '%s' "$ONLY_REPOS" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep . | sort -u)"
    while read -r r; do
      [[ -n "$r" ]] || continue
      printf '%s\n' "$ALL_REPOS" | grep -qx -- "$r" \
        || { echo "ERROR: --repos names '$r', which no project pins" >&2; exit 2; }
    done <<< "$SELECTED"
  else
    SELECTED="$ALL_REPOS"
  fi
  REPOS_CHECKED="$(printf '%s\n' "$SELECTED" | grep -c .)"

  ALL_BRANCHES='{}'
  while read -r repo; do
    [[ -n "$repo" ]] || continue
    names="$(fetch_branches "$repo")" || {
      # Fail closed. A repo we could not read is a repo whose residue is
      # unknown, and reporting "clean" for it is the one wrong answer.
      echo "ERROR: could not list branches for $repo" >&2; exit 2; }
    ALL_BRANCHES="$(jq -c -n --argjson m "$ALL_BRANCHES" --arg r "$repo" \
      --argjson n "$names" '$m + {($r): $n}')"
  done <<< "$SELECTED"

  BRANCHES_FILE_TMP="$CFG_DIR/branches.json"
  printf '%s' "$ALL_BRANCHES" > "$BRANCHES_FILE_TMP"

  BRANCHED="$(guard 'branch detector' jq -c -n \
    --slurpfile issues "$ISSUES_FILE" \
    --slurpfile repos "$REPO_MAP_FILE" \
    --slurpfile branches "$BRANCHES_FILE_TMP" '
    ($issues[0]) as $issues | ($repos[0]) as $repos | ($branches[0]) as $branches
    | ["todo","backlog","in_progress","in_review","blocked"] as $open
    | [ $branches | to_entries[]
        | .key as $repo
        | .value[]
        | . as $bname
        | ($bname | capture("^tog-(?<n>[0-9]+)-"; "i") | .n | tonumber) as $num
        | ($issues[] | select(.issueNumber == $num)) as $i
        | select((($i.projectId // "") == "") and ($i.status as $s | $open | index($s)))
        | ($repos[] | select(.repo == $repo)) as $hit
        | {issue: $i.issueNumber, status: $i.status, repo: $repo,
           project: $hit.project, projectId: $hit.projectId, via: ("branch:" + $bname)}
      ]')"
fi

RESIDUE="$(jq -c -n --argjson a "$NAMED" --argjson b "$BRANCHED" '
  ($a + $b)
  | group_by(.issue)
  | map( (.[0]) + {via: (map(.via) | join(", "))} )
  | sort_by(.issue)')"

COUNT="$(printf '%s' "$RESIDUE" | jq 'length')"

# Coverage. Text-only is inherently partial — it cannot see a TOG-289 — so a
# clean text-only run is never a gate pass either.
REPOS_TOTAL="${REPOS_TOTAL:-0}"
REPOS_CHECKED="${REPOS_CHECKED:-0}"
if [[ "$MODE_BRANCHES" -eq 1 && "$REPOS_CHECKED" -eq "$REPOS_TOTAL" && "$REPOS_TOTAL" -gt 0 ]]; then
  COVERAGE=full
else
  COVERAGE=partial
fi

if [[ "$OUTPUT" == json ]]; then
  jq -n --argjson r "$RESIDUE" --argjson c "$COUNT" --argjson b "$MODE_BRANCHES" \
        --arg cov "$COVERAGE" --argjson rc "$REPOS_CHECKED" --argjson rt "$REPOS_TOTAL" \
    '{residue: $r, count: $c, branchesChecked: ($b == 1),
      coverage: $cov, reposChecked: $rc, reposTotal: $rt}'
else
  scanned="$(guard 'scan count' jq '
    ["todo","backlog","in_progress","in_review","blocked"] as $open
    | [ .[] | select((.projectId // "") == "")
            | select(.status as $s | $open | index($s)) ] | length' "$ISSUES_FILE")"
  echo "open project-less issues scanned: $scanned"
  if [[ "$MODE_BRANCHES" -eq 1 ]]; then
    echo "branch detector: on — $REPOS_CHECKED of $REPOS_TOTAL in-scope repos checked"
  else
    echo "branch detector: off (text only — see --branches)"
  fi
  echo "coverage: $COVERAGE"
  echo
  if [[ "$COUNT" -eq 0 ]]; then
    if [[ "$COVERAGE" == full ]]; then
      echo "GATE PASSED: no open project-less issue needs a repo in the installation."
    else
      echo "INCONCLUSIVE: no residue seen, but coverage was partial — this is not a gate pass."
      [[ "$MODE_BRANCHES" -eq 1 ]] \
        || echo "  run again with --branches; text alone cannot see an issue that names no repo."
    fi
    echo "(a floor, not a proof — an issue that names no repo and has not pushed is invisible here)"
  else
    printf '%-9s %-12s %-24s %-22s %s\n' ISSUE STATUS REPO 'ATTACH TO' EVIDENCE
    printf '%s' "$RESIDUE" | jq -r '.[] | [("TOG-"+(.issue|tostring)), .status, .repo, .project, .via] | @tsv' \
      | while IFS=$'\t' read -r a b c d e; do printf '%-9s %-12s %-24s %-22s %s\n' "$a" "$b" "$c" "$d" "$e"; done
    echo
    echo "fix: PATCH /api/issues/<id> {\"projectId\":\"<ATTACH TO id>\"} — do NOT add a company-wide"
    echo "default repo list, which would re-widen exactly the scope TOG-174 narrowed."
  fi
fi

[[ "$COUNT" -gt 0 ]] && exit 1
[[ "$COVERAGE" == full ]] && exit 0
exit 3
