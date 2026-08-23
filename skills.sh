#!/usr/bin/env bash
set -uo pipefail

# ===========================================================================
# Role-aware skill provisioning
# ---------------------------------------------------------------------------
# Paperclip already has a full skill engine: a bundled catalog, import from
# local paths / GitHub / skills.sh / URLs, versioning, byte auditing, test
# inputs, and per-agent attachment. This script does NOT reimplement any of
# that. It adds the one thing the operating model needs and the server cannot
# express: WHO may give WHICH skill to WHOM.
#
# AUTHORITY MODEL (report sections 4, 6, 8)
# -----------------------------------------
#   skills:create          -> may install/import/create/edit COMPANY skills.
#                             Held by O1 (P1_PRESIDENT_COO) and T0 (B2_TECH_CHIEF).
#   skills:suggest-changes -> may only PROPOSE. Proposals are logged for review,
#                             never applied. Held by most chiefs and reviewers.
#   attach to an agent     -> the caller must be a STRICT ANCESTOR of the target
#                             in the reporting tree, or hold company-wide
#                             agents:configure (O1). A manager equips its own
#                             specialists; it can never equip a peer, its own
#                             manager, or another function's team.
#
# WHY THIS IS ENFORCED HERE RATHER THAN BY PAPERCLIP
# --------------------------------------------------
# `POST /agents/:id/skills/sync` is gated by agent_config:update, which resolves
# `agents:configure`. On this build that decision is made WITHOUT a target-agent
# scope, so a subtree-scoped `agents:configure` grant evaluates to deny (it
# fails closed). Chiefs therefore cannot equip their own teams through the API
# even though the operating model says they should. This script is the
# compensating control: it runs as the board operator and enforces the subtree
# rule in software, exactly as org_provisioner.sh does for agent creation.
#
# No autonomous agent can invoke this script, and none holds skills:create
# beyond what the report grants.
#
# USAGE
#   ./skills.sh catalog                      # browse app-shipped catalog
#   ./skills.sh search <query>
#   ./skills.sh library                      # skills installed in this company
#   ./skills.sh inspect <catalogRef>
#   ./skills.sh audit <skillRef>             # byte audit, does not execute
#   ./skills.sh install <catalogRef> --caller <ROLE>
#   ./skills.sh import  <source>     --caller <ROLE>   # path | GitHub | skills.sh | URL
#   ./skills.sh create  --caller <ROLE> --slug <s> --name <n> --file <markdown>
#   ./skills.sh edit    <skillRef> --caller <ROLE> --path <file> --content <file>
#   ./skills.sh grant   <skillRef> --caller <ROLE> --to <ROLE>
#   ./skills.sh revoke  <skillRef> --caller <ROLE> --to <ROLE>
#   ./skills.sh show    <ROLE>               # what an agent is equipped with
#   ./skills.sh matrix                       # whole-org skill matrix
#   ./skills.sh propose <skillRef> --caller <ROLE> --to <ROLE> --note "..."
#
# Kill switch: .provisioner-disabled (shared with org_provisioner.sh).
# ===========================================================================

COMPANY_ID="${COMPANY_ID:?Set COMPANY_ID}"
PAPERCLIP_API_URL="${PAPERCLIP_API_URL:-http://127.0.0.1:3100}"
PAPERCLIP_DB_CTR="${PAPERCLIP_DB_CTR:-paperclip-db}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_LOG="${SKILL_LOG:-$HERE/skill-grant-log.jsonl}"

command -v jq >/dev/null || { echo "ERROR: jq required" >&2; exit 1; }
resolve_cli() {
  [[ -n "${PAPERCLIP_CLI:-}" ]] && { echo "$PAPERCLIP_CLI"; return; }
  command -v paperclipai >/dev/null 2>&1 && { command -v paperclipai; return; }
  find "$HOME/.npm/_npx" -maxdepth 4 -path '*/node_modules/.bin/paperclipai' 2>/dev/null | head -1
}
PC_CLI="$(resolve_cli)"; [[ -n "$PC_CLI" ]] || { echo "ERROR: no paperclipai CLI" >&2; exit 1; }
pc() { "$PC_CLI" "$@" --api-base "$PAPERCLIP_API_URL"; }

