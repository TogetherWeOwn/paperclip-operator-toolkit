import { DEFAULT_MARGIN, type LanePaceObservation, type LanePaceVerdict, type PaceState } from "../lane-capacity/pace.js";
import { OPERATOR_PIN_LABEL } from "../constants.js";
import { activeModelCooldown, type ModelCooldown } from "../lane-capacity/counts-only.js";
import { compareSamePriceFamily } from "./same-price-family.js";
import type { Candidate, ModelEntry } from "./types.js";

/**
 * Per-lane state this plugin persists across polls. Keyed by `laneId`, the
 * same id a `ModelEntry.laneId` points at.
 */
export interface LaneLedgerEntry {
  laneId: string;
  verdict: LanePaceVerdict | null;
  /**
   * The normalized per-account, per-window document behind `verdict`. Carried
   * separately because `verdict.score` only reports the account's GOVERNING
   * (largest allowance) window — for a lane with more than one allowance
   * window (e.g. zai: 5h AND weekly) the non-governing window's utilization
   * is only readable here. Used by `lane5hUtilization`/`laneHealthyAccountCount`
   * (tier_dispatcher.py `lane_5h`/`lane_accounts` port). Null exactly when
   * `verdict` is null.
   */
  observation: LanePaceObservation | null;
  /** When this entry was last written, regardless of whether the poll succeeded. */
  fetchedAt: string;
  /** Null on a clean poll. A failed poll degrades `verdict` to null, never overwrites a good one with a stale guess (see `mergeLedgerEntry`). */
  error: string | null;
  /**
   * . When a SUCCESSFUL poll last found this lane unserviceable, and
   * why — the onset timestamp, held across subsequent failed polls.
   *
   * `verdict` alone cannot carry this. A failed poll degrades `verdict` to
   * null (above), and `hardStopExcluded` reads the verdict, so losing the
   * poll ERASED an exclusion the lane had already earned: a lane measured
   * exhausted at 16:55Z became admissible again the moment the poll flapped,
   * which is how 21 runs launched onto a hard-429ing lane on 09-16. Absence
   * of evidence was being read as evidence of capacity.
   *
   * So this field records the OBSERVATION rather than the reading. It is
   * written only from a verdict that was actually returned, and cleared only
   * by a later verdict that actually says the lane is serviceable again — a
   * failed poll leaves it exactly as it was. `unserviceableSince` keeps the
   * ONSET, not the most recent confirmation, so an operator can see how long
   * a lane has been out.
   *
   * Null on a lane that has never been observed unserviceable — including one
   * never polled at all, which stays fail-neutral as before. `undefined` on an
   * entry persisted before this field existed; read it through `?? null` so an
   * old ledger degrades to "no observation" instead of excluding every lane.
   */
  unserviceableSince?: string | null;
  /** The `verdict.reason` carried by the observation that set `unserviceableSince`. */
  unserviceableReason?: LanePaceVerdict["reason"] | null;
  /**
   * . The lane's combined utilization (see `laneCombinedUtilization`),
   * written only from a verdict a poll actually returned and carried across
   * failed polls, for the same reason as `unserviceableSince`: a flapping poll
   * must not move a withdrawn lane back to admissible. It is bounded by
   * `resetsAt` instead of by age, because a window rollover is what makes the
   * reading wrong, not the clock. `undefined` on an entry persisted before
   * this field existed; read it through `?? null`.
   */
  combinedUtilization?: LaneCombinedUtilization | null;
  /** Retained across failed polls, bounded by source freshness AND cooldown expiry. */
  modelCooldownEvidence?: Array<{
    observedAt: string;
    staleAfterSeconds: number;
    entries: ModelCooldown[];
  }>;
  /**
   *  (D1e). Consecutive lane-capacity polls with zero successes, where
   * success is a clean poll (`error === null`) whose verdict says
   * `serviceable === true`. Any poll error, `serviceable === false`, or
   * null/indeterminate verdict increments; any success resets to zero.
   * Optional so a ledger persisted before this field existed reads as zero
   * (`?? 0`) instead of vetoing every lane it holds.
   */
  consecutiveNonSuccess?: number;
}

export type LaneLedger = Record<string, LaneLedgerEntry>;

/** . One lane-wide utilization reading, with the instant it stops being evidence. */
export interface LaneCombinedUtilization {
  /** Capacity-weighted mean account utilization, 0-1, unserviceable accounts counted as fully spent. */
  utilization: number;
  /** Accounts that contributed a reading. */
  accounts: number;
  /** Earliest governing-window reset among the contributors. At or after it the reading no longer describes the lane. */
  resetsAt: string | null;
  /** `fetchedAt` of the poll that produced the reading. */
  measuredAt: string;
}

/**
 * . The lane's combined utilization: the capacity-weighted mean of its
 * accounts' governing-window utilization, where an account the pace engine calls
 * unserviceable counts as fully spent (1.0).
 *
 * That last clause is the point of the definition. `pace.ts` trips an account
 * at `1 - margin`, so an exhausted account reads 0.99 and a plain mean of seven
 * exhausted accounts and one at 0.85 is 0.9725 — under a 0.98 ceiling while
 * one account with 15% left carries all of the lane. Counting the account as
 * what it is for dispatch, a source of no more capacity, gives 0.98125. Against
 * 579 recorded T1 decisions this reading crosses 0.98 in exactly the regime the
 * live bridge withdraws the lane (0.9812 against the bridge's 0.98) and stays
 * under it in the regime the bridge does not (0.9775 at most); the plain mean
 * does neither (docs/lane-withdrawal.md).
 *
 * The live bridge's own definition has not been mirrored yet, so this is the
 * best-supported reading, not a port. An account with no governing-window
 * reading is left out of the mean (no evidence either way). Weights are the
 * reported account weights when every contributor has one, equal otherwise —
 * mixing reported and defaulted weights would skew the mean. Null when no
 * account contributes: a free lane, or one nobody can read.
 */
