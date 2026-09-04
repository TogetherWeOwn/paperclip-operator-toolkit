#!/usr/bin/env node
// ===========================================================================
// grant_attribution.js — answer "who granted this permission?" for every row
// in principal_permission_grants. (TOG-870.)
// ---------------------------------------------------------------------------
// WHY THIS EXISTS, AND WHY IT IS ARITHMETIC RATHER THAN A JUDGEMENT.
//
// `principal_permission_grants` has exactly one attribution column,
// `granted_by_user_id`, and it is USER-typed. `server/src/routes/agents.ts`
// writes it as:
//
//     req.actor.type === "board" ? (req.actor.userId ?? null) : null
//
// so an agent-made grant is deliberately stored as null. Measured on this
// company: 9 of 131 rows name a grantor. TOG-870 concluded from that number
// that the remaining 122 grantors were "not recoverable from this table" and
// that attribution therefore depended on the granting agent volunteering it
// in prose on a findable card.
//
// THAT CONCLUSION WAS WRONG, and it was wrong because it read one table.
// `activity_log` carries an `agent.permissions_updated` row written on the
// same code path, and it DOES record `actor_type`/`actor_id`. Joining the two
// recovers 97 of the 122. The grantor was never missing; it was one join away.
//
// This file is that join, written down. It is a script rather than a runbook
// paragraph because the answer must not change with whoever is asked.
//
//   node scripts/grant_attribution.js             # human table
//   node scripts/grant_attribution.js --json      # machine output
//   node scripts/grant_attribution.js --all-companies
//   node scripts/grant_attribution.js --selftest  # offline, no DB
//
// Exit codes: 0 fully attributed, 1 unattributable rows found,
//             2 usage/error, 5 COULD NOT MEASURE.
//
// ---------------------------------------------------------------------------
// EXIT 5 EXISTS AND IT IS THE MOST IMPORTANT CODE HERE.
//
// This tool's failure mode is silence in the WRONG DIRECTION. If the
// `activity_log` read comes back empty — a mis-scoped query returns zero rows
// rather than an error — then every grant resolves to `unattributable` and the
// tool reports a catastrophe that is really an empty read. If the GRANT read
// comes back empty, it reports "0 unattributable of 0" and exits 0: a perfect
// audit derived from having looked at nothing.
//
// The second is the dangerous one, because it is green. Both refuse with 5.
//
// ---------------------------------------------------------------------------
// WHY DERIVED ATTRIBUTION IS NEVER WRITTEN BACK, AND NEVER PRESENTED AS DIRECT.
//
// A derived grantor is an inference from a timestamp join. It is strong here —
// see the window note below — but it is not the same fact as a column the
// server wrote on purpose. Reporting the two as one number is how an audit
// trail starts lying with confidence. So every row carries its `source`
// (`direct` | `derived` | `unattributable`), the renderer prints the three
// counts separately, and nothing in this file writes to the database at all:
// the connection sets `default_transaction_read_only = on` before it queries,
// so a future edit that adds an UPDATE fails at the statement.
//
// Backfilling the null column from this join was considered and rejected. It
// would convert an inference into an indistinguishable fact, which is strictly
// worse than a null — the null at least tells the truth about what is known.
//
// ---------------------------------------------------------------------------
// THE WINDOW IS NOT TUNED, AND THAT IS THE POINT.
//
// The join is keyed on the AGENT (`activity_log.entity_id = grant.principal_id`)
// and only then filtered by time. The window exists to reject a grant being
// matched to a permissions edit made days later, not to disambiguate — the
// agent key already does that.
//
// Measured on this company, 2026-09-03, across ±0.5s / ±1s / ±2s / ±5s / ±15s
// / ±60s / ±300s: 97 derived and ZERO ambiguous at every width. Observed |Δt|
// was min 0.007s, median 0.139s, max 0.283s. A result that is identical across
// three orders of magnitude is not a fitted parameter.
//
// AMBIGUITY IS A REFUSAL, NOT A COIN FLIP. If two DIFFERENT actors appear in
// one grant's window, that row is reported `ambiguous` and counted as
// unattributable. Picking the nearest timestamp would silently manufacture an
// attribution, and a wrong grantor in an audit log is worse than a known gap.
//
// ---------------------------------------------------------------------------
// THE COMPANY FILTER IS MANDATORY. Both tables span every company on this
// host. An unscoped read would attribute our grants using another company's
// activity rows, and agent ids are valid keys there too — the join would
// succeed and be wrong. `--all-companies` is deliberate and opt-in.
// ===========================================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// The activity actions that accompany a grant write. `agent.permissions_updated`
// is the main path (routes/agents.ts); `agent.created` and
// `built_in_agent.provisioned` cover grants applied at creation time.
const GRANT_ACTIONS = [
  "agent.permissions_updated",
  "agent.created",
  "built_in_agent.provisioned",
];

