import { TIER_ORDER, type Tier } from "../constants.js";
import { priorP } from "../engine/scores.js";
import { LEGACY_TIER_POLICY } from "../engine/tier-policy.js";

const ID_PREFIX_RE = /^(cliproxy\/|openrouter\/|opencode-go\/|zai\/)/;

/**
 * Normalize a roster model id to the shape aa.ai's slugs use: strip the
 * routing-provenance prefixes this roster carries (none of which aa.ai
 * knows about), lowercase, and turn dots into dashes (aa.ai slugs are
 * dash-separated, e.g. `glm-4-5v`, not `glm-4.5v`).
 */
function normalizeModelId(modelId: string): string {
  return modelId.replace(ID_PREFIX_RE, "").toLowerCase().replace(/\./g, "-");
}

/**
 * Resolve a roster model to an aa.ai slug. An explicit `aaSlug` always wins
 * (operator-confirmed). Otherwise this requires an EXACT match against the
 * fetched slug set — no fuzzy scoring. A miss returns `null`: "not tracked
 * for drift this run," never a wrong match. Under-matching (silently
 * untracked) is the safer failure mode for a signal that must never
 * silently move a tier.
 */
export function resolveAaSlug(
  modelId: string,
  knownSlugs: ReadonlySet<string>,
  explicitSlug?: string | null,
): string | null {
  if (explicitSlug) return knownSlugs.has(explicitSlug) ? explicitSlug : null;
  const normalized = normalizeModelId(modelId);
  return knownSlugs.has(normalized) ? normalized : null;
}

/**
 * Which tier CUT (`priorP(idx) >= scoreThresholds[tier]`) this index clears on
 * its prior alone, highest tier first. `null` when it clears none. Pure
 * function shared by drift detection and its tests.
 *
 * These are the tier policy's score cuts (`tierForPosterior`), not its
 * capability bars (`summarize`). The two used to be the same table; since the
 * serving `t1baseline` carry-forward they differ at T1 (cut 0.85, bar 0.8), and
 * this has always followed the cut. It only flags drift; it never admits a
 * model to a tier.
 */
export function tierImpliedByIndex(
  index: number,
  thresholds: Readonly<Record<Tier, number>> = LEGACY_TIER_POLICY.scoreThresholds,
): Tier | null {
  const p = priorP(index);
  for (const tier of [...TIER_ORDER].reverse()) {
    if (p >= thresholds[tier]) return tier;
  }
  return null;
}

const EFFORT_SUFFIX_RE = /-(low|medium|high|xhigh|non-reasoning)$/;

/**
 * aa.ai publishes one record per (model x effort level), the effort encoded
 * as a slug suffix. Returns null for the
 * base/default row — never fabricated for a slug with no such suffix.
 */
export function effortSuffixOf(slug: string): string | null {
  return EFFORT_SUFFIX_RE.exec(slug)?.[1] ?? null;
}
