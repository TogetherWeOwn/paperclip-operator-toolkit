#!/usr/bin/env bash
# Regression suite for agent_endpoint_preflight.sh — the model-endpoint cutover gate.
#
# THE BUG THIS EXISTS FOR (TOG-358). The natural way to check "can we point the
# agents at the new model endpoint" is to curl it and look for a 2xx. Every one
# of the following returns a 2xx, or looks like success to a naive check, and
# every one of them breaks the fleet or the books if it ships:
#
#   an OpenAI-shaped body on /v1/messages   claude_local cannot parse it
#   a 200 carrying an error object          "succeeded" with no completion
#   usage{} without the cache fields        TOG-164's switch-cost rule reads a
#                                           missing key as zero, forever
#   an OpenRouter PAYG completion           works perfectly, bills per token,
#                                           leaves the Max subscriptions idle
#
# and two more that a 2xx check never even reaches:
#
#   connection refused                      the measured state of :20129 and
#                                           :8317 from inside a container
#   connected, then no response             observed on teamclaude while the
#                                           tool was being written
#
# The tool must give each of those its own exit code, and most of the
# assertions below exist to prove that none of them can come out as 0.
#
# WHY A STUB AND NOT THE REAL FRONTS. The interesting cases are a hang, a ban
# risk, a wrong dialect and a PAYG lane. Reproducing them live would need
# teamclaude, CLIProxy and OmniRoute all running, several live subscription
# credentials, and — for the 401 case — deliberately tripping the IP ban this
# tool exists to avoid. The stub serves each case off a distinct path prefix
# instead, so every branch is reachable, nothing leaves 127.0.0.1, and no
# quota is spent.
#
# Offline by construction, like test_gh_ci_status.sh. Requires node, curl, jq.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/agent_endpoint_preflight.sh"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

for c in node curl jq; do
  command -v "$c" >/dev/null 2>&1 || { echo "test_agent_endpoint_preflight: $c is required" >&2; exit 2; }
done
[[ -x "$TOOL" ]] || { echo "test_agent_endpoint_preflight: $TOOL is not executable" >&2; exit 2; }

TMP="$(mktemp -d)"
STUB_PID=""
cleanup() { [[ -n "$STUB_PID" ]] && kill "$STUB_PID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

COUNTS="$TMP/counts"
: > "$COUNTS"

# --- stub model front ---------------------------------------------------------
# One server, many personalities, selected by the path prefix the tool is
# pointed at. It appends every request path to $COUNTS so the suite can assert
# how many times the tool called it — the single-attempt property is the one
# thing here that cannot be checked from an exit code.
cat > "$TMP/stub.js" <<'STUB'
const http = require('http')
const fs = require('fs')

const COUNTS = process.env.COUNTS

// A well-formed Anthropic envelope. Cases below clone and corrupt it.
const envelope = (over = {}) => ({
  id: 'msg_01ABCDEFGHIJKLMNOP',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5',
  content: [{ type: 'text', text: 'h' }],
  stop_reason: 'max_tokens',
  usage: {
    input_tokens: 9,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  ...over,
})

// A cold request legitimately reports zero for both cache counters. That must
// still pass: the check is presence of the keys, not a non-zero value.
const CASES = {
  'case-green':   { code: 200, body: envelope() },

  // Both PAYG tells together, then each one alone — either can be absent
  // depending on which router is in front, and either alone must be enough.
  'case-payg':    { code: 200, body: envelope({ id: 'gen-1a2b3c4d', model: 'anthropic/claude-sonnet-5' }) },
  'case-payg-id': { code: 200, body: envelope({ id: 'gen-1a2b3c4d' }) },
  'case-payg-mdl':{ code: 200, body: envelope({ model: 'anthropic/claude-sonnet-5' }) },

  // Succeeds, and silently destroys cost accounting.
  'case-nocache': { code: 200, body: envelope({ usage: { input_tokens: 9, output_tokens: 1 } }) },
  // Only one of the two present is still not enough.
  'case-halfcache': { code: 200, body: envelope({ usage: { input_tokens: 9, output_tokens: 1, cache_read_input_tokens: 0 } }) },

  // Wrong dialect: a front translating /v1/messages to OpenAI's shape.
  'case-openai':  { code: 200, body: { id: 'chatcmpl-x', object: 'chat.completion',
                                       choices: [{ message: { role: 'assistant', content: 'h' } }] } },
  // A 200 that carries an error. "The request succeeded" is true and useless.
  'case-err200':  { code: 200, body: { error: { type: 'upstream_error', message: 'no healthy upstream' } } },
  // A proxy error page rendered as 200 with an HTML body.
  'case-html':    { code: 200, raw: '<html><body>502 Bad Gateway</body></html>', type: 'text/html' },

  'case-401':     { code: 401, body: { error: { type: 'authentication_error', message: 'invalid x-api-key' } } },
  'case-403':     { code: 403, body: { error: { type: 'permission_error', message: 'forbidden' } } },
  // The likeliest wrong base URL: right host, no Anthropic surface at that path.
  'case-404':     { code: 404, body: { error: { type: 'not_found_error', message: 'no route' } } },
  'case-500':     { code: 500, body: { error: { type: 'api_error', message: 'boom' } } },

  // Accepts the connection and never answers. Neither up nor down.
  'case-hang':    { hang: true },
}

const server = http.createServer((req, res) => {
  const key = (req.url.split('/')[1] || '')
  fs.appendFileSync(COUNTS, key + '\n')
  const c = CASES[key]
  // Drain the request body; curl waits for us to read it.
  req.on('data', () => {})
  req.on('end', () => {
    if (!c) { res.writeHead(418); res.end('no such case'); return }
    if (c.hang) return                                   // deliberately no response
    if (c.raw !== undefined) {
      res.writeHead(c.code, { 'content-type': c.type })
      res.end(c.raw)
      return
    }
    res.writeHead(c.code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(c.body))
  })
})

server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.env.PORTFILE, String(server.address().port))
})
STUB

