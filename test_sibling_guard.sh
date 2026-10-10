#!/usr/bin/env bash
# Regression suite for sibling_guard.sh — the duplicate-implementation guard.
#
# THE BUG THIS EXISTS FOR (TOG-345). Two runs of one agent implemented TOG-258
# end to end, independently; PR #28 was closed as a duplicate of #27. TOG-253
# (#15/#16) is the same incident. The losing run HAD checked for a sibling: it
# read `ps` (silently empty in this container, for every process including its
# own) and worktree mtimes (indistinguishable from a live run parked on CI).
# Both came back "nothing", and "nothing" was read as "nothing found".
#
# So most of the assertions below are not about detecting a sibling. They are
# about the tool REFUSING TO REPORT CLEAR when a detector could not run: no API
# key, a 500, an unparseable body, no GitHub credential, an unfetchable remote.
# Every one of those must exit 3, never 0. A guard that goes green while blind
# is the original defect, re-implemented in a script where it will be trusted
# forever rather than re-derived and doubted each time.
#
# The other half is false POSITIVES, which are their own failure mode: a guard
# that cries sibling on every issue gets skipped, and a skipped guard detects
# nothing. Measured 2026-08-25: `GET /api/issues/{id}/runs` is NOT
# issue-exclusive — a run holding the shared workspace's environment lease
# appears in the run list of every issue in the company. So a foreign agentId,
# a terminal row, the caller's own row, and the caller's own branch must all
# come back clear.
#
# HERMETIC BY CONSTRUCTION. Real git against a local bare "origin" — real refs,
# real `merge-base --is-ancestor`, no network — plus one node stub on 127.0.0.1
# serving both the Paperclip and the GitHub API. Nothing leaves the loopback and
# no credential of any kind is needed to run it. Requires bash, git, node, curl.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/sibling_guard.sh"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# assert <status> <label> [diagnostic]
#
# ONE label per assertion, printed identically whether it passes or fails, so a
# ci.yml mutation gate can pin a mutation to the exact assertion it must redden.
# Detail goes in the diagnostic argument, never in the label.
assert() {
  local status="$1" label="$2" diag="${3:-}"
  if [[ "$status" -eq 0 ]]; then ok "$label"; else
    bad "$label"
    [[ -n "$diag" ]] && printf '        %s\n' "$diag"
  fi
  return 0
}

for c in git node curl; do
  command -v "$c" >/dev/null 2>&1 || { echo "test_sibling_guard: $c is required" >&2; exit 2; }
done
[[ -x "$TOOL" ]] || { echo "test_sibling_guard: $TOOL is not executable" >&2; exit 2; }

