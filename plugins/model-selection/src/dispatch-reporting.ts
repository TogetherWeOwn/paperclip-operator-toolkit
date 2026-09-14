/**
 * TOG-2481: absorbed from the standalone `dispatch` plugin (TOG-747, design
 * TOG-706) — the two-channel reporting contract, ported verbatim.
 *
 * Two channels, deliberately different cadences:
 *
 *   - METRICS: written every firing, unconditionally. A metric that only
 *     appears when something changed cannot be graphed as a rate — a gap in
 *     the series is indistinguishable from "the job did not run".
 *   - ACTIVITY LOG: written only when the firing's summary differs from the
 *     last one recorded (`hasStateChanged`). The stall board does not change
 *     every 30 minutes; a log line for every no-op firing would bury the lines
 *     that mean something under decoration.
 */

import type { SelectDispatchResult, RoutingOwnersResult } from "./engine/dispatch-selection.js";
import { LEGACY_COUNTERS, SELECTION_COUNTERS } from "./engine/dispatch-selection.js";

export const METRIC_PREFIX = "dispatch";

export interface WakeOutcome {
  issueId: string;
  queued: boolean;
  error?: string;
}

export interface FiringSummary {
  companyId: string;
  counters: Record<string, number>;
  legacy: { candidates_ready: number; runnable_queue: number; deadlocked_agents: number | null };
  pickedIssueIds: string[];
  parkedIssueIds: string[];
  budgetBlockedIssueIds: string[];
  routingGapCount: number;
  routingOwnerIds: string[];
  routingOwnersComplete: boolean;
  wakeFailures: number;
}

/** Reduce one firing's selection + wake results to the shape both channels read from. */
export function summariseFiring(
  companyId: string,
  selection: SelectDispatchResult & { routingGap?: { count: number; owners?: RoutingOwnersResult } },
  wakeOutcomes: WakeOutcome[],
): FiringSummary {
  const woken = wakeOutcomes.filter((outcome) => outcome.queued).length;
  const wakeFailures = wakeOutcomes.filter((outcome) => !outcome.queued).length;

  return {
    companyId,
    counters: { ...selection.counters, woken },
    legacy: { ...selection.legacy },
    pickedIssueIds: selection.picks.map((p) => p.issue.id).sort(),
    parkedIssueIds: selection.parked.map((p) => p.issue.id).sort(),
    budgetBlockedIssueIds: selection.budgetBlocked.map((b) => b.issue.id).sort(),
    routingGapCount: selection.routingGap?.count ?? 0,
    routingOwnerIds: (selection.routingGap?.owners?.owners ?? []).map((o) => o.agentId).sort(),
    routingOwnersComplete: selection.routingGap?.owners?.complete ?? false,
    wakeFailures,
  };
}

/**
 * Sort every key and every id array so two summaries that differ only in
 * object-key order or array order compare EQUAL. `JSON.stringify` on an
 * unsorted object is a string-equality trap: the same facts serialize
 * differently depending on insertion order, which would make the activity log
 * fire on a no-op state-roundtrip.
 *
 * Idle-ms fields are deliberately ABSENT from what gets compared: idle grows
 * every firing by construction, so including it would make `hasStateChanged`
 * true on literally every call and defeat the whole point of the gate.
 */
function canonicalise(summary: FiringSummary): Record<string, unknown> {
  const sortedCounters = Object.fromEntries(Object.entries(summary.counters).sort(([a], [b]) => a.localeCompare(b)));
  const sortedLegacy = Object.fromEntries(Object.entries(summary.legacy).sort(([a], [b]) => a.localeCompare(b)));
  return {
    companyId: summary.companyId,
    counters: sortedCounters,
    legacy: sortedLegacy,
    pickedIssueIds: [...summary.pickedIssueIds].sort(),
    parkedIssueIds: [...summary.parkedIssueIds].sort(),
    budgetBlockedIssueIds: [...summary.budgetBlockedIssueIds].sort(),
    routingGapCount: summary.routingGapCount,
    routingOwnerIds: [...summary.routingOwnerIds].sort(),
    routingOwnersComplete: summary.routingOwnersComplete,
    wakeFailures: summary.wakeFailures,
  };
}

export function hasStateChanged(previous: FiringSummary | null | undefined, current: FiringSummary): boolean {
  if (!previous) return true;
  return JSON.stringify(canonicalise(previous)) !== JSON.stringify(canonicalise(current));
}

interface MetricsCtx {
  metrics: { write(name: string, value: number, tags: Record<string, string>): void | Promise<void> };
}

/**
 * Write every declared counter every firing, even when it is zero — a metric
 * that stops being written when its value hits zero cannot be told apart from
 * a job that stopped running.
 *
 * `deadlocked_agents` is the one declared legacy counter EXCLUDED: its value
 * is always `null` (no native equivalent, Q5), and a metrics backend has no
 * slot for "we do not know" — writing 0 would assert something we have not
 * measured. `legacy` iterates only the counters whose value is a `number`.
 */
export async function emitMetrics(
  ctx: MetricsCtx,
  input: { companyId: string; summary: FiringSummary; wakeEnabled: boolean },
): Promise<void> {
  const { companyId, summary, wakeEnabled } = input;
  const tags = { companyId, wakeEnabled: String(wakeEnabled) };

  for (const counter of SELECTION_COUNTERS) {
    await ctx.metrics.write(`${METRIC_PREFIX}.${counter}`, summary.counters[counter] ?? 0, tags);
  }
  for (const counter of LEGACY_COUNTERS) {
    const value = (summary.legacy as Record<string, number | null>)[counter];
    if (typeof value === "number") {
      await ctx.metrics.write(`${METRIC_PREFIX}.${counter}`, value, tags);
    }
  }
  await ctx.metrics.write(`${METRIC_PREFIX}.routing_gap`, summary.routingGapCount, tags);
  await ctx.metrics.write(`${METRIC_PREFIX}.wake_failures`, summary.wakeFailures, tags);
}

interface ActivityCtx {
  activity: {
    log(entry: {
      companyId: string;
      message: string;
      entityType: string;
      entityId: string;
      metadata: Record<string, unknown>;
    }): void | Promise<void>;
  };
}

/**
 * Write ONE activity line for this firing. Caller gates this behind
 * `hasStateChanged` — this function itself does not check, so it must never be
 * called unconditionally.
 */
export async function logStateChange(
  ctx: ActivityCtx,
  input: { companyId: string; summary: FiringSummary; wakeEnabled: boolean; notes?: string[] },
): Promise<void> {
  const { companyId, summary, wakeEnabled, notes = [] } = input;
  const mode = wakeEnabled ? "live" : "report-only";
  const action = wakeEnabled ? "woken" : "would have woken";

  const routing =
    summary.routingGapCount > 0
      ? ` Unassigned (routing gap): ${summary.routingGapCount}${
          summary.routingOwnersComplete ? "" : " (routing owners: partial list)"
        }.`
      : " Unassigned (routing gap): 0.";

  const message =
    `Dispatch sweep (${mode}): ${action} of ${summary.legacy.candidates_ready} ` +
    `candidates from a wakeable surface of ${summary.legacy.runnable_queue}. ` +
    `Parked on a named owner: ${summary.counters.parked_on_named_owner ?? 0}.` +
    routing;

  await ctx.activity.log({
    companyId,
    message,
    entityType: "plugin",
    entityId: "dispatch",
    metadata: { ...summary, wakeEnabled, notes },
  });
}
