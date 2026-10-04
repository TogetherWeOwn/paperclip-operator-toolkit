import {
  CARD_CENSOR_DAYS,
  SCORE_PRIOR_K,
  SCORE_PROVEN_N,
} from "../constants.js";
import {
  cohortKey,
  resolveServedEffort,
  resolveServedModel,
  resolveTaskClassFromLabels,
  UNKNOWN_COHORT_VALUE,
  type AcceptedWorkCohort,
} from "./cohort.js";

/**
 * First-party accepted-work posterior overlay (shadow-only).
 *
 * Folds accepted-work observations — served model x effective effort x task
 * class -> accept/rework counts — into a versioned posterior overlay consumed
 * (in a future reviewed slice, not this one) by the data-driven tier
 * evaluator. This slice produces the artifact and the report; nothing reads
 * it for routing yet.
 *
 * Legacy semantics preserved exactly (card requirement):
 * - prior weight 6 (`SCORE_PRIOR_K`), proven sample count 8
 *   (`SCORE_PROVEN_N`), 14-day censor window (`CARD_CENSOR_DAYS`);
 * - stickiness is preserved by construction: no selection module imports this,
 *   so no pin behavior can change with the producer on or off.
 *
 * Shadow-only by construction (mirroring the aa-free P2 discipline):
 * - pure functions below — no `ctx`, no IO, no write path to audit;
 * - the worker only builds this when `config.acceptedWork.enabled`, stores it
 *   under its own state key, and serves it through a read-only report tool;
 * - S-tier (`fallbackOnly`) cohorts stay `held: "fallback-only"` — the overlay
 *   never lifts them, it only labels them.
 */

/** Frozen spec identity. Bump on ANY change to cohorting, censoring, or math. */
export const ACCEPTED_WORK_SPEC_VERSION = "tog12972-v1";

/** One closed card, attributed to its served cohort. Built by the worker. */
export interface AcceptedWorkCardInput {
  issueId: string;
  /** Raw recorded model of the latest closing run (unresolved — resolution happens here). */
  rawServedModel: string | null;
  /** The issue pin's `adapterConfig` at read time (effort keys live here). */
  pinAdapterConfig: Record<string, unknown> | null;
  /** Label names on the issue at read time (task-class labels live here). */
  labelNames: readonly string[];
  /** ms epoch the card was closed. */
  closedAtMs: number;
  /** True if a reopen (<=72h) or rejection comment (<=48h) was observed. */
  rejected: boolean;
}

/** The roster view attribution reads. Structural so tests stay light. */
export interface AcceptedWorkModelView {
  id: string;
  fallbackOnly: boolean;
}

export interface AcceptedWorkCohortStats extends AcceptedWorkCohort {
  /** Closed cards that aged out of the censor window (or were rejected early). */
  resolved: number;
  /** Resolved cards with no rework observed. */
  accepted: number;
  /** Resolved cards with rework observed. */
  rejected: number;
  /** Closed cards still inside the censor window — counted, never scored. */
  pending: number;
  /** The served model's prior (same source the legacy ledger uses). */
  priorP: number;
  /** Beta-binomial posterior: (accepted + K*prior) / (resolved + K), K = 6. */
  p: number;
  /** True once `resolved` reaches the proven sample count (8). */
  proven: boolean;
  /** S-tier cohorts stay held even as evidence: the overlay never lifts them. */
  held: "fallback-only" | null;
  /** Why this card's coordinates landed where they did (audit trail). */
  attribution: {
    modelReason: string;
    effortReason: string;
  };
}

export interface AcceptedWorkUnattributed {
  /** Closed cards with no closing run at all (handoff, window loss). Dropped, not guessed. */
  closedCardsWithoutClosingRun: number;
}