TMP="$(mktemp -d)"
cleanup() {
  [[ -n "${STUB_PID:-}" ]] && kill "$STUB_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Stub API — one server, both APIs. The case is selected by the issue id in the
# Paperclip path and by the repo NAME in the GitHub path, so every branch of the
# tool is reachable without any per-case server state.
#
# Deliberately permissive where it matters: `case-500` and `pulls-denied` return
# clean errors rather than hanging, because a tool that folded an error into
# "nothing found" would still look completely healthy from the outside.
# ---------------------------------------------------------------------------
cat > "$TMP/stub.js" <<'STUB'
const http = require('http')

const ME        = 'run-me'
const MY_AGENT  = 'agent-me'
const OTHER     = 'agent-other'

const row = (o) => Object.assign({
  runId: 'run-x', status: 'running', agentId: MY_AGENT,
  adapterType: 'claude_local', startedAt: '2026-08-25T10:00:00.000Z',
  finishedAt: null, createdAt: '2026-08-25T10:00:00.000Z',
}, o)

const myOwnRow = row({ runId: ME, agentId: MY_AGENT })

const RUNS = {
  // Only the caller's own row. The baseline: this MUST be clear, or every
  // assertion below is satisfied by a tool that always says "sibling".
  'case-clear':    [myOwnRow],
  // The TOG-258 shape: a second live run of the SAME agent.
  'case-mine':     [myOwnRow, row({ runId: 'run-sib', agentId: MY_AGENT })],
  // The environment-lease leak: another agent's live run, joined to this issue
  // because it holds the shared workspace. Measured on TOG-345 2026-08-25.
  'case-foreign':  [myOwnRow, row({ runId: 'run-foreign', agentId: OTHER })],
  // Same agent, but finished. History is not a sibling.
  'case-terminal': [myOwnRow,
                    row({ runId: 'run-done', agentId: MY_AGENT, status: 'succeeded', finishedAt: '2026-08-25T09:00:00.000Z' }),
                    row({ runId: 'run-fail', agentId: MY_AGENT, status: 'failed',    finishedAt: '2026-08-25T09:30:00.000Z' })],
  // A terminal status carrying a null finishedAt: neither test alone is enough.
  'case-terminal-nullfinish': [myOwnRow,
                    row({ runId: 'run-cancelled', agentId: MY_AGENT, status: 'cancelled', finishedAt: null })],
  // A live row with no finishedAt and a status the tool has never seen. Unknown
  // must be treated as live, not skipped.
  'case-unknown-status': [myOwnRow, row({ runId: 'run-weird', agentId: MY_AGENT, status: 'provisioning' })],
}

const ISSUES = Object.keys(RUNS).map((id, i) => ({
  id, identifier: 'TOG-90' + i, title: 'stub issue ' + id,
})).concat([{ id: 'case-500', identifier: 'TOG-950' }, { id: 'case-badjson', identifier: 'TOG-951' }])

// Older than the 500-row company list, so the list never returns them. Only
// GET /api/issues/<key> resolves these.
const OLD_ISSUES = [{ id: 'case-old', identifier: 'OPS-7' }]
const OLD_RUNS   = { 'case-old': [myOwnRow] }
// A 200 that names a different issue must not resolve the key that was asked for.
const MISMATCHED = { 'OPS-8': { id: 'case-old', identifier: 'OPS-9' } }

const PULLS = {
  none:   [],
  hit:    [{ number: 77, title: 'Do the thing (TOG-900)', body: '', head: { ref: 'feature-x' } }],
  head:   [{ number: 78, title: 'unrelated title', body: '', head: { ref: 'tog-900-sibling' } }],
  mine:   [{ number: 79, title: 'mine (TOG-900)', body: '', head: { ref: 'CURRENT' } }],
  // Same-head fixtures. The body Refs line is the attribution source:
  // `foreign` is claimed by a different card, `self` by this one,
  // `unclaimed` names no card. Titles carry no card key on purpose, so the
  // refusal below can only come from the Refs line, never a substring.
  // STUB_CURRENT_BRANCH is spliced into CURRENT below, so the caller head
  // sits on each of these branches in turn.
  foreign: [{ number: 881, title: 'shared branch work', body: 'Refs: TOG-907', head: { ref: 'CURRENT' } }],
  self:    [{ number: 882, title: 'mine (TOG-900)', body: 'Refs: TOG-900', head: { ref: 'CURRENT' } }],
  unclaimed: [{ number: 883, title: 'no refs line', body: 'just a description', head: { ref: 'CURRENT' } }],
  denied: 403,
  bad:    'not json at all',
}

const srv = http.createServer((req, res) => {
  const url = req.url.split('?')[0]
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }

  let m
  if ((m = url.match(/^\/api\/companies\/[^/]+\/issues$/))) return send(200, ISSUES)
  // Listed keys 404 here on purpose: they must reach the list fallback, which
  // stays under test. Only the old tail is served by key.
  if ((m = url.match(/^\/api\/issues\/([^/]+)$/))) {
    if (MISMATCHED[m[1]]) return send(200, MISMATCHED[m[1]])
    const hit = OLD_ISSUES.find(i => i.identifier === m[1])
    return hit ? send(200, hit) : send(404, { error: 'no such issue' })
  }
  if ((m = url.match(/^\/api\/issues\/([^/]+)\/runs$/))) {
    const id = m[1]
    if (id === 'case-500') return send(500, { error: 'boom' })
    if (id === 'case-badjson') return send(200, '<html>not json</html>')
    if (RUNS[id] || OLD_RUNS[id]) return send(200, RUNS[id] || OLD_RUNS[id])
    return send(404, { error: 'no such issue' })
  }
  if ((m = url.match(/^\/repos\/[^/]+\/([^/]+)\/pulls$/))) {
    const v = PULLS[m[1]]
    if (v === undefined) return send(404, { error: 'no such repo' })
    if (v === 403) return send(403, { message: 'Resource not accessible' })
    if (typeof v === 'string') return send(200, v)
    const branch = process.env.STUB_CURRENT_BRANCH || ''
    return send(200, v.map(p => p.head.ref === 'CURRENT'
      ? Object.assign({}, p, { head: { ref: branch } }) : p))
  }
  return send(404, { error: 'API route not found' })
})
srv.listen(0, '127.0.0.1', () => console.log(srv.address().port))
STUB

