#!/usr/bin/env node
// ===========================================================================
// stale_descriptor_sweep.js — find blocked issues whose `unblockDescriptor`
// cites an interaction that is no longer pending. (TOG-890.)
// ---------------------------------------------------------------------------
// WHY THIS IS A SCRIPT AND NOT A HEARTBEAT'S JUDGEMENT.
//
// A card parked `blocked` with a descriptor reading "waiting on interaction X"
// is routed as far as any reader can tell. When X is later withdrawn,
// rejected, expired or answered, the descriptor is not updated — and the card
// becomes INVISIBLY STALLED. It still reads as correctly routed, so every
// recovery sweep and every agent who opens it concludes somebody else is
// handling it. Nothing will ever wake it.
//
// That is strictly worse than an unrouted card, because an unrouted card at
// least looks wrong. The only way to see this state is to join the descriptor
// prose against the interaction table, and that is arithmetic, not judgement.
//
// TOG-64 hit the pattern twice inside twenty minutes: its descriptor named
// 483c7140, withdrawn 10:40Z, and the comment announcing the replacement
// 3fe35b14 was itself stale by 10:47Z when that too was withdrawn.
//
//   node scripts/stale_descriptor_sweep.js            # human table
//   node scripts/stale_descriptor_sweep.js --json     # machine output
//   node scripts/stale_descriptor_sweep.js --all-companies
//   node scripts/stale_descriptor_sweep.js --selftest # offline, no DB
//
// Exit codes: 0 clean, 1 stale found, 2 usage/error, 5 COULD NOT MEASURE.
//
// ---------------------------------------------------------------------------
// EXIT 5 EXISTS AND IT IS THE MOST IMPORTANT CODE HERE.
//
// This detector's failure mode is silence. If the interaction list comes back
// empty, EVERY descriptor classifies as `no-citation` and the tool prints
// "no stale descriptors" and exits 0 — a clean bill of health derived from
// having looked at nothing. The same is true of an empty blocked-card list.
// Both refuse with 5 instead. A check that measured nothing must never read
// green; that rule is why this repo has a mutation gate on every detector.
//
// ---------------------------------------------------------------------------
// THE COMPANY FILTER IS MANDATORY, AND IT WAS LEARNED THE EXPENSIVE WAY.
//
// `issues` spans every company on this host. The first version of this sweep
// was unscoped and reported GST-19 — a card in company 3cd875ea that 404s on
// our API. A finding nobody here can act on is worse than no finding: it costs
// a run to chase and teaches the reader to skim the output.
//
// Interactions are read under the SAME scope, so a foreign company's
// interaction id can never mark one of our descriptors live OR stale.
// Measured 2026-09-03: 602 interactions on this host, 466 in this company,
// and zero of our descriptors cite one of the other 136.
//
// ---------------------------------------------------------------------------
// WHY FULL UUIDs ARE MASKED BEFORE THE SHORT-FORM SCAN.
//
// Agents habitually write the 8-char short form in prose ("interaction
// c955b3f5"), so matching only full UUIDs would miss most real citations —
// measured, 8 of 13 cited cards use the short form somewhere.
//
// But `unblockDescriptor` also carries `owner.agentId`, a full UUID, and the
// prose carries git hashes and commit ids that are 8 hex characters. Scanning
// raw text for 8-hex tokens therefore risks a PHANTOM CITATION: an agent id
// whose first 8 characters collide with an interaction id would mark a live
// card stale, or — far worse — a dead card live.
//
// So every full-UUID-shaped span is masked out before the short scan runs.
// An agent id can no longer contribute its own prefix, and a full interaction
// id is already handled by the full pass. Measured on this host: zero agent/
// interaction 8-prefix collisions and zero ambiguous interaction prefixes
// among 466. The mask is what keeps that true when it stops being true.
//
// RESIDUAL RISK, STATED RATHER THAN HIDDEN: a bare 8-hex git hash in prose
// that collides with an interaction prefix is indistinguishable from a
// citation. Nothing masks that. It is reported with matchedAs:"short" so a
// reader can tell which matches were inferred.
//
// ---------------------------------------------------------------------------
// A DESCRIPTOR CITING SEVERAL INTERACTIONS IS STALE ONLY IF NONE IS PENDING.
//
// "X was withdrawn, we are now waiting on Y" is the correct, healthy shape and
// it names a dead interaction on purpose. Requiring every citation to be live
// would report TOG-64's fixed descriptor as broken forever.
//
// ---------------------------------------------------------------------------
// THE ALLOWLIST IS A MARKER, NOT A LIST OF IDS.
//
// TOG-411 is a deliberate dead citation: its descriptor says the cancelled
// interaction must NOT be re-cut, which is a real instruction to a future
// agent and not a defect. A hardcoded id list would rot the moment that card
// closed, and would have to be edited in this repo by somebody who cannot see
// the board.
//
// The marker is an EXACT literal, `[sweep:acknowledged]`, and that is
// deliberate. Sniffing for prose like "do not re-cut" fails OPEN: any agent
// who happens to write that phrase silences the check without knowing the
// check exists. An exact token cannot be typed by accident.
//
// An acknowledged card is still PRINTED, in its own section. It is excluded
// from the exit-1 verdict, never from the report — a detector that silently
// drops findings is the failure this repo keeps re-learning.
//
// ---------------------------------------------------------------------------
// FRAGILE HOSTING — WHY A *LIVE* CITATION CAN STILL BE A FINDING. (TOG-908.)
//
// The sweep above finds descriptors that are ALREADY stale. It cannot see the
// state that produces them, and that state is mechanical rather than accidental.
//
// An interaction lives on exactly one issue. When that issue is marked done or
// cancelled, the platform expires EVERY pending interaction on the thread —
// `expirePendingInteractionsForTerminalIssue`. Deployed, it has THREE call
// sites, so this is not one branch you could route around: the PATCH
// `becameTerminal` branch (`/app/server/dist/routes/issues.js:8057-8059`), the
// same test on the comment-decision path (`:9678-9681`), and a third at
// `:8387`. The stored result is `{outcome: "issue_closed"}`, not a withdrawal.
//
// Nothing notifies the cards that CITE that interaction. They keep a descriptor
// naming a "LIVE ask" that no longer exists, and they read as correctly routed
// to every subsequent reader. Measured 2026-09-03: TOG-814 was marked done at
// 13:42:56.787Z and 9ms later killed ced1cb57 and 2711301f, stranding TOG-64
// and TOG-740 — two cards, neither of which was touched, by one close.
//
// So a descriptor whose live citation is hosted on a DIFFERENT card is not yet
// broken; it is one status transition away from breaking, and the transition
// belongs to somebody else. That is worth seeing BEFORE the fact, because
// afterwards only the citing card's own assignee can repair it (an agent may
// name only itself as `unblockDescriptor.owner`), and they are precisely the
// agent who has no reason to look.
//
// Two grades, and the distinction is the whole point:
//
//   DOOMED   — the citation is still `pending` but its host is ALREADY
//              terminal. This is a real, present defect: the platform expires
//              on the transition, so a pending row on a closed host means the
//              expiry did not reach it. It counts toward the exit-1 verdict.
//
//   FRAGILE  — the citation is `pending` on a live host. Not a defect. It is
//              reported and deliberately does NOT fail the run, because
//              hosting an ask elsewhere is sometimes correct and a detector
//              that cries wolf on 8 healthy cards gets muted within a week.
//
// A self-hosted live citation is the safe shape and is never reported: an ask
// on its own card cannot outlive that card's closure in a way that matters,
// because closing the card closes the question too.
//
// RESIDUAL RISK, STATED RATHER THAN HIDDEN. This grades every pending citation
// in the descriptor, and it cannot tell a card's LIVE routing from an
// informational cross-reference to somebody else's ask. Measured 2026-09-03:
// TOG-740's descriptor correctly names its own self-hosted ask AND mentions
// TOG-64's ask to say "that one is separate, do not merge them" — so it lands
// in the fragile list on the strength of a sentence that is doing the right
// thing. Reading intent out of prose is exactly the judgement this file
// refuses to fake, so the false positive is left visible in the NON-failing
// list rather than suppressed by a heuristic that would fail open elsewhere.
// It is one reason `fragile` must never gate an exit code.
// ===========================================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SHORT_RE = /\b[0-9a-f]{8}\b/gi;

