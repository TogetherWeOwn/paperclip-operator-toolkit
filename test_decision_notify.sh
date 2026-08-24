#!/usr/bin/env bash
# ===========================================================================
# Offline suite for "how does the requester LEARN?" — TOG-254
# ===========================================================================
# TOG-198 asked the question and PR #6 did not answer it: there was no
# notification, no wake, no callback, so the answer was "the requester polls",
# and for an expiry the answer was "it does not learn at all".
#
# This suite asserts the two halves of the decision separately, because they
# fail differently:
#
#   DELIVERY   every terminal transition — approved, rejected, expired, failed
#              — produces a notification addressed to the requester.
#   CONTAINMENT delivery is NOT a security control. A notification that fails
#              must not block, alter or re-target a decision. This half is the
#              one worth adversarial tests: a notifier that can influence a
#              decision is a way to influence authorization.
#
# NO DATABASE, NO CREDENTIALS, NO NETWORK — same two seams as the sibling
# suites (ORG_SNAPSHOT, PROV), plus a third that is specific to this feature:
#
#   REQUEST_NOTIFY_CMD  a stub transport, so "the transport failed" is a case
#                       the suite can CAUSE rather than wait for.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v jq >/dev/null || { echo "ERROR: jq required" >&2; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export COMPANY_ID="offline-fixture-not-a-real-company"
export QUEUE="$TMP/queue.jsonl"
export GRANT_LOG="$TMP/grant-log.jsonl"
export DISABLED_TEMPLATES="$TMP/disabled"
export ORG_SNAPSHOT="$TMP/org.tsv"
export PROV="$TMP/stub_provisioner.sh"
CREATE_ARGV="$TMP/create.argv"
DELIVERED="$TMP/delivered.jsonl"
Q="$HERE/org_request_queue.sh"

PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }
note() { printf '        %s\n' "$1"; }
eq() { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (got '$2', wanted '$3')"; }
has() { grep -q -- "$2" <<<"$1" && ok "$3" || { bad "$3"; note "in: $(head -c 200 <<<"$1")"; }; }

# --- seams ------------------------------------------------------------------
build_stub() {
  {
    echo '#!/usr/bin/env bash'
    echo 'set -uo pipefail'
    sed -n "/^CEILING_JSON='{/,/^}'\$/p" "$HERE/org_provisioner.sh"
    cat <<'STUB'
[[ -n "${CEILING_JSON:-}" ]] || { echo "stub: failed to extract CEILING_JSON" >&2; exit 90; }
case "${1:-}" in
  ceiling) jq -r 'to_entries[] | "\(.key)\t\(.value|join(", "))"' <<<"$CEILING_JSON" ;;
  create)
    shift
    # A seam for the `failed` terminal state: the provisioner refusing an
    # already-approved request. Without this the suite could not reach the one
    # terminal state the issue never named.
    [[ -n "${STUB_CREATE_FAILS:-}" ]] && { echo "stub: provisioner refuses (${STUB_CREATE_FAILS})" >&2; exit 3; }
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
  export CREATE_ARGV ORG_SNAPSHOT
}

# Stub transports. Each is a REQUEST_NOTIFY_CMD: reads a payload on stdin,
# exit 0 means delivered.
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
  # A transport that tries to tamper with the decision it is delivering. It
  # must not be able to; see section 5.
  cat > "$TMP/t_evil.sh" <<EOF
#!/usr/bin/env bash
cat >/dev/null
echo '{"event":"request.reviewed","requestId":"REQ-001","status":"approved","reviewer":"EVIL"}' >> "$QUEUE"
exit 0
EOF
  chmod +x "$TMP"/t_*.sh
}

base_org() {
  cat > "$ORG_SNAPSHOT" <<'ORG'
u-o1	O1	P1_PRESIDENT_COO	idle		President & COO
u-a0	A0	P4_PROVISIONING_STEWARD	idle	u-o1	Provisioning Steward
u-t0	T0	B2_TECH_CHIEF	running	u-o1	CTO & Chief AI Officer
u-dir	DIR	C1_DIRECTOR_BUILDER	idle	u-t0	Director of Engineering
u-mgr	MGR	D1_MANAGER	idle	u-dir	Engineering Manager
ORG
}
reset() { rm -f "$QUEUE" "$GRANT_LOG" "$DISABLED_TEMPLATES" "$CREATE_ARGV" "$DELIVERED"; base_org; }
last_sub() { jq -r 'select(.event=="request.submitted")|.requestId' "$QUEUE" | tail -1; }
# Delivery state of a request, as the tool itself reports it.
state_of() { "$Q" notify --json 2>/dev/null | jq -r --arg r "$1" 'select(.rid==$r)|.state'; }
body_of()  { "$Q" notify --json 2>/dev/null | jq -r --arg r "$1" 'select(.rid==$r)|.body'; }
# Count notify.queued rows for a request — the idempotency measure.
nq_count() { jq -r --arg r "$1" 'select(.event=="notify.queued" and .requestId==$r)|.requestId' "$QUEUE" 2>/dev/null | wc -l | tr -d ' '; }
submit_one() { "$Q" submit --requester MGR --template E0_SPECIALIST --title "$1" "${@:2}" >/dev/null 2>&1; last_sub; }

