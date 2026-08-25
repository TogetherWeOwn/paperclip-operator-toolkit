#!/usr/bin/env node
// ===========================================================================
// pg_source.js — the read seam that lets quota_brake.sh run from inside an
// AGENT CONTAINER, where lib/pcsql.sh cannot reach a database at all. (TOG-477.)
// ---------------------------------------------------------------------------
// WHY THIS EXISTS RATHER THAN A THIRD pcsql BACKEND.
//
// `lib/pcsql.sh` offers two backends and an agent container has neither:
//
//     $ ./quota_brake.sh plan --explain
//     lib/pcsql.sh: line 150: podman: command not found
//     UNKNOWN: cannot read the roster. Nothing braked, nothing restored.
//     $ echo $?
//     5
//
// The tool was right to exit 5 — it measured nothing. But it means the brake
// built to shape a 47-wide surge was operator-only, and during the ramp from 3
// to 47 in flight on 2026-08-25 nothing capped concurrency and nothing could
// have. There is no `psql` and no `podman` client in the container; there IS a
// `DATABASE_URL` and a `pg` module inside the Paperclip server's own
// node_modules. So the reachable path is neither of pcsql's backends, and
// quota_brake.sh already publishes the correct seam for exactly this:
// ROSTER_SOURCE_CMD and REFUSAL_SOURCE_CMD. This fills them in.
//
//     export ROSTER_SOURCE_CMD="$PWD/pg_source.js roster"
//     export REFUSAL_SOURCE_CMD="$PWD/pg_source.js refusals --since-min 15"
//     ./quota_brake.sh plan --explain
//
// ---------------------------------------------------------------------------
// IT IS A READ, AND THE DATABASE IS TOLD SO.
// Every connection sets `default_transaction_read_only = on` before it issues
// a query. The brake's WRITE path is unchanged and still goes through the API
// (`PATCH /api/agents/{id}`, with assert_policy_preserved on the bytes) — this
// file cannot write an agent even if a future caller asks it to, because the
// session refuses the statement. Reading the roster and writing it back are
// different privileges and this seam only ever needed the first.
//
// ---------------------------------------------------------------------------
// THE COMPANY FILTER IS MANDATORY, AND THAT IS NOT DEFENSIVENESS.
// The operator's `roster_sql()` has no company predicate because it runs via
// `podman exec` against a database it assumes is this company's. That
// assumption does not hold here: TWO COMPANIES SHARE THIS POSTGRES, and agent
// names collide across them. An unfiltered roster read from an agent container
// would hand quota_brake.sh another company's agents to brake, and the write
// path would accept them — they are valid agent ids. So the company id is
// required, taken from PAPERCLIP_COMPANY_ID or --company, and a missing one is
// a refusal rather than a default.
// ===========================================================================
"use strict";

const fs = require("fs");
const path = require("path");

// The `pg` version is pinned by the server's pnpm store, so resolve it by glob
// rather than hard-coding `pg@8.18.0` — a server upgrade would otherwise turn
// this seam into a "cannot find module" at the exact moment quota is tight.
// NODE_PATH is not an option: it does nothing for ESM and this file is CJS
// only by choice, so `require` of an absolute path is the reliable form.
function loadPg() {
  const roots = [
    process.env.PAPERCLIP_PG_MODULE,
    "/app/node_modules/pg",
  ].filter(Boolean);
  for (const r of roots) {
    try { return require(r); } catch { /* keep looking */ }
  }
  const store = "/app/node_modules/.pnpm";
  let entries = [];
  try { entries = fs.readdirSync(store); } catch { /* no store */ }
  const cands = entries
    .filter((e) => /^pg@\d/.test(e))
    .sort()
    .reverse()
    .map((e) => path.join(store, e, "node_modules", "pg"));
  for (const c of cands) {
    try { return require(c); } catch { /* keep looking */ }
  }
  return null;
}

// A tab or a newline inside a value would shift every column of the TSV the
// shell then splits on — the exact class of bug quota_brake.sh's `IFS=$'\x1f'`
// dance exists to survive. PostgreSQL renders jsonb on one line and escapes
// control characters inside strings, so the podman path never had to think
// about it; `pg` hands back real JS values, so this path does.
function cell(v) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replace(/\t/g, "\\t").replace(/\r?\n/g, "\\n");
}

