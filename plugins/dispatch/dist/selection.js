/**
 * dispatch — the selection policy (ADR 0003), as pure functions.
 *
 * Nothing here calls the host. The sweep gathers rows, this decides, and
 * worker.js acts. That split is what lets the policy be tested against
 * hand-built populations rather than against whatever the board happens to
 * hold on the day.
 *
 * The order of the rails is not cosmetic. The server evaluates them in exactly
 * this sequence (server/dist/services/plugin-host-services.js:1873-1890):
 *
 *   1. no assignee          -> "Issue has no assigned agent to wake"
 *   2. status in backlog|done|cancelled
 *   3. unresolved blocker RELATION (blockedBy with a blocker not `done`)
 *   4. budgets.getInvocationBlock
 *
 * We mirror ALL FOUR so a refusal is COUNTED instead of being discovered by
 * calling requestWakeup and catching a string. Mirroring the server's denylist
 * rather than inventing an allowlist is the whole reason the first cut of the
 * TOG-706 probe undercounted the wakeable surface by 88%.
 */

/** Statuses `requestWakeup` refuses outright (plugin-host-services.js:1876). */
export const WAKEUP_REFUSED_STATUSES = ["backlog", "done", "cancelled"];

/**
 * Terminal statuses are excluded from the counted population entirely.
 *
 * The five counters are defined over the NON-TERMINAL board, which is the
 * denominator `docs/dispatch-plugin-facts.md` §3 used (216 issues). Counting
 * every `done` card as `refused_backlog` would swamp the number that matters
 * and make the report undiffable against the fact base.
 */
export const TERMINAL_STATUSES = ["done", "cancelled"];

/**
 * Rail 4 — the budget hard stop — IS mirrored, without guessing at the rule.
 *
 * `budgets.getInvocationBlock` is not itself on the plugin capability surface,
 * but `issues.summaries.getOrchestration` calls it for us and returns the
 * verdict as `invocationBlocks`. Compare the two call sites: the orchestration
 * summary evaluates
 *
 *     budgets.getInvocationBlock(companyId, issueRow.assigneeAgentId,
 *                                { issueId: issueRow.id, projectId: issueRow.projectId })
 *       — plugin-host-services.js:2043
 *
 * and `requestWakeup` evaluates
 *
 *     budgets.getInvocationBlock(companyId, issue.assigneeAgentId,
 *                                { issueId: issue.id, projectId: issue.projectId })
 *       — plugin-host-services.js:1884
 *
 * Byte-identical arguments to the same function. So a non-empty
 * `invocationBlocks` entry for an issue is the server's OWN answer to rail 4,
 * not a local reimplementation of it — which is the only form of mirroring that
 * is worth anything. We already call getOrchestration for the run summaries
 * (ADR 0003's idle rail), so this costs nothing extra.
 *
 * The residual gap is TIME, not rule: the block is read at sweep time and the
 * wake is issued moments later. A budget that trips in between still refuses at
 * the wake, and ADR 0004's per-issue try/catch is what catches that. The counter
 * is a snapshot, and the report says so.
 */
export const BUDGET_RAIL_MIRROR_SOURCE = "issues.summaries.getOrchestration#invocationBlocks";

/** The five selection counters (Q5), in report order. */
export const SELECTION_COUNTERS = [
  "refused_backlog",
  "refused_unassigned",
  "refused_blocked",
  "parked_on_named_owner",
  "woken",
];

/**
 * The three counters the retired script printed (TOG-686 output), preserved so
 * a firing is diffable against pasted script output during the parallel week.
 *
 * `deadlocked_agents` has NO native equivalent. Per Q5 it is reported as null —
 * a knowing loss, never a fabricated substitute. Reporting 0 would assert
 * "there are no deadlocked agents", which we have not measured and cannot.
 */
export const LEGACY_COUNTERS = ["candidates_ready", "runnable_queue", "deadlocked_agents"];

/** A run in one of these statuses means the issue is being worked right now. */
const ACTIVE_RUN_STATUSES = ["queued", "running"];

