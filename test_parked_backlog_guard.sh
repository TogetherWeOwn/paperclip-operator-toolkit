#!/usr/bin/env bash
# ===========================================================================
# test_parked_backlog_guard.sh — offline suite for
# scripts/parked_backlog_guard.js (TOG-3465).
#
# No database, no network, no credentials. Every case is a synthetic source
# document fed through PARKED_GUARD_SOURCE_CMD, so CI can run this.
#
# WHAT THIS SUITE IS BUILT TO CATCH:
#
#  * THE SILENT GREEN. This detector's whole failure mode is measuring
#    nothing. If the comment read comes back empty, every card classifies
#    `queuable` and the tool reports a clean candidate set having looked at
#    nothing. §4 and §5 pin exit 5 on both empty inputs. This is the single
#    most important section here: an unscoped or mis-scoped query returns
#    zero rows rather than an error, so the state is REACHABLE.
#
#  * THE OPERATOR PROMOTION READING AS A PARK. The sweep's own comment —
#    `Operator ... (owner: "get work moving") — promoted from backlog to
#    todo` — says "backlog" and "todo" and is author_type=user. §2 pins that
#    operator prose never exempts a card, even when it names the statuses.
#
#  * AUTHORSHIP INVERSION. The heuristic's signal is agent-authored intent.
#    §3 pins that user prose quoting parking language does NOT park a card,
#    while an older agent park remains evidence beneath unrelated notes.
#    Section 7 maintains the independent QA preservation regressions.
#
#  * THE DESCRIPTION FALLBACK GOING QUIET. TOG-3303's rationale lives in its
#    description, not its newest comment. §1 pins that a parked-in-prose
#    card classifies parked with evidence=description even under operator
#    notes — and that a plain description stays queuable.
#
#  * THE TOUCHED LIST SWALLOWING A PARK. §6 pins that parked cards land in
#    the failing section with quoted evidence, and agent-touched-but-clean
#    cards land in the informational section without failing the run.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/scripts/parked_backlog_guard.js"
PASS=0; FAIL=0

[ -f "$TOOL" ] || { echo "FATAL: $TOOL not found"; exit 2; }

WORK="$(mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}/parked-guard.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

AGENT_A="aaaaaaaa-1111-2222-3333-444444444444"
AGENT_B="bbbbbbbb-1111-2222-3333-444444444444"
USER_OWEN="TVLjBoxr6NYBsvfQz8bol6NzcjnB3VHh"

# card <identifier> <assignee> <description> -> one backlog row (no trailing newline)
card() {
  printf '{"identifier":"%s","assigneeAgentId":"%s","description":"%s"}' "$1" "$2" "$3"
}

# cmt <id> <issue> <authorType> <authorId> <createdAt> <body> -> one comment row
cmt() {
  printf '{"id":"%s","issueIdentifier":"%s","authorType":"%s","%s":"%s","createdAt":"%s","body":"%s"}' \
    "$1" "$2" "$3" "$([ "$3" = agent ] && echo authorAgentId || echo authorUserId)" "$4" "$5" "$6"
}

# doc <file> <backlog-array> <comments-array>
doc() {
  printf '{"backlog":[%s],"comments":[%s]}\n' "$2" "$3" > "$1"
}