export function laneCombinedUtilization(verdict: LanePaceVerdict, measuredAt: string): LaneCombinedUtilization | null {
  const readings = verdict.accounts.flatMap((account) => {
    const utilization = account.score?.utilization;
    if (typeof utilization !== "number" || !Number.isFinite(utilization)) return [];
    return [{
      utilization: account.serviceable ? Math.min(1, Math.max(0, utilization)) : 1,
      weight: typeof account.weight === "number" && Number.isFinite(account.weight) && account.weight > 0 ? account.weight : null,
      resetAt: account.governingResetAt ?? null,
    }];
  });
  if (readings.length === 0) return null;
  const weighted = readings.every((reading) => reading.weight !== null);
  let spent = 0;
  let total = 0;
  for (const reading of readings) {
    const weight = weighted ? reading.weight! : 1;
    spent += weight * reading.utilization;
    total += weight;
  }
  const resets = readings.flatMap((reading) => (reading.resetAt && Number.isFinite(Date.parse(reading.resetAt)) ? [reading.resetAt] : []));
  return {
    utilization: spent / total,
    accounts: readings.length,
    resetsAt: resets.length > 0 ? resets.reduce((earliest, at) => (Date.parse(at) < Date.parse(earliest) ? at : earliest)) : null,
    measuredAt,
  };
}

/**
 * A running/queued issue's operator override, e.g. "route to this model
 * regardless of pace" — recorded with an expiry so a stale override cannot
 * silently outlive the incident that justified it.
 */
export interface OperatorOverrideEntry {
  issueId: string;
  modelId: string;
  setAt: string;
  expiresAt: string;
}

export type OperatorOverrideLedger = Record<string, OperatorOverrideEntry>;

/**
 * Merge one poll result into the ledger. A failed poll (`result.error` set)
 * NEVER overwrites a prior good verdict with a guess — it just records the
 * failure and leaves `verdict` as whatever the poll returned (null on
 * failure), so a reader always sees either a fresh verdict or an honest
 * "we don't know" rather than a fabricated one. One lane's failure has no
 * effect on any other lane's entry — callers merge one result at a time.
 *
 * : that honesty is right for `verdict` and wrong as the ONLY record
 * of serviceability, because it silently discards a measurement already
 * taken. `unserviceableSince` is the durable half — updated only from a
 * verdict this poll actually returned, carried forward untouched when the
 * poll returned none. The invariant is that a failed poll can never MOVE a
 * lane from excluded to admissible; only a successful poll finding the lane
 * serviceable does that.
 */
export function mergeLedgerEntry(
  ledger: LaneLedger,
  result: {
    laneId: string;
    fetchedAt: string;
    verdict: LanePaceVerdict | null;
    observation?: LanePaceObservation | null;
    error: string | null;
  },
): LaneLedger {
  const previous = ledger[result.laneId];
  // `null` = this poll returned no verdict, so it is evidence of nothing and
  // the prior observation stands. `true`/`false` = a verdict was returned and
  // it decides the question outright.
  const observed = result.verdict ? unserviceableVerdict(result.verdict) : null;
  const priorSince = previous?.unserviceableSince ?? null;
  const priorReason = previous?.unserviceableReason ?? null;

  let unserviceableSince: string | null;
  let unserviceableReason: LanePaceVerdict["reason"] | null;
  if (observed === null) {
    unserviceableSince = priorSince;
    unserviceableReason = priorReason;
  } else if (observed) {
    // Keep the ONSET across repeated confirmations, so the field measures how
    // long the lane has been out rather than when it was last re-checked.
    unserviceableSince = priorSince ?? result.fetchedAt;
    unserviceableReason = result.verdict!.reason;
  } else {
    unserviceableSince = null;
    unserviceableReason = null;
  }

  //  (D1e). A failed poll can never MOVE a lane from excluded to
  // admissible (see above); the same discipline applies to the streak — only
  // a clean poll whose verdict says `serviceable === true` resets it. A
  // `lane-secret-unavailable` merge carries a null verdict, so it increments
  // like any other non-success rather than freezing the streak in place.
  const pollSucceeded = result.error === null && result.verdict?.serviceable === true;
  const consecutiveNonSuccess = pollSucceeded ? 0 : (previous?.consecutiveNonSuccess ?? 0) + 1;

  const combined =
    (result.verdict ? laneCombinedUtilization(result.verdict, result.fetchedAt) : null) ??
    previous?.combinedUtilization ??
    null;

  return {
    ...ledger,
    [result.laneId]: {
      laneId: result.laneId,
      verdict: result.verdict,
      observation: result.observation ?? null,
      fetchedAt: result.fetchedAt,
      error: result.error,
      unserviceableSince,
      unserviceableReason,
      // : a verdict that yields no reading (free lane, unreadable
      // accounts) is evidence of nothing, so the prior reading stands until its
      // window resets; only a poll that measured the lane replaces it.
      ...(combined ? { combinedUtilization: combined } : {}),
      modelCooldownEvidence: result.verdict
        ? cooldownEvidence(result.observation ?? null)
        : previous?.modelCooldownEvidence ?? cooldownEvidence(previous?.observation ?? null),
      consecutiveNonSuccess,
    },
  };
}

export function laneVerdictFor(ledger: LaneLedger, laneId: string | null | undefined): LanePaceVerdict | null {
  if (!laneId) return null;
  return ledger[laneId]?.verdict ?? null;
}

/**
 * Within-tier preference order, most to least preferred. A lane running
 * behind its fair-share pace should get volume routed to it before its
 * allowance window closes unused; a lane already ahead should not get more.
 * `exhausted` ranks last here as a tie-break signal only — the actual
 * exclusion of an exhausted lane's model happens in `hardStopExcluded`,
 * which runs before ordering, not through this rank.
 */
const PACE_STATE_RANK: Record<PaceState, number> = {
  "behind-urgent": 0,
  behind: 1,
  on: 2,
  unknown: 3,
  free: 4,
  ahead: 5,
  exhausted: 6,
};

function paceStateOf(ledger: LaneLedger, model: ModelEntry | undefined): PaceState {
  if (!model) return "unknown";
  return laneVerdictFor(ledger, model.laneId ?? null)?.state ?? "unknown";
}

/**
 * : the only lane states the balance pass pulls idle pins toward —
 * a lane trailing its fair-share pace should get volume routed to it before
 * its allowance window closes unused. Everything else (including `on`,
 * `ahead`, and `unknown`) is never a pace-pull target.
 */
