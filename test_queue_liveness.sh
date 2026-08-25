#!/usr/bin/env bash
# ===========================================================================
# test_queue_liveness.sh — offline suite for the routing liveness precondition
# and the stall alarm (TOG-390).
#
# No database, no network, no credentials: liveness arrives through
# LIVENESS_SOURCE_CMD, exactly as notification arrives through
# REQUEST_NOTIFY_CMD in the sibling suites. That is what lets CI run this.
#
# WHAT THIS SUITE IS BUILT TO CATCH, beyond the happy path:
#
#  * A regression to the LYING FIELD. `runtime_config->>'wakeOnDemand'` reads
#    NULL for all 144 agents on this company, so a probe that used the
#    top-level path would call the entire dormant roster reachable and every
#    naive test would still pass. Section 2 pins the unset case explicitly so
#    "unset" can never quietly become "fine".
#
#  * A GUESSED CAUSE. Throttled and disabled are indistinguishable without the
#    pacer file. Section 3 asserts that absent the file the cause is
#    `undetermined` — never `disabled` — because mislabelling a throttled
#    agent invites someone to reassign its work permanently over a ten-minute
#    quota brake.
#
#  * A MONITOR THAT READS GREEN WHILE BLIND. Section 5 asserts the unmeasured
#    paths exit 5, not 0. Zero findings from zero rows examined is "never
#    ran", not "clean".
#
#  * ADJACENCY. Several of these inputs would also be caught by a neighbouring
#    guard, which is how an exit-code-only assertion goes green for the wrong
#    reason. Every verdict assertion below pins the CAUSE string, not just the
#    exit status, so a refusal from the wrong branch fails the test.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/queue_liveness.sh"
PASS=0; FAIL=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# HERMETIC BY DEFAULT (TOG-401). The tool's second discriminator defaults to
# `quota_brake.sh throttled`, which reaches for Postgres. Left at its default,
# every `QUOTA_PACER_THROTTLE_FILE=/nonexistent` assertion below would be
# asserting "undetermined" only because THIS box has no database — and would
# quietly start answering, and possibly flipping, on a box that does. Pinned
# empty here so "no file" really means "no discriminator at all"; §3b sets it
# deliberately and is the only place it is non-empty.
export THROTTLE_SOURCE_CMD=""

ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# assert_verdict <label> <expected_exit> <expected_verdict> <expected_cause> <stdout> <actual_exit>
assert_verdict() {
  local label="$1" xrc="$2" xv="$3" xc="$4" out="$5" rc="$6"
  local v c; IFS=$'\t' read -r v c _ _ _ <<<"$out"
  if [[ "$rc" == "$xrc" && "$v" == "$xv" && "$c" == "$xc" ]]; then ok "$label"
  else bad "$label" "expected rc=$xrc verdict=$xv cause=$xc; got rc=$rc verdict=$v cause=$c"; fi
}

# A fake liveness source. Emits the four-field TSV the tool expects.
# $1 wakeOnDemand, $2 lastRun, $3 skipped, $4 total
mk_source() {
  local f="$WORK/src_$$_$RANDOM.sh"
  cat > "$f" <<EOF
#!/usr/bin/env bash
printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4"
EOF
  chmod +x "$f"; printf '%s' "$f"
}

echo "== 1. the ordinary verdicts =="

SRC="$(mk_source true 2026-08-25T04:00:00Z 0 12)"
out="$(LIVENESS_SOURCE_CMD="$SRC" "$TOOL" probe --agent A1)"; rc=$?
assert_verdict "wakeOnDemand=true with no refusals is reachable (exit 0)" 0 reachable wake_on_demand_enabled "$out" "$rc"

SRC="$(mk_source false 2026-08-24T04:00:00Z 300 300)"
out="$(LIVENESS_SOURCE_CMD="$SRC" QUOTA_PACER_THROTTLE_FILE=/nonexistent "$TOOL" probe --agent A2)"; rc=$?
assert_verdict "wakeOnDemand=false is dormant and does NOT route (exit 4)" 4 dormant undetermined "$out" "$rc"