STUB_CURRENT_BRANCH="tog-900-work" node "$TMP/stub.js" > "$TMP/port.txt" 2>"$TMP/stub.err" &
STUB_PID=$!
for _ in $(seq 1 50); do [[ -s "$TMP/port.txt" ]] && break; sleep 0.1; done
PORT="$(tr -d '\n' < "$TMP/port.txt")"
[[ -n "$PORT" ]] || { echo "test_sibling_guard: stub server did not start: $(cat "$TMP/stub.err")" >&2; exit 2; }
BASE="http://127.0.0.1:$PORT"

# ---------------------------------------------------------------------------
# Git fixtures. A bare "origin" plus clones. Real refs, real ancestry, no
# network — the ancestor test in particular is worth exercising for real, since
# a hand-stubbed `merge-base` would only prove the stub agrees with the tool.
#
# `credential.helper=` (empty) and GIT_TERMINAL_PROMPT=0 make the tool's
# credential fallback return nothing instead of reaching this box's real broker
# helper. That is also the fixture for "no GitHub credential".
# ---------------------------------------------------------------------------
export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_GLOBAL="$TMP/gitconfig"
export GIT_CONFIG_SYSTEM=/dev/null
cat > "$GIT_CONFIG_GLOBAL" <<'GC'
[user]
	name = suite
	email = suite@example.invalid
[init]
	defaultBranch = main
[credential]
	helper =
[protocol]
	allow = always
GC

ORIGIN="$TMP/origin.git"
git init --quiet --bare -b main "$ORIGIN"
SEED="$TMP/seed"
git init --quiet -b main "$SEED" && (
  cd "$SEED"
  echo one > file.txt
  git add file.txt && git -c user.name=suite -c user.email=suite@example.invalid commit --quiet -m "seed"
  git remote add origin "$ORIGIN" && git push --quiet -u origin main
)

# mkclone <dir> — a fresh clone of origin on main.
mkclone() { git clone --quiet "$ORIGIN" "$1"; }

# run_guard <cwd> <issue> [extra args...] — invoke the tool with the stub wired
# in. Stdout+stderr land in $OUT, the exit code in $RC.
OUT=""; RC=0
run_guard() {
  local cwd="$1" issue="$2"; shift 2
  # OVERRIDE_GH_TOKEN="" must survive the broker shim: the shim re-mints a real
  # GH_TOKEN from PAPERCLIP_GITHUB_BROKER_TOKEN even when GH_TOKEN was cleared,
  # so the "no credential" case never goes blind. Clearing both broker vars
  # makes the shim report capability_missing and leave GH_TOKEN empty, which
  # then makes `git credential fill` fail — the fixture for that case.
  if [[ "${OVERRIDE_GH_TOKEN-sentinel}" == "" ]]; then
    OUT="$( cd "$cwd" && \
      PAPERCLIP_API_URL="$BASE" \
      PAPERCLIP_API_KEY="${OVERRIDE_KEY-stub-key}" \
      PAPERCLIP_COMPANY_ID="${OVERRIDE_CO-stub-co}" \
      PAPERCLIP_AGENT_ID="${OVERRIDE_AGENT-agent-me}" \
      PAPERCLIP_RUN_ID="${OVERRIDE_RUN-run-me}" \
      GH_API_URL="$BASE" \
      PAPERCLIP_GITHUB_BROKER_TOKEN="" PAPERCLIP_GITHUB_BROKER_URL="" GH_TOKEN="" \
      "$TOOL" "$issue" "$@" 2>&1 )"
  else
    OUT="$( cd "$cwd" && \
      PAPERCLIP_API_URL="$BASE" \
      PAPERCLIP_API_KEY="${OVERRIDE_KEY-stub-key}" \
      PAPERCLIP_COMPANY_ID="${OVERRIDE_CO-stub-co}" \
      PAPERCLIP_AGENT_ID="${OVERRIDE_AGENT-agent-me}" \
      PAPERCLIP_RUN_ID="${OVERRIDE_RUN-run-me}" \
      GH_API_URL="$BASE" \
      GH_TOKEN="${OVERRIDE_GH_TOKEN-stub-gh-token}" \
      "$TOOL" "$issue" "$@" 2>&1 )"
  fi
  RC=$?
  return 0
}

