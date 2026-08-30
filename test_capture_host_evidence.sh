#!/usr/bin/env bash
# ===========================================================================
# test_capture_host_evidence.sh — suite for capture_host_evidence.sh
#
# WHY THIS EXISTS. capture_host_evidence.sh shipped with NO test and was wired
# into NO CI job, while being the script a human runs, once, in a scarce host
# window, on the one procedure a `git revert` cannot undo. Its own commit
# message says it was "verified against stubs" — stubs that were never
# committed, so nothing re-verifies it after the next edit.
#
# HOW IT TESTS. There is no podman and no systemd here, so podman/systemctl are
# STUBBED on PATH. That is the same seam the script documents. Every refusal is
# asserted BY NAME, never by exit status: the script is fail-closed on nearly
# every input, so `rc == 2` passes for fixtures that never reach the check under
# test.
#
# Section 9 is the control on the controls: it deletes each check from a staging
# copy and asserts the test naming it goes RED. A check that stops doing
# anything cannot keep a green suite.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/capture_host_evidence.sh"
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# --- the stub host -------------------------------------------------------
# Builds a fake podman+systemctl on PATH. Every knob defaults to a HEALTHY
# two-leg host; each test perturbs exactly one.
make_host() {
  local d="$1"; shift
  local networks='{"systemd-paperclip":{},"systemd-omniroute":{}}'
  local units='paperclip-network.service enabled enabled
omniroute-network.service enabled enabled'
  local sys_units=''; local sys_units_set=0
  local img_digest='sha256:1111111111111111111111111111111111111111111111111111111111111111'
  local run_digest="$img_digest"
  local inspect_rc=0 img_rc=0
  # A failing systemctl is a THIRD state, distinct from both a populated and an
  # empty instance: exiting non-zero, or exiting 0 having written a diagnostic
  # where a table belongs. The stub could express neither, so the two refusals
  # that handle them had no way to be tested.
  local units_rc=0 units_stderr=''

  while [ $# -gt 0 ]; do
    case "$1" in
      --networks)   networks="$2"; shift 2 ;;
      --units)      units="$2"; shift 2 ;;
      --sys-units)  sys_units="$2"; sys_units_set=1; shift 2 ;;
      --units-rc)     units_rc="$2"; shift 2 ;;
      --units-stderr) units_stderr="$2"; shift 2 ;;
      --img-digest) img_digest="$2"; shift 2 ;;
      --run-digest) run_digest="$2"; shift 2 ;;
      --inspect-rc) inspect_rc="$2"; shift 2 ;;
      --img-rc)     img_rc="$2"; shift 2 ;;
      *) echo "make_host: bad arg $1" >&2; return 1 ;;
    esac
  done

  # Default: the system instance mirrors the user instance, so every existing
  # test keeps its original meaning regardless of which scope is queried.
  [ "$sys_units_set" -eq 1 ] || sys_units="$units"

  mkdir -p "$d/bin"
  cat >"$d/bin/podman" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "image" ] && [ "\$2" = "inspect" ]; then
  exit_code=$img_rc
  [ "\$exit_code" -ne 0 ] && exit "\$exit_code"
  printf '%s\n' '$img_digest'
  exit 0
fi
if [ "\$1" = "inspect" ]; then
  exit_code=$inspect_rc
  [ "\$exit_code" -ne 0 ] && exit "\$exit_code"
  case "\$*" in
    *ImageDigest*) printf '%s\n' '$run_digest' ;;
    *NetworkSettings.Networks*) printf '%s\n' '$networks' ;;
  esac
  exit 0
fi
exit 0
EOF
  # The stub answers PER INSTANCE. A root-owned host is the case where --user
  # reports nothing and --system holds the units; --sys-units defaults to the
  # same list so an instance-agnostic host behaves exactly as before.
  cat >"$d/bin/systemctl" <<EOF
#!/usr/bin/env bash
if [ -n "$units_stderr" ]; then
cat >&2 <<'ERRMSG'
$units_stderr
ERRMSG
fi
if [ "\$1" = "--system" ]; then
cat <<'UNITS'
$sys_units
UNITS
else
cat <<'UNITS'
$units
UNITS
fi
exit $units_rc
EOF
  chmod +x "$d/bin/podman" "$d/bin/systemctl"
}

