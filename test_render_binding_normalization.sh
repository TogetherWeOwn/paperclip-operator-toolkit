#!/usr/bin/env bash
# ===========================================================================
# test_render_binding_normalization.sh — the carrier/render binding tolerates
#            an Image= edit and NOTHING ELSE
#
# WHY THIS EXISTS. test_paperclip_immutable_runtime.sh binds carrier bytes to
# a host-produced render. Pinning the board-approved digest (step 3 of the
# activation sequence) edits `Image=` and would re-stale a render that could
# not possibly have differed — costing a SECOND scarce human host window for
# nothing. So the binding compares a NORMALIZED hash, with `^Image=` lines
# collapsed, and accepts a raw mismatch only when that normalized hash holds.
#
# A relaxation of a fail-closed check is exactly where a fail-open gets in.
# So this suite mutates in BOTH directions against a real fixture render:
#
#   - an Image= edit alone           -> ACCEPTED  (the window is not spent twice)
#   - any other edit                 -> STALE     (the binding still bites)
#   - an Image= edit PLUS another    -> STALE     (not a laundering route)
#   - a failed generator             -> STILL caught through the relaxed path
#
# The last is the one an early `continue` would have broken: skipping the hash
# error would also have skipped the exitCode check underneath it.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITE="$HERE/test_paperclip_immutable_runtime.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# Extract just the python binding check from the suite, so this tests the REAL
# comparison logic rather than a copy that can drift away from it.
PYCHECK="$(mktemp)"
awk '/^mapfile -t generated_values/,/^PY$/' "$SUITE" \
  | sed -e '1,/<<.PY.$/d' -e '/^PY$/d' > "$PYCHECK"
if ! grep -q 'serverCarrierNormalizedSha256' "$PYCHECK"; then
  printf 'FAIL: could not extract the binding check from %s\n' "$SUITE"
  exit 1
fi

norm() { sed 's|^Image=.*|Image=<SUBSTITUTED>|' "$1" | sha256sum | cut -d' ' -f1; }
raw()  { sha256sum "$1" | cut -d' ' -f1; }

# Build a fixture: two carriers plus a render that binds them, as
# the host render helper would have written it.
make_case() {
  local d; d="$(mktemp -d)"
  cp "$HERE/deploy/paperclip-immutable/paperclip.container" "$d/server"
  cp "$HERE/deploy/paperclip-immutable/agent-run.container.in" "$d/run"
  local exit_code="${1:-0}"
  jq -n --arg ssha "$(raw "$d/server")" --arg rsha "$(raw "$d/run")" \
        --arg snorm "$(norm "$d/server")" --arg rnorm "$(norm "$d/run")" \
        --argjson rc "$exit_code" \
  '{candidate:{commit:"C",tree:"T",parent:"P",
      serverCarrierSha256:$ssha, runCarrierSha256:$rsha,
      serverCarrierNormalizedSha256:$snorm, runCarrierNormalizedSha256:$rnorm},
    server:{exitCode:$rc, execStart:"SERVER_EXEC"},
    run:{exitCode:0, execStart:"RUN_EXEC"}}' > "$d/render.json"
  printf '%s' "$d"
}

check() {  # -> prints rc; stdout+stderr in $1/out
  local d="$1"
  python3 "$PYCHECK" "$d/render.json" "$d/server" "$d/run" C T P >"$d/out" 2>&1
  printf '%s' $?
}

printf '1. the unmutated fixture binds\n'
d="$(make_case)"; rc="$(check "$d")"
[ "$rc" = 0 ] && ok 'an untouched carrier pair passes' || bad 'an untouched carrier pair passes' "$(cat "$d/out")"
rm -rf "$d"

printf '\n2. an Image= edit alone is ACCEPTED — the window is not spent twice\n'
d="$(make_case)"
sed -i 's|^Image=.*|Image=paperclip-local@sha256:aaaabbbbccccddddeeeeffff00001111222233334444555566667777888899990|' "$d/server"
[ "$(raw "$d/server")" != "$(jq -r .candidate.serverCarrierSha256 "$d/render.json")" ] \
  && ok 'the fixture really did change the raw hash' || bad 'the fixture really did change the raw hash'
rc="$(check "$d")"
[ "$rc" = 0 ] && ok 'pinning the approved digest does NOT re-stale the render' \
  || bad 'pinning the approved digest does NOT re-stale the render' "$(cat "$d/out")"
