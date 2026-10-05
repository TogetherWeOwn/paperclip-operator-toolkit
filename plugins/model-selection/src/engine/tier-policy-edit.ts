/**
 * P2: add, edit and remove tiers as data, through the
 * `model_selection_tier_policy` tool.
 *
 * This build is the D4 fallback branch: prepare, validate and diff only. The
 * plugin SDK has no compare-and-set primitive, and nothing yet proves that the
 * installed persistence plus actor context enforces one authoritative revision.
 * So every outcome is `proposalOnly` or `rejected`, never `accepted`, and this
 * module never writes state or config and never changes routing. Serving keeps
 * evaluating the built-in `LEGACY_MODEL_SELECTION_V1`.
 *
 * Every guard in `tier-policy.ts` applies to the proposal unchanged, with the
 * base as `previous` so the S-tier check sees the edit. On top of those this
 * module adds the request gates D4 names:
 *  - `expectedRevision` must equal the base revision (the CAS precondition a
 *    later persistence path has to enforce for real);
 *  - a mutating action needs a `reason`;
 *  - a tier id never changes, and an edit may only touch the declared fields;
 *  - remove refuses the default tier and any tier a task class references.
 * A caller-supplied base is checked for S-tier weakening against the built-in
 * active policy as well, so a chain of supplied bases cannot relax one either.
 * Relaxing an S-tier needs a recorded CEO decision, which no input here carries.
 */
import { createHash } from "node:crypto";
import {
  LEGACY_MODEL_SELECTION_V1,
  compileTierPolicy,
  validateTierPolicy,
  type CompiledTierPolicy,
  type TierDefinition,
  type TierPolicy,
  type TierPolicyIssue,
} from "./tier-policy.js";
import { EDITABLE_TIER_FIELDS, TIER_POLICY_ACTIONS, type TierPolicyAction } from "../tier-policy-tool.js";

export { EDITABLE_TIER_FIELDS, TIER_POLICY_ACTIONS, type TierPolicyAction };

const MUTATING_ACTIONS: ReadonlySet<TierPolicyAction> = new Set(["add", "edit", "remove"]);
/** Patched shallowly, so `{legacy: {capabilityThreshold}}` keeps the other legacy fields. */
const MERGED_TIER_FIELDS: ReadonlySet<string> = new Set(["legacy", "evidence"]);

export const ACTIVE_TIER_POLICY_SOURCE = "built-in:LEGACY_MODEL_SELECTION_V1";
export const MAX_REASON_LENGTH = 2000;

export const PROPOSAL_ONLY_NOTE =
  "proposalOnly: nothing was written and routing is unchanged. Activation needs a persistence path " +
  "proven to enforce expectedRevision against one authoritative revision.";

export interface TierPolicyEditActor {
  agentId: string | null;
  runId: string | null;
}

export interface TierPolicyDiffEntry {
  path: string;
  change: "added" | "removed" | "changed";
  before: unknown;
  after: unknown;
}

export interface CompiledTierSummary {
  revision: number;
  defaultTierId: string;
  tierNames: Record<string, string>;
  scoreThresholds: Record<string, number>;
  capabilityThresholds: Record<string, number>;
  enforcedRules: number;
  notEnforcedRules: number;
}

export interface TierPolicyImpact {
  /** Always false: this build never activates a proposal. */
  appliedToServing: false;
  /** Whether the proposal, once activated, would change a tier cut, capability bar or the default tier. */
  wouldChangeServing: boolean;
  before: CompiledTierSummary | null;
  after: CompiledTierSummary | null;
}

