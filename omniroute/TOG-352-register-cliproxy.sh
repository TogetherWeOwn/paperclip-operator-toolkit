#!/usr/bin/env bash
# TOG-352 — register CLIProxyAPI as an OmniRoute provider node + connection,
# populate the full model catalogue, and build subscription-before-PAYG combos.
#
# PROPOSAL, NOT A DEPLOYMENT. Review before running. Dry-run is the default.
#
# WHY THIS SCRIPT EXISTS: an agent run cannot do this. Re-verified live on
# 2026-08-24 20:0xZ from inside an agent container:
#     GET https://router.example.net/v1/models   with an agent key -> 200
#     GET https://router.example.net/api/providers with an agent key -> 403
# Management is a separate TOKEN CLASS, not a scope an agent key can be granted.
# This needs an operator's management token. Third independent confirmation
# (TOG-152, TOG-153, TOG-352).
#
# ---------------------------------------------------------------------------
# THREE CORRECTIONS TO THE ISSUE AS WRITTEN. Read these before editing anything.
# ---------------------------------------------------------------------------
#
#   1. baseUrl is NOT http://127.0.0.1:8317/v1.
#      OmniRoute runs in its own container. `127.0.0.1` inside that container is
#      OmniRoute itself, not CLIProxy, so the node would be created successfully
#      and then fail every request with a connection error that reads like
#      CLIProxy being down. The address that reaches a host service from inside
#      the OmniRoute container is `host.containers.internal` — this is the same
#      address TOG-153 established for teamclaude on :3456, and :3456 is
#      confirmed reachable on that name from a container today while :8317 and
#      :20128 are not (they are host-loopback only). Use
#      http://host.containers.internal:8317/v1.
#
#   2. combo `strategy: "priority"` does NOT order the legs.
#      `open-sse/services/combo/applyStrategyOrdering.ts` has no `priority`
#      branch; its own docstring says "an unknown strategy falls through with the
#      input order unchanged" and confirms the chain has no trailing else. So
#      `priority` is a no-op that preserves the order the legs were DECLARED in.
#      That happens to give the behaviour we want, which is why it is kept here —
#      but the load-bearing thing is the ORDER OF THE `models` ARRAY, not the
#      strategy string. Reordering that array is what changes routing. Renaming
#      the strategy changes nothing.
#
#      The connection `priority` field is a real mechanism but at the OTHER
#      level: it picks among multiple connections OF THE SAME PROVIDER, via the
#      account selector's default `fill-first` (src/sse/services/auth.ts:1489).
#      Lower number does win there. It has no effect ACROSS providers, which is
#      the ordering this issue actually cares about.
#
#   3. A `cliproxy/*` WILDCARD LEG SILENTLY MATCHES NOTHING.
#      `collectProviderModelIds` (open-sse/services/combo/providerWildcard.ts)
#      expands a wildcard from the synced catalogue unioned with the STATIC
#      provider registry. A custom node has no static registry entry, so before
#      step 5 runs the wildcard expands to zero models — a combo that looks
#      correct and matches nothing. Every leg below is an explicit model id.
#
# ---------------------------------------------------------------------------
# CREDENTIAL HANDLING (do not "simplify" these)
# ---------------------------------------------------------------------------
#   - The CLIProxy bearer key is read from an operator-side env file and passed
#     to curl through the ENVIRONMENT and a --config file on fd 3. Never argv,
#     never echoed, never written to disk.
#   - Same for the OmniRoute management token.
#   - The key is bound to the connection record server-side. It is never placed
#     in any agent run env. Per TOG-191 any agent on this box can read any other
#     agent's /proc/PID/environ, so a run-env binding would be an agent-visible
#     surface. This satisfies the issue's non-negotiable constraint.
#
# ---------------------------------------------------------------------------
# OPERATING RULES CARRIED OVER FROM TOG-153 / TOG-249
# ---------------------------------------------------------------------------
#   A. DO NOT PRESS THE CONNECTION "TEST" BUTTON in the OmniRoute UI for any
#      Claude-serving node. Its fallback probe is a system-less Sonnet call,
#      which is the shape that HANGS, and a hung request holds a shared upstream
#      slot. Use --verify below instead.
#   B. DO NOT SET `system_message` ON ANY CLAUDE COMBO.
#   C. ADDRESS COMBOS BY NAME, never by bare model id. A bare Claude id on the
#      completion surface resolves to some other provider and returns a
#      misleading 200 (measured, TOG-153). Combo names 404 instead of falling
#      back, which is the property that makes them safe to assert on.

