/**
 * Validation and compilation of the tier policy document.
 * The legacy evaluator is keyed by the fixed T1/T2/T3 union, so under it a
 * rename is accepted and an added, deleted or reordered tier is refused with a
 * named issue. Every refusal here is a code a P2 edit tool will surface.
 */
import { describe, expect, it } from "vitest";

import { AA_FREE_SOURCE } from "../../src/aa-free/parse.js";
import {
  CAPABILITY_PRIOR_BINDING,
  EVIDENCE_V2_EVALUATOR_ID,
  LEGACY_EVALUATOR_ID,
  LEGACY_MODEL_SELECTION_V1,
  LEGACY_TIER_POLICY,
  TierPolicyError,
  compileTierPolicy,
  validateTierPolicy,
  type MetricRule,
  type NumericMetricRule,
  type TierDefinition,
  type TierPolicy,
} from "../../src/engine/tier-policy.js";

const SEED = LEGACY_MODEL_SELECTION_V1;

function edit(change: (p: TierPolicy) => Partial<TierPolicy>): TierPolicy {
  return { ...SEED, revision: SEED.revision + 1, ...change(SEED) };
}

function editTier(id: string, change: (t: TierDefinition) => Partial<TierDefinition>): TierPolicy {
  return edit((p) => ({ tiers: p.tiers.map((t) => (t.id === id ? { ...t, ...change(t) } : t)) }));
}

function editLegacy(id: string, legacy: Partial<TierDefinition["legacy"]>): TierPolicy {
  return editTier(id, (t) => ({ legacy: { ...t.legacy, ...legacy } }));
}

const PREDICATE: MetricRule = { kind: "capability-predicate", decisionBinding: CAPABILITY_PRIOR_BINDING, policyRevision: LEGACY_EVALUATOR_ID };

const INDEX_RULE: NumericMetricRule = {
  kind: "numeric-metric",
  metric: "artificial_analysis_intelligence_index",
  source: AA_FREE_SOURCE,
  version: "v4.0",
  operator: "gte",
  value: 50,
  unit: "index-points",
  decisionBinding: "aa-free-v1/intelligence-index",
  onMissing: "legacy",
};

function withRule(rule: Partial<NumericMetricRule> | MetricRule, tierId = "T2"): TierPolicy {
  const full = "kind" in rule && rule.kind === "capability-predicate" ? rule : { ...INDEX_RULE, ...rule };
  return editTier(tierId, () => ({ entryRules: { all: [PREDICATE, full as MetricRule] } }));
}

const codes = (p: TierPolicy, previous?: TierPolicy) => validateTierPolicy(p, { previous }).map((i) => i.code);

describe("seed policy", () => {
  it("validates clean and compiles to the serving cuts and bars", () => {
    expect(validateTierPolicy(SEED)).toEqual([]);
    expect(LEGACY_TIER_POLICY.evaluator).toBe(LEGACY_EVALUATOR_ID);
    expect(LEGACY_TIER_POLICY.revision).toBe(1);
    expect(LEGACY_TIER_POLICY.scoreThresholds).toEqual({ T1: 0.85, T2: 0.8, T3: 0.75 });
    expect(LEGACY_TIER_POLICY.capabilityThresholds).toEqual({ T1: 0.8, T2: 0.8, T3: 0.75 });
    expect(LEGACY_TIER_POLICY.capability).toEqual({ priorK: 6, provenN: 8, vetoMargin: 0.1 });
    expect(LEGACY_TIER_POLICY.defaultTierId).toBe("T1");
  });

  it("is frozen", () => {
    expect(Object.isFrozen(LEGACY_TIER_POLICY)).toBe(true);
    expect(Object.isFrozen(LEGACY_TIER_POLICY.scoreThresholds)).toBe(true);
    expect(Object.isFrozen(LEGACY_TIER_POLICY.capabilityThresholds)).toBe(true);
    expect(Object.isFrozen(SEED.tiers)).toBe(true);
  });

  it("records that recorded-decision parity has no corpus to stand on", () => {
    expect(SEED.legacyCompatibility.baselineDecisionCorpusHash).toBeNull();
  });
});

