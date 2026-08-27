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
BODIES="$TMP/bodies.jsonl"
: > "$COUNTS"
: > "$BODIES"

# --- stub model front ---------------------------------------------------------
# One server, many personalities, selected by the path prefix the tool is
# pointed at. It appends every request path to $COUNTS so the suite can assert
# how many times the tool called it — the single-attempt property is the one
# thing here that cannot be checked from an exit code.
cat > "$TMP/stub.js" <<'STUB'
const http = require('http')
const fs = require('fs')

const COUNTS = process.env.COUNTS
const BODIES = process.env.BODIES

// A well-formed Anthropic envelope. Cases below clone and corrupt it.
const envelope = (over = {}) => ({
  id: 'msg_01ABCDEFGHIJKLMNOP',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5',
  content: [{ type: 'text', text: 'h' }],
  stop_reason: 'max_tokens',
  stop_sequence: null,
  usage: {
    input_tokens: 9,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  ...over,
})

const cacheSeen = new Map()
const firstBodies = new Map()

const CASES = {
  // `cacheable` makes the first occurrence of an exact request body report a
  // cache write and the second report a cache read. The tool puts a unique
  // nonce in each run's prefix, so an old test request cannot satisfy a new
  // run's first phase accidentally.
  'case-green':   { code: 200, body: envelope(), cacheable: true },

  // Both PAYG tells together, then each one alone — either can be absent
  // depending on which router is in front, and either alone must be enough.
  'case-payg':    { code: 200, body: envelope({ id: 'gen-1a2b3c4d', model: 'anthropic/claude-sonnet-5' }), cacheable: true },
  'case-payg-id': { code: 200, body: envelope({ id: 'gen-1a2b3c4d' }), cacheable: true },
  'case-payg-mdl':{ code: 200, body: envelope({ model: 'anthropic/claude-sonnet-5' }), cacheable: true },

  // Succeeds, and silently destroys cost accounting.
  'case-nocache': { code: 200, body: envelope({ usage: { input_tokens: 9, output_tokens: 1 } }) },
  // Only one of the two present is still not enough.
  'case-halfcache': { code: 200, body: envelope({ usage: { input_tokens: 9, output_tokens: 1, cache_read_input_tokens: 0 } }) },
  // Both field names exist, but no accounting ever occurs.
  'case-zero-cache': { code: 200, body: envelope() },
  // A route can report a read on the replay without reporting that it created
  // the unique entry first. The write gate, not its neighbouring read gate,
  // must be what rejects this.
  'case-read-only': { code: 200, body: envelope(), cacheReadOnly: true },
  // The first request reports a write, but its identical replay never reports a
  // read. This is the exact false green a one-request presence check permits.
  'case-write-only': { code: 200, body: envelope(), cacheWriteOnly: true },
  'case-first-bad-envelope': { code: 200,
    body: { type: 'message', role: 'assistant', content: [], stop_reason: 'end_turn',
      stop_sequence: null, usage: { input_tokens: 9, output_tokens: 1,
        cache_creation_input_tokens: 4096, cache_read_input_tokens: 0 } } },
  // The first response is valid and creates a cache entry; only the replay is
  // corrupted. A replay must not borrow the first response's envelope/lane proof.
  'case-replay-bad-envelope': { code: 200, body: envelope(), cacheable: true,
    replayBody: { type: 'message', usage: { cache_read_input_tokens: 4096 } } },
  'case-replay-payg': { code: 200, body: envelope(), cacheable: true,
    replayBody: envelope({ id: 'gen-replay', model: 'anthropic/claude-sonnet-5', usage: {
      input_tokens: 9, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 4096 } }) },

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

  // TOG-361, teamclaude's actual behaviour: the endpoint is healthy and fast,
  // and one model class hangs forever. Selected on the request BODY, not the
  // path, because that is the only thing that distinguishes the two requests
  // the tool sends here. Anything that is not the control model hangs.
  'case-model-hang': { hangUnlessModel: 'claude-haiku-4-5-20251001', code: 200, body: envelope(), cacheAfterControl: true },
  // A proxy can answer the control request with status 200 while returning a
  // body no Anthropic client can consume. That must stay inconclusive (exit 6),
  // not upgrade the target timeout to model-unavailable (exit 8).
  'case-control-proxy200': { hangUnlessModel: 'claude-haiku-4-5-20251001', code: 200,
    body: { error: { type: 'proxy_error', message: 'upstream route missing' } } },
  // Looks superficially message-shaped but omits required Messages fields.
  'case-control-malformed200': { hangUnlessModel: 'claude-haiku-4-5-20251001', code: 200,
    body: { type: 'message', role: 'assistant', content: [], usage: {} } },
  'case-control-no-stop-reason': { hangUnlessModel: 'claude-haiku-4-5-20251001', code: 200,
    body: envelope({ stop_reason: undefined }) },
  'case-control-no-stop-sequence': { hangUnlessModel: 'claude-haiku-4-5-20251001', code: 200,
    body: envelope({ stop_sequence: undefined }) },
  'case-control-no-cache-create': { hangUnlessModel: 'claude-haiku-4-5-20251001', code: 200,
    body: envelope({ usage: { input_tokens: 9, output_tokens: 1, cache_read_input_tokens: 0 } }) },
  'case-control-no-cache-read': { hangUnlessModel: 'claude-haiku-4-5-20251001', code: 200,
    body: envelope({ usage: { input_tokens: 9, output_tokens: 1, cache_creation_input_tokens: 0 } }) },
  'case-control-null-cache': { hangUnlessModel: 'claude-haiku-4-5-20251001', code: 200,
    body: envelope({ usage: { input_tokens: 9, output_tokens: 1,
      cache_creation_input_tokens: null, cache_read_input_tokens: null } }) },
  'case-model-body-match': { hangUnlessModel: 'claude-haiku-4-5-20251001',
    requireBodiesEqualExceptModel: true, code: 200, body: envelope() },
  // The control sends a complete, valid envelope but never terminates the HTTP
  // transfer. curl sees status 200 and writes the body, then exits 28. The body
  // must not override the transport failure and falsely certify the endpoint.
  'case-control-partial200': { hangUnlessModel: 'claude-haiku-4-5-20251001', code: 200,
    body: envelope(), leaveOpen: true },

  // TOG-358, teamclaude's ACTUAL behaviour, measured 2026-08-25 from an agent
  // container. The front sits on Claude Max subscription accounts and the
  // subscription lane is reached only by requests that look like the Claude
  // Code CLI. A bare request — the one this tool used to send — hangs forever;
  // the same request carrying the client identity answers in 1.3s.
  //
  // This is the case that catches the dangerous direction. A gate that probes
  // without the identity gets silence here and reports a dead endpoint or a
  // dead model lane, when in fact every real agent is being served fine.
  'case-subscription-lane': { requireClientIdentity: true, code: 200, body: envelope(), cacheable: true },

  // The inverse, and the reason a green must not be accepted from a bare
  // probe: a front that answers ANYTHING, identity or not. Used to prove the
  // suite's identity assertions are actually reading the request rather than
  // passing because every stub case happens to answer.
  'case-any-client': { code: 200, body: envelope(), cacheable: true },

  // Both conditions at once, which is what teamclaude really is: the
  // subscription lane needs the client identity AND one model class is dead.
  // The target hangs on the model; the control can only answer if the CONTROL
  // request carried the identity too. That makes exit 8 here a direct
  // assertion that both requests are built the same way.
  'case-lane-and-identity': { requireClientIdentity: true, hangUnlessModel: 'claude-haiku-4-5-20251001', code: 200, body: envelope() },
}

const server = http.createServer((req, res) => {
  const key = (req.url.split('/')[1] || '')
  fs.appendFileSync(COUNTS, key + '\n')
  const c = CASES[key]
  // Drain the request body; curl waits for us to read it. Kept, not discarded,
  // for the cases that answer differently per model.
  let raw = ''
  req.on('data', (d) => { raw += d })
  req.on('end', () => {
    fs.appendFileSync(BODIES, JSON.stringify({ key, raw }) + '\n')
    if (!c) { res.writeHead(418); res.end('no such case'); return }
    if (c.hang) return                                   // deliberately no response
    if (c.hangUnlessModel !== undefined) {
      let parsed = null
      try { parsed = JSON.parse(raw) } catch (e) { /* fall through to hang */ }
      const model = parsed && parsed.model
      if (c.requireBodiesEqualExceptModel) {
        const comparable = JSON.stringify({ ...parsed, model: '<model>' })
        const first = firstBodies.get(key)
        if (first === undefined) firstBodies.set(key, comparable)
        else if (first !== comparable) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { type: 'request_mismatch', message: 'bodies differ beyond model' } }))
          return
        }
      }
      if (model !== c.hangUnlessModel) return            // this model's lane is dead
    }
    if (c.requireClientIdentity) {
      // Both elements were measured load-bearing on teamclaude: dropping the
      // system prompt alone, or the user-agent alone, each reverted a 1.3s
      // 200 to an indefinite hang. So the stub demands both.
      const ua = String(req.headers['user-agent'] || '')
      let sys = ''
      try {
        const s = JSON.parse(raw).system
        sys = Array.isArray(s) ? s.map((b) => b && b.text).join(' ') : String(s || '')
      } catch (e) { /* fall through to hang */ }
      if (!/^claude-cli\//.test(ua)) return              // not the CLI: no lane
      if (!/You are Claude Code/.test(sys)) return       // no Claude Code system prompt
    }
    if (c.raw !== undefined) {
      res.writeHead(c.code, { 'content-type': c.type })
      res.end(c.raw)
      return
    }
    let body = c.body
    if (c.cacheable || c.cacheReadOnly || c.cacheWriteOnly || c.cacheAfterControl) {
      const seen = cacheSeen.get(raw) || 0
      cacheSeen.set(raw, seen + 1)
      if (seen > 0 && c.replayBody !== undefined) {
        body = c.replayBody
      } else {
        body = envelope({
          ...(c.body.id && { id: c.body.id }),
          ...(c.body.model && { model: c.body.model }),
          usage: {
            input_tokens: 9,
            output_tokens: 1,
            cache_creation_input_tokens: c.cacheReadOnly ? 0 : (seen === 0 ? 4096 : 0),
            cache_read_input_tokens: (c.cacheable || c.cacheReadOnly || c.cacheAfterControl) && seen > 0 ? 4096 : 0,
          },
        })
      }
    }
    if (c.leaveOpen) {
      res.writeHead(c.code, { 'content-type': 'application/json' })
      res.write(JSON.stringify(body))
      return
    }
    res.writeHead(c.code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
})

server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.env.PORTFILE, String(server.address().port))
})
STUB

