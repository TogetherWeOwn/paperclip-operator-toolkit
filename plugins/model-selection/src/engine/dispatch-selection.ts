/**
 * : absorbed from the standalone `dispatch` plugin (, design
 * ) — the selection policy, as pure functions, ported verbatim.
 *
 * Nothing here calls the host. The sweep gathers rows, this decides, and
 * `worker.ts`'s `dispatchSweep` job acts. That split is what lets the policy
 * be tested against hand-built populations rather than against whatever the
 * board happens to hold on the day.
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
 *  probe undercounted the wakeable surface by 88%.
 *
 *  adds three more rails the SERVER does not enforce — a wake it
 * would happily accept, but that is still a wasted run because nothing an
 * agent does on that card can move it forward this firing:
 *
 *   5. a future `monitor_next_check_at`     -> refused_monitor_armed
 *   6. a pending human-only/wrong-addressee -> parked_on_human_ask
 *      interaction
 *   7. `in_review` with no pending          -> refused_in_review
 *      interaction naming the assignee
 *
 * These sit ABOVE `parked_on_named_owner` in classification order: 5-7 are
 * "this specific run would accomplish nothing", which is a harder fact than
 * "parked, but check anyway once idle".
 */

/** Statuses `requestWakeup` refuses outright (plugin-host-services.js:1876). */
export const WAKEUP_REFUSED_STATUSES = ["backlog", "done", "cancelled"] as const;

/**
 * Terminal statuses are excluded from the counted population entirely.
 *
 * The five counters are defined over the NON-TERMINAL board, which is the
 * denominator `docs/dispatch-plugin-facts.md` §3 used (216 issues). Counting
 * every `done` card as `refused_backlog` would swamp the number that matters
 * and make the report undiffable against the fact base.
 */
export const TERMINAL_STATUSES = ["done", "cancelled"] as const;

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

/**
 * The selection counters (Q5), in report order. Originally five; 
 * added refused_monitor_armed / parked_on_human_ask / refused_in_review, so
 * this is now eight, but the report-order and diffability guarantees are
 * unchanged.
 *
 *  adds two more, appended before `woken` so every existing counter
 * keeps its position:
 *
 *   - `actionable_idle_assignee`: the new candidate class — todo/in_progress,
 *     rails passed, assignee with no running run, woken regardless of
 *     `idleMinutes`. Counted separately from the threshold-based `actionable`
 *     set (which never appears as its own counter — it feeds `candidates_ready`
 *     and `picks`) so the report shows how much of each firing rides the new
 *     class vs the old threshold.
 *   - `skipped_lane_down`: a pick the sweep refused to wake because its lane
 *     read down at wake time. Counted, never silently dropped — "wakes into a
 *     lane reading exhausted = 0" is only verifiable if the skips are visible.
 */
export const SELECTION_COUNTERS = [
  "refused_backlog",
  "refused_unassigned",
  "refused_blocked",
  "refused_monitor_armed",
  "parked_on_human_ask",
  "refused_in_review",
  "parked_on_named_owner",
  "actionable_idle_assignee",
  "skipped_lane_down",
  "woken",
] as const;
export type SelectionCounter = (typeof SELECTION_COUNTERS)[number];

/**
 * The three counters the retired script printed ( output), preserved so
 * a firing is diffable against pasted script output during the parallel week.
 *
 * `deadlocked_agents` has NO native equivalent. Per Q5 it is reported as null —
 * a knowing loss, never a fabricated substitute. Reporting 0 would assert
 * "there are no deadlocked agents", which we have not measured and cannot.
 */
export const LEGACY_COUNTERS = ["candidates_ready", "runnable_queue", "deadlocked_agents"] as const;
export type LegacyCounter = (typeof LEGACY_COUNTERS)[number];

/** A run in one of these statuses means the issue is being worked right now. */
const ACTIVE_RUN_STATUSES = ["queued", "running"];

export interface DispatchIssue {
  id: string;
  identifier?: string | null;
  companyId?: string;
  projectId: string | null;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  unblockDescriptor?: unknown;
  createdAt: string | Date;
  updatedAt?: string | Date;
  /**
   * : a future monitor check is the card's OWN scheduled wake — the
   *  case, a deliberate 48h observation window re-armed by the CTO
   * run the sweep spawned. `null`/`undefined` both mean "no monitor armed".
   */
  monitorNextCheckAt?: string | Date | null;
}

/**
 * : the fields of `IssueThreadInteraction` the sweep needs to decide
 * whether a card is waiting on something only a human (or a specific named
 * reviewer) can resolve. A separate read from `getOrchestration`, which does
 * not carry interaction data at all.
 */