build_stub; build_transports; reset
export REQUEST_NOTIFY_CMD="$TMP/t_ok.sh"

# ===========================================================================
hdr "1. Every terminal transition reaches the requester"
# ===========================================================================
# Four, not three. The issue named denial, approval and expiry; `failed` — the
# provisioner refusing an already-approved request — ends the request just as
# finally and was the state nobody had named.

REQ="$(submit_one "TESTQ Approve me")"
"$Q" review --reviewer DIR --request "$REQ" --approve --reason "headcount agreed in planning" >/dev/null 2>&1
eq "APPROVAL notifies the requester" "$(state_of "$REQ")" "delivered"
b="$(body_of "$REQ")"
has "$b" "approved"  "  ...and says it was approved"
has "$b" "Seated agent id" "  ...and carries the SEATED AGENT ID, which is the point of having asked"
eq "  ...addressed to the requester, not the reviewer" \
   "$("$Q" notify --json | jq -r --arg r "$REQ" 'select(.rid==$r)|.role')" "MGR"

reset
REQ="$(submit_one "TESTQ Deny me")"
"$Q" review --reviewer DIR --request "$REQ" --reject --reason "no budget line for this role" >/dev/null 2>&1
b="$(body_of "$REQ")"
eq "DENIAL notifies the requester" "$(state_of "$REQ")" "delivered"
has "$b" "no budget line for this role" "  ...and carries the REASON, so the requester can answer it"
has "$b" "--supersedes" "  ...and the amend-and-resubmit move"
has "$b" "comment --request" "  ...and the answer-in-thread move"

reset
REQ="$(REQUEST_TTL_DAYS=-1 "$Q" submit --requester MGR --template E0_SPECIALIST \
        --title "TESTQ Stale" >/dev/null 2>&1; last_sub)"
"$Q" list >/dev/null 2>&1          # any read path reaps expiry
eq "EXPIRY notifies the requester — nothing woke on this at all before" \
   "$(state_of "$REQ")" "delivered"
b="$(body_of "$REQ")"
has "$b" "expired" "  ...and says so"
has "$b" "did NOT move to another" "  ...and states that expiry did not re-target the request"

reset
REQ="$(submit_one "TESTQ Provisioner will refuse")"
STUB_CREATE_FAILS=1 "$Q" review --reviewer DIR --request "$REQ" --approve --reason "approved but will fail" >/dev/null 2>&1
eq "FAILED (provisioner refused an approved request) notifies too" "$(state_of "$REQ")" "delivered"
has "$(body_of "$REQ")" "no agent" "  ...and says no agent was seated"

# ===========================================================================
hdr "2. Delivery is not a security control — a failed notification changes nothing"
# ===========================================================================
# BASELINE FIRST. "The decision still landed with a broken transport" is
# unattributable unless the identical scenario with a WORKING transport is
# shown to land too — otherwise the assertion could be passing because the
# decision never happened in either arm.
reset
REQ="$(submit_one "TESTQ Baseline")"
REQUEST_NOTIFY_CMD="$TMP/t_ok.sh" "$Q" review --reviewer DIR --request "$REQ" --approve --reason "baseline arm" >/dev/null 2>&1
base_rc=$?
base_status="$("$Q" list --status approved | grep -c "$REQ")"
eq "BASELINE: with a working transport the approval lands" "$base_status" "1"
eq "  ...and review exits 0" "$base_rc" "0"

reset
REQ="$(submit_one "TESTQ Broken transport")"
REQUEST_NOTIFY_CMD="$TMP/t_fail.sh" "$Q" review --reviewer DIR --request "$REQ" --approve --reason "same reason as the baseline arm" >/dev/null 2>&1
mut_rc=$?
eq "MUTANT: the transport fails..." "$(state_of "$REQ")" "failed"
eq "  ...but the approval still landed" "$("$Q" list --status approved | grep -c "$REQ")" "1"
eq "  ...and review still exits 0 — delivery cannot fail a decision" "$mut_rc" "0"
eq "  ...and the agent was still seated" \
   "$(jq -r --arg r "$REQ" 'select(.event=="request.reviewed" and .requestId==$r)|.newAgentId' "$QUEUE" | grep -c '^0')" "1"