# Run the script (or a staged copy) against a stub host. Captures stdout+stderr.
# Trailing args are passed through to the script under test.
run_capture() {
  local d="$1" script="${2:-$SCRIPT}"; shift 2 2>/dev/null || shift $#
  ( cd "$d" && PATH="$d/bin:$PATH" bash "$script" --out "$d/ev.json" "$@" ) >"$d/out" 2>&1
  printf '%s' $?
}

section() { printf '\n%s\n' "$1"; }

# =========================================================================
section "1. the healthy two-leg host"
# =========================================================================
D="$(mktemp -d)"; make_host "$D"
RC="$(run_capture "$D")"
if [ "$RC" = 0 ]; then ok "healthy host exits 0"; else bad "healthy host exits 0" "rc=$RC: $(cat "$D/out")"; fi

if [ -f "$D/ev.json" ]; then ok "evidence file written"; else bad "evidence file written" "no ev.json"; fi

got="$(jq -c '.networks' "$D/ev.json" 2>/dev/null)"
[ "$got" = '["systemd-omniroute","systemd-paperclip"]' ] \
  && ok ".networks[] holds podman's generated names" \
  || bad ".networks[] holds podman's generated names" "got $got"

got="$(jq -c '.networkUnits' "$D/ev.json" 2>/dev/null)"
[ "$got" = '["omniroute.network","paperclip.network"]' ] \
  && ok ".networkUnits[] holds the <stem>.network unit form" \
  || bad ".networkUnits[] holds the <stem>.network unit form" "got $got"

# The namespaces must not be conflated — that made the gate unsatisfiable at
# 208cdff3. Assert they are DIFFERENT, not merely both present.
if jq -e '[.networks[], .networkUnits[]] | any(startswith("systemd-")) and any(endswith(".network"))' \
     "$D/ev.json" >/dev/null 2>&1 \
   && ! jq -e '.networks | any(endswith(".network"))' "$D/ev.json" >/dev/null 2>&1 \
   && ! jq -e '.networkUnits | any(startswith("systemd-"))' "$D/ev.json" >/dev/null 2>&1; then
  ok "the two namespaces are kept apart"
else
  bad "the two namespaces are kept apart" "$(jq -c . "$D/ev.json")"
fi
rm -rf "$D"

# =========================================================================
section "2. the image digest is captured (the TOG-716 addition)"
# =========================================================================
D="$(mktemp -d)"; make_host "$D"
run_capture "$D" >/dev/null

got="$(jq -r '.image.candidate' "$D/ev.json" 2>/dev/null)"
[ "$got" = "1111111111111111111111111111111111111111111111111111111111111111" ] \
  && ok ".image.candidate is the bare 64-hex digest, sha256: stripped" \
  || bad ".image.candidate is the bare 64-hex digest" "got $got"

jq -e '.image.matchesRunning == true' "$D/ev.json" >/dev/null 2>&1 \
  && ok "matchesRunning true when candidate == running" \
  || bad "matchesRunning true when candidate == running" "$(jq -c '.image' "$D/ev.json")"
rm -rf "$D"

# The drift case is the whole reason .running is captured: the local tag was
# rebuilt since the service started, so pinning the candidate CHANGES the
# running image. Silence here would be the expensive failure.
D="$(mktemp -d)"
make_host "$D" --run-digest 'sha256:2222222222222222222222222222222222222222222222222222222222222222'
run_capture "$D" >/dev/null
jq -e '.image.matchesRunning == false' "$D/ev.json" >/dev/null 2>&1 \
  && ok "matchesRunning false under drift" \
  || bad "matchesRunning false under drift" "$(jq -c '.image' "$D/ev.json")"
grep -q 'DRIFT' "$D/out" \
  && ok "drift is REPORTED to the operator, not just recorded" \
  || bad "drift is REPORTED to the operator" "$(cat "$D/out")"
rm -rf "$D"

# An unreadable running digest must not silently read as "no drift".
D="$(mktemp -d)"; make_host "$D" --run-digest 'not-a-digest'
run_capture "$D" >/dev/null
jq -e '.image.running == null and .image.matchesRunning == false' "$D/ev.json" >/dev/null 2>&1 \
  && ok "unreadable running digest is null, never a false match" \
  || bad "unreadable running digest is null" "$(jq -c '.image' "$D/ev.json")"
grep -q 'UNREADABLE' "$D/out" \
  && ok "unreadable running digest is reported" \
  || bad "unreadable running digest is reported" "$(cat "$D/out")"
