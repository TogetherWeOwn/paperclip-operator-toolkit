#!/usr/bin/env bash
set -uo pipefail

# ===========================================================================
# GitHub access provisioning — the "second key" (report section 9)
# ---------------------------------------------------------------------------
# Paperclip RBAC never implies external access. A chief with tasks:assign_scope
# has no GitHub rights; an engineer with zero governance grants may hold them.
# This script manages that second key for GitHub specifically.
#
# HOW AN AGENT ACTUALLY GETS GITHUB
# ---------------------------------
# It never holds a token. Three company secrets are bound into the agent's run
# as environment variables:
#
#   env.GH_APP_ID           <- github_app_id
#   env.GH_APP_ORG          <- github_app_org
#   env.GH_APP_PRIVATE_KEY  <- github_app_private_key
#
# The instance-wide git credential helper (gh-app-token.js under the server
# container's .local/bin, already wired into the container's .gitconfig; see
# GH_APP_TOKEN_HELPER below) reads those and mints a fresh installation token
# per call, cached only for the run and expiring in an hour.
# Nothing durable is written, and revoking the binding revokes the access.
#
# ELIGIBILITY (two-key model)
# ---------------------------
# GitHub is an engineering resource. Eligible principals:
#   * O1  — enterprise operator
#   * T0  — CTO, and any agent inside T0's reporting subtree
# Everyone else is refused by default, including chiefs who outrank engineers.
# Finance, Marketing, Legal, Audit and the Chief of Staff have no code access.
#
# WHO MAY GRANT
# -------------
# The caller must hold company-wide agents:configure (O1), or be a strict
# ancestor of the target. A manager equips its own engineers; it cannot equip
# a peer's team, and it cannot equip itself.
#
#   ./gh_access.sh policy
#   ./gh_access.sh matrix
#   ./gh_access.sh grant  --caller <ROLE> --to <ROLE>
#   ./gh_access.sh revoke --caller <ROLE> --to <ROLE>
#   ./gh_access.sh show   <ROLE>
#   ./gh_access.sh verify <ROLE>      # prove the helper can mint for that agent
# ===========================================================================

COMPANY_ID="${COMPANY_ID:?Set COMPANY_ID}"
PAPERCLIP_DB_CTR="${PAPERCLIP_DB_CTR:-paperclip-db}"
PAPERCLIP_SERVER_CTR="${PAPERCLIP_SERVER_CTR:-paperclip}"
# Path of the git credential helper INSIDE the server container. When empty it
# resolves, in the container's own shell, to ${PAPERCLIP_HOME:-$HOME}/.local/bin/gh-app-token.js.
GH_APP_TOKEN_HELPER="${GH_APP_TOKEN_HELPER:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACCESS_LOG="${ACCESS_LOG:-$HERE/external-access-log.jsonl}"

# shellcheck source=lib/pcsql.sh
. "$HERE/lib/pcsql.sh" || { echo "ERROR: missing $HERE/lib/pcsql.sh" >&2; exit 1; }

# secret key -> env var projected into the agent run
SECRET_MAP='github_app_id=GH_APP_ID github_app_org=GH_APP_ORG github_app_private_key=GH_APP_PRIVATE_KEY'

die() { echo "REFUSED: $*" >&2; exit 2; }
log() { printf '%s\n' "$1" >> "$ACCESS_LOG"; chmod 0600 "$ACCESS_LOG" 2>/dev/null || true; }

# Reaches PostgreSQL through lib/pcsql.sh rather than one hard-wired container,
# so this tool can be pointed at a throwaway database. The
# flags and the :cid/:a/:b bindings are the ones this tool always used and the
# podman command pcsql_run builds is the one that was here; only the choice of
# transport moved. ON_ERROR_STOP stays ON, as it was.
sql() { PGV_COMPANY_ID="$COMPANY_ID" PGV_A="${1:-}" PGV_B="${2:-}" \
        pcsql_run -Atq -F'|' -v ON_ERROR_STOP=1 <<<"$3"; }

agent_row() { # -> "<id>|<template>|<title>"
  sql "$1" "" "SELECT a.id::text || '|' || COALESCE(a.metadata->>'permissionProfile','') || '|' || a.title
               FROM agents a WHERE a.company_id=:'cid'::uuid AND a.status<>'terminated'
                 AND (a.metadata->>'orgRoleId'=:'a' OR a.id::text=:'a') ORDER BY a.created_at LIMIT 1;"
}

