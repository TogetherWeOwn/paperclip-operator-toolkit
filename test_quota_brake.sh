#!/usr/bin/env bash
# ===========================================================================
# test_quota_brake.sh — offline suite for the quota brake (TOG-419).
#
# No database, no network, no credentials: the pace signal, the roster, the
# refusal counts and the write path all arrive through the four *_CMD seams,
# exactly as liveness arrives through LIVENESS_SOURCE_CMD in the sibling
# suites. That is what lets CI run this.
#
# WHAT THIS SUITE IS BUILT TO CATCH, beyond the happy path:
#
#  * THE OWNER'S HARD REQUIREMENT, REGRESSED. "The brake must never disable an
#    agent" is one edit away from being untrue at any time, and the edit that
#    breaks it looks reasonable — reaching for `wakeOnDemand` because it is the
#    shortest path to a hard stop. §1 asserts the guard REFUSES rather than
#    trusting that nobody will write that line.
#
#  * THE WHOLESALE-REPLACE BUG. `PATCH /api/agents/{id}` replaces
#    `runtimeConfig` instead of merging it (measured — it silently deleted
#    `enabled` and `wakeOnDemand` from a live agent during development). A
#    brake that patches only the key it cares about strips wakeability and
#    `modelProfiles` off every agent it touches, and because unset
#    `wakeOnDemand` defaults to TRUE the damage does not show up as an outage.
#    §2 pins that a dropped key is refused, not just a falsified one.
#
#  * THE DAILY-CAP SUBSTITUTION. TOG-419 proposes `maxDailyRuns` as the fix.
#    It drops wakes identically (`status:"skipped"`) while leaving a
#    `wakeOnDemand` roster check green, so adopting it would pass this suite's
#    §5 roster assertion while reproducing the incident. §1c refuses it
#    explicitly so that "we made the brake pass the check" cannot be achieved
#    by switching to a mechanism that only hides better.
#
#  * THE RATCHET. If the brake re-captures a baseline from an already-braked
#    agent, every cycle drives that agent permanently downward — invisible in
#    one run, fatal over a week. §4 runs the brake twice and pins that the
#    second run does not move the baseline.
#
#  * A BRAKE THAT MEASURED NOTHING READING GREEN. §6 asserts the unmeasured
#    paths exit 5 and write nothing. Zero agents braked out of zero examined is
#    "never ran", not "nothing needed braking".
#
#  * AN EXEMPTION THAT SILENTLY MATCHES NOTHING. This company has two agents
#    whose names differ only by case and suffix ("Chief of Staff to Owner" vs
#    "Chief of staff"), so a typo in the exempt file is not hypothetical and
#    would strand the owner exactly as before. §3d pins that an unmatched entry
#    is REPORTED.
# ===========================================================================
set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BRAKE="$HERE/quota_brake.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }

# --- fixtures ---------------------------------------------------------------
# Every ladder fixture below is arithmetic against a TARGET, so base_env pins
# one rather than inheriting whatever PACE_TARGET happens to default to. These
# fixtures exist to exercise the RESPONSE CURVE; the default is a separate
# decision with a separate owner (TOG-490 moved it 0.97 -> 0.90) and §10 pins
# it on its own. Without this pin, moving the default silently reddens §9h —
# which is exactly how it went the first time: one fixture crossed the 5.0x
# rung and the failure read as a ladder regression rather than as the change
# that was intended.
LADDER_TARGET=0.97

# A pace sample burning ~7.3x sustainable: weekly=0.62, days_left=4.02 gives
# need=(0.97-0.62)/4.02=0.0871, and burn 0.6381 over that is LEVEL3. These are
# the real numbers from quota-pacing.jsonl at 2026-08-25T09:29Z, not invented
# ones, so the ladder is exercised against a burn this company actually hit.
cat > "$WORK/pace_hot.json" <<'EOF'
{"accounts":[{"name":"hot@example.com","burn_per_day":0.6381,"weekly":0.62,"days_left":4.02}],"pool_verdict":"THROTTLE"}
EOF
# Comfortably under pace: burn 0.02 vs need 0.0871 -> ratio 0.23 -> RELEASE.
cat > "$WORK/pace_cool.json" <<'EOF'
{"accounts":[{"name":"cool@example.com","burn_per_day":0.02,"weekly":0.62,"days_left":4.02}],"pool_verdict":"OK"}
EOF
# Mild overshoot: burn 0.13 vs need 0.0871 -> ratio 1.49 -> LEVEL1 (halve).
cat > "$WORK/pace_mild.json" <<'EOF'
{"accounts":[{"name":"mild@example.com","burn_per_day":0.13,"weekly":0.62,"days_left":4.02}],"pool_verdict":"THROTTLE"}
EOF
# An account with no traffic yet MUST NOT average the hot one back down.
cat > "$WORK/pace_mixed.json" <<'EOF'
{"accounts":[{"name":"idle@example.com","burn_per_day":null,"weekly":0.1,"days_left":4.0},
             {"name":"hot@example.com","burn_per_day":0.6381,"weekly":0.62,"days_left":4.02}]}
EOF

printf 'Chief of Staff to Owner\tthe owner only interface\n' > "$WORK/exempt.txt"

# roster TSV: id name status wakeOnDemand maxConcurrentRuns baseline critical runtimeConfig
CFG_PLAIN='{"heartbeat":{"enabled":true,"wakeOnDemand":true,"maxConcurrentRuns":20},"modelProfiles":{"cheap":{"enabled":false}}}'
CFG_BRAKED='{"heartbeat":{"enabled":true,"wakeOnDemand":true,"maxConcurrentRuns":1,"quotaBrake":{"baseline":20,"level":"LEVEL3","tool":"quota_brake.sh"}}}'
CFG_COS='{"heartbeat":{"enabled":true,"wakeOnDemand":true,"maxConcurrentRuns":1}}'

roster_std() {
  printf 'a1\tBulk Worker\tidle\ttrue\t20\t\t0\t%s\n' "$CFG_PLAIN"
  printf 'a2\tChief of Staff to Owner\trunning\ttrue\t1\t\t0\t%s\n' "$CFG_COS"
  printf 'a3\tCritical Holder\tidle\ttrue\t20\t\t2\t%s\n' "$CFG_PLAIN"
  printf 'a4\tDormant One\tpaused\tfalse\t20\t\t0\t%s\n' "$CFG_PLAIN"
}
export -f roster_std
mk_roster() { printf '%s' "$1" > "$WORK/roster.sh"; chmod +x "$WORK/roster.sh"; }

# A write path that records instead of writing, so every assertion below is
# about the bytes the tool WOULD have sent.
cat > "$WORK/capture.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\t%s\n' "$1" "$2" >> "$CAPTURE_FILE"
EOF
chmod +x "$WORK/capture.sh"

cat > "$WORK/roster_std.sh" <<EOF
#!/usr/bin/env bash
printf 'a1\tBulk Worker\tidle\ttrue\t20\t\t0\t%s\n' '$CFG_PLAIN'
printf 'a2\tChief of Staff to Owner\trunning\ttrue\t1\t\t0\t%s\n' '$CFG_COS'
printf 'a3\tCritical Holder\tidle\ttrue\t20\t\t2\t%s\n' '$CFG_PLAIN'
printf 'a4\tDormant One\tpaused\tfalse\t20\t\t0\t%s\n' '$CFG_PLAIN'
EOF
chmod +x "$WORK/roster_std.sh"

cat > "$WORK/roster_braked.sh" <<EOF
#!/usr/bin/env bash
printf 'a1\tBulk Worker\tidle\ttrue\t1\t20\t0\t%s\n' '$CFG_BRAKED'
EOF
chmod +x "$WORK/roster_braked.sh"

base_env() {
  export PACE_TARGET="$LADDER_TARGET"
  export PACE_NOW="2026-08-25T10:45:00Z"
  export PACE_SOURCE_CMD="cat $WORK/${1:-pace_hot.json}"
  export ROSTER_SOURCE_CMD="$WORK/${2:-roster_std.sh}"
  export EXEMPT_FILE="$WORK/exempt.txt"
  export AGENT_WRITE_CMD="$WORK/capture.sh"
  export CAPTURE_FILE="$WORK/captured.tsv"
  : > "$CAPTURE_FILE"
}

# ===========================================================================
echo "== 1. the safety guard: a write may never remove wakeability =="
# Unit-tested directly, not only through the planner. A guard exercised solely
# via its caller is only ever fed inputs the caller already gets right.
QUOTA_BRAKE_LIB_ONLY=1 . "$BRAKE"
# The tool sets `set -euo pipefail` for its own execution, and sourcing it
# leaks that into this shell. A suite must run every assertion and report a
# tally, not abort on the first non-zero exit — which here is a PASSING result,
# since most of what follows asserts that something refuses. Turn -e back off.
set +e
BRAKE_HERE="$HERE"; HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

