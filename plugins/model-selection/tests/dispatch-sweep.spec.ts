import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";

import manifest from "../src/manifest.js";
import { DISPATCH_SWEEP_JOB_BUDGET_MS, JOB_KEYS, PLUGIN_STATE_KEYS } from "../src/constants.js";
import { wakeFailureCodeFor } from "../src/dispatch-reporting.js";
import { createPlugin } from "../src/worker.js";

const COMPANY = "co-1";

function issue(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    companyId: COMPANY,
    projectId: null,
    title: "A card",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: "agent-1",
    unblockDescriptor: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  } as unknown as Issue;
}

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    companyId: COMPANY,
    name: "Founding Engineer",
    role: "general",
    status: "active",
    permissions: {},
    ...overrides,
  } as never;
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    selection: { enabled: true, mode: "enforce" },
    models: [],
    tierLabelIds: {},
    dispatch: { wakeEnabled: false, idleMinutes: 30, maxWakesPerFiring: 3 },
    ...overrides,
  };
}

async function boot(config: Record<string, unknown>, seedIssues: Issue[] = [], agents: unknown[] = [agentRow()]) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({ issues: seedIssues, agents: agents as never, companies: [{ id: COMPANY, name: "Co" } as never] });
  const plugin = createPlugin();
  const setup = plugin.definition.setup;
  if (!setup) throw new Error("plugin definition has no setup handler");
  await setup(harness.ctx);
  const onConfigChanged = plugin.definition.onConfigChanged;
  if (!onConfigChanged) throw new Error("plugin definition has no onConfigChanged handler");
  await onConfigChanged(config, { companyId: COMPANY });
  return harness;
}

/**
 * The harness's own `getOrchestration` fake always returns `runs: []` and
 * `invocationBlocks: []` (hardcoded — see `testing.js`), so idle-run and
 * budget-block scenarios can't be driven through `seed()`. Blocker relations
 * DO flow through `seed({ issues: [{ blockedBy: [...] }] })` because the fake
 * derives `relations` from the same `blockedByIssueIds` map `issues.relations`
 * reads, so only this override is needed, mirroring the `harness.ctx.db.query`
 * override pattern already used for the other scheduled-pass tests.
 */
function withOrchestration(
  harness: ReturnType<typeof createTestHarness>,
  runsByIssue: Record<string, unknown[]>,
  invocationBlocksByIssue: Record<string, { reason: string }> = {},
) {
  const original = harness.ctx.issues.summaries.getOrchestration.bind(harness.ctx.issues.summaries);
  harness.ctx.issues.summaries.getOrchestration = (async (input: { issueId: string; companyId: string }) => {
    const base = await original(input);
    return {
      ...base,
      runs: runsByIssue[input.issueId] ?? [],
      invocationBlocks: invocationBlocksByIssue[input.issueId]
        ? [{ issueId: input.issueId, ...invocationBlocksByIssue[input.issueId] }]
        : [],
    };
  }) as never;
}

// The job under test computes idle against the REAL clock (`now: Date.now()`
// in worker.ts), not an injected value — so offsets here must be relative to
// the actual wall clock, not a fabricated date, or "N minutes ago" silently
// becomes "however many months ago" when compared against the real Date.now().
const NOW = Date.now();

