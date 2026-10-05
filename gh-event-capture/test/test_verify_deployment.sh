#!/usr/bin/env bash
# Offline suite for `scripts/verify-deployment.sh` — and the only place the
# receiver is exercised over a REAL HTTP SOCKET.
#
# Two things are being proven here, and they are different things.
#
#   1. The verifier works. It is the artifact the operator runs to close gate 0,
#      so a verifier that passes against a broken deployment is worse than no
#      verifier: it converts "we did not check" into "we checked and it was
#      fine". The second half of this file therefore points it at deliberately
#      broken receivers and requires it to go RED.
#
#   2. The receiver survives contact with a real socket. `capture.test.mjs`
#      calls `createApp` in-process with hand-built Request objects. That cannot
#      catch anything that only shows up over the wire — a header lost in
#      transit, a body that arrives as a stream, raw bytes re-encoded somewhere
#      between the socket and the HMAC. This runs the actual app under
#      `node:http` and drives it with curl.
#
# No Cloudflare, no D1, no network beyond 127.0.0.1, nothing installed. The
# store is the in-memory double; what is real is the HTTP path.
#
# Assertions pin EXIT STATUS, never printed prose, and no test count is asserted.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
srv_pid=""
trap 'rm -rf "$tmp"; [ -n "$srv_pid" ] && kill "$srv_pid" 2>/dev/null' EXIT INT TERM

fails=0
ok()  { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; fails=$((fails + 1)); }

SECRET="test-webhook-secret-not-a-real-one"
TOKEN="test-query-token-not-a-real-one"

command -v curl >/dev/null || { echo "FAIL  curl is required"; exit 1; }

# --- the real app, on a real socket ----------------------------------------
# `MODE` reshapes the deployment so the verifier can be pointed at a BROKEN one:
#
#   ok            correctly configured
#   no-secret     WEBHOOK_SECRET unset — the Worker fails closed with 503
#   no-token      QUERY_TOKEN unset — the read API is 503
#   accept-all    signature verification bypassed (the bug the control prevents)
#   no-store      accepts and answers 200 without ever writing a row
cat > "$tmp/server.mjs" <<'JS'
import http from 'node:http'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

// This file is written into a temp directory, so `../src` would resolve
// somewhere meaningless. SRC_DIR is the checkout, passed in by the runner.
const src = (m) => pathToFileURL(`${process.env.SRC_DIR}/${m}`).href
const { createApp } = await import(src('app.js'))
const { createMemoryStore } = await import(src('store-memory.js'))

const MODE = process.env.MODE ?? 'ok'
const store = createMemoryStore()

if (MODE === 'no-store') {
  // Answers as though it stored, and did not. The failure mode a deploy with a
  // wrong `database_id` would produce: everything looks green, nothing lands.
  store.append = async () => ({ inserted: true })
}

const app = createApp({
  store,
  webhookSecret: MODE === 'no-secret' ? undefined : process.env.SECRET,
  queryToken: MODE === 'no-token' ? undefined : process.env.TOKEN,
})

const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)

  const url = `http://127.0.0.1${req.url}`
  const init = { method: req.method, headers: req.headers }
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = body

  let request = new Request(url, init)

  if (MODE === 'accept-all') {
    // Reintroduce the bug this whole module exists to prevent: forge a valid
    // signature over whatever arrived, so every delivery verifies.
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(process.env.SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, body))
    let hex = ''
    for (const b of mac) hex += b.toString(16).padStart(2, '0')
    const headers = new Headers(req.headers)
    headers.set('x-hub-signature-256', `sha256=${hex}`)
    request = new Request(url, { ...init, headers })
  }

  const out = await app(request)
  const text = await out.text()
  res.writeHead(out.status, Object.fromEntries(out.headers))
  res.end(text)
})

server.listen(0, '127.0.0.1', () =>
  fs.writeFileSync(process.env.PORT_FILE, String(server.address().port)))
JS

start() {
  local mode="$1"
  [ -n "$srv_pid" ] && { kill "$srv_pid" 2>/dev/null; wait "$srv_pid" 2>/dev/null; srv_pid=""; }
  rm -f "$tmp/port"
  MODE="$mode" SECRET="$SECRET" TOKEN="$TOKEN" PORT_FILE="$tmp/port" SRC_DIR="$here/src" \
    node "$tmp/server.mjs" >"$tmp/server.log" 2>&1 &
  srv_pid=$!
  for _ in $(seq 1 60); do [ -s "$tmp/port" ] && break; sleep 0.1; done
  [ -s "$tmp/port" ] || { echo "FAIL  receiver ($mode) never came up"; sed 's/^/      /' "$tmp/server.log"; exit 1; }
  URL="http://127.0.0.1:$(cat "$tmp/port")"
}

# verify <wanted-exit> <label> [args...]
#
# env -i for the same reason the sibling suite uses it: a live GH_CAPTURE_SECRET
# or QUERY_TOKEN exported in the operator's shell must not reach a test run and
# quietly make a failing case pass.
verify() {
  local want="$1" label="$2"; shift 2
  env -i PATH="$PATH" HOME="$tmp" \
    GH_CAPTURE_URL="$URL" GH_CAPTURE_TOKEN="$TOKEN" GH_CAPTURE_SECRET="$SECRET" \
    bash "$here/scripts/verify-deployment.sh" "$@" > "$tmp/out" 2>&1
  local got=$?
  if [ "$got" -eq "$want" ]; then ok "$label (exit $got)"
  else bad "$label — wanted exit $want, got $got"; sed 's/^/      /' "$tmp/out"; fi
}

