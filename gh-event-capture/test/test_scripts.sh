#!/usr/bin/env bash
# Offline suite for the two shell tools.
#
# `check-subscription.sh` signs with the App private key, so CONTRIBUTING § "What
# done means" item 6 applies: if it can only be tested against real GitHub, it
# will stop being tested. It is tested here against a stub API on 127.0.0.1,
# with a throwaway RSA key generated per run, under `env -i` so a live
# GH_APP_PRIVATE_KEY exported in the operator's shell cannot leak into a run.
#
# Assertions pin EXIT STATUS, never printed prose. No test count is asserted
# anywhere — counts drift as suites grow and a gate that pins one turns
# ordinary growth into a red build.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"; [ -n "${stub_pid:-}" ] && kill "$stub_pid" 2>/dev/null' EXIT INT TERM

fails=0
ok()   { echo "PASS  $*"; }
bad()  { echo "FAIL  $*"; fails=$((fails + 1)); }

# expect <wanted-exit> <label> -- <command...>
expect() {
  local want="$1" label="$2"; shift 3
  "$@" > "$tmp/out" 2>&1
  local got=$?
  if [ "$got" -eq "$want" ]; then ok "$label (exit $got)"
  else bad "$label — wanted exit $want, got $got"; sed 's/^/      /' "$tmp/out"; fi
}

# --- a throwaway key, never a real one -------------------------------------
openssl genrsa -out "$tmp/key.pem" 2048 2>/dev/null
KEY="$(cat "$tmp/key.pem")"

# --- stub GitHub on 127.0.0.1 ----------------------------------------------
# Serves whatever `$tmp/app.json` and `$tmp/hook.json` currently hold, so a case
# can reshape the App's reported subscription without restarting anything.
cat > "$tmp/stub.js" <<'JS'
const http = require('http')
const fs = require('fs')
const server = http.createServer((req, res) => {
  if (req.url === '/app') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(fs.readFileSync(process.env.APP_JSON, 'utf8'))
  }
  if (req.url === '/app/hook/config') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(fs.readFileSync(process.env.HOOK_JSON, 'utf8'))
  }
  if (req.url.startsWith('/complete/')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end('{"claims":[]}')
  }
  if (req.url.startsWith('/partial/')) {
    // A valid JSON prefix cannot make a truncated HTTP transfer successful.
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100', connection: 'close' })
    return res.end('{"claims":[]}')
  }
  res.writeHead(404); return res.end('{}')
})
server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.env.PORT_FILE, String(server.address().port)))
JS
APP_JSON="$tmp/app.json" HOOK_JSON="$tmp/hook.json" PORT_FILE="$tmp/port" node "$tmp/stub.js" &
stub_pid=$!
for _ in $(seq 1 50); do [ -s "$tmp/port" ] && break; sleep 0.1; done
[ -s "$tmp/port" ] || { echo "FAIL  stub API never came up"; exit 1; }
API="http://127.0.0.1:$(cat "$tmp/port")"

run_check() {
  # env -i: a live GH_APP_PRIVATE_KEY in the operator's shell must not reach a
  # test run. Everything the script needs is passed explicitly.
  env -i PATH="$PATH" HOME="$tmp" \
    GH_APP_ID=1234567 GH_APP_PRIVATE_KEY="$KEY" GH_API_URL="$API" \
    EXPECTED_SUBSCRIPTION="$tmp/expected.json" \
    bash "$here/scripts/check-subscription.sh"
}

expected_with() { printf '{"events":%s,"hook_url":%s}\n' "$1" "$2" > "$tmp/expected.json"; }
app_with()      { printf '{"events":%s}\n' "$1" > "$tmp/app.json"; }
hook_with()     { printf '{"url":%s}\n' "$1" > "$tmp/hook.json"; }

FULL='["installation","installation_repositories","member","membership","organization","push","repository"]'
URL='"https://gh-event-capture.example.workers.dev/gh/webhook"'

