#!/usr/bin/env bash
# ===========================================================================
# test_discord_job_health.sh — offline suite for scripts/discord_job_health.js
# (TOG-676).
#
# No database, no network, no credentials. Every case is a synthetic source
# document fed through DISCORD_JOB_HEALTH_SOURCE_CMD, so CI can run this.
#
# WHAT THIS SUITE IS BUILT TO CATCH:
#
#  * THE BUG THE OLD DETECTOR HAD. Section 2 feeds the exact state the
#    forbidden workaround produces: every company configured, so ZERO
#    denials, and still no digest sent. The previous script scored that
#    "UNPROVEN" and exited 0 — green — which would have certified the one
#    remedy that is a cross-company data leak. This suite pins exit 1 and the
#    verdict NOT_DELIVERED. A detector rewritten to infer health from the
#    failure count fails here.
#
#  * A DEFECT REPORTED AS A PASS. Section 1 pins the live production shape:
#    a scope-denied digest run must be FAILING and exit 1.
#
#  * DELIVERY ACTUALLY COUNTING. Section 3 is byte-identical to section 2
#    except one `discord_digest_sent` row exists. It must be healthy and exit
#    0. Without this case, a script hardcoded to always say NOT_DELIVERED
#    would pass section 2 and the suite would be measuring nothing.
#
#  * ZERO-OF-ZERO IS NOT GREEN. Section 4 gives a window too short to contain
#    the 17:00 send. Zero sends out of zero opportunities is "never ran", not
#    "works": exit 5, UNKNOWN.
#
#  * A NULL ERROR IS NOT A SUCCESS. Section 5 feeds a `failed` run with no
#    error text. The old classify() returned "ok" for a falsy error, so such a
#    row was counted as a success. It must score as a failure.
#
#  * OFF IS NOT HEALTHY. Section 6: digest mode off must not read as green
#    delivery, and must not read as a defect either.
#
#  * A REFUSAL FROM THE WRONG BRANCH. Exit codes alone would let any refusal
#    read as the intended one, so every assertion pins the VERDICT text too.
#
#  * THE SEAM ITSELF. Section 7 asserts a source command that emits garbage
#    refuses (5) rather than crashing or passing.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/scripts/discord_job_health.js"
PASS=0; FAIL=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

[ -f "$TOOL" ] || { echo "FATAL: $TOOL not found"; exit 2; }

# ---------------------------------------------------------------------------
# src <file> <mode> <digest-run-json> <delivered> [extra-companies]
#
# Builds a source document. `companies` always contains our own company;
# `configuredCompanyIds` is what varies between the denial case and the
# "workaround applied" case.
# ---------------------------------------------------------------------------
OURS="00000000-0000-0000-0000-000000000001"
OTHER="8f967443-0000-0000-0000-000000000002"

# run <file> [args...] -> sets OUT and CODE
run() {
  local f=$1; shift
  # Run the tool via `bash -c` so $? is the TOOL's status. The harness shell
  # misreports pipeline status, and a detector suite that reads the wrong
  # exit code is exactly the failure this repo keeps re-learning.
  OUT="$(DISCORD_JOB_HEALTH_SOURCE_CMD="cat $f" bash -c \
        'node "$0" "$@" 2>&1' "$TOOL" "$@")"
  CODE=$?
}

expect() { # expect <label> <want-code> <want-substring>
  local label=$1 wantc=$2 wants=$3
  if [ "$CODE" != "$wantc" ]; then
    bad "$label" "exit $CODE, wanted $wantc. Output: $(printf '%s' "$OUT" | tail -4 | tr '\n' ' ')"
  elif ! printf '%s' "$OUT" | grep -qF "$wants"; then
    bad "$label" "missing '$wants'. Output: $(printf '%s' "$OUT" | tail -4 | tr '\n' ' ')"
  else
    ok "$label"
  fi
}

