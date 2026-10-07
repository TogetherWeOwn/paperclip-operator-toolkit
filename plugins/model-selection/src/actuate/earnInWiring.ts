import { TIERS, type Tier } from "../constants.js";
import { resolveTaskClassFromLabels } from "../accepted-work/cohort.js";
import { activeModelCooldown } from "../lane-capacity/counts-only.js";
import type { PaceState } from "../lane-capacity/pace.js";
import type { AvailabilitySnapshot } from "../engine/availability.js";
import { isAnthropicModelId } from "../engine/cost-attribution.js";
import { earnInGuardFor } from "../engine/free-lane-earn-in.js";
import { evidenceStateFor, type LaneEvidenceSnapshot } from "../engine/lane-evidence.js";
import { isAdapterBlockedModel, isDevinModelId } from "../engine/model-id.js";
import {
  hardStopExcluded,
  laneAvoidExcluded,
  laneOutageExcluded,
  laneVerdictFor,
  modelCooldownExcluded,
  type LaneAvoidConfig,
  type LaneLedger,
  type LaneOutageOverride,
} from "../engine/pacing.js";
import { classifyRunFailure, tierScoreFor } from "../engine/scores.js";
import { tierFromLabels } from "../engine/tier.js";
import type { EarnInState, ModelEntry, ModelScore } from "../engine/types.js";
import {
  recordEarnInOutcome,
  type EarnInCandidateCard,
  type LanePosture,
  type LanePostureByTier,
  type PacePosture,
} from "./earnIn.js";

/**
 * Earn-in wiring translators: pure functions between live worker
 * state and the pure `planEarnIn`/`recordEarnInOutcome` decision functions
 * (`actuate/earnIn.ts`, §3 / decision B).
 *
 * No I/O here: the worker owns every `ctx.state` read/write (parallel to
 * `scoresKey`/`readModelScores`) and calls these to build cards, resolve
 * postures, and fold outcomes. Keeping the translation pure makes the whole
 * admission policy testable without a host — the same shape as
 * `actuate/apply.ts`'s `planApply()`.
 *
 * Deliberate tightenings vs `select.ts` (experimental traffic must not
 * explore on blind instruments):
 * - an UNMAPPED or UNKNOWN availability lane reads "saturated" here, where
 *   selection fails open. A broken instrument must not take routing down, but
 *   it must not admit bounded exploration either.
 * - a model with no lane reads unavailable (no per-lane cap to track).
 * - `devin/*` models never admit, per the sequencing caveat
 *   (dispatch-credential failure, not model incapability).
 *
 * Counter semantics (preserving the named mutants):
 * - dispatch only APPENDS (`counter+1`, timestamp push, active+1, key record)
 *   and never prunes `dispatchedThisWeek` — `planEarnIn` filters to the
 *   rolling window itself, so the cap holds under an injected/skewed clock
 *   (named mutant: exceed-8-with-injected-clock).
 * - resolve always RELEASES the active slot, and folds the outcome only when
 *   it is model-attributable. Infra failures release without folding
 *   ("ignore"), so a dead lane cannot stop a model and a flaky host cannot
 *   spend its first-8 window.
 */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function asNumberRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(asRecord(value))) {
    if (typeof entry === "number" && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
}

function asNumberArrayRecord(value: unknown): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [key, entry] of Object.entries(asRecord(value))) {
    if (!Array.isArray(entry)) continue;
    out[key] = entry.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  }
  return out;
}

function asStringArrayRecord(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(asRecord(value))) {
    if (!Array.isArray(entry)) continue;
    out[key] = entry.filter((item): item is string => typeof item === "string");
  }
  return out;
}

function asBooleanRecord(value: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(asRecord(value))) {
    if (entry === true) out[key] = true;
    else if (entry === false) out[key] = false;
  }
  return out;
}

function asOutcomeArrayRecord(value: unknown): Record<string, ReadonlyArray<"ok" | "material-failure">> {
  const out: Record<string, ReadonlyArray<"ok" | "material-failure">> = {};
  for (const [key, entry] of Object.entries(asRecord(value))) {
    if (!Array.isArray(entry)) continue;
    out[key] = entry.filter(
      (item): item is "ok" | "material-failure" => item === "ok" || item === "material-failure",
    );
  }
  return out;
}