const toMillis = (value) => {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
};

/**
 * How long this issue has been without a run of its own.
 *
 * ADR 0003 rail: measured against `heartbeat_runs.context_snapshot->>'issueId'`,
 * never `updated_at` — a comment refreshes `updated_at` without a run having
 * happened, which would make a card that nobody has worked look freshly active.
 *
 * Two cases the ADR does not spell out, decided here and reported as such:
 *
 *   - An ACTIVE run (queued/running) scoped to the issue means idle 0. The work
 *     is happening. A wake would be noise and host coalescing would merge it
 *     into that same run anyway (ADR 0001).
 *   - NO run has ever been scoped to the issue. There is no run timestamp to
 *     measure from, so we fall back to the issue's own `createdAt` — NOT
 *     `updatedAt`, which is the field the ADR rules out. A card created two
 *     days ago that has never once had a run is the most stalled thing on the
 *     board, and anchoring to `createdAt` is what lets it be seen.
 */
export function computeIdleMs(issue, runs, nowMs) {
  const scoped = (runs ?? []).filter((run) => run.issueId === issue.id);

  if (scoped.some((run) => ACTIVE_RUN_STATUSES.includes(run.status))) {
    return { idleMs: 0, anchor: "active_run", hasRun: true };
  }

  let latest = null;
  for (const run of scoped) {
    for (const stamp of [run.finishedAt, run.startedAt, run.createdAt]) {
      const ms = toMillis(stamp);
      if (ms !== null && (latest === null || ms > latest)) latest = ms;
    }
  }

  if (latest !== null) {
    return { idleMs: Math.max(0, nowMs - latest), anchor: "last_run", hasRun: true };
  }

  const created = toMillis(issue.createdAt);
  if (created === null) return { idleMs: 0, anchor: "unknown", hasRun: false };
  return { idleMs: Math.max(0, nowMs - created), anchor: "issue_created_never_run", hasRun: false };
}

/** True when the issue is parked on a named principal (ADR 0003 rail 2). */
export function isParkedOnNamedOwner(issue) {
  const descriptor = issue.unblockDescriptor;
  return descriptor !== null && descriptor !== undefined;
}

/**
 * Classify one issue against the mirrored rails, in the server's own order.
 *
 * Returns a single reason so the counters partition the population instead of
 * overlapping: an issue that is both unassigned and `backlog` is counted where
 * the SERVER would have stopped, which is on the assignee rail.
 */
export function classifyIssue(input) {
  const { issue, blockedBy = [], invocationBlock = null, idleMinutes, idle } = input;

  if (TERMINAL_STATUSES.includes(issue.status)) {
    return { outcome: "excluded_terminal" };
  }
  if (!issue.assigneeAgentId) {
    return { outcome: "refused_unassigned" };
  }
  if (WAKEUP_REFUSED_STATUSES.includes(issue.status)) {
    return { outcome: "refused_backlog" };
  }
  if (blockedBy.some((blocker) => blocker.status !== "done")) {
    return { outcome: "refused_blocked" };
  }

  // Past this line the server's rails 1-3 would accept it. That is the
  // `runnable_queue` the fact base measured at 26, and the number the retired
  // script's output is diffable against — so `wakeable` is pinned to rails 1-3
  // and rail 4 is counted on its own line rather than being folded in. Widening
  // a legacy counter's meaning would make the parallel-week comparison compare
  // two different things while looking like it compared one.
  if (invocationBlock) {
    return { outcome: "refused_budget_block", wakeable: true, blockReason: invocationBlock.reason };
  }
  if (isParkedOnNamedOwner(issue)) {
    return { outcome: "parked_on_named_owner", wakeable: true };
  }
  if (idle.idleMs < idleMinutes * 60_000) {
    return { outcome: "wakeable_not_idle", wakeable: true };
  }
  return { outcome: "actionable", wakeable: true };
}

const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };

/**
 * Order the actionable set, then take at most one issue per assignee.
 *
 * The per-assignee cap is ADR 0001, not a style choice: host coalescing merges
 * a wake into that agent's already-active run and is keyed on the AGENT, so a
 * second pick for the same agent in one firing does not produce a second run.
 * It silently consumes a selection slot and buys nothing.
 *
 * Order: longest idle first, then priority, then id for a stable tiebreak. Most
 * stalled first is the only ordering the reporting can be read against — "the
 * top N by idle" is checkable from the same numbers the report carries.
 */
export function spreadAcrossAssignees(actionable, maxPicks) {
  const ordered = [...actionable].sort((a, b) => {
    if (b.idleMs !== a.idleMs) return b.idleMs - a.idleMs;
    const pa = PRIORITY_RANK[a.issue.priority] ?? 9;
    const pb = PRIORITY_RANK[b.issue.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    return String(a.issue.id).localeCompare(String(b.issue.id));
  });

  const picks = [];
  const coalesced = [];
  const claimed = new Set();

  for (const candidate of ordered) {
    const agentId = candidate.issue.assigneeAgentId;
    if (claimed.has(agentId)) {
      // Not dropped silently — reported, because "we saw it and chose not to
      // wake it this firing" is a different fact from "we never saw it".
      coalesced.push(candidate);
      continue;
    }
    if (picks.length >= maxPicks) break;
    claimed.add(agentId);
    picks.push(candidate);
  }

  const overflow = ordered.filter(
    (candidate) => !picks.includes(candidate) && !coalesced.includes(candidate),
  );

  return { picks, coalescedWithEarlierPick: coalesced, overflow };
}

/**
 * Run the whole policy over a gathered population.
 *
 * `population` entries are `{ issue, blockedBy, runs, invocationBlock }` —
 * everything the sweep read for that issue. `now` is injected rather than read
 * from the clock so the policy is deterministic under test.
 */
export function selectDispatch(population, options) {
  const { idleMinutes, maxWakesPerFiring, focusProjectIds = [], now } = options;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);

  const counters = {
    refused_backlog: 0,
    refused_unassigned: 0,
    refused_blocked: 0,
    parked_on_named_owner: 0,
    // Filled in by the worker after the wake attempts. The policy cannot know
    // it: whether a wake succeeds is the server's call, not ours.
    woken: 0,
  };

  const focus = new Set(focusProjectIds);
  const actionable = [];
  const parked = [];
  const budgetBlocked = [];
  let wakeable = 0;
  let excludedTerminal = 0;
  let outOfFocus = 0;

  for (const entry of population) {
    const { issue, blockedBy = [], runs = [], invocationBlock = null } = entry;
    const idle = computeIdleMs(issue, runs, nowMs);
    const result = classifyIssue({ issue, blockedBy, invocationBlock, idleMinutes, idle });

    if (result.outcome === "excluded_terminal") {
      excludedTerminal += 1;
      continue;
    }
    if (result.wakeable) wakeable += 1;

    if (result.outcome in counters) counters[result.outcome] += 1;

    if (result.outcome === "refused_budget_block") {
      budgetBlocked.push({ issue, idleMs: idle.idleMs, reason: result.blockReason ?? null });
      continue;
    }
    if (result.outcome === "parked_on_named_owner") {
      parked.push({ issue, idleMs: idle.idleMs, idleAnchor: idle.anchor });
      continue;
    }
    if (result.outcome !== "actionable") continue;

    // The focus filter runs LAST, after the counters, so the five numbers
    // describe the whole company and only the SELECTION narrows. The retired
    // script's `scope: FOCUS ONLY` filtered before it counted, which is why its
    // output could read "candidates ready: 0" while the board held stalls.
    if (focus.size > 0 && !focus.has(issue.projectId)) {
      outOfFocus += 1;
      continue;
    }

    actionable.push({ issue, idleMs: idle.idleMs, idleAnchor: idle.anchor });
  }

  const { picks, coalescedWithEarlierPick, overflow } = spreadAcrossAssignees(
    actionable,
    maxWakesPerFiring,
  );

  return {
    counters,
    legacy: {
      // The set we would select from: rails passed, not parked, idle over
      // threshold, in focus.
      candidates_ready: actionable.length,
      // The wakeable surface: rails 1-3 passed, before our two own rails. This
      // is the 26 in docs/dispatch-plugin-facts.md §3.
      runnable_queue: wakeable,
      // No native equivalent (Q5). null, never 0 — see LEGACY_COUNTERS.
      deadlocked_agents: null,
    },
    picks,
    parked,
    // Not one of the five counters — a sixth outcome the design did not know
    // was measurable. Reported alongside them, never folded into one of them.
    budgetBlocked,
    actionable,
    coalescedWithEarlierPick,
    overflow,
    excludedTerminal,
    outOfFocus,
  };
}

