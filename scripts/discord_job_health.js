#!/usr/bin/env node
// ===========================================================================
// discord_job_health.js — measure which paperclip-plugin-discord scheduled
// jobs actually work, and classify WHY the failing ones fail. (TOG-599.)
// ---------------------------------------------------------------------------
// WHY THIS IS A SCRIPT AND NOT A PARAGRAPH.
//
// TOG-599 was twice written up from a job-run table read by hand, and twice
// got the root cause wrong in the same direction: it reported
// `check-escalation-timeouts` as the single broken job and recorded the daily
// digest as healthy. The digest was not healthy. It had never once posted.
// It looked healthy because 23 of its 24 hourly rows are `succeeded` — they
// return at the hour gate (vendor `dist/worker.js:1914`) before doing any
// work. A `succeeded` row for a job that no-opped proves nothing, and a human
// skimming a status column cannot see the difference.
//
// So the numbers live here instead. Same input, same output, every time.
//
// WHAT THE FAILURE ACTUALLY IS (measured, not inferred).
//
// The host authorizes a plugin's *proactive* (no-invocation) company-scoped
// calls against exactly its CONFIGURED companies:
//
//     plugin-loader.js:1365       proactiveCompanyScopes: configRows.map(r => r.companyId)
//     plugin-worker-manager.js:534  if (proactiveCompanyId && proactiveCompanyScopes.has(...))
//
// A scheduled job carries no company: `deriveInvocationScope`
// (plugin-worker-manager.js:304-323) reads a company only from `companyId`,
// `performAction`, `executeTool`, or `onEvent` params, and the scheduler's
// `runJob` payload (plugin-job-scheduler.js:184) has none. Every job run row
// therefore has `company_id = NULL`. That is normal and is NOT the bug.
//
// The bug is that both failing jobs issue a company-scoped `state.get` for a
// scope id that is NOT a configured company:
//
//   check-escalation-timeouts -> escalation-state.js:48 asks for scope ids
//                                [ownerCompanyId, "default"]. The literal
//                                string "default" is not a company id, is not
//                                in the authorized set, and is denied.
//   discord-daily-digest      -> worker.js:1918 calls resolveChannel() for
//                                EVERY company from ctx.companies.list(), and
//                                resolveChannel does a company-scoped
//                                state.get at worker.js:107. This host has 4
//                                companies and 1 configured one, so the first
//                                unconfigured company is denied. That call sits
//                                OUTSIDE the per-company try/catch at
//                                worker.js:1921, so one denial aborts the whole
//                                digest before any company posts.
//
// This also explains the two different error strings, which previously read as
// two separate defects. `contextForWorkerMessage`
// (plugin-worker-manager.js:523-540) returns `invalidInvocationScope` when some
// other invocation is in flight and a bare `{}` when none is. So the SAME
// denial surfaces as "the worker referenced a missing, expired, or unknown
// invocation scope" when it races a concurrent job and as "company context is
// required" when it runs alone. `check-escalation-timeouts` and
// `check-budget-thresholds` are both `*/5 * * * *`, which is why the escalation
// job shows mostly the former. One cause, two texts.
//
// WHY THERE IS NO CONFIGURATION-ONLY REPAIR.
//
// Adding config rows for the other three companies WOULD authorize the scope
// and stop the denial — and must not be done. `resolveChannel`'s fallback is
// `rt.defaultChannelId`, so each newly-authorized company would resolve to OUR
// #control-room and the digest would post other companies' issue and agent
// counts into this company's private Discord. The denial is currently the only
// thing preventing that. Silencing it would convert a broken feature into a
// cross-company data leak. Leave it failing and fix it upstream.
//
// USAGE
//     node scripts/discord_job_health.js            # human table
//     node scripts/discord_job_health.js --json     # machine readable
//
// Read-only. Requires DATABASE_URL (present in an agent container) and the
// server's own `pg`. Exits 5 if it could not measure — never 0 on no data,
// because "measured nothing" must not read as "everything is green".
// ===========================================================================

"use strict";

const fs = require("fs");
const path = require("path");

const PLUGIN_KEY = "paperclip-plugin-discord";

// The vendor jobs that do real work only inside a time gate. A `succeeded` row
// for one of these is NOT evidence it did anything.
const GATED_JOBS = new Set(["discord-daily-digest"]);

function loadPg() {
  const roots = [process.env.PAPERCLIP_PG_MODULE, "/app/node_modules/pg"].filter(Boolean);
  for (const r of roots) {
    try { return require(r); } catch { /* keep looking */ }
  }
  let entries = [];
  try { entries = fs.readdirSync("/app/node_modules/.pnpm"); } catch { /* no store */ }
  const cands = entries
    .filter((e) => /^pg@\d/.test(e))
    .sort()
    .reverse()
    .map((e) => path.join("/app/node_modules/.pnpm", e, "node_modules", "pg"));
  for (const c of cands) {
    try { return require(c); } catch { /* keep looking */ }
  }
  return null;
}

