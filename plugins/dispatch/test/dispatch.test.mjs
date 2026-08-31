/**
 * dispatch — test suite (TOG-747, design TOG-706).
 *
 * Run:  node --test test/dispatch.test.mjs
 * (Pass the FILE, not the directory — on Node 24 `node --test test/` resolves
 * `test` as a module specifier and dies before running anything.)
 *
 * Two layers, and the split is forced by the harness rather than chosen:
 *
 *   - The POLICY is tested directly against hand-built populations. It has to
 *     be: createTestHarness's `getOrchestration` returns a hard-coded
 *     `runs: []` and `invocationBlocks: []` (plugin-sdk dist/testing.js:1674),
 *     so the idle rail and the budget rail cannot be reached through runJob at
 *     all. A suite that only drove the harness would report green while never
 *     once executing the two rails this plugin adds.
 *
 *   - The WIRING is tested through the harness: capability enforcement, the
 *     company enumeration, the metric contract, the activity threshold, the
 *     state round-trip, and the wake gate.
 *
 * Where a test can assert against the source of truth instead of a local
 * restatement of it, it does — enumerating from the module's own exported
 * constants is how a deleted counter deletes its own test instead of silently
 * passing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import { manifest } from "../dist/manifest.js";
import {
  BUDGET_RAIL_MIRROR_SOURCE,
  LEGACY_COUNTERS,
  SELECTION_COUNTERS,
  TERMINAL_STATUSES,
  WAKEUP_REFUSED_STATUSES,
  classifyIssue,
  computeIdleMs,
  identifyRoutingOwners,
  isParkedOnNamedOwner,
  selectDispatch,
  spreadAcrossAssignees,
  summariseRoutingGap,
} from "../dist/selection.js";
import {
  METRIC_PREFIX,
  emitMetrics,
  hasStateChanged,
  logStateChange,
  summariseFiring,
} from "../dist/reporting.js";
import { plugin, sweepCompany } from "../dist/worker.js";

const COMPANY = "company-1";
const AGENT_A = "agent-aaaa";
const AGENT_B = "agent-bbbb";
const NOW = Date.parse("2026-08-30T12:00:00.000Z");
const MIN = 60_000;

/** An issue as the policy sees it. Only the fields the rails actually read. */
const issue = (over = {}) => ({
  id: "issue-1",
  identifier: "TOG-1",
  companyId: COMPANY,
  projectId: "project-1",
  status: "in_progress",
  priority: "medium",
  assigneeAgentId: AGENT_A,
  unblockDescriptor: null,
  createdAt: new Date(NOW - 10 * 24 * 60 * MIN).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
  ...over,
});

/** A population entry as the sweep gathers it. */
const entry = (over = {}) => ({
  issue: issue(over.issue),
  blockedBy: over.blockedBy ?? [],
  runs: over.runs ?? [],
  invocationBlock: over.invocationBlock ?? null,
});

const OPTIONS = { idleMinutes: 120, maxWakesPerFiring: 3, focusProjectIds: [], now: NOW };

const classify = (over = {}, idleMinutes = 120) => {
  const e = entry(over);
  return classifyIssue({
    issue: e.issue,
    blockedBy: e.blockedBy,
    invocationBlock: e.invocationBlock,
    idleMinutes,
    idle: computeIdleMs(e.issue, e.runs, NOW),
  });
};

// ───────────────────── the rails, in the server's own order ─────────────────

test("the refused-status list is the server's denylist, not an allowlist of runnable statuses", () => {
  // The first cut of the TOG-706 probe undercounted the wakeable surface by 88%
  // because it enumerated statuses it believed were runnable. The server
  // refuses exactly three; every other status is wakeable BY DEFAULT, including
  // ones that do not exist yet.
  assert.deepEqual(WAKEUP_REFUSED_STATUSES, ["backlog", "done", "cancelled"]);

  for (const status of ["todo", "in_progress", "in_review", "blocked", "a_status_invented_later"]) {
    assert.equal(classify({ issue: { status } }, 0).wakeable, true, `${status} must be wakeable`);
  }
});

test("rail 1 (no assignee) is checked before rail 2 (status), matching the server", () => {
  // An issue that is BOTH unassigned and backlog is refused by the server on
  // the assignee rail, because that is the one it reaches first. Counting it as
  // refused_backlog would put it in the wrong bucket and make the routing gap
  // look smaller than it is.
  const result = classify({ issue: { assigneeAgentId: null, status: "backlog" } });
  assert.equal(result.outcome, "refused_unassigned");
});

