#!/usr/bin/env bash
# ===========================================================================
# Offline suite for "how does the LEADER learn?" — TOG-317
# ===========================================================================
# THE CLAIM THIS SUITE EXISTS TO KEEP TRUE.
# docs/responsible-leader.md has said since TOG-194 that a dormant leader is
# "NOT a skip — wake them", and the design's refusal to auto-escalate on a timer
# rests on it: a request may only sit with one approver because that approver is
# reliably TOLD. Nothing did the telling. Measured on origin/main at 4b26243,
# with a recording transport configured and a derived leader resolved:
#
#   $ org_request_queue.sh submit --requester MGR --template E0_SPECIALIST ...
#   SUBMITTED REQ-001 ... responsible leader : DIR [C1_DIRECTOR_BUILDER]
#   $ jq -r .event queue.jsonl          -> request.submitted        (one row)
#   $ cat delivered.jsonl               -> (empty; never invoked)
#   $ org_request_queue.sh notify       -> (no notifications); exit 0
#   $ org_request_queue.sh inbox --for DIR -> (no decisions for DIR)
#
# Both halves were missing — push AND the pull path TOG-254 built precisely so
# a failed push would not be a dead end — and the CI gate for undelivered
# notifications read GREEN, because a notification nobody queued is not an
# undelivered one. That last line is why this needs its own suite rather than a
# line in the runbook: the absence was invisible to every existing check.
#
# WHAT IS ASSERTED SEPARATELY, BECAUSE IT FAILS SEPARATELY.
#   DELIVERY      submit produces a notification addressed to the DERIVED
#                 LEADER, and the leader can also pull it with no transport.
#   NON-INTERFERENCE  the leader's notification must not consume the
#                 REQUESTER's. The two share an outbox, an idempotency guard
#                 and a grouping key, and the natural implementation of either
#                 silently deletes the other.
#   CONTAINMENT   a wake that fails must not block, alter or re-target the
#                 decision — and above all must never walk UP the reporting
#                 line. "The leader didn't answer, tell their manager" is the
#                 approver-shopping this design rejects, wearing a retry's
#                 clothes. It is the most tempting defect available here, so it
#                 gets an adversarial test rather than a comment.
#
# NO DATABASE, NO CREDENTIALS, NO NETWORK — same seams as the sibling suites
# (ORG_SNAPSHOT, PROV, REQUEST_NOTIFY_CMD).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v jq >/dev/null || { echo "ERROR: jq required" >&2; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
ASSERTION_SENTINEL="${TEST_LEADER_NOTIFY_ASSERTION_SENTINEL:-}"
export COMPANY_ID="offline-fixture-not-a-real-company"
export QUEUE="$TMP/queue.jsonl"
export GRANT_LOG="$TMP/grant-log.jsonl"
export DISABLED_TEMPLATES="$TMP/disabled"
export ORG_SNAPSHOT="$TMP/org.tsv"
export PROV="$TMP/stub_provisioner.sh"
DELIVERED="$TMP/delivered.jsonl"
Q="$HERE/org_request_queue.sh"

PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }
note() { printf '        %s\n' "$1"; }
eq()  { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (got '$2', wanted '$3')"; }
has() { grep -q -- "$2" <<<"$1" && ok "$3" || { bad "$3"; note "in: $(head -c 200 <<<"$1")"; }; }
hasnt() { grep -q -- "$2" <<<"$1" && { bad "$3"; note "found: $2"; } || ok "$3"; }

# --- seams ------------------------------------------------------------------
# The ceiling and template catalogs are EXTRACTED from the provisioner, never
# copied: a stub with its own copy keeps answering against yesterday's keys.
build_stub() {
  {
    echo '#!/usr/bin/env bash'
    echo 'set -uo pipefail'
    sed -n "/^CEILING_JSON='{/,/^}'\$/p" "$HERE/org_provisioner.sh"
    sed -n "/^TEMPLATES_JSON='{/,/^}'\$/p" "$HERE/org_provisioner.sh"
    cat <<'STUB'
[[ -n "${CEILING_JSON:-}" ]]   || { echo "stub: failed to extract CEILING_JSON" >&2; exit 90; }
[[ -n "${TEMPLATES_JSON:-}" ]] || { echo "stub: failed to extract TEMPLATES_JSON" >&2; exit 90; }
case "${1:-}" in
  ceiling) jq -r 'to_entries[] | "\(.key)\t\(.value|join(", "))"' <<<"$CEILING_JSON" ;;
  template-keys) jq -r 'to_entries[] | "\(.key)\t\(.value|map(.permissionKey)|join(","))"' <<<"$TEMPLATES_JSON" ;;
  create)
    shift
    caller=""; template=""; title=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --caller) caller="$2"; shift 2;;
        --template) template="$2"; shift 2;;
        --title) title="$2"; shift 2;;
        *) shift;;
      esac
    done
    n="$(wc -l < "$ORG_SNAPSHOT")"
    uuid="$(printf '00000000-0000-4000-8000-%012d' "$n")"
    parent="$(awk -F'\t' -v k="$caller" '($1==k||$2==k){print $1; exit}' "$ORG_SNAPSHOT")"
    printf '%s\tu-new-%s\t%s\tidle\t%s\t%s\n' "$uuid" "$n" "$template" "$parent" "$title" >> "$ORG_SNAPSHOT"
    echo "PROVISIONED $template -> $uuid"
    ;;
  *) echo "stub: unsupported subcommand '${1:-}'" >&2; exit 91;;
esac
STUB
  } > "$PROV"
  chmod +x "$PROV"
  export ORG_SNAPSHOT
}