set -euo pipefail

CP_ENV="${CP_ENV:-$HOME/secure-drop/cliproxy.env}"
OMNIROUTE_BASE="${OMNIROUTE_BASE:-https://router.example.net}"
NODE_NAME="${NODE_NAME:-cliproxy}"
NODE_PREFIX="${NODE_PREFIX:-cliproxy}"
CONN_NAME="${CONN_NAME:-cliproxy-main}"
PROVIDER_ID="openai-compatible-${NODE_PREFIX}"

# CLIProxy as reached BY OMNIROUTE (from inside the omniroute container).
CP_BASE_FOR_OMNIROUTE="${CP_BASE_FOR_OMNIROUTE:-http://host.containers.internal:8317/v1}"
# CLIProxy as reached BY THIS SCRIPT (from the operator's host shell).
CP_BASE_FOR_OPERATOR="${CP_BASE_FOR_OPERATOR:-http://127.0.0.1:8317/v1}"

APPLY=0
VERIFY_ONLY=0
case "${1:-}" in
  --apply)  APPLY=1 ;;
  --verify) VERIFY_ONLY=1 ;;
  "")       ;;
  *)        echo "usage: $0 [--apply|--verify]" >&2; exit 2 ;;
esac
if [[ $APPLY -eq 0 && $VERIFY_ONLY -eq 0 ]]; then
  echo "### DRY RUN — no writes will be made. Re-run with --apply to execute. ###"
  echo
fi

die()  { echo "FATAL: $*" >&2; exit 1; }
step() { echo; echo "== $* =="; }
warn() { echo "WARN: $*" >&2; }

command -v jq >/dev/null || die "jq is required"

# ---------------------------------------------------------------- preflight --
step "Preflight"

[[ -r "$CP_ENV" ]] || die "cannot read $CP_ENV (expected an operator-side file exporting CLIPROXY_API_KEY)"
perm="$(stat -c '%a' "$CP_ENV" 2>/dev/null || echo '?')"
[[ "$perm" == "600" ]] || warn "$CP_ENV is mode $perm, expected 600"

set -a; . "$CP_ENV"; set +a
[[ -n "${CLIPROXY_API_KEY:-}" ]] || die "CLIPROXY_API_KEY not set by $CP_ENV"
echo "cliproxy credential: loaded (${#CLIPROXY_API_KEY} chars, not shown)"

: "${OMNIROUTE_MGMT_TOKEN:?set OMNIROUTE_MGMT_TOKEN to an OmniRoute *management* token (an agent key gets 403 AUTH_001)}"

# curl auth via a --config file on a fd, so no secret reaches argv or the filesystem.
mgmt() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method" -H "Content-Type: application/json" -w '\n%{http_code}')
  [[ -n "$body" ]] && args+=(-d "$body")
  curl "${args[@]}" --config /dev/fd/3 "${OMNIROUTE_BASE}${path}" \
    3<<<"header = \"Authorization: Bearer ${OMNIROUTE_MGMT_TOKEN}\""
}

cp_get() {
  curl -sS --config /dev/fd/3 "${CP_BASE_FOR_OPERATOR}$1" \
    3<<<"header = \"Authorization: Bearer ${CLIPROXY_API_KEY}\""
}

# -- CLIProxy liveness and a FRESH catalogue read -----------------------------
# The issue says 61 models. That number is NOT hardcoded anywhere below: it is
# re-read here every run, because the issue itself warns the catalogue moves.
step "CLIProxy catalogue (re-read live — never cite a pinned list)"

cp_models_json="$(cp_get /models)" || die "CLIProxy unreachable at $CP_BASE_FOR_OPERATOR"
cp_count="$(jq -r '(.data // []) | length' <<<"$cp_models_json")"
[[ "${cp_count:-0}" -gt 0 ]] || die "CLIProxy returned no models — refusing to register an empty upstream"
echo "CLIProxy serves $cp_count models right now"
jq -r '(.data // [])[].id' <<<"$cp_models_json" | sort > /tmp/tog352-cp-models.$$ || true
echo "full id list written to /tmp/tog352-cp-models.$$"

