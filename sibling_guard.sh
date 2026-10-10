#!/usr/bin/env bash
set -uo pipefail

# ===========================================================================
# SIBLING-RUN GUARD  (TOG-345)
#
# THE INCIDENT THIS EXISTS FOR. TOG-258 was implemented end to end, twice,
# independently, by two runs of the SAME agent. Both produced a branch, both
# opened a PR. #27 merged; #28 was closed as a duplicate after diffing to two
# cosmetic wording differences. TOG-253 (PRs #15/#16) is the same incident with
# different numbers. Each costs a full implementation and a full CI cycle.
#
# The losing run on TOG-258 DID check for a sibling. It looked at the two
# signals a shell in this container makes obvious, and both lied:
#
#   ps -eo pid,etime,args   returns NOTHING in the agent container — not even
#                           the calling process. Sibling runs live in other
#                           containers. An empty process list is not evidence of
#                           absence, but it reads exactly like it.
#   worktree file mtimes    were minutes old. That is normal for a live run
#                           parked on a CI poll or a model call, which is what
#                           it was.
#
# So the local signals available at the time were: one that is silently always
# empty, and one that is indistinguishable from a live run. Neither
# discriminates, and "I checked and found nothing" was the wrong conclusion from
# both. THIS TOOL NEVER CONSULTS `ps`. If you find yourself adding it, read the
# paragraph above again.
#
# ---------------------------------------------------------------------------
# THREE DETECTORS, BECAUSE NO ONE OF THEM SEES THE WHOLE PICTURE
#
#   control-plane   GET /api/issues/{id}/runs. The LEADING signal: it reports a
#                   sibling that has written nothing at all — no commit, no
#                   branch, no push. Nothing else can do that.
#   local-refs      Branch refs are shared across every worktree of one clone,
#                   so a sibling's commits are visible the moment they commit,
#                   long before any push. This is the ONLY signal for work that
#                   is finished but unpublished — a run can complete and die
#                   without ever pushing (measured on TOG-339: the complete fix
#                   sat as a local commit while the remote said nothing existed).
#   remote          Pushed branch, open PR, and whether the work is already an
#                   ancestor of origin/main. LAGGING — it sees a sibling only
#                   after they push — but it is the only one that survives the
#                   clone being different from the sibling's.
#
# WHY THE CHECKOUT CLAIM IS NOT ONE OF THEM. The harness hands each run a
# checkout claim, and `PATCH /api/issues/{id}` 409s naming the holder when
# another agent's run is live. That is a real oracle for a FOREIGN agent, and it
# is not the case here: measured on this platform, a newer run of the same agent
# TAKES the checkout from the older one, and the older run keeps executing. So
# `issue.checkoutRunId != $PAPERCLIP_RUN_ID` catches the older run and the newer
# run sees its own id and reads CLEAR. Half-blind in exactly the direction that
# produced TOG-258. The run list below is symmetric: both runs see both rows.
#
# ---------------------------------------------------------------------------
# `/api/issues/{id}/runs` IS NOT ISSUE-EXCLUSIVE — FILTER ON agentId
#
# Measured 2026-08-25. Run 76bb3cb2 (agent 8b87f690, working TOG-424) appeared
# in the run list of TOG-345, TOG-441 AND TOG-290 while it held the shared
# workspace's environment lease. A naive "any other running row means a sibling"
# would have fired on every issue in the company.
#
# The discriminator is `agentId`. A duplicate implementation is two runs of ONE
# agent: that is what TOG-253 and TOG-258 both were, and a run of another agent
# on your issue is their checkout to hold, not a duplicate of your work. So a
# row with a foreign agentId is REPORTED (it is real, and worth seeing) but is
# not on its own a sibling verdict.
#
# ---------------------------------------------------------------------------
# FOUR EXIT STATES, NOT TWO. THIS IS THE WHOLE POINT.
#
#   0  clear          every detector RAN, and none of them found a sibling
#   1  sibling        at least one detector found one — stop and read the report
#   3  indeterminate  at least one detector COULD NOT RUN, and none found a
#                     sibling. NOT a pass. This is `ps` returning nothing,
#                     promoted into an exit code that cannot be misread.
#   2  usage          bad invocation
#
# A detector that could not run contributes NOTHING, and a tool that folds
# "nothing" into "nothing found" reproduces the original bug in a script, where
# it will be re-trusted forever. Exit 3 matches the house convention already set
# by test_request_queue.sh / test_responsible_leader.sh (TOG-402) and by
# gh_ci_status.sh's `unknown`: could-not-observe is a distinct answer from pass.
#
# ---------------------------------------------------------------------------
# RUN IT TWICE. A START-TIME CHECK ALONE IS NOT SUFFICIENT.
#
# On TOG-258 the winning run had not pushed when the losing run started, so a
# correct start-time check would still have come back clear. The sibling landed
# DURING the loser's CI wait. Hence two phases:
#
#   --phase=start     before you implement anything
#   --phase=prepush   immediately before `git push`, every time, including the
#                     push you make after a CI cycle. Adds the ancestor test:
#                     if HEAD is already reachable from origin/main, your work
#                     is already landed and the push is a duplicate. Adds the
#                     same-head ownership check: an open PR sitting on HEAD
#                     whose `Refs:` line names only OTHER cards refuses the
#                     push and names that card (two cards, one branch, both
#                     pushed). A `Refs:` line naming this card — even among
#                     others — or no `Refs:` line at all, stays clear.
#
# USAGE
#   sibling_guard.sh <ISSUE-KEY|issue-uuid> [--phase=start|prepush] [--repo O/R]
#                    [--quiet] [--json]
#
#   A key is resolved by GET /api/issues/<key>, which answers for any issue
#   however old. The company issue list (the 500 newest) is only the fallback.
#   A uuid is used as-is and needs no lookup.
#
# ENVIRONMENT
#   PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_AGENT_ID, PAPERCLIP_RUN_ID
#                       control-plane detector; absent -> that detector is
#                       could-not-run, i.e. exit 3, never exit 0.
#   PAPERCLIP_COMPANY_ID   needed only when GET /api/issues/<key> is not 200 and
#                       the company issue list has to be tried.
#   GH_TOKEN            open-PR query. Absent -> the PR half is could-not-run.
#                       Branch-and-ancestor still run off the local clone.
#   GH_API_URL          default https://api.github.com (test seam).
#   SIBLING_GUARD_NO_FETCH=1   skip `git fetch`; the remote view is then only as
#                       fresh as the last fetch, and is reported as such.
# ===========================================================================