test("rail 3 counts a blocker that is not done, and ignores one that is", () => {
  assert.equal(
    classify({ blockedBy: [{ id: "b", status: "in_progress" }] }).outcome,
    "refused_blocked",
  );
  assert.equal(classify({ blockedBy: [{ id: "b", status: "done" }] }, 0).outcome, "actionable");
});

test("rail 4 is mirrored from the server's own verdict, not reimplemented", () => {
  // The value of this rail is that we do not guess the budget rule: the server
  // evaluates budgets.getInvocationBlock inside getOrchestration with
  // byte-identical arguments to the ones requestWakeup uses, and hands back the
  // verdict. If this constant ever stops naming that field, the mirror has been
  // replaced by a local reimplementation and the test should say so.
  assert.equal(BUDGET_RAIL_MIRROR_SOURCE, "issues.summaries.getOrchestration#invocationBlocks");

  const blocked = classify({
    invocationBlock: { issueId: "issue-1", reason: "monthly_budget_exhausted" },
  }, 0);
  assert.equal(blocked.outcome, "refused_budget_block");
  assert.equal(blocked.blockReason, "monthly_budget_exhausted");
});

test("a budget-blocked issue still counts as wakeable, so runnable_queue stays diffable", () => {
  // runnable_queue is the retired script's counter and the fact base's 26.
  // Rail 4 is ours to add; folding it into a legacy counter would make the
  // parallel-week comparison compare two different things while looking like it
  // compared one.
  const selection = selectDispatch(
    [entry({ invocationBlock: { issueId: "issue-1", reason: "cap" } })],
    { ...OPTIONS, idleMinutes: 0 },
  );
  assert.equal(selection.legacy.runnable_queue, 1);
  assert.equal(selection.budgetBlocked.length, 1);
  assert.equal(selection.picks.length, 0);
  for (const name of SELECTION_COUNTERS) {
    assert.equal(selection.counters[name], 0, `${name} must not absorb the budget rail`);
  }
});

test("terminal issues are excluded from the counted population entirely", () => {
  for (const status of TERMINAL_STATUSES) {
    assert.equal(classify({ issue: { status } }).outcome, "excluded_terminal");
  }
  const selection = selectDispatch(
    [entry({ issue: { id: "a", status: "done" } }), entry({ issue: { id: "b" } })],
    { ...OPTIONS, idleMinutes: 0 },
  );
  assert.equal(selection.excludedTerminal, 1);
  assert.equal(selection.legacy.runnable_queue, 1);
});

test("the counters partition the population — every issue lands in exactly one", () => {
  const population = [
    entry({ issue: { id: "unassigned", assigneeAgentId: null } }),
    entry({ issue: { id: "backlog", status: "backlog" } }),
    entry({ issue: { id: "blocked" }, blockedBy: [{ id: "x", status: "todo" }] }),
    entry({ issue: { id: "parked", unblockDescriptor: { agentId: AGENT_A, action: "waiting" } } }),
    entry({ issue: { id: "ready" } }),
    entry({ issue: { id: "terminal", status: "done" } }),
  ];
  const s = selectDispatch(population, { ...OPTIONS, idleMinutes: 0 });
  const counted =
    s.counters.refused_unassigned +
    s.counters.refused_backlog +
    s.counters.refused_blocked +
    s.counters.parked_on_named_owner +
    s.actionable.length +
    s.excludedTerminal;
  assert.equal(counted, population.length);
});

// ───────────────────────────── the idle rail ────────────────────────────────

test("idle is measured from runs scoped to the issue, never from updatedAt", () => {
  // ADR 0003's whole point: a comment refreshes updated_at without a run having
  // happened, so a card nobody has worked reads as freshly active. This issue's
  // updatedAt is NOW and its last run is three hours old — the idle answer must
  // follow the run.
  const target = issue({ updatedAt: new Date(NOW).toISOString() });
  const idle = computeIdleMs(target, [
    { issueId: target.id, status: "completed", finishedAt: new Date(NOW - 180 * MIN).toISOString() },
  ], NOW);
  assert.equal(idle.anchor, "last_run");
  assert.equal(idle.idleMs, 180 * MIN);
});

