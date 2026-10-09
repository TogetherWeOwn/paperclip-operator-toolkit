#!/usr/bin/env bash
# ===========================================================================
# red_main_poll.sh — poll company-repo main branches and emit the `redMains`
# snapshot fragment for watchdog/detectors.py.
#
# THE GAP THIS EXISTS FOR. watchdog/detectors.py already knows what a red
# main MEANS (exactly one incident per repo plus red signature; repeats are
# info-level, not new incidents) but nothing BUILDS its `redMains` input:
# nobody polls main-branch CI, nobody computes the signature, and nobody
# checks the board for an already-open incident before asserting
# `incidentExists: false`. An `incidentExists` nobody measured is a guess,
# and a guess of false opens a duplicate card on every poll while the same
# red persists. This script is the measuring half.
#
# WHAT IT DOES, AND WHAT IT REFUSES TO DO. Per repo it asks gh_ci_status.sh
# (the fail-closed reader: denied, vacuous and never-ran verdicts stay
# distinct from pass AND from fail) for the verdict on `main`, derives a
# stable red signature from the sorted failing-job set, looks up open board
# cards carrying the dedupe tag, and emits `{"redMains": [...]}` for the
# detector. `propose` prints the incident-card drafts the CEO hourly routine
# would file — one per untracked (repo, signature) — and writes nothing.
# There is no `--apply`, no issue-create call, no recovery-writer mutation:
# phase 1 is propose-only, and incident creation stays a CEO-routine action.
#
# KEY FORMAT. The dedupe key is owned by the triage contract,
# not by this script:
#   red-main:v1:{owner}/{repo}:{sig8}
# where sig8 is the first 8 hex chars of SHA-1 over the sorted, lowercased
# failing-check identifiers, one per line. Identifiers are the lowercased
# check-run names — the finest stable identifier the check-runs API yields
# with `checks:read` alone (no workflow name field exists there; upgrading
# to `workflow/name` identifiers would re-key every open incident, so that
# is a v2 key version, not a silent change). Suggested severity follows the
# contract rubric: S1 for prod-path repos or red security gates, else S2;
# S3 (non-required-only) needs required-check data this poller cannot see,
# so triage alone may downgrade to it.
#
# FOUR RULES, EACH BECAUSE THE OBVIOUS VERSION OPENS DUPLICATES OR HIDES RED:
#
#  1. THE SIGNATURE KEYS ON THE FAILURE SET, NOT THE HEAD SHA. A new commit
#     that breaks the same jobs is the same breakage, not a new incident:
#     `repo-red` at head aaa and `repo-red-newsha` at head bbb with identical
#     failing jobs hash to the same signature, and the incident card tracks
#     the newest head in its body. Keying on the SHA would open one card per
#     commit for the whole life of the red.
#  2. NAMES ARE SORTED BEFORE HASHING. The Checks API returns runs in an
#     order no caller should depend on; hashing the raw order would rotate
#     the signature — and open a new card — on a mere reordering.
#  3. AN UNREADABLE BOARD IS NOT "NO INCIDENT". `post_finding.sh`
#     refuses to post blind for the same reason: with the board down,
#     asserting `incidentExists: false` manufactures a duplicate per tick.
#     Both subcommands exit 3 with no snapshot rather than guess.
#  3b. THE BOARD READ MUST COVER THE WHOLE BOARD. The issues list API ignores
#     `per_page` and, with no `limit`, returns only the newest 500 rows by
#     `updatedAt`; a quiet incident card ages out of that window and the lookup
#     would read "no incident" for a live one. The read therefore asks the
#     server to filter (`q=red-main:v1`, a substring match, so it is a superset
#     of cards whose TITLE carries the tag; the poller still matches on titles
#     only) with `limit=1000` (the measured hard cap, 2026-10-04), and a page
#     that comes back FULL is treated as truncated: exit 3, never "no
#     incident". A non-200, an error object or any unrecognised body shape is
#     likewise unreadable, not empty (`curl` without `--fail` exits 0 on a 401).
#  4. UNOBSERVABLE CI IS NOT GREEN. A denied token, a pending build, zero
#     signals, or a never-ran account block produce no entry and a non-zero
#     exit — never an empty list that reads as "all green". A never-ran
#     verdict is explicitly NOT a red build: there is nothing in
#     the diff to fix, so it must not open a repo-lead incident.
#
# USAGE
#   ./red_main_poll.sh snapshot <owner/repo> [...]   # JSON fragment on stdout
#   ./red_main_poll.sh propose  <owner/repo> [...]   # card drafts on stdout
#
# EXIT CODES — gate on these, not on stdout.
#   0  measured, full coverage: snapshot has no red entry (propose printed
#      nothing, and every repo was observable).
#   1  red observed with full coverage: snapshot carries at least one entry
#      (tracked or not); propose printed at least one draft.
#   2  usage: no repos, bad repo format, missing GH_TOKEN, missing tooling.
#   3  unknown: at least one repo unobservable (denied/pending/no-signal/
#      never-ran) or the board unreadable. Incompleteness dominates a red:
#      entries are still printed (snapshot) and drafts still drafted
#      (propose), but the caller must resolve the blind spot before treating
#      the output as complete — filing a partial snapshot as a clean bill of
#      health is what rule 4 exists to prevent.
#
# ENVIRONMENT
#   GH_TOKEN               required. Same token gh_ci_status.sh uses; passed
#                          to curl via a 0600 header file, never on argv.
#   GH_API_URL             optional, defaults to https://api.github.com.
#                          The test seam (stub serves cases off repo names).
#   INCIDENT_SOURCE_CMD    optional test/operator seam: stdout is a JSON
#                          array of open issues (objects with .title).
#                          When set, no board credential is needed.
#   PAPERCLIP_API_URL, PAPERCLIP_COMPANY_ID
#                          required for the default board read.
#   RED_MAIN_API_KEY       agent API key for the board read. Falls back to
#                          PAPERCLIP_API_KEY when set (a heartbeat run JWT).
#                          Sent via a curl config pipe, never on argv.
#   RED_MAIN_ROLLUP_PARENT_ID
#                          optional bounded-read mode. When set to the UUID of
#                          a rollup thread inside the installer's key boundary,
#                          the board read uses only single-issue routes (GET
#                          the thread, GET its comments) and never touches the
#                          company-wide issue list. That list answers 403 to
#                          least-privilege bridge keys, so unattended timers
#                          must set this. Bound is not enough: live 2026-10-05
#                          proved the bound rollup root itself can answer 403
#                          ("outside this actor's authorization boundary")
#                          when it is unassigned, so the thread MUST be
#                          assigned to the key's triage owner; if the root
#                          stays refused, use an assigned descendant thread
#                          under the bound parent (same routes, no key change).
#                          Incident tags are found in prior draft bodies and
#                          filed-key mirrors posted as comments on the thread;
#                          the filing routine (which holds a full read) still
#                          owns the final dedupe check before opening a card.
#                          Entries carry boardRead:"parent-comments" in this
#                          mode vs "company-list" otherwise.
#   GH_CI_STATUS_BIN       optional path to gh_ci_status.sh (default: same
#                          directory as this script).
# ===========================================================================
set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CI_STATUS_BIN="${GH_CI_STATUS_BIN:-$HERE/gh_ci_status.sh}"
API="${GH_API_URL:-https://api.github.com}"

