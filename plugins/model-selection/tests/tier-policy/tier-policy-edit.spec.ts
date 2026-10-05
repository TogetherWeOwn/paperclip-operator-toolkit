/**
 * P2: the `model_selection_tier_policy` edit path.
 * Every P1 guard must hold through the tool, plus the D4 request gates
 * (expectedRevision, reason, immutable id, referenced/default remove). This
 * build is proposal-only: no outcome is ever `accepted` and nothing persists.
 */
import { describe, expect, it } from "vitest";

import { AA_FREE_SOURCE } from "../../src/aa-free/parse.js";
import {
  ACTIVE_TIER_POLICY_SOURCE,
  MAX_REASON_LENGTH,
  diffTierPolicies,
  prepareTierPolicyEdit,
  renderTierPolicyEditResult,
  type TierPolicyEditResult,
} from "../../src/engine/tier-policy-edit.js";
import {
  CAPABILITY_PRIOR_BINDING,
  EVIDENCE_V2_EVALUATOR_ID,
  LEGACY_EVALUATOR_ID,
  LEGACY_MODEL_SELECTION_V1,
  type MetricRule,
  type TierDefinition,
  type TierPolicy,
} from "../../src/engine/tier-policy.js";

const SEED = LEGACY_MODEL_SELECTION_V1;
const ACTOR = { agentId: "agent-1", runId: "run-1" };
const REASON = " test";

const PREDICATE: MetricRule = { kind: "capability-predicate", decisionBinding: CAPABILITY_PRIOR_BINDING, policyRevision: LEGACY_EVALUATOR_ID };

