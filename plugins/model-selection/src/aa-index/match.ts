import { SCORE_THRESHOLDS, TIER_ORDER, type Tier } from "../constants.js";
import { priorP } from "../engine/scores.js";

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
 * Which tier's admission bar (`priorP(idx) >= SCORE_THRESHOLDS[tier]`) this
 * index currently clears, highest tier first. `null` when the index clears
 * no tier's threshold. Pure function shared by drift detection and its
 * tests — the exact same math `priorP`/`summarize` already use to decide
 * capability, just inverted to answer "which tier would this prior admit."
 */
export function tierImpliedByIndex(index: number): Tier | null {
  const p = priorP(index);
  for (const tier of [...TIER_ORDER].reverse()) {
    if (p >= SCORE_THRESHOLDS[tier]) return tier;
  }
  return null;
}

const EFFORT_SUFFIX_RE = /-(low|medium|high|xhigh|non-reasoning)$/;

/**
 * aa.ai publishes one record per (model x effort level), the effort encoded
 * as a slug suffix (TOG-2438 scope expansion). Returns null for the
 * base/default row — never fabricated for a slug with no such suffix.
 */
export function effortSuffixOf(slug: string): string | null {
  return EFFORT_SUFFIX_RE.exec(slug)?.[1] ?? null;
}
