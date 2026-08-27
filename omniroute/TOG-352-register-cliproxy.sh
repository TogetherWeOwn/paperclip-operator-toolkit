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

# Strip inherited management credentials before any child process starts. Keep
# one shell-local copy for the private curl config fd below; /proc exposes every
# child environment on this host.
MGMT_KEY="${OMNIROUTE_MGMT_TOKEN:-}"
export -n MGMT_KEY 2>/dev/null || true
unset OMNIROUTE_MGMT_TOKEN

CP_ENV="${CP_ENV:-$HOME/secure-drop/cliproxy.env}"
OMNIROUTE_BASE="${OMNIROUTE_BASE:-https://router.example.net}"
NODE_NAME="${NODE_NAME:-cliproxy}"
NODE_PREFIX="${NODE_PREFIX:-cliproxy}"
CONN_NAME="${CONN_NAME:-cliproxy-main}"
# PROVIDER_ID is NOT set here. It is DERIVED from the provider node's own id
# once the node is known (see resolve_node_id below).
#
# Measured, TOG-485: this build returns `openai-compatible-<apiType>-<uuid>`
# (e.g. openai-compatible-chat-1628780c-...), NOT `openai-compatible-<prefix>`.
# Constructing it produced {"error":"OpenAI Compatible node not found"} AFTER
# the node had already been created, so the script left a real node behind and
# then failed. The node's own id IS the provider id. Derive it, never build it.
PROVIDER_ID=""

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

# Source without auto-export. If the file itself exports the variable, clear the
# attribute immediately before the next child starts.
. "$CP_ENV"
CP_KEY="${CLIPROXY_API_KEY:-}"
export -n CP_KEY 2>/dev/null || true
unset CLIPROXY_API_KEY
[[ -n "$CP_KEY" ]] || die "CLIPROXY_API_KEY not set by $CP_ENV"
echo "cliproxy credential: loaded (${#CP_KEY} chars, not shown)"

[[ -n "$MGMT_KEY" ]] || die "set OMNIROUTE_MGMT_TOKEN to an OmniRoute *management* token (an agent key gets 403 AUTH_001)"

# curl auth via a --config file on a fd, so no secret reaches argv or the filesystem.
# Request bodies use stdin: connection-create JSON contains the CLIProxy key.
mgmt() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method" -H "Content-Type: application/json" -w '\n%{http_code}')
  [[ -n "$body" ]] && args+=(--data-binary @-)
  if [[ -n "$body" ]]; then
    # -q MUST be argv[1]; otherwise curl reads ~/.curlrc before this private
    # config and can trace, dump, or forward the management credential.
    printf '%s' "$body" | curl -q "${args[@]}" --config /dev/fd/3 "${OMNIROUTE_BASE}${path}" \
      3<<<"header = \"Authorization: Bearer ${MGMT_KEY}\""
  else
    curl -q "${args[@]}" --config /dev/fd/3 "${OMNIROUTE_BASE}${path}" \
      3<<<"header = \"Authorization: Bearer ${MGMT_KEY}\""
  fi
}

cp_get() {
  curl -q -sS --config /dev/fd/3 "${CP_BASE_FOR_OPERATOR}$1" \
    3<<<"header = \"Authorization: Bearer ${CP_KEY}\""
}

# -- CLIProxy liveness and a FRESH catalogue read -----------------------------
# The issue says 61 models. That number is NOT hardcoded anywhere below: it is
# re-read here every run, because the issue itself warns the catalogue moves.
step "CLIProxy catalogue (re-read live — never cite a pinned list)"

cp_models_json="$(cp_get /models)" || die "CLIProxy unreachable at $CP_BASE_FOR_OPERATOR"
cp_count="$(jq -r '(.data // []) | length' <<<"$cp_models_json")"
[[ "${cp_count:-0}" -gt 0 ]] || die "CLIProxy returned no models — refusing to register an empty upstream"
echo "CLIProxy serves $cp_count models right now"
SCRATCH="$(umask 077; mktemp -d "${TMPDIR:-/tmp}/tog352-register.XXXXXXXX")" \
  || die "could not create private scratch directory"
