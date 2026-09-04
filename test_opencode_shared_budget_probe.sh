#!/usr/bin/env bash
# ===========================================================================
# test_opencode_shared_budget_probe.sh — offline suite for the TOG-894 ask-2
# shared-budget probe.
#
# No gateway: every HTTP result arrives through OPENCODE_PROBE_CMD, the same
# seam style as MODEL_PROBE_CMD in test_model_lane_probe.sh. That is what lets
# CI run this.
#
# THE FIXTURES ARE REAL RESPONSE SHAPES. The throttle body below is the
# verbatim shape measured on 2026-09-03 and is the same string the shipped
# platform classifier keys on:
#
#     [opencode-go/qwen3.6-plus] [401]: Missing API key
#
# WHAT THIS SUITE IS BUILT TO CATCH, beyond the happy path:
#
#  * A TOOL THAT CANNOT TELL THE TWO HYPOTHESES APART. Sections 1 and 2 feed a
#    KNOWN-SHARED and a KNOWN-PER-LANE world and demand different verdicts. A
#    probe that always says one thing passes neither. This is the assertion the
#    whole file exists for — without it the tool could hardcode "SHARED" and
#    look correct against the only world anyone bothered to simulate.
#
#  * A QUIET WINDOW REPORTED AS AN ANSWER. Section 3 pins that zero throttles
#    is INCONCLUSIVE (exit 3), not "per-lane" and not "healthy". The measured
#    2026-09-03 window was exactly this, and calling it a "no" would have
#    published a false negative on ask 2.
#
#  * A GATEWAY OUTAGE READ AS A SHARED BUDGET. Section 4 fails the CONTROL in
#    the same rounds every lane fails. Those rounds must be EXCLUDED, so the
#    run comes back INCONCLUSIVE rather than triumphantly "SHARED". This is the
#    cross-provider-control lesson; an in-namespace control cannot do it.
#
#  * A DETERMINISTIC 500 COUNTED AS CAPACITY. Section 5 feeds the
#    gpt-5.6-luna-style upstream 500. TOG-845 filed that very response as a
#    missing-credential fault. It must land in OTHER, never in the throttle
#    count, and must not by itself produce a verdict.
#
#  * AN EXIT-CODE-ONLY ASSERTION GOING GREEN FOR THE WRONG REASON. Every
#    section pins the VERDICT string as well as the exit code — a script that
#    crashes early also exits non-zero.
# ===========================================================================
set -u

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/opencode_shared_budget_probe.sh"
PASS=0; FAIL=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; }
sect() { printf '\n== %s\n' "$1"; }

# The suite must never reach the real gateway. The seam defaults to something
# that FAILS rather than something that succeeds quietly.
export OPENCODE_PROBE_CMD="false"
unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY 2>/dev/null || true

THROTTLE_BODY='{"error":{"message":"[opencode-go/qwen3.6-plus] [401]: Missing API key"}}'
OK_BODY='{"id":"msg_x","type":"message","role":"assistant"}'
LUNA_500='{"error":{"message":"[opencode-go/gpt-5.6-luna] [500]: internal error"}}'

# A fake probe. $1 = a mode script written to disk; it receives the model name
# and the round number (read from a counter file) and prints "<http>\t<body>".
# EVERY FIXTURE GETS ITS OWN PATH via mktemp: the callers invoke these in
# command substitution, so a shell counter would be discarded in the subshell.
new_fixture() { mktemp "$WORK/$1.XXXXXXXX"; }