CUR='{"heartbeat":{"wakeOnDemand":true,"maxConcurrentRuns":20}}'

out="$( (assert_policy_preserved "$CUR" '{"runtimeConfig":{"heartbeat":{"wakeOnDemand":false,"maxConcurrentRuns":1}}}') 2>&1 )"; rc=$?
check "1a  wakeOnDemand=false is refused" "$rc" "2"
case "$out" in *"may not disable an agent"*) ok "1a2 refusal names the requirement";; *) bad "1a2 refusal names the requirement" "$out";; esac

# The wholesale-replace bug: the key is not falsified, it is simply absent.
out="$( (assert_policy_preserved "$CUR" '{"runtimeConfig":{"heartbeat":{"maxConcurrentRuns":1}}}') 2>&1 )"; rc=$?
check "1b  DROPPING wakeOnDemand is refused" "$rc" "2"
case "$out" in *"REPLACED, not merged"*) ok "1b2 refusal explains why";; *) bad "1b2 refusal explains why" "$out";; esac

out="$( (assert_policy_preserved "$CUR" '{"runtimeConfig":{"heartbeat":{"wakeOnDemand":true,"maxConcurrentRuns":1,"maxDailyRuns":5}}}') 2>&1 )"; rc=$?
check "1c  introducing maxDailyRuns is refused" "$rc" "2"

# Each alias is a separate door. parseHeartbeatPolicy coalesces all four.
for alias in wakeOnAssignment wakeOnOnDemand wakeOnAutomation; do
  cur_a="$(jq -nc --arg k "$alias" '{heartbeat:{($k):true,maxConcurrentRuns:20}}')"
  body_a="$(jq -nc '{runtimeConfig:{heartbeat:{maxConcurrentRuns:1}}}')"
  rc=0; (assert_policy_preserved "$cur_a" "$body_a") >/dev/null 2>&1 || rc=$?
  check "1d  alias $alias is guarded too" "$rc" "2"
done

# The legitimate write must still pass, or the guard is just an off switch.
GOOD="$(brake_body "$CUR" 1 20 LEVEL3)"
rc=0; (assert_policy_preserved "$CUR" "$GOOD") >/dev/null 2>&1 || rc=$?
check "1e  a correct brake body PASSES the guard" "$rc" "0"

# ===========================================================================
echo "== 2. read-modify-write preserves everything it does not own =="
CUR_FULL='{"heartbeat":{"enabled":true,"wakeOnDemand":true,"maxConcurrentRuns":20},"modelProfiles":{"cheap":{"enabled":false}}}'
BODY="$(brake_body "$CUR_FULL" 1 20 LEVEL3)"
check "2a  modelProfiles survives"  "$(jq -c '.runtimeConfig.modelProfiles' <<<"$BODY")" '{"cheap":{"enabled":false}}'
check "2b  heartbeat.enabled survives" "$(jq -r '.runtimeConfig.heartbeat.enabled' <<<"$BODY")" "true"
check "2c  wakeOnDemand survives as true" "$(jq -r '.runtimeConfig.heartbeat.wakeOnDemand' <<<"$BODY")" "true"
check "2d  the cap is applied" "$(jq -r '.runtimeConfig.heartbeat.maxConcurrentRuns' <<<"$BODY")" "1"
check "2e  the baseline is recorded in-record" "$(jq -r '.runtimeConfig.heartbeat.quotaBrake.baseline' <<<"$BODY")" "20"

RBODY="$(restore_body "$(jq -c '.runtimeConfig' <<<"$BODY")" 20)"
check "2f  restore returns the baseline" "$(jq -r '.runtimeConfig.heartbeat.maxConcurrentRuns' <<<"$RBODY")" "20"
check "2g  restore REMOVES the marker, not nulls it" "$(jq -r '.runtimeConfig.heartbeat|has("quotaBrake")' <<<"$RBODY")" "false"
check "2h  restore still preserves wakeOnDemand" "$(jq -r '.runtimeConfig.heartbeat.wakeOnDemand' <<<"$RBODY")" "true"

# ===========================================================================
echo "== 3. the ladder, the floor, and the exemptions =="
check "3a  LEVEL3 never proposes zero (baseline 1)" "$(cap_for LEVEL3 1)" "1"
check "3a2 LEVEL3 never proposes zero (baseline 20)" "$(cap_for LEVEL3 20)" "1"
check "3a3 LEVEL2 of baseline 1 is still 1" "$(cap_for LEVEL2 1)" "1"
check "3a4 LEVEL1 halves, rounding up" "$(cap_for LEVEL1 5)" "3"
check "3a5 RELEASE returns the baseline" "$(cap_for RELEASE 20)" "20"
# A nonsense baseline must not become a nonsense cap.
check "3a6 a zero baseline is floored, not propagated" "$(cap_for LEVEL1 0)" "1"

check "3b  ratio 7.3 is LEVEL3" "$(verdict_for 7.33)" "LEVEL3"
check "3b2 ratio 1.0 is RELEASE" "$(verdict_for 1.0)" "RELEASE"
check "3b3 ratio 1.5 is LEVEL1" "$(verdict_for 1.5)" "LEVEL1"
check "3b4 ratio 3 is LEVEL2" "$(verdict_for 3)" "LEVEL2"

base_env pace_hot.json roster_std.sh
plan="$("$BRAKE" plan 2>/dev/null)"
cos_line="$(awk -F'\t' '$3=="Chief of Staff to Owner"' <<<"$plan")"
check "3c  the CoS is exempt at the most aggressive level" "$(cut -f1 <<<"$cos_line")" "exempt"
crit_line="$(awk -F'\t' '$3=="Critical Holder"' <<<"$plan")"
check "3c2 a critical-issue holder is exempt" "$(cut -f1 <<<"$crit_line")" "exempt"
bulk_line="$(awk -F'\t' '$3=="Bulk Worker"' <<<"$plan")"
check "3c3 a bulk agent IS braked" "$(cut -f1 <<<"$bulk_line")" "brake"
check "3c4 ...to concurrency 1, not 0" "$(cut -f5 <<<"$bulk_line")" "1"
check "3c5 a paused agent is skipped, not braked" "$(awk -F'\t' '$3=="Dormant One"{print $1}' <<<"$plan")" "skip"

# A typo in the exempt file must not read as a successful exemption.
printf 'Chief of Staff to Owner\treal\nCheif of Staff\ttypo\n' > "$WORK/exempt_typo.txt"
EXEMPT_FILE="$WORK/exempt_typo.txt" plan2="$(EXEMPT_FILE="$WORK/exempt_typo.txt" "$BRAKE" plan 2>/dev/null)"
case "$plan2" in *exempt-entry-unmatched*) ok "3d  an unmatched exempt entry is REPORTED";; *) bad "3d  an unmatched exempt entry is REPORTED" "no marker in output";; esac

# An exemption file that cannot be trusted must stop the brake, not be ignored.
printf 'No Reason Here\n' > "$WORK/exempt_noreason.txt"
rc=0; (EXEMPT_FILE="$WORK/exempt_noreason.txt" "$BRAKE" plan) >/dev/null 2>&1 || rc=$?
check "3e  an exemption without a reason is refused" "$rc" "2"
printf '# only comments\n' > "$WORK/exempt_empty.txt"
rc=0; (EXEMPT_FILE="$WORK/exempt_empty.txt" "$BRAKE" plan) >/dev/null 2>&1 || rc=$?
check "3f  an EMPTY exemption file is refused" "$rc" "2"

# ===========================================================================
echo "== 4. the ratchet: a baseline is captured once, never re-captured =="
base_env pace_hot.json roster_braked.sh
plan="$("$BRAKE" plan 2>/dev/null)"
line="$(awk -F'\t' '$3=="Bulk Worker"' <<<"$plan")"
check "4a  an already-braked agent reports its ORIGINAL baseline" "$(cut -f6 <<<"$line")" "20"
check "4b  ...and is a no-op, not a second brake" "$(cut -f1 <<<"$line")" "nochange"

# Apply twice against a roster that reflects the first apply; the baseline in
# the second body must still be 20, never the throttled 1.
base_env pace_hot.json roster_std.sh
"$BRAKE" apply --yes >/dev/null 2>&1
b1="$(awk -F'\t' '$1=="a1"{print $2}' "$CAPTURE_FILE" | head -1)"
check "4c  first apply captures baseline 20" "$(jq -r '.runtimeConfig.heartbeat.quotaBrake.baseline' <<<"$b1")" "20"
base_env pace_hot.json roster_braked.sh
"$BRAKE" apply --yes >/dev/null 2>&1
check "4d  second apply writes NOTHING (no ratchet)" "$(wc -l < "$CAPTURE_FILE" | tr -d ' ')" "0"

