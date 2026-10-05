import { EFFORT_LADDER } from "../engine/effort.js";
import type { AaEffortEvidence } from "../engine/types.js";
import type { AaFreeSnapshot } from "./parse.js";
import {
  AaEffortRegistry,
  resolveEffectiveEffort,
  type AaBinding,
} from "./registry.js";

/**
 * P2: opt-in free-list sync/discovery/shadow.
 *
 * Default-off at every layer: `config.aaFreeSync.enabled` is false unless an
 * operator sets it, the scheduled job returns before any network when no
 * company enables it, and advise attaches no evidence without a fresh
 * snapshot plus curated bindings. Disabling restores legacy behavior
 * byte-for-byte (no evidence field, no fetch, no state change).
 *
 * What this module does NOT do, by construction (everything here is pure —
 * no `ctx`, no IO, so there is no write path to audit):
 * - never writes pins, tiers, enabled flags, adapter models or agent config;
 * - never lifts `fallbackOnly` (S-tier stays held);
 * - never admits an ambiguous match;
 * - never substitutes a credential (401/403 stops the source);
 * - never parses a slug suffix to derive effort (suffixes surface only as
 *   family hints for operator curation, never as bindings).
 *
 * Free AA only (owner constraint 2026-10-01): the only network input is the
 * official FREE-tier legacy list via `fetchAaFreeList`, under the D1 quota
 * (at most one scheduled fetch/day, 429 honored with Retry-After).
 */

/** The roster view the v2 layer reads. Structural so tests stay light; `ModelEntry` satisfies it. */
export interface SyncModelView {
  id: string;
  laneId: string | null | undefined;
  fallbackOnly: boolean;
  enabled: boolean;
}

export type BindingBreakReason =
  | "model-unknown"
  | "lane-mismatch"
  | "effort-inexpressible"
  | "slug-absent"
  | "slug-ambiguous"
  | "duplicate-binding";

export interface VerifiedBinding {
  binding: AaBinding;
  aaIndex: number | null;
  /** S-tier (`fallbackOnly`) and disabled rows stay curated-but-inactive, never eligible. */
  held: "fallback-only" | "model-disabled" | null;
}

export interface BrokenBinding {
  binding: AaBinding;
  reason: BindingBreakReason;
  detail: string;
}

export interface AmbiguousSlug {
  aaSlug: string;
  candidateIds: string[];
}

/** Effort levels a curated binding may claim. `default`/`unknown` are lookup-time ineligible, so they fail loudly here instead. */
const BINDABLE_EFFORTS: ReadonlySet<string> = new Set([...EFFORT_LADDER, "none"]);

/** Strip routing provenance the same way the v1 matcher does, so discovery and drift agree on identity. */
function normalizeRosterId(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  const bare = slash === -1 ? modelId : modelId.slice(slash + 1);
  return bare.toLowerCase().replace(/\./g, "-");
}

/**
 * Check curated bindings against the roster and a snapshot. Exact
 * lane/effort conformance only: the binding's lane must equal the roster
 * row's lane, the effort must be expressible, and the slug must resolve to
 * exactly one snapshot row. Anything else is broken, never a fallback.
 */
