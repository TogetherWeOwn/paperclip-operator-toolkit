/**
 * Which models.dev provider prices a lane's traffic.
 *
 * Keyed on `laneId`, deliberately NOT inferred from the model id. The same
 * model is priced differently at different providers — `kimi-k2.6` is on both
 * `moonshotai` and `opencode-go` in today's feed at different rates, as are
 * `glm-5.x` and the `muse-spark-*-contributor` rows — so a global id search
 * returns *a* price with high confidence and the wrong one about as often as
 * the right one. The lane is the only field on a roster row that records who
 * we actually buy from.
 *
 * Verified against the 2026-09-22 manual audit, which is where this exact
 * mapping came from. A lane absent from this map is reported as unresolved
 * rather than guessed: a new lane is a code change here, because getting it
 * wrong is silent and the failure mode is a confidently-wrong price feeding
 * the cost sort.
 */
export const LANE_PRICE_PROVIDERS: Readonly<Record<string, string>> = {
  "cliproxy-claude": "anthropic",
  "cliproxy-codex": "openai",
  "cliproxy-meta": "meta",
  "cliproxy-zai": "zhipuai",
  "cliproxy-kimi": "moonshotai",
  "cliproxy-opencode-go": "opencode-go",
};

/**
 * Roster rows that are correct as-is and must never be "fixed" against
 * models.dev. Each is a different reason, and each reason is the argument for
 * why absence from the feed is not evidence of a wrong price.
 */
export type PriceExclusionReason =
  /** Devin meters by subscription/ACU, not per token. It is not on models.dev and a per-token price for it would be a fiction. */
  | "metered-not-per-token"
  /** A genuinely-free row (-free ids or note-marked Zen offers such as big-pickle). 0 is the true price, not a missing one. */
  | "free-tier"
  /** A retired id, absent from the feed but verified against historical rates. The feed drops retired models; that is not a price change. */
  | "retired-verified"
  /** Priced per image, excluded from chat routing entirely — the $/Mtok fields do not describe it. */
  | "per-image";

/** Roster id prefix for the 28 Devin rows. */
const DEVIN_PREFIX = "devin/";

/**
 * The six enabled retired Anthropic ids the 2026-09-22 audit checked by hand
 * against historical rate cards and confirmed correct. Bare ids: the
 * exclusion is matched after prefix stripping, so `cliproxy/claude-opus-4-...`
 * is covered too.
 */
const RETIRED_VERIFIED_IDS: ReadonlySet<string> = new Set([
  "claude-3-5-haiku-20241022",
  "claude-3-7-sonnet-20250219",
  "claude-opus-4-1-20250805",
  "claude-opus-4-20250514",
  "claude-sonnet-4-20250514",
  "claude-opus-4-6-thinking",
]);

/** Image models: per-image pricing, not in chat routing. */
const PER_IMAGE_IDS: ReadonlySet<string> = new Set(["gpt-image-1.5", "gpt-image-2"]);

/**
 * Strip the routing-provenance prefix a roster id may carry
 * (`cliproxy/claude-sonnet-5`, `opencode-go/glm-5.3`, ...) down to the bare id
 * models.dev keys its per-provider model map by. Everything through the final
 * `/` goes; models.dev ids never contain one.
 *
 * Case and punctuation are left alone — unlike aa.ai slugs, models.dev keys
 * are the vendor's own model ids, dots included (`glm-4.5v`, `gpt-5.5`), so
 * normalizing them would break the match rather than fix it.
 */
export function bareModelId(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  return slash === -1 ? modelId : modelId.slice(slash + 1);
}

/**
 * Why this row is out of scope for price reconciliation, or `null` if it is in
 * scope. Checked before any feed lookup: an excluded row must not produce a
 * drift finding even when the feed happens to carry an id that looks like it.
 */
export function priceExclusionReason(modelId: string, note?: string | null): PriceExclusionReason | null {
  if (modelId.startsWith(DEVIN_PREFIX)) return "metered-not-per-token";
  const bare = bareModelId(modelId);
  // Same free-model markers as scripts/assemble-additive-config.mjs:
  // big-pickle has no -free suffix, but its note identifies the free Zen offer.
  // Do not exempt the whole Zen lane or treat an unmarked 0 price as proof.
  if (bare.endsWith("-free") || /(?:free Zen model|no Go quota)/i.test(note ?? "")) return "free-tier";
  if (RETIRED_VERIFIED_IDS.has(bare)) return "retired-verified";
  if (PER_IMAGE_IDS.has(bare)) return "per-image";
  return null;
}

export interface PriceMatchInput {
  modelId: string;
  laneId: string | null;
  note?: string | null;
}

export type PriceMatchOutcome =
  | { kind: "matched"; providerId: string; bareId: string }
  | { kind: "excluded"; reason: PriceExclusionReason }
  | { kind: "no-lane" }
  | { kind: "unmapped-lane"; laneId: string }
  | { kind: "absent-from-feed"; providerId: string; bareId: string };

/**
 * Resolve one roster row against the fetched catalogue. Every non-match is a
 * distinct, named outcome rather than a bare `null`: "we chose not to check
 * this", "we could not check this", and "we checked and the feed does not
 * carry it" are three different things, and only the first is a settled
 * answer. Collapsing them is how a reconciliation report starts quietly
 * skipping rows nobody notices.
 */
export function matchRosterRow(
  row: PriceMatchInput,
  catalog: ReadonlyMap<string, ReadonlyMap<string, unknown>>,
): PriceMatchOutcome {
  const excluded = priceExclusionReason(row.modelId, row.note);
  if (excluded) return { kind: "excluded", reason: excluded };

  if (!row.laneId) return { kind: "no-lane" };
  const providerId = LANE_PRICE_PROVIDERS[row.laneId];
  if (!providerId) return { kind: "unmapped-lane", laneId: row.laneId };

  const bareId = bareModelId(row.modelId);
  const models = catalog.get(providerId);
  if (!models || !models.has(bareId)) return { kind: "absent-from-feed", providerId, bareId };

  return { kind: "matched", providerId, bareId };
}