// Seconds. See the window note above — this is a sanity bound, not a tuned
// parameter. Widening it by two orders of magnitude changes nothing measured.
const WINDOW_SECONDS = 2;

// ---------------------------------------------------------------------------
// The pure core. `grants` and `activity` are plain arrays so the suite can
// drive every branch without a database.
// ---------------------------------------------------------------------------
function attribute(grants, activity) {
  const byPrincipal = new Map();
  for (const row of activity) {
    if (!GRANT_ACTIONS.includes(row.action)) continue;
    if (!byPrincipal.has(row.entityId)) byPrincipal.set(row.entityId, []);
    byPrincipal.get(row.entityId).push(row);
  }

  return grants.map((g) => {
    // A grantor the server wrote on purpose always wins. Deriving one for a
    // row that already names its grantor would let the join overrule the
    // record it is supposed to be corroborating.
    if (g.grantedByUserId) {
      return {
        ...g,
        source: "direct",
        actorType: "user",
        actorId: g.grantedByUserId,
        deltaSeconds: null,
      };
    }

    const at = new Date(g.createdAt).getTime();
    const candidates = (byPrincipal.get(g.principalId) || [])
      .map((row) => ({ row, delta: (new Date(row.createdAt).getTime() - at) / 1000 }))
      .filter((c) => Math.abs(c.delta) <= WINDOW_SECONDS)
      .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));

    if (candidates.length === 0) {
      return { ...g, source: "unattributable", reason: "no-activity", actorType: null, actorId: null, deltaSeconds: null };
    }

    // Two different actors in one window means the join cannot tell who did
    // it. Reporting the nearest would invent an attribution.
    const actors = new Set(candidates.map((c) => `${c.row.actorType}:${c.row.actorId}`));
    if (actors.size > 1) {
      return {
        ...g,
        source: "unattributable",
        reason: "ambiguous",
        actorType: null,
        actorId: null,
        deltaSeconds: null,
        candidates: [...actors],
      };
    }

    const best = candidates[0];
    return {
      ...g,
      source: "derived",
      actorType: best.row.actorType,
      actorId: best.row.actorId,
      viaAction: best.row.action,
      runId: best.row.runId || null,
      deltaSeconds: Number(best.delta.toFixed(3)),
    };
  });
}

// A self-grant is a principal that granted a permission to ITSELF. This is the
// charter metric "no request decided by its own requester", evaluated against
// the table rather than against prose. Only an agent actor can be a self-grant:
// a board user granting an agent is a different principal by construction.
function selfGrants(rows) {
  return rows.filter((r) => r.actorType === "agent" && r.actorId === r.principalId);
}

function buildReport(doc) {
  const grants = Array.isArray(doc.grants) ? doc.grants : [];
  const activity = Array.isArray(doc.activity) ? doc.activity : [];
  const rows = attribute(grants, activity);
  const of = (s) => rows.filter((r) => r.source === s);
  const unattributable = of("unattributable");
  return {
    checked: grants.length,
    activityKnown: activity.filter((a) => GRANT_ACTIONS.includes(a.action)).length,
    direct: of("direct").length,
    derived: of("derived").length,
    unattributable: unattributable.length,
    ambiguous: unattributable.filter((r) => r.reason === "ambiguous").length,
    selfGrants: selfGrants(rows),
    unattributableRows: unattributable,
    derivedRows: of("derived"),
    rows,
  };
}

