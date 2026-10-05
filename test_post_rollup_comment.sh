#!/usr/bin/env bash
# ===========================================================================
# test_post_rollup_comment.sh — offline regression suite for the comment-only
# rollup writer (post_rollup_comment.sh).
#
# The writer is the half of the bridge contract the poller cannot prove: it
# must post proposals with ZERO company-wide calls (every one of those is a
# 403 for a parent-bound bridge key), never claim a delivery the API refused,
# and never touch argv with the key or the body. A stub API on 127.0.0.1
# plays the deployed semantics; a curl shim records argv.
#
# WHAT THIS SUITE IS BUILT TO CATCH:
#
#  * A COMPANY-WIDE CALL. Every scenario asserts the stub log holds no
#    company-issues call: the writer must be postable with a key that is
#    refused all of those.
#  * A SILENT 403/500. `curl -sS` exits 0 on those, so without an explicit
#    status check the helper would announce a posted comment the API never
#    recorded. Refused writes must exit non-zero with no success line.
#  * A BLIND POST. A missing, denied, misshapen or closed parent must stop
#    the write with zero comment POSTs -- an unreadable thread is not an
#    empty one.
#  * AN EMPTY PROPOSAL. Posting an empty body records nothing readable and
#    still consumes the caller's cadence state; it is refused up front.
#  * A QUIET DEDUPE. The helper is at-least-once by contract (callers dedupe
#    by digest): two identical calls must post two comments, proving no
#    hidden skipping that could swallow a changed finding.
#  * A SOURCE-ORDER FAILURE. The installed env carries only
#    RED_MAIN_ROLLUP_PARENT_ID and the wrapper sources the helper before
#    exporting the PAPERCLIP_ alias: sourcing must succeed and the post
#    must target the RED_MAIN_ id (live 2026-10-05 retest, exit 1 before
#    any transport). Neither name set is usage exit 2.
#  * A DISCARDED REFUSAL REASON. The retest's helper threw away the POST
#    body's error/code, leaving the 403 unexplained. Refusals now log the
#    HTTP status plus the server's sanitized error/code, and a run-gate
#    403 names the heartbeat-run fix explicitly.
#  * A RUNLESS POST AS "DELIVERED". Deployed comment routes need a
#    heartbeat run the systemd timer does not have: GETs answer 200 while
#    the POST answers 403 cross_issue_influence_run_context_required. That
#    split must fail closed with no success line, never a phantom delivery.
#
# Hermetic: no network beyond 127.0.0.1, no credentials, no board writes.
# ===========================================================================
set -Eeuo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
HELPER="$REPO_ROOT/post_rollup_comment.sh"
PORT="${ROLLUP_TEST_PORT:-8793}"
SENTINEL_KEY="SENTINELKEY-must-never-reach-argv"

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n' "$1"; fail=$((fail+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