echo "== 1. production shape: scope-denied digest is FAILING =="
cat >"$WORK/denied.json" <<EOF
{"plugin":{"key":"paperclip-plugin-discord","id":"p1","version":"0.11.0","status":"ready"},
 "companies":[{"id":"$OURS","name":"TogetherWeOwn"},{"id":"$OTHER","name":"Octavo Foundry"}],
 "configuredCompanyIds":["$OURS"],
 "digest":{"mode":"daily","dailyDigestTime":"17:00"},
 "jobs":[{"jobKey":"discord-daily-digest","schedule":"0 * * * *","status":"active",
   "runs":[{"status":"failed","error":"is not allowed to perform \"state.get\": company context is required","startedAt":"2026-08-29T17:00:22Z"},
           {"status":"succeeded","error":null,"startedAt":"2026-08-29T16:00:06Z"}]}],
 "deliveries":{"discord_digest_sent":0},
 "now":"2026-08-30T05:00:00Z","windowHours":48}
EOF
run "$WORK/denied.json"
expect "scope-denied digest -> FAILING, exit 1" 1 "FAILING"
run "$WORK/denied.json"
expect "unauthorized company is named" 1 "Octavo Foundry"

echo "== 2. THE REGRESSION: no denials, still nothing sent =="
# This is the state that adding plugin_config rows for the other companies
# produces. Zero failures. The old detector exited 0 here.
cat >"$WORK/silent.json" <<EOF
{"plugin":{"key":"paperclip-plugin-discord","id":"p1","version":"0.11.0","status":"ready"},
 "companies":[{"id":"$OURS","name":"TogetherWeOwn"},{"id":"$OTHER","name":"Octavo Foundry"}],
 "configuredCompanyIds":["$OURS","$OTHER"],
 "digest":{"mode":"daily","dailyDigestTime":"17:00"},
 "jobs":[{"jobKey":"discord-daily-digest","schedule":"0 * * * *","status":"active",
   "runs":[{"status":"succeeded","error":null,"startedAt":"2026-08-29T17:00:22Z"},
           {"status":"succeeded","error":null,"startedAt":"2026-08-29T16:00:06Z"}]}],
 "deliveries":{"discord_digest_sent":0},
 "now":"2026-08-30T05:00:00Z","windowHours":48}
EOF
run "$WORK/silent.json"
expect "clean runs + zero sends -> NOT_DELIVERED" 1 "NOT_DELIVERED"
run "$WORK/silent.json"
expect "and it does NOT read healthy" 1 "0 x discord_digest_sent"

echo "== 3. a real delivery is green (proves section 2 measures something) =="
sed 's/"discord_digest_sent":0/"discord_digest_sent":1/' "$WORK/silent.json" >"$WORK/sent.json"
run "$WORK/sent.json"
expect "one send metric -> healthy, exit 0" 0 "healthy"

echo "== 4. zero-of-zero refuses rather than passing =="
# Window ends 05:00 and is 4h long, so no 17:00 boundary is inside it.
sed 's/"windowHours":48/"windowHours":4/' "$WORK/silent.json" >"$WORK/short.json"
run "$WORK/short.json" --window-hours 4
expect "no send opportunity -> exit 5 UNKNOWN" 5 "UNKNOWN"

echo "== 5. a failed run with no error text is not a success =="
cat >"$WORK/nullerr.json" <<EOF
{"plugin":{"key":"paperclip-plugin-discord","id":"p1","version":"0.11.0","status":"ready"},
 "companies":[{"id":"$OURS","name":"TogetherWeOwn"}],
 "configuredCompanyIds":["$OURS"],
 "digest":{"mode":"daily","dailyDigestTime":"17:00"},
 "jobs":[{"jobKey":"check-watches","schedule":"*/15 * * * *","status":"active",
   "runs":[{"status":"failed","error":null,"startedAt":"2026-08-29T17:00:22Z"}]}],
 "deliveries":{"discord_digest_sent":0},
 "now":"2026-08-30T05:00:00Z","windowHours":48}
EOF
run "$WORK/nullerr.json"
expect "failed+null error -> FAILING, exit 1" 1 "FAILING"
run "$WORK/nullerr.json"
expect "counted as a failure, not a success" 1 "0 succeeded"

echo "== 6. digest off is neither healthy nor a defect =="
sed 's/"mode":"daily"/"mode":"off"/' "$WORK/silent.json" >"$WORK/off.json"
run "$WORK/off.json"
expect "mode off -> DISABLED, exit 0" 0 "DISABLED"

echo "== 7. a broken source refuses =="
printf 'not json at all\n' >"$WORK/garbage.json"
run "$WORK/garbage.json"
expect "garbage source -> exit 5" 5 "UNKNOWN"

echo ""
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
