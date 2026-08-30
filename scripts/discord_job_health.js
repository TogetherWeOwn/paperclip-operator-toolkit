#!/usr/bin/env node
// ===========================================================================
// discord_job_health.js — measure which paperclip-plugin-discord scheduled
// jobs actually work, and classify WHY the failing ones fail. (TOG-599.)
//
// TOG-676 rewrite: prove DELIVERY, not merely the absence of an exception.
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
// ---------------------------------------------------------------------------
// WHAT THE TOG-676 REWRITE FIXES, AND WHY IT MATTERED.
//
// The first version of this script inferred the digest's health from its
// FAILURE count. That inference has a hole big enough to drive the whole bug
// through: it can only see a digest that dies loudly. A digest that stops
// throwing and still never posts reads as `0 scope-denied` — and the old code
// printed "UNPROVEN" and exited **0**. Green.
//
// That is not hypothetical. It is the exact state the cheapest "remedy"
// produces. Adding `plugin_config` rows for the other three companies removes
// every denial (see WHY THERE IS NO CONFIGURATION-ONLY REPAIR below) — so the
// failure count goes to zero, this detector goes green, and the digest still
// posts nothing to our channel. The measurement would have certified the one
// workaround that must never be applied.
//
// So delivery is now proven POSITIVELY, from the vendor's own success metric:
//
//     dist/worker.js:1996   await ctx.metrics.write(METRIC_NAMES.digestSent, 1)
//     dist/constants.js:74  digestSent: "discord_digest_sent"
//
// That write follows the post, so a row in `plugin_logs` is evidence a digest
// reached Discord and the absence of one is evidence it did not. Measured
// 2026-08-30: **0 rows all-time**, against 1,117 `discord_notifications_sent`.
// The metric channel works; the digest has simply never run to completion.
//
// A time-gated job is therefore scored on more than two outcomes:
//     FAILING       — runs threw. The error is classified below.
//     NOT_DELIVERED — runs are clean, send opportunities passed, nothing sent.
//     healthy       — a send metric landed inside the window.
// and "the window contained no opportunity to send" is a REFUSAL (exit 5),
// not a pass. Zero-of-zero is not evidence.
//
// ---------------------------------------------------------------------------
// WHAT THE FAILURE ACTUALLY IS (measured, not inferred).
//
// The host authorizes a plugin's *proactive* (no-invocation) company-scoped
// calls against exactly its CONFIGURED companies:
//
//     plugin-loader.js:1365         proactiveCompanyScopes: configRows.map(r => r.companyId)
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
// ---------------------------------------------------------------------------
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
// This is precisely why NOT_DELIVERED exists: it keeps the alarm on after
// someone silences the exception.
//
// ---------------------------------------------------------------------------
// USAGE
//     node scripts/discord_job_health.js                 # human table
//     node scripts/discord_job_health.js --json          # machine readable
//     node scripts/discord_job_health.js --window-hours 48
//
// Read-only. Reads DATABASE_URL and the server's own `pg` by default. The
// measurement can instead be piped in from a command emitting the source JSON
// documented at readSourceFromCmd():
//
//     DISCORD_JOB_HEALTH_SOURCE_CMD=./fixture.sh node scripts/discord_job_health.js
//
// That seam follows the ROSTER_SOURCE_CMD/pg_source.js precedent and is what
// lets test_discord_job_health.sh run in CI, which has no database.
//
// EXIT CODES
//     0  every job healthy AND every gated job proved a delivery
//     1  at least one job is FAILING or NOT_DELIVERED
//     5  could not measure — never 0 on no data, because "measured nothing"
//        must not read as "everything is green"
// ===========================================================================

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const PLUGIN_KEY = "paperclip-plugin-discord";

// Jobs that do real work only inside a time gate. A `succeeded` row for one of
// these is NOT evidence it did anything, so each maps to the metric that IS.
// vendor dist/worker.js:1996 -> dist/constants.js:74
const GATED_JOBS = new Map([["discord-daily-digest", "discord_digest_sent"]]);

const DEFAULT_WINDOW_HOURS = 48;