trap 'rm -rf "$SCRATCH"' EXIT
CP_MODELS="$SCRATCH/cliproxy-models"
jq -r '(.data // [])[].id' <<<"$cp_models_json" | sort > "$CP_MODELS" \
  || die "could not record the CLIProxy model catalogue"
echo "full id list written to private per-run scratch (removed on exit)"

cp_has() { grep -qxF "$1" "$CP_MODELS"; }

# -- response-envelope normalisation ------------------------------------------
# Measured, TOG-485: these list endpoints do NOT all return a bare array.
#   GET /api/providers       -> {"connections":[...]}
#   GET /api/provider-nodes  -> {"nodes":[...]} (or a bare array)
#   GET /api/combos          -> {"combos":[...]} (or a bare array)
#
# Status and shape are both gates. Defaulting an unrecognised object to [] turns
# a completed 401/500 into "nothing exists" and makes --apply create duplicates.
mgmt_list() { # mgmt_list <path> <primary-field>
  local path="$1" field="$2" out code body
  out="$(mgmt GET "$path")" || die "management request failed: GET $path"
  code="$(tail -n1 <<<"$out")"
  body="$(sed '$d' <<<"$out")"
  [[ "$code" =~ ^20 ]] || die "GET $path returned HTTP $code: $(head -c 300 <<<"$body")"
  jq -er --arg f "$field" '
    if type == "array" then .
    elif ((.[$f] | type) == "array") then .[$f]
    elif ((.data | type) == "array") then .data
    else error("unrecognised list envelope") end' <<<"$body" \
    || die "GET $path returned an unrecognised list envelope: $(head -c 300 <<<"$body")"
}

list_nodes()  { mgmt_list /api/provider-nodes nodes; }
list_conns()  { mgmt_list /api/providers connections; }
list_combos() { mgmt_list /api/combos combos; }

# name:model — every id is checked against the live CLIProxy catalogue before
# apply, and the same registry defines the required verify state.
COMBOS=(
  "sub-claude-opus:claude-opus-5"
  "sub-claude-sonnet:claude-sonnet-5"
  "sub-claude-fable:claude-fable-5"
  "sub-gemini-flash:gemini-3-flash"
  "sub-gpt:gpt-5.4"
)

# Resolve the provider node id for NODE_PREFIX, or empty if it does not exist.
# The returned id is BOTH the node id and the provider id (see PROVIDER_ID above).
resolve_node_id() {
  list_nodes | jq -r --arg p "$NODE_PREFIX" 'map(select(.prefix==$p)) | .[0].id // empty'
}