# Builds a probe command whose behaviour is driven by a per-lane round schedule.
# `spec` lines are "<model> <rounds-that-throttle-csv-or-'none'>".
make_probe() {
  local script counter
  script="$(new_fixture probe.sh)"
  counter="$(new_fixture counter)"
  echo 0 > "$counter"
  local nlanes="$1"; shift
  {
    echo '#!/usr/bin/env bash'
    echo 'model="$1"'
    printf 'counter=%q\n' "$counter"
    printf 'nlanes=%s\n' "$nlanes"
    # One round = nlanes lane calls + 1 control call.
    cat <<'SH'
n=$(cat "$counter"); n=$((n+1)); echo "$n" > "$counter"
per=$((nlanes+1))
round=$(( (n-1)/per + 1 ))
SH
    echo 'case "$model" in'
    while [[ $# -gt 0 ]]; do
      local m="$1" rounds="$2"; shift 2
      printf '  %q)\n' "$m"
      if [[ "$rounds" == "none" ]]; then
        printf '    printf "200\\t%%s" %q ;;\n' "$OK_BODY"
      elif [[ "$rounds" == "500" ]]; then
        printf '    printf "500\\t%%s" %q ;;\n' "$LUNA_500"
      else
        printf '    case ",%s," in *",$round,"*) printf "401\\t%%s" %q ;; *) printf "200\\t%%s" %q ;; esac ;;\n' \
          "$rounds" "$THROTTLE_BODY" "$OK_BODY"
      fi
    done
    printf '  *) printf "200\\t%%s" %q ;;\n' "$OK_BODY"
    echo 'esac'
  } > "$script"
  chmod +x "$script"
  echo "$script"
}

run_tool() { # prints stdout; sets RC
  local out; out="$(new_fixture out.tsv)"
  set +e
  TOOL_OUT="$("$TOOL" --rounds "$1" --sleep 0 --out "$out" 2>/dev/null)"
  RC=$?
  set -e
  printf '%s' "$TOOL_OUT"
}

L1=opencode-go/qwen3.6-plus
L2=opencode-go/glm-5.3
CTRL=cliproxy/claude-haiku-4-5-20251001
export LANES="$L1 $L2"
export CONTROL="$CTRL"

# --------------------------------------------------------------------------
sect "1. a KNOWN-SHARED world is reported SHARED"
# Both lanes throttle in the SAME rounds (2 and 3). Control always green.
P="$(make_probe 2 "$L1" "2,3" "$L2" "2,3" "$CTRL" none)"
OPENCODE_PROBE_CMD="$P" run_tool 4 >/dev/null
if [[ $RC -eq 0 ]] && printf '%s' "$TOOL_OUT" | grep -q 'SHARED'; then
  ok "coincident throttles -> SHARED (exit 0)"
else
  bad "coincident throttles -> SHARED (got exit $RC): $(printf '%s' "$TOOL_OUT" | tail -3)"
fi

# --------------------------------------------------------------------------
sect "2. a KNOWN-PER-LANE world is reported PER-LANE"
# The SAME number of throttles as section 1, but never in the same round.
# A tool that counts failures instead of coincidences cannot tell these apart.
P="$(make_probe 2 "$L1" "2" "$L2" "4" "$CTRL" none)"
OPENCODE_PROBE_CMD="$P" run_tool 4 >/dev/null
if [[ $RC -eq 0 ]] && printf '%s' "$TOOL_OUT" | grep -q 'PER-LANE'; then
  ok "scattered throttles -> PER-LANE (exit 0)"
else
  bad "scattered throttles -> PER-LANE (got exit $RC): $(printf '%s' "$TOOL_OUT" | tail -3)"
fi

# --------------------------------------------------------------------------
sect "3. a quiet window is INCONCLUSIVE, not an answer"
P="$(make_probe 2 "$L1" none "$L2" none "$CTRL" none)"
OPENCODE_PROBE_CMD="$P" run_tool 3 >/dev/null
if [[ $RC -eq 3 ]] && printf '%s' "$TOOL_OUT" | grep -q 'INCONCLUSIVE'; then
  ok "zero throttles -> INCONCLUSIVE (exit 3)"
else
  bad "zero throttles -> INCONCLUSIVE (got exit $RC): $(printf '%s' "$TOOL_OUT" | tail -3)"
fi
if printf '%s' "$TOOL_OUT" | grep -qi 'PER-LANE'; then
  bad "a quiet window must NOT be read as PER-LANE"
else
  ok "a quiet window is not misreported as PER-LANE"
fi

# --------------------------------------------------------------------------
sect "4. a gateway outage is EXCLUDED, not reported as a shared budget"
# Every lane fails in rounds 2-3 -- and so does the cross-provider control.
# That is the gateway, not the opencode budget. Those rounds are excluded, so
# nothing is left to conclude from.
P="$(make_probe 2 "$L1" "2,3" "$L2" "2,3" "$CTRL" "2,3")"
OPENCODE_PROBE_CMD="$P" run_tool 4 >/dev/null
if printf '%s' "$TOOL_OUT" | grep -q 'SHARED'; then
  bad "control-failed rounds must NOT produce a SHARED verdict"
else
  ok "control-failed rounds do not produce a SHARED verdict"
fi
if printf '%s' "$TOOL_OUT" | grep -qE 'control-failed\(excluded\)=2'; then
  ok "the two gateway rounds are counted as excluded"
else
  bad "expected control-failed(excluded)=2: $(printf '%s' "$TOOL_OUT" | grep -i excluded)"
fi

# --------------------------------------------------------------------------
sect "5. a deterministic upstream 500 is NOT capacity"
P="$(make_probe 2 "$L1" 500 "$L2" none "$CTRL" none)"
OPENCODE_PROBE_CMD="$P" run_tool 3 >/dev/null
if printf '%s' "$TOOL_OUT" | grep -q 'total lane-throttle observations: 0'; then
  ok "a 500 does not enter the throttle count"
else
  bad "a 500 leaked into the throttle count: $(printf '%s' "$TOOL_OUT" | grep -i 'throttle observations')"
fi
if printf '%s' "$TOOL_OUT" | grep -q 'non-throttle failures'; then
  ok "the 500 is reported separately as a non-throttle failure"
else
  bad "the 500 was not reported at all -- a silent drop is worse than a miscount"
fi

# --------------------------------------------------------------------------
sect "6. the throttle discriminator needs the routed-upstream prefix"
# A bare "Missing API key" with NO [provider/model] [status] prefix is a real
# local credential fault. Folding it into capacity is the original TOG-894
# defect inverted, so it must land in OTHER.
BARE="$(new_fixture bare.sh)"
cat > "$BARE" <<SH
#!/usr/bin/env bash
case "\$1" in
  $CTRL) printf '200\t%s' '$OK_BODY' ;;
  *) printf '401\t%s' '{"error":{"message":"Missing API key"}}' ;;
esac
SH
chmod +x "$BARE"
OPENCODE_PROBE_CMD="$BARE" run_tool 2 >/dev/null
if printf '%s' "$TOOL_OUT" | grep -q 'total lane-throttle observations: 0'; then
  ok "a prefix-less 'Missing API key' is not counted as a throttle"
else
  bad "a prefix-less credential fault was counted as capacity"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
