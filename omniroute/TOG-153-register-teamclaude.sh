#!/usr/bin/env bash
# TOG-153 — register teamclaude as an OmniRoute provider node + connection + Claude combos.
#
# PROPOSAL, NOT A DEPLOYMENT. Review before running. Dry-run is the default.
#
# WHY THIS SCRIPT EXISTS: an agent run cannot do this. GET /api/providers,
# /api/provider-nodes and /api/combos all return 403 AUTH_001 with an agent key —
# management is a separate token class. This needs an operator's management token.
#
# CREDENTIAL HANDLING (do not "simplify" these):
#   - the teamclaude key is read from ~/secure-drop/teamclaude.env via `set -a; . file; set +a`
#   - it is passed to curl through the *environment* and a --config file on fd 3,
#     never in argv, never echoed, never written to disk unencrypted
#   - same for the OmniRoute management token
#
# Rationale for every configuration choice is in TOG-153-teamclaude-omniroute-findings.md.
# The three that will silently bite you if changed:
#   1. type MUST be "anthropic-compatible" with NO compatMode. The "cc" variant sends
#      Authorization: Bearer and cannot send x-api-key (it is on the FORBIDDEN_AUTH
#      denylist), so it 401s against teamclaude in a way that looks like a bad key.
#   2. baseUrl MUST end in /v1. OmniRoute appends "/messages". Without /v1 the
#      connection Test falls through to a system-less Sonnet probe that HANGS and
#      starves teamclaude for every company on the box. This is a safety control.
#   3. the credential MUST be stored as an API key, not an OAuth token. The executor
#      falls back to Authorization: Bearer when apiKey is empty.
#
# TWO OPERATING RULES, both confirmed by TOG-249 (see findings §13):
#   A. DO NOT PRESS THE CONNECTION "TEST" BUTTON in the OmniRoute UI. Its fallback
#      probe is a system-less Sonnet call — the exact shape that hangs — and a hung
#      request holds a shared upstream slot and degrades Claude for every company on
#      this box. Verify with TOG-153-verify.sh instead; that is what it is for.
#   B. DO NOT SET `system_message` ON ANY CLAUDE COMBO. Anthropic's OAuth gate
#      requires the FIRST system block to be the Claude Code identity string exactly.
#      OmniRoute's injection may append (safe), prepend (hangs) or concatenate into
#      block 0 (hangs); which of the three it does has not been measured through a
#      live combo. Leaving it unset is safe under all three, and no combo here needs it.
#
# ADDRESSING: these combos are reached by COMBO NAME (`claude-opus`, ...), not by a
# bare model id. Bare ids do not reach teamclaude — measured, they resolve to other
# providers entirely and return a misleading 200. Findings §13.2.

set -euo pipefail

TC_ENV="${TC_ENV:-$HOME/secure-drop/teamclaude.env}"
OMNIROUTE_BASE="${OMNIROUTE_BASE:-https://router.example.net}"
NODE_NAME="${NODE_NAME:-teamclaude}"
NODE_PREFIX="${NODE_PREFIX:-teamclaude}"
CONN_NAME="${CONN_NAME:-teamclaude-pool}"
# host.containers.internal resolves to the podman host from inside the omniroute container.
TC_BASE_FOR_OMNIROUTE="${TC_BASE_FOR_OMNIROUTE:-http://host.containers.internal:3456/v1}"

APPLY=0
# Refuse an unrecognised argument instead of silently dry-running (TOG-371 review).
# The old form was `[[ "${1:-}" == "--apply" ]] && APPLY=1`, which treats `apply`,
# `-apply` and `--aply` as "no argument" and prints the dry-run banner. That is
# fail-SAFE (nothing is written) but not fail-LOUD: the operator reads a clean run
# and can believe the registration happened when it did not. Same contract as
# TOG-352-register-cliproxy.sh, which has always refused unknown argv.
case "${1:-}" in
  --apply) APPLY=1 ;;
  "")      ;;
  *)       echo "usage: $0 [--apply]" >&2; exit 2 ;;
esac
if [[ $APPLY -eq 0 ]]; then
  echo "### DRY RUN — no writes will be made. Re-run with --apply to execute. ###"
  echo
