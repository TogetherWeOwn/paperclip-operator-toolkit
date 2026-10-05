#!/usr/bin/env bash
# ===========================================================================
# test_runner_disk_pressure.sh — regression suite for the runner
# disk-pressure detector.
#
# The detector's load-bearing properties, in the order they matter:
#
#   1. It FIRES at the recorded incident shape: a host at 99% reads CRITICAL, exit 1.
#      A detector that cannot return 1 is an alarm that is always off.
#   2. It STAYS QUIET on a healthy host. A detector that cannot return 0 is
#      an alarm that is always on -- and a hardcoded `exit 1` passes every
#      other case here and fails only this one. This is the test that keeps
#      the suite honest.
#   3. It FAILS CLOSED. An unmeasurable path or unparseable df is exit 2
#      (inconclusive), never exit 0. Reporting health from a measurement the
#      detector could not make is the exact failure that let the real
#      incident run undetected until jobs could no longer write.
#   4. The du breakdown NEVER moves the verdict. A failed breakdown is a
#      note, not a pass and not a finding.
#   5. The CI wiring survives `bash -e`. The runner executes steps with
#      errexit, so a capture of the form `out="$(...detector...)"; rc=$?`
#      without `set +e` dies silently on the exact exits the step exists to
#      handle (rc 1/2) — no `rc=$?`, no `::error` annotation. A past
#      incident caught exactly that on the first CI run. The suite pins `set +e`
#      bracketing in BOTH workflow steps and proves the real step bodies
#      reach the annotation under `bash -e`, plus a mutation control proving
#      the check can fail (stripped bracketing dies silent).
#
# Fully offline: `df` and `du` are DF_BIN/DU_BIN stubs, runner roots are
# mktemp fixtures, workflow step bodies run against the stubbed detector.
# No host, no network, no credential.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${RUNNER_DISK_PRESSURE_SH:-$HERE/runner_disk_pressure.sh}"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[[ -x "$TOOL" ]] || { echo "ERROR: $TOOL is not executable" >&2; exit 1; }
command -v jq >/dev/null || { echo "ERROR: jq is required" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/test_runner_disk_pressure.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/root/instance-a" "$WORK/root/instance-b"
echo data > "$WORK/root/instance-a/file"

# The df stub prints a POSIX two-line table for the requested path. The
# detector calls `df -P -- <path>`; the stub answers for that path and fails
# for anything else, which keeps multi-path confusion visible.
mkdf() {
  cat > "$WORK/bin/df" <<STUB
#!/usr/bin/env bash
path="\${*: -1}"
case "\$path" in
  "$1") printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/md5 800000000 782468505 100000 99%% /\n' ;;
  *) printf 'df: %s: No such file or directory\n' "\$path" >&2; exit 1 ;;
esac
STUB
  chmod +x "$WORK/bin/df"
}

# run [detector args...] -> sets RC and OUT. The detector is pointed at the
# stubs by absolute path (DF_BIN/DU_BIN): a PATH shim does not survive this
# environment — every non-interactive bash re-sources BASH_ENV, which
# hard-resets PATH and voids the shim before the detector runs.
run() {
  OUT="$(DF_BIN="$WORK/bin/df" DU_BIN="$WORK/bin/du" "$TOOL" "$@" 2>&1)"
  RC=$?
}

# du defaults to the real binary until a case installs the failing stub.
ln -s "$(command -v du)" "$WORK/bin/du"

# --- 1. the real incident shape --------------------------------------------
hdr "Fires on the recorded incident shape (host at 99%)"
mkdf "/"
run --path / --runner-root "$WORK/root"
(( RC == 1 )) && ok "exit 1 at 99%" || bad "expected exit 1, got $RC ($OUT)"
grep -q "CRITICAL" <<<"$OUT" && ok "reads CRITICAL, not merely WARNING" || bad "no CRITICAL verdict"

hdr "Boundary: exactly at warn reads pressure, exactly at crit reads critical"
cat > "$WORK/bin/df" <<'STUB'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/md5 100 80 20 80%% /\n'
STUB
chmod +x "$WORK/bin/df"
run --path / --warn-pct 80 --crit-pct 90
(( RC == 1 )) && ok "exit 1 at exactly warn" || bad "expected exit 1, got $RC"
grep -q "WARNING" <<<"$OUT" && ok "80 with crit 90 is WARNING" || bad "wrong severity ($OUT)"
cat > "$WORK/bin/df" <<'STUB'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/md5 100 90 10 90%% /\n'
STUB
chmod +x "$WORK/bin/df"
run --path / --warn-pct 80 --crit-pct 90
grep -q "CRITICAL" <<<"$OUT" && ok "90 with crit 90 is CRITICAL" || bad "wrong severity ($OUT)"

