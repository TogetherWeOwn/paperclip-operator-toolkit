// Vendored from @togetherweown/lane-capacity (paperclip-model-router,
// packages/lane-capacity/src/fleet-admission.ts) at source SHA
// b054ef0c374ca5fb6a9dbb7317e19512731cd434, byte-faithful, because that
// package is workspace-internal to a different git repo and is not published
// to any npm registry — there is no dependency mechanism between the two
// repos. Do not hand-edit divergently from the source; re-vendor from there.
//
// The `./pace.js` import resolves to this plugin's derived pace engine
// (`lane-capacity/pace.ts`), which exposes the same `LanePaceVerdict` shape
// for every field this module reads.
import {
  BURN_DOWN_TARGET_HIGH,
  BURN_DOWN_TARGET_LOW,
  type LaneBurnDown,
} from "./burn-down.js";
import type { LanePaceVerdict } from "./pace.js";

// Fleet admission proposal: total remaining weekly allowance → one admission
// level for the fleet, plus a lane spend order.
//
// The owner rule behind this module: adding or cancelling a subscription (for
// example a Meta account) must change fleet admission within one cycle with no
// config edit, spending down remaining weekly allowance so the fleet lands at
// about 95-98% at each reset — neither exhausting early nor leaving allowance
// destroyed at reset. The weekly target is the governor; five-hour
// serviceability windows are a backstop only.
//
// Propose-only by construction: pure arithmetic over already-evaluated lane
// verdicts and burn-down readouts. No config read, no host call, no pacing or
// selection change, no per-agent cap edit. The actuator (pacer/admission path,
// shadow first) consumes the proposal; this module never applies it.
// Non-goals (owned elsewhere): observed-burn deltas across cycles (this module
// sees one spot readout per call; callers tracking passive deltas compare
// successive proposals), CI/review backpressure gating, host resource bounds,
// and the per-decision audit-log append path.
//
// Inventory auto-discovery: account counts and weights come from the verdicts
// themselves (`knownAccountCount` / `knownWeight` / per-account weights), which
// are evaluated from live lane documents each cycle. A new subscription shows
// up as a new account in the next evaluation; a cancelled one disappears. The
// proposal reports the inventory it saw, so a shadow report can assert the
// reflow happened within one cycle.

/** Fleet admission level, ordered by restrictiveness (boost < normal < hold < conserve). */
export type FleetAdmissionLevel = "boost" | "normal" | "hold" | "conserve" | "unknown";

export type FleetAdmissionReason =
  | "all-lanes-unknown"
  | "all-lanes-blocked"
  | "fleet-under-use-boost"
  | "fleet-on-track"
  | "fleet-over-burn-hold"
  | "fleet-over-burn-conserve"
  | "capped-by-serviceability-backstop";

export interface FleetAdmissionLaneInput {
  verdict: LanePaceVerdict;
  burndown: LaneBurnDown;
  /**
   * Governing allowance window length in seconds (for example 604800 for a
   * weekly window). Needed only for the per-hour rate readouts; when absent
   * the rates report null while the level and spend order still compute.
   */
  windowSeconds?: number | null;
}

export interface FleetAdmissionPolicy {
  /** Lower edge of the end-of-window target band. Defaults to BURN_DOWN_TARGET_LOW. */
  targetLow?: number;
  /** Fleet projected at/above this proposes `hold`. Defaults to BURN_DOWN_TARGET_HIGH. */
  holdAt?: number;
  /** Fleet projected at/above this proposes `conserve`. Defaults to 1.5. */
  conserveAt?: number;
  /**
   * Upgrade-only deadband. Downgrades (toward conserve) apply immediately at
   * the boundary — over-burn reaction must be fast — while upgrades (toward
   * boost) require the projection to clear the boundary by this margin, so the
   * level does not flap on noisy snapshots. Defaults to 0.05.
   */
  hysteresis?: number;
  /** Per-level admission fraction (multiplier on the baseline wake rate). */
  fractions?: Partial<Record<Exclude<FleetAdmissionLevel, "unknown">, number>>;
  /** Clamp floor for the admission fraction. Defaults to 0.1. */
  minAdmission?: number;
  /** Clamp ceiling for the admission fraction. Defaults to 1.5. */
  maxAdmission?: number;
  /**
   * Share of the fleet's accounted weight that must sit behind a five-hour
   * serviceability trip before the backstop caps the fleet at `hold`. Below
   * this share the weekly level stands: the tripped lanes are already withheld
   * from the spend order, so a minority trip must not throttle healthy lanes
   * whose weekly allowance would otherwise go unspent. Defaults to 0.5. Zero
   * restores "any trip holds the fleet"; above 1 disables the cap.
   */
  backstopHoldShare?: number;
}