test("a run scoped to a DIFFERENT issue does not reset this issue's idle", () => {
  const target = issue();
  const idle = computeIdleMs(target, [
    { issueId: "some-other-issue", status: "running", startedAt: new Date(NOW).toISOString() },
  ], NOW);
  assert.equal(idle.hasRun, false);
  assert.equal(idle.anchor, "issue_created_never_run");
});

test("an active run means idle zero — the work is already happening", () => {
  for (const status of ["queued", "running"]) {
    const idle = computeIdleMs(issue(), [{ issueId: "issue-1", status }], NOW);
    assert.equal(idle.idleMs, 0, `a ${status} run must suppress the wake`);
    assert.equal(idle.anchor, "active_run");
  }
});

test("an issue that has NEVER had a run anchors on createdAt, not updatedAt", () => {
  // The most stalled thing on the board is a card that has never once been
  // picked up. Anchoring on updatedAt would hide it behind its own comments.
  const target = issue({
    createdAt: new Date(NOW - 3000 * MIN).toISOString(),
    updatedAt: new Date(NOW - 1 * MIN).toISOString(),
  });
  const idle = computeIdleMs(target, [], NOW);
  assert.equal(idle.anchor, "issue_created_never_run");
  assert.equal(idle.idleMs, 3000 * MIN);
});

test("idle below the threshold is wakeable but not actionable", () => {
  const runs = [
    { issueId: "issue-1", status: "completed", finishedAt: new Date(NOW - 30 * MIN).toISOString() },
  ];
  const result = classifyIssue({
    issue: issue(),
    blockedBy: [],
    invocationBlock: null,
    idleMinutes: 120,
    idle: computeIdleMs(issue(), runs, NOW),
  });
  assert.equal(result.outcome, "wakeable_not_idle");
  assert.equal(result.wakeable, true);
});

test("the latest of finishedAt/startedAt/createdAt wins across several runs", () => {
  const idle = computeIdleMs(issue(), [
    { issueId: "issue-1", status: "completed", finishedAt: new Date(NOW - 500 * MIN).toISOString() },
    { issueId: "issue-1", status: "failed", startedAt: new Date(NOW - 200 * MIN).toISOString() },
    { issueId: "issue-1", status: "failed", createdAt: new Date(NOW - 900 * MIN).toISOString() },
  ], NOW);
  assert.equal(idle.idleMs, 200 * MIN);
});

// ─────────────────────────── parked on a named owner ────────────────────────

test("an unblock_descriptor parks the issue — wakeable, deliberately not woken", () => {
  // ADR 0003: 12 of the 26 wakeable issues were parked on a named principal.
  // "Wakeable" and "should be woken" are different questions, and waking a card
  // that is waiting on a specific human is noise aimed at the wrong party.
  assert.equal(isParkedOnNamedOwner(issue({ unblockDescriptor: { agentId: AGENT_B } })), true);
  assert.equal(isParkedOnNamedOwner(issue()), false);

  const s = selectDispatch(
    [entry({ issue: { unblockDescriptor: { agentId: AGENT_B, action: "review" } } })],
    { ...OPTIONS, idleMinutes: 0 },
  );
  assert.equal(s.counters.parked_on_named_owner, 1);
  assert.equal(s.legacy.runnable_queue, 1);
  assert.equal(s.picks.length, 0);
  assert.equal(s.parked.length, 1);
});

// ───────────────────────── spread across assignees ──────────────────────────

test("at most one pick per assignee, because coalescing is keyed on the agent", () => {
  // ADR 0001: a second wake for the same agent merges into that agent's active
  // run. It consumes a selection slot and produces nothing.
  const actionable = [
    { issue: issue({ id: "a1", assigneeAgentId: AGENT_A }), idleMs: 900 * MIN },
    { issue: issue({ id: "a2", assigneeAgentId: AGENT_A }), idleMs: 800 * MIN },
    { issue: issue({ id: "b1", assigneeAgentId: AGENT_B }), idleMs: 700 * MIN },
  ];
  const { picks, coalescedWithEarlierPick } = spreadAcrossAssignees(actionable, 3);
  assert.deepEqual(picks.map((p) => p.issue.id), ["a1", "b1"]);
  // Reported, not silently dropped: "we saw it and chose not to wake it" is a
  // different fact from "we never saw it".
  assert.deepEqual(coalescedWithEarlierPick.map((p) => p.issue.id), ["a2"]);
});

