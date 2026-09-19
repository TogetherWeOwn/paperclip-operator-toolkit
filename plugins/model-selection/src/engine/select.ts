import type { PacingMode, Tier } from "../constants.js";
import type { SelectionObjective } from "../config/resolve.js";
import { costOf, resolveProfile, tierAbove, tierIndex } from "./cost.js";
import { resolveConfiguredModelId } from "./model-id.js";
import { computeShadowDiff, orderByObjective } from "./objective.js";
import { resolveTier } from "./tier.js";
import type {
  Candidate,
  CardLedgerEntry,
  IssueDescriptor,
  ModelEntry,
  ModelScore,
  QualitySignal,
  Rejection,
  SelectionDecision,
  VolumeProfile,
} from "./types.js";
import { LANE_ID_CODEX, LANE_ID_OPENCODE_GO, LANE_ID_ZAI } from "../constants.js";
import { applyPickOrdering } from "./pick-order.js";
import {
  avoidThresholdFor,
  hardStopExcluded,
  laneAvoidExcluded,
  laneEffectiveUtilization,
  laneHasRoom,
  laneOutageExcluded,
  laneVerdictFor,
  orderCandidatesByPace,
  preferredCandidateId,
  slotAllowed,
  ZAI_LONG_RUN_AGENTS,
  type LaneAvoidConfig,
  type LaneLedger,
  type LaneOutageOverride,
} from "./pacing.js";

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
  /**
   * TOG-2481 port of `tier_dispatcher.py`'s `AVOID` / `AVOID_LANE`. A lane at
   * or above its threshold is excluded from NEW admission (fail-neutral when
   * unset or when a lane has no measured utilization yet). Distinct from the
   * serviceability hard stop above: a lane can be "avoided" long before it is
   * unserviceable. Gated the same as the hard stop — only when `paceActive`.
   */
  laneAvoidConfig?: LaneAvoidConfig;
  /**
   * TOG-2481 port of `tier_dispatcher.py` `pick()`'s Codex/OpenCode-Go
   * fallback rule and its Z.ai-long-run-agent exclusion (2026-09-07 03:15Z /
   * 2026-09-08 22:15Z owner rules). Names which configured lane is Codex/
   * OpenCode Go so both rules key on this company's actual lane ids rather
   * than a bare `"codex"`/`"opencode-go"` string. Absent falls back to the
   * same constants every other unconfigured TOG-2481 addition uses.
   */
  codexLaneId?: string;
  opencodeGoLaneId?: string;
  zaiLaneId?: string;
  /**
   * TOG-2481 port of `tier_dispatcher.py`'s `lane_outage()` /
   * `lane_outage.json` — an operator-declared outage the telemetry cannot
   * see. Gated the same as the hard stop — only when `paceActive`.
   */
  laneOutageOverride?: LaneOutageOverride | null;
  /**
   * TOG-2481 port of `tier_dispatcher.py`'s `lane_has_room()` and its
   * `LANE_CAP_PER_ACCOUNT` / Z.ai peak-hour / weekly-pacing rules. Absent
   * disables the gate entirely (fail-open, matching every other TOG-2481
   * pacing addition — a company that never configures this sees no change).
   * Gated the same as the hard stop — only when `paceActive`.
   */
  laneRoom?: {
    capPerAccount: Readonly<Record<string, number>>;
    /** `lane_active_pins()`: current todo/in_progress pinned weight per lane, flash models half-weighted. */
    activePinsWeightByLane: Readonly<Record<string, number>>;
    fiveHourWindowName: string;
    zaiLaneId: string;
    zaiWeeklyWindowName: string;
    zaiWeeklyDefaultMargin: number;
    zaiPaceOverrideMargin: number | null;
    now: number;
  };
  /**
   * Which cost term orders candidates. Defaults to "list-price" — unchanged
   * behavior. Composition with pacing (TOG-2137): objective reordering runs
   * strictly AFTER pace ordering / the ahead-of-line slot throttle and never
   * bypasses either. Pace encodes hard capacity/serviceability reality
   * (a lane can only take so much traffic right now); objective encodes a
   * longer-run cost preference over whichever candidates pace already
   * cleared. Concretely: `orderByObjective` is applied to `orderedCandidates`
   * (the pace-ordered array, identical to `candidates` when pacing is
   * `off`/`shadow` or agreed with cost order), and the slot-throttle winner
   * index is computed against that same objective-ordered array — so a
   * throttled-ahead lane is deferred regardless of which objective picked it.
   */
  objective?: SelectionObjective;
  /**
   * TOG-2481 port of `tier_dispatcher.py` `model_scores.py`'s Bayesian
   * (model, tier) success scores, keyed by model id. Drives both the
   * `capability-score` gate below and `applyPickOrdering`'s
   * proven/free-must-be-proven/explore-fraction logic. Absent disables both —
   * fail-open, matching every other TOG-2481 addition: a company with no
   * scored history yet sees no change from this engine.
   */
  modelScores?: Readonly<Record<string, ModelScore>>;
  /**
   * TOG-2481 port of `tier_dispatcher.py` `pick(..., explore=False)`. Defaults
   * to `true` (unchanged `advise`/`apply` behavior). The new
   * `labelOnlyPass`/`repinPass`/`balancePass` jobs set this `false` for their
   * pinned-branch calls, matching every Python call site that re-affirms or
   * replaces an existing pin rather than seeding new evidence.
   */
  allowExplore?: boolean;
  /**
   * TOG-3210. Monitor ticks, continuation wakes, and label-only passes
   * re-check an already-tiered card; the card is correctly judged T1 by
   * every rubric anchor, but the RE-CHECK itself is cheap. Absent/disabled:
   * byte-identical to pre-TOG-3210 behavior. When enabled and
   * `descriptor.wakeReason` is on `wakeReasons`, the gate/ladder walk below
   * starts from `floorTier` instead of `judgement.tier` for THIS decision
   * only — `judgement.tier` itself (what the label/pin encode) is never
   * touched, and any decision this actually lowers the floor for is forced
   * `advisory: true` (see `base` below), so `apply.ts`'s
   * `if (decision.advisory) return nothing(...)` guarantees it can never be
   * written durably. The card's real tier is restored automatically — with
   * no extra bookkeeping — the instant a call without a matching wake reason
   * runs. One-key rollback: `wakeScopedFloor.enabled: false`.
   */
  wakeScopedFloor?: {
    enabled: boolean;
    /** Operator-curated allowlist of "cheap" wake reasons. Empty = inert even when enabled. */
    wakeReasons: readonly string[];
    /** The lower floor a matching wake reason gets. Must be below the card's judged tier to take effect. */
    floorTier: Tier;
  };
}