build_transports() {
  cat > "$TMP/t_ok.sh" <<EOF
#!/usr/bin/env bash
cat >> "$DELIVERED"
echo "delivered-by-stub"
EOF
  cat > "$TMP/t_fail.sh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
echo "transport is down" >&2
exit 7
EOF
  cat > "$TMP/t_hang.sh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
sleep 300
EOF
  cat > "$TMP/t_ignore_term.sh" <<EOF
#!/usr/bin/env bash
cat >/dev/null
: > "$TMP/ignore-term.started"
if [[ -n "\${TEST_LEADER_NOTIFY_DESCENDANT_WATCH:-}" ]]; then
  watch_pid="\$\$"
  watch_sid="\$(WATCH_PID="\$watch_pid" python3 -c 'import os; print(os.getsid(int(os.environ["WATCH_PID"])))')"
  printf '%s %s\n' "\$watch_pid" "\$watch_sid" > "\$TEST_LEADER_NOTIFY_DESCENDANT_WATCH"
fi
trap '' TERM
while :; do
  date +%s%N > "$TMP/ignore-term.heartbeat"
  sleep 0.1
 done
EOF
  cat > "$TMP/t_slow.sh" <<EOF
#!/usr/bin/env bash
cat >/dev/null
: > "$TMP/slow.started"
sleep 6
echo "delivered-after-honest-delay"
EOF
  cat > "$TMP/t_should_not_run.sh" <<EOF
#!/usr/bin/env bash
cat >/dev/null
: > "$TMP/should-not-run"
echo "unexpected-delivery"
EOF
  cat > "$TMP/t_count_calls.sh" <<EOF
#!/usr/bin/env bash
cat >/dev/null
printf 'called\n' >> "$TMP/courier-calls"
echo "delivered-by-counting-stub"
EOF
  # A transport that tries to decide the request it is carrying. Read the id from
  # the payload so the same hostile courier exercises submit-time delivery and a
  # later drain retry, rather than passing because both fixtures happen to use
  # REQ-001.
  cat > "$TMP/t_evil.sh" <<EOF
#!/usr/bin/env bash
payload="\$(cat)"
rid="\$(jq -r '.requestId' <<<"\$payload")"
echo "{\"event\":\"request.reviewed\",\"requestId\":\"\$rid\",\"status\":\"approved\",\"reviewer\":\"EVIL\"}" >> "$QUEUE"
exit 0
EOF
  cat > "$TMP/t_retain_stdout.sh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
(sleep 300) &
echo "parent-exited"
EOF
  cat > "$TMP/t_no_stdin.sh" <<'EOF'
#!/usr/bin/env bash
sleep 300
EOF
  cat > "$TMP/t_detached_mutator.sh" <<'EOF'
#!/usr/bin/env bash
payload="$(cat)"
rid="$(jq -r '.requestId' <<<"$payload")"
setsid bash -c 'sleep 2; printf '\''{"event":"request.reviewed","requestId":"%s","status":"approved","reviewer":"DETACHED"}\n'\'' "$1" >> "$2"' _ "$rid" "$QUEUE" >/dev/null 2>&1 &
echo "detached"
EOF
  cat > "$TMP/t_malformed.sh" <<EOF
#!/usr/bin/env bash
payload="\$(cat)"
printf '{not-json\n' >> "$QUEUE"
echo "malformed"
EOF
  cat > "$TMP/t_cross_request.sh" <<EOF
#!/usr/bin/env bash
payload="\$(cat)"
rid="\$(jq -r 'select(.event=="request.submitted")|.requestId' "$QUEUE" | head -1)"
echo "{\"event\":\"request.reviewed\",\"requestId\":\"\$rid\",\"status\":\"approved\",\"reviewer\":\"CROSS\"}" >> "$QUEUE"
exit 0
EOF
  cat > "$TMP/t_malformed_overlap.sh" <<EOF
#!/usr/bin/env bash
payload="\$(cat)"
: > "$TMP/malformed.started"
sleep 1
printf '{not-json\n' >> "$QUEUE"
echo "malformed"
EOF
  cat > "$TMP/t_assert_standing_queued.sh" <<EOF
#!/usr/bin/env bash
payload="\$(cat)"
rid="\$(jq -r '.requestId' <<<"\$payload")"
count="\$(jq -r --arg r "\$rid" 'select(.event=="notify.queued" and .requestId==\$r and .audience=="leader")|.recipientRole' "$QUEUE" | wc -l | tr -d ' ')"
printf '%s\n' "\$count" >> "$TMP/standing-counts"
[[ "\$count" -eq 2 ]]
EOF
  cat > "$TMP/t_mixed_standing.sh" <<EOF
#!/usr/bin/env bash
payload="\$(cat)"
role="\$(jq -r '.recipientRole' <<<"\$payload")"
if [[ "\$role" == P4_PROVISIONING_STEWARD ]]; then
  echo "P4 unavailable" >&2
  exit 7
fi
echo "delivered to \$role"
EOF
  chmod +x "$TMP"/t_*.sh
}

# DIR is MGR's manager and the derived leader for an E0_SPECIALIST ask.
# T0 is DIR's manager, and is the agent a "failed wake escalates upward" defect
# would reach for. It exists in this fixture solely so that hazard is testable.
base_org() {
  cat > "$ORG_SNAPSHOT" <<'ORG'
u-o1	O1	P1_PRESIDENT_COO	idle		President & COO
u-a0	A0	P4_PROVISIONING_STEWARD	idle	u-o1	Provisioning Steward
u-t0	T0	B2_TECH_CHIEF	running	u-o1	CTO & Chief AI Officer
u-dir	DIR	C1_DIRECTOR_BUILDER	idle	u-t0	Director of Engineering
u-mgr	MGR	D1_MANAGER	idle	u-dir	Engineering Manager
ORG
}
reset() { rm -f "$QUEUE" "$GRANT_LOG" "$DISABLED_TEMPLATES" "$DELIVERED"; base_org; }
last_sub() { jq -r 'select(.event=="request.submitted")|.requestId' "$QUEUE" | tail -1; }
submit_one() { "$Q" submit --requester MGR --template E0_SPECIALIST --title "$1" "${@:2}" >/dev/null 2>&1; last_sub; }

# Everything is selected BY AUDIENCE, never by position in the file. Emission
# order is an accident; the audience is the property under test.
lead_row()  { jq -c --arg r "$1" 'select(.event=="notify.queued" and .requestId==$r and .audience=="leader")' "$QUEUE" 2>/dev/null; }
lead_state(){ "$Q" notify --json 2>/dev/null | jq -r --arg r "$1" 'select(.rid==$r and .audience=="leader")|.state'; }
lead_body() { "$Q" notify --json 2>/dev/null | jq -r --arg r "$1" 'select(.rid==$r and .audience=="leader")|.body'; }
req_state() { "$Q" notify --json 2>/dev/null | jq -r --arg r "$1" 'select(.rid==$r and .audience=="requester")|.state'; }
# Count queued notifications for one audience — the per-audience idempotency
# measure. Unscoped it would count the other audience's row and report 2.
nq_aud()    { jq -r --arg r "$1" --arg a "$2" 'select(.event=="notify.queued" and .requestId==$r and (.audience // "requester")==$a)|.requestId' "$QUEUE" 2>/dev/null | wc -l | tr -d ' '; }

build_stub; build_transports; reset
export REQUEST_NOTIFY_CMD="$TMP/t_ok.sh"

# ===========================================================================
hdr "0. BASELINE — the fixture actually routes at a leader"
# ===========================================================================
# Without this, every assertion below could pass because derivation returned
# nothing and the notifier correctly declined to invent a recipient. A suite
# whose subject never ran is the failure mode TOG-402 was filed about.
REQ="$(submit_one "TESTL baseline")"
[[ -n "$REQ" ]] && ok "a request was recorded" || bad "no request was recorded — the fixture is broken"
eq "  ...and it derived DIR as the responsible leader" \
   "$(jq -r --arg r "$REQ" 'select(.event=="request.submitted" and .requestId==$r)|.responsibleLeader' "$QUEUE")" "DIR"

# ===========================================================================
hdr "1. Submit tells the leader — the claim the doc has made since TOG-194"
# ===========================================================================
eq "submit queues a notification addressed to the LEADER" \
   "$(lead_row "$REQ" | jq -r '.recipientRole')" "DIR"
eq "  ...to the leader's recorded AGENT ID, not just its role string" \
   "$(lead_row "$REQ" | jq -r '.recipientAgentId')" "u-dir"
eq "  ...and it was actually handed to the transport" "$(lead_state "$REQ")" "delivered"
eq "  ...the transport received the leader payload, not the requester's" \
   "$(jq -r 'select(.audience=="leader")|.recipientRole' "$DELIVERED")" "DIR"

