import type { LaneLedger } from "./engine/pacing.js";
import { BURN_DOWN_TARGET_HIGH, BURN_DOWN_TARGET_LOW } from "./lane-capacity/burn-down.js";
import type { FleetAdmissionLevel } from "./lane-capacity/fleet-admission.js";
import { WEEK_SECONDS, weeklyLaneReadingsForLedger, type FleetHistoryEntry } from "./fleet-admission-shadow.js";

/** Source observations within one normal poll freshness budget of reset can validate the landing. */
export const RESET_READING_MAX_AGE_MS = 15 * 60 * 1000;

export interface LaneProjectionSnapshot {
  laneId: string;
  projected: number | null;
  resetAt: string | null;
  asOf: string;
}

export interface LaneResetActual {
  laneId: string;
  utilization: number | null;
  resetAt: string | null;
  asOf: string | null;
}

export interface LevelSnapshot {
  level: FleetAdmissionLevel;
  asOf: string;
}

export interface PredictedVsActualRow {
  laneId: string;
  windowStart: string | null;
  resetAt: string | null;
  status: "unknown-window" | "pending-reset" | "reset-reading-unavailable" | "reset-observed";
  projected: number | null;
  projectedAsOf: string | null;
  actualUtilization: number | null;
  actualAsOf: string | null;
  projectionError: number | null;
  withinTargetBand: boolean | null;
}

export interface PredictedVsActualReport {
  mode: "read-only";
  asOf: string;
  rows: PredictedVsActualRow[];
  fleetLevels: {
    proposalLevel: Exclude<FleetAdmissionLevel, "unknown"> | null;
    proposalAsOf: string | null;
    governorLevel: Exclude<FleetAdmissionLevel, "unknown"> | null;
    governorAsOf: string | null;
    match: boolean | null;
  };
  limitations: string[];
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function latestAtOrBefore<T extends { asOf: string | null }>(
  entries: readonly T[], atOrBeforeMs: number, notBeforeMs = Number.NEGATIVE_INFINITY,
): T | null {
  let best: T | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const ms = Date.parse(entry.asOf ?? "");
    if (!Number.isFinite(ms) || ms > atOrBeforeMs || ms < notBeforeMs) continue;
    if (ms > bestMs) {
      best = entry;
      bestMs = ms;
    }
  }
  return best;
}

function knownLevel(snapshot: LevelSnapshot | null): Exclude<FleetAdmissionLevel, "unknown"> | null {
  const level = snapshot?.level;
  return level === "boost" || level === "normal" || level === "hold" || level === "conserve" ? level : null;
}

export function historyToSnapshots(history: readonly FleetHistoryEntry[]): LaneProjectionSnapshot[] {
  return history.flatMap(entry => entry.lanes.map(lane => ({
    laneId: lane.laneId, projected: lane.projected, resetAt: lane.resetAt ?? null,
    asOf: lane.observedAt ?? entry.asOf,
  })));
}

export function historyToResetActuals(history: readonly FleetHistoryEntry[]): LaneResetActual[] {
  return history.flatMap(entry => entry.lanes.map(lane => ({
    laneId: lane.laneId, utilization: lane.utilization ?? null,
    resetAt: lane.resetAt ?? null, asOf: lane.observedAt ?? null,
  })));
}

/** Reads weekly usage, never the serviceability-adjusted combined-utilization score. */
export function resetActualsForLedger(ledger: LaneLedger, asOf: string): LaneResetActual[] {
  return weeklyLaneReadingsForLedger(ledger)
    .filter(reading => Date.parse(reading.observedAt!) <= Date.parse(asOf))
    .map(reading => ({ laneId: reading.laneId, utilization: reading.utilization ?? null,
      resetAt: reading.resetAt ?? null, asOf: reading.observedAt ?? null }));
}

/**
 * Read-only mismatch table, keyed by lane AND weekly reset. Pending windows,
 * missing endpoint samples and old history without reset identity are explicit
 * unknowns. The daily clock never relabels a mid-week reading as a reset actual.
 */
