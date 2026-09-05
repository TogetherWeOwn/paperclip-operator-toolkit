#!/usr/bin/env bash
# ===========================================================================
# Offline regression suite for interaction_triage.sh (TOG-423).
# NO DATABASE, NO CREDENTIALS, NO NETWORK — this is what CI runs.
#
# EVERY VERDICT IS ASSERTED BY THE GATE THAT PRODUCED IT, NOT JUST BY ITS NAME.
# ---------------------------------------------------------------------------
# "verdict == OWNER_ONLY" is satisfied by four different gates in this tool.
# A test that checks only the verdict string passes when the WRONG gate fires,
# which is how the parent issue's own analysis went wrong in the first place:
# it attributed 42 blocked interactions to the assignee gate when the assignee
# gate was not what stopped them. So `verdict_is` takes the source line that
# must appear in the reason, and a verdict reached via a different citation is
# a FAILURE.
#
# Section 9 then does the reverse: it deletes each gate from a staging copy and
# asserts the test naming that gate goes RED — with a baseline assertion first,
# because "the mutated suite failed" means nothing if the unmutated copy in the
# same staging directory does not pass.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v jq >/dev/null || { echo "ERROR: jq required" >&2; exit 1; }

T="$HERE/interaction_triage.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# row <k=v>... -> a single-element JSON array with sane defaults.
row() {
  local json='{"identifier":"TOG-1","issueStatus":"in_review","kind":"request_confirmation",
               "effectiveResolverPolicy":"board_only","assigneeAgentId":null,
               "createdByAgentId":"author","addresseeAgentId":null,
               "hasToolAction":false,"namedReviewInteraction":false}'
  local kv k v
  for kv in "$@"; do
    k="${kv%%=*}"; v="${kv#*=}"
    json="$(jq -c --arg k "$k" --argjson v "$v" '.[$k]=$v' <<<"$json")"
  done
  jq -c -n --argjson r "$json" '[$r]'
}

# verdict_is <desc> <expected-verdict> <reason-substring> <json-array> [tool]
verdict_is() {
  local d="$1" want="$2" why="$3" input="$4" tool="${5:-$T}"
  local out got reason
  out="$(printf '%s' "$input" | "$tool" classify --json 2>&1)"
  got="$(jq -r '.verdict' <<<"$out" 2>/dev/null)"
  reason="$(jq -r '.why' <<<"$out" 2>/dev/null)"
  if [[ "$got" != "$want" ]]; then
    bad "$d — expected $want, got ${got:-<none>}"; sed 's/^/        /' <<<"$out" | head -3; return 1
  fi
  if [[ "$reason" != *"$why"* ]]; then
    bad "$d — verdict $want reached by the WRONG gate: $reason"; return 1
  fi
  ok "$d"; return 0
}

# ---------------------------------------------------------------------------
hdr "1. The assignee gate (:2946 -> :2793) — the claim the parent issue inverted"

verdict_is "unassigned + board_or_agents -> ANY agent may answer" \
  AGENT_RESOLVABLE ":2793" \
  "$(row 'effectiveResolverPolicy="board_or_agents"' 'assigneeAgentId=null')"

verdict_is "assigned to a NON-creator -> that assignee may answer" \
  AGENT_RESOLVABLE "named agent" \
  "$(row 'effectiveResolverPolicy="board_or_agents"' 'assigneeAgentId="someone-else"')"

verdict_is "assigned to the creator -> INERT via the creator bar, NOT the assignee gate" \
  INERT ":2975" \
  "$(row 'effectiveResolverPolicy="board_or_agents"' 'assigneeAgentId="author"')"

# The resolver set for an unassigned issue must be open, not a named agent.
res="$(row 'effectiveResolverPolicy="board_or_agents"' 'assigneeAgentId=null' \
  | "$T" classify --json | jq -r '.resolvers[0]')"
[[ "$res" == "<any agent except the creator>" ]] \
  && ok "unassigned issue names an OPEN resolver set" \
  || bad "unassigned issue resolver set was '$res'"

hdr "2. The addressee-on-an-unassigned-issue case (the one that reads as inert but is live)"

verdict_is "unassigned + addressed to a non-creator -> that addressee may answer" \
  AGENT_RESOLVABLE "named agent" \
  "$(row 'effectiveResolverPolicy="board_or_agents"' 'assigneeAgentId=null' 'addresseeAgentId="cmo"')"