rm -rf "$d"

printf '\n3. any other edit is still STALE — the binding still bites\n'
d="$(make_case)"
sed -i 's|^Network=omniroute.network|# Network=omniroute.network|' "$d/server"
rc="$(check "$d")"
if [ "$rc" != 0 ] && grep -q 'STALE' "$d/out"; then
  ok 'dropping a Network= leg is STALE'
else bad 'dropping a Network= leg is STALE' "rc=$rc: $(cat "$d/out")"; fi
rm -rf "$d"

d="$(make_case)"
sed -i 's|^ReadOnly=true|ReadOnly=false|' "$d/server"
rc="$(check "$d")"
[ "$rc" != 0 ] && grep -q 'STALE' "$d/out" && ok 'flipping ReadOnly is STALE' \
  || bad 'flipping ReadOnly is STALE' "rc=$rc: $(cat "$d/out")"
rm -rf "$d"

d="$(make_case)"
sed -i 's|^Network=none|Network=host|' "$d/run"
rc="$(check "$d")"
[ "$rc" != 0 ] && grep -q 'STALE' "$d/out" && ok 'editing the RUN carrier is STALE' \
  || bad 'editing the RUN carrier is STALE' "rc=$rc: $(cat "$d/out")"
rm -rf "$d"

printf '\n4. an Image= edit is not a laundering route for a second edit\n'
# The attack the relaxation invites: bundle a real change with an Image= change
# and hope the normalized comparison waves both through.
d="$(make_case)"
sed -i -e 's|^Image=.*|Image=paperclip-local@sha256:1111|' \
       -e 's|^DropCapability=all|DropCapability=none|' "$d/server"
rc="$(check "$d")"
[ "$rc" != 0 ] && grep -q 'STALE' "$d/out" && ok 'Image= plus a capability edit is STALE' \
  || bad 'Image= plus a capability edit is STALE' "rc=$rc: $(cat "$d/out")"
rm -rf "$d"

printf '\n5. the relaxed path still enforces the generator exit code\n'
# An early `continue` on the normalized match would have skipped the exitCode
# check underneath, accepting a render whose generator FAILED.
d="$(make_case 1)"
sed -i 's|^Image=.*|Image=paperclip-local@sha256:2222|' "$d/server"
rc="$(check "$d")"
if [ "$rc" != 0 ] && grep -q 'not successful' "$d/out"; then
  ok 'a failed generator is caught even when the Image= relaxation applies'
else bad 'a failed generator is caught even when the Image= relaxation applies' "rc=$rc: $(cat "$d/out")"; fi
rm -rf "$d"

printf '\n6. control on the control — neuter the relaxation, the STALE cases go green\n'
# Forcing image_line_only=True is what the relaxation looks like when it stops
# discriminating. Every case in section 3 must then be wrongly ACCEPTED. If
# they are not, this suite is not actually exercising the relaxation.
#
# The first version of this control deleted the equality CLAUSE instead, and it
# found a real fail-open: the guard was two clauses joined by `and`, so
# removing the comparison left `norm_expected is not None` — true for every
# fresh render, accepting ANY carrier edit. The guard is now one expression.
staged="$(mktemp)"
sed 's|^\( *\)image_line_only = .*|\1image_line_only = True|' "$PYCHECK" > "$staged"
# Compare CONTENT, not line count: this mutation rewrites a line in place, so
# the counts are equal either way and a length check would report "matched
# nothing" on a mutation that worked perfectly.
if cmp -s "$staged" "$PYCHECK"; then
  bad 'the mutation pattern matched something' 'pattern matched nothing — this control tests nothing'
else
  d="$(make_case)"
  sed -i 's|^Network=omniroute.network|# Network=omniroute.network|' "$d/server"
  python3 "$staged" "$d/render.json" "$d/server" "$d/run" C T P >"$d/out" 2>&1
  rc=$?
  [ "$rc" = 0 ] \
    && ok 'neutering the relaxation wrongly accepts a dropped leg (so section 3 is real)' \
    || bad 'neutering the relaxation wrongly accepts a dropped leg' \
           "still refused (rc=$rc) — section 3 may be passing for another reason"
  rm -rf "$d"
fi
rm -f "$staged" "$PYCHECK"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
