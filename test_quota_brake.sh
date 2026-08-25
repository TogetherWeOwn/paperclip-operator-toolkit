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
echo
echo "passed: $PASS   failed: $FAIL"
(( FAIL == 0 )) || exit 1
# A suite that asserted nothing must not report success — the same rule the
# tool under test enforces on itself.
(( PASS >= 60 )) || { echo "REFUSED: only $PASS assertions ran; the suite did not execute." >&2; exit 1; }
echo "ALL GREEN"
