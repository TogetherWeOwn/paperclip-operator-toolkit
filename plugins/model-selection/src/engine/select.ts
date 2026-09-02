import type { Tier } from "../constants.js";
import { costOf, resolveProfile, tierIndex } from "./cost.js";
import { resolveTier } from "./tier.js";
import type {
  Candidate,
  IssueDescriptor,
  ModelEntry,
  QualitySignal,
  Rejection,
  SelectionDecision,
  VolumeProfile,
} from "./types.js";

export interface SelectionConfig {
  /**
   * false = advise only, never write. This is the default, and Stage 2's
   * rollout discipline depends on it: the plugin can be installed and observed
   * before it is allowed to change a live selection variable.
   */
  enforcementEnabled: boolean;
  defaultTier: Tier;
  models: readonly ModelEntry[];
  /**
   * When true, a decision computed from an untrusted volume profile holds at
   * the agent floor instead of acting. Guessing the volume term is the failure
   * this plugin exists to avoid, so this defaults on.
   */
  holdOnUntrustedProfile: boolean;
  /** Keep the model already used on this issue (ADR-0008, Round 4). */
  stickyWithinIssue: boolean;
}

export interface SelectInput {
  descriptor: IssueDescriptor;
  config: SelectionConfig;
  profiles: readonly VolumeProfile[];
  signals: readonly QualitySignal[];
  now: number;
}