export interface DispatchInteraction {
  status: string;
  addresseeAgentId?: string | null;
  effectiveResolverPolicy?: string | null;
}

export interface DispatchRun {
  issueId: string | null;
  status: string;
  finishedAt?: string | Date | null;
  startedAt?: string | Date | null;
  createdAt?: string | Date | null;
}

export interface DispatchBlocker {
  id: string;
  status: string;
}

export interface DispatchInvocationBlock {
  issueId: string;
  reason: string;
}

export interface IdleResult {
  idleMs: number;
  anchor: "active_run" | "last_run" | "issue_created_never_run" | "unknown";
  hasRun: boolean;
}

const toMillis = (value: unknown): number | null => {
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
export function computeIdleMs(issue: DispatchIssue, runs: DispatchRun[] | undefined, nowMs: number): IdleResult {
  const scoped = (runs ?? []).filter((run) => run.issueId === issue.id);

  if (scoped.some((run) => ACTIVE_RUN_STATUSES.includes(run.status))) {
    return { idleMs: 0, anchor: "active_run", hasRun: true };
  }

  let latest: number | null = null;
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
export function isParkedOnNamedOwner(issue: DispatchIssue): boolean {
  const descriptor = issue.unblockDescriptor;
  return descriptor !== null && descriptor !== undefined;
}

/**
 *  fix 1: the card already has its own wake scheduled.
 *
 *  is the case this exists for — a deliberate 48h observation window
 * (`monitor_next_check_at` 2026-09-16 09:40) that the sweep woke anyway,
 * spawning a run that just re-read state and re-armed the same monitor.
 */
export function isMonitorArmed(issue: DispatchIssue, nowMs: number): boolean {
  const at = toMillis(issue.monitorNextCheckAt ?? null);
  return at !== null && at > nowMs;
}

const PENDING_INTERACTION_STATUS = "pending";

/**
 *  fix 2: a pending interaction that only a human (or a specific
 * other agent) can resolve. `effectiveResolverPolicy === "human_only"` is
 * the /2455/1677 case verbatim from the issue text. The addressee
 * check catches the same "no agent run can advance this" fact by a
 * different route: an interaction addressed to someone other than the
 * assignee is not this agent's to answer, regardless of resolver policy. A
 * `null`/unset addressee is open to anyone and does not trip this rail —
 * only an EXPLICIT mismatch does.
 */
export function isParkedOnHumanAsk(
  interactions: DispatchInteraction[] | undefined,
  assigneeAgentId: string | null,
): boolean {
  return (interactions ?? []).some((interaction) => {
    if (interaction.status !== PENDING_INTERACTION_STATUS) return false;
    if (interaction.effectiveResolverPolicy === "human_only") return true;
    return interaction.addresseeAgentId != null && interaction.addresseeAgentId !== assigneeAgentId;
  });
}

/**
 *  fix 3: an `in_review` card only gets woken if the assignee is the
 * reviewer actually named on the pending interaction — mirrors the retired
 * dispatcher's treatment of review-state cards (no surviving source; ported
 * from the issue's description of that behavior, since `dispatcher.py` was a
 * host-only script never present in this repo's history). No pending
 * interaction naming the assignee means nobody has confirmed the assignee IS
 * the reviewer, so the conservative choice is to skip rather than guess.
 */
export function isReviewerNamedAssignee(
  interactions: DispatchInteraction[] | undefined,
  assigneeAgentId: string | null,
): boolean {
  return (interactions ?? []).some(
    (interaction) =>
      interaction.status === PENDING_INTERACTION_STATUS && interaction.addresseeAgentId === assigneeAgentId,
  );
}

export interface ClassifyIssueInput {
  issue: DispatchIssue;
  blockedBy?: DispatchBlocker[];
  invocationBlock?: DispatchInvocationBlock | null;
  pendingInteractions?: DispatchInteraction[];
  idleMinutes: number;
  idle: IdleResult;
  nowMs: number;
  /**
   * : `true` when the assignee holds NO running/queued run right now
   * (read once per firing from `heartbeat_runs`, not per issue). The new
   * candidate class keys on agent-idleness rather than issue-idleness: an
   * idle agent holding an executable card gets woken even when the card
   * itself is below the `idleMinutes` threshold.
   */
  assigneeIdle?: boolean;
}

export type ClassifyOutcome =
  | "excluded_terminal"
  | "refused_unassigned"
  | "refused_backlog"
  | "refused_blocked"
  | "refused_budget_block"
  | "refused_monitor_armed"
  | "parked_on_human_ask"
  | "refused_in_review"
  | "parked_on_named_owner"
  | "wakeable_not_idle"
  | "actionable_idle_assignee"
  | "actionable";

export interface ClassifyResult {
  outcome: ClassifyOutcome;
  wakeable?: boolean;
  blockReason?: string;
}

/**
 * Classify one issue against the mirrored rails, in the server's own order.
 *
 * Returns a single reason so the counters partition the population instead of
 * overlapping: an issue that is both unassigned and `backlog` is counted where
 * the SERVER would have stopped, which is on the assignee rail.
 */
export function classifyIssue(input: ClassifyIssueInput): ClassifyResult {
  const {
    issue,
    blockedBy = [],
    invocationBlock = null,
    pendingInteractions,
    idleMinutes,
    idle,
    nowMs,
    assigneeIdle = false,
  } = input;

  if ((TERMINAL_STATUSES as readonly string[]).includes(issue.status)) {
    return { outcome: "excluded_terminal" };
  }
  if (!issue.assigneeAgentId) {
    return { outcome: "refused_unassigned" };
  }
  if ((WAKEUP_REFUSED_STATUSES as readonly string[]).includes(issue.status)) {
    return { outcome: "refused_backlog" };
  }
  if (blockedBy.some((blocker) => blocker.status !== "done")) {
    return { outcome: "refused_blocked" };
  }

  // Past this line the server's rails 1-3 would accept it. That is the
  // `runnable_queue` the fact base measured at 26, and the number the retired
  // script's output is diffable against — so `wakeable` is pinned to rails 1-3
  // and rail 4 (and the  rails below) are counted on their own lines
  // rather than being folded in. Widening a legacy counter's meaning would
  // make the parallel-week comparison compare two different things while
  // looking like it compared one.

  //  fix 1: the card already has its own wake scheduled — waking it
  // again is pure noise.
  if (isMonitorArmed(issue, nowMs)) {
    return { outcome: "refused_monitor_armed", wakeable: true };
  }
  //  fix 2: waiting on a human, or on someone other than the
  // assignee — no agent run the sweep can request will advance this
  // (/2455/1677).
  if (isParkedOnHumanAsk(pendingInteractions, issue.assigneeAgentId)) {
    return { outcome: "parked_on_human_ask", wakeable: true };
  }
  //  fix 3: an in_review card only gets woken if the assignee is the
  // reviewer actually named on the pending interaction.
  if (issue.status === "in_review" && !isReviewerNamedAssignee(pendingInteractions, issue.assigneeAgentId)) {
    return { outcome: "refused_in_review", wakeable: true };
  }
  if (invocationBlock) {
    return { outcome: "refused_budget_block", wakeable: true, blockReason: invocationBlock.reason };
  }
  if (isParkedOnNamedOwner(issue)) {
    return { outcome: "parked_on_named_owner", wakeable: true };
  }
  if (idle.idleMs < idleMinutes * 60_000) {
    // : below the threshold, but the assignee holds no running run —
    // an idle agent with an executable card. Eligible regardless of
    // `idleMinutes`, but only for todo/in_progress: in_review, armed-monitor
    // and human-ask cards were already refused above and stay refused.
    if (assigneeIdle && (issue.status === "todo" || issue.status === "in_progress")) {
      return { outcome: "actionable_idle_assignee", wakeable: true };
    }
    return { outcome: "wakeable_not_idle", wakeable: true };
  }
  return { outcome: "actionable", wakeable: true };
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

export interface ActionableCandidate {
  issue: DispatchIssue;
  idleMs: number;
  idleAnchor?: IdleResult["anchor"];
}

export interface SpreadResult {
  picks: ActionableCandidate[];
  coalescedWithEarlierPick: ActionableCandidate[];
  overflow: ActionableCandidate[];
}

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
export function spreadAcrossAssignees(actionable: ActionableCandidate[], maxPicks: number): SpreadResult {
  const ordered = [...actionable].sort((a, b) => {
    if (b.idleMs !== a.idleMs) return b.idleMs - a.idleMs;
    const pa = PRIORITY_RANK[a.issue.priority] ?? 9;
    const pb = PRIORITY_RANK[b.issue.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    return String(a.issue.id).localeCompare(String(b.issue.id));
  });

  const picks: ActionableCandidate[] = [];
  const coalesced: ActionableCandidate[] = [];
  const claimed = new Set<string>();

  for (const candidate of ordered) {
    const agentId = candidate.issue.assigneeAgentId as string;
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

export interface DispatchPopulationEntry {
  issue: DispatchIssue;
  blockedBy?: DispatchBlocker[];
  runs?: DispatchRun[];
  invocationBlock?: DispatchInvocationBlock | null;
  pendingInteractions?: DispatchInteraction[];
}

export interface SelectDispatchOptions {
  idleMinutes: number;
  maxWakesPerFiring: number;
  focusProjectIds?: string[];
  now: number | Date;
  /**
   * : the set of assignee agent ids holding NO running/queued run at
   * sweep time (one `heartbeat_runs` read per firing, not per issue). Entries
   * whose assignee is in this set skip the `idleMinutes` threshold via the
   * `actionable_idle_assignee` class. Omitted/empty = the old behavior: only
   * the threshold-based `actionable` class is selectable.
   */
  idleAssignees?: ReadonlySet<string>;
  /**
   * : per-issue lane the wake would run on, for the lane-down gate.
   * When set for an issue, a down lane demotes the pick to
   * `skipped_lane_down` instead of waking into it. Issues with no entry are
   * lane-unknown and stay selectable (fail-neutral — a broken instrument must
   * not take dispatch down).
   */
  laneByIssueId?: ReadonlyMap<string, string | null>;
  /**
   * : `true` when the issue's lane reads down. Read once per firing
   * from the lane ledger (hard stop), the outage override and the collector
   * availability snapshot — NOT re-derived per issue, so the gate is O(lanes),
   * not O(issues).
   */
  isLaneDown?: (laneId: string) => boolean;
}

export interface ParkedEntry {
  issue: DispatchIssue;
  idleMs: number;
  idleAnchor: IdleResult["anchor"];
}

export interface BudgetBlockedEntry {
  issue: DispatchIssue;
  idleMs: number;
  reason: string | null;
}

export interface RoutingGapSummary {
  count: number;
  byProject: Record<string, number>;
  issueIds: string[];
  owners?: RoutingOwnersResult;
}

export interface LaneDownSkip {
  issue: DispatchIssue;
  laneId: string;
}

export interface SelectDispatchResult {
  counters: Record<SelectionCounter, number>;
  legacy: { candidates_ready: number; runnable_queue: number; deadlocked_agents: null };
  picks: ActionableCandidate[];
  parked: ParkedEntry[];
  budgetBlocked: BudgetBlockedEntry[];
  actionable: ActionableCandidate[];
  /**
   * : the subset of `actionable` riding the new idle-assignee class
   * (below the `idleMinutes` threshold, assignee holding no run). Reported
   * alongside, never folded in — the operator report shows how much of each
   * firing the new class contributes.
   */
  idleAssigneeActionable: ActionableCandidate[];
  /**
   * : picks the lane-down gate refused to wake. Counted as
   * `skipped_lane_down` and listed here with the lane that refused them, so
   * "wakes into a lane reading exhausted = 0" is checkable per firing.
   */
  laneDownSkipped: LaneDownSkip[];
  coalescedWithEarlierPick: ActionableCandidate[];
  overflow: ActionableCandidate[];
  excludedTerminal: number;
  outOfFocus: number;
  routingGap?: RoutingGapSummary;
}

/**
 * Run the whole policy over a gathered population.
 *
 * `population` entries are `{ issue, blockedBy, runs, invocationBlock }` —
 * everything the sweep read for that issue. `now` is injected rather than read
 * from the clock so the policy is deterministic under test.
 */
export function selectDispatch(
  population: DispatchPopulationEntry[],
  options: SelectDispatchOptions,
): SelectDispatchResult {
  const {
    idleMinutes,
    maxWakesPerFiring,
    focusProjectIds = [],
    now,
    idleAssignees,
    laneByIssueId,
    isLaneDown,
  } = options;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);

  const counters: Record<SelectionCounter, number> = {
    refused_backlog: 0,
    refused_unassigned: 0,
    refused_blocked: 0,
    refused_monitor_armed: 0,
    parked_on_human_ask: 0,
    refused_in_review: 0,
    parked_on_named_owner: 0,
    actionable_idle_assignee: 0,
    skipped_lane_down: 0,
    // Filled in by the worker after the wake attempts. The policy cannot know
    // it: whether a wake succeeds is the server's call, not ours.
    woken: 0,
  };

  const focus = new Set(focusProjectIds);
  const actionable: ActionableCandidate[] = [];
  const idleAssigneeActionable: ActionableCandidate[] = [];
  const laneDownSkipped: LaneDownSkip[] = [];
  const parked: ParkedEntry[] = [];
  const budgetBlocked: BudgetBlockedEntry[] = [];
  let wakeable = 0;
  let excludedTerminal = 0;
  let outOfFocus = 0;

  for (const entry of population) {
    const { issue, blockedBy = [], runs = [], invocationBlock = null, pendingInteractions } = entry;
    const idle = computeIdleMs(issue, runs, nowMs);
    // : agent-idle comes from the firing-wide set, never from the
    // issue's own runs. An ACTIVE run scoped to this issue means idle 0 and
    // keeps the card under the threshold (the assignee is busy ON this card);
    // the new class is for agents with no running run at all.
    const assigneeIdle =
      !!issue.assigneeAgentId &&
      !!idleAssignees?.has(issue.assigneeAgentId) &&
      !runs.some((run) => run.issueId === issue.id && (run.status === "queued" || run.status === "running"));
    const result = classifyIssue({
      issue,
      blockedBy,
      invocationBlock,
      pendingInteractions,
      idleMinutes,
      idle,
      nowMs,
      assigneeIdle,
    });

    if (result.outcome === "excluded_terminal") {
      excludedTerminal += 1;
      continue;
    }
    if (result.wakeable) wakeable += 1;

    if (result.outcome in counters) counters[result.outcome as SelectionCounter] += 1;

    if (result.outcome === "refused_budget_block") {
      budgetBlocked.push({ issue, idleMs: idle.idleMs, reason: result.blockReason ?? null });
      continue;
    }
    if (result.outcome === "parked_on_named_owner") {
      parked.push({ issue, idleMs: idle.idleMs, idleAnchor: idle.anchor });
      continue;
    }
    if (result.outcome !== "actionable" && result.outcome !== "actionable_idle_assignee") continue;

    // The focus filter runs LAST, after the counters, so the five numbers
    // describe the whole company and only the SELECTION narrows. The retired
    // script's `scope: FOCUS ONLY` filtered before it counted, which is why its
    // output could read "candidates ready: 0" while the board held stalls.
    if (focus.size > 0 && !focus.has(issue.projectId ?? "")) {
      outOfFocus += 1;
      continue;
    }

    //  lane-down gate: a pick whose lane reads down is refused BEFORE
    // the wake, counted as `skipped_lane_down` and listed with the lane — the
    // acceptance "wakes into a lane reading exhausted = 0" is only checkable
    // if the skips are visible. Lane-unknown (no entry) stays selectable:
    // fail-neutral, a broken instrument must not take dispatch down.
    const laneId = laneByIssueId?.get(issue.id) ?? null;
    if (laneId !== null && isLaneDown?.(laneId)) {
      counters.skipped_lane_down += 1;
      laneDownSkipped.push({ issue, laneId });
      continue;
    }

    const candidate = { issue, idleMs: idle.idleMs, idleAnchor: idle.anchor };
    actionable.push(candidate);
    if (result.outcome === "actionable_idle_assignee") idleAssigneeActionable.push(candidate);
  }

  const { picks, coalescedWithEarlierPick, overflow } = spreadAcrossAssignees(actionable, maxWakesPerFiring);

  return {
    counters,
    legacy: {
      // The set we would select from: rails passed, not parked, not
      // lane-down, in focus — both the threshold class and the 
      // idle-assignee class.
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
    idleAssigneeActionable,
    laneDownSkipped,
    coalescedWithEarlierPick,
    overflow,
    excludedTerminal,
    outOfFocus,
  };
}

export interface DispatchAgent {
  id: string;
  name: string;
  role?: string;
  status: string;
  permissions?: { canCreateAgents?: boolean };
}

export interface RoutingOwner {
  agentId: string;
  name: string;
  source: "ceo_role" | "agent_creator";
}

export interface RoutingOwnersResult {
  owners: RoutingOwner[];
  complete: false;
  unreadableSources: string[];
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
export function identifyRoutingOwners(agents: DispatchAgent[] | undefined): RoutingOwnersResult {
  const owners: RoutingOwner[] = [];
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
export function summariseRoutingGap(population: Array<{ issue: DispatchIssue }>): RoutingGapSummary {
  const unassigned = population
    .map((entry) => entry.issue)
    .filter((issue) => !(TERMINAL_STATUSES as readonly string[]).includes(issue.status) && !issue.assigneeAgentId);

  const byProject: Record<string, number> = {};
  for (const issue of unassigned) {
    const key = issue.projectId ?? "(no project)";
    byProject[key] = (byProject[key] ?? 0) + 1;
  }

  return { count: unassigned.length, byProject, issueIds: unassigned.map((issue) => issue.id) };
}