export function buildPredictedVsActualReport(input: {
  asOf: string;
  snapshots: readonly LaneProjectionSnapshot[];
  actuals: readonly LaneResetActual[];
  proposals: readonly LevelSnapshot[];
  governorLevels: readonly LevelSnapshot[];
}): PredictedVsActualReport {
  const asOfMs = Date.parse(input.asOf);
  const windows = new Map<string, { laneId: string; resetAt: string | null }>();
  for (const entry of [...input.snapshots, ...input.actuals]) {
    const resetAt = Number.isFinite(Date.parse(entry.resetAt ?? "")) ? entry.resetAt : null;
    windows.set(JSON.stringify([entry.laneId, resetAt]), { laneId: entry.laneId, resetAt });
  }
  const rows: PredictedVsActualRow[] = [...windows.values()]
    .sort((a, b) => a.laneId.localeCompare(b.laneId) || (a.resetAt ?? "").localeCompare(b.resetAt ?? ""))
    .map(({ laneId, resetAt }) => {
      const resetMs = Date.parse(resetAt ?? "");
      const startMs = resetMs - WEEK_SECONDS * 1000;
      const snapshot = latestAtOrBefore(input.snapshots.filter(s => s.laneId === laneId && s.resetAt === resetAt),
        Math.min(resetMs, asOfMs), startMs);
      const actual = latestAtOrBefore(input.actuals.filter(a => a.laneId === laneId && a.resetAt === resetAt),
        Math.min(resetMs, asOfMs), startMs);
      const completed = Number.isFinite(resetMs) && Number.isFinite(asOfMs) && resetMs <= asOfMs;
      const resetObserved = completed && actual !== null && finite(actual.utilization) &&
        resetMs - Date.parse(actual.asOf ?? "") <= RESET_READING_MAX_AGE_MS;
      const actualUtilization = resetObserved ? actual!.utilization : null;
      const projected = finite(snapshot?.projected) ? snapshot.projected : null;
      return {
        laneId, resetAt, windowStart: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
        status: resetAt === null ? "unknown-window" : !completed ? "pending-reset"
          : resetObserved ? "reset-observed" : "reset-reading-unavailable",
        projected, projectedAsOf: snapshot?.asOf ?? null,
        actualUtilization, actualAsOf: resetObserved ? actual!.asOf : null,
        projectionError: projected !== null && actualUtilization !== null ? actualUtilization - projected : null,
        withinTargetBand: actualUtilization === null ? null
          : actualUtilization >= BURN_DOWN_TARGET_LOW && actualUtilization <= BURN_DOWN_TARGET_HIGH,
      };
    });

  // Compare levels from the same observation horizon, never a current proposal
  // against an arbitrarily old governor snapshot (or the soonest lane reset).
  const proposal = latestAtOrBefore(input.proposals, asOfMs);
  const governor = latestAtOrBefore(input.governorLevels, asOfMs);
  const proposalLevel = knownLevel(proposal);
  const governorLevel = knownLevel(governor);
  const aligned = proposal !== null && governor !== null &&
    Math.abs(Date.parse(proposal.asOf) - Date.parse(governor.asOf)) <= RESET_READING_MAX_AGE_MS;
  const limitations = [
    "Projections are linear spot readouts (utilization/elapsed), not forecasts; bursty consumption deviates from them.",
    "Reset actuals use the last source observation at or before a completed weekly reset, within 15 minutes; older or missing readings are unknown, not a validated landing.",
  ];
  if (governorLevel === null || !aligned) {
    limitations.push("Host governor snapshots unavailable or unaligned: level compare is governor-unknown, not agreement.");
  }
  if (proposalLevel === null) limitations.push("No shadow proposal recorded: level compare is deferred, not agreement.");

  return {
    mode: "read-only", asOf: input.asOf, rows,
    fleetLevels: { proposalLevel, proposalAsOf: proposal?.asOf ?? null,
      governorLevel, governorAsOf: governor?.asOf ?? null,
      match: proposalLevel !== null && governorLevel !== null && aligned ? proposalLevel === governorLevel : null },
    limitations,
  };
}