# ===========================================================================
hdr "1. The baseline. A clean issue must come back CLEAR."
# Without this, every assertion below is satisfied by a tool hardwired to say
# "sibling" — which detects the duplicate and stops all work forever.
CLEAN="$TMP/clean"; mkclone "$CLEAN"
run_guard "$CLEAN" TOG-900 --repo=stub/none
assert "$([[ "$RC" -eq 0 ]] && echo 0 || echo 1)" \
  "a clean issue with all three detectors running exits 0" "rc=$RC out=$OUT"
assert "$(grep -q "VERDICT: clear" <<< "$OUT" && echo 0 || echo 1)" \
  "the clean verdict is reported as clear" "$OUT"

# ===========================================================================
hdr "2. Blindness is never a pass. Every detector that cannot run exits 3."
# This block is the reason the tool exists. `ps` returning nothing was read as
# "no sibling"; each case here is the same shape in a different disguise.

OVERRIDE_KEY="" run_guard "$CLEAN" TOG-900 --repo=stub/none
assert "$([[ "$RC" -eq 3 ]] && echo 0 || echo 1)" \
  "a missing PAPERCLIP_API_KEY exits 3, not 0" "rc=$RC out=$OUT"

OVERRIDE_RUN="" run_guard "$CLEAN" TOG-900 --repo=stub/none
assert "$([[ "$RC" -eq 3 ]] && echo 0 || echo 1)" \
  "a missing PAPERCLIP_RUN_ID exits 3, not 0" "rc=$RC out=$OUT"

OVERRIDE_AGENT="" run_guard "$CLEAN" TOG-900 --repo=stub/none
assert "$([[ "$RC" -eq 3 ]] && echo 0 || echo 1)" \
  "a missing PAPERCLIP_AGENT_ID exits 3, not 0" "rc=$RC out=$OUT"

OVERRIDE_CO="" run_guard "$CLEAN" TOG-900 --repo=stub/none
assert "$([[ "$RC" -eq 3 ]] && echo 0 || echo 1)" \
  "an unresolvable issue key exits 3, not 0" "rc=$RC out=$OUT"

run_guard "$CLEAN" TOG-950 --repo=stub/none
assert "$([[ "$RC" -eq 3 ]] && echo 0 || echo 1)" \
  "a 500 from the run list exits 3, not 0" "rc=$RC out=$OUT"

run_guard "$CLEAN" TOG-951 --repo=stub/none
assert "$([[ "$RC" -eq 3 ]] && echo 0 || echo 1)" \
  "an unparseable run list exits 3, not 0" "rc=$RC out=$OUT"

OVERRIDE_GH_TOKEN="" run_guard "$CLEAN" TOG-900 --repo=stub/none
assert "$([[ "$RC" -eq 3 ]] && echo 0 || echo 1)" \
  "no GitHub credential at all exits 3, not 0" "rc=$RC out=$OUT"

run_guard "$CLEAN" TOG-900 --repo=stub/denied
assert "$([[ "$RC" -eq 3 ]] && echo 0 || echo 1)" \
  "a 403 on the pull request list exits 3, not 0" "rc=$RC out=$OUT"

run_guard "$CLEAN" TOG-900 --repo=stub/bad
assert "$([[ "$RC" -eq 3 ]] && echo 0 || echo 1)" \
  "an unparseable pull request list exits 3, not 0" "rc=$RC out=$OUT"

NOREMOTE="$TMP/noremote"; git init --quiet -b main "$NOREMOTE" && (cd "$NOREMOTE" && echo x > a && git add a && git -c user.name=suite -c user.email=suite@example.invalid commit --quiet -m x)
run_guard "$NOREMOTE" TOG-900 --repo=stub/none
assert "$([[ "$RC" -eq 3 ]] && echo 0 || echo 1)" \
  "a clone with no origin exits 3, not 0" "rc=$RC out=$OUT"

