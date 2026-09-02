// src/worker.ts
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

// src/constants.ts
var PLUGIN_VERSION = "0.1.0";
var TOOL_NAMES = {
  /** Advise a tier + model for one issue. Read-only, always safe to call. */
  advise: "model_selection_advise",
  /** Advise and, if enforcement is on for this company, write the override. */
  apply: "model_selection_apply"
};
var ROUTE_KEYS = {
  advise: "advise",
  applyIssue: "apply-issue"
};
var JOB_KEYS = {
  /** Recompute per-tier volume profiles from this company's own runs. */
  refreshProfiles: "refreshVolumeProfiles"
};
var TIER_LABEL_PREFIX = "tier:";
var TIERS = ["T1", "T2", "T3"];
var TIER_ORDER = TIERS;
var PLUGIN_STATE_KEYS = {
  volumeProfiles: "volumeProfiles"
};

// src/actuate/apply.ts
var TERMINAL_STATUSES = /* @__PURE__ */ new Set(["done", "cancelled"]);
function planApply(decision, context, targetIssueId) {
  const nothing = (reason) => ({
    write: false,
    issueId: targetIssueId,
    patch: null,
    labelName: null,
    reason
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
    return nothing(
      "issue already carries assigneeAdapterOverrides; re-pinning would reset the session and discard the prompt cache"
    );
  }
  if (decision.judgement.source === "capability-exclusion") {
    return nothing(
      `capability exclusion applies (${decision.judgement.detail}); leaving the issue at its agent floor rather than pinning`
    );
  }
  const tier2 = decision.effectiveTier;
  return {
    write: true,
    issueId: targetIssueId,
    patch: { assigneeAdapterOverrides: { adapterConfig: { model: decision.modelId } } },
    labelName: context.hasExistingTierLabel || !tier2 ? null : tierLabelName(tier2),
    reason: `pinning ${decision.modelId} at ${tier2} \u2014 ${decision.trace.at(-1) ?? "selected"}`
  };
}
function tierLabelName(tier2) {
  return `${TIER_LABEL_PREFIX}${tier2}`;
}

// src/config/resolve.ts
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function num(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function tier(value, fallback) {
  return typeof value === "string" && TIERS.includes(value) ? value : fallback;
}
function resolveConfig(raw) {
  const root = record(raw);
  const selection = record(root.selection);
  const profiles = record(root.profiles);
  const quality = record(root.quality);
  const models = Array.isArray(root.models) ? root.models.flatMap((entry) => {
    const model = record(entry);
    if (typeof model.id !== "string" || model.id.length === 0) return [];
    return [
      {
        id: model.id,
        tier: tier(model.tier, "T3"),
        enabled: bool(model.enabled, true),
        costPerMTokIn: num(model.costPerMTokIn, 0),
        costPerMTokOut: num(model.costPerMTokOut, 0),
        costPerMTokCacheRead: num(model.costPerMTokCacheRead, 0),
        capabilities: Array.isArray(model.capabilities) ? model.capabilities.filter((c) => typeof c === "string") : [],
        contextWindow: num(model.contextWindow, 2e5)
      }
    ];
  }) : [];
  const rawLabelIds = record(root.tierLabelIds);
  const tierLabelIds = {};
  for (const t of TIERS) {
    const id = rawLabelIds[t];
    if (typeof id === "string" && id.length > 0) tierLabelIds[t] = id;
  }
  return {
    selection: {
      enabled: bool(selection.enabled, true),
      mode: selection.mode === "enforce" ? "enforce" : "advise",
      defaultTier: tier(selection.defaultTier, "T3"),
      stickyModelWithinIssue: bool(selection.stickyModelWithinIssue, true),
      holdOnUntrustedProfile: bool(selection.holdOnUntrustedProfile, true)
    },
    models,
    tierLabelIds,
    profiles: {
      windowDays: num(profiles.windowDays, 7),
      minSamples: num(profiles.minSamples, 5),
      maxAgeDays: num(profiles.maxAgeDays, 14)
    },
    quality: {
      t1EscalationCeiling: num(quality.t1EscalationCeiling, 0.05),
      t2EscalationCeiling: num(quality.t2EscalationCeiling, 0.15),
      silentFailureWeight: num(quality.silentFailureWeight, 10)
    }
  };
}
function validateConfig(config) {
  const errors = [];
  const warnings = [];
  const seen = /* @__PURE__ */ new Set();
  for (const model of config.models) {
    if (seen.has(model.id)) errors.push(`duplicate model id: ${model.id}`);
    seen.add(model.id);
    if (model.costPerMTokCacheRead === 0 && model.costPerMTokIn > 0) {
      warnings.push(
        `${model.id} has costPerMTokCacheRead 0 \u2014 cache read is the largest cost line; a zero rate hides it`
      );
    }
  }
  if (config.selection.enabled && config.models.length === 0) {
    warnings.push("selection is enabled but no models are configured; every decision will be no-eligible-model");
  }
  for (const t of TIERS) {
    if (!config.models.some((model) => model.enabled && model.tier === t)) {
      warnings.push(`no enabled model at tier ${t}`);
    }
  }
  if (config.selection.mode === "enforce" && Object.keys(config.tierLabelIds).length === 0) {
    warnings.push(
      "no tierLabelIds configured; overrides will be written without a tier:* label, because the plugin cannot resolve a label id from its name"
    );
  }
  if (config.selection.mode === "enforce") {
    warnings.push(
      "mode is enforce: this plugin will write assigneeAdapterOverrides. Confirm Stage 2 is stable before running this alongside another live selection change."
    );
  }
  return { errors, warnings };
}

// src/engine/profiles.ts
function buildVolumeProfiles(rows, models, computedAt) {
  const tierOf = new Map(models.map((model) => [model.id, model.tier]));
  const buckets = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const tier2 = row.model ? tierOf.get(row.model) : void 0;
    if (!tier2) continue;
    const input = row.inputTokens ?? 0;
    const cache = row.cachedInputTokens ?? 0;
    const output = row.outputTokens ?? 0;
    if (input === 0 && cache === 0 && output === 0) continue;
    const bucket = buckets.get(tier2) ?? { n: 0, input: 0, cache: 0, output: 0 };
    bucket.n += 1;
    bucket.input += input;
    bucket.cache += cache;
    bucket.output += output;
    buckets.set(tier2, bucket);
  }
  return [...buckets.entries()].map(([tier2, bucket]) => ({
    tier: tier2,
    sampleCount: bucket.n,
    computedAt,
    avgInputTokens: bucket.input / bucket.n,
    avgCacheReadTokens: bucket.cache / bucket.n,
    avgOutputTokens: bucket.output / bucket.n
  }));
}
function buildQualitySignals(rows, computedAt) {
  return rows.map((row) => ({
    tier: row.tier,
    escalationRate: row.issues > 0 ? row.escalations / row.issues : 0,
    silentFailureCount: row.silentFailures,
    sampleCount: row.issues,
    computedAt
  }));
}

// src/engine/cost.ts
var MIN_PROFILE_SAMPLES = 5;
var PROFILE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1e3;
function tierIndex(tier2) {
  return TIER_ORDER.indexOf(tier2);
}
function tierAbove(tier2) {
  return TIER_ORDER[tierIndex(tier2) + 1] ?? null;
}
function resolveProfile(tier2, profiles, now) {
  const profile = profiles.find((entry) => entry.tier === tier2) ?? null;
  if (!profile) {
    return { profile: null, trusted: false, reason: `no volume profile recorded for ${tier2}` };
  }
  if (profile.sampleCount < MIN_PROFILE_SAMPLES) {
    return {
      profile,
      trusted: false,
      reason: `${tier2} profile has ${profile.sampleCount} runs, below the ${MIN_PROFILE_SAMPLES}-run minimum`
    };
  }
  const age = now - Date.parse(profile.computedAt);
  if (!Number.isFinite(age)) {
    return { profile, trusted: false, reason: `${tier2} profile has an unparseable computedAt` };
  }
  if (age > PROFILE_MAX_AGE_MS) {
    const days = Math.round(age / (24 * 60 * 60 * 1e3));
    return { profile, trusted: false, reason: `${tier2} profile is ${days} days old` };
  }
  return { profile, trusted: true, reason: `${tier2} profile: ${profile.sampleCount} runs` };
}
function runCost(model, profile) {
  const inputCostUsd = profile.avgInputTokens / 1e6 * model.costPerMTokIn;
  const cacheReadCostUsd = profile.avgCacheReadTokens / 1e6 * model.costPerMTokCacheRead;
  const outputCostUsd = profile.avgOutputTokens / 1e6 * model.costPerMTokOut;
  return {
    inputCostUsd,
    cacheReadCostUsd,
    outputCostUsd,
    runCostUsd: inputCostUsd + cacheReadCostUsd + outputCostUsd
  };
}
function escalationRisk(tier2, models, profiles, signals, now) {
  const above = tierAbove(tier2);
  if (!above) return 0;
  const signal = signals.find((entry) => entry.tier === tier2);
  if (!signal || signal.sampleCount <= 0) return 0;
  const silentRate = signal.silentFailureCount * 10 / signal.sampleCount;
  const effectiveRate = Math.min(1, Math.max(0, signal.escalationRate) + silentRate);
  if (effectiveRate <= 0) return 0;
  const verdict = resolveProfile(above, profiles, now);
  if (!verdict.profile) return 0;
  const redo = models.filter((model) => model.enabled && model.tier === above).map((model) => runCost(model, verdict.profile).runCostUsd).sort((left, right) => left - right)[0];
  return redo === void 0 ? 0 : redo * effectiveRate;
}
function costOf(model, profileTier, profiles, models, signals, now) {
  const verdict = resolveProfile(profileTier, profiles, now);
  if (!verdict.profile) return null;
  const direct = runCost(model, verdict.profile);
  const escalationRiskUsd = escalationRisk(model.tier, models, profiles, signals, now);
  return {
    modelId: model.id,
    ...direct,
    escalationRiskUsd,
    expectedCostUsd: direct.runCostUsd + escalationRiskUsd,
    profileTier,
    profileTrusted: verdict.trusted
  };
}

// src/engine/tier.ts
function isTier(value) {
  return TIERS.includes(value);
}
function tierFromLabels(labelNames) {
  if (!labelNames) return null;
  const found = [];
  for (const name of labelNames) {
    if (!name.startsWith(TIER_LABEL_PREFIX)) continue;
    const suffix = name.slice(TIER_LABEL_PREFIX.length);
    if (isTier(suffix)) found.push(suffix);
  }
  if (found.length === 0) return null;
  return found.sort((left, right) => TIERS.indexOf(right) - TIERS.indexOf(left))[0];
}
function tierOfModel(modelId, models) {
  if (!modelId) return null;
  return models.find((model) => model.id === modelId)?.tier ?? null;
}
function resolveTier(descriptor, models, configDefaultTier) {
  if (descriptor.exclusion?.excluded) {
    return {
      tier: "T3",
      source: "capability-exclusion",
      detail: `capability exclusion forces T3: ${descriptor.exclusion.reasons.join("; ") || "unspecified"}`
    };
  }
  const pinnedTier = tierOfModel(descriptor.pinnedModelId, models);
  if (pinnedTier) {
    return {
      tier: pinnedTier,
      source: "issue-override",
      detail: `assigneeAdapterOverrides pins ${descriptor.pinnedModelId} (${pinnedTier})`
    };
  }
  const labelTier = tierFromLabels(descriptor.labelNames);
  if (labelTier) {
    return { tier: labelTier, source: "issue-label", detail: `${TIER_LABEL_PREFIX}${labelTier} label on the issue` };
  }
  const floorTier = tierOfModel(descriptor.agentFloorModelId, models);
  if (floorTier) {
    return {
      tier: floorTier,
      source: "agent-floor",
      detail: `no issue-level judgement; assignee floor ${descriptor.agentFloorModelId} (${floorTier})`
    };
  }
  return {
    tier: configDefaultTier,
    source: "config-default",
    detail: `no judgement and no recognised agent floor; config default ${configDefaultTier}`
  };
}

// src/engine/select.ts
function selectModel(input) {
  const { descriptor, config, profiles, signals, now } = input;
  const trace = [];
  const rejections = [];
  const judgement = resolveTier(descriptor, config.models, config.defaultTier);
  trace.push(`tier ${judgement.tier} via ${judgement.source} \u2014 ${judgement.detail}`);
  const base = {
    outcome: "no-eligible-model",
    modelId: null,
    judgement,
    effectiveTier: null,
    candidates: [],
    rejections,
    trace,
    advisory: !config.enforcementEnabled,
    heldReason: null
  };
  if (config.models.length === 0) {
    trace.push("no models configured for this company");
    return { ...base, outcome: "disabled" };
  }
  const floor = judgement.source === "capability-exclusion" ? judgement.tier : null;
  if (floor) {
    trace.push(`tier floor ${floor}: capability exclusion, no model below ${floor} is eligible`);
  }
  if (config.stickyWithinIssue && descriptor.stickyModelId) {
    const incumbent = config.models.find(
      (model) => model.id === descriptor.stickyModelId && model.enabled
    );
    if (incumbent && floor && tierIndex(incumbent.tier) < tierIndex(floor)) {
      trace.push(
        `sticky ${incumbent.id} (${incumbent.tier}) declined: below the ${floor} capability floor`
      );
      rejections.push({
        modelId: incumbent.id,
        stage: "tier-floor",
        reason: `tier ${incumbent.tier} is below the ${floor} capability floor`
      });
    } else if (incumbent) {
      trace.push(
        `sticky: ${incumbent.id} is already running this issue \u2014 switching would reset the session and discard the prompt cache`
      );
      return { ...base, outcome: "selected", modelId: incumbent.id, effectiveTier: incumbent.tier };
    }
  }
  const ceiling = judgement.tier;
  const required = new Set(descriptor.requiredCapabilities ?? []);
  if (required.size > 0) {
    trace.push(`hard capability gate: ${[...required].sort().join(", ")}`);
  }
  const qualified = [];
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
        reason: `missing ${missing.sort().join(", ")}`
      });
      continue;
    }
    if (floor && tierIndex(model.tier) < tierIndex(floor)) {
      rejections.push({
        modelId: model.id,
        stage: "tier-floor",
        reason: `tier ${model.tier} is below the ${floor} capability floor`
      });
      continue;
    }
    if (typeof descriptor.requiredContextTokens === "number" && model.contextWindow < descriptor.requiredContextTokens) {
      rejections.push({
        modelId: model.id,
        stage: "context-window",
        reason: `context window ${model.contextWindow} < required ${descriptor.requiredContextTokens}`
      });
      continue;
    }
    qualified.push(model);
  }
  if (qualified.length === 0) {
    trace.push(`no model cleared the gates (${rejections.length} rejected)`);
    return base;
  }
  let appliedCeiling = ceiling;
  if (!qualified.some((model) => tierIndex(model.tier) <= tierIndex(ceiling))) {
    const lowestQualified = qualified.reduce(
      (lowest, model) => tierIndex(model.tier) < tierIndex(lowest.tier) ? model : lowest
    );
    trace.push(
      `ceiling ${ceiling} lifted to ${lowestQualified.tier}: nothing at or below ${ceiling} clears the capability gate`
    );
    appliedCeiling = lowestQualified.tier;
  }
  const survivors = qualified.filter((model) => {
    if (tierIndex(model.tier) <= tierIndex(appliedCeiling)) return true;
    rejections.push({
      modelId: model.id,
      stage: "tier-ceiling",
      reason: `tier ${model.tier} exceeds ceiling ${appliedCeiling}`
    });
    return false;
  });
  const profileVerdict = resolveProfile(appliedCeiling, profiles, now);
  trace.push(`volume profile: ${profileVerdict.reason}`);
  const candidates = [];
  for (const model of survivors) {
    const cost = costOf(model, appliedCeiling, profiles, config.models, signals, now);
    if (!cost) {
      rejections.push({
        modelId: model.id,
        stage: "no-profile",
        reason: `no volume profile for ${appliedCeiling}; cannot cost this candidate`
      });
      continue;
    }
    candidates.push({ ...cost, tier: model.tier });
  }
  if (candidates.length === 0) {
    trace.push("no candidate could be costed \u2014 refusing to choose on a guessed volume term");
    return { ...base, effectiveTier: appliedCeiling };
  }
  candidates.sort((left, right) => {
    if (left.expectedCostUsd !== right.expectedCostUsd) {
      return left.expectedCostUsd - right.expectedCostUsd;
    }
    if (left.tier !== right.tier) return tierIndex(right.tier) - tierIndex(left.tier);
    return left.modelId.localeCompare(right.modelId);
  });
  const winner = candidates[0];
  const withCandidates = { ...base, candidates, effectiveTier: appliedCeiling };
  if (config.holdOnUntrustedProfile && !winner.profileTrusted) {
    const reason = `volume profile for ${appliedCeiling} is not trusted (${profileVerdict.reason})`;
    trace.push(`held at agent floor: ${reason}`);
    return { ...withCandidates, outcome: "held-at-floor", heldReason: reason };
  }
  trace.push(
    `selected ${winner.modelId} at an expected $${winner.expectedCostUsd.toFixed(4)}/run (direct $${winner.runCostUsd.toFixed(4)} = in $${winner.inputCostUsd.toFixed(4)} + cache-read $${winner.cacheReadCostUsd.toFixed(4)} + out $${winner.outputCostUsd.toFixed(4)}; escalation risk $${winner.escalationRiskUsd.toFixed(4)}) \u2014 cheapest of ${candidates.length}`
  );
  if (!config.enforcementEnabled) {
    trace.push("advisory mode: enforcement is off, so this decision is recorded and not written");
  }
  return { ...withCandidates, outcome: "selected", modelId: winner.modelId };
}

