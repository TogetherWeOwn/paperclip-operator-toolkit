#!/usr/bin/env bash
# TOG-153 — verify the teamclaude OmniRoute integration after registration.
#
# Read-only against OmniRoute, and by default it sends no request that can hang.
# Never echoes a credential.
#
# ONE OPT-IN EXCEPTION: the section-A hang canary (HANG_CANARY=1) deliberately
# induces a hang. It is OFF by default and it is NOT free — see the block itself.
#
# The important assertions are the LATENCY ones. The failure mode this integration
# has is not an error code — it is an indefinite HANG on non-Haiku Claude models
# whose first `system` block is not the Claude Code identity string. A test that
# only checks "HTTP 200 eventually" will pass while the thing is broken, so every
# model check below is bounded by --max-time and a slow pass is reported as a FAIL.
#
# Measured basis, CORRECTED by TOG-249 (2026-08-24). The gate is not the SHAPE of
# `system`, it is its CONTENT: the first system block must be the Claude Code
# identity string, byte-for-byte. A bare string works if the string is exact; a
# content-block array with any other text hangs. Sonnet/Opus/Fable answer in ~1.2s
# on the exact string and hang on anything else. Haiku is exempt and answers
# either way in ~0.6s. Full evidence: TOG-249-claude-hang-gate-RESOLVED.md
#
# A hung request also delays or hangs whatever is sent after it. If a check below
# fails unexpectedly, WAIT 60s before re-running or the re-run is uninterpretable.

set -uo pipefail

# The Anthropic OAuth identity gate. Do not reword, reformat or append to this.
CC_IDENTITY="You are Claude Code, Anthropic's official CLI for Claude."

TC_ENV="${TC_ENV:-$HOME/secure-drop/teamclaude.env}"
OMNIROUTE_BASE="${OMNIROUTE_BASE:-https://router.example.net}"
OMNIROUTE_API="${OMNIROUTE_API:-https://router.example.net}"   # :20129-equivalent completion surface
NODE_PREFIX="${NODE_PREFIX:-teamclaude}"
DEADLINE_S="${DEADLINE_S:-15}"

pass=0; fail=0
ok()   { echo "  PASS  $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $*"; fail=$((fail+1)); }
step() { echo; echo "== $* =="; }

set -a; . "$TC_ENV" 2>/dev/null; set +a

# ------------------------------------------------- A. teamclaude directly ----
step "A. teamclaude direct (is the upstream itself healthy?)"

