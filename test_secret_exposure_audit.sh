#!/usr/bin/env bash
# Regression suite for secret_exposure_audit.sh  (TOG-392).
#
# Runs fully offline. It never reads the real master key, the real DATABASE_URL,
# or any live secret: every case launches the audit under a FABRICATED
# environment (`env -i` plus fakes) and a throwaway master-key file in a temp
# dir. That is the seam -- the audit reads the process env and one file path, so
# controlling both under env -i controls the whole input without omitting it.
# (Omitting the env entirely would test a different, easier program; see the
# standing lesson on faking the credential env rather than dropping it.)
#
# The two failures this suite is built to catch, both in the fail-open
# direction -- the direction that would wrongly authorise closing TOG-392:
#
#   * a set-but-EMPTY projection counting as "present", which would report a
#     contained environment as still exposed (false alarm) OR, worse in the
#     mirror case, let a real channel that happens to be empty read as gone.
#   * a secret VALUE leaking into the report. The whole point of the audit is to
#     enumerate exposure without adding to it; a test that only checks exit
#     codes would pass against a script that printed the master key. So one case
#     feeds sentinel values and asserts they never appear in stdout.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIT="$HERE/secret_exposure_audit.sh"
PASS=0; FAIL=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [[ ! -x "$AUDIT" ]]; then
  echo "ERROR: $AUDIT not found or not executable" >&2
  exit 2
fi

ok()   { PASS=$((PASS+1)); printf 'ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$1"; [[ -n "${2:-}" ]] && printf '     %s\n' "$2"; }

# run_audit <expected_exit> <label> -- extra args after label are env KEY=VAL
# assignments handed to the audit under a clean env. Captures stdout in $OUT.
OUT=""
run_audit() {
  local expected="$1" label="$2"; shift 2
  local -a assigns=("$@")
  # env -i wipes everything; we restore only PATH (for wc/stat/tr) and add fakes.
  OUT="$(env -i PATH="$PATH" "${assigns[@]}" bash "$AUDIT" 2>&1)"
  local rc=$?
  if [[ "$rc" == "$expected" ]]; then ok "$label (exit $rc)"; else
    bad "$label" "expected exit $expected, got $rc"; fi
}

# A fabricated master-key file: real bytes, throwaway value, so the file-readable
# check has something to find without touching the platform key.
FAKE_KEY="$WORK/master.key"
printf 'FAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKE' > "$FAKE_KEY"   # 32 bytes, non-secret
SENTINEL="SENTINEL_SECRET_VALUE_SHOULD_NEVER_APPEAR"

# --- Case 1: fully exposed environment -> exit 1, verdict EXPOSED -----------
run_audit 1 "all high channels present -> EXPOSED" \
  PAPERCLIP_SECRETS_MASTER_KEY_FILE="$FAKE_KEY" \
  DATABASE_URL="postgres://fake" \
  BETTER_AUTH_SECRET="fake" \
  PAPERCLIP_TOOL_ACTION_SIGNING_SECRET="fake" \
  GH_APP_PRIVATE_KEY="fake"
grep -q "VERDICT: EXPOSED" <<<"$OUT" && ok "case1 says EXPOSED" || bad "case1 verdict" "$OUT"

# --- Case 2: fully contained -> exit 0, verdict CONTAINED -------------------
# No env fakes, and the master-key path points at a file that does not exist.
run_audit 0 "no channels present -> CONTAINED" \
  PAPERCLIP_SECRETS_MASTER_KEY_FILE="$WORK/does-not-exist"
grep -q "VERDICT: CONTAINED" <<<"$OUT" && ok "case2 says CONTAINED" || bad "case2 verdict" "$OUT"

# --- Case 3: set-but-empty must NOT count as present ------------------------
# The classic fail-open: an empty projection is not a usable credential. If this
# counts as present the audit can never reach CONTAINED and the containment
# signal TOG-392 depends on is dead.
run_audit 0 "set-but-empty high channels -> CONTAINED" \
  PAPERCLIP_SECRETS_MASTER_KEY_FILE="$WORK/does-not-exist" \
  DATABASE_URL="" \
  BETTER_AUTH_SECRET="" \
  PAPERCLIP_TOOL_ACTION_SIGNING_SECRET="" \
  GH_APP_PRIVATE_KEY=""

# --- Case 4: exactly one high channel present still flips the exit ----------
# A single held key is a finding; the exit must not require all of them.
run_audit 1 "one high channel present -> EXPOSED" \
  PAPERCLIP_SECRETS_MASTER_KEY_FILE="$WORK/does-not-exist" \
  BETTER_AUTH_SECRET="fake"

# --- Case 5: a med-only channel does NOT flip the exit ----------------------
run_audit 0 "med channel only -> CONTAINED" \
  PAPERCLIP_SECRETS_MASTER_KEY_FILE="$WORK/does-not-exist" \
  ANTHROPIC_API_KEY="fake" \
  POSTGRES_PASSWORD="fake"

# --- Case 6: NEVER prints a secret value ------------------------------------
# Feed sentinels through both an env channel and the master-key file contents,
# then assert neither sentinel appears anywhere in the report.
printf '%s' "$SENTINEL" > "$WORK/sentinel.key"
run_audit 1 "sentinel run (for leak check)" \
  PAPERCLIP_SECRETS_MASTER_KEY_FILE="$WORK/sentinel.key" \
  DATABASE_URL="$SENTINEL" \
  BETTER_AUTH_SECRET="$SENTINEL"
if grep -q "$SENTINEL" <<<"$OUT"; then
  bad "no secret value in output" "sentinel leaked into report"
else
  ok "no secret value in output (text)"
fi
# and in JSON form
OUT="$(env -i PATH="$PATH" \
  PAPERCLIP_SECRETS_MASTER_KEY_FILE="$WORK/sentinel.key" \
  DATABASE_URL="$SENTINEL" BETTER_AUTH_SECRET="$SENTINEL" \
  bash "$AUDIT" --format json 2>&1)"
grep -q "$SENTINEL" <<<"$OUT" && bad "no secret value in output (json)" "sentinel leaked" \
  || ok "no secret value in output (json)"

# --- Case 7: --quiet emits nothing but still sets the exit code -------------
OUT="$(env -i PATH="$PATH" DATABASE_URL="postgres://fake" \
  PAPERCLIP_SECRETS_MASTER_KEY_FILE="$WORK/does-not-exist" \
  bash "$AUDIT" --quiet 2>&1)"; rc=$?
if [[ "$rc" == "1" && -z "$OUT" ]]; then ok "--quiet: no output, exit 1"; else
  bad "--quiet" "rc=$rc out='$OUT'"; fi

# --- Case 8: bad --format is a usage error (exit 2), not a false CONTAINED --
env -i PATH="$PATH" bash "$AUDIT" --format yaml >/dev/null 2>&1; rc=$?
[[ "$rc" == "2" ]] && ok "bad --format -> exit 2" || bad "bad --format" "expected 2 got $rc"

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