export interface TierPolicyEditResult {
  ok: boolean;
  /** Present when `ok` is false: the first issue code, matching the `toolRejection` shape. */
  error?: string;
  outcome: "proposalOnly" | "rejected";
  action: TierPolicyAction | null;
  baseSource: typeof ACTIVE_TIER_POLICY_SOURCE | "supplied";
  baseRevision: number | null;
  proposedRevision: number | null;
  dryRun: boolean;
  persisted: false;
  issues: TierPolicyIssue[];
  diff: TierPolicyDiffEntry[];
  impact: TierPolicyImpact;
  proposedPolicy: TierPolicy | null;
  reason: string | null;
  auditId: string;
  note: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A detached, JSON-only copy: tool input is JSON, and nothing here may alias the frozen built-in. */
function cloneJson<T>(value: unknown): T | undefined {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : (JSON.parse(text) as T);
  } catch {
    return undefined;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The shapes `validateTierPolicy` dereferences without a guard. It assumes a
 * well-typed document; tool input is not one, so check the containers first and
 * never hand it something it would throw on.
 */
function shapeIssues(policy: unknown, at: string): TierPolicyIssue[] {
  const issues: TierPolicyIssue[] = [];
  const push = (path: string, message: string) => issues.push({ path, code: "malformed-policy", message });
  if (!isPlainObject(policy)) {
    push(at, "policy must be an object");
    return issues;
  }
  if (!Array.isArray(policy.tiers)) push(`${at}.tiers`, "tiers must be an array");
  else policy.tiers.forEach((tier, i) => issues.push(...tierShapeIssues(tier, `${at}.tiers[${i}]`)));
  if (policy.taskClassTierRefs !== undefined && !isPlainObject(policy.taskClassTierRefs)) {
    push(`${at}.taskClassTierRefs`, "taskClassTierRefs must be an object");
  }
  return issues;
}

function tierShapeIssues(tier: unknown, at: string): TierPolicyIssue[] {
  const issues: TierPolicyIssue[] = [];
  const push = (path: string, message: string) => issues.push({ path, code: "malformed-policy", message });
  if (!isPlainObject(tier)) {
    push(at, "tier must be an object");
    return issues;
  }
  if (!isPlainObject(tier.entryRules) || !Array.isArray(tier.entryRules.all)) {
    push(`${at}.entryRules.all`, "entryRules.all must be an array");
  } else {
    tier.entryRules.all.forEach((rule, r) => {
      if (!isPlainObject(rule)) push(`${at}.entryRules.all[${r}]`, "entry rule must be an object");
    });
  }
  if (!Array.isArray(tier.allowedEfforts)) push(`${at}.allowedEfforts`, "allowedEfforts must be an array");
  if (!isPlainObject(tier.evidence)) push(`${at}.evidence`, "evidence must be an object");
  if (!isPlainObject(tier.legacy)) push(`${at}.legacy`, "legacy must be an object");
  return issues;
}

/** Tiers diff by id so a reorder or rename reads as a field change, not a whole-array swap. */
function tiersById(value: unknown): Map<string, unknown> | null {
  if (!Array.isArray(value)) return null;
  const byId = new Map<string, unknown>();
  for (const tier of value) {
    const id = isPlainObject(tier) ? tier.id : undefined;
    if (typeof id !== "string" || byId.has(id)) return null;
    byId.set(id, tier);
  }
  return byId;
}

function diffValues(path: string, before: unknown, after: unknown, out: TierPolicyDiffEntry[]): void {
  if (canonicalJson(before) === canonicalJson(after)) return;
  if (before === undefined || after === undefined) {
    out.push({ path, change: before === undefined ? "added" : "removed", before: before ?? null, after: after ?? null });
    return;
  }
  const beforeTiers = path === "tiers" ? tiersById(before) : null;
  const afterTiers = path === "tiers" ? tiersById(after) : null;
  if (beforeTiers && afterTiers) {
    const ids = [...beforeTiers.keys(), ...[...afterTiers.keys()].filter((id) => !beforeTiers.has(id))];
    for (const id of ids) diffValues(`tiers.${id}`, beforeTiers.get(id), afterTiers.get(id), out);
    return;
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) diffValues(path ? `${path}.${key}` : key, before[key], after[key], out);
    return;
  }
  out.push({ path, change: "changed", before, after });
}

/** Structural diff from `before` to `after`; tiers keyed by id. */
export function diffTierPolicies(before: unknown, after: unknown): TierPolicyDiffEntry[] {
  const out: TierPolicyDiffEntry[] = [];
  diffValues("", before, after, out);
  return out;
}

function summarize(compiled: CompiledTierPolicy): CompiledTierSummary {
  const enforcedRules = compiled.rules.filter((r) => r.status === "enforced").length;
  return {
    revision: compiled.revision,
    defaultTierId: compiled.defaultTierId,
    tierNames: { ...compiled.tierNames },
    scoreThresholds: { ...compiled.scoreThresholds },
    capabilityThresholds: { ...compiled.capabilityThresholds },
    enforcedRules,
    notEnforcedRules: compiled.rules.length - enforcedRules,
  };
}

function compileSummary(policy: TierPolicy | null): CompiledTierSummary | null {
  if (!policy) return null;
  try {
    return summarize(compileTierPolicy(policy));
  } catch {
    return null;
  }
}

function servingKey(summary: CompiledTierSummary | null): string | null {
  if (!summary) return null;
  return canonicalJson({
    defaultTierId: summary.defaultTierId,
    scoreThresholds: summary.scoreThresholds,
    capabilityThresholds: summary.capabilityThresholds,
  });
}

/**
 * Every issue the proposal has as a replacement for `base`. A supplied base is
 * also not trusted to define what an S-tier was: the built-in active policy is
 * checked as `previous` too.
 */
function proposalIssues(proposed: TierPolicy, base: TierPolicy, active: TierPolicy, baseIsActive: boolean): TierPolicyIssue[] {
  const issues = validateTierPolicy(proposed, { previous: base });
  if (!baseIsActive) {
    const seen = new Set(issues.map((i) => `${i.path}|${i.code}`));
    for (const issue of validateTierPolicy(proposed, { previous: active })) {
      if (issue.code !== "s-tier-weakened" || seen.has(`${issue.path}|${issue.code}`)) continue;
      issues.push(issue);
    }
  }
  return issues;
}

function requiredTierId(value: unknown, issues: TierPolicyIssue[]): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  issues.push({ path: "tierId", code: "invalid-tier-id", message: "tierId must be a non-empty string" });
  return null;
}

