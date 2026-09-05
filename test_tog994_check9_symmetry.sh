#!/usr/bin/env bash
# ===========================================================================
# test_tog994_check9_symmetry.sh — check 9 must ask the SAME question of both
# sides of its join.
#
# THE BUG THIS PINS (TOG-994). Check 9 compares a GRANT (a row in
# company_secret_bindings) against a DECLARATION (an adapterConfig.env entry).
# The declaration CTE `d` reads only non-terminated agents. The binding CTE `b`
# read every agent. So a binding whose holder was terminated had nothing on the
# other side it could ever match, fell out of the LEFT JOIN with a NULL, and was
# reported MISSING — "this secret projects NOTHING at runtime" — every single
# time. That verdict was produced by the WHERE clause, not by the agent.
#
# It is not a cosmetic miscount. Measured on the live company on 2026-09-05 it
# was 27 of 27 findings, all of them terminated holders, and 0 real ones. A
# check whose entire output is known-benign is a check nobody reads, so a
# genuine live-agent projection failure — the exact TOG-172/173 recurrence this
# check exists to catch — would have arrived as line 28 and been skipped.
#
# WHY THIS SUITE IS STATIC AND OFFLINE. The assertion is a property of the SQL
# TEXT: both sides carry the same terminated-agent predicate. Proving it by
# running the query needs a PostgreSQL with jsonb_each, LATERAL and uuid casts —
# neither an agent container nor CI has one, and a hand-rolled stand-in engine
# would answer plausibly and wrongly, which is worse than not running. The
# behavioural half was verified separately against the live database and is
# recorded on TOG-994: 27 findings -> 0, with all 59 live-agent verdicts
# byte-identical before and after.
#
# §3 IS THE ASSERTION THAT CARRIES THIS SUITE. A static check that only ever
# sees the fixed file cannot tell you it would have caught the bug. So §3
# reconstructs the pre-fix text and requires the guard to go RED on it. Without
# that, this suite passes against a grep that matches nothing.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REVIEW="${ORG_ACCESS_REVIEW_SH:-$HERE/org_access_review.sh}"
PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[[ -r "$REVIEW" ]] || { echo "no readable org_access_review.sh at $REVIEW" >&2; exit 2; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# The check-9 projection query, sliced out of the tool by its own delimiters so
# this suite reads the SAME text the tool runs rather than a copy that rots.
extract_check9() {
  awk '/^proj_rows="\$\(sql "/{f=1} f{print} f&&/ORDER BY 1, 2;"\)"/{exit}' "$1"
}

# The terminated-agent predicate, in either of the two forms the file uses: the
# inline `status <> 'terminated'` on the declaration side, and the EXISTS
# subquery on the binding side. Matching on the STATUS COMPARISON rather than on
# either syntax is deliberate — the invariant is "both sides exclude terminated
# agents", not "both sides are spelled the same way".
count_terminated_filters() { grep -c "status <> 'terminated'" <<<"$1"; }

BLOCK="$(extract_check9 "$REVIEW")"

hdr "1. The check-9 block is still locatable"
if [[ -z "$BLOCK" ]]; then
  bad "could not slice the check-9 projection query out of $REVIEW"
  # Every later assertion would vacuously pass against an empty string.
  printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$((FAIL+1))"
  exit 1
fi
ok "sliced the check-9 projection query ($(wc -l <<<"$BLOCK") lines)"

grep -q 'WITH b AS' <<<"$BLOCK" && grep -q '^d AS' <<<"$BLOCK" \
  && ok "the slice contains BOTH the b (binding) and d (declaration) CTEs" \
  || bad "the slice is missing one of the two CTEs — it is not the whole join"

hdr "2. Both sides of the join exclude terminated agents"
n="$(count_terminated_filters "$BLOCK")"
if [[ "$n" -ge 2 ]]; then
  ok "check 9 filters terminated agents on both sides ($n predicates)"
else
  bad "check 9 has $n terminated-agent predicate(s); one side is unfiltered (TOG-994)"
fi

# Pin the binding side specifically. A count of two could otherwise be reached
# by two filters on the declaration side while `b` stays wide open.
b_side="$(awk '/WITH b AS/{f=1} f&&/^d AS/{exit} f{print}' <<<"$BLOCK")"
if grep -q "status <> 'terminated'" <<<"$b_side"; then
  ok "the BINDING side (b) carries the terminated-agent filter"
else
  bad "the BINDING side (b) does not filter terminated agents — this IS the TOG-994 bug"
fi

d_side="$(awk '/^d AS/{f=1} f{print} f&&/^\)$/{exit}' <<<"$BLOCK")"
if grep -q "status <> 'terminated'" <<<"$d_side"; then
  ok "the DECLARATION side (d) carries the terminated-agent filter"
else
  bad "the DECLARATION side (d) no longer filters terminated agents"
fi

hdr "3. Positive control — the guard goes RED on the pre-fix text"
# Reconstruct the bug by deleting the EXISTS predicate from the binding side,
# then re-run §2's logic against it. If this still passes, §2 is asserting
# nothing and the suite is decorative.
MUTANT="$WORK/mutant.sh"
awk '
  /AND EXISTS \(SELECT 1 FROM agents a2/ { skip = 1 }
  skip && /a2\.status <> .terminated.\)/ { skip = 0; next }
  skip { next }
  { print }
' "$REVIEW" > "$MUTANT"

mutant_block="$(extract_check9 "$MUTANT")"
mutant_b="$(awk '/WITH b AS/{f=1} f&&/^d AS/{exit} f{print}' <<<"$mutant_block")"

if [[ -z "$mutant_block" ]]; then
  bad "the mutation destroyed the check-9 block; the control proves nothing"
elif grep -q "status <> 'terminated'" <<<"$mutant_b"; then
  bad "the mutation did not actually remove the binding-side filter"
else
  ok "the mutation removes the binding-side filter as intended"
  mn="$(count_terminated_filters "$mutant_block")"
  [[ "$mn" -lt 2 ]] \
    && ok "the guard REJECTS the pre-fix text ($mn predicate(s)) — it would have caught TOG-994" \
    || bad "the guard ACCEPTS the pre-fix text — §2 asserts nothing"
fi

hdr "4. The mutated file is still valid bash"
# Guards against a mutation that goes 'red' only because it produced garbage,
# which would make §3 a false positive.
bash -n "$MUTANT" 2>/dev/null \
  && ok "the pre-fix reconstruction parses — §3's red is about the predicate" \
  || bad "the pre-fix reconstruction does not parse; §3's result is meaningless"

hdr "5. The tool itself still parses"
bash -n "$REVIEW" 2>/dev/null && ok "org_access_review.sh parses" || bad "org_access_review.sh does not parse"

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