role_of() { sql "$1" "" "SELECT COALESCE(a.metadata->>'orgRoleId', a.title) FROM agents a
                         WHERE a.company_id=:'cid'::uuid AND a.id::text=:'a';"; }

is_strict_ancestor() {
  [[ "$(sql "$1" "$2" "
    WITH RECURSIVE sub AS (
      SELECT id FROM agents WHERE company_id=:'cid'::uuid AND id=:'a'::uuid
      UNION ALL SELECT c.id FROM agents c JOIN sub s ON c.reports_to=s.id WHERE c.company_id=:'cid'::uuid
    ) SELECT EXISTS(SELECT 1 FROM sub WHERE id=:'b'::uuid AND id<>:'a'::uuid);")" == "t" ]]
}

# Eligible = O1 itself, or T0 / anything inside T0's subtree.
is_eligible() {
  local id="$1"
  [[ "$(sql "$id" "" "SELECT CASE WHEN a.metadata->>'orgRoleId'='O1' THEN 'yes' ELSE 'no' END
                      FROM agents a WHERE a.company_id=:'cid'::uuid AND a.id::text=:'a';")" == "yes" ]] && return 0
  local t0; t0="$(sql "" "" "SELECT id::text FROM agents WHERE company_id=:'cid'::uuid AND metadata->>'orgRoleId'='T0';")"
  [[ -n "$t0" ]] || return 1
  [[ "$id" == "$t0" ]] && return 0
  is_strict_ancestor "$t0" "$id"
}

has_companywide_configure() {
  [[ "$(sql "$1" "" "SELECT count(*) FROM principal_permission_grants
                     WHERE company_id=:'cid'::uuid AND principal_type='agent' AND principal_id=:'a'
                       AND permission_key='agents:configure' AND scope IS NULL;")" -gt 0 ]]
}

secret_id_for() { sql "$1" "" "SELECT id::text FROM company_secrets
                               WHERE company_id=:'cid'::uuid AND key=:'a' AND status='active' LIMIT 1;"; }

cmd_grant() {
  local caller="" to="" revoke="${REVOKE:-0}"
  while [[ $# -gt 0 ]]; do case "$1" in
    --caller) caller="$2"; shift 2;; --to) to="$2"; shift 2;; *) die "unknown argument: $1";; esac; done
  [[ -n "$caller" && -n "$to" ]] || die "usage: --caller <ROLE> --to <ROLE>"

  local crow trow; crow="$(agent_row "$caller")"; trow="$(agent_row "$to")"
  [[ -n "$crow" ]] || die "caller not found: $caller"
  [[ -n "$trow" ]] || die "target not found: $to"
  local cid ctpl tid ttpl
  cid="$(cut -d'|' -f1 <<<"$crow")"; ctpl="$(cut -d'|' -f2 <<<"$crow")"
  tid="$(cut -d'|' -f1 <<<"$trow")"; ttpl="$(cut -d'|' -f2 <<<"$trow")"

  # 1. Delegation: company-wide configure, or strict ancestry. Never self-grant.
  if ! has_companywide_configure "$cid"; then
    [[ "$cid" != "$tid" ]] || die "$caller cannot grant external access to itself."
    is_strict_ancestor "$cid" "$tid" \
      || { log "$(jq -cn --arg c "$caller" --arg t "$to" '{event:"github.refused",reason:"target_outside_subtree",caller:$c,target:$t}')"
           die "$to is not inside $caller's reporting subtree."; }
  fi

  # 2. Two-key eligibility, checked even for O1's targets.
  if [[ "$revoke" != "1" ]] && ! is_eligible "$tid"; then
    log "$(jq -cn --arg c "$caller" --arg t "$to" --arg tt "$ttpl" \
      '{event:"github.refused",reason:"not_eligible_for_code_access",caller:$c,target:$t,targetTemplate:$tt}')"
    echo "  GitHub is an engineering resource. Eligible: O1, T0, and T0's subtree." >&2
    die "$to [$ttpl] is not eligible for code access under the two-key model."
  fi

  local n=0
  for pair in $SECRET_MAP; do
    local key="${pair%%=*}" var="${pair#*=}" sid
    sid="$(secret_id_for "$key")"; [[ -n "$sid" ]] || die "secret '$key' not found in this company."
    if [[ "$revoke" == "1" ]]; then
      sql "$sid" "$tid" "DELETE FROM company_secret_bindings
                         WHERE company_id=:'cid'::uuid AND secret_id=:'a'::uuid
                           AND target_type='agent' AND target_id=:'b';" >/dev/null
    else
      # Mirrors the shape the server's own createBinding writes.
      sql "$sid" "$tid" "INSERT INTO company_secret_bindings
          (company_id, secret_id, target_type, target_id, config_path,
           version_selector, required, projection_class)
        VALUES (:'cid'::uuid, :'a'::uuid, 'agent', :'b', 'env.${var}',
                'latest', true, 'unclassified')
        ON CONFLICT DO NOTHING;" >/dev/null
    fi
    n=$((n+1))
  done

  log "$(jq -cn --arg c "$caller" --arg ct "$ctpl" --arg t "$to" --arg tt "$ttpl" \
    --arg a "$([[ "$revoke" == "1" ]] && echo revoked || echo granted)" \
    '{event:"github.access",action:$a,caller:$c,callerTemplate:$ct,target:$t,targetTemplate:$tt,
      projected:["GH_APP_ID","GH_APP_ORG","GH_APP_PRIVATE_KEY"]}')"
  [[ "$revoke" == "1" ]] && echo "REVOKED GitHub access from $to [$ttpl] (by $caller)" \
                         || echo "GRANTED GitHub access to $to [$ttpl] (by $caller [$ctpl]) — $n env bindings"
}