function verdictFor(report) {
  // Nothing to attribute is "could not measure", never "all attributed".
  if (report.checked === 0) {
    return {
      verdict: "UNKNOWN",
      code: 5,
      reason:
        "read ZERO grant rows. An empty grant table is not a clean audit — it is a " +
        "mis-scoped or failed read. Refusing to report attribution coverage.",
    };
  }
  // The mirror failure: an empty activity read makes every row look anonymous.
  if (report.activityKnown === 0) {
    return {
      verdict: "UNKNOWN",
      code: 5,
      reason:
        "read ZERO grant-bearing activity_log rows, so every grant would resolve as " +
        "unattributable regardless of the truth. Refusing to report a false catastrophe.",
    };
  }
  // A self-grant is the separation-of-duties breach this office exists to catch.
  if (report.selfGrants.length > 0) {
    return {
      verdict: "SELF-GRANT",
      code: 1,
      reason: `${report.selfGrants.length} grant(s) were made by the principal that received them.`,
    };
  }
  if (report.unattributable > 0) {
    return {
      verdict: "UNATTRIBUTED",
      code: 1,
      reason: `${report.unattributable} of ${report.checked} grants cannot name a grantor.`,
    };
  }
  return { verdict: "ATTRIBUTED", code: 0, reason: `all ${report.checked} grants name a grantor.` };
}

function short(id) {
  return id ? String(id).slice(0, 8) : "(none)";
}

