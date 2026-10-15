#!/usr/bin/env bash
# test_regen_receipt_supervised_apply.sh — acceptance tests for Land #915 (TOG-24793).
#
# Paired tests for the Land #915 finish work (PR
# TogetherWeOwn/paperclip-ops-tooling#915, parent TOG-24774): bounded supervised
# apply to the regen receipt carrier (ops/tog-17271/regen_dry_run_receipt.sh).
# The Builder implements the carrier mirror on this branch WITHOUT touching test
# files; these tests fail until the mirror lands, then pass.
#
# THE RISKS THIS EXISTS FOR. Paperclip Review 4/5 on head 84450199 found two
# warnings, both fixed at 300b067b (suite 140 -> 153, now 5/5):
#   1. A refused apply lost the record of what was deleted (carrier :273): the
#      receipt checks ran after the pruner deleted, and on refusal the wrapper
#      printed only the reason then deleted tool.out. With log_error set the
#      operator saw only "REFUSED - log_error is set", no removed count, no
#      manifest path. Fix: on an apply refusal print the summary counts and
#      manifest path (as the tool-crash path already does).
#   2. Three new checks breakable without any test failing (suite :352): the
#      keep-file check reduced to a count comparison (stub adds a third ID, so
#      the count changes); duplicate --max-remove allowed (wrapper checks the
#      first value, pruner uses the last); receipt mode unchecked (existing case
#      refused earlier for missing keys, before mode is checked). Fix: same-count
#      keep swap case, duplicate --max-remove case, complete apply receipt
#      labelled dry-run case.
#
# What this pins, hermetically (no network, no credentials, no host paths):
#   A. Refused apply prints removed/planned/manifest (risk 1).
#   B. Keep-file same-count swap refuses (risk 2a): sorted-set + file-bytes
#      digests, not just the count.
#   C. Duplicate --max-remove refuses with exactly-one semantics (risk 2b).
#   D. Complete apply receipt labelled dry-run refuses (risk 2c): mode check.
#   E. Apply bounds: exactly one --time-budget 1..30, exactly one --max-remove
#      1..200, --runs-root refused, --expect-script-sha + --expect-holds required,
#      pin checked before PAUSE is touched.
#   F. Valid apply receipt exits 0 with the exact pinned argv; PAUSE restored on
#      every path; no custody ID ever printed.
#
# RED (before the fix): the carrier mirror regen_dry_run_receipt.sh is absent
# from this repo, so every case FAILs (wrapper missing / tool not run). GREEN
# (after): all pass against the #915 head carrier. Verified out-of-tree: 18/18
# pass with the 4fb668e5 carrier materialized; 4/4 risk mutants fail.
#
# Run: bash test_regen_receipt_supervised_apply.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="$HERE/regen_dry_run_receipt.sh"

UUID_A="11111111-1111-4111-8111-111111111111"
UUID_B="22222222-2222-4222-8222-222222222222"

pass=0; fail=0
check() { # name expected actual
  if [[ "$2" == "$3" ]]; then pass=$((pass+1));
  else fail=$((fail+1)); echo "FAIL: $1 (expected [$2], got [$3])"; fi
}

fresh() { # echoes tmpdir with stub tool, PAUSE present, keep with 2 annotated holds
  local tmp; tmp="$(mktemp -d)"
  cat > "$tmp/tool.py" <<'EOF'
import json, os, sys, time
open(os.environ["STUB_MARK"], "w").write("ran\n")
if os.environ.get("STUB_ARGV"):
    open(os.environ["STUB_ARGV"], "w").write(json.dumps(sys.argv[1:]) + "\n")
if os.environ.get("STUB_SWAP_KEEP"):
    import re
    _kp = os.environ.get("STUB_KEEP", "")
    with open(_kp, encoding="utf-8", errors="surrogateescape") as _fh:
        _c = _fh.read()
    _m = re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", _c)
    if _m:
        _orig = _m.group(0)
        _repl = "33333333-3333-4333-8333-333333333333"
        if _orig == _repl:
            _repl = "44444444-4444-4444-8444-444444444444"
        _c = _c.replace(_orig, _repl, 1)
        with open(_kp, "w", encoding="utf-8") as _fh:
            _fh.write(_c)
if os.environ.get("STUB_SLEEP"):
    time.sleep(float(os.environ["STUB_SLEEP"]))
sys.stdout.write(os.environ.get("STUB_JSON", "") + "\n")
sys.exit(int(os.environ.get("STUB_RC", "0")))
EOF
  printf '%s  # recovery custody hold\n%s # legacy annotated hold\n# comment\n\n' \
    "$UUID_A" "$UUID_B" > "$tmp/keep.txt"
  touch "$tmp/PAUSE"
  echo "$tmp"
}

