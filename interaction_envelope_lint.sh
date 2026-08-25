#!/usr/bin/env bash
# ===========================================================================
# interaction_envelope_lint.sh — refuse an envelope the server will silently
#                                edit behind your back (TOG-396)
# ===========================================================================
# `interaction_route.sh` decides WHERE an ask belongs. This decides whether the
# JSON you are about to POST says what you think it says. They are different
# questions and the second one is the one that fails silently.
#
# THE BUG THIS EXISTS FOR
# -----------------------
# `POST /api/issues/{id}/interactions` validates its body with
# `createIssueThreadInteractionSchema`
# (`packages/shared/src/validators/issue.ts:1170`) — a `z.discriminatedUnion`
# of plain, NON-strict `z.object`s. Zod strips unknown keys by default. So a
# misspelled envelope key is not an error; it is a deletion, and the field it
# was meant to set falls back to a per-kind default
# (`services/issue-thread-interactions.ts:225-231`).
#
# Measured live 2026-08-25, two creates one second apart on the same issue,
# differing only in the key name (full transcript in
# `docs/interaction-envelope-strictness.md`):
#
#   {"resolverPolicy":"board_only", ...}           -> 201  effective=board_only
#   {"requestedResolverPolicy":"board_only", ...}  -> 201  effective=board_or_agents
#
# The second one is the trap: `requestedResolverPolicy` is a name the API
# *returns* in its own response, so it reads as the round-trip field. It is
# not an input. The response to that create echoed
# `"resolverPolicy":"board_or_agents"` — the caller's own key name, carrying
# the opposite of the value they sent.
#
# WHY A VALUE TYPO IS LOUD AND A KEY TYPO IS SILENT
# -------------------------------------------------
#   {"resolverPolicy":"board_onlyy"}       -> 400, invalid_enum_value
#   {"requestedResolverPolicy":"board_only"} -> 201, wrong policy
# Enum membership is checked; key membership is not. Every wrong-value class is
# caught and every wrong-key class is not.
#
# THE "INCONSISTENCY" IN THE TOG-396 REPORT IS NOT ONE — see the doc. The
# answers payload is not strict either; its loud 400 comes from `optionIds`
# being REQUIRED, not from unknown-key rejection. That matters because it kills
# the cheap fix: there is no strict sibling schema to copy. Client-side is the
# only layer we control, which is this script.
#
# WHAT THIS DOES NOT DO
# ---------------------
# It does not POST anything, and it cannot make the server strict. It is a
# preflight: a wrong envelope still reaches the API if you skip the check. It
# reads stdin and exits.
# ===========================================================================
set -uo pipefail

TOOL_NAME="interaction_envelope_lint.sh"

# Exit codes are the contract. Tests pin these, never message text
# (CONTRIBUTING.md: "Assert on exit status, not printed output").
EX_OK=0            # envelope is explicit and every key survives the server
EX_USAGE=2         # bad invocation, or unparseable JSON on stdin
EX_REJECTED=6      # envelope would be silently edited — do not POST it
EX_KEYSET_DRIFT=7  # --verify-keyset: the platform's accepted keys moved
EX_UNVERIFIED=8    # --verify-keyset: could not read the platform; NOT a pass

# --------------------------------------------------------------------------
# The pin.
# --------------------------------------------------------------------------
# Derived from the deployed schema, not hand-typed, and identical across all
# five interaction kinds (verified: `--verify-keyset` re-derives and diffs).
# Provenance: packages/shared/src/validators/issue.ts:1165-1226 —
# `createIssueThreadInteractionCommon` supplies resolverPolicy +
# addresseeAgentId; each union member adds the other eight.
#
# This is pinned rather than read live because the platform source is present
# in an agent container and absent in CI. A pin plus a drift check is honest;
# reading it live and skipping when absent would make CI green on nothing.
ACCEPTED_ENVELOPE_KEYS="addresseeAgentId continuationPolicy idempotencyKey kind payload resolverPolicy sourceCommentId sourceRunId summary title"