const PACE_PULL_STATES: ReadonlySet<PaceState> = new Set(["behind", "behind-urgent"]);

/** : whether this model's lane is trailing pace. `unknown` (unobserved or lane-less) is never behind. */
export function isBehindPace(ledger: LaneLedger, model: ModelEntry | undefined): boolean {
  return PACE_PULL_STATES.has(paceStateOf(ledger, model));
}

/**
 * : this model's lane rank in the new-pin preference order (lower =
 * more preferred). The balance-pass pace-pull gate requires the target's rank
 * to be strictly better (lower) than the pinned lane's, so a pull never moves
 * a card sideways between equally-behind lanes or backwards onto a
 * better-paced lane. The rank map itself stays private — all ordering stays
 * in `orderCandidatesByPace`.
 */
export function pacePreferenceRank(ledger: LaneLedger, model: ModelEntry | undefined): number {
  return PACE_STATE_RANK[paceStateOf(ledger, model)];
}

function deviationOf(ledger: LaneLedger, model: ModelEntry | undefined): number {
  if (!model) return 0;
  return laneVerdictFor(ledger, model.laneId ?? null)?.score?.deviation ?? 0;
}

/**
 * Use-before-expiry pull: headroom-per-hour for one lane's
 * allowance windows — remaining weekly headroom divided by hours to reset,
 * summed over every serviceable behind-pace window the lane reports. A lane
 * with 89 points of weekly headroom expiring in 48 h pulls harder (1.85/h)
 * than a lane with 83 points expiring in 168 h (0.49/h), even though both
 * read "behind" — the Muse use-before-expiry case from 2026-10-03, where
 * lanes 7/5/2 held 89/39/26 points of headroom to the same 10-05 reset while
 * the plain elapsed/deviation rank saw them as interchangeable.
 *
 * Pure capacity math, not an admission gate: the 5h brake, the weekly-pace
 * rule, and `hardStopExcluded` all run upstream and unchanged. Windows at or
 * past full (utilization >= 1) contribute nothing — an exhausted window has no
 * headroom to spend. A lane with no computable window scores 0, exactly like
 * the `unknown` rank it already carries. Higher pulls first; ties fall
 * through to cost below.
 */
export function expiryPull(verdict: LanePaceVerdict | null, nowMs: number): number {
  if (!verdict || verdict.serviceable !== true) return 0;
  let pull = 0;
  for (const account of verdict.accounts) {
    if (!account.serviceable || !Array.isArray(account.windows)) continue;
    for (const window of account.windows) {
      if (window.role !== "allowance" || !window.serviceable) continue;
      if (typeof window.utilization !== "number" || typeof window.resetsAt !== "string") continue;
      if (window.utilization >= 1) continue;
      const resetMs = Date.parse(window.resetsAt);
      if (!Number.isFinite(resetMs)) continue;
      const hoursLeft = (resetMs - nowMs) / 3_600_000;
      if (!(hoursLeft > 0)) continue;
      pull += ((1 - window.utilization) * 100) / hoursLeft;
    }
  }
  return pull;
}

function expiryPullOf(ledger: LaneLedger, model: ModelEntry | undefined, nowMs: number): number {
  if (!model) return 0;
  return expiryPull(laneVerdictFor(ledger, model.laneId ?? null), nowMs);
}

function modelOf(models: readonly ModelEntry[], candidate: Candidate): ModelEntry | undefined {
  return models.find((model) => model.id === candidate.modelId);
}

/**
 * , Defect 5. Fraction of a governing window's duration (0-1) after
 * which a trailing lane is considered close enough to reset that its unused
 * allowance is at risk of being wasted. 0.8 = the last 20% of the window.
 */
export const PREFERRED_ELAPSED_THRESHOLD = 0.8;

/**
 * , Defect 5: the pace engine was brake-only. `hardStopExcluded`
 * excludes an exhausted lane and `slotFactorFor` throttles a lane running
 * `ahead` — both only ever hold a lane BACK. Nothing on the other side ever
 * PREFERS a lane, so a lane trailing its elapsed-fraction trajectory can
 * ride out its whole reset window under-used: the allowance is not banked
 * or refunded, it is simply gone once the window rolls over. As a window's
 * close nears (elapsed fraction >= `elapsedThreshold`, default the last 20%)
 * with utilization still behind that elapsed fraction (deviation < 0), the
 * lane becomes PREFERRED for new dispatch — the gas-pedal counterpart to
 * the two existing brakes.
 *
 * This only ever reads `verdict.score`, which the vendored pace engine
 * (`pace.ts`) populates solely for a lane with a computable governing
 * (allowance-role) window. A `free` (unmetered/subscription) lane, or one
 * whose config defines no allowance window at all — the shape that maps to
 * the reference dispatcher's fixed `AVOID`/`AVOID_LANE` thresholds, which
 * gate on a flat utilization reading with no reset-window concept — returns
 * `score: null` and cannot be classified as preferred here. Extending the
 * same two-sided treatment to that case needs the vendored verdict to expose
 * a raw serviceability-window utilization number, which it does not; that is
 * an upstream `@togetherweown/lane-capacity` change, not something this
 * plugin can compute locally without forking pace.ts's own account-level
 * logic. Tracked as a follow-up rather than silently left unimplemented.
 */
export function isPreferredNearReset(
  verdict: LanePaceVerdict | null,
  elapsedThreshold: number = PREFERRED_ELAPSED_THRESHOLD,
): boolean {
  if (!verdict || verdict.serviceable !== true || !verdict.score) return false;
  return verdict.score.elapsed >= elapsedThreshold && verdict.score.deviation < 0;
}

function preferredOf(
  ledger: LaneLedger,
  model: ModelEntry | undefined,
  elapsedThreshold: number,
): boolean {
  if (!model) return false;
  return isPreferredNearReset(laneVerdictFor(ledger, model.laneId ?? null), elapsedThreshold);
}

/** The modelId `orderCandidatesByPace` would boost ahead for being preferred, if any — for trace purposes only. */
export function preferredCandidateId(
  candidates: readonly Candidate[],
  models: readonly ModelEntry[],
  ledger: LaneLedger,
  elapsedThreshold: number = PREFERRED_ELAPSED_THRESHOLD,
): string | null {
  const preferred = candidates.find((candidate) => preferredOf(ledger, modelOf(models, candidate), elapsedThreshold));
  return preferred?.modelId ?? null;
}

