#!/usr/bin/env node
// ===========================================================================
// parked_backlog_guard.js — list backlog cards that carry a deliberate,
// agent-authored park rationale, so an idle-agent sweep can skip them. (TOG-3465.)
// ---------------------------------------------------------------------------
// WHY THIS EXISTS.
//
// The idle-agent sweep promotes cards from `backlog` to `todo` with the
// generic comment `Operator ... (owner: "get work moving") — promoted from
// backlog to todo; agents are idle and this is assigned to you`. It does not
// distinguish a card that is genuinely queued from one an agent deliberately
// parked with a documented rationale (e.g. the CTO burn-cap park under
// TOG-3240). Measured 2026-09-17→20: TOG-3230 reactivated 3+ times and
// TOG-3303 four times, each run ending in the same revert-to-backlog
// decision with zero product work — burning exactly the non-product run
// budget the cap was created to reduce.
//
// Detector-only delivery is the explicit TOG-3728 plan-revision-2 scope.
// The real sweep has no established authorized read-path (TOG-3742/3747).
// This tool never patches status, grants promotion, or automatically unparks.
// Caller integration is unsupplied, not simulated by a wrapper.
//
// WHY PARK EVIDENCE SURVIVES UNRELATED COMMENTS.
//
// A newer comment is not a scheduling decision. Preserve any non-deleted
// agent park rationale, and check the description independently of who
// last commented. This conservative prose detector never treats a generic
// sweep note or progress update as authority to lift an existing park.
//
// GET /api/issues/{id}/activity DOES expose status transitions, including
// actorType, actorId and details.changes.status.{from,to}. This reader does
// not consume that feed. Its pagination/retention completeness is unverified.
// A user actor alone does not prove an explicit unpark: automated promotions
// use the same actor. Unpark requires an explicit human/CTO-authored decision
// on the parking-authority card, checked separately by the responsible agent.
// Neither runId=null nor allow_board_actor verifies that decision. This tool
// deliberately has no unpark override; documented parks are retained.
//
// RESIDUAL RISK, STATED RATHER THAN HIDDEN: this sniffs descriptive prose,
// so an agent who parks a card using none of PARK_MARKERS' words is missed
// unless a caller applies a stronger scheduling gate. Conversely a queued
// card whose thread merely *mentions* parking in an agent comment reads as
// parked. This detector cannot establish unpark authority; a scheduling
// integration must supply that decision. Every parked row quotes evidence.
//
// WHY USER-AUTHORED PARK PROSE DOES NOT COUNT.
//
// The heuristic's signal is *agent-authored* intent: an agent moving its own
// card to backlog with a rationale is a scheduling decision by the card's
// owner. Operator/owner prose about parking is routing discussion, not the
// park itself — counting it would let a sweep's own commentary ("this was
// parked, picking it up") self-exempt or self-target cards.
//
//   node scripts/parked_backlog_guard.js            # human table
//   node scripts/parked_backlog_guard.js --json     # machine output
//   node scripts/parked_backlog_guard.js --selftest # offline, no DB
//
// Exit codes: 0 no park signal in supplied evidence (NOT promotion approval),
// 1 park signal found, 2 usage error, 5 COULD NOT MEASURE.
// All machine reports include promotionAuthorized=false, even on exit 0.
//
// ---------------------------------------------------------------------------
// EXIT 5 EXISTS AND IT IS THE MOST IMPORTANT CODE HERE.
//
// This detector's failure mode is silence. If the comment read comes back
// empty, EVERY card classifies `queuable` and the tool reports a clean
// candidate set having looked at nothing. The same is true of an empty
// backlog list. Both refuse with 5 instead. A check that measured nothing
// must never read green; that rule is why this repo has a mutation gate on
// every detector.
//
// ---------------------------------------------------------------------------
// THE COMPANY FILTER IS MANDATORY, AND IT WAS LEARNED THE EXPENSIVE WAY.
//
// `issues` spans every company on this host. An unscoped sweep reports cards
// you cannot even GET. Interactions taught us this first (stale_descriptor_
// sweep.js); the same predicate applies here.
// ===========================================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Descriptive-prose markers, matched case-insensitively as substrings.
// "parked" covers "Parked to backlog", "re-parked", "deliberately parked";
// "unpark" covers "unpark requires the CTO to say so" (TOG-3303's shape);
// "why backlog" covers a description section explaining the parked state.
// Topic words (non-product, burn cap, lane optimization) alone are not parks.
const PARK_MARKERS = [
  "parked",
  "re-park",
  "repark",
  "why backlog",
  "unpark",
];

