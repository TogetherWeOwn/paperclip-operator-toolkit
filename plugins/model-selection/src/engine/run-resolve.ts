import { TIER_LABEL_PREFIX, type Tier } from "../constants.js";
import type { ResolvedConfig } from "../config/resolve.js";
import { recoverSelectedCandidate } from "../aa-free/sync.js";
import { normalizeAvailability } from "./availability.js";
import {
  ANCILLARY_MODEL_ENV_KEYS,
  CONTEXT_LIMIT_ENV_KEY,
  MIN_STAMPED_CONTEXT_TOKENS,
  PIN_LANE_MODEL_ENV_KEYS,
  cheapestHealthyModelIdForTier,
  estimateIssueContext,
} from "./context.js";
import { effortConfigKeyFor, resolveEffortPin, inheritedEffortFrom } from "./effort.js";
import type { LaneEvidenceSnapshot } from "./lane-evidence.js";
import { isAdapterBlockedModel, resolveConfiguredModelId } from "./model-id.js";
import {
  activeOperatorOverride,
  activeZaiPaceOverride,
  type LaneLedger,
  type LaneOutageOverride,
  type OperatorOverrideLedger,
  type ZaiPaceOverride,
} from "./pacing.js";
import { applyDerivedTiers } from "./scores.js";
import { selectModel } from "./select.js";
import type { SelectionConfig } from "./select.js";
import { resolveTier } from "./tier.js";
import type {
  CardLedgerEntry,
  IssueDescriptor,
  ModelEntry,
  ModelScore,
  QualitySignal,
  SelectionDecision,
  VolumeProfile,
} from "./types.js";

/**
 * the run-scoped model decision.
 *
 * Everything in this file is pure. The worker owns every read and hands this
 * module a frozen view of the hot caches, so the decision itself performs no
 * IO and its latency is the selection engine's own (a few ms over the roster),
 * which is what the p99 <= 250 ms budget in §6 depends on.
 *
 * The wire types below mirror the fork's `ResolveRunModelParams` /
 * `ResolveRunModelResult`.
 * They are declared here because the SDK this package builds against
 * (2026.824.1) predates the hook; the host's own validator is the authority.
 */
export interface ResolveRunModelParams {
  runId: string;
  companyId: string;
  agentId: string;
  issueId: string | null;
  adapterType: string;
  invocationSource: string;
  wakeReason: string | null;
  agentDefaultModel: string | null;
  previous: { runId: string; model: string | null; decisionId: string | null } | null;
  issueOverrideModel: string | null;
  deadlineMs: number;
}

export type ResolveRunModelResult =
  | {
      kind: "decide";
      decisionId: string;
      model: string;
      effort?: string;
      env?: Record<string, string>;
      tier?: string;
      source: string;
      fallback?: boolean;
      reason?: string;
    }
  | { kind: "keep" }
  | { kind: "defer"; retryAfterMs: number; reason: string };

/**
 * Plain env keys a decision may set. Declared in the manifest as
 * `modelRouting.envKeys`; the host rejects any key outside that list, and any
 * key that is a secret binding in the base config. Never an agent-env key
 * beyond these: every one is a model-valued surface or the context cap this
 * plugin has always owned.
 */
export const RUN_RESOLVE_ENV_KEYS: readonly string[] = [
  CONTEXT_LIMIT_ENV_KEY,
  ...PIN_LANE_MODEL_ENV_KEYS,
  ...ANCILLARY_MODEL_ENV_KEYS,
];

export type TierSource = "label" | "classifier" | "heuristic";

/** What the host recorded for a previous decision (`contextSnapshot.modelDecision`). */
export interface RunDecisionRecord {
  decisionId: string | null;
  model: string;
  /** `null` when the record predates tier recording: the tier-change switch cannot fire. */
  tier: Tier | null;
  fallback: boolean;
}

export interface RunIssueFacts {
  labelNames: readonly string[];
  priority: string | null;
  title: string;
  status: string;
}

export interface RunAgentFacts {
  name: string | null;
  adapterConfig: Record<string, unknown>;
}