res="$(row 'effectiveResolverPolicy="board_or_agents"' 'assigneeAgentId=null' 'addresseeAgentId="cmo"' \
  | "$T" classify --json | jq -r '.resolvers | join(",")')"
[[ "$res" == "cmo" ]] \
  && ok "the addressee is named as the sole resolver" \
  || bad "expected sole resolver 'cmo', got '$res'"

verdict_is "addressed to its own creator -> INERT" \
  INERT ":2975" \
  "$(row 'effectiveResolverPolicy="board_or_agents"' 'assigneeAgentId=null' 'addresseeAgentId="author"')"

verdict_is "assigned to X but addressed to Y -> INERT, Y cannot pass :2946" \
  INERT ":2946" \
  "$(row 'effectiveResolverPolicy="board_or_agents"' 'assigneeAgentId="x"' 'addresseeAgentId="y"')"

hdr "3. The policy gate (:2962)"

verdict_is "board_only with no review naming -> OWNER_ONLY via the policy gate" \
  OWNER_ONLY ":2962" \
  "$(row 'effectiveResolverPolicy="board_only"' 'assigneeAgentId=null')"

hdr "4. The tool-action gate (:2953) fires BEFORE the policy gate"

verdict_is "toolAction + board_or_agents -> OWNER_ONLY, cited to :2953 not :2962" \
  OWNER_ONLY ":2953" \
  "$(row 'effectiveResolverPolicy="board_or_agents"' 'hasToolAction=true' 'assigneeAgentId=null')"

hdr "5. The review-verdict bypass (:2956)"

verdict_is "in_review + named reviewInteractionId -> bypasses board_only" \
  AGENT_REVIEW_VERDICT ":2956" \
  "$(row 'effectiveResolverPolicy="board_only"' 'namedReviewInteraction=true' \
         'issueStatus="in_review"' 'assigneeAgentId="reviewer"')"

verdict_is "named as review interaction but NOT in_review -> no bypass" \
  OWNER_ONLY ":2962" \
  "$(row 'effectiveResolverPolicy="board_only"' 'namedReviewInteraction=true' \
         'issueStatus="in_progress"' 'assigneeAgentId="reviewer"')"

verdict_is "in_review but nothing named it -> no bypass" \
  OWNER_ONLY ":2962" \
  "$(row 'effectiveResolverPolicy="board_only"' 'namedReviewInteraction=false' \
         'issueStatus="in_review"' 'assigneeAgentId="reviewer"')"

verdict_is "review bypass does not rescue an ask_user_questions" \
  OWNER_ONLY ":2962" \
  "$(row 'kind="ask_user_questions"' 'effectiveResolverPolicy="board_only"' \
         'namedReviewInteraction=true' 'issueStatus="in_review"' 'assigneeAgentId="reviewer"')"

# The bypass must still respect the creator bar at :2975.
verdict_is "review verdict named, but the reviewer IS the author -> still INERT" \
  INERT ":2975" \
  "$(row 'effectiveResolverPolicy="board_only"' 'namedReviewInteraction=true' \
         'issueStatus="in_review"' 'assigneeAgentId="author"')"

hdr "6. The assign_would_kill warning"

w="$(row 'effectiveResolverPolicy="board_or_agents"' 'assigneeAgentId=null' \
  | "$T" classify --json | jq -r '.warnings | join(" ")')"
[[ "$w" == *"assign_would_kill"* ]] \
  && ok "an open question warns that assigning it narrows the resolver set" \
  || bad "expected an assign_would_kill warning, got: $w"

w="$(row 'effectiveResolverPolicy="board_or_agents"' 'assigneeAgentId="x"' 'issueStatus="in_progress"' \
  | "$T" classify --json | jq -r '.warnings | join(" ")')"
[[ "$w" == *"run-lock"* ]] \
  && ok "an in_progress assigned issue warns about the checkout run-lock" \
  || bad "expected a run-lock warning, got: $w"

hdr "7. Malformed input must not read as a clean board"

out="$(printf '[{"identifier":"TOG-9","kind":"ask_user_questions"}]' | "$T" classify 2>&1)"; rc=$?
[[ $rc -eq 2 && "$out" == *"MALFORMED"* ]] \
  && ok "a row missing required fields is MALFORMED and exits 2" \
  || bad "malformed row: rc=$rc out=$(head -c 120 <<<"$out")"