b="$(lead_body "$REQ")"
has "$b" "YOU are the responsible leader" "the body tells the leader the request is THEIRS"
has "$b" "NOBODY ELSE IS GOING TO DECIDE THIS" \
    "  ...and that waiting does not hand it to anyone else"
has "$b" "review --reviewer DIR --request $REQ" \
    "  ...and carries the exact command that decides it"
has "$b" "expires at" "  ...and the deadline, so 'later' has a meaning"

# The pull half. TOG-254's argument was that if the only answer to a failed
# push is another push, the design swapped one dead end for a subtler one. That
# argument applies to the leader identically, and on origin/main this command
# answered "(no decisions for DIR)".
inb="$("$Q" inbox --for DIR 2>&1)"
has "$inb" "$REQ" "the leader's own inbox shows the pending request"
has "$inb" "leader" "  ...labelled with the audience, so it is not read as a decision"

# ===========================================================================
hdr "2. The leader's notification must NOT consume the requester's"
# ===========================================================================
# The regression this change was most likely to cause, and the one no existing
# suite could see. Both notifications live in one outbox, share one idempotency
# guard and one grouping key; keyed on requestId alone the leader's row (which
# is written FIRST, at submit) suppresses the requester's decision notice for
# the rest of the request's life. TOG-254's entire feature, deleted silently,
# with the leader half demonstrably working.
"$Q" review --reviewer DIR --request "$REQ" --approve --reason "headcount agreed" >/dev/null 2>&1
eq "the requester STILL gets its decision notification" "$(req_state "$REQ")" "delivered"
eq "  ...and the leader's row is still there beside it, not overwritten" \
   "$(lead_state "$REQ")" "delivered"
eq "  ...one request, exactly two notifications" \
   "$("$Q" notify --json | jq -r --arg r "$REQ" 'select(.rid==$r)|.audience' | sort | tr '\n' ',')" \
   "leader,requester,"
eq "  ...the requester's says APPROVED" \
   "$("$Q" notify --json | jq -r --arg r "$REQ" 'select(.rid==$r and .audience=="requester")|.status')" "approved"
eq "  ...and the leader's still says PENDING — they are not the same message" \
   "$(lead_row "$REQ" | jq -r '.decision')" "pending"
reset

# ===========================================================================
hdr "3. The address is NOT the requester's to choose"
# ===========================================================================
# --notify-issue is written by the REQUESTER — the least-privileged party in
# the flow. Reusing it for the leader's summons would let a requester deliver
# "you have something to decide" to an issue the leader never reads, while the
# queue records notify.delivered. That is not a missed notification: it is a
# forged record of one, and it is the TOG-198 steering defect one layer up.
REQ="$(submit_one "TESTL requester picks an address" --notify-issue REQUESTERS-OWN-ISSUE)"
eq "the requester's notification uses the requester's chosen issue" \
   "$(jq -r --arg r "$REQ" 'select(.event=="request.submitted" and .requestId==$r)|.notifyIssue' "$QUEUE")" \
   "REQUESTERS-OWN-ISSUE"
eq "  ...and the LEADER's notification does not" \
   "$(lead_row "$REQ" | jq -r '.notifyIssue')" "null"

REQ2="$(REQUEST_LEADER_NOTIFY_ISSUE=OPS-LEADER-INBOX submit_one "TESTL operator picks the address" --notify-issue REQUESTERS-OWN-ISSUE)"
eq "the leader's address comes from the OPERATOR's env instead" \
   "$(lead_row "$REQ2" | jq -r '.notifyIssue')" "OPS-LEADER-INBOX"

# Operator-supplied is not the same as trusted. The requester's field is
# charset-validated at submit; applying a weaker rule to this one because "the
# operator sets it" is precisely how the requester's field got here.
REQ3="$(REQUEST_LEADER_NOTIFY_ISSUE='../../agents/me/secrets?x=' submit_one "TESTL malformed operator address")"
eq "a malformed operator address is refused, not recorded" \
   "$(lead_row "$REQ3" | jq -r '.notifyIssue')" "null"
has "$(lead_row "$REQ3" | jq -r '.addressNote // ""')" "not a well-formed issue id" \
    "  ...and the refusal is recorded rather than silently swallowed"
eq "  ...and the submission itself still stands" \
   "$(jq -r --arg r "$REQ3" 'select(.event=="request.submitted" and .requestId==$r)|.status' "$QUEUE")" "pending"

# The reference Paperclip adapter is address-based. Its null leader address is
# the documented pull path even when the requester fallback is configured.
cp "$HERE/notify_paperclip_issue.sh" "$TMP/notify_paperclip_issue.sh"
chmod +x "$TMP/notify_paperclip_issue.sh"
REQ4="$(REQUEST_NOTIFY_CMD="$TMP/notify_paperclip_issue.sh" \
  REQUEST_NOTIFY_ISSUE=REQUESTER-FALLBACK submit_one "TESTL reference adapter pull only")"
eq "a null leader address through the reference adapter records pull_only" \
   "$(lead_state "$REQ4")" "pull_only"
reset

# ===========================================================================
hdr "4. CONTAINMENT — a failed wake changes nothing about the decision"
# ===========================================================================
# Property 1: the request is durably queued BEFORE any delivery is attempted,
# so every transport failure happens to a request that already exists and is
# already routed.
REQ="$(REQUEST_NOTIFY_CMD="$TMP/t_fail.sh" submit_one "TESTL transport is down")"
[[ -n "$REQ" ]] && ok "the submission SUCCEEDS even though the wake failed" \
                || bad "a failed wake blocked the submission — delivery has become a control"
eq "  ...the request is recorded and pending" \
   "$(jq -r --arg r "$REQ" 'select(.event=="request.submitted" and .requestId==$r)|.status' "$QUEUE")" "pending"
eq "  ...still routed at the SAME leader" \
   "$(jq -r --arg r "$REQ" 'select(.event=="request.submitted" and .requestId==$r)|.responsibleLeader' "$QUEUE")" "DIR"
eq "  ...and the failure is recorded, not swallowed" "$(lead_state "$REQ")" "failed"
eq "  ...with the transport's exit status, so 'why' survives" \
   "$(jq -r --arg r "$REQ" 'select(.event=="notify.failed" and .requestId==$r)|.exit' "$QUEUE")" "7"

# THE ORDERING, ASSERTED DIRECTLY. Not "the row exists" but "it exists BEFORE
# the first notification row". This is the property that makes every failure
# above harmless, and it is invisible to any test that only checks outcomes.
eq "the request row precedes every notification row" \
   "$(jq -r --arg r "$REQ" 'select(.requestId==$r)|.event' "$QUEUE" | head -1)" "request.submitted"

# An undelivered wake is an OPERATIONAL finding, not a silent state. This is
# the gate that read green on origin/main while the leader had been told
# nothing at all — because a notification nobody queued is not undelivered.
"$Q" notify >/dev/null 2>&1
eq "  ...and \`notify\` exits 1 while the leader's wake is undelivered" "$?" "1"

