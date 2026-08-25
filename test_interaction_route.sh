#!/usr/bin/env bash
# ===========================================================================
# test_interaction_route.sh — suite for interaction_route.sh (TOG-389)
# ===========================================================================
# Needs nothing: no API key, no VPS, no database. Every case is a literal JSON
# fixture or a flag combination, so this runs in CI and in an agent container.
#
# Assertions pin EXIT STATUS, not message text (CONTRIBUTING.md). The one place
# text is asserted is the refusal *reason* in `check`, because that reason is
# the tool's actual product — it names which gate fired, and a tool that
# refuses for the wrong reason sends the caller to fix the wrong thing.
#
# §9 is a mutation check. It restores the bug that live data caught during
# development — review-eligibility defaulting to true — and asserts the suite
# goes RED. A fail-closed test that stays green against that mutation is
# asserting nothing.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/interaction_route.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
EX_OK=0; EX_USAGE=2; EX_RESERVED=3; EX_UNANSWERABLE=4; EX_NOT_A_QUESTION=5

ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

# assert_exit <expected> <label> -- <command...>
assert_exit() {
  local want="$1" label="$2"; shift 3
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  if [[ "$rc" == "$want" ]]; then ok "$label"
  else bad "$label" "expected exit $want, got $rc"; fi
}

# assert_reason <issue> <substring> <fixture>
assert_reason() {
  local issue="$1" want="$2" fixture="$3"
  local line
  line="$("$TOOL" check < "$fixture" 2>/dev/null | awk -v i="$issue" '$1==i')"
  if [[ "$line" == *"$want"* ]]; then ok "check: $issue -> $want"
  else bad "check: $issue -> $want" "got: ${line:-<no row>}"; fi
}

A_SELF="aaaaaaaa-0000-0000-0000-000000000001"
A_PEER="bbbbbbbb-0000-0000-0000-000000000002"
A_THIRD="cccccccc-0000-0000-0000-000000000003"

printf '\n== §1 usage and argument validation ==\n'
assert_exit "$EX_USAGE" "no subcommand is a usage error"      -- "$TOOL"
assert_exit "$EX_USAGE" "unknown subcommand is a usage error" -- "$TOOL" frobnicate
assert_exit "$EX_USAGE" "unknown option is a usage error"     -- "$TOOL" route --wat
assert_exit "$EX_OK"    "--help succeeds"                     -- "$TOOL" --help
assert_exit "$EX_OK"    "explain succeeds"                    -- "$TOOL" explain
assert_exit "$EX_USAGE" "bad --answer-type is refused"        -- \
  "$TOOL" route --answer-type telepathy --addressee "$A_PEER"
# An agent-routable ask with nobody to answer it is a usage error, not a
# silently-addressed-to-the-board interaction. That drift is the whole bug.
assert_exit "$EX_USAGE" "routable ask without --addressee is refused" -- \
  "$TOOL" route --answer-type yes_no

printf '\n== §2 the five reserved matters each route to the owner ==\n'
for flag in --spends-money --credential-external --org-structure \
            --reverses-owner-preference --public-commitment; do
  assert_exit "$EX_RESERVED" "reserved: $flag" -- \
    "$TOOL" route "$flag" --addressee "$A_PEER" --issue-assignee "$A_PEER" --self "$A_SELF"
done
# Reserved must win even when every routing preconditon is otherwise perfect --
# otherwise the test would pass for the wrong reason.
assert_exit "$EX_RESERVED" "reserved beats a fully-valid agent route" -- \
  "$TOOL" route --spends-money --answer-type choice \
  --addressee "$A_PEER" --issue-assignee "$A_PEER" --self "$A_SELF"

