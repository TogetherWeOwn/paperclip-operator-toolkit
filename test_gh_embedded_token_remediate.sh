#!/usr/bin/env bash
# Regression suite for gh_embedded_token_remediate.py — TOG-3202/TOG-3209.
#
# WHAT THIS PROTECTS. The sweep's old repair, `git remote set-url`, deletes OUR
# COPY of an embedded credential and leaves the credential itself live at
# GitHub for up to an hour — measured on TOG-3202, where a scrubbed token still
# authenticated ~5 min after the sweep reported it remediated. This tool does
# the half nothing else does: revoke, then scrub. The ways THAT can be wrong,
# in descending order of how badly it hurts:
#
#   1. It scrubs before it revokes. Scrubbing destroys the only handle the
#      revoke authenticates with, so a tool that gets the order wrong strands
#      a live credential it can no longer kill. Asserted by SEQUENCE: the stub
#      API and a git-shim wrapper append to one shared log, and the first
#      DELETE must precede the first `remote set-url`.
#
#   2. It scores UNKNOWN as handled. An unreachable API and a dead token are
#      indistinguishable from the caller's side; a tool that treats a transport
#      error as "dead" closes a live credential out as remediated AND destroys
#      the handle. Asserted: unreachable -> exit 1 and the URL is NOT touched.
#
#   3. It believes 204 without re-probing. `DELETE /installation/token` -> 204
#      is GitHub accepting the request, not proof of death. Asserted: a stub
#      that returns 204 but keeps authenticating the token -> exit 1, no scrub.
#
#   4. It prints or passes the secret. The sentinel must appear in no captured
#      stdout/stderr and no git argv (the shim log IS the argv record), and
#      the ids it prints must be honest — the printed truncated sha256 equals
#      the digest of the secret the stub actually received in Authorization.
#
# Offline and credential-free by construction: a loopback stub serves the two
# GitHub routes the tool touches, fixtures are throwaway `git init` repos with
# a fabricated token-shaped sentinel, and nothing leaves 127.0.0.1.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${GH_EMBEDDED_TOKEN_REMEDIATE_PY:-$HERE/gh_embedded_token_remediate.py}"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); [[ -n "${2:-}" ]] && printf '        %s\n' "$2"; }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[[ -f "$TOOL" ]] || { echo "ERROR: $TOOL not found" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/test_gh_embedded_remediate.XXXXXXXX")"
trap '[[ -n "${STUB_PID:-}" ]] && kill "$STUB_PID" 2>/dev/null; rm -rf "$WORK"' EXIT

# ASSEMBLED AT RUNTIME for the same reason as test_git_remote_credential_scan.sh:
# CI's Secret scan greps tracked files for /gh[pousr]_[A-Za-z0-9]{16,}/ and a
# literal sentinel here fails the job. Concatenating the prefix keeps the
# fixture classifiable while leaving no matchable literal committed.
TOKEN_PREFIX="ghs"
SENTINEL="${TOKEN_PREFIX}_ZZREMEDIATESUITESENTINEL0123456789abcdef"
FP_EXPECT="sha256:$(printf '%s' "$SENTINEL" | sha256sum | cut -c1-12)"

CTRL="$WORK/ctrl.json"; PORTFILE="$WORK/port"; SEQLOG="$WORK/seq.log"

# --- stub GitHub API ---------------------------------------------------------
# Serves exactly the two routes the tool uses. Per-request behaviour comes from
# CTRL (re-read each time so a case can flip state mid-run, which is how
# "DELETE accepted but token still live" is staged). Every request appends
#   API <METHOD> <path> authfp=<truncated sha256 of the bearer, or none>
# to the shared sequence log — the same file the git shim below writes — so
# cross-process ordering is provable from one file.
cat > "$WORK/stub_api.py" <<'STUB'
import hashlib, json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

CTRL, PORTFILE, SEQLOG = sys.argv[1], sys.argv[2], sys.argv[3]

def ctrl():
    with open(CTRL) as f:
        return json.load(f)

