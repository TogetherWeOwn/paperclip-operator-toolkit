import { TIERS, TIER_LABEL_PREFIX, TIER_ORDER, type Tier } from "../constants.js";
import { resolveConfiguredModelId } from "./model-id.js";
import type { IssueDescriptor, ModelEntry, TierJudgement } from "./types.js";

/**
 * Resolve the tier for one issue from RECORDED judgement only.
 *
 * This is the design's load-bearing constraint and the thing that most wants to
 * drift. ADR-0007 established there is no task-type field to key on — `work_mode`
 * is 729/730 `standard` and `priority` encodes urgency, not kind of work — and
 * the ratified Q8-a ruling settled that the key stays a recorded human/agent
 * judgement at assignment time, NOT an inferred taxonomy.
 *
 * So there is deliberately no classifier here, and no text heuristic. Every
 * branch below reads something a human or agent already decided and wrote down.
 * If nothing was written down, the answer is the agent's tier floor — which is
 * a valid answer, not a missing one (ADR-0008: "a missing label is not a missing
 * decision").
 *
 * Adding a `guessTierFromTitle()` here would be the failure mode, not the
 * feature.
 */

function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

/** Extract `tier:T2` -> `T2` from label names. Unknown suffixes are ignored. */
export function tierFromLabels(labelNames: readonly string[] | undefined): Tier | null {
  if (!labelNames) return null;
  const found: Tier[] = [];
  for (const name of labelNames) {
    if (!name.startsWith(TIER_LABEL_PREFIX)) continue;
    const suffix = name.slice(TIER_LABEL_PREFIX.length);
    if (isTier(suffix)) found.push(suffix);
  }
  if (found.length === 0) return null;
  // More than one tier label is a labelling error, not a judgement. Take the
  // most capable rather than picking arbitrarily — the conservative direction.
  return found.sort((left, right) => TIER_ORDER.indexOf(right) - TIER_ORDER.indexOf(left))[0]!;
}

/** Most capable enabled tier configured for this runtime model id, if any. */
export function tierOfModel(modelId: string | null | undefined, models: readonly ModelEntry[]): Tier | null {
  const configuredId = resolveConfiguredModelId(modelId, models);
  if (!configuredId) return null;
  const matches = models.filter((model) => model.id === configuredId && model.enabled);
  if (matches.length === 0) return null;
  return matches.reduce((highest, model) =>
    TIER_ORDER.indexOf(model.tier) > TIER_ORDER.indexOf(highest) ? model.tier : highest,
  matches[0]!.tier);
}

export interface ResolveTierOptions {
  /**
   * TOG-2137, Defect 6. Whether a given model's lane is currently a
   * serviceability hard stop (same check `hardStopExcluded` applies in
   * `select.ts`). When the model an issue is pinned to fails this check, the
   * pin can no longer win outright — a `pinnedModelId` that hard-bypasses
   * capacity routing is exactly the classifier-SPOF pattern the reference
   * dispatcher's `tier_dispatcher.py:classify()` has: a pin on a task class
   * the control loop itself depends on cannot silently ride a dead lane.
   * Omitted (or always-false) reproduces the pre-2137 unconditional pin.
   */
  isLaneUnserviceable?: (model: ModelEntry) => boolean;
}

export function resolveTier(
  descriptor: IssueDescriptor,
  models: readonly ModelEntry[],
  configDefaultTier: Tier,
  options?: ResolveTierOptions,
): TierJudgement {
  // Step 1 — capability exclusion, checked FIRST and overriding everything
  // below (ADR-0004, ADR-0008 step 1). This is not a difficulty judgement: a
  // mechanically trivial config edit is excluded because the constraint, not
  // the task, is the safety property. Measured basis: haiku called a forbidden
  // write when explicitly told not to, and produced unstable arithmetic.
  if (descriptor.exclusion?.excluded) {
    return {
      tier: "T1",
      source: "capability-exclusion",
      detail: `capability exclusion forces T1: ${descriptor.exclusion.reasons.join("; ") || "unspecified"}`,
    };
  }

  // Step 2 — an explicit per-issue model pin is the strongest recorded
  // judgement: somebody set assigneeAdapterOverrides on purpose. But a pin is
  // a preference, not a suicide pact: if every enabled row for the pinned
  // model id sits on a serviceability hard stop, honoring it anyway would
  // silently wedge this issue (or, worse, a router-dependent task class like
  // `triage`) on a dead lane forever with no path to escalate. Fall through to
  // the next recorded judgement instead. A pin with at least one serviceable
  // row still wins outright, same as before — this only overrides the pin
  // when it is universally unserviceable, never merely "not preferred".
  const pinnedModelId = resolveConfiguredModelId(descriptor.pinnedModelId, models);
  const pinnedMatches = models.filter((model) => model.id === pinnedModelId && model.enabled);
  const servicablePinnedMatches = pinnedMatches.filter(
    (model) => !(options?.isLaneUnserviceable?.(model) ?? false),
  );
  if (pinnedMatches.length > 0 && servicablePinnedMatches.length === 0) {
    // Every row is hard-stopped; the pin cannot win. Do not `return` — let
    // this fall through to the tier label / agent floor / config default
    // below, same as if there were no pin at all.
  } else if (servicablePinnedMatches.length > 0) {
    const pinnedTier = servicablePinnedMatches.reduce((highest, model) =>
      TIER_ORDER.indexOf(model.tier) > TIER_ORDER.indexOf(highest) ? model.tier : highest,
    servicablePinnedMatches[0]!.tier);
    return {
      tier: pinnedTier,
      source: "issue-override",
      detail: `assigneeAdapterOverrides pins ${pinnedModelId} (${pinnedTier})`,
    };
  }

  // Step 3 — the tier:* label, the durable record that survives a remapping of
  // which model backs each tier (ADR-0008).
  const labelTier = tierFromLabels(descriptor.labelNames);
  if (labelTier) {
    return { tier: labelTier, source: "issue-label", detail: `${TIER_LABEL_PREFIX}${labelTier} label on the issue` };
  }

  // Step 4 — the assignee agent's own model is the tier floor. Nobody engaged
  // on this issue specifically; run it where the fleet config says.
  const floorTier = tierOfModel(descriptor.agentFloorModelId, models);
  if (floorTier) {
    return {
      tier: floorTier,
      source: "agent-floor",
      detail: `no issue-level judgement; assignee floor ${descriptor.agentFloorModelId} (${floorTier})`,
    };
  }

  return {
    tier: configDefaultTier,
    source: "config-default",
    detail: `no judgement and no recognised agent floor; config default ${configDefaultTier}`,
  };
}