out="$(printf '{"not":"an array"}' | "$T" classify 2>&1)"; rc=$?
[[ $rc -eq 2 ]] && ok "non-array stdin is refused (exit 2)" || bad "non-array stdin exited $rc"

# An EMPTY board is a legitimately clean board, not an error.
out="$(printf '[]' | "$T" classify --strict 2>&1)"; rc=$?
[[ $rc -eq 0 ]] && ok "an empty pending set exits 0" || bad "empty set exited $rc"

hdr "8. --strict and --only"

both="$(jq -c -n '[
  {identifier:"A",issueStatus:"in_review",kind:"request_confirmation",
   effectiveResolverPolicy:"board_or_agents",assigneeAgentId:"author",
   createdByAgentId:"author",addresseeAgentId:null,hasToolAction:false,
   namedReviewInteraction:false},
  {identifier:"B",issueStatus:"in_review",kind:"request_confirmation",
   effectiveResolverPolicy:"board_or_agents",assigneeAgentId:null,
   createdByAgentId:"author",addresseeAgentId:null,hasToolAction:false,
   namedReviewInteraction:false}]')"

printf '%s' "$both" | "$T" classify >/dev/null 2>&1; rc=$?
[[ $rc -eq 0 ]] && ok "without --strict an INERT row still exits 0" || bad "non-strict exited $rc"

printf '%s' "$both" | "$T" classify --strict >/dev/null 2>&1; rc=$?
[[ $rc -eq 3 ]] && ok "--strict exits 3 when a row is INERT" || bad "--strict exited $rc, expected 3"

# --only is a VIEW. If it could suppress the exit status, a strict CI gate
# would go green simply by being asked to print a different column.
printf '%s' "$both" | "$T" classify --strict --only AGENT_RESOLVABLE >/dev/null 2>&1; rc=$?
[[ $rc -eq 3 ]] \
  && ok "--only filters the table but NEVER changes the exit status" \
  || bad "--only AGENT_RESOLVABLE masked the INERT row (rc=$rc)"

n="$(printf '%s' "$both" | "$T" classify --json --only INERT 2>/dev/null | wc -l)"
[[ "$n" -eq 1 ]] && ok "--only INERT prints exactly the one INERT row" || bad "--only INERT printed $n rows"

hdr "9. The continuation gate (:1253) — 'and then what?'"

# Same discipline as verdict_is: the CITATION must match, so a continuation
# reached by the wrong branch is a failure. DEAD_WAKE has two sources (no
# assignee, closed issue) and they must stay distinguishable.
continuation_is() {
  local d="$1" want="$2" why="$3" input="$4" tool="${5:-$T}"
  local out got reason
  out="$(printf '%s' "$input" | "$tool" classify --json 2>&1)"
  got="$(jq -r '.continuation' <<<"$out" 2>/dev/null)"
  reason="$(jq -r '.continuationWhy' <<<"$out" 2>/dev/null)"
  if [[ "$got" != "$want" ]]; then
    bad "$d — expected $want, got ${got:-<none>}"; return 1
  fi
  if [[ "$reason" != *"$why"* ]]; then
    bad "$d — $want reached by the WRONG branch: $reason"; return 1
  fi
  ok "$d"; return 0
}

# The live TOG-38 / TOG-58 / TOG-104 shape: a healthy card nobody can act on.
continuation_is "wake_assignee on an UNASSIGNED issue -> DEAD_WAKE" \
  DEAD_WAKE "NO ASSIGNEE" \
  "$(row 'continuationPolicy="wake_assignee"' 'assigneeAgentId=null')"

continuation_is "wake_assignee on an assigned, open issue -> WAKES" \
  WAKES ":1253" \
  "$(row 'continuationPolicy="wake_assignee"' 'assigneeAgentId="owner-agent"')"

# Attributed to the CLOSED branch, not the assignee branch — an assignee IS
# present here, so a test that only checked "DEAD_WAKE" would pass on the
# wrong gate.
continuation_is "wake_assignee on a DONE issue -> DEAD_WAKE via isClosedIssueStatus" \
  DEAD_WAKE ":1126" \
  "$(row 'continuationPolicy="wake_assignee"' 'assigneeAgentId="a"' 'issueStatus="done"')"

continuation_is "wake_assignee on a DONE unassigned issue -> closed DEAD_WAKE branch" \
  DEAD_WAKE ":1126" \
  "$(row 'continuationPolicy="wake_assignee"' 'assigneeAgentId=null' 'issueStatus="done"')"