test("picks are ordered by idle first, then priority, then id", () => {
  const actionable = [
    { issue: issue({ id: "c", assigneeAgentId: "x", priority: "low" }), idleMs: 100 },
    { issue: issue({ id: "a", assigneeAgentId: "y", priority: "urgent" }), idleMs: 100 },
    { issue: issue({ id: "b", assigneeAgentId: "z", priority: "high" }), idleMs: 999 },
  ];
  const { picks } = spreadAcrossAssignees(actionable, 3);
  assert.deepEqual(picks.map((p) => p.issue.id), ["b", "a", "c"]);
});

test("maxWakesPerFiring caps the picks and the rest are reported as overflow", () => {
  const actionable = ["a", "b", "c", "d"].map((id, i) => ({
    issue: issue({ id, assigneeAgentId: `agent-${id}` }),
    idleMs: (900 - i) * MIN,
  }));
  const { picks, overflow } = spreadAcrossAssignees(actionable, 2);
  assert.equal(picks.length, 2);
  assert.deepEqual(overflow.map((p) => p.issue.id), ["c", "d"]);
});

// ──────────────────────────── the focus filter ──────────────────────────────

test("the focus filter narrows the SELECTION but not the COUNTERS", () => {
  // The retired script filtered to its focus project BEFORE counting, which is
  // how its output could read "candidates ready: 0" while the board held stalls
  // everywhere else. The five counters describe the whole company; only the
  // picks are narrowed.
  const population = [
    entry({ issue: { id: "in", projectId: "project-1" } }),
    entry({ issue: { id: "out", projectId: "project-2" } }),
    entry({ issue: { id: "out-parked", projectId: "project-2", unblockDescriptor: { a: 1 } } }),
  ];
  const s = selectDispatch(population, {
    ...OPTIONS,
    idleMinutes: 0,
    focusProjectIds: ["project-1"],
  });
  assert.equal(s.legacy.runnable_queue, 3, "the wakeable surface is company-wide");
  assert.equal(s.counters.parked_on_named_owner, 1, "a parked card out of focus is still counted");
  assert.equal(s.outOfFocus, 1);
  assert.deepEqual(s.picks.map((p) => p.issue.id), ["in"]);
});

test("an empty focus list means the whole company, which is wider than the script was", () => {
  const s = selectDispatch(
    [entry({ issue: { id: "anywhere", projectId: "project-9" } })],
    { ...OPTIONS, idleMinutes: 0 },
  );
  assert.equal(s.picks.length, 1);
});

// ──────────────────────── the legacy counter contract ───────────────────────

test("deadlocked_agents is null, never 0, and is never written as a metric", async () => {
  // Q5 records it as a known loss. Writing 0 would assert "there are no
  // deadlocked agents", a measurement nobody made. A zero series on a dashboard
  // reads as a healthy zero; an absent series reads as absent.
  const s = selectDispatch([entry()], { ...OPTIONS, idleMinutes: 0 });
  assert.equal(s.legacy.deadlocked_agents, null);

  const written = [];
  const ctx = { metrics: { write: async (name, value, tags) => written.push({ name, value, tags }) } };
  await emitMetrics(ctx, {
    companyId: COMPANY,
    summary: summariseFiring(COMPANY, s, []),
    wakeEnabled: false,
  });

  assert.ok(written.length > 0);
  assert.equal(
    written.some((m) => m.name.includes("deadlocked_agents")),
    false,
    "deadlocked_agents must not be written at all",
  );
});

test("every declared counter is written every firing, enumerated from its own list", async () => {
  const s = selectDispatch([entry()], { ...OPTIONS, idleMinutes: 0 });
  const written = [];
  await emitMetrics(
    { metrics: { write: async (name, value, tags) => written.push({ name, value, tags }) } },
    { companyId: COMPANY, summary: summariseFiring(COMPANY, s, []), wakeEnabled: false },
  );
  const names = written.map((m) => m.name);

  for (const counter of SELECTION_COUNTERS) {
    assert.ok(names.includes(`${METRIC_PREFIX}.${counter}`), `missing ${counter}`);
  }
  for (const counter of LEGACY_COUNTERS.filter((c) => c !== "deadlocked_agents")) {
    assert.ok(names.includes(`${METRIC_PREFIX}.${counter}`), `missing ${counter}`);
  }
  assert.ok(names.includes(`${METRIC_PREFIX}.routing_gap`));
  assert.ok(names.includes(`${METRIC_PREFIX}.wake_failures`));
});