/** Frozen hot-cache view for one company. Nothing here is read on the decision path. */
export interface RunResolveSnapshot {
  config: ResolvedConfig;
  profiles: readonly VolumeProfile[];
  signals: readonly QualitySignal[];
  laneLedger: LaneLedger;
  operatorOverrides: OperatorOverrideLedger;
  cardLedger: Readonly<Record<string, CardLedgerEntry>>;
  modelScores: Readonly<Record<string, ModelScore>>;
  laneOutageOverride: LaneOutageOverride | null;
  zaiPaceOverride: ZaiPaceOverride | null;
  pinsWeightByLane: Readonly<Record<string, number>>;
  /** Raw published quota document; normalized per decision so staleness is judged at decision time. */
  availabilityRaw: unknown;
  laneEvidence: LaneEvidenceSnapshot;
  /** When the snapshot was assembled, for the staleness metric. */
  loadedAtMs: number;
}

export type SwitchReason =
  | "first-decision"
  | "tier-changed"
  | "unserviceable"
  | "primary-recovered";

export interface RunResolveInput {
  params: ResolveRunModelParams;
  issue: RunIssueFacts;
  agent: RunAgentFacts;
  snapshot: RunResolveSnapshot;
  prior: RunDecisionRecord | null;
  /** Tier a still-in-flight classification just produced, when the card has no label yet. */
  classifiedTier: Tier | null;
  /** The previous run's measured single-turn peak, from the lazily-warmed cache. */
  lastRunPeakTokens: number | null;
  now: number;
  /** Test seam only: returns the decision id (default: a random UUID). */
  newDecisionId?: () => string;
}

export type RunResolution =
  | {
      kind: "decide";
      result: Extract<ResolveRunModelResult, { kind: "decide" }>;
      /** Present on every switch away from `previous.model`, and on the first decision. */
      switch: { from: string | null; to: string; reason: SwitchReason; detail: string } | null;
      tier: Tier;
      tierSource: TierSource;
      trace: readonly string[];
    }
  | { kind: "keep"; reason: string }
  | { kind: "defer"; reason: string };

/**
 * Same field-for-field assembly `advise` hands `selectModel`
 * (`worker.ts`), minus the per-issue reads. `advise` stays untouched; the
 * parity spec (`tests/run-resolve.spec.ts`) runs both on identical state and
 * fails if they ever pick differently.
 */
export function buildRunSelectionConfig(
  snapshot: RunResolveSnapshot,
  issueId: string,
  nowIso: string,
  now: number,
  sticky: boolean,
): SelectionConfig {
  const { config } = snapshot;
  const liveOverride = activeOperatorOverride(snapshot.operatorOverrides, issueId, nowIso);
  return {
    // The handler is only reached on an enforcing install, and a run-scoped
    // decision is never written durably, so no decision is forced advisory.
    enforcementEnabled: true,
    defaultTier: config.selection.defaultTier,
    models: applyDerivedTiers(config.models, snapshot.modelScores),
    holdOnUntrustedProfile: config.selection.holdOnUntrustedProfile,
    stickyWithinIssue: sticky,
    pacingMode: config.pacing.mode,
    laneLedger: snapshot.laneLedger,
    slotFloorFraction: config.pacing.slotFloorFraction,
    operatorOverrideModelId: liveOverride?.modelId ?? null,
    laneAvoidConfig: config.pacing.avoid,
    codexLaneId: config.pacing.codexLaneId,
    opencodeGoLaneId: config.pacing.opencodeGoLaneId,
    zaiLaneId: config.pacing.zai.laneId,
    laneOutageOverride: snapshot.laneOutageOverride,
    laneRoom: {
      capPerAccount: config.pacing.laneCapPerAccount,
      activePinsWeightByLane: snapshot.pinsWeightByLane,
      fiveHourWindowName: config.pacing.fiveHourWindowName,
      zaiLaneId: config.pacing.zai.laneId,
      zaiWeeklyWindowName: config.pacing.zai.weeklyWindowName,
      zaiWeeklyDefaultMargin: config.pacing.zai.weeklyDefaultMargin,
      zaiPaceOverrideMargin: activeZaiPaceOverride(snapshot.zaiPaceOverride, nowIso),
      now,
    },
    objective: config.selection.objective,
    modelScores: snapshot.modelScores,
    // A decision at a run boundary re-affirms or replaces, it does not seed
    // evidence: the same rule every pinned-branch pass applies.
    allowExplore: false,
    holdOnUnknownAvailability: config.selection.holdOnUnknownAvailability,
    wakeScopedFloor: config.wakeScopedFloor,
  };
}

