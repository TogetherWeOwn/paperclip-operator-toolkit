import type { Tier } from "../constants.js";
import type { ResolvedConfig } from "../config/resolve.js";
import { enforceMonotoneCapability } from "../engine/scores.js";
import type { EarnInState, ModelScore } from "../engine/types.js";

/**
 * Bounded T1 earn-in ( §3,  decision B). Default OFF —
 * `planEarnIn` is a pure decision function; `worker.ts` never calls it unless
 * `config.earnIn.enabled === true`, and the shipped config keeps that false.
 *
 * "Every 12th eligible pick goes to the highest-prior unproven candidate" is a
 * documented constant (`SELECTION_COUNTER_MODULUS`), never `Math.random()` —
 * determinism is itself an acceptance criterion (named mutant: swap in
 * randomness).
 */
export const SELECTION_COUNTER_MODULUS = 12;

/**
 * `perModelPerWeek` is a ROLLING window, not a lifetime cap — `planEarnIn`
 * filters `state.dispatchedThisWeek` to this width itself rather than trusting
 * a caller to have pruned it, so the cap holds even under an injected/skewed
 * clock (named mutant: exceed-8-with-injected-clock).
 */
export const ROLLING_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type LanePosture = "available" | "saturated";
export type PacePosture = "behind" | "on-pace" | "ahead" | "unknown";

/**
 * Lane posture MUST be resolved per tier, never as a single flat value. A
 * T3-only lane (e.g. a zen-free lane) can read "available" company-wide while
 * the T1 lane earn-in actually targets is starved — collapsing this to one
 * global posture would let earn-in dispatch into a starved T1 lane just
 * because some other tier's lane had headroom (named mutant:
 * global-lane-check-passes-while-target-tier-starved).
 */
export type LanePostureByTier = Record<Tier, LanePosture>;

export interface EarnInCandidateCard {
  issueId: string;
  modelId: string;
  lane: string;
  /** Card must be T1 — earn-in only ever admits unproven candidates into the top tier. */
  tier: "T1";
  status: string;
  /** True if a run is currently active on this card. */
  hasRunningRun: boolean;
  /** `research` | `review` per  §3. Anything else is out of scope. */
  workClass: string;
  hasOperatorPin: boolean;
  hasExclusion: boolean;
  requiresCredentials: boolean;
  requiresPermissionsOrApprovals: boolean;
}

export interface EarnInDecision {
  dispatch: boolean;
  reason: string;
  cohortTag: string | null;
  idempotencyKey: string | null;
}

function nothing(reason: string): EarnInDecision {
  return { dispatch: false, reason, cohortTag: null, idempotencyKey: null };
}

/**
 * Pure eligibility + cap + lane-gate + determinism decision for one candidate
 * card. Mirrors `actuate/apply.ts`'s `planApply()` shape: no I/O, callers own
 * the state read/write and the idempotency check against `state.dispatchedKeys`.
 */