# A hung transport must not hold the submission open forever.
REQ="$(REQUEST_NOTIFY_CMD="$TMP/t_hang.sh" REQUEST_NOTIFY_TIMEOUT=1 submit_one "TESTL transport hangs")"
[[ -n "$REQ" ]] && ok "a HANGING transport does not wedge the submission" \
                || bad "a hanging transport wedged the submission"
eq "  ...and the timeout is recorded as a failure, not as delivery" "$(lead_state "$REQ")" "failed"

# The configured transport is untrusted, so it can ignore TERM. The supervisor's
# forced-kill path must make the courier window finite AND leave no live courier
# behind. A heartbeat makes that attributable without trusting process-table PID
# reuse: after delivery returns, the file must stop changing.
rm -f "$TMP/ignore-term.started" "$TMP/ignore-term.heartbeat"
[[ -z "$ASSERTION_SENTINEL" ]] || printf '%s\n' "transport-ignore-term-assertion-armed" >> "$ASSERTION_SENTINEL"
start="$(date +%s)"
REQ="$(REQUEST_NOTIFY_CMD="$TMP/t_ignore_term.sh" REQUEST_NOTIFY_TIMEOUT=1 \
  REQUEST_NOTIFY_KILL_AFTER=1 submit_one "TESTL transport ignores TERM")"
elapsed=$(( $(date +%s) - start ))
[[ "$elapsed" -le 4 ]] \
  && ok "a TERM-ignoring transport is forcibly bounded" \
  || bad "a TERM-ignoring transport ran for ${elapsed}s despite a 2s hard bound"
[[ -e "$TMP/ignore-term.started" ]] \
  && ok "  ...and the TERM-ignoring fixture demonstrably ran" \
  || bad "  ...but the TERM-ignoring fixture never started"
ignore_term_heartbeat="$(cat "$TMP/ignore-term.heartbeat" 2>/dev/null || true)"
sleep 1
if [[ -n "$ignore_term_heartbeat" && "$(cat "$TMP/ignore-term.heartbeat" 2>/dev/null || true)" == "$ignore_term_heartbeat" ]]; then
  ok "  ...and the TERM-ignoring courier is gone before delivery returns"
  [[ -z "$ASSERTION_SENTINEL" ]] || printf '%s\n' "transport-ignore-term-courier-gone" >> "$ASSERTION_SENTINEL"
else
  bad "  ...but the TERM-ignoring courier kept mutating after delivery"
fi
eq "  ...and forced termination is recorded as failed delivery" "$(lead_state "$REQ")" "failed"

# The deadline includes writing stdin. A large payload sent to a courier that
# never reads its pipe must not block before the supervisor starts its timer.
large_title="$(printf 'x%.0s' {1..70000})"
start="$(date +%s)"
REQ="$(REQUEST_NOTIFY_CMD="$TMP/t_no_stdin.sh" REQUEST_NOTIFY_TIMEOUT=1 \
  REQUEST_NOTIFY_KILL_AFTER=1 submit_one "$large_title")"
elapsed=$(( $(date +%s) - start ))
[[ "$elapsed" -le 4 ]] \
  && ok "a courier that never reads a large stdin is forcibly bounded" \
  || bad "a non-reading courier blocked stdin for ${elapsed}s before the timeout"
eq "  ...and the non-reading courier is recorded failed" "$(lead_state "$REQ")" "failed"

# The wrapper owns every descendant, not only the configured shell. A background
# child retaining stdout used to keep command substitution open after its parent
# exited, so the nominally bounded transport still wedged submit.
start="$(date +%s)"
REQ="$(REQUEST_NOTIFY_CMD="$TMP/t_retain_stdout.sh" REQUEST_NOTIFY_TIMEOUT=3 \
  REQUEST_NOTIFY_KILL_AFTER=1 submit_one "TESTL descendant retains stdout")"
elapsed=$(( $(date +%s) - start ))
[[ "$elapsed" -le 3 ]] \
  && ok "a descendant retaining stdout cannot hold delivery open" \
  || bad "a descendant retained stdout for ${elapsed}s after its parent exited"
eq "  ...and the parent transport outcome is still recorded" "$(lead_state "$REQ")" "delivered"

# A detached mutator used to escape the shell's process group, write after the
# fingerprint window, and leave a forged decision looking authoritative.
REQ="$(REQUEST_NOTIFY_CMD="$TMP/t_detached_mutator.sh" REQUEST_NOTIFY_TIMEOUT=3 \
  REQUEST_NOTIFY_KILL_AFTER=1 submit_one "TESTL detached mutator")"
sleep 3
eq "a detached descendant cannot mutate after the fingerprint window" \
   "$(jq -r --arg r "$REQ" 'select(.event=="request.reviewed" and .requestId==$r and .reviewer=="DETACHED")|.requestId' "$QUEUE" 2>/dev/null | wc -l | tr -d ' ')" "0"
eq "  ...and the delivery remains attributable" "$(lead_state "$REQ")" "delivered"

# Measurement failure is itself a containment failure. Malformed JSON appended
# by the courier used to make both suppressed jq outputs empty and compare equal.
before_delivered="$(grep -c '\"event\":\"notify.delivered\"' "$QUEUE" 2>/dev/null || true)"
REQ="$(REQUEST_NOTIFY_CMD="$TMP/t_malformed.sh" submit_one "TESTL malformed queue append")"
eq "malformed JSON from the courier fails the fingerprint closed" \
   "$(jq -r --arg r "$REQ" 'select(.event=="request.disputed" and .requestId==$r)|.requestId' "$QUEUE" 2>/dev/null | wc -l | tr -d ' ')" "1"
eq "  ...and malformed output is never recorded delivered" \
   "$(( $(grep -c '\"event\":\"notify.delivered\"' "$QUEUE" 2>/dev/null || true) - before_delivered ))" "0"
eq "  ...while the corrupt artifact is preserved for evidence" \
   "$(find "$TMP" -maxdepth 1 -name 'queue.jsonl.notify-corrupt.*' -type f | wc -l | tr -d ' ')" "1"
reset

# Malformed recovery may remove only the courier's appended bytes. Every honest
# queue writer shares the status lock, so a concurrent submission waits, then
# lands after recovery instead of being erased by an old whole-file snapshot.
rm -f "$TMP/malformed.started"
REQUEST_NOTIFY_CMD="$TMP/t_malformed_overlap.sh" \
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTL malformed overlap" \
  >"$TMP/malformed-submit.out" 2>&1 & malformed_pid=$!
for _ in {1..100}; do [[ -f "$TMP/malformed.started" ]] && break; sleep 0.02; done
"$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTL honest overlapping submit" \
  >"$TMP/honest-overlap.out" 2>&1 & honest_pid=$!
wait "$malformed_pid"; malformed_rc=$?
wait "$honest_pid"; honest_rc=$?
eq "malformed recovery leaves an honest concurrent submission durable" "$honest_rc" "0"
eq "  ...and both submissions remain in the parseable queue" \
   "$(jq -r 'select(.event=="request.submitted")|.requestId' "$QUEUE" | wc -l | tr -d ' ')" "2"
reset

# Timeout enforcement is part of the containment boundary. Point the explicit
# command seam at an unavailable binary: the transport must not run unbounded,
# and the queued notification must stay retryable.
reset
rm -f "$TMP/should-not-run"
REQ="$(REQUEST_TIMEOUT_CMD="$TMP/no-such-timeout" REQUEST_NOTIFY_CMD="$TMP/t_should_not_run.sh" \
  submit_one "TESTL timeout unavailable")"