echo "--- check-subscription.sh ---"

# Today's real state: nothing registered, and the baseline has no url yet.
expected_with "$FULL" '""'
app_with '[]'
hook_with 'null'
expect 2 "no hook_url in the baseline reports PENDING, not OK and not drift" -- run_check

# Live and matching.
expected_with "$FULL" "$URL"
app_with "$FULL"
hook_with "$URL"
expect 0 "a matching subscription exits 0" -- run_check

# Order must not matter; the sets are what is being compared.
app_with '["repository","push","organization","membership","member","installation_repositories","installation"]'
hook_with "$URL"
expect 0 "event order does not affect the comparison" -- run_check

# `installation` and `installation_repositories` are implicit — GitHub delivers
# them to every App and never lists them in GET /app events. Absence there is
# not drift.
app_with '["member","membership","organization","push","repository"]'
hook_with "$URL"
expect 0 "implicit events absent from GET /app is still OK" -- run_check

# The case this exists for: someone with organization_administration quietly
# unsubscribes an event. Use a non-implicit event so the filter does not hide it.
app_with '["installation","installation_repositories","membership","organization","push","repository"]'
hook_with "$URL"
expect 1 "a removed non-implicit event is DRIFT" -- run_check

# The other silencing: repoint the URL and the store simply goes quiet.
app_with "$FULL"
hook_with '"https://somewhere-else.example.com/collect"'
expect 1 "a repointed hook url is DRIFT" -- run_check

app_with "$FULL"
hook_with 'null'
expect 1 "a removed hook url is DRIFT" -- run_check

# Widening is drift too. An event nobody agreed to subscribe is a change to the
# control's scope, and it should be noticed and then blessed in the baseline —
# not absorbed silently because "more data cannot hurt".
app_with '["installation","installation_repositories","member","membership","organization","push","repository","secret_scanning_alert"]'
hook_with "$URL"
expect 1 "an UNEXPECTED extra event is also drift" -- run_check

# The check's whole value is that it runs from cron, and cron's PATH is
# /usr/bin:/bin while node is routinely installed to /usr/local/bin. Every other
# case here passes PATH="$PATH" — the operator's rich interactive PATH — so none
# of them can see a cron-PATH failure, which is exactly how one shipped: the
# script exited 3 "node is required" every hour while a by-hand run exited 2 and
# looked healthy.
#
# This arm is identical to run_check except for PATH. openssl, curl, bash and
# the rest of the script's dependencies all live in /usr/bin; node is the only
# one that does not, so a failure here is attributable to node resolution and
# nothing else. If this ever goes red with "node is required", the cron check is
# dead and the drift control is not running.
app_with "$FULL"
hook_with "$URL"
expected_with "$FULL" "$URL"
run_check_cron_path() {
  env -i PATH=/usr/bin:/bin HOME="$tmp" \
    GH_APP_ID=1234567 GH_APP_PRIVATE_KEY="$KEY" GH_API_URL="$API" \
    EXPECTED_SUBSCRIPTION="$tmp/expected.json" \
    bash "$here/scripts/check-subscription.sh"
}
expect 0 "a matching subscription still exits 0 under cron's PATH (node off PATH)" -- run_check_cron_path

# An explicit NODE_BIN is the documented escape hatch for a node in an unusual
# place, so it has to actually be honoured — and a bad one must refuse loudly
# rather than fall back to a working node and hide the operator's typo.
run_check_node_bin() {
  env -i PATH=/usr/bin:/bin HOME="$tmp" NODE_BIN="$1" \
    GH_APP_ID=1234567 GH_APP_PRIVATE_KEY="$KEY" GH_API_URL="$API" \
    EXPECTED_SUBSCRIPTION="$tmp/expected.json" \
    bash "$here/scripts/check-subscription.sh"
}
expect 0 "an explicit NODE_BIN is honoured" -- run_check_node_bin "$(command -v node)"
expect 3 "a NODE_BIN that is not executable is refused, not silently replaced" -- \
  run_check_node_bin "$tmp/no-such-node"