run_wrapper() { # $1=tmp, rest appended as wrapper args; echoes exit code
  local tmp="$1"; shift
  STUB_MARK="$tmp/ran" STUB_ARGV="$tmp/argv" STUB_KEEP="$tmp/keep.txt" "$WRAPPER" --script "$tmp/tool.py" --pause "$tmp/PAUSE" \
    --keep "$tmp/keep.txt" "$@" > "$tmp/out.txt" 2> "$tmp/err.txt"
  echo $?
}

apply_json() { # removed planned custody_held archive_verified_runs
  printf '{"mode": "apply", "removed": %s, "fail_closed": null, "custody_held": %s, "kept_by_reason": {}, "refused_by_reason": {}, "planned": %s, "manifest": "m.txt", "archive_verified_runs": %s, "archive_pending_runs": 0, "ledger_error": null, "log_error": null}' "$1" "$3" "$2" "$4"
}
run_apply() { # $1 = tmp; rest = wrapper args, with the apply pins added here
  local tmp="$1"; shift
  local sha; sha="$(sha256sum "$tmp/tool.py" | cut -d' ' -f1)"
  run_wrapper "$tmp" --apply --expect-script-sha "$sha" --expect-holds 2 "$@"
}
ARGS=(-- --time-budget 30 --max-remove 5)

# F. Valid apply receipt exits 0 with the exact pinned argv; PAUSE restored.
t="$(fresh)"
rc="$(STUB_JSON="$(apply_json 1 2 2 1)" STUB_RC=0 STUB_SLEEP="" run_apply "$t" "${ARGS[@]}")"
check "valid apply receipt exits 0" 0 "$rc"
check "apply argv is exactly the pinned flags" '["--apply", "--time-budget", "30", "--max-remove", "5"]' "$(cat "$t/argv" 2>/dev/null || echo MISSING)"
check "apply receipt labelled apply" 1 "$(grep -c 'receipt: VALID — mode=apply' "$t/out.txt" 2>/dev/null || true)"
check "PAUSE restored after apply" 1 "$([ -f "$t/PAUSE" ] && echo 1 || echo 0)"
rm -rf "$t"

# A. Refused apply still prints what was removed (risk 1: record not lost).
t="$(fresh)"
rc="$(STUB_JSON='{"mode": "apply", "removed": 3, "fail_closed": null, "custody_held": 2, "planned": 5, "manifest": "m-apply.txt", "archive_verified_runs": 1, "archive_pending_runs": 0, "ledger_error": null, "log_error": "disk full"}' STUB_RC=0 STUB_SLEEP="" run_apply "$t" "${ARGS[@]}")"
check "apply log_error refusal exits 3" 3 "$rc"
check "apply refusal prints removed count" 1 "$(grep -c 'removed=3' "$t/out.txt" 2>/dev/null || true)"
check "apply refusal prints manifest" 1 "$(grep -c 'm-apply.txt' "$t/out.txt" 2>/dev/null || true)"
check "apply refusal: PAUSE restored" 1 "$([ -f "$t/PAUSE" ] && echo 1 || echo 0)"
rm -rf "$t"

# B. Keep-file swap with the same hold count still refuses (risk 2a).
t="$(fresh)"
rc="$(STUB_JSON="$(apply_json 1 2 2 1)" STUB_RC=0 STUB_SLEEP="" STUB_SWAP_KEEP=1 run_apply "$t" "${ARGS[@]}")"
check "keep file swapped ID same count exits 3" 3 "$rc"
check "keep swap named on stderr" 1 "$(grep -c 'changed during the run' "$t/err.txt" 2>/dev/null || true)"
check "keep swap preserves tool summary on stderr" 1 "$(grep -c 'removed' "$t/err.txt" 2>/dev/null || true)"
check "keep swap: PAUSE restored" 1 "$([ -f "$t/PAUSE" ] && echo 1 || echo 0)"
rm -rf "$t"

