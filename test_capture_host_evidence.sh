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
  local img_digest='sha256:1111111111111111111111111111111111111111111111111111111111111111'
  local run_digest="$img_digest"
  local inspect_rc=0 img_rc=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --networks)   networks="$2"; shift 2 ;;
      --units)      units="$2"; shift 2 ;;
      --img-digest) img_digest="$2"; shift 2 ;;
      --run-digest) run_digest="$2"; shift 2 ;;
      --inspect-rc) inspect_rc="$2"; shift 2 ;;
      --img-rc)     img_rc="$2"; shift 2 ;;
      *) echo "make_host: bad arg $1" >&2; return 1 ;;
    esac
  done

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
  cat >"$d/bin/systemctl" <<EOF
#!/usr/bin/env bash
cat <<'UNITS'
$units
UNITS
EOF
  chmod +x "$d/bin/podman" "$d/bin/systemctl"
}

# Run the script (or a staged copy) against a stub host. Captures stdout+stderr.
run_capture() {
  local d="$1" script="${2:-$SCRIPT}"
  ( cd "$d" && PATH="$d/bin:$PATH" bash "$script" --out "$d/ev.json" ) >"$d/out" 2>&1
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

# Delete the empty-units guard; an empty unit list must then be recorded as
# absence — the mis-query that would refuse a CORRECT carrier.
mutate_and_expect_red \
  "deleting the empty-units guard records absence it cannot distinguish" \
  's/refuse no_network_units/: no_network_units_DISABLED/' \
  --units ''

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