fi

die() { echo "FATAL: $*" >&2; exit 1; }
step() { echo; echo "== $* =="; }

# ---------------------------------------------------------------- preflight --
step "Preflight"

[[ -r "$TC_ENV" ]] || die "cannot read $TC_ENV"
perm="$(stat -c '%a' "$TC_ENV")"
[[ "$perm" == "600" ]] || echo "WARN: $TC_ENV is mode $perm, expected 600"

set -a; . "$TC_ENV"; set +a
[[ -n "${TEAMCLAUDE_API_KEY:-}" ]] || die "TEAMCLAUDE_API_KEY not set by $TC_ENV"
echo "teamclaude credential: loaded (${#TEAMCLAUDE_API_KEY} chars, not shown)"

: "${OMNIROUTE_MGMT_TOKEN:?set OMNIROUTE_MGMT_TOKEN to an OmniRoute *management* token (an agent key gets 403 AUTH_001)}"

# curl auth via a --config file on a fd, so no secret reaches argv or the filesystem.
mgmt() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method" -H "Content-Type: application/json" -w '\n%{http_code}')
  [[ -n "$body" ]] && args+=(-d "$body")
  curl "${args[@]}" --config /dev/fd/3 "${OMNIROUTE_BASE}${path}" \
    3<<<"header = \"Authorization: Bearer ${OMNIROUTE_MGMT_TOKEN}\""
}

resp="$(mgmt GET /api/providers || true)"
code="$(tail -n1 <<<"$resp")"
[[ "$code" == "200" ]] || die "management token rejected (HTTP $code). 403 => wrong token class, not a wrong URL."
echo "management token: OK"