const ROSTER_SQL = `
  select a.id,
         a.name,
         a.status,
         coalesce(a.runtime_config->'heartbeat'->>'wakeOnDemand', ''),
         coalesce(a.runtime_config->'heartbeat'->>'maxConcurrentRuns', ''),
         coalesce(a.runtime_config->'heartbeat'->'quotaBrake'->>'baseline', ''),
         (select count(*) from issues i
           where i.assignee_agent_id = a.id
             and i.priority = 'critical'
             and i.status in ('todo','in_progress')),
         coalesce(a.runtime_config::text, '{}')
    from agents a
   where a.company_id = $1
     and a.status <> 'terminated'
   order by a.name`;

// Mirrors quota_brake.sh's refusal_sql(), including the three reasons it
// counts. The window is an interval literal built from a validated integer —
// never interpolated text — because this is the one place a caller-supplied
// number reaches SQL.
const REFUSAL_SQL = `
  select w.reason,
         coalesce(a.name,'(unknown)'),
         count(*)
    from agent_wakeup_requests w
    left join agents a on a.id = w.agent_id
   where a.company_id = $1
     and w.status = 'skipped'
     and w.created_at > now() - ($2 || ' minutes')::interval
     and w.reason in ('heartbeat.wakeOnDemand.disabled',
                      'heartbeat.daily_run_limit',
                      'heartbeat.daily_cost_limit')
   group by 1,2
   order by 3 desc`;

function refuse(msg) {
  process.stderr.write(`REFUSED: ${msg}\n`);
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const mode = argv[0] || "";
  let company = process.env.PAPERCLIP_COMPANY_ID || "";
  let sinceMin = 15;

  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--company") { company = argv[++i] || ""; continue; }
    if (argv[i] === "--since-min") { sinceMin = Number(argv[++i]); continue; }
    refuse(`unknown argument: ${argv[i]}`);
  }

  if (mode !== "roster" && mode !== "refusals") {
    process.stderr.write(
      "usage: pg_source.js roster|refusals [--company UUID] [--since-min N]\n" +
      "  roster    -> id\\tname\\tstatus\\twakeOnDemand\\tmaxConcurrentRuns\\tbaseline\\tcritical\\truntimeConfig\n" +
      "  refusals  -> reason\\tagent\\tcount\n");
    process.exit(2);
  }
  if (!company) {
    refuse("no company. Set PAPERCLIP_COMPANY_ID or pass --company; two companies share this database " +
           "and an unfiltered roster would brake the wrong one (TOG-477).");
  }
  if (!Number.isInteger(sinceMin) || sinceMin <= 0) {
    refuse(`--since-min must be a positive integer, got '${sinceMin}'`);
  }
  if (!process.env.DATABASE_URL) {
    refuse("DATABASE_URL is not set in this environment.");
  }

  const pg = loadPg();
  if (!pg) {
    refuse("cannot load the 'pg' module. Set PAPERCLIP_PG_MODULE to its directory.");
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("SET default_transaction_read_only = on");
    // `rowMode: "array"` IS REQUIRED, and the object form is a silent
    // corruption rather than an error. Five of the roster's eight columns are
    // bare `coalesce(...)` expressions, so PostgreSQL names them all
    // `coalesce`; `pg`'s default object rows key on column NAME, and each
    // duplicate overwrites the last. The first run of this file emitted
    // `id, name, status, runtimeConfig` — the whole config landed in the
    // wakeOnDemand column, four fields short, and the shell split it happily.
    // Positional rows are the TSV's actual contract, so ask for positions.
    const res = mode === "roster"
      ? await client.query({ text: ROSTER_SQL, values: [company], rowMode: "array" })
      : await client.query({ text: REFUSAL_SQL, values: [company, String(sinceMin)], rowMode: "array" });
    const out = res.rows
      .map((r) => r.map(cell).join("\t"))
      .join("\n");
    if (out) process.stdout.write(out + "\n");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  // Exit 1, not 0: quota_brake.sh treats a non-zero source as "cannot read the
  // roster" and exits 5 UNKNOWN. An empty stdout with status 0 would instead
  // read as "zero agents", which is the silent-green failure rule 4 exists to
  // prevent.
  process.stderr.write(`ERROR: ${e && e.message ? e.message : e}\n`);
  process.exit(1);
});
