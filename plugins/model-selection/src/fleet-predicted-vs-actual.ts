import { laneCombinedUtilization, type LaneLedger } from "./engine/pacing.js";
import { BURN_DOWN_TARGET_HIGH, BURN_DOWN_TARGET_LOW } from "./lane-capacity/burn-down.js";
import type { FleetAdmissionLevel } from "./lane-capacity/fleet-admission.js";
import type { FleetHistoryEntry } from "./fleet-admission-shadow.js";

/**
 * Daily predicted-vs-actual report (read-only artifact). Compares, per lane,
 * the end-of-window `projected` snapshotted during the week against the
 * actual weekly utilization read at the reset, and the shadow proposal level
 * against the host weekly-quota governor level — as a mismatch table.
 *
 * Pure and read-only: every input is caller-supplied. Missing inputs read as
 * unknown, never as a guess. In particular the host governor snapshots live
 * outside this plugin's state; until an ingestion writes them into the stored
 * document the level-compare column reports governor-unknown rather than
 * inventing agreement or mismatch.
 */

export interface LaneProjectionSnapshot {
  laneId: string;
  projected: number | null;
  asOf: string;
}

export interface LaneResetActual {
  laneId: string;
  utilization: number | null;
}

export interface LevelSnapshot {
  level: FleetAdmissionLevel;
  asOf: string;
}

export interface PredictedVsActualRow {
  laneId: string;
  /** Latest end-of-window projection snapshotted at or before the reset. */
  projected: number | null;
  projectedAsOf: string | null;
  /** Weekly utilization read at the reset. */
  actualUtilization: number | null;
  /** actual minus projected; null when either side is unknown. */
  projectionError: number | null;
  /** Whether the actual landed in the 98-100% band; null when unknown. */
  withinTargetBand: boolean | null;
}

export interface PredictedVsActualReport {
  mode: "read-only";
  windowStart: string;
  windowReset: string;
  asOf: string;
  rows: PredictedVsActualRow[];
  fleetLevels: {
    proposalLevel: Exclude<FleetAdmissionLevel, "unknown"> | null;
    governorLevel: Exclude<FleetAdmissionLevel, "unknown"> | null;
    /** True/false when both levels are known, else null (never a guess). */
    match: boolean | null;
  };
  limitations: string[];
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function latestAtOrBefore<T extends { asOf: string }>(entries: readonly T[], atOrBeforeMs: number): T | null {
  let best: T | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const ms = Date.parse(entry.asOf);
    if (!Number.isFinite(ms) || ms > atOrBeforeMs) continue;
    if (ms > bestMs) {
      best = entry;
      bestMs = ms;
    }
  }
  return best;
}

function knownLevel(snapshot: LevelSnapshot | null): Exclude<FleetAdmissionLevel, "unknown"> | null {
  if (!snapshot || snapshot.level === "unknown") return null;
  return snapshot.level;
}

export function historyToSnapshots(history: readonly FleetHistoryEntry[]): LaneProjectionSnapshot[] {
  return history.flatMap((entry) =>
    entry.lanes.map((lane) => ({ laneId: lane.laneId, projected: lane.projected, asOf: entry.asOf })),
  );
}

/**
 * Current weekly utilization per lane, from the live pace ledger: the
 * capacity-weighted governing-window reading (unserviceable accounts count
 * as fully spent). Lanes with no reading report null, never a guess. Read
 * at the reset this is the "actual" the projections are judged against;
 * mid-window it is a point-in-time reading, labelled by `asOf`.
 */
export function resetActualsForLedger(ledger: LaneLedger, asOf: string): LaneResetActual[] {
  return Object.values(ledger)
    .filter((entry) => entry.verdict !== null)
    .map((entry) => {
      let utilization: number | null = null;
      try {
        utilization = laneCombinedUtilization(entry.verdict!, entry.fetchedAt)?.utilization ?? null;
      } catch {
        utilization = null;
      }
      return { laneId: entry.laneId, utilization };
    })
    .sort((a, b) => a.laneId.localeCompare(b.laneId));
}

export function buildPredictedVsActualReport(input: {
  windowStart: string;
  windowReset: string;
  asOf: string;
  snapshots: readonly LaneProjectionSnapshot[];
  actuals: readonly LaneResetActual[];
  proposals: readonly LevelSnapshot[];
  governorLevels: readonly LevelSnapshot[];
}): PredictedVsActualReport {
  const resetMs = Date.parse(input.windowReset);
  const laneIds = [...new Set([...input.snapshots.map((s) => s.laneId), ...input.actuals.map((a) => a.laneId)])].sort();
  const actualByLane = new Map(input.actuals.map((a) => [a.laneId, a.utilization]));

  const rows: PredictedVsActualRow[] = laneIds.map((laneId) => {
    const snapshot = latestAtOrBefore(
      input.snapshots.filter((s) => s.laneId === laneId),
      resetMs,
    );
    const actual = actualByLane.get(laneId) ?? null;
    const projected = snapshot?.projected ?? null;
    const actualUtilization = finite(actual) ? actual : null;
    const projectionError = finite(projected) && actualUtilization !== null ? actualUtilization - projected : null;
    return {
      laneId,
      projected: finite(projected) ? projected : null,
      projectedAsOf: snapshot ? snapshot.asOf : null,
      actualUtilization,
      projectionError,
      withinTargetBand:
        actualUtilization === null
          ? null
          : actualUtilization >= BURN_DOWN_TARGET_LOW && actualUtilization <= BURN_DOWN_TARGET_HIGH,
    };
  });

  const proposalLevel = knownLevel(latestAtOrBefore(input.proposals, resetMs));
  const governorLevel = knownLevel(latestAtOrBefore(input.governorLevels, resetMs));

  const limitations = [
    "Projections are linear spot readouts (utilization/elapsed), not forecasts; bursty consumption deviates from them.",
    "Actuals are point-in-time weekly utilization readings; only a reading taken at the reset validates the landing.",
  ];
  if (input.governorLevels.length === 0) {
    limitations.push(
      "Host governor snapshots unavailable for this window: level compare is governor-unknown, not agreement.",
    );
  }
  if (input.proposals.length === 0) {
    limitations.push("No shadow proposal recorded for this window: level compare is deferred, not agreement.");
  }

  return {
    mode: "read-only",
    windowStart: input.windowStart,
    windowReset: input.windowReset,
    asOf: input.asOf,
    rows,
    fleetLevels: {
      proposalLevel,
      governorLevel,
      match: proposalLevel !== null && governorLevel !== null ? proposalLevel === governorLevel : null,
    },
    limitations,
  };
}