/**
 * Order candidates: preferred-near-reset first, then pace state, then
 * deviation, then measured cost, then release date, then id. This function
 * partitions by TIER FIRST and only ever compares within one tier group —
 * pace must never reorder a candidate ahead of a candidate in a different,
 * already-preferred tier group. That partition is the whole defense for the
 * "pace crosses tiers" mutant: even a candidate with a perfect pace score
 * never moves ahead of any candidate in a tier group that sorted earlier.
 * A preferred-near-reset boost (Defect 5) is subject to the exact same
 * partition — it can win the within-group tie-break, never cross tiers.
 *
 * Tier-group order is taken from each group's FIRST APPEARANCE in the
 * incoming `candidates` array, not from a fixed tier index. `select.ts` has
 * already cost-sorted `candidates` before calling this (there is no tier
 * ceiling any more — a required-tier floor admits every more-capable tier
 * too, and their relative preference is a cost/tie-break decision, not a
 * fixed tier order). Re-deriving group order from `tierIndex` here would
 * silently override that cost ordering with a tier assumption; preserving
 * first-appearance order keeps pace confined to within-group tie-breaking
 * only, exactly like the ceiling-bounded design this replaced.
 */
export function orderCandidatesByPace(
  candidates: readonly Candidate[],
  models: readonly ModelEntry[],
  ledger: LaneLedger,
  options?: { preferredElapsedThreshold?: number; nowMs?: number },
): Candidate[] {
  const elapsedThreshold = options?.preferredElapsedThreshold ?? PREFERRED_ELAPSED_THRESHOLD;
  const nowMs = options?.nowMs ?? Date.now();
  const byTier = new Map<Candidate["tier"], Candidate[]>();
  const orderedTierKeys: Candidate["tier"][] = [];
  for (const candidate of candidates) {
    let group = byTier.get(candidate.tier);
    if (!group) {
      group = [];
      byTier.set(candidate.tier, group);
      orderedTierKeys.push(candidate.tier);
    }
    group.push(candidate);
  }

  const result: Candidate[] = [];
  for (const tierKey of orderedTierKeys) {
    const group = byTier.get(tierKey)!;
    group.sort((left, right) => {
      const leftModel = modelOf(models, left);
      const rightModel = modelOf(models, right);

      const leftPreferred = preferredOf(ledger, leftModel, elapsedThreshold);
      const rightPreferred = preferredOf(ledger, rightModel, elapsedThreshold);
      if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;

      const stateDelta = PACE_STATE_RANK[paceStateOf(ledger, leftModel)] - PACE_STATE_RANK[paceStateOf(ledger, rightModel)];
      if (stateDelta !== 0) return stateDelta;

      const deviationDelta = deviationOf(ledger, leftModel) - deviationOf(ledger, rightModel);
      if (deviationDelta !== 0) return deviationDelta;

      // Use-before-expiry: same pace state AND same deviation (the
      // common Muse case — lanes 7/5/2 all "behind" toward one shared
      // reset) — the lane with more headroom-per-hour wins the group. Below
      // cost on purpose: pace preference outranks price inside a tier group,
      // and this tie-break only fires when state AND deviation already tied.
      const pullDelta = expiryPullOf(ledger, rightModel, nowMs) - expiryPullOf(ledger, leftModel, nowMs);
      if (pullDelta !== 0) return pullDelta;

      if (left.expectedCostUsd !== right.expectedCostUsd) return left.expectedCostUsd - right.expectedCostUsd;

      //  owner rule: same vendor family, tier, and price — the newer
      // release wins outright unless the older one carries an explicit
      // earn-in verdict proving it's better. This runs before the plain
      // release-date fallback below because it is a strict same-family match
      // rather than a same-price coincidence across unrelated models.
      if (leftModel && rightModel) {
        const familyOrder = compareSamePriceFamily(leftModel, rightModel);
        if (familyOrder !== 0) return familyOrder;
      }

      // Release date: prefer the newer release when everything else ties —
      // matches `select.ts`'s own exact-cost tie-break (newest releasedAt,
      // then stable model id). Missing dates sort last.
      const leftRelease = leftModel?.releasedAt ?? "1970-01-01";
      const rightRelease = rightModel?.releasedAt ?? "1970-01-01";
      if (leftRelease !== rightRelease) return leftRelease > rightRelease ? -1 : 1;

      return left.modelId.localeCompare(right.modelId);
    });
    result.push(...group);
  }
  return result;
}

/**
 * Lane verdict reasons where the snapshot PARSED and was fresh, and what it
 * says is that this lane's remaining capacity cannot be computed: an account
 * with no usable allowance weight, or one naming a governing window this
 * snapshot cannot resolve. These are evidence, not absence of evidence — the
 * lane may be at 2% or at 100%, and nothing here can tell them apart.
 *
 * They carry `serviceable: null`, which is why they must be named explicitly:
 * `serviceable === false` alone lets an indeterminate lane through, and because
 * pace ordering treats an unknown lane as merely unranked, a CHEAPER
 * indeterminate lane then outranks a fallback whose capacity is known.
 */
const INDETERMINATE_CAPACITY_REASONS: ReadonlySet<LanePaceVerdict["reason"]> = new Set([
  "indeterminate-account-weight",
  "invalid-configured-governing-window",
]);

/**
 * A lane that is not serviceable (exhausted or unavailable, per the accepted
 * pace engine's own `serviceable` computation) is a hard stop: the model is
 * excluded outright, not merely reordered to the back. So is a lane whose
 * capacity is indeterminate for one of the reasons above — the pace engine
 * fails closed there, and this is the only place that decision can be enforced.
 *
 * A lane with NO ledger entry at all stays fail-neutral and excludes nothing —
 * an unobserved lane is not evidence of exhaustion. So do the no-data reasons
 * the pace engine reports (malformed document, stale snapshot, no records,
 * unusable account identity): those are a verdict saying "I could not tell".
 *
 * : what is NOT fail-neutral any more is a lane this plugin HAS
 * observed unserviceable and has since lost the reading for. `verdict` goes
 * null on every failed poll, and reading serviceability solely off `verdict`
 * meant a flapping poll silently readmitted a lane measured exhausted minutes
 * earlier. The observation is kept in `unserviceableSince` (see
 * `mergeLedgerEntry`) precisely so it survives that, and it is authoritative
 * until a successful poll contradicts it.
 */