cmd_show() {
  local row; row="$(agent_row "${1:?role}")"; [[ -n "$row" ]] || die "agent not found: $1"
  local id title; id="$(cut -d'|' -f1 <<<"$row")"; title="$(cut -d'|' -f3 <<<"$row")"
  echo "$title"
  local b; b="$(sql "$id" "" "SELECT b.config_path || '  <- ' || s.key
                              FROM company_secret_bindings b JOIN company_secrets s ON s.id=b.secret_id
                              WHERE b.company_id=:'cid'::uuid AND b.target_type='agent' AND b.target_id=:'a'
                              ORDER BY b.config_path;")"
  [[ -n "$b" ]] && sed 's/^/  /' <<<"$b" || echo "  (no external credentials bound)"
}

cmd_matrix() {
  sql "" "" "
  SELECT COALESCE(a.metadata->>'orgRoleId','·') || '|' || a.title || '|' ||
         CASE WHEN EXISTS (SELECT 1 FROM company_secret_bindings b
                            WHERE b.company_id=a.company_id AND b.target_type='agent'
                              AND b.target_id=a.id::text AND b.config_path='env.GH_APP_PRIVATE_KEY')
              THEN 'GitHub' ELSE '—' END
  FROM agents a WHERE a.company_id=:'cid'::uuid AND a.status<>'terminated'
  ORDER BY 1;" | { printf 'ROLE|TITLE|EXTERNAL ACCESS\n'; cat; } | column -t -s'|'
}

cmd_verify() {
  local row; row="$(agent_row "${1:?role}")"; [[ -n "$row" ]] || die "agent not found: $1"
  local id; id="$(cut -d'|' -f1 <<<"$row")"
  local bound; bound="$(sql "$id" "" "SELECT count(*) FROM company_secret_bindings
                                       WHERE company_id=:'cid'::uuid AND target_type='agent' AND target_id=:'a'
                                         AND config_path IN ('env.GH_APP_ID','env.GH_APP_ORG','env.GH_APP_PRIVATE_KEY');")"
  echo "  bindings present: $bound/3"
  [[ "$bound" == "3" ]] || { echo "  -> not fully provisioned"; return 1; }
  echo "  credential helper: $(podman exec "$PAPERCLIP_SERVER_CTR" sh -c 'test -x "${1:-${PAPERCLIP_HOME:-$HOME}/.local/bin/gh-app-token.js}"' sh "$GH_APP_TOKEN_HELPER" && echo present || echo MISSING)"
  echo "  (the helper mints a fresh installation token per git call at run time)"
}

case "${1:-}" in
  grant)  shift; REVOKE=0 cmd_grant "$@" ;;
  revoke) shift; REVOKE=1 cmd_grant "$@" ;;
  show)   shift; cmd_show "$@" ;;
  matrix) cmd_matrix ;;
  verify) shift; cmd_verify "$@" ;;
  policy) sed -n '/^# ELIGIBILITY/,/^# WHO MAY GRANT/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  log)    [[ -f "$ACCESS_LOG" ]] && cat "$ACCESS_LOG" || echo "(no access log yet)" ;;
  *) sed -n '/^#   \.\/gh_access/,/^# ====/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' | head -n -1 ;;
esac