# Keys that are silently stripped AND have a known correct spelling. Anything
# here gets a targeted message instead of the generic unknown-key one, because
# the generic message does not tell you what to type instead.
#   name<TAB>correct<TAB>why
KNOWN_TRAPS=$(cat <<'TRAPS'
requestedResolverPolicy	resolverPolicy	this is an OUTPUT-only alias. The API returns both `resolverPolicy` and `requestedResolverPolicy` on every read, so it looks round-trippable. Only `resolverPolicy` is read on input.
effectiveResolverPolicy	resolverPolicy	output-only; the server computes this from resolverPolicy, kind governance and payload.toolAction. You cannot set it.
assigneeAgentId	addresseeAgentId	the issue has an assignee; the interaction has an addressee. Different fields, and only the addressee is settable here.
addressee	addresseeAgentId	the full field name is required.
supersedeOnUserComment	payload.supersedeOnUserComment	this lives INSIDE payload, not on the envelope. At envelope level it is stripped and the payload default (true) applies — which cancels your question when the owner comments on the issue.
status	-	output-only; a created interaction is always `pending`.
createdByAgentId	-	output-only; taken from your authenticated identity.
TRAPS
)

VALID_POLICIES="board_only board_or_agents"

die() { printf '%s: %s\n' "$TOOL_NAME" "$*" >&2; exit "$EX_USAGE"; }

usage() {
  cat <<'USAGE'
interaction_envelope_lint.sh — check an interaction envelope before you POST it

  ./interaction_envelope_lint.sh < envelope.json
  some-generator | ./interaction_envelope_lint.sh --quiet
  ./interaction_envelope_lint.sh --verify-keyset

The server strips unknown envelope keys without a word and falls back to a
per-kind default. This refuses the envelope instead.

OPTIONS
  --quiet           only print findings, not the OK banner
  --allow-default   permit an omitted `resolverPolicy` (relying on the per-kind
                    default). Off by default: the default is the thing that
                    bit us. Unknown keys are still refused.
  --verify-keyset   re-derive the accepted key set from the deployed platform
                    schema and diff it against the pin in this script. Exits 8
                    if the platform is not readable — it never reports a pass
                    it did not measure. Override the path with
                    PAPERCLIP_SHARED_VALIDATORS.

CHECKS (all fail-closed)
  1. every key is one the server actually reads          -> else exit 6
  2. `resolverPolicy` is present and explicit            -> else exit 6
  3. `resolverPolicy` is a valid enum member             -> else exit 6
  4. `kind` is present and a real kind                   -> else exit 6
  5. `payload.supersedeOnUserComment` is set explicitly  -> WARNING only

EXIT CODES
  0 clean   2 usage/unparseable   6 envelope rejected
  7 keyset drift   8 keyset unverifiable
USAGE
}