function cooldownEvidence(observation: LanePaceObservation | null): NonNullable<LaneLedgerEntry["modelCooldownEvidence"]> {
  if (!observation || observation.error !== null || !observation.observedAt) return [];
  return observation.accounts.flatMap((account) => account.modelCooldowns?.length ? [{
    observedAt: observation.observedAt!,
    staleAfterSeconds: Math.min(900, observation.staleAfterSeconds ?? 900, account.staleAfterSeconds ?? 900),
    entries: account.modelCooldowns,
  }] : []);
}

export function modelCooldownExcluded(ledger: LaneLedger, model: ModelEntry, nowMs: number): boolean {
  const entry = model.laneId ? ledger[model.laneId] : null;
  if (!entry) return false;
  const evidence = entry.modelCooldownEvidence ?? cooldownEvidence(entry.observation);
  return evidence.some((sample) => {
    const ageMs = nowMs - Date.parse(sample.observedAt);
    return ageMs >= -60_000 && ageMs <= sample.staleAfterSeconds * 1000 &&
      activeModelCooldown(sample.entries, model.id, nowMs);
  });
}

export function hardStopExcluded(ledger: LaneLedger, model: ModelEntry, nowMs = Date.now()): boolean {
  const laneId = model.laneId ?? null;
  if (!laneId) return false;
  const entry = ledger[laneId];
  if (!entry) return false;
  if (modelCooldownExcluded(ledger, model, nowMs)) return true;
  if (entry.verdict) return unserviceableVerdict(entry.verdict);
  // No current reading. Fall back to the last observation that produced one;
  // `?? null` so a ledger persisted before this field existed reads as "never
  // observed" rather than excluding every lane it holds.
  return (entry.unserviceableSince ?? null) !== null;
}

/**
 *  (D1e). How many consecutive non-success polls dead-veto a lane.
 * Held equal to `EVIDENCE_ZERO_SUCCESS_SAMPLES` (lane-evidence.ts) on purpose:
 * the same evidence weight that condemns a lane on run outcomes condemns one
 * on poll outcomes. Kept as its own constant so the two can retune apart.
 */
export const DEAD_LANE_VETO_NON_SUCCESS_POLLS = 5;

/**
 *  (D1e). The company scope a dead-veto read needs beyond the ledger.
 * Both fields are what keep the veto from firing where it must not: the
 * configured set keeps unconfigured lanes out, and the bypass keeps a
 * poller-side outage from vetoing every lane at once.
 */
export interface DeadVetoScope {
  /**
   * The lanes configured for this company (`pacing.lanes[].laneId`). Null
   * (absent) fails the veto OPEN: without the configured set an unconfigured
   * lane cannot be told apart from a dead one, so vetoing anything would risk
   * vetoing everything.
   */
  readonly configuredLaneIds?: readonly string[] | null;
  /** True when every configured lane is dead in the same window — admit as today. */
  readonly bypassAllDead?: boolean;
}

/**
 *  (D1e). Whether a lane is dead-vetoed: its last
 * `DEAD_LANE_VETO_NON_SUCCESS_POLLS` consecutive lane-capacity polls contain
 * zero successes. Self-healing — any success resets the streak in
 * `mergeLedgerEntry`, so recovery clears the veto with no operator action.
 * Fail-open throughout: no ledger entry (never polled, or a missing ledger),
 * a lanless model, an unconfigured lane, or an absent configured set vetoes
 * nothing, matching `hardStopExcluded`'s posture for unobserved lanes.
 */
export function deadVetoExcluded(
  ledger: LaneLedger,
  model: ModelEntry,
  scope?: DeadVetoScope,
): boolean {
  const laneId = model.laneId ?? null;
  if (!laneId) return false;
  if (scope?.bypassAllDead) return false;
  const configured = scope?.configuredLaneIds ?? null;
  if (configured === null) return false;
  if (!configured.includes(laneId)) return false;
  return (ledger[laneId]?.consecutiveNonSuccess ?? 0) >= DEAD_LANE_VETO_NON_SUCCESS_POLLS;
}

/**
 *  (D1e). CEO fail-open: when every configured lane meets the dead
 * condition in the same window, the failure is poller-side (the  API
 * slowness, `lane-secret-unavailable`), not per-lane. Vetoing all of them
 * would stop dispatch through `tier-exhausted`, so selection admits as today
 * and the worker raises the operator card as "poller suspect" instead.
 * A configured lane with no ledger entry was never polled — not evidence of
 * an outage, and with no streak it cannot be vetoed either — so it blocks the
 * bypass: dispatch still has somewhere to go.
 */
export function allLanesDeadVetoed(
  ledger: LaneLedger,
  configuredLaneIds: readonly string[] | null | undefined,
): boolean {
  if (!configuredLaneIds || configuredLaneIds.length === 0) return false;
  return configuredLaneIds.every(
    (laneId) => (ledger[laneId]?.consecutiveNonSuccess ?? 0) >= DEAD_LANE_VETO_NON_SUCCESS_POLLS,
  );
}

/**
 * Whether a verdict the pace engine actually returned makes its lane a hard
 * stop. Split out of `hardStopExcluded` so the live reading and the durable
 * observation recorded by `mergeLedgerEntry` are decided by one definition —
 * if these two ever disagreed, a lane could be recorded unserviceable and
 * still be admitted, or the reverse.
 */
function unserviceableVerdict(verdict: LanePaceVerdict): boolean {
  if (verdict.serviceable === false) return true;
  return verdict.serviceable === null && INDETERMINATE_CAPACITY_REASONS.has(verdict.reason);
}

/**
 * Deterministic per-issue coin flip in [0, 1), stable for a given input
 * string. Used for ahead-of-line slot throttling, and for the 
 * T2/T3 explore-fraction roll (`applyPickOrdering` in `select.ts`), so the
 * same issue always lands on the same side of a cap/roll — no shared
 * counter, so no last-write-wins race between concurrent selections (see
 * `last-write-wins-voids-clobber-scores`). Deliberately NOT `Math.random()`:
 * the Python source's `pick()` used genuine randomness per call, but this
 * plugin can be re-invoked for the same issue (advise, then apply) and must
 * give the same answer both times.
 */
