#!/usr/bin/env bash
# verify-deployment.sh — prove a DEPLOYED receiver actually does what the suite
# says it does, against the live URL.
#
# The offline suite proves the logic. It cannot prove that this deployment has
# the right secret, reached the right D1 database, or is even the code we think
# it is. Those are exactly the ways a deploy goes quietly wrong, and "done" includes "an unsigned payload is PROVEN rejected" — proven against the
# thing on the internet, not against an in-memory double.
#
# Run this once immediately after `npm run deploy` (README § 4), before
# registering the webhook. Re-run with --no-probe any time.
#
#   GH_CAPTURE_URL      base URL of the deployed Worker, no trailing slash
#   GH_CAPTURE_TOKEN    the QUERY_TOKEN secret
#   GH_CAPTURE_SECRET   the WEBHOOK_SECRET secret
#
# All three from the inherited environment, never argv — /proc/*/cmdline is
# world-readable by other processes on the host.
#
# Usage:
#   ./verify-deployment.sh              # full proof, INCLUDING one signed probe
#   ./verify-deployment.sh --no-probe   # refusal checks only, writes nothing
#
# THE PROBE WRITES A PERMANENT ROW. The store is append-only by trigger, so the
# probe delivery cannot be deleted afterwards — by design, since a store that
# can be tidied is not append-only. Probe rows are identifiable and easy to
# exclude:
#
#   ./query.sh events event=x_capture_probe
#
# Exit status is the gate: 0 = every check passed, 1 = a check failed,
# 2 = usage or environment error, or no checks ran at all. It is never "0 with
# a warning printed" — a validator that printed REFUSED and exited 0 has
# already shipped in this repo once.
#
# "No checks ran" is deliberately NOT exit 1. Exit 1 is a verdict about the
# deployment — do not register the webhook. A run that executed nothing carries
# no verdict about the deployment at all; it means this script is broken.

set -euo pipefail

die() { echo "verify-deployment: $*" >&2; exit 2; }

probe=1
case "${1:-}" in
  "") : ;;
  --no-probe) probe=0 ;;
  -h|--help|help)
    # Print usage and refuse. Never fall through to a request: the default for
    # an unrecognised input in this repo is refusal, not action.
    sed -n '2,39p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
  *) die "unknown argument: $1" ;;