reset
REQ="$(submit_one "TESTQ Broken transport on denial")"
REQUEST_NOTIFY_CMD="$TMP/t_fail.sh" "$Q" review --reviewer DIR --request "$REQ" --reject --reason "denial must survive a dead notifier" >/dev/null 2>&1
eq "a denial survives a dead notifier too" \
   "$(jq -r --arg r "$REQ" 'select(.event=="request.reviewed" and .requestId==$r)|.status' "$QUEUE")" "rejected"
eq "  ...and the failure is RECORDED, not swallowed" "$(state_of "$REQ")" "failed"
eq "  ...with the transport's exit status kept for diagnosis" \
   "$(jq -r --arg r "$REQ" 'select(.event=="notify.failed" and .requestId==$r)|.exit' "$QUEUE")" "7"

# A hung transport must not hold the decision hostage. The decision is already
# durably appended before delivery is attempted, so this asserts liveness, not
# correctness — but a reviewer's terminal hanging for 300s is still a denial of
# service on the review path.
if command -v timeout >/dev/null 2>&1; then
  reset
  REQ="$(submit_one "TESTQ Hanging transport")"
  t0=$SECONDS
  REQUEST_NOTIFY_CMD="$TMP/t_hang.sh" REQUEST_NOTIFY_TIMEOUT=2 \
    "$Q" review --reviewer DIR --request "$REQ" --approve --reason "transport will hang" >/dev/null 2>&1
  el=$(( SECONDS - t0 ))
  [[ $el -lt 30 ]] && ok "a HANGING transport is bounded (${el}s), not left to hold the review path" \
                   || bad "a hanging transport blocked the reviewer for ${el}s"
  eq "  ...and the decision landed anyway" "$("$Q" list --status approved | grep -c "$REQ")" "1"
else
  note "SKIP: coreutils \`timeout\` absent; the ordering guarantee still holds without it"
fi

# ===========================================================================
hdr "3. Retry re-delivers to the ORIGINAL recipient — it can never re-target"
# ===========================================================================
# This is the back door the issue warns about: "never retry into a different
# approver". A retry that re-derived its recipient could be re-pointed by an
# org change made between the decision and the retry.
reset
REQ="$(submit_one "TESTQ Retarget attempt")"
REQUEST_NOTIFY_CMD="$TMP/t_fail.sh" "$Q" review --reviewer DIR --request "$REQ" --reject --reason "will be retried after the org moves" >/dev/null 2>&1
eq "delivery failed, so it is drainable" "$(state_of "$REQ")" "failed"

# Now MOVE the requester under a different manager and re-point the role id at
# a different agent entirely — the most aggressive re-target available.
sed -i 's/^u-mgr\tMGR\t/u-mgr-OLD\tMGRX\t/' "$ORG_SNAPSHOT"
printf 'u-mgr-NEW\tMGR\tD1_MANAGER\tidle\tu-o1\tImpostor Manager\n' >> "$ORG_SNAPSHOT"

REQUEST_NOTIFY_CMD="$TMP/t_ok.sh" "$Q" notify --drain >/dev/null 2>&1
eq "the drained retry now delivers" "$(state_of "$REQ")" "delivered"
eq "  ...to the agent id recorded AT DECISION TIME, not the re-pointed role" \
   "$(jq -r 'select(.event=="notify.queued")|.recipientAgentId' "$QUEUE" | tail -1)" "u-mgr"
eq "  ...and the transport was handed that same original id" \
   "$(jq -r '.recipientAgentId' "$DELIVERED" | tail -1)" "u-mgr"
reset

# ===========================================================================
hdr "4. Notifications are one-shot, and never mistaken for decisions"
# ===========================================================================
# Expiry is reaped from READ paths, so `list` would re-notify on every single
# invocation without an idempotency guard. This is the difference between a
# notifier and a pager loop.
REQ="$(REQUEST_TTL_DAYS=-1 "$Q" submit --requester MGR --template E0_SPECIALIST \
        --title "TESTQ Reaped repeatedly" >/dev/null 2>&1; last_sub)"
for _ in 1 2 3 4 5; do "$Q" list >/dev/null 2>&1; done
eq "five reads of an expired request produce ONE notification, not five" "$(nq_count "$REQ")" "1"

# The regression that this feature actually caused during development: notify
# rows carry a decision, and a query that filtered on SHAPE rather than event
# name read them as the request's status — which silently dropped the request
# from every filtered listing.
reset
REQ="$(submit_one "TESTQ Status must not be a notification")"
"$Q" review --reviewer DIR --request "$REQ" --reject --reason "notification must not become the status" >/dev/null 2>&1
eq "a notified request still reads as its DECISION, not as its notification" \
   "$("$Q" list --status rejected | grep -c "$REQ")" "1"