export function hashUnitInterval(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

/**
 * Ahead-of-line slot throttling. A lane running `ahead` of its fair-share
 * pace gets its slot share capped at `slotFloorFraction` (default 25%) —
 * capped, but never below the floor while the lane is still serviceable.
 * Any state other than `ahead` gets the full slot share: throttling exists
 * to slow a lane down that is outrunning its allowance, not to ration a
 * lane that is on pace or behind.
 *
 * The floor is a hard invariant: this function must never be able to return
 * 0 for a serviceable lane. `hardStopExcluded` is the ONLY path that removes
 * a model entirely, and it runs upstream of this — a lane that reaches here
 * is, by construction, serviceable.
 */
export function slotFactorFor(ledger: LaneLedger, model: ModelEntry, slotFloorFraction: number): number {
  const verdict = laneVerdictFor(ledger, model.laneId ?? null);
  if (!verdict || verdict.state !== "ahead") return 1;
  const floor = Math.max(Number.EPSILON, slotFloorFraction);
  return floor;
}

/** Whether this issue's dispatch clears the slot throttle for `model`. */
export function slotAllowed(issueId: string, ledger: LaneLedger, model: ModelEntry, slotFloorFraction: number): boolean {
  const factor = slotFactorFor(ledger, model, slotFloorFraction);
  if (factor >= 1) return true;
  return hashUnitInterval(issueId) < factor;
}

/**
 * A live operator override for this issue, if one is recorded and has not
 * expired. An EXPIRED override is treated exactly as if none existed —
 * never honored past its TTL, however recently it was set.
 */
export function activeOperatorOverride(
  overrides: OperatorOverrideLedger,
  issueId: string,
  nowIso: string,
): OperatorOverrideEntry | null {
  const entry = overrides[issueId];
  if (!entry) return null;
  return entry.expiresAt > nowIso ? entry : null;
}

export function recordOperatorOverride(
  overrides: OperatorOverrideLedger,
  issueId: string,
  modelId: string,
  nowIso: string,
  ttlSeconds: number,
): OperatorOverrideLedger {
  const expiresAt = new Date(Date.parse(nowIso) + ttlSeconds * 1000).toISOString();
  return { ...overrides, [issueId]: { issueId, modelId, setAt: nowIso, expiresAt } };
}

export interface RepinGateContext {
  /** `pin:operator` label present on the issue. */
  hasOperatorPin: boolean;
  /** True when the issue has no running or queued run right now. */
  isIdle: boolean;
  /** ISO timestamp of the last pace-driven repin on this issue, if any. */
  lastRepinAt: string | null;
  now: string;
  idleRepinHysteresisSeconds: number;
  /** True when this repin is a serviceability hard stop, not a routine pace repin. */
  isServiceabilityHardStop: boolean;
}

/**
 * Gate a pace-driven repin. This is the single choke point for two separate
 * rules that must both hold:
 *
 * 1. `pin:operator` survives a routine pace repin, but not a serviceability
 *    hard stop — staying pinned to a dead lane is a silent failure, not
 *    "leaving it alone".
 * 2. A repin only fires when the issue is idle (no running/queued run) AND
 *    it has been at least `idleRepinHysteresisSeconds` since the last
 *    pace-driven repin on this issue — this is the hysteresis that stops a
 *    lane oscillating near its margin from flapping the model back and
 *    forth on a live issue.
 */
/**
 * Per-lane utilization threshold above which a lane is avoided for NEW
 * admission, even while still serviceable. Ported from `tier_dispatcher.py`'s
 * module-level `AVOID = 0.8` / `AVOID_LANE = {"codex": 0.99}` / `avoid_for()`.
 */
export interface LaneAvoidConfig {
  defaultThreshold: number;
  perLane: Record<string, number>;
  /**
   * . Per-lane withdrawal ceiling, from `pacing.lanes[].withdrawAtUtilization`.
   * A lane absent here is never withdrawn, which is the default. It rides in this
   * config because every site that asks "may NEW work go to this lane" already
   * receives it.
   */
  withdrawAt?: Readonly<Record<string, number>>;
}

export function avoidThresholdFor(config: LaneAvoidConfig, laneId: string): number {
  return config.perLane[laneId] ?? config.defaultThreshold;
}

/**
 * Avoid new admission only when the governing window is BOTH at the lane's
 * configured utilization threshold AND ahead of its elapsed trajectory by
 * more than the pace engine's default margin (0.1). High utilization near
 * reset is not itself pressure: .75 used at .83 elapsed still has headroom.
 *
 * Per-lane thresholds still apply (e.g. Codex's higher threshold), and a
 * collector health/state label alone never triggers avoidance. Missing or
 * nonfinite pace scores stay neutral. Exhaustion and declared outages remain
 * separate hard gates; this soft admission rule never waives them.
 */
export function laneAvoidExcluded(ledger: LaneLedger, model: ModelEntry, config: LaneAvoidConfig): boolean {
  if (!model.laneId) return false;
  const score = laneVerdictFor(ledger, model.laneId)?.score;
  if (!score || !Number.isFinite(score.utilization) || !Number.isFinite(score.elapsed) || !Number.isFinite(score.deviation)) return false;
  // The governing score's deviation is utilization minus elapsed, normalized
  // by the pace engine to avoid floating-point drift at the strict boundary.
  // Reuse its default deadband: threshold alone must not park a lane whose
  // remaining allowance is on pace (or at risk of expiring unused).
  return score.utilization >= avoidThresholdFor(config, model.laneId) && score.deviation > DEFAULT_MARGIN;
}

/** . A lane whose combined utilization is at or above its withdrawal ceiling. */
export interface LaneWithdrawal {
  laneId: string;
  utilization: number;
  ceiling: number;
  accounts: number;
}

/** Utilization is compared at 1e-6, the same drift guard `pace.ts` applies in milli-units. */
function atOrAbove(value: number, ceiling: number): boolean {
  return Math.round(value * 1_000_000) >= Math.round(ceiling * 1_000_000);
}

/**
 * . Whether a lane is withdrawn from NEW dispatch, and why. The
 * selector otherwise keeps a lane open while any one account can serve
 * (`hardStopExcluded`) and prefers a trailing lane near its reset
 * (`orderCandidatesByPace`), so a lane with 7 of 8 accounts exhausted still
 * took every new dispatch. The live bridge withdraws the lane at a combined
 * ceiling; this is that rule, with the ceiling read from config.
 *
 * Off unless the lane has a positive ceiling. Fail-neutral on a lane with no
 * reading, like `hardStopExcluded` on an unpolled lane, but a reading taken
 * before a failed poll still counts (see `LaneLedgerEntry.combinedUtilization`)
 * until the earliest contributing window resets.
 */
export function laneWithdrawal(
  ledger: LaneLedger,
  laneId: string | null | undefined,
  config: LaneAvoidConfig,
  nowMs: number = Date.now(),
): LaneWithdrawal | null {
  if (!laneId) return null;
  const ceiling = config.withdrawAt?.[laneId];
  if (typeof ceiling !== "number" || !Number.isFinite(ceiling) || ceiling <= 0) return null;
  const reading = ledger[laneId]?.combinedUtilization ?? null;
  if (!reading) return null;
  if (reading.resetsAt !== null && Date.parse(reading.resetsAt) <= nowMs) return null;
  if (!atOrAbove(reading.utilization, ceiling)) return null;
  return { laneId, utilization: reading.utilization, ceiling, accounts: reading.accounts };
}

export function laneWithdrawnExcluded(
  ledger: LaneLedger,
  model: ModelEntry,
  config: LaneAvoidConfig,
  nowMs: number = Date.now(),
): boolean {
  return laneWithdrawal(ledger, model.laneId, config, nowMs) !== null;
}

/**
 * Operator-declared outage the telemetry cannot see — ported from
 * `tier_dispatcher.py`'s `lane_outage()` /
 * `ops/model-router/lane_outage.json` (2026-09-07 06:40Z owner note: e.g.
 * OpenCode Go rejecting every request with 400 MissingSessionID while the
 * accounts still look healthy to telemetry). `until` is an ISO-8601 UTC
 * timestamp compared lexicographically, matching `activeOperatorOverride`'s
 * own expiry convention elsewhere in this file.
 */
export interface LaneOutageOverride {
  lanes: readonly string[];
  models: readonly string[];
  until: string;
  reason?: string;
}

/** An outage entry past its `until` is treated exactly as if none existed. */
export function isLaneOutageActive(override: LaneOutageOverride | null, nowIso: string): boolean {
  if (!override) return false;
  return override.until > nowIso;
}

export function laneOutageExcluded(override: LaneOutageOverride | null, nowIso: string, model: ModelEntry): boolean {
  if (!isLaneOutageActive(override, nowIso)) return false;
  if (override!.models.includes(model.id)) return true;
  if (model.laneId && override!.lanes.includes(model.laneId)) return true;
  return false;
}

/**
 * List-price blend, ported byte-for-byte from `tier_dispatcher.py`'s
 * `blended(m) = (3*costPerMTokIn + costPerMTokOut)/4`. Deliberately NOT the
 * volume-aware `cost.ts` engine — this is the same simple, weight-only figure
 * the Python source uses for `lane_active_pins()`'s flash-model half-weighting
 * (a model under $1/Mtok blended counts as half a lane slot).
 */
export function blendedListPrice(model: ModelEntry): number {
  return (3 * model.costPerMTokIn + model.costPerMTokOut) / 4;
}

/**
 * 2026-09-08 22:15Z owner rule: long-turn engineering agent NAMES that keep
 * hitting Z.ai's Anthropic-compat 1214 ("messages parameter is illegal") on
 * conversations over ~78 minutes. Ported verbatim from `tier_dispatcher.py`'s
 * `ZAI_LONG_RUN_AGENTS` — every SQL caller there sources `agent` from
 * `coalesce(a.name,'')`, so this is a display-NAME set, never a role enum.
 */
export const ZAI_LONG_RUN_AGENTS: ReadonlySet<string> = new Set([
  "Founding Engineer",
  "Web Engineer",
  "Automation Engineer",
  "DevOps & Reliability Engineer",
  "CTO & Chief AI Officer",
  "Director of Engineering",
]);

/**
 * Fail-neutral-to-0.5 utilization read, ported from `tier_dispatcher.py`'s
 * `eff_util(lane) = 0.5 if lane_util(lane) is None else lane_util(lane)`.
 * Distinct from `laneAvoidExcluded`'s fail-neutral-to-FALSE: this feeds a
 * threshold comparison (`< avoid_for(lane)`) where "unknown" must read as a
 * mid-pack value, not as "definitely fine" or "definitely blocked".
 */
export function laneEffectiveUtilization(ledger: LaneLedger, laneId: string): number {
  const verdict = laneVerdictFor(ledger, laneId);
  const utilization = verdict?.score?.utilization;
  return utilization === null || utilization === undefined ? 0.5 : utilization;
}

/**
 * Z.ai Coding Plan peak hours (premium models cost 1x instead of 0.5x
 * credits): Mon-Fri 14:00-18:00 Asia/Shanghai = 06:00-10:00 UTC. Ported
 * verbatim from `tier_dispatcher.py`'s `zai_peak_now()`.
 */
export function zaiPeakNow(nowMs: number): boolean {
  const now = new Date(nowMs);
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  return day >= 1 && day <= 5 && hour >= 6 && hour < 10;
}

/**
 * Read the utilization of a specific NAMED window (not necessarily the
 * account's governing window) across a lane's healthy accounts, taking the
 * max. Ported from `tier_dispatcher.py`'s `lane_5h()`, generalized to any
 * window name since this plugin's lane documents are config-named rather
 * than hardcoded JSON keys. Fail-neutral to 0 (no observation, or nothing
 * healthy, reads as "no measured pressure" — never excludes on ignorance).
 */
export function laneNamedWindowUtilization(ledger: LaneLedger, laneId: string, windowName: string): number {
  const observation = ledger[laneId]?.observation;
  if (!observation) return 0;
  const utilizations = observation.accounts
    .filter((account) => account.health === "healthy")
    .flatMap((account) => {
      const window = account.windows.find((w) => w.name === windowName);
      return typeof window?.utilization === "number" ? [window.utilization] : [];
    });
  return utilizations.length > 0 ? Math.max(...utilizations) : 0;
}

/**
 * Count of healthy accounts on a lane. Ported from `tier_dispatcher.py`'s
 * `lane_accounts()`, whose `try/except` falls back to 1 when the usage file
 * cannot be read — the same fail-neutral-to-1 posture applies here when this
 * lane has never been polled (`observation` null), so a per-account cap does
 * not silently multiply out to "unlimited" on missing telemetry.
 */
export function laneHealthyAccountCount(ledger: LaneLedger, laneId: string): number {
  const observation = ledger[laneId]?.observation;
  if (!observation) return 1;
  return observation.accounts.filter((account) => account.health === "healthy").length;
}

/**
 * Operator-declared temporary margin override for `zaiWeeklyPaceOk`, e.g.
 * during a Codex outage. Ported from `tier_dispatcher.py`'s
 * `zai_pace_override()` / `ops/model-router/zai_pace_override.json`.
 */
export interface ZaiPaceOverride {
  margin: number;
  until: string;
}

/** An override past its `until` is treated exactly as if none existed. */
export function activeZaiPaceOverride(override: ZaiPaceOverride | null, nowIso: string): number | null {
  if (!override) return null;
  return override.until > nowIso ? override.margin : null;
}

/**
 * 2026-09-08 13:20Z owner rule: the Z.ai Pro plan is 60k credits/week but 12k
 * per 5h, so full-bore use empties the WEEK in ~1 day. Admit NEW zai cards
 * only while weekly utilization <= elapsed fraction of the plan week +
 * margin; cards already pinned keep running (this function only gates NEW
 * admission, in `laneHasRoom`). Ported verbatim from
 * `tier_dispatcher.py`'s `zai_weekly_pace_ok()`, reading the FIRST reported
 * account only, matching the Python source's `records[0]`.
 */
export function zaiWeeklyPaceOk(input: {
  ledger: LaneLedger;
  laneId: string;
  weeklyWindowName: string;
  defaultMargin: number;
  overrideMargin: number | null;
  nowMs: number;
}): boolean {
  const margin = input.overrideMargin ?? input.defaultMargin;
  const observation = input.ledger[input.laneId]?.observation;
  const account = observation?.accounts[0];
  if (!account) return true;
  const window = account.windows.find((w) => w.name === input.weeklyWindowName);
  if (!window || window.utilization === null || window.resetsAt === null) return true;
  const remainingMs = Date.parse(window.resetsAt) - input.nowMs;
  const elapsed = 1 - Math.max(0, Math.min(1, remainingMs / (7 * 24 * 60 * 60 * 1000)));
  return window.utilization <= elapsed + margin;
}

/**
 * 2026-09-06 17:1xZ owner rule: OpenCode Go allowances are small ($12 per
 * rolling 5h per account ≈ 8 agent runs); pinning every card to the cheapest
 * lane drained all three accounts in an hour and 429'd 8 runs. Cap the
 * number of ACTIVE (todo/in_progress) cards a lane may hold at once; the
 * surplus takes the next-cheapest capable model.
 *
 * 2026-09-06 23:5xZ: two active cards per Go account still drained both 5h
 * windows in ~3h (runs are long). Stop handing the lane NEW cards once any
 * healthy account's 5h window passes 0.5 (2026-09-07 03:15Z: 0.6 -> 0.5) —
 * leave the rest for the runs already in flight.
 *
 * 2026-09-07 12:32Z: cap back to 2 for opencode-go — Go now carries only
 * cheap models (owner: maximize Go usage); T1 stays off Go unless codex is
 * exhausted (see the separate T1-avoids-Go rule in `select.ts`).
 *
 * Ported from `tier_dispatcher.py`'s `lane_has_room()`.
 */
export function laneHasRoom(input: {
  laneId: string;
  activePinsWeight: number;
  extra?: number;
  ledger: LaneLedger;
  capPerAccount: Readonly<Record<string, number>>;
  fiveHourWindowName: string;
  zaiLaneId: string;
  zaiWeeklyWindowName: string;
  zaiWeeklyDefaultMargin: number;
  zaiPaceOverrideMargin: number | null;
  nowMs: number;
}): boolean {
  if (input.laneId === input.zaiLaneId) {
    const weeklyOk = zaiWeeklyPaceOk({
      ledger: input.ledger,
      laneId: input.laneId,
      weeklyWindowName: input.zaiWeeklyWindowName,
      defaultMargin: input.zaiWeeklyDefaultMargin,
      overrideMargin: input.zaiPaceOverrideMargin,
      nowMs: input.nowMs,
    });
    if (!weeklyOk) return false;
  }

  let per = input.capPerAccount[input.laneId];
  if (input.laneId === input.zaiLaneId && per !== undefined && zaiPeakNow(input.nowMs)) {
    per = 1;
  }
  if (per === undefined) return true;

  if (laneNamedWindowUtilization(input.ledger, input.laneId, input.fiveHourWindowName) >= 0.5) return false;

  const accounts = Math.max(1, laneHealthyAccountCount(input.ledger, input.laneId));
  return input.activePinsWeight + (input.extra ?? 0) < per * accounts;
}

export function repinAllowed(context: RepinGateContext): { allowed: boolean; reason: string } {
  if (context.hasOperatorPin && !context.isServiceabilityHardStop) {
    return { allowed: false, reason: `${OPERATOR_PIN_LABEL} survives a routine pace repin` };
  }
  if (!context.isIdle) {
    return { allowed: false, reason: "issue has a running or queued run; never repin live work" };
  }
  if (context.lastRepinAt) {
    const elapsedSeconds = (Date.parse(context.now) - Date.parse(context.lastRepinAt)) / 1000;
    if (elapsedSeconds < context.idleRepinHysteresisSeconds) {
      return { allowed: false, reason: `only ${Math.round(elapsedSeconds)}s since the last pace repin, below the ${context.idleRepinHysteresisSeconds}s hysteresis` };
    }
  }
  return { allowed: true, reason: context.isServiceabilityHardStop ? "serviceability hard stop overrides the operator pin" : "idle and past the repin hysteresis" };
}
