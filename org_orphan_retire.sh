#!/usr/bin/env bash
# ===========================================================================
# org_orphan_retire.sh — retire access rows left behind by TERMINATED agents
# ---------------------------------------------------------------------------
# TOG-994, follow-up to TOG-984. Three kinds of row outlive the agent they were
# written for, because they were created before org_provisioner.sh's
# cmd_deactivate did the right thing, or by a termination that never went
# through the provisioner at all:
#
#   grants       principal_permission_grants rows for a terminated principal
#                (org_access_review.sh check 7)
#   memberships  company_memberships still status='active' for one
#                (org_access_review.sh check 7)
#   bindings     company_secret_bindings whose holder is terminated, so the
#                binding projects into nothing (org_access_review.sh check 9)
#
# THIS IS HYGIENE, NOT AN ACTIVE EXPOSURE, AND SAYING SO PRECISELY MATTERS.
# A grant row is not a credential. It is authorization checked against an
# authenticated principal, and a terminated agent cannot authenticate, cannot be
# woken, and has no run to project a secret into. Measured on this company
# 2026-09-05: restricted to LIVE agents there were ZERO defects of all three
# kinds. So nothing here is a live privilege, and this tool is not an incident
# response — it removes noise that would hide a real orphan among 66 benign
# ones. Overstating that would be its own defect; the value is in the signal
# this restores, not in a leak it closes.
#
# THE REANIMATION CASE IS WHY IT IS WORTH DOING AT ALL. "Cannot be exercised
# today" is a statement about today. A status flip, a restore from backup, or a
# name collision (two companies share this database) would re-animate the
# principal WITH its old authority still attached, silently. Of the bindings,
# one holder carries the full GitHub App triple, and per the TOG-308 runbook
# GH_APP_PRIVATE_KEY mints a full-ceiling token directly, bypassing the
# credential helper's scope flags. That is the row whose blast radius on
# re-animation is materially larger than the rest, so --kind bindings can be run
# first and alone.
#
# ---------------------------------------------------------------------------
# SAFETY CONTRACT
#
#   1. DRY RUN IS THE DEFAULT. `--apply` is required for any write.
#   2. LIVE AGENTS ARE REFUSED, NOT SKIPPED. Every statement carries its own
#      `status = 'terminated'` predicate in the WHERE clause — the selection is
#      re-derived inside the same transaction that writes, so a plan built when
#      an agent was terminated cannot delete a row for an agent that has since
#      come back. A row whose holder is live is not silently passed over; the
#      run aborts.
#   3. TERMINATED IS REQUIRED, NOT MERELY ABSENT. A grant whose principal has NO
#      agent row at all is left alone and reported. `status='terminated'` is a
#      fact; a missing row is an unexplained absence, and deleting on the
#      strength of one would be deleting because we cannot see something.
#   4. THE COMPANY FILTER IS MANDATORY. Two companies share this PostgreSQL and
#      agent names collide across them (see pg_source.js). Every statement is
#      scoped to COMPANY_ID; there is no default.
#   5. EVERY WRITE IS ATTRIBUTED. Deletions are as attributable as grants —
#      arguably more so, since TOG-870's whole finding was that a write which
#      bypassed the API left no activity_log row and became unrecoverable. An
#      activity_log row naming the requesting agent is written INSIDE the same
#      transaction, so a retirement that commits without its attribution is
#      impossible rather than merely discouraged.
#   6. IT COUNTS WHAT IT CHANGED. Each statement reports its rowcount and the
#      run re-measures afterwards. A sweep that cannot say what it removed is
#      the silent-green failure this repo keeps finding.
#   7. THE UNDO PATH IS PRINTED BEFORE THE WRITE, not described afterwards.
#
# USAGE
#   COMPANY_ID=<uuid> ./org_orphan_retire.sh plan [--kind grants|memberships|bindings|all]
#   COMPANY_ID=<uuid> ./org_orphan_retire.sh apply --requested-by <AGENT_UUID> [--kind ...]
#
# Kill switch: `.provisioner-disabled` next to this script, or
# PROVISIONER_DISABLED=1, refuses every mutating operation — the same switch
# org_provisioner.sh honours, because this tool writes the same tables.
# ===========================================================================
set -uo pipefail

