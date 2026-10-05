import type { ModelEntry } from "./types.js";

/**
 * Collapses a model id down to its vendor-family line by stripping a
 * trailing run of version-like segments (bare integers, dotted point
 * releases, 8-digit dates). `claude-opus-4-8` and `claude-opus-5` both
 * collapse to `claude-opus`; `gpt-5.6-sol` is left whole because `sol` is
 * not version-like. A `provider/` prefix (`zai/glm-5.3`) is dropped first so
 * the same model routed through two providers still collapses to one family.
 */
export function modelFamily(modelId: string): string {
  const bare = modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId;
  const segments = bare.split("-");
  while (segments.length > 1 && /^\d/.test(segments[segments.length - 1]!)) {
    segments.pop();
  }
  return segments.join("-");
}

function priceSignature(model: ModelEntry): string {
  return `${model.costPerMTokIn}:${model.costPerMTokOut}:${model.costPerMTokCacheRead}`;
}

/**
 * True when `a` and `b` are the trigger condition for the owner's
 * same-price-newer-model rule (memory `same-price-newer-model-rule`,
 * ): two enabled roster rows in the same vendor family and tier,
 * priced identically.
 */
export function sharesPriceFamily(a: ModelEntry, b: ModelEntry): boolean {
  return (
    a.id !== b.id &&
    a.enabled !== false &&
    b.enabled !== false &&
    a.tier === b.tier &&
    modelFamily(a.id) === modelFamily(b.id) &&
    priceSignature(a) === priceSignature(b)
  );
}

/**
 * `ModelEntry.earnIn` is freeform roster metadata (schema.ts) with no
 * behavior wired to it yet anywhere else in the engine. This is the one
 * convention this rule reads from it: `{ verdict: "provenBetter" }` on the
 * OLDER of a same-price-family pair means an explicit eval already showed it
 * outperforms its newer, same-price sibling — the owner's stated exception.
 * Absent, `null`, or any other shape means no such verdict exists yet.
 */
function provenBetterVerdict(model: ModelEntry): boolean {
  const earnIn = model.earnIn;
  if (!earnIn || typeof earnIn !== "object") return false;
  return (earnIn as Record<string, unknown>).verdict === "provenBetter";
}

/**
 * 2026-09-19 owner rule (memory `same-price-newer-model-rule`, ):
 * "at the same price the newer version wins unless the older one is
 * demonstrably better at the task." Returns negative when `a` should rank
 * ahead of `b`, positive when `b` should rank ahead of `a`, and exactly `0`
 * when the pair is not a same-price-family match at all — callers must fall
 * through to their own tiebreak in that case, never treat `0` as "tied".
 */
export function compareSamePriceFamily(a: ModelEntry, b: ModelEntry): number {
  if (!sharesPriceFamily(a, b)) return 0;
  const aIsOlder = Date.parse(a.releasedAt) < Date.parse(b.releasedAt);
  const older = aIsOlder ? a : b;
  const newer = aIsOlder ? b : a;
  const winner = provenBetterVerdict(older) ? older : newer;
  return winner === a ? -1 : 1;
}