test("every metric carries the wakeEnabled tag, so a zero is readable across the gate", async () => {
  // dispatch.woken = 0 is ambiguous between "nothing needed waking" and "the
  // waker is off" — and the evidence gate is exactly a comparison across that
  // boundary.
  const s = selectDispatch([entry()], { ...OPTIONS, idleMinutes: 0 });
  const written = [];
  await emitMetrics(
    { metrics: { write: async (name, value, tags) => written.push({ name, value, tags }) } },
    { companyId: COMPANY, summary: summariseFiring(COMPANY, s, []), wakeEnabled: false },
  );
  for (const metric of written) {
    assert.equal(metric.tags.wakeEnabled, "false", `${metric.name} lost the wakeEnabled tag`);
    assert.equal(metric.tags.companyId, COMPANY);
  }
});

// ─────────────────────── the state-change threshold ─────────────────────────

test("idle milliseconds are excluded from the state comparison", () => {
  // They change every single firing by construction. Including them would make
  // every firing a "state change" and collapse the activity channel into the
  // metrics channel.
  const build = (idleMs) => {
    const s = selectDispatch(
      [entry({ runs: [{ issueId: "issue-1", status: "completed", finishedAt: new Date(NOW - idleMs).toISOString() }] })],
      { ...OPTIONS, idleMinutes: 1 },
    );
    return summariseFiring(COMPANY, s, []);
  };
  assert.equal(hasStateChanged(build(200 * MIN), build(230 * MIN)), false);
});

test("a first firing always counts as a change, and a different pick set does too", () => {
  const s = selectDispatch([entry()], { ...OPTIONS, idleMinutes: 0 });
  const summary = summariseFiring(COMPANY, s, []);
  assert.equal(hasStateChanged(null, summary), true);

  const other = selectDispatch(
    [entry({ issue: { id: "issue-2", identifier: "TOG-2" } })],
    { ...OPTIONS, idleMinutes: 0 },
  );
  assert.equal(hasStateChanged(summary, summariseFiring(COMPANY, other, [])), true);
});

test("state survives a JSON round-trip with reordered keys", () => {
  const s = selectDispatch([entry()], { ...OPTIONS, idleMinutes: 0 });
  const summary = summariseFiring(COMPANY, s, []);
  const shuffled = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(summary))).reverse());
  assert.equal(hasStateChanged(shuffled, summary), false);
});

// ───────────────────────────── the routing gap ──────────────────────────────

test("the routing gap counts non-terminal unassigned work, grouped by project", () => {
  const gap = summariseRoutingGap([
    { issue: issue({ id: "u1", assigneeAgentId: null, projectId: "p1" }) },
    { issue: issue({ id: "u2", assigneeAgentId: null, projectId: "p1" }) },
    { issue: issue({ id: "u3", assigneeAgentId: null, projectId: null }) },
    { issue: issue({ id: "done", assigneeAgentId: null, status: "done" }) },
    { issue: issue({ id: "assigned" }) },
  ]);
  assert.equal(gap.count, 3);
  assert.deepEqual(gap.byProject, { p1: 2, "(no project)": 1 });
});

test("routing owners are a declared-partial list, and say so in the return value", () => {
  // The server derives tasks:assign from four branches; two of them need
  // access.* operations, of which the deployed capability map has none. A list
  // of names with no completeness flag reads as exhaustive. This one is not.
  const result = identifyRoutingOwners([
    { id: "ceo", name: "CEO", role: "ceo", status: "idle", permissions: { canCreateAgents: false } },
    { id: "dir", name: "Dir", role: "manager", status: "idle", permissions: { canCreateAgents: true } },
    { id: "ic", name: "IC", role: "worker", status: "idle", permissions: { canCreateAgents: false } },
    { id: "gone", name: "Gone", role: "ceo", status: "terminated", permissions: {} },
  ]);
  assert.deepEqual(result.owners.map((o) => o.agentId), ["ceo", "dir"]);
  assert.deepEqual(result.owners.map((o) => o.source), ["ceo_role", "agent_creator"]);
  assert.equal(result.complete, false);
  assert.deepEqual(result.unreadableSources, ["explicit_grant", "simple_default"]);
});