/** Empty bookkeeping: every counter at zero, nothing dispatched, nothing stopped. */
export function emptyEarnInState(): EarnInState {
  return {
    counter: {},
    dispatchedThisWeek: {},
    activePerModel: {},
    activePerLane: {},
    firstEightOutcomes: {},
    stopped: {},
    dispatchedKeys: [],
  };
}

/**
 * Defensive read of the `earnInState` key: well-shaped fields survive, anything
 * else degrades to empty rather than throwing or guessing. Same discipline as
 * `readModelScores`/`readClassificationExclusions` in `worker.ts`.
 */
export function normalizeEarnInState(raw: unknown): EarnInState {
  const stored = asRecord(raw);
  const outcomeSlots: NonNullable<EarnInState["outcomeSlots"]> = {};
  for (const [key, value] of Object.entries(asRecord(stored.outcomeSlots))) {
    const slot = asRecord(value);
    if (typeof slot.modelId !== "string" || typeof slot.lane !== "string") continue;
    if (typeof slot.index !== "number" || !Number.isInteger(slot.index) || slot.index < 0 || slot.index >= 8) continue;
    outcomeSlots[key] = { modelId: slot.modelId, lane: slot.lane, index: slot.index };
  }
  return {
    ...(Object.keys(outcomeSlots).length ? { outcomeSlots } : {}),
    counter: asNumberRecord(stored.counter),
    dispatchedThisWeek: asNumberArrayRecord(stored.dispatchedThisWeek),
    activePerModel: asNumberRecord(stored.activePerModel),
    activePerLane: asStringArrayRecord(stored.activePerLane),
    firstEightOutcomes: asOutcomeArrayRecord(stored.firstEightOutcomes),
    stopped: asBooleanRecord(stored.stopped),
    dispatchedKeys: asStringArray(stored.dispatchedKeys),
  };
}

/** Map a pace-engine state onto the posture `planEarnIn` gates on. Only a trailing lane counts as behind. */
export function pacePostureOfPaceState(state: PaceState | null | undefined): PacePosture {
  if (state === "behind" || state === "behind-urgent") return "behind";
  if (state === "on") return "on-pace";
  if (state === "ahead") return "ahead";
  return "unknown";
}

/** The pace posture of a candidate model's own lane. Lane-less or unread models read "unknown" (never behind). */
export function pacePostureForModel(
  ledger: LaneLedger,
  model: Pick<ModelEntry, "laneId">,
): PacePosture {
  return pacePostureOfPaceState(laneVerdictFor(ledger, model.laneId ?? null)?.state ?? null);
}

export interface EarnInLaneInputs {
  ledger: LaneLedger;
  availability?: AvailabilitySnapshot | null;
  laneEvidence?: LaneEvidenceSnapshot | null;
  laneAvoidConfig?: LaneAvoidConfig | null;
  laneOutageOverride?: LaneOutageOverride | null;
  pacingActive: boolean;
  trafficScale?: "issue" | "fleet-default";
  nowMs: number;
  nowIso: string;
}

/**
 * Mirror of `select.ts`'s per-model gates (`clearsLane` + `clearsEvidence` +
 * hard stop + avoid + outage), tightened for exploration: an UNREADABLE
 * document, an UNKNOWN lane, or a lane the document never maps all refuse
 * instead of passing through. A lane the instruments cannot see is
 * "saturated" for earn-in purposes — experimental traffic is the first thing
 * cut when blind, not the last. (A missing document — `availability` null,
 * term not configured — skips only this term; the ledger, evidence, and
 * outage gates above and below still judge.)
 */