# Reachability of teamclaude *from the omniroute container* is the thing that matters.
# If podman is available, check it there; otherwise fall back to a host check and say so.
#
# SLOW-CATALOGUE WARNING (measured 2026-08-24, agent container -> teamclaude).
# Authenticated GET /v1/models has HIGHLY VARIABLE latency. 8 consecutive calls:
#   0.11  0.13  0.14  0.16  0.20  14.61  21.46  45.34  (seconds)
# This is NOT a clean cold/warm cache — an idle gap did not predict the next
# latency (0.16s "cold" refetch, then 45.34s after 30s idle, then 0.2s after
# 120s idle). Treat it as a long-tailed upstream/contention distribution.
# Two consequences for the operator:
#   1. A slow response here is NOT a bad key. The unauthenticated 401 returns in
#      0.02s and local GET /teamclaude/status in 0.00s, so auth and the local
#      server are provably fine. Do NOT start rotating the proxy key on slowness.
#   2. OmniRoute's outbound fetch timeouts cluster at 10-15s
#      (src/lib/services/modelSync.ts FETCH_TIMEOUT_MS=10_000; usage/fetcher.ts
#      10-15s). The observed tail exceeds that, so an OmniRoute-side catalogue
#      fetch CAN time out. Retry the Test button before concluding failure.
# Running this step first is a cheap best-effort warm, not a guarantee.
# NOTE: I did not identify a provider-node models-sync path that fires
# automatically for anthropic-compatible nodes, so the timeout risk above is a
# plausible first-Test failure mode, not an observed one.
step "teamclaude reachability (catalogue latency is long-tailed; this call may take ~45s)"
if command -v podman >/dev/null 2>&1 && podman ps --format '{{.Names}}' | grep -qx omniroute; then
  # -e passes the value by inheritance; it never appears in the command line.
  podman exec -e TEAMCLAUDE_API_KEY omniroute sh -c '
    body=$(curl -sS --max-time 60 -w "\n%{http_code} %{time_total}" \
      -H "x-api-key: $TEAMCLAUDE_API_KEY" -H "anthropic-version: 2023-06-01" \
      http://host.containers.internal:3456/v1/models)
    code=$(echo "$body" | tail -n1 | cut -d" " -f1)
    secs=$(echo "$body" | tail -n1 | cut -d" " -f2)
    echo "  GET /v1/models from omniroute container: HTTP $code in ${secs}s"
    [ "$code" = "200" ] || exit 1
    echo "$body" | sed "\$d" > /tmp/tc-models.json
  ' || die "teamclaude not reachable from the omniroute container"
  MODELS_JSON="$(podman exec omniroute cat /tmp/tc-models.json)"
  podman exec omniroute rm -f /tmp/tc-models.json
else
  echo "  WARN: omniroute container not found; checking from this host instead."
  echo "  NOTE: a host-side pass does NOT prove the container can reach it."
  resp="$(curl -sS --max-time 60 -w '\n%{http_code} %{time_total}' \
    -H "x-api-key: ${TEAMCLAUDE_API_KEY}" -H 'anthropic-version: 2023-06-01' \
    "${TEAMCLAUDE_BASE_URL:-http://127.0.0.1:3456}/v1/models")"
  code="$(tail -n1 <<<"$resp" | cut -d' ' -f1)"
  secs="$(tail -n1 <<<"$resp" | cut -d' ' -f2)"
  echo "  GET /v1/models from host: HTTP $code in ${secs}s"
  [[ "$code" == "200" ]] || die "teamclaude /v1/models returned $code"
  MODELS_JSON="$(sed '$d' <<<"$resp")"
fi

# Pre-flight: every model id this script is about to put in a combo must exist in
# teamclaude's catalogue. Catching a renamed/retired id here costs one grep;
# catching it after the combos are live costs a 404 in production traffic.
# Verified present 2026-08-24 (catalogue had 10 ids).
step "teamclaude catalogue pre-flight"
# Guard first: an empty or unparseable MODELS_JSON makes every id below report
# ABSENT, which reads exactly like a real catalogue change. Fail on the actual
# cause instead. (Observed during authoring: a missing file produced a confident
# all-ABSENT result.)
jq -e '.data | type == "array" and length > 0' >/dev/null 2>&1 <<<"$MODELS_JSON" \
  || die "catalogue response was empty or unparseable — cannot pre-flight model ids (this is a fetch problem, not a missing model)"
missing=0
for m in claude-opus-5 claude-sonnet-5 claude-haiku-4-5-20251001 claude-fable-5; do
  if jq -e --arg m "$m" '[.data[].id] | index($m)' >/dev/null 2>&1 <<<"$MODELS_JSON"; then
    echo "  $m: present"
  else
    echo "  $m: *** ABSENT from teamclaude catalogue ***"; missing=1
  fi
done
[[ $missing -eq 0 ]] || die "a combo model id is not served by teamclaude; fix the id list before applying"

# --------------------------------------------------------- 1. provider node --
step "1. Provider node"

node_payload="$(jq -nc \
  --arg name "$NODE_NAME" --arg prefix "$NODE_PREFIX" --arg baseUrl "$TC_BASE_FOR_OMNIROUTE" \
  '{name:$name, prefix:$prefix, type:"anthropic-compatible", baseUrl:$baseUrl}')"
# NOTE: deliberately no compatMode, no chatPath, no customHeaders. See header comment.

existing_node="$(mgmt GET /api/provider-nodes | sed '$d' \
  | jq -r --arg p "$NODE_PREFIX" '(if type=="array" then . else (.nodes // .data // []) end)
      | map(select(.prefix==$p)) | .[0].id // empty')"

if [[ -n "$existing_node" ]]; then
  echo "already exists: $existing_node (leaving as-is; verify baseUrl ends in /v1)"
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
step "2. Connection (exactly ONE — teamclaude rotates its own accounts internally)"

# The api key goes in the JSON body; build it with jq --arg so it is never in argv.
conn_payload="$(TC_KEY="$TEAMCLAUDE_API_KEY" jq -nc \
  --arg provider "anthropic-compatible-${NODE_PREFIX}" \
  --arg name "$CONN_NAME" \
  --arg baseUrl "$TC_BASE_FOR_OMNIROUTE" \
  '{provider:$provider, name:$name, apiKey:env.TC_KEY, isActive:true, priority:1,
    providerSpecificData:{baseUrl:$baseUrl, validationModelId:"claude-haiku-4-5-20251001",
                          autoSync:true}}')"
# autoSync:true is REQUIRED for the catalogue to stay populated. The auto-sync
# scheduler skips every connection whose providerSpecificData.autoSync is not
# exactly true (modelSyncScheduler.ts:161), so without it the teamclaude/* model
# list never refreshes on its own -- not at the next cycle, not ever. It does NOT
# populate the catalogue now; the scheduler only runs at startup+5s and every 24h
# (modelSyncScheduler.ts:276-283). Step 5 below does the immediate population.

existing_conn="$(mgmt GET /api/providers | sed '$d' \
  | jq -r --arg p "anthropic-compatible-${NODE_PREFIX}" \
      'map(select(.provider==$p)) | .[0].id // empty')"

n_conn="$(mgmt GET /api/providers | sed '$d' \
  | jq -r --arg p "anthropic-compatible-${NODE_PREFIX}" 'map(select(.provider==$p)) | length')"
[[ "${n_conn:-0}" -le 1 ]] || die "found $n_conn teamclaude connections — MUST be exactly 1 (see findings §7)"

if [[ -n "$existing_conn" ]]; then
  echo "already exists: $existing_conn"
  CONN_ID="$existing_conn"
else
  echo "create: connection '$CONN_NAME' (apiKey redacted; validationModelId=claude-haiku-4-5-20251001)"
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

# ---------------------------------------------------------------- 3. combos --
step "3. Claude combos (single leg each, pinned to the teamclaude connection)"

# Single-leg by design. Allowing Claude PAYG later is an EDIT to the combo — add a
# second leg — with no code change and no deploy. Do not add a PAYG code path.
#
# ALL FOUR SHIP ACTIVE. An earlier revision of this package said to create all four
# but activate only claude-haiku, because every non-Haiku model appeared to hang.
# TOG-249 identified that gate as Anthropic's OAuth identity check — the first
# system block must be the Claude Code identity string byte-for-byte — and
# Sonnet/Opus/Fable all answer in ~1.2s on the correct shape. Paperclip's
# claude_local adapter IS Claude Code and emits that block natively. Restriction
# lifted; it is superseded, not reversed.
#
# Worth knowing if you are tempted to reinstate it: you cannot. Combos are created
# active BY CONSTRUCTION — createComboSchema (src/shared/validation/schemas/combo.ts:285)
# has no isActive field at all; only updateComboSchema (:349) does, and every read
# path treats `isActive !== false` as active. "Create inactive" is not expressible
# in one call. It would take a second PATCH per combo, with a live window in
# between. Do not attempt it.
#
# DO NOT SET system_message ON ANY CLAUDE COMBO. It is accepted by the schema and
# it will hang the lane. OmniRoute applies it via comboSetup.ts:100 ->
# comboAgentMiddleware.ts:120 applySystemMessageOverride(), which does:
#     messages.filter(m => m.role !== "system")        <- strips every system msg
#     return [{role:"system", content: X}, ...filtered] <- and prepends its own
# Strip-and-prepend is precisely the shape TOG-249 measured as hanging (cell F,
# [X, CC]; cell S2, concatenated into block 0). The module docstring is explicit:
# "replacing any existing system message". The middleware only fires when the
# field is a non-empty string (comboAgentMiddleware.ts:199), so leaving it unset
# is a provable no-op rather than a hopeful default. No combo here needs it.
# TOG-153-verify.sh section B2 fails the run if one is ever set.
declare -A COMBO_ID=()

combo_id_by_name() {
  mgmt GET /api/combos | sed '$d' \
    | jq -r --arg n "$1" '(if type=="array" then . else (.combos // .data // []) end)
        | map(select(.name==$n)) | .[0].id // empty'
}

COMBO_SPEC='claude-opus|claude-opus-5
claude-sonnet|claude-sonnet-5
claude-haiku|claude-haiku-4-5-20251001
claude-fable|claude-fable-5'

# TC_CATCHALL=1 also builds a DEDICATED catch-all combo whose leg is byte-for-byte
# the claude-sonnet leg. The duplication is the point and it is not redundancy:
# OmniRoute emits NO log line when a model->combo mapping matches
# (resolveComboForModel, src/lib/db/modelComboMappings.ts:216-248, and its caller
# getComboForModel, src/sse/services/model.ts:397-413, both log nothing and the
# caller additionally swallows errors in a bare `catch {}`). The only durable
# evidence a substitution happened is the call_logs row. If the catch-all pointed
# at `claude-sonnet`, a substituted call and a legitimate Sonnet call would both
# land as combo_name='claude-sonnet' and be indistinguishable without an
# allowlist of known-good ids. Pointing it at its own combo makes
#   combo_name='claude-catchall'  ==  a substitution occurred, requested_model = what was asked for
# a single-predicate query with no allowlist to maintain. Costs nothing: same
# node, same connection, same model, same lane.
if [[ "${TC_CATCHALL:-0}" == "1" ]]; then
  COMBO_SPEC+='
claude-catchall|claude-sonnet-5'
fi

while IFS='|' read -r combo_name model_id; do
  [[ -z "$combo_name" ]] && continue
  if [[ "$combo_name" == "claude-catchall" ]]; then
    combo_desc="TOG-153 CATCH-ALL: an unknown claude-* id was contained on-lane and answered by Sonnet. A call_logs row bearing this combo_name IS a silent-substitution event; requested_model on that row is the id the caller actually asked for."
  else
    combo_desc="TOG-153: Claude via teamclaude pool. Single leg by design; add a PAYG leg here to allow PAYG."
  fi
  payload="$(jq -nc \
    --arg name "$combo_name" --arg model "$model_id" \
    --arg pid "$NODE_ID" --arg cid "$CONN_ID" --arg desc "$combo_desc" \
    '{name:$name, strategy:"priority",
      description:$desc,
      models:[{kind:"model", model:$model, providerId:$pid, connectionId:$cid, weight:1}]}')"
  echo "  combo $combo_name -> $model_id"
  if [[ $APPLY -eq 1 ]]; then
    out="$(mgmt POST /api/combos "$payload")"
    c="$(tail -n1 <<<"$out")"
    if [[ "$c" =~ ^20 ]]; then
      COMBO_ID[$combo_name]="$(sed '$d' <<<"$out" | jq -r '.id // .combo.id // empty')"
      echo "    created (${COMBO_ID[$combo_name]})"
    elif [[ "$c" == "409" ]]; then
      COMBO_ID[$combo_name]="$(combo_id_by_name "$combo_name")"
      echo "    already exists (${COMBO_ID[$combo_name]})"
    else die "combo $combo_name failed (HTTP $c): $(sed '$d' <<<"$out" | head -c 300)"; fi
    [[ -n "${COMBO_ID[$combo_name]}" ]] \
      || die "combo $combo_name has no id; cannot map bare ids to it (step 4 would silently no-op)"
  else
    COMBO_ID[$combo_name]="<combo-id:$combo_name>"
  fi