function refuse(msg) {
  console.error(`UNKNOWN: ${msg} Nothing measured.`);
  process.exit(5);
}

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

// ---------------------------------------------------------------------------
// Classification.
//
// Both governed-access texts are the SAME denial; see the header. A failed run
// with no error text is deliberately NOT scored "ok" — only the row's own
// `succeeded` status may do that. Letting a null error mean success is how a
// detector reports a defect as a pass.
// ---------------------------------------------------------------------------
function classify(error) {
  if (!error) return "other";
  if (error.includes("company context is required")) return "scope-denied";
  if (error.includes("invocation scope")) return "scope-denied";
  return "other";
}

function parseHour(t) {
  const [h] = String(t == null ? "" : t).split(":");
  const n = parseInt(h, 10);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : null;
}

// Which UTC hours does the vendor's gate (dist/worker.js:1895-1914) admit?
function digestSendHours(digest) {
  const cfg = digest || {};
  const mode = cfg.mode || "off";
  if (mode === "off") return [];
  const first = parseHour(cfg.dailyDigestTime || "09:00");
  const second = parseHour(cfg.bidailySecondTime || "17:00");
  if (mode === "daily") return first === null ? [] : [first];
  if (mode === "bidaily") return [first, second].filter((h) => h !== null);
  if (mode === "tridaily") {
    return String(cfg.tridailyTimes || "07:00,13:00,19:00")
      .split(",")
      .map((t) => parseHour(t.trim()))
      .filter((h) => h !== null);
  }
  return [];
}