function applyEdit(base: TierPolicy, request: Record<string, unknown>, issues: TierPolicyIssue[]): TierDefinition[] | null {
  const tierId = requiredTierId(request.tierId, issues);
  if (!isPlainObject(request.patch) || Object.keys(request.patch).length === 0) {
    issues.push({ path: "patch", code: "invalid-patch", message: "patch must be a non-empty object" });
    return null;
  }
  const patch = request.patch;
  for (const key of Object.keys(patch)) {
    if (key === "id") {
      issues.push({ path: "patch.id", code: "immutable-id", message: "a tier id never changes; rename with patch.name" });
    } else if (!(EDITABLE_TIER_FIELDS as readonly string[]).includes(key)) {
      issues.push({ path: `patch.${key}`, code: "unknown-patch-key", message: `${key} is not an editable tier field` });
    }
  }
  if (tierId === null || issues.length > 0) return null;
  const index = base.tiers.findIndex((t) => t.id === tierId);
  if (index < 0) {
    issues.push({ path: "tierId", code: "unknown-tier", message: `no tier ${tierId} in base revision ${base.revision}` });
    return null;
  }
  const current = base.tiers[index] as unknown as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    next[key] = MERGED_TIER_FIELDS.has(key) && isPlainObject(value) && isPlainObject(current[key])
      ? { ...current[key], ...value }
      : value;
  }
  return base.tiers.map((t, i) => (i === index ? (next as unknown as TierDefinition) : t));
}