export function laneAvailableForEarnIn(model: ModelEntry, inputs: EarnInLaneInputs): boolean {
  const laneId = model.laneId ?? null;
  if (!laneId) return false;
  if (hardStopExcluded(inputs.ledger, model, inputs.nowMs)) return false;
  if (modelCooldownExcluded(inputs.ledger, model, inputs.nowMs)) return false;
  if (
    inputs.pacingActive &&
    inputs.laneAvoidConfig &&
    laneAvoidExcluded(inputs.ledger, model, inputs.laneAvoidConfig)
  ) {
    return false;
  }
  // The outage quarantine is a recorded operator/lane verdict, not a pacing
  // preference — it binds in every mode (selection's `isLaneUnserviceable`
  // reads it the same way). Gated on `pacingActive` only for the avoid
  // threshold above, which IS a pacing preference.
  if (laneOutageExcluded(inputs.laneOutageOverride ?? null, inputs.nowIso, model)) {
    return false;
  }
  const availability = inputs.availability ?? null;
  if (availability) {
    if (availability.unreadableReason) return false;
    const lane = availability.lanes.find((entry) => entry.laneId === laneId) ?? null;
    if (!lane) return false;
    if (lane.state !== "available") return false;
    if (activeModelCooldown(lane.modelCooldowns ?? [], model.id, inputs.nowMs)) return false;
    //  AC-3, same as selection: one credential cannot carry
    // fleet-default traffic at any quota level.
    if ((inputs.trafficScale ?? "issue") === "fleet-default" && lane.serviceableAccountCount <= 1) {
      return false;
    }
  }
  // The `devin/*` 0/74 provider refusal is invisible to every contract above;
  // only run-outcome evidence sees it. A proven-dead lane admits nothing.
  if (evidenceStateFor(inputs.laneEvidence ?? undefined, laneId) === "proven-dead") return false;
  return true;
}

/**
 * Per-tier lane posture for `planEarnIn` — NEVER a collapsed global flag. A
 * tier reads "available" when at least one enabled, non-devin row at that
 * tier clears the gates above; otherwise "saturated". `devin/*` rows are
 * excluded from every tier's availability (sequencing caveat), so a
 * T1 served only by Devin reads starved, not open.
 */
export function lanePostureByTier(
  models: readonly ModelEntry[],
  inputs: EarnInLaneInputs,
): LanePostureByTier {
  // : `Tier` now includes T0 (explicit-only, never earn-in
  // admitted — the T1 gates below still refuse it). Seed it saturated.
  const posture: Record<Tier, LanePosture> = { T0: "saturated", T1: "saturated", T2: "saturated", T3: "saturated" };
  for (const tier of TIERS) {
    const available = models.some(
      (model) =>
        model.enabled &&
        model.tier === tier &&
        !isDevinModelId(model.id) &&
        laneAvailableForEarnIn(model, inputs),
    );
    posture[tier] = available ? "available" : "saturated";
  }
  return posture;
}

export interface EarnInCardInput {
  issueId: string;
  status: string;
  hasRunningRun: boolean;
  hasOperatorPin: boolean;
  /** Recorded capability-exclusion answer (classification map), never inferred. */
  exclusionExcluded: boolean;
  labelNames: readonly string[];
  model: Pick<ModelEntry, "id" | "laneId">;
}

/**
 * Build the `EarnInCandidateCard` for one (issue, model) pair, or null when
 * the pair cannot be an earn-in candidate at all (non-T1 card, lane-less
 * model). Every other gate stays inside `planEarnIn` so the refusal is
 * recorded with its reason rather than silently skipped.
 *
 * `requiresCredentials`/`requiresPermissionsOrApprovals` follow the recorded
 * exclusion: the classification map stores a boolean only, and every RUBRIC
 * exclusion trigger (secrets, credentials, permissions, provisioning,
 * approvals) is credential-shaped — so an excluded card is excluded three
 * ways, and a non-excluded card claims neither flag. Conservative in the safe
 * direction either way.
 */
