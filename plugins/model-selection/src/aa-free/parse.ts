/**
 * `aa-free-v1`: parser for the official FREE-tier legacy list
 * `GET /api/v2/data/llms/models` (TOG-11549 design D1).
 *
 * Fail-closed: returns `null` on any structural mismatch, never throws. Every
 * observed field is kept as its own observation; null is unknown, never zero.
 * The legacy payload carries no index version, so `sourceVersion` is always
 * `"unknown"`. The ONLY decision input is `aaIndex`; everything else is an
 * observation with zero decision weight (see `project.ts`).
 */

/** The 18 evaluation keys observed in the authenticated legacy list (2026-10-01). */
export const AA_FREE_EVALUATION_KEYS = [
  "artificial_analysis_intelligence_index",
  "artificial_analysis_coding_index",
  "artificial_analysis_math_index",
  "mmlu_pro",
  "gpqa",
  "hle",
  "livecodebench",
  "scicode",
  "math_500",
  "aime",
  "aime_25",
  "ifbench",
  "lcr",
  "terminalbench_hard",
  "terminalbench_v2_1",
  "terminalbench_v4_0",
  "tau2",
  "tau_banking",
] as const;
export type AaFreeEvaluationKey = (typeof AA_FREE_EVALUATION_KEYS)[number];

export const AA_FREE_SOURCE = "artificialanalysis.ai/api/v2/data/llms/models" as const;
export const AA_FREE_PROFILE = "aa-free-v1" as const;

export interface AaFreeObservations {
  priceInput1m: number | null;
  priceOutput1m: number | null;
  priceBlended3to1: number | null;
  medianOutputTokensPerSecond: number | null;
  medianTimeToFirstTokenSeconds: number | null;
  /** Legacy field name has no `_seconds` suffix; unit is seconds. */
  medianTimeToFirstAnswerTokenSeconds: number | null;
  evaluations: Readonly<Record<AaFreeEvaluationKey, number | null>>;
}

/**
 * Namespace for richer (non-free) metrics. The free parser never populates it;
 * it exists so a future source can attach observations WITHOUT any decision
 * path reading them. Typed `unknown` on purpose.
 */
export type AaOptionalRich = Readonly<Record<string, unknown>>;

export interface AaFreeRow {
  id: string;
  slug: string;
  name: string | null;
  releaseDate: string | null;
  creatorName: string | null;
  /** Normalised `artificial_analysis_intelligence_index`; null = unknown. */
  aaIndex: number | null;
  free: AaFreeObservations;
  optionalRich: AaOptionalRich;
}

export interface AaFreeSnapshot {
  profile: typeof AA_FREE_PROFILE;
  source: typeof AA_FREE_SOURCE;
  /** Legacy list publishes no index version. */
  sourceVersion: "unknown";
  retrievedAt: string;
  workload: { parallelQueries: number | null; promptLength: number | null };
  rows: readonly AaFreeRow[];
  /** Slugs seen more than once; mapping must disambiguate, never last-write-wins. */
  duplicateSlugs: readonly string[];
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function buildRow(raw: unknown): AaFreeRow | null {
  const r = obj(raw);
  const slug = str(r.slug);
  if (slug === null) return null;
  const id = typeof r.id === "string" ? r.id : slug;
  const pricing = obj(r.pricing);
  const ev = obj(r.evaluations);
  const evaluations = {} as Record<AaFreeEvaluationKey, number | null>;
  for (const key of AA_FREE_EVALUATION_KEYS) evaluations[key] = num(ev[key]);
  return Object.freeze({
    id,
    slug,
    name: str(r.name),
    releaseDate: str(r.release_date),
    creatorName: str(obj(r.model_creator).name),
    aaIndex: evaluations.artificial_analysis_intelligence_index,
    free: Object.freeze({
      priceInput1m: num(pricing.price_1m_input_tokens),
      priceOutput1m: num(pricing.price_1m_output_tokens),
      priceBlended3to1: num(pricing.price_1m_blended_3_to_1),
      medianOutputTokensPerSecond: num(r.median_output_tokens_per_second),
      medianTimeToFirstTokenSeconds: num(r.median_time_to_first_token_seconds),
      medianTimeToFirstAnswerTokenSeconds: num(r.median_time_to_first_answer_token),
      evaluations: Object.freeze(evaluations),
    }),
    optionalRich: Object.freeze({}),
  });
}

/** Parse the legacy-list JSON text into an immutable snapshot, or `null`. */
export function parseAaFreeList(text: string, retrievedAt: string): AaFreeSnapshot | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const top = obj(body);
  if (!Array.isArray(top.data)) return null;
  const rows: AaFreeRow[] = [];
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const entry of top.data) {
    const row = buildRow(entry);
    if (!row) continue;
    if (seen.has(row.slug)) dup.add(row.slug);
    seen.add(row.slug);
    rows.push(row);
  }
  if (rows.length === 0) return null;
  const opts = obj(top.prompt_options);
  return Object.freeze({
    profile: AA_FREE_PROFILE,
    source: AA_FREE_SOURCE,
    sourceVersion: "unknown",
    retrievedAt,
    workload: { parallelQueries: num(opts.parallel_queries), promptLength: num(opts.prompt_length) },
    rows: Object.freeze(rows),
    duplicateSlugs: Object.freeze([...dup].sort()),
  });
}
