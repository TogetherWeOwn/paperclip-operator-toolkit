#!/usr/bin/env bash
# Acceptance tests for Land #87 (sibling-guard branch attribution).
#
# Card: TOG-24847. Paired with the Land #87 finish work
# (PR TogetherWeOwn/paperclip-operator-toolkit#87).
#
# LANDING RISKS PINNED HERE (fail before the #87 fix, pass after):
#  1. Cross-card branch-name substring: another card's branch that names the
#     requested key only as a secondary token (e.g.
#     `tog-907-...-so-tog-900-...` when asked for TOG-900) must stay clear
#     through the local-refs detector, the remote pushed-branch detector,
#     AND the generic open-PR head-relevance check.
#  2. Namespaced-branch attribution: branches where the key starts a whole
#     path segment (`ops/<key>-...`, `<key>/...`) are PRIMARY ownership and
#     must still refuse — and the remote detector must name the full remote
#     ref (`origin/ops/<key>-...`), not just its basename.
#
# ANTI-REGRESSION PINS (pass before and after — they stop a naive
# exact/leading-prefix-only fix from over-narrowing):
#  - prefix-owned (`<key>-...`) and bare (`<key>`) branches still refuse.
#
# HERMETIC: real git against a local bare "origin" plus a node stub on
# 127.0.0.1 serving both the Paperclip and GitHub APIs. Requires bash, git,
# node, curl. Test files only — the Builder implements sibling_guard.sh on
# this branch without touching this file.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${SIBLING_GUARD_TOOL:-$HERE/sibling_guard.sh}"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# assert <status> <label> [diagnostic] — one label per assertion.
assert() {
  local status="$1" label="$2" diag="${3:-}"
  if [[ "$status" -eq 0 ]]; then ok "$label"; else
    bad "$label"
    [[ -n "$diag" ]] && printf '        %s\n' "$diag"
  fi
  return 0
}

for c in git node curl; do
  command -v "$c" >/dev/null 2>&1 || { echo "land87 acceptance: $c is required" >&2; exit 2; }
done
[[ -x "$TOOL" ]] || { echo "land87 acceptance: $TOOL is not executable" >&2; exit 2; }

TMP="$(mktemp -d)"
cleanup() {
  [[ -n "${STUB_PID:-}" ]] && kill "$STUB_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

# --- stub API ---------------------------------------------------------------
cat > "$TMP/stub.js" <<'STUB'
const http = require('http')
const ME = 'run-me', MY_AGENT = 'agent-me'
const row = (o) => Object.assign({
  runId: 'run-x', status: 'running', agentId: MY_AGENT,
  adapterType: 'claude_local', startedAt: '2026-08-25T10:00:00.000Z',
  finishedAt: null, createdAt: '2026-08-25T10:00:00.000Z',
}, o)
const myOwnRow = row({ runId: ME, agentId: MY_AGENT })
const RUNS = { 'case-clear': [myOwnRow] }
const ISSUES = [{ id: 'case-clear', identifier: 'TOG-901', title: 'stub' }]
const OLD_ISSUES = [{ id: '11111111-2222-3333-4444-555555555555', identifier: 'TOG-900' }]
const OLD_RUNS = { '11111111-2222-3333-4444-555555555555': [myOwnRow] }
const PULLS = {
  none: [],
  // Cross-card open PR: head branch owned by TOG-907 names TOG-900 only as a
  // secondary token; title carries no key; Refs names only the foreign card.
  crosscardpr: [{ number: 927, title: 'bump pin', body: 'Refs: TOG-907',
    head: { ref: 'tog-907-bump-pin-so-tog-900-reruns-green', sha: 'DISTINCT' } }],
}
const srv = http.createServer((req, res) => {
  const url = req.url.split('?')[0]
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }
  let m
  if ((m = url.match(/^\/api\/companies\/[^/]+\/issues$/))) return send(200, ISSUES)
  if ((m = url.match(/^\/api\/issues\/([^/]+)$/))) {
    const hit = OLD_ISSUES.find(i => i.identifier === m[1] || i.id === m[1])
    return hit ? send(200, hit) : send(404, { error: 'no such issue' })
  }
  if ((m = url.match(/^\/api\/issues\/([^/]+)\/runs$/))) {
    const id = m[1]
    if (RUNS[id] || OLD_RUNS[id]) return send(200, RUNS[id] || OLD_RUNS[id])
    return send(404, { error: 'no such issue' })
  }
  if ((m = url.match(/^\/repos\/[^/]+\/([^/]+)\/pulls$/))) {
    const v = PULLS[m[1]]
    if (v === undefined) return send(404, { error: 'no such repo' })
    let sameSha = ''
    try { sameSha = require('fs').readFileSync(process.env.STUB_SHA_FILE || '', 'utf8').trim() } catch (e) { sameSha = '' }
    return send(200, v.map(p => {
      let head = p.head
      if (head && head.sha === 'SAMESHA') head = Object.assign({}, head, { sha: sameSha })
      if (head && head.sha === 'DISTINCT') head = Object.assign({}, head, { sha: '0000000000000000000000000000000000000000' })
      return (head === p.head) ? p : Object.assign({}, p, { head })
    }))
  }
  return send(404, { error: 'API route not found' })
})
srv.listen(0, '127.0.0.1', () => console.log(srv.address().port))
STUB