rm -rf "$D"

# =========================================================================
section "3. it refuses rather than writing evidence it could not measure"
# =========================================================================
# Each refusal asserted BY NAME. rc=2 alone proves nothing: the script is
# fail-closed on nearly every input.
refuses() { # <name> <label> <make_host args...>
  local want="$1" label="$2"; shift 2
  local d; d="$(mktemp -d)"
  make_host "$d" "$@"
  local rc; rc="$(run_capture "$d")"
  if [ "$rc" != 2 ]; then
    bad "$label" "expected rc=2, got $rc: $(cat "$d/out")"
  elif ! grep -q "REFUSED \[$want\]" "$d/out"; then
    bad "$label" "expected REFUSED [$want], got: $(cat "$d/out")"
  elif [ -f "$d/ev.json" ]; then
    bad "$label" "refused but still wrote ev.json"
  elif ls "$d"/ev.json.partial.* >/dev/null 2>&1; then
    bad "$label" "refused but left a .partial file behind"
  else
    ok "$label"
  fi
  rm -rf "$d"
}

refuses inspect_failed        "podman inspect failure refuses by name"        --inspect-rc 1
refuses no_network_legs       "zero network legs refuses"                     --networks '{}'
refuses no_network_units      "zero network units refuses (wrong instance?)"  --units ''
refuses image_inspect_failed  "podman image inspect failure refuses"          --img-rc 1
refuses image_digest_unresolvable "an empty image digest refuses"             --img-digest ''
refuses image_digest_unresolvable "a malformed image digest refuses"          --img-digest 'sha256:abc123'

# =========================================================================
section "3a. a FAILED unit query is not an absent unit"
# =========================================================================
# WHY. `systemctl --user` fails outright with no session bus, which is the
# normal state of a root shell on this host. Swallowed into `|| true`, that
# failure produced the same empty string a genuinely-empty instance produces,
# so the operator was told "no units — try --system"; on --system they were
# then told to re-run the flag they had just used. The window ends with no
# evidence and no correct next step, and the fault was never the units.
refuses unit_query_failed "a non-zero systemctl refuses as a QUERY failure, not an absence" \
  --units-rc 1 --units-stderr 'Failed to connect to bus: No medium found'

# The refusal must survive an EMPTY table too — otherwise "rc!=0 and empty"
# falls through to the absence branch, which is the exact conflation above.
refuses unit_query_failed "a non-zero systemctl with an empty table still refuses as a query failure" \
  --units '' --sys-units '' --units-rc 1 --units-stderr 'Failed to list unit files: Access denied'

# systemctl can exit 0 having printed a diagnostic where the table belongs.
# The mapping is a blind sed, so "Failed to list unit files: ..." becomes the
# unit `Failed`, is written to .networkUnits[], and the script exits 0. The
# gate then reads a unit the host does not have. Fabricated evidence is worse
# than none: no_network_units is a refusal, a fabricated unit is a false PASS.
refuses unit_row_unrecognised "a diagnostic printed where a unit row belongs refuses" \
  --units 'Failed to list unit files: Access denied'

# BASELINE: the distinct-refusal claim only means something if the ORIGINAL
# code reached a DIFFERENT verdict on these inputs. Assert the pre-fix shape
# actually mis-handled them, so a regression cannot pass by coincidence.
D="$(mktemp -d)"; make_host "$D" --units 'Failed to list unit files: Access denied'
# Reconstruct the pre-fix query+parse: `2>/dev/null || true`, no row check.
legacy_units="$(PATH="$D/bin:$PATH" systemctl --user list-unit-files '*-network.service' --no-legend --plain 2>/dev/null || true)"
legacy_json="$(printf '%s\n' "$legacy_units" | awk 'NF {print $1}' | sed 's/-network\.service$/.network/' | jq -R . | jq -sc 'map(select(length>0)) | sort')"
[ "$legacy_json" = '["Failed"]' ] \
  && ok "BASELINE: the pre-fix parse really did fabricate the unit \"Failed\"" \
  || bad "BASELINE: the pre-fix parse fabricated a unit" "got $legacy_json, expected [\"Failed\"]"
rm -rf "$D"

# A genuinely empty instance must STILL refuse as an absence, not as a query
# failure — the two refusals carry opposite next steps, and collapsing them
# either way strands the operator.
refuses no_network_units "a genuinely empty instance still refuses as an ABSENCE" \
  --units '' --sys-units ''