export interface FleetLaneRate {
  laneId: string;
  /** Weight-weighted remaining allowance fraction across computable accounts. */
  remainingFraction: number | null;
  /** Weight-weighted end-of-window projection across computable accounts. */
  projected: number | null;
  hoursToReset: number | null;
  /**
   * Allowance fraction per hour the lane may still burn to land exactly on
   * `targetLow` at reset. Null when the window length, reset or as-of clock
   * is unknown. Floored reporting: 0 means the lane already meets or exceeds
   * the target ("no room left"), null means "unknown".
   */
  targetRatePerHour: number | null;
  /**
   * Window-average burn rate so far (allowance fraction per hour), from the
   * spot readout only — no synthetic measurement, no cross-cycle state.
   */
  windowRatePerHour: number | null;
  computableAccounts: number;
  blocked: boolean;
}

export interface FleetAdmissionInventory {
  knownAccountCount: number;
  knownWeight: number;
  serviceableAccountCount: number;
  computableAccountCount: number;
  lanes: Array<{
    laneId: string;
    knownAccountCount: number;
    knownWeight: number;
    serviceableAccountCount: number;
    computableAccountCount: number;
  }>;
}

/** How much of the fleet sits behind a five-hour serviceability trip, and whether that capped the level. */
export interface FleetAdmissionBackstop {
  /** Lanes with a tripped five-hour serviceability window. Always withheld from the spend order. */
  trippedLanes: string[];
  /**
   * Tripped lanes' share of the fleet's accounted weight (tripped lanes plus
   * the computable weight of the rest), 0 when nothing tripped.
   */
  trippedShare: number;
  /** Share at/above which the backstop caps the fleet at `hold`. */
  holdShare: number;
  /** True when the backstop lowered the level the weekly picture alone would propose. */
  capped: boolean;
}

export interface FleetAdmissionProposal {
  /** Explicit `asOf`, else the latest finite observation time across all lanes; null when neither exists. */
  asOf: string | null;
  level: FleetAdmissionLevel;
  /** Baseline wake-rate multiplier, clamped to [minAdmission, maxAdmission]. Null when unknown. */
  admissionFraction: number | null;
  reason: FleetAdmissionReason;
  /** Fleet weight-weighted remaining allowance fraction. Null when nothing computable. */
  remainingFraction: number | null;
  /** Fleet weight-weighted end-of-window projection. Null when nothing computable. */
  projected: number | null;
  /** Soonest reset across computable lanes. Null when unknown. */
  soonestResetAt: string | null;
  /** Lanes to spend first: reset soonest, then headroom largest. Blocked lanes are withheld, never ordered. */
  spendOrder: string[];
  /** Lanes excluded from spending (unserviceable or uncomputable). */
  withheld: string[];
  backstop: FleetAdmissionBackstop;
  inventory: FleetAdmissionInventory;
  lanes: FleetLaneRate[];
}

const DEFAULT_HOLD_AT = 1.0;
const DEFAULT_CONSERVE_AT = 1.5;
const DEFAULT_HYSTERESIS = 0.05;
const DEFAULT_MIN_ADMISSION = 0.1;
const DEFAULT_MAX_ADMISSION = 1.5;
const DEFAULT_BACKSTOP_HOLD_SHARE = 0.5;
const DEFAULT_FRACTIONS: Record<Exclude<FleetAdmissionLevel, "unknown">, number> = {
  boost: 1.25,
  normal: 1.0,
  hold: 0.6,
  conserve: 0.25,
};

const RESTRICTIVENESS: Array<Exclude<FleetAdmissionLevel, "unknown">> = ["boost", "normal", "hold", "conserve"];

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positive(value: unknown): number | null {
  const n = finite(value);
  return n !== null && n > 0 ? n : null;
}

/**
 * The fleet clock when the caller supplies none: the latest finite observation
 * time across every lane, so the result never depends on lane order and one
 * stale or unavailable lane cannot shift the others' hours-to-reset.
 */