STUB_CURRENT_BRANCH="tog-900-work" STUB_SHA_FILE="$TMP/sha.txt" node "$TMP/stub.js" > "$TMP/port.txt" 2>"$TMP/stub.err" &
STUB_PID=$!
for _ in $(seq 1 50); do [[ -s "$TMP/port.txt" ]] && break; sleep 0.1; done
PORT="$(tr -d '\n' < "$TMP/port.txt")"
[[ -n "$PORT" ]] || { echo "land87 acceptance: stub did not start: $(cat "$TMP/stub.err")" >&2; exit 2; }
BASE="http://127.0.0.1:$PORT"

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

mkclone() { git clone --quiet "$ORIGIN" "$1"; }

OUT=""; RC=0
run_guard() {
  local cwd="$1" issue="$2"; shift 2
  OUT="$( cd "$cwd" && \
    PAPERCLIP_API_URL="$BASE" \
    PAPERCLIP_API_KEY="stub-key" \
    PAPERCLIP_COMPANY_ID="stub-co" \
    PAPERCLIP_AGENT_ID="agent-me" \
    PAPERCLIP_RUN_ID="run-me" \
    GH_API_URL="$BASE" \
    GH_TOKEN="stub-gh-token" \
    "$TOOL" "$issue" "$@" 2>&1 )"
  RC=$?
  return 0
}

# ===========================================================================
hdr "Land87-1. Cross-card branch-name substring stays clear (local)."
# TOG-900 requested; branch owned by TOG-907 names it only secondarily.
XC="$TMP/xc"; mkclone "$XC"
(cd "$XC" && git checkout --quiet -b tog-907-bump-pin-so-tog-900-reruns-green && echo cross >> file.txt \
  && git -c user.name=suite -c user.email=suite@example.invalid commit --quiet -am "other card work" && git checkout --quiet main)
run_guard "$XC" TOG-900 --repo=stub/none
assert "$([[ "$RC" -eq 0 ]] && echo 0 || echo 1)" \
  "land87 local cross-card substring stays clear" "rc=$RC out=$OUT"
assert "$(grep -q "VERDICT: clear" <<< "$OUT" && echo 0 || echo 1)" \
  "land87 local cross-card verdict is clear" "$OUT"

# ===========================================================================
hdr "Land87-2. Cross-card pushed-branch substring stays clear (remote)."
REMXC="$TMP/remxc-push"; mkclone "$REMXC"
(cd "$REMXC" && git checkout --quiet -b tog-907-bump-pin-so-tog-900-reruns-remote-green && echo rx >> file.txt \
  && git -c user.name=suite -c user.email=suite@example.invalid commit --quiet -am "other card pushed" \
  && git push --quiet -u origin tog-907-bump-pin-so-tog-900-reruns-remote-green)
REMXF="$TMP/remxc-fresh"; mkclone "$REMXF"
run_guard "$REMXF" TOG-900 --repo=stub/none
assert "$([[ "$RC" -eq 0 ]] && echo 0 || echo 1)" \
  "land87 remote cross-card substring stays clear" "rc=$RC out=$OUT"

# ===========================================================================
hdr "Land87-3. Namespaced branches are primary ownership (local + remote)."
NSL="$TMP/nsl"; mkclone "$NSL"
(cd "$NSL" && git checkout --quiet -b ops/tog-900-widget && echo ns >> file.txt \
  && git -c user.name=suite -c user.email=suite@example.invalid commit --quiet -am "namespaced work" && git checkout --quiet main)