printf '\n== §3 spending quota is NOT spending money ==\n'
# The distinction the company keeps getting wrong: unused weekly quota is
# destroyed at reset, so underrunning the budget is the waste. --spends-quota
# must not trip the reserved gate.
assert_exit "$EX_OK" "--spends-quota is not reserved" -- \
  "$TOOL" route --spends-quota --addressee "$A_PEER" --issue-assignee "$A_PEER" --self "$A_SELF"

printf '\n== §4 a human capability is not a human decision ==\n'
assert_exit "$EX_NOT_A_QUESTION" "needs-human-capability is not a question" -- \
  "$TOOL" route --needs-human-capability --addressee "$A_PEER" \
  --issue-assignee "$A_PEER" --self "$A_SELF"
# Reserved outranks capability: a root command that also spends money is still
# the owner's call, not a runbook line.
assert_exit "$EX_RESERVED" "reserved outranks needs-human-capability" -- \
  "$TOOL" route --needs-human-capability --spends-money --addressee "$A_PEER" \
  --issue-assignee "$A_PEER" --self "$A_SELF"

printf '\n== §5 route refuses envelopes that would be inert ==\n'
assert_exit "$EX_OK" "happy path: addressee is the assignee and is not me" -- \
  "$TOOL" route --addressee "$A_PEER" --issue-assignee "$A_PEER" --self "$A_SELF"
# :2975 — you may never answer your own ask.
assert_exit "$EX_UNANSWERABLE" "inert: addressee == self (creator bar :2975)" -- \
  "$TOOL" route --addressee "$A_SELF" --issue-assignee "$A_SELF" --self "$A_SELF"
# :2946 — the addressee must be the assignee. This is the 42-of-49 failure.
assert_exit "$EX_UNANSWERABLE" "inert: addressee is not the assignee (:2946)" -- \
  "$TOOL" route --addressee "$A_PEER" --issue-assignee "$A_THIRD" --self "$A_SELF"
# Unassigned issues are open to any agent (:2792), so omitting --issue-assignee
# must not be treated as a mismatch.
assert_exit "$EX_OK" "unassigned issue: no assignee mismatch" -- \
  "$TOOL" route --addressee "$A_PEER" --self "$A_SELF"

printf '\n== §6 kind follows what you need back, not the policy ==\n'
kind_of() { "$TOOL" route --json --answer-type "$1" --addressee "$A_PEER" \
              --issue-assignee "$A_PEER" --self "$A_SELF" | jq -r .kind; }
[[ "$(kind_of yes_no)" == "request_confirmation" ]] \
  && ok "yes_no -> request_confirmation" || bad "yes_no -> request_confirmation" "got $(kind_of yes_no)"
[[ "$(kind_of choice)" == "ask_user_questions" ]] \
  && ok "choice -> ask_user_questions" || bad "choice -> ask_user_questions" "got $(kind_of choice)"
# Both routable kinds must carry board_or_agents explicitly. Relying on the
# per-kind default is exactly how 110 of 113 confirmations became owner-bound.
for at in yes_no choice; do
  pol="$("$TOOL" route --json --answer-type "$at" --addressee "$A_PEER" \
          --issue-assignee "$A_PEER" --self "$A_SELF" | jq -r .resolverPolicy)"
  [[ "$pol" == "board_or_agents" ]] && ok "$at carries board_or_agents explicitly" \
    || bad "$at carries board_or_agents explicitly" "got $pol"
done

printf '\n== §7 check: the resolvability predicate ==\n'
mk() { printf '%s' "$1" > "$WORK/$2.json"; }

# Each fixture differs from the resolvable baseline in exactly ONE field, so a
# refusal is attributable to that field and not over-determined.
mk '[{"identifier":"BASE","issueStatus":"blocked","kind":"ask_user_questions",
      "status":"pending","effectiveResolverPolicy":"board_or_agents",
      "createdByAgentId":"'"$A_SELF"'","assigneeAgentId":"'"$A_PEER"'",
      "addresseeAgentId":null,"hasToolAction":false}]' base
assert_reason BASE "ok" "$WORK/base.json"