# And the healthy host must not be caught by either new refusal.
D="$(mktemp -d)"; make_host "$D"
RC="$(run_capture "$D")"
[ "$RC" = 0 ] && [ "$(jq -c '.networkUnits' "$D/ev.json" 2>/dev/null)" = '["omniroute.network","paperclip.network"]' ] \
  && ok "the healthy host is untouched by the query-failure refusals" \
  || bad "the healthy host is untouched by the query-failure refusals" "rc=$RC: $(cat "$D/out")"
rm -rf "$D"

# The empty-digest case is the one that matters most: an empty string recorded
# instead of refused becomes `Image=paperclip-local@sha256:` in the carrier,
# filled by a human from a field that read as successfully captured.
D="$(mktemp -d)"; make_host "$D" --img-digest ''
run_capture "$D" >/dev/null
[ ! -f "$D/ev.json" ] \
  && ok "an unresolvable digest writes NO evidence file at all" \
  || bad "an unresolvable digest writes no evidence" "wrote $(jq -c . "$D/ev.json")"
rm -rf "$D"

# =========================================================================
section "3b. --system reaches the root-owned instance, and says which it used"
# =========================================================================
# WHY. The document told the operator, twice, to "re-capture against --system"
# on a no_network_units refusal. There was no --system flag: the parser's *)
# arm exited 2 with `unknown argument`. That advice fires DURING the window,
# in the branch where the operator is already recovering from a refusal, so
# the window ended with no evidence and no instruction that worked.
#
# The root-owned host: --user reports nothing, --system holds the units.
ROOT_OWNED=(--units '' --sys-units 'paperclip-network.service enabled enabled
omniroute-network.service enabled enabled')

# The defect itself: --user on a root-owned host must still refuse ...
refuses no_network_units "root-owned host: --user still refuses" "${ROOT_OWNED[@]}"

# ... and the refusal must name a flag that EXISTS. A refusal advising a
# nonexistent flag is what shipped.
D="$(mktemp -d)"; make_host "$D" "${ROOT_OWNED[@]}"
run_capture "$D" >/dev/null
advice="$(grep -o '\-\-system' "$D/out" | head -1)"
if [ "$advice" = "--system" ]; then
  # and the advised flag must actually be accepted by the parser
  RC="$(run_capture "$D" "$SCRIPT" --system)"
  if [ "$RC" = 0 ]; then
    ok "the flag the refusal advises is accepted by the parser"
  else
    bad "the flag the refusal advises is accepted by the parser" \
        "advised --system, but running it gave rc=$RC: $(cat "$D/out")"
  fi
else
  bad "the refusal advises --system" "$(cat "$D/out")"
fi
rm -rf "$D"

# --system on the root-owned host completes the window: units captured AND
# the image digest recorded. Under the old script this branch yielded nothing.
D="$(mktemp -d)"; make_host "$D" "${ROOT_OWNED[@]}"
RC="$(run_capture "$D" "$SCRIPT" --system)"
if [ "$RC" = 0 ] && jq -e '(.networkUnits | length) == 2' "$D/ev.json" >/dev/null 2>&1; then
  ok "--system captures the root-owned units"
else
  bad "--system captures the root-owned units" "rc=$RC: $(cat "$D/out")"
fi
jq -e '.image.candidate | test("^[0-9a-f]{64}$")' "$D/ev.json" >/dev/null 2>&1 \
  && ok "--system window still records the image digest (the other host-gated red)" \
  || bad "--system window still records the image digest" "$(jq -c '.image' "$D/ev.json" 2>&1)"

# Self-describing: "no units" from the wrong instance and "no units" from a
# genuinely absent unit are identical bytes unless the instance is recorded.
jq -e '.systemdInstance == "system"' "$D/ev.json" >/dev/null 2>&1 \
  && ok "evidence records which systemd instance was queried" \
  || bad "evidence records the instance" "$(jq -c '.systemdInstance' "$D/ev.json" 2>&1)"
rm -rf "$D"

D="$(mktemp -d)"; make_host "$D"
run_capture "$D" >/dev/null
jq -e '.systemdInstance == "user"' "$D/ev.json" >/dev/null 2>&1 \
  && ok "the default instance is recorded as user" \
  || bad "the default instance is recorded as user" "$(jq -c '.systemdInstance' "$D/ev.json" 2>&1)"
rm -rf "$D"

# --system must NOT become a way to manufacture units that are not there:
# when BOTH instances are empty the units are genuinely absent, which is the
# real TOG-657 red, and the guard must still refuse.
refuses no_network_units "units absent in BOTH instances still refuses" \
  --units '' --sys-units ''

# MUTATION GATE. Prove the flag is what reaches the system instance, rather
# than the stub answering identically either way. Break the scope plumbing and
# the root-owned capture must go RED.
D="$(mktemp -d)"; make_host "$D" "${ROOT_OWNED[@]}"
sed 's/systemctl "\$SYSTEMD_SCOPE" list-unit-files/systemctl --user list-unit-files/' \
    "$SCRIPT" > "$D/mutated.sh"
if cmp -s "$SCRIPT" "$D/mutated.sh"; then
  bad "MUTATION: scope plumbing is load-bearing" "mutation did not apply — anchor drifted"
else
  RC="$(run_capture "$D" "$D/mutated.sh" --system)"
  if [ "$RC" = 2 ]; then
    ok "MUTATION: hard-coding --user makes the root-owned capture refuse again"
  else
    bad "MUTATION: hard-coding --user makes the root-owned capture refuse again" \
        "expected rc=2, got $RC — the --system path may not be what reads the units"
  fi
fi
rm -rf "$D"

# =========================================================================
section "4. no credential can reach the evidence"
# =========================================================================
# The stub returns a whole object carrying Config.Env, as a real bare
# `podman inspect` would. The script must never produce evidence containing it.
D="$(mktemp -d)"
make_host "$D" --networks '{"systemd-paperclip":{},"systemd-omniroute":{}}'
run_capture "$D" >/dev/null
if grep -qiE 'POSTGRES_PASSWORD|ANTHROPIC_API_KEY|"Env"|"Config"' "$D/ev.json" 2>/dev/null; then
  bad "no Config/Env in the evidence" "$(jq -c . "$D/ev.json")"
else
  ok "no Config/Env in the evidence"
fi

# Assert the guard FIRES, not merely that clean input is clean. A negative grep
# over healthy input is not an assertion — it passes on an empty file.
cat >"$D/bin/podman" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  printf 'sha256:1111111111111111111111111111111111111111111111111111111111111111\n'; exit 0
fi
if [ "$1" = "inspect" ]; then
  case "$*" in
    *ImageDigest*) printf 'sha256:1111111111111111111111111111111111111111111111111111111111111111\n' ;;
    *) printf '{"systemd-paperclip":{"Config":{"Env":["POSTGRES_PASSWORD=hunter2"]}}}\n' ;;
  esac
  exit 0