echo "== 4bis. RELEASE lifts the brake with no operator and no state file =="
base_env pace_cool.json roster_braked.sh
plan="$("$BRAKE" plan 2>/dev/null)"
check "4e  under pace, a braked agent is restored" "$(awk -F'\t' '$3=="Bulk Worker"{print $1}' <<<"$plan")" "restore"
check "4f  ...to its recorded baseline" "$(awk -F'\t' '$3=="Bulk Worker"{print $5}' <<<"$plan")" "20"
# The payoff of rule 2: `restore` works from a cold start, knowing nothing.
out="$("$BRAKE" restore 2>&1)"
case "$out" in *"restorable: 1"*) ok "4g  restore finds the agent from its OWN record";; *) bad "4g  restore finds the agent from its OWN record" "$out";; esac
check "4h  restore is dry-run without --yes" "$(wc -l < "$CAPTURE_FILE" | tr -d ' ')" "0"

echo "== 4ter. a mild overshoot halves rather than flooring =="
base_env pace_mild.json roster_std.sh
plan="$("$BRAKE" plan 2>/dev/null)"
check "4i  LEVEL1 halves a baseline-20 agent to 10" "$(awk -F'\t' '$3=="Bulk Worker"{print $5}' <<<"$plan")" "10"

echo "== 4quater. a null-burn account must not dilute a hot one =="
base_env pace_mixed.json roster_std.sh
check "4j  worst account decides the verdict" "$("$BRAKE" plan --explain 2>&1 >/dev/null | awk '/verdict/{print $3}')" "LEVEL3"

# ===========================================================================
echo "== 5. verify: the roster invariant the owner stated as hard =="
cat > "$WORK/roster_clean.sh" <<EOF
#!/usr/bin/env bash
printf 'a1\tOne\tidle\ttrue\t1\t20\t0\t{}\n'
printf 'a2\tTwo\tidle\t\t2\t\t0\t{}\n'
EOF
chmod +x "$WORK/roster_clean.sh"
rc=0; ROSTER_SOURCE_CMD="$WORK/roster_clean.sh" "$BRAKE" verify >/dev/null 2>&1 || rc=$?
check "5a  all wakeable (incl. unset) is exit 0" "$rc" "0"

cat > "$WORK/roster_dirty.sh" <<EOF
#!/usr/bin/env bash
printf 'a1\tOne\tidle\ttrue\t1\t20\t0\t{}\n'
printf 'a2\tTwo\tidle\tfalse\t2\t\t0\t{}\n'
EOF
chmod +x "$WORK/roster_dirty.sh"
rc=0; ROSTER_SOURCE_CMD="$WORK/roster_dirty.sh" "$BRAKE" verify >/dev/null 2>&1 || rc=$?
check "5b  one unwakeable agent is exit 3" "$rc" "3"

# ===========================================================================
echo "== 6. a check that measured nothing must not read green =="
# EXIT CODE ALONE IS NOT ENOUGH HERE. `plan` has four separate "I could not
# measure" gates in a row, all exiting 5, so a test that only checks the code
# is satisfied by whichever gate happens to fire — and a mutation that deletes
# the gate under test stays GREEN because its neighbour catches the same input.
# Measured: neutering the unreadable-roster gate left this whole section
# passing, because the empty-roster gate downstream fired instead. Each
# assertion therefore pins its OWN cause by message.
rc=0; out="$( (PACE_SOURCE_CMD="false" ROSTER_SOURCE_CMD="$WORK/roster_std.sh" \
       EXEMPT_FILE="$WORK/exempt.txt" "$BRAKE" plan) 2>&1 )" || rc=$?
check "6a  unreadable pace is exit 5, not 0" "$rc" "5"
case "$out" in *"cannot read the pace signal"*) ok "6a2 ...for the PACE reason specifically";; *) bad "6a2 ...for the PACE reason specifically" "$out";; esac

rc=0; out="$( (PACE_SOURCE_CMD="cat $WORK/pace_hot.json" ROSTER_SOURCE_CMD="false" \
       EXEMPT_FILE="$WORK/exempt.txt" "$BRAKE" plan) 2>&1 )" || rc=$?
check "6b  unreadable roster is exit 5, not 0" "$rc" "5"
case "$out" in *"cannot read the roster"*) ok "6b2 ...for the UNREADABLE reason, not the empty one";; *) bad "6b2 ...for the UNREADABLE reason, not the empty one" "$out";; esac

rc=0; out="$( (PACE_SOURCE_CMD="cat $WORK/pace_hot.json" ROSTER_SOURCE_CMD="true" \
       EXEMPT_FILE="$WORK/exempt.txt" "$BRAKE" plan) 2>&1 )" || rc=$?
check "6c  an EMPTY roster is exit 5, not 'nothing to do'" "$rc" "5"
case "$out" in *"came back empty"*) ok "6c2 ...for the EMPTY reason, not the unreadable one";; *) bad "6c2 ...for the EMPTY reason, not the unreadable one" "$out";; esac

rc=0; (ROSTER_SOURCE_CMD="false" "$BRAKE" verify) >/dev/null 2>&1 || rc=$?
check "6d  verify cannot pass while blind" "$rc" "5"

rc=0; (REFUSAL_SOURCE_CMD="false" "$BRAKE" refusals) >/dev/null 2>&1 || rc=$?
check "6e  refusals cannot read quiet while blind" "$rc" "5"

# An apply that cannot measure must not have written on the way to failing.
base_env pace_hot.json roster_std.sh
rc=0; (PACE_SOURCE_CMD="false" "$BRAKE" apply --yes) >/dev/null 2>&1 || rc=$?
check "6f  a blind apply writes NOTHING" "$(wc -l < "$CAPTURE_FILE" | tr -d ' ')" "0"

# The frozen real outage feed must fail before roster evaluation or mutation.
DEAD="$HERE/tests/dead-feed-2026-08-26.jsonl"
: > "$WORK/captured.tsv"
rc=0; out="$(QUOTA_PACING_FILE="$DEAD" PACE_SOURCE_CMD="" PACE_NOW=2026-09-04T16:00:00Z \
  ROSTER_SOURCE_CMD="$WORK/roster_std.sh" EXEMPT_FILE="$WORK/exempt.txt" \
  AGENT_WRITE_CMD="$WORK/capture.sh" CAPTURE_FILE="$WORK/captured.tsv" "$BRAKE" pace 2>&1)" || rc=$?
check "6g  the real dead feed makes pace UNKNOWN" "$rc" "5"
case "$out" in *"UNKNOWN"*) ok "6g2 ...and names UNKNOWN";; *) bad "6g2 ...and names UNKNOWN" "$out";; esac
case "$out" in *'"verdict"'*) bad "6g3 ...without a confident JSON verdict" "$out";; *) ok "6g3 ...without a confident JSON verdict";; esac

# A malformed timestamped row cannot sort after the validated sample and drive
# a privileged apply. Production drops it before both guard and derivation.
cat > "$WORK/malformed-ts.jsonl" <<'EOF'
{"ts":"2026-09-04T15:59:00Z","pool_verdict":"AHEAD","accounts":[{"name":"valid","weekly":0.40,"five_hour":0.20,"days_left":6,"burn_per_day":0.01,"weekly_reset_utc":"2026-09-11 00:00 UTC"}]}
{"ts":"zzzz","pool_verdict":"AHEAD","accounts":[{"name":"attacker","weekly":0.99,"five_hour":0.99,"days_left":1,"burn_per_day":9,"weekly_reset_utc":"2026-09-11 00:00 UTC"}]}
EOF
out="$(QUOTA_PACING_FILE="$WORK/malformed-ts.jsonl" PACE_SOURCE_CMD="" PACE_NOW=2026-09-04T16:00:00Z "$BRAKE" pace 2>/dev/null)"; rc=$?
check "6g4 a malformed timestamp cannot drive the brake" "$(jq -r '.name' <<<"$out")" "valid"
check "6g5 ...and cannot select LEVEL3" "$(jq -r '.verdict' <<<"$out")" "RELEASE"

rc=0; (QUOTA_PACING_FILE="$DEAD" PACE_SOURCE_CMD="" PACE_NOW=2026-09-04T16:00:00Z \
  ROSTER_SOURCE_CMD="$WORK/roster_std.sh" EXEMPT_FILE="$WORK/exempt.txt" \
  AGENT_WRITE_CMD="$WORK/capture.sh" CAPTURE_FILE="$WORK/captured.tsv" "$BRAKE" apply --yes) >/dev/null 2>&1 || rc=$?