# ---------------------------------------------------------------------------
# A correct deployment passes — over a real socket, end to end.
# ---------------------------------------------------------------------------
start ok
verify 0 "a correctly configured receiver passes every check"
verify 0 "--no-probe passes too, and writes nothing" --no-probe

# The probe row really is in the store, reachable by the documented query. This
# is the end-to-end path — curl, socket, HMAC over raw bytes, store, read back.
probes="$(curl -sS --max-time 10 -H "Authorization: Bearer $TOKEN" "$URL/events?event=x_capture_probe" | grep -c 'capture-probe-')"
[ "$probes" -ge 1 ] && ok "the probe delivery is queryable by its documented event name" \
                    || bad "the probe delivery did not come back from GET /events"

# ---------------------------------------------------------------------------
# The verifier must be able to FAIL. CONTRIBUTING § "What done means" item 3:
# a green check that cannot go red is worse than none, because it is believed.
# Each case below is a real way a deploy goes wrong.
# ---------------------------------------------------------------------------
start no-secret
verify 1 "a receiver with no WEBHOOK_SECRET is caught (fails closed, 503)"

start no-token
verify 1 "a receiver with no QUERY_TOKEN is caught"

start accept-all
verify 1 "a receiver that skips signature verification is caught"

start no-store
verify 1 "a receiver that answers 200 without storing is caught"

# ---------------------------------------------------------------------------
# A run in which NO check executes must not exit 0. `fail -eq 0` is satisfied by
# zero evidence exactly as well as by a healthy deployment, and telling those
# two apart is the entire value of the gate.
#
# Staged as a MUTATION: check() and assert() are replaced with no-ops after
# their real definitions, so every request still goes out over the socket and
# nothing is counted. The unmutated copy runs from the same staging directory
# first — without that baseline, "the mutant exited 2" could equally mean the
# staging step broke the script, and the case would prove nothing.
# ---------------------------------------------------------------------------
start ok
mkdir -p "$tmp/staged"
cp "$here/scripts/verify-deployment.sh" "$tmp/staged/baseline.sh"

run_staged() {
  env -i PATH="$PATH" HOME="$tmp" \
    GH_CAPTURE_URL="$URL" GH_CAPTURE_TOKEN="$TOKEN" GH_CAPTURE_SECRET="$SECRET" \
    bash "$1" --no-probe >"$tmp/out" 2>&1
}

run_staged "$tmp/staged/baseline.sh"; got=$?
[ "$got" -eq 0 ] && ok "baseline: the staged, unmutated verifier still exits 0" \
                 || { bad "baseline: staged unmutated verifier wanted exit 0, got $got"; sed 's/^/      /' "$tmp/out"; }

awk '{ print }
     /^echo "verify-deployment: \$GH_CAPTURE_URL"$/ { print "check()  { :; }"; print "assert() { :; }" }' \
  "$here/scripts/verify-deployment.sh" > "$tmp/staged/nocount.sh"

# The injection must have landed, or the case below is vacuous for the wrong
# reason — it would exit 2 whether or not the guard exists.
grep -q '^check()  { :; }$' "$tmp/staged/nocount.sh" \
  && ok "the zero-check mutation was actually applied" \
  || bad "the zero-check mutation did not apply — the case below proves nothing"

run_staged "$tmp/staged/nocount.sh"; got=$?
[ "$got" -eq 2 ] && ok "a run where zero checks execute is exit 2, never a green gate" \
                 || { bad "zero checks executed but the verifier exited $got — a gate passing on no evidence"; sed 's/^/      /' "$tmp/out"; }

# Environment errors are exit 2 — distinct from "a check failed", so a missing
# variable can never be misread as a receiver that is genuinely broken.
start ok
env -i PATH="$PATH" HOME="$tmp" GH_CAPTURE_URL="$URL" GH_CAPTURE_TOKEN="$TOKEN" \
  bash "$here/scripts/verify-deployment.sh" >"$tmp/out" 2>&1
[ $? -eq 2 ] && ok "a missing GH_CAPTURE_SECRET is exit 2, not a false failure" \
             || bad "a missing GH_CAPTURE_SECRET must exit 2"

verify 2 "an unknown argument is refused, never run" --wipe-the-store

env -i PATH="$PATH" HOME="$tmp" \
  GH_CAPTURE_URL="$URL" GH_CAPTURE_TOKEN="$TOKEN" GH_CAPTURE_SECRET="$SECRET" \
  bash "$here/scripts/verify-deployment.sh" --help >"$tmp/out" 2>&1
[ $? -eq 2 ] && ok "--help prints usage and refuses, never falls through to a request" \
             || bad "--help must exit 2 without acting"

# ---------------------------------------------------------------------------
echo
if [ "$fails" -ne 0 ]; then echo "$fails failing case(s)"; exit 1; fi
echo "all cases passed"
exit 0