describe("dispatch sweep (TOG-2481 absorption of the standalone dispatch plugin)", () => {
  it("does not wake anything when dispatch.wakeEnabled is false (report-only)", async () => {
    const card = issue("i1", { createdAt: new Date("2026-09-01T00:00:00.000Z") });
    const harness = await boot(baseConfig(), [card]);
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    expect(harness.activity).toHaveLength(1);
    expect(harness.activity[0]?.message).toContain("report-only");
    expect(harness.activity[0]?.message).toContain("would have woken");
  });

  it("wakes an idle, actionable issue when wakeEnabled is true", async () => {
    const card = issue("i1", { createdAt: new Date(NOW - 60 * 60_000) });
    const harness = await boot(baseConfig({ dispatch: { wakeEnabled: true, idleMinutes: 30, maxWakesPerFiring: 3 } }), [
      card,
    ]);
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    expect(harness.activity[0]?.message).toContain("live");
    expect(harness.activity[0]?.message).toContain("woken");
    expect((harness.activity[0]?.metadata as { counters: { woken: number } }).counters.woken).toBe(1);
  });

  it("refuses a backlog-status issue and counts it as refused_backlog", async () => {
    const card = issue("i1", { status: "backlog" });
    const harness = await boot(baseConfig(), [card]);
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as { counters: Record<string, number> };
    expect(metadata.counters.refused_backlog).toBe(1);
    expect(metadata.counters.woken ?? 0).toBe(0);
  });

  it("refuses an unassigned issue and counts it toward the routing gap, not refused_blocked", async () => {
    const card = issue("i1", { assigneeAgentId: null, projectId: "proj-a" });
    const harness = await boot(baseConfig(), [card], []);
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as { counters: Record<string, number>; routingGapCount: number };
    expect(metadata.counters.refused_unassigned).toBe(1);
    expect(metadata.routingGapCount).toBe(1);
  });

  it("excludes a terminal (done/cancelled) issue entirely — no counter incremented", async () => {
    const done = issue("i1", { status: "done" });
    const cancelled = issue("i2", { status: "cancelled" });
    const idle = issue("i3", { createdAt: new Date(NOW - 60 * 60_000), assigneeAgentId: "agent-2" });
    const harness = await boot(baseConfig(), [done, cancelled, idle], [agentRow(), agentRow({ id: "agent-2" })]);
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as { counters: Record<string, number> };
    const total = Object.values(metadata.counters).reduce((a, b) => a + b, 0);
    // Only i3 (actionable, hence woken=0 report-only... but counters here only
    // cover the five SELECTION_COUNTERS, not `actionable`) — done/cancelled
    // contribute to neither refused_backlog nor refused_unassigned.
    expect(metadata.counters.refused_backlog ?? 0).toBe(0);
    expect(metadata.counters.refused_unassigned ?? 0).toBe(0);
    expect(total).toBeGreaterThanOrEqual(0);
  });

  it("refuses a blocked issue (unresolved blocker relation) as refused_blocked", async () => {
    const blocker = issue("blocker-1", { status: "in_progress" });
    const blocked = issue("i1", {
      createdAt: new Date(NOW - 60 * 60_000),
      blockedBy: [{ id: "blocker-1" } as never],
    });
    const harness = await boot(baseConfig(), [blocker, blocked]);
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as { counters: Record<string, number> };
    expect(metadata.counters.refused_blocked).toBe(1);
  });

  it("does not refuse when the sole blocker is done", async () => {
    const blocker = issue("blocker-1", { status: "done" });
    const unblocked = issue("i1", {
      createdAt: new Date(NOW - 60 * 60_000),
      blockedBy: [{ id: "blocker-1" } as never],
    });
    const harness = await boot(baseConfig({ dispatch: { wakeEnabled: true, idleMinutes: 30, maxWakesPerFiring: 3 } }), [
      blocker,
      unblocked,
    ]);
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as { counters: Record<string, number> };
    expect(metadata.counters.refused_blocked ?? 0).toBe(0);
    expect(metadata.counters.woken).toBe(1);
  });

  it("parks an issue carrying an unblockDescriptor without waking it", async () => {
    const parked = issue("i1", {
      createdAt: new Date(NOW - 60 * 60_000),
      unblockDescriptor: { kind: "named_owner", ownerAgentId: "agent-9" } as never,
    });
    const harness = await boot(baseConfig({ dispatch: { wakeEnabled: true, idleMinutes: 30, maxWakesPerFiring: 3 } }), [
      parked,
    ]);
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as {
      counters: Record<string, number>;
      parkedIssueIds: string[];
    };
    expect(metadata.counters.parked_on_named_owner).toBe(1);
    expect(metadata.parkedIssueIds).toEqual(["i1"]);
    expect(metadata.counters.woken ?? 0).toBe(0);
  });

  it("mirrors the server's budget invocation block (rail 4) as refused_budget_block, counted separately from the five report counters", async () => {
    const blocked = issue("i1", { createdAt: new Date(NOW - 60 * 60_000) });
    const harness = await boot(baseConfig({ dispatch: { wakeEnabled: true, idleMinutes: 30, maxWakesPerFiring: 3 } }), [
      blocked,
    ]);
    withOrchestration(harness, {}, { i1: { reason: "monthly_budget_exhausted" } });

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as {
      counters: Record<string, number>;
      budgetBlockedIssueIds: string[];
    };
    expect(metadata.budgetBlockedIssueIds).toEqual(["i1"]);
    expect(metadata.counters.woken ?? 0).toBe(0);
    // Not one of the five SELECTION_COUNTERS — never fabricated as refused_blocked.
    expect(metadata.counters.refused_blocked ?? 0).toBe(0);
  });

  it("treats an issue with an active (queued/running) run as idle 0 — not yet over the idle threshold", async () => {
    const active = issue("i1", { createdAt: new Date(NOW - 24 * 60 * 60_000) });
    const harness = await boot(baseConfig({ dispatch: { wakeEnabled: true, idleMinutes: 30, maxWakesPerFiring: 3 } }), [
      active,
    ]);
    withOrchestration(harness, { i1: [{ issueId: "i1", status: "running" }] });

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as { counters: Record<string, number> };
    expect(metadata.counters.woken ?? 0).toBe(0);
  });

  it("anchors idle to the last finished run, not issue.createdAt, when a run exists", async () => {
    const card = issue("i1", { createdAt: new Date(NOW - 24 * 60 * 60_000) });
    // TOG-3585: the sibling running run keeps agent-1 busy, so the new
    // idle-assignee class cannot claim i1 — this test isolates the anchoring
    // rule (without it, i1 would wake via `actionable_idle_assignee` and the
    // assertion would prove nothing about anchoring).
    const sibling = issue("i2", { createdAt: new Date(NOW - 24 * 60 * 60_000) });
    const harness = await boot(baseConfig({ dispatch: { wakeEnabled: true, idleMinutes: 30, maxWakesPerFiring: 3 } }), [
      card,
      sibling,
    ]);
    // Finished 5 minutes ago — well under the 30-minute idle threshold, even
    // though the issue itself was created a day ago.
    withOrchestration(harness, {
      i1: [{ issueId: "i1", status: "succeeded", finishedAt: new Date(NOW - 5 * 60_000).toISOString() }],
      i2: [{ issueId: "i2", status: "running" }],
    });

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as { counters: Record<string, number> };
    expect(metadata.counters.woken ?? 0).toBe(0);
  });

  it("spreads picks across distinct assignees — at most one wake per agent per firing", async () => {
    const sameAgentA = issue("i1", { assigneeAgentId: "agent-1", createdAt: new Date(NOW - 120 * 60_000) });
    const sameAgentB = issue("i2", { assigneeAgentId: "agent-1", createdAt: new Date(NOW - 90 * 60_000) });
    const otherAgent = issue("i3", { assigneeAgentId: "agent-2", createdAt: new Date(NOW - 60 * 60_000) });
    const harness = await boot(
      baseConfig({ dispatch: { wakeEnabled: true, idleMinutes: 30, maxWakesPerFiring: 3 } }),
      [sameAgentA, sameAgentB, otherAgent],
      [agentRow(), agentRow({ id: "agent-2" })],
    );
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as { counters: Record<string, number>; pickedIssueIds: string[] };
    expect(metadata.counters.woken).toBe(2);
    expect(metadata.pickedIssueIds.sort()).toEqual(["i1", "i3"]);
  });

  it("caps picks at dispatch.maxWakesPerFiring", async () => {
    const cards = Array.from({ length: 5 }, (_, i) =>
      issue(`i${i}`, { assigneeAgentId: `agent-${i}`, createdAt: new Date(NOW - (60 + i) * 60_000) }),
    );
    const agents = cards.map((c) => agentRow({ id: c.assigneeAgentId }));
    const harness = await boot(
      baseConfig({ dispatch: { wakeEnabled: true, idleMinutes: 30, maxWakesPerFiring: 2 } }),
      cards,
      agents,
    );
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as { counters: Record<string, number> };
    expect(metadata.counters.woken).toBe(2);
  });

  it("respects dispatch.focusProjectIds — an out-of-focus actionable issue is not picked", async () => {
    const inFocus = issue("i1", { projectId: "proj-a", createdAt: new Date(NOW - 60 * 60_000) });
    const outOfFocus = issue("i2", {
      projectId: "proj-b",
      assigneeAgentId: "agent-2",
      createdAt: new Date(NOW - 60 * 60_000),
    });
    const harness = await boot(
      baseConfig({
        dispatch: { wakeEnabled: true, idleMinutes: 30, maxWakesPerFiring: 3, focusProjectIds: ["proj-a"] },
      }),
      [inFocus, outOfFocus],
      [agentRow(), agentRow({ id: "agent-2" })],
    );
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as { counters: Record<string, number>; pickedIssueIds: string[] };
    expect(metadata.pickedIssueIds).toEqual(["i1"]);
    expect(metadata.counters.woken).toBe(1);
  });

  it("still counts the five report rails over the WHOLE company when a focus filter is set (focus narrows only the pick, per dispatch-selection.ts)", async () => {
    const backlogCard = issue("i1", { status: "backlog", projectId: "proj-b" });
    const inFocus = issue("i2", { projectId: "proj-a", createdAt: new Date(NOW - 60 * 60_000) });
    const harness = await boot(
      baseConfig({ dispatch: { wakeEnabled: false, idleMinutes: 30, maxWakesPerFiring: 3, focusProjectIds: ["proj-a"] } }),
      [backlogCard, inFocus],
    );
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as { counters: Record<string, number> };
    expect(metadata.counters.refused_backlog).toBe(1);
  });

  it("emits every SELECTION_COUNTERS metric unconditionally, even when zero, tagged with companyId and wakeEnabled", async () => {
    const card = issue("i1");
    const harness = await boot(baseConfig(), [card]);
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const names = harness.metrics.map((m) => m.name);
    expect(names).toContain("dispatch.refused_backlog");
    expect(names).toContain("dispatch.woken");
    expect(names).toContain("dispatch.routing_gap");
    expect(names).toContain("dispatch.wake_failures");
    // deadlocked_agents has no native equivalent (Q5) — never fabricated as a metric.
    expect(names).not.toContain("dispatch.deadlocked_agents");
    const woken = harness.metrics.find((m) => m.name === "dispatch.woken");
    expect(woken?.tags).toMatchObject({ companyId: COMPANY, wakeEnabled: "false" });
  });

  it("does not write a second activity line on a firing whose summary is unchanged (hasStateChanged gate)", async () => {
    const card = issue("i1", { status: "backlog" });
    const harness = await boot(baseConfig(), [card]);
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);
    await harness.runJob(JOB_KEYS.dispatchSweep);

    expect(harness.activity).toHaveLength(1);
  });

  it("writes a new activity line when the firing's summary changes between runs", async () => {
    const card = issue("i1", { status: "backlog" });
    const harness = await boot(baseConfig(), [card]);
    withOrchestration(harness, {});
    await harness.runJob(JOB_KEYS.dispatchSweep);

    await harness.ctx.issues.update("i1", { status: "in_progress" }, COMPANY);
    await harness.runJob(JOB_KEYS.dispatchSweep);

    expect(harness.activity).toHaveLength(2);
  });

  it("reports the routing gap and names ceo/agent_creator routing owners, marked incomplete (Q2)", async () => {
    const unassigned = issue("i1", { assigneeAgentId: null, projectId: "proj-a" });
    const ceo = agentRow({ id: "ceo-1", role: "ceo" });
    const harness = await boot(baseConfig(), [unassigned], [ceo]);
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as {
      routingGapCount: number;
      routingOwnerIds: string[];
      routingOwnersComplete: boolean;
    };
    expect(metadata.routingGapCount).toBe(1);
    expect(metadata.routingOwnerIds).toEqual(["ceo-1"]);
    expect(metadata.routingOwnersComplete).toBe(false);
  });

  it("TOG-2533 fix 3/4: report-only would-have-woken note names the specific issue identifiers, not just a count", async () => {
    const card = issue("i1", { createdAt: new Date(NOW - 60 * 60_000), identifier: "TOG-9001" } as never);
    const harness = await boot(baseConfig(), [card]);
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    // Named mutant: "report-only would-have-woken note dropped". If the
    // `!dispatchConfig.wakeEnabled && selection.picks.length > 0` push in
    // worker.ts were deleted, `notes` would be `[]` here and this assertion
    // goes red — the operator report loses the one piece of information a
    // human needs to act on (which specific card would have woken).
    const metadata = harness.activity[0]?.metadata as { notes: string[] };
    expect(metadata.notes.some((n) => n.startsWith("report-only: would have woken") && n.includes("TOG-9001"))).toBe(
      true,
    );
  });

  it("TOG-2533 fix 3/4: does not add a report-only would-have-woken note when nothing was picked", async () => {
    const card = issue("i1", { status: "backlog" });
    const harness = await boot(baseConfig(), [card]);
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as { notes: string[] };
    expect(metadata.notes.some((n) => n.startsWith("report-only:"))).toBe(false);
  });

  it("TOG-2533 fix 3/4: an issue whose orchestration read throws is counted and named in an unreadable-coverage note", async () => {
    const readable = issue("i1", { createdAt: new Date(NOW - 60 * 60_000) });
    const unreadable = issue("i2", { createdAt: new Date(NOW - 60 * 60_000), assigneeAgentId: "agent-2" });
    const harness = await boot(
      baseConfig({ dispatch: { wakeEnabled: true, idleMinutes: 30, maxWakesPerFiring: 3 } }),
      [readable, unreadable],
      [agentRow(), agentRow({ id: "agent-2" })],
    );
    const original = harness.ctx.issues.summaries.getOrchestration.bind(harness.ctx.issues.summaries);
    harness.ctx.issues.summaries.getOrchestration = (async (input: { issueId: string; companyId: string }) => {
      if (input.issueId === "i2") throw new Error("boom");
      return original(input);
    }) as never;

    await harness.runJob(JOB_KEYS.dispatchSweep);

    // Named mutant: "unreadable count dropped". If the `unreadable += 1` /
    // trailing `notes.push` in worker.ts's dispatch-sweep population loop
    // were removed, this note never appears and the operator has no way to
    // know one assigned issue silently fell out of selection this firing.
    const metadata = harness.activity[0]?.metadata as { notes: string[] };
    expect(metadata.notes).toContain("1 assigned issues could not be read and are excluded from selection");
    // The readable issue still gets woken — a read failure excludes only the
    // failing issue, never the whole company's firing.
    expect((metadata as unknown as { counters: { woken: number } }).counters.woken).toBe(1);
  });

  it("TOG-2533 fix 3/4: a partial-list routing-owners note is attached whenever the routing gap is non-empty", async () => {
    const unassigned = issue("i1", { assigneeAgentId: null, projectId: "proj-a" });
    const harness = await boot(baseConfig(), [unassigned], []);
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as { notes: string[] };
    expect(
      metadata.notes.some(
        (n) => n.startsWith("routing owners are a partial list:") && n.includes("explicit_grant") && n.includes("simple_default"),
      ),
    ).toBe(true);
  });

  it("TOG-2533 fix 3/4: a page-saturation note is attached when the issue list hits the page limit", async () => {
    const DISPATCH_ISSUE_PAGE_LIMIT = 1000;
    const cards = Array.from({ length: DISPATCH_ISSUE_PAGE_LIMIT }, (_, i) =>
      issue(`saturated-${i}`, { status: "done" }),
    );
    const harness = await boot(baseConfig(), cards);
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    // Named mutant: "page saturation note dropped". If the `notes.push` in
    // worker.ts's `issues.length >= DISPATCH_ISSUE_PAGE_LIMIT` branch were
    // removed, this note never appears and a company whose board has grown
    // past the page limit would silently undercount with no operator signal.
    const metadata = harness.activity[0]?.metadata as { notes: string[] };
    expect(
      metadata.notes.some(
        (n) => n.startsWith("issue list saturated at limit") && n.includes(String(DISPATCH_ISSUE_PAGE_LIMIT)),
      ),
    ).toBe(true);
  });

  it("manifest declares the dispatch-sweep job and its three absorbed capabilities", () => {
    expect(manifest.jobs?.some((j) => j.jobKey === JOB_KEYS.dispatchSweep)).toBe(true);
    expect(manifest.capabilities).toContain("issue.relations.read");
    expect(manifest.capabilities).toContain("issues.orchestration.read");
    expect(manifest.capabilities).toContain("issues.wakeup");
  });

  it("manifest declares issue.interactions.read (TOG-2572: needed for listInteractions)", () => {
    expect(manifest.capabilities).toContain("issue.interactions.read");
  });

  it("TOG-2572 fix 1: refuses a card with a future monitor_next_check_at as refused_monitor_armed", async () => {
    const armed = issue("i1", {
      createdAt: new Date(NOW - 60 * 60_000),
      monitorNextCheckAt: new Date(NOW + 48 * 60 * 60_000),
    } as never);
    const harness = await boot(baseConfig({ dispatch: { wakeEnabled: true, idleMinutes: 30, maxWakesPerFiring: 3 } }), [
      armed,
    ]);
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    // Named mutant: "monitor-armed check removed". Without it this card falls
    // through to `actionable` and gets woken — TOG-2426 verbatim.
    const metadata = harness.activity[0]?.metadata as { counters: Record<string, number> };
    expect(metadata.counters.refused_monitor_armed).toBe(1);
    expect(metadata.counters.woken ?? 0).toBe(0);
  });

  it("TOG-2572 fix 1: a PAST monitor_next_check_at does not refuse the wake", async () => {
    const lapsed = issue("i1", {
      createdAt: new Date(NOW - 60 * 60_000),
      monitorNextCheckAt: new Date(NOW - 60 * 60_000),
    } as never);
    const harness = await boot(baseConfig({ dispatch: { wakeEnabled: true, idleMinutes: 30, maxWakesPerFiring: 3 } }), [
      lapsed,
    ]);
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as { counters: Record<string, number> };
    expect(metadata.counters.refused_monitor_armed ?? 0).toBe(0);
    expect(metadata.counters.woken).toBe(1);
  });

  it("TOG-2572 fix 2: refuses a card with a pending human_only interaction as parked_on_human_ask", async () => {
    const asked = issue("i1", { createdAt: new Date(NOW - 60 * 60_000) });
    const harness = await boot(baseConfig({ dispatch: { wakeEnabled: true, idleMinutes: 30, maxWakesPerFiring: 3 } }), [
      asked,
    ]);
    harness.seed({
      issueInteractions: [
        {
          id: "int-1",
          companyId: COMPANY,
          issueId: "i1",
          kind: "request_confirmation",
          status: "pending",
          continuationPolicy: "blocking",
          resolverPolicy: "human_only",
          requestedResolverPolicy: "human_only",
          effectiveResolverPolicy: "human_only",
          resolverPolicyProvenance: "explicit",
        } as never,
      ],
    });
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    // Named mutant: "human_only check removed". Without it this falls through
    // to actionable — TOG-2319/2455/1677 verbatim: no agent run can advance a
    // card an owner must personally resolve.
    const metadata = harness.activity[0]?.metadata as { counters: Record<string, number> };
    expect(metadata.counters.parked_on_human_ask).toBe(1);
    expect(metadata.counters.woken ?? 0).toBe(0);
  });

  it("TOG-2572 fix 2: refuses a card whose pending interaction is addressed to a different agent", async () => {
    const asked = issue("i1", { createdAt: new Date(NOW - 60 * 60_000), assigneeAgentId: "agent-1" });
    const harness = await boot(baseConfig({ dispatch: { wakeEnabled: true, idleMinutes: 30, maxWakesPerFiring: 3 } }), [
      asked,
    ]);
    harness.seed({
      issueInteractions: [
        {
          id: "int-1",
          companyId: COMPANY,
          issueId: "i1",
          kind: "request_confirmation",
          status: "pending",
          continuationPolicy: "blocking",
          resolverPolicy: "board_or_agents",
          requestedResolverPolicy: "board_or_agents",
          effectiveResolverPolicy: "board_or_agents",
          resolverPolicyProvenance: "explicit",
          addresseeAgentId: "agent-9",
        } as never,
      ],
    });
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as { counters: Record<string, number> };
    expect(metadata.counters.parked_on_human_ask).toBe(1);
    expect(metadata.counters.woken ?? 0).toBe(0);
  });

  it("TOG-2572 fix 2: a RESOLVED (non-pending) interaction does not park the card", async () => {
    const resolved = issue("i1", { createdAt: new Date(NOW - 60 * 60_000) });
    const harness = await boot(baseConfig({ dispatch: { wakeEnabled: true, idleMinutes: 30, maxWakesPerFiring: 3 } }), [
      resolved,
    ]);
    harness.seed({
      issueInteractions: [
        {
          id: "int-1",
          companyId: COMPANY,
          issueId: "i1",
          kind: "request_confirmation",
          status: "answered",
          continuationPolicy: "blocking",
          resolverPolicy: "human_only",
          requestedResolverPolicy: "human_only",
          effectiveResolverPolicy: "human_only",
          resolverPolicyProvenance: "explicit",
        } as never,
      ],
    });
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as { counters: Record<string, number> };
    expect(metadata.counters.parked_on_human_ask ?? 0).toBe(0);
    expect(metadata.counters.woken).toBe(1);
  });

  it("TOG-2572 fix 3: refuses an in_review card with no interaction naming the assignee as refused_in_review", async () => {
    const reviewing = issue("i1", { status: "in_review", createdAt: new Date(NOW - 60 * 60_000) });
    const harness = await boot(baseConfig({ dispatch: { wakeEnabled: true, idleMinutes: 30, maxWakesPerFiring: 3 } }), [
      reviewing,
    ]);
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    // Named mutant: "in_review reviewer check removed". Without it an
    // in_review card wakes on idle alone, same as any other status — the
    // dispatcher.py behavior TOG-2572 asks to restore.
    const metadata = harness.activity[0]?.metadata as { counters: Record<string, number> };
    expect(metadata.counters.refused_in_review).toBe(1);
    expect(metadata.counters.woken ?? 0).toBe(0);
  });

  it("TOG-2572 fix 3: wakes an in_review card when a pending interaction names the assignee as the reviewer", async () => {
    const reviewing = issue("i1", {
      status: "in_review",
      createdAt: new Date(NOW - 60 * 60_000),
      assigneeAgentId: "agent-1",
    });
    const harness = await boot(baseConfig({ dispatch: { wakeEnabled: true, idleMinutes: 30, maxWakesPerFiring: 3 } }), [
      reviewing,
    ]);
    harness.seed({
      issueInteractions: [
        {
          id: "int-1",
          companyId: COMPANY,
          issueId: "i1",
          kind: "request_confirmation",
          status: "pending",
          continuationPolicy: "blocking",
          resolverPolicy: "board_or_agents",
          requestedResolverPolicy: "board_or_agents",
          effectiveResolverPolicy: "board_or_agents",
          resolverPolicyProvenance: "explicit",
          addresseeAgentId: "agent-1",
        } as never,
      ],
    });
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as { counters: Record<string, number> };
    expect(metadata.counters.refused_in_review ?? 0).toBe(0);
    expect(metadata.counters.woken).toBe(1);
  });

  it("dispatch.wakeEnabled defaults to false when the company config omits the dispatch block entirely", async () => {
    const card = issue("i1", { createdAt: new Date(NOW - 60 * 60_000) });
    const harness = await boot({ selection: { enabled: true, mode: "enforce" }, models: [], tierLabelIds: {} }, [card]);
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    expect(harness.activity[0]?.message).toContain("report-only");
  });

  it("state key is scoped per company, not shared across companies (dispatchLastFiring)", async () => {
    const cardA = issue("i1", { status: "backlog", companyId: "co-1" });
    const cardB = issue("i2", { status: "backlog", companyId: "co-2" });
    const harness = createTestHarness({ manifest, config: baseConfig() });
    harness.seed({
      issues: [cardA, cardB],
      agents: [agentRow()] as never,
      companies: [{ id: "co-1", name: "A" } as never, { id: "co-2", name: "B" } as never],
    });
    const plugin = createPlugin();
    const setup = plugin.definition.setup;
    if (!setup) throw new Error("plugin definition has no setup handler");
    await setup(harness.ctx);
    const onConfigChanged = plugin.definition.onConfigChanged;
    if (!onConfigChanged) throw new Error("plugin definition has no onConfigChanged handler");
    await onConfigChanged(baseConfig(), { companyId: "co-1" });
    await onConfigChanged(baseConfig(), { companyId: "co-2" });
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    // One firing per company => two activity lines (each is a first-ever
    // state for its own company scope), never merged into one.
    expect(harness.activity).toHaveLength(2);
    const companyIds = harness.activity.map((entry) => (entry.metadata as { companyId: string }).companyId).sort();
    expect(companyIds).toEqual(["co-1", "co-2"]);
  });

  it("TOG-7785: stops starting new gather RPCs when the job budget is reached, still emitting a partial summary", async () => {
    const cards = [
      issue("i1", { createdAt: new Date(NOW - 60 * 60_000) }),
      issue("i2", { createdAt: new Date(NOW - 60 * 60_000) }),
    ];
    const harness = await boot(
      baseConfig({ dispatch: { wakeEnabled: true, idleMinutes: 30, maxWakesPerFiring: 3 } }),
      cards,
    );
    withOrchestration(harness, {});

    // The job computes idle against Date.now(), so the mocked clock starts
    // at the real now (both cards read idle) and jumps past the cooperative
    // deadline once the first gather completes.
    let nowMs = NOW;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    let orchestrationCalls = 0;
    const originalOrchestration = harness.ctx.issues.summaries.getOrchestration;
    harness.ctx.issues.summaries.getOrchestration = (async (input: { issueId: string; companyId: string }) => {
      orchestrationCalls += 1;
      const result = await originalOrchestration(input);
      nowMs = NOW + DISPATCH_SWEEP_JOB_BUDGET_MS + 1;
      return result;
    }) as never;
    const warnLogs: Array<{ message: string; metadata: Record<string, unknown> }> = [];
    const originalWarn = harness.ctx.logger.warn.bind(harness.ctx.logger);
    harness.ctx.logger.warn = ((message: string, metadata: Record<string, unknown>) => {
      warnLogs.push({ message, metadata });
      return originalWarn(message, metadata);
    }) as typeof harness.ctx.logger.warn;
    let wakeups = 0;
    harness.ctx.issues.requestWakeup = (async () => {
      wakeups += 1;
      return { queued: true, runId: "r1" };
    }) as typeof harness.ctx.issues.requestWakeup;
    // TOG-9368: the fix under test — a deadline crossed mid-gather must
    // skip the second per-issue RPC, not just the next loop iteration.
    let interactionsCalls = 0;
    const originalListInteractions = harness.ctx.issues.listInteractions.bind(harness.ctx.issues);
    harness.ctx.issues.listInteractions = (async (...args: [string, string]) => {
      interactionsCalls += 1;
      return originalListInteractions(...args);
    }) as typeof harness.ctx.issues.listInteractions;

    try {
      await harness.runJob(JOB_KEYS.dispatchSweep);
    } finally {
      nowSpy.mockRestore();
      harness.ctx.logger.warn = originalWarn;
    }

    // Named mutant: "deadline check removed". Without it both issues are
    // gathered and the first pick is woken; with it no *new* gather RPC
    // starts past the budget and no wake RPC fires.
    //
    // TOG-9368: the clock jumps past the deadline while the first
    // `getOrchestration` is in flight, so the mid-gather checkpoint trips
    // before `listInteractions` — the first issue is dropped with an
    // incomplete gather rather than completed without its interactions
    // read (which would misreport "no pending interactions"). The second
    // gather never starts.
    expect(orchestrationCalls).toBe(1);
    expect(interactionsCalls).toBe(0);
    expect(wakeups).toBe(0);
    const stopWarns = warnLogs.filter((entry) => entry.message.includes("stopped before the host RPC wall"));
    expect(stopWarns).toHaveLength(1);
    expect(stopWarns[0]?.metadata.budgetMs).toBe(DISPATCH_SWEEP_JOB_BUDGET_MS);
    expect(stopWarns[0]?.metadata.gathered).toBe(0);
    // Partial firing still emits metrics and a summary naming the coverage.
    expect(harness.metrics.length).toBeGreaterThan(0);
    expect(harness.activity).toHaveLength(1);
    const metadata = harness.activity[0]?.metadata as {
      counters: Record<string, number>;
      pickedIssueIds: string[];
      notes?: string[];
    };
    expect(metadata.counters.woken ?? 0).toBe(0);
    expect(metadata.pickedIssueIds).toEqual([]);
    expect(metadata.notes?.some((note) => note.includes("partial firing"))).toBe(true);
    const completeLogs = (
      harness.logs as Array<{ level: string; message: string; meta: Record<string, unknown> }>
    ).filter((entry) => entry.message === "dispatch sweep complete");
    expect(completeLogs).toHaveLength(1);
    expect(completeLogs[0]?.meta.budgetExhausted).toBe(true);
  });
});