COMPANY_ID="${COMPANY_ID:?Set COMPANY_ID}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GRANT_LOG="${GRANT_LOG:-$HERE/provisioner-grant-log.jsonl}"

# shellcheck source=lib/pcsql.sh
. "$HERE/lib/pcsql.sh" || { echo "ERROR: missing $HERE/lib/pcsql.sh" >&2; exit 1; }

die() { echo "REFUSED: $*" >&2; exit 2; }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }
say() { printf '  %s\n' "$1"; }

for bin in jq "$(pcsql_required_bin)"; do
  command -v "$bin" >/dev/null 2>&1 || die "missing $bin"
done

MODE=""; KIND="all"; REQUESTED_BY=""
case "${1:-}" in
  plan|apply) MODE="$1"; shift ;;
  *) sed -n '/^# USAGE/,/^# Kill switch/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
while [[ $# -gt 0 ]]; do
  case "$1" in
    --kind) KIND="$2"; shift 2 ;;
    --requested-by) REQUESTED_BY="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
case "$KIND" in grants|memberships|bindings|all) ;; *) die "--kind must be grants, memberships, bindings, or all" ;; esac

if [[ "$MODE" == "apply" ]]; then
  if [[ -f "$HERE/.provisioner-disabled" || "${PROVISIONER_DISABLED:-0}" == "1" ]]; then
    die "provisioner kill switch is engaged (owner/board control)."
  fi
  # The requesting agent is REQUIRED with no default, for the reason
  # apply_exact_grants states: a default silently restores anonymous rows the
  # first time a call site forgets to pass one.
  [[ -n "$REQUESTED_BY" ]] || die "apply needs --requested-by <AGENT_UUID>: an unattributed retirement is unrecoverable (TOG-870)."
  [[ "$REQUESTED_BY" =~ ^[0-9a-fA-F-]{36}$ ]] || die "--requested-by must be an agent UUID"
fi

# A missing backend must never read as "nothing to retire".
if ! pcsql_preflight; then
  cat >&2 <<EOF

ERROR: org_orphan_retire.sh cannot reach the company database, so it did not run.
  An unreachable database would report zero orphans and exit clean.
    PAPERCLIP_SQL_BACKEND=podman (default) — podman + \${PAPERCLIP_DB_CTR:-paperclip-db}
    PAPERCLIP_SQL_BACKEND=psql             — psql + DATABASE_URL or libpq PG* vars
EOF
  exit 3
fi

SQL_FAILED_FILE="$(mktemp)"; trap 'rm -f "$SQL_FAILED_FILE"' EXIT
sql() {
  local out rc
  out="$(PGV_COMPANY_ID="$COMPANY_ID" PGV_A="${REQUESTED_BY:-}" pcsql_run -Atq -v ON_ERROR_STOP=1 -F'|' <<<"$1")"; rc=$?
  [[ $rc -eq 0 ]] || { printf x > "$SQL_FAILED_FILE"; return "$rc"; }
  printf '%s' "$out"
}
assert_sql_ok() { [[ ! -s "$SQL_FAILED_FILE" ]] || { echo "ERROR: a query failed; refusing to report a verdict." >&2; exit 3; }; }

# Same guard org_access_review.sh uses: a reachable but EMPTY or WRONG database
# makes every absence check green.
subject_count="$(sql "SELECT count(*) FROM agents WHERE company_id = :'cid'::uuid;")"; assert_sql_ok
[[ "$subject_count" =~ ^[1-9][0-9]*$ ]] \
  || die "no agents for company $COMPANY_ID; refusing to sweep an empty or wrong database."

echo "Orphan retirement — company $COMPANY_ID — mode=$MODE kind=$KIND — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "agents in company: $subject_count"