/** A per-benchmark threshold the free list carries (compiles to version-unknown). */
const INDEX_RULE: MetricRule = {
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

/** Max cost per task and min context are optional-source rules under aa-free-v1. */
const COST_RULE: MetricRule = {
  kind: "numeric-metric",
  metric: "cost_per_task",
  source: "aa-pro",
  version: "2026-09",
  operator: "lte",
  value: 0.5,
  unit: "usd",
  decisionBinding: "aa-pro/cost-per-task",
  optionalSourceRule: { source: "aa-pro", metric: "cost_per_task", version: "2026-09" },
  onMissing: "legacy",
};
const CONTEXT_RULE: MetricRule = {
  ...COST_RULE,
  metric: "context_window",
  operator: "gte",
  value: 200_000,
  unit: "tokens",
  decisionBinding: "aa-pro/context-window",
  optionalSourceRule: { source: "aa-pro", metric: "context_window", version: "2026-09" },
};

function prepare(request: Record<string, unknown>, active: TierPolicy = SEED): TierPolicyEditResult {
  return prepareTierPolicyEdit(request, ACTOR, active);
}

function editRequest(tierId: string, patch: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { action: "edit", tierId, patch, expectedRevision: 1, reason: REASON, ...extra };
}

const codes = (result: TierPolicyEditResult) => result.issues.map((i) => i.code);

function tierOf(policy: TierPolicy | null, id: string): TierDefinition {
  const tier = policy?.tiers.find((t) => t.id === id);
  if (!tier) throw new Error(`no tier ${id}`);
  return tier;
}

/** A policy where T1 is an S-tier and fallbackOnly — the shape astra/opus-5-5/fable sit in. */
function sTierPolicy(): TierPolicy {
  return {
    ...SEED,
    tiers: SEED.tiers.map((t) => (t.id === "T1" ? { ...t, sTier: true, fallbackOnly: true } : t)),
  };
}

function expectProposalOnly(result: TierPolicyEditResult): void {
  expect(result.issues).toEqual([]);
  expect(result).toMatchObject({ ok: true, outcome: "proposalOnly", persisted: false });
  expect(result.error).toBeUndefined();
  expect(result.impact.appliedToServing).toBe(false);
}

function expectRejected(result: TierPolicyEditResult, code: string): void {
  expect(result.ok).toBe(false);
  expect(result.outcome).toBe("rejected");
  expect(result.persisted).toBe(false);
  expect(codes(result)).toContain(code);
  expect(result.error).toBe(result.issues[0]?.code);
}

describe("edit", () => {
  it("renames a tier as a proposal, and a rename back round-trips to the seed tiers", () => {
    const renamed = prepare(editRequest("T1", { name: "Frontier" }));
    expectProposalOnly(renamed);
    expect(renamed.baseSource).toBe(ACTIVE_TIER_POLICY_SOURCE);
    expect(renamed).toMatchObject({ action: "edit", baseRevision: 1, proposedRevision: 2, dryRun: true });
    expect(tierOf(renamed.proposedPolicy, "T1").name).toBe("Frontier");
    expect(renamed.diff).toEqual([
      { path: "revision", change: "changed", before: 1, after: 2 },
      { path: "tiers.T1.name", change: "changed", before: "T1", after: "Frontier" },
    ]);
    expect(renamed.impact.after?.tierNames.T1).toBe("Frontier");
    expect(renamed.impact.wouldChangeServing).toBe(false);

    const back = prepare({ ...editRequest("T1", { name: "T1" }), expectedRevision: 2, basePolicy: renamed.proposedPolicy });
    expectProposalOnly(back);
    expect(back.baseSource).toBe("supplied");
    expect(back.proposedRevision).toBe(3);
    expect(back.proposedPolicy?.tiers).toEqual(SEED.tiers);
  });

  it("edits entry rules: per-benchmark threshold, max cost per task and min context", () => {
    const result = prepare(editRequest("T2", { entryRules: { all: [PREDICATE, INDEX_RULE, COST_RULE, CONTEXT_RULE] } }));
    expectProposalOnly(result);
    expect(tierOf(result.proposedPolicy, "T2").entryRules.all).toHaveLength(4);
    // None of them becomes a live cut: the capability predicate stays the only enforced rule.
    expect(result.impact.after?.enforcedRules).toBe(result.impact.before?.enforcedRules);
    expect((result.impact.after?.notEnforcedRules ?? 0) - (result.impact.before?.notEnforcedRules ?? 0)).toBe(3);
    expect(result.impact.wouldChangeServing).toBe(false);
  });

  it("edits allowed efforts, and merges a partial legacy patch", () => {
    expectProposalOnly(prepare(editRequest("T2", { allowedEfforts: ["low", "medium"] })));
    const raised = prepare(editRequest("T1", { legacy: { scoreThreshold: 0.9 } }));
    expectProposalOnly(raised);
    expect(tierOf(raised.proposedPolicy, "T1").legacy).toEqual({ ...tierOf(SEED, "T1").legacy, scoreThreshold: 0.9 });
    expect(raised.impact.wouldChangeServing).toBe(true);
    expect(raised.impact.after?.scoreThresholds.T1).toBe(0.9);
    expect(raised.diff.map((d) => d.path)).toEqual(["revision", "tiers.T1.legacy.scoreThreshold"]);
  });

  it("refuses a reorder", () => {
    expectRejected(prepare(editRequest("T1", { order: 0 })), "duplicate-order");
    expectRejected(prepare(editRequest("T1", { order: -1 })), "invalid-tier-order");
  });

  it("refuses overlapping and equal cuts", () => {
    expectRejected(prepare(editRequest("T1", { legacy: { scoreThreshold: 0.8 } })), "overlapping-tiers");
    expectRejected(prepare(editRequest("T2", { legacy: { scoreThreshold: 0.7 } })), "overlapping-tiers");
  });

  it("refuses an inverted capability bar", () => {
    expectRejected(prepare(editRequest("T1", { legacy: { capabilityThreshold: 0.79 } })), "inverted-capability");
  });

  it("refuses an unversioned rule", () => {
    for (const version of ["", "latest", "unknown"]) {
      expectRejected(prepare(editRequest("T2", { entryRules: { all: [PREDICATE, { ...INDEX_RULE, version }] } })), "unversioned-metric");
    }
  });

  it("refuses a rule set without the capability predicate", () => {
    expectRejected(prepare(editRequest("T2", { entryRules: { all: [INDEX_RULE] } })), "missing-capability-predicate");
  });

  it("refuses posterior evidence requirements the legacy evaluator cannot run", () => {
    const evidence = { mode: "posterior-required", minIndependentTasks: 20, cohort: "model-effort-lane-harness-taskclass", maxAgeDays: 14 };
    expectRejected(prepare(editRequest("T1", { evidence })), "evidence-evaluator-mismatch");
  });

  it("refuses a changed id and fields outside the editable set", () => {
    expectRejected(prepare(editRequest("T1", { id: "T0" })), "immutable-id");
    expectRejected(prepare(editRequest("T1", { colour: "red" })), "unknown-patch-key");
    expectRejected(prepare(editRequest("T1", {})), "invalid-patch");
    expectRejected(prepare(editRequest("T9", { name: "x" })), "unknown-tier");
    expectRejected(prepare(editRequest("", { name: "x" })), "invalid-tier-id");
  });
});

describe("add and remove", () => {
  const T0 = { ...(SEED.tiers[0] as TierDefinition), id: "T0", name: "Floor", order: -1 };

  it("refuses an added tier under the legacy evaluator but returns the proposal", () => {
    const added = prepare({ action: "add", tier: T0, expectedRevision: 1, reason: REASON });
    expectRejected(added, "legacy-tier-unknown");
    expect(added.proposedPolicy?.tiers.map((t) => t.id)).toEqual(["T3", "T2", "T1", "T0"]);
    expect(added.diff.map((d) => `${d.path}:${d.change}`)).toEqual(["revision:changed", "tiers.T0:added"]);
    expect(added.impact.after).toBeNull();
  });

  it("refuses a removed tier under the legacy evaluator", () => {
    const removed = prepare({ action: "remove", tierId: "T2", expectedRevision: 1, reason: REASON });
    expectRejected(removed, "legacy-tier-missing");
    expect(removed.diff.map((d) => `${d.path}:${d.change}`)).toEqual(["revision:changed", "tiers.T2:removed"]);
  });

  it("round-trips add then remove back to the seed tiers", () => {
    const added = prepare({ action: "add", tier: T0, expectedRevision: 1, reason: REASON });
    const removed = prepare({ action: "remove", tierId: "T0", expectedRevision: 2, reason: REASON, basePolicy: added.proposedPolicy });
    expectProposalOnly(removed);
    expect(removed.proposedRevision).toBe(3);
    expect(removed.proposedPolicy?.tiers).toEqual(SEED.tiers);
  });

  it("refuses removing the default tier and a tier a task class references", () => {
    expectRejected(prepare({ action: "remove", tierId: "T1", expectedRevision: 1, reason: REASON }), "tier-is-default");
    const referenced = { ...SEED, taskClassTierRefs: { deploy: "T3", review: "T3" } };
    const result = prepare({ action: "remove", tierId: "T3", expectedRevision: 1, reason: REASON, basePolicy: referenced });
    expectRejected(result, "tier-referenced");
    expect(result.issues.find((i) => i.code === "tier-referenced")?.message).toContain("deploy, review");
    expectRejected(prepare({ action: "remove", tierId: "T9", expectedRevision: 1, reason: REASON }), "unknown-tier");
  });

  it("refuses an add without a tier object", () => {
    expectRejected(prepare({ action: "add", expectedRevision: 1, reason: REASON }), "invalid-tier");
    expectRejected(prepare({ action: "add", tier: [T0], expectedRevision: 1, reason: REASON }), "invalid-tier");
  });
});

describe("S-tier protection", () => {
  const active = sTierPolicy();

  it("refuses dropping the S-tier or fallbackOnly flag, removing it, or lowering its bar", () => {
    expectRejected(prepare(editRequest("T1", { sTier: false }), active), "s-tier-weakened");
    expectRejected(prepare(editRequest("T1", { fallbackOnly: false }), active), "s-tier-weakened");
    expectRejected(prepare(editRequest("T1", { legacy: { scoreThreshold: 0.84 } }), active), "s-tier-weakened");
    expectRejected(prepare(editRequest("T1", { legacy: { capabilityThreshold: 0.79 } }), active), "s-tier-weakened");
  });

  it("accepts raising an S-tier bar and renaming it", () => {
    expectProposalOnly(prepare(editRequest("T1", { legacy: { scoreThreshold: 0.9 } }), active));
    expectProposalOnly(prepare(editRequest("T1", { name: "S" }), active));
  });

  it("refuses laundering a relaxation through a supplied base that already cleared the flag", () => {
    const laundered = { ...active, tiers: active.tiers.map((t) => (t.id === "T1" ? { ...t, fallbackOnly: false } : t)) };
    const result = prepare({ ...editRequest("T1", { name: "S" }), basePolicy: laundered }, active);
    expectRejected(result, "s-tier-weakened");
    expect(result.issues.filter((i) => i.code === "s-tier-weakened")).toHaveLength(1);
  });

  it("does not double-report a weakening seen against both the base and the active policy", () => {
    const result = prepare({ ...editRequest("T1", { sTier: false }), basePolicy: active }, active);
    expect(result.issues.filter((i) => i.code === "s-tier-weakened")).toHaveLength(1);
  });
});

describe("request gates", () => {
  it("refuses a stale or missing expectedRevision on every mutating action", () => {
    for (const action of ["add", "edit", "remove"]) {
      const missing = prepare({ action, tierId: "T1", patch: { name: "x" }, reason: REASON });
      expectRejected(missing, "missing-expected-revision");
      expect(missing.proposedPolicy).toBeNull();
      const stale = prepare({ action, tierId: "T1", patch: { name: "x" }, reason: REASON, expectedRevision: 2 });
      expectRejected(stale, "revision-conflict");
      expect(stale.proposedPolicy).toBeNull();
    }
    expectRejected(prepare(editRequest("T1", { name: "x" }, { expectedRevision: "1" })), "revision-conflict");
  });

  it("checks expectedRevision on validate and diff too, when supplied", () => {
    expectRejected(prepare({ action: "validate", expectedRevision: 7 }), "revision-conflict");
  });

  it("refuses a mutating action without a usable reason", () => {
    expectRejected(prepare(editRequest("T1", { name: "x" }, { reason: undefined })), "missing-reason");
    expectRejected(prepare(editRequest("T1", { name: "x" }, { reason: "   " })), "missing-reason");
    expectRejected(prepare(editRequest("T1", { name: "x" }, { reason: "x".repeat(MAX_REASON_LENGTH + 1) })), "invalid-reason");
  });

  it("refuses an unknown action", () => {
    for (const action of [undefined, "", "accept", "delete", 3]) {
      const result = prepare({ action, expectedRevision: 1, reason: REASON });
      expectRejected(result, "invalid-action");
      expect(result.action).toBeNull();
    }
  });

  it("refuses a malformed or unversioned base", () => {
    expectRejected(prepare({ action: "validate", basePolicy: "seed" }), "malformed-policy");
    expectRejected(prepare({ action: "validate", basePolicy: { ...SEED, tiers: {} } }), "malformed-policy");
    expectRejected(prepare({ action: "validate", basePolicy: { ...SEED, revision: 0 } }), "invalid-revision");
  });
});

describe("validate and diff", () => {
  it("validate with no candidate checks the base", () => {
    expectProposalOnly(prepare({ action: "validate" }));
    const bad = prepare({ action: "validate", basePolicy: { ...SEED, evaluator: EVIDENCE_V2_EVALUATOR_ID } });
    expectRejected(bad, "evaluator-unavailable");
  });

  it("refuses an evidence-v2 candidate as evaluator-unavailable", () => {
    const candidate = { ...SEED, revision: 2, evaluator: EVIDENCE_V2_EVALUATOR_ID };
    expectRejected(prepare({ action: "validate", policy: candidate }), "evaluator-unavailable");
  });

  it("refuses a whole-policy candidate that is not the next revision", () => {
    expectRejected(prepare({ action: "validate", policy: { ...SEED } }), "revision-not-next");
    expectRejected(prepare({ action: "diff", policy: { ...SEED, revision: 5 } }), "revision-not-next");
  });

  it("diffs a candidate by tier id, without needing a reason", () => {
    const candidate = {
      ...SEED,
      revision: 2,
      tiers: SEED.tiers.map((t) => (t.id === "T2" ? { ...t, name: "Mid", allowedEfforts: ["high"] } : t)),
    };
    const result = prepare({ action: "diff", policy: candidate });
    expectProposalOnly(result);
    expect(result.diff.map((d) => d.path)).toEqual(["revision", "tiers.T2.allowedEfforts", "tiers.T2.name"]);
    expectRejected(prepare({ action: "diff" }), "missing-policy");
  });

  it("validate applies the S-tier check to a whole-policy candidate", () => {
    const active = sTierPolicy();
    const candidate = { ...active, revision: 2, tiers: active.tiers.map((t) => (t.id === "T1" ? { ...t, sTier: false } : t)) };
    expectRejected(prepare({ action: "validate", policy: candidate }, active), "s-tier-weakened");
  });

  it("refuses a candidate whose containers would make the validator throw", () => {
    const candidates = [
      "policy",
      { ...SEED, revision: 2, tiers: "T1" },
      { ...SEED, revision: 2, tiers: [null] },
      { ...SEED, revision: 2, tiers: SEED.tiers.map((t) => ({ ...t, entryRules: { all: [null] } })) },
      { ...SEED, revision: 2, tiers: SEED.tiers.map((t) => ({ ...t, legacy: null })) },
      { ...SEED, revision: 2, tiers: SEED.tiers.map((t) => ({ ...t, evidence: "legacy" })) },
      { ...SEED, revision: 2, tiers: SEED.tiers.map((t) => ({ ...t, allowedEfforts: "high" })) },
      { ...SEED, revision: 2, taskClassTierRefs: [] },
    ];
    for (const policy of candidates) {
      expectRejected(prepare({ action: "validate", policy }), "malformed-policy");
    }
  });

  it("refuses a malformed edit value instead of throwing", () => {
    expectRejected(prepare(editRequest("T1", { legacy: null })), "malformed-policy");
    expectRejected(prepare(editRequest("T1", { entryRules: [PREDICATE] })), "malformed-policy");
  });
});

describe("result contract", () => {
  it("never reports accepted and never persists, on any path", () => {
    const requests: Record<string, unknown>[] = [
      {},
      { action: "validate" },
      editRequest("T1", { name: "Frontier" }, { dryRun: false }),
      editRequest("T1", { order: 0 }),
      { action: "remove", tierId: "T1", expectedRevision: 1, reason: REASON },
      { action: "diff", policy: { ...SEED, revision: 2 } },
    ];
    for (const request of requests) {
      const result = prepare(request);
      expect(["proposalOnly", "rejected"]).toContain(result.outcome);
      expect(result.persisted).toBe(false);
      expect(result.impact.appliedToServing).toBe(false);
      expect(result.note).toMatch(/^proposalOnly: nothing was written/);
    }
  });

  it("echoes dryRun but still writes nothing when it is false", () => {
    const live = prepare(editRequest("T1", { name: "Frontier" }, { dryRun: false }));
    expectProposalOnly(live);
    expect(live.dryRun).toBe(false);
  });

  it("never mutates the active policy or the caller's inputs", () => {
    const before = JSON.stringify(SEED);
    const patch = { legacy: { scoreThreshold: 0.9 } };
    const base = JSON.parse(JSON.stringify(SEED)) as TierPolicy;
    const baseBefore = JSON.stringify(base);
    const result = prepare({ ...editRequest("T1", patch), basePolicy: base });
    expectProposalOnly(result);
    expect(JSON.stringify(SEED)).toBe(before);
    expect(JSON.stringify(base)).toBe(baseBefore);
    expect(patch).toEqual({ legacy: { scoreThreshold: 0.9 } });
  });

  it("derives a stable audit id from action, base, proposal, reason and actor", () => {
    const request = editRequest("T1", { name: "Frontier" });
    const a = prepare(request).auditId;
    expect(a).toMatch(/^tpa_[0-9a-f]{24}$/);
    expect(prepare(request).auditId).toBe(a);
    expect(prepare({ ...request, reason: "other" }).auditId).not.toBe(a);
    expect(prepare({ ...request, patch: { name: "Other" } }).auditId).not.toBe(a);
    expect(prepareTierPolicyEdit(request, { agentId: "agent-2", runId: "run-1" }).auditId).not.toBe(a);
  });

  it("renders a readable summary naming the outcome, issues and changed paths", () => {
    const ok = renderTierPolicyEditResult(prepare(editRequest("T1", { name: "Frontier" })));
    expect(ok).toContain("edit: proposalOnly");
    expect(ok).toContain("tiers.T1.name");
    expect(ok).toContain("would not change any tier cut");
    const bad = renderTierPolicyEditResult(prepare(editRequest("T1", { order: 0 })));
    expect(bad).toContain("edit: rejected");
    expect(bad).toContain("duplicate-order");
  });

  it("never throws on hostile input", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const inputs: Record<string, unknown>[] = [
      { action: "edit", tierId: "T1", patch: cyclic, expectedRevision: 1, reason: REASON },
      { action: "add", tier: cyclic, expectedRevision: 1, reason: REASON },
      { action: "validate", policy: cyclic },
      { action: "validate", basePolicy: cyclic },
      { action: "edit", tierId: ["T1"], patch: "name", expectedRevision: {}, reason: 7 },
      { action: "validate", policy: { tiers: [{}] } },
      { action: "edit", tierId: "T1", patch: { name: 42, order: "high", allowedEfforts: ["turbo"] }, expectedRevision: 1, reason: REASON },
    ];
    for (const request of inputs) {
      const result = prepare(request);
      expect(result.ok, JSON.stringify(Object.keys(request))).toBe(false);
      expect(typeof renderTierPolicyEditResult(result)).toBe("string");
    }
  });
});

describe("diffTierPolicies", () => {
  it("reports nothing for identical documents and keys tiers by id", () => {
    expect(diffTierPolicies(SEED, JSON.parse(JSON.stringify(SEED)))).toEqual([]);
    const reordered = { ...SEED, tiers: [...SEED.tiers].reverse() };
    expect(diffTierPolicies(SEED, reordered)).toEqual([]);
  });
});
