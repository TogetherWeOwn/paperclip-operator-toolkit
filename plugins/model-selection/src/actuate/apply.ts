import { TIER_LABEL_PREFIX, type Tier } from "../constants.js";
import type { SelectionDecision } from "../engine/types.js";
import { repinAllowed, type RepinGateContext } from "../engine/pacing.js";

/**
 * Turning a decision into a board write.
 *
 * Two rules govern this file, and both were paid for in evidence:
 *
 * 1. **Pin an arbitrary model, never `modelProfile: "cheap"`.** That profile
 *    carries `effort: ""` and the merge puts the adapter default first
 *    (`heartbeat.ts:3523-3525`), which is the known ACP `effort` outage path.
 *    We write `adapterConfig.model` directly.
 *
 * 2. **Never re-pin an issue that already has an override.** A mid-flight model
 *    change fires `shouldResetTaskSessionForModelChange`
 *    (`heartbeat.ts:5127-5133`), discarding the warm prompt cache — the single
 *    largest cost line (ADR-0002). If the tier turns out wrong, that is a
 *    finding for the NEXT issue's labelling, not a reason to re-pin this one.
 *
 *    One narrow exception (TOG-12305): an override whose env carries secret
 *    refs the current assignee does not carry. The host checks every
 *    `secret_ref` against the RUN's agent, so such a pin fails every wake as
 *    `configuration_incomplete` — there is no warm session left to protect.
 *    `planEnvRepair` rewrites that override on the SAME model; it never
 *    changes the model, so rule 2 still holds for every model-changing write.
 */

export interface ApplyPlan {
  /** Whether anything should be written at all. */
  write: boolean;
  issueId: string;
  /**
   * The selected model id. The caller builds the full env-preserving override.
   *
   * TOG-3045 — if you came here looking for the sub-call surface pins
   * (`ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`), they are
   * NOT here. This function is pure and never sees an env map. All five override
   * write paths build their patch through `modelOverrideForContext`
   * (`engine/context.ts`), which is therefore the only place the env merge can
   * live without being duplicated four times.
   */
  modelId: string | null;
  /**
   * Tier label to attach alongside, per ADR-0008.
   *
   * CAUTION for the caller: `issues.update` REPLACES the label set — the host
   * deletes every `issue_labels` row for the issue and re-inserts exactly the
   * ids given (`issues.ts:4835-4852`). So a patch carrying `labelIds` must
   * carry the issue's EXISTING ids plus this one, never this one alone, or the
   * update silently strips every other label off the issue.
   */
  labelName: string | null;
  /** Why we are or are not writing. Always populated. */
  reason: string;
  /**
   * TOG-12305. True when this write only rebuilds the env of an existing pin:
   * `modelId` is the model the override ALREADY pins, never the decision's.
   */
  envRepairOnly: boolean;
}

/** TOG-12305. What `planEnvRepair` needs to know about an existing pin. */
export interface EnvRepairContext {
  /** The model the existing override pins, or null when it pins none. */
  pinnedModelId: string | null;
  /**
   * Override env keys bound to a secret the assignee's own env does not carry
   * (`staleOverrideSecretRefKeys`). Empty when the assignee env is UNKNOWN —
   * without the assignee's env we cannot tell a stale ref from a live one.
   */
  staleSecretRefKeys: readonly string[];
}

export interface ApplyContext {
  /** True when the issue already carries an assigneeAdapterOverrides value. */
  hasExistingOverride: boolean;
  /** True when the issue already carries any tier:* label. */
  hasExistingTierLabel: boolean;
  /** Issue status. We do not re-pin work that is already finished. */
  status: string;
  /**
   * TOG-2137. Present only when this decision was reached under
   * `pacing.mode: enforce` and is a candidate for a pace-driven repin of an
   * issue that already carries an override. Absent entirely for a plain
   * (non-pacing) re-pin attempt, which keeps the pre-2137 refusal below.
   */
  paceRepin?: RepinGateContext;
  /**
   * TOG-12305. Present when the caller read the existing pin; lets a declined
   * plan fall back to a same-model env repair. Absent: no repair is planned.
   */
  envRepair?: EnvRepairContext;
}

const TERMINAL_STATUSES = new Set(["done", "cancelled"]);