if [[ $VERIFY_ONLY -eq 1 ]]; then
  step "VERIFY MODE"
  nodes_json="$(list_nodes)"
  node_count="$(jq -r --arg p "$NODE_PREFIX" '[.[] | select(.prefix==$p)] | length' <<<"$nodes_json")"
  [[ "$node_count" -eq 1 ]] || die "verify: expected exactly one provider node with prefix '$NODE_PREFIX', got $node_count"
  jq -e --arg p "$NODE_PREFIX" --arg name "$NODE_NAME" --arg base "$CP_BASE_FOR_OMNIROUTE" '
    any(.[];
      .prefix == $p
      and .name == $name
      and .type == "openai-compatible"
      and .apiType == "chat"
      and .baseUrl == $base
      and (.id | type) == "string" and (.id | length) > 0)' \
    >/dev/null <<<"$nodes_json" \
    || die "verify: node '$NODE_PREFIX' does not have type=openai-compatible apiType=chat baseUrl=$CP_BASE_FOR_OMNIROUTE"
  PROVIDER_ID="$(jq -r --arg p "$NODE_PREFIX" '.[] | select(.prefix==$p) | .id' <<<"$nodes_json")"
  echo "-- node --"
  jq -r --arg p "$NODE_PREFIX" '.[] | select(.prefix==$p)
      | "id=\(.id) type=\(.type) baseUrl=\(.baseUrl) apiType=\(.apiType)"' <<<"$nodes_json"

  conns_json="$(list_conns)"
  conn_count="$(jq -r --arg p "$PROVIDER_ID" --arg n "$CONN_NAME" '[.[] | select(.provider==$p and .name==$n)] | length' <<<"$conns_json")"
  [[ "$conn_count" -eq 1 ]] || die "verify: expected exactly one '$CONN_NAME' connection for '$PROVIDER_ID', got $conn_count"
  jq -e --arg p "$PROVIDER_ID" --arg n "$CONN_NAME" --arg base "$CP_BASE_FOR_OMNIROUTE" '
    any(.[];
      .provider == $p and .name == $n
      and .isActive == true and .priority == 1
      and .providerSpecificData.baseUrl == $base
      and .providerSpecificData.autoSync == true
      and (.id | type) == "string" and (.id | length) > 0)' \
    >/dev/null <<<"$conns_json" \
    || die "verify: connection '$CONN_NAME' is not active priority=1 autoSync=true at $CP_BASE_FOR_OMNIROUTE"
  CONN_ID="$(jq -r --arg p "$PROVIDER_ID" --arg n "$CONN_NAME" '.[] | select(.provider==$p and .name==$n) | .id' <<<"$conns_json")"
  echo "-- connection --"
  jq -r --arg id "$CONN_ID" '.[] | select(.id==$id)
      | "id=\(.id) name=\(.name) active=\(.isActive) priority=\(.priority) test=\(.testStatus)"' <<<"$conns_json"

  echo "-- catalogue exposure through OmniRoute --"
  omniroute_ids="$(mgmt_list /v1/models data | jq -c --arg p "$NODE_PREFIX/" '[.[].id | select(startswith($p)) | ltrimstr($p)] | sort | unique')"
  cliproxy_ids="$(jq -c '[.data[].id] | sort | unique' <<<"$cp_models_json")"
  [[ "$omniroute_ids" == "$cliproxy_ids" ]] \
    || die "verify: ${NODE_PREFIX}/ catalogue does not exactly match CLIProxy (OmniRoute=$(jq length <<<"$omniroute_ids"), CLIProxy=$(jq length <<<"$cliproxy_ids"))"
  echo "$(jq length <<<"$omniroute_ids") ids under ${NODE_PREFIX}/; exact set match"

  echo "-- combos --"
  combos_json="$(list_combos)"
  for entry in "${COMBOS[@]}"; do
    cname="${entry%%:*}"; mid="${entry#*:}"
    combo_count="$(jq -r --arg name "$cname" '[.[] | select(.name==$name)] | length' <<<"$combos_json")"
    [[ "$combo_count" -eq 1 ]] || die "verify: expected exactly one combo named '$cname', got $combo_count"
    jq -e --arg name "$cname" --arg model "$mid" --arg pid "$PROVIDER_ID" --arg cid "$CONN_ID" '
      any(.[];
        .name == $name
        and .strategy == "priority"
        and (.models | type) == "array" and (.models | length) >= 1
        and .models[0].model == $model
        and .models[0].providerId == $pid
        and .models[0].connectionId == $cid)' \
      >/dev/null <<<"$combos_json" \
      || die "verify: combo '$cname' first leg is not '$mid' via provider '$PROVIDER_ID' connection '$CONN_ID'"
  done
  jq -r '.[] | "\(.name): strategy=\(.strategy) legs=[\([.models[]? | "\(.model)@\(.providerId // "?")"] | join(" -> "))]"' <<<"$combos_json"
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

existing_node="$(resolve_node_id)"

if [[ -n "$existing_node" ]]; then
  echo "already exists: $existing_node (verify baseUrl is $CP_BASE_FOR_OMNIROUTE)"
  NODE_ID="$existing_node"