echo "== 2. the lying field: unset must not read as fine =="

# THE REGRESSION THIS PINS. If someone repoints the query at the top-level
# `runtime_config->>'wakeOnDemand'`, every agent returns unset. With refusals
# on record the tool must still call that dormant — the recorded refusal is an
# ATTEMPT and outranks a missing flag.
SRC="$(mk_source '' 2026-08-24T04:00:00Z 3369 3369)"
out="$(LIVENESS_SOURCE_CMD="$SRC" "$TOOL" probe --agent A3)"; rc=$?
assert_verdict "unset + observed refusals is dormant, not reachable" 4 dormant refused_wakes_observed "$out" "$rc"

# Unset with nothing observed is genuinely unknown. Not reachable, not dormant.
SRC="$(mk_source '' '' 0 0)"
out="$(LIVENESS_SOURCE_CMD="$SRC" "$TOOL" probe --agent A4)"; rc=$?
assert_verdict "unset with nothing observed is unknown (exit 5), never reachable" 5 unknown wake_on_demand_unset "$out" "$rc"

# The failure reason outranks the flag in the other direction too: a config
# that claims wakeable while the platform records refusals is not wakeable.
SRC="$(mk_source true 2026-08-24T04:00:00Z 500 500)"
out="$(LIVENESS_SOURCE_CMD="$SRC" "$TOOL" probe --agent A5)"; rc=$?
assert_verdict "flag says enabled but wakes are refused => dormant" 4 dormant refused_despite_enabled_flag "$out" "$rc"

echo "== 3. throttled is not disabled =="

THROTTLE="$WORK/throttled.json"

printf '["A6"]\n' > "$THROTTLE"
SRC="$(mk_source false 2026-08-24T04:00:00Z 10 10)"
out="$(LIVENESS_SOURCE_CMD="$SRC" QUOTA_PACER_THROTTLE_FILE="$THROTTLE" "$TOOL" probe --agent A6)"; rc=$?
assert_verdict "an agent named in the pacer file is 'throttled'" 4 dormant throttled "$out" "$rc"

printf '["SOMEONE_ELSE"]\n' > "$THROTTLE"
out="$(LIVENESS_SOURCE_CMD="$SRC" QUOTA_PACER_THROTTLE_FILE="$THROTTLE" "$TOOL" probe --agent A7)"; rc=$?
assert_verdict "absent from a READABLE pacer file is 'disabled'" 4 dormant disabled "$out" "$rc"

# The load-bearing one. With no discriminator the tool must say so rather than
# defaulting to 'disabled' — that default is what gets a throttled agent's work
# permanently reassigned.
out="$(LIVENESS_SOURCE_CMD="$SRC" QUOTA_PACER_THROTTLE_FILE=/nonexistent "$TOOL" probe --agent A8)"; rc=$?
assert_verdict "no pacer file => 'undetermined', NOT 'disabled'" 4 dormant undetermined "$out" "$rc"

# An unparseable file is also undetermined. A corrupt discriminator must not
# harden into a confident answer.
printf 'not json at all\n' > "$THROTTLE"
out="$(LIVENESS_SOURCE_CMD="$SRC" QUOTA_PACER_THROTTLE_FILE="$THROTTLE" "$TOOL" probe --agent A9)"; rc=$?
assert_verdict "an unparseable pacer file => 'undetermined'" 4 dormant undetermined "$out" "$rc"

echo "== 3b. the second discriminator: the brake's own throttle export (TOG-401) =="

# A stand-in for `quota_brake.sh throttled`. The real one is exercised by
# test_quota_brake.sh §9; what is pinned HERE is that queue_liveness consumes
# the shape, honours the precedence, and degrades the right way.
mk_throttle_cmd() {
  local f="$WORK/throttlecmd_$$_$RANDOM.sh"
  { echo '#!/usr/bin/env bash'; printf '%s\n' "$1"; } > "$f"
  chmod +x "$f"; printf '%s' "$f"
}

