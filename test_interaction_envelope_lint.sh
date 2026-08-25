#!/usr/bin/env bash
# ===========================================================================
# test_interaction_envelope_lint.sh — regression suite for TOG-396
# ===========================================================================
# Offline. No credentials, no network, no platform source. CI runs this.
#
# Every rejection case below is the BASELINE envelope with exactly ONE thing
# changed. That is deliberate: an envelope that is broken in three ways proves
# nothing about which check caught it, and stays green after the check under
# test is deleted. §1 asserts the baseline passes, so a later blanket-refusal
# regression cannot make the whole suite pass by accident.
#
# Assertions pin EXIT CODES, never printed text (CONTRIBUTING.md).
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LINT="$HERE/interaction_envelope_lint.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

EX_OK=0; EX_USAGE=2; EX_REJECTED=6; EX_KEYSET_DRIFT=7; EX_UNVERIFIED=8

pass=0; fail=0
ok()   { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  FAIL %s\n' "$1"; fail=$((fail+1)); }

# expect_rc <expected> <label> <stdin-body> [args...]
expect_rc() {
  local expected="$1" label="$2" body="$3"; shift 3
  local rc
  printf '%s' "$body" | "$LINT" "$@" >/dev/null 2>&1
  rc=$?
  if [[ "$rc" == "$expected" ]]; then ok "$label (rc=$rc)"; else bad "$label — expected rc=$expected, got rc=$rc"; fi
}

# The baseline: correct in every respect. Every case below mutates exactly one
# field of this.
BASELINE='{"kind":"ask_user_questions","resolverPolicy":"board_or_agents","addresseeAgentId":"11111111-1111-1111-1111-111111111111","continuationPolicy":"wake_assignee","payload":{"version":1,"supersedeOnUserComment":false,"questions":[{"id":"q1","prompt":"p","selectionMode":"single","options":[{"id":"a","label":"A"}]}]}}'

printf '\n== 1. baseline (the control — if this fails, nothing below means anything) ==\n'
expect_rc "$EX_OK" "a fully correct envelope is accepted" "$BASELINE"

printf '\n== 2. the TOG-396 bug: an unknown envelope key is refused ==\n'
# The exact live reproduction: `requestedResolverPolicy` is the name the API
# returns, is NOT an input, and is silently stripped by the server.
expect_rc "$EX_REJECTED" "requestedResolverPolicy instead of resolverPolicy" \
  "$(jq -c 'del(.resolverPolicy) | .requestedResolverPolicy = "board_only"' <<<"$BASELINE")"
# ...and it is refused even when resolverPolicy is ALSO present and correct.
#
# This case is not redundant with the one above it — it is the only one that
# pins the unknown-key check to itself. Demonstrated by mutation: delete the
# unknown-key check entirely and the case ABOVE still passes, because that
# envelope also omits `resolverPolicy` and the default check (§3) refuses it
# for an unrelated reason. Only this variant, which satisfies §3, can go red
# for the right reason. An assertion satisfied by a neighbouring gate is an
# assertion you no longer have.
expect_rc "$EX_REJECTED" "requestedResolverPolicy alongside a valid resolverPolicy" \
  "$(jq -c '.requestedResolverPolicy = "board_only"' <<<"$BASELINE")"
expect_rc "$EX_REJECTED" "a key with no known correct spelling" \
  "$(jq -c '.zzzTotallyMadeUpKey = "x"' <<<"$BASELINE")"
expect_rc "$EX_REJECTED" "effectiveResolverPolicy (output-only)" \
  "$(jq -c '.effectiveResolverPolicy = "board_only"' <<<"$BASELINE")"
expect_rc "$EX_REJECTED" "assigneeAgentId (the addressee/assignee confusion)" \
  "$(jq -c '.assigneeAgentId = "11111111-1111-1111-1111-111111111111"' <<<"$BASELINE")"
expect_rc "$EX_REJECTED" "supersedeOnUserComment hoisted to the envelope" \
  "$(jq -c '.supersedeOnUserComment = false' <<<"$BASELINE")"

printf '\n== 3. an omitted resolverPolicy is a silent default, not a blank ==\n'
OMITTED="$(jq -c 'del(.resolverPolicy)' <<<"$BASELINE")"
expect_rc "$EX_REJECTED" "resolverPolicy omitted is refused by default" "$OMITTED"
expect_rc "$EX_OK"       "--allow-default permits it deliberately"       "$OMITTED" --allow-default
# --allow-default must relax ONLY the default, never the unknown-key check.
expect_rc "$EX_REJECTED" "--allow-default still refuses an unknown key" \
  "$(jq -c 'del(.resolverPolicy) | .requestedResolverPolicy = "board_only"' <<<"$BASELINE")" --allow-default

printf '\n== 4. values the server would catch, caught one round trip earlier ==\n'
expect_rc "$EX_REJECTED" "resolverPolicy with a bad enum value" \
  "$(jq -c '.resolverPolicy = "board_onlyy"' <<<"$BASELINE")"
expect_rc "$EX_REJECTED" "resolverPolicy null" \
  "$(jq -c '.resolverPolicy = null' <<<"$BASELINE")"
expect_rc "$EX_REJECTED" "kind missing" \
  "$(jq -c 'del(.kind)' <<<"$BASELINE")"
expect_rc "$EX_REJECTED" "kind not a real kind" \
  "$(jq -c '.kind = "ask_user_question"' <<<"$BASELINE")"

printf '\n== 5. all five real kinds are accepted (no accidental allowlist of one) ==\n'
for k in suggest_tasks ask_user_questions request_confirmation request_checkbox_confirmation request_item_verdicts; do
  expect_rc "$EX_OK" "kind=$k" "$(jq -c --arg k "$k" '.kind = $k' <<<"$BASELINE")"
done

printf '\n== 6. payload.supersedeOnUserComment is a WARNING, not a rejection ==\n'
# It is a payload field, out of TOG-396 scope; warning it must not change the
# exit code, or every legitimate envelope that omits it becomes unusable.
expect_rc "$EX_OK" "omitting it still exits 0" \
  "$(jq -c 'del(.payload.supersedeOnUserComment)' <<<"$BASELINE")"
WARN_OUT="$(jq -c 'del(.payload.supersedeOnUserComment)' <<<"$BASELINE" | "$LINT" 2>&1 >/dev/null)"
if [[ -n "$WARN_OUT" ]]; then ok "omitting it does emit a warning on stderr"; else bad "omitting it emitted no warning"; fi

printf '\n== 7. bad invocation is usage (2), never a silent pass ==\n'
expect_rc "$EX_USAGE" "empty stdin"          ""
expect_rc "$EX_USAGE" "not JSON"             "this is not json"
expect_rc "$EX_USAGE" "JSON but not object"  '["kind"]'
expect_rc "$EX_USAGE" "unknown option"       "$BASELINE" --no-such-flag

printf '\n== 8. --verify-keyset: matches, drifts, and refuses to guess ==\n'
# A stub standing in for the deployed zod schema. It only needs the two things
# the deriver reads: `optionsMap`, and `.shape` per member.
make_stub() { # $1 = path, $2... = keys
  local path="$1"; shift
  local keys="" k
  for k in "$@"; do keys+="\"$k\": true, "; done
  cat > "$path" <<EOF
const shape = { $keys };
export const createIssueThreadInteractionSchema = {
  optionsMap: new Map([
    ["suggest_tasks", { shape }],
    ["ask_user_questions", { shape }],
    ["request_confirmation", { shape }],
    ["request_checkbox_confirmation", { shape }],
    ["request_item_verdicts", { shape }],
  ]),
};
EOF
}

PINNED=(addresseeAgentId continuationPolicy idempotencyKey kind payload resolverPolicy sourceCommentId sourceRunId summary title)

make_stub "$TMP/match.mjs" "${PINNED[@]}"
PAPERCLIP_SHARED_VALIDATORS="$TMP/match.mjs" "$LINT" --verify-keyset >/dev/null 2>&1
[[ $? == "$EX_OK" ]] && ok "a matching key set passes" || bad "a matching key set did not pass"

make_stub "$TMP/added.mjs" "${PINNED[@]}" newPlatformKey
PAPERCLIP_SHARED_VALIDATORS="$TMP/added.mjs" "$LINT" --verify-keyset >/dev/null 2>&1
[[ $? == "$EX_KEYSET_DRIFT" ]] && ok "an ADDED key is drift (7)" || bad "an added key was not reported as drift"

make_stub "$TMP/removed.mjs" addresseeAgentId continuationPolicy idempotencyKey kind payload sourceCommentId sourceRunId summary title
PAPERCLIP_SHARED_VALIDATORS="$TMP/removed.mjs" "$LINT" --verify-keyset >/dev/null 2>&1
[[ $? == "$EX_KEYSET_DRIFT" ]] && ok "a REMOVED key is drift (7)" || bad "a removed key was not reported as drift"

# The one that matters most: absent platform must NOT read as a pass.
PAPERCLIP_SHARED_VALIDATORS="$TMP/does-not-exist.mjs" "$LINT" --verify-keyset >/dev/null 2>&1
[[ $? == "$EX_UNVERIFIED" ]] && ok "an unreadable platform is UNVERIFIED (8), not OK" || bad "an unreadable platform did not exit 8"

# A schema whose shape changed so much the deriver cannot read it is also
# unverified — not a pass, and not drift, because nothing was measured.
printf 'export const createIssueThreadInteractionSchema = {};\n' > "$TMP/shapeless.mjs"
PAPERCLIP_SHARED_VALIDATORS="$TMP/shapeless.mjs" "$LINT" --verify-keyset >/dev/null 2>&1
[[ $? == "$EX_UNVERIFIED" ]] && ok "an unreadable schema shape is UNVERIFIED (8)" || bad "an unreadable schema shape did not exit 8"

# Kinds that stop sharing one key set invalidate the single-pin design.
cat > "$TMP/divergent.mjs" <<'EOF'
export const createIssueThreadInteractionSchema = {
  optionsMap: new Map([
    ["suggest_tasks", { shape: { kind: true, payload: true } }],
    ["ask_user_questions", { shape: { kind: true, payload: true, extra: true } }],
  ]),
};
EOF
PAPERCLIP_SHARED_VALIDATORS="$TMP/divergent.mjs" "$LINT" --verify-keyset >/dev/null 2>&1
[[ $? == "$EX_UNVERIFIED" ]] && ok "kinds with divergent key sets are UNVERIFIED (8)" || bad "divergent kinds did not exit 8"

printf '\n---------------------------------------------\n'
printf 'passed: %d   failed: %d\n' "$pass" "$fail"
(( fail == 0 )) || exit 1
printf 'ALL GREEN\n'
