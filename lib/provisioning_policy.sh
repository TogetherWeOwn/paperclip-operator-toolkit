#!/usr/bin/env bash
# Pure create-policy gate chain for org_provisioner.sh.
#
# Production passes the provisioner's literal catalogs. Tests may pass a widened
# ceiling directly to this function without creating an environment override on
# the mutating CLI itself.

create_policy_check() {
  local caller_template="$1" template="$2" ceiling_json="$3" templates_json="$4"

  CREATE_POLICY_REASON=""
  CREATE_POLICY_MESSAGE=""
  CREATE_POLICY_ALLOWED="$(jq -r --arg t "$caller_template" '.[$t] // [] | join(" ")' <<<"$ceiling_json")"

  if ! jq -e --arg c "$caller_template" --arg r "$template" \
        '(.[$c] // []) | index($r) != null' <<<"$ceiling_json" >/dev/null; then
    CREATE_POLICY_REASON="template_above_ceiling"
    CREATE_POLICY_MESSAGE="template '$template' exceeds the delegation ceiling of '$caller_template'."
    return 1
  fi

  if ! jq -e --arg t "$template" 'has($t)' <<<"$templates_json" >/dev/null; then
    CREATE_POLICY_REASON="unknown_template"
    CREATE_POLICY_MESSAGE="unknown role template: $template"
    return 1
  fi

  # Defence in depth: these assertions intentionally remain independent of the
  # catalogs. If both catalogs are widened, the widened path must still stop.
  if [[ "$template" == B[1-5]_* && "$caller_template" != "P1_PRESIDENT_COO" ]]; then
    CREATE_POLICY_REASON="chief_seating_reserved"
    CREATE_POLICY_MESSAGE="only P1_PRESIDENT_COO may seat a functional chief (attempted by $caller_template)."
    return 1
  fi
  if [[ "$template" == P0_* || "$template" == P1_* ]]; then
    CREATE_POLICY_REASON="enterprise_role_unprovisionable"
    CREATE_POLICY_MESSAGE="owner and enterprise-operator roles are never provisionable."
    return 1
  fi

  return 0
}