// `pending` and nothing else. `answered`, `accepted` and `rejected` are all
// resolved states: the question has been settled and no further wake will come
// from it, which is exactly the condition that strands the card.
const LIVE_STATUSES = new Set(["pending"]);

const ACK_MARKER = "[sweep:acknowledged]";

// ---------------------------------------------------------------------------
// THE PURE CORE. No database, no clock, no environment — so the logic is
// testable offline and the mutation gate can reach every limb of it.
// ---------------------------------------------------------------------------
function classify(descriptorText, interactions) {
  const text = descriptorText || "";

  const byFull = new Map();
  const byShort = new Map();
  for (const i of interactions) {
    const id = String(i.id).toLowerCase();
    byFull.set(id, i);
    const s = id.slice(0, 8);
    byShort.set(s, (byShort.get(s) || []).concat(i));
  }

  const full = [...new Set((text.match(UUID_RE) || []).map((s) => s.toLowerCase()))]
    .filter((u) => byFull.has(u))
    .map((u) => ({ id: u, status: byFull.get(u).status, matchedAs: "uuid" }));

  // Mask EVERY full-UUID-shaped span, matched or not. See the header: an
  // unmatched UUID is an agent id or a foreign interaction, and its first 8
  // characters must not be able to masquerade as a short-form citation.
  const masked = text.replace(UUID_RE, (m) => " ".repeat(m.length));

  const seenFull = new Set(full.map((f) => f.id));
  const shorts = [...new Set((masked.match(SHORT_RE) || []).map((s) => s.toLowerCase()))]
    .filter((s) => byShort.has(s))
    .flatMap((s) => byShort.get(s))
    .filter((i) => !seenFull.has(String(i.id).toLowerCase()))
    .map((i) => ({ id: String(i.id).toLowerCase(), status: i.status, matchedAs: "short" }));

  const cited = [...full, ...shorts];
  const acknowledged = text.toLowerCase().includes(ACK_MARKER);

  if (cited.length === 0) return { verdict: "no-citation", cited, acknowledged };
  if (cited.some((c) => LIVE_STATUSES.has(c.status))) {
    return { verdict: "live", cited, acknowledged };
  }
  // The marker only ever downgrades a finding that would otherwise be raised.
  // It can never turn a live card into a finding, and it is recorded on the
  // row either way so the report can say why a card was not counted.
  return { verdict: acknowledged ? "acknowledged" : "stale", cited, acknowledged };
}

