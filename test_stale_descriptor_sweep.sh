#!/usr/bin/env bash
# ===========================================================================
# test_stale_descriptor_sweep.sh — offline suite for
# scripts/stale_descriptor_sweep.js (TOG-890).
#
# No database, no network, no credentials. Every case is a synthetic source
# document fed through STALE_DESCRIPTOR_SOURCE_CMD, so CI can run this.
#
# WHAT THIS SUITE IS BUILT TO CATCH:
#
#  * THE SILENT GREEN. This detector's whole failure mode is measuring
#    nothing. If the interaction read comes back empty, every descriptor
#    classifies `no-citation` and the tool reports a clean board having looked
#    at nothing at all. §4 and §5 pin exit 5 on both empty inputs. This is the
#    single most important section here: an unscoped or mis-scoped query
#    returns zero rows rather than an error, so the state is REACHABLE.
#
#  * THE PHANTOM CITATION. `unblockDescriptor.owner.agentId` is a full UUID
#    sitting in the same blob as the prose. §3 gives an agent id whose first 8
#    characters ARE a cancelled interaction's, which without masking reads as
#    a citation of a dead ask — a card reported stale on the strength of its
#    own owner field. It also pins the mirror error: the mask must not swallow
#    a genuine full-form citation beside it.
#
#  * SUPERSESSION READ BACKWARDS. §2 is the TOG-64 shape: "X withdrawn, now
#    Y". A rule requiring every citation to be live reports that healthy,
#    correctly-updated descriptor as broken forever.
#
#  * A RESOLVED ASK TREATED AS LIVE. §6 pins that `answered`, `accepted` and
#    `rejected` all strand a card exactly as hard as `cancelled`. Only
#    `pending` is live. Scoring `answered` as live is the plausible edit that
#    makes this tool blind to the most common stale shape.
#
#  * THE ALLOWLIST FAILING OPEN. §7 pins that the marker is an EXACT literal:
#    prose that merely sounds deliberate must NOT silence a finding, an
#    acknowledged card must still be PRINTED, and the marker must never
#    promote or demote a live card.
#
#  * A REFUSAL FROM THE WRONG BRANCH. Exit codes alone would let any refusal
#    read as the intended one, so every assertion pins the VERDICT text too.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/scripts/stale_descriptor_sweep.js"
PASS=0; FAIL=0

[ -f "$TOOL" ] || { echo "FATAL: $TOOL not found"; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# Fixed ids. LIVE is pending; DEAD_* are the four resolved states.
LIVE="aaaaaaaa-1111-2222-3333-444444444444"
DEAD="bbbbbbbb-1111-2222-3333-444444444444"
EXPIRED="cccccccc-1111-2222-3333-444444444444"
ANSWERED="dddddddd-1111-2222-3333-444444444444"
ACCEPTED="eeeeeeee-1111-2222-3333-444444444444"
REJECTED="ffffffff-1111-2222-3333-444444444444"

INTS='[{"id":"'$LIVE'","status":"pending"},
       {"id":"'$DEAD'","status":"cancelled"},
       {"id":"'$EXPIRED'","status":"expired"},
       {"id":"'$ANSWERED'","status":"answered"},
       {"id":"'$ACCEPTED'","status":"accepted"},
       {"id":"'$REJECTED'","status":"rejected"}]'

# doc <file> <blocked-array-json> [interactions-json]
doc() {
  local f=$1 blocked=$2 ints=${3:-$INTS}
  printf '{"blocked":%s,"interactions":%s}\n' "$blocked" "$ints" > "$f"
}

# card <identifier> <owner-agent-id> <action-text>  -> one blocked row
card() {
  # jq is not assumed; the action text is embedded with escaped quotes by
  # the caller if it needs any.
  printf '{"identifier":"%s","assigneeAgentId":"agent-of-%s","unblockDescriptor":{"owner":{"agentId":"%s"},"action":"%s"}}' \
    "$1" "$1" "$2" "$3"
}