mk '[{"identifier":"CBAR","issueStatus":"blocked","kind":"ask_user_questions",
      "status":"pending","effectiveResolverPolicy":"board_or_agents",
      "createdByAgentId":"'"$A_PEER"'","assigneeAgentId":"'"$A_PEER"'",
      "addresseeAgentId":null,"hasToolAction":false}]' cbar
assert_reason CBAR ":2975" "$WORK/cbar.json"

mk '[{"identifier":"POL","issueStatus":"blocked","kind":"ask_user_questions",
      "status":"pending","effectiveResolverPolicy":"board_only",
      "createdByAgentId":"'"$A_SELF"'","assigneeAgentId":"'"$A_PEER"'",
      "addresseeAgentId":null,"hasToolAction":false}]' pol
assert_reason POL ":2962" "$WORK/pol.json"

# A tool-action confirmation is board-only even when policy AND creator are
# both fine -- so this asserts the toolAction clause specifically.
mk '[{"identifier":"TOOL","issueStatus":"blocked","kind":"request_confirmation",
      "status":"pending","effectiveResolverPolicy":"board_or_agents",
      "createdByAgentId":"'"$A_SELF"'","assigneeAgentId":"'"$A_PEER"'",
      "addresseeAgentId":null,"hasToolAction":true}]' tool
assert_reason TOOL ":2952" "$WORK/tool.json"

# Addressed to someone who is not the assignee: the addressee cannot pass :2946.
mk '[{"identifier":"ADDR","issueStatus":"blocked","kind":"ask_user_questions",
      "status":"pending","effectiveResolverPolicy":"board_or_agents",
      "createdByAgentId":"'"$A_SELF"'","assigneeAgentId":"'"$A_PEER"'",
      "addresseeAgentId":"'"$A_THIRD"'","hasToolAction":false}]' addr
assert_reason ADDR ":2946" "$WORK/addr.json"

# An unassigned issue is resolvable by any agent (:2792).
mk '[{"identifier":"UNASSIGNED","issueStatus":"blocked","kind":"ask_user_questions",
      "status":"pending","effectiveResolverPolicy":"board_or_agents",
      "createdByAgentId":"'"$A_SELF"'","assigneeAgentId":null,
      "addresseeAgentId":null,"hasToolAction":false}]' unassigned
assert_reason UNASSIGNED "ok" "$WORK/unassigned.json"

printf '\n== §8 check: the review-verdict bypass, and its fail-closed default ==\n'
# board_only + in_review + a confirmation + NAMED as reviewInteractionId
# => resolvable, because :2956 skips the policy check at :2962.
mk '[{"identifier":"RV","issueStatus":"in_review","kind":"request_confirmation",
      "status":"pending","effectiveResolverPolicy":"board_only",
      "createdByAgentId":"'"$A_SELF"'","assigneeAgentId":"'"$A_PEER"'",
      "addresseeAgentId":null,"hasToolAction":false,"isReviewVerdict":true}]' rv
assert_reason RV "ok" "$WORK/rv.json"

# THE REGRESSION. Identical to RV except isReviewVerdict is omitted -- exactly
# one field removed, so the refusal is attributable to it alone. Live data had
# three rows in this shape (a spend approval, a credential placement, a brand
# decision) and the first draft called all three agent-resolvable.
mk '[{"identifier":"RVNONE","issueStatus":"in_review","kind":"request_confirmation",
      "status":"pending","effectiveResolverPolicy":"board_only",
      "createdByAgentId":"'"$A_SELF"'","assigneeAgentId":"'"$A_PEER"'",
      "addresseeAgentId":null,"hasToolAction":false}]' rvnone
assert_reason RVNONE ":2962" "$WORK/rvnone.json"