done <<<"$COMBO_SPEC"

# ------------------------------------------------- 4. model → combo mappings --
step "4. Model-combo mappings (this is what makes a BARE claude id stay on-lane)"

# WHY THIS STEP EXISTS — it is not optional, and without it rule 1 is still broken.
#
# Creating the combos above only makes them reachable BY COMBO NAME (`claude-opus`).
# A client that sends the real id `claude-opus-5` does NOT reach them. Measured on
# the live router: a bare `claude-sonnet-5` returns 200 echoing
# `anthropic/claude-sonnet-5` — an id that is not even in the 1,438-entry
# catalogue — i.e. it is served OFF teamclaude. That is the containment rule
# broken by the very id form the owner's rule 3 mandates.
#
# The mechanism that fixes it is the model_combo_mappings table. Resolution order
# is fixed in src/sse/services/model.ts::getComboForModel and runs from
# src/sse/handlers/chat.ts:644, BEFORE any provider resolution:
#     1. exact combo-name match
#     2. glob mapping pattern, enabled=1, ORDER BY priority DESC, created_at ASC
#     3. null  -> provider resolution -> the off-lane fallback above
# So a mapping is the only thing standing between a bare id and the leak.
#
# Matching semantics, from the shipped resolver (verified against the built
# bundle, not just src): the pattern is escaped, `*`->`.*`, `?`->`.`, then
# anchored `^...$` and compiled CASE-INSENSITIVE. A combo with isActive===false
# is skipped and matching CONTINUES to the next mapping.
#
# The combo's leg pins providerId to the teamclaude node, so once a bare id
# resolves to one of these combos it is on-lane by construction.
#
# POST /api/model-combo-mappings body (zod, from the shipped route):
#   pattern      string, 1..500          required
#   comboId      string, min 1           required
#   priority     int                     optional, default 0
#   enabled      bool                    optional, default true
#   description  string, max 1000        optional, default ""