PORTFILE="$TMP/port"
COUNTS="$COUNTS" PORTFILE="$PORTFILE" node "$TMP/stub.js" & STUB_PID=$!
for _ in $(seq 1 50); do [[ -s "$PORTFILE" ]] && break; sleep 0.1; done
PORT="$(cat "$PORTFILE" 2>/dev/null)"
[[ -n "$PORT" ]] || { echo "stub did not start" >&2; exit 2; }

# A port nothing listens on, for the refused-connection case. Bound and closed
# by node so it is known-free rather than guessed.
CLOSED_PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})')"

# run <case-path> [extra tool args...] -> sets RC, OUT
run() {
  local case_path="$1"; shift
  OUT="$(PREFLIGHT_API_KEY=test-key-not-real "$TOOL" "$@" "http://127.0.0.1:$PORT/$case_path" 2>&1)"
  RC=$?
}

# expect <exit> <label> <case-path> [extra args...]
expect() {
  local want="$1" label="$2"; shift 2
  run "$@"
  if [[ "$RC" -eq "$want" ]]; then ok "$label (exit $RC)"
  else bad "$label — wanted exit $want, got $RC"; printf '        %s\n' "$OUT" | head -4; fi
}

# =============================================================================
hdr "1. The only green — a real Anthropic front on a subscription lane"
# =============================================================================
expect 0 "well-formed envelope with cache accounting passes" case-green
run case-green
grep -q 'verdict  : ok' <<<"$OUT" && ok "reports verdict ok" || bad "did not report verdict ok"
grep -q 'claude-sonnet-5' <<<"$OUT" && ok "names the served model" || bad "did not name the served model"

# Cold caches report zero, not absence. If this ever fails, someone has
# changed a presence check into a truthiness check.
expect 0 "zero-valued cache counters are presence, not absence" case-green

# =============================================================================
hdr "2. Succeeds and bills per token — the money case (TOG-358)"
# =============================================================================
expect 1 "PAYG lane (both tells) does not pass" case-payg
expect 1 "OpenRouter-shaped id alone is enough to flag" case-payg-id
expect 1 "namespaced model alone is enough to flag" case-payg-mdl
expect 0 "--allow-payg records the decision and clears it" case-payg --allow-payg
run case-payg
grep -qi 'billed per token' <<<"$OUT" && ok "says why it stopped" || bad "did not explain the PAYG stop"

# =============================================================================
hdr "3. Succeeds and breaks cost accounting — the silent case (TOG-164)"
# =============================================================================
expect 2 "usage without the cache fields does not pass" case-nocache
expect 2 "only one of the two cache fields is still not enough" case-halfcache

# =============================================================================
hdr "4. Returns 200 and is unusable"
# =============================================================================
expect 3 "an OpenAI chat-completion body is not an Anthropic envelope" case-openai
expect 3 "a 200 carrying an error object does not pass" case-err200
expect 3 "an HTML error page served as 200 does not pass" case-html
expect 3 "404 at /v1/messages is reported, not treated as absence of CI-style silence" case-404
expect 3 "500 does not pass" case-500

# =============================================================================
hdr "5. Auth — and the single-attempt property that avoids the IP ban"
# =============================================================================
: > "$COUNTS"
expect 4 "401 is unauthorized, distinct from unreachable" case-401
N="$(grep -c '^case-401$' "$COUNTS")"
[[ "$N" -eq 1 ]] && ok "401 was NOT retried (exactly 1 request reached the stub)" \
                 || bad "401 produced $N requests — a retry loop here IP-bans the host for 30 minutes"