export function verifyBindings(input: {
  bindings: readonly AaBinding[];
  models: readonly SyncModelView[];
  snapshot: AaFreeSnapshot;
}): { verified: VerifiedBinding[]; broken: BrokenBinding[]; ambiguous: AmbiguousSlug[] } {
  const verified: VerifiedBinding[] = [];
  const broken: BrokenBinding[] = [];
  const ambiguous: AmbiguousSlug[] = [];

  // One key, one binding: two curated bindings for the same model x lane x
  // effort disagree about the slug, so neither may serve as evidence. All
  // sharers break loudly in the diff rather than first-wins silently.
  const keyCounts = new Map<string, number>();
  for (const binding of input.bindings) {
    const key = binding.modelId + "\u0000" + binding.laneId + "\u0000" + binding.evaluatedEffort;
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }

  for (const binding of input.bindings) {
    const key = binding.modelId + "\u0000" + binding.laneId + "\u0000" + binding.evaluatedEffort;
    if ((keyCounts.get(key) ?? 0) > 1) {
      broken.push({ binding, reason: "duplicate-binding", detail: `duplicate binding for ${binding.modelId} x ${binding.laneId} x ${binding.evaluatedEffort}` });
      continue;
    }
    const model = input.models.find((m) => m.id === binding.modelId);
    if (!model) {
      broken.push({ binding, reason: "model-unknown", detail: `roster has no model ${binding.modelId}` });
      continue;
    }
    if (!model.laneId || model.laneId !== binding.laneId) {
      broken.push({
        binding,
        reason: "lane-mismatch",
        detail: `binding lane ${binding.laneId} !== roster lane ${model.laneId ?? "none"}`,
      });
      continue;
    }
    if (!BINDABLE_EFFORTS.has(binding.evaluatedEffort)) {
      broken.push({
        binding,
        reason: "effort-inexpressible",
        detail: `evaluatedEffort ${binding.evaluatedEffort} is not a measurable effort level`,
      });
      continue;
    }
    if (input.snapshot.duplicateSlugs.includes(binding.aaSlug)) {
      broken.push({ binding, reason: "slug-ambiguous", detail: `slug ${binding.aaSlug} is duplicated in the snapshot` });
      continue;
    }
    const row = input.snapshot.rows.find((r) => r.slug === binding.aaSlug);
    if (!row) {
      broken.push({ binding, reason: "slug-absent", detail: `slug ${binding.aaSlug} is absent from the snapshot` });
      continue;
    }
    verified.push({
      binding,
      aaIndex: row.aaIndex,
      held: model.fallbackOnly ? "fallback-only" : model.enabled ? null : "model-disabled",
    });
  }

  // Two curated bindings claiming one slug is an ambiguous mapping even when
  // the snapshot itself is clean: neither may serve as evidence.
  const bySlug = new Map<string, VerifiedBinding[]>();
  for (const v of verified) {
    const group = bySlug.get(v.binding.aaSlug) ?? [];
    group.push(v);
    bySlug.set(v.binding.aaSlug, group);
  }
  const kept: VerifiedBinding[] = [];
  for (const [aaSlug, group] of bySlug) {
    if (group.length > 1) {
      ambiguous.push({ aaSlug, candidateIds: group.map((g) => g.binding.candidateId).sort() });
    } else {
      kept.push(group[0]!);
    }
  }
  return { verified: kept, broken, ambiguous };
}

export interface UnboundModel {
  modelId: string;
  laneId: string;
  /** Exact base-row slug match. A proposal for curation only: effort is still unknown, so this never auto-binds. */
  suggestedSlug: string | null;
  /** Slug-family hints (`<normalized-id>-*`) for operator review. Never bindings, never scored. */
  familySlugs: string[];
}

/**
 * Deterministic discovery over roster rows with no verified binding.
 * Exact normalized equality proposes; `<id>-*` prefix lists hints; anything
 * vaguer is not surfaced at all. Disabled and lane-less rows are skipped
 * silently — they cannot be selected, so proposing for them is noise.
 */
export function discoverUnbound(input: {
  models: readonly SyncModelView[];
  verified: readonly VerifiedBinding[];
  snapshot: AaFreeSnapshot;
  unmatchedCap?: number;
}): { unbound: UnboundModel[]; unmatchedSlugs: string[]; unmatchedTruncated: number } {
  const claimedSlugs = new Set(input.verified.map((v) => v.binding.aaSlug));
  const unbound: UnboundModel[] = [];

  for (const model of input.models) {
    if (!model.enabled || !model.laneId) continue;
    const hasBinding = input.verified.some((v) => v.binding.modelId === model.id && v.binding.laneId === model.laneId);
    if (hasBinding) continue;
    const norm = normalizeRosterId(model.id);
    const suggestedSlug = input.snapshot.rows.some((r) => r.slug === norm) ? norm : null;
    const familySlugs = input.snapshot.rows
      .map((r) => r.slug)
      .filter((slug) => slug !== norm && slug.startsWith(`${norm}-`))
      .sort();
    unbound.push({ modelId: model.id, laneId: model.laneId, suggestedSlug, familySlugs });
  }

  const knownFamilies = new Set<string>();
  for (const model of input.models) {
    if (!model.laneId) continue;
    const norm = normalizeRosterId(model.id);
    knownFamilies.add(norm);
    for (const row of input.snapshot.rows) {
      if (row.slug.startsWith(`${norm}-`)) knownFamilies.add(row.slug);
    }
  }
  const unmatched = input.snapshot.rows
    .map((r) => r.slug)
    .filter((slug) => !claimedSlugs.has(slug) && !knownFamilies.has(slug))
    .sort();
  const cap = input.unmatchedCap ?? 100;
  return {
    unbound,
    unmatchedSlugs: unmatched.slice(0, cap),
    unmatchedTruncated: Math.max(0, unmatched.length - cap),
  };
}