eq "without enforceable timeout the delivery fails closed" "$(lead_state "$REQ")" "failed"
eq "  ...with a distinct reason, not a generic transport error" \
   "$(jq -r --arg r "$REQ" 'select(.event=="notify.failed" and .requestId==$r)|.reason' "$QUEUE")" \
   "timeout_enforcement_unavailable"
[[ ! -e "$TMP/should-not-run" ]] \
  && ok "  ...and the transport was never invoked unbounded" \
  || bad "  ...but the transport ran without timeout enforcement"
reset

# The reachability read is advisory, but it must obey the same liveness rule as
# the courier: no enforcement means do not execute. BASELINE FIRST: prove the
# copied submit path actually invokes and renders a healthy bounded probe.
REACH_ROOT="$TMP/reachability-root"; mkdir -p "$REACH_ROOT"
cp "$Q" "$REACH_ROOT/org_request_queue.sh"
chmod +x "$REACH_ROOT/org_request_queue.sh"
ln -s "$HERE/lib" "$REACH_ROOT/lib"
cat > "$REACH_ROOT/queue_liveness.sh" <<'EOF'
#!/usr/bin/env bash
: > "${REACHABILITY_FIXTURE_STARTED:?}"
printf 'reachable\twake_on_demand_enabled\ttrue\tnever\t0/0\n'
EOF
chmod +x "$REACH_ROOT/queue_liveness.sh"
rm -f "$TMP/reachability.started"
reach_base_out="$(REQUEST_TIMEOUT_CMD=timeout REACHABILITY_FIXTURE_STARTED="$TMP/reachability.started" \
  REQUEST_NOTIFY_CMD="" "$REACH_ROOT/org_request_queue.sh" submit --requester MGR --template E0_SPECIALIST --title "TESTL reachability baseline" 2>&1)"
reach_base_rc=$?
eq "BASELINE: bounded reachability measurement leaves submit successful" "$reach_base_rc" "0"
[[ -e "$TMP/reachability.started" ]] \
  && ok "  ...and the probe fixture demonstrably ran" \
  || bad "  ...but the baseline probe never ran"
has "$reach_base_out" "DIR can receive this decision" \
  "  ...and its reachable verdict is rendered"
reset

# MUTANT ARM: point the explicit timeout seam at an absent path while a hanging
# probe fixture makes any accidental unbounded invocation visible.
cat > "$REACH_ROOT/queue_liveness.sh" <<'EOF'
#!/usr/bin/env bash
: > "${REACHABILITY_FIXTURE_STARTED:?}"
sleep 300
EOF
chmod +x "$REACH_ROOT/queue_liveness.sh"
rm -f "$TMP/reachability.started"
start="$(date +%s)"
reach_out="$(REQUEST_TIMEOUT_CMD="$TMP/no-such-timeout" REACHABILITY_FIXTURE_STARTED="$TMP/reachability.started" \
  REQUEST_NOTIFY_CMD="" "$REACH_ROOT/org_request_queue.sh" submit --requester MGR --template E0_SPECIALIST --title "TESTL reachability timeout unavailable" 2>&1)"
reach_rc=$?
elapsed=$(( $(date +%s) - start ))
eq "without timeout enforcement submit still returns" "$reach_rc" "0"
[[ "$elapsed" -le 3 ]] \
  && ok "  ...the advisory reachability path is not run unbounded" \
  || bad "  ...the advisory reachability path held submit for ${elapsed}s"
[[ ! -e "$TMP/reachability.started" ]] \
  && ok "  ...and the hanging probe was skipped entirely" \
  || bad "  ...but the hanging probe was executed without a deadline"
has "$reach_out" "timeout_enforcement_unavailable" \
  "  ...and submit reports that reachability was unmeasured"
reset

# ===========================================================================
hdr "4b. Submission and leader intent persistence is crash-safe"
# The durable batch writer replaces the queue only after every row is fsynced.
# These failpoints kill the submit process from inside that writer, reproducing
# interruption after request.submitted and after the first standing row without
# depending on scheduler timing.
run_interrupted_submit() {
  local after_lines="$1" title="$2"
  rm -f "$QUEUE" "$TMP/courier-calls"
  base_org
  REQRECORD_TEST_INTERRUPT_AFTER_LINES="$after_lines" \
    REQUEST_NOTIFY_CMD="$TMP/t_count_calls.sh" \
    "$Q" submit --requester O1 --template E0_SPECIALIST --title "$title" \
    >"$TMP/interrupted-$after_lines.out" 2>&1
  return $?
}

run_interrupted_submit 1 "TESTL interrupted after submission"; interrupted_rc=$?
[[ $interrupted_rc -ne 0 ]] \
  && ok "interruption after request.submitted terminates submit" \
  || bad "interruption after request.submitted unexpectedly succeeded"
eq "  ...and exposes no request without its leader intent" \
   "$(jq -r 'select(.event=="request.submitted" or .event=="notify.queued")|.event' "$QUEUE" 2>/dev/null | wc -l | tr -d ' ')" "0"
[[ ! -e "$TMP/courier-calls" ]] \
  && ok "  ...and invokes no courier before the full batch commits" \
  || bad "  ...but a courier ran for an uncommitted intent"

run_interrupted_submit 2 "TESTL interrupted after first standing row"; interrupted_rc=$?
[[ $interrupted_rc -ne 0 ]] \
  && ok "interruption after the first standing row terminates submit" \
  || bad "interruption after the first standing row unexpectedly succeeded"
eq "  ...and exposes no partial P4/P1 standing set" \
   "$(jq -r 'select(.event=="notify.queued" and .audience=="leader")|.recipientRole' "$QUEUE" 2>/dev/null | wc -l | tr -d ' ')" "0"
[[ ! -e "$TMP/courier-calls" ]] \
  && ok "  ...and still invokes no courier" \
  || bad "  ...but a courier ran for a partial standing set"

rm -f "$QUEUE" "$TMP/courier-calls"
base_org
REQRECORD_TEST_INTERRUPT_AFTER_COMMIT=1 REQUEST_NOTIFY_CMD="$TMP/t_count_calls.sh" \
  "$Q" submit --requester O1 --template E0_SPECIALIST --title "TESTL interrupted after commit" \
  >"$TMP/interrupted-after-commit.out" 2>&1
interrupted_rc=$?
[[ $interrupted_rc -ne 0 ]] \
  && ok "interruption immediately after commit terminates before delivery" \
  || bad "interruption immediately after commit unexpectedly succeeded"
eq "  ...the committed request remains recoverable" \
   "$(jq -r 'select(.event=="request.submitted")|.requestId' "$QUEUE" | wc -l | tr -d ' ')" "1"
eq "  ...with the complete standing recipient set drainable" \
   "$(jq -r 'select(.event=="notify.queued" and .audience=="leader")|.recipientRole' "$QUEUE" | sort | tr '\n' ',')" \
   "P1_PRESIDENT_COO,P4_PROVISIONING_STEWARD,"