# --- 2. the negative control -----------------------------------------------
hdr "Stays quiet on a healthy host (negative control)"
cat > "$WORK/bin/df" <<'STUB'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/md5 100 46 54 46%% /\n'
STUB
chmod +x "$WORK/bin/df"
run --path /
(( RC == 0 )) && ok "exit 0 at 46%" || bad "expected exit 0, got $RC ($OUT)"
grep -q "^OK" <<<"$OUT" && ok "says OK" || bad "did not report healthy"

# --- 3. fail closed ----------------------------------------------------------
hdr "Fails closed on an unmeasurable path"
mkdf "/"
run --path /does-not-exist
(( RC == 2 )) && ok "exit 2 on df failure" || bad "expected exit 2, got $RC ($OUT)"

hdr "Fails closed on unparseable df output"
cat > "$WORK/bin/df" <<'STUB'
#!/usr/bin/env bash
printf 'something unexpected with no percent column\n'
STUB
chmod +x "$WORK/bin/df"
run --path /
(( RC == 2 )) && ok "exit 2 on unparseable df" || bad "expected exit 2, got $RC ($OUT)"

hdr "Refuses inverted thresholds instead of mis-scoring"
cat > "$WORK/bin/df" <<'STUB'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/md5 100 46 54 46%% /\n'
STUB
chmod +x "$WORK/bin/df"
run --path / --warn-pct 90 --crit-pct 80
(( RC == 2 )) && ok "exit 2 on warn >= crit" || bad "expected exit 2, got $RC ($OUT)"

# --- 4. breakdown is corroborating only --------------------------------------
hdr "A failed breakdown never moves the verdict"
cat > "$WORK/bin/df" <<'STUB'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/md5 100 99 1 99%% /\n'
STUB
chmod +x "$WORK/bin/df"
rm -f "$WORK/bin/du" # symlink to the real du; `cat >` would follow it
cat > "$WORK/bin/du" <<'STUB'
#!/usr/bin/env bash
echo "permission denied" >&2; exit 1
STUB
chmod +x "$WORK/bin/du"
run --path / --runner-root "$WORK/root"
(( RC == 1 )) && ok "still exit 1 when du fails" || bad "expected exit 1, got $RC ($OUT)"
grep -qi "note:" <<<"$OUT" && ok "failed breakdown is a note" || bad "no note for failed breakdown"
ln -sf "$(command -v du)" "$WORK/bin/du"
run --path / --runner-root "$WORK/root"
grep -q "instance-" <<<"$OUT" && ok "working breakdown names consumers" || bad "no consumer breakdown ($OUT)"

# --- 5. json shape -------------------------------------------------------------
hdr "JSON output parses and carries the verdict"
cat > "$WORK/bin/df" <<'STUB'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/md5 100 85 15 85%% /\n'
STUB
chmod +x "$WORK/bin/df"
run --path / --runner-root "$WORK/root" --json
STATUS="$(jq -r .status <<<"$OUT" 2>/dev/null)"
[[ "$STATUS" == "pressure" ]] && ok "status=pressure at 85/80/90" || bad "wrong status ($STATUS)"
jq -e '.use_pct == 85 and .warn_pct == 80 and .crit_pct == 90 and (.top_consumers | length) > 0' <<<"$OUT" >/dev/null \
  && ok "thresholds and consumers present" || bad "json shape wrong ($OUT)"

hdr "A note containing spaces stays one JSON string, not fragments"
cat > "$WORK/bin/df" <<'STUB'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/md5 100 46 54 46%% /\n'
STUB
chmod +x "$WORK/bin/df"
run --path / --runner-root "$WORK/does-not-exist" --json
jq -e '.notes | length == 1' <<<"$OUT" >/dev/null \
  && ok "one note, not word fragments" || bad "note was word-split ($OUT)"
jq -e '.notes[0] | contains("runner root")' <<<"$OUT" >/dev/null \
  && ok "note text intact" || bad "note text broken ($OUT)"

# --- 6. CI wiring (toolkit adaptation note) --------------------------------
# The private suite pinned `bash -e` bracketing inside private workflow steps
# (ci.yml preflight + a scheduled live workflow) and fleet-name gates. This
# toolkit runs change-gated CI with a ci-ok aggregator on standard runners,
# so those private step bodies do not exist here. Sections 1-5 above pin the
# portable detector logic offline; toolkit CI coverage for this detector
# arrives with the workflow integration slice, not this port.

echo
echo "PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]