die() { echo "REFUSED: $*" >&2; exit 2; }
log() { printf '%s\n' "$1" >> "$SKILL_LOG"; chmod 0600 "$SKILL_LOG" 2>/dev/null || true; }

assert_enabled() {
  [[ -f "$HERE/.provisioner-disabled" || "${PROVISIONER_DISABLED:-0}" == "1" ]] \
    && die "kill switch engaged (owner/board control)."
  return 0
}

sql() { podman exec -i -e C="$COMPANY_ID" -e A="${1:-}" -e B="${2:-}" "$PAPERCLIP_DB_CTR" sh -c \
        'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atq -F"|" -v cid="$C" -v a="$A" -v b="$B" -f -' <<<"$3"; }

# "<id>\t<template>\t<title>" for a role id or uuid
agent_row() {
  sql "$1" "" "SELECT a.id::text || E'\t' || COALESCE(a.metadata->>'permissionProfile','') || E'\t' || a.title
              FROM agents a WHERE a.company_id=:'cid'::uuid AND a.status<>'terminated'
                AND (a.metadata->>'orgRoleId'=:'a' OR a.id::text=:'a') ORDER BY a.created_at LIMIT 1;"
}

has_grant() { # has_grant <agentId> <permissionKey> -> prints 'company-wide' | 'scoped' | ''
  sql "$1" "$2" "SELECT CASE WHEN scope IS NULL THEN 'company-wide' ELSE 'scoped' END
                 FROM principal_permission_grants
                 WHERE company_id=:'cid'::uuid AND principal_type='agent'
                   AND principal_id=:'a' AND permission_key=:'b' LIMIT 1;"
}

is_strict_ancestor() { # is_strict_ancestor <ancestorId> <descendantId>
  [[ "$(sql "$1" "$2" "
    WITH RECURSIVE sub AS (
      SELECT id FROM agents WHERE company_id=:'cid'::uuid AND id=:'a'::uuid
      UNION ALL
      SELECT c.id FROM agents c JOIN sub s ON c.reports_to=s.id WHERE c.company_id=:'cid'::uuid
    ) SELECT EXISTS(SELECT 1 FROM sub WHERE id=:'b'::uuid AND id<>:'a'::uuid);")" == "t" ]]
}

skill_row() { # -> "<id>\t<slug>\t<name>"
  sql "$1" "" "SELECT id::text || E'\t' || slug || E'\t' || name FROM company_skills
               WHERE company_id=:'cid'::uuid AND (slug=:'a' OR key=:'a' OR id::text=:'a') LIMIT 1;"
}

require_author() { # require_author <callerId> <callerTemplate> <callerLabel> <action>
  local id="$1" tpl="$2" label="$3" what="$4"
  if [[ -n "$(has_grant "$id" 'skills:create')" ]]; then return 0; fi
  if [[ -n "$(has_grant "$id" 'skills:suggest-changes')" ]]; then
    log "$(jq -cn --arg c "$label" --arg t "$tpl" --arg w "$what" \
      '{event:"skill.refused",reason:"suggest_only",caller:$c,callerTemplate:$t,action:$w}')"
    echo "  $label [$tpl] holds skills:suggest-changes, not skills:create." >&2
    echo "  Use: ./skills.sh propose ... --caller $label   (proposals are logged for review)" >&2
    die "$label may propose skill changes but not apply them."
  fi
  die "$label [$tpl] holds no skill authority at all."
}