BADREMOTE="$TMP/badremote"; mkclone "$BADREMOTE"
(cd "$BADREMOTE" && git remote set-url origin "$TMP/does-not-exist.git")
run_guard "$BADREMOTE" TOG-900 --repo=stub/none
assert "$([[ "$RC" -eq 3 ]] && echo 0 || echo 1)" \
  "a fetch that fails exits 3, not 0" "rc=$RC out=$OUT"

SIBLING_GUARD_NO_FETCH=1 run_guard "$CLEAN" TOG-900 --repo=stub/none
assert "$([[ "$RC" -eq 3 ]] && echo 0 || echo 1)" \
  "a deliberately skipped fetch exits 3, not 0" "rc=$RC out=$OUT"

assert "$(grep -qi "COULD NOT RUN" <<< "$OUT" && echo 0 || echo 1)" \
  "an unrunnable detector is named in the report" "$OUT"

# ===========================================================================
hdr "3. The control plane finds a sibling nobody else can see."
# The leading signal: a second run of my own agent that has committed nothing,
# pushed nothing, and opened nothing. On TOG-258 this was the state of the world
# at the moment the losing run decided to start.

run_guard "$CLEAN" TOG-901 --repo=stub/none
assert "$([[ "$RC" -eq 1 ]] && echo 0 || echo 1)" \
  "a live run of my own agent on my issue exits 1" "rc=$RC out=$OUT"
assert "$(grep -q "run-sib" <<< "$OUT" && echo 0 || echo 1)" \
  "the sibling run id is named in the report" "$OUT"

run_guard "$CLEAN" TOG-905 --repo=stub/none
assert "$([[ "$RC" -eq 1 ]] && echo 0 || echo 1)" \
  "a live row with an unrecognised status counts as a sibling" "rc=$RC out=$OUT"

# ===========================================================================
hdr "4. And does not fire on rows that are not siblings."
# A guard that fires on every issue is a guard that gets skipped.

run_guard "$CLEAN" TOG-902 --repo=stub/none
assert "$([[ "$RC" -eq 0 ]] && echo 0 || echo 1)" \
  "another agent's live run on my issue is not a sibling verdict" "rc=$RC out=$OUT"
assert "$(grep -q "run-foreign" <<< "$OUT" && echo 0 || echo 1)" \
  "another agent's live run is still reported" "$OUT"

run_guard "$CLEAN" TOG-903 --repo=stub/none
assert "$([[ "$RC" -eq 0 ]] && echo 0 || echo 1)" \
  "my agent's finished runs on this issue are not siblings" "rc=$RC out=$OUT"

run_guard "$CLEAN" TOG-904 --repo=stub/none
assert "$([[ "$RC" -eq 0 ]] && echo 0 || echo 1)" \
  "a terminal status with a null finishedAt is not a sibling" "rc=$RC out=$OUT"

run_guard "$CLEAN" TOG-901 --repo=stub/none
assert "$(grep -q 'run run-me of MY OWN' <<< "$OUT" && echo 1 || echo 0)" \
  "the caller never detects its own run as a sibling" "rc=$RC out=$OUT"

# ===========================================================================
hdr "5. Local refs — the only signal for finished-but-unpushed work."
# TOG-339: the complete fix sat as a local commit on a sibling's branch while
# the remote said nothing existed at all.

AHEAD="$TMP/ahead"; mkclone "$AHEAD"
(cd "$AHEAD" && git checkout --quiet -b tog-900-sibling && echo two >> file.txt \
   && git -c user.name=suite -c user.email=suite@example.invalid commit --quiet -am "sibling work" && git checkout --quiet main)
run_guard "$AHEAD" TOG-900 --repo=stub/none
assert "$([[ "$RC" -eq 1 ]] && echo 0 || echo 1)" \
  "a local branch naming the issue and ahead of origin/main exits 1" "rc=$RC out=$OUT"
assert "$(grep -q "tog-900-sibling" <<< "$OUT" && echo 0 || echo 1)" \
  "the local sibling branch is named in the report" "$OUT"

# The same branch pointing at origin/main. A dead run's empty leftover, which is
# exactly what this issue's own first failed run left behind. Reporting it as
# sibling work would train the reader to ignore the tool.
EMPTY="$TMP/emptybranch"; mkclone "$EMPTY"
(cd "$EMPTY" && git branch --quiet tog-900-leftover origin/main)
run_guard "$EMPTY" TOG-900 --repo=stub/none
assert "$([[ "$RC" -eq 0 ]] && echo 0 || echo 1)" \
  "a local branch carrying no commits is not sibling work" "rc=$RC out=$OUT"