export function selectModel(input: SelectInput): SelectionDecision {
  const { descriptor, config, profiles, signals, now } = input;
  const trace: string[] = [];
  const rejections: Rejection[] = [];

  const judgement = resolveTier(descriptor, config.models, config.defaultTier);
  trace.push(`tier ${judgement.tier} via ${judgement.source} — ${judgement.detail}`);

  const base: SelectionDecision = {
    outcome: "no-eligible-model",
    modelId: null,
    judgement,
    effectiveTier: null,
    candidates: [],
    rejections,
    trace,
    advisory: !config.enforcementEnabled,
    heldReason: null,
  };

  if (config.models.length === 0) {
    trace.push("no models configured for this company");
    return { ...base, outcome: "disabled" };
  }

  // A capability exclusion is a tier FLOOR, not a ceiling. `resolveTier` returns
  // T3 for excluded work, but T3 read as a ceiling admits every cheaper model
  // and the cost sort then picks the cheapest one — the exact inversion of what
  // the exclusion is for. ADR-0004's boundary is capability, not difficulty, so
  // this floor never yields: not to cost, not to sticky, not to a lifted ceiling.
  const floor: Tier | null = judgement.source === "capability-exclusion" ? judgement.tier : null;
  if (floor) {
    trace.push(`tier floor ${floor}: capability exclusion, no model below ${floor} is eligible`);
  }

  // Sticky beats cost. A mid-issue model change fires
  // `shouldResetTaskSessionForModelChange` (heartbeat.ts:5127-5133), discarding
  // the warm prompt cache — and cache read is the largest cost line we have
  // (ADR-0002). The saving from a cheaper model on turn N does not repay a
  // cache reset at turn N.
  //
  // Sticky beats cost, but it does not beat the floor: an issue already pinned
  // to a cheap model that is later found to be capability-excluded must not stay
  // there just because a session reset is expensive.
  if (config.stickyWithinIssue && descriptor.stickyModelId) {
    const incumbent = config.models.find(
      (model) => model.id === descriptor.stickyModelId && model.enabled,
    );
    if (incumbent && floor && tierIndex(incumbent.tier) < tierIndex(floor)) {
      trace.push(
        `sticky ${incumbent.id} (${incumbent.tier}) declined: below the ${floor} capability floor`,
      );
      rejections.push({
        modelId: incumbent.id,
        stage: "tier-floor",
        reason: `tier ${incumbent.tier} is below the ${floor} capability floor`,
      });
    } else if (incumbent) {
      trace.push(
        `sticky: ${incumbent.id} is already running this issue — switching would reset the session and discard the prompt cache`,
      );
      return { ...base, outcome: "selected", modelId: incumbent.id, effectiveTier: incumbent.tier };
    }
  }

  const ceiling = judgement.tier;
  const required = new Set(descriptor.requiredCapabilities ?? []);
  if (required.size > 0) {
    trace.push(`hard capability gate: ${[...required].sort().join(", ")}`);
  }

  // Gate every model. A gate is a filter, never a score adjustment — a model
  // that cannot do the work is out, however cheap it is.
  const qualified: ModelEntry[] = [];
  for (const model of config.models) {
    if (!model.enabled) {
      rejections.push({ modelId: model.id, stage: "disabled", reason: "disabled in the model table" });
      continue;
    }
    const missing = [...required].filter((capability) => !model.capabilities.includes(capability));
    if (missing.length > 0) {
      rejections.push({
        modelId: model.id,
        stage: "capability",
        reason: `missing ${missing.sort().join(", ")}`,
      });
      continue;
    }
    if (floor && tierIndex(model.tier) < tierIndex(floor)) {
      rejections.push({
        modelId: model.id,
        stage: "tier-floor",
        reason: `tier ${model.tier} is below the ${floor} capability floor`,
      });
      continue;
    }
    if (
      typeof descriptor.requiredContextTokens === "number" &&
      model.contextWindow < descriptor.requiredContextTokens
    ) {
      rejections.push({
        modelId: model.id,
        stage: "context-window",
        reason: `context window ${model.contextWindow} < required ${descriptor.requiredContextTokens}`,
      });
      continue;
    }
    qualified.push(model);
  }

  if (qualified.length === 0) {
    trace.push(`no model cleared the gates (${rejections.length} rejected)`);
    return base;
  }

  // Ceiling yields to the floor: if nothing at or below the judged tier
  // survived the capability gate, lift the ceiling rather than return nothing.
  // The capability gate is a hard constraint; the tier is a cost preference,
  // and a cost preference must never silently drop a capability requirement.
  let appliedCeiling = ceiling;
  if (!qualified.some((model) => tierIndex(model.tier) <= tierIndex(ceiling))) {
    const lowestQualified = qualified.reduce((lowest, model) =>
      tierIndex(model.tier) < tierIndex(lowest.tier) ? model : lowest,
    );
    trace.push(
      `ceiling ${ceiling} lifted to ${lowestQualified.tier}: nothing at or below ${ceiling} clears the capability gate`,
    );
    appliedCeiling = lowestQualified.tier;
  }

  const survivors = qualified.filter((model) => {
    if (tierIndex(model.tier) <= tierIndex(appliedCeiling)) return true;
    rejections.push({
      modelId: model.id,
      stage: "tier-ceiling",
      reason: `tier ${model.tier} exceeds ceiling ${appliedCeiling}`,
    });
    return false;
  });

  // Cost the survivors against the volume profile of the tier we are running
  // at — the measured multi-turn token totals, not a per-request estimate.
  const profileVerdict = resolveProfile(appliedCeiling, profiles, now);
  trace.push(`volume profile: ${profileVerdict.reason}`);

  const candidates: Candidate[] = [];
  for (const model of survivors) {
    const cost = costOf(model, appliedCeiling, profiles, config.models, signals, now);
    if (!cost) {
      rejections.push({
        modelId: model.id,
        stage: "no-profile",
        reason: `no volume profile for ${appliedCeiling}; cannot cost this candidate`,
      });
      continue;
    }
    candidates.push({ ...cost, tier: model.tier });
  }

  if (candidates.length === 0) {
    trace.push("no candidate could be costed — refusing to choose on a guessed volume term");
    return { ...base, effectiveTier: appliedCeiling };
  }

  candidates.sort((left, right) => {
    if (left.expectedCostUsd !== right.expectedCostUsd) {
      return left.expectedCostUsd - right.expectedCostUsd;
    }
    // Tie on cost: prefer the more capable tier, then a stable id order.
    if (left.tier !== right.tier) return tierIndex(right.tier) - tierIndex(left.tier);
    return left.modelId.localeCompare(right.modelId);
  });

  const winner = candidates[0]!;
  const withCandidates: SelectionDecision = { ...base, candidates, effectiveTier: appliedCeiling };

  // An untrusted profile means we do not actually know the volume term. Say so
  // and hold at the floor rather than act on a number we would not defend.
  if (config.holdOnUntrustedProfile && !winner.profileTrusted) {
    const reason = `volume profile for ${appliedCeiling} is not trusted (${profileVerdict.reason})`;
    trace.push(`held at agent floor: ${reason}`);
    return { ...withCandidates, outcome: "held-at-floor", heldReason: reason };
  }

  trace.push(
    `selected ${winner.modelId} at an expected $${winner.expectedCostUsd.toFixed(4)}/run ` +
      `(direct $${winner.runCostUsd.toFixed(4)} = in $${winner.inputCostUsd.toFixed(4)} + ` +
      `cache-read $${winner.cacheReadCostUsd.toFixed(4)} + out $${winner.outputCostUsd.toFixed(4)}; ` +
      `escalation risk $${winner.escalationRiskUsd.toFixed(4)}) — cheapest of ${candidates.length}`,
  );

  if (!config.enforcementEnabled) {
    trace.push("advisory mode: enforcement is off, so this decision is recorded and not written");
  }

  return { ...withCandidates, outcome: "selected", modelId: winner.modelId };
}
