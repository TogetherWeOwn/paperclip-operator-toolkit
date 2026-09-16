#!/usr/bin/env bash
# ===========================================================================
# test_grant_attribution.sh — offline suite for scripts/grant_attribution.js
# (TOG-870).
#
# No database, no network, no credentials. Every case is a synthetic source
# document fed through GRANT_ATTRIBUTION_SOURCE_CMD, so CI can run this.
#
# WHAT THIS SUITE IS BUILT TO CATCH:
#
#  * THE SILENT GREEN, which here has TWO shapes and only one of them looks
#    like a failure. An empty ACTIVITY read makes every grant resolve
#    unattributable — loud, wrong, but at least visible. An empty GRANT read
#    reports "0 unattributable of 0" and exits 0: a perfect audit derived from
#    reading nothing. §4 and §5 pin exit 5 on both. Both states are reachable
#    in production from a mis-scoped query, which returns zero rows rather
#    than an error.
#
#  * A MANUFACTURED ATTRIBUTION. §3 puts two different actors in one grant's
#    window. Picking the nearest timestamp would write a confident, possibly
#    wrong grantor into an audit trail — worse than a known gap. The mirror
#    error is pinned beside it: the SAME actor logged twice must NOT read as
#    ambiguous, or ordinary double-logging turns a clean row into a finding.
#
#  * THE JOIN LOSING ITS KEY. §6 pins that another agent's activity, an
#    out-of-window row, and an unrelated action all fail to attribute. A join
#    that matched on time alone would attribute grants to whoever happened to
#    act nearby.
#
#  * A DERIVED INFERENCE PRESENTED AS A RECORDED FACT. §7 pins that direct and
#    derived stay separate in both renderings, and that the report says the
#    derived attribution is not written back. Collapsing them into one number
#    is how an audit log starts lying with confidence.
#
#  * THE SELF-GRANT CONTROL FAILING, in both directions. §8 pins that a
#    principal granting itself is caught and outranks every other verdict, and
#    that an ordinary user-to-agent grant does NOT trip it. A control that
#    fires on everything gets muted.
#
#  * A REFUSAL FROM THE WRONG BRANCH. Exit codes alone would let any refusal
#    read as the intended one, so every assertion pins the VERDICT text too.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/scripts/grant_attribution.js"
PASS=0; FAIL=0