# Standing on your own branch must not detect yourself.
SELF="$TMP/self"; mkclone "$SELF"
(cd "$SELF" && git checkout --quiet -b tog-901-work && echo mine >> file.txt && git -c user.name=suite -c user.email=suite@example.invalid commit --quiet -am "my work")
run_guard "$SELF" TOG-901 --repo=stub/none
assert "$(grep -qv "tog-901-work is" <<< "$OUT" && grep -q "run-sib" <<< "$OUT" && echo 0 || echo 1)" \
  "the branch the caller is standing on is not reported as a sibling branch" "$OUT"

# ===========================================================================
hdr "6. Remote — a pushed branch, and an open PR."

PUSHED="$TMP/pushed"; mkclone "$PUSHED"
(cd "$PUSHED" && git checkout --quiet -b tog-901-pushed && echo p >> file.txt \
   && git -c user.name=suite -c user.email=suite@example.invalid commit --quiet -am push && git push --quiet -u origin tog-901-pushed \
   && git checkout --quiet main && git branch -D tog-901-pushed >/dev/null 2>&1)
FRESH="$TMP/fresh"; mkclone "$FRESH"
run_guard "$FRESH" TOG-901 --repo=stub/none
assert "$(grep -q "tog-901-pushed" <<< "$OUT" && echo 0 || echo 1)" \
  "a branch pushed to origin naming the issue is reported" "$OUT"
assert "$([[ "$RC" -eq 1 ]] && echo 0 || echo 1)" \
  "a branch pushed to origin naming the issue exits 1" "rc=$RC out=$OUT"

run_guard "$CLEAN" TOG-900 --repo=stub/hit
assert "$([[ "$RC" -eq 1 ]] && echo 0 || echo 1)" \
  "an open PR whose title names the issue exits 1" "rc=$RC out=$OUT"
assert "$(grep -q "#77" <<< "$OUT" && echo 0 || echo 1)" \
  "the duplicate PR number is named in the report" "$OUT"

run_guard "$CLEAN" TOG-900 --repo=stub/head
assert "$([[ "$RC" -eq 1 ]] && echo 0 || echo 1)" \
  "an open PR whose head branch names the issue exits 1" "rc=$RC out=$OUT"

# The caller's own PR is not a duplicate of itself. This is the pre-push repeat:
# by then you have usually already opened your own PR, and a guard that fires on
# it makes the required second check useless.
MYPR="$TMP/mypr"; mkclone "$MYPR"
(cd "$MYPR" && git checkout --quiet -b tog-900-work)
run_guard "$MYPR" TOG-900 --repo=stub/mine
assert "$([[ "$RC" -eq 0 ]] && echo 0 || echo 1)" \
  "an open PR on the caller's own head branch is not a sibling" "rc=$RC out=$OUT"

# ===========================================================================
hdr "6b. Same-head ownership at prepush (two cards, one branch)."
# Two cards, one branch, both pushed. The old PR scan skipped the
# caller's own head branch, so a same-head PR claimed by a DIFFERENT card
# read as clear. Attribution is the body `Refs:` line ONLY, so a mention
# elsewhere in the body does not count; your own Refs, or no Refs at all,
# stays clear.

# Start phase keeps the old skip: nothing is being pushed yet.
run_guard "$MYPR" TOG-900 --repo=stub/foreign
assert "$([[ "$RC" -eq 0 ]] && echo 0 || echo 1)" \
  "at start, a same-head PR claimed by another card is not yet a refusal" "rc=$RC out=$OUT"

# The prepush half runs on MYPR itself: it stands on tog-900-work, which the
# stub splices into CURRENT, so each fixture PR sits on the caller's own head
# — the same-head shape. One commit first, or the already-landed test fires
# and every assertion below is satisfied by the wrong finding. (The stub
# server is a separate process: its STUB_CURRENT_BRANCH is fixed at spawn, so
# the fixture branch must be the spawn-time value, not a re-export.)
(cd "$MYPR" && echo pushme >> file.txt && git -c user.name=suite -c user.email=suite@example.invalid commit --quiet -am "my push")
run_guard "$MYPR" TOG-900 --repo=stub/foreign --phase=prepush
assert "$([[ "$RC" -eq 1 ]] && echo 0 || echo 1)" \
  "at prepush, a same-head PR claimed by another card exits 1" "rc=$RC out=$OUT"