OBJ='{"A20":{"agentId":"A20","name":"Braked One","level":"LEVEL3","cap":1,"baseline":20,"tool":"quota_brake.sh"}}'

# THE ACCEPTANCE CRITERION, first half. With no host pacer file at all — the
# state every agent container is in — a throttled agent is now named as
# throttled instead of reading `undetermined`.
TCMD="$(mk_throttle_cmd "printf '%s\n' '$OBJ'")"
SRC="$(mk_source false 2026-08-24T04:00:00Z 10 10)"
out="$(LIVENESS_SOURCE_CMD="$SRC" QUOTA_PACER_THROTTLE_FILE=/nonexistent THROTTLE_SOURCE_CMD="$TCMD" "$TOOL" probe --agent A20)"; rc=$?
assert_verdict "3b1 a disabled agent IN the brake export is 'throttled'" 4 dormant throttled "$out" "$rc"

# THE ACCEPTANCE CRITERION, second half — and the one that has to be earned.
# `disabled` is only allowed because a source ANSWERED and did not name this
# agent. Same command, same shape, different agent.
out="$(LIVENESS_SOURCE_CMD="$SRC" QUOTA_PACER_THROTTLE_FILE=/nonexistent THROTTLE_SOURCE_CMD="$TCMD" "$TOOL" probe --agent A21)"; rc=$?
assert_verdict "3b2 a disabled agent ABSENT from a working export is 'disabled'" 4 dormant disabled "$out" "$rc"

# THE FAILURE THAT MATTERS MOST. A source that exits non-zero must NOT be read
# as an empty set — an empty set means "nobody is throttled", which licenses
# 3b2's `disabled`. A broken brake must produce `undetermined`, i.e. it must be
# indistinguishable from having no source at all.
TCMD_DEAD="$(mk_throttle_cmd 'echo "boom" >&2; exit 5')"
out="$(LIVENESS_SOURCE_CMD="$SRC" QUOTA_PACER_THROTTLE_FILE=/nonexistent THROTTLE_SOURCE_CMD="$TCMD_DEAD" "$TOOL" probe --agent A22)"; rc=$?
assert_verdict "3b3 a FAILING export is 'undetermined', never 'disabled'" 4 dormant undetermined "$out" "$rc"

# A source that exits 0 with nothing on stdout is the same claim as a crash:
# it did not answer. Distinct from 3b5, where it answered "nobody".
TCMD_MUTE="$(mk_throttle_cmd 'exit 0')"
out="$(LIVENESS_SOURCE_CMD="$SRC" QUOTA_PACER_THROTTLE_FILE=/nonexistent THROTTLE_SOURCE_CMD="$TCMD_MUTE" "$TOOL" probe --agent A23)"; rc=$?
assert_verdict "3b4 a SILENT export (exit 0, no output) is 'undetermined'" 4 dormant undetermined "$out" "$rc"

# BASELINE for 3b3/3b4, so those two cannot pass merely because everything in
# this section reads undetermined. An explicit empty object is a real answer.
TCMD_EMPTY="$(mk_throttle_cmd "printf '{}\n'")"
out="$(LIVENESS_SOURCE_CMD="$SRC" QUOTA_PACER_THROTTLE_FILE=/nonexistent THROTTLE_SOURCE_CMD="$TCMD_EMPTY" "$TOOL" probe --agent A24)"; rc=$?
assert_verdict "3b5 BASELINE an EMPTY export is a real answer: 'disabled'" 4 dormant disabled "$out" "$rc"

# PRECEDENCE. A readable file wins, so the seam the acceptance criterion names
# as the integration point still overrides everything. The file says this agent
# is not throttled; the command says it is. The file must win.
PFILE="$WORK/precedence.json"
printf '["SOMEONE_ELSE"]\n' > "$PFILE"
out="$(LIVENESS_SOURCE_CMD="$SRC" QUOTA_PACER_THROTTLE_FILE="$PFILE" THROTTLE_SOURCE_CMD="$TCMD" "$TOOL" probe --agent A20)"; rc=$?
assert_verdict "3b6 a readable FILE outranks the command" 4 dormant disabled "$out" "$rc"