[[ ! -e "$TMP/courier-calls" ]] \
  && ok "  ...and no courier ran before recovery" \
  || bad "  ...but a courier ran despite the post-commit interruption"
REQUEST_NOTIFY_CMD="$TMP/t_count_calls.sh" "$Q" notify --drain >/dev/null 2>&1
eq "  ...and drain delivers every recovered intent" \
   "$(wc -l < "$TMP/courier-calls" | tr -d ' ')" "2"
reset

# A durable append failure is a hard stop. The caller must observe it, release
# its locks, and never invoke transport for an intent that was not verified in
# the queue.
cat > "$TMP/t_fail_append.sh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
echo "fixture durable append failure" >&2
exit 74
EOF
chmod +x "$TMP/t_fail_append.sh"
rm -f "$QUEUE" "$TMP/courier-calls"
base_org
append_out="$(REQRECORD_DURABLE_WRITER="$TMP/t_fail_append.sh" REQUEST_NOTIFY_CMD="$TMP/t_count_calls.sh" \
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTL append failure" 2>&1)"; append_rc=$?
[[ $append_rc -ne 0 ]] \
  && ok "durable append failure propagates to submit" \
  || bad "durable append failure was swallowed"
has "$append_out" "could not durably persist" \
  "  ...and reports the persistence failure explicitly"
[[ ! -e "$TMP/courier-calls" ]] \
  && ok "  ...and invokes no courier without verified intent" \
  || bad "  ...but invoked the courier after append failure"
[[ ! -s "$QUEUE" ]] \
  && ok "  ...and leaves no false submitted record" \
  || bad "  ...but left queue rows after the failed append"
reset

# ===========================================================================
hdr "5. A failed wake must NEVER walk up the reporting line"
# ===========================================================================
# The single most dangerous thing that could be added here, and the most
# tempting: "the leader didn't answer, so tell their manager". It is the
# auto-escalation-on-a-timer the design rejects, arriving through the retry
# path instead of the timer. The fixture gives DIR a manager (T0) precisely so
# this is testable rather than merely asserted in a comment.
REQ="$(REQUEST_NOTIFY_CMD="$TMP/t_fail.sh" submit_one "TESTL leader never answers")"
allrows="$(jq -c 'select(.event=="notify.queued")' "$QUEUE")"
hasnt "$allrows" '"recipientRole":"T0"' "no notification is addressed to the leader's MANAGER"
hasnt "$allrows" '"recipientAgentId":"u-t0"' "  ...not by agent id either"

# Drain it several times: a retry is where re-targeting would actually be
# implemented, so the retry is where it has to be refused.
for _ in 1 2 3; do REQUEST_NOTIFY_CMD="$TMP/t_fail.sh" "$Q" notify --drain >/dev/null 2>&1; done
allrows="$(jq -c 'select(.event=="notify.queued")' "$QUEUE")"
hasnt "$allrows" '"recipientRole":"T0"' "  ...and repeated retries still do not escalate upward"
eq "  ...every retry went to the ORIGINAL recipient" \
   "$(jq -r 'select(.event=="notify.queued")|.recipientRole' "$QUEUE" | sort -u | tr '\n' ',')" "DIR,"

# Re-point the role at a different agent between submit and retry — the most
# aggressive re-target available — and the retry must still use the agent id
# recorded at submit. Re-deriving here would make an org edit a way to choose
# who learns there is a decision to take.
sed -i 's/^u-dir\tDIR\t/u-dir-OLD\tDIRX\t/' "$ORG_SNAPSHOT"
printf 'u-dir-NEW\tDIR\tC1_DIRECTOR_BUILDER\tidle\tu-t0\tImpostor Director\n' >> "$ORG_SNAPSHOT"
REQUEST_NOTIFY_CMD="$TMP/t_ok.sh" "$Q" notify --drain >/dev/null 2>&1
eq "the drained retry delivers" "$(lead_state "$REQ")" "delivered"
eq "  ...to the agent id recorded AT SUBMIT, not the re-pointed role" \
   "$(jq -c 'select(.audience=="leader")' "$DELIVERED" | tail -1 | jq -r '.recipientAgentId')" "u-dir"
reset

# ===========================================================================
hdr "6. The wake is one-shot per audience, not a nag loop"
# ===========================================================================
# TOG-317 asked for an explicit decision on a pre-expiry reminder. The decision
# recorded in docs/responsible-leader.md is NO, and this is what holds it: read
# paths reap expiry and would otherwise re-page the leader on every `list`. A
# notifier that pages on every read gets muted, and a muted notifier is the
# same dead end this issue exists to close, reached by a different road.
REQ="$(submit_one "TESTL read me repeatedly")"
# Move it inside a plausible reminder window without expiring it. A separate
# leader_reminder audience near expiry must fail this test just as a resend of
# the original leader row would.
near_expiry="$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)"
jq -c --arg r "$REQ" --arg exp "$near_expiry" \
  'if .event=="request.submitted" and .requestId==$r then .expiresAt=$exp else . end' \
  "$QUEUE" > "$QUEUE.near" && mv "$QUEUE.near" "$QUEUE"
for _ in 1 2 3 4 5; do "$Q" list >/dev/null 2>&1; "$Q" inbox --for DIR >/dev/null 2>&1; done
eq "ten near-expiry reads produce ONE notification to the leader, not a reminder" \
   "$(jq -r --arg r "$REQ" 'select(.event=="notify.queued" and .requestId==$r and .recipientRole=="DIR")|.audience' "$QUEUE" | wc -l | tr -d ' ')" "1"
eq "  ...and no separate leader_reminder audience exists" \
   "$(jq -r --arg r "$REQ" 'select(.event=="notify.queued" and .requestId==$r and .audience=="leader_reminder")|.requestId' "$QUEUE" | wc -l | tr -d ' ')" "0"
eq "  ...and still exactly one for the requester once decided" \
   "$("$Q" review --reviewer DIR --request "$REQ" --approve --reason "fine" >/dev/null 2>&1; nq_aud "$REQ" requester)" "1"
reset

# ===========================================================================
hdr "7. A request with no single leader is still announced"
# ===========================================================================
# `escalate` (the requester is a root, or every ancestor is skipped) and
# `cycle` (malformed reporting data) have no derived individual to tell — which
# makes them the requests MOST likely to sit unread, not least. Each standing
# permission profile is therefore resolved to its live holder when the notice is
# queued, and that UUID is recorded permanently rather than re-derived on read.
rm -f "$TMP/standing-counts"
REQ="$(REQUEST_NOTIFY_CMD="$TMP/t_assert_standing_queued.sh" \
  "$Q" submit --requester O1 --template E0_SPECIALIST --title "TESTL root has no ancestor" >/dev/null 2>&1; last_sub)"
eq "a root requester's ask escalates" \
   "$(jq -r --arg r "$REQ" 'select(.event=="request.submitted" and .requestId==$r)|.responsibleLeaderMode' "$QUEUE")" "escalate"
has "$(lead_row "$REQ" | jq -r '.recipientRole')" "P4_PROVISIONING_STEWARD" \
    "  ...and IS announced, to the standing authority"
eq "  ...every standing intent exists before the first delivery" \
   "$(sort -u "$TMP/standing-counts" | tr '\n' ',')" "2,"