function latestObservedAt(lanes: FleetAdmissionLaneInput[]): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const lane of lanes) {
    const observedAt = lane?.verdict?.observedAt;
    const ms = typeof observedAt === "string" ? Date.parse(observedAt) : Number.NaN;
    if (Number.isFinite(ms) && ms > latestMs) {
      latest = observedAt as string;
      latestMs = ms;
    }
  }
  return latest;
}

/**
 * Weight a tripped lane carries in the backstop share: its known account
 * weight, else the weight of the accounts it lists, else 1. A lane tripped on
 * a window with no usable weekly reading still counts as capacity behind a trip.
 */
function trippedLaneWeight(verdict: LanePaceVerdict | undefined): number {
  const known = positive(verdict?.knownWeight);
  if (known !== null) return known;
  const listed = (verdict?.accounts ?? []).reduce((sum, account) => sum + (positive(account?.weight) ?? 1), 0);
  return listed > 0 ? listed : 1;
}

function levelForProjected(projected: number, holdAt: number, conserveAt: number): Exclude<FleetAdmissionLevel, "unknown"> {
  if (projected >= conserveAt) return "conserve";
  if (projected >= holdAt) return "hold";
  return "normal";
}

function boundaryBelow(level: Exclude<FleetAdmissionLevel, "unknown">, boostBelow: number, holdAt: number, conserveAt: number): number {
  switch (level) {
    case "boost": return Number.NEGATIVE_INFINITY;
    case "normal": return boostBelow;
    case "hold": return holdAt;
    case "conserve": return conserveAt;
  }
}

/**
 * Apply upgrade-only hysteresis: downgrades adopt immediately, upgrades step
 * toward the raw level only while the projection clears each boundary by the
 * deadband margin. Unknown previous (or none) adopts the raw level directly.
 */
export function applyHysteresis(input: {
  raw: Exclude<FleetAdmissionLevel, "unknown">;
  previous?: FleetAdmissionLevel | null;
  projected: number;
  boostBelow: number;
  holdAt: number;
  conserveAt: number;
  hysteresis: number;
}): Exclude<FleetAdmissionLevel, "unknown"> {
  const previous = input.previous ?? null;
  if (previous === null || previous === "unknown") return input.raw;
  const rawIndex = RESTRICTIVENESS.indexOf(input.raw);
  let current = RESTRICTIVENESS.indexOf(previous);
  if (current <= rawIndex) return input.raw; // downgrade or same: immediate
  while (current > rawIndex) {
    const level = RESTRICTIVENESS[current]!;
    const exitBelow = boundaryBelow(level, input.boostBelow, input.holdAt, input.conserveAt) - input.hysteresis;
    if (input.projected <= exitBelow) {
      current -= 1;
    } else {
      break;
    }
  }
  return RESTRICTIVENESS[current]!;
}

function reasonFor(level: Exclude<FleetAdmissionLevel, "unknown">): FleetAdmissionReason {
  switch (level) {
    case "boost": return "fleet-under-use-boost";
    case "normal": return "fleet-on-track";
    case "hold": return "fleet-over-burn-hold";
    case "conserve": return "fleet-over-burn-conserve";
  }
}

/**
 * Roll per-lane pace verdicts and burn-down readouts up to one fleet admission
 * proposal. Each account contributes its own projection weighted by its
 * verdict weight, so a hot account cannot hide behind a cool peer. Lanes with
 * no computable account (stale/unavailable documents, unparseable windows)
 * are withheld, never guessed. The input objects are never mutated.
 */