echo "== 3c. throttling is no longer dormancy (TOG-419 changed the mechanism) =="

# THE SHAPE THAT ACTUALLY OCCURS NOW. The brake may not write
# wakeOnDemand=false; it lowers maxConcurrentRuns and leaves the agent
# wakeable. So a throttled agent has wakeOnDemand=true, and the tool must call
# it REACHABLE — its wakes are queued and drained, not refused — while still
# naming the cause `throttled` so nobody reassigns its work over a quota brake.
SRC_OK="$(mk_source true 2026-08-25T04:00:00Z 0 12)"
out="$(LIVENESS_SOURCE_CMD="$SRC_OK" QUOTA_PACER_THROTTLE_FILE=/nonexistent THROTTLE_SOURCE_CMD="$TCMD" "$TOOL" probe --agent A20)"; rc=$?
assert_verdict "3c1 a concurrency-throttled agent is REACHABLE, cause 'throttled'" 0 reachable throttled "$out" "$rc"

# BASELINE: the same wakeable agent absent from the export is unremarkable. If
# 3c1 passed because every wakeable agent now reads `throttled`, this fails.
out="$(LIVENESS_SOURCE_CMD="$SRC_OK" QUOTA_PACER_THROTTLE_FILE=/nonexistent THROTTLE_SOURCE_CMD="$TCMD" "$TOOL" probe --agent A25)"; rc=$?
assert_verdict "3c2 BASELINE a wakeable agent NOT in the export is unremarkable" 0 reachable wake_on_demand_enabled "$out" "$rc"

# Recorded refusals still outrank everything, including a throttle marker. An
# agent the brake claims it is merely pacing, which the platform is in fact
# refusing to wake, is dormant. The throttle lookup must not launder that.
SRC_REFUSED="$(mk_source true 2026-08-24T04:00:00Z 500 500)"
out="$(LIVENESS_SOURCE_CMD="$SRC_REFUSED" QUOTA_PACER_THROTTLE_FILE=/nonexistent THROTTLE_SOURCE_CMD="$TCMD" "$TOOL" probe --agent A20)"; rc=$?
assert_verdict "3c3 observed refusals outrank a 'throttled' marker" 4 dormant refused_despite_enabled_flag "$out" "$rc"

# --explain must not silently lose the distinction it exists to draw.
out="$(LIVENESS_SOURCE_CMD="$SRC_OK" QUOTA_PACER_THROTTLE_FILE=/nonexistent THROTTLE_SOURCE_CMD="$TCMD" "$TOOL" probe --agent A20 --explain 2>&1)"
case "$out" in
  *"still REACHABLE"*) ok "3c4 --explain says a throttled agent is still reachable" ;;
  *) bad "3c4 --explain says a throttled agent is still reachable" "$out" ;;
esac
case "$out" in
  *"LEVEL3"*) ok "3c5 --explain surfaces the brake level from the export" ;;
  *) bad "3c5 --explain surfaces the brake level from the export" "$out" ;;
esac

echo "== 4. the alarm fires on a request routed at a dormant reviewer =="

Q="$WORK/queue.jsonl"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RECENT="$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)"

# One pending request, routed at a dormant leader, submitted just now — so the
# stall clock (trigger b) is NOT what fires. This isolates trigger (a).
cat > "$Q" <<EOF
{"event":"request.submitted","requestId":"R-1","status":"pending","responsibleLeaderAgentId":"DORMANT","responsibleLeader":"P1_PRESIDENT_COO","submittedAt":"$NOW"}
{"event":"request.reviewed","requestId":"R-0","status":"approved","at":"$RECENT"}
EOF

SRC="$(mk_source false 2026-08-24T04:00:00Z 3369 3369)"
out="$(QUEUE="$Q" LIVENESS_SOURCE_CMD="$SRC" QUOTA_PACER_THROTTLE_FILE=/nonexistent "$TOOL" alarm 2>&1)"; rc=$?
if [[ "$rc" == 3 ]] && grep -q "R-1 is routed at P1_PRESIDENT_COO" <<<"$out" && grep -qi "cannot receive" <<<"$out"; then
  ok "a request at a dormant reviewer raises ALARM (exit 3) and names the request and reviewer"