// How many times COULD the job have sent inside the window? Counting real hour
// boundaries rather than dividing by a cadence keeps this exact at the edges —
// and a count of 0 is what turns a "clean" window into a refusal, not a pass.
function sendOpportunities(digest, fromMs, toMs) {
  const hours = new Set(digestSendHours(digest));
  if (hours.size === 0) return 0;
  let n = 0;
  const cursor = new Date(fromMs);
  cursor.setUTCMinutes(0, 0, 0);
  if (cursor.getTime() < fromMs) cursor.setUTCHours(cursor.getUTCHours() + 1);
  for (let t = cursor.getTime(); t <= toMs; t += 3600 * 1000) {
    if (hours.has(new Date(t).getUTCHours())) n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// The source contract. Either the built-in database read, or an external
// command emitting this same JSON:
//
//   { plugin:    {key,id,version,status},
//     companies: [{id,name}],
//     configuredCompanyIds: [id],
//     digest:    {mode,dailyDigestTime,bidailySecondTime,tridailyTimes},
//     jobs:      [{jobKey,schedule,status,runs:[{status,error,startedAt}]}],
//     deliveries:{ "<metric>": <count in window> },
//     now:       ISO8601,
//     windowHours: number }
// ---------------------------------------------------------------------------
function readSourceFromCmd(cmd, windowHours) {
  let raw;
  try {
    raw = execFileSync("/bin/sh", ["-c", cmd], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, DISCORD_JOB_HEALTH_WINDOW_HOURS: String(windowHours) },
    });
  } catch (err) {
    refuse(`source command failed: ${(err && err.message) || err}.`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    refuse(`source command did not emit valid JSON: ${(err && err.message) || err}.`);
  }
  return null;
}

async function readSourceFromDb(windowHours) {
  const pg = loadPg();
  if (!pg) refuse("could not load the server's pg module.");
  if (!process.env.DATABASE_URL) refuse("DATABASE_URL is not set in this environment.");

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // This tool only ever reads. Tell the database, rather than trusting every
    // future query in this file to stay a SELECT.
    await client.query("SET default_transaction_read_only = on");

    const plugin = await client.query(
      `SELECT id, version, status FROM plugins WHERE plugin_key = $1`,
      [PLUGIN_KEY],
    );
    if (plugin.rowCount === 0) refuse(`plugin ${PLUGIN_KEY} is not installed.`);
    const { id: pluginId, version, status: pluginStatus } = plugin.rows[0];

    const configured = await client.query(
      `SELECT company_id, config_json FROM plugin_config
        WHERE plugin_id = $1 ORDER BY company_id`,
      [pluginId],
    );
    const allCompanies = await client.query(`SELECT id, name FROM companies ORDER BY id`);

    // Digest cadence comes from OUR company's config row; it is the only one
    // whose channel the digest would legitimately post to.
    const ours = process.env.PAPERCLIP_COMPANY_ID;
    const row =
      configured.rows.find((r) => r.company_id === ours) || configured.rows[0] || null;
    let cfg = {};
    if (row && row.config_json) {
      cfg = typeof row.config_json === "string" ? JSON.parse(row.config_json) : row.config_json;
    }

    const jobs = await client.query(
      `SELECT id, job_key, schedule, status FROM plugin_jobs
        WHERE plugin_id = $1 ORDER BY job_key`,
      [pluginId],
    );
    if (jobs.rowCount === 0) refuse("the plugin has no registered jobs.");

    const jobReports = [];
    for (const job of jobs.rows) {
      const runs = await client.query(
        `SELECT status, error, started_at FROM plugin_job_runs
          WHERE job_id = $1 AND started_at > now() - ($2 || ' hours')::interval
          ORDER BY started_at DESC`,
        [job.id, String(windowHours)],
      );
      jobReports.push({
        jobKey: job.job_key,
        schedule: job.schedule,
        status: job.status,
        runs: runs.rows.map((r) => ({
          status: r.status,
          error: r.error,
          startedAt: r.started_at,
        })),
      });
    }

    // Positive proof of delivery, per gated job.
    const deliveries = {};
    for (const metric of GATED_JOBS.values()) {
      const m = await client.query(
        `SELECT count(*)::int AS n FROM plugin_logs
          WHERE plugin_id = $1 AND message = $2
            AND created_at > now() - ($3 || ' hours')::interval`,
        [pluginId, metric, String(windowHours)],
      );
      deliveries[metric] = m.rows[0].n;
    }

    const nowRow = await client.query(`SELECT now() AS now`);

    return {
      plugin: { key: PLUGIN_KEY, id: pluginId, version, status: pluginStatus },
      companies: allCompanies.rows.map((c) => ({ id: c.id, name: c.name })),
      configuredCompanyIds: configured.rows.map((r) => r.company_id),
      digest: {
        mode: cfg.digestMode ?? "off",
        dailyDigestTime: cfg.dailyDigestTime,
        bidailySecondTime: cfg.bidailySecondTime,
        tridailyTimes: cfg.tridailyTimes,
      },
      jobs: jobReports,
      deliveries,
      now: new Date(nowRow.rows[0].now).toISOString(),
      windowHours,
    };
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Pure scoring. Kept free of I/O so the suite can drive every branch.
// ---------------------------------------------------------------------------
function score(src) {
  if (!src || !Array.isArray(src.jobs) || src.jobs.length === 0) {
    refuse("the source reported no jobs.");
  }
  const windowHours = Number(src.windowHours) || DEFAULT_WINDOW_HOURS;
  const nowMs = Date.parse(src.now);
  if (!Number.isFinite(nowMs)) refuse("the source reported no usable clock.");
  const fromMs = nowMs - windowHours * 3600 * 1000;

  const authorized = new Set(src.configuredCompanyIds || []);
  const unauthorized = (src.companies || []).filter((c) => !authorized.has(c.id));

  const report = [];
  for (const job of src.jobs) {
    const counts = { ok: 0, "scope-denied": 0, other: 0 };
    let latestError = null;
    for (const r of job.runs || []) {
      const k = r.status === "succeeded" ? "ok" : classify(r.error);
      counts[k] = (counts[k] || 0) + 1;
      if (!latestError && r.status !== "succeeded") latestError = r.error || "(no error text)";
    }
    const failing = counts["scope-denied"] + counts.other;
    const metric = GATED_JOBS.get(job.jobKey) || null;
    const mode = (src.digest || {}).mode || "off";

    let verdict;
    let opportunities = null;
    let delivered = null;

    if (metric) {
      opportunities = sendOpportunities(src.digest, fromMs, nowMs);
      delivered = Number((src.deliveries || {})[metric] || 0);
      if (failing > 0) {
        verdict = "FAILING";
      } else if (mode === "off") {
        // Deliberately switched off is not a defect, but it is not delivery
        // either. Never call it healthy.
        verdict = "DISABLED (digest mode off — nothing is expected to post)";
      } else if (opportunities === 0) {
        // Zero-of-zero: the window was too short to contain a scheduled send.
        // Refuse rather than pass.
        verdict = "UNMEASURED";
      } else if (delivered > 0) {
        verdict = "healthy";
      } else {
        verdict = "NOT_DELIVERED";
      }
    } else {
      verdict = failing > 0 ? "FAILING" : "healthy";
    }

    report.push({
      jobKey: job.jobKey,
      schedule: job.schedule,
      enabled: job.status,
      runs: (job.runs || []).length,
      succeeded: counts.ok,
      scopeDenied: counts["scope-denied"],
      otherFailures: counts.other,
      deliveryMetric: metric,
      sendOpportunities: opportunities,
      delivered,
      verdict,
      latestError,
    });
  }

  return {
    plugin: src.plugin,
    windowHours,
    companies: {
      total: (src.companies || []).length,
      configured: authorized.size,
    },
    // The digest iterates every company; each unconfigured one is a denial
    // waiting to abort it.
    unauthorizedCompanies: unauthorized.map((c) => ({ id: c.id, name: c.name })),
    digest: src.digest,
    jobs: report,
  };
}

function render(out) {
  const p = out.plugin || {};
  console.log(`plugin ${p.key} v${p.version} (${p.status})   window: ${out.windowHours}h`);
  console.log(
    `companies: ${out.companies.total} total, ${out.companies.configured} configured, ` +
      `${out.unauthorizedCompanies.length} unauthorized for proactive job calls`,
  );
  for (const c of out.unauthorizedCompanies) console.log(`  unauthorized: ${c.name} (${c.id})`);
  console.log("");
  for (const j of out.jobs) {
    console.log(`${j.jobKey}  [${j.schedule}]  ${j.verdict}`);
    console.log(
      `    ${out.windowHours}h: ${j.runs} runs, ${j.succeeded} succeeded, ` +
        `${j.scopeDenied} scope-denied, ${j.otherFailures} other`,
    );
    if (j.deliveryMetric) {
      console.log(
        `    delivery: ${j.delivered} x ${j.deliveryMetric} across ` +
          `${j.sendOpportunities} scheduled send ` +
          `opportunit${j.sendOpportunities === 1 ? "y" : "ies"}`,
      );
      console.log(
        "    NOTE: time-gated job — succeeded rows are hour-gate no-ops, not posts.",
      );
    }
    if (j.latestError) console.log(`    latest error: ${j.latestError}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const wIdx = argv.indexOf("--window-hours");
  const windowHours = wIdx >= 0 ? Number(argv[wIdx + 1]) : DEFAULT_WINDOW_HOURS;
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    refuse("--window-hours must be a positive number.");
  }

  const cmd = process.env.DISCORD_JOB_HEALTH_SOURCE_CMD;
  const src = cmd ? readSourceFromCmd(cmd, windowHours) : await readSourceFromDb(windowHours);
  if (cmd && src.windowHours == null) src.windowHours = windowHours;

  const out = score(src);

  if (json) console.log(JSON.stringify(out, null, 2));
  else render(out);

  // A window that could not contain a send is a refusal, not a pass.
  if (out.jobs.some((j) => j.verdict === "UNMEASURED")) {
    console.error(
      "UNKNOWN: the window contained no scheduled send opportunity for a gated job. " +
        "Nothing measured.",
    );
    process.exit(5);
  }
  const broken = out.jobs.filter(
    (j) => j.verdict === "FAILING" || j.verdict === "NOT_DELIVERED",
  ).length;
  process.exit(broken > 0 ? 1 : 0);
}

main().catch((err) => refuse(err && err.message ? err.message : String(err)));