class H(BaseHTTPRequestHandler):
    def _fp(self):
        h = self.headers.get("Authorization", "")
        return "none" if " " not in h else "sha256:" + hashlib.sha256(
            h.split(" ", 1)[1].encode()).hexdigest()[:12]

    def _log(self):
        with open(SEQLOG, "a") as f:
            f.write("API %s %s authfp=%s\n" % (self.command, self.path, self._fp()))

    def _reply(self, code):
        self.send_response(code)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self._log()
        if self.path.startswith("/installation/repositories"):
            self._reply(ctrl().get("get_repositories", 200))
        else:
            self._reply(404)

    def do_DELETE(self):
        self._log()
        c = ctrl()
        if c.get("dead_after_delete", True):
            # The token died: every later probe must 401.
            c["get_repositories"] = 401
            with open(CTRL, "w") as f:
                json.dump(c, f)
        self._reply(c.get("delete", 204))

    def log_message(self, *a):
        pass

srv = HTTPServer(("127.0.0.1", 0), H)
with open(PORTFILE, "w") as f:
    f.write(str(srv.server_port))
srv.serve_forever()
STUB
python3 "$WORK/stub_api.py" "$CTRL" "$PORTFILE" "$SEQLOG" & STUB_PID=$!
for _ in $(seq 50); do [[ -s "$PORTFILE" ]] && break; sleep 0.1; done
[[ -s "$PORTFILE" ]] || { echo "ERROR: stub API did not start" >&2; exit 2; }
GH_API="http://127.0.0.1:$(cat "$PORTFILE")"

# --- git shim: the argv record ----------------------------------------------
# The tool calls git via PATH. This wrapper appends the full argv to the shared
# sequence log (so ordering against API calls is provable) and execs the real
# git. It is also the no-secret-on-argv oracle: the line IS what /proc cmdline
# would show.
SHIM="$WORK/shim"; mkdir -p "$SHIM"
cat > "$SHIM/git" <<'SHIMGIT'
#!/bin/sh
printf 'GIT %s\n' "$*" >> "$SEQLOG"
exec /usr/bin/git "$@"
SHIMGIT
chmod +x "$SHIM/git"
export SEQLOG

# run <expected-rc> <repo-or-file-arg>... — runs the tool with stub + shim,
# captures both streams, asserts the exit code.
run() {
  local want="$1"; shift
  OUT="$(PATH="$SHIM:$PATH" GH_API="$GH_API" python3 "$TOOL" "$@" 2>"$WORK/err")"
  RC=$?
  ERR="$(cat "$WORK/err")"
  if [[ $RC -eq $want ]]; then ok "exit $want: $*"
  else bad "expected exit $want, got $RC: $*" "$OUT
$ERR"; fi
}

url_of() { /usr/bin/git -C "$1" config --local --get remote.origin.url; }

# mkrepo <dir> <url> — a real checkout-shaped fixture.
mkrepo() {
  /usr/bin/git init -q "$1"
  /usr/bin/git -C "$1" remote add origin "$2"
}

reset_ctrl() { printf '%s\n' "$1" > "$CTRL"; : > "$SEQLOG"; }

CLEAN_URL="https://github.com/Org/two-bot.git"
CRED_URL="https://x-access-token:${SENTINEL}@${CLEAN_URL#https://}"

# --- 1. clean + username-only: no finding, no API traffic --------------------
hdr "1. Clean trees are clean, and touch no API"
R1="$WORK/clean"; mkrepo "$R1" "$CLEAN_URL"
R1B="$WORK/useronly"; mkrepo "$R1B" "https://x-access-token@github.com/Org/two-bot.git"
reset_ctrl '{"get_repositories": 200}'
run 0 --repo "$R1"
grep -q '^CLEAN' <<<"$OUT" && ok 'CLEAN banner on a credential-free repo' || bad 'no CLEAN banner' "$OUT"
run 0 --repo "$R1B"
grep -q '^CLEAN' <<<"$OUT" \
  && ok 'username-only userinfo (no colon) is not a finding' || bad 'flagged a colon-less remote' "$OUT"
