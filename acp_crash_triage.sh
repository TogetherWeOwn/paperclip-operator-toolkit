#!/usr/bin/env bash
# ===========================================================================
# acp_crash_triage.sh — recover the REAL cause of an ACP "process exited
# unexpectedly" crash, which the platform throws away. (TOG-695.)
# ---------------------------------------------------------------------------
# THE INCIDENT THIS EXISTS FOR.
# On 2026-08-28, five runs across four agents died between 22:53:01Z and
# 23:07:10Z with an identical, content-free error:
#
#     Internal error: The Claude Agent process exited unexpectedly.
#     Please start a new session.
#
# Every DB column that a responder would reach for is either synthetic or
# silent about the cause:
#
#   * `exit_code = 1` on all five — a CONSTANT, hard-coded at
#     packages/adapter-utils/src/acpx-engine/execute.ts:3713 for any
#     non-completed turn. It is not the child's real exit status.
#   * `signal = NULL` on all five — the ACP server survived and REPORTED its
#     child's death in-band, so Paperclip never saw a signal itself.
#   * `stderr_excerpt` holds only the unrelated adapter-timeout banner.
#   * `error` / `result_json.stopReason` hold the generic string above.
#
# TOG-695 was filed pointing at TOG-692 (memory oversubscription) as "the most
# promising lead": an OOM kill presents as "process exited unexpectedly". It
# was the wrong lead, and no DB column could have refuted it.
#
# ---------------------------------------------------------------------------
# WHERE THE TRUTH ACTUALLY LIVES.
# `acp-agent.js:2866` substitutes the generic message for the real one. The
# real one is written to the ACP logger a line earlier, and that logger's
# stderr is captured per-run at:
#
#     <stateDir>/run-stderr/<runId>.log
#     stateDir = <instance>/companies/<companyId>/acp-engine/agents/<agentId>
#
# For all five runs that file says, verbatim:
#
#     Claude Agent process died: Claude Code process terminated by signal SIGABRT
#
# SIGABRT (6) — not SIGKILL (9). **The kernel OOM killer sends SIGKILL and
# cannot be caught or converted.** So the memory hypothesis is refuted by the
# signal number alone, and TOG-692 is a different, non-causal issue here.
#
# The generic-vs-real substitution is the actual reliability defect: the
# platform persists the useless string and drops the diagnostic one. The
# error-path helper DOES attach a `childStderrTail`
# (execute.ts:2686), but the in-band terminal-failure path at execute.ts:3697+
# never calls it — so a crash reported through ACP rather than thrown loses
# the tail. That is why this script reads the file directly.
#
# ---------------------------------------------------------------------------
# USAGE
#     ./acp_crash_triage.sh                 # last 7 days, this company
#     ./acp_crash_triage.sh --since-days 30
#     ./acp_crash_triage.sh --run <runId>   # one specific run
#
# Exit codes:  0 = no crashes found · 10 = crashes found and explained
#              11 = crashes found but stderr missing (cause unrecoverable)
#              5  = UNKNOWN, could not read the database
#
# It is READ-ONLY: the DB session sets default_transaction_read_only.
# ===========================================================================
set -uo pipefail

SINCE_DAYS=7
ONE_RUN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --since-days) SINCE_DAYS="${2:?--since-days needs a value}"; shift 2 ;;
    --run)        ONE_RUN="${2:?--run needs a runId}"; shift 2 ;;
    -h|--help)    sed -n '1,62p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

COMPANY_ID="${PAPERCLIP_COMPANY_ID:-}"
if [[ -z "$COMPANY_ID" ]]; then
  echo "UNKNOWN: PAPERCLIP_COMPANY_ID is unset. Two companies share this database" >&2
  echo "         and agent names collide, so an unscoped read is not safe." >&2
  exit 5
fi

INSTANCE_DIR="${PAPERCLIP_INSTANCE_DIR:-/paperclip/instances/default}"

