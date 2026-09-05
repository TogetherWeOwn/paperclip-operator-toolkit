#!/usr/bin/env bash
# TOG-689 regression suite: a freshly provisioned agent must be BORN with an
# explicitly falsy `effort` on its cheap model profile.
#
# WHY THIS EXISTS
# ---------------
# `effort` is a legitimate claude_local CLI-lane field and ships in that
# adapter's own default cheap profile (adapters/claude-local/src/index.ts).
# The ACP engine lane refuses it outright:
#
#   ACP session ... does not advertise config option 'effort'.
#   Supported config options: mode, model.
#
# An agent that downshifts to the cheap profile on the ACP lane therefore dies,
# and cannot self-heal, because self-repair requires it to be running. TOG-685
# swept the 47 existing agents; this suite closes the hole for NEW ones.
#
# THE TRAP THIS SUITE EXISTS TO CATCH
# -----------------------------------
# Omitting the key does NOT work. resolveModelProfileApplication
# (server/src/services/heartbeat.ts) spreads the ADAPTER DEFAULT FIRST and the
# stored profile second, so any key we merely leave out is re-supplied as "low"
# at run time. That is why `absent` and `null` are asserted to be FAILURES here
# rather than passes -- a naive "no effort key present" assertion would go green
# on precisely the broken shape. Both lanes guard on TRUTHINESS, so "" is what
# suppresses the ACP option while leaving the CLI lane working.
#
# This runs fully offline: `pc` and `pcsql` are stubbed, so no database, API,
# credential or agent mutation is involved. It exercises the REAL create path
# in org_provisioner.sh and captures the payload actually sent.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROV="${PROV:-$HERE/org_provisioner.sh}"
command -v jq >/dev/null || { echo "ERROR: jq required" >&2; exit 1; }
[[ -f "$PROV" ]] || { echo "ERROR: missing $PROV" >&2; exit 1; }

PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- stubs -----------------------------------------------------------------
# `pc` records the create payload and returns a plausible agent id. Every other
# subcommand is a no-op success, so the create path runs to completion.
mkdir -p "$WORK/bin"
cat >"$WORK/bin/paperclipai" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "agent" && "${2:-}" == "create" ]]; then
  for ((i=1; i<=$#; i++)); do
    if [[ "${!i}" == "--payload-json" ]]; then
      j=$((i+1)); printf '%s' "${!j}" >"$TOG689_PAYLOAD"
    fi
  done
  echo '{"id":"00000000-0000-4000-8000-000000000689"}'
  exit 0
fi
echo '{}'
STUB
chmod +x "$WORK/bin/paperclipai"

# `psql` stands in for the pcsql backend: lookup_agent returns one caller row,
# every other query returns nothing.
cat >"$WORK/bin/psql" <<'STUB'
#!/usr/bin/env bash
sql="$(cat)"
if [[ "$sql" == *"permissionProfile"* ]]; then
  printf '%s\t%s\t%s\n' "11111111-1111-4111-8111-111111111111" "P1_PRESIDENT_COO" "President & COO"
fi
exit 0
STUB
chmod +x "$WORK/bin/psql"

# Run the real `create` and echo the captured payload on stdout.
provision() {
  local payload_file="$WORK/payload.json"
  : >"$payload_file"
  PATH="$WORK/bin:$PATH" \
  TOG689_PAYLOAD="$payload_file" \
  COMPANY_ID="00000000-0000-4000-8000-000000000000" \
  PAPERCLIP_CLI="$WORK/bin/paperclipai" \
  PAPERCLIP_SQL_BACKEND="psql" \
  PGHOST="stub-offline" \
  ADAPTER_TYPE="${1:-claude_local}" \
    bash "$PROV" create --caller P1_PRESIDENT_COO --template B1_FUNCTION_CHIEF \
      --title "TOG-689 probe" >/dev/null 2>"$WORK/err.txt"
  cat "$payload_file"
}

cheap_of() { jq -c '.runtimeConfig.modelProfiles.cheap // null' <<<"$1"; }

printf '\n\033[1mTOG-689: a provisioned claude_local agent is born ACP-safe\033[0m\n'

PAYLOAD="$(provision claude_local)"
if [[ -z "$PAYLOAD" ]]; then
  bad "provisioner produced a create payload (stderr: $(tr '\n' ' ' <"$WORK/err.txt" | cut -c1-200))"
else
  ok "provisioner produced a create payload"

  CHEAP="$(cheap_of "$PAYLOAD")"
  # Distinguish "key present and empty" from "key missing". A `// "ABSENT"`
  # default would collapse exactly the two cases this suite must tell apart,
  # because jq's `//` fires on an empty string too.
  EFFORT="$(jq -r 'if ((.adapterConfig // {}) | has("effort"))
                   then (.adapterConfig.effort | tostring)
                   else "ABSENT" end' <<<"$CHEAP")"

  # The load-bearing assertion. `absent` is a FAILURE, not a pass: the adapter
  # default refills an omitted key with "low" at run time.
  case "$EFFORT" in
    "")     ok  "cheap.adapterConfig.effort is pinned to the empty string" ;;
    ABSENT) bad "effort is ABSENT -- the adapter default refills it with \"low\" at run time" ;;
    *)      bad "effort is '"'"'$EFFORT'"'"' -- any truthy value is fatal on the ACP lane" ;;
  esac

  # Guard the key exists rather than merely being falsy-by-absence.
  if jq -e 'has("adapterConfig") and (.adapterConfig|has("effort"))' <<<"$CHEAP" >/dev/null 2>&1; then
    ok "the effort key is explicitly present, not merely omitted"
  else
    bad "the effort key is not explicitly present"
  fi

  # The heartbeat block must survive: runtimeConfig is replaced WHOLESALE on
  # PATCH, and an earlier sweep clobbered a live agent's heartbeat this way.
  if jq -e '.runtimeConfig.heartbeat.enabled == false
            and .runtimeConfig.heartbeat.wakeOnDemand == false' <<<"$PAYLOAD" >/dev/null; then
    ok "the heartbeat block is preserved alongside the new modelProfiles block"
  else
    bad "the heartbeat block was lost: $(jq -c '.runtimeConfig.heartbeat' <<<"$PAYLOAD")"
  fi

  # Born disabled AND pinned. Disabled alone short-circuits before the merge and
  # is safe today, but is one `enabled:true` edit away from fatal; the pin makes
  # the agent safe in both positions.
  if jq -e '.enabled == false' <<<"$CHEAP" >/dev/null; then
    ok "the cheap profile is born disabled (safe even before the merge is reached)"
  else
    bad "the cheap profile is not born disabled: $CHEAP"
  fi

  # Invariants that predate this change and must not regress.
  #
  # The assignment mode expectation was INVERTED by the TOG-984 owner decision
  # (2026-09-05): agents are now born `company_default` with canAssignTasks
  # true, because the old born-protected posture made an agent's first hand-back
  # up its own chain fail with 403 deny_policy_restricted (TOG-54/69/586).
  # `canCreateAgents == false` is untouched by that decision and still holds —
  # the creator ceiling is a separate invariant from the assignment baseline.
  if jq -e '.permissions.canCreateAgents == false
            and .permissions.canAssignTasks == true
            and .permissions.authorizationPolicy.assignmentPolicy.mode == "company_default"' \
       <<<"$PAYLOAD" >/dev/null; then
    ok "provisioning invariants hold: creator ceiling off, TOG-984 assignment baseline on"
  else
    bad "provisioning invariants regressed: $(jq -c '.permissions' <<<"$PAYLOAD")"
  fi
fi

printf '\n\033[1mAdapters are opted in explicitly, never by default\033[0m\n'
OTHER="$(provision codex_local)"
if [[ -z "$OTHER" ]]; then
  bad "provisioner produced a payload for a non-claude_local adapter"
elif jq -e '.runtimeConfig | has("modelProfiles") | not' <<<"$OTHER" >/dev/null; then
  ok "a non-claude_local adapter gets no invented cheap profile"
else
  bad "a cheap profile was invented for an adapter that may not declare one: \
$(jq -c '.runtimeConfig.modelProfiles' <<<"$OTHER")"
fi

printf '\n\033[1mRESULT: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