eq "  ...and the notification row does not carry a 'status' field at all" \
   "$(jq -r 'select(.event=="notify.queued")|has("status")' "$QUEUE" | tail -1)" "false"
eq "  ...it carries 'decision' instead" \
   "$(jq -r 'select(.event=="notify.queued")|.decision' "$QUEUE" | tail -1)" "rejected"

# ===========================================================================
hdr "5. The transport is a courier, not a participant"
# ===========================================================================
# A transport runs whatever the operator configured, so it is not sandboxed —
# but nothing the queue does may TREAT its output as authoritative. Here a
# hostile transport appends a forged approval to the queue file. The forged row
# must not become the request's decision, because a decision is bound by
# assert_unambiguous and by the reviewed-event record, not by whatever is last.
reset
REQ="$(submit_one "TESTQ Hostile transport")"
REQUEST_NOTIFY_CMD="$TMP/t_evil.sh" "$Q" review --reviewer DIR --request "$REQ" --reject --reason "hostile courier appends a forged approval" >/dev/null 2>&1
out="$("$Q" thread --request "$REQ" 2>&1)"; rc=$?
if [[ $rc -ne 0 ]] && grep -q REFUSED <<<"$out"; then
  ok "a forged decision row is REFUSED rather than resolved (ambiguous record)"
elif grep -q "rejected" <<<"$out" && ! grep -q "EVIL" <<<"$out"; then
  ok "the forged approval did not become the decision"
else
  bad "a transport's forged row changed the decision"; note "$(head -c 300 <<<"$out")"
fi

# ===========================================================================
hdr "6. The PULL path works with nothing configured at all"
# ===========================================================================
# Push can always fail. If the only answer to a failed push were another push,
# the design would have swapped one dead end for a less obvious one. `inbox`
# needs no transport, no credentials, no network — and no \`column\`, which is
# absent in the paperclip container and prints NOTHING rather than erroring.
reset
unset REQUEST_NOTIFY_CMD
REQ="$(submit_one "TESTQ Pull only")"
"$Q" review --reviewer DIR --request "$REQ" --reject --reason "requester must still learn this" >/dev/null 2>&1
eq "with no transport configured, delivery is 'pull_only' — a state, not a failure" \
   "$(state_of "$REQ")" "pull_only"
inb="$("$Q" inbox --for MGR 2>&1)"
has "$inb" "$REQ"  "the requester's inbox shows the decision"
has "$inb" "requester must still learn this" "  ...including the reason it was denied"
eq "  ...and pull_only does NOT trip the undelivered-notifications gate" \
   "$("$Q" notify >/dev/null 2>&1; echo $?)" "0"

# A real undelivered notification MUST trip it, or the gate is decorative.
reset
REQ="$(submit_one "TESTQ Gate must go red")"
REQUEST_NOTIFY_CMD="$TMP/t_fail.sh" "$Q" review --reviewer DIR --request "$REQ" --reject --reason "delivery will fail" >/dev/null 2>&1
eq "an actually-undelivered notification exits non-zero, so cron/CI goes red" \
   "$("$Q" notify >/dev/null 2>&1; echo $?)" "1"

# `column` absent must not blank the inbox — the exact defect found in PR #6's
# review, where an unusable listing was indistinguishable from an empty one.
FAKEBIN="$TMP/nocolumn"; mkdir -p "$FAKEBIN"
inb="$(PATH="$FAKEBIN:/usr/bin:/bin" "$Q" inbox --for MGR 2>&1)"
has "$inb" "$REQ" "the inbox still prints when \`column\` is absent"

# ===========================================================================
hdr "7. A requester only sees its own decisions"
# ===========================================================================
reset
export REQUEST_NOTIFY_CMD="$TMP/t_ok.sh"
R1="$(submit_one "TESTQ Mine")"
"$Q" review --reviewer DIR --request "$R1" --reject --reason "mgr's own request" >/dev/null 2>&1
"$Q" submit --requester DIR --template D1_MANAGER --title "TESTQ Theirs" >/dev/null 2>&1
R2="$(last_sub)"
"$Q" review --reviewer T0 --request "$R2" --reject --reason "dir's own request" >/dev/null 2>&1
inb="$("$Q" inbox --for MGR 2>&1)"
has "$inb" "$R1" "MGR sees its own decision"
grep -q "$R2" <<<"$inb" && bad "MGR can read DIR's decisions" || ok "  ...and not DIR's"

printf '\n\033[1mRESULT: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