function applyRemove(base: TierPolicy, request: Record<string, unknown>, issues: TierPolicyIssue[]): TierDefinition[] | null {
  const tierId = requiredTierId(request.tierId, issues);
  if (tierId === null) return null;
  if (!base.tiers.some((t) => t.id === tierId)) {
    issues.push({ path: "tierId", code: "unknown-tier", message: `no tier ${tierId} in base revision ${base.revision}` });
    return null;
  }
  if (base.defaultTierId === tierId) {
    issues.push({ path: "tierId", code: "tier-is-default", message: `${tierId} is the default tier; move defaultTierId first` });
  }
  const referencing = Object.entries(base.taskClassTierRefs ?? {})
    .filter(([, ref]) => ref === tierId)
    .map(([taskClass]) => taskClass)
    .sort();
  if (referencing.length > 0) {
    issues.push({ path: "tierId", code: "tier-referenced", message: `${tierId} is referenced by task classes ${referencing.join(", ")}` });
  }
  return base.tiers.filter((t) => t.id !== tierId);
}

/**
 * Prepare one tier-policy change. Pure: reads nothing but its arguments, writes
 * nothing, never throws. `active` is the policy serving evaluates today.
 */
export function prepareTierPolicyEdit(
  request: Record<string, unknown>,
  actor: TierPolicyEditActor,
  active: TierPolicy = LEGACY_MODEL_SELECTION_V1,
): TierPolicyEditResult {
  const issues: TierPolicyIssue[] = [];
  const action = (TIER_POLICY_ACTIONS as readonly unknown[]).includes(request.action)
    ? (request.action as TierPolicyAction)
    : null;
  const dryRun = request.dryRun !== false;
  const reason = typeof request.reason === "string" && request.reason.trim().length > 0 ? request.reason.trim() : null;

  const baseIsActive = request.basePolicy === undefined;
  let base: TierPolicy | null = null;
  if (baseIsActive) {
    base = cloneJson<TierPolicy>(active) ?? null;
  } else {
    const supplied = cloneJson<unknown>(request.basePolicy);
    const malformed = shapeIssues(supplied, "basePolicy");
    if (malformed.length > 0) issues.push(...malformed);
    else base = supplied as TierPolicy;
  }
  const baseRevision = base && Number.isInteger(base.revision) ? base.revision : null;

  if (action === null) {
    issues.push({ path: "action", code: "invalid-action", message: `action must be one of ${TIER_POLICY_ACTIONS.join(", ")}` });
  }
  if (action !== null && MUTATING_ACTIONS.has(action)) {
    if (reason === null) issues.push({ path: "reason", code: "missing-reason", message: `${action} needs a reason for the audit record` });
    else if (reason.length > MAX_REASON_LENGTH) {
      issues.push({ path: "reason", code: "invalid-reason", message: `reason is limited to ${MAX_REASON_LENGTH} characters` });
    }
    if (request.expectedRevision === undefined) {
      issues.push({ path: "expectedRevision", code: "missing-expected-revision", message: `${action} needs expectedRevision (compare-and-set)` });
    }
  }
  if (request.expectedRevision !== undefined && baseRevision !== null && request.expectedRevision !== baseRevision) {
    issues.push({
      path: "expectedRevision",
      code: "revision-conflict",
      message: `expectedRevision ${String(request.expectedRevision)} does not match base revision ${baseRevision}`,
    });
  }
  if (base !== null && baseRevision === null) {
    issues.push({ path: "basePolicy.revision", code: "invalid-revision", message: "base revision must be a positive integer" });
  }

  let proposed: TierPolicy | null = null;
  if (issues.length === 0 && action !== null && base !== null && baseRevision !== null) {
    const nextRevision = baseRevision + 1;
    if (action === "add") {
      const tier = cloneJson<unknown>(request.tier);
      if (!isPlainObject(tier)) {
        issues.push({ path: "tier", code: "invalid-tier", message: "add needs a tier object" });
      } else {
        proposed = { ...base, revision: nextRevision, tiers: [...base.tiers, tier as unknown as TierDefinition] };
      }
    } else if (action === "edit") {
      const tiers = applyEdit(base, request, issues);
      if (tiers) proposed = { ...base, revision: nextRevision, tiers };
    } else if (action === "remove") {
      const tiers = applyRemove(base, request, issues);
      if (tiers) proposed = { ...base, revision: nextRevision, tiers };
    } else if (request.policy !== undefined) {
      const candidate = cloneJson<unknown>(request.policy);
      const malformed = shapeIssues(candidate, "policy");
      if (malformed.length > 0) {
        issues.push(...malformed);
      } else {
        proposed = candidate as TierPolicy;
        if (proposed.revision !== nextRevision) {
          issues.push({
            path: "policy.revision",
            code: "revision-not-next",
            message: `a replacement for revision ${baseRevision} must be revision ${nextRevision}`,
          });
        }
      }
    } else if (action === "diff") {
      issues.push({ path: "policy", code: "missing-policy", message: "diff needs a candidate policy" });
    } else {
      // validate with no candidate: check the base itself.
      issues.push(...validateTierPolicy(base));
    }
  }

  if (proposed !== null && base !== null) {
    const malformed = shapeIssues(proposed, "proposed");
    if (malformed.length > 0) {
      issues.push(...malformed);
    } else {
      try {
        issues.push(...proposalIssues(proposed, base, active, baseIsActive));
      } catch (cause) {
        issues.push({ path: "proposed", code: "malformed-policy", message: cause instanceof Error ? cause.message : String(cause) });
      }
    }
  }

  const ok = issues.length === 0;
  const before = compileSummary(base);
  const after = ok ? compileSummary(proposed) : null;
  const diff = proposed !== null && base !== null ? diffTierPolicies(base, proposed) : [];
  const auditId = `tpa_${sha256(
    canonicalJson({
      action,
      baseSource: baseIsActive ? ACTIVE_TIER_POLICY_SOURCE : "supplied",
      baseHash: base ? sha256(canonicalJson(base)) : null,
      proposedHash: proposed ? sha256(canonicalJson(proposed)) : null,
      reason,
      dryRun,
      agentId: actor.agentId,
      runId: actor.runId,
    }),
  ).slice(0, 24)}`;

  return {
    ok,
    ...(ok ? {} : { error: (issues[0] as TierPolicyIssue).code }),
    outcome: ok ? "proposalOnly" : "rejected",
    action,
    baseSource: baseIsActive ? ACTIVE_TIER_POLICY_SOURCE : "supplied",
    baseRevision,
    proposedRevision: proposed && Number.isInteger(proposed.revision) ? proposed.revision : null,
    dryRun,
    persisted: false,
    issues,
    diff,
    impact: {
      appliedToServing: false,
      wouldChangeServing: after !== null && before !== null && servingKey(after) !== servingKey(before),
      before,
      after,
    },
    proposedPolicy: proposed,
    reason,
    auditId,
    note: PROPOSAL_ONLY_NOTE,
  };
}