check "6g6 stale apply is UNKNOWN" "$rc" "5"
check "6g7 stale apply writes NOTHING" "$(wc -l < "$WORK/captured.tsv" | tr -d ' ')" "0"

# ===========================================================================
echo "== 7. dry-run by default =="
base_env pace_hot.json roster_std.sh
"$BRAKE" plan >/dev/null 2>&1
check "7a  plan writes nothing" "$(wc -l < "$CAPTURE_FILE" | tr -d ' ')" "0"
rc=0; ("$BRAKE" apply) >/dev/null 2>&1 || rc=$?
check "7b  apply without --yes is refused" "$rc" "2"
check "7c  ...and wrote nothing"  "$(wc -l < "$CAPTURE_FILE" | tr -d ' ')" "0"
"$BRAKE" apply --yes >/dev/null 2>&1
n="$(wc -l < "$CAPTURE_FILE" | tr -d ' ')"
if (( n > 0 )); then ok "7d  apply --yes does write ($n)"; else bad "7d  apply --yes does write" "wrote 0"; fi
# Every captured body must survive the guard — the real end-to-end assertion.
allgood=yes
while IFS=$'\t' read -r _id body; do
  [[ -n "$body" ]] || continue
  case "$(jq -r '.runtimeConfig.heartbeat.wakeOnDemand' <<<"$body")" in
    true) ;;
    *) allgood=no ;;
  esac
done < "$CAPTURE_FILE"
check "7e  every applied body keeps wakeOnDemand=true" "$allgood" "yes"

# ===========================================================================
echo "== 8. refusals: the loud metric =="
cat > "$WORK/ref_hot.sh" <<'EOF'
#!/usr/bin/env bash
printf 'heartbeat.wakeOnDemand.disabled\tChief of Staff to Owner\t68\n'
printf 'heartbeat.daily_run_limit\tBulk Worker\t3\n'
EOF
chmod +x "$WORK/ref_hot.sh"
rc=0; out="$(REFUSAL_SOURCE_CMD="$WORK/ref_hot.sh" "$BRAKE" refusals 2>&1)" || rc=$?
check "8a  71 refusals over threshold 10 is exit 3" "$rc" "3"
case "$out" in *"refused wakes in the last"*71*) ok "8b  the count is reported as a NUMBER";; *) bad "8b  the count is reported as a NUMBER" "$out";; esac

cat > "$WORK/ref_quiet.sh" <<'EOF'
#!/usr/bin/env bash
printf 'heartbeat.wakeOnDemand.disabled\tSomebody\t2\n'
EOF
chmod +x "$WORK/ref_quiet.sh"
rc=0; (REFUSAL_SOURCE_CMD="$WORK/ref_quiet.sh" "$BRAKE" refusals) >/dev/null 2>&1 || rc=$?
check "8c  2 refusals under threshold is exit 0" "$rc" "0"

# Zero rows is genuinely quiet — distinct from §6e, where the SOURCE failed.
rc=0; (REFUSAL_SOURCE_CMD="true" "$BRAKE" refusals) >/dev/null 2>&1 || rc=$?
check "8d  zero refusals from a WORKING source is exit 0" "$rc" "0"

# ===========================================================================
# 9. TOG-440 — BURN IS DERIVED FROM `weekly`, AND A FALLBACK SAYS SO.
#
# Everything above §9 feeds the tool a SINGLE ts-less sample, which is the
# pre-TOG-440 shape. Those fixtures now exercise the labelled fallback, which
# is worth pinning — but it means the suite would otherwise never run the
# derived path at all, and the derived path is the one that decides how fast
# this company is allowed to work.
#
# The case that matters most is 9c. From 2026-08-25T11:59Z to 14:30Z the real
# account burned NOTHING — `weekly` flat at 0.86 — while `burn_per_day` decayed
# from 0.9568 to 0.1595 and reported ratios of 34.1x down to 5.5x. Every one of
# those samples selected LEVEL2 or LEVEL3: concurrency 1 across the roster, on
# an account that was idle. Underrunning the weekly quota is the expensive
# failure mode here (unused quota is destroyed at reset), so a brake that
# floors the company while nothing is burning is not "fail-safe", it is the
# failure. 9c pins that this window now RELEASES.
echo "== 9. TOG-440: burn is derived from the weekly series =="

# A window is JSONL, oldest first.
mkwin() { printf '%s\n' "$@" > "$WORK/$WIN"; }

# --- 9a/9b: a real climb derives the rate, exactly -------------------------
# weekly 0.52 -> 0.62 over exactly 24h => 0.10/day against
# need=(0.97-0.62)/4.02=0.08706 => ratio 1.1486 => LEVEL1. Note what this
# shows: the SAME account, hour and reported field that §4's fixture puts at
# 7.3x is a 1.1x when measured. That gap is the whole issue — LEVEL1 halves
# concurrency, LEVEL3 floors it to 1.
WIN=win_climb.jsonl
mkwin \
 '{"ts":"2026-08-24T09:29:00Z","accounts":[{"name":"hot@example.com","burn_per_day":0.6381,"weekly":0.52,"days_left":5.02}]}' \
 '{"ts":"2026-08-24T21:29:00Z","accounts":[{"name":"hot@example.com","burn_per_day":0.6381,"weekly":0.57,"days_left":4.52}]}' \
 '{"ts":"2026-08-25T09:29:00Z","accounts":[{"name":"hot@example.com","burn_per_day":0.6381,"weekly":0.62,"days_left":4.02}]}'
base_env; export PACE_SOURCE_CMD="cat $WORK/$WIN"
pace="$("$BRAKE" pace 2>/dev/null)"
check "9a  a window with history reports source=derived" "$(jq -r '.source' <<<"$pace")" "derived"
check "9b  burn is dweekly/dt to 4dp, NOT burn_per_day" "$(jq -r '.burn*10000|round/10000' <<<"$pace")" "0.1"
check "9b2 ...and is not the reported 0.6381" "$(jq -r '.burn == 0.6381' <<<"$pace")" "false"
check "9b3 the derived ratio selects LEVEL1, not LEVEL3" "$(jq -r '.verdict' <<<"$pace")" "LEVEL1"
plan="$("$BRAKE" plan 2>/dev/null)"
check "9b4 ...so a baseline-20 agent is halved, not floored" \
      "$(awk -F'\t' '$3=="Bulk Worker"{print $5}' <<<"$plan")" "10"

# --- 9c: THE REGRESSION. flat weekly, decaying reported burn ---------------
# Lifted from the real file: 11:59Z-14:30Z, weekly pinned at 0.86 while
# burn_per_day decays. Derived burn is 0 => RELEASE. Reported burn 0.1595
# against need=(0.97-0.86)/3.81=0.02887 is 5.52x => LEVEL3.
WIN=win_flat.jsonl
mkwin \
 '{"ts":"2026-08-25T11:59:40Z","accounts":[{"name":"idle@example.com","burn_per_day":0.9568,"weekly":0.86,"days_left":3.92}]}' \
 '{"ts":"2026-08-25T13:14:57Z","accounts":[{"name":"idle@example.com","burn_per_day":0.2733,"weekly":0.86,"days_left":3.86}]}' \
 '{"ts":"2026-08-25T14:30:10Z","accounts":[{"name":"idle@example.com","burn_per_day":0.1595,"weekly":0.86,"days_left":3.81}]}'
base_env; export PACE_SOURCE_CMD="cat $WORK/$WIN"
pace="$("$BRAKE" pace 2>/dev/null)"
check "9c  an idle account derives zero burn" "$(jq -r '.burn' <<<"$pace")" "0"
check "9c2 ...and RELEASES instead of flooring the roster" "$(jq -r '.verdict' <<<"$pace")" "RELEASE"
# Prove the OLD input really would have gone the other way on this SAME
# fixture. Without this the case only shows the new answer, not that it
# differs — and "the fix changed nothing" is the outcome to catch.
need_flat="$(jq -r '.need' <<<"$pace")"
check "9c3 the reported field on this same window says LEVEL3" \
      "$(awk -v b=0.1595 -v n="$need_flat" 'BEGIN{r=b/n; print (r<=1?"RELEASE":(r<=2?"LEVEL1":(r<=5?"LEVEL2":"LEVEL3")))}')" \
      "LEVEL3"
plan="$("$BRAKE" plan 2>/dev/null)"
check "9c4 an unbraked agent is left alone" \
      "$(awk -F'\t' '$3=="Bulk Worker"{print $1}' <<<"$plan")" "nochange"

# --- 9d: a window too short to derive falls back, LOUDLY -------------------
WIN=win_short.jsonl
mkwin \
 '{"ts":"2026-08-25T09:29:00Z","accounts":[{"name":"hot@example.com","burn_per_day":0.6381,"weekly":0.62,"days_left":4.02}]}' \
 '{"ts":"2026-08-25T09:44:00Z","accounts":[{"name":"hot@example.com","burn_per_day":0.6381,"weekly":0.62,"days_left":4.02}]}'
