import type { LanePaceVerdict, PaceState } from "../lane-capacity/pace.js";
import { OPERATOR_PIN_LABEL } from "../constants.js";
import type { Candidate, ModelEntry } from "./types.js";

/**
 * Per-lane state this plugin persists across polls. Keyed by `laneId`, the
 * same id a `ModelEntry.laneId` points at.
 */
export interface LaneLedgerEntry {
  laneId: string;
  verdict: LanePaceVerdict | null;
  /** When this entry was last written, regardless of whether the poll succeeded. */
  fetchedAt: string;
  /** Null on a clean poll. A failed poll degrades `verdict` to null, never overwrites a good one with a stale guess (see `mergeLedgerEntry`). */
  error: string | null;
}

export type LaneLedger = Record<string, LaneLedgerEntry>;

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
 */
export function mergeLedgerEntry(
  ledger: LaneLedger,
  result: { laneId: string; fetchedAt: string; verdict: LanePaceVerdict | null; error: string | null },
): LaneLedger {
  return { ...ledger, [result.laneId]: { laneId: result.laneId, verdict: result.verdict, fetchedAt: result.fetchedAt, error: result.error } };
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

function deviationOf(ledger: LaneLedger, model: ModelEntry | undefined): number {
  if (!model) return 0;
  return laneVerdictFor(ledger, model.laneId ?? null)?.score?.deviation ?? 0;
}

function modelOf(models: readonly ModelEntry[], candidate: Candidate): ModelEntry | undefined {
  return models.find((model) => model.id === candidate.modelId);
}

/**
 * Order candidates: pace state, then deviation, then measured cost, then
 * release date, then id. This function partitions by TIER FIRST and only
 * ever compares within one tier group — pace must never reorder a candidate
 * ahead of a candidate in a different, already-preferred tier group. That
 * partition is the whole defense for the "pace crosses tiers" mutant: even a
 * candidate with a perfect pace score never moves ahead of any candidate in
 * a tier group that sorted earlier.
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
): Candidate[] {
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
      const stateDelta = PACE_STATE_RANK[paceStateOf(ledger, leftModel)] - PACE_STATE_RANK[paceStateOf(ledger, rightModel)];
      if (stateDelta !== 0) return stateDelta;

      const deviationDelta = deviationOf(ledger, leftModel) - deviationOf(ledger, rightModel);
      if (deviationDelta !== 0) return deviationDelta;

      if (left.expectedCostUsd !== right.expectedCostUsd) return left.expectedCostUsd - right.expectedCostUsd;

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
 * A lane that is not serviceable (exhausted or unavailable, per the accepted
 * pace engine's own `serviceable` computation) is a hard stop: the model is
 * excluded outright, not merely reordered to the back. `verdict === null`
 * (never polled, malformed document, stale snapshot) is fail-neutral and
 * excludes nothing — an unknown lane is not evidence of exhaustion.
 */
export function hardStopExcluded(ledger: LaneLedger, model: ModelEntry): boolean {
  const verdict = laneVerdictFor(ledger, model.laneId ?? null);
  if (!verdict) return false;
  return verdict.serviceable === false;
}

/**
 * Deterministic per-issue coin flip in [0, 1), stable for a given issue id.
 * Used for ahead-of-line slot throttling so the same issue always lands on
 * the same side of the cap — no shared counter, so no last-write-wins race
 * between concurrent selections (see `last-write-wins-voids-clobber-scores`).
 */
function hashUnitInterval(input: string): number {
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