continuation_is "wake_assignee_on_accept -> a REJECTION wakes nobody" \
  WAKES_ON_ACCEPT ":1263" \
  "$(row 'continuationPolicy="wake_assignee_on_accept"' 'assigneeAgentId="a"')"

continuation_is "a non-wake policy -> NO_WAKE_REQUESTED" \
  NO_WAKE_REQUESTED ":1265" \
  "$(row 'continuationPolicy="none"' 'assigneeAgentId="a"')"

continuation_is "a row with no continuationPolicy -> UNKNOWN, never assumed live" \
  UNKNOWN "NOT measured" \
  "$(row 'assigneeAgentId="a"')"

continuation_is "wake_assignee with no issueStatus -> UNKNOWN, never assumed open" \
  UNKNOWN "no issueStatus" \
  "$(row 'continuationPolicy="wake_assignee"' 'issueStatus=null' 'assigneeAgentId="a"')"

# BACKWARD COMPATIBILITY. Adding this gate must not move a single existing
# verdict — a diagnostic tool that reclassifies the board on upgrade is worse
# than one that never shipped.
before="$(row 'effectiveResolverPolicy="board_only"' 'assigneeAgentId=null' | "$T" classify --json | jq -c '{verdict,why}')"
after="$(row 'effectiveResolverPolicy="board_only"' 'assigneeAgentId=null' 'continuationPolicy="wake_assignee"' | "$T" classify --json | jq -c '{verdict,why}')"
[[ "$before" == "$after" ]] \
  && ok "adding continuationPolicy leaves the resolver verdict and its citation identical" \
  || bad "continuationPolicy changed the resolver verdict: $before -> $after"

# THE DISTINCTION THE WHOLE ISSUE IS ABOUT: answerable, and yet inert.
both="$(row 'effectiveResolverPolicy="board_only"' 'assigneeAgentId=null' 'continuationPolicy="wake_assignee"' \
  | "$T" classify --json | jq -r '.verdict + "/" + .continuation')"
[[ "$both" == "OWNER_ONLY/DEAD_WAKE" ]] \
  && ok "a board_only card on an unassigned issue is OWNER_ONLY *and* DEAD_WAKE — not collapsed into INERT" \
  || bad "expected OWNER_ONLY/DEAD_WAKE, got '$both'"

# A DEAD_WAKE row must carry the remediation for the branch that produced it,
# not one generic instruction that is wrong for half the states.
warn="$(row 'effectiveResolverPolicy="board_only"' 'assigneeAgentId=null' 'continuationPolicy="wake_assignee"' \
  | "$T" classify --json | jq -r '.warnings | join(" ")')"
[[ "$warn" == *"Assign the issue"* && "$warn" != *"open status"* ]] \
  && ok "unassigned DEAD_WAKE says to assign the issue" \
  || bad "unassigned DEAD_WAKE gave the wrong remediation: $warn"

warn="$(row 'effectiveResolverPolicy="board_only"' 'assigneeAgentId="a"' 'issueStatus="done"' 'continuationPolicy="wake_assignee"' \
  | "$T" classify --json | jq -r '.warnings | join(" ")')"
[[ "$warn" == *"open status"* && "$warn" == *"cannot repair"* && "$warn" != *"Assign the issue;"* ]] \
  && ok "closed DEAD_WAKE says to resume the issue, not assign it" \
  || bad "closed DEAD_WAKE gave the wrong remediation: $warn"

warn="$(row 'effectiveResolverPolicy="board_only"' 'assigneeAgentId=null' 'issueStatus="done"' 'continuationPolicy="wake_assignee"' \
  | "$T" classify --json | jq -r '.warnings | join(" ")')"
[[ "$warn" == *"open status"* && "$warn" == *"only after reopening"* && "$warn" == *"Assignment alone cannot repair"* ]] \
  && ok "closed+unassigned DEAD_WAKE requires reopening before assignment" \
  || bad "closed+unassigned DEAD_WAKE gave incomplete remediation: $warn"

hdr "10. --strict-wake exit codes, including the case that measured nothing"

row 'continuationPolicy="wake_assignee"' 'assigneeAgentId=null' | "$T" classify >/dev/null 2>&1
[[ $? -eq 0 ]] && ok "without --strict-wake a DEAD_WAKE row still exits 0" \
               || bad "DEAD_WAKE changed the default exit status"