assert "$(grep -q "TOG-907" <<< "$OUT" && echo 0 || echo 1)" \
  "the sibling card owning the PR branch is named in the report" "$OUT"
assert "$(grep -q "#881" <<< "$OUT" && echo 0 || echo 1)" \
  "the same-head PR number is named in the report" "$OUT"
assert "$(grep -q "owns this PR branch" <<< "$OUT" && echo 0 || echo 1)" \
  "the refusal names the ownership, not the already-landed test" "$OUT"

run_guard "$MYPR" TOG-900 --repo=stub/self --phase=prepush
assert "$([[ "$RC" -eq 0 ]] && echo 0 || echo 1)" \
  "at prepush, a same-head PR claiming this card is your own, exits 0" "rc=$RC out=$OUT"

run_guard "$MYPR" TOG-900 --repo=stub/unclaimed --phase=prepush
assert "$([[ "$RC" -eq 0 ]] && echo 0 || echo 1)" \
  "at prepush, a same-head PR naming no card stays clear" "rc=$RC out=$OUT"

# ===========================================================================
hdr "7. The pre-push phase, and the already-landed test."
# On TOG-258 a correct start-time check would still have come back clear: the
# sibling landed DURING the loser's CI wait. The re-check before pushing is the
# half that would actually have caught it.

LANDED="$TMP/landed"; mkclone "$LANDED"
run_guard "$LANDED" TOG-900 --repo=stub/none --phase=prepush
assert "$([[ "$RC" -eq 1 ]] && echo 0 || echo 1)" \
  "at prepush, a HEAD already reachable from origin/main exits 1" "rc=$RC out=$OUT"
assert "$(grep -qi "already an ancestor" <<< "$OUT" && echo 0 || echo 1)" \
  "the already-landed finding says the work is already on origin/main" "$OUT"

# The same repo at start phase. HEAD sits on origin/main at the beginning of
# every piece of work, so running the ancestor test then would fire on
# everything and the guard would be turned off within a day.
run_guard "$LANDED" TOG-900 --repo=stub/none --phase=start
assert "$([[ "$RC" -eq 0 ]] && echo 0 || echo 1)" \
  "at start, a HEAD sitting on origin/main is not already-landed" "rc=$RC out=$OUT"

WORK="$TMP/work"; mkclone "$WORK"
(cd "$WORK" && git checkout --quiet -b tog-901-work && echo w >> file.txt && git -c user.name=suite -c user.email=suite@example.invalid commit --quiet -am w)
run_guard "$WORK" TOG-900 --repo=stub/none --phase=prepush
assert "$([[ "$RC" -eq 0 ]] && echo 0 || echo 1)" \
  "at prepush, unlanded work on a fresh branch is clear" "rc=$RC out=$OUT"

SIBLING_GUARD_NO_FETCH=1 run_guard "$WORK" TOG-900 --repo=stub/none --phase=prepush
assert "$([[ "$RC" -eq 3 ]] && echo 0 || echo 1)" \
  "at prepush, an ancestor test on an unfetched origin exits 3" "rc=$RC out=$OUT"

# ===========================================================================
hdr "8. A finding outranks blindness."
# If a sibling is found AND a detector was blind, the answer is 1. Exit 3 would
# read as "inconclusive, try again", and the caller would push anyway.

OVERRIDE_GH_TOKEN="" run_guard "$AHEAD" TOG-901 --repo=stub/none
assert "$([[ "$RC" -eq 1 ]] && echo 0 || echo 1)" \
  "a sibling found while another detector is blind still exits 1" "rc=$RC out=$OUT"

# ===========================================================================
hdr "9. Invocation contract."

run_guard "$CLEAN" TOG-900 --phase=sideways --repo=stub/none
assert "$([[ "$RC" -eq 2 ]] && echo 0 || echo 1)" \
  "an unknown phase is a usage error" "rc=$RC out=$OUT"

OUT="$("$TOOL" 2>&1)"; RC=$?
assert "$([[ "$RC" -eq 2 ]] && echo 0 || echo 1)" \
  "no issue argument is a usage error" "rc=$RC out=$OUT"