# --- the read seam -------------------------------------------------------
# Same approach as pg_source.js: there is no psql and no podman in an agent
# container, but DATABASE_URL and the server's own `pg` are both reachable.
# rowMode:"array" is deliberate — see pg_source.js for the duplicate-column
# corruption that the object form causes.
# The reader is written to a temp file rather than passed to `node -e`. The SQL
# needs single quotes ('%...%', ' days') and a single-quoted `node -e` payload
# cannot contain them — two separate syntax errors were hit doing it that way.
read_crashes() {
  local js
  js="$(mktemp "${PAPERCLIP_RUN_SCRATCH_DIR:-/tmp}/acp-triage-XXXXXX.cjs")" || return 5
  cat >"$js" <<'NODE_EOF'
const fs=require("fs"), path=require("path");
function loadPg(){
  const direct=[process.env.PAPERCLIP_PG_MODULE,"/app/node_modules/pg"].filter(Boolean);
  for(const r of direct){ try{ return require(r); }catch{} }
  const store="/app/node_modules/.pnpm";
  let e=[]; try{ e=fs.readdirSync(store); }catch{}
  for(const c of e.filter(x=>/^pg@\d/.test(x)).sort().reverse()
                  .map(x=>path.join(store,x,"node_modules","pg"))){
    try{ return require(c); }catch{}
  }
  return null;
}
const pg=loadPg();
if(!pg){ console.error("UNKNOWN: cannot load the pg module"); process.exit(5); }
// slice(2): argv[0] is node and argv[1] is this script. Using slice(1) shifted
// every value one place left, which silently turned the "--since-days" branch
// into the "--run" branch and made Postgres reject the unused $2.
const [companyId, sinceDays, oneRun]=process.argv.slice(2);
(async()=>{
  const c=new pg.Client({connectionString:process.env.DATABASE_URL});
  await c.connect();
  await c.query("SET default_transaction_read_only = on");
  // Each branch binds ONLY the parameters it uses. Passing a value Postgres
  // never references leaves its type uninferable and the whole query fails
  // with "could not determine data type of parameter".
  const filter = oneRun ? "and h.id = $2::uuid"
                        : "and h.created_at > now() - ($2::text || ' days')::interval";
  const vals = [companyId, oneRun || sinceDays];
  const r=await c.query({text:`
    -- EVERY column is coalesced to a NON-EMPTY string. A tab-IFS shell read
    -- drops an empty field and shifts all later columns left; the signal
    -- column is NULL on exactly this failure mode, which silently slid
    -- error_code into signal, issueId into error_code and the successor
    -- count into issueId. (No backticks in this query: it is a JS template.)
    select h.id::text, h.agent_id::text, a.name,
           to_char(h.finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           coalesce(h.exit_code::text, 'NULL'),
           coalesce(h.signal, 'NULL'),
           coalesce(h.error_code, 'NULL'),
           coalesce(nullif(h.context_snapshot->>'issueId',''), '-'),
           (select count(*) from heartbeat_runs x where x.retry_of_run_id = h.id)::text
    from heartbeat_runs h join agents a on a.id = h.agent_id
    where h.company_id = $1::uuid
      and h.error ilike '%process exited unexpectedly%'
      ${filter}
    order by h.created_at`, values:vals, rowMode:"array"});
  for(const row of r.rows) console.log(row.join("\t"));
  await c.end();
})().catch(e=>{ console.error("UNKNOWN: "+e.message); process.exit(5); });
NODE_EOF
  node "$js" "$COMPANY_ID" "$SINCE_DAYS" "$ONE_RUN"
  local rc=$?
  rm -f "$js"
  return $rc
}

CRASHES="$(read_crashes)" || exit 5

if [[ -z "$CRASHES" ]]; then
  if [[ -n "$ONE_RUN" ]]; then
    echo "OK: run $ONE_RUN is not an ACP process-exit crash."
  else
    echo "OK: no ACP process-exit crashes in the last $SINCE_DAYS days."
  fi
  exit 0
fi

echo "ACP process-exit crashes (company $COMPANY_ID):"
echo

found=0
unexplained=0
declare -A SIGNALS=()

# Column order must match the SELECT exactly. See the note there: every field
# is coalesced to a non-empty placeholder because `IFS=$'\t' read` drops empty
# fields and shifts the remainder left.
while IFS=$'\t' read -r run_id agent_id agent_name finished exit_code signal err_code issue_id successors; do
  [[ -z "${run_id:-}" ]] && continue
  found=$((found+1))
  stderr_log="$INSTANCE_DIR/companies/$COMPANY_ID/acp-engine/agents/$agent_id/run-stderr/$run_id.log"

  echo "  run       $run_id"
  echo "  agent     $agent_name"
  echo "  crashed   $finished"
  [[ "$issue_id" != "-" ]] && echo "  issue     $issue_id"
  # exit_code/signal are printed ONLY to say they are useless, so a future
  # responder does not quietly trust them the way TOG-695 nearly did.
  echo "  db fields exit_code=$exit_code (synthetic constant) signal=${signal:-NULL} error_code=$err_code"
  echo "  retried   $successors successor run(s)"

  if [[ -f "$stderr_log" ]]; then
    cause="$(grep -ao 'Claude Agent process died: .*' "$stderr_log" 2>/dev/null | head -1)"
    if [[ -n "$cause" ]]; then
      sig="$(printf '%s' "$cause" | grep -ao 'signal [A-Z]*' | head -1 | awk '{print $2}')"
      echo "  REAL CAUSE ${cause#Claude Agent process died: }"
      if [[ -n "$sig" ]]; then
        SIGNALS["$sig"]=$(( ${SIGNALS["$sig"]:-0} + 1 ))
        case "$sig" in
          SIGKILL) echo "             ^ SIGKILL — consistent with an OOM kill or an external kill." ;;
          SIGABRT) echo "             ^ SIGABRT — an ABORT inside the child, NOT an OOM kill." ;;
          *)       echo "             ^ signal $sig." ;;
        esac
      fi
    else
      echo "  REAL CAUSE (stderr log present but records no process death)"
      unexplained=$((unexplained+1))
    fi
  else
    echo "  REAL CAUSE UNRECOVERABLE — no $stderr_log"
    unexplained=$((unexplained+1))
  fi
  echo
done <<< "$CRASHES"

echo "---"
echo "$found crash(es) examined; $unexplained without a recoverable cause."
if [[ ${#SIGNALS[@]} -gt 0 ]]; then
  echo -n "signals: "
  for s in "${!SIGNALS[@]}"; do echo -n "$s=${SIGNALS[$s]} "; done
  echo
  # The whole point of the script: settle the OOM question with the signal
  # number instead of a plausible story about memory.
  if [[ -z "${SIGNALS[SIGKILL]:-}" ]]; then
    echo "No SIGKILL among these deaths => the kernel OOM killer did not cause them."
  fi
fi

[[ $unexplained -gt 0 ]] && exit 11
exit 10