if [[ -n "${TEAMCLAUDE_API_KEY:-}" ]]; then
  TCB="${TEAMCLAUDE_BASE_URL:-http://127.0.0.1:3456}"

  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H "x-api-key: ${TEAMCLAUDE_API_KEY}" -H 'anthropic-version: 2023-06-01' "$TCB/v1/models")
  [[ "$code" == "200" ]] && ok "GET /v1/models = 200 (this is what makes the connection Test short-circuit)" \
                         || bad "GET /v1/models = $code — connection Test will fall through to a HANGING probe"

  # Bearer must be rejected. If this ever starts passing, the auth model changed.
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H "authorization: Bearer ${TEAMCLAUDE_API_KEY}" -H 'anthropic-version: 2023-06-01' "$TCB/v1/models")
  [[ "$code" == "401" ]] && ok "Bearer auth correctly rejected (401)" \
                         || bad "Bearer auth returned $code, expected 401 — re-check the 'cc' analysis"

  # The hang canary — OPT-IN, and deliberately so.
  #
  # It asserts the hazard is still real by sending a system-less Sonnet request and
  # requiring it NOT to come back. That assertion is only obtainable by causing the
  # incident: teamclaude applies no upstream timeout, so the socket is held after
  # curl gives up, the slot stays occupied, and requests behind it are delayed or
  # hung — for EVERY company on the box, because the two pooled Claude Max accounts
  # are shared in real time (TOG-249). curl's --max-time bounds our wait, not the
  # upstream hold.
  #
  # So this is not a verification cost, it is a production cost, and it must be a
  # decision rather than a default. Everything the rest of this script asserts is
  # obtainable without it: section C proves the lane WORKS on the correct identity
  # string, which is the property registration needs. This canary only proves the
  # hazard has not silently disappeared — useful when re-validating the findings,
  # not when confirming a deployment.
  #
  #   HANG_CANARY=1 ./TOG-153-verify.sh    # only in a quiet window, and tell the team
  if [[ "${HANG_CANARY:-0}" == "1" ]]; then
    echo "  !! HANG_CANARY=1: deliberately hanging one upstream slot; this degrades"
    echo "     Claude for every company on this box for ~60s. Ctrl-C now to skip."
    t0=$(date +%s)
    curl -sS -o /dev/null --max-time 12 -X POST "$TCB/v1/messages" \
      -H "x-api-key: ${TEAMCLAUDE_API_KEY}" -H 'anthropic-version: 2023-06-01' \
      -H 'content-type: application/json' \
      -d '{"model":"claude-sonnet-5","max_tokens":16,"messages":[{"role":"user","content":"say ok"}]}' \
      >/dev/null 2>&1
    t1=$(date +%s); dt=$((t1-t0))
    if [[ $dt -ge 11 ]]; then
      ok "system-less Sonnet still hangs (canary intact; hazard still real)"
      echo "        NOTE: that request is still draining upstream. Give it ~60s before"
      echo "        trusting any timing measured immediately after."
    else
      bad "system-less Sonnet returned in ${dt}s — upstream gate CHANGED, re-verify TOG-153 findings"
    fi
    CANARY_RAN=1
  else
    echo "  SKIP  hang canary (HANG_CANARY=1 to run it — it costs a real, shared"
    echo "        upstream slot and briefly degrades Claude for every company)"
  fi
else
  echo "  SKIP  TEAMCLAUDE_API_KEY not loaded from $TC_ENV"
fi

# ------------------------------------------- B. OmniRoute management state ----
step "B. OmniRoute registration state"