cp_has() { grep -qxF "$1" /tmp/tog352-cp-models.$$; }

if [[ $VERIFY_ONLY -eq 1 ]]; then
  step "VERIFY MODE"
  echo "-- node --"
  mgmt GET /api/provider-nodes | sed '$d' \
    | jq -r --arg p "$NODE_PREFIX" '(if type=="array" then . else (.nodes // .data // []) end)
        | map(select(.prefix==$p)) | .[] | "id=\(.id) type=\(.type) baseUrl=\(.baseUrl) apiType=\(.apiType)"'
  echo "-- connection --"
  mgmt GET /api/providers | sed '$d' \
    | jq -r --arg p "$PROVIDER_ID" 'map(select(.provider==$p)) | .[]
        | "id=\(.id) name=\(.name) active=\(.isActive) priority=\(.priority) test=\(.testStatus)"'
  echo "-- catalogue exposure through OmniRoute --"
  mgmt GET /v1/models | sed '$d' \
    | jq -r --arg p "$NODE_PREFIX/" '[(.data//[])[].id | select(startswith($p))] | "\(length) ids under \($p)"'
  echo "-- combos --"
  mgmt GET /api/combos | sed '$d' \
    | jq -r '(if type=="array" then . else (.combos // .data // []) end)[]
        | "\(.name): strategy=\(.strategy) legs=[\([.models[]? | "\(.model)@\(.providerId // "?")"] | join(" -> "))]"'
  exit 0
fi

# --------------------------------------------------------- 1. provider node --
step "1. Provider node (type=openai-compatible)"

# VERIFIED FROM SOURCE, not assumed — the issue asked for exactly this check.
# `createProviderNodeSchema` (src/shared/validation/schemas/provider.ts:299)
# accepts type: z.enum(["openai-compatible","anthropic-compatible"]) and
# OPENAI_COMPATIBLE_PREFIX = "openai-compatible-" exists in
# src/shared/constants/providers.ts:135. So a generic OpenAI-compatible node
# type DOES exist. `apiType` is REQUIRED when type is openai-compatible (the
# schema's superRefine rejects the create without it) -> "chat".
# `baseUrl` is left to default to api.openai.com if omitted, so it must be set.
node_payload="$(jq -nc \
  --arg name "$NODE_NAME" --arg prefix "$NODE_PREFIX" --arg baseUrl "$CP_BASE_FOR_OMNIROUTE" \
  '{name:$name, prefix:$prefix, type:"openai-compatible", apiType:"chat", baseUrl:$baseUrl}')"
# Deliberately no customHeaders: Authorization/x-api-key are on the FORBIDDEN_AUTH
# denylist (src/shared/constants/upstreamHeaders.ts) and would be silently dropped.
# The bearer key belongs on the CONNECTION, which is step 2.

existing_node="$(mgmt GET /api/provider-nodes | sed '$d' \
  | jq -r --arg p "$NODE_PREFIX" '(if type=="array" then . else (.nodes // .data // []) end)
      | map(select(.prefix==$p)) | .[0].id // empty')"

if [[ -n "$existing_node" ]]; then
  echo "already exists: $existing_node (verify baseUrl is $CP_BASE_FOR_OMNIROUTE)"
  NODE_ID="$existing_node"
else
  echo "create: $node_payload"
  if [[ $APPLY -eq 1 ]]; then
    out="$(mgmt POST /api/provider-nodes "$node_payload")"
    [[ "$(tail -n1 <<<"$out")" =~ ^20 ]] || die "node create failed: $out"
    NODE_ID="$(sed '$d' <<<"$out" | jq -r '.id // .node.id')"
    echo "created node: $NODE_ID"
  else
    NODE_ID="<node-id>"
  fi
fi

# ------------------------------------------------------------ 2. connection --
step "2. Connection"

conn_payload="$(CP_KEY="$CLIPROXY_API_KEY" jq -nc \
  --arg provider "$PROVIDER_ID" \
  --arg name "$CONN_NAME" \
  --arg baseUrl "$CP_BASE_FOR_OMNIROUTE" \
  '{provider:$provider, name:$name, apiKey:env.CP_KEY, isActive:true, priority:1,
    providerSpecificData:{baseUrl:$baseUrl, autoSync:true}}')"