export function planEarnIn(
  card: EarnInCandidateCard,
  modelScore: ModelScore | null,
  state: EarnInState,
  config: ResolvedConfig["earnIn"],
  lanePostureByTier: LanePostureByTier,
  pacePosture: PacePosture,
  isClaudeModel: boolean,
  nowMs: number,
): EarnInDecision {
  if (!config.enabled) {
    return nothing("earn-in is disabled for this company");
  }
  if (state.stopped[card.modelId]) {
    return nothing(`${card.modelId} is stopped: 2+ material first-submission failures or a safety/authority violation`);
  }
  if (card.tier !== "T1") {
    return nothing("earn-in only ever admits T1 work (never T0, which is operator-recorded)");
  }
  if (!config.classes.includes(card.workClass)) {
    return nothing(`work class ${card.workClass} is not in the configured earn-in classes`);
  }
  if (card.status !== "todo") {
    return nothing(`card status is ${card.status}, not todo`);
  }
  if (card.hasRunningRun) {
    return nothing("card has a running run");
  }
  if (card.hasOperatorPin) {
    return nothing("card carries an operator pin");
  }
  if (card.hasExclusion) {
    return nothing("card carries a capability exclusion");
  }
  if (card.requiresCredentials) {
    return nothing("card requires credentials — excluded from earn-in");
  }
  if (card.requiresPermissionsOrApprovals) {
    return nothing("card requires permissions/approvals — excluded from earn-in");
  }

  if (!modelScore) {
    return nothing(`no model score for ${card.modelId}; cannot judge capable/proven`);
  }
  // the monotone verdict, so an unproven T1 above a failed T2 is not capable.
  const t1 = enforceMonotoneCapability(modelScore.tiers).T1;
  if (t1.proven) {
    return nothing(`${card.modelId} is already proven at T1; not an earn-in candidate`);
  }
  if (t1.capable === false) {
    return nothing(`${card.modelId} is not judged capable at T1`);
  }

  const idempotencyKey = `${card.issueId}:${card.modelId}:earnin`;
  if (state.dispatchedKeys.includes(idempotencyKey)) {
    return nothing(`already dispatched: ${idempotencyKey}`);
  }

  // Filter to the rolling window ourselves — never trust a caller to have
  // pruned `dispatchedThisWeek`, and never let an injected/skewed `nowMs`
  // widen the window into counting stale dispatches as fresh capacity.
  const windowStartMs = nowMs - ROLLING_WEEK_MS;
  const dispatchedThisWeek = (state.dispatchedThisWeek[card.modelId] ?? []).filter((ts) => ts > windowStartMs).length;
  if (dispatchedThisWeek >= config.perModelPerWeek) {
    return nothing(`${card.modelId} already dispatched ${dispatchedThisWeek}/${config.perModelPerWeek} this rolling week`);
  }
  if ((state.activePerModel[card.modelId] ?? 0) >= config.maxActivePerModel) {
    return nothing(`${card.modelId} already has an active earn-in card`);
  }
  if ((state.activePerLane[card.lane]?.length ?? 0) >= config.maxActivePerLane) {
    return nothing(`lane ${card.lane} already has an active earn-in card`);
  }

  // Look up the posture for the CARD'S OWN tier, not some other tier's lane
  // and not a collapsed global flag — a T1 card must never ride on a T3
  // lane's availability.
  const lanePosture = lanePostureByTier[card.tier];
  if (lanePosture !== "available") {
    return nothing(`${card.tier} lane posture is ${lanePosture}, not available`);
  }
  if (isClaudeModel && pacePosture !== "behind") {
    return nothing(`Claude pace posture is ${pacePosture}, not behind — earn-in only fires when Claude is behind pace`);
  }

  const counter = state.counter[card.modelId] ?? 0;
  if (counter % SELECTION_COUNTER_MODULUS !== 0) {
    return nothing(`counter ${counter} is not a multiple of ${SELECTION_COUNTER_MODULUS} — not this candidate's turn`);
  }

  const cohortTag = `earnin:${card.modelId}`;
  return {
    dispatch: true,
    reason: `dispatching ${card.modelId} on ${card.issueId}: unproven, capable, lane available, counter ${counter} % ${SELECTION_COUNTER_MODULUS} === 0`,
    cohortTag,
    idempotencyKey,
  };
}

/** True when `outcome` should count toward the stop-on-2-of-first-8 circuit breaker. */
export function isMaterialFailure(outcome: "ok" | "material-failure"): boolean {
  return outcome === "material-failure";
}

/**
 * Folds one dispatched-and-resolved earn-in card's outcome into `EarnInState`,
 * returning a new state. Stops the model (sticky) on 2 material failures
 * within its first 8 outcomes, or immediately on `safetyOrAuthorityViolation`.
 */
export function recordEarnInOutcome(
  state: EarnInState,
  modelId: string,
  outcome: "ok" | "material-failure",
  safetyOrAuthorityViolation: boolean,
): EarnInState {
  const prior = state.firstEightOutcomes[modelId] ?? [];
  const outcomes = prior.length < 8 ? [...prior, outcome] : prior;
  const materialFailures = outcomes.filter(isMaterialFailure).length;
  const stopped =
    state.stopped[modelId] === true || safetyOrAuthorityViolation || (outcomes.length <= 8 && materialFailures >= 2);

  return {
    ...state,
    firstEightOutcomes: { ...state.firstEightOutcomes, [modelId]: outcomes },
    stopped: { ...state.stopped, [modelId]: stopped },
  };
}