# ---------------------------------------------------------------------------
# The three predicates. Each names `status = 'terminated'` POSITIVELY via
# EXISTS. That is the difference between "the holder is terminated" and "no
# holder is visible", and safety rule 3 turns on it.
# ---------------------------------------------------------------------------
TERMINATED_HOLDER="EXISTS (SELECT 1 FROM agents a WHERE a.id::text = %s AND a.company_id = :'cid'::uuid AND a.status = 'terminated')"
p_terminated() { printf "$TERMINATED_HOLDER" "$1"; }

hdr "1. What is on the record now"
counts="$(sql "
SELECT
 (SELECT count(*) FROM principal_permission_grants g
   WHERE g.company_id = :'cid'::uuid AND g.principal_type='agent'
     AND $(p_terminated g.principal_id)),
 (SELECT count(DISTINCT g.principal_id) FROM principal_permission_grants g
   WHERE g.company_id = :'cid'::uuid AND g.principal_type='agent'
     AND $(p_terminated g.principal_id)),
 (SELECT count(*) FROM company_memberships m
   WHERE m.company_id = :'cid'::uuid AND m.principal_type='agent' AND m.status='active'
     AND $(p_terminated m.principal_id)),
 (SELECT count(*) FROM company_secret_bindings b
   WHERE b.company_id = :'cid'::uuid AND b.target_type='agent'
     AND $(p_terminated b.target_id));")"; assert_sql_ok
IFS='|' read -r N_GRANT_ROWS N_GRANT_PRINC N_MEMBERS N_BINDINGS <<<"$counts"
say "grant rows on terminated principals:      $N_GRANT_ROWS (across $N_GRANT_PRINC principals)"
say "active memberships on terminated agents:  $N_MEMBERS"
say "secret bindings on terminated holders:    $N_BINDINGS"

# ---------------------------------------------------------------------------
# Rule 3 in the negative: rows whose principal has NO agent row at all. These
# are NOT retired. Reported so the count is never mistaken for zero.
# ---------------------------------------------------------------------------
hdr "2. Rows this tool deliberately does NOT touch"
absent="$(sql "
SELECT
 (SELECT count(*) FROM principal_permission_grants g
   WHERE g.company_id = :'cid'::uuid AND g.principal_type='agent'
     AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id::text = g.principal_id)),
 (SELECT count(*) FROM company_memberships m
   WHERE m.company_id = :'cid'::uuid AND m.principal_type='agent' AND m.status='active'
     AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id::text = m.principal_id)),
 (SELECT count(*) FROM company_secret_bindings b
   WHERE b.company_id = :'cid'::uuid AND b.target_type='agent'
     AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id::text = b.target_id));")"; assert_sql_ok
IFS='|' read -r A_G A_M A_B <<<"$absent"
if [[ "$A_G" == "0" && "$A_M" == "0" && "$A_B" == "0" ]]; then
  say "none — every orphan row has a real agent row marked terminated"
else
  say "grants=$A_G memberships=$A_M bindings=$A_B whose principal has NO agent row."
  say "These are left in place ON PURPOSE: 'terminated' is a fact, a missing row is an"
  say "unexplained absence, and deleting on the strength of one is deleting because we"
  say "cannot see something. Investigate them by hand."
fi

hdr "3. The affected principals"
sql "
SELECT COALESCE(a.title,'(unknown)'), a.status,
       (SELECT count(*) FROM principal_permission_grants g
         WHERE g.company_id = :'cid'::uuid AND g.principal_type='agent' AND g.principal_id = a.id::text),
       (SELECT count(*) FROM company_memberships m
         WHERE m.company_id = :'cid'::uuid AND m.principal_type='agent' AND m.principal_id = a.id::text AND m.status='active'),
       (SELECT count(*) FROM company_secret_bindings b
         WHERE b.company_id = :'cid'::uuid AND b.target_type='agent' AND b.target_id = a.id::text)