# --------------------------------------------------------------------------
cmd_install_or_import() {
  local mode="$1" ref="$2"; shift 2
  local caller="" as=""
  while [[ $# -gt 0 ]]; do case "$1" in
    --caller) caller="$2"; shift 2;; --as) as="$2"; shift 2;; *) die "unknown argument: $1";; esac; done
  [[ -n "$caller" && -n "$ref" ]] || die "usage: $mode <ref> --caller <ROLE>"
  assert_enabled
  local row; row="$(agent_row "$caller")"; [[ -n "$row" ]] || die "caller not found: $caller"
  local cid ctpl; cid="$(cut -f1 <<<"$row")"; ctpl="$(cut -f2 <<<"$row")"
  require_author "$cid" "$ctpl" "$caller" "$mode:$ref"

  local out rc
  if [[ "$mode" == "install" ]]; then
    out="$(pc skills install "$ref" --company-id "$COMPANY_ID" ${as:+--as "$as"} --json 2>&1)"; rc=$?
  else
    out="$(pc skills import "$ref" --company-id "$COMPANY_ID" --json 2>&1)"; rc=$?
  fi
  [[ $rc -eq 0 ]] || { echo "$out" >&2; die "$mode failed"; }
  log "$(jq -cn --arg c "$caller" --arg t "$ctpl" --arg m "$mode" --arg r "$ref" \
    '{event:"skill.library_changed",action:$m,ref:$r,caller:$c,callerTemplate:$t}')"
  echo "$mode OK: $ref (by $caller [$ctpl])"
  echo "  NOTE: the skill is now in the company library but attached to NO agent."
  echo "  Equip a team with: ./skills.sh grant <slug> --caller <ROLE> --to <ROLE>"
}

cmd_grant() {
  local skill="$1"; shift
  local caller="" to="" mode="add"
  while [[ $# -gt 0 ]]; do case "$1" in
    --caller) caller="$2"; shift 2;; --to) to="$2"; shift 2;;
    --revoke) mode="remove"; shift;; *) die "unknown argument: $1";; esac; done
  [[ -n "$caller" && -n "$to" ]] || die "usage: grant <skillRef> --caller <ROLE> --to <ROLE>"
  assert_enabled

  local srow; srow="$(skill_row "$skill")"; [[ -n "$srow" ]] || die "skill not in company library: $skill"
  local sslug; sslug="$(cut -f2 <<<"$srow")"

  local crow trow; crow="$(agent_row "$caller")"; trow="$(agent_row "$to")"
  [[ -n "$crow" ]] || die "caller not found: $caller"
  [[ -n "$trow" ]] || die "target not found: $to"
  local cid ctpl tid ttpl; cid="$(cut -f1 <<<"$crow")"; ctpl="$(cut -f2 <<<"$crow")"
  tid="$(cut -f1 <<<"$trow")"; ttpl="$(cut -f2 <<<"$trow")"

  # Authority: company-wide agents:configure, or strict ancestry.
  local scope; scope="$(has_grant "$cid" 'agents:configure')"
  if [[ "$scope" != "company-wide" ]]; then
    [[ -n "$scope" ]] || die "$caller [$ctpl] holds no agents:configure and cannot equip agents."
    if ! is_strict_ancestor "$cid" "$tid"; then
      log "$(jq -cn --arg c "$caller" --arg t "$to" --arg s "$sslug" \
        '{event:"skill.refused",reason:"target_outside_subtree",caller:$c,target:$t,skill:$s}')"
      die "$to is not inside $caller's reporting subtree — a leader may only equip its own descendants."
    fi
  fi

  local out rc
  out="$(pc agent skills:sync "$tid" --desired-skills "$sslug" --mode "$mode" --json 2>&1)"; rc=$?
  [[ $rc -eq 0 ]] || { echo "$out" >&2; die "skill sync failed"; }
  log "$(jq -cn --arg c "$caller" --arg ct "$ctpl" --arg t "$to" --arg tt "$ttpl" \
    --arg s "$sslug" --arg m "$mode" \
    '{event:"skill.attached",mode:$m,skill:$s,caller:$c,callerTemplate:$ct,target:$t,targetTemplate:$tt}')"
  [[ "$mode" == "add" ]] && echo "EQUIPPED $to [$ttpl] with '$sslug' (by $caller [$ctpl])" \
                         || echo "REMOVED '$sslug' from $to [$ttpl] (by $caller [$ctpl])"
}

cmd_propose() {
  local skill="$1"; shift
  local caller="" to="" note=""
  while [[ $# -gt 0 ]]; do case "$1" in
    --caller) caller="$2"; shift 2;; --to) to="$2"; shift 2;; --note) note="$2"; shift 2;; *) die "unknown argument: $1";; esac; done
  [[ -n "$caller" ]] || die "usage: propose <skillRef> --caller <ROLE> [--to <ROLE>] --note '...'"
  local row; row="$(agent_row "$caller")"; [[ -n "$row" ]] || die "caller not found"
  local cid ctpl; cid="$(cut -f1 <<<"$row")"; ctpl="$(cut -f2 <<<"$row")"
  [[ -n "$(has_grant "$cid" 'skills:suggest-changes')$(has_grant "$cid" 'skills:create')" ]] \
    || die "$caller [$ctpl] holds no skill authority."
  log "$(jq -cn --arg c "$caller" --arg t "$ctpl" --arg s "$skill" --arg to "$to" --arg n "$note" \
    '{event:"skill.proposed",skill:$s,caller:$c,callerTemplate:$t,target:$to,note:$n}')"
  echo "PROPOSED '$skill'${to:+ for $to} by $caller [$ctpl] — logged for review, not applied."
}