command -v curl >/dev/null 2>&1 || { echo "test_post_rollup_comment: curl is required" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "test_post_rollup_comment: jq is required" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "test_post_rollup_comment: python3 is required" >&2; exit 2; }
[[ -f "$HELPER" ]] || { echo "test_post_rollup_comment: helper missing at $HELPER" >&2; exit 2; }
bash -n "$HELPER" || { echo "test_post_rollup_comment: helper does not parse" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; [[ -n "${SRV_PID:-}" ]] && kill "$SRV_PID" 2>/dev/null' EXIT

# --- stub API ------------------------------------------------------------
# Parent scenario is the issue id in the path. Every request is logged to
# $WORK/calls.jsonl for the zero-company-calls assertions.
cat > "$WORK/api.py" <<'PY'
import http.server, json, os, sys
CALLS = os.environ["CALLS_FILE"]
class H(http.server.BaseHTTPRequestHandler):
    def _api(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode() if n else ""
        with open(CALLS, "a") as f:
            f.write(json.dumps({"m": self.command, "p": self.path.split("?")[0],
                                "auth": self.headers.get("Authorization"),
                                "body": body}) + "\n")
        status, payload = 404, {}
        if self.path.startswith("/api/companies/"):
            status, payload = 403, {
                "error": "Task bridge keys cannot use company-wide issue list APIs"}
        else:
            parts = self.path.split("?")[0].strip("/").split("/")
            # /api/issues/<id> and /api/issues/<id>/comments only.
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "issues":
                iid = parts[2]
                if self.command != "GET":
                    status, payload = 405, {}
                elif iid == "parent-denied":
                    status, payload = 403, {"error": "Forbidden"}
                elif iid == "parent-outside-boundary":
                    # Live 2026-10-05: bound-but-unassigned rollup root.
                    status, payload = 403, {"error": "Issue is outside this actor's authorization boundary"}
                elif iid == "parent-missing":
                    status, payload = 404, {"error": "Not found"}
                elif iid == "parent-badshape":
                    status, payload = 200, {"error": "not an issue"}
                else:
                    st = "done" if iid == "parent-closed" else "in_progress"
                    status, payload = 200, {
                        "id": iid, "title": "Rollup parent", "status": st}
            elif (len(parts) == 4 and parts[0] == "api" and parts[1] == "issues"
                    and parts[3] == "comments"):
                iid = parts[2]
                if self.command == "GET":
                    status, payload = 200, []
                elif iid == "comments-down":
                    status, payload = 500, {"error": "boom"}
                elif iid == "comments-forbidden":
                    status, payload = 403, {"error": "Forbidden"}
                elif iid == "parent-runless":
                    # Live 2026-10-05 22:28Z: GETs on the bound thread answer
                    # 200 runless, but the comment POST needs a heartbeat run
                    # the systemd timer does not have.
                    status, payload = 403, {"error": "Agent issue comments and updates require a valid heartbeat run so cross-issue influence can be contained",
                                            "details": {"code": "cross_issue_influence_run_context_required"}}
                else:
                    try:
                        seq = sum(1 for _ in open(CALLS)) + 1
                    except Exception:
                        seq = 1
                    status, payload = 201, {"id": "comment-%d" % seq}
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())
    do_GET = _api
    do_POST = _api
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY

# --- curl shim -----------------------------------------------------------
REAL_CURL="$(command -v curl)"
mkdir -p "$WORK/bin"
cat > "$WORK/bin/curl" <<SHIM
#!/usr/bin/env bash
printf '%s\0' "\$@" >> "${WORK}/argv.bin"
exec "${REAL_CURL}" "\$@"
SHIM
chmod +x "$WORK/bin/curl"

start_api() {
  : > "$WORK/calls.jsonl"; : > "$WORK/argv.bin"
  CALLS_FILE="$WORK/calls.jsonl" python3 "$WORK/api.py" "$PORT" & SRV_PID=$!
  for _ in $(seq 1 50); do
    (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null && break
    sleep 0.1
  done
}

# run_post <parent-id> <tag> <title> <body-text> -> prints exit code.
# stdout/stderr of the helper land in $WORK/out.txt / $WORK/err.txt.
run_post() {
  local parent="$1" tag="$2" title="$3" text="$4" rc=0
  printf '%s' "$text" > "$WORK/body.txt"
  : > "$WORK/calls.jsonl"; : > "$WORK/argv.bin"
  env -u BASH_ENV \
    PATH="$WORK/bin:$PATH" \
    PAPERCLIP_API_URL="http://127.0.0.1:$PORT" \
    PAPERCLIP_AGENT_API_KEY="$SENTINEL_KEY" \
    PAPERCLIP_ROLLUP_PARENT_ID="$parent" \
    bash -c 'source "$0"; post_rollup_comment "$1" "$2" "$3"' \
    "$HELPER" "$tag" "$title" "$WORK/body.txt" \
    >"$WORK/out.txt" 2>"$WORK/err.txt" || rc=$?
  echo "$rc"
}

# run_post_red_alias <parent-id> <tag> <title> <body-text>
# Same as run_post but with the DOCUMENTED clean host env: only
# RED_MAIN_ROLLUP_PARENT_ID is set (the private wrapper sources the helper
# before exporting the PAPERCLIP_ alias, and the installed env file carries
# only the RED_MAIN_ name). Sourcing must succeed and the post must target
# the RED_MAIN_ id. Live 2026-10-05: the source-time requirement turned this
# order into exit 1 before any transport.
run_post_red_alias() {
  local parent="$1" tag="$2" title="$3" text="$4" rc=0
  printf '%s' "$text" > "$WORK/body.txt"
  : > "$WORK/calls.jsonl"; : > "$WORK/argv.bin"
  env -u BASH_ENV -u PAPERCLIP_ROLLUP_PARENT_ID \
    PATH="$WORK/bin:$PATH" \
    PAPERCLIP_API_URL="http://127.0.0.1:$PORT" \
    PAPERCLIP_AGENT_API_KEY="$SENTINEL_KEY" \
    RED_MAIN_ROLLUP_PARENT_ID="$parent" \
    bash -c 'source "$0"; post_rollup_comment "$1" "$2" "$3"' \
    "$HELPER" "$tag" "$title" "$WORK/body.txt" \
    >"$WORK/out.txt" 2>"$WORK/err.txt" || rc=$?
  echo "$rc"
}

calls() { wc -l < "$WORK/calls.jsonl" | tr -d ' '; }
company_calls() {
  python3 -c '
import json,sys
n = 0
for l in open(sys.argv[1]):
    d = json.loads(l)
    if d["m"] == "GET" and d["p"].startswith("/api/companies/"):
        n += 1
print(n)' "$WORK/calls.jsonl"
}
comment_posts() {
  python3 -c '
import json,sys
n = 0
for l in open(sys.argv[1]):
    d = json.loads(l)
    if d["m"] == "POST" and d["p"].endswith("/comments"):
        n += 1
print(n)' "$WORK/calls.jsonl"
}
posted_bodies() {
  python3 -c '
import json,sys
for l in open(sys.argv[1]):
    d = json.loads(l)
    if d["m"] == "POST" and d["p"].endswith("/comments"):
        print(json.loads(d["body"])["body"])' "$WORK/calls.jsonl"
}

echo "post_rollup_comment contracts"
start_api

hdr "Happy path posts exactly one comment, nothing company-wide"
rc="$(run_post parent-open "[red-main-poll]" "red-main drafts" "draft body line 1")"
[[ "$rc" == "0" ]] && ok "exit 0 on an open parent" || bad "exit 0 on an open parent" "exit=$rc err=$(cat "$WORK/err.txt")"
[[ "$(calls)" == "2" ]] && ok "exactly 2 API calls (GET parent, POST comment)" || bad "exactly 2 API calls (GET parent, POST comment)" "calls=$(calls)"
[[ "$(company_calls)" == "0" ]] && ok "zero company-wide calls" || bad "zero company-wide calls"
grep -q "posted comment comment-" "$WORK/err.txt" \
  && ok "success names the posted comment id" \
  || bad "success names the posted comment id" "$(cat "$WORK/err.txt")"
posted="$(posted_bodies)"
[[ "$(head -n 1 <<<"$posted")" == "[red-main-poll] red-main drafts" ]] \
  && ok "comment first line carries [TAG] TITLE" \
  || bad "comment first line carries [TAG] TITLE" "$posted"
grep -q "draft body line 1" <<<"$posted" \
  && ok "comment carries the full proposal body" \
  || bad "comment carries the full proposal body" "$posted"

hdr "A closed, missing, denied or misshapen parent stops the write"
for parent in parent-closed parent-missing parent-denied parent-badshape; do
  rc="$(run_post "$parent" "[red-main-poll]" "t" "some finding")"
  [[ "$rc" != "0" && "$(comment_posts)" == "0" ]] \
    && ok "$parent: non-zero with zero comment POSTs" \
    || bad "$parent: non-zero with zero comment POSTs" "exit=$rc posts=$(comment_posts) err=$(cat "$WORK/err.txt")"
  ! grep -q "posted comment" "$WORK/err.txt" \
    && ok "$parent: no success line" \
    || bad "$parent: no success line" "$(cat "$WORK/err.txt")"
done

hdr "Live 2026-10-05: bound-but-unassigned root is a boundary refusal"
# The deployed API answered 403 "outside this actor's authorization boundary"
# on the rollup-root read while the bound rollup was unassigned. The writer
# must post nothing, claim nothing, and name the assignment/descendant fix.
rc="$(run_post parent-outside-boundary "[red-main-poll]" "t" "some finding")"
[[ "$rc" != "0" && "$(comment_posts)" == "0" ]] \
  && ok "boundary-refused root: non-zero with zero comment POSTs" \
  || bad "boundary-refused root: non-zero with zero comment POSTs" "exit=$rc posts=$(comment_posts) err=$(cat "$WORK/err.txt")"
! grep -q "posted comment" "$WORK/err.txt" \
  && ok "boundary-refused root: no success line" \
  || bad "boundary-refused root: no success line" "$(cat "$WORK/err.txt")"
grep -q "triage owner" "$WORK/err.txt" \
  && ok "boundary-refused root: names the assignment fix" \
  || bad "boundary-refused root: names the assignment fix" "$(cat "$WORK/err.txt")"
[[ "$(company_calls)" == "0" ]] \
  && ok "boundary-refused root: zero company-wide calls" \
  || bad "boundary-refused root: zero company-wide calls"

hdr "Live 2026-10-05 retest: RED_MAIN-only env sources and posts (source-order fix)"
# The installed env carries only RED_MAIN_ROLLUP_PARENT_ID and the wrapper
# sources the helper before exporting the PAPERCLIP_ alias. Sourcing must
# not fail and the post must target the RED_MAIN_ id.
rc="$(run_post_red_alias parent-open "[red-main-poll]" "red-main drafts" "draft body line 1")"
[[ "$rc" == "0" ]] && ok "RED_MAIN-only env: exit 0" || bad "RED_MAIN-only env: exit 0" "exit=$rc err=$(cat "$WORK/err.txt")"
[[ "$(comment_posts)" == "1" ]] && ok "RED_MAIN-only env: exactly one comment POST" || bad "RED_MAIN-only env: exactly one comment POST" "posts=$(comment_posts)"
python3 -c '
import json,sys
ok = any(json.loads(l)["p"] == "/api/issues/parent-open/comments" for l in open(sys.argv[1]))
sys.exit(0 if ok else 1)' "$WORK/calls.jsonl" \
  && ok "RED_MAIN-only env: POST targets the RED_MAIN_ id" \
  || bad "RED_MAIN-only env: POST targets the RED_MAIN_ id" "$(cat "$WORK/calls.jsonl")"
[[ "$(company_calls)" == "0" ]] \
  && ok "RED_MAIN-only env: zero company-wide calls" \
  || bad "RED_MAIN-only env: zero company-wide calls"
rc=0
env -u BASH_ENV -u PAPERCLIP_ROLLUP_PARENT_ID -u RED_MAIN_ROLLUP_PARENT_ID \
  PATH="$WORK/bin:$PATH" \
  PAPERCLIP_API_URL="http://127.0.0.1:$PORT" \
  PAPERCLIP_AGENT_API_KEY="$SENTINEL_KEY" \
  bash -c 'source "$0"; post_rollup_comment "[t]" "t" "$1"' \
  "$HELPER" "$WORK/body.txt" >/dev/null 2>&1 || rc=$?
[[ "$rc" == "2" ]] && ok "neither parent name set: usage exit 2" || bad "neither parent name set: usage exit 2" "exit=$rc"

hdr "Live 2026-10-05 retest: runless POST is a named run-gate refusal"
# Deployed semantics: GETs on the assigned bound thread answer 200 runless,
# but the comment POST requires a heartbeat run the systemd timer does not
# have. The writer must fail closed, claim nothing, name the run-context
# fix, and surface the server code -- never discard the reason.
rc="$(run_post parent-runless "[red-main-poll]" "t" "some finding")"
# The refused attempt is logged by the stub (one POST tried) but the server
# recorded nothing: exit is non-zero and no success is claimed. comments-down
# and comments-forbidden above assert the same shape for the same reason.
[[ "$rc" != "0" ]] \
  && ok "run-gated post: non-zero exit (nothing recorded)" \
  || bad "run-gated post: non-zero exit (nothing recorded)" "exit=$rc err=$(cat "$WORK/err.txt")"
! grep -q "posted comment" "$WORK/err.txt" \
  && ok "run-gated post: no success line" \
  || bad "run-gated post: no success line" "$(cat "$WORK/err.txt")"
grep -q "heartbeat run context" "$WORK/err.txt" \
  && ok "run-gated post: names the run-context fix" \
  || bad "run-gated post: names the run-context fix" "$(cat "$WORK/err.txt")"
grep -q "cross_issue_influence_run_context_required" "$WORK/err.txt" \
  && ok "run-gated post: surfaces the server code" \
  || bad "run-gated post: surfaces the server code" "$(cat "$WORK/err.txt")"
[[ "$(company_calls)" == "0" ]] \
  && ok "run-gated post: zero company-wide calls" \
  || bad "run-gated post: zero company-wide calls"

hdr "A refused comment write is a failed tick, never a posted finding"
for parent in comments-down comments-forbidden; do
  rc="$(run_post "$parent" "[red-main-poll]" "t" "some finding")"
  [[ "$rc" != "0" ]] \
    && ok "$parent: non-zero exit" \
    || bad "$parent: non-zero exit" "exit=$rc"
  ! grep -q "posted comment" "$WORK/err.txt" \
    && ok "$parent: no success claimed" \
    || bad "$parent: no success claimed" "$(cat "$WORK/err.txt")"
done

hdr "Usage failures post nothing"
rc=0
env -u BASH_ENV PATH="$WORK/bin:$PATH" \
  PAPERCLIP_API_URL="http://127.0.0.1:$PORT" \
  PAPERCLIP_AGENT_API_KEY="$SENTINEL_KEY" \
  PAPERCLIP_ROLLUP_PARENT_ID="parent-open" \
  bash -c 'source "$0"; post_rollup_comment "" "" ""' "$HELPER" >/dev/null 2>&1 || rc=$?
[[ "$rc" == "2" ]] && ok "empty TAG/TITLE/BODY is usage exit 2" || bad "empty TAG/TITLE/BODY is usage exit 2" "exit=$rc"
: > "$WORK/body.txt"
rc="$(run_post parent-open "[red-main-poll]" "t" "")"
[[ "$rc" == "2" && "$(calls)" == "0" ]] \
  && ok "empty body file is refused with zero API calls" \
  || bad "empty body file is refused with zero API calls" "exit=$rc calls=$(calls)"
rc=0
env -u BASH_ENV PATH="$WORK/bin:$PATH" \
  PAPERCLIP_API_URL="http://127.0.0.1:$PORT" \
  PAPERCLIP_AGENT_API_KEY= PAPERCLIP_API_KEY= \
  PAPERCLIP_ROLLUP_PARENT_ID="parent-open" \
  bash -c 'source "$0"' "$HELPER" >/dev/null 2>&1 || rc=$?
[[ "$rc" != "0" ]] && ok "missing credential fails at source time" || bad "missing credential fails at source time"

hdr "At-least-once: identical calls post twice (callers dedupe by digest)"
printf 'same finding' > "$WORK/body.txt"
: > "$WORK/calls.jsonl"
for _ in 1 2; do
  env -u BASH_ENV PATH="$WORK/bin:$PATH" \
    PAPERCLIP_API_URL="http://127.0.0.1:$PORT" \
    PAPERCLIP_AGENT_API_KEY="$SENTINEL_KEY" \
    PAPERCLIP_ROLLUP_PARENT_ID="parent-open" \
    bash -c 'source "$0"; post_rollup_comment "[red-main-poll]" "t" "$1"' \
    "$HELPER" "$WORK/body.txt" >/dev/null 2>"$WORK/err.txt" || \
    { bad "at-least-once: repeat call failed" "$(cat "$WORK/err.txt")"; break; }
done
[[ "$(comment_posts)" == "2" ]] \
  && ok "two identical calls post two comments (no hidden skipping)" \
  || bad "two identical calls post two comments (no hidden skipping)" "posts=$(comment_posts)"

hdr "No credential on argv"
: > "$WORK/argv.bin"
run_post parent-open "[red-main-poll]" "t" "finding with body-text-token" >/dev/null
argv_txt="$(tr '\0' '\n' < "$WORK/argv.bin")"
[[ -s "$WORK/argv.bin" ]] || bad "REFUSE: curl shim recorded nothing"
if [[ -s "$WORK/argv.bin" ]]; then
  grep -qF "$SENTINEL_KEY" <<<"$argv_txt" \
    && bad "the API key reached curl argv" \
    || ok "the API key never reaches curl argv"
  grep -qF "finding with body-text-token" <<<"$argv_txt" \
    && bad "the proposal body reached curl argv" \
    || ok "the proposal body never reaches curl argv"
fi

kill "$SRV_PID" 2>/dev/null; SRV_PID=""; wait 2>/dev/null || true
hdr "Transport failure is a failed tick"
rc="$(run_post parent-open "[red-main-poll]" "t" "some finding")"
[[ "$rc" != "0" ]] && ok "dead server: non-zero exit" || bad "dead server: non-zero exit" "exit=$rc"
! grep -q "posted comment" "$WORK/err.txt" \
  && ok "dead server: no success claimed" \
  || bad "dead server: no success claimed" "$(cat "$WORK/err.txt")"

echo
echo "post_rollup_comment: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