eq "  ...with one explicit row per standing-authority role" \
   "$(lead_row "$REQ" | jq -r '.recipientRole' | sort | tr '\n' ',')" \
   "P1_PRESIDENT_COO,P4_PROVISIONING_STEWARD,"
eq "  ...and each row records the live standing recipient UUID" \
   "$(lead_row "$REQ" | jq -r '[.recipientRole,.recipientAgentId]|@tsv' | sort | tr '\n' ',')" \
   $'P1_PRESIDENT_COO\tu-o1,P4_PROVISIONING_STEWARD\tu-a0,'
eq "  ...and both real authorities can pull the pending request by role" \
   "$(for role in P1_PRESIDENT_COO P4_PROVISIONING_STEWARD; do "$Q" inbox --for "$role" --json | jq -r --arg r "$REQ" 'select(.rid==$r and .audience=="leader")|.role'; done | sort | tr '\n' ',')" \
   "P1_PRESIDENT_COO,P4_PROVISIONING_STEWARD,"
eq "  ...and the P4 authenticated UUID reads exactly P4's standing notice" \
   "$("$Q" inbox --for u-a0 --json | jq -r --arg r "$REQ" 'select(.rid==$r and .audience=="leader")|.role' | tr '\n' ',')" \
   "P4_PROVISIONING_STEWARD,"
eq "  ...and the P1 authenticated UUID reads exactly P1's standing notice" \
   "$("$Q" inbox --for u-o1 --json | jq -r --arg r "$REQ" 'select(.rid==$r and .audience=="leader")|.role' | tr '\n' ',')" \
   "P1_PRESIDENT_COO,"
eq "  ...and an unrelated UUID reads neither standing notice" \
   "$("$Q" inbox --for u-dir --json | jq -r --arg r "$REQ" 'select(.rid==$r and .audience=="leader")|.role' | wc -l | tr -d ' ')" "0"

# The recorded UUID is immutable notice ownership, not a live alias. Re-seat P4
# after enqueue: the old holder keeps the old notice and the new holder does not
# inherit it merely by taking the permission profile.
sed -i 's/^u-a0\tA0\tP4_PROVISIONING_STEWARD\t/u-a0-OLD\tA0X\tE0_SPECIALIST\t/' "$ORG_SNAPSHOT"
printf 'u-a0-NEW\tA0\tP4_PROVISIONING_STEWARD\tidle\tu-o1\tReplacement Provisioning Steward\n' >> "$ORG_SNAPSHOT"
eq "  ...and re-seating P4 does not retarget the already queued notice" \
   "$("$Q" inbox --for u-a0 --json | jq -r --arg r "$REQ" 'select(.rid==$r and .audience=="leader")|.role' | tr '\n' ',')" \
   "P4_PROVISIONING_STEWARD,"
eq "  ...or disclose that old notice to the replacement P4 holder" \
   "$("$Q" inbox --for u-a0-NEW --json | jq -r --arg r "$REQ" 'select(.rid==$r and .audience=="leader")|.role' | wc -l | tr -d ' ')" "0"
reset

# BASELINE FIRST: both successes must be reported independently before the mixed
# arm can prove that one later success does not overwrite an earlier failure.
base_submit_out="$(REQUEST_NOTIFY_CMD="$TMP/t_ok.sh" \
  "$Q" submit --requester O1 --template E0_SPECIALIST --title "TESTL standing report baseline" 2>&1)"
base_req="$(last_sub)"
has "$base_submit_out" "P4_PROVISIONING_STEWARD — delivered" \
  "BASELINE: submit reports P4's successful delivery"
has "$base_submit_out" "P1_PRESIDENT_COO — delivered" \
  "  ...and reports P1's successful delivery separately"
eq "  ...with both standing rows delivered in the outbox" \
   "$("$Q" notify --json | jq -r --arg r "$base_req" 'select(.rid==$r and .audience=="leader")|.state' | sort | tr '\n' ',')" \
   "delivered,delivered,"
reset

mixed_submit_out="$(REQUEST_NOTIFY_CMD="$TMP/t_mixed_standing.sh" \
  "$Q" submit --requester O1 --template E0_SPECIALIST --title "TESTL mixed standing delivery" 2>&1)"
mixed_req="$(last_sub)"
has "$mixed_submit_out" "P4_PROVISIONING_STEWARD — NO; delivery failed" \
  "mixed standing delivery reports P4's failure"
has "$mixed_submit_out" "P1_PRESIDENT_COO — delivered" \
  "  ...and P1's later success without hiding P4"
hasnt "$mixed_submit_out" "leader notified    : yes — delivered to the standing authority" \
  "  ...and never collapses the mixed result to an all-success summary"
eq "  ...the outbox preserves one failed and one delivered state" \
   "$("$Q" notify --json 2>/dev/null | jq -r --arg r "$mixed_req" 'select(.rid==$r and .audience=="leader")|.state' | sort | tr '\n' ',')" \
   "delivered,failed,"
reset

# Upgrade compatibility. Pre-recipient-aware outcome rows omitted recipientRole;
# they must still close the historical requester notification rather than split
# into a role-less phantom group and make the queued intent drainable again.
cat > "$QUEUE" <<'LEGACY'
{"event":"notify.queued","requestId":"REQ-001","audience":"requester","decision":"approved","recipientAgentId":"u-mgr","recipientRole":"MGR","body":"legacy delivered decision","at":"2026-08-01T00:00:00Z"}
{"event":"notify.delivered","requestId":"REQ-001","audience":"requester","at":"2026-08-01T00:00:01Z","detail":"legacy courier"}
LEGACY
legacy_state="$("$Q" notify --json 2>/dev/null)"
eq "legacy role-less outcomes remain paired with their queued requester row" \
   "$(jq -r '.state' <<<"$legacy_state")" "delivered"
eq "  ...and render exactly one notification state" \
   "$(jq -s 'length' <<<"$legacy_state")" "1"
rm -f "$TMP/should-not-run"
legacy_drain="$(REQUEST_NOTIFY_CMD="$TMP/t_should_not_run.sh" "$Q" notify --drain 2>&1)"; legacy_drain_rc=$?
eq "  ...so drain remains a no-op after upgrade" "$legacy_drain_rc" "0"
has "$legacy_drain" "(nothing to drain)" "  ...and says there is nothing to resend"
[[ ! -e "$TMP/should-not-run" ]] \
  && ok "  ...the already-delivered legacy decision is not redelivered" \
  || bad "  ...but drain redelivered a historical decision"
reset