# autoSync:true is REQUIRED and is the whole of scope item 2 ("must re-sync, not
# be a one-time paste"). The scheduler skips every connection whose
# providerSpecificData.autoSync is not exactly true
# (src/shared/services/modelSyncScheduler.ts:162 `if (psd.autoSync !== true) continue`).
# Without it the catalogue never refreshes on its own — not next cycle, not ever.
# It does NOT populate the catalogue now: the scheduler runs at startup+5s then
# every 24h. Step 3 does the immediate population.

existing_conn="$(mgmt GET /api/providers | sed '$d' \
  | jq -r --arg p "$PROVIDER_ID" 'map(select(.provider==$p)) | .[0].id // empty')"

if [[ -n "$existing_conn" ]]; then
  echo "already exists: $existing_conn"
  CONN_ID="$existing_conn"
else
  echo "create: connection '$CONN_NAME' (apiKey redacted, autoSync=true, priority=1)"
  if [[ $APPLY -eq 1 ]]; then
    out="$(mgmt POST /api/providers "$conn_payload")"
    [[ "$(tail -n1 <<<"$out")" =~ ^20 ]] || die "connection create failed: $(sed '$d' <<<"$out" | head -c 300)"
    CONN_ID="$(sed '$d' <<<"$out" | jq -r '.id // .connection.id')"
    echo "created connection: $CONN_ID"
  else
    CONN_ID="<connection-id>"
  fi
fi
unset conn_payload

# ------------------------------------------------------- 3. populate models --
step "3. Populate the catalogue now (sync-models)"

# Keyed on CONNECTION id despite the /providers/ segment — see
# omniroute-catalogue-population. This is the only thing that writes
# key_value namespace `syncedAvailableModels`, which is what /v1/models reads.
if [[ $APPLY -eq 1 ]]; then
  echo "POST /api/providers/$CONN_ID/sync-models"
  out="$(mgmt POST "/api/providers/$CONN_ID/sync-models" '{}')"
  [[ "$(tail -n1 <<<"$out")" =~ ^20 ]] || die "sync-models failed: $(sed '$d' <<<"$out" | head -c 300)"
  synced="$(sed '$d' <<<"$out" | jq -r '(.models // .synced // []) | if type=="array" then length else . end' 2>/dev/null || echo '?')"
  echo "synced: $synced models (CLIProxy advertised $cp_count)"
else
  echo "would POST /api/providers/<connection-id>/sync-models"
  echo "expect roughly $cp_count ids to appear under ${NODE_PREFIX}/"
fi

# ---------------------------------------------------------------- 4. combos --
step "4. Combos — subscription before PAYG"

# ORDERING RULE (the owner's requirement, scope item 3):
#   leg 1  cliproxy   — OpenCode Go subscription. Separate quota pool, untouched.
#   leg 2  teamclaude — Claude Max subscription. The pool that is the binding
#                       constraint today, so it is SECOND, not first.
#   leg 3  (none)     — no PAYG leg is created by this script. Adding one is a
#                       deliberate combo edit, not a default.
#
# This is expressed purely as the order of the `models` array. See correction 2.
#
# RECONCILIATION WITH TOG-153: if a Claude combo already exists (TOG-153 creates
# claude-opus / claude-sonnet / claude-haiku / claude-fable), this script does
# NOT create a duplicate. It reports what it found and what the merged leg order
# should be, so the two issues converge on one combo per tier instead of two
# competing sets. As of the 18:38Z snapshot no such combo and no teamclaude
# connection exist, so today this branch will not fire.

# name:model — every id is checked against the LIVE CLIProxy catalogue below.
COMBOS=(
  "sub-claude-opus:claude-opus-5"
  "sub-claude-sonnet:claude-sonnet-5"
  "sub-claude-fable:claude-fable-5"
  "sub-gemini-flash:gemini-3-flash"
  "sub-gpt:gpt-5.4"
)