/** The reviewable per-company sync diff. Read-only; an operator curates from it, nothing applies it. */
export interface AaFreeSyncDiff {
  digest: string;
  fetchedAt: string;
  rowCount: number;
  verified: VerifiedBinding[];
  broken: BrokenBinding[];
  ambiguous: AmbiguousSlug[];
  unbound: UnboundModel[];
  unmatchedSlugs: string[];
  unmatchedTruncated: number;
}

export function buildSyncDiff(input: {
  bindings: readonly AaBinding[];
  models: readonly SyncModelView[];
  snapshot: AaFreeSnapshot;
  digest: string;
}): AaFreeSyncDiff {
  const { verified, broken, ambiguous } = verifyBindings(input);
  const { unbound, unmatchedSlugs, unmatchedTruncated } = discoverUnbound({ ...input, verified });
  return {
    digest: input.digest,
    fetchedAt: input.snapshot.retrievedAt,
    rowCount: input.snapshot.rows.length,
    verified,
    broken,
    ambiguous,
    unbound,
    unmatchedSlugs,
    unmatchedTruncated,
  };
}

// --- CAS snapshot identity ---------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** FNV-1a hex. Equality check only, not tamper-proof — no `node:` import so the plugin host can run this. */
function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Content address of a snapshot. Rows sort by slug first, so a pure
 * reorder is not a change; any observed-value change is.
 */
export function freeSnapshotDigest(snapshot: AaFreeSnapshot): string {
  const rows = [...snapshot.rows].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return fnv1aHex(JSON.stringify(canonicalize({ profile: snapshot.profile, source: snapshot.source, rows })));
}

// --- Quota + freshness -------------------------------------------------------

/** At most one scheduled fetch/day; 429 honors Retry-After; 401/403 stops the source (no substitution, back off a day). */
export type FreeFetchOutcome = "ok" | "rate-limited" | "retryable" | "fatal";

export function shouldFetchFreeSync(state: { nextEligibleAt: string | null }, nowMs: number): boolean {
  if (!state.nextEligibleAt) return true;
  const eligible = Date.parse(state.nextEligibleAt);
  return Number.isNaN(eligible) || nowMs >= eligible;
}

export function nextEligibleAfter(
  outcome: FreeFetchOutcome,
  nowMs: number,
  retryAfterSeconds: number | null,
  intervals?: { successMs?: number; retryMs?: number },
): string {
  const successMs = intervals?.successMs ?? 24 * 60 * 60 * 1000;
  const retryMs = intervals?.retryMs ?? 60 * 60 * 1000;
  let waitMs: number;
  switch (outcome) {
    case "ok":
    case "fatal":
      waitMs = successMs;
      break;
    case "retryable":
      waitMs = retryMs;
      break;
    case "rate-limited":
      waitMs = retryAfterSeconds !== null && retryAfterSeconds >= 0 ? retryAfterSeconds * 1000 : retryMs;
      break;
  }
  return new Date(nowMs + waitMs).toISOString();
}

/** Bounded freshness policy: older than `maxAgeMs` the snapshot is reported stale and yields no evidence. */
export function isSnapshotFresh(
  fetchedAt: string | null | undefined,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  if (!fetchedAt) return false;
  const at = Date.parse(fetchedAt);
  return Number.isFinite(at) && nowMs >= at && nowMs - at <= maxAgeMs;
}

