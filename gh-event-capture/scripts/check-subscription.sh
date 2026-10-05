#!/usr/bin/env bash
# check-subscription.sh — is the App still subscribed, and still pointed at us?
#
# WHAT THIS IS FOR, AND WHAT IT IS NOT
#
# README § 1 states the limit that matters: an actor holding
# `organization_administration` — the scope every agent token carries today —
# can unsubscribe the events or repoint the webhook URL, and GitHub records
# nothing when they do. The event store would simply go quiet, and a quiet
# store is indistinguishable from a quiet week.
#
# This script is the partial answer. It reads `GET /app` for the live `events`
# list and `GET /app/hook/config` for the live webhook `url`, and compares both
# against the expected-subscription file (`$EXPECTED_SUBSCRIPTION`). Drift is a non-zero exit.
#
# `installation` and `installation_repositories` are implicit — GitHub delivers
# them to every App and never lists them in `GET /app`'s `events`, nor shows a
# checkbox for them in the App settings UI. Proof: delivery
# `54f22710-b4a7-11f1-9a81-76729154bdd6` (`installation`/`new_permissions_accepted`
# 03:57:01Z 2026-09-20) arrived while `events` was
# `[member, membership, organization, push, repository]`. They are filtered from
# the comparison so the check does not report DRIFT forever on a live, healthy
# App. `hook_attributes.url` is only in the app-manifest creation response;
# the live URL is `GET /app/hook/config` → `.url`.
#
# It does NOT close the gap:
#   * It detects; it does not prevent. Anyone who can unsubscribe can also stop
#     this cron, and stopping it is not recorded either.
#   * It answers "is the capture configured", never "was the capture complete".
#   * It runs on a schedule on the capture host. Between two runs, events can
#     be switched off and switched back on, and neither this nor GitHub will
#     show it.
#
# Run it from cron on the capture host. Exit status is the gate:
#   0  live and matching
#   1  DRIFT — the subscription is not what it should be
#   2  PENDING — not registered yet (expected before the webhook is registered)
#   3  usage/environment error
#
# Credentials come from the inherited environment, never argv: /proc/*/cmdline
# is world-readable by other processes on the host.
#
#   GH_APP_ID           the numeric App id (no default)
#   GH_APP_PRIVATE_KEY  PEM, in the environment
#   GH_API_URL          optional; defaults to https://api.github.com.
#                       This is the seam the test suite stubs — removing it
#                       makes this script untestable without a live credential.
#   NODE_BIN            optional; an explicit path to node. Only needed if node
#                       is somewhere unusual — cron's PATH is handled without
#                       it. Set this rather than editing the cron PATH.

set -euo pipefail

GH_API_URL="${GH_API_URL:-https://api.github.com}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
expected_file="${EXPECTED_SUBSCRIPTION:-$here/expected-subscription.json}"

die() { echo "check-subscription: $*" >&2; exit 3; }

[ -n "${GH_APP_ID:-}" ] || die "GH_APP_ID is not set"
[ -n "${GH_APP_PRIVATE_KEY:-}" ] || die "GH_APP_PRIVATE_KEY is not set"
[ -r "$expected_file" ] || die "cannot read $expected_file"
command -v openssl >/dev/null || die "openssl is required"

# Resolve node by path, not by PATH lookup alone. This script's whole value is
# that it runs unattended from cron (README § 5 step 4), and cron runs with
# PATH=/usr/bin:/bin while node is commonly installed to /usr/local/bin — where
# it is on some hosts. `command -v node` therefore finds nothing under cron and
# the check would exit 3 every hour: a dead control that an operator who only
# ever ran it by hand would read as configured. Measured both arms, identical
# environment, PATH the only difference: interactive exit 2 (PENDING, working),
# PATH=/usr/bin:/bin exit 3 "node is required".
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
[ -n "$NODE_BIN" ] || die "node is required (not on PATH and not in the usual install prefixes; set NODE_BIN=/path/to/node)"

# Everything transient lands here and is removed on every exit path, including
# the private key copy the JWT signing needs and the curl config file that
# carries the Authorization header.
work="$(mktemp -d)"
chmod 700 "$work"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT INT TERM

umask 077
printf '%s' "$GH_APP_PRIVATE_KEY" > "$work/key.pem"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