export function buildEarnInCandidateCard(input: EarnInCardInput): EarnInCandidateCard | null {
  if (tierFromLabels(input.labelNames) !== "T1") return null;
  const lane = input.model.laneId ?? null;
  if (!lane) return null;
  return {
    issueId: input.issueId,
    modelId: input.model.id,
    lane,
    tier: "T1",
    status: input.status,
    hasRunningRun: input.hasRunningRun,
    // Recorded `class:*` label, verbatim; "unknown" when no task-class evidence
    // exists yet — `planEarnIn` then refuses (not in configured classes), which
    // is the honest answer until somebody records the class.
    workClass: resolveTaskClassFromLabels(input.labelNames),
    hasOperatorPin: input.hasOperatorPin,
    hasExclusion: input.exclusionExcluded,
    requiresCredentials: input.exclusionExcluded,
    requiresPermissionsOrApprovals: input.exclusionExcluded,
  };
}

export interface EarnInIssueInput {
  status: string;
  isIdle: boolean;
  hasOperatorPin: boolean;
  exclusionExcluded: boolean;
  /** A card that already carries an override is never re-pinned (`apply.ts` rule 2). */
  hasExistingOverride: boolean;
  /** : a user-assigned card rejects agent overrides outright. */
  assigneeUserId: string | null;
  labelNames: readonly string[];
  priority: string | null;
  title: string | null;
}

/**
 * Cheap pre-filter mirroring the scheduled passes' own early rejects plus the
 * earn-in-specific ones (T1 only, `todo` only, protected cards never
 * take experimental traffic). Anything passing here still goes through
 * `planEarnIn`'s full gate list — this only saves the wasted call, never
 * admits.
 */
export function isEarnInCandidateIssue(input: EarnInIssueInput): boolean {
  if (input.status !== "todo") return false;
  if (!input.isIdle) return false;
  if (input.hasOperatorPin) return false;
  if (input.exclusionExcluded) return false;
  if (input.hasExistingOverride) return false;
  if (input.assigneeUserId) return false;
  if (tierFromLabels(input.labelNames) !== "T1") return false;
  if (earnInGuardFor({ priority: input.priority, title: input.title }).protected) return false;
  return true;
}

export interface EarnInModelInput {
  model: ModelEntry;
  modelScores?: Readonly<Record<string, ModelScore>>;
  agentAdapterType?: string | null;
}

/**
 * Roster-side pre-filter: enabled T1 rows only, never `devin/*` (
 * sequencing caveat), never adapter-blocked, never already proven or measured
 * incapable at T1. A model with no score passes through — `planEarnIn` refuses
 * it with "no model score", which is the recordable answer rather than a
 * silent skip.
 */
export function isEarnInCandidateModel(input: EarnInModelInput): boolean {
  const { model } = input;
  if (!model.enabled) return false;
  if (model.tier !== "T1") return false;
  if (isDevinModelId(model.id)) return false;
  if (isAdapterBlockedModel(model.id, input.agentAdapterType ?? null)) return false;
  const tierScore = tierScoreFor(input.modelScores?.[model.id], "T1");
  if (tierScore?.proven) return false;
  if (tierScore?.capable === false) return false;
  return true;
}

/** `planEarnIn`'s Claude pace gate keys on the served id's namespace, never a substring. */
export function resolveIsClaudeModel(modelId: string): boolean {
  return isAnthropicModelId(modelId);
}

/** The idempotency key `planEarnIn` itself derives — recorded here so dispatch and state agree. */
export function earnInIdempotencyKey(issueId: string, modelId: string): string {
  return `${issueId}:${modelId}:earnin`;
}

/**
 * Pure dispatch transition: bump the deterministic counter, append the rolling
 * timestamp, occupy one model slot and one lane slot, record the idempotency
 * key. Append-only — pruning `dispatchedThisWeek` here would let an
 * injected/skewed clock widen the window (named mutant:
 * exceed-8-with-injected-clock), so `planEarnIn` filters to the window itself.
 */