cmd_show() {
  local row; row="$(agent_row "${1:?agent ref}")"; [[ -n "$row" ]] || die "agent not found: $1"
  local id title; id="$(cut -f1 <<<"$row")"; title="$(cut -f3 <<<"$row")"
  echo "$title"
  # The API returns `desiredSkills` (what the agent is equipped with) alongside
  # `entries` (everything in the company library, each flagged .desired).
  pc agent skills "$id" --json 2>/dev/null | jq -r '
      (.desiredSkills // []) as $on
      | if ($on | length) == 0 then "  equipped: (none)"
        else "  equipped:", ($on[] | "    - " + (. | split("/") | last))
        end,
        "  available in library but not equipped:",
        (((.entries // []) | map(select(.desired != true) | .key | split("/") | last))
         | if length == 0 then "    (none)" else .[] | "    - " + . end)'
}

cmd_matrix() {
  sql "" "" "
  SELECT COALESCE(a.metadata->>'orgRoleId','·') || '|' ||
         COALESCE(a.metadata->>'permissionProfile','(built-in)') || '|' ||
         a.title || '|' ||
         CASE WHEN COUNT(g.permission_key) FILTER (WHERE g.permission_key='skills:create')>0 THEN 'author'
              WHEN COUNT(g.permission_key) FILTER (WHERE g.permission_key='skills:suggest-changes')>0 THEN 'propose'
              ELSE 'none' END
  FROM agents a
  LEFT JOIN principal_permission_grants g
    ON g.company_id=a.company_id AND g.principal_type='agent' AND g.principal_id=a.id::text
  WHERE a.company_id=:'cid'::uuid AND a.status<>'terminated'
  GROUP BY a.id, a.metadata, a.title ORDER BY 1;" \
  | { printf 'ROLE|TEMPLATE|TITLE|SKILL AUTHORITY\n'; cat; } | column -t -s'|'
}

case "${1:-}" in
  catalog) pc skills browse --company-id "$COMPANY_ID" --json 2>/dev/null | jq -r 'if type=="array" then .[] else . end | "  " + (.ref // .slug // .name // "?") + "  —  " + (.description // .tagline // "")' ;;
  search)  shift; pc skills search "${1:?query}" --company-id "$COMPANY_ID" --json 2>/dev/null | jq -r '.[]? | "  " + (.ref // .slug // .name)' ;;
  inspect) shift; pc skills inspect "${1:?ref}" --company-id "$COMPANY_ID" --json 2>/dev/null | jq . ;;
  library) sql "" "" "SELECT slug || '|' || name || '|' || source_type || '|' || trust_level FROM company_skills WHERE company_id=:'cid'::uuid ORDER BY slug;" \
             | { printf 'SLUG|NAME|SOURCE|TRUST\n'; cat; } | column -t -s'|' ;;
  audit)   shift; pc skill get "${1:?ref}" --company-id "$COMPANY_ID" --json 2>/dev/null | jq -c '{slug,trustLevel,fileInventory}' ;;
  install) shift; cmd_install_or_import install "$@" ;;
  import)  shift; cmd_install_or_import import  "$@" ;;
  grant)   shift; cmd_grant "$@" ;;
  revoke)  shift; s="$1"; shift; cmd_grant "$s" "$@" --revoke ;;
  propose) shift; cmd_propose "$@" ;;
  show)    shift; cmd_show "$@" ;;
  matrix)  cmd_matrix ;;
  log)     [[ -f "$SKILL_LOG" ]] && cat "$SKILL_LOG" || echo "(no skill log yet)" ;;
  *) sed -n '/^# USAGE/,/^# ====/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' | head -n -1 ;;
esac