: > "$COUNTS"
expect 4 "403 is unauthorized" case-403
N="$(grep -c '^case-403$' "$COUNTS")"
[[ "$N" -eq 1 ]] && ok "403 was NOT retried" || bad "403 produced $N requests"

: > "$COUNTS"
expect 0 "the success path is also a single request" case-green
N="$(grep -c '^case-green$' "$COUNTS")"
[[ "$N" -eq 1 ]] && ok "success sent exactly 1 request (quota is real)" || bad "success sent $N requests"

# =============================================================================
hdr "6. Not up, and not down — the two states a 2xx check cannot see"
# =============================================================================
OUT="$(PREFLIGHT_API_KEY=k "$TOOL" "http://127.0.0.1:$CLOSED_PORT" 2>&1)"; RC=$?
[[ "$RC" -eq 5 ]] && ok "connection refused is unreachable (exit 5)" || { bad "refused connection gave exit $RC, wanted 5"; printf '        %s\n' "$OUT" | head -3; }
grep -qi 'outage' <<<"$OUT" && ok "says what flipping the env here would do" || bad "did not name the consequence"

OUT="$(PREFLIGHT_API_KEY=k "$TOOL" --timeout 2 "http://127.0.0.1:$PORT/case-hang" 2>&1)"; RC=$?
[[ "$RC" -eq 6 ]] && ok "connected-then-silent is timeout (exit 6), NOT unreachable and NOT ok" \
                  || { bad "hanging endpoint gave exit $RC, wanted 6"; printf '        %s\n' "$OUT" | head -3; }

OUT="$(PREFLIGHT_API_KEY=k "$TOOL" "http://127.0.0.1:1/x" 2>&1)"; RC=$?
[[ "$RC" -eq 5 ]] && ok "a closed privileged port is unreachable, not a pass" || bad "port 1 gave exit $RC, wanted 5"

# =============================================================================
hdr "7. Refuses to guess"
# =============================================================================
OUT="$(env -u PREFLIGHT_API_KEY -u ANTHROPIC_API_KEY "$TOOL" "http://127.0.0.1:$PORT/case-green" 2>&1)"; RC=$?
[[ "$RC" -eq 7 ]] && ok "no key is a usage error, not an anonymous probe" || bad "missing key gave exit $RC, wanted 7"

OUT="$(PREFLIGHT_API_KEY=k "$TOOL" 2>&1)"; RC=$?
[[ "$RC" -eq 7 ]] && ok "no base URL is a usage error" || bad "no args gave exit $RC, wanted 7"

OUT="$(PREFLIGHT_API_KEY=k "$TOOL" --wat "http://127.0.0.1:$PORT/case-green" 2>&1)"; RC=$?
[[ "$RC" -eq 7 ]] && ok "an unknown flag refuses instead of being ignored" || bad "unknown flag gave exit $RC, wanted 7"

OUT="$(PREFLIGHT_API_KEY=k "$TOOL" "127.0.0.1:$PORT/case-green" 2>&1)"; RC=$?
[[ "$RC" -eq 7 ]] && ok "a schemeless URL refuses" || bad "schemeless URL gave exit $RC, wanted 7"

OUT="$(PREFLIGHT_API_KEY=k "$TOOL" --timeout 0 "http://127.0.0.1:$PORT/case-green" 2>&1)"; RC=$?
[[ "$RC" -eq 7 ]] && ok "--timeout 0 refuses" || bad "--timeout 0 gave exit $RC, wanted 7"

OUT="$(PREFLIGHT_API_KEY=k "$TOOL" --model 2>&1)"; RC=$?
[[ "$RC" -eq 7 ]] && ok "a flag missing its value refuses" || bad "dangling --model gave exit $RC, wanted 7"

# =============================================================================
hdr "8. The key never reaches argv"
# =============================================================================
# TOG-200: /proc/*/cmdline is world-readable and every company shares this box.
# The tool builds a 0600 header file; this asserts the key is not passed to
# curl on a command line, by watching what a stub curl is actually invoked with.
SPY="$TMP/spy"; mkdir -p "$SPY"
cat > "$SPY/curl" <<'SPYC'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "$SPY_ARGV"
exec /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/curl "$@"
SPYC
chmod +x "$SPY/curl"
SPY_ARGV="$TMP/argv"; : > "$SPY_ARGV"
if [[ -x /usr/bin/curl ]]; then
  SPY_ARGV="$SPY_ARGV" PATH="$SPY:$PATH" PREFLIGHT_API_KEY="canary-key-9f3a2b" \
    "$TOOL" --quiet "http://127.0.0.1:$PORT/case-green" >/dev/null 2>&1
  if [[ -s "$SPY_ARGV" ]]; then
    grep -q 'canary-key-9f3a2b' "$SPY_ARGV" \
      && bad "the API key appeared in curl's argv — visible in /proc/*/cmdline" \
      || ok "the API key never appears in curl's argv"
  else
    ok "spy recorded nothing (curl not re-entered); key-on-argv unchecked here"
  fi