FROM agents a
WHERE a.company_id = :'cid'::uuid AND a.status = 'terminated'
  AND ((SELECT count(*) FROM principal_permission_grants g
         WHERE g.company_id = :'cid'::uuid AND g.principal_type='agent' AND g.principal_id = a.id::text) > 0
    OR (SELECT count(*) FROM company_memberships m
         WHERE m.company_id = :'cid'::uuid AND m.principal_type='agent' AND m.principal_id = a.id::text AND m.status='active') > 0
    OR (SELECT count(*) FROM company_secret_bindings b
         WHERE b.company_id = :'cid'::uuid AND b.target_type='agent' AND b.target_id = a.id::text) > 0)
ORDER BY 1;" | while IFS='|' read -r title status g m b; do
  [[ -n "$title" ]] || continue
  printf '  %-52s %-11s grants=%-3s memb=%-3s bindings=%s\n' "$title" "$status" "$g" "$m" "$b"
done
assert_sql_ok

# ---------------------------------------------------------------------------
hdr "4. Undo path — read this BEFORE applying"
cat <<'UNDO'
  There is no automatic rollback. `principal_permission_grants` and
  `company_secret_bindings` rows are DELETED; `company_memberships` rows are
  UPDATEd to status='archived' (the same terminal status the native
  archiveMember route and cmd_deactivate use), so that third kind is reversible
  in place with an UPDATE back to 'active'.

  To restore a deleted grant or binding you need a database backup, or you
  re-provision the agent through org_provisioner.sh, which rewrites both from
  the role template. Take a dump first if you want a cheap undo:

    pg_dump -t principal_permission_grants -t company_secret_bindings \
            -t company_memberships > pre-tog994.sql

  The attribution row in activity_log is NOT removed by any undo, and should
  not be — it records that the retirement happened.
UNDO

if [[ "$MODE" == "plan" ]]; then
  hdr "PLAN ONLY — nothing was written"
  say "re-run with: apply --requested-by <AGENT_UUID> [--kind $KIND]"
  exit 0
fi

# ---------------------------------------------------------------------------
# APPLY. One transaction. Every statement re-derives its own selection with the
# terminated predicate inline, so nothing depends on the counts printed above
# still being true — safety rule 2.
# ---------------------------------------------------------------------------
hdr "5. Applying"

do_grants=0; do_members=0; do_bindings=0
case "$KIND" in
  grants)      do_grants=1 ;;
  memberships) do_members=1 ;;
  bindings)    do_bindings=1 ;;
  all)         do_grants=1; do_members=1; do_bindings=1 ;;
esac

# The requesting agent must be a LIVE agent in this company. A retirement
# attributed to a terminated or foreign agent is not attribution.
requester_ok="$(sql "
SELECT count(*) FROM agents
WHERE id::text = :'a' AND company_id = :'cid'::uuid AND status <> 'terminated';")"; assert_sql_ok
[[ "$requester_ok" == "1" ]] || die "--requested-by is not a live agent in this company."

result="$(PGV_COMPANY_ID="$COMPANY_ID" PGV_A="$REQUESTED_BY" \
  pcsql_run -Atq -v ON_ERROR_STOP=1 -F'|' <<SQL
BEGIN;

-- Rule 2: the predicate is re-evaluated HERE, inside the writing transaction.
-- A row whose holder is live cannot match, whatever the plan above said.
WITH del_g AS (
  DELETE FROM principal_permission_grants g
   WHERE '$do_grants' = '1'
     AND g.company_id = :'cid'::uuid AND g.principal_type = 'agent'
     AND $(p_terminated g.principal_id)
  RETURNING 1
), del_b AS (
  DELETE FROM company_secret_bindings b
   WHERE '$do_bindings' = '1'
     AND b.company_id = :'cid'::uuid AND b.target_type = 'agent'
     AND $(p_terminated b.target_id)
  RETURNING 1
), upd_m AS (
  UPDATE company_memberships m
     SET status = 'archived', updated_at = NOW()
   WHERE '$do_members' = '1'
     AND m.company_id = :'cid'::uuid AND m.principal_type = 'agent' AND m.status = 'active'
     AND $(p_terminated m.principal_id)
  RETURNING 1
), counted AS (
  SELECT (SELECT count(*) FROM del_g) AS g,
         (SELECT count(*) FROM del_b) AS b,
         (SELECT count(*) FROM upd_m) AS m
)
-- Rule 5: the attribution row commits WITH the retirement or not at all.
-- entity_id is the company because this sweep spans many principals; the
-- per-principal detail is in the details payload.
INSERT INTO activity_log
  (company_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, details)