now="$(date +%s)"
header="$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)"
# 9-minute expiry; GitHub refuses anything over 10.
payload="$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$((now - 60))" "$((now + 540))" "$GH_APP_ID" | b64url)"
signature="$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "$work/key.pem" | b64url)"

# The JWT goes in a curl --config file, never on argv. Same reason and same
# pattern as omniroute_combo_cli.sh; copy that rather than inventing another.
printf 'header = "Authorization: Bearer %s.%s.%s"\nheader = "Accept: application/vnd.github+json"\nheader = "X-GitHub-Api-Version: 2022-11-28"\n' \
  "$header" "$payload" "$signature" > "$work/curlrc"

http_status="$(curl -sS --max-time 30 -o "$work/app.json" -w '%{http_code}' \
  --config "$work/curlrc" "$GH_API_URL/app" || true)"

if [ "$http_status" != "200" ]; then
  echo "check-subscription: GET /app returned HTTP $http_status" >&2
  exit 3
fi

http_status_hook="$(curl -sS --max-time 30 -o "$work/hook.json" -w '%{http_code}' \
  --config "$work/curlrc" "$GH_API_URL/app/hook/config" || true)"

# Comparison in node rather than jq: jq is not installed on every box this has
# to run on, and node already is (gh-app-token.js depends on it). Invoked
# through $NODE_BIN so a cron PATH cannot silently kill this check.
NODE_APP="$work/app.json" NODE_HOOK="$work/hook.json" NODE_HOOK_STATUS="$http_status_hook" NODE_EXPECTED="$expected_file" "$NODE_BIN" -e '
const fs = require("fs")
const live = JSON.parse(fs.readFileSync(process.env.NODE_APP, "utf8"))
const expected = JSON.parse(fs.readFileSync(process.env.NODE_EXPECTED, "utf8"))
let hook = {}
try { hook = JSON.parse(fs.readFileSync(process.env.NODE_HOOK, "utf8")) } catch (_) { hook = {} }

const IMPLICIT = new Set(["installation", "installation_repositories"])
const liveEvents = [...(live.events || [])].filter((e) => !IMPLICIT.has(e)).sort()
const wantEvents = [...(expected.events || [])].filter((e) => !IMPLICIT.has(e)).sort()
const liveUrl = (hook && typeof hook.url === "string" ? hook.url : null)
const wantUrl = expected.hook_url || ""

if (wantUrl === "") {
  // Before gate 4. Report it as pending rather than as drift, so the day the
  // owner registers the hook the exit status changes for a real reason.
  console.log("PENDING  no hook_url in expected-subscription.json — the webhook has not been registered yet")
  console.log("         live events:", JSON.stringify(liveEvents))
  console.log("         live url   :", JSON.stringify(liveUrl))
  process.exit(2)
}

if (process.env.NODE_HOOK_STATUS !== "200") {
  console.error("DRIFT  the App webhook config is not reachable (GET /app/hook/config returned HTTP " + process.env.NODE_HOOK_STATUS + ")")
  console.error(`  hook url is ${JSON.stringify(liveUrl)}, expected ${JSON.stringify(wantUrl)}`)
  process.exit(1)
}

const missing = wantEvents.filter((e) => !liveEvents.includes(e))
const extra = liveEvents.filter((e) => !wantEvents.includes(e))
const urlDrift = liveUrl !== wantUrl

if (missing.length === 0 && extra.length === 0 && !urlDrift) {
  console.log(`OK  ${liveEvents.length} events subscribed, url ${liveUrl}`)
  process.exit(0)
}

console.error("DRIFT  the App subscription is not what it should be")
if (missing.length) console.error("  events NO LONGER subscribed:", JSON.stringify(missing))
if (extra.length)   console.error("  events subscribed but NOT expected:", JSON.stringify(extra))
if (urlDrift)       console.error(`  hook url is ${JSON.stringify(liveUrl)}, expected ${JSON.stringify(wantUrl)}`)
console.error("")
console.error("  A missing event means deliveries of that type stopped, and the store went")
console.error("  quiet WITHOUT that being recorded anywhere. Treat the gap as uninformative:")
console.error("  it is not evidence that nothing happened. See README section 1.")
process.exit(1)
'