# run <file> [args...] -> sets OUT and CODE
run() {
  local f=$1; shift
  # Run via `bash -c` so $? is the TOOL's status rather than a pipeline's.
  OUT="$(STALE_DESCRIPTOR_SOURCE_CMD="cat $f" bash -c 'node "$0" "$@" 2>&1' "$TOOL" "$@")"
  CODE=$?
}

expect() { # expect <label> <want-code> <want-substring>
  local label=$1 wantc=$2 wants=$3
  if [ "$CODE" != "$wantc" ]; then
    bad "$label" "exit $CODE, wanted $wantc. Output: $(printf '%s' "$OUT" | tail -4 | tr '\n' ' ')"
  elif ! printf '%s' "$OUT" | grep -qF "$wants"; then
    bad "$label" "missing '$wants'. Output: $(printf '%s' "$OUT" | tail -4 | tr '\n' ' ')"
  else
    ok "$label"
  fi
}

expect_absent() { # expect_absent <label> <want-code> <forbidden-substring>
  local label=$1 wantc=$2 forbidden=$3
  if [ "$CODE" != "$wantc" ]; then
    bad "$label" "exit $CODE, wanted $wantc"
  elif printf '%s' "$OUT" | grep -qF "$forbidden"; then
    bad "$label" "output contains '$forbidden' and must not"
  else
    ok "$label"
  fi
}

echo "== 0. the pure core's own offline checks =="
if out="$(node "$TOOL" --selftest 2>&1)"; then
  ok "selftest exits 0 ($(printf '%s' "$out" | tail -1))"
else
  bad "selftest exits 0" "$(printf '%s' "$out" | grep FAIL | tr '\n' ' ')"
fi
# A selftest that ran zero cases is not a green selftest.
if printf '%s' "$out" | grep -qE 'selftest 0/'; then
  bad "selftest ran assertions" "it scored 0 cases"
else
  ok "selftest ran a non-zero number of cases"
fi

echo "== 1. the production shape: a dead citation is a finding =="
doc "$WORK/stale.json" "[$(card TOG-221 owner-1 "Routing raised via interaction $DEAD on this issue.")]"
run "$WORK/stale.json"
expect "dead citation -> STALE, exit 1" 1 "STALE unblock descriptors: 1 of 1"
run "$WORK/stale.json"
expect "the finding names the card" 1 "TOG-221"
run "$WORK/stale.json"
expect "and its assignee, who is the only agent who can fix it" 1 "agent-of-TOG-221"

echo "== 2. TOG-64's shape: superseded-then-replaced is NOT stale =="
# A healthy descriptor names the dead ask on purpose. Requiring every citation
# to be live would report this correctly-updated card as broken forever.
doc "$WORK/superseded.json" "[$(card TOG-64 owner-1 "SUPERSEDED - do not wait on $DEAD (cancelled 10:40Z). LIVE ask: $LIVE on TOG-814.")]"
run "$WORK/superseded.json"
expect "one live citation among dead ones -> clean, exit 0" 0 "No stale unblock descriptors"

echo "== 3. the phantom citation: owner.agentId must not be read as an ask =="
# This agent id's first 8 chars ARE the cancelled interaction's. Unmasked, the
# card is reported stale on the strength of its own owner field.
doc "$WORK/phantom.json" "[$(card TOG-999 "bbbbbbbb-9999-9999-9999-999999999999" "no interaction is cited here at all")]"
run "$WORK/phantom.json"
expect "an agent id sharing a dead ask's 8-prefix is NOT a citation" 0 "No stale unblock descriptors"
# The mirror error: masking must not swallow a real citation sitting beside it.
doc "$WORK/phantom2.json" "[$(card TOG-998 "bbbbbbbb-9999-9999-9999-999999999999" "waiting on $DEAD")]"
run "$WORK/phantom2.json"
expect "...but a genuine full-form citation beside it still counts" 1 "TOG-998"

echo "== 4. THE SILENT GREEN: zero interactions must never read clean =="
# Reachable in production: a mis-scoped query returns zero rows, not an error.
doc "$WORK/noints.json" "[$(card TOG-1 owner-1 "waiting on $DEAD")]" "[]"
run "$WORK/noints.json"
expect "zero interactions -> exit 5 UNKNOWN" 5 "UNKNOWN"
run "$WORK/noints.json"
expect "...and says it looked at nothing" 5 "ZERO interactions"
run "$WORK/noints.json"
expect_absent "...and never claims the board is clean" 5 "No stale unblock descriptors"

