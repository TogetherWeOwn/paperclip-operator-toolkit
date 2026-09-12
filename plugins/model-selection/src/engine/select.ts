import type { PacingMode, Tier } from "../constants.js";
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
import { hardStopExcluded, orderCandidatesByPace, slotAllowed, type LaneLedger } from "./pacing.js";

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
  /**
   * TOG-2137. `off`: no pace involvement at all (skips the hard stop too —
   * an operator can fully disable this feature). `shadow` (default): the
   * hard stop and pace ordering both run and are recorded in the trace, but
   * `pacingApplied` on the decision tells the caller not to treat the result
   * as different from a pace-less selection for any consequential purpose
   * (the 48h comparison stream reads this rather than acting on it).
   * `enforce`: pace ordering and slot throttling actually change which
   * survivor wins.
   */
  pacingMode?: PacingMode;
  laneLedger?: LaneLedger;
  slotFloorFraction?: number;
  /**
   * TOG-2137. A live (non-expired) operator override for this issue: "route
   * to this model regardless of pace." It bypasses pace-preference ordering
   * and the ahead-of-line slot throttle for THIS model only — it never
   * bypasses a capability gate, a tier floor, the untrusted-profile hold, or
   * the serviceability hard stop, all of which are safety invariants an
   * operator override cannot waive (the same rule `repinAllowed` applies to
   * `pin:operator`: staying pinned to a dead lane is a silent failure, not
   * "leaving it alone"). Expiry itself is checked by the caller
   * (`activeOperatorOverride`) before this is ever set; this field is either a
   * live override or absent.
   */
  operatorOverrideModelId?: string | null;
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
    pacingApplied: false,
  };

  // `off` means no pace involvement of any kind, including the hard stop —
  // an operator can fully disable this feature and get exactly the pre-2137
  // engine back. `shadow` and `enforce` both run the hard stop and pace
  // ordering; only `enforce` lets either change which model wins.
  const pacingMode: PacingMode = config.pacingMode ?? "shadow";
  const paceActive = pacingMode !== "off";
  const paceEnforced = pacingMode === "enforce";
  const ledger: LaneLedger = config.laneLedger ?? {};
  const slotFloorFraction = config.slotFloorFraction ?? 0.25;
  const overrideModelId = config.operatorOverrideModelId ?? null;

  if (config.models.length === 0) {
    trace.push("no models configured for this company");
    return { ...base, outcome: "disabled" };
  }

  // Tiers are minimum capability requirements. T1 is the highest requirement;
  // T3 is mechanical work. An exclusion resolves to T1 before this engine runs,
  // so the same admission rule protects both labelled and sensitive work.
  trace.push(`tier floor ${judgement.tier}: no lower-capability model is eligible`);

  // Sticky beats cost. A mid-issue model change fires
  // `shouldResetTaskSessionForModelChange` (heartbeat.ts:5127-5133), discarding
  // the warm prompt cache — and cache read is the largest cost line we have
  // (ADR-0002). The saving from a cheaper model on turn N does not repay a
  // cache reset at turn N.
  //
  // Sticky beats cost, but it does not beat the required tier: an issue already
  // pinned to a lower-capability model must not stay there after a stronger
  // recorded judgement supersedes it.
  if (config.stickyWithinIssue && descriptor.stickyModelId) {
    const incumbent = config.models.find(
      (model) => model.id === descriptor.stickyModelId && model.enabled,
    );
    if (incumbent && tierIndex(incumbent.tier) < tierIndex(judgement.tier)) {
      trace.push(
        `sticky ${incumbent.id} (${incumbent.tier}) declined: below the ${judgement.tier} required tier`,
      );
      rejections.push({
        modelId: incumbent.id,
        stage: "tier-floor",
        reason: `tier ${incumbent.tier} is below the ${judgement.tier} required tier`,
      });
    } else if (incumbent) {
      trace.push(
        `sticky: ${incumbent.id} is already running this issue — switching would reset the session and discard the prompt cache`,
      );
      return { ...base, outcome: "selected", modelId: incumbent.id, effectiveTier: incumbent.tier };
    }
  }

  const requiredTier = judgement.tier;
  const required = new Set(descriptor.requiredCapabilities ?? []);
  if (required.size > 0) {
    trace.push(`hard capability gate: ${[...required].sort().join(", ")}`);
  }

  // Gate every model. A gate is a filter, never a score adjustment — a model
  // that cannot do the work is out, however cheap it is.
  const qualified: ModelEntry[] = [];
  for (const model of config.models) {
    if (!model.enabled) {
      rejections.push({ modelId: model.id, stage: "disabled", reason: "disabled in the roster" });
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
    if (tierIndex(model.tier) < tierIndex(requiredTier)) {
      rejections.push({
        modelId: model.id,
        stage: "tier-floor",
        reason: `tier ${model.tier} is below the ${requiredTier} required tier`,
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
    // Serviceability hard stop (TOG-2137): a lane that is exhausted or
    // unavailable excludes its model outright, same as a missing capability
    // — never merely deprioritized. `paceActive` gates this off entirely in
    // `pacing.mode: off`, and `hardStopExcluded` itself is fail-neutral: an
    // unpolled or malformed lane (`verdict === null`) excludes nothing.
    // A serviceability hard stop is never waived by an operator override — the
    // same rule `repinAllowed` applies to `pin:operator`: staying pinned to a
    // dead lane is a silent failure, not "leaving it alone", so the strongest
    // override in this design still yields to it.
    if (paceActive && hardStopExcluded(ledger, model)) {
      rejections.push({
        modelId: model.id,
        stage: "lane-unserviceable",
        reason: `lane ${model.laneId ?? "(none)"} is not serviceable`,
      });
      continue;
    }
    qualified.push(model);
  }

  if (qualified.length === 0) {
    trace.push(`no model cleared the gates (${rejections.length} rejected)`);
    return base;
  }

  // Cost against the judged tier's measured multi-turn volume. Ordinary picks
  // use regular rows only; fallback-only rows are consulted only when every
  // regular row was rejected or could not be costed. Disabled rows never enter
  // either path.
  const profileVerdict = resolveProfile(requiredTier, profiles, now);
  trace.push(`volume profile: ${profileVerdict.reason}`);

  function costCandidates(models: readonly ModelEntry[]): Candidate[] {
    const candidates: Candidate[] = [];
    for (const model of models) {
      const cost = costOf(model, requiredTier, profiles, config.models, signals, now);
      if (!cost) {
        rejections.push({
          modelId: model.id,
          stage: "no-profile",
          reason: `no volume profile for ${requiredTier}; cannot cost this candidate`,
        });
        continue;
      }
      candidates.push({
        ...cost,
        tier: model.tier,
        releasedAt: model.releasedAt,
        fallbackOnly: model.fallbackOnly,
      });
    }
    return candidates;
  }

  let candidates = costCandidates(qualified.filter((model) => !model.fallbackOnly));
  if (candidates.length === 0) {
    const fallbackModels = qualified.filter((model) => model.fallbackOnly);
    if (fallbackModels.length > 0) {
      trace.push("no regular candidate survived; considering fallback-only roster rows");
      candidates = costCandidates(fallbackModels);
    }
  }

  if (candidates.length === 0) {
    trace.push("no candidate could be costed — refusing to choose on a guessed volume term");
    return { ...base, effectiveTier: requiredTier };
  }

  candidates.sort((left, right) => {
    if (left.expectedCostUsd !== right.expectedCostUsd) {
      return left.expectedCostUsd - right.expectedCostUsd;
    }
    const releaseOrder = Date.parse(right.releasedAt) - Date.parse(left.releasedAt);
    if (releaseOrder !== 0) return releaseOrder;
    return left.modelId.localeCompare(right.modelId);
  });

  // Pace ordering (TOG-2137): pace state, deviation, cost, release date, id —
  // computed and traced whenever pacing is not `off`, but only allowed to
  // change the winner in `enforce`. `orderCandidatesByPace` partitions by
  // tier (in cost-sort order) before comparing anything, so this can never
  // move a candidate ahead of one in a group that already sorted earlier.
  let orderedCandidates = candidates;
  if (paceActive) {
    const paceOrdered = orderCandidatesByPace(candidates, config.models, ledger);
    const changed = paceOrdered.some((candidate, index) => candidate.modelId !== candidates[index]?.modelId);
    trace.push(
      changed
        ? `pace ordering (${pacingMode}) reorders to ${paceOrdered.map((c) => c.modelId).join(" > ")}`
        : `pace ordering (${pacingMode}) agrees with cost ordering`,
    );
    if (paceEnforced) orderedCandidates = paceOrdered;
  }

  // Ahead-of-line slot throttling (TOG-2137, enforce only): a candidate whose
  // lane is `ahead` is capped at `slotFloorFraction` of traffic rather than
  // excluded — the floor never reaches zero while the lane is serviceable
  // (serviceability itself was already enforced above as a hard stop, not
  // here). Throttled-out candidates fall through to the next in order rather
  // than producing no-eligible-model.
  let winnerIndex = 0;
  if (paceEnforced) {
    // An operator override picks its candidate outright, ahead of pace
    // ordering and the slot throttle both — it already survived the
    // capability/tier gates and the serviceability hard stop above (neither
    // of which an override can waive); the only two things left to skip are
    // pace preference and ahead-of-line throttling, which this does by
    // selecting the override's index directly rather than the first
    // throttle-cleared one.
    const overrideIndex = overrideModelId
      ? orderedCandidates.findIndex((candidate) => candidate.modelId === overrideModelId)
      : -1;
    if (overrideIndex >= 0) {
      if (overrideIndex !== 0) {
        trace.push(`operator override: routing to ${overrideModelId} ahead of pace ordering and slot throttling`);
      }
      winnerIndex = overrideIndex;
    } else {
      const allowedIndex = orderedCandidates.findIndex((candidate) => {
        const model = config.models.find((entry) => entry.id === candidate.modelId);
        return !model || slotAllowed(descriptor.issueId, ledger, model, slotFloorFraction);
      });
      if (allowedIndex >= 0) {
        if (allowedIndex !== 0) {
          trace.push(
            `slot throttle: ${orderedCandidates[0]!.modelId} deferred (ahead-of-line, floor ${slotFloorFraction}); using ${orderedCandidates[allowedIndex]!.modelId}`,
          );
        }
        winnerIndex = allowedIndex;
      }
    }
  }

  const winner = orderedCandidates[winnerIndex]!;
  const pacingApplied = paceEnforced && winner.modelId !== candidates[0]!.modelId;
  const withCandidates: SelectionDecision = { ...base, candidates, effectiveTier: requiredTier, pacingApplied };

  // An untrusted profile means we do not actually know the volume term. Say so
  // and hold at the floor rather than act on a number we would not defend.
  if (config.holdOnUntrustedProfile && !winner.profileTrusted) {
    const reason = `volume profile for ${requiredTier} is not trusted (${profileVerdict.reason})`;
    trace.push(`held at agent floor: ${reason}`);
    return { ...withCandidates, outcome: "held-at-floor", heldReason: reason };
  }

  trace.push(
    `selected ${winner.modelId} at an expected $${winner.expectedCostUsd.toFixed(4)}/run ` +
      `(direct $${winner.runCostUsd.toFixed(4)} = in $${winner.inputCostUsd.toFixed(4)} + ` +
      `cache-read $${winner.cacheReadCostUsd.toFixed(4)} + out $${winner.outputCostUsd.toFixed(4)}; ` +
      `escalation risk $${winner.escalationRiskUsd.toFixed(4)}) — cheapest of ${candidates.length}; ` +
      `exact ties prefer newest releasedAt then stable model id${winner.fallbackOnly ? "; fallback-only path" : ""}`,
  );

  if (!config.enforcementEnabled) {
    trace.push("advisory mode: enforcement is off, so this decision is recorded and not written");
  }

  return { ...withCandidates, outcome: "selected", modelId: winner.modelId };
}