describe("tier edits under the legacy evaluator", () => {
  it("accepts a rename (a name change only) and carries the name through", () => {
    const renamed = editTier("T1", () => ({ name: "Frontier" }));
    expect(codes(renamed)).toEqual([]);
    const compiled = compileTierPolicy(renamed);
    expect(compiled.tierNames.T1).toBe("Frontier");
    expect(compiled.scoreThresholds).toEqual(LEGACY_TIER_POLICY.scoreThresholds);
  });

  it("refuses an added tier", () => {
    const t0 = { ...(SEED.tiers[2] as TierDefinition), id: "T0", name: "T0", order: 3 };
    expect(codes(edit((p) => ({ tiers: [...p.tiers, t0] })))).toContain("legacy-tier-unknown");
  });

  it("refuses a deleted tier", () => {
    expect(codes(edit((p) => ({ tiers: p.tiers.filter((t) => t.id !== "T2") })))).toContain("legacy-tier-missing");
  });

  it("refuses a renamed id (an id is a reference, not a label)", () => {
    const c = codes(editTier("T3", () => ({ id: "Basic" })));
    expect(c).toEqual(expect.arrayContaining(["legacy-tier-missing", "legacy-tier-unknown"]));
  });

  it("refuses an inverted order", () => {
    const swapped = edit((p) => ({
      tiers: p.tiers.map((t) => (t.id === "T1" ? { ...t, order: 0 } : t.id === "T3" ? { ...t, order: 2 } : t)),
    }));
    expect(codes(swapped)).toContain("invalid-tier-order");
  });

  it("refuses duplicate ids and orders, non-integer order, and an empty name", () => {
    expect(codes(editTier("T2", () => ({ id: "T1" })))).toContain("duplicate-id");
    expect(codes(editTier("T2", () => ({ order: 0 })))).toContain("duplicate-order");
    expect(codes(editTier("T2", () => ({ order: 1.5 })))).toContain("invalid-order");
    expect(codes(editTier("T2", () => ({ name: "  " })))).toContain("invalid-name");
  });

  it("refuses overlapping cuts, including an exact tie", () => {
    expect(codes(editLegacy("T1", { scoreThreshold: 0.8 }))).toContain("overlapping-tiers");
    expect(codes(editLegacy("T2", { scoreThreshold: 0.7 }))).toContain("overlapping-tiers");
  });

  it("allows a capability tie (serving already ties T1 == T2 at 0.8) but refuses an inversion", () => {
    expect(LEGACY_TIER_POLICY.capabilityThresholds.T1).toBe(LEGACY_TIER_POLICY.capabilityThresholds.T2);
    expect(codes(editLegacy("T2", { capabilityThreshold: 0.75 }))).toEqual([]);
    expect(codes(editLegacy("T1", { capabilityThreshold: 0.79 }))).toContain("inverted-capability");
  });

  it("refuses non-finite and out-of-range thresholds", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -0.1, 1.01]) {
      expect(codes(editLegacy("T2", { scoreThreshold: bad }))).toContain("invalid-threshold");
      expect(codes(editLegacy("T2", { capabilityThreshold: bad }))).toContain("invalid-threshold");
    }
  });

  it("refuses a tier with no entry rules, or without the capability predicate", () => {
    expect(codes(editTier("T3", () => ({ entryRules: { all: [] } })))).toContain("no-entry-rules");
    expect(codes(editTier("T3", () => ({ entryRules: { all: [INDEX_RULE] } })))).toContain("missing-capability-predicate");
  });

  it("refuses unknown, duplicate or empty efforts", () => {
    expect(codes(editTier("T2", () => ({ allowedEfforts: [] })))).toContain("no-efforts");
    expect(codes(editTier("T2", () => ({ allowedEfforts: ["high", "high"] })))).toContain("duplicate-effort");
    expect(codes(editTier("T2", () => ({ allowedEfforts: ["turbo" as never] })))).toContain("unknown-effort");
  });

  it("refuses posterior evidence gates the legacy evaluator cannot run", () => {
    const required = editTier("T1", () => ({ evidence: { mode: "posterior-required", minIndependentTasks: 20, cohort: "model-effort-lane-harness-taskclass", maxAgeDays: 14 } }));
    expect(codes(required)).toContain("evidence-evaluator-mismatch");
    expect(codes(editTier("T1", (t) => ({ evidence: { ...t.evidence, minIndependentTasks: -1 } })))).toContain("invalid-sample-gate");
    expect(codes(editTier("T1", (t) => ({ evidence: { ...t.evidence, maxAgeDays: 0 } })))).toContain("invalid-ttl");
    expect(codes(editTier("T1", (t) => ({ evidence: { ...t.evidence, mode: "vibes" as never } })))).toContain("invalid-evidence-mode");
  });
});

