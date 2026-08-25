#!/usr/bin/env bash
# Offline regression suite for org_provisioner.sh's pure create-policy gate.
# No database, API, credential or agent mutation is involved.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v jq >/dev/null || { echo "ERROR: jq required" >&2; exit 1; }
# shellcheck source=lib/provisioning_policy.sh
. "$HERE/lib/provisioning_policy.sh" || { echo "ERROR: missing provisioning policy" >&2; exit 1; }

extract_catalog() { sed -n "/^$1='{/,/^}'\$/p" "$HERE/org_provisioner.sh"; }
eval "$(extract_catalog CEILING_JSON)"
eval "$(extract_catalog TEMPLATES_JSON)"
[[ -n "${CEILING_JSON:-}" && -n "${TEMPLATES_JSON:-}" ]] \
  || { echo "ERROR: could not extract provisioner catalogs" >&2; exit 1; }

PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }

allows() {
  local desc="$1" caller="$2" requested="$3" ceiling="${4:-$CEILING_JSON}"
  if create_policy_check "$caller" "$requested" "$ceiling" "$TEMPLATES_JSON"; then ok "$desc"
  else bad "$desc — refused as $CREATE_POLICY_REASON: $CREATE_POLICY_MESSAGE"; fi
}

refuses_because() {
  local desc="$1" reason="$2" message="$3" caller="$4" requested="$5" ceiling="${6:-$CEILING_JSON}" templates="${7:-$TEMPLATES_JSON}"
  if create_policy_check "$caller" "$requested" "$ceiling" "$templates"; then
    bad "$desc — was allowed"
  elif [[ "$CREATE_POLICY_REASON" != "$reason" ]]; then
    bad "$desc — wrong gate: got '$CREATE_POLICY_REASON', wanted '$reason'"
  elif [[ "$CREATE_POLICY_MESSAGE" != *"$message"* ]]; then
    bad "$desc — wrong message: '$CREATE_POLICY_MESSAGE'"
  else ok "$desc"; fi
}

printf '\n\033[1m1. The production ceiling still decides ordinary creation\033[0m\n'
allows "P1 may seat a functional chief" P1_PRESIDENT_COO B1_FUNCTION_CHIEF
allows "a manager may create a specialist" D1_MANAGER E0_SPECIALIST
refuses_because "a manager may not create a director" template_above_ceiling \
  "exceeds the delegation ceiling" D1_MANAGER C1_DIRECTOR_BUILDER

printf '\n\033[1m2. Widening the ceiling reaches the independent chief-seat gate\033[0m\n'
WIDE_CHIEF="$(jq -c '.B2_TECH_CHIEF += ["B4_FINANCE_CHIEF"]' <<<"$CEILING_JSON")"
refuses_because "a non-P1 chief still cannot seat another functional chief" \
  chief_seating_reserved "only P1_PRESIDENT_COO may seat a functional chief" \
  B2_TECH_CHIEF B4_FINANCE_CHIEF "$WIDE_CHIEF"

printf '\n\033[1m3. Widening both catalogs reaches the enterprise-role gate\033[0m\n'
WIDE_ENTERPRISE="$(jq -c '.P1_PRESIDENT_COO += ["P0_OWNER","P1_PRESIDENT_COO"]' <<<"$CEILING_JSON")"
WIDE_TEMPLATES="$(jq -c '.P0_OWNER = [] | .P1_PRESIDENT_COO = []' <<<"$TEMPLATES_JSON")"
refuses_because "even P1 cannot provision another enterprise operator" \
  enterprise_role_unprovisionable "owner and enterprise-operator roles are never provisionable" \
  P1_PRESIDENT_COO P1_PRESIDENT_COO "$WIDE_ENTERPRISE" "$WIDE_TEMPLATES"
refuses_because "even P1 cannot provision the owner role" \
  enterprise_role_unprovisionable "owner and enterprise-operator roles are never provisionable" \
  P1_PRESIDENT_COO P0_OWNER "$WIDE_ENTERPRISE" "$WIDE_TEMPLATES"

printf '\n\033[1m4. Unknown templates remain a separate fail-closed gate\033[0m\n'
WIDE_UNKNOWN="$(jq -c '.D1_MANAGER += ["Z9_NOT_A_TEMPLATE"]' <<<"$CEILING_JSON")"
refuses_because "a ceiling entry cannot make an unknown template provisionable" \
  unknown_template "unknown role template" D1_MANAGER Z9_NOT_A_TEMPLATE "$WIDE_UNKNOWN"

printf '\n\033[1mRESULT: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