export function proposeFleetAdmission(input: {
  lanes: FleetAdmissionLaneInput[];
  asOf?: string | null;
  policy?: FleetAdmissionPolicy;
  previousLevel?: FleetAdmissionLevel | null;
}): FleetAdmissionProposal {
  const explicitAsOf = typeof input.asOf === "string" && Number.isFinite(Date.parse(input.asOf)) ? input.asOf : null;
  const asOf = explicitAsOf ?? latestObservedAt(input.lanes ?? []);
  const asOfMs = asOf !== null ? Date.parse(asOf) : Number.NaN;
  const targetLow = finite(input.policy?.targetLow) ?? BURN_DOWN_TARGET_LOW;
  const holdAt = finite(input.policy?.holdAt) ?? DEFAULT_HOLD_AT;
  const conserveAt = finite(input.policy?.conserveAt) ?? DEFAULT_CONSERVE_AT;
  const hysteresis = finite(input.policy?.hysteresis) ?? DEFAULT_HYSTERESIS;
  const minAdmission = finite(input.policy?.minAdmission) ?? DEFAULT_MIN_ADMISSION;
  const maxAdmission = finite(input.policy?.maxAdmission) ?? DEFAULT_MAX_ADMISSION;
  const backstopHoldShare = Math.max(0, finite(input.policy?.backstopHoldShare) ?? DEFAULT_BACKSTOP_HOLD_SHARE);
  const fractions = { ...DEFAULT_FRACTIONS, ...input.policy?.fractions };

  const laneRates: FleetLaneRate[] = [];
  const spendCandidates: Array<{ laneId: string; resetMs: number; projected: number }> = [];
  const withheld: string[] = [];
  const trippedLanes: string[] = [];
  let trippedWeight = 0;
  let untrippedComputableWeight = 0;

  const inventoryLanes: FleetAdmissionInventory["lanes"] = [];
  let knownAccountCount = 0;
  let knownWeight = 0;
  let serviceableAccountCount = 0;
  let computableAccountCount = 0;
  let fleetRemaining = 0;
  let fleetRemainingWeight = 0;
  let fleetProjected = 0;
  let fleetProjectedWeight = 0;
  let soonestResetMs: number | null = null;
  let soonestResetAt: string | null = null;

  for (const lane of input.lanes ?? []) {
    const verdict = lane?.verdict;
    const burndown = lane?.burndown;
    const laneId = typeof verdict?.laneId === "string" ? verdict.laneId : "unknown";
    const blocked = verdict?.serviceable === false;
    const tripped = verdict?.reason === "serviceability-window-exhausted";
    if (tripped) {
      trippedLanes.push(laneId);
      trippedWeight += trippedLaneWeight(verdict);
    }
    knownAccountCount += verdict?.knownAccountCount ?? 0;
    knownWeight += verdict?.knownWeight ?? 0;
    serviceableAccountCount += verdict?.serviceableAccountCount ?? 0;
    const windowSeconds = positive(lane?.windowSeconds);

    const burnByAccount = new Map(
      (Array.isArray(burndown?.accounts) ? burndown.accounts : []).map((account) => [account?.accountKey, account]),
    );
    let laneRemaining = 0;
    let laneRemainingWeight = 0;
    let laneProjected = 0;
    let laneProjectedWeight = 0;
    let laneComputable = 0;
    let laneResetMs: number | null = null;
    let laneHoursToReset: number | null = null;
    let laneUtilization: number | null = null;

    for (const account of verdict?.accounts ?? []) {
      const utilization = finite(account?.score?.utilization);
      const projected = finite(burnByAccount.get(account?.accountKey)?.projected);
      const weight = positive(account?.weight) ?? 1;
      if (utilization === null || projected === null) continue;
      if (account?.serviceable !== true) continue;
      laneComputable += 1;
      laneRemaining += (1 - utilization) * weight;
      laneRemainingWeight += weight;
      laneProjected += projected * weight;
      laneProjectedWeight += weight;
      if (laneUtilization === null || utilization > laneUtilization) laneUtilization = utilization;
      // Reset order compares reset times only; it must not need a fleet clock.
      const resetMs = Date.parse(account?.governingResetAt ?? "");
      if (Number.isFinite(resetMs)) {
        if (laneResetMs === null || resetMs < laneResetMs) laneResetMs = resetMs;
        if (soonestResetMs === null || resetMs < soonestResetMs) {
          soonestResetMs = resetMs;
          soonestResetAt = account.governingResetAt;
        }
      }
    }

    computableAccountCount += laneComputable;
    if (!tripped) untrippedComputableWeight += laneProjectedWeight;
    inventoryLanes.push({
      laneId,
      knownAccountCount: verdict?.knownAccountCount ?? 0,
      knownWeight: verdict?.knownWeight ?? 0,
      serviceableAccountCount: verdict?.serviceableAccountCount ?? 0,
      computableAccountCount: laneComputable,
    });

    const remainingFraction = laneRemainingWeight > 0 ? laneRemaining / laneRemainingWeight : null;
    const projected = laneProjectedWeight > 0 ? laneProjected / laneProjectedWeight : null;
    if (remainingFraction !== null) {
      fleetRemaining += laneRemaining;
      fleetRemainingWeight += laneRemainingWeight;
    }
    if (projected !== null) {
      fleetProjected += laneProjected;
      fleetProjectedWeight += laneProjectedWeight;
    }

    if (laneResetMs !== null && Number.isFinite(asOfMs)) {
      const hours = (laneResetMs - asOfMs) / 3_600_000;
      laneHoursToReset = hours > 0 ? hours : null;
    }
    let targetRatePerHour: number | null = null;
    let windowRatePerHour: number | null = null;
    if (laneHoursToReset !== null && laneUtilization !== null && windowSeconds !== null) {
      targetRatePerHour = Math.max(0, (targetLow - laneUtilization) / laneHoursToReset);
      const elapsedHours = windowSeconds / 3600 - laneHoursToReset;
      windowRatePerHour = elapsedHours > 0 ? laneUtilization / elapsedHours : null;
    }

    laneRates.push({
      laneId,
      remainingFraction,
      projected,
      hoursToReset: laneHoursToReset,
      targetRatePerHour,
      windowRatePerHour,
      computableAccounts: laneComputable,
      blocked,
    });

    if (!blocked && projected !== null && laneResetMs !== null) {
      spendCandidates.push({ laneId, resetMs: laneResetMs, projected });
    } else {
      withheld.push(laneId);
    }
  }

  // Spend the lanes whose reset is soonest and whose headroom is largest
  // first: earliest reset wins, lowest projection (most headroom) breaks ties.
  spendCandidates.sort((a, b) => a.resetMs - b.resetMs || a.projected - b.projected);
  const spendOrder = spendCandidates.map((entry) => entry.laneId);

  const fleetRemainingFraction = fleetRemainingWeight > 0 ? fleetRemaining / fleetRemainingWeight : null;
  const fleetProjectedValue = fleetProjectedWeight > 0 ? fleetProjected / fleetProjectedWeight : null;
  const trippedShare = trippedWeight > 0 ? trippedWeight / (trippedWeight + untrippedComputableWeight) : 0;
  const backstopCapsFleet = trippedLanes.length > 0 && trippedShare >= backstopHoldShare;
  const backstop = (capped: boolean): FleetAdmissionBackstop => ({
    trippedLanes,
    trippedShare,
    holdShare: backstopHoldShare,
    capped,
  });

  if (fleetProjectedValue === null) {
    const anyBlocked = laneRates.some((lane) => lane.blocked);
    return {
      asOf,
      level: "unknown",
      admissionFraction: null,
      reason: anyBlocked ? "all-lanes-blocked" : "all-lanes-unknown",
      remainingFraction: fleetRemainingFraction,
      projected: null,
      soonestResetAt,
      spendOrder: [],
      withheld,
      backstop: backstop(false),
      inventory: { knownAccountCount, knownWeight, serviceableAccountCount, computableAccountCount, lanes: inventoryLanes },
      lanes: laneRates,
    };
  }

  const underUse = fleetProjectedValue < targetLow;
  const raw: Exclude<FleetAdmissionLevel, "unknown"> = underUse
    ? "boost"
    : levelForProjected(fleetProjectedValue, holdAt, conserveAt);
  const leveled = applyHysteresis({
    raw,
    previous: input.previousLevel ?? null,
    projected: fleetProjectedValue,
    boostBelow: targetLow,
    holdAt,
    conserveAt,
    hysteresis: Math.max(0, hysteresis),
  });

  // The five-hour serviceability backstop caps but never sets the weekly
  // level, and it is sized by how much of the fleet it covers. A tripped lane
  // is already withheld from the spend order, so a minority trip leaves the
  // weekly level alone — holding every healthy lane would strand their weekly
  // allowance. Once tripped lanes carry `backstopHoldShare` of the fleet's
  // accounted weight, the fleet holds at most: no boost into a mostly hot
  // fleet, and never a conserve on five-hour grounds alone.
  const capped = backstopCapsFleet && (leveled === "boost" || leveled === "normal") ? "hold" as const : leveled;
  const fraction = Math.min(maxAdmission, Math.max(minAdmission, fractions[capped] ?? DEFAULT_FRACTIONS[capped]));

  return {
    asOf,
    level: capped,
    admissionFraction: minAdmission <= maxAdmission ? fraction : null,
    reason: capped !== leveled ? "capped-by-serviceability-backstop" : reasonFor(capped),
    remainingFraction: fleetRemainingFraction,
    projected: fleetProjectedValue,
    soonestResetAt,
    spendOrder,
    withheld,
    backstop: backstop(capped !== leveled),
    inventory: { knownAccountCount, knownWeight, serviceableAccountCount, computableAccountCount, lanes: inventoryLanes },
    lanes: laneRates,
  };
}