// ───────────────────────── manifest / capability shape ──────────────────────

test("wakeEnabled defaults to false — installing must not be what enables it", () => {
  assert.equal(manifest.instanceConfigSchema.properties.wakeEnabled.default, false);
});

test("issues.wakeup is declared even though the wake is off, because capabilities are static", () => {
  // Adding a capability later puts the plugin into upgrade_pending. The
  // report-only week must run with the eventual capability set installed, or it
  // is evidence for a different program than the one that ships.
  assert.ok(manifest.capabilities.includes("issues.wakeup"));
});

test("no database capability is requested, because a read would cost DDL rights", () => {
  // manifest.database maps to database.namespace.migrate in FEATURE_CAPABILITIES.
  // A read-only reporter holding a migrate capability is a worse trade than one
  // extra host call per issue.
  assert.equal(manifest.database, undefined);
  for (const capability of manifest.capabilities) {
    assert.equal(capability.startsWith("database."), false, `unexpected ${capability}`);
  }
});

test("the sweep is scheduled on the retired timer's own cadence", () => {
  const job = manifest.jobs.find((j) => j.jobKey === "dispatch-sweep");
  assert.equal(job.schedule, "*/30 * * * *");
});

// ────────────────────────── the harness: wiring ─────────────────────────────

const company = (over = {}) => ({
  id: COMPANY,
  name: "TogetherWeOwn",
  slug: "two",
  createdAt: new Date(NOW),
  updatedAt: new Date(NOW),
  ...over,
});

const seedIssue = (over = {}) => ({
  ...issue(over),
  createdAt: new Date(Date.parse(issue(over).createdAt)),
  updatedAt: new Date(Date.parse(issue(over).updatedAt)),
  assigneeUserId: null,
  parentId: null,
  goalId: null,
  title: over.title ?? "A card",
  workMode: "standard",
  checkoutRunId: null,
});

/**
 * `definePlugin` returns `Object.freeze({ definition })` (define-plugin.js:84),
 * so the handlers hang off `.definition` — the host unwraps it, and a test that
 * drives the plugin has to unwrap it too.
 */
const boot = (ctx) => plugin.definition.setup(ctx);

async function bootedHarness(config = {}) {
  const harness = createTestHarness({ manifest, config });
  await boot(harness.ctx);
  return harness;
}

test("a firing writes metrics for every seeded company, not just the first", async () => {
  // A PluginJobContext carries no companyId, so the sweep enumerates. A bug
  // that swept only companies[0] would still look green on a single-company
  // board, which is the board this was developed against.
  const harness = await bootedHarness();
  harness.seed({
    companies: [company(), company({ id: "company-2", slug: "two-2" })],
    issues: [
      seedIssue({ id: "i1" }),
      seedIssue({ id: "i2", companyId: "company-2", assigneeAgentId: null }),
    ],
  });

  await harness.runJob("dispatch-sweep", { trigger: "schedule" });

  const companiesSeen = new Set(harness.metrics.map((m) => m.tags.companyId));
  assert.deepEqual([...companiesSeen].sort(), [COMPANY, "company-2"]);
});

test("report-only: the sweep calls requestWakeup zero times and says what it would have done", async () => {
  const harness = await bootedHarness({ idleMinutes: 1 });
  harness.seed({ companies: [company()], issues: [seedIssue({ id: "i1" })] });

  let wakes = 0;
  const realWakeup = harness.ctx.issues.requestWakeup.bind(harness.ctx.issues);
  harness.ctx.issues.requestWakeup = async (...args) => {
    wakes += 1;
    return realWakeup(...args);
  };

  const { summary, notes } = await sweepCompany(harness.ctx, COMPANY, {
    jobKey: "dispatch-sweep",
    runId: "run-1",
    trigger: "schedule",
    scheduledAt: new Date(NOW).toISOString(),
  });

  assert.equal(wakes, 0, "the wake must not fire while wakeEnabled is false");
  assert.equal(summary.counters.woken, 0);
  assert.equal(summary.pickedIssueIds.length, 1, "the real policy still ran");
  assert.ok(notes.some((n) => n.startsWith("report-only: would have woken")));
});