base_env; export PACE_SOURCE_CMD="cat $WORK/$WIN"
pace="$("$BRAKE" pace 2>/dev/null)"
check "9d  a 15m window cannot derive; it falls back" "$(jq -r '.source' <<<"$pace")" "reported"
check "9d2 ...to the reported value, not to zero" "$(jq -r '.burn' <<<"$pace")" "0.6381"
case "$(jq -r '.reason' <<<"$pace")" in
  *"under the 2h minimum"*) ok "9d3 ...and the reason names the minimum it missed";;
  *) bad "9d3 ...and the reason names the minimum it missed" "$(jq -r '.reason' <<<"$pace")";;
esac
# The warning is on EVERY plan, not only --explain. An operator who did not ask
# for detail is exactly the one who will otherwise read an estimate as a
# measurement.
err="$("$BRAKE" plan 2>&1 >/dev/null)"
case "$err" in
  *"burn was NOT derived"*) ok "9d4 a plain \`plan\` warns that this was not measured";;
  *) bad "9d4 a plain \`plan\` warns that this was not measured" "$err";;
esac
# And the converse, which is what makes 9d4 mean anything: the warning must be
# ABSENT when the reading really was derived. A warning printed unconditionally
# would pass 9d4 while telling the operator nothing.
export PACE_SOURCE_CMD="cat $WORK/win_climb.jsonl"
err="$("$BRAKE" plan 2>&1 >/dev/null)"
case "$err" in
  *"burn was NOT derived"*) bad "9d5 a DERIVED plan does not warn" "$err";;
  *) ok "9d5 a DERIVED plan does not warn";;
esac

# --- 9e: --require-derived refuses the fallback ----------------------------
export PACE_SOURCE_CMD="cat $WORK/win_short.jsonl"
rc=0; out="$("$BRAKE" plan --require-derived 2>&1)" || rc=$?
check "9e  --require-derived on a fallback is exit 5" "$rc" "5"
case "$out" in *"could not be DERIVED"*) ok "9e2 ...naming derivation as the reason";; *) bad "9e2 ...naming derivation as the reason" "$out";; esac
rc=0; ("$BRAKE" apply --yes --require-derived) >/dev/null 2>&1 || rc=$?
check "9e3 ...and a refused apply is also exit 5" "$rc" "5"
check "9e4 ...having written NOTHING" "$(wc -l < "$CAPTURE_FILE" | tr -d ' ')" "0"
# The env spelling must work too — the monitor path sets it once, globally,
# rather than remembering a flag at every call site.
rc=0; (PACE_REQUIRE_DERIVED=1 "$BRAKE" plan) >/dev/null 2>&1 || rc=$?
check "9e5 PACE_REQUIRE_DERIVED=1 refuses the same way" "$rc" "5"
# ...and must NOT refuse a derived reading. An env var that refuses everything
# would pass 9e5 and silently take the brake off the air.
rc=0; (PACE_REQUIRE_DERIVED=1 PACE_SOURCE_CMD="cat $WORK/win_climb.jsonl" "$BRAKE" plan) >/dev/null 2>&1 || rc=$?
check "9e6 ...but allows a DERIVED plan through" "$rc" "0"

# --- 9f: a weekly reset inside the window is not "burning nothing" ---------
# weekly runs 0.90 -> 0.95, resets to 0.02, then climbs to 0.12 over 12h.
# Naive end-minus-start across the reset gives (0.12-0.90)/1d = -0.78/day,
# which clamps to 0 and RELEASES the brake at the start of a fresh week.
# Truncating at the reset gives (0.12-0.02)/0.5d = +0.20/day.
WIN=win_reset.jsonl
mkwin \
 '{"ts":"2026-08-24T09:00:00Z","accounts":[{"name":"roll@example.com","burn_per_day":null,"weekly":0.90,"days_left":0.5}]}' \
 '{"ts":"2026-08-24T18:00:00Z","accounts":[{"name":"roll@example.com","burn_per_day":null,"weekly":0.95,"days_left":0.2}]}' \
 '{"ts":"2026-08-24T21:00:00Z","accounts":[{"name":"roll@example.com","burn_per_day":null,"weekly":0.02,"days_left":7.0}]}' \
 '{"ts":"2026-08-25T09:00:00Z","accounts":[{"name":"roll@example.com","burn_per_day":null,"weekly":0.12,"days_left":6.5}]}'
base_env; export PACE_SOURCE_CMD="cat $WORK/$WIN"
pace="$("$BRAKE" pace 2>/dev/null)"
check "9f  a window spanning a reset derives from the NEW week only" \
      "$(jq -r '.burn*10000|round/10000' <<<"$pace")" "0.2"
check "9f2 ...and never reads a reset as negative burn" "$(jq -r '.burn >= 0' <<<"$pace")" "true"
check "9f3 ...using only the post-reset samples" "$(jq -r '.dweekly*100|round/100' <<<"$pace")" "0.1"

# --- 9g: rounding jitter clamps to zero, it does not go negative -----------
# The real file steps -0.01 at 2026-08-25T10:44:23Z on a flat account. `weekly`
# is rounded to 0.01, so this is quantization, not a refund. It is also well
# under PACE_RESET_DROP, so it must NOT be mistaken for a week reset.
WIN=win_jitter.jsonl
mkwin \
 '{"ts":"2026-08-24T09:00:00Z","accounts":[{"name":"jit@example.com","burn_per_day":1.5882,"weekly":0.71,"days_left":4.98}]}' \
 '{"ts":"2026-08-24T21:00:00Z","accounts":[{"name":"jit@example.com","burn_per_day":1.5882,"weekly":0.71,"days_left":4.48}]}' \
 '{"ts":"2026-08-25T09:00:00Z","accounts":[{"name":"jit@example.com","burn_per_day":1.5882,"weekly":0.70,"days_left":3.97}]}'
base_env; export PACE_SOURCE_CMD="cat $WORK/$WIN"
pace="$("$BRAKE" pace 2>/dev/null)"
check "9g  a -0.01 rounding step clamps to zero burn" "$(jq -r '.burn' <<<"$pace")" "0"
check "9g2 ...but the raw dweekly stays visible" "$(jq -r '.dweekly*100|round/100' <<<"$pace")" "-0.01"
check "9g3 ...and the verdict is RELEASE, not a negative ratio" "$(jq -r '.verdict' <<<"$pace")" "RELEASE"
check "9g4 ...and it was NOT treated as a week reset" "$(jq -r '.window_h' <<<"$pace")" "24"

# --- 9h: the worst account still decides, on derived input -----------------
# §4quater pins this for the reported field. It has to hold for the derived one
# too: an idle account averaging a hot one down is the failure that lets a
# burning pool read comfortable.
WIN=win_mixed.jsonl
mkwin \
 '{"ts":"2026-08-24T09:29:00Z","accounts":[{"name":"idle@example.com","burn_per_day":null,"weekly":0.10,"days_left":5.00},{"name":"hot@example.com","burn_per_day":null,"weekly":0.20,"days_left":5.02}]}' \
 '{"ts":"2026-08-25T09:29:00Z","accounts":[{"name":"idle@example.com","burn_per_day":null,"weekly":0.10,"days_left":4.00},{"name":"hot@example.com","burn_per_day":null,"weekly":0.62,"days_left":4.02}]}'
base_env; export PACE_SOURCE_CMD="cat $WORK/$WIN"
pace="$("$BRAKE" pace 2>/dev/null)"
# hot: 0.20 -> 0.62 over 24h = 0.42/day against need=(0.97-0.62)/4.02=0.08706
# => 4.82x => LEVEL2.  idle: flat 0.10 => 0/day => RELEASE.
check "9h  the hot account is the one reported" "$(jq -r '.name' <<<"$pace")" "hot@example.com"
check "9h2 ...at LEVEL2, undiluted by the idle one" "$(jq -r '.verdict' <<<"$pace")" "LEVEL2"
# The assertion that gives 9h2 its meaning: the idle account ALONE reads
# RELEASE, so the pool verdict came from taking the worst rather than from
# every account happening to agree.
WIN=win_idle_only.jsonl
mkwin \
 '{"ts":"2026-08-24T09:29:00Z","accounts":[{"name":"idle@example.com","burn_per_day":null,"weekly":0.10,"days_left":5.00}]}' \
 '{"ts":"2026-08-25T09:29:00Z","accounts":[{"name":"idle@example.com","burn_per_day":null,"weekly":0.10,"days_left":4.00}]}'
