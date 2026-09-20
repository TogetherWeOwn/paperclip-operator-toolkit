/**
 * The lane-evidence term (TOG-3132, second failure shape).
 *
 * WHY THE AVAILABILITY TERM IS NOT ENOUGH
 *
 * `availability.ts` reads the published cliproxy quota-contract document. That
 * document describes the lanes that HAVE a quota contract. Measured on
 * 2026-09-17, the lanes actually burning the fleet are the ones it never
 * mentions:
 *
 *   * `devin/*` — 0 successes in 74 dispatches across 7 models, every one a
 *     PROVIDER-level refusal: `503 auth_unavailable: no auth available
 *     (providers=devin)`. No quota document describes this lane, so
 *     `select.ts` reads it as UNKNOWN/`unmapped` and, with
 *     `holdOnUnknownAvailability` off, lets it through.
 *   * `qwen3.8-max` — 0 successes in 42 dispatches in the same 24h window, and
 *     named in no incident report at all.
 *
 * Both were re-derived for this module by `ops/tog-3132/lane_evidence2.js`.
 *
 * THE KEY IS `usage_json->>'model'`, AND THAT HAD TO BE CHECKED
 *
 * A term built on run outcomes is worthless if a run that dies before
 * inference carries no model. It was measured: of 408 failed runs in 24h, 391
 * carry `usage_json ? 'model'` — including all 74 `providers=devin` auth
 * refusals. Attribution survives a provider-level outage, so this term can see
 * exactly the failure the availability term cannot.
 *
 * WHY TRI-STATE, AND WHY A CONFIDENCE BOUND RATHER THAN A RATE
 *
 * A veto keyed on an observed failure RATE re-selects every newly added lane
 * forever: a lane with 0 recorded runs has no failures, so it looks perfect.
 * That is how `devin/gpt-6-astra` took cards while it had ~0 history. The fix
 * is a third state — a lane can be proven good, proven dead, or simply not yet
 * known — and the boundary has to be drawn on EVIDENCE STRENGTH, not on the
 * point estimate.
 *
 * So both verdicts are drawn from a Wilson score interval, which makes the
 * small-sample case correct by construction rather than by a hand-tuned
 * minimum:
 *
 *   * proven-dead  <- the 95% UPPER bound on the success rate is still at or
 *     below `deadThreshold`. Being wrong here costs a usable lane, so the
 *     burden of proof sits on the exclusion.
 *   * proven-good  <- the 95% LOWER bound is at or above `goodThreshold`.
 *   * unproven     <- anything else, including every lane with no history.
 *
 * Worked against the measured window, with the shipped defaults:
 *
 *   | lane                      | ok/n  | Wilson    | state       |
 *   |---------------------------|-------|-----------|-------------|
 *   | devin (all models)        | 0/74  | up 0.049  | proven-dead |
 *   | qwen3.8-max               | 0/42  | up 0.084  | proven-dead |
 *   | claude-haiku-4-5-20251001 | 34/42 | low 0.667 | proven-good |
 *
 * AND THE WILSON BOUND ALONE IS TOO SLOW — THE ZERO-SUCCESS RULE
 *
 * An earlier revision of this module stopped there, and cited
 * `deepseek-v4-flash` at 0/5 (upper 0.434) as proof the term was honest: five
 * failures is a bad sign, not a proof, so it was left admitted. Measurement
 * killed that argument. Solve `wilsonUpper(0, n) <= 0.2` and the first n that
 * satisfies it is **16** — a lane that has NEVER served must fail sixteen times
 * before the Wilson bound will exclude it. On 2026-09-17 09:22Z
 * `deepseek-v4-flash` sat at 0/10 on `500 no healthy managed OpenCode Go
 * capacity remains` with 11 open cards pinned to it, 5 of them product. Under
 * the bound alone it would have taken six more cards first.
 *
 * So zero successes is its own rule, not a point on the Wilson curve:
 *
 *   * proven-dead <- `succeeded === 0` over at least `zeroSuccessSamples`
 *     observations, whatever the interval says.
 *
 * The statistics were not wrong; the loss function was. A 95% bound is the
 * right burden of proof when being wrong is expensive, and here it is cheap:
 * an excluded lane takes no traffic, so it ages out of the window, returns to
 * zero recorded runs, and `evidenceStateFor` calls it `unproven` again —
 * admitted. Exclusion is therefore PROBATIONARY and self-healing, and its true
 * cost is bounded at `zeroSuccessSamples` burnt runs per window per dead lane.
 * Paying 16 to reach the same place buys nothing.
 *
 * The two rules are reported separately (`rule` below) because they answer
 * different operator questions: `wilson-upper` means "this lane serves too
 * rarely", `zero-success` means "this lane has never once served".
 *
 * THIS TERM IS SERVICEABILITY, NOT QUALITY
 *
 * `goodThreshold` defaults to 0.5 — "this lane serves more often than not" —
 * deliberately low. Whether a model does the work WELL is already gated by the
 * per-(model, tier) `capable` verdict in `scores.ts`. Setting a quality-grade
 * threshold here would duplicate that gate on a worse signal and exclude lanes
 * twice for the same reason.
 *
 * AGGREGATION IS PER LANE, NOT PER MODEL
 *
 * `providers=devin` is one credential failing for seven model ids at once. Per
 * model, each looks like a thin sample (8, 4, 3 runs); per lane they are one
 * conclusive 0/74. The lane is the unit the failure actually has.
 */