/**
 * Principals who can close the routing gap, as far as the plugin surface can
 * see. A DELIBERATE SUBSET, and the shortfall is the point of this comment.
 *
 * The server derives `tasks:assign` in `buildAgentAccessState`
 * (server/dist/routes/agents.js:506-546) from four branches, in order:
 *
 *   1. role === "ceo"                          -> "ceo_role"
 *   2. permissions.canCreateAgents             -> "agent_creator"
 *   3. an explicit `tasks:assign` grant        -> "explicit_grant"
 *   4. an active company membership            -> "simple_default"
 *
 * Branches 1 and 2 read fields that are ON the `Agent` row `agents.list`
 * returns, so they are mirrored exactly. Branches 3 and 4 need
 * `access.listPrincipalGrants` / `access.getMembership`, and the deployed
 * capability map has ZERO `authorization.*` and ZERO `access.*` operations out
 * of 94 (plugin-capability-validator.js, OPERATION_CAPABILITIES) — and
 * `checkOperation` rejects an unknown operation by default. There is no route
 * to them and no partial route worth guessing at.
 *
 * So this returns a subset and says so. `complete: false` is carried in the
 * return value rather than left as a comment, because the difference between
 * "these are the routing owners" and "these are the routing owners we can see"
 * is exactly the kind of thing that gets read off a report as the former.
 */
export function identifyRoutingOwners(agents) {
  const owners = [];
  for (const agent of agents ?? []) {
    if (agent.status === "terminated") continue;
    if (agent.role === "ceo") {
      owners.push({ agentId: agent.id, name: agent.name, source: "ceo_role" });
      continue;
    }
    if (agent.permissions?.canCreateAgents === true) {
      owners.push({ agentId: agent.id, name: agent.name, source: "agent_creator" });
    }
  }
  return {
    owners,
    complete: false,
    unreadableSources: ["explicit_grant", "simple_default"],
  };
}

/**
 * The routing gap (Q2): work that exists, is not terminal, and has no assignee,
 * so `requestWakeup` refuses it outright. 38 issues at the time of the design.
 *
 * The plugin never assigns. Q2 also says it wakes a principal holding
 * `tasks:assign` — and on this server build it CANNOT, which is recorded here
 * rather than quietly dropped. `issues.requestWakeup` is the only wake
 * operation in the deployed map; waking an agent directly (`agents.invoke`) is
 * typed by the SDK but has no OPERATION_CAPABILITIES entry, so it is rejected
 * as an unknown operation. Waking a routing owner therefore requires an issue
 * ASSIGNED TO THEM to wake — i.e. creating a board issue, which is a write this
 * card does not take and the retirement plan puts behind the evidence gate.
 *
 * What ships instead: the gap is measured, the owners who could close it are
 * named (see identifyRoutingOwners), and both go into the metric and the
 * activity line every time they change. See README §"Known gap".
 */
export function summariseRoutingGap(population) {
  const unassigned = population
    .map((entry) => entry.issue)
    .filter((issue) => !TERMINAL_STATUSES.includes(issue.status) && !issue.assigneeAgentId);

  const byProject = {};
  for (const issue of unassigned) {
    const key = issue.projectId ?? "(no project)";
    byProject[key] = (byProject[key] ?? 0) + 1;
  }

  return { count: unassigned.length, byProject, issueIds: unassigned.map((issue) => issue.id) };
}