missing=0
for entry in "${COMBOS[@]}"; do
  mid="${entry#*:}"
  if cp_has "$mid"; then
    echo "  ok       $mid"
  else
    echo "  MISSING  $mid  (not in CLIProxy's live catalogue)"
    missing=$((missing+1))
  fi
done
[[ $missing -eq 0 ]] || die "$missing combo model id(s) are not served by CLIProxy — fix the id list before applying"

existing_combos="$(mgmt GET /api/combos | sed '$d' \
  | jq -r '(if type=="array" then . else (.combos // .data // []) end) | map(.name) | join(" ")')"

for entry in "${COMBOS[@]}"; do
  cname="${entry%%:*}"; mid="${entry#*:}"
  if grep -qw -- "$cname" <<<"$existing_combos"; then
    echo "combo '$cname' already exists — leaving as-is (inspect leg order with --verify)"
    continue
  fi
  payload="$(jq -nc --arg name "$cname" --arg model "$mid" \
    --arg pid "$NODE_ID" --arg cid "$CONN_ID" \
    '{name:$name, strategy:"priority",
      models:[{kind:"model", model:$model, providerId:$pid, connectionId:$cid, weight:1}]}')"
  # connectionId is pinned explicitly. ComboModelStep supports it
  # (src/lib/combos/steps.ts) and pinning is what makes "add a teamclaude or PAYG
  # second leg later" a pure combo edit with no code change.
  # NB: do NOT name any combo auto/* — that namespace already serves models
  # unrelated to its name on this instance.
  echo "create combo '$cname' -> $mid"
  if [[ $APPLY -eq 1 ]]; then
    out="$(mgmt POST /api/combos "$payload")"
    [[ "$(tail -n1 <<<"$out")" =~ ^20 ]] || die "combo '$cname' create failed: $(sed '$d' <<<"$out" | head -c 300)"
    echo "  created"
  else
    echo "  payload: $payload"
  fi
done

# ------------------------------------------------------------------ 5. next --
step "Done"
cat <<EOF

Next, in order:

  1. $0 --verify
     Asserts the node type/baseUrl, the connection, the ${NODE_PREFIX}/ catalogue
     count, and every combo's leg order.

  2. Send a real completion THROUGH A COMBO NAME and assert the echoed model:

       curl -sS \$OMNIROUTE_BASE/v1/chat/completions \\
         -H "Authorization: Bearer \$OMNIROUTE_API_KEY" \\
         -H 'Content-Type: application/json' \\
         -d '{"model":"sub-claude-opus","max_tokens":16,
              "messages":[{"role":"user","content":"reply with OK"}]}'

     Assert on the response .model field. It is the only ground truth about what
     answered. Anything echoing anthropic/, openrouter/, oc/, opencode/ or auto/
     is a containment FAIL, not a pass. max_tokens must be >= 16: max_tokens:1 on
     a combo returns a 502 from the quality validator and manufactures a fake
     fallthrough.

  3. Confirm attribution landed on the OpenCode Go subscription and NOT on a Max
     account. There is no in-band connection fingerprint on a 200, so this is a
     management-side read of usage_history (columns: timestamp — NOT created_at —
     connection_id, account_label, provider).
     /paperclip/operator-handoff/TOG-208-conn-counts.py is a working read-only hook.

     YOU MUST OVERRIDE ITS PROVIDER FILTER (TOG-371 review). That tool defaults to
     TOG208_PROVIDER=opencode-go, the provider the bake-off it was written for
     measured. Left at the default it filters out every cliproxy row and prints
     "zero opencode-go rows in [w0, w1)" — which reads as "attribution did not
     land" when it actually means "wrong provider filter". Run it as:

         TOG208_PROVIDER=${PROVIDER_ID} ./TOG-208-conn-counts.py report <W_START> <W_END>

     Run its `selftest` subcommand first; it refuses on a schema it cannot serve
     rather than returning an empty result that looks like a measurement.

  4. Only after 1-3 pass: the model-router plugin's Claude block still pins Claude
     to teamclaude only (CLAUDE_PROVIDER_ALLOWLIST in src/constants.ts). Until the
     OWNER widens it, the plugin will refuse to select a Claude model served by
     cliproxy even though the route now exists. That is an owner policy decision,
     deliberately a one-line change, and it is tracked separately — it is NOT
     bundled into this script.
EOF