// src/worker.ts
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function summary(decision) {
  if (decision.outcome === "selected") {
    return `${decision.modelId} at ${decision.effectiveTier} (tier via ${decision.judgement.source})${decision.advisory ? " \u2014 advisory, nothing written" : ""}`;
  }
  if (decision.outcome === "held-at-floor") {
    return `Held at the agent floor: ${decision.heldReason}`;
  }
  if (decision.outcome === "disabled") return "Model Selection is not configured for this company.";
  return "No eligible model for this issue.";
}
function createPlugin() {
  let context = null;
  return definePlugin({
    multiCompanyConfig: true,
    async setup(ctx) {
      context = ctx;
      const companyConfig = async (companyId) => resolveConfig(await ctx.config.get(companyId));
      const profilesKey = (companyId) => ({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.volumeProfiles
      });
      const readProfiles = async (companyId) => {
        const stored = asRecord(await ctx.state.get(profilesKey(companyId)));
        return {
          profiles: Array.isArray(stored.profiles) ? stored.profiles : [],
          signals: Array.isArray(stored.signals) ? stored.signals : []
        };
      };
      const describeIssue = async (companyId, issueId, supplied) => {
        const issue = await ctx.issues.get(issueId, companyId);
        if (!issue) return null;
        const overrides = asRecord(issue.assigneeAdapterOverrides);
        const adapterConfig = asRecord(overrides.adapterConfig);
        const pinnedModelId = typeof adapterConfig.model === "string" ? adapterConfig.model : null;
        const labels = issue.labels ?? [];
        const labelNames = labels.map((label) => label.name).filter((name) => typeof name === "string");
        let agentFloorModelId = null;
        const assigneeAgentId = issue.assigneeAgentId;
        if (typeof assigneeAgentId === "string") {
          try {
            const agent = await ctx.agents.get(assigneeAgentId, companyId);
            const config = asRecord(asRecord(agent).adapterConfig);
            if (typeof config.model === "string") agentFloorModelId = config.model;
          } catch {
          }
        }
        const exclusionRaw = asRecord(supplied.exclusion);
        const descriptor = {
          issueId,
          labelNames,
          pinnedModelId,
          agentFloorModelId,
          // Sticky is derived from the pin: if the issue is already pinned, the
          // run is already on that model and a change would reset the session.
          stickyModelId: pinnedModelId,
          requiredCapabilities: Array.isArray(supplied.requiredCapabilities) ? supplied.requiredCapabilities : void 0,
          requiredContextTokens: typeof supplied.requiredContextTokens === "number" ? supplied.requiredContextTokens : void 0,
          ...typeof exclusionRaw.excluded === "boolean" ? {
            exclusion: {
              excluded: exclusionRaw.excluded,
              reasons: Array.isArray(exclusionRaw.reasons) ? exclusionRaw.reasons : []
            }
          } : {}
        };
        const existingLabelIds = issue.labelIds ?? labels.map((label) => label.id).filter((id) => typeof id === "string");
        return {
          descriptor,
          status: String(issue.status ?? ""),
          hasOverride: Object.keys(overrides).length > 0,
          existingLabelIds,
          hasTierLabel: labelNames.some((name) => name.startsWith(TIER_LABEL_PREFIX))
        };
      };
      const advise = async (companyId, params) => {
        const issueId = typeof params.issueId === "string" ? params.issueId : null;
        if (!issueId) return null;
        const config = await companyConfig(companyId);
        const described = await describeIssue(companyId, issueId, params);
        if (!described) return null;
        const { profiles, signals } = await readProfiles(companyId);
        const decision = selectModel({
          descriptor: described.descriptor,
          config: {
            enforcementEnabled: config.selection.enabled && config.selection.mode === "enforce",
            defaultTier: config.selection.defaultTier,
            models: config.models,
            holdOnUntrustedProfile: config.selection.holdOnUntrustedProfile,
            stickyWithinIssue: config.selection.stickyModelWithinIssue
          },
          profiles,
          signals,
          now: Date.now()
        });
        await ctx.metrics.write(`model_selection.decision.${decision.outcome}`, 1);
        return {
          decision,
          issueId,
          status: described.status,
          hasOverride: described.hasOverride,
          existingLabelIds: described.existingLabelIds,
          hasTierLabel: described.hasTierLabel,
          config
        };
      };
      ctx.tools.register(
        TOOL_NAMES.advise,
        {
          displayName: "Advise a model for an issue",
          description: "Return the tier judgement and costed candidates for one issue. Writes nothing.",
          parametersSchema: { type: "object" }
        },
        async (params, runCtx) => {
          const result = await advise(runCtx.companyId, asRecord(params));
          if (!result) return { content: "Issue not found, or issueId was missing.", data: null };
          return { content: summary(result.decision), data: result.decision };
        }
      );
      ctx.tools.register(
        TOOL_NAMES.apply,
        {
          displayName: "Apply a model selection to an issue",
          description: "Advise, then write the per-issue override and tier label when enforcement is on. No-ops on an issue that already has an override.",
          parametersSchema: { type: "object" }
        },
        async (params, runCtx) => {
          const result = await advise(runCtx.companyId, asRecord(params));
          if (!result) return { content: "Issue not found, or issueId was missing.", data: null };
          const plan = planApply(
            result.decision,
            {
              hasExistingOverride: result.hasOverride,
              // Read from the issue's actual labels, not from the judgement
              // source. An issue can carry a tier label that did NOT key this
              // decision (an override outranks it), and inferring "has a label"
              // from "the label decided it" would re-add a duplicate.
              hasExistingTierLabel: result.hasTierLabel,
              status: result.status
            },
            result.issueId
          );
          if (!plan.write || !plan.patch) {
            return { content: `No write: ${plan.reason}`, data: { decision: result.decision, plan } };
          }
          const patch = { ...plan.patch };
          let labelNote = "";
          if (plan.labelName && result.decision.effectiveTier) {
            const labelId = result.config.tierLabelIds[result.decision.effectiveTier];
            if (labelId) {
              patch.labelIds = [.../* @__PURE__ */ new Set([...result.existingLabelIds, labelId])];
            } else {
              labelNote = ` (no configured label id for ${plan.labelName}; override written without it)`;
            }
          }
          await ctx.issues.update(
            result.issueId,
            patch,
            runCtx.companyId,
            { actorAgentId: runCtx.agentId ?? null, actorRunId: runCtx.runId ?? null }
          );
          await ctx.activity.log({
            companyId: runCtx.companyId,
            message: `Model Selection pinned ${result.decision.modelId} (${result.decision.effectiveTier}) on this issue`,
            entityType: "issue",
            entityId: result.issueId,
            metadata: {
              modelId: result.decision.modelId,
              tier: result.decision.effectiveTier,
              tierSource: result.decision.judgement.source,
              trace: result.decision.trace
            }
          });
          return { content: plan.reason + labelNote, data: { decision: result.decision, plan } };
        }
      );
      ctx.jobs.register(JOB_KEYS.refreshProfiles, async () => {
        const companies = await ctx.companies.list();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            if (config.models.length === 0) continue;
            const rows = await ctx.db.query(
              `select usage_json->>'model' as model,
                      (usage_json->>'inputTokens')::numeric as input_tokens,
                      (usage_json->>'cachedInputTokens')::numeric as cached_input_tokens,
                      (usage_json->>'outputTokens')::numeric as output_tokens
                 from heartbeat_runs
                where company_id = $1
                  and started_at > now() - ($2 || ' days')::interval
                  and status = 'succeeded'
                  and (usage_json->>'costUsd')::numeric > 0`,
              [company.id, String(config.profiles.windowDays)]
            );
            const runRows = (Array.isArray(rows) ? rows : []).map((row) => {
              const r = asRecord(row);
              return {
                model: typeof r.model === "string" ? r.model : null,
                inputTokens: Number(r.input_tokens ?? 0),
                cachedInputTokens: Number(r.cached_input_tokens ?? 0),
                outputTokens: Number(r.output_tokens ?? 0)
              };
            });
            const computedAt = (/* @__PURE__ */ new Date()).toISOString();
            const profiles = buildVolumeProfiles(runRows, config.models, computedAt);
            const existing = await readProfiles(company.id);
            await ctx.state.set(profilesKey(company.id), {
              profiles,
              // Quality signals are refreshed by their own measurement path;
              // preserve whatever is stored rather than zeroing it here, which
              // would silently drop the escalation term to zero.
              signals: existing.signals
            });
            ctx.logger.info("volume profiles refreshed", {
              companyId: company.id,
              tiers: profiles.map((p) => `${p.tier}:${p.sampleCount}`).join(",")
            });
          } catch (cause) {
            ctx.logger.error("volume profile refresh failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause)
            });
          }
        }
      });
      ctx.logger.info("Model Selection worker ready", { version: PLUGIN_VERSION });
    },
    async onHealth() {
      return { status: "ok", message: `Model Selection ${PLUGIN_VERSION}` };
    },
    async onValidateConfig(raw) {
      const { errors, warnings } = validateConfig(resolveConfig(raw));
      return { ok: errors.length === 0, errors, warnings };
    },
    async onApiRequest(input) {
      if (!context) return { status: 503, body: { error: "worker is not initialised" } };
      if (input.routeKey !== ROUTE_KEYS.advise && input.routeKey !== ROUTE_KEYS.applyIssue) {
        return { status: 404, body: { error: `unknown route ${input.routeKey}` } };
      }
      return { status: 501, body: { error: "use the registered tools; the HTTP surface is reserved" } };
    }
  });
}
var plugin = createPlugin();
var worker_default = plugin;
runWorker(plugin, import.meta.url);
export {
  createPlugin,
  worker_default as default
};
//# sourceMappingURL=worker.js.map