command -v curl >/dev/null 2>&1 || { echo "red_main_poll: curl is required" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "red_main_poll: jq is required" >&2; exit 2; }
command -v sha1sum >/dev/null 2>&1 || { echo "red_main_poll: sha1sum is required" >&2; exit 2; }
[[ -x "$CI_STATUS_BIN" ]] || { echo "red_main_poll: CI reader missing at $CI_STATUS_BIN" >&2; exit 2; }

die() { echo "red_main_poll: $*" >&2; exit 2; }

[[ -n "${GH_TOKEN:-}" ]] || die "GH_TOKEN is not set; refusing to poll anonymously (an anonymous read of a private repo is a 404, which is not green)"

# The token goes in a 0600 header file, never on a command line: argv is
# world-readable through /proc (the world-readable-argv class of bug; same convention
# as gh_ci_status.sh).
GH_HDRS="$(mktemp)"; chmod 600 "$GH_HDRS"
GH_BODY="$(mktemp)"
# Under `set -u` the EXIT trap must tolerate variables unset by an early
# `die`: the ${VAR:-} form keeps a prereq failure from tripping its own
# unbound-variable error on the way out.
trap 'rm -f "${GH_HDRS:-}" "${GH_BODY:-}" 2>/dev/null' EXIT
printf 'Authorization: Bearer %s\nAccept: application/vnd.github+json\nX-GitHub-Api-Version: 2022-11-28\n' "$GH_TOKEN" > "$GH_HDRS"

