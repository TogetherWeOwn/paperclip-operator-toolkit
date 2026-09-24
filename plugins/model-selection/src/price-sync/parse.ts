/**
 * models.dev's `api.json` is a two-level object: provider id -> `{ models:
 * { model id -> record } }`, each record carrying an optional `cost` block in
 * $/Mtok. Only the three fields the selector's cost term reads are lifted out
 * (`costPerMTokIn`/`costPerMTokOut`/`costPerMTokCacheRead`, ADR-0001); the
 * rest of the record is deliberately dropped rather than stored, because
 * anything stored here would eventually be read as if the roster tracked it.
 */
export interface PriceRecord {
  providerId: string;
  modelId: string;
  /** $/Mtok input. `null` when the feed publishes no `cost.input` for this model. */
  input: number | null;
  /** $/Mtok output. `null` when the feed publishes no `cost.output`. */
  output: number | null;
  /**
   * $/Mtok cached-read. `null` — NOT 0 — when the feed omits `cache_read`
   * (e.g. `zhipuai/glm-4.5v`). A missing field is "not published"; reporting
   * it as 0 would manufacture a drift row against every correctly-priced
   * roster row whose provider simply doesn't publish a cache rate.
   */
  cacheRead: number | null;
}

/** provider id -> (bare model id -> record). */
export type PriceCatalog = Map<string, Map<string, PriceRecord>>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Finite numbers only. `NaN`/`Infinity` (a JSON `1e999` parses to `Infinity`)
 * are treated as unpublished rather than propagated into a cost comparison.
 */
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Parse the models.dev catalogue. Returns `null` — never a partial map — when
 * the payload is not parseable JSON or is not the expected provider object, so
 * the caller can keep its prior snapshot rather than diff against an empty
 * catalogue and report the whole roster as "absent from the feed".
 *
 * A provider entry with no `models` object is skipped; a model with no `cost`
 * block is still recorded, with all three fields `null`. That distinction
 * matters downstream: "present in the feed, unpriced" and "absent from the
 * feed" are different facts, and only the second one is the card's
 * "absence is not evidence of a wrong price" case.
 */
export function parsePriceCatalog(json: string): PriceCatalog | null {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return null;
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;

  const catalog: PriceCatalog = new Map();
  for (const [providerId, providerValue] of Object.entries(root as Record<string, unknown>)) {
    const models = asRecord(asRecord(providerValue).models);
    if (Object.keys(models).length === 0) continue;

    const byModel = new Map<string, PriceRecord>();
    for (const [modelId, modelValue] of Object.entries(models)) {
      const cost = asRecord(asRecord(modelValue).cost);
      byModel.set(modelId, {
        providerId,
        modelId,
        input: finiteNumber(cost.input),
        output: finiteNumber(cost.output),
        cacheRead: finiteNumber(cost.cache_read),
      });
    }
    catalog.set(providerId, byModel);
  }

  // An object that parsed but yielded no provider carrying models is a shape
  // change, not an empty industry. Same verdict as unparseable.
  return catalog.size === 0 ? null : catalog;
}