test("with the flag on, exactly one requestWakeup call is made per pick", async () => {
  // ADR 0004: requestWakeups is a bare for-loop with no try/catch that throws
  // on the first refusal AFTER waking prior issues and discards the results.
  // The batch call is never used, at any size, including one.
  const harness = await bootedHarness({ wakeEnabled: true, idleMinutes: 1 });
  harness.seed({
    companies: [company()],
    issues: [
      seedIssue({ id: "i1", assigneeAgentId: AGENT_A }),
      seedIssue({ id: "i2", assigneeAgentId: AGENT_B }),
    ],
  });

  const singles = [];
  let batches = 0;
  const realWakeup = harness.ctx.issues.requestWakeup.bind(harness.ctx.issues);
  harness.ctx.issues.requestWakeup = async (issueId, companyId, opts) => {
    singles.push(issueId);
    return realWakeup(issueId, companyId, opts);
  };
  harness.ctx.issues.requestWakeups = async () => {
    batches += 1;
    throw new Error("requestWakeups must never be called");
  };

  const { summary } = await sweepCompany(harness.ctx, COMPANY, {
    jobKey: "dispatch-sweep",
    runId: "run-1",
    trigger: "schedule",
    scheduledAt: new Date(NOW).toISOString(),
  });

  assert.equal(batches, 0);
  assert.deepEqual(singles.sort(), ["i1", "i2"]);
  assert.equal(summary.counters.woken, 2);
});

test("one refused wake is recorded and the remaining picks still go out", async () => {
  // The refusal is DATA: it means our mirror and the server's rails disagreed
  // for that issue, which is the number the evidence gate turns on. Aborting
  // the loop would lose both the other wakes and the measurement.
  const harness = await bootedHarness({ wakeEnabled: true, idleMinutes: 1 });
  harness.seed({
    companies: [company()],
    issues: [
      seedIssue({ id: "i1", assigneeAgentId: AGENT_A }),
      seedIssue({ id: "i2", assigneeAgentId: AGENT_B }),
    ],
  });

  const realWakeup = harness.ctx.issues.requestWakeup.bind(harness.ctx.issues);
  harness.ctx.issues.requestWakeup = async (issueId, companyId, opts) => {
    if (issueId === "i1") throw new Error("Issue is not wakeable in status: backlog");
    return realWakeup(issueId, companyId, opts);
  };

  const { summary } = await sweepCompany(harness.ctx, COMPANY, {
    jobKey: "dispatch-sweep",
    runId: "run-1",
    trigger: "schedule",
    scheduledAt: new Date(NOW).toISOString(),
  });

  assert.deepEqual(summary.wakeFailures, ["i1"]);
  assert.equal(summary.counters.woken, 1, "the second pick still went out");
  assert.ok(harness.logs.some((l) => l.level === "error" && l.message.includes("mirror disagreed")));
});

test("wake_failures is written even when it is zero, so silence never means zero", async () => {
  const harness = await bootedHarness({ idleMinutes: 1 });
  harness.seed({ companies: [company()], issues: [seedIssue({ id: "i1" })] });
  await harness.runJob("dispatch-sweep", { trigger: "schedule" });
  const failures = harness.metrics.filter((m) => m.name === `${METRIC_PREFIX}.wake_failures`);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].value, 0);
});

test("activity is written on the first firing and withheld on an identical second", async () => {
  const harness = await bootedHarness({ idleMinutes: 1 });
  harness.seed({ companies: [company()], issues: [seedIssue({ id: "i1" })] });

  const job = {
    jobKey: "dispatch-sweep",
    runId: "run-1",
    trigger: "schedule",
    scheduledAt: new Date(NOW).toISOString(),
  };
  await sweepCompany(harness.ctx, COMPANY, job);
  assert.equal(harness.activity.length, 1, "the first firing has told nobody anything yet");

  await sweepCompany(harness.ctx, COMPANY, { ...job, runId: "run-2" });
  assert.equal(harness.activity.length, 1, "an unchanged board must not write a second line");

  // ...but the metrics keep being written both times.
  const woken = harness.metrics.filter((m) => m.name === `${METRIC_PREFIX}.woken`);
  assert.equal(woken.length, 2);
});