fi
EOF
chmod +x "$D/bin/podman"
RC="$(run_capture "$D")"
# keys[] projects names only, so a credential-bearing VALUE cannot survive.
if [ -f "$D/ev.json" ] && grep -q 'hunter2' "$D/ev.json"; then
  bad "a credential-bearing inspect cannot leak into evidence" "$(cat "$D/ev.json")"
else
  ok "a credential-bearing inspect cannot leak into evidence"
fi
rm -rf "$D"

# =========================================================================
section "5. it must refuse to run inside an agent container"
# =========================================================================
# This is the script's headline claim. An agent container has no podman and no
# systemctl; running with an empty PATH is that condition exactly.
# PATH must still carry bash and jq, or the script never starts and rc=127 —
# an "absence" that proves nothing about the check under test. Build a PATH
# holding exactly the interpreters and NOT podman/systemctl.
D="$(mktemp -d)"; mkdir -p "$D/bin"
for b in bash jq sed awk printf grep; do
  p="$(command -v "$b" 2>/dev/null)" && ln -sf "$p" "$D/bin/$b"
done
( cd "$D" && PATH="$D/bin" "$D/bin/bash" "$SCRIPT" --out "$D/ev.json" ) >"$D/out" 2>&1
RC=$?
if [ "$RC" != 2 ]; then
  bad "refuses by name with no podman/systemctl on PATH" "expected rc=2, got $RC: $(cat "$D/out")"
elif grep -qE 'REFUSED \[missing_(podman|systemctl)\]' "$D/out"; then
  ok "refuses by name with no podman/systemctl on PATH"