function refuse(msg) {
  console.error(`UNKNOWN: ${msg} Nothing measured.`);
  process.exit(5);
}

// Classify one error string into its underlying cause. Both governed-access
// texts are the SAME denial; see the header.
function classify(error) {
  if (!error) return "ok";
  if (error.includes("company context is required")) return "scope-denied";
  if (error.includes("invocation scope")) return "scope-denied";
  return "other";
}

async function main() {
  const json = process.argv.includes("--json");
  const pg = loadPg();
  if (!pg) refuse("could not load the server's pg module.");
  if (!process.env.DATABASE_URL) refuse("DATABASE_URL is not set in this environment.");

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const plugin = await client.query(
      `SELECT id, version, status FROM plugins WHERE plugin_key = $1`,
      [PLUGIN_KEY],
    );
    if (plugin.rowCount === 0) refuse(`plugin ${PLUGIN_KEY} is not installed.`);
    const { id: pluginId, version, status: pluginStatus } = plugin.rows[0];

    // Authorized proactive scopes == configured companies. This is the set the
    // host checks every company-scoped job call against.
    const configured = await client.query(
      `SELECT company_id FROM plugin_config WHERE plugin_id = $1 ORDER BY company_id`,
      [pluginId],
    );
    const allCompanies = await client.query(`SELECT id, name FROM companies ORDER BY id`);
    const authorized = new Set(configured.rows.map((r) => r.company_id));
    const unauthorized = allCompanies.rows.filter((c) => !authorized.has(c.id));

    const jobs = await client.query(
      `SELECT id, job_key, schedule, status, next_run_at
         FROM plugin_jobs WHERE plugin_id = $1 ORDER BY job_key`,
      [pluginId],
    );
    if (jobs.rowCount === 0) refuse("the plugin has no registered jobs.");

    const report = [];
    for (const job of jobs.rows) {
      const runs = await client.query(
        `SELECT status, error, started_at FROM plugin_job_runs
          WHERE job_id = $1 AND started_at > now() - interval '48 hours'
          ORDER BY started_at DESC`,
        [job.id],
      );
      const counts = { ok: 0, "scope-denied": 0, other: 0 };
      let latestError = null;
      for (const r of runs.rows) {
        const k = r.status === "succeeded" ? "ok" : classify(r.error);
        counts[k] = (counts[k] || 0) + 1;
        if (!latestError && r.status !== "succeeded") latestError = r.error;
      }
      const failing = counts["scope-denied"] + counts.other;
      report.push({
        jobKey: job.job_key,
        schedule: job.schedule,
        enabled: job.status,
        runs48h: runs.rowCount,
        succeeded: counts.ok,
        scopeDenied: counts["scope-denied"],
        otherFailures: counts.other,
        // A gated job's successes are hour-gate no-ops, so they are not proof.
        successesProveWork: !GATED_JOBS.has(job.job_key),
        verdict:
          failing > 0
            ? "FAILING"
            : GATED_JOBS.has(job.job_key)
              ? "UNPROVEN (gated: succeeded rows may be no-ops)"
              : "healthy",
        latestError,
      });
    }

    const out = {
      plugin: { key: PLUGIN_KEY, id: pluginId, version, status: pluginStatus },
      companies: { total: allCompanies.rowCount, configured: authorized.size },
      // The digest iterates every company; each unconfigured one is a denial
      // waiting to abort it.
      unauthorizedCompanies: unauthorized.map((c) => ({ id: c.id, name: c.name })),
      jobs: report,
    };

    if (json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`plugin ${PLUGIN_KEY} v${version} (${pluginStatus})`);
      console.log(
        `companies: ${out.companies.total} total, ${out.companies.configured} configured, ` +
          `${unauthorized.length} unauthorized for proactive job calls`,
      );
      for (const c of unauthorized) console.log(`  unauthorized: ${c.name} (${c.id})`);
      console.log("");
      for (const j of report) {
        console.log(`${j.jobKey}  [${j.schedule}]  ${j.verdict}`);
        console.log(
          `    48h: ${j.runs48h} runs, ${j.succeeded} succeeded, ` +
            `${j.scopeDenied} scope-denied, ${j.otherFailures} other`,
        );
        if (!j.successesProveWork) {
          console.log("    NOTE: time-gated job — succeeded rows may be no-ops, not posts.");
        }
        if (j.latestError) console.log(`    latest error: ${j.latestError}`);
      }
    }

    const broken = report.filter((j) => j.verdict === "FAILING").length;
    process.exit(broken > 0 ? 1 : 0);
  } finally {
    await client.end();
  }
}

main().catch((err) => refuse(err && err.message ? err.message : String(err)));
