import { effortConfigKeyFor, resolveEffortPin } from "../engine/effort.js";
import type { AaFreeRow, AaFreeSnapshot } from "./parse.js";

/**
 * `default` = provider-default control (not a measured effort); `unknown` =
 * no evidence, ineligible for effort-scored selection.
 */
export type AaEffort =
  | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "default" | "unknown";

const KNOWN_EFFORTS: ReadonlySet<string> = new Set([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
]);

/** Requested / effective / served are three separate facts; no field substitutes for another. */
export interface EffortIdentity {
  /** What the issue/roster asked for. */
  requestedEffort: AaEffort;
  /** Deployed resolver output, decided BEFORE evidence lookup. */
  effectiveEffort: AaEffort;
  /** Post-hoc observation only; never an input to lookup. */
  observedServedEffort: AaEffort | null;
}

/** One curated, exact binding. Slug suffixes are never parsed to guess effort. */
export interface AaBinding {
  candidateId: string;
  modelId: string;
  laneId: string;
  /** Effort the AA slug was evaluated at. */
  evaluatedEffort: AaEffort;
  aaSlug: string;
  /** Benchmark variants that are not controllable harness treatments. */
  observationalOnly?: boolean;
}

export type CandidateEvidence =
  | { status: "matched"; candidateId: string; row: AaFreeRow; identity: EffortIdentity; binding: AaBinding }
  | { status: "ineligible"; reason: IneligibleReason; candidateId: string | null; identity: EffortIdentity };

export type IneligibleReason =
  | "effort-unknown"
  | "no-binding"
  | "observational-only"
  | "slug-absent-from-snapshot"
  | "slug-ambiguous";

function asEffort(v: string | null | undefined): AaEffort {
  const e = (v ?? "").trim().toLowerCase();
  return KNOWN_EFFORTS.has(e) ? (e as AaEffort) : "unknown";
}

/**
 * Resolve the effort the invocation will actually run, using the deployed
 * resolver. No max->high borrowing: a clamped effort IS the effective effort,
 * and evidence is looked up for that effort only.
 */
export function resolveEffectiveEffort(input: {
  adapterType: string | null | undefined;
  modelId: string;
  requestedEffort?: string | null;
  inheritedEffort?: string | null;
}): EffortIdentity {
  const requested = asEffort(input.requestedEffort);
  const pin = resolveEffortPin({
    adapterType: input.adapterType,
    modelId: input.modelId,
    rosterEffort: input.requestedEffort ?? null,
    inheritedEffort: input.inheritedEffort ?? null,
  });
  const key = effortConfigKeyFor(input.adapterType);
  let effective: AaEffort;
  switch (pin.outcome) {
    case "pinned":
    case "clamped":
    case "neutralized-clamped":
      effective = asEffort(key ? pin.writes[key] : null);
      break;
    case "inherited-ok":
      effective = asEffort(input.inheritedEffort);
      break;
    case "none":
    case "neutralized-cleared":
      effective = "default";
      break;
    default: // adapter-unsupported, rejected
      effective = "unknown";
  }
  return { requestedEffort: requested, effectiveEffort: effective, observedServedEffort: null };
}

/**
 * Exact model x effective-effort registry. Lookup keys on the effective
 * effort and fails closed: no binding, an `unknown`/`default` effort, an
 * observational-only variant, a slug missing from the snapshot or duplicated
 * in it all yield `ineligible` — never a fallback to another effort's row.
 */
export class AaEffortRegistry {
  private readonly byKey = new Map<string, AaBinding>();

  constructor(bindings: readonly AaBinding[]) {
    for (const b of bindings) {
      const key = AaEffortRegistry.key(b.modelId, b.laneId, b.evaluatedEffort);
      if (this.byKey.has(key)) throw new Error(`duplicate aa binding ${key}`);
      this.byKey.set(key, b);
    }
  }

  private static key(modelId: string, laneId: string, effort: AaEffort): string {
    return `${modelId}\u0000${laneId}\u0000${effort}`;
  }

  lookup(
    snapshot: AaFreeSnapshot,
    input: { modelId: string; laneId: string; identity: EffortIdentity },
  ): CandidateEvidence {
    const { identity } = input;
    const eff = identity.effectiveEffort;
    if (eff === "unknown" || eff === "default") {
      return { status: "ineligible", reason: "effort-unknown", candidateId: null, identity };
    }
    const binding = this.byKey.get(AaEffortRegistry.key(input.modelId, input.laneId, eff));
    if (!binding) return { status: "ineligible", reason: "no-binding", candidateId: null, identity };
    if (binding.observationalOnly) {
      return { status: "ineligible", reason: "observational-only", candidateId: binding.candidateId, identity };
    }
    if (snapshot.duplicateSlugs.includes(binding.aaSlug)) {
      return { status: "ineligible", reason: "slug-ambiguous", candidateId: binding.candidateId, identity };
    }
    const row = snapshot.rows.find((r) => r.slug === binding.aaSlug);
    if (!row) {
      return { status: "ineligible", reason: "slug-absent-from-snapshot", candidateId: binding.candidateId, identity };
    }
    return { status: "matched", candidateId: binding.candidateId, row, identity, binding };
  }
}