else
  bad "refuses by name with no podman/systemctl on PATH" "wrong refusal: $(cat "$D/out")"
fi
[ ! -f "$D/ev.json" ] \
  && ok "an agent container produces no evidence file" \
  || bad "an agent container produces no evidence file" "wrote one"
rm -rf "$D"

# =========================================================================
section "9. the controls are load-bearing (delete each, assert its test goes red)"
# =========================================================================
# A check that stops doing anything must not keep a green suite.
mutate_and_expect_red() { # <label> <sed-expr> <make_host args...>
  local label="$1" expr="$2"; shift 2
  local d; d="$(mktemp -d)"
  make_host "$d" "$@"
  cp "$SCRIPT" "$d/staged.sh"
  sed -i "$expr" "$d/staged.sh"
  local rc; rc="$(run_capture "$d" "$d/staged.sh")"
  # With the guard deleted, the bad input must now be ACCEPTED (rc=0) — which
  # is precisely the regression the guard exists to prevent.
  if [ "$rc" = 0 ]; then
    ok "$label"
  else
    bad "$label" "guard deleted but input still refused (rc=$rc) — the test may not reach this guard: $(cat "$d/out")"
  fi
  rm -rf "$d"
}

# The digest shape is guarded TWICE and deliberately: once at capture
# (image_digest_unresolvable) and once on the written artifact
# (malformed_image_evidence). Deleting either alone must still refuse — that
# redundancy is the point, so assert it rather than mutating around it.
mutate_one_guard_still_refuses() { # <label> <sed-expr> <expected refusal>
  local label="$1" expr="$2" want="$3"
  local d; d="$(mktemp -d)"
  make_host "$d" --img-digest 'sha256:abc123'
  cp "$SCRIPT" "$d/staged.sh"
  sed -i "$expr" "$d/staged.sh"
  local rc; rc="$(run_capture "$d" "$d/staged.sh")"
  if [ "$rc" = 2 ] && grep -q "REFUSED \[$want\]" "$d/out" && [ ! -f "$d/ev.json" ]; then
    ok "$label"
  else
    bad "$label" "rc=$rc, expected REFUSED [$want]: $(cat "$d/out")"
  fi
  rm -rf "$d"
}
mutate_one_guard_still_refuses \
  "deleting the capture-time digest guard, the artifact guard still refuses" \
  's/refuse image_digest_unresolvable/: image_digest_unresolvable_DISABLED/' \
  malformed_image_evidence
mutate_one_guard_still_refuses \
  "deleting the artifact digest guard, the capture-time guard still refuses" \
  's/refuse malformed_image_evidence/: malformed_image_evidence_DISABLED/' \
  image_digest_unresolvable

# Both deleted: a malformed digest must now sail through. This proves the pair
# is what stops it, rather than something incidental upstream.
D="$(mktemp -d)"; make_host "$D" --img-digest 'sha256:abc123'
cp "$SCRIPT" "$D/staged.sh"
sed -i -e 's/refuse image_digest_unresolvable/: image_digest_unresolvable_DISABLED/' \
       -e 's/refuse malformed_image_evidence/: malformed_image_evidence_DISABLED/' "$D/staged.sh"
RC="$(run_capture "$D" "$D/staged.sh")"
if [ "$RC" = 0 ] && [ -f "$D/ev.json" ]; then
  ok "with BOTH digest guards deleted, a malformed digest is accepted"
else
  bad "with BOTH digest guards deleted, a malformed digest is accepted" \
      "rc=$RC — the guards may not be what refuses it: $(cat "$D/out")"
fi
rm -rf "$D"

# Delete the zero-leg guard; a zero-leg host must then be accepted.
mutate_and_expect_red \
  "deleting the zero-leg guard lets a legless host through" \
  's/refuse no_network_legs/: no_network_legs_DISABLED/' \
  --networks '{}'

# Delete the query-failure guard; a systemctl that FAILED must then fall
# through to the absence branch — recording "no units" for a query that never
# ran, which is what sends the operator to a flag that cannot help them.
D="$(mktemp -d)"; make_host "$D" --units '' --sys-units '' --units-rc 1 --units-stderr 'Failed to connect to bus: No medium found'
cp "$SCRIPT" "$D/staged.sh"
sed -i 's/refuse unit_query_failed/: unit_query_failed_DISABLED/' "$D/staged.sh"
RC="$(run_capture "$D" "$D/staged.sh")"
if [ "$RC" = 2 ] && grep -q 'REFUSED \[no_network_units\]' "$D/out"; then
  ok "deleting the query-failure guard conflates a failed query with an absence"