check "9h3 ...the idle account on its own is RELEASE" \
      "$(PACE_SOURCE_CMD="cat $WORK/$WIN" "$BRAKE" pace 2>/dev/null | jq -r '.verdict')" "RELEASE"

# --- 9i: THE BLINDNESS FIX --------------------------------------------------
# Every account in win_mixed reports burn_per_day:null — the shape of 75 of the
# 219 rows in the real file, including its entire 14:45Z-17:00Z tail. The
# pre-TOG-440 tool returned empty from pace_ratio on exactly this and exited 5
# UNKNOWN: no brake, no restore, nothing. A third of the samples.
rc=0; ("$BRAKE" plan) >/dev/null 2>&1 || rc=$?
check "9i  an all-null-burn window now PLANS instead of exiting 5" "$rc" "0"
# The floor still holds: a window with neither a derivable series nor a
# reported value is still exit 5. Deriving must not turn "no data" into a
# confident zero — that would brake nothing during a real burn.
WIN=win_blank.jsonl
mkwin '{"ts":"2026-08-25T09:29:00Z","accounts":[{"name":"x@example.com","burn_per_day":null,"weekly":0.62,"days_left":4.02}]}'
rc=0; out="$(PACE_SOURCE_CMD="cat $WORK/$WIN" "$BRAKE" plan 2>&1)" || rc=$?
check "9i2 a single null-burn sample is still exit 5, not zero burn" "$rc" "5"
case "$out" in *"Refusing to guess"*) ok "9i3 ...refusing to guess";; *) bad "9i3 ...refusing to guess" "$out";; esac

# --- 9j: `pace` is the machine-readable surface ----------------------------
# The do_plan warning goes to stderr, which is where an automated caller drops
# it. A monitor needs the source on stdout AND in the exit code.
rc=0; PACE_SOURCE_CMD="cat $WORK/win_climb.jsonl" "$BRAKE" pace >/dev/null 2>&1 || rc=$?
check "9j  \`pace\` exits 0 on a derived reading" "$rc" "0"
rc=0; PACE_SOURCE_CMD="cat $WORK/win_short.jsonl" "$BRAKE" pace >/dev/null 2>&1 || rc=$?
check "9j2 ...and exits 4 on a fallback" "$rc" "4"

# ===========================================================================
echo
echo "== 9. the throttled export (TOG-401) =="
#
# This is what makes `throttled` distinguishable from `disabled` outside the
# operator's host. `queue_liveness.sh` consumes it, so two properties are
# load-bearing and neither is obvious from the happy path:
#
#   * an EMPTY export is a positive claim ("nobody is braked") that licenses
#     the consumer to report a dormant agent as deliberately disabled, so it
#     may only ever be produced by a source that actually answered; and
#   * a FAILED read must therefore leave no export behind at all, including
#     any export a previous run wrote.

# A braked agent (baseline present) alongside three that are not. `a4` is
# dormant-but-unbraked, which is exactly the row the consumer will call
# `disabled` on the strength of this export.
cat > "$WORK/roster_mixed.sh" <<EOF
#!/usr/bin/env bash
printf 'a1\tBulk Worker\tidle\ttrue\t1\t20\t0\t%s\n' '$CFG_BRAKED'
printf 'a2\tChief of Staff to Owner\trunning\ttrue\t1\t\t0\t%s\n' '$CFG_COS'
printf 'a4\tDormant One\tpaused\tfalse\t20\t\t0\t%s\n' '$CFG_PLAIN'
EOF
chmod +x "$WORK/roster_mixed.sh"

out="$(ROSTER_SOURCE_CMD="$WORK/roster_mixed.sh" "$BRAKE" throttled 2>/dev/null)"; rc=$?
check "9a  export exits 0" "$rc" "0"
check "9b  ONLY the agent with a baseline is exported" "$(jq -r 'keys|join(",")' <<<"$out")" "a1"
check "9c  the exported entry carries the level"      "$(jq -r '.a1.level' <<<"$out")" "LEVEL3"
check "9d  ...and the baseline, as a NUMBER"          "$(jq -r '.a1.baseline|tostring + ":" + type' <<<"$out")" "20:number"
check "9e  ...and the current cap"                    "$(jq -r '.a1.cap' <<<"$out")" "1"
# The shape queue_liveness.sh parses: an object keyed by agent id.
check "9f  the document is an object keyed by agent id" "$(jq -r 'type' <<<"$out")" "object"

# The marker is the BASELINE, not a low cap. `a2` sits at maxConcurrentRuns=1
# — identical to a LEVEL3 cap — but was never braked, and must not appear.
# Without this, an agent legitimately configured at 1 reads throttled forever.
case "$(jq -r 'has("a2")' <<<"$out")" in
  false) ok "9g  a low cap WITHOUT a baseline is not throttled" ;;
  *)     bad "9g  a low cap WITHOUT a baseline is not throttled" "$out" ;;
esac

# BASELINE for 9b/9g: a roster with nothing braked yields a real empty answer,
# not an error. This is the state the whole board is in most of the time, and
# it is what lets the consumer say `disabled` instead of `undetermined`.
out="$(ROSTER_SOURCE_CMD="$WORK/roster_std.sh" "$BRAKE" throttled 2>/dev/null)"; rc=$?
check "9h  BASELINE nothing braked is exit 0..." "$rc" "0"
check "9h2 ...and an empty OBJECT, not an error" "$out" "{}"

# THE ONE THAT MATTERS. An unreadable roster must be exit 5 with no document.
# Emitting `{}` here would tell the consumer "nobody is throttled" on the
# strength of a failed read, and every dormant agent on the board would harden
# from `undetermined` into `disabled`.
out="$(ROSTER_SOURCE_CMD="false" "$BRAKE" throttled 2>/dev/null)"; rc=$?
check "9i  an unreadable roster is exit 5 (UNKNOWN)" "$rc" "5"
check "9i2 ...and emits NOTHING, never '{}'" "$out" ""

# A source that exits 0 with no rows is the same failure wearing a better
# face: it did not read the roster either.
out="$(ROSTER_SOURCE_CMD="true" "$BRAKE" throttled 2>/dev/null)"; rc=$?
check "9j  an EMPTY roster is exit 5, not 'nobody is braked'" "$rc" "5"
check "9j2 ...and emits NOTHING" "$out" ""

# --out, and the same refusal through it. A stale export left behind by a
# failed run is worse than no export: it is confidently wrong.
EXPORT="$WORK/throttled_export.json"
ROSTER_SOURCE_CMD="$WORK/roster_mixed.sh" "$BRAKE" throttled --out "$EXPORT" >/dev/null 2>&1
check "9k  --out writes the document" "$(jq -r 'keys|join(",")' "$EXPORT" 2>/dev/null)" "a1"
ROSTER_SOURCE_CMD="false" "$BRAKE" throttled --out "$EXPORT" >/dev/null 2>&1
check "9l  a FAILED --out leaves the previous export untouched" "$(jq -r 'keys|join(",")' "$EXPORT" 2>/dev/null)" "a1"
case "$(ls "$WORK"/throttled_export.json.tmp.* 2>/dev/null)" in
  '') ok "9m  no temp file is left behind" ;;
  *)  bad "9m  no temp file is left behind" "$(ls "$WORK"/throttled_export.json.tmp.* 2>/dev/null)" ;;
esac

# The export is a READ. It must never reach the agent write path, whatever the
# pace signal says — `plan`/`apply` are the only things allowed to write agents.
: > "$WORK/captured.tsv"
PACE_SOURCE_CMD="cat $WORK/pace_hot.json" AGENT_WRITE_CMD="$WORK/capture.sh" CAPTURE_FILE="$WORK/captured.tsv" \
  ROSTER_SOURCE_CMD="$WORK/roster_mixed.sh" "$BRAKE" throttled >/dev/null 2>&1
check "9n  the export writes no agent" "$(wc -l < "$WORK/captured.tsv" | tr -d ' ')" "0"

rc=0; (ROSTER_SOURCE_CMD="$WORK/roster_mixed.sh" "$BRAKE" throttled --bogus) >/dev/null 2>&1 || rc=$?
check "9o  an unknown flag is refused (exit 2)" "$rc" "2"

# ===========================================================================
echo "== 10. TOG-490: the default is a reserve, and a passed target is not a release =="
# Everything above pins PACE_TARGET so the ladder can be tested without the
# default moving under it — which leaves the default itself unasserted, and
# that is how it sat at 0.97 unexamined until TOG-490. These measure it through
# the tool's own arithmetic rather than by grepping the source, because a
# `grep PACE_TARGET quota_brake.sh` passes just as happily on a line nothing
# reads.

pace_field() {  # $1: field, $2: pace fixture, $3: PACE_TARGET or "" for the default
  base_env "$2"
  if [[ -n "${3:-}" ]]; then export PACE_TARGET="$3"; else unset PACE_TARGET; fi
  "$BRAKE" pace 2>/dev/null | jq -r --arg f "$1" '.[$f]'
}