GH_API="${GH_API_URL:-https://api.github.com}"
PHASE="start"
QUIET=0
JSON=0
REPO_SLUG="${SIBLING_GUARD_REPO:-}"
POSITIONAL=()

die() { echo "sibling_guard: $*" >&2; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase=*) PHASE="${1#--phase=}"; shift;;
    --phase)   PHASE="${2:-}"; shift 2;;
    --repo=*)  REPO_SLUG="${1#--repo=}"; shift;;
    --repo)    REPO_SLUG="${2:-}"; shift 2;;
    --quiet|-q) QUIET=1; shift;;
    --json)    JSON=1; shift;;
    -h|--help) sed -n '93,122p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0;;
    --) shift; POSITIONAL+=("$@"); break;;
    -*) die "unknown flag $1";;
    # Flags are accepted on either side of the issue key. `TOG-345 --phase=prepush`
    # is the order a human types, and refusing it is a way to make the guard
    # annoying enough to skip.
    *) POSITIONAL+=("$1"); shift;;
  esac
done

[[ "${#POSITIONAL[@]}" -eq 1 ]] || die "usage: sibling_guard.sh <ISSUE-KEY|issue-uuid> [--phase=start|prepush]"
ISSUE_ARG="${POSITIONAL[0]}"
case "$PHASE" in start|prepush) ;; *) die "unknown phase \"$PHASE\" (want start or prepush)";; esac
[[ "$ISSUE_ARG" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "refusing an issue argument that is not a bare key or uuid"

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v git  >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "node is required"

# Lowercased key used for branch matching. `TOG-345` -> `tog-345`.
KEY_LC="$(printf '%s' "$ISSUE_ARG" | tr '[:upper:]' '[:lower:]')"

# --- verdict accumulation ----------------------------------------------------
# FINDINGS holds sibling evidence. BLIND holds detectors that could not run.
# They are separate on purpose: a finding outranks blindness (you already know
# to stop), but blindness must never be silently absent from the tally.
FINDINGS=()
BLIND=()
NOTES=()

find_it()  { FINDINGS+=("$1"); }
blind_on() { BLIND+=("$1"); }
note()     { NOTES+=("$1"); }

# In --json mode the human report is suppressed entirely: a caller parsing
# stdout must not have to strip a trailing prose verdict off the JSON.
say() { [[ "$QUIET" -eq 1 || "$JSON" -eq 1 ]] || printf '%s\n' "$*"; }

TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

# ===========================================================================
# DETECTOR 1 — control plane (leading: sees a sibling that has written nothing)
# ===========================================================================
detect_control_plane() {
  local base key url code direct body hdrs
  base="${PAPERCLIP_API_URL:-}"
  [[ -n "$base" ]] || { blind_on "control-plane: PAPERCLIP_API_URL is unset"; return; }
  key="${PAPERCLIP_API_KEY:-}"
  [[ -n "$key" ]] || { blind_on "control-plane: PAPERCLIP_API_KEY is unset"; return; }
  [[ -n "${PAPERCLIP_RUN_ID:-}" ]] || { blind_on "control-plane: PAPERCLIP_RUN_ID is unset, so every row including my own would read as a sibling"; return; }
  [[ -n "${PAPERCLIP_AGENT_ID:-}" ]] || { blind_on "control-plane: PAPERCLIP_AGENT_ID is unset, so a foreign agent's run cannot be told from mine"; return; }

  base="${base%/}"; base="${base%/api}"

  hdrs="$TMPD/hdrs"; : > "$hdrs"; chmod 600 "$hdrs"
  printf 'Authorization: Bearer %s\n' "$key" > "$hdrs"   # never on argv — /proc is world readable

  local issue_id="$ISSUE_ARG"
  if [[ ! "$ISSUE_ARG" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}- ]]; then
    # The company list holds only the 500 newest issues, so a key is asked of
    # GET /api/issues/<key> first. The list is the fallback, not the source.
    body="$TMPD/issue.json"
    direct="$(curl -sS -m 30 -o "$body" -w '%{http_code}' -H "@$hdrs" "$base/api/issues/$ISSUE_ARG" 2>/dev/null || echo 000)"
    if [[ "$direct" == "200" ]]; then
      issue_id="$(node -e '
        const fs = require("fs")
        const i = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
        if (String(i.identifier || "").toLowerCase() === process.argv[2].toLowerCase()) process.stdout.write(String(i.id || ""))
      ' "$body" "$ISSUE_ARG" 2>/dev/null)"
    else
      [[ -n "${PAPERCLIP_COMPANY_ID:-}" ]] || { blind_on "control-plane: GET /api/issues/$ISSUE_ARG returned HTTP $direct and PAPERCLIP_COMPANY_ID is unset, so the issue list cannot be tried"; return; }
      body="$TMPD/issues.json"
      code="$(curl -sS -m 30 -o "$body" -w '%{http_code}' -H "@$hdrs" "$base/api/companies/$PAPERCLIP_COMPANY_ID/issues" 2>/dev/null || echo 000)"
      [[ "$code" == "200" ]] || { blind_on "control-plane: GET /api/issues/$ISSUE_ARG returned HTTP $direct and the issue list returned HTTP $code, cannot resolve $ISSUE_ARG"; return; }
      issue_id="$(node -e '
        const fs = require("fs")
        const a0 = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
        const a = Array.isArray(a0) ? a0 : (a0.issues || [])
        const want = process.argv[2].toLowerCase()
        const m = a.find(i => String(i.identifier || "").toLowerCase() === want)
        process.stdout.write(m ? String(m.id) : "")
      ' "$body" "$ISSUE_ARG" 2>/dev/null)"
    fi
    [[ -n "$issue_id" ]] || { blind_on "control-plane: $ISSUE_ARG did not resolve to an issue id (GET /api/issues/$ISSUE_ARG returned HTTP $direct)"; return; }
  fi

  body="$TMPD/runs.json"
  code="$(curl -sS -m 30 -o "$body" -w '%{http_code}' -H "@$hdrs" "$base/api/issues/$issue_id/runs" 2>/dev/null || echo 000)"
  [[ "$code" == "200" ]] || { blind_on "control-plane: GET /api/issues/$issue_id/runs returned HTTP $code"; return; }

  # A row is LIVE when it has not finished and its status is not terminal.
  # Both tests, not either: `finishedAt` is null on a queued row too, and a
  # terminal status has been observed alongside a null finishedAt.
  local out
  out="$(node -e '
    const fs = require("fs")
    const TERMINAL = new Set(["succeeded","failed","cancelled","canceled","expired","timed_out","timeout","errored","error","skipped"])
    let rows
    try { rows = JSON.parse(fs.readFileSync(process.argv[1], "utf8")) } catch (e) { process.exit(9) }
    if (!Array.isArray(rows)) rows = rows.runs || []
    const me = process.argv[2], myAgent = process.argv[3]
    const live = rows.filter(r => !r.finishedAt && !TERMINAL.has(String(r.status || "").toLowerCase()))
    for (const r of live) {
      if (r.runId === me) continue
      const kind = (r.agentId === myAgent) ? "SIBLING" : "FOREIGN"
      process.stdout.write([kind, r.runId, r.agentId, r.status, r.startedAt || r.createdAt || "?"].join("\t") + "\n")
    }
    process.stderr.write("rows=" + rows.length + " live=" + live.length + "\n")
  ' "$body" "$PAPERCLIP_RUN_ID" "$PAPERCLIP_AGENT_ID" 2>"$TMPD/cp.err")"
  if [[ $? -ne 0 ]]; then
    blind_on "control-plane: run list at /api/issues/$issue_id/runs did not parse as JSON"
    return
  fi

  note "control-plane: read $issue_id run list ($(tr -d '\n' < "$TMPD/cp.err"))"

  local line kind rid aid st started
  while IFS=$'\t' read -r kind rid aid st started; do
    [[ -n "${kind:-}" ]] || continue
    if [[ "$kind" == "SIBLING" ]]; then
      find_it "control-plane: run $rid of MY OWN agent is $st on this issue (started $started). This is the TOG-258 shape: two runs of one agent on one issue."
    else
      note "control-plane: run $rid of another agent ($aid) is $st and joined to this issue. Usually the shared-workspace lease, not a duplicate of your work — but if that agent is genuinely implementing this issue, coordinate rather than race."
    fi
  done <<< "$out"
}

# ===========================================================================
# DETECTOR 2 — local refs (the only signal for finished-but-unpushed work)
# ===========================================================================
detect_local_refs() {
  git rev-parse --git-dir >/dev/null 2>&1 || { blind_on "local-refs: not inside a git repository"; return; }

  local current base
  current="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"

  # The comparison base. origin/main if it exists, else main. If neither does we
  # cannot say whether a branch carries work, and must say so rather than guess.
  if git rev-parse --verify -q refs/remotes/origin/main >/dev/null 2>&1; then
    base="refs/remotes/origin/main"
  elif git rev-parse --verify -q refs/heads/main >/dev/null 2>&1; then
    base="refs/heads/main"
    note "local-refs: no origin/main in this clone; comparing against local main"
  else
    blind_on "local-refs: neither origin/main nor main exists, so \"ahead of main\" cannot be evaluated"
    return
  fi

  # Which branches are checked out in some other worktree. Recorded for the
  # report only — a `+` marker is NOT a liveness signal (a dead run leaves one
  # behind, and that misreading is half of what TOG-258 was).
  local checked_out
  checked_out="$(git worktree list --porcelain 2>/dev/null | awk '/^branch /{sub("refs/heads/","",$2); print $2}')"

  local found=0 b ahead
  while read -r b; do
    [[ -n "$b" ]] || continue
    [[ "$b" != "$current" ]] || continue
    found=1
    ahead="$(git rev-list --count "$base..refs/heads/$b" 2>/dev/null || echo "?")"
    local where=""
    grep -qx -- "$b" <<< "$checked_out" && where=" (checked out in another worktree)"
    if [[ "$ahead" == "0" ]]; then
      note "local-refs: branch $b names this issue but carries NO commits beyond $(basename "$base")$where — a dead run's empty leftover, safe to delete and reuse."
    else
      find_it "local-refs: branch $b is $ahead commit(s) ahead of $(basename "$base")$where. Work for this issue already exists in this clone, pushed or not. Read it before writing anything: \`git log $base..$b\`."
    fi
  done < <(git for-each-ref --format='%(refname:short)' refs/heads 2>/dev/null \
             | while read -r n; do [[ "$(printf '%s' "$n" | tr '[:upper:]' '[:lower:]')" == *"$KEY_LC"* ]] && printf '%s\n' "$n"; done)

  [[ "$found" -eq 1 ]] || note "local-refs: no local branch names $ISSUE_ARG"
}

# ===========================================================================
# DETECTOR 3 — remote (lagging, but sees other clones)
# ===========================================================================
detect_remote() {
  git rev-parse --git-dir >/dev/null 2>&1 || { blind_on "remote: not inside a git repository"; return; }
  git remote get-url origin >/dev/null 2>&1 || { blind_on "remote: this clone has no origin"; return; }

  local fetched=0
  if [[ "${SIBLING_GUARD_NO_FETCH:-0}" == "1" ]]; then
    blind_on "remote: fetch skipped by SIBLING_GUARD_NO_FETCH, so the remote view is only as fresh as the last fetch"
  elif git fetch --quiet origin 2>"$TMPD/fetch.err"; then
    fetched=1
  else
    blind_on "remote: git fetch origin failed ($(head -1 "$TMPD/fetch.err" 2>/dev/null | tr -d '\n')). A stale remote view cannot clear you."
  fi

  # -- pushed branches naming the issue -------------------------------------
  local current_sha current_branch
  current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
  local rb
  while read -r rb; do
    [[ -n "$rb" ]] || continue
    [[ "${rb#origin/}" != "$current_branch" ]] || continue
    find_it "remote: origin/$( basename "$rb" ) exists on the remote and names this issue. Someone has already pushed work for it."
  done < <(git for-each-ref --format='%(refname:short)' refs/remotes/origin 2>/dev/null \
             | while read -r n; do [[ "$(printf '%s' "$n" | tr '[:upper:]' '[:lower:]')" == *"$KEY_LC"* ]] && printf '%s\n' "$n"; done)

  # -- open pull requests ----------------------------------------------------
  local slug="$REPO_SLUG"
  if [[ -z "$slug" ]]; then
    slug="$(git remote get-url origin 2>/dev/null \
            | sed -E 's#^git@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##')"
  fi
  # The token. GH_TOKEN if the caller set one; otherwise ask git's own
  # credential helper for the credential this clone already fetches with. In an
  # agent container there is no App private key to mint from — `gh_token.sh
  # token` dies on a missing PEM — but the broker-backed helper hands out a
  # `ghs_` installation token, and `git fetch` a few lines above just proved it
  # works. Read once, into a variable, never onto a command line.
  local token="${GH_TOKEN:-}"
  if [[ -z "$token" ]]; then
    token="$(printf 'protocol=https\nhost=github.com\n\n' \
             | timeout 60 git credential fill 2>/dev/null \
             | sed -n 's/^password=//p')"
    [[ -n "$token" ]] && note "remote: no GH_TOKEN, using the credential this clone fetches with"
  fi

  if [[ ! "$slug" =~ ^[^/]+/[^/]+$ ]]; then
    blind_on "remote: could not read owner/repo off origin, so open PRs were not queried"
  elif [[ -z "$token" ]]; then
    blind_on "remote: no GH_TOKEN and git's credential helper returned nothing, so open PRs were not queried (an anonymous read of a private repo is a 404, which is not \"no PR\")"
  else
    local hdrs body code
    hdrs="$TMPD/ghhdrs"; : > "$hdrs"; chmod 600 "$hdrs"
    { printf 'Authorization: Bearer %s\n' "$token"
      printf 'Accept: application/vnd.github+json\n'
      printf 'X-GitHub-Api-Version: 2022-11-28\n'; } > "$hdrs"
    body="$TMPD/prs.json"
    code="$(curl -sS -m 30 -o "$body" -w '%{http_code}' -H "@$hdrs" "$GH_API/repos/$slug/pulls?state=open&per_page=100" 2>/dev/null || echo 000)"
    if [[ "$code" != "200" ]]; then
      blind_on "remote: GET /repos/$slug/pulls returned HTTP $code, so open PRs were not queried"
    else
      local hits
      hits="$(node -e '
        const fs = require("fs")
        let prs
        try { prs = JSON.parse(fs.readFileSync(process.argv[1], "utf8")) } catch (e) { process.exit(9) }
        if (!Array.isArray(prs)) process.exit(9)
        const key = process.argv[2]
        const mine = process.argv[3]
        for (const p of prs) {
          const hay = [p.title || "", (p.head && p.head.ref) || "", p.body || ""].join(" ").toLowerCase()
          // A PR sitting on the calling run own head branch is NOT skipped:
          // at prepush it is the ownership evidence for the check below.
          // Attribution is card keys on a Refs line ONLY — a bare substring
          // would keep the false-positive class where a "Related" line
          // merely mentions a foreign card.
          if (p.head && p.head.ref === mine) {
            const claimed = []
            // Attribution is a Refs LINE, not a Refs mention: the match is
            // anchored to the start of a line so "see Refs: TOG-1 for detail"
            // mid-sentence does not count. Tokens are card-key-shaped
            // (>=2 letters, word boundaries) so "TOG-1x" is not "TOG-1".
            for (const line of String(p.body || "").matchAll(/^[ \t]*refs[ \t]*:[^\n]*/gim)) {
              for (const k of line[0].matchAll(/\b[A-Za-z]{2,}-\d+\b/g)) claimed.push(k[0])
            }
            process.stdout.write(["SAMEHEAD", p.number, p.head.ref, (p.title || "").slice(0, 90), claimed.join(",")].join("\t") + "\n")
            continue
          }
          if (!hay.includes(key)) continue
          process.stdout.write([p.number, (p.head && p.head.ref) || "?", (p.title || "").slice(0, 90)].join("\t") + "\n")
        }
      ' "$body" "$KEY_LC" "$current_branch" 2>/dev/null)"
      if [[ $? -ne 0 ]]; then
        blind_on "remote: the pull request list did not parse as JSON"
      else
        note "remote: queried open pull requests on $slug"
        local num ref title
        while IFS=$'\t' read -r num ref title; do
          [[ "$num" == "SAMEHEAD" ]] && continue
          [[ -n "${num:-}" ]] || continue
          find_it "remote: open PR #$num (head $ref) already covers this issue — \"$title\". Diff yours against it before pushing; do not open a second."
        done <<< "$hits"
        # -- same-head ownership: does another card own this PR branch? -------
        # Two cards, one branch, both pushed: the guard keyed on the caller
        # own card key, so a PR whose head is the branch
        # about to be pushed but whose body carries `Refs:` for a DIFFERENT
        # card read as clear. At prepush the branch is known (it is HEAD), so
        # same-head PRs are attributed through their `Refs:` line, and a
        # Refs line naming only OTHER cards refuses the push by name. A Refs
        # line that names our own key — even alongside others, and even
        # alongside key-shaped non-cards like a parenthetical SHA-256 — is
        # our own PR. Start phase keeps the old skip: nothing is being
        # pushed yet, and your own just-opened PR must not alarm you.
        if [[ "$PHASE" == "prepush" ]]; then
          local mykey="$KEY_LC"
          # The caller's own-key lookup below runs ONLY when there is a
          # same-head PR to attribute: with nothing to attribute, a
          # transient API error must not turn the push indeterminate.
          local samehead_rows
          samehead_rows="$(grep '^SAMEHEAD' <<< "$hits" || true)"
          if [[ -z "$samehead_rows" ]]; then
            mykey=""
          elif [[ "$ISSUE_ARG" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}- ]]; then
            # Invoked by uuid: the caller's own card key is not the argument,
            # so it is read off GET /api/issues/<uuid> — the same endpoint the
            # control-plane detector resolves keys through. Unresolvable means
            # unattributable, which fails closed, never clear.
            if [[ -z "${PAPERCLIP_API_URL:-}" || -z "${PAPERCLIP_API_KEY:-}" ]]; then
              blind_on "remote: prepush ownership check cannot learn our own card key for $ISSUE_ARG with no control-plane credential, so a same-head PR cannot be attributed"
              mykey=""
            else
              local obase ohdrs obody ocode
              obase="${PAPERCLIP_API_URL%/}"; obase="${obase%/api}"
              ohdrs="$TMPD/ownhdrs"; : > "$ohdrs"; chmod 600 "$ohdrs"
              printf 'Authorization: Bearer %s\n' "$PAPERCLIP_API_KEY" > "$ohdrs"
              obody="$TMPD/own.json"
              ocode="$(curl -sS -m 30 -o "$obody" -w '%{http_code}' -H "@$ohdrs" "$obase/api/issues/$ISSUE_ARG" 2>/dev/null || echo 000)"
              if [[ "$ocode" == "200" ]]; then
                mykey="$(node -e 'try { const i = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(i.identifier || "").toLowerCase()) } catch (e) { process.exit(9) }' "$obody" 2>/dev/null)"
                if [[ $? -ne 0 || -z "$mykey" ]]; then
                  blind_on "remote: prepush ownership check could not read our own card key off /api/issues/$ISSUE_ARG (HTTP $ocode)"
                  mykey=""
                fi
              else
                blind_on "remote: prepush ownership check GET /api/issues/$ISSUE_ARG returned HTTP $ocode, so a same-head PR cannot be attributed"
                mykey=""
              fi
            fi
          fi
          if [[ -n "$mykey" ]]; then
            local wt_branches
            wt_branches="$(git worktree list --porcelain 2>/dev/null | awk '/^branch /{sub("refs/heads/","",$2); print $2}')"
            local tag s_num s_head s_title s_claims
            while IFS=$'\t' read -r tag s_num s_head s_title s_claims; do
              [[ "${tag:-}" == "SAMEHEAD" ]] || continue
              [[ -n "${s_num:-}" ]] || continue
              if [[ -z "${s_claims:-}" ]]; then
                note "remote: open PR #$s_num (head $s_head) is on the branch you are about to push and names no card — treating it as your own"
                continue
              fi
              local claimant mine_present="" foreign=""
              local -a claimants=()
              IFS=',' read -ra claimants <<< "$s_claims"
              for claimant in "${claimants[@]}"; do
                if [[ "$(printf '%s' "$claimant" | tr '[:upper:]' '[:lower:]')" == "$mykey" ]]; then
                  mine_present=1
                elif [[ -z "$foreign" ]]; then
                  foreign="$claimant"
                fi
              done
              if [[ -n "$mine_present" ]]; then
                note "remote: open PR #$s_num (head $s_head) is on the branch you are about to push and its Refs line claims this card — your own PR, as expected before a push"
              else
                local where=""
                grep -qx -- "$s_head" <<< "$wt_branches" && where=" Local worktree match: branch $s_head checked out in this clone — read it before pushing anything."
                find_it "remote: open PR #$s_num (head $s_head) is on the branch you are about to push but its body claims another open card $foreign (Refs: $s_claims). Do not push here; that card owns this PR branch.$where"
              fi
            done <<< "$samehead_rows"
          fi
        fi
      fi
    fi
  fi

  # -- is the work already landed? ------------------------------------------
  # TOG-258's own stated remedy was to merge into a branch that had already
  # merged. The literal instruction would have delivered nothing, and nothing is
  # what a duplicate push delivers too.
  if [[ "$PHASE" == "prepush" ]]; then
    if [[ "$fetched" -ne 1 ]]; then
      blind_on "remote: the ancestor test ran against an unfetched origin/main and cannot clear this push"
    fi
    if git rev-parse --verify -q refs/remotes/origin/main >/dev/null 2>&1; then
      current_sha="$(git rev-parse HEAD 2>/dev/null || echo "")"
      if [[ -n "$current_sha" ]] && git merge-base --is-ancestor "$current_sha" refs/remotes/origin/main 2>/dev/null; then
        find_it "remote: HEAD ($(git rev-parse --short HEAD)) is ALREADY an ancestor of origin/main. This work is landed. Pushing it again delivers nothing."
      else
        note "remote: HEAD is not yet on origin/main, as expected before a push"
      fi
    else
      blind_on "remote: no origin/main, so the already-landed test could not run"
    fi
  fi
}