export interface AcceptedWorkOverlay {
  specVersion: typeof ACCEPTED_WORK_SPEC_VERSION;
  computedAt: string;
  cohorts: AcceptedWorkCohortStats[];
  unattributed: AcceptedWorkUnattributed;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Attribute one card to its cohort. Unknown coordinates stay in `unknown`
 * cells — they are never inferred from the requested (pinned) model name and
 * never borrowed from another effort's evidence.
 */
export function attributeAcceptedWorkCard(
  card: AcceptedWorkCardInput,
  models: readonly AcceptedWorkModelView[],
): { cohort: AcceptedWorkCohort; held: "fallback-only" | null; attribution: AcceptedWorkCohortStats["attribution"] } {
  const model = resolveServedModel(card.rawServedModel, models);
  const effort = resolveServedEffort(card.pinAdapterConfig);
  const taskClass = resolveTaskClassFromLabels(card.labelNames);
  // S-tier stays held even as evidence: the overlay never lifts a
  // `fallbackOnly` row — it only labels the cohort. The unknown cell (`null`
  // resolution) is never held: "unknown" is not an S-tier model.
  const served = model.status === "known"
    ? models.find((m) => m.id === model.servedModel) ?? null
    : null;
  const held = served?.fallbackOnly === true ? ("fallback-only" as const) : null;
  return {
    cohort: { servedModel: model.servedModel, servedEffort: effort.servedEffort, taskClass },
    held,
    attribution: { modelReason: model.reason, effortReason: effort.reason },
  };
}

/**
 * Fold attributed cards into per-cohort posteriors. Mirrors
 * `buildCardLedger`'s censor discipline: a card closed less than
 * `CARD_CENSOR_DAYS` ago and not yet rejected is pending — right-censored,
 * excluded from both counts (never assumed accepted).
 */
export function buildAcceptedWorkOverlay(input: {
  cards: readonly AcceptedWorkCardInput[];
  models: readonly AcceptedWorkModelView[];
  priorPByModel: Readonly<Record<string, number>>;
  unattributed: AcceptedWorkUnattributed;
  nowMs: number;
  nowIso: string;
}): AcceptedWorkOverlay {
  const censorMs = CARD_CENSOR_DAYS * 24 * 60 * 60 * 1000;
  const byKey = new Map<string, { cohort: AcceptedWorkCohort; held: "fallback-only" | null; rows: AcceptedWorkCardInput[] }>();
  for (const card of input.cards) {
    const { cohort, held } = attributeAcceptedWorkCard(card, input.models);
    const key = cohortKey(cohort);
    const bucket = byKey.get(key);
    if (bucket) bucket.rows.push(card);
    else byKey.set(key, { cohort, held, rows: [card] });
  }

  const cohorts: AcceptedWorkCohortStats[] = [...byKey.values()].map(({ cohort, held, rows }) => {
    const resolved = rows.filter((r) => r.rejected || input.nowMs - r.closedAtMs >= censorMs);
    const accepted = resolved.filter((r) => !r.rejected);
    // The prior is the served model's own prior — the same source the legacy
    // ledger falls back to — or 0.8 for the unknown cell, which is
    // `priorP(null)`: "assume roughly T2 until measured", never a measurement.
    const priorP = cohort.servedModel === UNKNOWN_COHORT_VALUE
      ? 0.8
      : (input.priorPByModel[cohort.servedModel] ?? 0.8);
    const p = (accepted.length + SCORE_PRIOR_K * priorP) / (resolved.length + SCORE_PRIOR_K);
    // Attribution reasons agree within a cell by construction (same key ← same
    // coordinates ← same resolver outputs), so the first row's trail stands
    // for the cell.
    const first = rows[0]!;
    const trail = attributeAcceptedWorkCard(first, input.models).attribution;
    return {
      ...cohort,
      resolved: resolved.length,
      accepted: accepted.length,
      rejected: resolved.length - accepted.length,
      pending: rows.length - resolved.length,
      priorP: round(priorP, 4),
      p: round(p, 3),
      proven: resolved.length >= SCORE_PROVEN_N,
      held,
      attribution: trail,
    };
  });
  cohorts.sort((a, b) =>
    cohortKey(a) < cohortKey(b) ? -1 : cohortKey(a) > cohortKey(b) ? 1 : 0,
  );

  return {
    specVersion: ACCEPTED_WORK_SPEC_VERSION,
    computedAt: input.nowIso,
    cohorts,
    unattributed: { ...input.unattributed },
  };
}

/**
 * Normalize untyped plugin-state input. Stored state is unversioned JSON a
 * previous build (or a hand edit) may have shaped differently; a malformed
 * value fails OPEN to an empty overlay rather than crashing the report tool.
 * A spec-version mismatch is also an empty overlay: rows written under a
 * superseded spec describe a rule this build no longer implements.
 */
export function normalizeAcceptedWorkOverlay(stored: unknown): AcceptedWorkOverlay | null {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const record = stored as Record<string, unknown>;
  if (record.specVersion !== ACCEPTED_WORK_SPEC_VERSION) return null;
  if (!Array.isArray(record.cohorts)) return null;
  if (typeof record.computedAt !== "string") return null;
  const unattributed = record.unattributed as Record<string, unknown> | null;
  const cohorts: AcceptedWorkCohortStats[] = [];
  for (const entry of record.cohorts) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const row = entry as Record<string, unknown>;
    if (
      typeof row.servedModel !== "string" ||
      typeof row.servedEffort !== "string" ||
      typeof row.taskClass !== "string" ||
      !isSafeCount(row.resolved) ||
      !isSafeCount(row.accepted) ||
      !isSafeCount(row.rejected) ||
      !isSafeCount(row.pending) ||
      typeof row.priorP !== "number" ||
      !Number.isFinite(row.priorP) ||
      typeof row.p !== "number" ||
      !Number.isFinite(row.p) ||
      typeof row.proven !== "boolean" ||
      (row.held !== null && row.held !== "fallback-only")
    ) {
      return null;
    }
    cohorts.push(row as unknown as AcceptedWorkCohortStats);
  }
  return {
    specVersion: ACCEPTED_WORK_SPEC_VERSION,
    computedAt: record.computedAt,
    cohorts,
    unattributed: {
      closedCardsWithoutClosingRun: isSafeCount(unattributed?.closedCardsWithoutClosingRun)
        ? (unattributed.closedCardsWithoutClosingRun as number)
        : 0,
    },
  };
}