else
  bad "alarm on dormant reviewer" "rc=$rc out=$(tr '\n' '|' <<<"$out")"
fi

# THE BASELINE. Without this, the assertion above is unattributable: the alarm
# might fire for ANY queue. Same queue, same code, reviewer now reachable =>
# must go quiet. If this does not pass, the test above proves nothing.
SRC_OK="$(mk_source true 2026-08-25T04:00:00Z 0 5)"
out="$(QUEUE="$Q" LIVENESS_SOURCE_CMD="$SRC_OK" "$TOOL" alarm 2>&1)"; rc=$?
if [[ "$rc" == 0 ]] && grep -q "quiet" <<<"$out"; then
  ok "BASELINE: the same queue with a reachable reviewer is quiet (exit 0)"
else
  bad "BASELINE quiet case" "rc=$rc out=$(tr '\n' '|' <<<"$out")"
fi

echo "== 5. the alarm fires on nothing happening, and never reads green while blind =="

OLD="$(date -u -d '30 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-30H +%Y-%m-%dT%H:%M:%SZ)"

# Pending work, reachable reviewer, but NO decision for 30h. Trigger (b) alone:
# the reviewer is fine, so if this fires it can only be the stall clock.
cat > "$Q" <<EOF
{"event":"request.submitted","requestId":"R-2","status":"pending","responsibleLeaderAgentId":"LIVE","responsibleLeader":"P2_LEAD","submittedAt":"$OLD"}
{"event":"request.reviewed","requestId":"R-0","status":"approved","at":"$OLD"}
EOF
out="$(QUEUE="$Q" LIVENESS_SOURCE_CMD="$SRC_OK" "$TOOL" alarm 2>&1)"; rc=$?
if [[ "$rc" == 3 ]] && grep -q "nothing has been decided" <<<"$out"; then
  ok "pending work + no decisions inside the threshold raises ALARM even with a healthy reviewer"
else
  bad "stall alarm" "rc=$rc out=$(tr '\n' '|' <<<"$out")"
fi

# BASELINE for the stall clock: identical queue, threshold raised above the
# age, must go quiet. Pins the firing above to the CLOCK and not to the queue.
out="$(QUEUE="$Q" LIVENESS_SOURCE_CMD="$SRC_OK" "$TOOL" alarm --stall-hours 100 2>&1)"; rc=$?
if [[ "$rc" == 0 ]]; then ok "BASELINE: same queue under a wider threshold is quiet"
else bad "BASELINE stall threshold" "rc=$rc out=$(tr '\n' '|' <<<"$out")"; fi

# A gate that has NEVER decided anything must not be exempted by the absence of
# the very decisions it is failing to produce.
cat > "$Q" <<EOF
{"event":"request.submitted","requestId":"R-3","status":"pending","responsibleLeaderAgentId":"LIVE","responsibleLeader":"P2_LEAD","submittedAt":"$OLD"}
EOF
out="$(QUEUE="$Q" LIVENESS_SOURCE_CMD="$SRC_OK" "$TOOL" alarm 2>&1)"; rc=$?
if [[ "$rc" == 3 ]] && grep -q "NO request has ever been decided" <<<"$out"; then
  ok "a queue that has never decided anything alarms rather than being exempt"
else
  bad "never-decided queue" "rc=$rc out=$(tr '\n' '|' <<<"$out")"
fi

# An idle queue is not a stalled queue. Nothing pending => quiet, so the tool
# does not train its readers to ignore it.
cat > "$Q" <<EOF
{"event":"request.submitted","requestId":"R-4","status":"pending","responsibleLeaderAgentId":"LIVE","responsibleLeader":"P2_LEAD","submittedAt":"$OLD"}
{"event":"request.reviewed","requestId":"R-4","status":"approved","at":"$OLD"}
EOF
out="$(QUEUE="$Q" LIVENESS_SOURCE_CMD="$SRC_OK" "$TOOL" alarm 2>&1)"; rc=$?
if [[ "$rc" == 0 ]]; then ok "an idle queue with nothing pending is quiet, not alarming"
else bad "idle queue" "rc=$rc out=$(tr '\n' '|' <<<"$out")"; fi