# run <file> [args...] -> sets OUT and CODE
run() {
  local f=$1; shift
  OUT="$(PARKED_GUARD_SOURCE_CMD="cat $f" bash -c 'node "$0" "$@" 2>&1' "$TOOL" "$@")"
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

PARK_CMT='Parked to backlog under TOG-3240 (routing/ops non-product burn cap). Lane optimization, not active breakage.'
SWEEP_CMT='Operator 2026-09-20 05:30Z (owner: get work moving) - promoted from backlog to todo; agents are idle and this is assigned to you. Pick it up.'
REVERT_CMT='Still parked under TOG-3240. The 05:24Z operator promotion is the generic sweep, not an unpark. Reverting to backlog.'
PLAIN_DESC='File the next batch of executable slices in project order.'
PARK_DESC='Why backlog, not todo: Parked per TOG-3240 (CTO non-product burn cap). CTO owns unpark.'

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

echo "== 1. the production shape: TOG-3230 (agent park comment) and TOG-3303 (description rationale) =="
# TOG-3303's newest comment in this fixture is the operator sweep note, so its
# description rationale is what exempts it; TOG-3230 exempts via its newest
# agent-authored park comment. (Live, TOG-3303's newest comment is also an
# agent revert — either evidence source reaches the same verdict.)
doc "$WORK/prod.json" \
  "$(card TOG-3230 agent-1 "$PLAIN_DESC"),$(card TOG-3303 agent-2 "$PARK_DESC")" \
  "$(cmt c1 TOG-3230 agent $AGENT_A 2026-09-17T10:42:50Z "$PARK_CMT"),$(cmt c3 TOG-3303 user $USER_OWEN 2026-09-20T05:24:23Z "$SWEEP_CMT")"
run "$WORK/prod.json"
expect "agent-parked cards -> PARKED, exit 1" 1 "PARKED backlog cards (sweep must skip): 2 of 2"
run "$WORK/prod.json"
expect "TOG-3230 named via its comment evidence" 1 "TOG-3230"
run "$WORK/prod.json"
expect "TOG-3303 named via its description evidence" 1 "TOG-3303"
run "$WORK/prod.json"
expect "comment evidence quoted" 1 "evidence: comment"
run "$WORK/prod.json"
expect "description evidence quoted" 1 "evidence: description"

echo "== 2. the sweep's own promotion comment never parks a card =="
doc "$WORK/sweep.json" \
  "$(card TOG-9999 agent-1 "$PLAIN_DESC")" \
  "$(cmt c1 TOG-9999 user $USER_OWEN 2026-09-20T05:24:23Z "$SWEEP_CMT")"
run "$WORK/sweep.json"
expect "sweep comment -> clean, exit 0" 0 "No park signal. Checked 1 backlog cards"
run "$WORK/sweep.json" --json
expect "machine verdict is not scheduling approval" 0 '"verdict": "NO_PARK_SIGNAL"'
expect "machine report never authorizes promotion" 0 '"promotionAuthorized": false'
expect "machine report identifies detector-only mode" 0 '"mode": "detector-only"'
expect "machine report disclaims scheduling evidence" 0 '"schedulingEvidence": "not-verified"'

echo "== 3. authorship: user prose quoting parking language is not a park =="
doc "$WORK/user.json" \
  "$(card TOG-9998 agent-1 "$PLAIN_DESC")" \
  "$(cmt c1 TOG-9998 user $USER_OWEN 2026-09-20T05:24:23Z 'This was parked before; picking it up now.'),$(cmt c2 TOG-9998 agent $AGENT_A 2026-09-19T03:02:14Z 'Now running the suite plus typecheck.')"
run "$WORK/user.json"
expect "user-authored park mention -> clean" 0 "No park signal"
# No recognized park marker in either comment or description. Contrast the
# older documented parks in section 7: those must survive operator notes.
doc "$WORK/order.json" \
  "$(card TOG-9997 agent-1 'Router accuracy follow-up.')" \
  "$(cmt c1 TOG-9997 user $USER_OWEN 2026-09-20T01:00:00Z 'Reconciled and back to todo; please resume.'),$(cmt c2 TOG-9997 agent $AGENT_A 2026-09-19T03:02:14Z 'Restored status to backlog.')"
run "$WORK/order.json"
expect "operator-over-agent with no rationale -> clean" 0 "No park signal"

echo "== 4. empty comment read refuses with 5, never green =="
doc "$WORK/nocomments.json" \
  "$(card TOG-9996 agent-1 "$PARK_DESC")" \
  ""
run "$WORK/nocomments.json"
expect "zero comments -> UNKNOWN, exit 5" 5 "UNKNOWN: could not measure"
run "$WORK/nocomments.json"
expect_absent "zero comments must not print a clean bill" 5 "No park signal"

echo "== 5. empty backlog list refuses with 5, never green =="
doc "$WORK/nocards.json" "" "$(cmt c1 TOG-9996 agent $AGENT_A 2026-09-19T03:02:14Z "$PARK_CMT")"
run "$WORK/nocards.json"
expect "zero backlog cards -> UNKNOWN, exit 5" 5 "UNKNOWN: could not measure"
run "$WORK/nocards.json"
expect_absent "zero cards must not print a clean bill" 5 "No park signal"

echo "== 6. evidence sections: parked fails, touched informs =="
doc "$WORK/mixed.json" \
  "$(card TOG-3230 agent-1 "$PLAIN_DESC"),$(card TOG-9995 agent-1 "$PLAIN_DESC")" \
  "$(cmt c1 TOG-3230 agent $AGENT_A 2026-09-17T10:42:50Z "$PARK_CMT"),$(cmt c2 TOG-9995 agent $AGENT_B 2026-09-19T22:59:39Z 'Now running the suite plus typecheck.')"
run "$WORK/mixed.json"
expect "mixed set -> PARKED, exit 1" 1 "PARKED backlog cards (sweep must skip): 1 of 2"
run "$WORK/mixed.json"
expect "parked card quoted with markers" 1 "markers:"
run "$WORK/mixed.json"
expect "touched card listed as informational" 1 "TOG-9995"
run "$WORK/mixed.json"
expect_absent "touched card must not read as a finding" 1 "TOG-9995  (assignee"

echo "== 7. QA park-preservation regressions =="
if node "$HERE/test/parked_backlog_guard_preservation.cjs" "$TOOL"; then
  ok "maintained park-preservation regressions"
else
  bad "maintained park-preservation regressions"
fi

echo "== 8. unavailable and corrupt sources refuse without leaking source text =="
OUT="$(PARKED_GUARD_SOURCE_CMD='printf fixture-secret-sentinel >&2; exit 9' node "$TOOL" --json 2>&1)"
CODE=$?
expect "source failure is UNKNOWN" 5 '"verdict": "UNKNOWN"'
expect_absent "source failure redacts stderr and command" 5 'fixture-secret-sentinel'
expect "source failure cannot authorize" 5 '"promotionAuthorized": false'
printf 'fixture-secret-sentinel invalid json\n' > "$WORK/corrupt.json"
run "$WORK/corrupt.json" --json
expect "corrupt JSON is UNKNOWN" 5 '"verdict": "UNKNOWN"'
expect_absent "corrupt JSON redacts input" 5 'fixture-secret-sentinel'
run "$WORK/corrupt.json"
expect "human source failure refuses" 5 'UNKNOWN: could not measure'
expect "human source failure disclaims authorization" 5 'DETECTOR ONLY'

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