else
  bad "deleting the query-failure guard conflates a failed query with an absence" \
      "rc=$RC, expected the absence refusal to take over: $(cat "$D/out")"
fi
rm -rf "$D"

# Delete the row-shape guard; the diagnostic must then be recorded AS A UNIT.
# rc=0 alone would not prove it — assert the fabricated name is in the
# artifact, because that is the value the gate would go on to read.
D="$(mktemp -d)"; make_host "$D" --units 'Failed to list unit files: Access denied'
cp "$SCRIPT" "$D/staged.sh"
sed -i 's/refuse unit_row_unrecognised/: unit_row_unrecognised_DISABLED/' "$D/staged.sh"
RC="$(run_capture "$D" "$D/staged.sh")"
if [ "$RC" = 0 ] && [ "$(jq -c '.networkUnits' "$D/ev.json" 2>/dev/null)" = '["Failed"]' ]; then
  ok "deleting the row-shape guard writes the fabricated unit \"Failed\" into the evidence"
else
  bad "deleting the row-shape guard writes the fabricated unit into the evidence" \
      "rc=$RC, networkUnits=$(jq -c '.networkUnits' "$D/ev.json" 2>&1): $(cat "$D/out")"
fi
rm -rf "$D"

# Delete the empty-units guard; an empty unit list must then be recorded as
# absence — the mis-query that would refuse a CORRECT carrier.
mutate_and_expect_red \
  "deleting the empty-units guard records absence it cannot distinguish" \
  's/refuse no_network_units/: no_network_units_DISABLED/' \
  --units ''

# =========================================================================
section "10. --help prints the WHOLE header, not a hard-coded window"
# =========================================================================
# WHY. `--help` printed `sed -n '2,49p'`, a fixed line range. Documenting
# --system pushed the header down six lines and the help silently truncated,
# dropping the READ-ONLY paragraph -- the one thing an operator checks before
# running this in a scarce host window. A hard-coded range is a claim about
# line numbers that no test held, so editing the header broke the help and
# every suite stayed green. Assert the CONTRACT (help == header) rather than
# any particular range, so the next header edit cannot reintroduce it.
help_covers_header() {
  # $1 = script path. Compares --help output against the contiguous comment
  # block after the shebang, which is what the header IS.
  local s="$1" d; d="$(mktemp -d)"
  bash "$s" --help >"$d/help" 2>&1
  awk 'NR>=2 { if ($0 ~ /^#/) { print; next } exit }' "$s" >"$d/header"
  cmp -s "$d/help" "$d/header"; local rc=$?
  rm -rf "$d"; return $rc
}

for s in "$SCRIPT" "$HERE/capture_host_render.sh"; do
  n="$(basename "$s")"
  if help_covers_header "$s"; then
    ok "$n --help prints the entire header"
  else
    bad "$n --help prints the entire header" \
        "help output and header differ — a truncating range is back"
  fi
done

# The operator-facing guarantee, asserted by content and not by line count:
# whatever else changes, --help must still say this script only reads.
./capture_host_evidence.sh --help 2>/dev/null | grep -q 'READ-ONLY with respect to the host' \
  && ok "--help still states the script is READ-ONLY" \
  || bad "--help still states the script is READ-ONLY" "the READ-ONLY paragraph is not in the help output"

# MUTATION GATE. A truncating help is exactly what shipped, so prove this
# section FIRES on it rather than passing because both sides are empty.
D="$(mktemp -d)"
sed 's/-h|--help)   print_header; exit 0 ;;/-h|--help)   sed -n "2,49p" "$0"; exit 0 ;;/' \
    "$SCRIPT" > "$D/mutated.sh"
chmod +x "$D/mutated.sh"
if cmp -s "$SCRIPT" "$D/mutated.sh"; then
  bad "MUTATION: the help contract is load-bearing" "mutation did not apply — anchor drifted"
elif help_covers_header "$D/mutated.sh"; then
  bad "MUTATION: restoring the hard-coded range makes the help test go red" \
      "a truncated help still compared equal — the check is inert"
else
  ok "MUTATION: restoring the hard-coded range makes the help test go red"
fi
rm -rf "$D"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
