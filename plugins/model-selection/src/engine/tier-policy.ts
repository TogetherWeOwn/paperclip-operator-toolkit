/**
 * Tiers as data.
 *
 * Before this module the tier ladder was three hard-coded lookups: the tier CUT
 * (`SCORE_THRESHOLDS` in `tierForPosterior`/`deriveModelTier`/`tierImpliedByIndex`)
 * and the per-tier CAPABILITY gate (`summarize` and `buildModelScore`'s no-stats
 * branch). The two were the same table in source, but the serving build split
 * them: the operator's 2026-10-01 `t1cap080` carry-forward lowered the T1
 * capability bar to 0.8 and left the T1 cut at 0.85. Source never caught up.
 *
 * This module holds both tables as one versioned policy document. The only
 * evaluator is `legacy-model-selection-v1`, which is the pre-existing math with
 * its constants read from the policy instead of inlined. It is pinned to the
 * serving build, not to the source it replaces. `tests/tier-policy/` replays the
 * frozen serving evaluator against this one and requires zero diffs.
 *
 * What the legacy evaluator does NOT do, on purpose:
 *  - It never turns an entry rule into a raw aa.ai index cut or an invocation
 *    cut. The free list publishes no index version (`sourceVersion: "unknown"`),
 *    so a numeric rule over it cannot be compared across versions. Such a rule
 *    validates, compiles to the existing capability predicate, and reports
 *    `not-enforced-version-unknown`.
 *  - It never reads a paid/optional source. A rule that names one compiles to the
 *    same capability predicate and reports `not-enforced-in-aa-free-v1`, so a
 *    decision is identical whether optional data is absent, null, stale or
 *    conflicting.
 *  - It never changes the prior weight (6), the proven count (8), the veto
 *    margin (0.1) or the prior curve. Those are evaluator constants, not data.
 *
 * Model-level `fallbackOnly` (the S-tier rows) lives on the roster and is not
 * touched here. The per-tier `sTier`/`fallbackOnly` flags only protect a tier
 * from being weakened by a later edit.
 */
import { AA_FREE_PROFILE, AA_FREE_SOURCE } from "../aa-free/parse.js";
import type { AaEffort } from "../aa-free/registry.js";
import { SCORE_PRIOR_K, SCORE_PROVEN_N, SCORE_THRESHOLDS, TIER_ORDER, type Tier } from "../constants.js";

export const TIER_POLICY_SCHEMA_VERSION = 2 as const;
export const LEGACY_EVALUATOR_ID = "legacy-model-selection-v1" as const;
export const EVIDENCE_V2_EVALUATOR_ID = "evidence-v2" as const;
export type TierEvaluatorId = typeof LEGACY_EVALUATOR_ID | typeof EVIDENCE_V2_EVALUATOR_ID;

/** The capability predicate every legacy tier is entered through. */
export const CAPABILITY_PRIOR_BINDING = "existing-capability-prior-v1" as const;

/**
 * Fixed parameters of the legacy evaluator. They are NOT policy data: a policy
 * cannot change them, because the zero-diff baseline only holds while they stay
 * exactly what serving runs.
 */
export const LEGACY_CAPABILITY_PARAMS = Object.freeze({
  /** Pseudo-observations contributed by the prior (posterior weight). */
  priorK: SCORE_PRIOR_K,
  /** Judged runs before a (model, tier) verdict is "proven". */
  provenN: SCORE_PROVEN_N,
  /** A proven model is vetoed when its observed rate is this far under the bar. */
  vetoMargin: 0.1,
});

export const ALL_AA_EFFORTS: readonly AaEffort[] = [
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "default", "unknown",
];

export type MetricOperator = "gte" | "lte" | "between";