row 'continuationPolicy="wake_assignee"' 'assigneeAgentId=null' | "$T" classify --strict-wake >/dev/null 2>&1
[[ $? -eq 4 ]] && ok "--strict-wake exits 4 on a DEAD_WAKE row" \
               || bad "--strict-wake did not exit 4 on DEAD_WAKE"

row 'continuationPolicy="wake_assignee"' 'assigneeAgentId="a"' | "$T" classify --strict-wake >/dev/null 2>&1
[[ $? -eq 0 ]] && ok "--strict-wake exits 0 when the wake path is whole" \
               || bad "--strict-wake failed a healthy row"

row 'continuationPolicy="wake_assignee"' 'issueStatus=null' 'assigneeAgentId="a"' \
  | "$T" classify --strict-wake >/dev/null 2>&1
[[ $? -eq 2 ]] && ok "--strict-wake REFUSES missing issueStatus rather than assuming open" \
               || bad "--strict-wake reported WAKES over missing issueStatus"

row 'effectiveResolverPolicy="board_or_agents"' 'assigneeAgentId="author"' \
  'continuationPolicy="wake_assignee"' 'issueStatus=null' \
  | "$T" classify --strict --strict-wake >/dev/null 2>&1
[[ $? -eq 2 ]] && ok "missing issueStatus refusal takes precedence over INERT under combined strict flags" \
               || bad "combined strict flags let INERT hide missing issueStatus"

# The rule this tool exists to enforce, applied to the tool itself: a sweep
# that measured nothing must NOT report green. Exit 2 (refusal), not 0 (pass).
row 'assigneeAgentId="a"' | "$T" classify --strict-wake >/dev/null 2>&1
[[ $? -eq 2 ]] && ok "--strict-wake REFUSES (exit 2) rows with no continuationPolicy rather than passing them" \
               || bad "--strict-wake reported clean over rows it never measured"

# Precedence must be deterministic when a row trips both strict flags.
row 'effectiveResolverPolicy="board_or_agents"' 'assigneeAgentId="author"' 'continuationPolicy="wake_assignee"' \
  | "$T" classify --strict --strict-wake >/dev/null 2>&1
[[ $? -eq 3 ]] && ok "--strict (INERT, exit 3) takes precedence over --strict-wake" \
               || bad "combined strict flags gave a non-deterministic exit"

hdr "11. Mutation gate — delete a gate, prove the test that names it goes RED"

STAGE="$TMP/stage"; mkdir -p "$STAGE"
cp "$T" "$STAGE/interaction_triage.sh"; chmod +x "$STAGE/interaction_triage.sh"
M="$STAGE/interaction_triage.sh"

# BASELINE FIRST. Without this, every mutation below is unattributable: a
# staging copy that was already broken produces the same red.
base_ok=1
verdict_is "BASELINE unmutated staging copy still classifies correctly" \
  AGENT_RESOLVABLE ":2793" \
  "$(row 'effectiveResolverPolicy="board_or_agents"' 'assigneeAgentId=null')" "$M" || base_ok=0
verdict_is "BASELINE unmutated staging copy still refuses board_only" \
  OWNER_ONLY ":2962" \
  "$(row 'effectiveResolverPolicy="board_only"' 'assigneeAgentId=null')" "$M" || base_ok=0

if [[ $base_ok -ne 1 ]]; then
  bad "baseline staging copy is already broken — mutation results below would be meaningless"
