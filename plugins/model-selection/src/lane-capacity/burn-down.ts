// Vendored from @togetherweown/lane-capacity (paperclip-model-router,
// packages/lane-capacity/src/burn-down.ts) at source SHA
// b054ef0c374ca5fb6a9dbb7317e19512731cd434, byte-faithful, because that
// package is workspace-internal to a different git repo and is not published
// to any npm registry — there is no dependency mechanism between the two
// repos. Do not hand-edit divergently from the source; re-vendor from there.
import type { LanePaceVerdict } from "./pace.js";

// Weekly-window burn-down readout toward the 98-100% subscription target.
//
// A subscription allowance is destroyed at reset, so the question this answers
// is purely quantitative: if an account keeps burning at its window-average
// rate, where does it land at reset relative to the 98-100% band?
//
//   projected = utilization / elapsed
//
// where `utilization` is the fraction of the governing allowance window
// consumed and `elapsed` is the fraction of that window elapsed, both taken
// from a real pace evaluation. Linear (constant-burn) projection: a spot
// readout, not a forecast — bursty consumption will deviate from it.
//
// Read-only by construction: pure arithmetic over an already-evaluated
// verdict. No config read, no host call, no admission or pacing change.
// Non-goals (owned elsewhere): the per-lane use-before-expiry countdown, the
// per-decision audit-log append path, and the admit/deny calibration vectors.

/** Lower edge of the end-of-window target band: land at 98-100%. */
export const BURN_DOWN_TARGET_LOW = 0.98;
/** Upper edge of the end-of-window target band: never exceed 100%. */
export const BURN_DOWN_TARGET_HIGH = 1.0;

export type BurnDownVerdict = "on-track" | "over-burn" | "under-use" | "unknown";

export type BurnDownReason =
  | "within-target-band"
  | "above-target-band"
  | "below-target-band"
  | "no-burn-history"
  | "window-already-elapsed"
  | "no-computable-window";

export interface BurnDownPolicy {
  /** Lower edge of the target band. Defaults to BURN_DOWN_TARGET_LOW. */
  targetLow?: number;
  /** Upper edge of the target band. Defaults to BURN_DOWN_TARGET_HIGH. */
  targetHigh?: number;
}

export interface BurnDownProjection {
  utilization: number | null;
  elapsed: number | null;
  /** Linear end-of-window projection, or null when there is nothing to project. */
  projected: number | null;
  verdict: BurnDownVerdict;
  reason: BurnDownReason;
}

export interface AccountBurnDown extends BurnDownProjection {
  accountKey: string;
}

export interface LaneBurnDown {
  laneId: string;
  observedAt: string | null;
  state: LanePaceVerdict["state"];
  serviceable: LanePaceVerdict["serviceable"];
  reason: LanePaceVerdict["reason"];
  accounts: AccountBurnDown[];
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function projectBurnDown(input: {
  utilization: number | null;
  elapsed: number | null;
  policy?: BurnDownPolicy;
}): BurnDownProjection {
  const utilization = finite(input.utilization);
  const elapsed = finite(input.elapsed);
  const low = finite(input.policy?.targetLow) ?? BURN_DOWN_TARGET_LOW;
  const high = finite(input.policy?.targetHigh) ?? BURN_DOWN_TARGET_HIGH;
  if (utilization === null || elapsed === null) {
    return { utilization, elapsed, projected: null, verdict: "unknown", reason: "no-computable-window" };
  }
  if (elapsed <= 0) {
    return { utilization, elapsed, projected: null, verdict: "unknown", reason: "no-burn-history" };
  }
  if (elapsed > 1) {
    return { utilization, elapsed, projected: null, verdict: "unknown", reason: "window-already-elapsed" };
  }
  const projected = utilization / elapsed;
  if (projected > high) {
    return { utilization, elapsed, projected, verdict: "over-burn", reason: "above-target-band" };
  }
  if (projected < low) {
    return { utilization, elapsed, projected, verdict: "under-use", reason: "below-target-band" };
  }
  return { utilization, elapsed, projected, verdict: "on-track", reason: "within-target-band" };
}

/**
 * Project every account of an already-evaluated lane verdict toward the
 * target band. Each account projects from its own pace score, so a hot
 * account cannot hide behind a cool peer and vice versa. Accounts without a
 * computable governing window (score null) report unknown, never a guess.
 * The input verdict is never mutated.
 */
export function laneBurnDown(verdict: LanePaceVerdict, policy?: BurnDownPolicy): LaneBurnDown {
  return {
    laneId: verdict.laneId,
    observedAt: verdict.observedAt,
    state: verdict.state,
    serviceable: verdict.serviceable,
    reason: verdict.reason,
    accounts: verdict.accounts.map((account) => ({
      accountKey: account.accountKey,
      ...projectBurnDown({
        utilization: account.score?.utilization ?? null,
        elapsed: account.score?.elapsed ?? null,
        policy,
      }),
    })),
  };
}