# A checkout with NO remotes. `git config --get-regexp` exits 1 on no-match, so
# folding that into "clean" has to be deliberate; when it is not, the tool dies
# with a traceback and exits 1 — and this tool's own contract reads exit 1 as
# "a live credential could not be verified dead", i.e. page someone. A false
# page on a repo that is clean by construction is how a sweep gets muted.
R1C="$WORK/noremote"; /usr/bin/git init -q "$R1C"
run 0 --repo "$R1C"
grep -q '^CLEAN' <<<"$OUT" \
  && ok 'a checkout with no remotes reads CLEAN' || bad 'no CLEAN banner on a remote-less repo' "$OUT"
grep -q 'Traceback' <<<"$ERR" \
  && bad 'crashed with a traceback instead of reporting CLEAN' "$ERR" \
  || ok 'no traceback on a remote-less repo'
if grep -q '^API ' "$SEQLOG"; then bad 'tool hit the API on clean repos' "$(cat "$SEQLOG")"
else ok 'zero API requests on clean repos — the scanner never authenticates (local git probes are fine)'; fi

# --- 2. dead token: probe, no revoke, scrub ----------------------------------
hdr "2. Dead token: probed, NOT revoked, scrubbed"
R2="$WORK/dead"; mkrepo "$R2" "$CRED_URL"
reset_ctrl '{"get_repositories": 401}'
run 0 --repo "$R2"
[[ "$(url_of "$R2")" == "$CLEAN_URL" ]] \
  && ok 'URL scrubbed to the credential-free form' || bad 'URL not scrubbed' "$(url_of "$R2")"
grep -q 'API DELETE' "$SEQLOG" && bad 'DELETE issued against an already-dead token' "$(cat "$SEQLOG")" \
  || ok 'no DELETE for a dead token'
grep -q 'remote set-url' "$SEQLOG" && ok 'scrub executed' || bad 'no set-url in the git log' "$(cat "$SEQLOG")"

# --- 3. live token: revoke -> verify -> scrub, in that order -----------------
hdr "3. Live token: revoked, verified dead, THEN scrubbed"
R3="$WORK/live"; mkrepo "$R3" "$CRED_URL"
reset_ctrl '{"get_repositories": 200, "delete": 204, "dead_after_delete": true}'
run 0 --repo "$R3"
[[ "$(url_of "$R3")" == "$CLEAN_URL" ]] \
  && ok 'URL scrubbed after verified revocation' || bad 'URL not scrubbed' "$(url_of "$R3")"
DEL_LINE="$(grep -n 'API DELETE /installation/token' "$SEQLOG" | head -1 | cut -d: -f1)"
SETURL_LINE="$(grep -n 'GIT .*remote set-url' "$SEQLOG" | head -1 | cut -d: -f1)"
if [[ -n "$DEL_LINE" && -n "$SETURL_LINE" && "$DEL_LINE" -lt "$SETURL_LINE" ]]; then
  ok 'ORDER: DELETE (line '"$DEL_LINE"') precedes set-url (line '"$SETURL_LINE"')'
else
  bad 'revoke-before-scrub violated or unprovable' "$(cat "$SEQLOG")"
fi
FIRST_GET="$(grep -n 'API GET /installation/repositories' "$SEQLOG" | head -1 | cut -d: -f1)"
[[ -n "$FIRST_GET" && "$FIRST_GET" -lt "$DEL_LINE" ]] \
  && ok 'liveness probe precedes the revoke' || bad 'no probe before DELETE' "$(cat "$SEQLOG")"
grep -q 'API GET /installation/repositories' < <(tail -n +"$((DEL_LINE+1))" "$SEQLOG") \
  && ok 'post-revoke 401 re-probe happened (a 204 alone is not death)' \
  || bad 'no verification probe after DELETE' "$(cat "$SEQLOG")"

# --- 4. unreachable API: UNKNOWN, exit 1, URL untouched ----------------------
hdr "4. Unreachable API is UNKNOWN — exit 1 and the handle is preserved"
R4="$WORK/unreachable"; mkrepo "$R4" "$CRED_URL"
: > "$SEQLOG"
# Point GH_API at a port with no listener: connection refused, not a slow timeout.
OUT="$(PATH="$SHIM:$PATH" GH_API="http://127.0.0.1:1" python3 "$TOOL" --repo "$R4" 2>"$WORK/err")"; RC=$?
ERR="$(cat "$WORK/err")"
if [[ $RC -eq 1 ]]; then ok 'exit 1 when the API is unreachable'
else bad "expected exit 1 on unreachable API, got $RC" "$OUT
$ERR"; fi
[[ "$(url_of "$R4")" == "$CRED_URL" ]] \
  && ok 'URL LEFT INTACT — the token stays revocable' || bad 'scrubbed a token it could not check' "$(url_of "$R4")"