/** 95% two-sided normal quantile — the `z` in the Wilson interval below. */
const Z_95 = 1.959_963_985;

/**
 * Below this many observations a lane is never called proven-GOOD, however
 * clean its record. The Wilson bound already refuses to call a thin sample
 * dead; this is the mirror guard, so one lucky run cannot anoint a lane and
 * make it a valid cost-down destination.
 */
export const EVIDENCE_MIN_SAMPLES = 5;

/**
 * A lane with ZERO successes over at least this many observations is dead,
 * whatever the Wilson bound says. Held equal to `EVIDENCE_MIN_SAMPLES` on
 * purpose: the same amount of evidence that can anoint a lane can condemn one
 * that has never served. Separate constant so the two can be retuned apart.
 */
export const EVIDENCE_ZERO_SUCCESS_SAMPLES = EVIDENCE_MIN_SAMPLES;

/** A lane whose success rate is provably at or under this is dead. */
export const EVIDENCE_DEAD_THRESHOLD = 0.2;

/** A lane whose success rate is provably at or over this is good. */
export const EVIDENCE_GOOD_THRESHOLD = 0.5;

export type LaneEvidenceState = "proven-good" | "proven-dead" | "unproven";

/**
 * Which rule produced the state — carried onto the decision so `decisions.jsonl`
 * answers "why did this card not get opus" with the specific test that fired
 * (AC-6), not just the verdict.
 */
export type LaneEvidenceRule =
  | "no-runs"
  | "zero-success"
  | "wilson-upper"
  | "wilson-lower"
  | "inconclusive";

export interface LaneOutcomeCounts {
  laneId: string;
  /** Runs that reached `succeeded`. NOT `completed` — that value does not exist. */
  succeeded: number;
  /** Runs that reached a terminal failure: `failed` or `timed_out`. */
  failed: number;
}

export interface LaneEvidence extends LaneOutcomeCounts {
  state: LaneEvidenceState;
  /** The specific test that produced `state`. */
  rule: LaneEvidenceRule;
  total: number;
  /** Point estimate. Present for the trace; never the thing a verdict is drawn from. */
  successRate: number | null;
  lowerBound: number;
  upperBound: number;
  reason: string;
}

export interface LaneEvidenceSnapshot {
  lanes: readonly LaneEvidence[];
  /** Window the counts were drawn over, for the decision record. */
  windowHours: number;
  /**
   * Set when the evidence could not be read at all. Every lane is then
   * `unproven` — which excludes nothing, but still blocks a cost-down move,
   * and must be SAID rather than passing quietly (AC-4).
   */
  unreadableReason: string | null;
}

export interface EvidenceThresholds {
  minSamples?: number;
  zeroSuccessSamples?: number;
  deadThreshold?: number;
  goodThreshold?: number;
}

/**
 * Wilson score interval for a binomial proportion. Chosen over the normal
 * approximation precisely because the interesting rows here are 0/5 and 0/74,
 * where the normal interval collapses to zero width and would call both of
 * them dead with equal confidence.
 */