function isFallbackDecision(decision: SelectionDecision, model: ModelEntry | undefined): boolean {
  return decision.escalatedFromTier !== null || model?.fallbackOnly === true;
}

function rejectionFor(decision: SelectionDecision, modelId: string): string {
  const rejection = decision.rejections.find((entry) => entry.modelId === modelId);
  return rejection ? `${rejection.stage}: ${rejection.reason}` : "declined by the selection engine";
}

/**
 * Plain env for the decided model, per key. Mirrors the model-valued part of
 * `modelOverrideForContext` but returns ONLY keys it writes: nothing is copied
 * from the agent env, and a key the agent binds to a secret is skipped (the
 * host would reject the whole decision for it).
 */
export function runDecisionEnv(input: {
  model: Pick<ModelEntry, "id" | "contextWindow">;
  cheapModelId: string | null;
  adapterType: string | null;
  agentEnv: Record<string, unknown>;
  agentEnvContextTokens: number;
  compactionRatio: number;
}): Record<string, string> {
  const env: Record<string, string> = {};
  const secretBound = (key: string): boolean => {
    const entry = input.agentEnv[key];
    if (!entry || typeof entry !== "object") return false;
    const type = (entry as Record<string, unknown>).type;
    return type === "secret_ref" || type === "user_secret_ref";
  };
  const set = (key: string, value: string): void => {
    if (!RUN_RESOLVE_ENV_KEYS.includes(key) || secretBound(key)) return;
    env[key] = value;
  };

  const window = Number.isFinite(input.model.contextWindow) && input.model.contextWindow > 0
    ? Math.floor(input.model.contextWindow)
    : null;
  const cap = Number.isFinite(input.agentEnvContextTokens) && input.agentEnvContextTokens > 0
    ? Math.floor(input.agentEnvContextTokens)
    : null;
  const ratio = input.compactionRatio > 0 && input.compactionRatio < 1 ? input.compactionRatio : 0.75;
  if (cap !== null && window !== null && window < cap) {
    set(
      CONTEXT_LIMIT_ENV_KEY,
      String(Math.max(Math.floor(window * ratio), Math.min(window, MIN_STAMPED_CONTEXT_TOKENS))),
    );
  }

  if (!isAdapterBlockedModel(input.model.id, input.adapterType)) {
    for (const key of PIN_LANE_MODEL_ENV_KEYS) set(key, input.model.id);
    const cheapPick = input.cheapModelId || input.model.id;
    const cheapId = isAdapterBlockedModel(cheapPick, input.adapterType) ? input.model.id : cheapPick;
    for (const key of ANCILLARY_MODEL_ENV_KEYS) set(key, cheapId);
  }
  return env;
}

/**
 * The decision, sticky rule included (§4.3):
 *
 *  keep `prior.model` unless
 *   - it is unserviceable (the engine's own sticky probe declines it: lane hard
 *     stop, availability, evidence, context window, adapter, tier floor), or
 *   - it was a fallback and the primary pick is serviceable again, or
 *   - the tier changed.
 *
 * Every switch carries its reason. No prior decision means there is nothing to
 * be sticky to: a first decision, not a switch.
 */