function render(report, v) {
  const out = [];
  out.push(`Grant attribution: ${report.checked} grants, ${report.activityKnown} grant-bearing activity rows`);
  out.push("");
  out.push(`  direct   (granted_by_user_id) ${report.direct}`);
  out.push(`  derived  (activity_log join)  ${report.derived}`);
  out.push(`  unattributable                ${report.unattributable}${report.ambiguous ? ` (${report.ambiguous} ambiguous)` : ""}`);
  out.push("");

  if (v.code === 5) {
    out.push(`UNKNOWN: ${v.reason}`);
    return out.join("\n");
  }

  // Self-grants first: it is the finding that matters most and must never be
  // scrolled past under a long list of merely-anonymous rows.
  if (report.selfGrants.length > 0) {
    out.push("SELF-GRANTS — a principal granted itself a permission:");
    for (const r of report.selfGrants) {
      out.push(`  ${short(r.principalId)} granted ITSELF ${r.permissionKey}  (${r.createdAt})`);
    }
    out.push("");
  }

  if (report.unattributable > 0) {
    out.push(`UNATTRIBUTABLE grants: ${report.unattributable} of ${report.checked}`);
    for (const r of report.unattributableRows.slice(0, 40)) {
      const why = r.reason === "ambiguous" ? `ambiguous: ${(r.candidates || []).join(" , ")}` : "no activity_log row";
      out.push(`  ${r.createdAt}  ${short(r.principalId)}  ${r.permissionKey}  [${why}]`);
    }
    if (report.unattributableRows.length > 40) {
      out.push(`  ... and ${report.unattributableRows.length - 40} more`);
    }
    out.push("");
  } else {
    out.push("No unattributable grants.");
    out.push("");
  }

  // Derived rows are printed as derived. An operator must be able to see which
  // attributions are inferences without opening the JSON.
  if (report.derived > 0) {
    const byActor = {};
    for (const r of report.derivedRows) {
      const k = `${r.actorType}:${short(r.actorId)}`;
      byActor[k] = (byActor[k] || 0) + 1;
    }
    out.push("Derived attribution (inferred from activity_log, NOT written back):");
    for (const [k, n] of Object.entries(byActor).sort((a, b) => b[1] - a[1])) {
      out.push(`  ${k}  ${n}`);
    }
    out.push("");
  }

  out.push(`${v.verdict}: ${v.reason}`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Offline selftest. Covers the pure core only; the suite covers the pipeline.
// ---------------------------------------------------------------------------
function selftest() {
  const AG = "aaaaaaaa-1111-2222-3333-444444444444";
  const BG = "bbbbbbbb-1111-2222-3333-444444444444";
  const CEO = "cccccccc-1111-2222-3333-444444444444";
  // A SYNTHETIC board-user id, deliberately not the real one. Nothing here
  // needs the true value, and a real principal identifier in a fixture is a
  // detail about this installation that a public repo does not need to carry.
  const USER = "UsRxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const T = "2026-09-03T07:18:00.000Z";
  const at = (ms) => new Date(Date.parse(T) + ms).toISOString();

  const grant = (principalId, key, gbu, when) => ({
    principalId, permissionKey: key, grantedByUserId: gbu || null, createdAt: when || T,
  });
  const act = (entityId, actorType, actorId, when, action) => ({
    entityId, actorType, actorId, createdAt: when || T,
    action: action || "agent.permissions_updated", runId: null,
  });

  let pass = 0, total = 0;
  const check = (label, got, want) => {
    total++;
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++;
    console.log(`${ok ? "ok  " : "FAIL"} want=${JSON.stringify(want)} got=${JSON.stringify(got)}  ${label}`);
  };

  // A row the server attributed itself is `direct`, and the join must not
  // overrule it even when an activity row sits right beside it.
  let r = attribute([grant(AG, "tasks:assign", USER)], [act(AG, "agent", CEO)]);
  check("granted_by_user_id wins over the join", [r[0].source, r[0].actorId], ["direct", USER]);

  // The TOG-870 shape: an agent-made grant, null column, recovered from
  // activity_log 9ms later. This is the case the card said was impossible.
  r = attribute([grant(AG, "tasks:assign", null)], [act(AG, "agent", CEO, at(9))]);
  check("agent grant recovered from activity_log", [r[0].source, r[0].actorType, r[0].actorId], ["derived", "agent", CEO]);

  // No activity row at all — the org_provisioner.sh direct-INSERT shape.
  r = attribute([grant(AG, "agents:configure", null)], []);
  check("a grant with no activity row is unattributable", [r[0].source, r[0].reason], ["unattributable", "no-activity"]);

  // Two different actors in one window: refuse rather than pick the nearest.
  r = attribute([grant(AG, "tasks:assign", null)], [act(AG, "agent", CEO, at(10)), act(AG, "user", USER, at(20))]);
  check("two actors in the window -> ambiguous, not nearest-wins", [r[0].source, r[0].reason], ["unattributable", "ambiguous"]);

  // The SAME actor twice must NOT read as ambiguous, or a double-logged write
  // would turn a perfectly attributed grant into a finding.
  r = attribute([grant(AG, "tasks:assign", null)], [act(AG, "agent", CEO, at(10)), act(AG, "agent", CEO, at(20))]);
  check("the same actor logged twice is not ambiguous", [r[0].source, r[0].actorId], ["derived", CEO]);

  // The join is keyed on the agent: another agent's activity must never
  // attribute this grant, however close in time it lands.
  r = attribute([grant(AG, "tasks:assign", null)], [act(BG, "agent", CEO, at(5))]);
  check("another agent's activity does not attribute this grant", r[0].source, "unattributable");

  // Outside the window is not a match. Without this a permissions edit made
  // days later would be read as the grantor of an unrelated row.
  r = attribute([grant(AG, "tasks:assign", null)], [act(AG, "agent", CEO, at(30000))]);
  check("an activity row outside the window does not match", r[0].source, "unattributable");

  // An unrelated action in the window must not attribute a grant.
  r = attribute([grant(AG, "tasks:assign", null)], [act(AG, "agent", CEO, at(9), "issue.updated")]);
  check("an unrelated action does not attribute a grant", r[0].source, "unattributable");

  // Creation-time grants come through a different action name.
  r = attribute([grant(AG, "skills:suggest-changes", null)], [act(AG, "system", "built-in", at(9), "built_in_agent.provisioned")]);
  check("built_in_agent.provisioned attributes a creation grant", [r[0].source, r[0].actorType], ["derived", "system"]);

  // The charter metric. A principal appearing as its own grantor is the
  // separation-of-duties breach, and it must outrank a merely-anonymous row.
  const sg = buildReport({
    grants: [grant(AG, "tasks:assign", null)],
    activity: [act(AG, "agent", AG, at(9))],
  });
  check("a self-grant is detected", sg.selfGrants.length, 1);
  check("...and outranks UNATTRIBUTED in the verdict", verdictFor(sg).verdict, "SELF-GRANT");

  // A board user granting an agent is NOT a self-grant even when the ids
  // line up nowhere — the control must not fire on every ordinary grant.
  const ok2 = buildReport({ grants: [grant(AG, "tasks:assign", null)], activity: [act(AG, "user", USER, at(9))] });
  check("a user granting an agent is not a self-grant", ok2.selfGrants.length, 0);

  // The two refusals.
  check("zero grants -> UNKNOWN", verdictFor(buildReport({ grants: [], activity: [act(AG, "agent", CEO)] })).code, 5);
  check("zero activity -> UNKNOWN", verdictFor(buildReport({ grants: [grant(AG, "x", null)], activity: [] })).code, 5);
  // ...and the control: a fully attributed board is green.
  check("a fully attributed board is ATTRIBUTED", verdictFor(ok2).verdict, "ATTRIBUTED");

  console.log(`\nselftest ${pass}/${total}`);
  return pass === total ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Database read. Same loader and same read-only assertion as pg_source.js: the
// `pg` version is pinned by the server's pnpm store, so a server upgrade must
// not turn this into "cannot find module".
// ---------------------------------------------------------------------------
function loadPg() {
  const roots = [process.env.PAPERCLIP_PG_MODULE, "/app/node_modules/pg"].filter(Boolean);
  for (const r of roots) {
    try { return require(r); } catch { /* keep looking */ }
  }
  const store = "/app/node_modules/.pnpm";
  let entries = [];
  try { entries = fs.readdirSync(store); } catch { /* no store */ }
  for (const c of entries
    .filter((e) => /^pg@\d/.test(e))
    .sort()
    .reverse()
    .map((e) => path.join(store, e, "node_modules", "pg"))) {
    try { return require(c); } catch { /* keep looking */ }
  }
  return null;
}

async function readFromDatabase(allCompanies) {
  const pg = loadPg();
  if (!pg) throw new Error("cannot load the 'pg' module. Set PAPERCLIP_PG_MODULE to its directory.");
  const company = process.env.PAPERCLIP_COMPANY_ID;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // This tool must never write. Saying so to the database is cheaper and far
    // more durable than a comment claiming it.
    await client.query("SET default_transaction_read_only = on");
    const scope = allCompanies ? "" : " and company_id = $1";
    const args = allCompanies ? [] : [company];
    const grants = await client.query(
      `select id, created_at, principal_type, principal_id, permission_key, scope, granted_by_user_id
         from principal_permission_grants
        where true` + scope + " order by created_at",
      args
    );
    const activity = await client.query(
      `select created_at, action, actor_type, actor_id, entity_id, run_id
         from activity_log
        where entity_type = 'agent' and action = any($${args.length + 1})` + scope,
      [...args, GRANT_ACTIONS]
    );
    return {
      grants: grants.rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at.toISOString(),
        principalType: r.principal_type,
        principalId: r.principal_id,
        permissionKey: r.permission_key,
        scope: r.scope,
        grantedByUserId: r.granted_by_user_id,
      })),
      activity: activity.rows.map((r) => ({
        createdAt: r.created_at.toISOString(),
        action: r.action,
        actorType: r.actor_type,
        actorId: r.actor_id,
        entityId: r.entity_id,
        runId: r.run_id,
      })),
    };
  } finally {
    await client.end();
  }
}