// ---------------------------------------------------------------------------
// THE PURE CORE. No database, no clock, no environment — so the logic is
// testable offline and the mutation gate can reach every limb of it.
// ---------------------------------------------------------------------------
function findMarkers(text) {
  const lower = (text || "").toLowerCase();
  return PARK_MARKERS.filter((m) => lower.includes(m));
}

// Newest non-deleted comment wins. The input is already newest-first from
// the database read; fixtures pass arrays in the same order.
function newestComment(comments) {
  const rows = (comments || []).filter((c) => c && !c.deletedAt);
  return rows.length > 0 ? rows[0] : null;
}

function classify(card, comments) {
  const newest = newestComment(comments);
  for (const comment of comments || []) {
    if (!comment || comment.deletedAt || comment.authorType !== "agent") continue;
    const markers = findMarkers(comment.body);
    if (markers.length > 0) {
      return {
        verdict: "parked",
        evidence: "comment",
        markers,
        quote: (comment.body || "").slice(0, 200),
        commentId: comment.id || null,
      };
    }
  }
  // Description evidence survives both agent progress notes and operator
  // sweep notes. Neither is proof that the parking decision was lifted.
  const descMarkers = findMarkers(card && card.description);
  if (descMarkers.length > 0) {
    return {
      verdict: "parked",
      evidence: "description",
      markers: descMarkers,
      quote: (card.description || "").slice(0, 200),
      commentId: null,
    };
  }
  return {
    verdict: "queuable", evidence: null, markers: [], quote: null,
    commentId: newest && newest.id || null,
    ...(newest && newest.authorType === "agent" ? { note: "recent-agent-touch" } : {}),
  };
}

