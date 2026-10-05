import type {
  DecisionLogEmitObservation,
  DecisionLogLagInput,
} from "../src/decision-log-lag.js";

/**
 *  fixtures: decision-log lag detector inputs.
 *
 * Pure builders only; no live state, no secrets. Clocks are fixed so
 * warn/crit threshold assertions are deterministic. `emitMsAgo` is measured
 * back from NOW_MS, mirroring "scheduled-job emit timestamp vs
 * sweep-observed timestamp".
 */

export const NOW_MS = Date.parse("2026-10-04T00:00:00.000Z");

export function emit(recordId: string, emitMsAgo: number | null): DecisionLogEmitObservation {
  return {
    recordId,
    emitAt: emitMsAgo === null ? null : NOW_MS - emitMsAgo,
  };
}

export function baseInput(
  overrides: Partial<DecisionLogLagInput> = {},
): DecisionLogLagInput {
  return {
    now: NOW_MS,
    emits: [emit("rec-1", 60_000), emit("rec-2", 120_000)],
    ...overrides,
  };
}
