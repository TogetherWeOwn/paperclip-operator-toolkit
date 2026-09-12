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
 */

export interface ApplyPlan {
  /** Whether anything should be written at all. */
  write: boolean;
  issueId: string;
  /** The `assigneeAdapterOverrides` patch, or null when nothing is written. */
  patch: { assigneeAdapterOverrides: { adapterConfig: { model: string } } } | null;
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
}

const TERMINAL_STATUSES = new Set(["done", "cancelled"]);

/**
 * Decide what, if anything, to write. Pure — it performs no IO, so the whole
 * write policy is testable without a host.
 */
export function planApply(
  decision: SelectionDecision,
  context: ApplyContext,
  targetIssueId: string,
): ApplyPlan {
  const nothing = (reason: string): ApplyPlan => ({
    write: false,
    issueId: targetIssueId,
    patch: null,
    labelName: null,
    reason,
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
    patch: { assigneeAdapterOverrides: { adapterConfig: { model: decision.modelId } } },
    labelName: context.hasExistingTierLabel || !tier ? null : tierLabelName(tier),
    reason: `pinning ${decision.modelId} at ${tier} — ${decision.trace.at(-1) ?? "selected"}`,
  };
}

export function tierLabelName(tier: Tier): string {
  return `${TIER_LABEL_PREFIX}${tier}`;
}