// ---------------------------------------------------------------------------
// Report building. Separated from I/O so the suite can drive the whole
// pipeline — read, classify, verdict, exit code — through a fixture.
// ---------------------------------------------------------------------------
function buildReport(doc) {
  const backlog = Array.isArray(doc && doc.backlog) ? doc.backlog : [];
  const allComments = Array.isArray(doc && doc.comments) ? doc.comments : [];
  const unknown = [];
  if (!doc || !Array.isArray(doc.backlog) || !Array.isArray(doc.comments)) {
    unknown.push("source must contain backlog and comments arrays");
  }

  const byIssue = new Map();
  for (const c of allComments) {
    const key = c && (c.issueIdentifier || c.issueId);
    if (typeof key !== "string" || !key || typeof c.body !== "string" ||
        !["agent", "user", "system"].includes(c.authorType) ||
        (c.authorType === "agent" && !c.authorAgentId) ||
        !c.createdAt || !Number.isFinite(new Date(c.createdAt).getTime())) {
      unknown.push("malformed comment evidence");
      continue;
    }
    if (!byIssue.has(key)) byIssue.set(key, []);
    byIssue.get(key).push(c);
  }
  // Newest first per issue, so `newestComment` just takes element zero.
  for (const rows of byIssue.values()) {
    rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  const parked = [];
  const touched = [];
  const seen = new Set();
  for (const card of backlog) {
    const key = card && (card.identifier || card.id);
    if (typeof key !== "string" || !key || seen.has(key) ||
        !(card.description == null || typeof card.description === "string")) {
      unknown.push("malformed or duplicate backlog candidate");
      continue;
    }
    seen.add(key);
    const comments = byIssue.get(key) || [];
    // A different card's comments must never disguise an empty read here.
    // Until the reader supplies explicit per-card completeness, skip it.
    if (!comments.some((c) => !c.deletedAt)) {
      unknown.push(`${key}: no non-deleted comment evidence`);
      continue;
    }
    const res = classify(card, comments);
    const entry = {
      issue: card.identifier || card.id,
      assigneeAgentId: card.assigneeAgentId || null,
      evidence: res.evidence,
      markers: res.markers,
      quote: res.quote,
    };
    if (res.verdict === "parked") parked.push(entry);
    else if (res.note === "recent-agent-touch") touched.push(entry);
  }
  return {
    mode: "detector-only",
    promotionAuthorized: false,
    schedulingEvidence: "not-verified",
    checked: backlog.length,
    commentsKnown: allComments.length,
    parked,
    touched,
    unknown,
  };
}

// Returns an exit code. `unmeasurable` is a first-class outcome, not an error.
function verdictFor(report) {
  if (report.unknown && report.unknown.length > 0) {
    return { code: 5, verdict: "UNKNOWN", reason: report.unknown.join("; ") };
  }
  if (report.checked === 0) {
    return {
      code: 5,
      verdict: "UNKNOWN",
      reason:
        "read ZERO backlog cards. There is nothing to guard, which is not " +
        "the same fact as 'no parked cards'.",
    };
  }
  if (report.commentsKnown === 0) {
    return {
      code: 5,
      verdict: "UNKNOWN",
      reason:
        "read ZERO comments. Every card would classify as 'queuable' and " +
        "this guard would wave the sweep through having looked at nothing.",
    };
  }
  if (report.parked.length > 0) return { code: 1, verdict: "PARKED", reason: "" };
  return { code: 0, verdict: "NO_PARK_SIGNAL", reason: "No park signal in supplied prose; not scheduling authorization." };
}

function render(report, v) {
  const out = ["DETECTOR ONLY — not scheduling authorization; no status changes are made."];
  if (v.code === 5) {
    out.push(`UNKNOWN: could not measure — ${v.reason}`);
    return out.join("\n");
  }
  if (report.parked.length === 0) {
    out.push(
      `No park signal. Checked ${report.checked} backlog cards ` +
        `against ${report.commentsKnown} comments.`
    );
  } else {
    out.push(
      `PARKED backlog cards (sweep must skip): ${report.parked.length} of ${report.checked} backlog cards\n`
    );
    for (const r of report.parked) {
      out.push(`  ${r.issue}${r.assigneeAgentId ? `  (assignee ${r.assigneeAgentId})` : ""}`);
      out.push(`      evidence: ${r.evidence} — markers: ${r.markers.join(", ")}`);
      if (r.quote) out.push(`      quote: "${r.quote}"`);
    }
    out.push(
      `\nEach card above has a prose park signal, not a verified scheduling history. ` +
        `Retain documented parks by default. Unpark requires an explicit human/CTO ` +
        `decision on the parking-authority card, checked separately. ` +
        `A user-actor PATCH, sweep comment or null runId is not that authority.`
    );
  }
  // Printed on every measured run, clean or not. An agent-touched card that
  // is NOT parked is the shape most likely to become parked next, and the
  // sweep reader should see it rather than discover it mid-run.
  if (report.touched.length > 0) {
    out.push(
      `\nAgent-touched but not parked (informational, NOT a failure, ` +
        `${report.touched.length}): newest comment is agent-authored with no ` +
        `park rationale. This is not scheduling authorization.`
    );
    for (const r of report.touched) out.push(`  ${r.issue}`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Offline selftest. Covers the pure core only; the suite covers the pipeline.
// ---------------------------------------------------------------------------
function selftest() {
  const AGENT = { id: "c1", authorType: "agent", authorAgentId: "aaaa", body: "", createdAt: "2026-09-20T05:29:01Z" };
  const OPER = { id: "c2", authorType: "user", authorUserId: "TVLjBoxr", body: "", createdAt: "2026-09-20T05:24:23Z" };
  const withBody = (base, body) => ({ ...base, body });
  const cases = [
    // TOG-3230's shape: agent park comment under the burn cap.
    ["agent park comment", { description: "" },
      [withBody(AGENT, "**Parked to backlog under TOG-3240** (routing/ops non-product burn cap).")],
      "parked"],
    // TOG-3303's newest-comment shape: agent re-park revert.
    ["agent re-park revert", { description: "" },
      [withBody(AGENT, "Still parked under TOG-3240. The 05:24Z operator promotion is the generic sweep.")],
      "parked"],
    // TOG-3303's description shape: rationale in prose, no comments at all.
    ["park rationale in description only", { description: "## Why backlog, not todo\n\nParked per TOG-3240 (CTO non-product burn cap)." },
      [], "parked"],
    // The sweep's own promotion comment is operator prose, not a park.
    ["operator promotion comment", { description: "" },
      [withBody(OPER, 'Operator 2026-09-20 05:30Z (owner: "get work moving") — promoted from backlog to todo; agents are idle.')],
      "queuable"],
    // No comments and no rationale: genuinely queued.
    ["empty thread, plain description", { description: "File the next batch of executable slices." },
      [], "queuable"],
    // Agent-authored but no park rationale: touched, not parked.
    ["agent progress note, no rationale", { description: "" },
      [withBody(AGENT, "Now running the suite plus typecheck.")],
      "queuable"],
    // Case-insensitivity: a shouted park is still a park.
    ["uppercase park prose", { description: "" },
      [withBody(AGENT, "PARKED TO BACKLOG under the burn cap.")],
      "parked"],
    // Authorship is the signal: user prose quoting a park is not a park.
    ["user prose mentioning parked", { description: "" },
      [withBody(OPER, "This was parked before; picking it up now.")],
      "queuable"],
    // This older comment has no park marker; description evidence still
    // survives the newer operator note.
    ["operator note over agent park, rationale in description",
      { description: "Parked per TOG-3240; lane optimization, not active breakage." },
      [withBody(OPER, "Reconciled and back to todo; please resume."),
       withBody({ ...AGENT, createdAt: "2026-09-19T03:02:14Z" }, "Restored status to backlog under TOG-3240.")],
      "parked"],
    // Without description evidence or any recognized agent park marker,
    // the prose detector finds no park (not proof of scheduling authority).
    ["operator note over agent park, no rationale anywhere", { description: "Router accuracy follow-up." },
      [withBody(OPER, "Reconciled and back to todo; please resume."),
       withBody({ ...AGENT, createdAt: "2026-09-19T03:02:14Z" }, "Restored status to backlog.")],
      "queuable"],
  ];
  let pass = 0;
  let total = 0;
  for (const [label, card, comments, want] of cases) {
    const got = classify(card, comments).verdict;
    const ok = got === want;
    total++;
    if (ok) pass++;
    console.log(`${ok ? "ok  " : "FAIL"} want=${want} got=${got}  ${label}`);
  }
  // Evidence source matters: comment evidence must point at the comment,
  // description evidence must say so.
  const evCases = [
    ["comment evidence", { description: "" },
      [withBody(AGENT, "Parked to backlog under the cap.")], "comment"],
    ["description evidence", { description: "Why backlog, not todo: parked under the cap." },
      [], "description"],
  ];
  for (const [label, card, comments, wantEv] of evCases) {
    const got = classify(card, comments);
    const ok = got.verdict === "parked" && got.evidence === wantEv && got.markers.length > 0 && !!got.quote;
    total++;
    if (ok) pass++;
    console.log(`${ok ? "ok  " : "FAIL"} evidence=${wantEv}  ${label}`);
  }
  console.log(`\nselftest ${pass}/${total}`);
  return pass === total ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Database read. Same loader and same read-only assertion as pg_source.js:
// the `pg` version is pinned by the server's pnpm store, so a server upgrade
// must not turn this into "cannot find module".
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
    // more durable than a comment claiming it: a future edit that adds an
    // UPDATE fails at the statement rather than in production.
    await client.query("SET default_transaction_read_only = on");
    const scope = allCompanies ? "" : " and company_id = $1";
    const args = allCompanies ? [] : [company];
    const backlog = await client.query(
      `select identifier, assignee_agent_id, description
         from issues
        where status = 'backlog'
          and hidden_at is null` + scope,
      args
    );
    // Newest-first per issue; deleted comments are not voices.
    // Column names follow liveness_reconciler_source.js (issue_comments:
    // author_type, author_agent_id, author_user_id, body, created_at,
    // deleted_at; issues: description).
    const comments = await client.query(
      `select i.identifier as issue_identifier, c.id, c.author_type, c.author_agent_id,
              c.author_user_id, c.body, c.created_at
         from issue_comments c
         join issues i on i.id = c.issue_id
        where i.status = 'backlog'
          and i.hidden_at is null
          and c.deleted_at is null` + scope.replaceAll("company_id", "i.company_id"),
      args
    );
    return {
      backlog: backlog.rows.map((r) => ({
        identifier: r.identifier,
        assigneeAgentId: r.assignee_agent_id,
        description: r.description,
      })),
      comments: comments.rows.map((r) => ({
        issueIdentifier: r.issue_identifier,
        id: r.id,
        authorType: r.author_type,
        authorAgentId: r.author_agent_id,
        authorUserId: r.author_user_id,
        body: r.body,
        createdAt: r.created_at,
      })),
    };
  } finally {
    await client.end();
  }
}

// The offline seam, same shape as STALE_DESCRIPTOR_SOURCE_CMD. It is what
// lets CI run this detector at all: GitHub Actions has no database.
function readFromSourceCmd(cmd) {
  const raw = execSync(cmd, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"] });
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
      fail(`unknown argument: ${a}\nusage: parked_backlog_guard.js [--json] [--all-companies] [--selftest]`, 2);
    }
  }
  if (argv.includes("--selftest")) process.exit(selftest());

  const allCompanies = argv.includes("--all-companies");
  const asJson = argv.includes("--json");
  const sourceCmd = process.env.PARKED_GUARD_SOURCE_CMD;

  let doc;
  if (sourceCmd) {
    doc = readFromSourceCmd(sourceCmd);
  } else {
    if (!process.env.DATABASE_URL) {
      fail("DATABASE_URL is not set. Use --selftest for the offline checks, or set PARKED_GUARD_SOURCE_CMD.", 2);
    }
    if (!allCompanies && !process.env.PAPERCLIP_COMPANY_ID) {
      fail(
        "PAPERCLIP_COMPANY_ID is not set. Set it, or pass --all-companies deliberately: " +
          "the issues table spans every company on this host and an unscoped sweep " +
          "reports cards you cannot even GET.",
        2
      );
    }
    doc = await readFromDatabase(allCompanies);
  }

  emitReport(buildReport(doc), asJson);
}

function emitReport(report, asJson) {
  const v = verdictFor(report);
  if (asJson) {
    console.log(JSON.stringify({ verdict: v.verdict, reason: v.reason, ...report }, null, 2));
  } else {
    console.log(render(report, v));
  }
  process.exit(v.code);
}

if (require.main === module) {
  main().catch(() => {
    // Source errors can contain credentials, command text or raw evidence.
    // Never echo them. An unavailable/malformed source is not a measured run.
    const report = buildReport(null);
    report.unknown = ["source unavailable or invalid; no scheduling conclusion"];
    emitReport(report, process.argv.includes("--json"));
  });
}

module.exports = { classify, buildReport, verdictFor, render, PARK_MARKERS };