export interface SelectInput {
  descriptor: IssueDescriptor;
  config: SelectionConfig;
  profiles: readonly VolumeProfile[];
  signals: readonly QualitySignal[];
  now: number;
  /** TOG-1917 §2.2 card ledger, keyed `${modelId}:${tier}`. Only consulted for the shadow diff / non-default objective. */
  cardLedger?: Readonly<Record<string, CardLedgerEntry>>;
}

export function selectModel(input: SelectInput): SelectionDecision {
  const { descriptor, config, profiles, signals, now } = input;
  const trace: string[] = [];
  const rejections: Rejection[] = [];

  // `off` means no pace involvement of any kind, including the hard stop —
  // an operator can fully disable this feature and get exactly the pre-2137
  // engine back. `shadow` and `enforce` both run the hard stop and pace
  // ordering; only `enforce` lets either change which model wins. Resolved
  // ahead of `resolveTier` (Defect 6) so an issue-override pin on a
  // fully-unserviceable model can fall through to the tier label / agent
  // floor instead of silently wedging this issue — or a router-dependent
  // task class like `triage` — on a dead lane with no path to escalate.
  const pacingMode: PacingMode = config.pacingMode ?? "shadow";
  const paceActive = pacingMode !== "off";
  const paceEnforced = pacingMode === "enforce";
  const ledger: LaneLedger = config.laneLedger ?? {};
  const slotFloorFraction = config.slotFloorFraction ?? 0.25;
  const overrideModelId = resolveConfiguredModelId(config.operatorOverrideModelId, config.models);

  const judgement = resolveTier(descriptor, config.models, config.defaultTier, {
    isLaneUnserviceable: (model) => paceActive && hardStopExcluded(ledger, model),
  });
  trace.push(`tier ${judgement.tier} via ${judgement.source} — ${judgement.detail}`);

  // TOG-3210: a wake-scoped floor never raises the required tier and never
  // touches `judgement` — it only ever supplies a lower starting rung for the
  // gate/ladder walk below, for this one decision. Computed here, ahead of
  // `base`/the sticky block, so both use it consistently.
  const wakeFloorConfig = config.wakeScopedFloor;
  const wakeReason = descriptor.wakeReason ?? null;
  const wakeFloorEligible =
    !!wakeFloorConfig?.enabled &&
    !!wakeReason &&
    wakeFloorConfig.wakeReasons.includes(wakeReason) &&
    tierIndex(wakeFloorConfig.floorTier) < tierIndex(judgement.tier);
  const requiredTier: Tier = wakeFloorEligible ? wakeFloorConfig!.floorTier : judgement.tier;
  if (wakeFloorEligible) {
    trace.push(
      `wake-scoped floor: wake reason "${wakeReason}" lowers the required tier from ${judgement.tier} to ${requiredTier} for this decision only — card tier unchanged, decision forced advisory`,
    );
  }

  const base: SelectionDecision = {
    outcome: "no-eligible-model",
    modelId: null,
    judgement,
    effectiveTier: null,
    candidates: [],
    rejections,
    trace,
    advisory: !config.enforcementEnabled || wakeFloorEligible,
    heldReason: null,
    pacingApplied: false,
    shadowDiff: null,
    escalatedFromTier: null,
    wakeScopedTier: wakeFloorEligible ? requiredTier : null,
  };

  const nowIso = new Date(now).toISOString();

  if (config.models.length === 0) {
    trace.push("no models configured for this company");
    return { ...base, outcome: "disabled" };
  }

  // Tiers are minimum capability requirements. T1 is the highest requirement;
  // T3 is mechanical work. An exclusion resolves to T1 before this engine runs,
  // so the same admission rule protects both labelled and sensitive work.
  trace.push(`tier floor ${requiredTier}: no lower-capability model is eligible`);

  // Sticky beats cost. A mid-issue model change fires
  // `shouldResetTaskSessionForModelChange` (heartbeat.ts:5127-5133), discarding
  // the warm prompt cache — and cache read is the largest cost line we have
  // (ADR-0002). The saving from a cheaper model on turn N does not repay a
  // cache reset at turn N.
  //
  // Sticky beats cost, but it does not beat the required tier: an issue already
  // pinned to a lower-capability model must not stay there after a stronger
  // recorded judgement supersedes it. It also does not beat the serviceability
  // hard stop (TOG-2137, Defect 6): staying sticky to a model whose lane is
  // exhausted/unavailable would silently wedge the issue there with no path
  // to escalate, the same failure `hardStopExcluded` exists to prevent for
  // every other candidate below — sticky is a preference for continuity, not
  // a capacity override.
  if (config.stickyWithinIssue && descriptor.stickyModelId) {
    const stickyModelId = resolveConfiguredModelId(descriptor.stickyModelId, config.models);
    const incumbent = config.models.find(
      (model) => model.id === stickyModelId && model.enabled,
    );
    const incumbentUnserviceable = incumbent && paceActive && hardStopExcluded(ledger, incumbent);
    if (incumbent && tierIndex(incumbent.tier) < tierIndex(requiredTier)) {
      trace.push(
        `sticky ${incumbent.id} (${incumbent.tier}) declined: below the ${requiredTier} required tier`,
      );
      rejections.push({
        modelId: incumbent.id,
        stage: "tier-floor",
        reason: `tier ${incumbent.tier} is below the ${requiredTier} required tier`,
        operand: { kind: "tier-floor", tier: incumbent.tier, requiredTier },
      });
    } else if (
      incumbent &&
      typeof descriptor.requiredContextTokens === "number" &&
      incumbent.contextWindow < descriptor.requiredContextTokens
    ) {
      trace.push(
        `sticky ${incumbent.id} declined: context window ${incumbent.contextWindow} < required ${descriptor.requiredContextTokens}`,
      );
      rejections.push({
        modelId: incumbent.id,
        stage: "context-window",
        reason: `context window ${incumbent.contextWindow} < required ${descriptor.requiredContextTokens}`,
        operand: {
          kind: "context-window",
          contextWindow: incumbent.contextWindow,
          requiredContextTokens: descriptor.requiredContextTokens,
        },
      });
    } else if (incumbent && incumbentUnserviceable) {
      trace.push(
        `sticky ${incumbent.id} declined: lane ${incumbent.laneId ?? "(none)"} is not serviceable — re-selecting instead of wedging this issue on a dead lane`,
      );
      rejections.push({
        modelId: incumbent.id,
        stage: "lane-unserviceable",
        reason: `lane ${incumbent.laneId ?? "(none)"} is not serviceable`,
        operand: {
          kind: "lane-unserviceable",
          laneId: incumbent.laneId ?? null,
          verdict: laneVerdictFor(ledger, incumbent.laneId)?.state ?? null,
        },
      });
    } else if (incumbent) {
      trace.push(
        `sticky: ${incumbent.id} is already running this issue — switching would reset the session and discard the prompt cache`,
      );
      return { ...base, outcome: "selected", modelId: incumbent.id, effectiveTier: incumbent.tier };
    }
  }

  const required = new Set(descriptor.requiredCapabilities ?? []);
  if (required.size > 0) {
    trace.push(`hard capability gate: ${[...required].sort().join(", ")}`);
  }

  // Gate every model. A gate is a filter, never a score adjustment — a model
  // that cannot do the work is out, however cheap it is.
  const qualified: ModelEntry[] = [];
  for (const model of config.models) {
    if (!model.enabled) {
      rejections.push({ modelId: model.id, stage: "disabled", reason: "disabled in the roster", operand: { kind: "disabled" } });
      continue;
    }
    const missing = [...required].filter((capability) => !model.capabilities.includes(capability));
    if (missing.length > 0) {
      rejections.push({
        modelId: model.id,
        stage: "capability",
        reason: `missing ${missing.sort().join(", ")}`,
        operand: { kind: "capability", missing: missing.sort() },
      });
      continue;
    }
    if (tierIndex(model.tier) < tierIndex(requiredTier)) {
      rejections.push({
        modelId: model.id,
        stage: "tier-floor",
        reason: `tier ${model.tier} is below the ${requiredTier} required tier`,
        operand: { kind: "tier-floor", tier: model.tier, requiredTier },
      });
      continue;
    }
    // TOG-2481 port of `tier_dispatcher.py` `model_scores.py`'s `capable()`:
    // a model can clear the static roster `tier-floor` above and still be
    // measurably failing this tier's actual work. `capable` is a tri-state
    // (`true`/`false`/`null` for "not enough evidence either way") — only an
    // explicit `false` excludes; fail-open when `config.modelScores` is unset,
    // when this model has no recorded score, or when the tier verdict is
    // `null`, so a company with no scored history yet sees no change.
    const score = config.modelScores?.[model.id]?.tiers[requiredTier];
    if (score && score.capable === false) {
      rejections.push({
        modelId: model.id,
        stage: "capability-score",
        reason: `measured ${requiredTier} success rate (p=${score.p}) is below the capability threshold`,
        operand: { kind: "capability-score", tier: requiredTier, p: score.p },
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
        operand: {
          kind: "context-window",
          contextWindow: model.contextWindow,
          requiredContextTokens: descriptor.requiredContextTokens,
        },
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
        operand: {
          kind: "lane-unserviceable",
          laneId: model.laneId ?? null,
          verdict: laneVerdictFor(ledger, model.laneId)?.state ?? null,
        },
      });
      continue;
    }
    // TOG-2481: lane avoid threshold and operator-declared outage, ported from
    // `tier_dispatcher.py`'s `AVOID`/`AVOID_LANE` and `lane_outage.json`. Both
    // are gated the same as the hard stop above (`paceActive` only) and, like
    // it, are never waived by an operator override.
    if (paceActive && config.laneAvoidConfig && laneAvoidExcluded(ledger, model, config.laneAvoidConfig)) {
      rejections.push({
        modelId: model.id,
        stage: "lane-avoid",
        reason: `lane ${model.laneId ?? "(none)"} is at or above its avoid threshold`,
        operand: { kind: "lane-avoid", laneId: model.laneId ?? null },
      });
      continue;
    }
    if (paceActive && laneOutageExcluded(config.laneOutageOverride ?? null, nowIso, model)) {
      rejections.push({
        modelId: model.id,
        stage: "lane-outage",
        reason: `lane ${model.laneId ?? "(none)"} is under an operator-declared outage`,
        operand: { kind: "lane-outage", laneId: model.laneId ?? null },
      });
      continue;
    }
    // TOG-2481 port of `tier_dispatcher.py`'s `lane_has_room()`: a per-account
    // active-card cap (opencode-go, zai), Z.ai peak-hour throttle, Z.ai
    // weekly-pacing gate, and the 5h-window new-admission stop. This gates
    // NEW admission only — it never touches an issue already pinned to the
    // lane (that weight is exactly what `activePinsWeightByLane` counts).
    if (paceActive && config.laneRoom && model.laneId) {
      const room = config.laneRoom;
      const admitted = laneHasRoom({
        laneId: model.laneId,
        activePinsWeight: room.activePinsWeightByLane[model.laneId] ?? 0,
        ledger,
        capPerAccount: room.capPerAccount,
        fiveHourWindowName: room.fiveHourWindowName,
        zaiLaneId: room.zaiLaneId,
        zaiWeeklyWindowName: room.zaiWeeklyWindowName,
        zaiWeeklyDefaultMargin: room.zaiWeeklyDefaultMargin,
        zaiPaceOverrideMargin: room.zaiPaceOverrideMargin,
        nowMs: room.now,
      });
      if (!admitted) {
        rejections.push({
          modelId: model.id,
          stage: "lane-no-room",
          reason: `lane ${model.laneId} has no room for a new active card right now`,
          operand: { kind: "lane-no-room", laneId: model.laneId },
        });
        continue;
      }
    }
    // 2026-09-07 03:15Z owner rule: T1 runs carry ~150k-token contexts for
    // 30-60 turns; on the OpenCode Go lane one such run drains $7-10 of a
    // $12/5h account and the whole lane 429s mid-run, failing every run
    // pinned there. Go is T1's FALLBACK only — used when the codex lane is
    // at/over its avoid threshold. T2/T3 keep using Go under the cap/5h rule
    // above. Ported from `tier_dispatcher.py` `pick()`.
    if (
      paceActive &&
      requiredTier === "T1" &&
      model.laneId === (config.opencodeGoLaneId ?? LANE_ID_OPENCODE_GO) &&
      config.laneAvoidConfig &&
      laneEffectiveUtilization(ledger, config.codexLaneId ?? LANE_ID_CODEX) <
        avoidThresholdFor(config.laneAvoidConfig, config.codexLaneId ?? LANE_ID_CODEX)
    ) {
      rejections.push({
        modelId: model.id,
        stage: "lane-avoid",
        reason: "T1 stays off opencode-go while the codex lane still has room (Go fallback only)",
        operand: { kind: "lane-avoid", laneId: model.laneId ?? null },
      });
      continue;
    }
    // 2026-09-08 22:15Z owner rule: Z.ai's Anthropic-compat endpoint rejects
    // very long agent conversations (error 1214) — 3/3 hits were engineering
    // turns of 78-232 min. Keep zai for reviewer/QA/mechanical roles; route
    // long-turn engineering agent NAMES to codex when it has room. Ported
    // from `tier_dispatcher.py` `pick()`'s `ZAI_LONG_RUN_AGENTS` rule.
    const zaiLaneId = config.zaiLaneId ?? LANE_ID_ZAI;
    const codexLaneId = config.codexLaneId ?? LANE_ID_CODEX;
    if (
      paceActive &&
      model.laneId === zaiLaneId &&
      descriptor.agentName &&
      ZAI_LONG_RUN_AGENTS.has(descriptor.agentName) &&
      config.laneAvoidConfig &&
      laneEffectiveUtilization(ledger, codexLaneId) < avoidThresholdFor(config.laneAvoidConfig, codexLaneId) &&
      config.models.some((entry) => entry.laneId === codexLaneId && entry.enabled)
    ) {
      rejections.push({
        modelId: model.id,
        stage: "lane-avoid",
        reason: `long-turn agent "${descriptor.agentName}" stays off zai while the codex lane still has room (Z.ai 1214 risk)`,
        operand: { kind: "lane-avoid", laneId: model.laneId ?? null },
      });
      continue;
    }
    qualified.push(model);
  }

  if (qualified.length === 0) {
    // TOG-2137, Defect 2. Distinguish a genuine capacity dead end from an
    // ordinary config/capability gap. If every model from `requiredTier`
    // through the T1 ceiling that survived the disabled/capability/context
    // gates was excluded ONLY by the pace serviceability hard stop, there is
    // nowhere left to escalate to — that is `tier-exhausted`, and it must
    // reach an operator (see `worker.ts`), never fail silently the way the
    // reference dispatcher's `pick()` does. A mix with a disabled/capability/
    // context rejection means the gap is a config problem, not capacity, so
    // it stays `no-eligible-model`.
    const atOrAboveRequired = rejections.filter((rejection) => {
      const rejectedModel = config.models.find((entry) => entry.id === rejection.modelId);
      return rejectedModel ? tierIndex(rejectedModel.tier) >= tierIndex(requiredTier) : false;
    });
    const tierExhausted =
      atOrAboveRequired.length > 0 && atOrAboveRequired.every((rejection) => rejection.stage === "lane-unserviceable");
    if (tierExhausted) {
      trace.push(
        `tier exhausted: every candidate from ${requiredTier} through the T1 ceiling was excluded by the pace ` +
          `serviceability hard stop (${atOrAboveRequired.length} rejection${atOrAboveRequired.length === 1 ? "" : "s"}) — nowhere left to escalate to`,
      );
      return { ...base, outcome: "tier-exhausted", effectiveTier: requiredTier };
    }
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
          operand: { kind: "no-profile", tier: requiredTier },
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

  // TOG-2137, Defect 2. Walk the tier ladder one rung at a time, starting at
  // the required tier — never pool every qualifying tier into one flat cost
  // race. A candidate one tier up must never win merely for being cheaper
  // than a candidate that was actually available at the required tier; it is
  // only ever considered once the required tier itself has nothing costable.
  // `tierAbove` (cost.ts) is the same "one step up, or null at the ceiling"
  // primitive `escalationRisk` uses, so the walk can never skip a tier or
  // step down.
  let candidates: Candidate[] = [];
  let landingTier: Tier = requiredTier;
  for (let rung: Tier | null = requiredTier; rung !== null; rung = tierAbove(rung)) {
    const atRung = qualified.filter((model) => model.tier === rung);
    if (atRung.length === 0) continue;

    let rungCandidates = costCandidates(atRung.filter((model) => !model.fallbackOnly));
    if (rungCandidates.length === 0) {
      const fallbackModels = atRung.filter((model) => model.fallbackOnly);
      if (fallbackModels.length > 0) {
        trace.push(`no regular candidate survived at ${rung}; considering fallback-only roster rows`);
        rungCandidates = costCandidates(fallbackModels);
      }
    }
    if (rungCandidates.length > 0) {
      landingTier = rung;
      candidates = rungCandidates;
      break;
    }
  }

  if (candidates.length === 0) {
    trace.push("no candidate could be costed — refusing to choose on a guessed volume term");
    return { ...base, effectiveTier: requiredTier };
  }

  const escalatedFromTier = landingTier !== requiredTier ? requiredTier : null;
  if (escalatedFromTier) {
    trace.push(
      `escalated from ${requiredTier} to ${landingTier}: no candidate at ${requiredTier} survived the gates or could be costed`,
    );
  }

  candidates.sort((left, right) => {
    if (left.expectedCostUsd !== right.expectedCostUsd) {
      return left.expectedCostUsd - right.expectedCostUsd;
    }
    const releaseOrder = Date.parse(right.releasedAt) - Date.parse(left.releasedAt);
    if (releaseOrder !== 0) return releaseOrder;
    return left.modelId.localeCompare(right.modelId);
  });

  // TOG-2481 port of `tier_dispatcher.py` `pick()`'s own ordering rules —
  // free-must-be-proven, the 20% cost-band least-utilized-lane tiebreak, and
  // the 10% T2/T3 explore fraction — layered directly on top of the cost
  // sort, before pace ordering runs. Fail-open when `config.modelScores` is
  // unset: a company with no scored history yet gets the plain cost order,
  // unchanged from pre-TOG-2481 behavior.
  if (config.modelScores) {
    const pickResult = applyPickOrdering(
      candidates,
      config.models,
      ledger,
      config.modelScores,
      requiredTier,
      descriptor.issueId,
      config.allowExplore ?? true,
    );
    candidates = pickResult.ordered;
    trace.push(
      pickResult.explored
        ? `explore: routing to unproven ${pickResult.exploreModelId} to gather ${requiredTier} evidence`
        : "pick ordering: free-must-be-proven + 20% cost-band least-utilized-lane tiebreak applied",
    );
  }

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
    // TOG-2137, Defect 5. Preferred-near-reset is the gas-pedal counterpart
    // to the hard stop and slot throttle, both of which only ever hold a
    // lane back — this is traced separately so the 48h comparison stream can
    // tell a "trailing lane preferred" reorder apart from an ordinary
    // behind/ahead pace reorder.
    const preferredId = preferredCandidateId(candidates, config.models, ledger);
    if (preferredId) {
      trace.push(`${preferredId}'s lane is trailing pace near its reset window close — preferred for new dispatch`);
    }
    if (paceEnforced) orderedCandidates = paceOrdered;
  }

  // Ahead-of-line slot throttling (TOG-2137, enforce only): a candidate whose
  // lane is `ahead` is capped at `slotFloorFraction` of traffic rather than
  // excluded — the floor never reaches zero while the lane is serviceable
  // (serviceability itself was already enforced above as a hard stop, not
  // here). Throttled-out candidates fall through to the next in order rather
  // than producing no-eligible-model.
  //
  // Ordering composition (TOG-2136 + TOG-2137): pace answers "what can we
  // serve right now" (hard stop above, and this throttle) and, in `enforce`,
  // "what should we prefer right now" (the reorder above). `objective`
  // answers a separate question — "which of the survivors is cheapest per
  // accepted card" — and is layered strictly ON TOP of whatever pace already
  // produced: it is default `list-price`, a documented no-op, so shipped
  // behavior is unchanged; when explicitly switched, it re-ranks
  // `orderedCandidates` (the pace-enforced order, or the plain cost order
  // when pacing is `off`/`shadow`), and this SAME throttle walk below is
  // re-applied over that re-ranked array so a throttled-ahead lane stays
  // deferred no matter which objective ranked it first. Capacity safety
  // (hard stop, slot throttle) always outranks either ordering preference.
  function pickWinnerIndex(ordered: readonly Candidate[]): number {
    // An operator override picks its candidate outright, ahead of pace
    // ordering and the slot throttle both — it already survived the
    // capability/tier gates and the serviceability hard stop above (neither
    // of which an override can waive); the only two things left to skip are
    // pace preference and ahead-of-line throttling, which this does by
    // selecting the override's index directly rather than the first
    // throttle-cleared one.
    const overrideIndex = overrideModelId ? ordered.findIndex((candidate) => candidate.modelId === overrideModelId) : -1;
    if (overrideIndex >= 0) return overrideIndex;
    const allowedIndex = ordered.findIndex((candidate) => {
      const model = config.models.find((entry) => entry.id === candidate.modelId);
      return !model || slotAllowed(descriptor.issueId, ledger, model, slotFloorFraction);
    });
    return allowedIndex >= 0 ? allowedIndex : 0;
  }

  let paceWinnerIndex = 0;
  if (paceEnforced) {
    paceWinnerIndex = pickWinnerIndex(orderedCandidates);
    const overrideIndex = overrideModelId
      ? orderedCandidates.findIndex((candidate) => candidate.modelId === overrideModelId)
      : -1;
    if (overrideIndex >= 0 && overrideIndex === paceWinnerIndex) {
      if (overrideIndex !== 0) {
        trace.push(`operator override: routing to ${overrideModelId} ahead of pace ordering and slot throttling`);
      }
    } else if (paceWinnerIndex !== 0) {
      trace.push(
        `slot throttle: ${orderedCandidates[0]!.modelId} deferred (ahead-of-line, floor ${slotFloorFraction}); using ${orderedCandidates[paceWinnerIndex]!.modelId}`,
      );
    }
  }

  // `pacingApplied` is measured against the pace-only decision (ignoring
  // `objective` entirely) so an `objective` switch never taints its meaning —
  // a caller checking `pacingApplied` is asking specifically "did pace change
  // this", not "did anything change this".
  const paceOnlyWinner = orderedCandidates[paceWinnerIndex]!;
  const pacingApplied = paceEnforced && paceOnlyWinner.modelId !== candidates[0]!.modelId;

  const listPriceWinner = candidates[0]!;
  const cardLedger = input.cardLedger ?? {};
  const shadowDiff = computeShadowDiff(descriptor.issueId, landingTier, candidates, listPriceWinner.modelId, cardLedger);

  // `objective` never affects `candidates`/`winner` unless explicitly switched
  // away from the default. Shipped config always leaves this at "list-price"
  // (TOG-2136 hard constraint) — the alternate ordering above only feeds the
  // shadow-diff record, observed for 7 days before any enforcement proposal.
  const objective = config.objective ?? "list-price";
  let winner = paceOnlyWinner;
  if (objective === "cost-per-accepted-card") {
    const objectiveOrdered = orderByObjective(orderedCandidates, objective, cardLedger);
    if (objectiveOrdered.length > 0) {
      winner = paceEnforced ? objectiveOrdered[pickWinnerIndex(objectiveOrdered)]! : objectiveOrdered[0]!;
    }
  }

  const withCandidates: SelectionDecision = {
    ...base,
    candidates,
    effectiveTier: landingTier,
    pacingApplied,
    shadowDiff,
    escalatedFromTier,
  };

  // An untrusted profile means we do not actually know the volume term. Say so
  // and hold at the floor rather than act on a number we would not defend —
  // UNLESS the floor itself is not serviceable right now. "Held at floor" is
  // only ever a statement about cost trust; it says nothing about
  // availability. And the floor is frequently never a candidate above: a
  // fleet-wide floor model is usually below `requiredTier` for a T1/T2 card,
  // so it never reached the `qualified` loop and its lane was never tested
  // against `ledger`/`laneOutageOverride` at all (TOG-3037). Test it here,
  // on the exact same predicates, before handing the run back to a lane that
  // might already be dead. `winner` already cleared every gate above
  // (including serviceability), so it is always a safe explicit fallback.
  if (config.holdOnUntrustedProfile && !winner.profileTrusted) {
    const reason = `volume profile for ${requiredTier} is not trusted (${profileVerdict.reason})`;
    const floorModelId = resolveConfiguredModelId(descriptor.agentFloorModelId ?? null, config.models);
    const floorModel = floorModelId ? config.models.find((model) => model.id === floorModelId) : undefined;
    const floorLaneDead =
      paceActive &&
      !!floorModel &&
      (hardStopExcluded(ledger, floorModel) ||
        (!!config.laneAvoidConfig && laneAvoidExcluded(ledger, floorModel, config.laneAvoidConfig)) ||
        laneOutageExcluded(config.laneOutageOverride ?? null, nowIso, floorModel));
    if (floorLaneDead) {
      trace.push(
        `held-at-floor declined: floor ${floorModel!.id} lane ${floorModel!.laneId ?? "(none)"} is not serviceable — ` +
          `writing an explicit pin to ${winner.modelId} instead (${reason})`,
      );
      return { ...withCandidates, outcome: "selected", modelId: winner.modelId };
    }
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
  } else if (wakeFloorEligible) {
    trace.push(
      `advisory mode: wake-scoped floor decisions are never written, regardless of enforcement — the card's ${judgement.tier} tier is untouched`,
    );
  }

  return { ...withCandidates, outcome: "selected", modelId: winner.modelId };
}