MAP_PRIORITY="${MAP_PRIORITY:-100}"

# getModelComboMappings() returns {items,total} (modelComboMappings.ts:68-91);
# older/other shapes wrap as .mappings or .data, or return a bare array. Accept
# all of them — reading the wrong key yields an EMPTY list, which would silently
# turn every add_mapping below into a duplicate-create attempt.
existing_patterns="$(mgmt GET /api/model-combo-mappings | sed '$d' \
  | jq -r '(if type=="array" then . else (.items // .mappings // .data // []) end)
      | map(.pattern) | .[]' 2>/dev/null || true)"

add_mapping() {
  local pattern="$1" combo="$2" prio="$3" desc="$4"
  if grep -Fxq "$pattern" <<<"$existing_patterns" 2>/dev/null; then
    echo "  mapping $pattern -> $combo : already present, skipping"
    return 0
  fi
  echo "  mapping $pattern -> $combo (priority $prio)"
  [[ $APPLY -eq 1 ]] || return 0
  local body
  body="$(jq -nc --arg p "$pattern" --arg c "${COMBO_ID[$combo]}" \
    --argjson prio "$prio" --arg d "$desc" \
    '{pattern:$p, comboId:$c, priority:$prio, enabled:true, description:$d}')"
  local out c
  out="$(mgmt POST /api/model-combo-mappings "$body")"
  c="$(tail -n1 <<<"$out")"
  [[ "$c" =~ ^20 ]] || die "mapping $pattern failed (HTTP $c): $(sed '$d' <<<"$out" | head -c 300)"
  echo "    created"
}