else
  # Mutation A: make the unassigned branch behave like an assigned one, i.e.
  # reintroduce exactly the misreading the parent issue made of :2793.
  #
  # NOTE: this mutation does NOT change the verdict, and that is the finding.
  # An unassigned issue mutated to `[$assignee]` yields `[null]`, which is
  # still a non-empty eligible set, so the row stays AGENT_RESOLVABLE. The only
  # observable is the RESOLVER SET collapsing from open to a null agent — so
  # the assertion that actually covers :2793 is section 1's resolver-set check,
  # not any of its verdict checks. Asserting the verdict here would have been a
  # test that looked like coverage and was not.
  cp "$T" "$M"
  sed -i 's/if \$unassigned then "\*"/if false then "*"/' "$M"
  got="$(row 'effectiveResolverPolicy="board_or_agents"' 'assigneeAgentId=null' \
    | "$M" classify --json 2>/dev/null | jq -r '.resolvers[0]')"
  [[ "$got" != "<any agent except the creator>" ]] \
    && ok "MUTATION :2793 (unassigned no longer opens the gate) -> the resolver-set test goes RED" \
    || bad "MUTATION :2793 survived — nothing in section 1 covers the assignee gate"

  # Mutation B: drop the creator bar.
  cp "$T" "$M"
  sed -i 's/map(select(. != \$creator))/map(select(true))/' "$M"
  got="$(row 'effectiveResolverPolicy="board_or_agents"' 'assigneeAgentId="author"' \
    | "$M" classify --json 2>/dev/null | jq -r '.verdict')"
  [[ "$got" != "INERT" ]] \
    && ok "MUTATION :2975 (creator bar removed) -> the INERT test goes RED" \
    || bad "MUTATION :2975 survived — the creator-bar test does not cover the creator bar"

  # Mutation C: let the tool-action gate fall through to the policy gate.
  cp "$T" "$M"
  sed -i 's|if \$toolAction then|if false then|' "$M"
  reason="$(row 'effectiveResolverPolicy="board_or_agents"' 'hasToolAction=true' 'assigneeAgentId=null' \
    | "$M" classify --json 2>/dev/null | jq -r '.verdict + " " + .why')"
  [[ "$reason" != *":2953"* ]] \
    && ok "MUTATION :2953 (tool-action gate removed) -> section 4 goes RED" \
    || bad "MUTATION :2953 survived — section 4 is satisfied by a neighbouring gate"

  # Mutation D: remove the review bypass.
  cp "$T" "$M"
  sed -i 's|and (\$i.namedReviewInteraction // false)|and false|' "$M"
  got="$(row 'effectiveResolverPolicy="board_only"' 'namedReviewInteraction=true' \
         'issueStatus="in_review"' 'assigneeAgentId="reviewer"' \
    | "$M" classify --json 2>/dev/null | jq -r '.verdict')"
  [[ "$got" != "AGENT_REVIEW_VERDICT" ]] \
    && ok "MUTATION :2956 (review bypass removed) -> section 5 goes RED" \
    || bad "MUTATION :2956 survived — section 5 does not cover the review bypass"

  # A sed that matches nothing leaves the file intact, the mutant behaves like
  # the original, and the "mutation survived" branch reports a FAILURE that is
  # really a broken test. So every mutation below proves it edited the file
  # before it draws any conclusion from the result.
  mutate() {
    cp "$T" "$M"
    sed -i "$1" "$M"
    if cmp -s "$T" "$M"; then
      bad "MUTATION '$1' matched nothing — the mutation gate below would be vacuous"
      return 1
    fi
    return 0
  }

  # Mutation E: drop the assignee check from the continuation gate — i.e.
  # pretend :1253 does not return early on an unassigned issue.
  if mutate 's/if \$noAssignee then/if false then/'; then
    got="$(row 'continuationPolicy="wake_assignee"' 'assigneeAgentId=null' \
      | "$M" classify --json 2>/dev/null | jq -r '.continuation')"
    [[ "$got" != "DEAD_WAKE" ]] \
      && ok "MUTATION :1253 (unassigned no longer kills the wake) -> section 9 goes RED" \
      || bad "MUTATION :1253 survived — section 9 does not cover the continuation gate"
  fi

  # Mutation F: let --strict-wake report green over rows it never measured.
  # This one guards a RULE rather than a gate: absence of evidence must not
  # read as evidence of health.
  if mutate 's/"\$unmeasured" -gt 0/"$unmeasured" -gt 999999/'; then
    row 'assigneeAgentId="a"' | "$M" classify --strict-wake >/dev/null 2>&1
    [[ $? -ne 2 ]] \
      && ok "MUTATION (unmeasured rows pass silently) -> the 'measured nothing' test goes RED" \
      || bad "MUTATION survived — nothing covers the unmeasured-rows refusal"
  fi

  # Mutation G: restore the defect under correction — assume a missing
  # issueStatus means the issue is open, allowing WAKES / strict exit 0.
  if mutate 's/elif \$issueStatus == null or \$issueStatus == "" then/elif false then/'; then
    got="$(row 'continuationPolicy="wake_assignee"' 'issueStatus=null' 'assigneeAgentId="a"' \
      | "$M" classify --json 2>/dev/null | jq -r '.continuation')"
    [[ "$got" == "WAKES" ]] \
      && ok "MUTATION (missing issueStatus assumed open) -> the UNKNOWN regression goes RED" \
      || bad "MUTATION did not recreate the missing-status false green: $got"
  fi
fi

hdr "RESULT"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]] || exit 1