valid_repo() { [[ "$1" == */* && "$1" != *..* && "$1" != *" "* ]]; }

# resolve_main <owner/repo> -> the commit SHA main points at, on stdout; returns
# 1 when it cannot be resolved. Resolved once per repo so the reader and the
# failing-check read describe the same commit: a push between them would split
# the verdict from the names it is keyed on.
resolve_main() {
  local sha
  [[ "$(gh_api "/repos/$1/commits/main")" == "200" ]] || return 1
  sha="$(jq -r '.sha // ""' "$GH_BODY" 2>/dev/null)"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  printf '%s' "$sha"
}

# ci_json <owner/repo> <commit-sha> -> prints gh_ci_status.sh JSON on stdout.
# Returns the reader's exit code (0 pass, 1 fail, 2 pending, 3 unknown,
# 5 non-started). A reader failure is the repo's verdict, not the poll's.
ci_json() {
  "$CI_STATUS_BIN" --quiet "$1" "$2" 2>/dev/null
}

# gh_api <path> -> HTTP status; body in $GH_BODY.
gh_api() { curl -sS -o "$GH_BODY" -w '%{http_code}' -H "@$GH_HDRS" "$API$1" 2>/dev/null || echo 000; }

# failing_checks <owner/repo> <commit-sha> <body-file> -> prints sorted, lowercased
# failing check-run names, one per line. Every check-runs page is read until
# the rows seen match total_count; a short read returns 1 with nothing printed,
# so the caller keys on the reader reason instead of a partial check set. The
# first page is saved to <body-file> for the caller to mine head_sha from. The
# body goes through a file, not a sentinel line, because check-run names are
# attacker-influenced strings and any sentinel (HEAD_SHA=, ---, ...) is a name
# someone can type. Lowercased because the contract keys on the lowercased set
# ("Broker suite" and "broker suite" are one signature, not two incidents).
# Empty output with exit 0 means "check runs read, none failing": a fail verdict
# sourced elsewhere (commit statuses) falls back to the reader reason as key.
failing_checks() {
  local slug="$1" sha="$2" body_file="$3" code page=1 total=0 seen=0 page_n tmp
  tmp="$(mktemp)" || return 1
  while true; do
    code="$(gh_api "/repos/$slug/commits/$sha/check-runs?per_page=100&page=$page")"
    [[ "$code" == "200" ]] || { rm -f "$tmp"; return 1; }
    if [[ "$page" -eq 1 ]]; then
      total="$(jq -r '.total_count // (.check_runs | length) // empty' "$GH_BODY" 2>/dev/null)"
      [[ "$total" =~ ^[0-9]+$ ]] || { rm -f "$tmp"; return 1; }
      cp "$GH_BODY" "$body_file" 2>/dev/null || { rm -f "$tmp"; return 1; }
    fi
    page_n="$(jq -r '.check_runs | length' "$GH_BODY" 2>/dev/null)"
    [[ "$page_n" =~ ^[0-9]+$ ]] || page_n=0
    seen=$((seen + page_n))
    jq -c '[.check_runs[]?
        | select(.status=="completed")
        | select((.conclusion // "") | IN("failure","timed_out","cancelled","action_required","startup_failure"))
        | (.name // "" | tostring | ascii_downcase)]' "$GH_BODY" >> "$tmp" 2>/dev/null
    if [[ "$seen" -ge "$total" || "$page_n" -eq 0 ]]; then break; fi
    page=$((page + 1))
    if [[ "$page" -gt 100 ]]; then rm -f "$tmp"; return 1; fi
  done
  if [[ "$seen" -lt "$total" ]]; then rm -f "$tmp"; return 1; fi
  jq -rs 'add // [] | sort | .[]' "$tmp" 2>/dev/null
  rm -f "$tmp"
  return 0
}

# prod-path repos per the triage contract: red main on these
# is S1. Everything else defaults to S2; the security-gate and S3 rules need
# required-check data this poller cannot observe, so they are triage's call.
PROD_PATH_REPOS="${RED_MAIN_PROD_PATH_REPOS:-TogetherWeOwn/two-bot-next TogetherWeOwn/two-web-next}"

# suggested_severity <owner/repo> -> S1|S2 on stdout.
suggested_severity() {
  local slug="$1" entry
  for entry in $PROD_PATH_REPOS; do
    [[ "$slug" == "$entry" ]] && { printf 'S1'; return 0; }
  done
  printf 'S2'
}

# The issues list API caps one page at 1000 rows (measured 2026-10-04; a larger
# `limit` is clamped, `per_page` is ignored). A response with this many rows
# may have been cut off, so it is refused rather than searched (rule 3b).
BOARD_LIMIT=1000

# The statuses that count as "an open incident card": every non-terminal one,
# `backlog` included (a parked incident is still the one card for its key).
BOARD_STATUSES="backlog,todo,in_progress,in_review,blocked"

# BOARD_READ_MODE names the board source the last board_titles call used:
# "seam" (INCIDENT_SOURCE_CMD), "parent-comments" (bounded rollup-thread
# read) or "company-list" (legacy company-wide search). Entries carry it so
# the filing routine knows whether incident dedupe was fully searched or
# deferred to its own full read.
BOARD_READ_MODE="unknown"

# board_api_get <path> -> prints "body\n<http-code>" on stdout.
# The credential travels in a config pipe, never on argv: `curl -H
# "Bearer $key"` would expose it in /proc/<pid>/cmdline (see the shared
# post_finding helper's non-disclosure rule). The status comes back through
# -w: without it a 401 or 500 is an exit-0 curl with an error body, which
# parses as "no issues".
board_api_get() {
  local path="$1" key="$2"
  curl -sS -w $'\n%{http_code}' --config <(printf 'header = "Authorization: Bearer %s"\n' "$key") \
    "${PAPERCLIP_API_URL%/}${path}" 2>/dev/null
}

# board_titles_bounded -> prints the rollup parent title plus every comment
# body on it, one blob per line group. Callers grep this for dedupe tags, so
# prior drafts and filed-key mirrors posted as comments count as "known".
# Non-zero when the thread could not be read in full: the caller must NOT
# treat that as "no incident". Unreadable covers transport errors, non-200
# statuses, a missing or closed parent, and bodies that are not an issue or
# a comment list. Uses only single-issue routes and never touches the
# company-wide list. A 403 here means the thread is outside the key's
# boundary even though the key is parent-bound: live 2026-10-05 proved a
# bound-but-unassigned rollup root answers 403 on both routes, so the thread
# must be assigned to the key's triage owner (or be an assigned descendant
# of the bound parent) -- see docs/red-main-task-bridge-contract.md.
# bounded_403_hint <what> <code> -> one stderr line naming the fix. A 403 on
# a single-issue route under a parent-bound bridge key is a boundary refusal,
# not "no incident": the usual causes are an unassigned thread (the key's
# assignee allowlist covers only the triage owner) or a bound root the API
# treats as outside the actor's boundary (use an assigned descendant thread).
bounded_403_hint() {
  echo "red_main_poll: $1 answered HTTP $2 (boundary refusal, not 'no incident': assign the thread to the key's triage owner, or point RED_MAIN_ROLLUP_PARENT_ID at an assigned descendant of the bound parent)" >&2
}
board_titles_bounded() {
  local parent_id="$1" key="$2" resp code raw title bodies
  resp="$(board_api_get "/api/issues/${parent_id}" "$key")" || return 1
  code="${resp##*$'\n'}"
  raw="${resp%$'\n'*}"
  [[ "$code" == "200" ]] || { bounded_403_hint "rollup thread read" "$code"; return 1; }
  title="$(jq -r '.title // ""' <<<"$raw" 2>/dev/null)" || return 1
  [[ -n "$title" ]] || { echo "red_main_poll: rollup parent body is not an issue" >&2; return 1; }
  resp="$(board_api_get "/api/issues/${parent_id}/comments" "$key")" || return 1
  code="${resp##*$'\n'}"
  raw="${resp%$'\n'*}"
  [[ "$code" == "200" ]] || { bounded_403_hint "rollup comments read" "$code"; return 1; }
  bodies="$(jq -c 'if type == "array" then .
                   elif type == "object" and (.comments | type) == "array" then .comments
                   else error("unrecognised comments shape") end' <<<"$raw" 2>/dev/null)" || return 1
  [[ -n "$bodies" ]] || return 1
  printf '%s\n' "$title"
  jq -r '.[] | .body // ""' <<<"$bodies" 2>/dev/null || return 1
  return 0
}

# board_titles -> prints known issue titles (or parent-thread text in bounded
# mode), for tag matching. Non-zero when the board could not be read in full:
# the caller must NOT treat that as "no incident". Unreadable covers transport
# errors, non-200 statuses, bodies that are not a list of issues, and a page
# that hit BOARD_LIMIT.
board_titles() {
  local raw rows n
  if [[ -n "${INCIDENT_SOURCE_CMD:-}" ]]; then
    BOARD_READ_MODE="seam"
    raw="$($INCIDENT_SOURCE_CMD 2>/dev/null)" || return 1
  elif [[ -n "${RED_MAIN_ROLLUP_PARENT_ID:-}" ]]; then
    BOARD_READ_MODE="parent-comments"
    [[ -n "${PAPERCLIP_API_URL:-}" ]] \
      || { echo "red_main_poll: no board source (set PAPERCLIP_API_URL for the parent-thread read)" >&2; return 1; }
    local key="${RED_MAIN_API_KEY:-${PAPERCLIP_API_KEY:-}}"
    [[ -n "$key" ]] || { echo "red_main_poll: no board credential (set RED_MAIN_API_KEY)" >&2; return 1; }
    board_titles_bounded "$RED_MAIN_ROLLUP_PARENT_ID" "$key" || return 1
    return 0
  else
    BOARD_READ_MODE="company-list"
    [[ -n "${PAPERCLIP_API_URL:-}" && -n "${PAPERCLIP_COMPANY_ID:-}" ]] \
      || { echo "red_main_poll: no board source (set INCIDENT_SOURCE_CMD or PAPERCLIP_API_URL/COMPANY_ID)" >&2; return 1; }
    local key="${RED_MAIN_API_KEY:-${PAPERCLIP_API_KEY:-}}"
    [[ -n "$key" ]] || { echo "red_main_poll: no board credential (set RED_MAIN_API_KEY)" >&2; return 1; }
    local resp code
    resp="$(board_api_get "/api/companies/${PAPERCLIP_COMPANY_ID}/issues?status=${BOARD_STATUSES}&q=red-main:v1&limit=${BOARD_LIMIT}" "$key")" || return 1
    code="${resp##*$'\n'}"
    raw="${resp%$'\n'*}"
    if [[ "$code" == "403" ]]; then
      echo "red_main_poll: board read answered HTTP 403 (company-wide list; a bridge key needs RED_MAIN_ROLLUP_PARENT_ID parent-thread mode)" >&2
      return 1
    fi
    [[ "$code" == "200" ]] || { echo "red_main_poll: board read answered HTTP $code" >&2; return 1; }
  fi
  rows="$(jq -c 'if type == "array" then .
                 elif type == "object" and (.issues | type) == "array" then .issues
                 elif type == "object" and (.data | type) == "array" then .data
                 else error("unrecognised board shape") end' <<<"$raw" 2>/dev/null)" || return 1
  # An empty body makes jq print nothing and exit 0: that is a board that said
  # nothing, not a board with no incident.
  [[ -n "$rows" ]] || return 1
  n="$(jq 'length' <<<"$rows" 2>/dev/null)" || return 1
  if [[ "$n" -ge "$BOARD_LIMIT" ]]; then
    echo "red_main_poll: board read returned a full page ($n >= $BOARD_LIMIT rows); it may be truncated" >&2
    return 1
  fi
  jq -r '.[] | .title // ""' <<<"$rows" 2>/dev/null || return 1
  return 0
}

# sig_for <newline-joined-key-material> -> 8 hex chars per the contract:
# SHA-1 over the sorted, lowercased failing-check identifiers, one per line.
# Companion: the triage contract. The head SHA is
# evidence, never key (rule 1); the repo slug is part of the TAG, not the
# hash, so one repo's signature never collides with another's by omitting it.
sig_for() {
  printf '%s' "$1" | sha1sum | cut -c1-8
}

# tag_for <owner/repo> <sig8> -> the contract dedupe key bare (matches the
# triage contract verbatim so a plain board-title grep finds the card):
#   red-main:v1:{owner}/{repo}:{sig8}
tag_for() { printf 'red-main:v1:%s:%s' "$1" "$2"; }

# title_for <tag> <owner/repo> -> the incident-card title the routine files:
# the tag first, so coalescing is a substring match on the tag alone.
title_for() { printf '[%s] Red main: %s' "$1" "$2"; }

# poll_one <owner/repo> <titles-file>
# Prints one of: ENTRY <json> | UNKNOWN <reason>. Always returns 0; the
# caller tracks the worst exit separately so one blind repo cannot hide
# another repo's red (rule 4 cuts both ways: partial coverage is reported,
# not discarded).
poll_one() {
  local slug="$1" titles_file="$2" out rc=0 verdict reason names head key sig sig_source tag sev tracked checks_body main_sha
  main_sha="$(resolve_main "$slug")" || { printf 'UNKNOWN %s @ main: could not resolve main to a commit\n' "$slug"; return 0; }
  out="$(ci_json "$slug" "$main_sha")"; rc=$?
  verdict="$(jq -r '.verdict // ""' <<<"$out" 2>/dev/null)"
  reason="$(jq -r '.reason // ""' <<<"$out" 2>/dev/null)"
  case "$rc:$verdict" in
    1:fail)
      # A fail verdict with no failing check runs means the red came from
      # commit statuses or workflow runs: the stable reader reason stands in
      # for the check set, and sigSource says so. Contract downgrade path:
      # a red confined to non-required checks is S3, but required-ness is
      # not observable here, so triage alone downgrades on that evidence.
      checks_body="$(mktemp)"
      if names="$(failing_checks "$slug" "$main_sha" "$checks_body")"; then
        head="$(jq -r '[.check_runs[]? | .head_sha // ""] | map(select(length > 0)) | first // ""' "$checks_body" 2>/dev/null)"
      else
        names=""
        head=""
      fi
      rm -f "$checks_body"
      key="$(sed '/^[[:space:]]*$/d' <<<"$names" | paste -sd '\n' -)"
      if [[ -n "$key" ]]; then
        sig_source="checks"
      else
        key="$reason"
        sig_source="reason"
      fi
      sig="$(sig_for "$key")"
      tag="$(tag_for "$slug" "$sig")"
      sev="$(suggested_severity "$slug")"
      if grep -qF "$tag" "$titles_file" 2>/dev/null; then tracked=true; else tracked=false; fi
      # -c is load-bearing: callers treat each ENTRY line as one complete
      # entry. Pretty-printed JSON would spray one entry across many ENTRY-
      # prefixed lines and the propose loop would draft a card per line.
      jq -cn --arg repo "$slug" --arg sig "$sig" --arg tag "$tag" \
        --arg head "$head" --arg jobs "$key" --arg src "$sig_source" \
        --arg sev "$sev" --argjson tracked "$tracked" \
        --arg boardread "${BOARD_READ_MODE:-unknown}" \
        '{repo:$repo, signature:$sig, dedupeTag:$tag, headSha:$head,
          failingJobs:$jobs, sigSource:$src, suggestedSeverity:$sev,
          incidentExists:$tracked, boardRead:$boardread}' \
        | sed 's/^/ENTRY /'
      ;;
    0:pass) ;;
    5:non-started)
      printf 'UNKNOWN %s @ main: not started — %s\n' "$slug" "$reason"
      ;;
    *)
      printf 'UNKNOWN %s @ main: %s\n' "$slug" "${reason:-unreadable CI verdict}"
      ;;
  esac
  return 0
}

# poll_all <titles-file> <repos...>
# Prints ENTRY / UNKNOWN lines, one per repo verdict. A red observed under
# partial coverage stays reported: entries print regardless, and the exit is
# derived by the caller from the captured lines (red -> 1, unknown-only -> 3,
# clean -> 0) — so no caller can file a partial snapshot as a complete bill
# of health by reading the exit code. (The exit cannot travel in a variable:
# callers capture this in $(...), and a subshell assignment would die there.)
poll_all() {
  local titles_file="$1"; shift
  local slug
  for slug in "$@"; do
    valid_repo "$slug" || die "refusing repo coordinate '$slug' (want owner/name, no '..')"
    poll_one "$slug" "$titles_file"
  done
}

# worst_of <lines> -> 0/1/3 on stdout. Incompleteness dominates: an
# UNKNOWN anywhere means 3 even beside red entries, so no caller can mistake
# a partial sweep for a fully-observed one by reading the exit code.
worst_of() {
  if grep -q '^UNKNOWN ' <<<"$1"; then printf '3';
  elif grep -q '^ENTRY ' <<<"$1"; then printf '1';
  else printf '0'; fi
}

cmd_snapshot() {
  [[ $# -gt 0 ]] || die "usage: red_main_poll.sh snapshot <owner/repo> [...]"
  # Validate up front in the MAIN shell: poll_all runs inside $(...) downstream
  # and a `die` there would exit only the subshell, turning a refusal into a
  # wrong exit code. (poll_all keeps its own check as a backstop.)
  local slug
  for slug in "$@"; do
    valid_repo "$slug" || die "refusing repo coordinate '$slug' (want owner/name, no '..')"
  done
  local titles_file entries worst
  titles_file="$(mktemp)"
  board_titles > "$titles_file" \
    || { echo "red_main_poll: board unreadable — refusing to assert incidentExists blind (rule 3)" >&2; rm -f "$titles_file"; exit 3; }
  entries="$(poll_all "$titles_file" "$@")"
  worst="$(worst_of "$entries")"
  rm -f "$titles_file"
  # Partial coverage is not silent: UNKNOWN lines go to stderr beside the
  # fragment, so a routine operator sees which repos were unobservable.
  grep '^UNKNOWN ' <<<"$entries" >&2 || true
  printf '%s\n' "$entries" | grep '^ENTRY ' | sed 's/^ENTRY //' | jq -cs '{redMains: .}'
  return "$worst"
}

cmd_propose() {
  [[ $# -gt 0 ]] || die "usage: red_main_poll.sh propose <owner/repo> [...]"
  local slug
  for slug in "$@"; do
    valid_repo "$slug" || die "refusing repo coordinate '$slug' (want owner/name, no '..')"
  done
  local titles_file entries entry repo sig tag head jobs src sev title tracked drafts=0
  titles_file="$(mktemp)"
  board_titles > "$titles_file" \
    || { echo "red_main_poll: board unreadable — refusing to draft blind (rule 3)" >&2; rm -f "$titles_file"; exit 3; }
  entries="$(poll_all "$titles_file" "$@")"
  rm -f "$titles_file"
  # Partial coverage is not silent: UNKNOWN lines go to stderr so the routine
  # operator sees which repos were unobservable alongside any drafts.
  grep '^UNKNOWN ' <<<"$entries" >&2 || true
  while IFS= read -r line; do
    [[ "$line" == ENTRY* ]] || continue
    entry="${line#ENTRY }"
    tracked="$(jq -r '.incidentExists' <<<"$entry")"
    [[ "$tracked" == "true" ]] && continue
    repo="$(jq -r '.repo' <<<"$entry")"
    tag="$(jq -r '.dedupeTag' <<<"$entry")"
    head="$(jq -r '.headSha' <<<"$entry")"
    jobs="$(jq -r '.failingJobs' <<<"$entry")"
    src="$(jq -r '.sigSource' <<<"$entry")"
    sev="$(jq -r '.suggestedSeverity' <<<"$entry")"
    title="$(title_for "$tag" "$repo")"
    drafts=$((drafts + 1))
    printf '### %s\n\n' "$title"
    printf 'The `main` branch of `%s` is red (head `%s`).\n\n' "$repo" "${head:-unknown}"
    printf 'Failing checks: %s\n\n' "$jobs"
    printf 'Dedupe key: `%s` (signature source: %s). One open card per repo plus signature: do not open a second card while an open card carries this key; refresh evidence (at most one comment per day) and close per the triage contract.\n\n' "$tag" "$src"
    printf 'Suggested severity: %s (triage contract; triage alone downgrades to S3 on non-required-only evidence, escalates S2 to S1 after 24h unacknowledged).\n\n' "$sev"
    printf 'Triage: DevOps & Reliability Engineer confirms the signature and routes a child repair card to the repo steward via the Director. Close only on green `main` at the fixed head, citing run URL, head SHA and red duration.\n\n'
    printf 'Source: `red_main_poll.sh propose` (propose-only — the CEO routine files this, never the poller).\n\n---\n\n'
  done < <(printf '%s\n' "$entries" | grep '^ENTRY ' || true)
  # Drafts dominate (exit 1 files them); with no drafts, partial coverage is
  # still 3. Fully-tracked reds on a fully-observed sweep are 0: nothing to
  # file, nothing blind.
  if [[ "$drafts" -gt 0 ]]; then return 1; fi
  if grep -q '^UNKNOWN ' <<<"$entries"; then return 3; fi
  return 0
}

case "${1:-}" in
  snapshot) shift; cmd_snapshot "$@";;
  propose)  shift; cmd_propose "$@";;
  -h|--help|help|'') sed -n '1,60p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//';;
  *) die "unknown subcommand '$1' (want snapshot|propose)";;
esac
