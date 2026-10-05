import type { ModelEntry } from "./types.js";

/**
 * bridge-model ids covered by the  roster slice.
 *
 * The fleet-quota-balancer's MUSE / PRIMARY / FALLBACK choices. Kept as data
 * here (not inferred from tiers or lanes): membership is an operator-curated
 * fact, and a future bridge addition must be a deliberate edit to this list,
 * never a naming-pattern guess.
 */
export const BRIDGE_MODEL_IDS = [
  "muse-spark-1.3-contributor",
  "claude-sonnet-5-5",
  "gpt-6.1-sol",
] as const;

export type BridgeModelId = (typeof BRIDGE_MODEL_IDS)[number];

/** Machine-readable reason when advise finds no servable row for a bridge model. */
export const NO_ENABLED_ROWS = "NO_ENABLED_ROWS" as const;

export type BridgeModelNoEnabledRowsReason = typeof NO_ENABLED_ROWS;

export interface BridgeModelHit {
  status: "ok";
  modelId: string;
  /** Every ENABLED roster row carrying this model id. Non-empty by construction. */
  rows: readonly ModelEntry[];
}

export interface BridgeModelMiss {
  status: "no-enabled-rows";
  /** Machine-readable reason code — never prose-parsed by the caller. */
  reason: BridgeModelNoEnabledRowsReason;
  modelId: string;
  /**
   * Roster rows carrying this model id regardless of `enabled` (0 = the id
   * is absent entirely). Lets the caller tell "never configured" apart from
   * "configured but all disabled" without a second lookup.
   */
  rowsSeen: number;
}

export type BridgeModelAdvice = BridgeModelHit | BridgeModelMiss;

/**
 * advise-path lookup: enabled roster rows for one bridge model.
 *
 * Pure and advise-only: it reads an in-memory roster snapshot and returns a
 * machine-readable answer — either the enabled rows, or `NO_ENABLED_ROWS`
 * naming the model id — instead of a bare fallback (null / degraded
 * judgement) the caller would have to interpret. No config resolution, no
 * `selection.mode` read, no enforce change: enforcement behavior is owned by
 * , orphan-drop by .
 */
export function adviseBridgeModel(
  models: readonly ModelEntry[],
  modelId: string,
): BridgeModelAdvice {
  const seen = models.filter((model) => model.id === modelId);
  const rows = seen.filter((model) => model.enabled);
  if (rows.length > 0) return { status: "ok", modelId, rows };
  return { status: "no-enabled-rows", reason: NO_ENABLED_ROWS, modelId, rowsSeen: seen.length };
}