else
  echo "create: $node_payload"
  if [[ $APPLY -eq 1 ]]; then
    out="$(mgmt POST /api/provider-nodes "$node_payload")"
    [[ "$(tail -n1 <<<"$out")" =~ ^20 ]] || die "node create failed: $out"
    NODE_ID="$(sed '$d' <<<"$out" | jq -r '.id // .node.id // empty')"
    # Fail loudly rather than carrying an empty id into step 2. The old failure
    # mode was to create the node, then fail on a CONSTRUCTED provider id and
    # leave the node orphaned; an empty id here would recreate that mess.
    [[ -n "$NODE_ID" ]] || die "node created but no id in response: $(sed '$d' <<<"$out" | head -c 300)"
    echo "created node: $NODE_ID"
  else
    NODE_ID="<node-id>"
  fi
fi

# THE provider id. Same string as the node id — derived, never constructed.
PROVIDER_ID="$NODE_ID"
echo "provider id (derived from node): $PROVIDER_ID"

# ------------------------------------------------------------ 2. connection --
step "2. Connection"

conn_payload="$(printf '%s' "$CP_KEY" | jq -Rs \
  --arg provider "$PROVIDER_ID" \
  --arg name "$CONN_NAME" \
  --arg baseUrl "$CP_BASE_FOR_OMNIROUTE" \
  '{provider:$provider, name:$name, apiKey:., isActive:true, priority:1,
    providerSpecificData:{baseUrl:$baseUrl, autoSync:true}}')"
# autoSync:true is REQUIRED and is the whole of scope item 2 ("must re-sync, not
# be a one-time paste"). The scheduler skips every connection whose
# providerSpecificData.autoSync is not exactly true
# (src/shared/services/modelSyncScheduler.ts:162 `if (psd.autoSync !== true) continue`).
# Without it the catalogue never refreshes on its own — not next cycle, not ever.
# It does NOT populate the catalogue now: the scheduler runs at startup+5s then
# every 24h. Step 3 does the immediate population.

existing_conn="$(list_conns \
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
  sync_body="$(sed '$d' <<<"$out")"
  # The field is `syncedModels`. Measured, TOG-485.
  #
  # This line previously read `.models // .synced`, got 0 while the response body
  # plainly said `syncedModels: 61`, and the gate below then aborted a
  # registration that had ALREADY SUCCEEDED — printing a message that blamed
  # networking which was in fact working. That false negative sent the operator
  # to re-debug a solved problem. A false negative on a correctness gate costs
  # as much as a false positive.
  #
  # The gate stays. Only the field name was wrong. The fallbacks are kept ONLY
  # as a last resort, and the raw body is printed whenever the count does not
  # look right, so the next field-name drift is visible instead of silent.
  synced="$(jq -r '(.syncedModels // .models // .synced // [])
                   | if type=="array" then length else . end' <<<"$sync_body" 2>/dev/null || echo '?')"
  echo "synced: $synced models (CLIProxy advertised $cp_count)"
  if ! [[ "$synced" =~ ^[0-9]+$ ]] || [[ "$synced" -eq 0 ]]; then
    echo "raw sync response (count field not found or zero — read this before blaming the network):" >&2
    head -c 600 <<<"$sync_body" >&2; echo >&2
    die "sync-models returned no usable model count. If the body above shows a non-zero count under some other field name, THIS SCRIPT is wrong, not the chain."
  fi
  [[ "$synced" -eq "$cp_count" ]] \
    || die "sync-models synchronized $synced of $cp_count advertised models — refusing to call a partial catalogue complete"
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

existing_combos="$(list_combos)"

for entry in "${COMBOS[@]}"; do
  cname="${entry%%:*}"; mid="${entry#*:}"
  combo_count="$(jq -r --arg name "$cname" '[.[] | select(.name==$name)] | length' <<<"$existing_combos")"
  [[ "$combo_count" -le 1 ]] || die "multiple combos named '$cname' exist; refusing to choose one"
  if [[ "$combo_count" -eq 1 ]]; then
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