# Exact-family patterns. `claude-opus*` also catches dated variants such as
# claude-opus-5-20260514 and the [1m] context suffix, which a literal id would miss.
add_mapping 'claude-opus*'   claude-opus   "$MAP_PRIORITY" 'TOG-153: bare Claude Opus ids stay on the teamclaude lane.'
add_mapping 'claude-sonnet*' claude-sonnet "$MAP_PRIORITY" 'TOG-153: bare Claude Sonnet ids stay on the teamclaude lane.'
add_mapping 'claude-haiku*'  claude-haiku  "$MAP_PRIORITY" 'TOG-153: bare Claude Haiku ids stay on the teamclaude lane.'
add_mapping 'claude-fable*'  claude-fable  "$MAP_PRIORITY" 'TOG-153: bare Claude Fable ids stay on the teamclaude lane.'

# ---- OPT-IN CATCH-ALL — read this before enabling it -------------------------
# The four patterns above cover the four families that exist today. An id from a
# family that does not exist yet (say `claude-neptune-6`) matches none of them,
# falls through to provider resolution, and LEAKS OFF-LANE exactly as measured.
#
# TC_CATCHALL=1 adds a lowest-priority `claude-*` -> claude-catchall mapping that
# closes that hole. The trade is explicit and it is not free:
#   containment  an unknown Claude id is served on-lane, never off it
#   cost         it is silently answered by Sonnet, NOT by the model requested
#
# DECIDED 2026-08-24 (Chief of Staff, on-issue): turn it ON. Off-lane leakage
# fails twice — wrong family answers, AND the traffic escapes the teamclaude
# subscription we are trying to spend to 100%. A substituted answer is a quality
# problem you can find later; leaked quota is simply spent. The decision was made
# CONDITIONAL on the substitution being observable, which is why the catch-all
# now points at its own combo rather than at claude-sonnet (see step 3) and why
# TOG-153-verify.sh section B4 asserts that separation. Detection query:
#   SELECT timestamp, requested_model, model, status FROM call_logs
#    WHERE combo_name = 'claude-catchall' ORDER BY timestamp DESC;
# NOTE this is a PULL, not a push: nothing alerts. call_logs is trimmed at the
# first of 7 days / 100k rows (CALL_LOG_RETENTION_DAYS, CALL_LOGS_TABLE_MAX_ROWS,
# src/lib/logEnv.ts:5-9), so an unqueried fire ages out. Frequent fires mean the
# fix is a new family combo, not living on the catch-all.
# Priority 1 keeps it strictly below the exact patterns above.
if [[ "${TC_CATCHALL:-0}" == "1" ]]; then
  echo "  TC_CATCHALL=1 — adding the lowest-priority catch-all."
  add_mapping 'claude-*' claude-catchall 1 \
    'TOG-153 catch-all: unknown Claude ids are contained on-lane and answered by Sonnet. Rows with this combo_name are substitution events.'