[ -f "$TOOL" ] || { echo "FATAL: $TOOL not found"; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# Fixed ids. A/B are agents receiving grants; CEO is an agent grantor; USER is
# the board owner, the only principal the schema can attribute directly.
A="aaaaaaaa-1111-2222-3333-444444444444"
B="bbbbbbbb-1111-2222-3333-444444444444"
CEO="cccccccc-1111-2222-3333-444444444444"
USER="UsRxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"   # synthetic; see grant_attribution.js --selftest

T0="2026-09-03T07:18:00.000Z"
T9="2026-09-03T07:18:00.009Z"   # +9ms — the real observed delta
T20="2026-09-03T07:18:00.020Z"
TFAR="2026-09-03T07:18:30.000Z" # +30s — outside the window

# grant <principal> <key> <granted_by_user_id|null> [createdAt]
grant() {
  local gbu=$3
  [ "$gbu" = "null" ] && gbu=null || gbu="\"$gbu\""
  printf '{"principalId":"%s","permissionKey":"%s","grantedByUserId":%s,"createdAt":"%s"}' \
    "$1" "$2" "$gbu" "${4:-$T0}"
}

# act <entityId> <actorType> <actorId> [createdAt] [action]
act() {
  printf '{"entityId":"%s","actorType":"%s","actorId":"%s","createdAt":"%s","action":"%s","runId":null}' \
    "$1" "$2" "$3" "${4:-$T0}" "${5:-agent.permissions_updated}"
}

# doc <file> <grants-json-array> <activity-json-array>
doc() { printf '{"grants":%s,"activity":%s}\n' "$2" "$3" > "$1"; }

run() {
  local f=$1; shift
  OUT="$(GRANT_ATTRIBUTION_SOURCE_CMD="cat $f" bash -c 'node "$0" "$@" 2>&1' "$TOOL" "$@")"
  CODE=$?
}

expect() { # expect <label> <want-code> <want-substring>
  local label=$1 wantc=$2 wants=$3
  if [ "$CODE" != "$wantc" ]; then
    bad "$label" "exit $CODE, wanted $wantc. Output: $(printf '%s' "$OUT" | tail -4 | tr '\n' ' ')"
  elif ! grep -qF "$wants" <<<"$OUT"; then
    bad "$label" "missing '$wants'. Output: $(printf '%s' "$OUT" | tail -4 | tr '\n' ' ')"
  else
    ok "$label"
  fi
}

expect_absent() { # expect_absent <label> <want-code> <forbidden-substring>
  local label=$1 wantc=$2 forbidden=$3
  if [ "$CODE" != "$wantc" ]; then
    bad "$label" "exit $CODE, wanted $wantc"
  elif grep -qF "$forbidden" <<<"$OUT"; then
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
if grep -qE 'selftest 0/' <<<"$out"; then
  bad "selftest ran assertions" "it scored 0 cases"
else
  ok "selftest ran a non-zero number of cases"
fi

echo "== 1. the TOG-870 shape: an agent grant recovered from activity_log =="
# The card claimed this grantor was unrecoverable. It is one join away.
doc "$WORK/derived.json" "[$(grant $A tasks:assign null)]" "[$(act $A agent $CEO $T9)]"
run "$WORK/derived.json"
expect "an agent-made grant is attributed -> exit 0" 0 "ATTRIBUTED"
run "$WORK/derived.json"
expect "...and is counted as derived, not direct" 0 "derived  (activity_log join)  1"
run "$WORK/derived.json"
expect "...and names the granting agent" 0 "agent:cccccccc"

echo "== 2. a directly attributed row is never overruled by the join =="
# granted_by_user_id is a fact the server wrote; the join only fills gaps.
doc "$WORK/direct.json" "[$(grant $A tasks:assign $USER)]" "[$(act $A agent $CEO $T9)]"
run "$WORK/direct.json"
expect "granted_by_user_id wins -> counted direct" 0 "direct   (granted_by_user_id) 1"
run "$WORK/direct.json"
expect_absent "...and the nearby activity row does not make it derived" 0 "derived  (activity_log join)  1"

echo "== 3. ambiguity is a refusal, never a coin flip =="
# Two actors in one window. Nearest-wins would invent a grantor.
doc "$WORK/ambig.json" "[$(grant $A tasks:assign null)]" "[$(act $A agent $CEO $T9),$(act $A user $USER $T20)]"
run "$WORK/ambig.json"
expect "two actors in the window -> UNATTRIBUTED, exit 1" 1 "UNATTRIBUTED"
run "$WORK/ambig.json"
expect "...reported as ambiguous, naming both candidates" 1 "ambiguous:"
# The mirror error. Double-logging the same actor must stay attributed, or
# ordinary retries turn clean rows into findings and the tool gets muted.
doc "$WORK/twice.json" "[$(grant $A tasks:assign null)]" "[$(act $A agent $CEO $T9),$(act $A agent $CEO $T20)]"
run "$WORK/twice.json"
expect "the SAME actor logged twice is still attributed -> exit 0" 0 "ATTRIBUTED"

echo "== 4. THE SILENT GREEN: zero grants must never read as a clean audit =="
# The dangerous shape: it exits 0 and reports full coverage of nothing.
doc "$WORK/nogrants.json" "[]" "[$(act $A agent $CEO $T9)]"
run "$WORK/nogrants.json"
expect "zero grant rows -> exit 5 UNKNOWN" 5 "UNKNOWN"
run "$WORK/nogrants.json"
expect "...and says it read nothing" 5 "ZERO grant rows"
run "$WORK/nogrants.json"
expect_absent "...and never claims everything is attributed" 5 "ATTRIBUTED:"

echo "== 5. zero activity is a false catastrophe, and also refuses =="
doc "$WORK/noact.json" "[$(grant $A tasks:assign null)]" "[]"
run "$WORK/noact.json"
expect "zero activity rows -> exit 5 UNKNOWN" 5 "ZERO grant-bearing activity"
run "$WORK/noact.json"
expect_absent "...and does not report 1 of 1 unattributable" 5 "UNATTRIBUTED:"

echo "== 6. the join is keyed on the AGENT, not merely on time =="
# Another agent's activity, however close, must not attribute this grant.
doc "$WORK/other.json" "[$(grant $A tasks:assign null),$(grant $B x null)]" "[$(act $B agent $CEO $T9)]"
run "$WORK/other.json"
expect "another agent's activity does not attribute this grant" 1 "UNATTRIBUTED"
run "$WORK/other.json"
expect "...exactly one row stays unattributable" 1 "unattributable                1"
# Out of window: a permissions edit made 30s later is not this grant's author.
doc "$WORK/far.json" "[$(grant $A tasks:assign null)]" "[$(act $A agent $CEO $TFAR)]"
run "$WORK/far.json"
expect "an activity row outside the window does not match" 1 "no activity_log row"
# An unrelated action in the window must not attribute either. NOTE the second
# grant and its matching activity row: without a grant-bearing activity row
# somewhere in the document, `activityKnown` is 0 and the exit-5 refusal fires
# first — which would make this case pass for the wrong reason and prove
# nothing about action filtering.
doc "$WORK/unrel.json" \
  "[$(grant $A tasks:assign null),$(grant $B skills:create null)]" \
  "[$(act $A agent $CEO $T9 issue.updated),$(act $B agent $CEO $T9)]"
run "$WORK/unrel.json"
expect "an unrelated action does not attribute a grant" 1 "no activity_log row"
run "$WORK/unrel.json"
expect "...while the grant-bearing row beside it still attributes" 1 "derived  (activity_log join)  1"
# The control for all three: the same shapes DO attribute when they should.
doc "$WORK/ctl.json" "[$(grant $A tasks:assign null)]" "[$(act $A agent $CEO $T9)]"
run "$WORK/ctl.json"
expect "the control: a matching row still attributes -> exit 0" 0 "ATTRIBUTED"

echo "== 7. a derived inference is never presented as a recorded fact =="
doc "$WORK/mixed.json" \
  "[$(grant $A tasks:assign $USER),$(grant $B skills:create null)]" \
  "[$(act $B agent $CEO $T9)]"
run "$WORK/mixed.json"
expect "direct and derived are counted separately" 0 "direct   (granted_by_user_id) 1"
run "$WORK/mixed.json"
expect "...both lines present" 0 "derived  (activity_log join)  1"
run "$WORK/mixed.json"
expect "...and the report says derived is NOT written back" 0 "NOT written back"
run "$WORK/mixed.json" --json
expect "json carries the derived count as its own field" 0 '"derived": 1'
run "$WORK/mixed.json" --json
expect "...and the direct count separately" 0 '"direct": 1'

echo "== 8. the self-grant control, in both directions =="
# The charter metric: no request decided by its own requester.
doc "$WORK/self.json" "[$(grant $A tasks:assign null)]" "[$(act $A agent $A $T9)]"
run "$WORK/self.json"
expect "a principal granting ITSELF -> exit 1" 1 "SELF-GRANT"
run "$WORK/self.json"
expect "...names the principal" 1 "granted ITSELF tasks:assign"
# It must outrank a merely-anonymous row, or the finding that matters most
# gets buried under a long list of ordinary gaps.
doc "$WORK/selfmix.json" \
  "[$(grant $A tasks:assign null),$(grant $B x null)]" \
  "[$(act $A agent $A $T9)]"
run "$WORK/selfmix.json"
expect "a self-grant outranks UNATTRIBUTED in the verdict" 1 "SELF-GRANT:"
# THE FAIL-LOUD GUARD. An ordinary user-to-agent grant must not trip it.
doc "$WORK/notself.json" "[$(grant $A tasks:assign null)]" "[$(act $A user $USER $T9)]"
run "$WORK/notself.json"
expect_absent "an ordinary user-to-agent grant is NOT a self-grant" 0 "SELF-GRANT"
# ...nor may an agent granting a DIFFERENT agent.
doc "$WORK/agent2agent.json" "[$(grant $A tasks:assign null)]" "[$(act $A agent $CEO $T9)]"
run "$WORK/agent2agent.json"
expect_absent "an agent granting a DIFFERENT agent is not a self-grant" 0 "SELF-GRANT"

echo "== 9. the production shape: org_provisioner's direct-INSERT rows =="
# 25 real rows on this board have no activity_log row at all, because
# org_provisioner.sh writes them with raw SQL. They must be visible, not
# silently folded into the derived count.
doc "$WORK/prov.json" \
  "[$(grant $A agents:configure null),$(grant $A tasks:assign_scope null),$(grant $B skills:create null)]" \
  "[$(act $B agent $CEO $T9)]"
run "$WORK/prov.json"
expect "direct-INSERT rows are reported unattributable -> exit 1" 1 "unattributable                2"
run "$WORK/prov.json"
expect "...and each is named with its permission key" 1 "agents:configure  [no activity_log row]"

echo "== 10. --json carries the verdict a scheduled job would gate on =="
run "$WORK/prov.json" --json
expect "json output carries the verdict" 1 '"verdict": "UNATTRIBUTED"'
run "$WORK/nogrants.json" --json
expect "json output carries the refusal too" 5 '"verdict": "UNKNOWN"'
run "$WORK/self.json" --json
expect "json output carries the self-grant verdict" 1 '"verdict": "SELF-GRANT"'

echo "== 11. the seam itself refuses rather than passing =="
OUT="$(GRANT_ATTRIBUTION_SOURCE_CMD='echo not-json' bash -c 'node "$0" 2>&1' "$TOOL")"; CODE=$?
expect "a source command emitting garbage -> exit 2" 2 "grant attribution failed"
OUT="$(bash -c 'node "$0" --wat 2>&1' "$TOOL")"; CODE=$?
expect "an unknown argument -> exit 2" 2 "unknown argument"
# The scope guard. Both tables span every company on this host.
OUT="$(env -u PAPERCLIP_COMPANY_ID -u GRANT_ATTRIBUTION_SOURCE_CMD DATABASE_URL=postgres://unused \
      bash -c 'node "$0" 2>&1' "$TOOL")"; CODE=$?
expect "a missing company scope refuses before connecting -> exit 2" 2 "PAPERCLIP_COMPANY_ID is not set"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