// The offline seam, same shape as STALE_DESCRIPTOR_SOURCE_CMD. It is what lets
// CI run this at all: GitHub Actions has no database.
function readFromSourceCmd(cmd) {
  const raw = execSync(cmd, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(raw);
}

function fail(msg, code) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

async function main() {
  const argv = process.argv.slice(2);
  for (const a of argv) {
    if (!["--json", "--all-companies", "--selftest"].includes(a)) {
      fail(`unknown argument: ${a}\nusage: grant_attribution.js [--json] [--all-companies] [--selftest]`, 2);
    }
  }
  if (argv.includes("--selftest")) process.exit(selftest());

  const allCompanies = argv.includes("--all-companies");
  const asJson = argv.includes("--json");
  const sourceCmd = process.env.GRANT_ATTRIBUTION_SOURCE_CMD;

  let doc;
  if (sourceCmd) {
    doc = readFromSourceCmd(sourceCmd);
  } else {
    if (!process.env.DATABASE_URL) {
      fail("DATABASE_URL is not set. Use --selftest for the offline checks, or set GRANT_ATTRIBUTION_SOURCE_CMD.", 2);
    }
    if (!allCompanies && !process.env.PAPERCLIP_COMPANY_ID) {
      fail(
        "PAPERCLIP_COMPANY_ID is not set. Set it, or pass --all-companies deliberately: " +
          "both tables span every company on this host, and an unscoped read would " +
          "attribute our grants using another company's activity rows.",
        2
      );
    }
    doc = await readFromDatabase(allCompanies);
  }

  const report = buildReport(doc);
  const v = verdictFor(report);
  if (asJson) {
    const { rows, ...rest } = report;
    console.log(JSON.stringify({ verdict: v.verdict, reason: v.reason, ...rest }, null, 2));
  } else {
    console.log(render(report, v));
  }
  process.exit(v.code);
}

if (require.main === module) {
  main().catch((e) => {
    // Exit 2, never 0. An exception mid-read must not be indistinguishable
    // from a fully attributed board.
    fail(`grant attribution failed: ${e && e.message ? e.message : e}`, 2);
  });
}

module.exports = { attribute, buildReport, verdictFor, selfGrants, GRANT_ACTIONS, WINDOW_SECONDS };