# (0.90 - 0.62) / 4.02 = 0.069652
check "10a the DEFAULT target computes sustainable at 0.90" \
      "$(pace_field need pace_hot.json "" | jq -r '.*10000|round/10000')" "0.0697"
# The baseline that gives 10a its meaning. Without it, 10a passes on any build
# where `need` happens to come out at 0.0697 for some other reason — including
# one where PACE_TARGET is ignored entirely and a constant was folded in.
check "10b ...and it is genuinely read: 0.97 still gives the old 0.0871" \
      "$(pace_field need pace_hot.json 0.97 | jq -r '.*10000|round/10000')" "0.0871"

# THE failure mode that would make a low target dangerous. Once `weekly` passes
# the target, `sustainable` goes NEGATIVE — and a naive burn/need is then also
# negative, which sails under the ladder's `ratio <= 1.0` rung and RELEASES the
# brake at the exact moment the week is already overspent. burn is deliberately
# tiny here (0.02) so the naive answer would be -1.2, i.e. a comfortable
# RELEASE, rather than something that lands on LEVEL3 by luck.
cat > "$WORK/pace_passed.json" <<'EOF'
{"accounts":[{"name":"passed@example.com","burn_per_day":0.02,"weekly":0.95,"days_left":3.00}],"pool_verdict":"THROTTLE"}
EOF
check "10c a passed target pins the ratio to 999, not to a negative number" \
      "$(pace_field ratio pace_passed.json "")" "999"
check "10c2 ...and selects LEVEL3 — never RELEASE" \
      "$(pace_field verdict pace_passed.json "")" "LEVEL3"
# ...and the owner's hard requirement still holds under that new condition:
# LEVEL3 floors concurrency at 1, it does not reach 0 or touch wakeOnDemand.
base_env pace_passed.json; unset PACE_TARGET
plan="$("$BRAKE" plan 2>/dev/null)"
check "10d ...with the floor intact: a baseline-20 agent keeps 1 run, not 0" \
      "$(awk -F'\t' '$3=="Bulk Worker"{print $5}' <<<"$plan")" "1"

# The default-target checks above deliberately unset PACE_TARGET. Restore the
# ladder fixture before calling the sourced pure functions below: unlike a real
# quota_brake.sh process, this suite shares one shell across every section.
base_env

# ===========================================================================
echo
echo "== 10. the five-hour bucket and the per-agent ceiling (TOG-477) =="
#
# The incident these assertions are cut from: on 2026-08-25 the company ran
# 47-wide and both accounts' 5-hour buckets went from clear to exhausted in 89
# minutes, hard-429ing a run mid-turn — while `unused_weekly_remaining` was
# still 0.31 and the weekly term was comfortable throughout. Every fixture
# below carries the real pooled `five_hour` series from that morning.

# Pool = sum of the accounts' five_hour; capacity = the account count.
# 0.34 -> 1.98 of 2.00 across 106 minutes at 1-47 runs in flight.
cat > "$WORK/fh_incident.jsonl" <<'EOF'
{"ts":"2026-08-25T08:58:00Z","runs_in_flight":1,"accounts":[{"name":"a","five_hour":0.34,"weekly":0.62,"days_left":4.02,"burn_per_day":0.02},{"name":"b","five_hour":0.00,"weekly":0.10,"days_left":4.0,"burn_per_day":null}]}
{"ts":"2026-08-25T09:29:00Z","runs_in_flight":16,"accounts":[{"name":"a","five_hour":0.42,"weekly":0.62,"days_left":4.02,"burn_per_day":0.02},{"name":"b","five_hour":0.00,"weekly":0.10,"days_left":4.0,"burn_per_day":null}]}
{"ts":"2026-08-25T09:44:00Z","runs_in_flight":28,"accounts":[{"name":"a","five_hour":0.71,"weekly":0.62,"days_left":4.02,"burn_per_day":0.02},{"name":"b","five_hour":0.00,"weekly":0.10,"days_left":4.0,"burn_per_day":null}]}
{"ts":"2026-08-25T09:59:00Z","runs_in_flight":26,"accounts":[{"name":"a","five_hour":0.97,"weekly":0.62,"days_left":4.02,"burn_per_day":0.02},{"name":"b","five_hour":0.00,"weekly":0.10,"days_left":4.0,"burn_per_day":null}]}
{"ts":"2026-08-25T10:14:00Z","runs_in_flight":37,"accounts":[{"name":"a","five_hour":0.98,"weekly":0.62,"days_left":4.02,"burn_per_day":0.02},{"name":"b","five_hour":0.31,"weekly":0.10,"days_left":4.0,"burn_per_day":null}]}
{"ts":"2026-08-25T10:29:00Z","runs_in_flight":41,"accounts":[{"name":"a","five_hour":0.98,"weekly":0.62,"days_left":4.02,"burn_per_day":0.02},{"name":"b","five_hour":0.69,"weekly":0.10,"days_left":4.0,"burn_per_day":null}]}
{"ts":"2026-08-25T10:44:00Z","runs_in_flight":47,"accounts":[{"name":"a","five_hour":0.99,"weekly":0.62,"days_left":4.02,"burn_per_day":0.02},{"name":"b","five_hour":0.99,"weekly":0.10,"days_left":4.0,"burn_per_day":null}]}
EOF

# The rolling window EXPIRING, at zero runs in flight. Measured 14:30Z-15:45Z:
# the pool fell 1.99 -> 1.00 -> 0.00 in two cliffs while nothing was running.
cat > "$WORK/fh_expiry.jsonl" <<'EOF'
{"ts":"2026-08-25T14:30:00Z","runs_in_flight":0,"accounts":[{"name":"a","five_hour":0.99,"weekly":0.62,"days_left":4.02,"burn_per_day":0.02},{"name":"b","five_hour":1.00,"weekly":0.10,"days_left":4.0,"burn_per_day":null}]}
{"ts":"2026-08-25T15:00:00Z","runs_in_flight":0,"accounts":[{"name":"a","five_hour":0.00,"weekly":0.62,"days_left":4.02,"burn_per_day":0.02},{"name":"b","five_hour":1.00,"weekly":0.10,"days_left":4.0,"burn_per_day":null}]}
{"ts":"2026-08-25T15:45:00Z","runs_in_flight":0,"accounts":[{"name":"a","five_hour":0.00,"weekly":0.62,"days_left":4.02,"burn_per_day":0.02},{"name":"b","five_hour":0.00,"weekly":0.10,"days_left":4.0,"burn_per_day":null}]}
EOF

FH="$(five_hour_ratio "$(cat "$WORK/fh_incident.jsonl")")"
check "10a  the incident derives a 5h reading" "$(jq -r '.source' <<<"$FH")" "derived"
check "10a2 ...pooled across BOTH accounts, not per-account" "$(jq -r '.pool_used' <<<"$FH")" "1.98"
check "10a3 ...against a capacity equal to the account count" "$(jq -r '.pool_cap' <<<"$FH")" "2"
# 0.31 pool-units per 15 min against a sustainable 0.10 — the issue's own
# arithmetic ("~0.30/15min pooled, ~3x sustainable"), reproduced by the tool.
check "10a4 ...burn is ~3x sustainable" "$(jq -r '.ratio' <<<"$FH")" "3.12"
check "10a5 ...sustainable is DERIVED from the bucket period" "$(jq -r '.sustain_per_15m' <<<"$FH")" "0.1"
# The 429 landed at 10:48:50Z; the last sample before it was 10:44Z.
ex="$(jq -r '.minutes_to_exhaustion' <<<"$FH")"
if [[ "$ex" =~ ^[0-9]+$ ]] && (( ex <= 5 )); then ok "10a6 ...exhaustion is minutes away at 10:44Z (got ${ex}m)"
else bad "10a6 ...exhaustion is minutes away at 10:44Z" "got '$ex'"; fi

# THE INVERSION, and the reason this term exists at all. The weekly figure in
# this fixture is comfortable — burn 0.02/day against a need of 0.087 is ratio
# 0.23, which is RELEASE, which RESTORES every baseline. Meanwhile the 5-hour
# pool is at 1.98 of 2.00. A brake reading only the weekly term hands full
# concurrency back four minutes before a hard 429.
W_ONLY="$(pace_ratio "$(cat "$WORK/fh_incident.jsonl")")"
check "10b  the weekly term alone says RELEASE" "$(verdict_for "$(jq -r '.ratio' <<<"$W_ONLY")")" "RELEASE"
check "10b2 the 5h term alone does NOT" "$(verdict_for "$(jq -r '.ratio' <<<"$FH")")" "LEVEL2"