run_guard "$NSL" TOG-900 --repo=stub/none
assert "$([[ "$RC" -eq 1 ]] && echo 0 || echo 1)" \
  "land87 namespaced local branch still refuses" "rc=$RC out=$OUT"
assert "$(grep -q "ops/tog-900-widget" <<< "$OUT" && echo 0 || echo 1)" \
  "land87 namespaced local branch is named" "$OUT"

NSGL="$TMP/nsgl"; mkclone "$NSGL"
(cd "$NSGL" && git checkout --quiet -b tog-900/widget && echo ns >> file.txt \
  && git -c user.name=suite -c user.email=suite@example.invalid commit --quiet -am "segment work" && git checkout --quiet main)
run_guard "$NSGL" TOG-900 --repo=stub/none
assert "$([[ "$RC" -eq 1 ]] && echo 0 || echo 1)" \
  "land87 segment local branch still refuses" "rc=$RC out=$OUT"

REMNS="$TMP/remns-push"; mkclone "$REMNS"
(cd "$REMNS" && git checkout --quiet -b ops/tog-900-remote-widget && echo rn >> file.txt \
  && git -c user.name=suite -c user.email=suite@example.invalid commit --quiet -am "namespaced pushed" \
  && git push --quiet -u origin ops/tog-900-remote-widget)
REMNSF="$TMP/remns-fresh"; mkclone "$REMNSF"
run_guard "$REMNSF" TOG-900 --repo=stub/none
assert "$([[ "$RC" -eq 1 ]] && echo 0 || echo 1)" \
  "land87 namespaced pushed branch still refuses" "rc=$RC out=$OUT"
# Full-ref naming: the fix reports `origin/ops/<key>-...`, not just the
# basename. Pre-fix basename-only output fails this pin.
assert "$(grep -q "origin/ops/tog-900-remote-widget" <<< "$OUT" && echo 0 || echo 1)" \
  "land87 namespaced pushed branch is named by full remote ref" "$OUT"

# ===========================================================================
hdr "Land87-4. Open-PR cross-card head stays clear."
# Hermetic reset: earlier sections pushed cross-card and namespaced refs to the
# shared origin; delete them before the open-PR pin so the verdict below can
# only come from the stub PR, never a leaked remote ref.
(cd "$REMXC" && git push --quiet origin --delete tog-907-bump-pin-so-tog-900-reruns-remote-green >/dev/null 2>&1) || true
(cd "$REMNS" && git push --quiet origin --delete ops/tog-900-remote-widget >/dev/null 2>&1) || true
CLEAN="$TMP/clean"; mkclone "$CLEAN"
run_guard "$CLEAN" TOG-900 --repo=stub/crosscardpr
assert "$([[ "$RC" -eq 0 ]] && echo 0 || echo 1)" \
  "land87 open PR on cross-card branch stays clear" "rc=$RC out=$OUT"
assert "$(grep -q "VERDICT: clear" <<< "$OUT" && echo 0 || echo 1)" \
  "land87 open-PR cross-card verdict is clear" "$OUT"

# ===========================================================================
hdr "Land87-5. Prefix-owned and bare-key branches still refuse."
OWN="$TMP/own"; mkclone "$OWN"
(cd "$OWN" && git checkout --quiet -b tog-900-fix-widget-queue && echo own >> file.txt \
  && git -c user.name=suite -c user.email=suite@example.invalid commit --quiet -am "own work" && git checkout --quiet main)
run_guard "$OWN" TOG-900 --repo=stub/none
assert "$([[ "$RC" -eq 1 ]] && echo 0 || echo 1)" \
  "land87 prefix-owned local branch still refuses" "rc=$RC out=$OUT"

BARE="$TMP/bare"; mkclone "$BARE"
(cd "$BARE" && git checkout --quiet -b tog-900 && echo bare >> file.txt \
  && git -c user.name=suite -c user.email=suite@example.invalid commit --quiet -am "bare work" && git checkout --quiet main)
run_guard "$BARE" TOG-900 --repo=stub/none
assert "$([[ "$RC" -eq 1 ]] && echo 0 || echo 1)" \
  "land87 bare-key local branch still refuses" "rc=$RC out=$OUT"

# Hermetic cleanup of pushed refs.
(cd "$REMXC" && git push --quiet origin --delete tog-907-bump-pin-so-tog-900-reruns-remote-green >/dev/null 2>&1) || true
(cd "$REMNS" && git push --quiet origin --delete ops/tog-900-remote-widget >/dev/null 2>&1) || true

printf '\nland87 acceptance: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