/** The tool's human-readable `content`. `data` carries the full record. */
export function renderTierPolicyEditResult(result: TierPolicyEditResult): string {
  const head =
    `${result.action ?? "invalid action"}: ${result.outcome} ` +
    `(base ${result.baseSource} revision ${result.baseRevision ?? "?"}` +
    `${result.proposedRevision !== null ? ` -> proposed ${result.proposedRevision}` : ""}; audit ${result.auditId})`;
  const lines = [head];
  if (result.issues.length > 0) {
    lines.push(`${result.issues.length} issue(s):`);
    for (const issue of result.issues.slice(0, 20)) lines.push(`- ${issue.path}: ${issue.code}: ${issue.message}`);
    if (result.issues.length > 20) lines.push(`- ... ${result.issues.length - 20} more in data.issues`);
  }
  if (result.diff.length > 0) {
    lines.push(`${result.diff.length} change(s): ${result.diff.slice(0, 20).map((d) => d.path).join(", ")}`);
  }
  if (result.ok && result.proposedRevision !== null) {
    lines.push(result.impact.wouldChangeServing
      ? "Once activated this would change a tier cut, capability bar or the default tier."
      : "Once activated this would not change any tier cut, capability bar or the default tier.");
  }
  lines.push(result.note);
  return lines.join("\n");
}