else
  ok "no /usr/bin/curl to spy on; skipping argv check"
fi

# =============================================================================
hdr "9. Mutation check — with a baseline, so a red proves something"
# =============================================================================
# TOG-339/TOG-354: "the mutated suite failed" is unattributable unless the
# UNMUTATED copy passes in the same staging directory first. Four gates in this
# repo were vacuous for exactly that reason.
#
# There is a second rung, and the first draft of this section fell off it. A
# mutation that makes a check fire ALWAYS also produces a red — but it reddens
# the control case while leaving the named case untouched, which demonstrates
# nothing about the check being tested. So every mutation here must be in the
# permissive direction (make the check never fire) and must satisfy BOTH:
#
#   the NAMED case stops returning its code            <- the check is load-bearing
#   the green control still returns 0                  <- the mutation was surgical
#
# Checking only the first is how "always fires" passed for a check that could
# equally have been deleted.
MUT="$TMP/mut"; mkdir -p "$MUT"
stage() { cp "$TOOL" "$MUT/tool.sh"; chmod +x "$MUT/tool.sh"; }
mrun() { PREFLIGHT_API_KEY=k "$MUT/tool.sh" --quiet "http://127.0.0.1:$PORT/$1" >/dev/null 2>&1; echo $?; }

# mutate <label> <case> <want> <sed-expr...>
mutate() {
  local label="$1" case_name="$2" want="$3"; shift 3
  stage
  local bg bn
  bg="$(mrun case-green)"; bn="$(mrun "$case_name")"
  if [[ "$bg" -ne 0 || "$bn" -ne "$want" ]]; then
    bad "$label — baseline failed in the staging dir (green=$bg $case_name=$bn, wanted 0/$want); any red below would be unattributable"
    return
  fi
  ok "$label — baseline: staged copy gives green=0, $case_name=$want"
  local e
  for e in "$@"; do sed -i "$e" "$MUT/tool.sh"; done
  # A sed that matches nothing leaves the file identical, and an identical file
  # trivially "still detects the bug". That reads as a pass forever after the
  # code it targets moves a line.
  if cmp -s "$TOOL" "$MUT/tool.sh"; then
    bad "$label — the mutation changed nothing; the code moved and this gate is blind"
    return
  fi
  if ! bash -n "$MUT/tool.sh" 2>/dev/null; then
    bad "$label — the mutation did not parse; it proved nothing"
    return
  fi
  local mg mn
  mg="$(mrun case-green)"; mn="$(mrun "$case_name")"
  if [[ "$mn" -eq "$want" ]]; then
    bad "$label — NOT load-bearing: $case_name still returned $want with the check defeated"
  elif [[ "$mg" -ne 0 ]]; then
    bad "$label — mutation was not surgical: it also broke the green control (0->$mg), so the red is unattributable"
  else
    ok "$label — load-bearing: $case_name $want->$mn while green stayed 0"
  fi
}

# Each sed makes the guard permanently FALSE, i.e. equivalent to deleting the
# check, which is the regression these gates exist to catch.
mutate "9a cache-accounting check" case-nocache 2 \
  's/if \[\[ "\$HAS_CACHE" != "yes" \]\]; then/if [[ "$HAS_CACHE" == "impossible" ]]; then/'

mutate "9b unauthorized branch" case-401 4 \
  's/^  401|403)$/  901|903)/'

mutate "9c PAYG detection" case-payg 1 \
  's/^\[\[ "\$RESP_ID" == gen-\* \]\]/[[ "$RESP_ID" == nevergonnamatch-* ]]/' \
  's|^\[\[ "\$RESP_MODEL" == \*/\* \]\]|[[ "$RESP_MODEL" == *@@@* ]]|'

mutate "9d envelope shape check" case-openai 3 \
  's/^  anthropic) ;;$/  anthropic|openai|error|*) ;;/'

# =============================================================================
hdr "10. Static checks"
# =============================================================================
bash -n "$TOOL" && ok "the tool parses" || bad "the tool does not parse"
PREFLIGHT_API_KEY=k "$TOOL" --help >/dev/null 2>&1 && ok "--help exits 0" || bad "--help did not exit 0"
H="$(PREFLIGHT_API_KEY=k "$TOOL" --help 2>&1)"
grep -q 'EXIT CODES' <<<"$H" && ok "--help documents the exit codes" || bad "--help lost the exit-code table"
grep -q 'ENVIRONMENT' <<<"$H" && ok "--help reaches the end of the header" || bad "--help range is truncated"

printf '\n\033[1mtest_agent_endpoint_preflight\033[0m  passed %d, failed %d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