/**
 * Decide what, if anything, to write. Pure — it performs no IO, so the whole
 * write policy is testable without a host.
 *
 * The env repair is a fallback, not a pre-emption: when the pin path writes
 * (a fresh pin, an allowed pace repin) that write already rebuilds the env
 * from the assignee (`modelOverrideForContext`), so the repair only runs when
 * the pin path declined. Advisory mode declines both — enforcement off means
 * this plugin writes nothing at all.
 */
export function planApply(
  decision: SelectionDecision,
  context: ApplyContext,
  targetIssueId: string,
): ApplyPlan {
  const plan = planPin(decision, context, targetIssueId);
  if (plan.write || decision.advisory || !context.hasExistingOverride || !context.envRepair) return plan;
  const repair = planEnvRepair(context.envRepair, targetIssueId);
  if (!repair) return plan;
  return { ...repair, reason: `${repair.reason} (pin path declined: ${plan.reason})` };
}

/**
 * TOG-12305. A same-model env-only rewrite of an existing pin whose env carries
 * secret refs the current assignee does not carry, or null when none applies.
 *
 * Why this is safe against rule 2: the model does not change, so
 * `shouldResetTaskSessionForModelChange` cannot fire; and a pin with an
 * unbound ref fails the host's pre-dispatch binding check on every wake, so
 * there is no running session whose cache this could cost. Finished work is
 * included on purpose: a done card is still woken by comments, and every such
 * wake fails the same way until the pin is rewritten.
 *
 * The caller builds the patch with `modelOverrideForContext`, which rebuilds the
 * env from the assignee's own env when it is known — that rebuild is the repair.
 * An unknown assignee env yields no stale keys, so this never writes blind.
 */
export function planEnvRepair(context: EnvRepairContext, targetIssueId: string): ApplyPlan | null {
  if (!context.pinnedModelId || context.staleSecretRefKeys.length === 0) return null;
  return {
    write: true,
    issueId: targetIssueId,
    modelId: context.pinnedModelId,
    labelName: null,
    envRepairOnly: true,
    reason: `env repair on pinned ${context.pinnedModelId}: override binds secret refs the assignee does not carry (${context.staleSecretRefKeys.join(", ")}); model unchanged`,
  };
}

function planPin(decision: SelectionDecision, context: ApplyContext, targetIssueId: string): ApplyPlan {
  const nothing = (reason: string): ApplyPlan => ({
    write: false,
    issueId: targetIssueId,
    modelId: null,
    labelName: null,
    reason,
    envRepairOnly: false,
  });

  if (decision.advisory) {
    return nothing("advisory mode: enforcement is off for this company");
  }
  if (decision.outcome !== "selected" || !decision.modelId) {
    return nothing(`no model selected (outcome ${decision.outcome})`);
  }
  if (TERMINAL_STATUSES.has(context.status)) {
    return nothing(`issue status is ${context.status}; not re-pinning finished work`);
  }
  if (context.hasExistingOverride) {
    if (!context.paceRepin) {
      return nothing(
        "issue already carries assigneeAdapterOverrides; re-pinning would reset the session and discard the prompt cache",
      );
    }
    const gate = repinAllowed(context.paceRepin);
    if (!gate.allowed) {
      return nothing(`pace repin declined: ${gate.reason}`);
    }
  }
  const tier = decision.effectiveTier;
  return {
    write: true,
    issueId: targetIssueId,
    modelId: decision.modelId,
    labelName: context.hasExistingTierLabel || !tier ? null : tierLabelName(tier),
    reason: `pinning ${decision.modelId} at ${tier} — ${decision.trace.at(-1) ?? "selected"}`,
    envRepairOnly: false,
  };
}

export function tierLabelName(tier: Tier): string {
  return `${TIER_LABEL_PREFIX}${tier}`;
}

/**
 * TOG-12431: the single gate for every router-owned model/env pin write.
 *
 * `planApply` refuses advisory decisions, and the engine marks a decision
 * advisory exactly when this is false — but the five scheduled/event pin
 * sites in `worker.ts` bypass `planApply` and write through
 * `modelOverrideForContext` directly, so each of them checks this first.
 * When false the passes still walk their rows, still write tier labels, and
 * still emit their activity log marked advisory — they just write no
 * override.
 *
 * There is deliberately no safety-evacuation exception: any future exception
 * must be explicit and documented, not silent.
 */
export function selectionWritesAllowed(config: {
  selection: { enabled: boolean; mode: string };
}): boolean {
  return config.selection.enabled && config.selection.mode === "enforce";
}
