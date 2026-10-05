import { IMPLICIT_TIER_CEILING, TIER_ORDER, type Tier } from "../constants.js";
import { laneVerdictFor, type LaneLedger } from "./pacing.js";
import { tierScoreFor } from "./scores.js";
import type { Candidate, IssueDescriptor, ModelEntry, ModelScore } from "./types.js";

/**
 * Priorities that never take experimental earn-in traffic. Board
 * values are `critical`/`high`/`medium`/`low`; `urgent` is carried because the
 * dispatch sweep ranks it above all four. Compared case-insensitively —
 * anything unrecognized is not protected.
 */
const EARN_IN_PROTECTED_PRIORITIES: ReadonlySet<string> = new Set(["critical", "high", "urgent"]);

/**
 * Review/gate cards never take experimental earn-in traffic. Judged
 * on the raw card title — never inferred from anything else. Word-boundaried
 * so "gateway" matches as its own word but prose merely containing "gate" as
 * a substring of an unrelated word does not widen the guard.
 */
const REVIEW_GATE_TITLE_RE = /\b(review|reviews|reviewer|reviewing|gate|gates|gating|gateway)\b/i;

export interface EarnInGuard {
  protected: boolean;
  reason: string | null;
}

/**
 * Whether this card is protected from the free-lane earn-in
 * reorder: critical/high-priority cards and review/gate cards. Pure, so both
 * `freeEarnInCandidates` (enforcement) and `select.ts` (the trace line) read
 * the same verdict.
 */
export function earnInGuardFor(
  descriptor: Pick<IssueDescriptor, "priority" | "title"> | null | undefined,
): EarnInGuard {
  const priority = typeof descriptor?.priority === "string" ? descriptor.priority.trim().toLowerCase() : "";
  if (EARN_IN_PROTECTED_PRIORITIES.has(priority)) {
    return { protected: true, reason: `priority ${descriptor!.priority} never takes experimental earn-in traffic` };
  }
  const title = typeof descriptor?.title === "string" ? descriptor.title : "";
  if (REVIEW_GATE_TITLE_RE.test(title)) {
    return { protected: true, reason: "review/gate cards never take experimental earn-in traffic" };
  }
  return { protected: false, reason: null };
}

export interface FreeEarnInPick {
  candidate: Candidate;
  laneId: string;
  /** Recorded (model, tier) run count behind the "until judged" bound. */
  observations: number;
}

function modelOf(models: readonly ModelEntry[], candidate: Candidate): ModelEntry | undefined {
  return models.find((model) => model.id === candidate.modelId);
}

/**
 *  rule (b), 2026-09-19 owner rule: a free subscription lane whose
 * credential is serviceable and under its per-account cap wins its tier over
 * a paid/earned model until it has enough observations to be judged —
 * otherwise a new subscription can never earn placement.
 *
 * Eligibility, all required:
 * - the lane's pace verdict is `free` with `serviceable === true`. The 5h and
 *   weekly meters behind a subscription are invisible here (CLIProxy exposes
 *   only cooldown/retry_at, no quota signal), so a serviceable reading IS the
 *   "unused budget" proxy — and the day the lane reports exhausted, the
 *   serviceability hard stop in `select.ts` excludes it before this runs. No
 *   throttling assumption is baked in anywhere.
 * - the (model, requiredTier) score is not yet `proven` (fewer than
 *   SCORE_PROVEN_N judged runs). Proven is the "enough observations" bound —
 *   the same bound `summarize()` uses, not a second number to drift.
 * - the tier verdict is not an explicit `capable === false`. Earn-in seeds
 *   evidence for the unjudged; it never re-admits the measured-failing (the
 *   `capability-score` gate already rejected those before this runs — this is
 *   belt and braces so a future caller can't promote one by mistake).
 *
 * Per-account-cap and 5h admission are NOT re-checked here: they already gate
 * NEW admission upstream (`lane-no-room` rejections in `select.ts`), so every
 * candidate reaching this function survived them. This is a pure reorder over
 * gate survivors, never an admission bypass.
 *
 * Never crosses tiers: `select.ts` calls this over the single-rung `candidates`
 * array the tier ladder already settled, so the worst this does is reorder
 * within one tier — the same confinement `orderCandidatesByPace` honors.
 */
export function freeEarnInCandidates(
  candidates: readonly Candidate[],
  models: readonly ModelEntry[],
  ledger: LaneLedger,
  modelScores: Readonly<Record<string, ModelScore>> | undefined,
  requiredTier: Tier,
  descriptor?: Pick<IssueDescriptor, "priority" | "title"> | null,
): FreeEarnInPick[] {
  // protected cards (critical/high priority, review/gate) never
  // enter the reorder. Checked before any lane read so a protected card takes
  // no experimental traffic regardless of lane state.
  if (earnInGuardFor(descriptor).protected) return [];
  const picks: FreeEarnInPick[] = [];
  for (const candidate of candidates) {
    // earn-in seeds evidence for the unjudged; it never carries a
    // card above the implicit ceiling. T0 placement is operator-recorded, so a
    // T0 rung (reachable only on an explicit opt-in) is never reordered here.
    if (TIER_ORDER.indexOf(candidate.tier) > TIER_ORDER.indexOf(IMPLICIT_TIER_CEILING)) continue;
    const model = modelOf(models, candidate);
    const laneId = model?.laneId ?? null;
    if (!laneId) continue;
    const verdict = laneVerdictFor(ledger, laneId);
    if (!verdict || verdict.state !== "free" || verdict.serviceable !== true) continue;
    const tierScore = tierScoreFor(modelScores?.[candidate.modelId], requiredTier);
    if (tierScore?.proven) continue;
    if (tierScore?.capable === false) continue;
    picks.push({ candidate, laneId, observations: tierScore?.n ?? 0 });
  }
  return picks;
}

/**
 * The single earn-in pick: cheapest expected cost first (a free lane costs
 * ~$0/run, so this is usually first-come), newest release then stable id
 * behind that — the same tiebreak ladder `select.ts` uses, so two unjudged
 * subscription lanes settle deterministically. Null when nobody qualifies.
 */
export function freeEarnInWinner(
  candidates: readonly Candidate[],
  models: readonly ModelEntry[],
  ledger: LaneLedger,
  modelScores: Readonly<Record<string, ModelScore>> | undefined,
  requiredTier: Tier,
  descriptor?: Pick<IssueDescriptor, "priority" | "title"> | null,
): FreeEarnInPick | null {
  const picks = freeEarnInCandidates(candidates, models, ledger, modelScores, requiredTier, descriptor);
  if (picks.length === 0) return null;
  const sorted = [...picks].sort((a, b) => {
    if (a.candidate.expectedCostUsd !== b.candidate.expectedCostUsd) {
      return a.candidate.expectedCostUsd - b.candidate.expectedCostUsd;
    }
    if (a.candidate.releasedAt !== b.candidate.releasedAt) {
      return a.candidate.releasedAt > b.candidate.releasedAt ? -1 : 1;
    }
    return a.candidate.modelId.localeCompare(b.candidate.modelId);
  });
  return sorted[0]!;
}