OUT="$("$TOOL" TOG-900 EXTRA 2>&1)"; RC=$?
assert "$([[ "$RC" -eq 2 ]] && echo 0 || echo 1)" \
  "two issue arguments are a usage error" "rc=$RC out=$OUT"

OUT="$("$TOOL" 'TOG-900;rm -rf /' 2>&1)"; RC=$?
assert "$([[ "$RC" -eq 2 ]] && echo 0 || echo 1)" \
  "an issue argument that is not a bare key or uuid is refused" "rc=$RC out=$OUT"

run_guard "$CLEAN" TOG-901 --repo=stub/none --json
assert "$(node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);process.exit(j.verdict==="sibling"&&j.exitCode===1&&j.findings.length>0?0:1)})' <<< "$OUT" && echo 0 || echo 1)" \
  "--json reports the verdict, the exit code and the findings" "$OUT"

OVERRIDE_GH_TOKEN="" run_guard "$CLEAN" TOG-900 --repo=stub/none --json
assert "$(node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);process.exit(j.verdict==="indeterminate"&&j.couldNotRun.length>0?0:1)})' <<< "$OUT" && echo 0 || echo 1)" \
  "--json names the detectors that could not run" "$OUT"

# ===========================================================================
hdr "10. The tool never consults the process table."
# `ps` is empty in this container for every process including the caller's own,
# and reading that emptiness as 'no sibling' is the whole of TOG-258. Anyone
# reaching for it again is reaching for a signal that is known to carry zero
# information here. grep, not behaviour, because the failure is that it would
# LOOK like it worked.

# Comments are stripped first: the tool's header EXPLAINS why ps is useless
# here, and that explanation is the most valuable line in the file.
CODE_ONLY="$TMP/tool-code.sh"; grep -vE '^[[:space:]]*#' "$TOOL" > "$CODE_ONLY"
assert "$(grep -nE '(^|[^[:alnum:]_])(ps|pgrep)([[:space:]]|$)' "$CODE_ONLY" >/dev/null && echo 1 || echo 0)" \
  "sibling_guard.sh does not invoke ps" "$(grep -nE '(^|[^[:alnum:]_])(ps|pgrep)([[:space:]]|$)' "$CODE_ONLY" || true)"

assert "$(grep -q 'pgrep\|/proc/' "$CODE_ONLY" && echo 1 || echo 0)" \
  "sibling_guard.sh does not read the process table another way" \
  "$(grep -n 'pgrep\|/proc/' "$CODE_ONLY" || true)"

# No credential may reach argv: /proc/*/cmdline is world readable on this box.
assert "$(grep -nE 'curl[^|]*(\$GH_TOKEN|\$token|\$PAPERCLIP_API_KEY|\$key)' "$TOOL" >/dev/null && echo 1 || echo 0)" \
  "no credential is passed to curl on the command line" \
  "$(grep -nE 'curl[^|]*(\$GH_TOKEN|\$token|\$PAPERCLIP_API_KEY|\$key)' "$TOOL" || true)"

# ===========================================================================
hdr "11. An old key resolves through its own endpoint, not the 500-row list."
# The company list returns the 500 newest issues, so an older key is found only
# by GET /api/issues/<key>. A key that neither lookup finds stays blind.

run_guard "$CLEAN" OPS-7 --repo=stub/none
assert "$([[ "$RC" -eq 0 ]] && echo 0 || echo 1)" \
  "an old key outside the company list resolves and is read, exits 0" "rc=$RC out=$OUT"
assert "$(grep -q "read case-old run list" <<< "$OUT" && echo 0 || echo 1)" \
  "the old key resolves to the issue it names" "$OUT"

run_guard "$CLEAN" OPS-404 --repo=stub/none
assert "$([[ "$RC" -eq 3 ]] && echo 0 || echo 1)" \
  "a key that 404s by key and is absent from the list stays blind, exits 3" "rc=$RC out=$OUT"

run_guard "$CLEAN" OPS-8 --repo=stub/none
assert "$([[ "$RC" -eq 3 ]] && echo 0 || echo 1)" \
  "a 200 that names a different issue does not resolve the key, exits 3" "rc=$RC out=$OUT"

# ===========================================================================
printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