if [[ -n "${OMNIROUTE_MGMT_TOKEN:-}" ]]; then
  mgmt() { curl -sS --max-time 20 --config /dev/fd/3 "${OMNIROUTE_BASE}$1" \
             3<<<"header = \"Authorization: Bearer ${OMNIROUTE_MGMT_TOKEN}\""; }

  node="$(mgmt /api/provider-nodes | jq -r --arg p "$NODE_PREFIX" \
    '(if type=="array" then . else (.nodes // .data // []) end) | map(select(.prefix==$p)) | .[0] // empty')"
  if [[ -n "$node" ]]; then
    ok "provider node present"
    [[ "$(jq -r '.type' <<<"$node")" == "anthropic-compatible" ]] \
      && ok "type = anthropic-compatible" || bad "type = $(jq -r '.type' <<<"$node") (must NOT be cc)"
    [[ -z "$(jq -r '.compatMode // empty' <<<"$node")" ]] \
      && ok "no compatMode set" || bad "compatMode is set — cc cannot authenticate to teamclaude"
    b="$(jq -r '.baseUrl' <<<"$node")"
    [[ "$b" == */v1 ]] && ok "baseUrl ends in /v1 ($b)" \
                       || bad "baseUrl='$b' does NOT end in /v1 — Test button will hang teamclaude"
  else
    bad "provider node with prefix '$NODE_PREFIX' not found"
  fi

  n="$(mgmt /api/providers | jq -r --arg p "anthropic-compatible-${NODE_PREFIX}" \
        'map(select(.provider==$p)) | length')"
  [[ "$n" == "1" ]] && ok "exactly 1 connection (teamclaude does its own rotation)" \
                    || bad "found ${n:-0} connections — must be exactly 1"

  # ---- B2. no Claude combo may carry system_message -------------------------
  #
  # This is a HANG guard, not a style rule, and it is the one combo field that can
  # silently break the lane after registration succeeds.
  #
  # Source (omniroute 3.8.49):
  #   comboSetup.ts:100          applyComboAgentMiddleware() runs on EVERY combo
  #                              request, before target resolution.
  #   comboAgentMiddleware.ts:199 fires only when system_message is a non-empty
  #                              string — so leaving it unset is a provable no-op.
  #   comboAgentMiddleware.ts:120 applySystemMessageOverride():
  #                                filter(m => m.role !== "system")   <- STRIPS
  #                                [{role:"system",...}, ...filtered] <- PREPENDS
  #
  # Strip-and-prepend is the shape TOG-249 measured as HANGING (cells F and S2),
  # and Claude Code's identity block is exactly what gets stripped or displaced.
  # The module docstring says "replacing any existing system message" — replace,
  # not append. So this is not a hypothetical.
  #
  # Anything non-empty here is a hard FAIL. Unset/null/"" is the required state.
  combos_json="$(mgmt /api/combos)"
  offenders="$(jq -r '(if type=="array" then . else (.combos // .data // []) end)
      | map(select((.system_message // "") | tostring | test("^\\s*$") | not))
      | map(.name) | join(", ")' <<<"$combos_json" 2>/dev/null)"
  if [[ -z "$offenders" ]]; then
    ok "no combo sets system_message (required: it strips+prepends, which hangs Claude)"
  else
    bad "system_message is SET on: ${offenders} — strip+prepend displaces the Claude Code identity block and HANGS non-Haiku models. Unset it before shipping."
  fi

  # All four combos must exist and none may be explicitly deactivated. Combos are
  # created active by construction: createComboSchema (combo.ts:285) has NO
  # isActive field, only updateComboSchema (:349) does, and every read path treats
  # `isActive !== false` as active. So an absent isActive is the healthy state and
  # only a deliberate PATCH can turn one off.
  for c in claude-opus claude-sonnet claude-haiku claude-fable; do
    st="$(jq -r --arg n "$c" '(if type=="array" then . else (.combos // .data // []) end)
        | map(select(.name==$n)) | .[0]
        | if . == null then "missing" elif (.isActive == false) then "inactive" else "active" end' \
        <<<"$combos_json" 2>/dev/null)"
    [[ "$st" == "active" ]] && ok "combo '$c' present and active" \
                            || bad "combo '$c' is ${st:-unreadable} — TOG-249 lifted the Haiku-only restriction; all four ship active"
  done

  # ---- B4. the catch-all must stay observable -------------------------------
  #
  # The CoS approved TC_CATCHALL on one condition: that a silent substitution can
  # be found after the fact. OmniRoute gives us no help here — a model->combo
  # mapping match emits NO log line at any level (resolveComboForModel,
  # modelComboMappings.ts:216-248; getComboForModel, sse/services/model.ts:397-413,
  # which also swallows errors in a bare `catch {}`). The ONLY durable trace is
  # the call_logs row, which carries requested_model, model and combo_name
  # (schema: src/lib/db/core.ts:348-385).
  #
  # That trace is only unambiguous if the catch-all owns a combo nobody else uses.
  # Pointed at 'claude-sonnet' it would be indistinguishable from ordinary Sonnet
  # traffic. So: if the catch-all mapping exists at all, it MUST point at
  # 'claude-catchall'. This check is what keeps the approval condition true.
  # Envelope note: getModelComboMappings() returns {items,total}
  # (modelComboMappings.ts:68-91) and rowToMapping camelCases combo_name ->
  # comboName (:46-58), but the HTTP layer may re-wrap. Accept every plausible
  # envelope rather than betting on one, and treat an UNPARSEABLE body as a FAIL:
  # silently reading it as "no mapping" would be a false pass on exactly the
  # property this section exists to prove.
  maps_json="$(mgmt /api/model-combo-mappings)"
  maps_arr="$(jq -c 'if type=="array" then . else (.items // .mappings // .data // null) end' \
      <<<"$maps_json" 2>/dev/null)"
  if [[ -z "$maps_arr" || "$maps_arr" == "null" ]]; then
    bad "could not parse /api/model-combo-mappings (envelope not array/.items/.mappings/.data) — catch-all observability is UNVERIFIED, do not assume it is off"
    catchall_combo=""
  else
    catchall_combo="$(jq -r 'map(select(.pattern=="claude-*"))
        | .[0] | (.comboName // .combo_name // empty)' <<<"$maps_arr" 2>/dev/null)"
    if [[ -z "$catchall_combo" ]]; then
      ok "no 'claude-*' catch-all mapping present (TC_CATCHALL off — unknown ids resolve OFF-lane by design)"
    elif [[ "$catchall_combo" == "claude-catchall" ]]; then
      ok "catch-all maps to its own combo 'claude-catchall' (substitutions are queryable by combo_name)"
      st="$(jq -r '(if type=="array" then . else (.combos // .data // []) end)
          | map(select(.name=="claude-catchall")) | .[0]
          | if . == null then "missing" elif (.isActive == false) then "inactive" else "active" end' \
          <<<"$combos_json" 2>/dev/null)"
      [[ "$st" == "active" ]] && ok "combo 'claude-catchall' present and active" \
                              || bad "catch-all maps to 'claude-catchall' but that combo is ${st:-unreadable} — unknown ids will fail instead of being contained"
    else
      bad "catch-all maps to '${catchall_combo}', not 'claude-catchall' — a substituted call becomes indistinguishable from legitimate '${catchall_combo}' traffic in call_logs, which voids the condition TC_CATCHALL was approved under"
    fi
  fi
else
  echo "  SKIP  OMNIROUTE_MGMT_TOKEN not set (an agent key gets 403; this needs a management token)"
fi

# ------------------------------------------------ C. end-to-end via combos ----
step "C. End-to-end (200 AND fast AND exact model echo)"

# A hung request delays or hangs whatever follows it, which is exactly how TOG-249
# nearly reached the wrong conclusion. Only section A's opt-in canary hangs one, so
# the drain is only owed when the canary actually ran. The sanity cell below is the
# real guard either way — it fails loudly if the queue is blocked for any reason,
# including a hang caused by someone else's traffic.
DRAIN_S="${DRAIN_S:-60}"
if [[ "${CANARY_RAN:-0}" == "1" ]]; then
  echo "  ..draining ${DRAIN_S}s so section A's canary cannot confound these timings"
  sleep "$DRAIN_S"
fi

# ADDRESS THE COMBO, NEVER A BARE MODEL ID.
#
# An earlier revision of this section sent bare ids (`claude-sonnet-5`, ...) to the
# completion surface. That does NOT reach teamclaude, and it silently reaches
# something else instead. Measured 2026-08-24, with the teamclaude node NOT yet
# registered, using an agent key against router.example.net:
#
#   claude-opus-5              -> 200, echoed "anthropic/claude-opus-5"
#   claude-sonnet-5            -> 200, echoed "anthropic/claude-sonnet-5"
#   claude-fable-5             -> 200, echoed "anthropic/claude-fable-5"
#   claude-haiku-4-5-20251001  -> 400 "Ambiguous model ... use provider/model prefix"
#   claude-haiku-4-5           -> 401 "Missing API key" (some other provider's)
#
# Three of those are 200s from a provider that is not teamclaude and that did not
# exist in this integration's design. A bare-id test would therefore have gone
# GREEN after registration while proving nothing whatsoever about teamclaude —
# a false pass on the one property the whole task exists to establish.
#
# So every check below addresses a COMBO by name, and asserts on the echoed
# provider prefix, which is the only in-band evidence of which lane actually
# served the request.
COMBO_HAIKU="${COMBO_HAIKU:-claude-haiku}"
COMBO_SONNET="${COMBO_SONNET:-claude-sonnet}"
COMBO_OPUS="${COMBO_OPUS:-claude-opus}"
COMBO_FABLE="${COMBO_FABLE:-claude-fable}"

# Prefixes that prove the request did NOT go through teamclaude. Seen in the live
# catalogue (1438 ids) and in the echoes above.
OFF_LANE_RE='^(anthropic|openrouter|oc|opencode|opencode-go|ddgw|no-think|auto)/'

if [[ -n "${OMNIROUTE_API_KEY:-}" ]]; then
  # TOG-249: for non-Haiku models the FIRST system block must be the Claude Code
  # identity string, BYTE-FOR-BYTE. Not a prefix — appending text inside this
  # block hangs. Extra blocks *after* it are fine; a block before it hangs.
  # Anything else is held open with no status until the client gives up, so a
  # wrong string here reads as "the lane is broken" and blocks traffic behind it.
  # Do not reword this string. See TOG-249-claude-hang-gate-RESOLVED.md.
  call_combo() {   # combo -> "<http> <secs> <echoed-model>"
    local combo="$1" body out code echoed t0 dt
    body="$(jq -nc --arg m "$combo" --arg cc "$CC_IDENTITY" \
      '{model:$m, max_tokens:16,
        system:[{type:"text",text:$cc}],
        messages:[{role:"user",content:"Reply with the single word: ok"}]}')"
    t0=$(date +%s)
    out="$(curl -sS --max-time "$DEADLINE_S" -w '\n%{http_code}' \
      -X POST "${OMNIROUTE_API}/v1/messages" \
      -H "x-api-key: ${OMNIROUTE_API_KEY}" -H 'anthropic-version: 2023-06-01' \
      -H 'content-type: application/json' -d "$body" 2>/dev/null)"
    dt=$(( $(date +%s) - t0 ))
    code="$(tail -n1 <<<"$out")"
    echoed="$(sed '$d' <<<"$out" | jq -r '.model // empty' 2>/dev/null)"
    echo "${code:-timeout} ${dt} ${echoed}"
  }

  # Sanity cell: through the combo, not a bare id — a bare id would exercise a
  # different upstream entirely and tell us nothing about this queue.
  read -r s_code s_dt s_echo <<<"$(call_combo "$COMBO_SONNET")"
  if [[ "$s_code" == "200" && $s_dt -le 5 ]]; then
    ok "sanity: teamclaude lane is clear (200 in ${s_dt}s) — results below are interpretable"
  else
    bad "sanity: HTTP ${s_code} in ${s_dt}s via combo '$COMBO_SONNET' — lane blocked, absent or down. TREAT EVERY RESULT BELOW AS UNINTERPRETABLE; wait 60s and re-run."
  fi

  check_combo() {
    local label="$1" combo="$2" want_model="$3"
    local code dt echoed
    read -r code dt echoed <<<"$(call_combo "$combo")"

    if [[ "$code" != "200" ]]; then
      bad "$label: HTTP ${code} after ${dt}s via combo '$combo'"
    elif [[ $dt -ge $((DEADLINE_S - 2)) ]]; then
      bad "$label: 200 but took ${dt}s — that is the hang signature, not a healthy call"
    elif [[ "$echoed" =~ $OFF_LANE_RE ]]; then
      bad "$label: echoed '$echoed' — served by a NON-teamclaude provider. The combo pin did not hold; this violates rule1_scope=teamclaude_only. Do NOT ship."
    elif [[ "${echoed##*/}" != "$want_model" ]]; then
      bad "$label: echoed '$echoed', expected model id '$want_model' — the id was rewritten, so teamclaude per-model routing/quota will misattribute"
    else
      ok "$label: 200 in ${dt}s via '$combo', echoed '$echoed'"
    fi
  }
  check_combo "haiku " "$COMBO_HAIKU"  "claude-haiku-4-5-20251001"
  check_combo "sonnet" "$COMBO_SONNET" "claude-sonnet-5"
  check_combo "opus  " "$COMBO_OPUS"   "claude-opus-5"
  check_combo "fable " "$COMBO_FABLE"  "claude-fable-5"
else
  echo "  SKIP  OMNIROUTE_API_KEY not set"
fi

step "Result"
echo "  pass=$pass fail=$fail"
[[ $fail -eq 0 ]] || echo "  NOT READY — see TOG-153-teamclaude-omniroute-findings.md"
exit $(( fail > 0 ? 1 : 0 ))