# The bypass is confirmation-only: request_item_verdicts must not get it.
mk '[{"identifier":"RVKIND","issueStatus":"in_review","kind":"request_item_verdicts",
      "status":"pending","effectiveResolverPolicy":"board_only",
      "createdByAgentId":"'"$A_SELF"'","assigneeAgentId":"'"$A_PEER"'",
      "addresseeAgentId":null,"hasToolAction":false,"isReviewVerdict":true}]' rvkind
assert_reason RVKIND ":2962" "$WORK/rvkind.json"

printf '\n== §9 mutation check: the fail-closed default must be load-bearing ==\n'
# Baseline first. Without this, "the mutated copy failed" is unattributable --
# it could have failed because the staging copy was broken.
MUT="$WORK/mutant.sh"
cp "$TOOL" "$MUT"; chmod +x "$MUT"
if "$MUT" check < "$WORK/rvnone.json" 2>/dev/null | awk '$1=="RVNONE"' | grep -q "false"; then
  ok "baseline: unmutated copy refuses RVNONE in the staging dir"
else
  bad "baseline: unmutated copy refuses RVNONE" "staging copy is broken; §9 proves nothing"
fi
# Restore the bug: default review-eligibility to true.
sed -i 's/(\$i.isReviewVerdict \/\/ false)/($i.isReviewVerdict \/\/ true)/' "$MUT"
if grep -q 'isReviewVerdict // true' "$MUT"; then
  ok "mutation applied"
  if "$MUT" check < "$WORK/rvnone.json" 2>/dev/null | awk '$1=="RVNONE"' | grep -q "true"; then
    ok "mutation is caught: mutant wrongly calls RVNONE resolvable"
  else
    bad "mutation is caught" "mutant still refuses RVNONE -- the guard is not load-bearing"
  fi
else
  bad "mutation applied" "sed did not match; the mutation check is inert"
fi

printf '\n== §10 check: input handling and the --strict gate ==\n'
assert_exit "$EX_USAGE" "non-array input is refused" -- \
  bash -c "printf '{\"a\":1}' | '$TOOL' check"
assert_exit "$EX_USAGE" "empty input is refused" -- \
  bash -c "printf '' | '$TOOL' check"
assert_exit "$EX_OK" "empty array is accepted" -- \
  bash -c "printf '[]' | '$TOOL' check"
assert_exit "$EX_OK" "--strict passes when everything is resolvable" -- \
  bash -c "'$TOOL' check --strict < '$WORK/base.json'"
assert_exit "$EX_UNANSWERABLE" "--strict fails when something is unresolvable" -- \
  bash -c "'$TOOL' check --strict < '$WORK/cbar.json'"
# Zero-vs-zero must not read green: an empty array under --strict is "nothing
# measured", and must not be reported as a clean bill of health.
count="$(printf '[]' | "$TOOL" check 2>/dev/null | tail -1)"
[[ "$count" == *"0 of 0"* ]] && ok "empty input reports 0 of 0, not silence" \
  || bad "empty input reports 0 of 0" "got: $count"

printf '\n== §11 INTERACTION_SOURCE_CMD seam ==\n'
# The seam must be FAKED, not omitted: podman and psql are both absent from an
# agent container, so a tool that only reads a real DB is untestable here.
printf '#!/usr/bin/env bash\ncat %s\n' "$WORK/cbar.json" > "$WORK/src.sh"
chmod +x "$WORK/src.sh"
assert_exit "$EX_UNANSWERABLE" "source cmd feeds check (and --strict still fires)" -- \
  bash -c "INTERACTION_SOURCE_CMD='$WORK/src.sh' '$TOOL' check --strict"
assert_exit "$EX_USAGE" "a failing source cmd is an error, not an empty pass" -- \
  bash -c "INTERACTION_SOURCE_CMD=/nonexistent/nope '$TOOL' check"

printf '\n---------------------------------------------\n'
printf 'passed: %d   failed: %d\n' "$PASS" "$FAIL"
(( FAIL == 0 )) || exit 1
exit 0