describe("references", () => {
  it("refuses a default tier or task-class ref that does not exist", () => {
    expect(codes(edit(() => ({ defaultTierId: "T9" })))).toContain("unknown-tier-ref");
    expect(codes(edit(() => ({ taskClassTierRefs: { deploy: "T0" } })))).toContain("unknown-tier-ref");
    expect(codes(edit(() => ({ taskClassTierRefs: { deploy: "T2" } })))).toEqual([]);
  });
});

describe("entry rules", () => {
  it("accepts a versioned free-list index rule (it compiles to version-unknown)", () => {
    expect(codes(withRule({}))).toEqual([]);
  });

  it("refuses unversioned comparisons", () => {
    for (const version of ["", "latest", "unknown"]) expect(codes(withRule({ version }))).toContain("unversioned-metric");
  });

  it("refuses an unknown metric, a wrong source, a binding of the wrong kind and a wrong unit", () => {
    expect(codes(withRule({ decisionBinding: "aa-free-v1/vibes-index" }))).toContain("unknown-metric");
    expect(codes(withRule({ metric: "artificial_analysis_coding_index" }))).toContain("unknown-metric");
    expect(codes(withRule({ source: "example.com/leaderboard" }))).toContain("unknown-metric");
    expect(codes(withRule({ decisionBinding: CAPABILITY_PRIOR_BINDING }))).toContain("binding-kind-mismatch");
    expect(codes(withRule({ unit: "percent" }))).toContain("unsupported-unit");
  });

  it("refuses non-finite values, an inverted range and an unknown operator", () => {
    expect(codes(withRule({ value: Number.NaN }))).toContain("invalid-value");
    expect(codes(withRule({ operator: "between", value: 40 }))).toContain("invalid-value");
    expect(codes(withRule({ operator: "between", value: [60, 40] }))).toContain("invalid-value");
    expect(codes(withRule({ operator: "between", value: [40, 60] }))).toEqual([]);
    expect(codes(withRule({ operator: "gt" as never }))).toContain("unsupported-operator");
  });

  it("refuses a bad TTL and an unknown missing-data policy", () => {
    expect(codes(withRule({ maxAgeHours: 0 }))).toContain("invalid-ttl");
    expect(codes(withRule({ maxAgeHours: Number.POSITIVE_INFINITY }))).toContain("invalid-ttl");
    expect(codes(withRule({ maxAgeHours: 24 }))).toEqual([]);
    expect(codes(withRule({ onMissing: "zero" as never }))).toContain("invalid-on-missing");
  });

  it("accepts an unknown metric only as a declared, versioned optional-source rule", () => {
    const pro = { decisionBinding: "aa-pro/agentic-index", optionalSourceRule: { source: "aa-pro", metric: "agentic_index", version: "2026-09" } };
    expect(codes(withRule(pro))).toEqual([]);
    expect(codes(withRule({ ...pro, optionalSourceRule: { ...pro.optionalSourceRule, version: "latest" } }))).toContain("unversioned-metric");
    expect(codes(withRule({ ...pro, optionalSourceRule: { ...pro.optionalSourceRule, metric: "" } }))).toContain("optional-source-incomplete");
  });

  it("refuses a capability predicate bound to another evaluator or binding", () => {
    expect(codes(withRule({ ...PREDICATE, policyRevision: "evidence-v2" }))).toContain("predicate-evaluator-mismatch");
    expect(codes(withRule({ ...PREDICATE, decisionBinding: "other" as never }))).toContain("unknown-binding");
  });

  it("refuses an unknown rule kind", () => {
    const odd = editTier("T2", () => ({ entryRules: { all: [PREDICATE, { kind: "llm-judge" } as never] } }));
    expect(codes(odd)).toContain("unknown-rule-kind");
  });
});