export function nextEarnInStateOnDispatch(
  state: EarnInState,
  card: Pick<EarnInCandidateCard, "issueId" | "modelId" | "lane">,
  nowMs: number,
): EarnInState {
  const key = earnInIdempotencyKey(card.issueId, card.modelId);
  return {
    ...state,
    counter: { ...state.counter, [card.modelId]: (state.counter[card.modelId] ?? 0) + 1 },
    dispatchedThisWeek: {
      ...state.dispatchedThisWeek,
      [card.modelId]: [...(state.dispatchedThisWeek[card.modelId] ?? []), nowMs],
    },
    activePerModel: {
      ...state.activePerModel,
      [card.modelId]: (state.activePerModel[card.modelId] ?? 0) + 1,
    },
    activePerLane: {
      ...state.activePerLane,
      [card.lane]: [...(state.activePerLane[card.lane] ?? []), card.issueId],
    },
    dispatchedKeys: state.dispatchedKeys.includes(key) ? state.dispatchedKeys : [...state.dispatchedKeys, key],
  };
}

// Only an explicit safety/authority marker stops a model immediately. A bare
// refusal ("refus") is a material failure for the 2-of-8 circuit, not an
// instant stop — otherwise one content-filter refusal on an admitted
// candidate would permanently retire its model.
const EARN_IN_SAFETY_RE = /flagged for possible cybersecurity|policy violation|safety violation|authority violation/i;
const EARN_IN_SAFETY_CODES: ReadonlySet<string> = new Set([
  "safety",
  "authority",
  "policy_violation",
  "content_filter",
]);

export interface EarnInResolutionInput {
  runStatus: string | null;
  errorText: string | null;
  errorCode: string | null;
  /** Human reopen/rejection signal on the card — the card did not stay accepted. */
  rejected: boolean;
  modelId: string;
}

export interface EarnInResolution {
  outcome: "ok" | "material-failure" | "ignore";
  safetyOrAuthorityViolation: boolean;
}

/**
 * Classify one dispatched-and-resolved earn-in card. "ignore" means the
 * resolution carries no model evidence (infra failure, unknown status): the
 * active slot still releases, but the first-8 window and the stop circuit do
 * not move.
 */
export function classifyEarnInResolution(input: EarnInResolutionInput): EarnInResolution {
  const errorText = input.errorText ?? "";
  const errorCode = (input.errorCode ?? "").trim().toLowerCase();
  if (EARN_IN_SAFETY_RE.test(errorText) || EARN_IN_SAFETY_CODES.has(errorCode)) {
    return { outcome: "material-failure", safetyOrAuthorityViolation: true };
  }
  if (input.rejected) return { outcome: "material-failure", safetyOrAuthorityViolation: false };
  if (input.runStatus === "succeeded") return { outcome: "ok", safetyOrAuthorityViolation: false };
  if (input.runStatus === "failed" || input.runStatus === "timed_out") {
    const kind = classifyRunFailure(input.errorText, input.errorCode, input.modelId).kind;
    return kind === "model"
      ? { outcome: "material-failure", safetyOrAuthorityViolation: false }
      : { outcome: "ignore", safetyOrAuthorityViolation: false };
  }
  return { outcome: "ignore", safetyOrAuthorityViolation: false };
}

/**
 * Pure resolve transition: always release the active slot; fold the outcome
 * into the first-8 window only when it is model-attributable. Delegates the
 * stop circuit to `recordEarnInOutcome` (sticky 2-of-8 + immediate safety
 * stop), so this file never re-implements that rule.
 */
export function nextEarnInStateOnResolve(
  state: EarnInState,
  modelId: string,
  lane: string,
  issueId: string,
  resolution: EarnInResolution,
): EarnInState {
  const released: EarnInState = {
    ...state,
    activePerModel: {
      ...state.activePerModel,
      [modelId]: Math.max(0, (state.activePerModel[modelId] ?? 0) - 1),
    },
    activePerLane: {
      ...state.activePerLane,
      [lane]: (state.activePerLane[lane] ?? []).filter((id) => id !== issueId),
    },
  };
  if (resolution.outcome === "ignore") return released;
  const index = state.firstEightOutcomes[modelId]?.length ?? 0;
  const folded = recordEarnInOutcome(released, modelId, resolution.outcome, resolution.safetyOrAuthorityViolation);
  if (index >= 8) return folded;
  return {
    ...folded,
    outcomeSlots: {
      ...state.outcomeSlots,
      [earnInIdempotencyKey(issueId, modelId)]: { modelId, lane, index },
    },
  };
}