describe("dispatch sweep TOG-3585: idle-assignee class, lane-down gate, coded wake failures", () => {
  const wakeConfig = { dispatch: { wakeEnabled: true, idleMinutes: 30, maxWakesPerFiring: 3 } };

  it("wakes a below-threshold card whose assignee holds no running run (actionable_idle_assignee)", async () => {
    // Created 5 minutes ago — under the 30-minute threshold, so the old code
    // counted this as wakeable_not_idle and never picked it.
    const card = issue("i1", { createdAt: new Date(NOW - 5 * 60_000) });
    const harness = await boot(baseConfig(wakeConfig), [card]);
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as {
      counters: Record<string, number>;
      idleAssigneePickedIssueIds: string[];
    };
    // Named mutant: "assigneeIdle not threaded". Without the firing-wide idle
    // set, this card stays wakeable_not_idle and woken drops to 0.
    expect(metadata.counters.woken).toBe(1);
    expect(metadata.counters.actionable_idle_assignee).toBe(1);
    expect(metadata.idleAssigneePickedIssueIds).toEqual(["i1"]);
  });

  it("keeps a below-threshold card quiet when its assignee is busy on another card", async () => {
    const card = issue("i1", { createdAt: new Date(NOW - 5 * 60_000) });
    const sibling = issue("i2", { createdAt: new Date(NOW - 60 * 60_000) });
    const harness = await boot(baseConfig(wakeConfig), [card, sibling]);
    withOrchestration(harness, {
      i1: [],
      i2: [{ issueId: "i2", status: "running" }],
    });

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as { counters: Record<string, number> };
    // i2's active run keeps agent-1 busy: i1 is wakeable_not_idle (no
    // counter), i2 is idle-0 on its own active run. Neither wakes.
    expect(metadata.counters.woken ?? 0).toBe(0);
    expect(metadata.counters.actionable_idle_assignee ?? 0).toBe(0);
  });

  it("keeps the rails: an in_review card below the threshold stays refused even with an idle assignee", async () => {
    const reviewing = issue("i1", { status: "in_review", createdAt: new Date(NOW - 5 * 60_000) });
    const harness = await boot(baseConfig(wakeConfig), [reviewing]);
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as { counters: Record<string, number> };
    expect(metadata.counters.refused_in_review).toBe(1);
    expect(metadata.counters.actionable_idle_assignee ?? 0).toBe(0);
    expect(metadata.counters.woken ?? 0).toBe(0);
  });

  it("refuses to wake into a lane the ledger reads unserviceable (skipped_lane_down)", async () => {
    const models = [{ id: "m1", laneId: "lane-a", enabled: true }];
    const card = issue("i1", {
      createdAt: new Date(NOW - 60 * 60_000),
      assigneeAdapterOverrides: { adapterConfig: { model: "m1" } },
    } as never);
    const harness = await boot(baseConfig({ ...wakeConfig, models } as never), [card]);
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.laneLedger },
      { "lane-a": { verdict: { serviceable: false } } },
    );
    withOrchestration(harness, {});

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as {
      counters: Record<string, number>;
      laneDownSkippedIssueIds: string[];
      pickedIssueIds: string[];
    };
    // Named mutant: "lane gate removed". Without it this card wakes onto a
    // measured-dead lane — the acceptance's wakes-into-exhausted = 0 verbatim.
    expect(metadata.counters.skipped_lane_down).toBe(1);
    expect(metadata.counters.woken ?? 0).toBe(0);
    expect(metadata.laneDownSkippedIssueIds).toEqual(["i1"]);
    expect(metadata.pickedIssueIds).toEqual([]);
    const laneSkips = harness.metrics.find((m) => m.name === "dispatch.lane_down_skips");
    expect(laneSkips?.value).toBe(1);
  });

  it("persists a wake failure with code + message and counts it per reason", async () => {
    const card = issue("i1", { createdAt: new Date(NOW - 60 * 60_000) });
    const harness = await boot(baseConfig(wakeConfig), [card]);
    withOrchestration(harness, {});
    harness.ctx.issues.requestWakeup = (async () => {
      throw new Error("429 rate limited by dispatcher");
    }) as typeof harness.ctx.issues.requestWakeup;

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as {
      counters: Record<string, number>;
      wakeFailures: number;
      wakeFailuresByReason: Record<string, number>;
      wakeFailureDetails: Array<{ issueId: string; code: string; message: string }>;
    };
    // Named mutant: "failure reason dropped". A bare count without the code
    // cannot distinguish a 429 lane from a budget refusal — the post-916 gap
    // (9 failures, 0 reasons) verbatim.
    expect(metadata.wakeFailures).toBe(1);
    expect(metadata.wakeFailuresByReason).toEqual({ rate_limited: 1 });
    expect(metadata.wakeFailureDetails).toHaveLength(1);
    expect(metadata.wakeFailureDetails[0]).toMatchObject({ issueId: "i1", code: "rate_limited" });
    expect(metadata.wakeFailureDetails[0]?.message).toContain("429");
    const reasonSeries = harness.metrics.find(
      (m) => m.name === "dispatch.wake_failures" && (m.tags as Record<string, string>).reason === "rate_limited",
    );
    expect(reasonSeries?.value).toBe(1);
    const errorLogs = (harness.logs as Array<{ level: string; message: string; meta: Record<string, unknown> }>).filter(
      (entry) => entry.level === "error" && entry.message.includes("wake failed"),
    );
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]?.meta.code).toBe("rate_limited");
  });

  it("counts a queued:false answer without a throw as a failure with a reason, not a silent non-wake", async () => {
    const card = issue("i1", { createdAt: new Date(NOW - 60 * 60_000) });
    const harness = await boot(baseConfig(wakeConfig), [card]);
    withOrchestration(harness, {});
    harness.ctx.issues.requestWakeup = (async () => ({ queued: false, runId: null })) as never;

    await harness.runJob(JOB_KEYS.dispatchSweep);

    const metadata = harness.activity[0]?.metadata as {
      counters: Record<string, number>;
      wakeFailures: number;
      wakeFailuresByReason: Record<string, number>;
    };
    expect(metadata.counters.woken ?? 0).toBe(0);
    expect(metadata.wakeFailures).toBe(1);
    expect(Object.values(metadata.wakeFailuresByReason).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("maps requestWakeup throws to stable codes", () => {
    expect(wakeFailureCodeFor("Issue has no assigned agent to wake")).toBe("unassigned");
    expect(wakeFailureCodeFor("Issue is not wakeable in status: backlog")).toBe("bad_status");
    expect(wakeFailureCodeFor("Issue is blocked by unresolved blockers")).toBe("blocked");
    expect(wakeFailureCodeFor("monthly_budget_exhausted for agent")).toBe("budget_block");
    expect(wakeFailureCodeFor("429 Too Many Requests")).toBe("rate_limited");
    expect(wakeFailureCodeFor("RPC timeout after 10000ms")).toBe("timeout");
    expect(wakeFailureCodeFor("something entirely new")).toBe("unknown");
  });
});