PORTFILE="$TMP/port"
COUNTS="$COUNTS" BODIES="$BODIES" PORTFILE="$PORTFILE" node "$TMP/stub.js" & STUB_PID=$!
for _ in $(seq 1 50); do [[ -s "$PORTFILE" ]] && break; sleep 0.1; done
PORT="$(cat "$PORTFILE" 2>/dev/null)"
[[ -n "$PORT" ]] || { echo "stub did not start" >&2; exit 2; }
BASE_URL="http://127.0.0.1:$PORT"

# A port nothing listens on, for the refused-connection case. Bound and closed
# by node so it is known-free rather than guessed.
CLOSED_PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})')"
NONCE_SEQ=0

# run <case-path> [extra tool args...] -> sets RC, OUT
run() {
  local case_path="$1"; shift
  NONCE_SEQ=$((NONCE_SEQ+1))
  OUT="$(PREFLIGHT_API_KEY=test-key-not-real PREFLIGHT_CACHE_NONCE="test-$NONCE_SEQ" "$TOOL" "$@" "http://127.0.0.1:$PORT/$case_path" 2>&1)"
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

# The output must name the two positive measurements it actually observed. A
# green that cannot say what was written and read is not evidence.
grep -q 'cache    : creation=4096 replay_read=4096' <<<"$OUT" \
  && ok "reports the positive cache write and replay read" \
  || bad "did not report the cache-accounting measurements"

# OmniRoute's combo quality validator rejects max_tokens:1 before the selected
# upstream runs. That manufactured the live 502 which woke this issue even
# though TOG-352 had already installed a healthy subscription route. The gate
# must ask for enough output to reach the route it claims to test.
: > "$BODIES"
expect 0 "the request reaches the route with OmniRoute's minimum output budget" case-green
REQ_MAX="$(jq -r 'select(.key=="case-green") | .raw | fromjson | .max_tokens' "$BODIES" | tail -1)"
[[ "$REQ_MAX" -ge 16 ]] && ok "target request uses max_tokens >= 16 (got $REQ_MAX)" \
                         || bad "target request used max_tokens ${REQ_MAX:-missing}; OmniRoute manufactures a 502 below 16"

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
expect 3 "usage without the required cache fields is a bad envelope" case-nocache
expect 3 "only one required cache field is still a bad envelope" case-halfcache
expect 2 "two zero-valued field names are not cache-accounting evidence" case-zero-cache
expect 2 "a replay read without a positive write does not pass" case-read-only
expect 3 "an incomplete initial envelope cannot authorize a replay" case-first-bad-envelope
expect 2 "a malformed replay envelope does not borrow the first response's proof" case-replay-bad-envelope
expect 1 "a PAYG replay does not borrow the first response's subscription verdict" case-replay-payg
expect 0 "--allow-payg also records a PAYG replay decision" case-replay-payg --allow-payg

: > "$COUNTS"
expect 2 "a positive write without a positive replay read does not pass" case-write-only
N="$(grep -c '^case-write-only$' "$COUNTS")"
[[ "$N" -eq 2 ]] && ok "write-only case sent exactly the creation and replay requests" \
                 || bad "write-only case sent $N requests, wanted exactly 2"

# A missing/zero write stops before the replay. This is both cheaper and safer:
# a route that already failed the creation half cannot clear the full preflight.
: > "$COUNTS"
expect 2 "a zero-valued first response stops before replay" case-zero-cache
N="$(grep -c '^case-zero-cache$' "$COUNTS")"
[[ "$N" -eq 1 ]] && ok "zero-cache case sent no pointless replay" \
                 || bad "zero-cache case sent $N requests, wanted exactly 1"

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
expect 0 "the success path is exactly one cache write plus one replay" case-green
N="$(grep -c '^case-green$' "$COUNTS")"
[[ "$N" -eq 2 ]] && ok "success sent exactly 2 requests: creation and replay" || bad "success sent $N requests, wanted 2"

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
hdr "6b. A dead model lane on a live endpoint (TOG-361)"
# =============================================================================
# teamclaude served claude-haiku-4-5-20251001 in 0.48s while every Opus/Sonnet
# id hung forever. Reporting that as `timeout` says "the endpoint is down",
# which is the opposite of the truth and the opposite decision at a cutover
# gate. These assert the tool tells the two apart, and that it does not tell
# them apart by guessing.
: > "$COUNTS"
OUT="$(PREFLIGHT_API_KEY=k "$TOOL" --timeout 2 "http://127.0.0.1:$PORT/case-model-hang" 2>&1)"; RC=$?
[[ "$RC" -eq 8 ]] && ok "target model hangs + control model answers is model-unavailable (exit 8)" \
                  || { bad "dead model lane gave exit $RC, wanted 8"; printf '        %s\n' "$OUT" | head -4; }
grep -q 'verdict  : model-unavailable' <<<"$OUT" && ok "reports verdict model-unavailable" || bad "did not report verdict model-unavailable"
grep -q 'endpoint is UP' <<<"$OUT" && ok "says the endpoint is up, so this is not read as an outage" || bad "did not say the endpoint is up"
grep -q 'claude-haiku-4-5-20251001' <<<"$OUT" && ok "names the control model that answered" || bad "did not name the control model"
# Exit 8 must not be mistaken for a pass by anything gating on 0.
[[ "$RC" -ne 0 ]] && ok "a dead model lane is not a pass" || bad "dead model lane exited 0"

# Exactly two requests: the target, then one control. Not a retry loop.
N="$(grep -c '^case-model-hang$' "$COUNTS")"
[[ "$N" -eq 2 ]] && ok "sent exactly 2 requests: the target and one control" || bad "sent $N requests, wanted 2"

# HTTP 200 from the control is not sufficient. Both cases answer the control
# model, but neither body is a valid Anthropic Messages response envelope.
for c in case-control-proxy200 case-control-malformed200 case-control-no-stop-reason case-control-no-stop-sequence case-control-no-cache-create case-control-no-cache-read case-control-partial200; do
  : > "$COUNTS"
  OUT="$(PREFLIGHT_API_KEY=k "$TOOL" --timeout 2 "$BASE_URL/$c" 2>&1)"; RC=$?
  [[ "$RC" -eq 6 ]] && ok "$c stays inconclusive (exit 6)" \
                    || { bad "$c gave exit $RC, wanted 6"; printf '        %s\n' "$OUT" | head -4; }
  if [[ "$c" == case-control-partial200 ]]; then
    grep -q 'also failed (HTTP 000)' <<<"$OUT" \
      && ok "$c treats the incomplete HTTP 200 transfer as a timeout" \
      || bad "$c did not preserve curl's transfer failure"
  else
    grep -q 'non-Anthropic response envelope' <<<"$OUT" \
      && ok "$c says why HTTP 200 did not prove endpoint health" \
      || bad "$c did not reject the false-green control envelope"
  fi
  N="$(grep -c "^$c$" "$COUNTS")"
  [[ "$N" -eq 2 ]] && ok "$c sent exactly target + control" || bad "$c sent $N requests, wanted 2"
done

# Nullable cache counters are valid so long as both required keys exist.
: > "$COUNTS"
OUT="$(PREFLIGHT_API_KEY=k "$TOOL" --timeout 2 "$BASE_URL/case-control-null-cache" 2>&1)"; RC=$?
[[ "$RC" -eq 8 ]] && ok "null control cache counters remain a valid envelope (exit 8)" \
                    || { bad "null cache counters gave exit $RC, wanted 8"; printf '        %s\n' "$OUT" | head -4; }

# The control comparison earns its attribution only if the two request bodies
# differ by model and nothing else. This stub returns an error 200 on drift.
: > "$COUNTS"
OUT="$(PREFLIGHT_API_KEY=k "$TOOL" --timeout 2 "$BASE_URL/case-model-body-match" 2>&1)"; RC=$?
[[ "$RC" -eq 8 ]] && ok "target and control request bodies differ only by model" \
                    || { bad "request bodies drifted beyond model (exit $RC)"; printf '        %s\n' "$OUT" | head -4; }

# The endpoint-wide hang must still be exit 6 — the control probe hangs too.
: > "$COUNTS"
OUT="$(PREFLIGHT_API_KEY=k "$TOOL" --timeout 2 "http://127.0.0.1:$PORT/case-hang" 2>&1)"; RC=$?
[[ "$RC" -eq 6 ]] && ok "when the control model hangs too, it is still timeout (exit 6)" || bad "endpoint-wide hang gave exit $RC, wanted 6"
grep -q 'also failed' <<<"$OUT" && ok "says the control model also failed" || bad "did not report the control result"
# A control that also hangs is ambiguous — the target's own leaked capacity can
# take it down. Asserting the tool does not upgrade that into an outage claim.
grep -q 'INCONCLUSIVE' <<<"$OUT" && ok "calls a double timeout inconclusive rather than an outage" || bad "overclaimed an endpoint-wide hang"
grep -qi 'whole endpoint hanging' <<<"$OUT" && bad "still claims the whole endpoint is hanging" || ok "does not claim the whole endpoint is hanging"

# A control probe that cannot discriminate must not be run, and the tool must
# say so rather than quietly returning a verdict it did not earn.
OUT="$(PREFLIGHT_API_KEY=k "$TOOL" --timeout 2 --control-model claude-sonnet-5 "http://127.0.0.1:$PORT/case-model-hang" 2>&1)"; RC=$?
[[ "$RC" -eq 6 ]] && ok "control model equal to --model falls back to timeout (exit 6)" || bad "equal control model gave exit $RC, wanted 6"
grep -q 'CANNOT distinguish' <<<"$OUT" && ok "admits it could not tell a dead endpoint from a dead lane" || bad "did not admit the ambiguity"

: > "$COUNTS"
OUT="$(PREFLIGHT_API_KEY=k "$TOOL" --timeout 2 --control-model '' "http://127.0.0.1:$PORT/case-model-hang" 2>&1)"; RC=$?
[[ "$RC" -eq 6 ]] && ok "an empty --control-model suppresses the probe (exit 6)" || bad "empty control model gave exit $RC, wanted 6"
N="$(grep -c '^case-model-hang$' "$COUNTS")"
[[ "$N" -eq 1 ]] && ok "suppressed control probe sends exactly 1 request" || bad "suppressed probe sent $N requests, wanted 1"

# Pointing --model at the lane that works is a pass, which is exactly why the
# default must not be that model.
OUT="$(PREFLIGHT_API_KEY=k "$TOOL" --timeout 2 --model claude-haiku-4-5-20251001 "http://127.0.0.1:$PORT/case-model-hang" 2>&1)"; RC=$?
[[ "$RC" -eq 0 ]] && ok "the working lane passes when asked for by name" || bad "working lane gave exit $RC, wanted 0"
grep -q 'claude-sonnet-5' <<<"$(PREFLIGHT_API_KEY=k "$TOOL" --help 2>&1)" && ok "--help still documents the default model" || bad "--help lost the default model"

# =============================================================================
hdr "6c. The subscription lane needs a Claude Code client (TOG-358)"
# =============================================================================
# The fronts this gate checks sit on Claude Max subscription accounts, and that
# lane only answers requests that look like the Claude Code CLI. Measured on
# teamclaude 2026-08-25: a bare claude-sonnet-5 request hangs forever, the same
# request carrying the client identity returns 200 in 1.29s, and dropping
# EITHER the system prompt or the user-agent alone reverts it to a hang.
#
# So a probe without that identity is not asking the question this gate exists
# to answer. The fail is the safe direction and it already cost real work — it
# is what made teamclaude look like a dead model lane. The PASS is the
# dangerous direction: a front that answers a bare curl and refuses the
# subscription lane would clear this gate and break every agent on the box.
: > "$COUNTS"
OUT="$(PREFLIGHT_API_KEY=k "$TOOL" --timeout 2 "http://127.0.0.1:$PORT/case-subscription-lane" 2>&1)"; RC=$?
[[ "$RC" -eq 0 ]] && ok "a subscription-lane front passes, so the probe carries the client identity" \
                  || { bad "subscription lane gave exit $RC, wanted 0"; printf '        %s\n' "$OUT" | head -4; }

# The contrast that gives the assertion above its meaning: same stub, same
# tool, identity stripped. If this also passed, the case would be proving
# nothing about what the tool sends.
OUT="$(PREFLIGHT_API_KEY=k "$TOOL" --timeout 2 --no-client-identity "http://127.0.0.1:$PORT/case-subscription-lane" 2>&1)"; RC=$?
[[ "$RC" -ne 0 ]] && ok "the same front does NOT pass a bare probe (exit $RC)" || bad "a bare probe passed the subscription-lane front"

# ...and the baseline for THAT contrast: --no-client-identity must not simply
# break the tool. Against a front that answers anything, both forms pass, so
# the red above is attributable to the stub reading the request.
OUT="$(PREFLIGHT_API_KEY=k "$TOOL" --timeout 2 --no-client-identity "http://127.0.0.1:$PORT/case-any-client" 2>&1)"; RC=$?
[[ "$RC" -eq 0 ]] && ok "--no-client-identity still passes a front that answers anything" \
                  || { bad "--no-client-identity broke the tool outright (exit $RC)"; printf '        %s\n' "$OUT" | head -4; }
OUT="$(PREFLIGHT_API_KEY=k "$TOOL" --timeout 2 "http://127.0.0.1:$PORT/case-any-client" 2>&1)"; RC=$?
[[ "$RC" -eq 0 ]] && ok "so does the default form" || bad "default form failed a permissive front (exit $RC)"

# The control probe must carry the identity too. Here the target hangs on the
# model and the control can only answer if ITS request was built the same way —
# so exit 8 proves both requests share one builder, and exit 6 would mean the
# control was sent bare and hung for a reason that has nothing to do with lanes.
: > "$COUNTS"
OUT="$(PREFLIGHT_API_KEY=k "$TOOL" --timeout 2 "http://127.0.0.1:$PORT/case-lane-and-identity" 2>&1)"; RC=$?
[[ "$RC" -eq 8 ]] && ok "the control probe carries the client identity too (exit 8)" \
                  || { bad "control probe on a subscription lane gave exit $RC, wanted 8"; printf '        %s\n' "$OUT" | head -4; }

# Exit 8 must claim only what the control earned. Two models answering
# differently does not establish that one is unavailable upstream — a front
# serving them from different lanes produces the same observation, which is
# exactly the mistake that sent TOG-361 to the wrong conclusion.
grep -q 'not being served alike' <<<"$OUT" && ok "exit 8 says the two models are served differently" || bad "exit 8 did not hedge to a serving difference"
grep -q 'does NOT establish' <<<"$OUT" && ok "exit 8 disclaims 'unavailable upstream'" || bad "exit 8 still asserts the model is unavailable upstream"
grep -q 'confound is ruled out' <<<"$OUT" && ok "exit 8 records that both requests carried the identity" || bad "exit 8 did not record the identity of its requests"

# And when the run WAS bare, exit 8 must name that as the first thing to rule
# out — otherwise the tool hands over its least reliable verdict with its
# biggest confound unmentioned.
OUT="$(PREFLIGHT_API_KEY=k "$TOOL" --timeout 2 --no-client-identity "http://127.0.0.1:$PORT/case-model-hang" 2>&1)"; RC=$?
[[ "$RC" -eq 8 ]] && ok "a bare run can still reach exit 8" || bad "bare run gave exit $RC, wanted 8"
grep -q 'no-client-identity' <<<"$OUT" && ok "exit 8 warns that the bare-probe confound was not ruled out" || bad "bare exit 8 did not name its own confound"

grep -q -- '--no-client-identity' <<<"$(PREFLIGHT_API_KEY=k "$TOOL" --help 2>&1)" && ok "--help documents the diagnostic flag" || bad "--help does not document --no-client-identity"
HELP="$(PREFLIGHT_API_KEY=k "$TOOL" --help 2>&1)"
grep -q 'claude-cli' <<<"$HELP" && ok "--help names the client user-agent it sends" || bad "--help does not name the client user-agent"
grep -q 'Claude Code system prompt' <<<"$HELP" && ok "--help names the system prompt it sends" || bad "--help does not name the system prompt"

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
# --timeout 2 so the hanging cases below cost seconds, not the 45s default. The
# cases that answer are unaffected: the stub replies immediately.
mrun() {
  local nonce="mutation-$(date +%s%N)-$$-$RANDOM"
  PREFLIGHT_API_KEY=k PREFLIGHT_CACHE_NONCE="$nonce" \
    "$MUT/tool.sh" --quiet --timeout 2 "http://127.0.0.1:$PORT/$1" >/dev/null 2>&1
  echo $?
}

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
mutate "9a cache-creation check" case-read-only 2 \
  's/"\$CACHE_CREATE" -le 0/"$CACHE_CREATE" -le -1/'

mutate "9b cache-replay check" case-write-only 2 \
  's/"\$CACHE_REPLAY_READ" -le 0/"$CACHE_REPLAY_READ" -le -1/'

mutate "9c unauthorized branch" case-401 4 \
  's/^  401|403)$/  901|903)/'

mutate "9d PAYG detection" case-payg 1 \
  's/^\[\[ "\$RESP_ID" == gen-\* \].*$/[[ "$RESP_ID" == nevergonnamatch-* ]] \&\& PAYG_WHY="no"/' \
  's|^\[\[ "\$RESP_MODEL" == \*/\* \].*$|[[ "$RESP_MODEL" == *@@@* ]] \&\& PAYG_WHY="no"|' \
  's/^\[\[ "\$CACHE_RESP_ID" == gen-\* \].*$/[[ "$CACHE_RESP_ID" == nevergonnamatch-* ]] \&\& CACHE_PAYG_WHY="no"/' \
  's|^\[\[ "\$CACHE_RESP_MODEL" == \*/\* \].*$|[[ "$CACHE_RESP_MODEL" == *@@@* ]] \&\& CACHE_PAYG_WHY="no"|'

mutate "9e envelope shape check" case-openai 3 \
  's/^  anthropic) ;;$/  anthropic|openai|error|*) ;;/'

# TOG-361. Defeating the control-probe classification collapses exit 8 back
# into exit 6 — "the endpoint is down" for an endpoint that is up. The failure
# this catches is silent: both values are non-zero, so a gate that only checks
# `-ne 0` stays happy while the operator is told the wrong thing.
mutate "9f control-probe classification" case-model-hang 8 \
  's/if \[\[ "\$CCODE" == 200 \]\]; then/if [[ "$CCODE" == 999 ]]; then/'

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