echo "== 5. zero blocked cards is 'nothing to sweep', not 'nothing wrong' =="
doc "$WORK/noblocked.json" "[]"
run "$WORK/noblocked.json"
expect "zero blocked cards -> exit 5 UNKNOWN" 5 "ZERO blocked cards"

echo "== 6. every resolved status strands a card; only pending is live =="
for pair in "expired:$EXPIRED" "answered:$ANSWERED" "accepted:$ACCEPTED" "rejected:$REJECTED"; do
  st="${pair%%:*}"; id="${pair##*:}"
  doc "$WORK/$st.json" "[$(card "TOG-$st" owner-1 "waiting on $id")]"
  run "$WORK/$st.json"
  expect "a '$st' interaction strands the card -> exit 1" 1 "TOG-$st"
done
# The control. Without it a tool hardcoded to report everything satisfies the
# four cases above and this section measures nothing.
doc "$WORK/pending.json" "[$(card TOG-pending owner-1 "waiting on $LIVE")]"
run "$WORK/pending.json"
expect "a 'pending' interaction is live -> exit 0" 0 "No stale unblock descriptors"

echo "== 7. the allowlist marker is exact, and never hides a card =="
doc "$WORK/ack.json" "[$(card TOG-411 owner-1 "DO NOT re-cut $DEAD - cancelled deliberately by the President. [sweep:acknowledged]")]"
run "$WORK/ack.json"
expect "an acknowledged card is not counted -> exit 0" 0 "No stale unblock descriptors"
run "$WORK/ack.json"
expect "...but is still PRINTED, never silently dropped" 0 "Acknowledged"
run "$WORK/ack.json"
expect "...and named" 0 "TOG-411"
# FAIL-OPEN GUARD. Prose that merely sounds deliberate must not silence it:
# otherwise any agent who happens to write that phrase disables the check
# without knowing the check exists.
doc "$WORK/noack.json" "[$(card TOG-410 owner-1 "DO NOT re-cut $DEAD - cancelled deliberately by the President.")]"
run "$WORK/noack.json"
expect "the same prose WITHOUT the exact marker is still a finding" 1 "TOG-410"
# The marker must never manufacture a finding out of a live card either.
doc "$WORK/acklive.json" "[$(card TOG-409 owner-1 "waiting on $LIVE [sweep:acknowledged]")]"
run "$WORK/acklive.json"
expect_absent "the marker does not demote a LIVE card into the report" 0 "Acknowledged"

echo "== 8. mixed board: findings and acknowledgements coexist =="
doc "$WORK/mixed.json" "[$(card TOG-A owner-1 "waiting on $DEAD"),$(card TOG-B owner-1 "waiting on $LIVE"),$(card TOG-C owner-1 "deliberate $EXPIRED [sweep:acknowledged]")]"
run "$WORK/mixed.json"
expect "3 cards, 1 stale -> exit 1" 1 "1 of 3 blocked cards"
run "$WORK/mixed.json"
expect "...the acknowledged one is reported separately" 1 "Acknowledged"
run "$WORK/mixed.json"
expect_absent "...and the live one is not in the report at all" 1 "TOG-B"

echo "== 9. --json carries the verdict a scheduled job would gate on =="
run "$WORK/stale.json" --json
expect "json output carries the verdict" 1 '"verdict": "STALE"'
run "$WORK/noints.json" --json
expect "json output carries the refusal too" 5 '"verdict": "UNKNOWN"'

echo "== 10. the seam itself refuses rather than passing =="
OUT="$(STALE_DESCRIPTOR_SOURCE_CMD='echo not-json' bash -c 'node "$0" 2>&1' "$TOOL")"; CODE=$?
expect "a source command emitting garbage -> exit 2" 2 "sweep failed"
OUT="$(bash -c 'node "$0" --wat 2>&1' "$TOOL")"; CODE=$?
expect "an unknown argument -> exit 2" 2 "unknown argument"
# The scope guard. An unscoped sweep reports cards nobody here can act on.
OUT="$(env -u PAPERCLIP_COMPANY_ID -u STALE_DESCRIPTOR_SOURCE_CMD DATABASE_URL=postgres://unused \
      bash -c 'node "$0" 2>&1' "$TOOL")"; CODE=$?