describe("document-level checks", () => {
  it("refuses evidence-v2 (opt-in, not in this build) and unknown evaluators", () => {
    expect(codes(edit(() => ({ evaluator: EVIDENCE_V2_EVALUATOR_ID })))).toContain("evaluator-unavailable");
    expect(codes(edit(() => ({ evaluator: "magic" as never })))).toContain("unknown-evaluator");
  });

  it("refuses weighting optional rich data, another profile, schema or revision", () => {
    expect(codes(edit(() => ({ optionalRichDecisionWeight: 0.2 as never })))).toContain("optional-rich-weighted");
    expect(codes(edit(() => ({ decisionProfile: "aa-pro-v1" as never })))).toContain("unsupported-profile");
    expect(codes(edit(() => ({ schemaVersion: 1 as never })))).toContain("unsupported-schema");
    expect(codes(edit(() => ({ revision: 0 })))).toContain("invalid-revision");
    expect(codes(edit(() => ({ revision: 1.5 })))).toContain("invalid-revision");
    expect(codes(edit(() => ({ tiers: [] })))).toContain("no-tiers");
  });

  it("compile throws TierPolicyError carrying every issue", () => {
    const bad = edit(() => ({ revision: 0, defaultTierId: "T9" }));
    expect(() => compileTierPolicy(bad)).toThrow(TierPolicyError);
    try {
      compileTierPolicy(bad);
    } catch (error) {
      expect((error as TierPolicyError).issues.map((i) => i.code)).toEqual(expect.arrayContaining(["invalid-revision", "unknown-tier-ref"]));
    }
  });
});

describe("S-tier protection", () => {
  const sTiered = editTier("T1", () => ({ sTier: true, fallbackOnly: true }));

  it("a policy may mark a tier S-tier", () => {
    expect(codes(sTiered, SEED)).toEqual([]);
  });

  it("refuses dropping the flag, dropping fallbackOnly, lowering a bar or removing the tier", () => {
    const from = (change: (t: TierDefinition) => Partial<TierDefinition>) => ({
      ...sTiered,
      revision: sTiered.revision + 1,
      tiers: sTiered.tiers.map((t) => (t.id === "T1" ? { ...t, ...change(t) } : t)),
    });
    expect(codes(from(() => ({ sTier: false })), sTiered)).toContain("s-tier-weakened");
    expect(codes(from(() => ({ fallbackOnly: false })), sTiered)).toContain("s-tier-weakened");
    expect(codes(from((t) => ({ legacy: { ...t.legacy, capabilityThreshold: 0.79 } })), sTiered)).toContain("s-tier-weakened");
    expect(codes(from((t) => ({ legacy: { ...t.legacy, scoreThreshold: 0.84 } })), sTiered)).toContain("s-tier-weakened");
    const removed = { ...sTiered, tiers: sTiered.tiers.filter((t) => t.id !== "T1") };
    expect(codes(removed, sTiered)).toContain("s-tier-weakened");
  });

  it("allows raising an S-tier bar", () => {
    const raised = { ...sTiered, revision: 3, tiers: sTiered.tiers.map((t) => (t.id === "T1" ? { ...t, legacy: { ...t.legacy, scoreThreshold: 0.9, capabilityThreshold: 0.85 } } : t)) };
    expect(codes(raised, sTiered)).toEqual([]);
  });
});