# ===========================================================================
detect_control_plane
detect_local_refs
detect_remote

# --- report ------------------------------------------------------------------
if [[ "$JSON" -eq 1 ]]; then
  node -e '
    const [verdictArg, phase, issue] = process.argv.slice(1, 4)
    const rest = process.argv.slice(4)
    const cut = rest.indexOf("--")
    const cut2 = rest.indexOf("--", cut + 1)
    const findings = rest.slice(0, cut)
    const blind = rest.slice(cut + 1, cut2)
    const notes = rest.slice(cut2 + 1)
    const verdict = findings.length ? "sibling" : (blind.length ? "indeterminate" : "clear")
    process.stdout.write(JSON.stringify({
      issue, phase, verdict,
      exitCode: verdict === "sibling" ? 1 : (verdict === "indeterminate" ? 3 : 0),
      findings, couldNotRun: blind, notes,
    }, null, 2) + "\n")
  ' x "$PHASE" "$ISSUE_ARG" "${FINDINGS[@]+"${FINDINGS[@]}"}" -- "${BLIND[@]+"${BLIND[@]}"}" -- "${NOTES[@]+"${NOTES[@]}"}"
else
  say "sibling_guard $ISSUE_ARG  phase=$PHASE"
  if [[ "${#NOTES[@]}" -gt 0 ]]; then
    say ""
    for n in "${NOTES[@]}"; do say "  .  $n"; done
  fi
  if [[ "${#BLIND[@]}" -gt 0 ]]; then
    say ""
    say "  COULD NOT RUN — these detectors contributed nothing, not \"nothing found\":"
    for b in "${BLIND[@]}"; do say "  ?  $b"; done
  fi
  if [[ "${#FINDINGS[@]}" -gt 0 ]]; then
    say ""
    say "  SIBLING WORK FOUND:"
    for f in "${FINDINGS[@]}"; do say "  !  $f"; done
  fi
  say ""
fi

# --- verdict ----------------------------------------------------------------
# Precedence, written as last-assignment-wins so it can be read and mutated one
# line at a time. A FINDING outranks blindness: once a sibling is known, "and
# some other detector could not run" is not the useful thing to say, and exit 3
# reads as "inconclusive, try again" — which in practice is a push.
VERDICT="clear"; CODE=0
if [[ "${#BLIND[@]}" -gt 0 ]]; then VERDICT="indeterminate"; CODE=3; fi
if [[ "${#FINDINGS[@]}" -gt 0 ]]; then VERDICT="sibling"; CODE=1; fi

case "$VERDICT" in
  sibling)       say "VERDICT: sibling  (exit 1) — do not implement or push until you have read the evidence above.";;
  indeterminate) say "VERDICT: indeterminate  (exit 3) — this is NOT a pass. ${#BLIND[@]} detector(s) could not run.";;
  clear)         say "VERDICT: clear  (exit 0) — all three detectors ran and none found a sibling.";;
esac
exit "$CODE"