// Where does a card's LIVE citation live? Pure, and separate from `classify`
// on purpose: staleness is about the interaction's own status, hosting is about
// the STATUS OF A THIRD CARD. Conflating them is how a "live" verdict starts
// silently depending on data the offline suite does not supply.
//
// Returns only entries worth reporting — a self-hosted live citation is the
// safe shape and yields nothing.
function hostingRisks(row, cited, interactions) {
  const byId = new Map(interactions.map((i) => [String(i.id).toLowerCase(), i]));
  const out = [];
  for (const c of cited) {
    if (!LIVE_STATUSES.has(c.status)) continue; // dead citations are the sweep's job
    const it = byId.get(String(c.id).toLowerCase());
    if (!it) continue;
    // `hostIssue` absent means the reader did not supply hosting data. Say
    // nothing rather than guess: an unknown host must never read as self-hosted.
    if (it.hostIssue === undefined || it.hostIssue === null) continue;
    if (row.identifier && it.hostIssue === row.identifier) continue; // self-hosted: safe
    const doomed = ["done", "cancelled"].includes(it.hostStatus);
    out.push({
      id: String(c.id).toLowerCase(),
      hostIssue: it.hostIssue,
      hostStatus: it.hostStatus === undefined ? null : it.hostStatus,
      grade: doomed ? "doomed" : "fragile",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report building. Separated from I/O so the suite can drive the whole
// pipeline — read, classify, verdict, exit code — through a fixture.
// ---------------------------------------------------------------------------
function buildReport(doc) {
  const blocked = Array.isArray(doc && doc.blocked) ? doc.blocked : [];
  const interactions = Array.isArray(doc && doc.interactions) ? doc.interactions : [];

  const stale = [];
  const acknowledged = [];
  const doomed = [];
  const fragile = [];
  for (const row of blocked) {
    const res = classify(JSON.stringify(row.unblockDescriptor), interactions);
    const entry = {
      issue: row.identifier,
      assigneeAgentId: row.assigneeAgentId || null,
      cited: res.cited,
    };
    if (res.verdict === "stale") stale.push(entry);
    else if (res.verdict === "acknowledged") acknowledged.push(entry);

    // Hosting is judged on LIVE citations, so it applies to cards this sweep
    // otherwise passes. A card can be both stale and fragile; report both
    // rather than picking a winner and hiding the other.
    const risks = hostingRisks(row, res.cited, interactions);
    for (const grade of ["doomed", "fragile"]) {
      const hits = risks.filter((r) => r.grade === grade);
      if (hits.length === 0) continue;
      const bucket = grade === "doomed" ? doomed : fragile;
      bucket.push({ issue: row.identifier, assigneeAgentId: row.assigneeAgentId || null, hosts: hits });
    }
  }
  return {
    checked: blocked.length,
    interactionsKnown: interactions.length,
    stale,
    acknowledged,
    doomed,
    fragile,
  };
}

// Returns an exit code. `unmeasurable` is a first-class outcome, not an error.
function verdictFor(report) {
  if (report.interactionsKnown === 0) {
    return {
      code: 5,
      verdict: "UNKNOWN",
      reason:
        "read ZERO interactions. Every descriptor would classify as 'no-citation' " +
        "and this sweep would report a clean board having looked at nothing.",
    };
  }
  if (report.checked === 0) {
    return {
      code: 5,
      verdict: "UNKNOWN",
      reason:
        "read ZERO blocked cards carrying an unblockDescriptor. There is nothing " +
        "to sweep, which is not the same fact as 'no stale descriptors'.",
    };
  }
  if (report.stale.length > 0) return { code: 1, verdict: "STALE", reason: "" };
  // A pending interaction on an already-terminal host is a present defect, not
  // a forecast: the platform expires on the transition, so this row should not
  // exist. It fails the run. `fragile` deliberately does not — see the header.
  if ((report.doomed || []).length > 0) {
    return { code: 1, verdict: "DOOMED-HOST", reason: "" };
  }
  return { code: 0, verdict: "clean", reason: "" };
}

function render(report, v) {
  const out = [];
  if (v.code === 5) {
    out.push(`UNKNOWN: could not measure — ${v.reason}`);
    return out.join("\n");
  }
  if (report.stale.length === 0) {
    out.push(
      `No stale unblock descriptors. Checked ${report.checked} blocked cards ` +
        `against ${report.interactionsKnown} interactions.`
    );
  } else {
    out.push(
      `STALE unblock descriptors: ${report.stale.length} of ${report.checked} blocked cards\n`
    );
    for (const r of report.stale) {
      out.push(`  ${r.issue}${r.assigneeAgentId ? `  (assignee ${r.assigneeAgentId})` : ""}`);
      for (const c of r.cited) out.push(`      cites ${c.id} -> ${c.status} (${c.matchedAs})`);
    }
    out.push(
      `\nEach card above says it is waiting on an interaction that will never ` +
        `resolve. Only the card's own assignee can fix it: an agent may name ` +
        `only itself as unblockDescriptor.owner.`
    );
  }
  // Printed on every run, clean or not. An allowlisted card that has silently
  // stopped being deliberate is the way this tool goes quietly wrong.
  if (report.acknowledged.length > 0) {
    out.push(
      `\nAcknowledged (carry ${ACK_MARKER}, dead citation is deliberate, ` +
        `NOT counted): ${report.acknowledged.length}`
    );
    for (const r of report.acknowledged) {
      out.push(`  ${r.issue}`);
      for (const c of r.cited) out.push(`      cites ${c.id} -> ${c.status} (${c.matchedAs})`);
    }
  }

  const doomed = report.doomed || [];
  const fragile = report.fragile || [];
  if (doomed.length > 0) {
    out.push(
      `\nDOOMED HOST: ${doomed.length} card(s) cite a PENDING interaction whose ` +
        `host issue is already terminal. The platform expires pending interactions ` +
        `when an issue closes, so these rows should not exist — treat the citation ` +
        `as dead and re-cut on a card that stays open.`
    );
    for (const r of doomed) {
      out.push(`  ${r.issue}${r.assigneeAgentId ? `  (assignee ${r.assigneeAgentId})` : ""}`);
      for (const h of r.hosts) {
        out.push(`      cites ${h.id} (pending) hosted on ${h.hostIssue} [${h.hostStatus}]`);
      }
    }
  }
  if (fragile.length > 0) {
    out.push(
      `\nFragile hosting (NOT a failure, ${fragile.length} card(s)): the live ask ` +
        `is hosted on another card. Closing that card auto-expires the ask and ` +
        `nothing notifies the card below.`
    );
    for (const r of fragile) {
      out.push(`  ${r.issue}${r.assigneeAgentId ? `  (assignee ${r.assigneeAgentId})` : ""}`);
      for (const h of r.hosts) {
        out.push(`      cites ${h.id} (pending) hosted on ${h.hostIssue} [${h.hostStatus}]`);
      }
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Offline selftest. Covers the pure core only; the suite covers the pipeline.
// ---------------------------------------------------------------------------
function selftest() {
  const A = "aaaaaaaa-1111-2222-3333-444444444444"; // pending
  const B = "bbbbbbbb-1111-2222-3333-444444444444"; // cancelled
  const C = "cccccccc-1111-2222-3333-444444444444"; // expired
  const D = "dddddddd-1111-2222-3333-444444444444"; // answered
  const ints = [
    { id: A, status: "pending" },
    { id: B, status: "cancelled" },
    { id: C, status: "expired" },
    { id: D, status: "answered" },
  ];
  const cases = [
    ["no interaction mentioned at all", "no-citation"],
    [`waiting on ${A}`, "live"],
    [`waiting on ${B}`, "stale"],
    [`${B} withdrawn, now ${A}`, "live"],
    ["short form cccccccc is dead", "stale"],
    ["short form aaaaaaaa is alive", "live"],
    [`unknown eeeeeeee-1111-2222-3333-444444444444 is not ours`, "no-citation"],
    [`both dead: ${B} and ${C}`, "stale"],
    // `answered` is resolved. A card waiting on an answered question is
    // stranded exactly as hard as one waiting on a withdrawn question.
    [`waiting on ${D}`, "stale"],
    // The mask. This agent id's first 8 characters ARE interaction B's, and
    // without masking it would be read as a citation of a cancelled ask.
    [`{"owner":{"agentId":"bbbbbbbb-9999-9999-9999-999999999999"},"action":"no ask here"}`,
      "no-citation"],
    // ...and the mask must not swallow a real full-form citation next to one.
    [`{"owner":{"agentId":"bbbbbbbb-9999-9999-9999-999999999999"},"action":"waiting on ${A}"}`,
      "live"],
    // The allowlist marker, and the two ways it must NOT behave.
    [`${B} cancelled deliberately, do not re-cut ${ACK_MARKER}`, "acknowledged"],
    [`${B} cancelled deliberately, do not re-cut`, "stale"],
    [`${A} pending ${ACK_MARKER}`, "live"],
  ];
  let pass = 0;
  let total = 0;
  for (const [text, want] of cases) {
    const got = classify(text, ints).verdict;
    const ok = got === want;
    total++;
    if (ok) pass++;
    console.log(`${ok ? "ok  " : "FAIL"} want=${want} got=${got}  ${text.slice(0, 62)}`);
  }

  // Hosting grades. `A` is the pending interaction in every case; only the
  // host it sits on changes.
  const host = (hostIssue, hostStatus) => [
    { id: A, status: "pending", hostIssue, hostStatus },
  ];
  const hostCases = [
    ["self-hosted live ask is safe", { identifier: "TOG-1" }, host("TOG-1", "blocked"), []],
    ["cross-hosted on a live card is fragile", { identifier: "TOG-1" }, host("TOG-2", "in_review"), ["fragile"]],
    ["cross-hosted on a done card is doomed", { identifier: "TOG-1" }, host("TOG-2", "done"), ["doomed"]],
    ["cross-hosted on a cancelled card is doomed", { identifier: "TOG-1" }, host("TOG-2", "cancelled"), ["doomed"]],
    // Unknown hosting must stay silent. A null host that defaulted to
    // "not self" would report every card as fragile the moment a reader
    // stopped supplying the join — a detector that fails loud but WRONG.
    ["unknown host says nothing", { identifier: "TOG-1" }, [{ id: A, status: "pending", hostIssue: null }], []],
    // A dead citation is the sweep's job, never a hosting finding — otherwise
    // one defect would be counted twice under two names.
    ["dead citation is not a hosting finding", { identifier: "TOG-1" },
      [{ id: B, status: "cancelled", hostIssue: "TOG-2", hostStatus: "done" }], []],
  ];
  for (const [label, row, hostInts, want] of hostCases) {
    const cited = classify(`waiting on ${hostInts[0].id}`, hostInts).cited;
    const got = hostingRisks(row, cited, hostInts).map((r) => r.grade);
    const ok = JSON.stringify(got) === JSON.stringify(want);
    total++;
    if (ok) pass++;
    console.log(`${ok ? "ok  " : "FAIL"} want=[${want}] got=[${got}]  ${label}`);
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
    const issues = await client.query(
      `select identifier, assignee_agent_id, unblock_descriptor
         from issues
        where status = 'blocked'
          and unblock_descriptor is not null` + scope,
      args
    );
    // The join carries the HOST issue of each interaction. An interaction lives
    // on exactly one issue, and that issue's closure silently expires it — so
    // the host's identifier and status are what make fragile hosting visible.
    // LEFT join deliberately: an interaction whose host row is out of scope
    // yields a null host, and `hostingRisks` says nothing rather than guessing.
    const ints = await client.query(
      `select ti.id, ti.status, i.identifier as host_issue, i.status as host_status
         from issue_thread_interactions ti
         left join issues i on i.id = ti.issue_id
        where true` + (allCompanies ? "" : " and ti.company_id = $1"),
      args
    );
    return {
      blocked: issues.rows.map((r) => ({
        identifier: r.identifier,
        assigneeAgentId: r.assignee_agent_id,
        unblockDescriptor: r.unblock_descriptor,
      })),
      interactions: ints.rows.map((r) => ({
        id: r.id,
        status: r.status,
        hostIssue: r.host_issue,
        hostStatus: r.host_status,
      })),
    };
  } finally {
    await client.end();
  }
}

// The offline seam, same shape as DISCORD_JOB_HEALTH_SOURCE_CMD. It is what
// lets CI run this detector at all: GitHub Actions has no database.
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
      fail(`unknown argument: ${a}\nusage: stale_descriptor_sweep.js [--json] [--all-companies] [--selftest]`, 2);
    }
  }
  if (argv.includes("--selftest")) process.exit(selftest());

  const allCompanies = argv.includes("--all-companies");
  const asJson = argv.includes("--json");
  const sourceCmd = process.env.STALE_DESCRIPTOR_SOURCE_CMD;

  let doc;
  if (sourceCmd) {
    doc = readFromSourceCmd(sourceCmd);
  } else {
    if (!process.env.DATABASE_URL) {
      fail("DATABASE_URL is not set. Use --selftest for the offline checks, or set STALE_DESCRIPTOR_SOURCE_CMD.", 2);
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

  const report = buildReport(doc);
  const v = verdictFor(report);
  if (asJson) {
    console.log(JSON.stringify({ verdict: v.verdict, reason: v.reason, ...report }, null, 2));
  } else {
    console.log(render(report, v));
  }
  process.exit(v.code);
}

if (require.main === module) {
  main().catch((e) => {
    // Exit 2, never 0. An exception mid-read must not be indistinguishable
    // from a clean board.
    fail(`sweep failed: ${e && e.message ? e.message : e}`, 2);
  });
}

module.exports = { classify, buildReport, verdictFor, render, ACK_MARKER };