/** A rule on one published metric. Null observations mean "missing", never 0. */
export interface NumericMetricRule {
  kind: "numeric-metric";
  metric: string;
  source: string;
  /** Pinned metric version. Unversioned (`""`, `"latest"`, `"unknown"`) is refused. */
  version: string;
  operator: MetricOperator;
  /** A number for `gte`/`lte`; `[lo, hi]` for `between`. */
  value: number | readonly [number, number];
  unit: string;
  maxAgeHours?: number;
  decisionBinding: string;
  /** Names a richer (paid) source the rule really wants; never read under aa-free-v1. */
  optionalSourceRule?: OptionalSourceRule;
  onMissing: "reject" | "legacy";
}

/** Entry through the existing capability posterior (`summarize`'s `capable`). */
export interface CapabilityPredicateRule {
  kind: "capability-predicate";
  decisionBinding: typeof CAPABILITY_PRIOR_BINDING;
  /** Evaluator the predicate belongs to; must be the policy's evaluator. */
  policyRevision: string;
  optionalSourceRule?: OptionalSourceRule;
}

export interface OptionalSourceRule {
  source: string;
  metric: string;
  version: string;
}

export type MetricRule = NumericMetricRule | CapabilityPredicateRule;

export interface TierEvidencePolicy {
  mode: "legacy" | "prior-only" | "posterior-required";
  minIndependentTasks: number;
  cohort: "legacy-model-id" | "model-effort-lane-harness-taskclass";
  maxAgeDays?: number;
}

export interface TierDefinition {
  id: string;
  /** Display name. Renaming a tier is a change to this field only. */
  name: string;
  /** Ascending capability, like `TIER_ORDER`: the lowest tier has the lowest order. */
  order: number;
  entryRules: { all: readonly MetricRule[] };
  allowedEfforts: readonly AaEffort[];
  evidence: TierEvidencePolicy;
  fallbackOnly: boolean;
  sTier: boolean;
  legacy: {
    /** Tier CUT on the overall posterior (`tierForPosterior`). */
    scoreThreshold: number;
    /** Per-tier CAPABILITY gate (`summarize`, `buildModelScore`). */
    capabilityThreshold: number;
    sourceRevision: string;
  };
}

export interface TierPolicy {
  schemaVersion: typeof TIER_POLICY_SCHEMA_VERSION;
  revision: number;
  evaluator: TierEvaluatorId;
  decisionProfile: typeof AA_FREE_PROFILE;
  optionalRichDecisionWeight: 0;
  tiers: readonly TierDefinition[];
  defaultTierId: string;
  taskClassTierRefs: Readonly<Record<string, string>>;
  legacyCompatibility: {
    sourceRevision: string;
    servingBuild: string;
    servingWorkerSha256: string;
    rosterSnapshotHash: string | null;
    /** Null: the recorded decision stream does not carry evaluator inputs. */
    baselineDecisionCorpusHash: string | null;
  };
}

/** A metric the aa-free-v1 profile can bind a rule to. */
export interface DecisionBinding {
  id: string;
  kind: "numeric-metric" | "capability-predicate";
  metric: string | null;
  source: string | null;
  /** The version the source publishes; `"unknown"` means no cross-version comparison is possible. */
  publishedVersion: string | null;
  unit: string | null;
}

export const DECISION_BINDINGS: Readonly<Record<string, DecisionBinding>> = Object.freeze({
  "aa-free-v1/intelligence-index": {
    id: "aa-free-v1/intelligence-index",
    kind: "numeric-metric",
    metric: "artificial_analysis_intelligence_index",
    source: AA_FREE_SOURCE,
    publishedVersion: "unknown",
    unit: "index-points",
  },
  [CAPABILITY_PRIOR_BINDING]: {
    id: CAPABILITY_PRIOR_BINDING,
    kind: "capability-predicate",
    metric: null,
    source: null,
    publishedVersion: null,
    unit: null,
  },
});

const UNVERSIONED = new Set(["", "latest", "unknown"]);
const KNOWN_EFFORTS: ReadonlySet<string> = new Set(ALL_AA_EFFORTS);
const LEGACY_TIER_IDS: readonly Tier[] = TIER_ORDER;

export interface TierPolicyIssue {
  path: string;
  code: string;
  message: string;
}