# ===========================================================================
hdr "8. The transport is a courier, not a participant"
# ===========================================================================
# It runs whatever the operator configured, so it is not sandboxed. What must
# hold is that nothing it writes is READ as a decision or as a routing change.
#
# THIS SECTION IS A REGRESSION TEST FOR A HOLE TOG-317 ITSELF OPENED, found by
# running this suite rather than by reading the diff. Before TOG-317 the
# transport only ever ran at REVIEW time, when a genuine `request.reviewed` row
# already existed — so a forged one made the record ambiguous and
# assert_one_decision refused it. The protection was a COLLISION, not a check,
# and nothing said so. Running the transport at SUBMIT time removes the thing
# to collide with. Measured with the guard reverted:
#
#   $ list --status approved
#   REQ-001  approved  MGR [D1_MANAGER]  E0_SPECIALIST  probe8  EVIL
#   $ thread --request REQ-001  -> "REQ-001  APPROVED   by EVIL";  exit 0
#
# BASELINE FIRST. The guard fires on "status rows changed while the notifier
# ran", and a guard that fired on EVERY delivery would make every assertion
# below pass while breaking the feature outright. So an honest transport must
# leave the record undisputed, asserted here, before the hostile one is run.
REQ="$(submit_one "TESTL honest courier")"
eq "BASELINE: an honest transport leaves the record undisputed" \
   "$(jq -r --arg r "$REQ" 'select(.event=="request.disputed" and .requestId==$r)|.requestId' "$QUEUE" | wc -l | tr -d ' ')" "0"
eq "  ...and the request is still readable and pending" \
   "$("$Q" list --status pending | grep -c "$REQ")" "1"
reset

# Fingerprint the whole decision record, not just the notification's request. A
# courier handling request two must not be able to decide request one silently.
VICTIM="$(submit_one "TESTL cross-request victim")"
REQ="$(REQUEST_NOTIFY_CMD="$TMP/t_cross_request.sh" submit_one "TESTL cross-request courier")"
eq "a courier cannot forge a decision on a different request" \
   "$(jq -r --arg r "$REQ" 'select(.event=="request.disputed" and .requestId==$r)|.requestId' "$QUEUE" | wc -l | tr -d ' ')" "1"
out="$("$Q" thread --request "$VICTIM" 2>&1)"; rc=$?
[[ $rc -ne 0 ]] && has "$out" "REFUSED" \
  "  ...and the cross-request victim is refused rather than accepted" \
  || bad "  ...but the cross-request victim remained answerable"
reset

REQ="$(REQUEST_NOTIFY_CMD="$TMP/t_evil.sh" submit_one "TESTL hostile submit courier")"
eq "a hostile SUBMIT-time transport is DETECTED" \
   "$(jq -r --arg r "$REQ" 'select(.event=="request.disputed" and .requestId==$r)|.requestId' "$QUEUE" | wc -l | tr -d ' ')" "1"
out="$("$Q" thread --request "$REQ" 2>&1)"; rc=$?
[[ $rc -ne 0 ]] && has "$out" "REFUSED" "  ...and every command REFUSES the disputed record" \
                || bad "  ...and every command REFUSES the disputed record (thread exited 0)"
eq "  ...the forged approval appears in NO status listing" \
   "$("$Q" list --status approved 2>/dev/null | grep -c "EVIL")" "0"
eq "  ...and it is not quietly left looking pending either" \
   "$("$Q" list --status pending 2>/dev/null | grep -c "$REQ")" "0"
has "$("$Q" list --status all 2>&1)" "DISPUTED" \
    "  ...it is surfaced under its own label, not hidden"
# The routing record itself is untouched: the forgery adds rows, it does not
# rewrite the one that says who this was routed at.
eq "  ...and the request is still recorded as routed at the derived leader" \
   "$(jq -r --arg r "$REQ" 'select(.event=="request.submitted" and .requestId==$r)|.responsibleLeader' "$QUEUE")" "DIR"

# The fingerprint must identify the transport, not merely notice that the file
# changed during a slow call. A legitimate reviewer can act while an honest
# delivery is in flight. The review waits on the shared status lock, then lands
# after delivery; it must remain authoritative and must not dispute the record.
reset
rm -f "$TMP/slow.started"
REQUEST_NOTIFY_CMD="$TMP/t_slow.sh" REQUEST_NOTIFY_TIMEOUT=10 \
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTL honest concurrent review" \
  >"$TMP/slow-submit.out" 2>&1 & submit_pid=$!
for _ in {1..100}; do [[ -f "$TMP/slow.started" ]] && break; sleep 0.02; done
REQ="$(last_sub)"
[[ -f "$TMP/slow.started" && -n "$REQ" ]] \
  && ok "the honest slow transport is demonstrably in flight" \
  || bad "the slow-delivery fixture never entered its overlap window"
if mkdir "${QUEUE}.lock" 2>/dev/null; then
  ok "the transport does not own QUEUE_LOCK while it is in flight"
  rm -rf "${QUEUE}.lock"
else
  bad "the transport held QUEUE_LOCK during external I/O"
fi
"$Q" review --reviewer DIR --request "$REQ" --reject --reason "legitimate concurrent decision" \
  --alternative "fixture denial; concurrency is the property under test" \
  >"$TMP/concurrent-review.out" 2>&1 & review_pid=$!
wait "$submit_pid"; submit_rc=$?
wait "$review_pid"; review_rc=$?
eq "a legitimate review overlapping honest slow delivery succeeds" "$review_rc" "0"
eq "  ...and the submit path still succeeds" "$submit_rc" "0"
eq "  ...without falsely disputing the request" \
   "$(jq -r --arg r "$REQ" 'select(.event=="request.disputed" and .requestId==$r)|.requestId' "$QUEUE" | wc -l | tr -d ' ')" "0"
eq "  ...and the legitimate decision remains readable" \
   "$("$Q" list --status rejected 2>/dev/null | grep -c "$REQ")" "1"

# Drain is a second transport invocation, not a bookkeeping-only path. A guard
# wrapped only around submit leaves this retry able to forge the decision and
# report delivery. Fail once honestly, then retry through the hostile courier.
reset
REQ="$(REQUEST_NOTIFY_CMD="$TMP/t_fail.sh" submit_one "TESTL hostile drain courier")"
eq "the leader notification is failed and therefore drainable" "$(lead_state "$REQ")" "failed"
drain_out="$(REQUEST_NOTIFY_CMD="$TMP/t_evil.sh" "$Q" notify --drain 2>&1)"; drain_rc=$?
eq "a hostile DRAIN-time transport disputes the request" \
   "$(jq -r --arg r "$REQ" 'select(.event=="request.disputed" and .requestId==$r)|.requestId' "$QUEUE" | wc -l | tr -d ' ')" "1"
[[ $drain_rc -ne 0 ]] && ok "  ...and drain exits non-zero instead of reporting delivery" \
                         || bad "  ...but drain exited 0 after transport tampering"
has "$drain_out" "$REQ (leader -> DIR) -> failed" \
    "  ...and drain reports the attempted delivery as failed"
eq "  ...with no delivered outcome recorded for the hostile retry" \
   "$(jq -r --arg r "$REQ" 'select(.event=="notify.delivered" and .requestId==$r and .audience=="leader")|.requestId' "$QUEUE" | wc -l | tr -d ' ')" "0"
out="$("$Q" thread --request "$REQ" 2>&1)"; rc=$?
[[ $rc -ne 0 ]] && has "$out" "REFUSED" "  ...and thread refuses the drain-time forgery" \
                || bad "  ...and thread refuses the drain-time forgery (thread exited 0)"
eq "  ...and approved listings never accept EVIL's row" \
   "$("$Q" list --status approved 2>/dev/null | grep -c "EVIL")" "0"

printf '\n\033[1mRESULT: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