export function resolveRunDecision(input: RunResolveInput): RunResolution {
  const { params, issue, agent, snapshot, prior, now } = input;
  const issueId = params.issueId;
  if (!issueId) return { kind: "keep", reason: "non-issue run" };

  const { config } = snapshot;
  if (config.models.length === 0) return { kind: "keep", reason: "no models configured" };

  // an override whose model is gone from the roster (retired row,
  // e.g. a bridge model added then removed) or disabled is an orphan, not a
  // judgement. Honoring it would keep the run on a model id with no enabled
  // roster row; fall through to the fresh per-run decision instead. A live
  // override on an enabled row still wins outright, same as before.
  if (params.issueOverrideModel) {
    const liveOverride = resolveConfiguredModelId(params.issueOverrideModel, config.models);
    if (liveOverride && config.models.some((model) => model.id === liveOverride && model.enabled)) {
      return { kind: "keep", reason: "issue carries an override model" };
    }
  }

  const nowIso = new Date(now).toISOString();
  const hasTierLabel = issue.labelNames.some((name) => name.startsWith(TIER_LABEL_PREFIX));
  const descriptorBase: IssueDescriptor = {
    issueId,
    labelNames:
      !hasTierLabel && input.classifiedTier
        ? [...issue.labelNames, `${TIER_LABEL_PREFIX}${input.classifiedTier}`]
        : issue.labelNames,
    pinnedModelId: null,
    agentFloorModelId: params.agentDefaultModel,
    agentAdapterType: params.adapterType,
    priority: issue.priority,
    title: issue.title,
    agentName: agent.name,
    wakeReason: params.wakeReason ?? undefined,
  };

  const estimate = estimateIssueContext({
    lastRunPeakTokens: input.lastRunPeakTokens,
    history: prior || params.previous ? "run-found" : "no-history",
    fleetCeilingTokens: config.selection.fleetContextCeilingTokens,
  });
  if (estimate.tokens !== null) descriptorBase.requiredContextTokens = estimate.tokens;

  const availability = normalizeAvailability(snapshot.availabilityRaw, now);
  const selectWith = (stickyModelId: string | null): SelectionDecision =>
    selectModel({
      descriptor: { ...descriptorBase, stickyModelId },
      config: buildRunSelectionConfig(snapshot, issueId, nowIso, now, stickyModelId !== null),
      profiles: snapshot.profiles,
      signals: snapshot.signals,
      now,
      cardLedger: snapshot.cardLedger,
      availability,
      laneEvidence: snapshot.laneEvidence,
    });

  const fresh = selectWith(null);
  const currentTier = fresh.judgement.tier;
  const tierSource: TierSource =
    fresh.judgement.source === "issue-label"
      ? hasTierLabel
        ? "label"
        : "classifier"
      : "heuristic";

  const defer = (why: string, decision: SelectionDecision): RunResolution => ({
    kind: "defer",
    reason: `${why} (${decision.outcome}${decision.trace.length ? `: ${decision.trace[decision.trace.length - 1]}` : ""})`,
  });
  // `held-at-floor`/`disabled` are the engine saying "the agent default is the
  // answer"; `no-eligible-model`/`tier-exhausted` are "nothing may run": park.
  const unselected = (decision: SelectionDecision): RunResolution | null => {
    if (decision.outcome === "selected" && decision.modelId) return null;
    if (decision.outcome === "held-at-floor" || decision.outcome === "disabled") {
      return { kind: "keep", reason: `${decision.outcome}: ${decision.trace[decision.trace.length - 1] ?? ""}` };
    }
    return defer("no serviceable model", decision);
  };

  let chosen: SelectionDecision = fresh;
  let switchInfo: { from: string | null; to: string; reason: SwitchReason; detail: string } | null = null;
  const priorModelId = prior ? resolveConfiguredModelId(prior.model, config.models) ?? prior.model : null;

  if (!prior || !priorModelId) {
    const out = unselected(fresh);
    if (out) return out;
    switchInfo = {
      from: params.previous?.model ?? null,
      to: fresh.modelId as string,
      reason: "first-decision",
      detail: "no prior routed decision on this issue and agent",
    };
  } else {
    const probe = selectWith(priorModelId);
    const probeKeeps = probe.outcome === "selected" && probe.modelId === priorModelId;
    const out = unselected(fresh);
    if (prior.tier !== null && prior.tier !== currentTier) {
      if (out) return out;
      if (fresh.modelId !== priorModelId) {
        chosen = fresh;
        switchInfo = {
          from: priorModelId,
          to: fresh.modelId as string,
          reason: "tier-changed",
          detail: `tier ${prior.tier} -> ${currentTier} (${tierSource})`,
        };
      }
    } else if (!probeKeeps) {
      const probeOut = unselected(probe);
      if (probeOut) return probeOut;
      chosen = probe;
      switchInfo = {
        from: priorModelId,
        to: probe.modelId as string,
        reason: "unserviceable",
        detail: rejectionFor(probe, priorModelId),
      };
    } else if (prior.fallback && !out) {
      const freshModel = config.models.find((model) => model.id === fresh.modelId);
      if (!isFallbackDecision(fresh, freshModel) && fresh.modelId !== priorModelId) {
        chosen = fresh;
        switchInfo = {
          from: priorModelId,
          to: fresh.modelId as string,
          reason: "primary-recovered",
          detail: `fallback ${priorModelId} replaced: primary ${fresh.modelId} is serviceable again`,
        };
      } else {
        chosen = probe;
      }
    } else {
      chosen = probe;
    }
  }

  const selectedModel = recoverSelectedCandidate(config.models, chosen);
  if (!selectedModel) return defer("selected model is not in the roster", chosen);
  const roster = config.models.find((model) => model.id === selectedModel.id);

  const cheapModelId = cheapestHealthyModelIdForTier({
    models: config.models,
    tier: "T3",
    ledger: snapshot.laneLedger,
    laneOutageOverride: snapshot.laneOutageOverride,
    nowIso,
    modelScores: snapshot.modelScores,
    laneAvoidConfig: config.pacing.avoid,
    pacingMode: config.pacing.mode,
  });
  const agentEnv =
    agent.adapterConfig.env && typeof agent.adapterConfig.env === "object" && !Array.isArray(agent.adapterConfig.env)
      ? (agent.adapterConfig.env as Record<string, unknown>)
      : {};
  const env = runDecisionEnv({
    model: selectedModel,
    cheapModelId,
    adapterType: params.adapterType,
    agentEnv,
    agentEnvContextTokens: config.selection.agentEnvContextTokens,
    compactionRatio: config.selection.compactionRatio,
  });

  // The host carries one `effort` key. Only the adapter whose effort key IS
  // `effort` can express the pair; the rest keep their inherited effort and
  // the trace says so rather than pretend.
  const effortPin = resolveEffortPin({
    adapterType: params.adapterType,
    modelId: selectedModel.id,
    rosterEffort: selectedModel.effort,
    inheritedEffort: inheritedEffortFrom(params.adapterType, agent.adapterConfig),
  });
  const effort =
    effortConfigKeyFor(params.adapterType) === "effort" && typeof effortPin.writes.effort === "string" && effortPin.writes.effort
      ? effortPin.writes.effort
      : undefined;

  const effectiveTier = chosen.effectiveTier ?? currentTier;
  // A kept incumbent comes back from the engine's sticky branch, which never
  // sets `escalatedFromTier`: it would read as a primary and the next run would
  // never revisit a fallback it is still sitting on. A kept model keeps the
  // status it was decided with.
  const keptPrior = prior !== null && switchInfo === null && priorModelId === selectedModel.id;
  const fallback = keptPrior ? prior.fallback : isFallbackDecision(chosen, roster);
  const decisionId = (input.newDecisionId ?? (() => globalThis.crypto.randomUUID()))();
  const reason = switchInfo
    ? `${switchInfo.reason}: ${switchInfo.detail}`
    : `sticky: ${selectedModel.id} still serviceable at ${currentTier}`;
  return {
    kind: "decide",
    result: {
      kind: "decide",
      decisionId,
      model: selectedModel.id,
      ...(effort !== undefined ? { effort } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      // The judged tier, not the landing tier: the next run compares against
      // it, and an escalation must not read as a tier change on the next run.
      tier: currentTier,
      source: `model-selection:${tierSource}`,
      ...(fallback ? { fallback: true } : {}),
      reason,
    },
    switch: switchInfo,
    tier: currentTier,
    tierSource,
    trace: [...chosen.trace, `effective tier ${effectiveTier}`, `effort: ${effortPin.reason}`],
  };
}