else
  echo "  catch-all: NOT added (TC_CATCHALL=1 to enable — see the comment above)."
  echo "  An unrecognised claude-* id will still resolve OFF-lane until this is decided."
fi

# ------------------------------------------------ 5. populate model catalogue --
step "5. Model catalogue sync (this is what makes teamclaude/* appear in /v1/models)"

# Creating the node and the connection does NOT populate the catalogue. Confirmed
# in source, not inferred:
#   * /v1/models reads custom-node models from key_value namespace
#     'syncedAvailableModels', key '<providerId>:<connectionId>', gated on
#     provider_connections.is_active = 1   (src/lib/db/models.ts:538-546)
#   * that store is written ONLY by replaceSyncedAvailableModelsForConnection
#     (src/lib/db/models.ts:558), whose only callers are the sync-models route
#   * nothing fires it on create -- the auto-sync scheduler is the only automatic
#     caller and it runs at startup+5s then every 24h (modelSyncScheduler.ts:276)
# So this step is the difference between a catalogue that is populated now and one
# that is populated at some point in the next 24 hours.
#
# IMPORTANT: an empty teamclaude/* catalogue does NOT mean the lane is broken.
# Combo resolution never consults the catalogue -- getComboForModel checks the
# combos table then model_combo_mappings and nothing else (src/sse/services/
# model.ts:397-414), and lookupModelMeta is metadata enrichment with a catch-all
# fallback, not a gate (model.ts:206-231). The combos from steps 3-4 route with an
# empty catalogue. This step exists for the three things that DO need it: bare-id
# inference (getActiveProvidersWithSyncedModel), wildcard combo legs, and the
# dashboard listing. See findings §16.

if [[ $APPLY -eq 1 ]]; then
  echo "POST /api/providers/$CONN_ID/sync-models"
  out="$(mgmt POST "/api/providers/$CONN_ID/sync-models" '{}')"
  code="$(tail -n1 <<<"$out")"
  if [[ "$code" =~ ^20 ]]; then
    echo "  synced: $(sed '$d' <<<"$out" | jq -r '.syncedModels // "?"') models"
  else
    # Non-fatal by design: the lane still routes without this.
    echo "  WARN: sync-models returned $code — catalogue will stay empty until the"
    echo "        24h autoSync cycle runs. The COMBOS ARE STILL LIVE; confirm with"
    echo "        TOG-153-verify.sh. Do not treat this as a failed registration."
    echo "  body: $(sed '$d' <<<"$out" | head -c 300)"
  fi
else
  echo "would POST /api/providers/<connection-id>/sync-models"
fi

step "Done"
if [[ $APPLY -eq 0 ]]; then
  echo "Dry run complete. Re-run with --apply, then run TOG-153-verify.sh."
else
  echo "node=$NODE_ID connection=$CONN_ID"
  echo "NOW RUN: ./TOG-153-verify.sh   (it asserts the models answer instead of hanging)"
  echo "THEN:    router/scripts/claude-lane-preflight.sh"
  echo
  echo "On preflight: it reads catalogue membership only, so it is neither necessary"
  echo "nor sufficient for rule 1 — the combos route with an empty catalogue, and a"
  echo "populated catalogue says nothing about whether the mappings from step 4"
  echo "exist. TOG-153-verify.sh is the authoritative check. See findings §16."
fi