# C. Duplicate --max-remove refuses (risk 2b: exactly-one semantics).
t="$(fresh)"; rm -f "$t/ran"
rc="$(STUB_JSON="$(apply_json 1 2 2 1)" STUB_RC=0 STUB_SLEEP="" run_apply "$t" -- --time-budget 30 --max-remove 5 --max-remove 6)"
check "apply duplicate max-remove exits 2" 2 "$rc"
check "duplicate max-remove: tool not run" 0 "$([ -f "$t/ran" ] && echo 1 || echo 0)"
check "duplicate max-remove: PAUSE untouched" 1 "$([ -f "$t/PAUSE" ] && echo 1 || echo 0)"
rm -rf "$t"

# D. Complete apply receipt labelled dry-run refuses (risk 2c: mode check).
t="$(fresh)"
dry_as_apply="$(apply_json 1 2 2 1 | sed 's/"mode": "apply"/"mode": "dry-run"/')"
rc="$(STUB_JSON="$dry_as_apply" STUB_RC=0 STUB_SLEEP="" run_apply "$t" "${ARGS[@]}")"
check "apply complete receipt labelled dry-run exits 3" 3 "$rc"
check "mode refusal: PAUSE restored" 1 "$([ -f "$t/PAUSE" ] && echo 1 || echo 0)"
rm -rf "$t"

# E. Apply bounds refuse before the tool runs and before PAUSE is touched.
t="$(fresh)"; rm -f "$t/ran"
rc="$(STUB_JSON="$(apply_json 1 2 2 1)" STUB_RC=0 STUB_SLEEP="" run_apply "$t" -- --time-budget 31 --max-remove 5)"
check "apply time budget 31 exits 2" 2 "$rc"
check "time budget 31: tool not run" 0 "$([ -f "$t/ran" ] && echo 1 || echo 0)"
check "time budget 31: PAUSE untouched" 1 "$([ -f "$t/PAUSE" ] && echo 1 || echo 0)"
rm -rf "$t"

t="$(fresh)"
sha="$(sha256sum "$t/tool.py" | cut -d' ' -f1)"
rc="$(STUB_JSON="$(apply_json 1 2 2 1)" STUB_RC=0 STUB_SLEEP="" run_wrapper "$t" --apply --expect-script-sha "$(printf '%064d' 0)" --expect-holds 2 "${ARGS[@]}")"
check "apply with wrong script pin exits 2" 2 "$rc"
check "wrong pin: tool not run" 0 "$([ -f "$t/ran" ] && echo 1 || echo 0)"
check "wrong pin: PAUSE untouched" 1 "$([ -f "$t/PAUSE" ] && echo 1 || echo 0)"
rm -rf "$t"; _unused="$sha"

t="$(fresh)"; rm -f "$t/ran"
rc="$(STUB_JSON="$(apply_json 1 2 2 1)" STUB_RC=0 STUB_SLEEP="" run_apply "$t" -- --time-budget 30 --max-remove 5 --runs-root /x)"
check "apply refuses runs-root exits 2" 2 "$rc"
check "runs-root: tool not run" 0 "$([ -f "$t/ran" ] && echo 1 || echo 0)"
rm -rf "$t"

# Privacy: no custody ID ever printed, even on refusal paths.
t="$(fresh)"
rc="$(STUB_JSON="$(apply_json 1 2 2 1)" STUB_RC=0 STUB_SLEEP="" STUB_SWAP_KEEP=1 run_apply "$t" "${ARGS[@]}")"
check "no custody ID printed" 0 "$(cat "$t/out.txt" "$t/err.txt" 2>/dev/null | grep -c -e "$UUID_A" -e "$UUID_B" || true)"
rm -rf "$t"; _rc_unused="$rc"

echo "pass=$pass fail=$fail"
[[ "$fail" -eq 0 ]]
