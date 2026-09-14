import type { Tier } from "../constants.js";
import { tierImpliedByIndex } from "./match.js";
import { AA_NUMERIC_FIELDS, type AaModelRecord, type AaNumericField } from "./parse.js";

export interface AaFieldDelta {
  field: AaNumericField;
  previous: number | null;
  fresh: number | null;
  delta: number | null;
}

export interface AaDiffRow {
  modelId: string;
  previousIndex: number | null;
  freshIndex: number;
  delta: number | null;
  previousImpliedTier: Tier | null;
  freshImpliedTier: Tier | null;
  /** True when the fresh index implies a different tier than the previous one did. */
  crossesBoundary: boolean;
  /**
   * Every numeric field (TOG-2438 scope expansion) whose value differs
   * between the PREVIOUS fetched snapshot and the FRESH one for this slug —
   * price, speed, latency, context window, sub-benchmarks, etc. This is a
   * fetch-over-fetch comparison, independent of the roster's curated
   * `aaIndex` (which only ever drives `previousIndex`/`crossesBoundary`
   * above). Both-null fields are omitted; a field present in only one
   * snapshot is reported with the other side `null`, never fabricated.
   */
  fieldDeltas: AaFieldDelta[];
}

export interface AaDiffModelInput {
  modelId: string;
  /** The roster's currently-recorded aaIndex, or null if never set. */
  previousIndex: number | null;
  /** Resolved aa.ai slug for this model, or null if unmatched (excluded from the diff). */
  slug: string | null;
}

function diffFields(previous: AaModelRecord | undefined, fresh: AaModelRecord): AaFieldDelta[] {
  const deltas: AaFieldDelta[] = [];
  for (const field of AA_NUMERIC_FIELDS) {
    const prevValue = previous ? previous[field] : null;
    const freshValue = fresh[field];
    if (prevValue === null && freshValue === null) continue;
    if (prevValue === freshValue) continue;
    deltas.push({
      field,
      previous: prevValue,
      fresh: freshValue,
      delta: prevValue === null || freshValue === null ? null : freshValue - prevValue,
    });
  }
  return deltas;
}

/**
 * Pure diff: for every model with a resolved slug and a fresh reading,
 * compare the roster's currently-recorded `aaIndex` against the fresh
 * `intelligenceIndex` (tier-boundary crossing, unchanged semantics), and
 * separately diff every numeric field between the previous fetched snapshot
 * and the fresh one (TOG-2438 scope expansion — `fieldDeltas`). Models with
 * no resolved slug, or whose slug is absent from the fresh snapshot, are
 * omitted entirely — "not tracked for drift this run" — never reported as a
 * zero-delta match.
 */
export function diffSnapshot(
  models: readonly AaDiffModelInput[],
  freshBySlug: ReadonlyMap<string, AaModelRecord>,
  previousBySlug: ReadonlyMap<string, AaModelRecord> = new Map(),
): AaDiffRow[] {
  const rows: AaDiffRow[] = [];
  for (const model of models) {
    if (!model.slug) continue;
    const freshRecord = freshBySlug.get(model.slug);
    if (freshRecord === undefined || freshRecord.intelligenceIndex === null) continue;
    const freshIndex = freshRecord.intelligenceIndex;

    const previousIndex = model.previousIndex;
    const delta = previousIndex === null ? null : freshIndex - previousIndex;
    const previousImpliedTier = previousIndex === null ? null : tierImpliedByIndex(previousIndex);
    const freshImpliedTier = tierImpliedByIndex(freshIndex);

    rows.push({
      modelId: model.modelId,
      previousIndex,
      freshIndex,
      delta,
      previousImpliedTier,
      freshImpliedTier,
      crossesBoundary: previousImpliedTier !== freshImpliedTier,
      fieldDeltas: diffFields(previousBySlug.get(model.slug), freshRecord),
    });
  }
  return rows;
}