test("a changed board writes a second activity line", async () => {
  const harness = await bootedHarness({ idleMinutes: 1 });
  harness.seed({ companies: [company()], issues: [seedIssue({ id: "i1" })] });
  const job = {
    jobKey: "dispatch-sweep",
    runId: "run-1",
    trigger: "schedule",
    scheduledAt: new Date(NOW).toISOString(),
  };
  await sweepCompany(harness.ctx, COMPANY, job);
  harness.seed({ issues: [seedIssue({ id: "i2", assigneeAgentId: AGENT_B })] });
  await sweepCompany(harness.ctx, COMPANY, { ...job, runId: "run-2" });
  assert.equal(harness.activity.length, 2);
});

test("the firing summary is persisted to plugin state under a company scope", async () => {
  const harness = await bootedHarness({ idleMinutes: 1 });
  harness.seed({ companies: [company()], issues: [seedIssue({ id: "i1" })] });
  await harness.runJob("dispatch-sweep", { trigger: "schedule" });

  const stored = harness.getState({
    scopeKind: "company",
    scopeId: COMPANY,
    namespace: "dispatch",
    stateKey: "last-firing",
  });
  assert.equal(stored.companyId, COMPANY);
  assert.equal(stored.legacy.deadlocked_agents, null);
});

test("one company's failure does not stop the sweep for the companies after it", async () => {
  const harness = await bootedHarness();
  harness.seed({
    companies: [company({ id: "company-bad" }), company()],
    issues: [seedIssue({ id: "i1" })],
  });

  const realList = harness.ctx.issues.list.bind(harness.ctx.issues);
  harness.ctx.issues.list = async (input) => {
    if (input.companyId === "company-bad") throw new Error("board unavailable");
    return realList(input);
  };

  await harness.runJob("dispatch-sweep", { trigger: "schedule" });

  assert.ok(harness.logs.some((l) => l.level === "error" && l.message.includes("company sweep failed")));
  assert.ok(
    harness.metrics.some((m) => m.tags.companyId === COMPANY),
    "the healthy company must still have been reported",
  );
});

test("an unreadable issue is excluded and NOTED, not silently dropped", async () => {
  const harness = await bootedHarness({ idleMinutes: 1 });
  harness.seed({
    companies: [company()],
    issues: [seedIssue({ id: "i1" }), seedIssue({ id: "i2", assigneeAgentId: AGENT_B })],
  });

  const realGet = harness.ctx.issues.summaries.getOrchestration.bind(harness.ctx.issues.summaries);
  harness.ctx.issues.summaries.getOrchestration = async (input) => {
    if (input.issueId === "i1") throw new Error("read failed");
    return realGet(input);
  };

  const { notes } = await sweepCompany(harness.ctx, COMPANY, {
    jobKey: "dispatch-sweep",
    runId: "run-1",
    trigger: "schedule",
    scheduledAt: new Date(NOW).toISOString(),
  });

  assert.ok(notes.some((n) => n.includes("could not be read")));
  assert.ok(harness.logs.some((l) => l.level === "warn" && l.message.includes("orchestration read failed")));
});

test("the harness refuses an operation the manifest does not declare", async () => {
  // The capability model is enforced by the host at every bridge call, not just
  // at install. This is the check that a stray call added later gets caught by
  // the suite rather than by production.
  const narrowed = createTestHarness({
    manifest,
    capabilities: manifest.capabilities.filter((c) => c !== "issues.wakeup"),
  });
  await boot(narrowed.ctx);
  narrowed.seed({ companies: [company()], issues: [seedIssue({ id: "i1" })] });
  await assert.rejects(() => narrowed.ctx.issues.requestWakeup("i1", COMPANY, {}));
});

test("the state-change line names the routing gap as needing a human", async () => {
  const logged = [];
  const s = selectDispatch([entry({ issue: { assigneeAgentId: null } })], { ...OPTIONS, idleMinutes: 0 });
  s.routingGap = {
    count: 1,
    byProject: { "project-1": 1 },
    issueIds: ["issue-1"],
    owners: { owners: [{ agentId: "ceo", name: "CEO", source: "ceo_role" }], complete: false, unreadableSources: [] },
  };
  await logStateChange(
    { activity: { log: async (entryValue) => logged.push(entryValue) } },
    { companyId: COMPANY, summary: summariseFiring(COMPANY, s, []), wakeEnabled: false, notes: [] },
  );
  assert.equal(logged.length, 1);
  assert.match(logged[0].message, /routing gap\): 1/);
  assert.match(logged[0].message, /needs a human/);
  assert.match(logged[0].message, /partial list/);
});