esac
[ $# -le 1 ] || die "takes at most one argument"

[ -n "${GH_CAPTURE_URL:-}" ]    || die "GH_CAPTURE_URL is not set"
[ -n "${GH_CAPTURE_TOKEN:-}" ]  || die "GH_CAPTURE_TOKEN is not set"
[ -n "${GH_CAPTURE_SECRET:-}" ] || die "GH_CAPTURE_SECRET is not set"
command -v curl >/dev/null || die "curl is required"

# Same node resolution as check-subscription.sh, for the same reason: node is
# routinely installed outside a minimal PATH. This script is normally run by
# hand, where PATH is rich, but it is the gate in front of gate 4 and is worth
# nothing if a non-interactive caller cannot start it. NODE_BIN overrides.
NODE_BIN="${NODE_BIN:-}"
if [ -n "$NODE_BIN" ]; then
  [ -x "$NODE_BIN" ] || die "NODE_BIN is set but is not executable: $NODE_BIN"
else
  NODE_BIN="$(command -v node 2>/dev/null || true)"
  if [ -z "$NODE_BIN" ]; then
    for candidate in /usr/local/bin/node /usr/bin/node /opt/homebrew/bin/node /snap/bin/node; do
      if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
    done
  fi
fi
[ -n "$NODE_BIN" ] || die "node is required (used to compute the HMAC without putting the secret on argv); not on PATH and not in the usual install prefixes — set NODE_BIN=/path/to/node"

work="$(umask 077; mktemp -d)"; chmod 700 "$work"
trap 'rm -rf "$work"' EXIT INT TERM
umask 077

printf 'header = "Authorization: Bearer %s"\n' "$GH_CAPTURE_TOKEN" > "$work/curlrc"

pass=0; fail=0

# check <name> <expected-status> <actual-status> [extra-condition-description]
check() {
  local name="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then
    printf '  PASS  %-58s %s\n' "$name" "$got"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-58s expected %s, got %s\n' "$name" "$want" "$got" >&2
    fail=$((fail + 1))
  fi
}

# assert <name> <condition-exit-status> <detail>
assert() {
  local name="$1" ok="$2" detail="${3:-}"
  if [ "$ok" -eq 0 ]; then
    printf '  PASS  %-58s %s\n' "$name" "ok"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-58s %s\n' "$name" "$detail" >&2
    fail=$((fail + 1))
  fi
}

# post <body-file> <signature-or-empty> <event> <delivery-id> -> status, body in $work/out
post() {
  local body="$1" sig="$2" event="$3" id="$4"
  local args=(-sS --max-time 30 -o "$work/out" -w '%{http_code}'
              -X POST -H 'content-type: application/json'
              -H "X-GitHub-Event: $event" -H "X-GitHub-Delivery: $id"
              --data-binary "@$body")
  [ -n "$sig" ] && args+=(-H "X-Hub-Signature-256: $sig")
  curl "${args[@]}" "$GH_CAPTURE_URL/gh/webhook"
}

# get <path> [--anon] -> status, body in $work/out
get() {
  local path="$1" anon="${2:-}"
  if [ "$anon" = "--anon" ]; then
    curl -sS --max-time 30 -o "$work/out" -w '%{http_code}' "$GH_CAPTURE_URL$path"
  else
    curl -sS --max-time 30 --config "$work/curlrc" -o "$work/out" -w '%{http_code}' "$GH_CAPTURE_URL$path"
  fi
}

# Compute the HMAC in node, reading the secret from the ENVIRONMENT and the body
# from a FILE. Neither ever appears in a process argument list.
sign() {
  GH_CAPTURE_SECRET="$GH_CAPTURE_SECRET" BODY_FILE="$1" "$NODE_BIN" -e '
    const fs = require("fs"), crypto = require("crypto")
    const mac = crypto.createHmac("sha256", process.env.GH_CAPTURE_SECRET)
    mac.update(fs.readFileSync(process.env.BODY_FILE))
    process.stdout.write("sha256=" + mac.digest("hex"))
  '
}

echo "verify-deployment: $GH_CAPTURE_URL"
echo

# -- 1. the service is up and fully configured -------------------------------
echo "service"
status="$(get /health --anon)"
check "GET /health is 200" 200 "$status"
# Both secrets must be present. Either one missing means the Worker is failing
# closed on half its surface, which is a deploy that looks finished and is not.
grep -q '"webhook_secret_configured": true' "$work/out" && ok=0 || ok=1
assert "WEBHOOK_SECRET is set on the Worker" "$ok" "health says webhook_secret_configured is not true — 'wrangler secret put WEBHOOK_SECRET'"
grep -q '"query_token_configured": true' "$work/out" && ok=0 || ok=1
assert "QUERY_TOKEN is set on the Worker" "$ok" "health says query_token_configured is not true — 'wrangler secret put QUERY_TOKEN'"

# -- 2. forgeries are refused ------------------------------------------------
# The property the entire control rests on. The URL is public by construction.
echo
echo "refusal (the property the control rests on)"
printf '%s' '{"zen":"unsigned probe from verify-deployment.sh"}' > "$work/forge.json"

status="$(post "$work/forge.json" "" x_capture_probe "probe-unsigned-$$")"
check "an UNSIGNED delivery is refused" 401 "$status"

status="$(post "$work/forge.json" "sha256=not-hex" x_capture_probe "probe-malformed-$$")"
check "a MALFORMED signature is refused" 401 "$status"

badsig="$(GH_CAPTURE_SECRET="wrong-secret-$$" BODY_FILE="$work/forge.json" "$NODE_BIN" -e '
  const fs = require("fs"), crypto = require("crypto")
  const mac = crypto.createHmac("sha256", process.env.GH_CAPTURE_SECRET)
  mac.update(fs.readFileSync(process.env.BODY_FILE))
  process.stdout.write("sha256=" + mac.digest("hex"))
')"
status="$(post "$work/forge.json" "$badsig" x_capture_probe "probe-wrongsecret-$$")"
check "a delivery signed with the WRONG secret is refused" 401 "$status"

# A correctly signed body whose bytes then changed. This is the check that
# would catch a receiver verifying a re-serialised body instead of raw bytes.
goodsig="$(sign "$work/forge.json")"
printf '%s' '{"zen":"unsigned probe from verify-deployment.sh "}' > "$work/tampered.json"
status="$(post "$work/tampered.json" "$goodsig" x_capture_probe "probe-tampered-$$")"
check "a TAMPERED body fails its original signature" 401 "$status"

# -- 3. the read API is closed without a token -------------------------------
echo
echo "read api"
status="$(get /events --anon)"
check "GET /events without a token is refused" 401 "$status"
status="$(get /stats --anon)"
check "GET /stats without a token is refused" 401 "$status"
status="$(get '/events?repositry=typo')"
check "an unknown filter is a 400, not a silently widened query" 400 "$status"
status="$(get /admin --anon)"
check "an unknown path is a 404" 404 "$status"

# -- 4. the write path actually stores ---------------------------------------
if [ "$probe" -eq 1 ]; then
  echo
  echo "storage (writes one permanent row — see the header)"
  # No `date +%s` in the id alone: two runs in the same second would collide on
  # the primary key and the second would read as a false duplicate.
  probe_id="capture-probe-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  printf '{"zen":"deployment probe","probe_id":"%s"}' "$probe_id" > "$work/probe.json"
  sig="$(sign "$work/probe.json")"

  status="$(post "$work/probe.json" "$sig" x_capture_probe "$probe_id")"
  check "a correctly SIGNED delivery is accepted" 200 "$status"
  grep -q '"stored": true' "$work/out" && ok=0 || ok=1
  assert "it reached the database" "$ok" "the Worker answered 200 but did not store — check the D1 binding and database_id"

  # GitHub retries anything it did not see a 2xx for, reusing the delivery id.
  status="$(post "$work/probe.json" "$sig" x_capture_probe "$probe_id")"
  check "a REPLAY is de-duplicated and still answered 200" 200 "$status"
  grep -q '"duplicate": true' "$work/out" && ok=0 || ok=1
  assert "the replay created no second row" "$ok" "the retry was not recognised as a duplicate — dedupe is broken and GitHub retries"

  status="$(get "/events?delivery_id=$probe_id")"
  check "the probe is readable back through the query API" 200 "$status"
  grep -q "$probe_id" "$work/out" && ok=0 || ok=1
  assert "the stored row is the one that was sent" "$ok" "the delivery id did not come back from GET /events"
else
  echo
  echo "storage — SKIPPED (--no-probe). Refusal is proven; storing is not."
fi

# -- 5. the rejections above were counted ------------------------------------
echo
echo "rejection counters"
status="$(get /stats)"
check "GET /stats with a token is 200" 200 "$status"
# Rejection counting is coalesced in the isolate (see src/rejection-counter.js),
# and GET /stats settles the buffer first, so the counters must have moved by
# the time this response is built.
grep -q 'signature_missing' "$work/out" && ok=0 || ok=1
assert "the forged deliveries above were counted" "$ok" "no signature_missing counter — rejections are not reaching the store"

# ---------------------------------------------------------------------------
echo
echo "  $pass passed, $fail failed"
# A run where NOTHING executed satisfies `fail -eq 0` and would exit 0 — the
# gate would read "ready for gate 4" on the strength of zero evidence. That is
# the same shape as the validator this repo already shipped once that printed
# REFUSED and exited 0, so it gets an explicit floor rather than trust that the
# checks above always run.
if [ "$pass" -eq 0 ] && [ "$fail" -eq 0 ]; then
  echo
  echo "  No checks executed. Exit 0 here would mean 'verified' on no evidence." >&2
  echo "  This is a bug in the verifier, not a verdict on the deployment." >&2
  exit 2
fi
if [ "$fail" -ne 0 ]; then
  echo
  echo "  This deployment is NOT ready for gate 4. Do not register the webhook:" >&2
  echo "  a receiver that fails any check above will lose or mis-handle real" >&2
  echo "  deliveries, and GitHub keeps only 3 days of history to replay from." >&2
  exit 1
fi

echo
echo "  Ready for gate 4 (README § 5). Two things this does NOT prove:"
echo "   - that the App is subscribed — nothing is, until gate 4. Use check-subscription.sh."
echo "   - that the store is tamper-evident. It is not; see README § 1."
exit 0