// --- Advise-time shadow evidence ---------------------------------------------

/**
 * Alias for the decision-facing `AaEffortEvidence` (`engine/types.ts`). The
 * two shapes were defined in parallel and are field-identical
 * (`IneligibleReason | "snapshot-stale"` is exactly the decision type's
 * reason union); one name avoids a parallel type that can drift. The worker
 * assigns the builder's return straight onto `decision.aaEffortEvidence`.
 */
export type AdviseEffortEvidence = AaEffortEvidence;

/**
 * Resolve v2 evidence for the model selection just picked, for shadow
 * reporting only. Returns null when v2 is unconfigured (no bindings) — the
 * legacy path. Never throws, never gates: selection already decided.
 */
export function buildAdviseEvidence(input: {
  bindings: readonly AaBinding[];
  snapshot: AaFreeSnapshot;
  digest: string;
  stale: boolean;
  model: SyncModelView;
  adapterType: string | null | undefined;
  requestedEffort?: string | null;
  inheritedEffort?: string | null;
}): AdviseEffortEvidence | null {
  if (input.bindings.length === 0) return null;
  const identity = resolveEffectiveEffort({
    adapterType: input.adapterType,
    modelId: input.model.id,
    requestedEffort: input.requestedEffort,
    inheritedEffort: input.inheritedEffort,
  });
  const base = {
    requestedEffort: identity.requestedEffort,
    effectiveEffort: identity.effectiveEffort,
    // Advise time is pre-serving: served effort is unknown by construction,
    // so the field is the literal null rather than the identity's wider type.
    observedServedEffort: null as null,
    snapshotDigest: input.digest,
    stale: input.stale,
  };
  const held = input.model.fallbackOnly ? ("fallback-only" as const) : null;
  if (input.stale) {
    return { ...base, status: "ineligible", candidateId: null, reason: "snapshot-stale", aaIndex: null, held };
  }
  let registry: AaEffortRegistry;
  try {
    registry = new AaEffortRegistry(input.bindings);
  } catch {
    // Duplicate keys in unverified input: no evidence rather than wrong
    // evidence. The breakage itself surfaces in the per-company diff.
    return null;
  }
  const looked = registry.lookup(input.snapshot, {
    modelId: input.model.id,
    laneId: input.model.laneId ?? "",
    identity,
  });
  if (looked.status === "matched") {
    // Ambiguous mappings stay ineligible at advise time too, not just in the
    // reviewable diff: two curated bindings claiming one slug means neither
    // may serve as evidence, even when the snapshot itself is clean.
    const claimants = input.bindings.filter((b) => b.aaSlug === looked.binding.aaSlug).length;
    if (claimants > 1) {
      return { ...base, status: "ineligible", candidateId: looked.candidateId, reason: "slug-ambiguous", aaIndex: null, held };
    }
    return { ...base, status: "matched", candidateId: looked.candidateId, reason: null, aaIndex: looked.row.aaIndex, held };
  }
  return { ...base, status: "ineligible", candidateId: looked.candidateId, reason: looked.reason, aaIndex: null, held };
}

// --- candidateId carry through the model-ID-centric recovery path -------------

/**
 * Recover the selected roster row from a bare model id WITHOUT dropping the
 * v2 identity the decision already carries. The candidateId passes through
 * (possibly null) — it is never re-derived here, so a recovery site cannot
 * silently substitute a different candidate for the one evidenced at advise
 * time. Null when the model id resolves to no row.
 */
export function recoverSelectedCandidate<T extends { id: string }>(
  models: readonly T[],
  decision: { modelId: string | null; aaEffortEvidence?: AdviseEffortEvidence | null },
): (T & { candidateId: string | null }) | null {
  if (!decision.modelId) return null;
  const found = models.find((m) => m.id === decision.modelId);
  if (!found) return null;
  return { ...found, candidateId: decision.aaEffortEvidence?.candidateId ?? null };
}