export interface ValidateOptions {
  /** The policy being replaced, for edit-time checks (S-tier protection). */
  previous?: TierPolicy;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function inUnitInterval(v: unknown): v is number {
  return isFiniteNumber(v) && v > 0 && v <= 1;
}

function validateRule(rule: MetricRule, path: string, evaluator: TierEvaluatorId, issues: TierPolicyIssue[]): void {
  const push = (code: string, message: string, at = path) => issues.push({ path: at, code, message });
  if (rule.optionalSourceRule) {
    const o = rule.optionalSourceRule;
    if (!o.source || !o.metric) push("optional-source-incomplete", "optionalSourceRule needs a source and a metric");
    if (typeof o.version !== "string" || UNVERSIONED.has(o.version)) {
      push("unversioned-metric", "optionalSourceRule must pin a metric version", `${path}.optionalSourceRule.version`);
    }
  }
  if (rule.kind === "capability-predicate") {
    if (rule.decisionBinding !== CAPABILITY_PRIOR_BINDING) {
      push("unknown-binding", `capability predicate must bind ${CAPABILITY_PRIOR_BINDING}`);
    }
    if (rule.policyRevision !== evaluator) {
      push("predicate-evaluator-mismatch", `capability predicate names ${rule.policyRevision}, policy runs ${evaluator}`);
    }
    return;
  }
  if (rule.kind !== "numeric-metric") {
    push("unknown-rule-kind", `unknown rule kind ${String((rule as { kind?: unknown }).kind)}`);
    return;
  }
  if (typeof rule.version !== "string" || UNVERSIONED.has(rule.version)) {
    push("unversioned-metric", "a numeric rule must pin a metric version (no unversioned comparisons)", `${path}.version`);
  }
  if (rule.operator === "between") {
    const v = rule.value;
    if (!Array.isArray(v) || v.length !== 2 || !v.every(isFiniteNumber) || (v[0] as number) > (v[1] as number)) {
      push("invalid-value", "between needs a finite [lo, hi] with lo <= hi", `${path}.value`);
    }
  } else if (rule.operator === "gte" || rule.operator === "lte") {
    if (!isFiniteNumber(rule.value)) push("invalid-value", "value must be a finite number", `${path}.value`);
  } else {
    push("unsupported-operator", `unsupported operator ${String(rule.operator)}`, `${path}.operator`);
  }
  if (rule.maxAgeHours !== undefined && !(isFiniteNumber(rule.maxAgeHours) && rule.maxAgeHours > 0)) {
    push("invalid-ttl", "maxAgeHours must be a positive finite number", `${path}.maxAgeHours`);
  }
  if (rule.onMissing !== "reject" && rule.onMissing !== "legacy") {
    push("invalid-on-missing", "onMissing must be reject or legacy", `${path}.onMissing`);
  }
  const binding = DECISION_BINDINGS[rule.decisionBinding];
  if (!binding) {
    // A rule on a metric the free profile does not publish is only acceptable as
    // a declared optional-source rule; it then compiles to the capability fallback.
    if (!rule.optionalSourceRule) push("unknown-metric", `no decision binding ${rule.decisionBinding} in ${AA_FREE_PROFILE}`);
    return;
  }
  if (binding.kind !== "numeric-metric") {
    push("binding-kind-mismatch", `${binding.id} is not a numeric metric`);
    return;
  }
  if (rule.metric !== binding.metric || rule.source !== binding.source) {
    push("unknown-metric", `${rule.source}/${rule.metric} is not what ${binding.id} binds`);
  }
  if (rule.unit !== binding.unit) push("unsupported-unit", `${binding.id} is measured in ${binding.unit}`, `${path}.unit`);
  // The legacy evaluator enforces nothing but the capability predicate. Today
  // every numeric binding is unversioned, so its rules report version-unknown.
  // A versioned binding would need an evaluator that can actually enforce it.
  if (evaluator === LEGACY_EVALUATOR_ID && !UNVERSIONED.has(binding.publishedVersion ?? "")) {
    push("legacy-numeric-unsupported", `${LEGACY_EVALUATOR_ID} cannot enforce ${binding.id}`);
  }
}

/**
 * Structural and semantic validation. Returns every issue, never throws.
 * `compileTierPolicy` refuses a policy with any issue.
 */
export function validateTierPolicy(policy: TierPolicy, options: ValidateOptions = {}): TierPolicyIssue[] {
  const issues: TierPolicyIssue[] = [];
  const push = (path: string, code: string, message: string) => issues.push({ path, code, message });

  if (policy.schemaVersion !== TIER_POLICY_SCHEMA_VERSION) push("schemaVersion", "unsupported-schema", `schemaVersion must be ${TIER_POLICY_SCHEMA_VERSION}`);
  if (!Number.isInteger(policy.revision) || policy.revision < 1) push("revision", "invalid-revision", "revision must be a positive integer");
  if (policy.decisionProfile !== AA_FREE_PROFILE) push("decisionProfile", "unsupported-profile", `decisionProfile must be ${AA_FREE_PROFILE}`);
  if (policy.optionalRichDecisionWeight !== 0) push("optionalRichDecisionWeight", "optional-rich-weighted", "optional rich data has zero decision weight");
  if (policy.evaluator === EVIDENCE_V2_EVALUATOR_ID) {
    push("evaluator", "evaluator-unavailable", "evidence-v2 is opt-in and not available in this build");
  } else if (policy.evaluator !== LEGACY_EVALUATOR_ID) {
    push("evaluator", "unknown-evaluator", `unknown evaluator ${String(policy.evaluator)}`);
  }

  const tiers = Array.isArray(policy.tiers) ? policy.tiers : [];
  if (tiers.length === 0) push("tiers", "no-tiers", "a policy needs at least one tier");
  const ids = new Set<string>();
  const orders = new Set<number>();
  tiers.forEach((tier, i) => {
    const at = `tiers[${i}]`;
    if (typeof tier.id !== "string" || tier.id.length === 0) push(`${at}.id`, "invalid-id", "tier id must be a non-empty string");
    if (ids.has(tier.id)) push(`${at}.id`, "duplicate-id", `duplicate tier id ${tier.id}`);
    ids.add(tier.id);
    if (typeof tier.name !== "string" || tier.name.trim().length === 0) push(`${at}.name`, "invalid-name", "tier name must be non-empty");
    if (!Number.isInteger(tier.order)) push(`${at}.order`, "invalid-order", "order must be an integer");
    if (orders.has(tier.order)) push(`${at}.order`, "duplicate-order", `duplicate order ${tier.order}`);
    orders.add(tier.order);

    const rules: readonly MetricRule[] = tier.entryRules?.all ?? [];
    if (rules.length === 0) push(`${at}.entryRules`, "no-entry-rules", "a tier needs at least one entry rule");
    rules.forEach((rule, r) => validateRule(rule, `${at}.entryRules.all[${r}]`, policy.evaluator, issues));
    if (policy.evaluator === LEGACY_EVALUATOR_ID && !rules.some((r) => r.kind === "capability-predicate")) {
      push(`${at}.entryRules`, "missing-capability-predicate", `${LEGACY_EVALUATOR_ID} admits only through ${CAPABILITY_PRIOR_BINDING}`);
    }

    const efforts: readonly AaEffort[] = tier.allowedEfforts ?? [];
    if (efforts.length === 0) push(`${at}.allowedEfforts`, "no-efforts", "allowedEfforts must not be empty");
    if (new Set(efforts).size !== efforts.length) push(`${at}.allowedEfforts`, "duplicate-effort", "allowedEfforts has duplicates");
    for (const e of efforts) if (!KNOWN_EFFORTS.has(e)) push(`${at}.allowedEfforts`, "unknown-effort", `unknown effort ${String(e)}`);

    const ev = tier.evidence;
    if (!ev || !["legacy", "prior-only", "posterior-required"].includes(ev.mode)) {
      push(`${at}.evidence.mode`, "invalid-evidence-mode", "unknown evidence mode");
    } else {
      if (!Number.isInteger(ev.minIndependentTasks) || ev.minIndependentTasks < 0) {
        push(`${at}.evidence.minIndependentTasks`, "invalid-sample-gate", "minIndependentTasks must be a non-negative integer");
      }
      if (ev.maxAgeDays !== undefined && !(isFiniteNumber(ev.maxAgeDays) && ev.maxAgeDays > 0)) {
        push(`${at}.evidence.maxAgeDays`, "invalid-ttl", "maxAgeDays must be a positive finite number");
      }
      if (policy.evaluator === LEGACY_EVALUATOR_ID && (ev.mode !== "legacy" || ev.cohort !== "legacy-model-id")) {
        push(`${at}.evidence`, "evidence-evaluator-mismatch", `${LEGACY_EVALUATOR_ID} uses legacy evidence on the legacy-model-id cohort`);
      }
    }

    if (!inUnitInterval(tier.legacy?.scoreThreshold)) push(`${at}.legacy.scoreThreshold`, "invalid-threshold", "scoreThreshold must be finite in (0, 1]");
    if (!inUnitInterval(tier.legacy?.capabilityThreshold)) {
      push(`${at}.legacy.capabilityThreshold`, "invalid-threshold", "capabilityThreshold must be finite in (0, 1]");
    }
  });

  if (!ids.has(policy.defaultTierId)) push("defaultTierId", "unknown-tier-ref", `default tier ${policy.defaultTierId} does not exist`);
  for (const [taskClass, ref] of Object.entries(policy.taskClassTierRefs ?? {})) {
    if (!ids.has(ref)) push(`taskClassTierRefs.${taskClass}`, "unknown-tier-ref", `task class ${taskClass} names missing tier ${ref}`);
  }

  if (policy.evaluator === LEGACY_EVALUATOR_ID && tiers.length > 0) validateLegacyLadder(tiers, push);
  if (options.previous) validateSTierNotWeakened(options.previous, policy, push);
  return issues;
}

/**
 * The legacy evaluator is keyed by the fixed `Tier` union, so it accepts exactly
 * T1/T2/T3 in ascending capability order. Adding or deleting a tier needs an
 * evaluator that is not keyed by that union. Renaming one is a `name` change.
 */
function validateLegacyLadder(
  tiers: readonly TierDefinition[],
  push: (path: string, code: string, message: string) => void,
): void {
  const ids = tiers.map((t) => t.id);
  const missing = LEGACY_TIER_IDS.filter((id) => !ids.includes(id));
  const extra = ids.filter((id) => !(LEGACY_TIER_IDS as readonly string[]).includes(id));
  if (missing.length > 0) push("tiers", "legacy-tier-missing", `${LEGACY_EVALUATOR_ID} needs tiers ${missing.join(", ")}`);
  if (extra.length > 0) push("tiers", "legacy-tier-unknown", `${LEGACY_EVALUATOR_ID} cannot evaluate tiers ${extra.join(", ")}`);
  if (missing.length > 0 || extra.length > 0) return;

  const ascending = [...tiers].sort((a, b) => a.order - b.order).map((t) => t.id);
  if (ascending.join(",") !== LEGACY_TIER_IDS.join(",")) {
    push("tiers", "invalid-tier-order", `order must ascend ${LEGACY_TIER_IDS.join(" < ")}; got ${ascending.join(" < ")}`);
    return;
  }
  // Tier membership must not overlap: a tier whose cut is not strictly above the
  // one below can never be labelled. The capability gate may tie (T1 == T2 at 0.8
  // in serving) but must never invert.
  const byId = new Map(tiers.map((t) => [t.id, t]));
  for (let i = 1; i < LEGACY_TIER_IDS.length; i++) {
    const lower = byId.get(LEGACY_TIER_IDS[i - 1] as string) as TierDefinition;
    const upper = byId.get(LEGACY_TIER_IDS[i] as string) as TierDefinition;
    if (!(upper.legacy?.scoreThreshold > lower.legacy?.scoreThreshold)) {
      push(`tiers.${upper.id}.legacy.scoreThreshold`, "overlapping-tiers", `${upper.id} cut must be above ${lower.id} cut`);
    }
    if (!(upper.legacy?.capabilityThreshold >= lower.legacy?.capabilityThreshold)) {
      push(`tiers.${upper.id}.legacy.capabilityThreshold`, "inverted-capability", `${upper.id} capability bar is below ${lower.id}`);
    }
  }
}

/** An S-tier keeps its flags and never gets a lower bar. Relaxing one needs a recorded CEO decision, outside this check. */
function validateSTierNotWeakened(
  previous: TierPolicy,
  next: TierPolicy,
  push: (path: string, code: string, message: string) => void,
): void {
  for (const before of previous.tiers) {
    if (!before.sTier) continue;
    const after = next.tiers.find((t) => t.id === before.id);
    const at = `tiers.${before.id}`;
    if (!after) {
      push(at, "s-tier-weakened", `S-tier ${before.id} cannot be removed`);
      continue;
    }
    if (!after.sTier) push(`${at}.sTier`, "s-tier-weakened", `${before.id} cannot drop its S-tier flag`);
    if (before.fallbackOnly && !after.fallbackOnly) push(`${at}.fallbackOnly`, "s-tier-weakened", `${before.id} must stay fallbackOnly`);
    if (after.legacy.scoreThreshold < before.legacy.scoreThreshold || after.legacy.capabilityThreshold < before.legacy.capabilityThreshold) {
      push(`${at}.legacy`, "s-tier-weakened", `${before.id} thresholds cannot be lowered`);
    }
  }
}

export type RuleEnforcement = "enforced" | "not-enforced-in-aa-free-v1" | "not-enforced-version-unknown";

export interface CompiledRuleStatus {
  tierId: string;
  ruleIndex: number;
  status: RuleEnforcement;
  /** The predicate actually evaluated in this rule's place, or null when enforced as written. */
  replacement: typeof CAPABILITY_PRIOR_BINDING | null;
}

export interface CompiledTierPolicy {
  revision: number;
  evaluator: typeof LEGACY_EVALUATOR_ID;
  scoreThresholds: Readonly<Record<Tier, number>>;
  capabilityThresholds: Readonly<Record<Tier, number>>;
  capability: typeof LEGACY_CAPABILITY_PARAMS;
  defaultTierId: Tier;
  tierNames: Readonly<Record<Tier, string>>;
  rules: readonly CompiledRuleStatus[];
}

export class TierPolicyError extends Error {
  constructor(readonly issues: readonly TierPolicyIssue[]) {
    super(`invalid tier policy: ${issues.map((i) => `${i.path}: ${i.code}`).join("; ")}`);
    this.name = "TierPolicyError";
  }
}

/**
 * What each entry rule turns into under aa-free-v1. Only the capability
 * predicate is enforced. Everything else collapses onto it with a status that
 * says why, so a display can never show a rule as live when it is not.
 */
function ruleEnforcement(rule: MetricRule): RuleEnforcement {
  if (rule.optionalSourceRule) return "not-enforced-in-aa-free-v1";
  if (rule.kind === "capability-predicate") return "enforced";
  if (!DECISION_BINDINGS[rule.decisionBinding]) return "not-enforced-in-aa-free-v1";
  // A pinned version can only be honoured when the source publishes one. The free
  // list does not, so a numeric rule over it is never a raw index cut.
  return "not-enforced-version-unknown";
}

/** Validate and compile. Throws `TierPolicyError` listing every issue. */
export function compileTierPolicy(policy: TierPolicy, options: ValidateOptions = {}): CompiledTierPolicy {
  const issues = validateTierPolicy(policy, options);
  if (issues.length > 0) throw new TierPolicyError(issues);

  const byId = new Map(policy.tiers.map((t) => [t.id, t]));
  const scoreThresholds = {} as Record<Tier, number>;
  const capabilityThresholds = {} as Record<Tier, number>;
  const tierNames = {} as Record<Tier, string>;
  for (const id of LEGACY_TIER_IDS) {
    const tier = byId.get(id) as TierDefinition;
    scoreThresholds[id] = tier.legacy.scoreThreshold;
    capabilityThresholds[id] = tier.legacy.capabilityThreshold;
    tierNames[id] = tier.name;
  }
  const rules: CompiledRuleStatus[] = [];
  for (const tier of policy.tiers) {
    tier.entryRules.all.forEach((rule, ruleIndex) => {
      const status = ruleEnforcement(rule);
      rules.push({ tierId: tier.id, ruleIndex, status, replacement: status === "enforced" ? null : CAPABILITY_PRIOR_BINDING });
    });
  }
  return Object.freeze({
    revision: policy.revision,
    evaluator: LEGACY_EVALUATOR_ID,
    scoreThresholds: Object.freeze(scoreThresholds),
    capabilityThresholds: Object.freeze(capabilityThresholds),
    capability: LEGACY_CAPABILITY_PARAMS,
    defaultTierId: policy.defaultTierId as Tier,
    tierNames: Object.freeze(tierNames),
    rules: Object.freeze(rules),
  });
}

/**
 * The serving T1 capability bar (operator carry-forward `t1cap080`, 2026-10-01).
 * Before this change source said 0.85 here; serving has run 0.8 since that date.
 */
export const T1_CAPABILITY_THRESHOLD = 0.8;

function legacyTier(id: Tier, name: string, order: number, capabilityThreshold: number): TierDefinition {
  return {
    id,
    name,
    order,
    entryRules: { all: [{ kind: "capability-predicate", decisionBinding: CAPABILITY_PRIOR_BINDING, policyRevision: LEGACY_EVALUATOR_ID }] },
    allowedEfforts: ALL_AA_EFFORTS,
    evidence: { mode: "legacy", minIndependentTasks: 0, cohort: "legacy-model-id" },
    fallbackOnly: false,
    sTier: false,
    legacy: { scoreThreshold: SCORE_THRESHOLDS[id], capabilityThreshold, sourceRevision: "3da20ab13+t1cap080" },
  };
}

/**
 * The migration baseline: exactly what the serving build evaluates. Tier cuts
 * are `SCORE_THRESHOLDS` (0.85/0.8/0.75); capability bars are the same except
 * T1 at 0.8. Replayed against the frozen serving evaluator in
 * `tests/tier-policy/tier-policy-replay.spec.ts`.
 */
export const LEGACY_MODEL_SELECTION_V1: TierPolicy = Object.freeze({
  schemaVersion: TIER_POLICY_SCHEMA_VERSION,
  revision: 1,
  evaluator: LEGACY_EVALUATOR_ID,
  decisionProfile: AA_FREE_PROFILE,
  optionalRichDecisionWeight: 0,
  tiers: Object.freeze([
    legacyTier("T3", "T3", 0, SCORE_THRESHOLDS.T3),
    legacyTier("T2", "T2", 1, SCORE_THRESHOLDS.T2),
    legacyTier("T1", "T1", 2, T1_CAPABILITY_THRESHOLD),
  ]),
  defaultTierId: "T1",
  taskClassTierRefs: Object.freeze({}),
  legacyCompatibility: Object.freeze({
    sourceRevision: "3da20ab13",
    servingBuild: "model-selection-0.4.0-main5a9be61-t1cap080",
    servingWorkerSha256: "dde5fe180cc86856d2332a6ee56ff3ea62fedd349c91c1550de8bd8773b3c099",
    rosterSnapshotHash: null,
    baselineDecisionCorpusHash: null,
  }),
}) as TierPolicy;

/** The compiled policy every evaluator default reads. */
export const LEGACY_TIER_POLICY: CompiledTierPolicy = compileTierPolicy(LEGACY_MODEL_SELECTION_V1);