# --------------------------------------------------------------------------
# --verify-keyset — is the pin above still what the platform accepts?
# --------------------------------------------------------------------------
cmd_verify_keyset() {
  local validators="${PAPERCLIP_SHARED_VALIDATORS:-/app/packages/shared/dist/validators/issue.js}"

  if ! command -v node >/dev/null 2>&1; then
    printf '%s: UNVERIFIED — node is not on PATH, so the pin was not checked.\n' "$TOOL_NAME" >&2
    printf '  This is exit %d, not a pass. A check that measured nothing must not read green.\n' "$EX_UNVERIFIED" >&2
    exit "$EX_UNVERIFIED"
  fi
  if [[ ! -r "$validators" ]]; then
    printf '%s: UNVERIFIED — cannot read %s\n' "$TOOL_NAME" "$validators" >&2
    printf '  The platform source is present in an agent container and absent in CI.\n' >&2
    printf '  Run this from a container, or point PAPERCLIP_SHARED_VALIDATORS at a checkout.\n' >&2
    exit "$EX_UNVERIFIED"
  fi

  local derived
  derived=$(PC_VALIDATORS="$validators" node --input-type=module -e '
    const m = await import(process.env.PC_VALIDATORS);
    const s = m.createIssueThreadInteractionSchema;
    const map = s.optionsMap ?? s._def?.optionsMap;
    if (!map) { console.error("no discriminated-union optionsMap; schema shape changed"); process.exit(3); }
    const perKind = [...map].map(([, opt]) => Object.keys(opt.shape).sort().join(" "));
    if (new Set(perKind).size !== 1) { console.error("kinds no longer share one key set: " + JSON.stringify(perKind)); process.exit(3); }
    console.log(perKind[0]);
  ' 2>&1)
  local rc=$?

  if (( rc != 0 )); then
    printf '%s: UNVERIFIED — could not derive the key set:\n%s\n' "$TOOL_NAME" "$derived" >&2
    exit "$EX_UNVERIFIED"
  fi

  if [[ "$derived" == "$ACCEPTED_ENVELOPE_KEYS" ]]; then
    printf 'KEYSET OK — the pin matches the deployed schema (%d keys).\n' "$(wc -w <<<"$derived")"
    printf '  source: %s\n' "$validators"
    exit "$EX_OK"
  fi

  printf 'KEYSET DRIFT — the platform no longer accepts the pinned key set.\n' >&2
  printf '  pinned:  %s\n' "$ACCEPTED_ENVELOPE_KEYS" >&2
  printf '  derived: %s\n' "$derived" >&2
  printf '\n  Added by the platform: %s\n' \
    "$(comm -13 <(tr ' ' '\n' <<<"$ACCEPTED_ENVELOPE_KEYS" | sort) <(tr ' ' '\n' <<<"$derived" | sort) | tr '\n' ' ')" >&2
  printf '  Removed by the platform: %s\n' \
    "$(comm -23 <(tr ' ' '\n' <<<"$ACCEPTED_ENVELOPE_KEYS" | sort) <(tr ' ' '\n' <<<"$derived" | sort) | tr '\n' ' ')" >&2
  printf '\n  Update ACCEPTED_ENVELOPE_KEYS and re-read the default table at\n' >&2
  printf '  services/issue-thread-interactions.ts:225 before trusting this tool again.\n' >&2
  exit "$EX_KEYSET_DRIFT"
}

# --------------------------------------------------------------------------
# lint
# --------------------------------------------------------------------------
cmd_lint() {
  local quiet=0 allow_default=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --quiet)         quiet=1 ;;
      --allow-default) allow_default=1 ;;
      -h|--help)       usage; exit "$EX_OK" ;;
      *) die "unknown option: $1" ;;
    esac
    shift
  done

  command -v jq >/dev/null 2>&1 || die "jq is required"

  local body
  body=$(cat)
  [[ -n "${body//[[:space:]]/}" ]] || die "empty stdin; pipe the envelope JSON in"

  jq -e 'type == "object"' >/dev/null 2>&1 <<<"$body" \
    || die "stdin is not a JSON object (the envelope is the whole POST body)"

  local errors=() warnings=()

  # ---- 1. Unknown keys. This is the whole point of the tool. ----------------
  local key
  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    if [[ " $ACCEPTED_ENVELOPE_KEYS " == *" $key "* ]]; then
      continue
    fi
    local trap_line correct why
    trap_line=$(awk -F'\t' -v k="$key" '$1 == k {print; exit}' <<<"$KNOWN_TRAPS")
    if [[ -n "$trap_line" ]]; then
      correct=$(cut -f2 <<<"$trap_line")
      why=$(cut -f3 <<<"$trap_line")
      if [[ "$correct" == "-" ]]; then
        errors+=("\`$key\` is silently stripped: $why")
      else
        errors+=("\`$key\` is silently stripped — you meant \`$correct\`. $why")
      fi
    else
      errors+=("\`$key\` is not a key the server reads. It will be dropped without an error and whatever it was meant to set will fall back to a default.")
    fi
  done < <(jq -r 'keys_unsorted[]' <<<"$body")

  # ---- 2/3. resolverPolicy: present, explicit, and a real value. -----------
  local has_policy policy
  has_policy=$(jq -r 'has("resolverPolicy")' <<<"$body")
  if [[ "$has_policy" == "true" ]]; then
    policy=$(jq -r '.resolverPolicy // "null"' <<<"$body")
    if [[ " $VALID_POLICIES " != *" $policy "* ]]; then
      errors+=("\`resolverPolicy\` is \"$policy\"; the server accepts only: $VALID_POLICIES. (This one the server WOULD catch — 400 invalid_enum_value — but catching it here saves the round trip.)")
    fi
  elif (( ! allow_default )); then
    errors+=("\`resolverPolicy\` is absent, so a per-kind default decides who may answer you (services/issue-thread-interactions.ts:225-231). Set it explicitly. Pass --allow-default only if the default is what you actually want and you have checked which one it is.")
  fi

  # ---- 4. kind ------------------------------------------------------------
  local kind
  kind=$(jq -r '.kind // ""' <<<"$body")
  case "$kind" in
    suggest_tasks|ask_user_questions|request_confirmation|request_checkbox_confirmation|request_item_verdicts) ;;
    "") errors+=("\`kind\` is missing. It is the discriminator; without it the server cannot pick a schema and the whole body is rejected.") ;;
    *)  errors+=("\`kind\` is \"$kind\", which is not one of: suggest_tasks ask_user_questions request_confirmation request_checkbox_confirmation request_item_verdicts") ;;
  esac

  # ---- 5. payload.supersedeOnUserComment — warning, not an error. ----------
  # Out of TOG-396's stated scope (it is a payload field, not an envelope key)
  # but it is the same failure class and it is the measured largest single
  # cause of dead interactions, so silence here would be its own trap.
  local has_supersede
  has_supersede=$(jq -r 'if (.payload|type) == "object" then (.payload|has("supersedeOnUserComment")) else "no-payload" end' <<<"$body")
  if [[ "$has_supersede" == "false" ]]; then
    warnings+=("\`payload.supersedeOnUserComment\` is not set, so it defaults to TRUE. It fires on an OWNER comment: the owner replying on your issue cancels the question you asked them. Set it false explicitly unless you want that.")
  fi

  # ---- report -------------------------------------------------------------
  if (( ${#warnings[@]} > 0 )); then
    printf 'WARNING: %s\n' "${warnings[@]}" >&2
  fi

  if (( ${#errors[@]} > 0 )); then
    {
      printf 'ENVELOPE REJECTED — the server would accept this and change it.\n\n'
      printf '  - %s\n' "${errors[@]}"
      printf '\nA 201 is not confirmation that your fields took. Fix these and re-run.\n'
    } >&2
    exit "$EX_REJECTED"
  fi

  if (( ! quiet )); then
    printf 'ENVELOPE OK — every key survives the server, and resolverPolicy is explicit.\n'
    printf '  kind            %s\n' "$kind"
    printf '  resolverPolicy  %s%s\n' \
      "$(jq -r '.resolverPolicy // "(defaulted — you passed --allow-default)"' <<<"$body")" \
      ""
    printf '\nThis checks the SHAPE only. Whether the addressee can actually resolve it\n'
    printf 'is a different question — that is `interaction_route.sh route`.\n'
  fi
  exit "$EX_OK"
}

# --------------------------------------------------------------------------
main() {
  case "${1:-}" in
    --verify-keyset) shift; cmd_verify_keyset "$@" ;;
    -h|--help)       usage; exit "$EX_OK" ;;
    *)               cmd_lint "$@" ;;
  esac
}

main "$@"