expect "a missing company scope refuses before connecting -> exit 2" 2 "PAPERCLIP_COMPANY_ID is not set"

echo "== 11. fragile hosting: a LIVE ask that lives on somebody else's card =="
# An interaction lives on one issue and dies with it, silently. These cases pin
# the three hosting shapes apart. `hosted` builds an interaction list where the
# live ask sits on a named host card in a named status.
hosted() { # hosted <host-identifier> <host-status>
  printf '[{"id":"%s","status":"pending","hostIssue":"%s","hostStatus":"%s"},
           {"id":"%s","status":"cancelled","hostIssue":"%s","hostStatus":"%s"}]' \
    "$LIVE" "$1" "$2" "$DEAD" "$1" "$2"
}

# Self-hosted is the SAFE shape and must stay silent, or the check reports the
# very fix it is asking for and no one can ever reach a clean board.
doc "$WORK/selfhost.json" "[$(card TOG-500 owner-1 "waiting on $LIVE")]" "$(hosted TOG-500 blocked)"
run "$WORK/selfhost.json"
expect_absent "an ask hosted on its OWN card is not reported" 0 "TOG-500"

# Cross-hosted on a live card: reported, but must NOT fail the run. 8 healthy
# cards on this board have this shape; failing on them gets the check muted.
doc "$WORK/fragile.json" "[$(card TOG-501 owner-1 "waiting on $LIVE")]" "$(hosted TOG-777 in_review)"
run "$WORK/fragile.json"
expect "a live ask hosted elsewhere is reported as fragile -> exit 0" 0 "Fragile hosting"
run "$WORK/fragile.json"
expect "...and names the host card and its status" 0 "hosted on TOG-777 [in_review]"

# Cross-hosted on a CLOSED card: a present defect, and it fails the run. This
# is the TOG-64/TOG-740 shape — the row should not exist, because closing an
# issue expires its pending interactions.
doc "$WORK/doomed.json" "[$(card TOG-502 owner-1 "waiting on $LIVE")]" "$(hosted TOG-814 done)"
run "$WORK/doomed.json"
expect "a live ask hosted on a DONE card -> exit 1" 1 "DOOMED HOST"
run "$WORK/doomed.json"
expect "...and is graded doomed, not merely fragile" 1 "hosted on TOG-814 [done]"
doc "$WORK/doomedc.json" "[$(card TOG-503 owner-1 "waiting on $LIVE")]" "$(hosted TOG-815 cancelled)"
run "$WORK/doomedc.json"
expect "a cancelled host is doomed too -> exit 1" 1 "DOOMED HOST"

# The fail-wrong guard. If a reader stops supplying the join, hostIssue is
# null; defaulting that to "not mine" would grade EVERY card fragile and drown
# the real findings. Silence is the only safe reading of missing data.
doc "$WORK/nohost.json" "[$(card TOG-504 owner-1 "waiting on $LIVE")]" \
  "[{\"id\":\"$LIVE\",\"status\":\"pending\"}]"
run "$WORK/nohost.json"
expect_absent "an interaction with NO hosting data is not graded at all" 0 "Fragile hosting"

# Staleness and hosting are different defects and must not cannibalise each
# other: a dead citation is stale, never a hosting finding.
doc "$WORK/deadhost.json" "[$(card TOG-505 owner-1 "waiting on $DEAD")]" "$(hosted TOG-814 done)"
run "$WORK/deadhost.json"
expect "a DEAD citation stays a staleness finding" 1 "1 of 1 blocked cards"
run "$WORK/deadhost.json"
expect_absent "...and is not double-counted as a hosting finding" 1 "DOOMED HOST"

# The json seam a scheduled job gates on must carry the new verdict too.
run "$WORK/doomed.json" --json
expect "json carries the DOOMED-HOST verdict" 1 '"verdict": "DOOMED-HOST"'

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