export function wilsonInterval(
  successes: number,
  total: number,
  z: number = Z_95,
): { lower: number; upper: number } {
  if (total <= 0) return { lower: 0, upper: 1 };
  const phat = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (phat + z2 / (2 * total)) / denominator;
  const margin =
    (z / denominator) * Math.sqrt((phat * (1 - phat)) / total + z2 / (4 * total * total));
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

/** One lane's counts -> one verdict. Pure; no clock, no IO. */
export function evaluateLaneEvidence(
  counts: LaneOutcomeCounts,
  thresholds: EvidenceThresholds = {},
): LaneEvidence {
  const minSamples = thresholds.minSamples ?? EVIDENCE_MIN_SAMPLES;
  const zeroSuccessSamples = thresholds.zeroSuccessSamples ?? EVIDENCE_ZERO_SUCCESS_SAMPLES;
  const dead = thresholds.deadThreshold ?? EVIDENCE_DEAD_THRESHOLD;
  const good = thresholds.goodThreshold ?? EVIDENCE_GOOD_THRESHOLD;

  const succeeded = Math.max(0, Math.trunc(counts.succeeded));
  const failed = Math.max(0, Math.trunc(counts.failed));
  const total = succeeded + failed;
  const { lower, upper } = wilsonInterval(succeeded, total);
  const successRate = total > 0 ? succeeded / total : null;
  const base = {
    laneId: counts.laneId,
    succeeded,
    failed,
    total,
    successRate,
    lowerBound: lower,
    upperBound: upper,
  };

  if (total === 0) {
    return {
      ...base,
      state: "unproven",
      rule: "no-runs",
      reason: `${counts.laneId}: no recorded runs in the window`,
    };
  }
  // Dead is tested first: a lane cannot be both, and a lane that is provably
  // failing is the verdict an operator needs to see named.
  //
  // Zero-success leads, because it is the rule that fires EARLIER — a lane that
  // has never served is dead at `zeroSuccessSamples` observations, where the
  // Wilson bound would wait for 16. Reporting `wilson-upper` on a row that the
  // zero-success rule already condemned would misattribute the exclusion.
  if (succeeded === 0 && total >= zeroSuccessSamples) {
    return {
      ...base,
      state: "proven-dead",
      rule: "zero-success",
      reason:
        `${counts.laneId}: 0/${total} succeeded — no lane success in ${total} observations ` +
        `(zero-success rule fires at ${zeroSuccessSamples})`,
    };
  }
  if (upper <= dead) {
    return {
      ...base,
      state: "proven-dead",
      rule: "wilson-upper",
      reason:
        `${counts.laneId}: ${succeeded}/${total} succeeded — 95% upper bound ${upper.toFixed(3)} ` +
        `is at or below the ${dead} dead threshold`,
    };
  }
  if (total >= minSamples && lower >= good) {
    return {
      ...base,
      state: "proven-good",
      rule: "wilson-lower",
      reason:
        `${counts.laneId}: ${succeeded}/${total} succeeded — 95% lower bound ${lower.toFixed(3)} ` +
        `is at or above the ${good} good threshold`,
    };
  }
  return {
    ...base,
    state: "unproven",
    rule: "inconclusive",
    reason:
      `${counts.laneId}: ${succeeded}/${total} succeeded — 95% interval ` +
      `[${lower.toFixed(3)}, ${upper.toFixed(3)}] proves neither good nor dead`,
  };
}

/** Roll a set of per-lane counts into a snapshot. */
export function buildLaneEvidence(
  counts: readonly LaneOutcomeCounts[],
  windowHours: number,
  thresholds: EvidenceThresholds = {},
): LaneEvidenceSnapshot {
  const lanes = counts
    .map((entry) => evaluateLaneEvidence(entry, thresholds))
    .sort((left, right) => left.laneId.localeCompare(right.laneId));
  return { lanes, windowHours, unreadableReason: null };
}

/**
 * Look a lane up. A lane absent from the snapshot is `unproven`, never
 * available-by-default: "no evidence" is the state this term exists to name.
 */
export function evidenceStateFor(
  snapshot: LaneEvidenceSnapshot | undefined,
  laneId: string | null,
): LaneEvidenceState {
  if (!snapshot || snapshot.unreadableReason) return "unproven";
  if (!laneId) return "unproven";
  return snapshot.lanes.find((lane) => lane.laneId === laneId)?.state ?? "unproven";
}

/**
 * The cost-down guard, as a named predicate so both `select.ts` and the
 * worker's `balance_pass` apply the SAME rule.
 *
 * A move is refused when it leaves a proven-good lane for one that is not
 * proven good. `devin/gpt-6-astra` had ~0 runs and took cards off
 * `claude-haiku-4-5-20251001` at 34/42; under this predicate it cannot.
 *
 * Note the direction: this never blocks a move ONTO a proven-good lane, and
 * never blocks leaving a lane that is not proven good. An unproven lane can
 * still be explored from another unproven lane — the exploration slot in
 * `balance_pass` stays intact.
 */
export function costDownWouldAbandonProvenLane(
  fromState: LaneEvidenceState,
  toState: LaneEvidenceState,
): boolean {
  return fromState === "proven-good" && toState !== "proven-good";
}