plan="$( ( base_env; PACE_SOURCE_CMD="cat $WORK/fh_incident.jsonl"; "$BRAKE" plan ) 2>/dev/null )"
check "10b3 ...so the PLAN brakes rather than restoring" \
  "$(awk -F'\t' '$3=="Bulk Worker"{print $1}' <<<"$plan")" "brake"
explain="$( ( base_env; PACE_SOURCE_CMD="cat $WORK/fh_incident.jsonl"; "$BRAKE" plan --explain ) 2>&1 >/dev/null )"
case "$explain" in *"binding term : five_hour"*) ok "10b4 --explain names the binding term";; *) bad "10b4 --explain names the binding term" "$explain";; esac

# NEGATIVE DELTAS ARE NOT BURN. The bucket rolling over is not quota returned
# by work that did not happen; counting it would make the pool read healthiest
# immediately after it had been drained.
FHX="$(five_hour_ratio "$(cat "$WORK/fh_expiry.jsonl")")"
check "10c  a window that only EXPIRES derives zero burn" "$(jq -r '.burn_per_15m' <<<"$FHX")" "0"
check "10c2 ...and never a negative ratio" "$(jq -r '.ratio' <<<"$FHX")" "0"
check "10c3 ...and reports no affordable figure from zero burn" "$(jq -r '.affordable_in_flight' <<<"$FHX")" "null"

# RULE 4 APPLIES TO THIS TERM TOO: unmeasured is not "healthy".
FHN="$(five_hour_ratio '{"ts":"2026-08-25T10:44:00Z","accounts":[{"name":"a","weekly":0.62,"days_left":4.02,"burn_per_day":0.6381}]}')"
check "10d  a single sample cannot derive a 5h reading" "$(jq -r '.source' <<<"$FHN")" "unavailable"
check "10d2 ...and fabricates NO ratio" "$(jq -r '.ratio // "none"' <<<"$FHN")" "none"
case "$(jq -r '.reason' <<<"$FHN")" in *sample*) ok "10d3 ...and says why";; *) bad "10d3 ...and says why" "$(jq -r '.reason' <<<"$FHN")";; esac
FHS="$(FIVE_HOUR_MIN_WINDOW_MIN=999 five_hour_ratio "$(cat "$WORK/fh_incident.jsonl")")"
check "10d4 a too-short window is unavailable, not quiet" "$(jq -r '.source' <<<"$FHS")" "unavailable"

# --- the ceiling: a brake that cannot bind must not exit 0 -----------------
# `maxConcurrentRuns` is enforced PER AGENT and floors at 1, so the concurrency
# a plan produces is the SUM of the caps it leaves behind. On the real roster
# that sum (48) exceeds what the pool affords (~11) at every rung of the
# ladder, and before this check the tool printed 42 `brake` lines and exited 0.
out="$( ( base_env; PACE_SOURCE_CMD="cat $WORK/fh_incident.jsonl"; "$BRAKE" plan ) 2>&1 >/dev/null )"
rc=0; ( base_env; PACE_SOURCE_CMD="cat $WORK/fh_incident.jsonl"; "$BRAKE" plan ) >/dev/null 2>&1 || rc=$?
case "$out" in *"company-wide floor of"*) ok "10e  the plan reports a company-wide floor";; *) bad "10e  the plan reports a company-wide floor" "$out";; esac
case "$out" in *"affords"*) ok "10e2 ...next to what the 5h bucket affords";; *) bad "10e2 ...next to what the 5h bucket affords" "$out";; esac
# THE STANDARD FIXTURE IS ITSELF INSUFFICIENT, and that is worth pinning
# rather than working around: its Critical Holder is exempt at a cap of 20, so
# 20 of the floor sits on an agent the brake may not touch and no rung clears
# it. The verdict must blame the untouchable part, not the brakeable one.
case "$out" in *"21 on agents the brake may not touch"*) ok "10e3 the floor names its untouchable part";; *) bad "10e3 the floor names its untouchable part" "$out";; esac

# A roster that genuinely FITS must NOT cry insufficient. A ceiling check that
# fires on every plan is noise, and noise is how the real one gets ignored.
{ echo '#!/usr/bin/env bash'
  for i in 1 2 3; do
    printf "printf 'c%s\\tPlain %s\\tidle\\ttrue\\t2\\t\\t0\\t%%s\\n' '%s'\n" "$i" "$i" "$CFG_PLAIN"
  done
} > "$WORK/roster_fits.sh"; chmod +x "$WORK/roster_fits.sh"
out="$( ( base_env; PACE_SOURCE_CMD="cat $WORK/fh_incident.jsonl"; ROSTER_SOURCE_CMD="$WORK/roster_fits.sh"; "$BRAKE" plan ) 2>&1 >/dev/null )"
rc=0; ( base_env; PACE_SOURCE_CMD="cat $WORK/fh_incident.jsonl"; ROSTER_SOURCE_CMD="$WORK/roster_fits.sh"; "$BRAKE" plan ) >/dev/null 2>&1 || rc=$?
case "$out" in *INSUFFICIENT*) bad "10e3b a plan that FITS is not INSUFFICIENT" "$out";; *) ok "10e3b a plan that FITS is not INSUFFICIENT";; esac
check "10e4 ...and exits 0" "$rc" "0"

# A roster the brake provably cannot bind: 40 brakeable agents floor at 40
# concurrent runs against a pool that affords ~11.
{ echo '#!/usr/bin/env bash'
  for i in $(seq 1 40); do
    printf "printf 'b%s\\\\tWorker %s\\\\tidle\\\\ttrue\\\\t2\\\\t\\\\t0\\\\t%%s\\\\n' '%s'\n" "$i" "$i" "$CFG_PLAIN"
  done
} > "$WORK/roster_big.sh"; chmod +x "$WORK/roster_big.sh"

rc=0; out="$( ( base_env; PACE_SOURCE_CMD="cat $WORK/fh_incident.jsonl"; ROSTER_SOURCE_CMD="$WORK/roster_big.sh"; "$BRAKE" plan ) 2>&1 >/dev/null )"
rc=0; ( base_env; PACE_SOURCE_CMD="cat $WORK/fh_incident.jsonl"; ROSTER_SOURCE_CMD="$WORK/roster_big.sh"; "$BRAKE" plan ) >/dev/null 2>&1 || rc=$?
check "10f  a plan that cannot bind exits 4, not 0" "$rc" "4"
case "$out" in *INSUFFICIENT*) ok "10f2 ...and says INSUFFICIENT";; *) bad "10f2 ...and says INSUFFICIENT" "$out";; esac
case "$out" in *"PER AGENT"*) ok "10f3 ...naming per-agent enforcement as the reason";; *) bad "10f3 ...naming per-agent enforcement as the reason" "$out";; esac
# Exit 4 is a REPORT, not a refusal: the plan is still correct and still
# applied, so every agent must still appear in it.
plan="$( ( base_env; PACE_SOURCE_CMD="cat $WORK/fh_incident.jsonl"; ROSTER_SOURCE_CMD="$WORK/roster_big.sh"; "$BRAKE" plan ) 2>/dev/null )"
check "10f4 ...while still planning every agent" "$(grep -c '^brake' <<<"$plan")" "40"

# A WRITE FAILURE MUST NOT BE MASKED BY THE CEILING REPORT. A partially applied
# plan is the more urgent of the two facts, and exit 4 would hide it behind a
# condition the operator can do nothing about.
printf '#!/usr/bin/env bash\nexit 1\n' > "$WORK/write_fail.sh"; chmod +x "$WORK/write_fail.sh"
rc=0; ( base_env; PACE_SOURCE_CMD="cat $WORK/fh_incident.jsonl"; ROSTER_SOURCE_CMD="$WORK/roster_big.sh"
        AGENT_WRITE_CMD="$WORK/write_fail.sh"; "$BRAKE" apply --yes ) >/dev/null 2>&1 || rc=$?
check "10g  a write failure outranks the ceiling report" "$rc" "1"

# The 5h term must never reach the write path on its own account.
: > "$WORK/captured.tsv"
( base_env; PACE_SOURCE_CMD="cat $WORK/fh_incident.jsonl"; "$BRAKE" plan ) >/dev/null 2>&1
check "10h  plan still writes no agent" "$(wc -l < "$WORK/captured.tsv" | tr -d ' ')" "0"

# ===========================================================================
echo
echo "passed: $PASS   failed: $FAIL"
(( FAIL == 0 )) || exit 1
# A suite that asserted nothing must not report success — the same rule the
# tool under test enforces on itself.
(( PASS >= 95 )) || { echo "REFUSED: only $PASS assertions ran; the suite did not execute." >&2; exit 1; }
echo "ALL GREEN"