SELECT :'cid'::uuid, 'agent', :'a', 'agent.permissions_updated', 'company', :'cid', :'a'::uuid,
       jsonb_build_object(
         'source', 'org_orphan_retire.sh',
         'issue', 'TOG-994',
         'kind', '$KIND',
         'grantRowsDeleted', counted.g,
         'secretBindingsDeleted', counted.b,
         'membershipsArchived', counted.m,
         'note', 'retired access rows belonging to terminated agents')
FROM counted
RETURNING (details->>'grantRowsDeleted') || '|' ||
          (details->>'secretBindingsDeleted') || '|' ||
          (details->>'membershipsArchived');

COMMIT;
SQL
)"; rc=$?
[[ $rc -eq 0 ]] || { echo "ERROR: the retirement transaction failed; nothing was committed." >&2; exit 3; }

IFS='|' read -r DEL_G DEL_B UPD_M <<<"$(tail -1 <<<"$result")"
say "grant rows deleted:        ${DEL_G:-0}"
say "secret bindings deleted:   ${DEL_B:-0}"
say "memberships archived:      ${UPD_M:-0}"

printf '%s\n' "$(jq -cn \
  --arg c "$COMPANY_ID" --arg by "$REQUESTED_BY" --arg k "$KIND" \
  --arg g "${DEL_G:-0}" --arg b "${DEL_B:-0}" --arg m "${UPD_M:-0}" \
  '{event:"orphan.retired",issue:"TOG-994",companyId:$c,requestedBy:$by,kind:$k,
    grantRowsDeleted:($g|tonumber),secretBindingsDeleted:($b|tonumber),
    membershipsArchived:($m|tonumber)}')" >> "$GRANT_LOG"
chmod 0600 "$GRANT_LOG" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Rule 6: re-measure. The tool does not get to assert its own success.
# ---------------------------------------------------------------------------
hdr "6. Re-measured after the write"
after="$(sql "
SELECT
 (SELECT count(*) FROM principal_permission_grants g
   WHERE g.company_id = :'cid'::uuid AND g.principal_type='agent'
     AND $(p_terminated g.principal_id)),
 (SELECT count(*) FROM company_memberships m
   WHERE m.company_id = :'cid'::uuid AND m.principal_type='agent' AND m.status='active'
     AND $(p_terminated m.principal_id)),
 (SELECT count(*) FROM company_secret_bindings b
   WHERE b.company_id = :'cid'::uuid AND b.target_type='agent'
     AND $(p_terminated b.target_id));")"; assert_sql_ok
IFS='|' read -r R_G R_M R_B <<<"$after"
say "grant rows on terminated principals:      $R_G"
say "active memberships on terminated agents:  $R_M"
say "secret bindings on terminated holders:    $R_B"

# Only the kinds actually swept are required to be zero.
residual=0
[[ "$do_grants"   == "1" && "$R_G" != "0" ]] && { echo "  RESIDUAL: $R_G grant row(s) remain" >&2; residual=1; }
[[ "$do_members"  == "1" && "$R_M" != "0" ]] && { echo "  RESIDUAL: $R_M membership(s) remain" >&2; residual=1; }
[[ "$do_bindings" == "1" && "$R_B" != "0" ]] && { echo "  RESIDUAL: $R_B binding(s) remain" >&2; residual=1; }
[[ "$residual" -eq 0 ]] || { echo "ERROR: the sweep did not fully retire what it selected." >&2; exit 1; }

hdr "DONE"
say "verify independently with: COMPANY_ID=$COMPANY_ID ./org_access_review.sh --allow-active"
exit 0