# Default is refusal: no credential means stop, never proceed unauthenticated.
app_with "$FULL"
hook_with "$URL"
expect 3 "a missing GH_APP_ID is refused" -- env -i PATH="$PATH" HOME="$tmp" \
  GH_APP_PRIVATE_KEY="$KEY" GH_API_URL="$API" EXPECTED_SUBSCRIPTION="$tmp/expected.json" \
  bash "$here/scripts/check-subscription.sh"
expect 3 "a missing GH_APP_PRIVATE_KEY is refused" -- env -i PATH="$PATH" HOME="$tmp" \
  GH_APP_ID=1234567 GH_API_URL="$API" EXPECTED_SUBSCRIPTION="$tmp/expected.json" \
  bash "$here/scripts/check-subscription.sh"

# No key material may reach stdout or stderr on any path.
run_check > "$tmp/leak" 2>&1
if grep -qE 'BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY' "$tmp/leak"; then
  bad "private key material reached the script's output"
else
  ok "no private key material in output"
fi

echo "--- query.sh ---"

run_query() {
  env -i PATH="$PATH" HOME="$tmp" \
    GH_CAPTURE_URL="${1:-}" GH_CAPTURE_TOKEN="${2:-}" \
    bash "$here/scripts/query.sh" "${@:3}"
}

expect 2 "no URL configured is refused" -- run_query "" "tok" stats
expect 2 "no token configured is refused" -- run_query "http://127.0.0.1:1" "" stats
expect 2 "an unknown subcommand is refused" -- run_query "http://127.0.0.1:1" "tok" wipe
expect 2 "--help prints usage and refuses rather than making a request" -- \
  run_query "http://127.0.0.1:1" "tok" --help
expect 2 "a filter that is not key=value is refused" -- \
  run_query "http://127.0.0.1:1" "tok" events notakeyvalue
expect 2 "bridged rejects a filter that is not key=value" -- \
  run_query "http://127.0.0.1:1" "tok" bridged notakeyvalue
expect 2 "bridged-daily accepts only issue_ref, not arbitrary filters" -- \
  run_query "http://127.0.0.1:1" "tok" bridged-daily limit=500

for cmd in stats bridged bridged-daily; do
  expect 0 "$cmd accepts a complete HTTP 200 response" -- run_query "$API/complete" tok "$cmd"
  expect 1 "$cmd refuses HTTP 200 with curl partial-transfer failure" -- run_query "$API/partial" tok "$cmd"
  if [ -s "$tmp/out" ] && grep -q 'query: transport failed' "$tmp/out"; then
    ok "$cmd explains the transport failure"
  else
    bad "$cmd did not report the transport failure"
  fi
done

echo "--- verify-deployment.sh ---"

# Chained from here rather than given its own CI step, and that is a workaround
# with a reason worth recording: the GitHub App token this repo's agents mint
# CANNOT git-push a change to `.github/workflows/`, and on 2026-08-24 the
# Contents API — which had accepted an identical workflow edit earlier the same
# day — began answering "Resource not accessible by integration" for it too.
# Adding a CI step is therefore not currently something an agent can do.
#
# The alternative was to ship the suite uncovered by CI and leave a note asking
# someone to wire it up later, which is how a suite starts rotting on day one.
# This entry point already runs in CI, so chaining keeps the coverage real.
# Output stays labelled, so a failure still reads as "the deployment verifier
# went red" rather than as one opaque failure.
#
# If the workflow write becomes possible again, give this its own step and
# delete this block.
if bash "$here/test/test_verify_deployment.sh"; then
  ok "deployment-verifier suite"
else
  bad "deployment-verifier suite — see its output above"
fi

echo
if [ "$fails" -eq 0 ]; then echo "all script checks passed"; exit 0; fi
echo "$fails check(s) FAILED"; exit 1
