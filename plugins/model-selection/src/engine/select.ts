import type { PacingMode, Tier } from "../constants.js";
import type { SelectionObjective } from "../config/resolve.js";
import { costOf, resolveProfile, tierAbove, tierIndex } from "./cost.js";
import { isAdapterBlockedModel, resolveConfiguredModelId } from "./model-id.js";
import { computeShadowDiff, orderByObjective } from "./objective.js";
import { tierScoreFor, zeroAcceptEvidence } from "./scores.js";
import { admittedTierCeiling, resolveTier } from "./tier.js";
import type {
  AvailabilityNote,
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
import type { AvailabilitySnapshot, AvailabilityTerm, LaneAvailability } from "./availability.js";
import { activeModelCooldown } from "../lane-capacity/counts-only.js";
import {
  costDownWouldAbandonProvenLane,
  evidenceStateFor,
  type LaneEvidenceSnapshot,
  type LaneEvidenceState,
} from "./lane-evidence.js";
import { LANE_ID_CODEX, LANE_ID_OPENCODE_GO, LANE_ID_ZAI } from "../constants.js";
import { applyPickOrdering } from "./pick-order.js";
import { earnInGuardFor, freeEarnInWinner } from "./free-lane-earn-in.js";
import { compareSamePriceFamily } from "./same-price-family.js";
import {
  allLanesDeadVetoed,
  avoidThresholdFor,
  deadVetoExcluded,
  hardStopExcluded,
  modelCooldownExcluded,
  laneAvoidExcluded,
  laneWithdrawal,
  laneWithdrawnExcluded,
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
   * . `off`: no pace involvement at all (skips the hard stop too —
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
  /**
   *  (D1e). The lanes configured for this company
   * (`pacing.lanes[].laneId`). Null/absent fails the veto OPEN — without the
   * configured set an unconfigured lane cannot be told apart from a dead one,
   * so vetoing anything would risk vetoing everything. The worker passes the
   * resolved lane ids; callers that cannot name the configured set omit this
   * and get pre-D1e behaviour exactly.
   */
  configuredLaneIds?: readonly string[] | null;
  slotFloorFraction?: number;
  /**
   * . A live (non-expired) operator override for this issue: "route
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
   *  port of `tier_dispatcher.py`'s `AVOID` / `AVOID_LANE`. A lane at
   * or above its threshold is excluded from NEW admission (fail-neutral when
   * unset or when a lane has no measured utilization yet). Distinct from the
   * serviceability hard stop above: a lane can be "avoided" long before it is
   * unserviceable. Gated the same as the hard stop — only when `paceActive`.
   */
  laneAvoidConfig?: LaneAvoidConfig;
  /**
   *  port of `tier_dispatcher.py` `pick()`'s Codex/OpenCode-Go
   * fallback rule and its Z.ai-long-run-agent exclusion (2026-09-07 03:15Z /
   * 2026-09-08 22:15Z owner rules). Names which configured lane is Codex/
   * OpenCode Go so both rules key on this company's actual lane ids rather
   * than a bare `"codex"`/`"opencode-go"` string. Absent falls back to the
   * same constants every other unconfigured  addition uses.
   */
  codexLaneId?: string;
  opencodeGoLaneId?: string;
  zaiLaneId?: string;
  /**
   *  port of `tier_dispatcher.py`'s `lane_outage()` /
   * `lane_outage.json` — an operator-declared outage the telemetry cannot
   * see. Gated the same as the hard stop — only when `paceActive`.
   */
  laneOutageOverride?: LaneOutageOverride | null;
  /**
   *  port of `tier_dispatcher.py`'s `lane_has_room()` and its
   * `LANE_CAP_PER_ACCOUNT` / Z.ai peak-hour / weekly-pacing rules. Absent
   * disables the gate entirely (fail-open, matching every other 
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
   * behavior. Composition with pacing: objective reordering runs
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
   *  port of `tier_dispatcher.py` `model_scores.py`'s Bayesian
   * (model, tier) success scores, keyed by model id. Drives both the
   * `capability-score` gate below and `applyPickOrdering`'s
   * proven/free-must-be-proven/explore-fraction logic. Absent disables both —
   * fail-open, matching every other  addition: a company with no
   * scored history yet sees no change from this engine.
   */
  modelScores?: Readonly<Record<string, ModelScore>>;
  /**
   *  port of `tier_dispatcher.py` `pick(..., explore=False)`. Defaults
   * to `true` (unchanged `advise`/`apply` behavior). The new
   * `labelOnlyPass`/`repinPass`/`balancePass` jobs set this `false` for their
   * pinned-branch calls, matching every Python call site that re-affirms or
   * replaces an existing pin rather than seeding new evidence.
   */
  allowExplore?: boolean;
  /**
   *  AC-4. When true, a model whose lane availability is UNKNOWN is
   * excluded rather than merely recorded. Defaults to FALSE, and that
   * asymmetry is deliberate: the agent floor is itself a cliproxy lane
   * (`the-agent-floor-is-itself-on-cliproxy`), so a dead telemetry feed that
   * excluded every candidate would not fall back to a known-good path — it
   * would move the whole fleet to an unmeasured one. Either way the UNKNOWN
   * is recorded on `decision.availability.unknown` and traced, which is the
   * part `pacing_verdict.py` actually forbids skipping.
   */
  holdOnUnknownAvailability?: boolean;
  /**
   * . Monitor ticks, continuation wakes, and label-only passes
   * re-check an already-tiered card; the card is correctly judged T1 by
   * every rubric anchor, but the RE-CHECK itself is cheap. Absent/disabled:
   * byte-identical to pre- behavior. When enabled and
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
  /**  §2.2 card ledger, keyed `${modelId}:${tier}`. Only consulted for the shadow diff / non-default objective. */
  cardLedger?: Readonly<Record<string, CardLedgerEntry>>;
  /**
   * : the availability term. Read per decision from the published
   * quota-contract document (`worker.ts` `readAvailability`), never cached in
   * config — both measured failure shapes were transient (Z.ai's cooldown
   * ~4 minutes, Claude's window recovered inside two hours), so a value held
   * past its window is the same defect as the static `enabled` boolean this
   * supplements. Absent means "not configured" and changes nothing.
   */
  availability?: AvailabilitySnapshot;
  /**
   * , second failure shape: run-outcome evidence per lane, from
   * `heartbeat_runs`. Distinct from `availability`, which can only speak about
   * lanes that publish a quota contract — `devin/*` publishes none and still
   * refused 74 of 74 dispatches at the provider level, so the availability
   * term reads it UNKNOWN/`unmapped` and lets it through.
   *
   * Absent means every lane is `unproven`: nothing is excluded, but no
   * cost-down move may abandon a proven-good lane on no evidence.
   */
  laneEvidence?: LaneEvidenceSnapshot;
}

export function selectModel(input: SelectInput): SelectionDecision {
  const { descriptor, config, profiles, signals, now } = input;
  const trace: string[] = [];
  const rejections: Rejection[] = [];
  /** : lanes already named in a withdrawal trace line, so a lane with six models traces once. */
  const withdrawnLanes = new Set<string>();

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

  //  (D1e). CEO fail-open: when every configured lane meets the dead
  // condition in the same window, the failure is poller-side, not per-lane —
  // vetoing all of them would stop dispatch through `tier-exhausted`. Admit
  // as today instead; the worker raises the operator card as "poller suspect"
  // off `decision.deadVeto.bypassedAllDead`. Null configured set fails open
  // too (see `configuredLaneIds` above).
  const configuredLaneIds = config.configuredLaneIds ?? null;
  const bypassAllDead =
    paceActive && configuredLaneIds !== null && allLanesDeadVetoed(ledger, configuredLaneIds);
  const deadVetoScope = { configuredLaneIds, bypassAllDead };

  // ---- : the availability term ------------------------------------
  //
  // Independent of `pacingMode`, and deliberately so. `hardStopExcluded` above
  // is the PACE engine's verdict: it only fires on a lane that was polled AND
  // produced an account identity the pace engine could key on, and it is
  // fail-neutral otherwise (`pacing.ts:275`) — an unpolled lane excludes
  // nothing and says nothing. That is the right posture for a pacer and the
  // wrong one for serviceability, because the two outages on 2026-09-16/17
  // were invisible to it: one lane published `health: "healthy"` at 0.46
  // weekly while refusing every request (the binding state was the
  // `subscription-pool` cooldown, which no pace window encodes), and the
  // other stood on a single credential behind a per-account limiter.
  //
  // So this gate reads the published quota-contract document directly and
  // carries the three terms the pace verdict has no field for — cooldown,
  // serviceable account COUNT, and an explicit staleness UNKNOWN. It is
  // enabled by supplying `input.availability`, not by `pacing.mode`.
  const availability = input.availability;
  const availableLanes = new Map<string, LaneAvailability>(
    (availability?.lanes ?? []).map((lane) => [lane.laneId, lane]),
  );
  const holdOnUnknownAvailability = config.holdOnUnknownAvailability ?? false;
  const trafficScale = descriptor.trafficScale ?? "issue";
  const excludedByLane: AvailabilityNote[] = [];
  const unknownLanes: AvailabilityNote[] = [];

  type LaneRead =
    | { state: "available" }
    | { state: "unavailable" | "unknown"; term: AvailabilityTerm; reason: string };

  /**
   * Pure: no recording, no side effects, so `resolveTier` can consult it
   * without the tier walk leaving phantom rejections behind.
   */
  function laneRead(model: ModelEntry): LaneRead {
    if (modelCooldownExcluded(ledger, model, now)) {
      return { state: "unavailable", term: "cooldown", reason: `lane ${model.laneId}: active cooldown for ${model.id}` };
    }
    if (!availability) return { state: "available" };
    if (availability.unreadableReason) {
      return { state: "unknown", term: "staleness", reason: availability.unreadableReason };
    }
    const laneId = model.laneId ?? null;
    if (!laneId) {
      // A model with no lane is UNKNOWN, not healthy. Reading an absent lane
      // as available is how a gate silently enforces on nothing.
      return { state: "unknown", term: "unmapped", reason: `${model.id} declares no laneId` };
    }
    const lane = availableLanes.get(laneId);
    if (!lane) {
      return { state: "unknown", term: "unmapped", reason: `lane ${laneId} is absent from the snapshot` };
    }
    if (lane.state === "unavailable") {
      return { state: "unavailable", term: lane.term ?? "health", reason: `lane ${laneId}: ${lane.reason}` };
    }
    if (lane.state === "unknown") {
      return { state: "unknown", term: lane.term ?? "staleness", reason: `lane ${laneId}: ${lane.reason}` };
    }
    if (activeModelCooldown(lane.modelCooldowns ?? [], model.id, now)) {
      return { state: "unavailable", term: "cooldown", reason: `lane ${laneId}: active cooldown for ${model.id}` };
    }
    // AC-3. Quota is not the only way to run out: the 00:39Z lane had 54% of
    // its weekly allowance left and still refused, because one credential
    // behind a requests-per-window limiter cannot carry fleet-scale arrival.
    if (trafficScale === "fleet-default" && lane.serviceableAccountCount <= 1) {
      return {
        state: "unavailable",
        term: "accounts",
        reason:
          `lane ${laneId}: ${lane.serviceableAccountCount} serviceable account(s) cannot carry ` +
          `fleet-default-scale traffic at any quota level`,
      };
    }
    return { state: "available" };
  }

  /**
   * Record the verdict and answer whether the model may proceed. UNKNOWN is
   * recorded either way — an UNKNOWN that is not said has become a quiet
   * pass, which is the single thing `pacing_verdict.py` forbids.
   */
  function clearsLane(model: ModelEntry): boolean {
    const read = laneRead(model);
    if (read.state === "available") return true;
    const note: AvailabilityNote = {
      modelId: model.id,
      laneId: model.laneId ?? null,
      term: read.term,
      reason: read.reason,
    };
    const bucket = read.state === "unavailable" ? excludedByLane : unknownLanes;
    // The sticky branch and the qualification loop can both reach the same
    // incumbent; one lane failure is one note.
    if (!bucket.some((entry) => entry.modelId === model.id)) bucket.push(note);
    if (read.state === "unknown" && !holdOnUnknownAvailability) return true;
    if (!rejections.some((r) => r.modelId === model.id && r.stage === "lane-availability")) {
      rejections.push({
        modelId: model.id,
        stage: "lane-availability",
        reason: `${read.term}: ${read.reason}`,
        operand: { kind: "lane-availability", laneId: model.laneId ?? null, term: read.term, state: read.state },
      });
    }
    return false;
  }

  // ---- : the lane-evidence term -----------------------------------
  // The availability term above can only see lanes that publish a quota
  // contract. This one sees what actually happened when the fleet dispatched
  // to a lane, which is the only signal that catches a provider-level refusal
  // (`503 auth_unavailable: no auth available (providers=devin)`, 74/74 on
  // 2026-09-17) on a lane no contract document mentions.
  const laneEvidence = input.laneEvidence;
  const evidenceExcluded: AvailabilityNote[] = [];
  const incumbentEvidence: LaneEvidenceState = evidenceStateFor(
    laneEvidence,
    config.models.find(
      (model) => model.id === resolveConfiguredModelId(descriptor.stickyModelId ?? "", config.models),
    )?.laneId ?? null,
  );

  /**
   * Answer whether a model's lane has the evidence to carry this decision.
   *
   * Two refusals, and they are different acts:
   *   * `proven-dead` EXCLUDES, the same discipline as a missing capability.
   *   * `unproven` excludes ONLY when taking this candidate would abandon a
   *     proven-good incumbent — the cost-down guard. An unproven lane is still
   *     freely selectable for a card that is not already on a proven-good one,
   *     which is what keeps `balance_pass`'s exploration slot alive.
   */
  function clearsEvidence(model: ModelEntry): boolean {
    if (!laneEvidence) return true;
    const state = evidenceStateFor(laneEvidence, model.laneId ?? null);
    const record = laneEvidence.lanes.find((lane) => lane.laneId === model.laneId);
    const detail =
      record?.reason ??
      laneEvidence.unreadableReason ??
      `lane ${model.laneId ?? "(none)"} has no recorded runs in the ${laneEvidence.windowHours}h window`;

    if (state === "proven-dead") {
      const note: AvailabilityNote = {
        modelId: model.id,
        laneId: model.laneId ?? null,
        term: "evidence",
        reason: detail,
      };
      if (!evidenceExcluded.some((entry) => entry.modelId === model.id)) evidenceExcluded.push(note);
      if (!rejections.some((r) => r.modelId === model.id && r.stage === "lane-evidence")) {
        // The RULE is named, not just the verdict: `zero-success` and
        // `wilson-upper` are different operator findings (AC-6).
        rejections.push({
          modelId: model.id,
          stage: "lane-evidence",
          reason: `proven-dead [${record?.rule ?? "unknown"}]: ${detail}`,
          operand: {
            kind: "lane-evidence",
            laneId: model.laneId ?? null,
            state: "proven-dead",
            rule: record?.rule ?? null,
          },
        });
      }
      return false;
    }
    if (costDownWouldAbandonProvenLane(incumbentEvidence, state)) {
      const note: AvailabilityNote = {
        modelId: model.id,
        laneId: model.laneId ?? null,
        term: "evidence",
        reason: `${detail} — refusing to move off a proven-good lane onto an ${state} one`,
      };
      if (!evidenceExcluded.some((entry) => entry.modelId === model.id)) evidenceExcluded.push(note);
      if (!rejections.some((r) => r.modelId === model.id && r.stage === "lane-evidence")) {
        rejections.push({
          modelId: model.id,
          stage: "lane-evidence",
          reason: `${state}: ${detail} — incumbent lane is proven-good`,
          operand: { kind: "lane-evidence", laneId: model.laneId ?? null, state, rule: null },
        });
      }
      return false;
    }
    return true;
  }

  const judgement = resolveTier(descriptor, config.models, config.defaultTier, {
    // An issue-override pin on a lane that will not serve falls through to the
    // tier label / agent floor, the same as for the pace hard stop. An UNKNOWN
    // never moves a pin: a blind instrument is not grounds to discard a
    // recorded human judgement. A dead-vetoed lane fails the pin the same
    // way — a pin is a preference, not a suicide pact.
    isLaneUnserviceable: (model) =>
      (paceActive &&
        (hardStopExcluded(ledger, model, now) || deadVetoExcluded(ledger, model, deadVetoScope))) ||
      laneRead(model).state === "unavailable",
  });
  trace.push(`tier ${judgement.tier} via ${judgement.source} — ${judgement.detail}`);
  if (bypassAllDead) {
    trace.push(
      `dead-lane veto fail-open: every configured lane meets the dead condition ` +
        `(${(configuredLaneIds ?? []).length} of ${(configuredLaneIds ?? []).length}) — ` +
        `admitting as today; a poller-side outage is suspect, not per-lane death`,
    );
  }

  // : T0 admission. Rows more capable than this decision's ceiling
  // are removed from the pool HERE, before the sticky lookup, the gate loop,
  // the exhaustion accounting, the ladder walk and the escalation-risk term
  // all read it — a barred row must never win, escalate a card into itself,
  // or inflate any count. They are not recorded as rejections: nothing about
  // them failed a gate, they were never candidates.
  const admittedCeiling = admittedTierCeiling(judgement);
  const poolModels = config.models.filter((model) => tierIndex(model.tier) <= tierIndex(admittedCeiling));
  const barredAboveCeiling = config.models.length - poolModels.length;
  if (barredAboveCeiling > 0) {
    trace.push(
      `tier ceiling ${admittedCeiling}: ${barredAboveCeiling} roster row(s) above it are not candidates for this decision ` +
        `(T0 is admitted only by an explicit tier:T0 label or an explicit-provenance pin)`,
    );
  }

  // : a wake-scoped floor never raises the required tier and never
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
    // Live references: every early return below carries whatever the gate had
    // recorded by then, so a decision can never report an empty availability
    // record it did not actually observe.
    availability: {
      configured: Boolean(availability),
      unreadableReason: availability?.unreadableReason ?? null,
      excluded: excludedByLane,
      unknown: unknownLanes,
      selectedOnUnknownLane: false,
      evidenceExcluded,
      incumbentEvidence,
    },
    //  (D1e). Said on every decision, including when the veto did
    // nothing — a gate that is silent when unconfigured is indistinguishable
    // from a gate that is silent because it is broken.
    deadVeto: { bypassedAllDead: bypassAllDead },
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
  // hard stop (, Defect 6): staying sticky to a model whose lane is
  // exhausted/unavailable would silently wedge the issue there with no path
  // to escalate, the same failure `hardStopExcluded` exists to prevent for
  // every other candidate below — sticky is a preference for continuity, not
  // a capacity override.
  if (config.stickyWithinIssue && descriptor.stickyModelId) {
    const stickyModelId = resolveConfiguredModelId(descriptor.stickyModelId, config.models);
    const incumbent = poolModels.find(
      (model) => model.id === stickyModelId && model.enabled,
    );
    const incumbentVetoed =
      incumbent && paceActive && deadVetoExcluded(ledger, incumbent, deadVetoScope);
    // Sticky history is not an opt-in: an incumbent above the ceiling (a T0 row
    // from a pin, floor or earlier decision) is declined and the issue re-selects.
    const barredIncumbent = config.models.find(
      (model) => model.id === stickyModelId && model.enabled && tierIndex(model.tier) > tierIndex(admittedCeiling),
    );
    if (!incumbent && barredIncumbent) {
      trace.push(
        `sticky ${barredIncumbent.id} (${barredIncumbent.tier}) declined: above the ${admittedCeiling} tier ceiling — sticky history is not a ${barredIncumbent.tier} opt-in, re-selecting`,
      );
    }
    const incumbentUnserviceable = incumbent && paceActive && hardStopExcluded(ledger, incumbent, now);
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
    } else if (incumbent && isAdapterBlockedModel(incumbent.id, descriptor.agentAdapterType)) {
      // : staying sticky to an adapter-incompatible model would wedge
      // the issue on a lane that refuses every dispatch at the provider level.
      trace.push(
        `sticky ${incumbent.id} declined: incompatible with the ${descriptor.agentAdapterType} adapter — re-selecting instead of wedging this issue on a refusing lane`,
      );
      rejections.push({
        modelId: incumbent.id,
        stage: "adapter",
        reason: `${incumbent.id} is incompatible with the ${descriptor.agentAdapterType} adapter (Devin rejects the Claude Code system banner)`,
        operand: { kind: "adapter", modelId: incumbent.id, adapterType: descriptor.agentAdapterType as string },
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
    } else if (incumbent && incumbentVetoed) {
      //  (D1e). Same reasoning as the hard stop above: a warm prompt
      // cache on a lane with zero successes in its last 5 polls is worth
      // nothing. Recorded under its own stage so `decisions.jsonl` answers
      // which instrument took the lane out.
      const streak = ledger[incumbent.laneId ?? ""]?.consecutiveNonSuccess ?? 0;
      trace.push(
        `sticky ${incumbent.id} declined: lane ${incumbent.laneId ?? "(none)"} is dead-vetoed ` +
          `(${streak} consecutive polls with zero successes) — re-selecting instead of wedging this issue on a dead lane`,
      );
      rejections.push({
        modelId: incumbent.id,
        stage: "lane-dead-veto",
        reason: `lane ${incumbent.laneId ?? "(none)"} has ${streak} consecutive polls with zero successes`,
        operand: {
          kind: "lane-dead-veto",
          laneId: incumbent.laneId ?? null,
          consecutiveNonSuccess: streak,
        },
      });
    } else if (incumbent && !clearsEvidence(incumbent)) {
      // A warm prompt cache on a lane that has never once returned a run is
      // worth nothing — same reasoning as the availability branch below, from
      // the instrument that can actually see `providers=devin`. Note this can
      // only fire on `proven-dead`: the cost-down guard compares the incumbent
      // against itself here, and a lane is never worse than itself.
      trace.push(
        `sticky ${incumbent.id} declined: lane ${incumbent.laneId ?? "(none)"} evidence — ` +
          `${evidenceExcluded.find((note) => note.modelId === incumbent.id)?.reason ?? "proven-dead"}`,
      );
    } else if (incumbent && !clearsLane(incumbent)) {
      // Same reasoning as the hard stop above, from the other input. A warm
      // prompt cache on a lane returning 500 is worth nothing.
      trace.push(
        `sticky ${incumbent.id} declined: lane ${incumbent.laneId ?? "(none)"} availability — ` +
          `${excludedByLane.concat(unknownLanes).find((note) => note.modelId === incumbent.id)?.reason ?? "unavailable"}`,
      );
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

  // . Read once, here, because the ledger now feeds two consumers with
  // opposite standing: the `card-accept-rate` GATE in the loop below (live on
  // shipped config) and the shadow-diff/objective ordering far downstream
  // (inert unless `objective` is switched off its default).
  const cardLedger = input.cardLedger ?? {};

  // Gate every model. A gate is a filter, never a score adjustment — a model
  // that cannot do the work is out, however cheap it is.
  const qualified: ModelEntry[] = [];
  for (const model of poolModels) {
    if (!model.enabled) {
      rejections.push({ modelId: model.id, stage: "disabled", reason: "disabled in the roster", operand: { kind: "disabled" } });
      continue;
    }
    // . Adapter-compatibility: `devin/*` cannot serve a `claude_local`
    // assignee — Devin's content filter rejects the Claude Code / Agent SDK
    // system banner (Cognition ticket 71806; measured 25 failed / 3 succeeded
    // runs on claude_local+devin). An exclusion, never a down-rank, and an
    // unknown adapter never excludes. Runs before capability so the recorded
    // gate names the incompatibility rather than a coincidental capability gap.
    if (isAdapterBlockedModel(model.id, descriptor.agentAdapterType)) {
      const adapterType = descriptor.agentAdapterType as string;
      rejections.push({
        modelId: model.id,
        stage: "adapter",
        reason: `${model.id} is incompatible with the ${adapterType} adapter (Devin rejects the Claude Code system banner)`,
        operand: { kind: "adapter", modelId: model.id, adapterType },
      });
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
    //  port of `tier_dispatcher.py` `model_scores.py`'s `capable()`:
    // a model can clear the static roster `tier-floor` above and still be
    // measurably failing this tier's actual work. `capable` is a tri-state
    // (`true`/`false`/`null` for "not enough evidence either way") — only an
    // explicit `false` excludes; fail-open when `config.modelScores` is unset,
    // when this model has no recorded score, or when the tier verdict is
    // `null`, so a company with no scored history yet sees no change.
    // : read through `tierScoreFor`, so a tier with no proven
    // evidence of its own cannot pass where an easier tier failed.
    const modelScore = config.modelScores?.[model.id];
    const score = tierScoreFor(modelScore, requiredTier);
    if (score && score.capable === false) {
      const cappedBy = score.cappedBy;
      rejections.push({
        modelId: model.id,
        stage: "capability-score",
        reason:
          cappedBy === undefined
            ? `measured ${requiredTier} success rate (p=${score.p}) is below the capability threshold`
            : `no proven ${requiredTier} evidence of its own, and it fails the easier ${cappedBy} tier (p=${modelScore?.tiers[cappedBy]?.p})`,
        operand:
          cappedBy === undefined
            ? { kind: "capability-score", tier: requiredTier, p: score.p }
            : { kind: "capability-score", tier: requiredTier, p: score.p, cappedBy },
      });
      continue;
    }
    // . `capability-score` above measures whether RUNS succeed; this
    // measures whether the CARDS those runs closed stayed closed. A model can
    // pass the first and fail this one: `gpt-6-astra` read a 98.0% run success
    // rate over 296 runs on 2026-09-22 while every resolved T1 card attributed
    // to it had been reopened or rejected.
    //
    // Deliberately an exclusion and not a rank penalty. A down-rank still
    // routes the card the moment the cheaper rows are busy, which is exactly
    // when a rework loop is most expensive; and the objective that would carry
    // the penalty (`cost-per-accepted-card`) is not the shipped one, so a
    // penalty would have no live effect at all.
    //
    // Require a valid, mature cohort and recheck its expiry on this decision's
    // clock. An old cache must not turn a bounded exclusion into a sticky ban.
    const zeroAccept = zeroAcceptEvidence(model.id, requiredTier, cardLedger, now);
    if (zeroAccept) {
      rejections.push({
        modelId: model.id,
        stage: "card-accept-rate",
        reason: `0 of ${zeroAccept.cardsResolved} mature ${requiredTier} cards were accepted (all reopened or rejected); evidence expires ${new Date(zeroAccept.expiresAtMs).toISOString()}`,
        operand: {
          kind: "card-accept-rate",
          tier: requiredTier,
          cardsResolved: zeroAccept.cardsResolved,
          cardsAccepted: zeroAccept.cardsAccepted,
        },
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
    // Serviceability hard stop: a lane that is exhausted or
    // unavailable excludes its model outright, same as a missing capability
    // — never merely deprioritized. `paceActive` gates this off entirely in
    // `pacing.mode: off`, and `hardStopExcluded` itself is fail-neutral: an
    // unpolled or malformed lane (`verdict === null`) excludes nothing.
    // A serviceability hard stop is never waived by an operator override — the
    // same rule `repinAllowed` applies to `pin:operator`: staying pinned to a
    // dead lane is a silent failure, not "leaving it alone", so the strongest
    // override in this design still yields to it.
    if (paceActive && hardStopExcluded(ledger, model, now)) {
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
    //  (D1e). The dead-lane veto: a lane with zero successes in its
    // last 5 consecutive polls excludes its models outright, at the same gate
    // position as `lane-unserviceable` — never merely deprioritized. Gated on
    // `paceActive` like the hard stop (inert when `pacing.mode` is off), and
    // fail-open on an absent configured set and on the all-lanes-dead bypass
    // (both decided in `deadVetoExcluded` via `deadVetoScope`).
    if (paceActive && deadVetoExcluded(ledger, model, deadVetoScope)) {
      const streak = ledger[model.laneId ?? ""]?.consecutiveNonSuccess ?? 0;
      rejections.push({
        modelId: model.id,
        stage: "lane-dead-veto",
        reason: `lane ${model.laneId ?? "(none)"} has ${streak} consecutive polls with zero successes`,
        operand: {
          kind: "lane-dead-veto",
          laneId: model.laneId ?? null,
          consecutiveNonSuccess: streak,
        },
      });
      continue;
    }
    // : a lane whose combined utilization has reached its configured
    // withdrawal ceiling is out for NEW dispatch, through the same hard-stop
    // path: excluded outright, never waived by an operator override, and
    // counted as capacity when it empties a tier. Off unless the lane has a
    // ceiling. An issue already sticky to the lane keeps it (see the sticky
    // block above): this is about where new work starts, not about evicting
    // work in flight.
    const withdrawal = paceActive && config.laneAvoidConfig
      ? laneWithdrawal(ledger, model.laneId, config.laneAvoidConfig, now)
      : null;
    if (withdrawal) {
      if (!withdrawnLanes.has(withdrawal.laneId)) {
        withdrawnLanes.add(withdrawal.laneId);
        trace.push(
          `lane ${withdrawal.laneId} withdrawn from new dispatch: combined utilization ` +
            `${withdrawal.utilization.toFixed(4)} across ${withdrawal.accounts} account(s) is at or above its ` +
            `${withdrawal.ceiling} withdrawal ceiling`,
        );
      }
      rejections.push({
        modelId: model.id,
        stage: "lane-withdrawn",
        reason:
          `lane ${withdrawal.laneId} is withdrawn: combined utilization ${withdrawal.utilization.toFixed(4)} ` +
          `is at or above its ${withdrawal.ceiling} withdrawal ceiling`,
        operand: {
          kind: "lane-withdrawn",
          laneId: withdrawal.laneId,
          utilization: withdrawal.utilization,
          ceiling: withdrawal.ceiling,
          accounts: withdrawal.accounts,
        },
      });
      continue;
    }
    //  AC-1: the availability term excludes, exactly as a missing
    // capability does, and never merely down-ranks. Measured on , the
    // down-ranking alternative is not a weaker version of this — it is a
    // no-op: the router's `normalizeHealth` buckets `health: "cooldown"` as
    // degraded, `postureFor` turns degraded into `avoid`, and an avoided lane
    // stays selectable. It looks handled and keeps taking traffic.
    if (!clearsLane(model)) continue;
    //  second failure shape. Same exclusion discipline, different
    // instrument: `clearsLane` reads the published contract, this reads what
    // dispatches to the lane actually did. `devin/*` passes the first and
    // fails this one.
    if (!clearsEvidence(model)) continue;
    // : lane avoid threshold and operator-declared outage, ported from
    // `tier_dispatcher.py`'s `AVOID`/`AVOID_LANE` and `lane_outage.json`. Both
    // are gated the same as the hard stop above (`paceActive` only) and, like
    // it, are never waived by an operator override.
    if (paceActive && config.laneAvoidConfig && laneAvoidExcluded(ledger, model, config.laneAvoidConfig)) {
      rejections.push({
        modelId: model.id,
        stage: "lane-avoid",
        reason: `lane ${model.laneId ?? "(none)"} is at or above its avoid threshold and ahead of its window pace margin`,
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
    //  port of `tier_dispatcher.py`'s `lane_has_room()`: a per-account
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
      poolModels.some((entry) => entry.laneId === codexLaneId && entry.enabled)
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

  // Say what the availability term did on EVERY decision, including when it did
  // nothing. A gate that is silent when unconfigured is indistinguishable from
  // a gate that is silent because it is broken.
  if (!availability) {
    trace.push("lane availability: no lane input supplied — the term is not configured and excluded nothing");
  } else if (excludedByLane.length > 0) {
    trace.push(
      `lane availability excluded ${excludedByLane.length} candidate(s): ` +
        excludedByLane.map((note) => `${note.modelId} [${note.term}] ${note.reason}`).join("; "),
    );
  }
  if (unknownLanes.length > 0) {
    trace.push(
      `lane availability UNKNOWN for ${unknownLanes.length} candidate(s): ` +
        unknownLanes.map((note) => `${note.modelId} [${note.term}] ${note.reason}`).join("; "),
    );
  }

  // Same discipline for the evidence term: say what it did on every decision,
  // including nothing. AC-6 — this is the line that has to answer "why did this
  // card not get opus" from `decisions.jsonl` alone.
  if (!laneEvidence) {
    trace.push("lane evidence: no run-outcome input supplied — the term is not configured and excluded nothing");
  } else {
    trace.push(
      `lane evidence over ${laneEvidence.windowHours}h` +
        (laneEvidence.unreadableReason
          ? ` UNREADABLE (${laneEvidence.unreadableReason}) — every lane is unproven`
          : `: ${laneEvidence.lanes.filter((lane) => lane.state === "proven-good").length} proven-good, ` +
            `${laneEvidence.lanes.filter((lane) => lane.state === "proven-dead").length} proven-dead, ` +
            `${laneEvidence.lanes.filter((lane) => lane.state === "unproven").length} unproven`) +
        `; incumbent lane is ${incumbentEvidence}`,
    );
    if (evidenceExcluded.length > 0) {
      trace.push(
        `lane evidence excluded ${evidenceExcluded.length} candidate(s): ` +
          evidenceExcluded.map((note) => `${note.modelId} [${note.term}] ${note.reason}`).join("; "),
      );
    }
  }

  // : say what the adapter-compatibility gate did on every decision,
  // including nothing — the same AC-6 discipline as the availability and
  // evidence terms above, so `decisions.jsonl` answers "why did this
  // claude_local card not get devin" without re-deriving it.
  const adapterExcluded = rejections.filter((rejection) => rejection.stage === "adapter");
  if (adapterExcluded.length > 0) {
    trace.push(
      `adapter compatibility excluded ${adapterExcluded.length} candidate(s): ` +
        adapterExcluded.map((rejection) => `${rejection.modelId} [adapter]: ${rejection.reason}`).join("; "),
    );
  }

  if (qualified.length === 0) {
    // , Defect 2. Distinguish a genuine capacity dead end from an
    // ordinary config/capability gap. If every model from `requiredTier`
    // through the admitted ceiling that survived the disabled/capability/context
    // gates was excluded ONLY by the pace serviceability hard stop, there is
    // nowhere left to escalate to — that is `tier-exhausted`, and it must
    // reach an operator (see `worker.ts`), never fail silently the way the
    // reference dispatcher's `pick()` does. A mix with a disabled/capability/
    // context rejection means the gap is a config problem, not capacity, so
    // it stays `no-eligible-model`.
    const atOrAboveRequired = rejections.filter((rejection) => {
      const rejectedModel = poolModels.find((entry) => entry.id === rejection.modelId);
      return rejectedModel ? tierIndex(rejectedModel.tier) >= tierIndex(requiredTier) : false;
    });
    // `lane-availability` counts here alongside `lane-unserviceable`:
    // both are capacity, and which of the two inputs saw the outage first is an
    // implementation detail. Routing a wholly-unserviceable tier to
    // `no-eligible-model` would report a capacity outage as a config gap and
    // strand it — `tier-exhausted` is the outcome that reaches an operator.
    // `lane-evidence` joins them for the same reason: a tier whose every lane
    // has proven dead is a capacity outage, and the fact that run history
    // rather than a quota document is what proved it changes nothing about who
    // needs to hear about it. `lane-dead-veto` (, D1e) joins them for
    // the same reason again: a tier whose every lane has zero poll successes
    // is a capacity dead end — never silent misrouting.
    // `lane-withdrawn` joins them: a tier whose every lane sits at
    // its withdrawal ceiling is a capacity outage by the operator's own
    // definition of one.
    const CAPACITY_STAGES = new Set(["lane-unserviceable", "lane-availability", "lane-evidence", "lane-dead-veto", "lane-withdrawn"]);
    // ...with one exception, and it is the tri-state one. If the only reason
    // nothing qualified is that `holdOnUnknownAvailability` excluded lanes
    // nobody could READ, that is not a capacity dead end — it is a blind
    // instrument, and reporting it as `tier-exhausted` would send an operator
    // to the quota dashboards for a telemetry outage. Hold at the floor, which
    // is what this engine already does for the other "we do not actually know"
    // input (an untrusted volume profile).
    const unknownModelIds = new Set(unknownLanes.map((note) => note.modelId));
    if (
      atOrAboveRequired.length > 0 &&
      atOrAboveRequired.every(
        (rejection) => rejection.stage === "lane-availability" && unknownModelIds.has(rejection.modelId),
      )
    ) {
      const reason =
        `lane availability is UNKNOWN for every candidate at or above ${requiredTier} ` +
        `(${unknownLanes.map((note) => note.reason).join("; ")}) and selection.holdOnUnknownAvailability is on`;
      trace.push(`held at agent floor: ${reason}`);
      return { ...base, outcome: "held-at-floor", heldReason: reason };
    }
    const tierExhausted =
      atOrAboveRequired.length > 0 && atOrAboveRequired.every((rejection) => CAPACITY_STAGES.has(rejection.stage));
    if (tierExhausted) {
      trace.push(
        `tier exhausted: every candidate from ${requiredTier} through the ${admittedCeiling} ceiling was excluded by a capacity ` +
          `gate (${atOrAboveRequired.length} rejection${atOrAboveRequired.length === 1 ? "" : "s"}) — nowhere left to escalate to`,
      );
      return { ...base, outcome: "tier-exhausted", effectiveTier: requiredTier };
    }
    trace.push(`no model cleared the gates (${rejections.length} rejected)`);
    return base;
  }

  // Cost against the judged tier's measured multi-turn volume. Consult
  // fallback-only rows only when no regular row at or above the required tier
  // clears ALL gates. A weaker normal row cannot suppress qualified fallback;
  // a stronger qualified normal row must not lose to fallback at a lower rung.
  const regularModels = qualified.filter((model) => !model.fallbackOnly);
  const selectionPool = regularModels.length > 0 ? regularModels : qualified;
  if (regularModels.length === 0) {
    trace.push("no qualified regular candidate survived; considering fallback-only roster rows");
  }
  const profileVerdict = resolveProfile(requiredTier, profiles, now);
  trace.push(`volume profile: ${profileVerdict.reason}`);

  function costCandidates(models: readonly ModelEntry[]): Candidate[] {
    const candidates: Candidate[] = [];
    for (const model of models) {
      const cost = costOf(model, requiredTier, profiles, poolModels, signals, now, admittedCeiling);
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

  // , Defect 2. Walk the tier ladder one rung at a time, starting at
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
    const atRung = selectionPool.filter((model) => model.tier === rung);
    if (atRung.length === 0) continue;

    const rungCandidates = costCandidates(atRung);
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
    //  owner rule: same vendor family, tier, and price — the newer
    // release wins outright unless the older one carries an explicit
    // earn-in verdict proving it's better. Checked before the plain
    // newest-release fallback, which stays as the tiebreak for a same-price
    // coincidence across unrelated models.
    const leftModel = config.models.find((model) => model.id === left.modelId);
    const rightModel = config.models.find((model) => model.id === right.modelId);
    if (leftModel && rightModel) {
      const familyOrder = compareSamePriceFamily(leftModel, rightModel);
      if (familyOrder !== 0) return familyOrder;
    }
    const releaseOrder = Date.parse(right.releasedAt) - Date.parse(left.releasedAt);
    if (releaseOrder !== 0) return releaseOrder;
    return left.modelId.localeCompare(right.modelId);
  });

  //  port of `tier_dispatcher.py` `pick()`'s own ordering rules —
  // free-must-be-proven, the 20% cost-band least-utilized-lane tiebreak, and
  // the 10% T2/T3 explore fraction — layered directly on top of the cost
  // sort, before pace ordering runs. Fail-open when `config.modelScores` is
  // unset: a company with no scored history yet gets the plain cost order,
  // unchanged from pre- behavior.
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

  // Pace ordering: pace state, deviation, cost, release date, id —
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
    // , Defect 5. Preferred-near-reset is the gas-pedal counterpart
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

  // Ahead-of-line slot throttling (, enforce only): a candidate whose
  // lane is `ahead` is capped at `slotFloorFraction` of traffic rather than
  // excluded — the floor never reaches zero while the lane is serviceable
  // (serviceability itself was already enforced above as a hard stop, not
  // here). Throttled-out candidates fall through to the next in order rather
  // than producing no-eligible-model.
  //
  // Ordering composition ( + ): pace answers "what can we
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

  //  rule (b), 2026-09-19 owner rule: a free subscription lane whose
  // credential is serviceable and under its per-account cap wins its tier over
  // a paid/earned model until it has enough observations to be judged —
  // otherwise a new subscription can never earn placement (21:12Z /
  // 3401 experiment: unproven Meta rows lost to earned opus-4-8 on every rung
  // because cost-0 does not outrank an earned score).
  //
  // Placement is deliberately POST-pace, after the `pacingApplied` measurement
  // above (which stays a pure pace-vs-cost signal for the 48h comparison
  // stream), in every pacing mode including `shadow`: `applyPickOrdering`'s
  // free-must-be-proven filter demotes exactly these candidates, and pace
  // ranks `free` 4th, so an earlier placement would be reordered away before
  // it could win. This is a pure reorder of the already-gated single-rung
  // `orderedCandidates` array — never an admission bypass (cap/5h gates,
  // capability, hard stop all ran upstream) and never cross-tier (the ladder
  // settled the rung above). An operator override still wins outright (the
  // `pickWinnerIndex` override branch below is untouched). The slot throttle
  // needs no special handling: only an `ahead` lane throttles, and a `free`
  // verdict always clears `slotAllowed`, so the earn-in winner would survive
  // that walk identically. An explicitly-switched `objective` yields to this —
  // an owner rule about who wins the tier beats the experimental
  // cost-per-accepted-card observation switch (shipped config is `list-price`
  // anyway, so this changes nothing deployed). `allowExplore === false`
  // (repin/label-only/balance) does NOT suppress this: that flag gates the
  // random 10% sampling roll, while this is a deterministic owner rule about
  // who wins the tier. Sticky continuity is unaffected — a sticky incumbent
  // returns before this runs.
  // : earn-in never fires on protected cards (critical/high
  // priority, review/gate). The picker itself enforces the guard; this trace
  // line says which side of it this decision fell on, so `decisions.jsonl`
  // answers "why did this card not earn-in" without re-deriving it.
  const earnInGuard = earnInGuardFor(descriptor);
  const earnInPick = freeEarnInWinner(
    orderedCandidates,
    config.models,
    ledger,
    config.modelScores,
    requiredTier,
    descriptor,
  );
  if (earnInGuard.protected) {
    trace.push(`free-lane earn-in skipped: ${earnInGuard.reason}`);
  }
  const earnInOverridden =
    !!overrideModelId && orderedCandidates.some((candidate) => candidate.modelId === overrideModelId);
  if (earnInPick && !earnInOverridden && earnInPick.candidate.modelId !== orderedCandidates[0]?.modelId) {
    trace.push(
      `free-lane earn-in: routing to unproven ${earnInPick.candidate.modelId} on serviceable free lane ` +
        `${earnInPick.laneId} (${earnInPick.observations} recorded ${requiredTier} runs, not yet proven) to gather ${requiredTier} evidence`,
    );
    orderedCandidates = [
      earnInPick.candidate,
      ...orderedCandidates.filter((candidate) => candidate.modelId !== earnInPick.candidate.modelId),
    ];
  }
  const earnInWinner = earnInPick && !earnInOverridden ? earnInPick.candidate : null;

  const listPriceWinner = candidates[0]!;
  const shadowDiff = computeShadowDiff(descriptor.issueId, landingTier, candidates, listPriceWinner.modelId, cardLedger);

  // `objective` never affects `candidates`/`winner` unless explicitly switched
  // away from the default. Shipped config always leaves this at "list-price"
  // ( hard constraint) — the alternate ordering above only feeds the
  // shadow-diff record, observed for 7 days before any enforcement proposal.
  const objective = config.objective ?? "list-price";
  // Earn-in already sits at orderedCandidates[0] and clears the slot throttle
  // (only `ahead` throttles), so paceOnlyWinner IS the earn-in pick in both
  // modes — this line is belt and braces, and the objective guard below is
  // the part that actually holds the win against the experimental re-rank.
  let winner = earnInWinner ?? paceOnlyWinner;
  if (!earnInWinner && objective === "cost-per-accepted-card") {
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
  // against `ledger`/`laneOutageOverride` at all. Test it here,
  // on the exact same predicates, before handing the run back to a lane that
  // might already be dead. `winner` already cleared every gate above
  // (including serviceability), so it is always a safe explicit fallback.
  if (config.holdOnUntrustedProfile && !winner.profileTrusted) {
    const reason = `volume profile for ${requiredTier} is not trusted (${profileVerdict.reason})`;
    const floorModelId = resolveConfiguredModelId(descriptor.agentFloorModelId ?? null, config.models);
    const floorModel = floorModelId ? config.models.find((model) => model.id === floorModelId) : undefined;
    //  AC-3: the floor still exists, so the availability term is
    // encoded here too. The pace predicates above are gated on `paceActive`;
    // the availability term deliberately is not — it is supplied by
    // `input.availability`, not by `pacing.mode`, so a floor on a lane that a
    // published contract calls unavailable is dead whether or not pacing runs.
    // UNKNOWN is not dead: consistent with `isLaneUnserviceable`, a blind
    // instrument is not grounds to discard a recorded human judgement.
    const floorLaneRead = floorModel ? laneRead(floorModel) : null;
    const floorLaneUnavailable = floorLaneRead !== null && floorLaneRead.state === "unavailable";
    if (floorModel && floorLaneRead !== null && floorLaneRead.state === "unavailable") {
      // `excluded` on the decision is a live reference, so the floor's own
      // exclusion is answerable in `decisions.jsonl` even though the floor
      // never entered the candidate loop (AC-6).
      if (!excludedByLane.some((entry) => entry.modelId === floorModel.id)) {
        excludedByLane.push({
          modelId: floorModel.id,
          laneId: floorModel.laneId ?? null,
          term: floorLaneRead.term,
          reason: floorLaneRead.reason,
        });
      }
    }
    const floorLaneDead =
      !!floorModel &&
      ((paceActive &&
        (hardStopExcluded(ledger, floorModel, now) ||
          (!!config.laneAvoidConfig && laneAvoidExcluded(ledger, floorModel, config.laneAvoidConfig)) ||
          (!!config.laneAvoidConfig && laneWithdrawnExcluded(ledger, floorModel, config.laneAvoidConfig, now)) ||
          laneOutageExcluded(config.laneOutageOverride ?? null, nowIso, floorModel))) ||
        floorLaneUnavailable);
    if (floorLaneDead) {
      trace.push(
        `held-at-floor declined: floor ${floorModel!.id} lane ${floorModel!.laneId ?? "(none)"} is not serviceable` +
          (floorLaneUnavailable ? ` [${floorLaneRead!.term}: ${floorLaneRead!.reason}]` : "") +
          ` — writing an explicit pin to ${winner.modelId} instead (${reason})`,
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

  // AC-4: an UNKNOWN that reaches a selection is SAID. Under the default
  // policy this model was allowed through on a lane nobody could read, and a
  // decision stream that recorded that as an ordinary pick would be lying by
  // omission about what the engine actually knew.
  const winnerUnknown = unknownLanes.find((note) => note.modelId === winner.modelId);
  if (winnerUnknown) {
    trace.push(
      `availability UNKNOWN for the selected model: ${winnerUnknown.reason} — not treated as available; ` +
        `selection proceeded because selection.holdOnUnknownAvailability is off`,
    );
  }

  return {
    ...withCandidates,
    outcome: "selected",
    modelId: winner.modelId,
    availability: { ...withCandidates.availability, selectedOnUnknownLane: Boolean(winnerUnknown) },
  };
}