echo "== 5b. unmeasured is not clean =="

# The liveness source fails outright. Exactly ONE input is broken — the queue,
# the reviewer id and the clock are all intact — so a refusal here can only be
# the unreachable source, not an over-determined failure.
FAILSRC="$WORK/failsrc.sh"; printf '#!/usr/bin/env bash\nexit 1\n' > "$FAILSRC"; chmod +x "$FAILSRC"

cat > "$Q" <<EOF
{"event":"request.submitted","requestId":"R-5","status":"pending","responsibleLeaderAgentId":"WHO","responsibleLeader":"P2_LEAD","submittedAt":"$NOW"}
{"event":"request.reviewed","requestId":"R-0","status":"approved","at":"$RECENT"}
EOF
out="$(QUEUE="$Q" LIVENESS_SOURCE_CMD="$FAILSRC" "$TOOL" alarm 2>&1)"; rc=$?
if [[ "$rc" == 5 ]] && grep -qi "NOT a clean result" <<<"$out"; then
  ok "an unreachable liveness source exits 5 (UNKNOWN), never 0"
else
  bad "unmeasured must not be green" "rc=$rc out=$(tr '\n' '|' <<<"$out")"
fi

out="$(QUEUE="$WORK/no-such-queue.jsonl" LIVENESS_SOURCE_CMD="$SRC_OK" "$TOOL" alarm 2>&1)"; rc=$?
if [[ "$rc" == 5 ]]; then ok "a missing queue file is UNKNOWN (exit 5), not 'no problems found'"
else bad "missing queue" "rc=$rc out=$(tr '\n' '|' <<<"$out")"; fi

echo "== 6. the precondition gate =="

SRC="$(mk_source false 2026-08-24T04:00:00Z 99 99)"
out="$(LIVENESS_SOURCE_CMD="$SRC" QUOTA_PACER_THROTTLE_FILE=/nonexistent "$TOOL" precondition --agent A10 --role P1_PRESIDENT_COO 2>&1)"; rc=$?
if [[ "$rc" == 4 ]] && grep -q "DO NOT ROUTE" <<<"$out"; then
  ok "precondition refuses to route at a dormant agent (exit 4)"
else bad "precondition dormant" "rc=$rc out=$out"; fi

out="$(LIVENESS_SOURCE_CMD="$FAILSRC" "$TOOL" precondition --agent A11 2>&1)"; rc=$?
if [[ "$rc" == 5 ]] && grep -qi "not reachable" <<<"$out"; then
  ok "precondition treats unmeasured as do-not-route (exit 5)"
else bad "precondition unmeasured" "rc=$rc out=$out"; fi

out="$(LIVENESS_SOURCE_CMD="$SRC_OK" "$TOOL" precondition --agent A12 --role P2_LEAD 2>&1)"; rc=$?
if [[ "$rc" == 0 ]]; then ok "BASELINE: precondition routes at a reachable agent (exit 0)"
else bad "precondition reachable" "rc=$rc out=$out"; fi

echo "== 7. usage refusals =="

out="$("$TOOL" probe 2>&1)"; rc=$?
[[ "$rc" == 2 ]] && ok "probe with no --agent is refused (exit 2)" || bad "probe arity" "rc=$rc"

out="$("$TOOL" frobnicate 2>&1)"; rc=$?
[[ "$rc" == 2 ]] && ok "an unrecognised subcommand is refused, not silently exit 0" || bad "unknown subcommand" "rc=$rc"

out="$(QUEUE="$Q" "$TOOL" alarm --stall-hours notanumber 2>&1)"; rc=$?
[[ "$rc" == 2 ]] && ok "a non-numeric --stall-hours is refused" || bad "stall-hours validation" "rc=$rc"

echo
echo "queue_liveness: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