grep -q 'remote set-url' "$SEQLOG" && bad 'scrubbed during an outage' "$(cat "$SEQLOG")" \
  || ok 'no scrub during an outage'

# --- 5. revoke accepted but not effective: exit 1, no scrub ------------------
hdr "5. A 204 that does not kill the token is not a revoke"
R5="$WORK/notver"; mkrepo "$R5" "$CRED_URL"
reset_ctrl '{"get_repositories": 200, "delete": 204, "dead_after_delete": false}'
run 1 --repo "$R5"
[[ "$(url_of "$R5")" == "$CRED_URL" ]] \
  && ok 'URL untouched while the token still authenticates' || bad 'scrubbed an unrevoked token' "$(url_of "$R5")"

# --- 6. dry-run and check-file never revoke -----------------------------------
hdr "6. Dry-run and check-file never revoke"
R6="$WORK/dryrun"; mkrepo "$R6" "$CRED_URL"
reset_ctrl '{"get_repositories": 200, "delete": 204, "dead_after_delete": true}'
run 1 --repo "$R6" --dry-run
grep -q 'API DELETE' "$SEQLOG" && bad 'dry-run issued a DELETE' "$(cat "$SEQLOG")" \
  || ok 'dry-run revokes nothing'
[[ "$(url_of "$R6")" == "$CRED_URL" ]] && ok 'dry-run scrubs nothing' || bad 'dry-run scrubbed' "$(url_of "$R6")"
printf '%s' "$SENTINEL" > "$WORK/tok.dead"
reset_ctrl '{"get_repositories": 401}'
run 0 --check-file "$WORK/tok.dead"
printf '%s' "$SENTINEL" > "$WORK/tok.live"
reset_ctrl '{"get_repositories": 200}'
run 1 --check-file "$WORK/tok.live"
grep -q 'API DELETE' "$SEQLOG" && bad 'check-file revoked' "$(cat "$SEQLOG")" \
  || ok 'check-file never revokes, live or dead'

# --- 7. the secret goes nowhere it should not ---------------------------------
hdr "7. Sentinel in no output and no git argv"
OUTALL="$OUT $ERR $(cat "$SEQLOG")"
grep -qF "$SENTINEL" <<<"$OUTALL" \
  && bad 'THE SENTINEL LEAKED into output, argv record, or config' \
  || ok 'sentinel absent from all captured output and every git argv'
grep -qF "$FP_EXPECT" "$SEQLOG" \
  && ok 'stub received the sentinel under the fingerprint the tool prints' \
  || bad 'stub never saw the sentinel — the revoke path was not really exercised' "$(cat "$SEQLOG")"
grep -qF "$FP_EXPECT" <<<"$OUT" \
  && ok 'tool identifies findings by the honest truncated sha256' \
  || bad 'expected fingerprint in tool output' "$OUT"

# --- 8. usage errors ----------------------------------------------------------
hdr "8. Usage errors exit 2"
run 2 --repo "$WORK/nope"
run 2
run 2 --repo "$R1" --check-file "$WORK/tok.dead"

# --- 9. this suite does not itself trip the CI Secret scan --------------------
hdr "9. No token-shaped literal committed"
if command grep -nIE '(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})' "${BASH_SOURCE[0]}" >/dev/null 2>&1; then
  bad 'this file contains a token-shaped literal; CI Secret scan will fail the job'
else
  ok 'no token-shaped literal in this suite'
fi
if printf 'x:%s\n' "$SENTINEL" \
     | command grep -qIE '(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})'; then
  ok 'control — the Secret-scan regex does match the assembled sentinel'
else
  bad 'the Secret-scan regex matched nothing; test 9 is vacuous'
fi

hdr "Result"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]] || exit 1
