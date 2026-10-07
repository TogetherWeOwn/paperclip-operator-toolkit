import { randomUUID } from "node:crypto";

import { definePlugin, runWorker, type PluginContext, type ToolResult } from "@paperclipai/plugin-sdk";

import { planApply, planEnvRepair, selectionWritesAllowed } from "./actuate/apply.js";
import { planEarnIn, recordEarnInOutcome } from "./actuate/earnIn.js";
import {
  buildEarnInCandidateCard,
  classifyEarnInResolution,
  isEarnInCandidateIssue,
  isEarnInCandidateModel,
  laneAvailableForEarnIn,
  lanePostureByTier,
  nextEarnInStateOnDispatch,
  nextEarnInStateOnResolve,
  normalizeEarnInState,
  pacePostureForModel,
  resolveIsClaudeModel,
} from "./actuate/earnInWiring.js";
import { reportDecisionAdmissionShadow, type DecisionAdmissionShadowInput } from "./admission-shadow.js";
import { readRunContextEvidence, type ContextUsage } from "./context-evidence.js";
import { isAgentExempt, resolveConfig, validateConfig, type ResolvedConfig } from "./config/resolve.js";
import {
  AA_FETCH_TIMEOUT_MS,
  AA_FREE_FETCH_INTERVAL_MS,
  AA_FREE_FETCH_TIMEOUT_MS,
  AA_FREE_MAX_RESPONSE_BYTES,
  AA_FREE_RETRY_INTERVAL_MS,
  AA_LEADERBOARD_URL,
  AA_MAX_RESPONSE_BYTES,
  AA_SNAPSHOT_HISTORY_LIMIT,
  MODELS_DEV_CATALOG_URL,
  MODELS_DEV_FETCH_TIMEOUT_MS,
  MODELS_DEV_MAX_RESPONSE_BYTES,
  MODELS_DEV_USER_AGENT,
  BALANCE_PASS_BUSIER_UTILIZATION_DELTA,
  BALANCE_PASS_COST_DOWN_MULTIPLIER,
  BALANCE_PASS_FETCH_LIMIT,
  BALANCE_PASS_JOB_BUDGET_MS,
  BALANCE_PASS_PROBATION_PRICE_USD,
  BALANCE_PASS_ROW_TIMEOUT_MS,
  BALANCE_PASS_WRITE_LIMIT,
  CARD_LEDGER_WINDOW_DAYS,
  CLASSIFY_FETCH_LIMIT_MAX,
  CLASSIFY_FETCH_MULTIPLIER,
  CLASSIFY_JOB_BUDGET_MS,
  CLASSIFY_ROW_TIMEOUT_MS,
  FALLBACK_LEASE_EXAMINE_LIMIT,
  FALLBACK_LEASE_WRITE_LIMIT,
  FALLBACK_PIN_INDEX_MAX,
  DISPATCH_ISSUE_PAGE_LIMIT,
  DISPATCH_SWEEP_JOB_BUDGET_MS,
  LANE_EVIDENCE_TTL_MS,
  LANE_EVIDENCE_WINDOW_HOURS,
  JOB_KEYS,
  LOCAL_FOLDER_KEYS,
  LABEL_ONLY_PASS_FETCH_LIMIT,
  LABEL_ONLY_PASS_JOB_BUDGET_MS,
  LABEL_ONLY_PASS_MAX_ROWS_PER_FIRING,
  LABEL_ONLY_PASS_ROW_TIMEOUT_MS,
  NO_ELIGIBLE_NOTICE_THROTTLE_MS,
  OPERATOR_PIN_LABEL,
  PIN_MAX_AGE_MS,
  PLUGIN_STATE_KEYS,
  REJECTION_WINDOW_MS,
  REOPEN_WINDOW_MS,
  REPIN_PASS_FETCH_LIMIT,
  REPIN_PASS_JOB_BUDGET_MS,
  REPIN_PASS_ROW_TIMEOUT_MS,
  IMPLICIT_TIER_CEILING,
  REPIN_PASS_WRITE_LIMIT,
  ROUTE_KEYS,
  SCORE_THRESHOLDS,
  SCORE_WINDOW_DAYS,
  TIER_LABEL_PREFIX,
  TIERS,
  TOOL_NAMES,
  PLUGIN_VERSION,
  type Tier,
} from "./constants.js";
import { diffSnapshot, type AaDiffModelInput } from "./aa-index/diff.js";
import { fetchAaSnapshot, type AaHttpClient } from "./aa-index/fetch.js";
import { fetchAaFreeList } from "./aa-free/fetch.js";
import { parseAaFreeList, type AaFreeSnapshot } from "./aa-free/parse.js";
import {
  buildAdviseEvidence,
  buildSyncDiff,
  freeSnapshotDigest,
  isSnapshotFresh,
  nextEligibleAfter,
  recoverSelectedCandidate,
  shouldFetchFreeSync,
  type AaFreeSyncDiff,
  type FreeFetchOutcome,
} from "./aa-free/sync.js";
import {
  buildAcceptedWorkOverlay,
  normalizeAcceptedWorkOverlay,
  type AcceptedWorkCardInput,
  type AcceptedWorkOverlay,
} from "./accepted-work/posterior.js";
import { effortSuffixOf, resolveAaSlug, tierImpliedByIndex } from "./aa-index/match.js";
import { parseAaLeaderboardHtml, type AaModelRecord } from "./aa-index/parse.js";
import { reconcilePrices, type PriceReconcileReport, type PriceRosterRow } from "./price-sync/diff.js";
import { fetchPriceCatalog, type PriceHttpClient } from "./price-sync/fetch.js";
import { parsePriceCatalog } from "./price-sync/parse.js";
import { ancillaryDriftForAgent, recommendAncillaryModel, type AncillarySurfaceDrift } from "./engine/ancillary.js";
import {
  cheapestHealthyModelIdForTier,
  overrideEnvOnExcludedLane,
  estimateIssueContext,
  modelOverrideForContext,
  staleOverrideSecretRefKeys,
  readPinProvenance,
  type PinProvenance,
} from "./engine/context.js";
import { resolveConfiguredModelId } from "./engine/model-id.js";
import { tierIndex } from "./engine/cost.js";
import { classifyCostAttribution } from "./engine/cost-attribution.js";
import { buildQualitySignals, buildVolumeProfiles, type RunRow } from "./engine/profiles.js";
import { selectModel } from "./engine/select.js";
import { normalizeAvailability, type AvailabilitySnapshot } from "./engine/availability.js";
import { resolveTier, tierFromLabels, tierOfModel, tierWithFallback } from "./engine/tier.js";
import {
  accumulateRunStats,
  applyDerivedTiers,
  blendedPriorP,
  buildCardLedger,
  buildModelScore,
  findClosingRun,
  foldReworkIntoStats,
  tierScoreFor,
  type CardRow,
  type ClosingRunCandidate,
  type ReworkClosingRun,
  type RunOutcomeRow,
} from "./engine/scores.js";
import { BENCHMARK_SPEC_VERSION, type BenchmarkRow } from "./engine/benchmark-prior.js";
import { FROZEN_BENCHMARK_ROWS } from "./engine/benchmark-data.js";
import type {
  AaEffortEvidence,
  CardLedgerEntry,
  EarnInState,
  IssueDescriptor,
  ModelEntry,
  ModelScore,
  QualitySignal,
  SelectionDecision,
  VolumeProfile,
} from "./engine/types.js";
import { inheritedEffortFrom } from "./engine/effort.js";
import { prepareTierPolicyEdit, renderTierPolicyEditResult } from "./engine/tier-policy-edit.js";
import { TIER_POLICY_TOOL_DESCRIPTION, TIER_POLICY_TOOL_DISPLAY_NAME, TIER_POLICY_TOOL_PARAMETERS } from "./tier-policy-tool.js";
import type { AaBinding } from "./aa-free/registry.js";
import {
  activeOperatorOverride,
  activeZaiPaceOverride,
  blendedListPrice,
  deadVetoExcluded,
  hardStopExcluded,
  isBehindPace,
  isLaneOutageActive,
  laneAvoidExcluded,
  laneWithdrawnExcluded,
  laneEffectiveUtilization,
  laneHasRoom,
  laneHealthyAccountCount,
  laneOutageExcluded,
  mergeLedgerEntry,
  pacePreferenceRank,
  recordOperatorOverride,
  repinAllowed,
  type LaneLedger,
  type LaneOutageOverride,
  type OperatorOverrideLedger,
  type ZaiPaceOverride,
} from "./engine/pacing.js";
import { availabilityDocumentFrom } from "./lane-capacity/availability-source.js";
import { pollLanes, type LanePollHttpClient, type LaneSourceDefinition } from "./lane-capacity/poll.js";
import { autoQuarantineFor, laneExhaustionFromRunFailure, mergeLaneOutage } from "./lane-capacity/run-failure.js";
import { buildHostRecord, buildShadowRecord } from "./shadow-emit.js";
import {
  ACTIVE_ROUTED_RUN_MODELS_SQL,
  CREATION_PIN_LIVE_RUNS_SQL,
  LANE_EVIDENCE_RUNS_SQL,
  LAST_RUN_CONTEXT_USAGE_SQL,
  PREVIOUS_RUN_DECISION_SQL,
  REFRESH_SCORE_CLOSING_RUNS_SQL,
  REFRESH_SCORE_RUNS_SQL,
} from "./sql.js";
import { HotCache, HotCacheTimeout, withinMs } from "./hot-cache.js";
import {
  resolveRunDecision,
  type ResolveRunModelParams,
  type ResolveRunModelResult,
  type RunAgentFacts,
  type RunDecisionRecord,
  type RunIssueFacts,
  type RunResolveSnapshot,
} from "./engine/run-resolve.js";
import {
  buildLaneEvidence,
  costDownWouldAbandonProvenLane,
  evidenceStateFor,
  type LaneEvidenceSnapshot,
} from "./engine/lane-evidence.js";
import {
  accumulateTierPollOutcomes,
  normalizeTierPollOutcomes,
  type TierPollOutcomes,
} from "./engine/tier-outcomes.js";
import { callClassifier, type ClassificationHttpClient } from "./engine/classify-call.js";
import { scanMarkAfterWalk, walkRowsWithinDeadline } from "./row-walk.js";
import {
  buildClassificationPrompt,
  parseClassificationResponse,
  resolveClassifiedTiers,
  RUBRIC,
} from "./engine/classify.js";
import {
  selectDispatch,
  summariseRoutingGap,
  identifyRoutingOwners,
  isMonitorArmed,
  isParkedOnNamedOwner,
  TERMINAL_STATUSES as DISPATCH_TERMINAL_STATUSES,
  type DispatchIssue,
  type DispatchPopulationEntry,
} from "./engine/dispatch-selection.js";
import {
  summariseFiring,
  hasStateChanged,
  emitMetrics,
  logStateChange,
  wakeFailureCodeFor,
  type WakeOutcome,
} from "./dispatch-reporting.js";

/**
 * . The SDK this package builds against (2026.824.1) predates the
 * run-model hook; the fork's SDK adds `onResolveRunModel` to
 * `PluginDefinition`. Widen the definition here so the handler type-checks on
 * both, and the host's own validator stays the authority on the wire shape.
 */
type PluginDefinitionWithRunResolve = Parameters<typeof definePlugin>[0] & {
  onResolveRunModel?: (params: ResolveRunModelParams) => Promise<ResolveRunModelResult>;
};

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * . The Paperclip tool gateway maps a plugin result to
 * `structuredContent: result?.data ?? null`, and the Claude client rejects a
 * null `structuredContent` — every tool call that returned only `{content}`
 * (or an explicit `data: null`) failed schema validation in Claude Code.
 * Every `ctx.tools.register` handler below therefore returns a plain-object
 * `data` on EVERY path, including validation rejections, which use this
 * `{ ok: false, error: <code> }` shape. `content` is unchanged — it stays the
 * human-readable message; `data` is the machine-readable record.
 */
function toolRejection(error: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: false, error, ...extra };
}

interface StoredProfiles {
  profiles: VolumeProfile[];
  signals: QualitySignal[];
}

/** One captured `issue.updated`/`issue.comment.created` rework signal, pending a `refreshScores` fold. */
interface ReworkSignal {
  issueId: string;
  atMs: number;
  kind: "reopen" | "rejected";
  /** Excluded from the closing-run match when this signal is a rejection (comment author != closer). */
  excludeAgentId: string | null;
}


/**
 * The patch we send to `issues.update`.
 *
 * `assigneeAdapterOverrides` is a real `issues` column
 * (`assignee_adapter_overrides jsonb`, verified against the live DB) and the
 * host bridge spreads the patch verbatim into `issues.update`
 * (`plugin-host-services.ts:1901-1938` → `issues.ts:7440`). The SDK's `update()`
 * TS signature omits it, so this type is deliberately wider than the SDK's —
 * see README "Typed narrower than the host".
 */
interface IssueUpdatePatch {
  assigneeAdapterOverrides: {
    adapterConfig: { model: string; env?: Record<string, unknown> };
  };
  labelIds?: string[];
}

function summary(decision: SelectionDecision): string {
  if (decision.outcome === "selected") {
    const wakeNote = decision.wakeScopedTier
      ? ` — wake-scoped floor ${decision.wakeScopedTier} (card tier ${decision.judgement.tier} unchanged)`
      : "";
    //  (D1e): a bypassed all-dead window admitted as today — the
    // tool answer must say the poller is suspect, not report a routine pick.
    const bypassNote = decision.deadVeto.bypassedAllDead
      ? " — dead-lane veto bypassed: every configured lane met the dead condition, poller-side outage suspect"
      : "";
    return `${decision.modelId} at ${decision.effectiveTier} (tier via ${decision.judgement.source})${
      decision.advisory ? " — advisory, nothing written" : ""
    }${wakeNote}${bypassNote}`;
  }
  if (decision.outcome === "held-at-floor") {
    return `Held at the agent floor: ${decision.heldReason}`;
  }
  if (decision.outcome === "disabled") return "Model Selection is not configured for this company.";
  if (decision.outcome === "tier-exhausted") {
    return `Tier exhausted: every model from ${decision.judgement.tier} through T1 is pace-exhausted; nowhere left to escalate to.`;
  }
  return "No eligible model for this issue.";
}

/**
 * A single scheduled pass's per-issue memo of {@link ContextUsage}, keyed
 * `companyId:issueId`. Created per pass and passed explicitly, so it cannot
 * outlive its pass or leak one company's rows into another's. In-flight
 * promises are stored rather than resolved values, so concurrent asks for one
 * issue collapse to a single `heartbeat_runs` read.
 */
type ContextUsageCache = Map<string, Promise<ContextUsage>>;

export function createPlugin() {
  let context: PluginContext | null = null;

  /**
   *  reopen: `ctx.companies.list()` is a wildcard host call that,
   * unlike every other call this worker makes, is not carried by the
   * per-company `proactiveCompanyScopes` authorization the host seeds
   * from this plugin's configured companies. A scheduled
   * job's `companies.list()` call therefore only succeeds when no other
   * invocation happens to be active in the worker process at that exact
   * moment — nondeterministic, and observed failing from the real
   * scheduler with "the worker referenced a missing, expired, or unknown
   * invocation scope". Every job here immediately filters the company
   * list down to "configured for this plugin" anyway (each loop bails
   * on an empty/disabled config), so tracking exactly that set ourselves
   * — fed by `onConfigChanged`, which the host already calls
   * unconditionally for every configured company at worker startup and
   * on every subsequent config save — is both sufficient and reliable:
   * it never depends on unrelated concurrent worker activity.
   */
  const knownCompanyIds = new Set<string>();
  const listKnownCompanies = (): Array<{ id: string }> =>
    [...knownCompanyIds].map((id) => ({ id }));

  const knownCompaniesKey = () => ({
    scopeKind: "instance" as const,
    stateKey: PLUGIN_STATE_KEYS.knownCompanies,
  });

  /**
   * . Bound by `setup()`; the SDK calls `onResolveRunModel` on the
   * definition, which has no access to the setup closure. Until setup has run
   * the honest answer is `defer`, never a guess.
   */
  let runResolveHandler = null as ((params: ResolveRunModelParams) => Promise<ResolveRunModelResult>) | null;
  let invalidateRunSnapshot = null as ((companyId: string) => void) | null;

  return definePlugin({
    multiCompanyConfig: true,

    async setup(ctx) {
      context = ctx;

      const companyConfig = async (companyId: string): Promise<ResolvedConfig> =>
        resolveConfig(await ctx.config.get(companyId));

      const profilesKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.volumeProfiles,
      });

      const readProfiles = async (companyId: string): Promise<StoredProfiles> => {
        const stored = asRecord(await ctx.state.get(profilesKey(companyId)));
        return {
          profiles: Array.isArray(stored.profiles) ? (stored.profiles as VolumeProfile[]) : [],
          signals: Array.isArray(stored.signals) ? (stored.signals as QualitySignal[]) : [],
        };
      };

      // --- : lane pace ledger, operator overrides, repin history ----

      const laneLedgerKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.laneLedger,
      });

      const readLaneLedger = async (companyId: string): Promise<LaneLedger> => {
        const stored = await ctx.state.get(laneLedgerKey(companyId));
        return stored && typeof stored === "object" ? (stored as LaneLedger) : {};
      };

      // --- : lane availability -------------------------------------

      const laneAvailabilityKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.laneAvailability,
      });

      /**
       * Read fresh on every decision, never memoized: both measured outage
       * shapes were transient (a ~4-minute cooldown, a window that recovered
       * inside two hours), so a snapshot held past its window reintroduces
       * exactly the staleness this term exists to detect. `normalizeAvailability`
       * converts an unreadable document into a snapshot of UNKNOWNs rather
       * than throwing — a broken instrument must not take selection down.
       */
      const readAvailability = async (
        companyId: string,
        nowMs: number,
      ): Promise<AvailabilitySnapshot> => {
        const stored = await ctx.state.get(laneAvailabilityKey(companyId));
        return normalizeAvailability(stored, nowMs);
      };

      /**
       * , second failure shape: the lane-evidence term's input.
       *
       * Short-TTL and re-read rather than cached in config, for the same reason
       * the availability term is. The TTL exists only so the three scheduled
       * sweeps do not re-run this aggregate once per issue — `balance_pass`
       * alone walks every open card.
       *
       * Fails to UNREADABLE, never throws: a broken instrument marks every lane
       * `unproven`, which excludes nothing and merely blocks a cost-down move.
       * A term that took selection down when its own query failed would be a
       * worse outage than the one it exists to prevent.
       */
      let laneEvidenceCache: { companyId: string; atMs: number; snapshot: LaneEvidenceSnapshot } | null =
        null;

      const readLaneEvidence = async (
        companyId: string,
        models: readonly ModelEntry[],
        nowMs: number,
      ): Promise<LaneEvidenceSnapshot> => {
        if (
          laneEvidenceCache &&
          laneEvidenceCache.companyId === companyId &&
          nowMs - laneEvidenceCache.atMs < LANE_EVIDENCE_TTL_MS
        ) {
          return laneEvidenceCache.snapshot;
        }
        let snapshot: LaneEvidenceSnapshot;
        try {
          const rows = (await ctx.db.query(LANE_EVIDENCE_RUNS_SQL, [
            companyId,
            String(LANE_EVIDENCE_WINDOW_HOURS),
          ])) as unknown[];
          // The model -> lane fold. `providers=devin` is ONE credential failing
          // for seven model ids at once: per model each looks like a thin
          // sample, per lane they are one conclusive 0/74.
          const byLane = new Map<string, { succeeded: number; failed: number }>();
          for (const row of rows) {
            const record = asRecord(row);
            const modelId = typeof record.model === "string" ? record.model : null;
            if (!modelId) continue;
            const laneId = models.find((entry) => entry.id === modelId)?.laneId ?? null;
            if (!laneId) continue;
            const bucket = byLane.get(laneId) ?? { succeeded: 0, failed: 0 };
            bucket.succeeded += Number(record.succeeded) || 0;
            bucket.failed += Number(record.failed) || 0;
            byLane.set(laneId, bucket);
          }
          snapshot = buildLaneEvidence(
            [...byLane.entries()].map(([laneId, counts]) => ({ laneId, ...counts })),
            LANE_EVIDENCE_WINDOW_HOURS,
          );
        } catch (error) {
          snapshot = {
            lanes: [],
            windowHours: LANE_EVIDENCE_WINDOW_HOURS,
            unreadableReason: `heartbeat_runs read failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
        laneEvidenceCache = { companyId, atMs: nowMs, snapshot };
        return snapshot;
      };

      const operatorOverridesKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.operatorOverrides,
      });

      const readOperatorOverrides = async (companyId: string): Promise<OperatorOverrideLedger> => {
        const stored = await ctx.state.get(operatorOverridesKey(companyId));
        return stored && typeof stored === "object" ? (stored as OperatorOverrideLedger) : {};
      };

      const laneOutageKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.laneOutage,
      });

      const readLaneOutage = async (companyId: string): Promise<LaneOutageOverride | null> => {
        const stored = await ctx.state.get(laneOutageKey(companyId));
        if (!stored || typeof stored !== "object") return null;
        const record = stored as Record<string, unknown>;
        if (!Array.isArray(record.lanes) || !Array.isArray(record.models) || typeof record.until !== "string") {
          return null;
        }
        return {
          lanes: record.lanes.filter((l): l is string => typeof l === "string"),
          models: record.models.filter((m): m is string => typeof m === "string"),
          until: record.until,
          ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
        };
      };

      const zaiPaceOverrideKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.zaiPaceOverride,
      });

      const readZaiPaceOverride = async (companyId: string): Promise<ZaiPaceOverride | null> => {
        const stored = await ctx.state.get(zaiPaceOverrideKey(companyId));
        if (!stored || typeof stored !== "object") return null;
        const record = stored as Record<string, unknown>;
        if (typeof record.margin !== "number" || typeof record.until !== "string") return null;
        return { margin: record.margin, until: record.until };
      };

      const paceRepinHistoryKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.paceRepinHistory,
      });

      const readPaceRepinHistory = async (companyId: string): Promise<Record<string, string>> => {
        const stored = asRecord(await ctx.state.get(paceRepinHistoryKey(companyId)));
        const history: Record<string, string> = {};
        for (const [issueId, at] of Object.entries(stored)) {
          if (typeof at === "string") history[issueId] = at;
        }
        return history;
      };

      const tierExhaustedAlarmsKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.tierExhaustedAlarms,
      });

      const readTierExhaustedAlarms = async (companyId: string): Promise<Record<string, string>> => {
        const stored = asRecord(await ctx.state.get(tierExhaustedAlarmsKey(companyId)));
        const alarms: Record<string, string> = {};
        for (const [issueId, at] of Object.entries(stored)) {
          if (typeof at === "string") alarms[issueId] = at;
        }
        return alarms;
      };

      /**
       * , Defect 2. `tier-exhausted` is a capacity dead end — every
       * model from the required tier through the T1 ceiling is
       * pace-unserviceable, and there is nowhere left for the ladder walk in
       * `select.ts` to climb to. `ctx.metrics.write` records the outcome for
       * dashboards, but a metric is not something an operator sees; this is
       * the "must reach an operator card, never a silent no-op" half.
       *
       * This reuses the instance's existing `Operator: <title>` + `operator`
       * label issue-creation convention (confirmed against 20+ live examples
       * — , , , etc. — all plain `manual`-origin
       * issues, usually a child of the blocked issue, usually unassigned).
       * That is a materially different mechanism from a same-issue
       * confirmation card: it is a real, separately-triaged unit of work, and
       * an unrecoverable capacity dead end is exactly that, not a
       * notification. One escalation issue per continuous exhaustion streak:
       * `tierExhaustedAlarms` gates re-creation while still exhausted, and is
       * cleared the moment the issue is no longer exhausted so the NEXT
       * exhaustion raises a fresh escalation rather than staying silent
       * forever.
       */
      const raiseOrClearTierExhaustedAlarm = async (
        companyId: string,
        issueId: string,
        issueTitle: string,
        issueIdentifier: string | null,
        decision: SelectionDecision,
        authorAgentId: string | null,
      ): Promise<void> => {
        const alarms = await readTierExhaustedAlarms(companyId);
        if (decision.outcome !== "tier-exhausted") {
          if (issueId in alarms) {
            const { [issueId]: _dropped, ...rest } = alarms;
            await ctx.state.set(tierExhaustedAlarmsKey(companyId), rest);
          }
          return;
        }
        if (issueId in alarms) return;

        const config = await companyConfig(companyId);
        const reference = issueIdentifier ? `${issueIdentifier} (${issueTitle})` : issueTitle;
        await ctx.issues.create({
          companyId,
          parentId: issueId,
          title: `Operator: model tier exhausted on ${reference}`,
          description:
            `Every model from ${decision.judgement.tier} through T1 is pace-exhausted for ` +
            `${reference} — there is nowhere left for Model Selection to escalate to.\n\n` +
            "Intervene to unblock: add lane capacity, adjust pacing, or set an operator override " +
            "(`model_selection_set_operator_override`). This escalation stays open until the lane recovers " +
            "and a fresh `model_selection_advise`/`apply` call on the original issue no longer reports " +
            "`tier-exhausted`.",
          priority: "critical",
          labelIds: config.operatorLabelId ? [config.operatorLabelId] : undefined,
          actor: { actorAgentId: authorAgentId ?? undefined },
        });
        await ctx.state.set(tierExhaustedAlarmsKey(companyId), { ...alarms, [issueId]: new Date().toISOString() });
      };

      /**
       *  (D1e). The CEO fail-open's operator half: the veto bypassed
       * an all-lanes-dead window and admitted as today, which means the
       * failure is poller-side until proven otherwise (the  API
       * slowness, `lane-secret-unavailable`). That suspicion must reach an
       * operator card — never a silent admit — with the poller, not per-lane
       * capacity, as the named suspect. Same one-card-per-streak dedup as
       * `raiseOrClearTierExhaustedAlarm` above, on its own key: the two are
       * different streaks (bypass vs. exhaustion) answering different owner
       * questions, and sharing a key would suppress one while the other runs.
       */
      const deadVetoPollerAlarmsKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.deadVetoPollerAlarms,
      });

      const raiseOrClearDeadVetoPollerAlarm = async (
        companyId: string,
        issueId: string,
        issueTitle: string,
        issueIdentifier: string | null,
        decision: SelectionDecision,
        authorAgentId: string | null,
      ): Promise<void> => {
        const stored = asRecord(await ctx.state.get(deadVetoPollerAlarmsKey(companyId)));
        const alarms: Record<string, string> = {};
        for (const [id, at] of Object.entries(stored)) {
          if (typeof at === "string") alarms[id] = at;
        }
        if (!decision.deadVeto.bypassedAllDead) {
          if (issueId in alarms) {
            const { [issueId]: _dropped, ...rest } = alarms;
            await ctx.state.set(deadVetoPollerAlarmsKey(companyId), rest);
          }
          return;
        }
        if (issueId in alarms) return;

        const config = await companyConfig(companyId);
        const reference = issueIdentifier ? `${issueIdentifier} (${issueTitle})` : issueTitle;
        await ctx.issues.create({
          companyId,
          parentId: issueId,
          title: `Operator: lane poller suspect on ${reference}`,
          description:
            `Every configured lane met the dead-lane veto condition for ${reference} in the same window, ` +
            `so Model Selection admitted as today instead of vetoing all dispatch — a poller-side failure ` +
            `(lane poller outage, fleet-wide API slowness as in , or a lane secret outage) is suspect, ` +
            `not per-lane death.\n\n` +
            "Intervene to unblock: check the lane poller and lane status endpoints, then the lane secrets " +
            "(`lane-secret-unavailable` fails every lane together). This escalation stays open until a fresh " +
            "`model_selection_advise`/`apply` call on the original issue no longer bypasses an all-lanes-dead window.",
          priority: "critical",
          labelIds: config.operatorLabelId ? [config.operatorLabelId] : undefined,
          actor: { actorAgentId: authorAgentId ?? undefined },
        });
        await ctx.state.set(deadVetoPollerAlarmsKey(companyId), { ...alarms, [issueId]: new Date().toISOString() });
      };

      // --- /2138/2504, shards : paired decision emitter --

      /**
       * . Hourly shard name, UTC, zero-padded so lexical order is
       * chronological order: `decisions-2026-10-03-14Z.jsonl`. Shard names are
       * derived from the record timestamp, never from wall-clock at write
       * time, so a late or replayed decision lands in its own hour.
       */
      const SHADOW_SHARD_PREFIX = "decisions-";
      const SHADOW_SHARD_PATTERN = /^decisions-(\d{4}-\d{2}-\d{2}-\d{2})Z\.jsonl$/;
      const shadowShardFor = (nowIso: string): string => {
        // `2026-09-10T12` → `2026-09-10-12`: no `T` or `:` in a folder file
        // name, and lexical order stays chronological order.
        const hour = new Date(nowIso).toISOString().slice(0, 13).replace("T", "-");
        return `${SHADOW_SHARD_PREFIX}${hour}Z.jsonl`;
      };

      /**
       * A missing shadow-decisions shard is the ordinary first-write case
       * (folder just configured, or this hour not yet created) and the only
       * read failure that may be treated as "start from empty". Both the real
       * host (`fs` ENOENT surfaced through the RPC error message, since the
       * ENOENT string `code` does not survive the JSON-RPC error-code coercion)
       * and the SDK test harness (`Local folder file not found: ...`) signal it
       * this way, so it must be detected on the message text, not a numeric
       * code. Any other error — folder not configured, not readable, transient
       * I/O — is NOT this case, and treating it as "empty" is exactly the QA
       *  defect: it silently truncates the on-disk history.
       */
      const isMissingShadowFileError = (err: unknown): boolean => {
        const message = err instanceof Error ? err.message : String(err);
        return /not found/i.test(message) || /ENOENT/.test(message);
      };

      // Per-company promise chain so overlapping `advise()`/`apply()` calls
      // serialize their read-modify-write against the same shard file instead
      // of racing: two emits that both read the same "before" content and then
      // both write collapse to whichever write lands last, silently dropping
      // the other's record.
      const decisionEmitChains = new Map<string, Promise<void>>();

      /**
       * Off by default (`shadowEmit.enabled`). Each authoritative decision
       * appends one `host` and one `plugin-shadow` projection to the current
       * UTC-hour shard, capped at `shardMaxRecords` — `ctx.localFolders` has
       * no native append, and the host only offers whole-file atomic replace.
       *
       * : the pre-shard design rewrote one `decisions.jsonl` whole on
       * every append. At `maxRecords: 5000` with ~16 KB live-shape records that
       * is a ~38 MB single `writeTextAtomic` RPC arg — one newline-delimited
       * JSON-RPC line on the worker's stdout — which timed out after 30 s
       * (158×) and tripped the host's oversized-line drop (158×), so no shadow
       * evidence accumulated at all. An hourly shard rewrite is kilobyte-scale
       * in the common case, and a single shard can never grow past
       * `shardMaxRecords` bounded-size records. Retention deletes whole old
       * shards past `retentionShards`; the legacy `decisions.jsonl`, if
       * present, is left untouched as historical evidence.
       *
       * A write failure is logged and swallowed: shadow emission is a side
       * channel for the  comparison stream, and must never fail the
       * `advise()`/`apply` call it rides on. A read failure is swallowed only
       * when it means "no shard yet" — any other read failure aborts the emit
       * instead of overwriting real history with a one-record file.
       */
      const emitDecisionPairSerialized = async (
        companyId: string,
        records: readonly ReturnType<typeof buildShadowRecord>[],
      ): Promise<void> => {
        const config = await companyConfig(companyId);
        const shard = shadowShardFor(records[0]?.ts ?? new Date().toISOString());
        let existing = "";
        try {
          existing = await ctx.localFolders.readText(companyId, LOCAL_FOLDER_KEYS.shadowDecisions, shard);
        } catch (err) {
          if (!isMissingShadowFileError(err)) {
            ctx.logger.warn("model-selection: shadow decision emit aborted — could not read existing log", {
              error: String(err),
            });
            return;
          }
          existing = "";
        }
        const lines = existing.split("\n").filter((line) => line.trim().length > 0);
        lines.push(...records.map((record) => JSON.stringify(record)));
        // A retained shard must never split the newest host/shadow pair. An
        // odd configured cap is rounded down, with two records as the floor.
        const pairAlignedCap = Math.max(2, config.shadowEmit.shardMaxRecords - (config.shadowEmit.shardMaxRecords % 2));
        const capped = lines.length > pairAlignedCap ? lines.slice(-pairAlignedCap) : lines;
        try {
          await ctx.localFolders.writeTextAtomic(
            companyId,
            LOCAL_FOLDER_KEYS.shadowDecisions,
            shard,
            capped.join("\n") + "\n",
          );
        } catch (err) {
          ctx.logger.warn("model-selection: shadow decision emit failed", { error: String(err) });
          return;
        }
        // Best-effort retention: drop whole shards older than the newest
        // `retentionShards`. A retention failure must never fail the emit that
        // just landed — it is logged and swallowed like any side-channel
        // failure. The legacy single-file `decisions.jsonl` is never touched.
        try {
          const listing = await ctx.localFolders.list(companyId, LOCAL_FOLDER_KEYS.shadowDecisions);
          const shards = listing.entries
            .filter((entry) => entry.kind === "file" && SHADOW_SHARD_PATTERN.test(entry.name))
            .map((entry) => entry.name)
            .sort();
          const excess = shards.length - Math.max(1, config.shadowEmit.retentionShards);
          for (let i = 0; i < excess; i++) {
            await ctx.localFolders.deleteFile(companyId, LOCAL_FOLDER_KEYS.shadowDecisions, shards[i]!);
          }
        } catch (err) {
          ctx.logger.warn("model-selection: shadow shard retention skipped", { error: String(err) });
        }
      };

      const emitDecisionPair = (
        companyId: string,
        records: readonly ReturnType<typeof buildShadowRecord>[],
      ): Promise<void> => {
        const previous = decisionEmitChains.get(companyId) ?? Promise.resolve();
        const next = previous.catch(() => {}).then(() => emitDecisionPairSerialized(companyId, records));
        decisionEmitChains.set(companyId, next);
        return next;
      };

      /**
       * `ctx.http.fetch` wrapped to the shape `pollLanes` expects. Mirrors
       * `capacityHttp(ctx)` in the accepted model-router worker: a thin
       * adapter with no policy of its own — every guard (https-only, no
       * userinfo/query/hash, no reserved host, timeout, redirect refusal,
       * size cap, media-type check) lives in `poll.ts`, not here.
       */
      const laneHttp: LanePollHttpClient = {
        fetch: (url, init) => ctx.http.fetch(url, init),
      };

      const reworkSignalsKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.reworkSignals,
      });

      const readReworkSignals = async (companyId: string): Promise<ReworkSignal[]> => {
        const stored = asRecord(await ctx.state.get(reworkSignalsKey(companyId)));
        return Array.isArray(stored.signals) ? (stored.signals as ReworkSignal[]) : [];
      };

      const scoresKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.modelScores,
      });

      // --- : LLM tier classification (tier_dispatcher.py classify()) --

      const classificationHttp: ClassificationHttpClient = {
        fetch: (url, init) => ctx.http.fetch(url, init),
      };

      const classificationExclusionsKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.classificationExclusions,
      });

      const readClassificationExclusions = async (companyId: string): Promise<Record<string, boolean>> => {
        const stored = asRecord(await ctx.state.get(classificationExclusionsKey(companyId)));
        const out: Record<string, boolean> = {};
        for (const [issueId, excluded] of Object.entries(stored)) {
          if (excluded === true) out[issueId] = true;
        }
        return out;
      };

      /**
       * . Provenance for the `tier:*` labels this job wrote:
       * `{issueId: "T2"}`. Same shape and lifecycle as the exclusions map
       * above, and read in the same place — the classify job's per-candidate
       * loop — so the job can distinguish its own recorded verdict from an
       * agent's self-assessment.
       */
      const classifierLabeledKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.classifierLabeledIssues,
      });

      const readClassifierLabeled = async (companyId: string): Promise<Record<string, Tier>> => {
        const stored = asRecord(await ctx.state.get(classifierLabeledKey(companyId)));
        const out: Record<string, Tier> = {};
        for (const [issueId, tier] of Object.entries(stored)) {
          if (typeof tier === "string" && (TIERS as readonly string[]).includes(tier)) out[issueId] = tier as Tier;
        }
        return out;
      };

      const readCardLedger = async (companyId: string): Promise<Record<string, CardLedgerEntry>> => {
        const stored = asRecord(await ctx.state.get(scoresKey(companyId)));
        const ledger = asRecord(stored.cardLedger);
        return ledger as Record<string, CardLedgerEntry>;
      };

      const readModelScores = async (companyId: string): Promise<Record<string, ModelScore>> => {
        const stored = asRecord(await ctx.state.get(scoresKey(companyId)));
        const scores = Array.isArray(stored.modelScores) ? (stored.modelScores as ModelScore[]) : [];
        const byModelId: Record<string, ModelScore> = {};
        for (const score of scores) byModelId[score.modelId] = score;
        return byModelId;
      };

      // Bounded T1 earn-in admission (§3 / decision B). The `earnInState` key
      // parallels `scoresKey` above: the worker owns the read/write, and the
      // pure translators in `actuate/earnInWiring.ts` build cards, resolve
      // postures, and fold outcomes around the pure `planEarnIn` decision
      // function. Default off — while `config.earnIn.enabled` is false the
      // resolve hooks return before the lock (no lock, no state read) and the
      // balance row skips the lock entirely, so this seam is inert until an
      // operator enables it.
      const earnInStateKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.earnInState,
      });

      const readEarnInState = async (companyId: string): Promise<EarnInState> =>
        normalizeEarnInState(await ctx.state.get(earnInStateKey(companyId)));

      const writeEarnInState = async (companyId: string, state: EarnInState): Promise<void> => {
        await ctx.state.set(earnInStateKey(companyId), { ...state });
      };

      // Serialize admission/pin/rollback and outcome folds in this worker.
      // The SDK state API has no CAS; parallel events must not lose counters.
      const earnInLocks = new Map<string, Promise<void>>();
      const withEarnInLock = async <T>(companyId: string, work: () => Promise<T>): Promise<T> => {
        const previous = earnInLocks.get(companyId) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => { release = resolve; });
        earnInLocks.set(companyId, current);
        await previous;
        try {
          return await work();
        } finally {
          release();
          if (earnInLocks.get(companyId) === current) earnInLocks.delete(companyId);
        }
      };

      // Reserve one eligible pick. The caller rolls back if no pin lands.
      // Every eligible pick advances cadence, including non-dispatch turns;
      // only admissions consume weekly/active budgets. Highest prior wins,
      // with roster order breaking ties (never randomness).
      const maybeAdmitEarnIn = async (
        companyId: string,
        input: {
          described: NonNullable<Awaited<ReturnType<typeof describeIssue>>>;
          exclusionExcluded: boolean;
          agentAdapterType: string | null;
          candidateModelIds: readonly string[];
          nowMs: number;
          nowIso: string;
        },
      ): Promise<{
        decision: ReturnType<typeof planEarnIn>;
        model: ModelEntry & { candidateId: string | null };
        priorState: EarnInState;
      } | null> => {
        const config = await companyConfig(companyId);
        // Legacy earn-in cannot synthesize another candidate's effort identity.
        if (!config.earnIn.enabled || !selectionWritesAllowed(config) || config.aaFreeSync.enabled) return null;
        const { described, exclusionExcluded, agentAdapterType, nowMs, nowIso } = input;
        if (
          !isEarnInCandidateIssue({
            status: described.status,
            isIdle: described.isIdle,
            hasOperatorPin: described.hasOperatorPin,
            exclusionExcluded,
            hasExistingOverride: described.hasOverride,
            assigneeUserId: described.assigneeUserId,
            labelNames: described.descriptor.labelNames ?? [],
            priority: described.descriptor.priority ?? null,
            title: described.title,
          })
        ) {
          return null;
        }
        const [state, modelScores, laneLedger, availability, laneEvidence, laneOutageOverride] =
          await Promise.all([
            readEarnInState(companyId),
            readModelScores(companyId),
            readLaneLedger(companyId),
            readAvailability(companyId, nowMs),
            readLaneEvidence(companyId, config.models, nowMs),
            readLaneOutage(companyId),
          ]);
        const laneInputs = {
          ledger: laneLedger,
          availability,
          laneEvidence,
          laneAvoidConfig: config.pacing.avoid,
          laneOutageOverride,
          pacingActive: config.pacing.mode !== "off",
          trafficScale: "issue" as const,
          nowMs,
          nowIso,
        };
        const posture = lanePostureByTier(config.models, laneInputs);
        // Only selection's gate survivors may compete: earn-in never bypasses
        // context, capabilities, mature-card evidence or fallback-only holds.
        const rivals = config.models.filter((model) =>
          !model.fallbackOnly && input.candidateModelIds.includes(model.id),
        ).sort((a, b) => (modelScores[b.id]?.priorP ?? 0) - (modelScores[a.id]?.priorP ?? 0));
        for (const model of rivals) {
          if (!isEarnInCandidateModel({ model, modelScores, agentAdapterType })) continue;
          if (!laneAvailableForEarnIn(model, laneInputs)) continue;
          const card = buildEarnInCandidateCard({
            issueId: described.descriptor.issueId,
            status: described.status,
            hasRunningRun: !described.isIdle,
            hasOperatorPin: described.hasOperatorPin,
            exclusionExcluded,
            labelNames: described.descriptor.labelNames ?? [],
            model: { id: model.id, laneId: model.laneId ?? null },
          });
          if (!card) continue;
          const decision = planEarnIn(
            card,
            modelScores[model.id] ?? null,
            state,
            config.earnIn,
            posture,
            pacePostureForModel(laneLedger, model),
            resolveIsClaudeModel(model.id),
            nowMs,
          );
          // Recheck eligibility without cadence: other refusals do not advance
          // the counter, while an eligible non-due pick must reach its next turn.
          const eligible = planEarnIn(
            card, modelScores[model.id] ?? null,
            { ...state, counter: { ...state.counter, [model.id]: 0 } },
            config.earnIn, posture, pacePostureForModel(laneLedger, model),
            resolveIsClaudeModel(model.id), nowMs,
          );
          if (!eligible.dispatch) continue;
          const next = decision.dispatch
            ? nextEarnInStateOnDispatch(state, card, nowMs)
            : { ...state, counter: { ...state.counter, [model.id]: (state.counter[model.id] ?? 0) + 1 } };
          try {
            await writeEarnInState(companyId, next);
          } catch (cause) {
            ctx.logger.warn("earn-in dispatch state write failed; balanced pick stands", {
              companyId,
              issue: described.identifier ?? described.descriptor.issueId,
              modelId: model.id,
              error: cause instanceof Error ? cause.message : String(cause),
            });
            return null;
          }
          return { decision, model: { ...model, candidateId: null }, priorState: state };
        }
        return null;
      };

      const shadowDiffsKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.shadowDiffs,
      });

      // --- : absorbed dispatch stall-sweep (/) ---------

      const dispatchLastFiringKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.dispatchLastFiring,
      });

      /**
       *  port of `tier_dispatcher.py`'s `lane_active_pins()`: current
       * todo/in_progress pinned weight per lane, a flash model (blended list
       * price under $1/Mtok) counting as half a lane slot. Computed live per
       * `advise()` call — same cadence the Python source used, reading fresh
       * on every dispatcher invocation rather than caching.
       */
      const activePinsWeightByLane = async (
        companyId: string,
        models: ResolvedConfig["models"],
      ): Promise<Record<string, number>> => {
        const rows = (await ctx.db.query(
          `select assignee_adapter_overrides->'adapterConfig'->>'model' as pinned_model
             from issues
            where company_id = $1
              and status in ('todo','in_progress')
              and assignee_adapter_overrides->'adapterConfig'->>'model' is not null`,
          [companyId],
        )) as unknown[];

        const weightByLane: Record<string, number> = {};
        for (const row of rows) {
          const r = asRecord(row);
          const rawModelId = typeof r.pinned_model === "string" ? r.pinned_model : null;
          const modelId = resolveConfiguredModelId(rawModelId, models);
          const model = models.find((m) => m.id === modelId);
          if (!model || !model.laneId) continue;
          const weight = blendedListPrice(model) < 1.0 ? 0.5 : 1.0;
          weightByLane[model.laneId] = (weightByLane[model.laneId] ?? 0) + weight;
        }
        return weightByLane;
      };

      // --- : aa.ai Intelligence Index snapshot + per-company drift dedup ---

      const aaSnapshotKey = () => ({
        scopeKind: "instance" as const,
        stateKey: PLUGIN_STATE_KEYS.aaIndexSnapshot,
      });

      const aaSnapshotHistoryKey = () => ({
        scopeKind: "instance" as const,
        stateKey: PLUGIN_STATE_KEYS.aaSnapshotHistory,
      });

      interface AaSnapshotState {
        fetchedAt: string | null;
        /** Every aa.ai slug (one per model x effort-level) mapped to its full parsed record ( scope expansion). */
        bySlug: Record<string, AaModelRecord>;
        lastAttemptAt: string | null;
        lastError: string | null;
      }

      const readAaSnapshot = async (): Promise<AaSnapshotState> => {
        const stored = asRecord(await ctx.state.get(aaSnapshotKey()));
        return {
          fetchedAt: typeof stored.fetchedAt === "string" ? stored.fetchedAt : null,
          bySlug: asRecord(stored.bySlug) as Record<string, AaModelRecord>,
          lastAttemptAt: typeof stored.lastAttemptAt === "string" ? stored.lastAttemptAt : null,
          lastError: typeof stored.lastError === "string" ? stored.lastError : null,
        };
      };

      interface AaSnapshotHistoryEntry {
        fetchedAt: string;
        bySlug: Record<string, AaModelRecord>;
      }

      /**
       *  scope expansion ("store the raw snapshot per fetch ... so
       * history is queryable"): appends one entry per successful fetch to a
       * bounded rolling list in plugin state. Kept in `plugin_state` rather
       * than `ctx.entities` — the latter would need a new, unconfirmed
       * capability declaration in the manifest; `plugin_state` already has
       * everything this plugin is granted and the SDK documents no size
       * limit on a stored value.
       */
      const appendAaSnapshotHistory = async (entry: AaSnapshotHistoryEntry): Promise<void> => {
        const stored = asRecord(await ctx.state.get(aaSnapshotHistoryKey()));
        const existing = Array.isArray(stored.entries) ? (stored.entries as AaSnapshotHistoryEntry[]) : [];
        const next = [...existing, entry].slice(-AA_SNAPSHOT_HISTORY_LIMIT);
        await ctx.state.set(aaSnapshotHistoryKey(), { entries: next });
      };

      const aaDriftSurfacedKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.aaDriftSurfaced,
      });

      const readAaDriftSurfaced = async (companyId: string): Promise<Set<string>> => {
        const stored = asRecord(await ctx.state.get(aaDriftSurfacedKey(companyId)));
        return new Set(Array.isArray(stored.keys) ? (stored.keys as string[]) : []);
      };

      const aaHttp: AaHttpClient = {
        fetch: (url, init) => ctx.http.fetch(url, init),
      };

      /**
       * . The one genuinely expensive read behind a descriptor: the
       * last heartbeat run's context usage for an issue.
       *
       * It is kept OUT of `describeIssue`'s eager path and behind a per-pass
       * memo for two measured reasons:
       *
       *  - every scheduled pass rejects most candidates on cheap, already-read
       *    fields (operator pin, tier label, status, idleness). Paying a
       *    `heartbeat_runs` read before those rejections cost one scan per
       *    *scanned* candidate rather than per *repinnable* one; and
       *  - the survivors then call `advise()`, which describes the same issue
       *    a second time — doubling the read on exactly the rows that reach it.
       *
       * The cache is created per pass and threaded in explicitly, so it can
       * never outlive the pass that owns it or serve one company's row to
       * another. Promises are memoized, not values, so two concurrent asks for
       * the same issue share a single in-flight query.
       */
      const readLastRunContextUsage = async (
        companyId: string,
        issueId: string,
        logRoot: string | null,
      ): Promise<ContextUsage> => {
        try {
          const rows = await ctx.db.query(LAST_RUN_CONTEXT_USAGE_SQL, [companyId, issueId]);
          if (!Array.isArray(rows)) throw new Error("Malformed history result");
          if (rows.length === 0) return {
            lastRunPeakTokens: null, history: "no-history", runId: null, evidence: "no-finalized-run",
          };
          return await readRunContextEvidence(rows[0], companyId, logRoot);
        } catch {
          return {
            lastRunPeakTokens: null, history: "unavailable", runId: null, evidence: "history-read-failed",
          };
        }
      };

      const loadContextUsage = (
        companyId: string,
        issueId: string,
        logRoot: string | null,
        cache?: ContextUsageCache,
      ): Promise<ContextUsage> => {
        if (!cache) return readLastRunContextUsage(companyId, issueId, logRoot);
        const key = `${companyId}:${issueId}`;
        const memo = cache.get(key);
        if (memo) return memo;
        const pending = readLastRunContextUsage(companyId, issueId, logRoot);
        cache.set(key, pending);
        return pending;
      };

      /**
       * Build the descriptor from what the board actually records. Everything
       * here is read, never inferred — the tier key is a recorded judgement
       * (ADR-0007 / ratified Q8-a), so the only classifier in this plugin is
       * the absence of one.
       *
       * The returned `contextUsage()` is lazy: callers that only need to
       * decide whether a card is repinnable never trigger the
       * `heartbeat_runs` read at all. Callers that do need the estimate get it
       * memoized for the life of the pass's `contextUsageCache`.
       */
      const describeIssue = async (
        companyId: string,
        issueId: string,
        supplied: Record<string, unknown>,
        contextUsageCache?: ContextUsageCache,
      ): Promise<{
        descriptor: IssueDescriptor;
        status: string;
        hasOverride: boolean;
        existingLabelIds: string[];
        hasTierLabel: boolean;
        hasOperatorPin: boolean;
        isIdle: boolean;
        title: string;
        identifier: string | null;
        /** `null` means UNKNOWN, not empty — see ModelOverrideInput.agentEnv in engine/context.ts. */
        agentEnv: Record<string, unknown> | null;
        /** . `null` = UNKNOWN; decides the effort key and vocabulary. */
        agentAdapterType: string | null;
        /** . `null` = UNKNOWN; read only for the effort it already carries. */
        agentAdapterConfig: Record<string, unknown> | null;
        existingOverrideEnv: Record<string, unknown>;
        /** Lazy + per-pass memoized; see {@link loadContextUsage}. */
        contextUsage: (logRoot: string | null) => Promise<ContextUsage>;
        /** : the assignment signal a creation-time pin keys on. */
        assigneeAgentId: string | null;
        /**
         * : the human assignment, if any. A card with a user
         * assignee rejects `issues.update` with an agent override
         * ("Issue can only have one assignee"), so the scheduled pin
         * passes skip it — SQL first, this field as the per-row backstop.
         */
        assigneeUserId: string | null;
        /** : raw description for the classification prompt. */
        description: string;
      } | null> => {
        const issue = await ctx.issues.get(issueId, companyId);
        if (!issue) return null;

        const overrides = asRecord(issue.assigneeAdapterOverrides);
        const adapterConfig = asRecord(overrides.adapterConfig);
        const existingOverrideEnv = asRecord(adapterConfig.env);
        const pinnedModelId = typeof adapterConfig.model === "string" ? adapterConfig.model : null;
        const labels = issue.labels ?? [];
        const labelNames = labels
          .map((label) => label.name)
          .filter((name): name is string => typeof name === "string");

        // Idle means no run is currently attached to this issue in any
        // running/queued sense — a repin must never touch live work.
        const scheduledRetryStatus = issue.scheduledRetry?.status ?? null;
        const isIdle =
          !issue.checkoutRunId &&
          !issue.executionRunId &&
          scheduledRetryStatus !== "queued" &&
          scheduledRetryStatus !== "running";

        let agentFloorModelId: string | null = null;
        let agentName: string | null = null;
        // Stays `null` unless we actually read the agent row. An unreadable or
        // absent assignee must not be reported as "the agent has no env vars":
        // the override write replaces the whole env object, so that conflation
        // would wipe the agent's real bindings for the run.
        let agentEnv: Record<string, unknown> | null = null;
        // . Same UNKNOWN discipline: the effort a pin may legally write
        // depends on the assignee's adapter, so an unreadable agent means we
        // write no effort rather than guess one.
        let agentAdapterType: string | null = null;
        let agentAdapterConfig: Record<string, unknown> | null = null;
        const assigneeAgentId = issue.assigneeAgentId;
        if (typeof assigneeAgentId === "string") {
          try {
            const agent = await ctx.agents.get(assigneeAgentId, companyId);
            const agentRecord = asRecord(agent);
            const config = asRecord(agentRecord.adapterConfig);
            if (typeof config.model === "string") agentFloorModelId = config.model;
            agentEnv = asRecord(config.env);
            agentAdapterConfig = config;
            if (typeof agentRecord.adapterType === "string") agentAdapterType = agentRecord.adapterType;
            if (typeof agentRecord.name === "string") agentName = agentRecord.name;
          } catch {
            // An agent we cannot read simply has no known floor; resolveTier
            // falls through to the config default rather than guessing.
          }
        }

        const exclusionRaw = asRecord(supplied.exclusion);
        const descriptor: IssueDescriptor = {
          issueId,
          labelNames,
          pinnedModelId,
          agentFloorModelId,
          // : adapter-compatibility gate (`devin/*` vs `claude_local`)
          // and the earn-in guard (priority + review/gate title) both read
          // these. Recorded from the issue/agent rows, never inferred.
          agentAdapterType,
          priority: typeof issue.priority === "string" ? issue.priority : null,
          title: String(issue.title ?? ""),
          agentName,
          // Sticky is derived from the pin: if the issue is already pinned, the
          // run is already on that model and a change would reset the session.
          stickyModelId: pinnedModelId,
          requiredCapabilities: Array.isArray(supplied.requiredCapabilities)
            ? (supplied.requiredCapabilities as string[])
            : undefined,
          // Only the CALLER-supplied value is eager. The measured fallback
          // needs the `heartbeat_runs` read, so callers that want it await
          // `contextUsage()` and set this themselves (`advise`, `repinPass`) —
          // the passes that only decide repinnability never pay for it.
          requiredContextTokens:
            typeof supplied.requiredContextTokens === "number" ? supplied.requiredContextTokens : undefined,
          // : the caller's PAPERCLIP_WAKE_REASON for this run, if any.
          // Feeds SelectionConfig.wakeScopedFloor only — resolveTier() never
          // reads it, so it can never change the card's own judged tier.
          wakeReason: typeof supplied.wakeReason === "string" ? supplied.wakeReason : undefined,
          ...(typeof exclusionRaw.excluded === "boolean"
            ? {
                exclusion: {
                  excluded: exclusionRaw.excluded,
                  reasons: Array.isArray(exclusionRaw.reasons) ? (exclusionRaw.reasons as string[]) : [],
                },
              }
            : {}),
        };

        // `issues.get` enriches both `labels` and `labelIds` via
        // `withIssueLabels` (issues.ts:1826-1842), so the existing id set is
        // already in hand — we never need a `labels` table read for it. That
        // matters: `labels` is NOT in PLUGIN_DATABASE_CORE_READ_TABLES, so a
        // `ctx.db.query` against it would be rejected outright.
        const existingLabelIds =
          issue.labelIds ?? labels.map((label) => label.id).filter((id) => typeof id === "string");

        return {
          descriptor,
          status: String(issue.status ?? ""),
          hasOverride: Object.keys(overrides).length > 0,
          existingLabelIds,
          hasTierLabel: labelNames.some((name) => name.startsWith(TIER_LABEL_PREFIX)),
          hasOperatorPin: labelNames.includes(OPERATOR_PIN_LABEL),
          isIdle,
          title: String(issue.title ?? ""),
          identifier: typeof issue.identifier === "string" ? issue.identifier : null,
          assigneeAgentId: typeof assigneeAgentId === "string" ? assigneeAgentId : null,
          assigneeUserId:
            typeof issue.assigneeUserId === "string" && issue.assigneeUserId.length > 0
              ? issue.assigneeUserId
              : null,
          description: String(issue.description ?? ""),
          agentEnv,
          agentAdapterType,
          agentAdapterConfig,
          existingOverrideEnv,
          contextUsage: (logRoot) => loadContextUsage(companyId, issueId, logRoot, contextUsageCache),
        };
      };

      // ---  P2: opt-in free-list sync/discovery/shadow ---------------
      //
      // Shadow-only v2 evidence, resolved AFTER selection from the last-good
      // free-list snapshot. Never an input to selection: the winner is already
      // decided, and this only annotates the decision for the shadow stream.
      // Returns null on every legacy leg (disabled, unconfigured,
      // snapshot-less, undecided) — the caller attaches the field only on a
      // non-null return, so disabling v2 restores the decision shape
      // byte-for-byte (key absent, not null).
      const aaFreeSyncSnapshotKey = () => ({
        scopeKind: "instance" as const,
        stateKey: PLUGIN_STATE_KEYS.aaFreeSyncSnapshot,
      });

      interface AaFreeSyncSnapshotState {
        fetchedAt: string | null;
        digest: string | null;
        snapshot: AaFreeSnapshot | null;
        lastAttemptAt: string | null;
        lastError: string | null;
        nextEligibleAt: string | null;
      }

      const readAaFreeSyncSnapshot = async (): Promise<AaFreeSyncSnapshotState> => {
        const stored = asRecord(await ctx.state.get(aaFreeSyncSnapshotKey()));
        const snapshot = asRecord(stored.snapshot);
        return {
          fetchedAt: typeof stored.fetchedAt === "string" ? stored.fetchedAt : null,
          digest: typeof stored.digest === "string" ? stored.digest : null,
          snapshot:
            Array.isArray(snapshot.rows) && typeof snapshot.retrievedAt === "string"
              ? (stored.snapshot as AaFreeSnapshot)
              : null,
          lastAttemptAt: typeof stored.lastAttemptAt === "string" ? stored.lastAttemptAt : null,
          lastError: typeof stored.lastError === "string" ? stored.lastError : null,
          nextEligibleAt: typeof stored.nextEligibleAt === "string" ? stored.nextEligibleAt : null,
        };
      };

      const aaFreeSyncDiffKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.aaFreeSyncDiff,
      });

      const buildAaFreeEvidence = async (input: {
        companyId: string;
        config: ResolvedConfig;
        decision: SelectionDecision;
        agentAdapterType: string | null;
        agentAdapterConfig: Record<string, unknown> | null;
      }): Promise<AaEffortEvidence | null> => {
        if (!input.config.aaFreeSync.enabled) return null;
        if (input.config.aaFreeSync.bindings.length === 0) return null;
        if (!input.decision.modelId) return null;
        const selected = input.config.models.find((model) => model.id === input.decision.modelId);
        if (!selected) return null;
        const stored = await readAaFreeSyncSnapshot();
        if (!stored.snapshot || !stored.digest || !stored.fetchedAt) return null;
        const maxAgeMs = input.config.aaFreeSync.maxSnapshotAgeHours * 60 * 60 * 1000;
        const stale = !isSnapshotFresh(stored.fetchedAt, Date.now(), maxAgeMs);
        return buildAdviseEvidence({
          bindings: input.config.aaFreeSync.bindings.map((b) => ({
            candidateId: b.candidateId,
            modelId: b.modelId,
            laneId: b.laneId,
            evaluatedEffort: b.evaluatedEffort as AaBinding["evaluatedEffort"],
            aaSlug: b.aaSlug,
            ...(b.observationalOnly !== undefined ? { observationalOnly: b.observationalOnly } : {}),
          })),
          snapshot: stored.snapshot,
          digest: stored.digest,
          stale,
          // ModelEntry.laneId is optional; the sync view requires the key.
          model: { id: selected.id, laneId: selected.laneId ?? null, fallbackOnly: selected.fallbackOnly, enabled: selected.enabled },
          adapterType: input.agentAdapterType,
          requestedEffort: selected.effort ?? null,
          inheritedEffort: inheritedEffortFrom(input.agentAdapterType, input.agentAdapterConfig),
        });
      };

      const advise = async (
        companyId: string,
        params: Record<string, unknown>,
        /**
         *  port of `tier_dispatcher.py` `pick(..., explore=False)`.
         * `labelOnlyPass`/`repinPass`/`balancePass`'s pinned-branch calls set
         * this `false` — they are re-affirming or replacing an existing pin,
         * not seeding new evidence. Defaults `true`: unchanged tool behavior.
         */
        allowExplore = true,
        /**
         *  port of `balance_pass()`'s unpinned branch:
         * `pick("T1", floor)` always dispatches unpinned+labelled cards at
         * T1, regardless of the row's own tier:* label — the 2026-09-05
         * 23:05Z "balanced T1-class pin" rule. `resolveTier()` would
         * otherwise re-derive the row's own label tier at step 3, so this
         * substitutes a synthetic `tier:T1` label ahead of that read rather
         * than touching `descriptor.exclusion` (a different, unrelated
         * forced-T1 path with its own capability-exclusion semantics).
         */
        forceTier?: Tier,
        /**
         * `repinPass`/`balancePass`'s PINNED branches set this `true`: they
         * exist specifically to move an issue off a pin that is now
         * unserviceable, measurably demoted, on-probation, over-cap, or on a
         * far busier lane than another usable one — the sticky short-circuit
         * in `selectModel()` only declines on a tier-floor violation, so
         * without this every such call silently re-selects the same pinned
         * model and these passes are dead code. `isIdle`/`hasOperatorPin` are
         * already checked by the caller before `advise()` runs, so this never
         * resets a live in-flight session; it only lets a deliberate,
         * idle-card re-pin see past the pin it is trying to replace. Defaults
         * `false`: the interactive advise/apply tool path must keep
         * protecting a live session's warm prompt cache.
         */
        suppressSticky = false,
        /**
         * . The owning pass's per-issue context memo. A scheduled pass
         * has almost always described this issue already; passing its cache
         * means `advise` reuses that `heartbeat_runs` read instead of
         * repeating it. Omitted on the interactive tool path, which describes
         * exactly one issue once.
         */
        contextUsageCache?: ContextUsageCache,
      ): Promise<{
        decision: SelectionDecision;
        issueId: string;
        status: string;
        hasOverride: boolean;
        existingLabelIds: string[];
        hasTierLabel: boolean;
        hasOperatorPin: boolean;
        isIdle: boolean;
        isServiceabilityHardStop: boolean;
        /**
         * True when the card's assignee is in `selection.exemptAgentIds`.
         * An exempt card is treated as `pin:operator` from the first pin;
         * only a serviceability hard stop may still repin it.
         */
        isAgentExempt: boolean;
        nowIso: string;
        config: ResolvedConfig;
        title: string;
        identifier: string | null;
        agentFloorModelId: string | null;
        pinnedModelId: string | null;
        /** `null` means UNKNOWN, not empty — see ModelOverrideInput.agentEnv in engine/context.ts. */
        agentEnv: Record<string, unknown> | null;
        /** . `null` = UNKNOWN; decides the effort key and vocabulary. */
        agentAdapterType: string | null;
        /** . `null` = UNKNOWN; read only for the effort it already carries. */
        agentAdapterConfig: Record<string, unknown> | null;
        existingOverrideEnv: Record<string, unknown>;
        /**
         * : target for the haiku-class sub-call env keys on this
         * card's override write — the cheapest healthy T3 model under the
         * CURRENT outage state, or null when none qualifies (the write then
         * falls back to the pin; see `ModelOverrideInput.cheapModelId`).
         */
        ancillaryModelId: string | null;
        /** : the assignee a fallback pin's provenance stamp names. */
        assigneeAgentId: string | null;
      } | null> => {
        const issueId = typeof params.issueId === "string" ? params.issueId : null;
        if (!issueId) return null;
        const config = await companyConfig(companyId);
        const described = await describeIssue(companyId, issueId, params, contextUsageCache);
        if (!described) return null;
        // A deliberate repin keeps the caller's effective tier even when the
        // old pin's lane is dead. Merely replacing labels cannot do this:
        // resolveTier gives a serviceable pin precedence over those labels.
        // : a forced tier can never create a T0 opt-in. The synthetic
        // label below would read as an explicit `tier:T0` judgement, so T0 is
        // honoured only when the card already carries that label itself.
        const forcedTier: Tier | undefined =
          forceTier === "T0" && tierFromLabels(described.descriptor.labelNames) !== "T0" ? IMPLICIT_TIER_CEILING : forceTier;
        const selectionDescriptor: IssueDescriptor = {
          ...described.descriptor,
          ...(forcedTier ? { pinnedModelId: null, labelNames: [`${TIER_LABEL_PREFIX}${forcedTier}`] } : {}),
          ...(suppressSticky ? { stickyModelId: null } : {}),
        };
        const { profiles, signals } = await readProfiles(companyId);
        const laneLedger = await readLaneLedger(companyId);
        const pacingActive = config.pacing.mode !== "off";
        //  (D1e). The pin fall-through must see the veto too: a pin
        // whose every row sits on a dead-vetoed lane falls through to the
        // label/floor, the same Defect-6 discipline as the hard stop. The
        // configured set is the primitive here (fail-open when absent), and
        // the all-dead bypass does not apply to a pin read — a pin that
        // cannot serve is not saved by the poller being suspect.
        const deadVetoScope = {
          configuredLaneIds: config.pacing.lanes.map((lane) => lane.laneId),
          bypassAllDead: false,
        };
        const profileTier = resolveTier(
          selectionDescriptor,
          config.models,
          config.selection.defaultTier,
          {
            isLaneUnserviceable: (model) =>
              pacingActive &&
              (hardStopExcluded(laneLedger, model) || deadVetoExcluded(laneLedger, model, deadVetoScope)),
          },
        ).tier;
        const profile = profiles.find((entry) => entry.tier === profileTier) ?? null;
        // The measured half of the estimate. This is the only place `advise`
        // needs the `heartbeat_runs` read, and it sits AFTER `resolveTier`,
        // which reads labels and lane state only — so nothing above this line
        // depends on it.
        const usage = await described.contextUsage(config.selection.contextRunLogRoot);
        const contextEstimate = estimateIssueContext({
          explicitTokens:
            typeof params.requiredContextTokens === "number" ? params.requiredContextTokens : undefined,
          lastRunPeakTokens: usage.lastRunPeakTokens,
          history: usage.history,
          fleetCeilingTokens: config.selection.fleetContextCeilingTokens,
        });
        selectionDescriptor.requiredContextTokens = contextEstimate.tokens ?? undefined;
        const nowIso = new Date().toISOString();
        const overrides = await readOperatorOverrides(companyId);
        const liveOverride = activeOperatorOverride(overrides, issueId, nowIso);
        const cardLedger = await readCardLedger(companyId);
        const modelScores = await readModelScores(companyId);
        const laneOutageOverride = await readLaneOutage(companyId);
        const zaiPaceOverride = await readZaiPaceOverride(companyId);
        const now = Date.now();
        const pinsWeightByLane =
          config.pacing.mode !== "off" ? await activePinsWeightByLane(companyId, config.models) : {};

        const decision = selectModel({
          descriptor: selectionDescriptor,
          config: {
            enforcementEnabled: selectionWritesAllowed(config),
            defaultTier: config.selection.defaultTier,
            // : the roster's hand-placed tier is overlaid with the tier
            // `refreshScores` derived from the model's posterior. Unscored models
            // and scores from a superseded spec version keep the configured tier.
            models: applyDerivedTiers(config.models, modelScores),
            holdOnUntrustedProfile: config.selection.holdOnUntrustedProfile,
            stickyWithinIssue: config.selection.stickyModelWithinIssue,
            pacingMode: config.pacing.mode,
            laneLedger,
            //  (D1e). The configured lane set the dead-veto reads:
            // without it an unconfigured lane cannot be told apart from a
            // dead one, so the veto stays fail-open (see `configuredLaneIds`).
            configuredLaneIds: config.pacing.lanes.map((lane) => lane.laneId),
            slotFloorFraction: config.pacing.slotFloorFraction,
            operatorOverrideModelId: liveOverride?.modelId ?? null,
            laneAvoidConfig: config.pacing.avoid,
            codexLaneId: config.pacing.codexLaneId,
            opencodeGoLaneId: config.pacing.opencodeGoLaneId,
            zaiLaneId: config.pacing.zai.laneId,
            laneOutageOverride,
            laneRoom: {
              capPerAccount: config.pacing.laneCapPerAccount,
              activePinsWeightByLane: pinsWeightByLane,
              fiveHourWindowName: config.pacing.fiveHourWindowName,
              zaiLaneId: config.pacing.zai.laneId,
              zaiWeeklyWindowName: config.pacing.zai.weeklyWindowName,
              zaiWeeklyDefaultMargin: config.pacing.zai.weeklyDefaultMargin,
              zaiPaceOverrideMargin: activeZaiPaceOverride(zaiPaceOverride, new Date(now).toISOString()),
              now,
            },
            objective: config.selection.objective,
            modelScores,
            allowExplore,
            holdOnUnknownAvailability: config.selection.holdOnUnknownAvailability,
            wakeScopedFloor: config.wakeScopedFloor,
          },
          profiles,
          signals,
          now,
          cardLedger,
          availability: await readAvailability(companyId, now),
          laneEvidence: await readLaneEvidence(companyId, config.models, now),
        });
        decision.trace.push(
          `context: source=${contextEstimate.source} tokens=${contextEstimate.tokens ?? "unknown"} ` +
          `run=${usage.runId ?? "none"} evidence=${usage.evidence}`,
        );

        //  P2: shadow-only v2 evidence, resolved AFTER selection from
        // the last-good free-list snapshot. Never an input to selection: the
        // winner is already decided above, and this only annotates the
        // decision for the shadow stream. Absent entirely (not null) when v2
        // is disabled, unconfigured, or snapshot-less — the legacy shape.
        const v2Evidence = await buildAaFreeEvidence({
          companyId,
          config,
          decision,
          agentAdapterType: described.agentAdapterType,
          agentAdapterConfig: described.agentAdapterConfig,
        });
        if (v2Evidence) decision.aaEffortEvidence = v2Evidence;

        // Whether the CURRENTLY PINNED model (not the newly-computed winner) sits
        // on an unserviceable lane — this, not a routine pace-preference change,
        // is the only thing allowed to force a repin through `pin:operator`.
        const pinnedModelId = resolveConfiguredModelId(
          described.descriptor.pinnedModelId,
          config.models,
        );
        const pinnedModel = config.models.find((model) => model.id === pinnedModelId);
        const isServiceabilityHardStop =
          config.pacing.mode !== "off" &&
          !!pinnedModel &&
          (hardStopExcluded(laneLedger, pinnedModel) ||
            deadVetoExcluded(laneLedger, pinnedModel, deadVetoScope));

        // Designated agents are exempt from router pinning: the exemption is
        // recorded in the decision trace so a skip is never silent. The
        // agent's own model governs; only a serviceability hard stop may
        // still repin the card.
        const agentExempt = isAgentExempt(described.assigneeAgentId, config);
        if (agentExempt) {
          decision.trace.push(
            `exempt: agent ${described.assigneeAgentId} is exempt from router pinning; ` +
            `agent model governs${isServiceabilityHardStop ? "; serviceability hard stop applies" : ""}`,
          );
        }

        await ctx.metrics.write(`model_selection.decision.${decision.outcome}`, 1);
        //  (D1e), the operational half of the veto: count what it
        // takes out, so "which term is excluding right now" stays answerable
        // without reparsing the decision stream.
        if (decision.rejections.some((rejection) => rejection.stage === "lane-dead-veto")) {
          await ctx.metrics.write("model_selection.lane_excluded.dead-veto", 1);
        }
        if (decision.deadVeto.bypassedAllDead) {
          await ctx.metrics.write("model_selection.dead_veto_bypassed_all_dead", 1);
        }

        //  AC-6, the operational half: the term is the metric name, so
        // "which term is taking candidates out right now" is answerable without
        // reparsing the decision stream. `lane_unknown_selected` is the one that
        // must not be silent — it counts decisions made on an unread lane.
        for (const note of decision.availability.excluded) {
          await ctx.metrics.write(`model_selection.lane_excluded.${note.term}`, 1);
        }
        if (decision.availability.selectedOnUnknownLane) {
          await ctx.metrics.write("model_selection.lane_unknown_selected", 1);
        }

        if (decision.shadowDiff) {
          const stored = asRecord(await ctx.state.get(shadowDiffsKey(companyId)));
          const existing = Array.isArray(stored.records)
            ? (stored.records as Array<{ atMs: number } & Record<string, unknown>>)
            : [];
          const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
          const records = [
            ...existing.filter((r) => r.atMs >= cutoffMs),
            { ...decision.shadowDiff, atMs: Date.now() },
          ];
          await ctx.state.set(shadowDiffsKey(companyId), { records });
        }

        if (config.shadowEmit.enabled) {
          const recordInput = {
            issueId,
            issueIdentifier: described.identifier,
            nowIso,
            decision,
            descriptor: selectionDescriptor,
            status: described.status,
            hasOverride: described.hasOverride,
            hasOperatorPin: described.hasOperatorPin,
            isIdle: described.isIdle,
            models: config.models,
            laneLedger,
            slotFloorFraction: config.pacing.slotFloorFraction,
            windowNames: {
              weekly: config.pacing.weeklyWindowName,
              fiveHour: config.pacing.fiveHourWindowName,
            },
            operatorOverride: liveOverride,
          };
          await emitDecisionPair(companyId, [buildHostRecord(recordInput), buildShadowRecord(recordInput)]);
        }

        // Optional post-selection side report. No result reaches selection or
        // actuation; malformed observations/storage failures cannot veto a pick.
        if (config.accountAdmissionShadow.enabled && params.admissionShadow !== undefined) {
          try {
            const report = reportDecisionAdmissionShadow(
              params.admissionShadow as DecisionAdmissionShadowInput,
              now,
              decision.candidates.map(candidate => ({
                modelId: candidate.modelId,
                lane: config.models.find(model => model.id === candidate.modelId)?.laneId ?? null,
              })),
            );
            if (report) await ctx.state.set({
              scopeKind: "company", scopeId: companyId, stateKey: PLUGIN_STATE_KEYS.admissionShadowReport,
            }, { issueId, evaluatedAt: now, report });
          } catch {
            // Do not echo potentially sensitive caller input in logs.
            ctx.logger.warn("model-selection: account admission shadow failed; selection unchanged");
          }
        }

        // : resolve the cheap-key target once per advise so every
        // override write site consumes the same answer. Pure — every input is
        // already in scope here, so this adds no IO to the advise path.
        const ancillaryModelId = cheapestHealthyModelIdForTier({
          models: config.models,
          tier: "T3",
          ledger: laneLedger,
          laneOutageOverride,
          nowIso,
          modelScores,
          laneAvoidConfig: config.pacing.avoid,
          pacingMode: config.pacing.mode,
        });

        return {
          decision,
          issueId,
          status: described.status,
          hasOverride: described.hasOverride,
          existingLabelIds: described.existingLabelIds,
          hasTierLabel: described.hasTierLabel,
          hasOperatorPin: described.hasOperatorPin,
          isIdle: described.isIdle,
          isServiceabilityHardStop,
          isAgentExempt: agentExempt,
          nowIso,
          config,
          title: described.title,
          identifier: described.identifier,
          agentFloorModelId: described.descriptor.agentFloorModelId ?? null,
          pinnedModelId: described.descriptor.pinnedModelId ?? null,
          agentEnv: described.agentEnv,
          agentAdapterType: described.agentAdapterType,
          agentAdapterConfig: described.agentAdapterConfig,
          existingOverrideEnv: described.existingOverrideEnv,
          ancillaryModelId,
          assigneeAgentId: described.assigneeAgentId,
        };
      };

      ctx.tools.register(
        TOOL_NAMES.advise,
        {
          displayName: "Advise a model for an issue",
          description: "Return the tier judgement and costed candidates for one issue. Writes nothing.",
          parametersSchema: {
            type: "object",
            properties: {
              issueId: { type: "string" },
              admissionShadow: { type: "object", description: "Optional non-secret, report-only account snapshot; requires accountAdmissionShadow.enabled." },
              wakeReason: {
                type: "string",
                description:
                  ". Pass the run's PAPERCLIP_WAKE_REASON here so a cheap re-check (e.g. a monitor tick) can get a lower advisory floor without ever changing the card's own tier — see wakeScopedFloor config.",
              },
            },
          },
        },
        async (params, runCtx): Promise<ToolResult> => {
          const result = await advise(runCtx.companyId, asRecord(params));
          if (!result) return { content: "Issue not found, or issueId was missing.", data: toolRejection("issue-not-found") };
          await raiseOrClearTierExhaustedAlarm(
            runCtx.companyId,
            result.issueId,
            result.title,
            result.identifier,
            result.decision,
            runCtx.agentId ?? null,
          );
          await raiseOrClearDeadVetoPollerAlarm(
            runCtx.companyId,
            result.issueId,
            result.title,
            result.identifier,
            result.decision,
            runCtx.agentId ?? null,
          );
          return { content: summary(result.decision), data: result.decision };
        },
      );

      ctx.tools.register(
        TOOL_NAMES.apply,
        {
          displayName: "Apply a model selection to an issue",
          description:
            "Advise, then write the per-issue override and tier label when enforcement is on. No-ops on an issue that already has an override.",
          parametersSchema: {
            type: "object",
            properties: {
              issueId: { type: "string" },
              admissionShadow: { type: "object", description: "Optional non-secret, report-only account snapshot; requires accountAdmissionShadow.enabled." },
              wakeReason: {
                type: "string",
                description:
                  ". A wake-scoped decision is always forced advisory, so passing this on `apply` never writes a lowered tier — it only ever affects the returned recommendation for this call.",
              },
            },
          },
        },
        async (params, runCtx): Promise<ToolResult> => {
          const result = await advise(runCtx.companyId, asRecord(params));
          if (!result) return { content: "Issue not found, or issueId was missing.", data: toolRejection("issue-not-found") };
          await raiseOrClearTierExhaustedAlarm(
            runCtx.companyId,
            result.issueId,
            result.title,
            result.identifier,
            result.decision,
            runCtx.agentId ?? null,
          );
          await raiseOrClearDeadVetoPollerAlarm(
            runCtx.companyId,
            result.issueId,
            result.title,
            result.identifier,
            result.decision,
            runCtx.agentId ?? null,
          );

          // Designated agents are exempt from router pinning: an exempt card
          // keeps the agent's own model. Only a serviceability hard stop may
          // still write it, so an exempt agent never fails on a dead lane.
          if (result.isAgentExempt && !result.isServiceabilityHardStop) {
            const exemptPlan = {
              write: false as const,
              issueId: result.issueId,
              modelId: null,
              labelName: null,
              reason: "agent exempt from router pinning; agent model governs",
              envRepairOnly: false,
            };
            return {
              content: `No write: ${exemptPlan.reason}`,
              data: { decision: result.decision, plan: exemptPlan },
            };
          }

          // The repin exception is itself a pace CONSEQUENCE, gated the same as
          // every other pace consequence: only in `enforce`. In `off`/`shadow`
          // this must behave exactly like pre-2137 — an existing override is
          // never touched, full stop.
          const paceRepinEligible = result.hasOverride && result.config.pacing.mode === "enforce";
          const repinHistory = paceRepinEligible ? await readPaceRepinHistory(runCtx.companyId) : {};

          const plan = planApply(
            result.decision,
            {
              hasExistingOverride: result.hasOverride,
              // Read from the issue's actual labels, not from the judgement
              // source. An issue can carry a tier label that did NOT key this
              // decision (an override outranks it), and inferring "has a label"
              // from "the label decided it" would re-add a duplicate.
              hasExistingTierLabel: result.hasTierLabel,
              status: result.status,
              // . Consulted only when the pin path declines: an
              // existing override that binds secret refs the assignee does not
              // carry cannot start a run, so it is rebuilt on the SAME model.
              envRepair: {
                pinnedModelId: result.pinnedModelId,
                staleSecretRefKeys: staleOverrideSecretRefKeys(result.existingOverrideEnv, result.agentEnv),
              },
              ...(paceRepinEligible
                ? {
                    paceRepin: {
                      hasOperatorPin: result.hasOperatorPin,
                      isIdle: result.isIdle,
                      lastRepinAt: repinHistory[result.issueId] ?? null,
                      now: result.nowIso,
                      idleRepinHysteresisSeconds: result.config.pacing.idleRepinHysteresisSeconds,
                      isServiceabilityHardStop: result.isServiceabilityHardStop,
                    },
                  }
                : {}),
            },
            result.issueId,
          );

          if (!plan.write || !plan.modelId) {
            return { content: `No write: ${plan.reason}`, data: { decision: result.decision, plan } };
          }

          //  P2: recover through the candidate-carrying path so the
          // v2 identity evidenced at advise time travels with the row instead
          // of being re-derived (possibly differently) from the bare model id.
          const selectedModel = recoverSelectedCandidate(result.config.models, {
            modelId: plan.modelId,
            aaEffortEvidence: result.decision.aaEffortEvidence,
          });
          if (!selectedModel) {
            return {
              content: `No write: selected model ${plan.modelId} is absent from the resolved roster`,
              data: { decision: result.decision, plan },
            };
          }
          const patch: IssueUpdatePatch = modelOverrideForContext({
            model: selectedModel,
            agentEnvContextTokens: result.config.selection.agentEnvContextTokens,
            compactionRatio: result.config.selection.compactionRatio,
            agentEnv: result.agentEnv,
            agentAdapterType: result.agentAdapterType,
            agentAdapterConfig: result.agentAdapterConfig,
            existingOverrideEnv: result.existingOverrideEnv,
            cheapModelId: result.ancillaryModelId,
            provenance: fallbackPinProvenance(selectedModel, result.assigneeAgentId),
          });
          let labelNote = "";
          if (plan.labelName && result.decision.effectiveTier) {
            // Operator-supplied id, not a name lookup: there is no label surface
            // in the plugin SDK and `labels` is absent from
            // PLUGIN_DATABASE_CORE_READ_TABLES, so a name→id query is rejected
            // by `assertAllowedPublicRead` (plugin-database.ts:157-168). A
            // missing id is not an error — the label is additive, not a gate.
            const labelId = result.config.tierLabelIds[result.decision.effectiveTier];
            if (labelId) {
              // The host REPLACES the label set: syncIssueLabels deletes every
              // issue_labels row then inserts exactly these ids
              // (issues.ts:4835-4852). Sending [labelId] alone would strip every
              // other label off the issue. Union with what is already there.
              patch.labelIds = [...new Set([...result.existingLabelIds, labelId])];
            } else {
              labelNote = ` (no configured label id for ${plan.labelName}; override written without it)`;
            }
          }

          await ctx.issues.update(
            result.issueId,
            patch as Parameters<typeof ctx.issues.update>[1],
            runCtx.companyId,
            { actorAgentId: runCtx.agentId ?? null, actorRunId: runCtx.runId ?? null },
          );
          await recordFallbackPin(runCtx.companyId, result.issueId, patch);

          if (plan.envRepairOnly) {
            await ctx.activity.log({
              companyId: runCtx.companyId,
              message: `Model Selection repaired the env of its ${plan.modelId} pin on this issue (model unchanged)`,
              entityType: "issue",
              entityId: result.issueId,
              metadata: {
                modelId: plan.modelId,
                staleSecretRefKeys: staleOverrideSecretRefKeys(result.existingOverrideEnv, result.agentEnv),
                trigger: "apply",
              },
            });
            // Not a repin: the model did not move, so the idle hysteresis
            // that `paceRepinHistory` feeds must not start counting.
            return { content: plan.reason, data: { decision: result.decision, plan } };
          }

          await ctx.activity.log({
            companyId: runCtx.companyId,
            message: `Model Selection pinned ${result.decision.modelId} (${result.decision.effectiveTier}) on this issue`,
            entityType: "issue",
            entityId: result.issueId,
            metadata: {
              modelId: result.decision.modelId,
              tier: result.decision.effectiveTier,
              tierSource: result.decision.judgement.source,
              trace: result.decision.trace,
            },
          });

          if (paceRepinEligible) {
            // This write only ever reaches here when `repinAllowed` said yes —
            // record it so the next repin attempt on this issue honors the
            // idle hysteresis instead of firing again immediately.
            await ctx.state.set(paceRepinHistoryKey(runCtx.companyId), {
              ...repinHistory,
              [result.issueId]: result.nowIso,
            });
          }

          return { content: plan.reason + labelNote, data: { decision: result.decision, plan } };
        },
      );

      ctx.tools.register(
        TOOL_NAMES.setOperatorOverride,
        {
          displayName: "Set an operator override for an issue",
          description:
            "Record a time-boxed override: `model_selection_advise`/`apply` will route this issue to the named model ahead of pace ordering and slot throttling, until it expires. It never bypasses a capability gate, tier floor/ceiling, the untrusted-profile hold, or a serviceability hard stop.",
          parametersSchema: {
            type: "object",
            required: ["issueId", "modelId"],
            properties: {
              issueId: { type: "string" },
              modelId: { type: "string" },
              ttlSeconds: { type: "integer", minimum: 1 },
            },
          },
        },
        async (params, runCtx): Promise<ToolResult> => {
          const supplied = asRecord(params);
          const issueId = typeof supplied.issueId === "string" ? supplied.issueId : null;
          const modelId = typeof supplied.modelId === "string" ? supplied.modelId : null;
          if (!issueId || !modelId) {
            return { content: "issueId and modelId are both required.", data: toolRejection("missing-params") };
          }
          const config = await companyConfig(runCtx.companyId);
          const configuredModelId = resolveConfiguredModelId(modelId, config.models);
          if (!configuredModelId) {
            return {
              content: `modelId ${modelId} is not a configured roster entry.`,
              data: toolRejection("unknown-model", { modelId }),
            };
          }
          const ttlSeconds =
            typeof supplied.ttlSeconds === "number" && supplied.ttlSeconds > 0
              ? supplied.ttlSeconds
              : config.pacing.operatorOverrideTtlSeconds;

          const nowIso = new Date().toISOString();
          const existing = await readOperatorOverrides(runCtx.companyId);
          const updated = recordOperatorOverride(existing, issueId, configuredModelId, nowIso, ttlSeconds);
          await ctx.state.set(operatorOverridesKey(runCtx.companyId), updated);

          const entry = updated[issueId]!;
          return {
            content: `operator override recorded: ${issueId} -> ${configuredModelId}, expires ${entry.expiresAt}`,
            data: entry,
          };
        },
      );

      ctx.tools.register(
        TOOL_NAMES.setLaneOutage,
        {
          displayName: "Declare or clear a lane outage",
          description:
            " port of lane_outage.json: declare a telemetry-invisible outage on named lanes/models until an ISO timestamp, or clear it by omitting both lanes and models.",
          parametersSchema: {
            type: "object",
            required: ["until"],
            properties: {
              lanes: { type: "array", items: { type: "string" } },
              models: { type: "array", items: { type: "string" } },
              until: { type: "string" },
              reason: { type: "string" },
            },
          },
        },
        async (params, runCtx): Promise<ToolResult> => {
          const supplied = asRecord(params);
          const lanes = Array.isArray(supplied.lanes) ? supplied.lanes.filter((l): l is string => typeof l === "string") : [];
          const models = Array.isArray(supplied.models) ? supplied.models.filter((m): m is string => typeof m === "string") : [];
          const until = typeof supplied.until === "string" ? supplied.until : null;
          if (!until) return { content: "until is required (ISO-8601 UTC timestamp).", data: toolRejection("missing-until") };
          if (lanes.length === 0 && models.length === 0) {
            await ctx.state.set(laneOutageKey(runCtx.companyId), null);
            return { content: "lane outage cleared.", data: { ok: true, cleared: true } };
          }
          const reason = typeof supplied.reason === "string" ? supplied.reason : undefined;
          const override: LaneOutageOverride = { lanes, models, until, ...(reason ? { reason } : {}) };
          await ctx.state.set(laneOutageKey(runCtx.companyId), override);
          return { content: `lane outage recorded: ${[...lanes, ...models].join(", ")} until ${until}`, data: override };
        },
      );

      ctx.tools.register(
        TOOL_NAMES.setZaiPaceOverride,
        {
          displayName: "Set or clear the Z.ai weekly-pace margin override",
          description:
            " port of zai_pace_override.json: temporarily widen (or tighten) the margin zaiWeeklyPaceOk allows above elapsed-week fraction, e.g. during a Codex outage. Clear by omitting margin.",
          parametersSchema: {
            type: "object",
            required: ["until"],
            properties: {
              margin: { type: "number", minimum: 0, maximum: 1 },
              until: { type: "string" },
            },
          },
        },
        async (params, runCtx): Promise<ToolResult> => {
          const supplied = asRecord(params);
          const until = typeof supplied.until === "string" ? supplied.until : null;
          if (!until) return { content: "until is required (ISO-8601 UTC timestamp).", data: toolRejection("missing-until") };
          if (typeof supplied.margin !== "number") {
            await ctx.state.set(zaiPaceOverrideKey(runCtx.companyId), null);
            return { content: "zai pace override cleared.", data: { ok: true, cleared: true } };
          }
          const override: ZaiPaceOverride = { margin: supplied.margin, until };
          await ctx.state.set(zaiPaceOverrideKey(runCtx.companyId), override);
          return { content: `zai pace override recorded: margin ${supplied.margin} until ${until}`, data: override };
        },
      );

      //  ( P2,  D4). Prepare/validate/diff only: the
      // SDK has no compare-and-set primitive, so nothing proves a write would
      // land on one authoritative revision. The tool therefore never touches
      // ctx.state or config and never changes routing; the log line is the audit.
      ctx.tools.register(
        TOOL_NAMES.tierPolicy,
        {
          displayName: TIER_POLICY_TOOL_DISPLAY_NAME,
          description: TIER_POLICY_TOOL_DESCRIPTION,
          parametersSchema: TIER_POLICY_TOOL_PARAMETERS as unknown as Record<string, unknown>,
        },
        async (params, runCtx): Promise<ToolResult> => {
          const result = prepareTierPolicyEdit(asRecord(params), {
            agentId: typeof runCtx?.agentId === "string" ? runCtx.agentId : null,
            runId: typeof runCtx?.runId === "string" ? runCtx.runId : null,
          });
          ctx.logger.info("tier policy proposal", {
            auditId: result.auditId,
            action: result.action,
            outcome: result.outcome,
            baseSource: result.baseSource,
            baseRevision: result.baseRevision,
            proposedRevision: result.proposedRevision,
            issueCodes: result.issues.map((i) => i.code),
            changedPaths: result.diff.length,
            companyId: runCtx?.companyId ?? null,
            agentId: runCtx?.agentId ?? null,
            runId: runCtx?.runId ?? null,
          });
          return { content: renderTierPolicyEditResult(result), data: result as unknown as Record<string, unknown> };
        },
      );

      // --- rework-signal capture ( §2.2 / model_scores.py:93-131) ---
      // `activity_log` is not an allowlisted table, so reopen detection cannot
      // be a live SQL join. Capture it from the event stream instead and let
      // `refreshScores` fold the accumulated signals in at its own cadence.
      const appendReworkSignal = async (companyId: string, signal: ReworkSignal): Promise<void> => {
        const existing = await readReworkSignals(companyId);
        // Bound growth: refreshScores drains signals older than its own read
        // window every run, so keep at most one window's worth resident.
        const cutoffMs = Date.now() - SCORE_WINDOW_DAYS * 2 * 24 * 60 * 60 * 1000;
        const pruned = existing.filter((s) => s.atMs >= cutoffMs);
        await ctx.state.set(reworkSignalsKey(companyId), { signals: [...pruned, signal] });
      };

      // Resolve one earn-in card.
      //
      // Completion/cancellation, reopen, rejection and run failure share this
      // fold. Active cards release capacity exactly once. Known first-eight
      // completions are later corrected only by explicit human evidence — a
      // rejection/reopen or a safety violation; duplicate, unrelated or late
      // run-failure events write nothing. A card dispatched before the flag
      // went off still releases (and folds) when it completes while
      // disabled, so re-enabling never finds wedged active caps. A
      // successful heartbeat alone is not delivered work, so
      // `agent.run.succeeded` never folds acceptance.
      //
      // `modelId` may be null when the caller does not know the served model
      // (reopen/rejection signals carry no model). The active entry names the
      // model — the dispatch-time idempotency key `${issueId}:${modelId}:earnin`
      // is the lookup, so resolution never guesses.
      const resolveEarnInForIssue = async (
        companyId: string,
        issueId: string,
        signal: {
          runStatus: string | null;
          errorText: string | null;
          errorCode: string | null;
          rejected: boolean;
          modelId: string | null;
        },
      ): Promise<{ modelId: string; lane: string | null; outcome: "ok" | "material-failure" | "ignore" } | null> => {
        const enabled = (await companyConfig(companyId)).earnIn.enabled;
        // The dispatch-time key names the model; match this issue's key
        // (caller-known model first, any active key for the issue second).
        const matchActiveKey = (state: EarnInState) => signal.modelId
          ? `${issueId}:${signal.modelId}:earnin`
          : state.dispatchedKeys.find((key) => key.startsWith(`${issueId}:`) && key.endsWith(":earnin")) ?? null;
        const activeLaneOf = (state: EarnInState) =>
          Object.entries(state.activePerLane).find(([, ids]) => ids.includes(issueId))?.[0] ?? null;
        if (!enabled) {
          // Disabled earn-in admits nothing, so an issue with no live entry
          // needs no serialization: return before the lock with no state
          // write. The `agent.run.failed` hook funnels through here before
          // the latency-sensitive lane quarantine, so even lock contention
          // is a production cost while the flag is off. An issue dispatched
          // before the flag went off still holds an active entry — it falls
          // through to the locked path below so its release + fold stays
          // serialized, and it never corrects a recorded outcome while off.
          const state = await readEarnInState(companyId);
          const activeKey = matchActiveKey(state);
          if (!activeKey || !state.dispatchedKeys.includes(activeKey)) return null;
          if (!activeLaneOf(state)) return null;
        }
        return withEarnInLock(companyId, async () => {
          const state = await readEarnInState(companyId);
          const activeKey = matchActiveKey(state);
          if (!activeKey || !state.dispatchedKeys.includes(activeKey)) return null;
          const modelId = activeKey.slice(issueId.length + 1, -":earnin".length);
          const lane = activeLaneOf(state);
          const resolution = classifyEarnInResolution({ ...signal, modelId });
          if (!lane) {
            // Done releases capacity. A later rejection replaces that card's
            // known first-eight slot, rather than vanishing or counting twice.
            // A late run failure (e.g. a timeout landing after the card
            // resolved) is not a quality verdict on delivered work, so it
            // never rewrites a recorded outcome toward the stop circuit.
            // Nothing corrects a recorded outcome while disabled, either.
            if (!enabled) return null;
            const slot = state.outcomeSlots?.[activeKey];
            const safetyStop = resolution.safetyOrAuthorityViolation && !state.stopped[modelId];
            if (slot && slot.modelId !== modelId) return null;
            if (!signal.rejected && !resolution.safetyOrAuthorityViolation) return null;
            if (resolution.outcome !== "material-failure") return null;
            if (!safetyStop && (!slot || state.firstEightOutcomes[modelId]?.[slot.index] !== "ok")) return null;
            // Safety stops bind beyond the first eight too. With no known slot,
            // stop without inventing another card outcome or a historical lane.
            await writeEarnInState(companyId, recordEarnInOutcome(
              state, modelId, "material-failure", resolution.safetyOrAuthorityViolation, slot?.index ?? -1,
            ));
            return { modelId, lane: slot?.lane ?? null, outcome: resolution.outcome };
          }
          const next = nextEarnInStateOnResolve(state, modelId, lane, issueId, resolution);
          await writeEarnInState(companyId, next);
          return { modelId, lane, outcome: resolution.outcome };
        });
      };

      ctx.events.on("issue.updated", async (event) => {
        const payload = asRecord(event.payload);
        const changes = asRecord(payload.changes);
        const issueId = typeof event.entityId === "string" ? event.entityId : null;
        // : any change may be a label or assignee change the next
        // run-scoped decision must see.
        if (issueId) runIssueCache.invalidate(runIssueKey(event.companyId, issueId));

        // : fresh assignment (null -> agent id) is the other
        // "creation moment" — cards are frequently created unassigned and
        // assigned by a later PATCH, after `issue.created` already fired and
        // found no assignee. Agent-to-agent reassignment is not a creation
        // moment (the card had one under the previous assignee), so it does
        // not re-decide the model; it only re-homes the pin's env.
        const assignment = asRecord(changes.assigneeAgentId);
        const assignedTo = typeof assignment.to === "string" ? assignment.to : null;
        let didAssignmentPin = false;
        const assignedFrom = typeof assignment.from === "string" ? assignment.from : null;
        if (issueId && assignedTo && assignment.from == null) {
          didAssignmentPin = true;
          try {
            await pinAtDecisionTime(event.companyId, issueId, "issue.updated:assignment");
          } catch (cause) {
            ctx.logger.error("assignment-time pin failed", {
              companyId: event.companyId,
              issueId,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        } else if (issueId && assignedTo && assignedFrom && assignedFrom !== assignedTo) {
          try {
            await rehomePinOnReassignment(event.companyId, issueId, assignedFrom, assignedTo);
          } catch (cause) {
            ctx.logger.error("reassignment pin re-home failed", {
              companyId: event.companyId,
              issueId,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }

        const status = asRecord(changes.status);
        const from = typeof status.from === "string" ? status.from : null;
        const to = typeof status.to === "string" ? status.to : null;
        // Delivery, not a successful heartbeat, completes an earn-in card.
        // Cancellation releases capacity but supplies no quality evidence.
        if (issueId && from !== to && (to === "done" || to === "cancelled")) {
          try {
            await resolveEarnInForIssue(event.companyId, issueId, {
              runStatus: to === "done" ? "succeeded" : "cancelled",
              errorText: null, errorCode: null, rejected: false, modelId: null,
            });
          } catch (cause) {
            ctx.logger.error("earn-in resolve on completion failed", {
              companyId: event.companyId, issueId,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
        // Resolve earn-in before the rework early return or todo re-entry pin.
        if (issueId && (from === "done" || from === "cancelled") && to && to !== "done" && to !== "cancelled") {
          try {
            await resolveEarnInForIssue(event.companyId, issueId, {
              runStatus: null,
              errorText: null,
              errorCode: null,
              rejected: true,
              modelId: null,
            });
          } catch (cause) {
            ctx.logger.error("earn-in resolve on reopen failed", {
              companyId: event.companyId,
              issueId,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
        // : todo re-entry (e.g. backlog -> todo) is the third
        // creation moment — the card missed both `issue.created` and the
        // assignment arm, so it rides the agent floor until the next
        // 10-minute pass. Reuse `pinAtDecisionTime` itself (single
        // pin-write policy). Skipped when the assignment arm above already
        // pinned in this same tick to avoid a double classification.
        // `from` must be a real non-todo status: a missing `from` is not a
        // re-entry. Deliberately placed before the reopen early-return
        // below — done -> todo is both a reopen (scores) and a re-entry
        // (pin), and both concerns must run.
        if (issueId && !didAssignmentPin && to === "todo" && typeof from === "string" && from !== "todo") {
          try {
            await pinAtDecisionTime(event.companyId, issueId, "issue.updated:status-todo");
          } catch (cause) {
            ctx.logger.error("status-todo pin failed", {
              companyId: event.companyId,
              issueId,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
        if (!issueId || from !== "done" || to === "done" || to === "cancelled" || !to) return;
        await appendReworkSignal(event.companyId, {
          issueId,
          atMs: Date.parse(event.occurredAt) || Date.now(),
          kind: "reopen",
          excludeAgentId: null,
        });
      });

      // Supplementary capture path only — full-body rejection-regex matching
      // happens directly against `issue_comments` inside `refreshScores`
      // (allowlisted), because the event payload truncates `body` to a
      // 120-char `bodySnippet`. Kept for symmetry with the reopen path and so
      // a signal is not lost if a comment is edited after the job last ran.
      const REJECTION_RE =
        /request(ed)? changes|^## *(rejected|fail|blocked by review)|not accepted|changes requested|re-?do this|does not pass review/i;
      ctx.events.on("issue.comment.created", async (event) => {
        const payload = asRecord(event.payload);
        const snippet = typeof payload.bodySnippet === "string" ? payload.bodySnippet : "";
        if (!REJECTION_RE.test(snippet)) return;
        const issueId = typeof event.entityId === "string" ? event.entityId : null;
        if (!issueId) return;
        // A rejection on an actively-dispatched earn-in card resolves it as
        // a material failure (the card did not stay accepted). Runs before
        // the rework-signal append so the slot releases even if the append
        // below throws.
        try {
          await resolveEarnInForIssue(event.companyId, issueId, {
            runStatus: null,
            errorText: null,
            errorCode: null,
            rejected: true,
            modelId: null,
          });
        } catch (cause) {
          ctx.logger.error("earn-in resolve on rejection failed", {
            companyId: event.companyId,
            issueId,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
        await appendReworkSignal(event.companyId, {
          issueId,
          atMs: Date.parse(event.occurredAt) || Date.now(),
          kind: "rejected",
          excludeAgentId: typeof event.actorId === "string" ? event.actorId : null,
        });
      });

      // --- : creation-time pin + unpinnable-card visibility ---------
      // The scheduled passes are `*/10` and their row queries EXCLUDE cards
      // with a running/queued run — a card dispatched within seconds of
      // creation (measured 0.2-0.3 s create-to-first-run,
      // docs/routing/-issue-created-pin-feasibility.md) is already
      // running at every pass firing, so it stays unlabelled and unpinned for
      // its whole first turn and lands on the agent floor. These handlers see
      // the card from the event stream the moment it exists. They cannot own
      // the first turn either (the bus is fire-and-forget and loses the same
      // measured race); they pin every card the passes were missing as soon
      // as it is idle — exactly the release mechanism the core-side dispatch
      // gate ( half 1) needs once it lands.

      /**
       *  AC3. One visible activity notice per throttle window for a
       * card the router looked at and could not pin — `no-eligible-model` or
       * `tier-exhausted`. Without this, labelOnlyPass/balancePass `continue`
       * silently, and a sustained lane outage reads as "no news" on every
       * card it strands. Lane states are embedded so the notice answers
       * "why" without a second lookup.
       */
      const maybeLogUnpinnableCard = async (
        companyId: string,
        issueId: string,
        identifier: string | null,
        decision: SelectionDecision | null,
      ): Promise<void> => {
        if (!decision) return;
        if (decision.outcome !== "no-eligible-model" && decision.outcome !== "tier-exhausted") return;
        const key = {
          scopeKind: "company" as const,
          scopeId: companyId,
          stateKey: PLUGIN_STATE_KEYS.noEligibleNotices,
        };
        const stored = asRecord(await ctx.state.get(key));
        const rawLast = stored[issueId];
        if (typeof rawLast === "string") {
          const lastAtMs = Date.parse(rawLast);
          if (!Number.isNaN(lastAtMs) && Date.now() - lastAtMs < NO_ELIGIBLE_NOTICE_THROTTLE_MS) return;
        }

        const laneLedger = await readLaneLedger(companyId);
        const laneStates = Object.values(laneLedger)
          .map(
            (entry) =>
              `${entry.laneId}=${entry.verdict ?? "?"}@${Math.round(laneEffectiveUtilization(laneLedger, entry.laneId) * 100)}%${entry.error ? "(poll-error)" : ""}`,
          )
          .join(" ");

        // Bounded: entries older than a week can never fire the throttle
        // check again, so drop them on write.
        const pruned: Record<string, string> = {};
        for (const [id, at] of Object.entries(stored)) {
          if (typeof at === "string" && Date.now() - Date.parse(at) < 7 * 24 * 60 * 60 * 1000) pruned[id] = at;
        }
        await ctx.state.set(key, { ...pruned, [issueId]: new Date().toISOString() });
        const rejectionSummary = decision.rejections.slice(0, 8)
          .map((entry) => `${entry.modelId} [${entry.stage}]: ${entry.reason}`).join("; ");
        const nextAction = decision.outcome === "tier-exhausted"
          ? "The router can retry when lane capacity recovers."
          : "The router can retry when eligibility evidence changes or expires; lane recovery alone may not resolve this.";
        await ctx.activity.log({
          companyId,
          message: `Model Selection cannot pin this card: ${decision.outcome}. Rejections: ${rejectionSummary || "see decision trace"}. Lane states: ${
            laneStates || "no lane data"
          }. ${nextAction}`,
          entityType: "issue",
          entityId: issueId,
          metadata: {
            outcome: decision.outcome,
            identifier,
            rejections: decision.rejections,
            lanes: Object.values(laneLedger).map((entry) => ({
              laneId: entry.laneId,
              verdict: entry.verdict,
              error: entry.error,
            })),
            trace: decision.trace,
          },
        });
      };

      /**
       * . True when run-scoped decisions are live for this company:
       * the flag is on AND the install enforces. Only then are the legacy pin
       * writers retired — an advisory install writes no pin anyway, and
       * retiring them while the handler answers `keep` would leave nothing
       * routing at all. Tier labels are never retired.
       */
      const runResolveActive = (config: ResolvedConfig): boolean =>
        config.runResolve.enabled && selectionWritesAllowed(config);

      /**
       * . Classifications this worker has started and not finished,
       * by issue. The run-scoped hook may WAIT (<= 1 s) on one that is already
       * running so a card created a moment ago gets its classified tier; it
       * never starts one ( §6). Entries remove themselves on settle.
       */
      const classificationsInFlight = new Map<string, Promise<Tier | null>>();
      const trackClassification = (issueId: string, work: Promise<Tier | null>): Promise<Tier | null> => {
        const tracked: Promise<Tier | null> = work
          .catch(() => null)
          .finally(() => {
            if (classificationsInFlight.get(issueId) === tracked) classificationsInFlight.delete(issueId);
          });
        classificationsInFlight.set(issueId, tracked);
        return tracked;
      };

      /**
       *  half 2, restructured by  ( §7 item 2).
       * Label-tier semantics — the pin is decided at the card's own tier label
       * (existing, or just written by the classification below), the same
       * outcome `labelOnlyPass` would produce, NOT balancePass's forced T1: an
       * event path that changed routing policy would be a silent policy
       * change, and this only moves the same decision earlier in time. Never
       * writes unless the card is agent-assigned, open, unpinned and its live
       * runs are all queued-and-unstarted (`creationWriteStillSafe`).
       *
       * Two phases, in this order:
       * 1. First pin, from data already in hand: `resolveTier()`'s judgement
       *    (label, else the assignee's floor tier, else the configured
       *    default — ADR-0007, no text heuristics). No network call precedes
       *    this write; the wake's run is claimed at p50 2.19 s after it is
       *    queued, and the classifier alone can take 15 s, so a pin that
       *    waited for it landed on 0 of 130 first runs.
       * 2. Classifier refinement, for an unlabelled card only. It writes the
       *    label as before; a different tier re-pins only while the wake's
       *    run is still unstarted. Otherwise the label stands and repinPass's
       *    `tierWithFallback` lets it supersede a weaker pin at the next idle
       *    boundary.
       */
      const pinAtDecisionTime = async (companyId: string, issueId: string, source: string): Promise<void> => {
        const receivedAtMs = Date.now();
        const config = await companyConfig(companyId);
        if (!config.classification.enabled) return;

        const described = await describeIssue(companyId, issueId, {});
        if (!described) return;
        // `issue.created` carries no assignee ( §3) — an unassigned
        // card returns here and is picked up by the assignment arm below.
        if (!described.assigneeAgentId) return;
        if (!balanceOpenStatuses.has(described.status)) return;
        if (described.hasOperatorPin) return;
        if (described.descriptor.pinnedModelId) return;

        // : with run-scoped decisions live, the pin is retired but the
        // classification still runs and still writes the label — the hook reads
        // it (or waits on it) at the run boundary.
        const runScoped = runResolveActive(config);
        const heuristicTier = resolveTier(described.descriptor, config.models, config.selection.defaultTier).tier;
        const firstPinnedModelId = await pinAtTier(companyId, issueId, described.identifier, source, config, {
          tier: heuristicTier,
          expectedPinnedModelId: null,
          receivedAtMs,
        });
        if (described.hasTierLabel) return; // the label already decided the tier

        const labelTier = await trackClassification(
          issueId,
          classifyForPin(companyId, issueId, described, config, source),
        );
        if (runScoped) return; // the label stands; the next run boundary applies it
        if (!labelTier || labelTier === heuristicTier) return;
        await pinAtTier(companyId, issueId, described.identifier, source, config, {
          tier: labelTier,
          expectedPinnedModelId: firstPinnedModelId,
          receivedAtMs,
        });
      };

      /**
       * Phase 2 of `pinAtDecisionTime`: classify one unlabelled card and write
       * its `tier:*` label. Mirror of classifyIssues' per-row path minus the
       * row query: the event already named this card; classifyIssues cannot
       * see it precisely because it dispatches before the next pass fires.
       * Returns the label tier, or null when no classification was made.
       */
      const classifyForPin = async (
        companyId: string,
        issueId: string,
        described: NonNullable<Awaited<ReturnType<typeof describeIssue>>>,
        config: ResolvedConfig,
        source: string,
      ): Promise<Tier | null> => {
        if (!config.classification.baseUrl || !config.classification.modelId) return null;
        let apiKey: string | null = null;
        if (config.classification.apiKeySecretRef) {
          try {
            apiKey = await ctx.secrets.resolve(config.classification.apiKeySecretRef as never, {
              companyId,
              configPath: "classification.apiKeySecretRef",
            });
          } catch {
            ctx.logger.error("creation-pin classification secret unavailable", { companyId, issueId });
            return null;
          }
        }
        const classified = await callClassifier(
          {
            baseUrl: config.classification.baseUrl,
            protocol: config.classification.protocol,
            modelId: config.classification.modelId,
            apiKey,
            system: RUBRIC,
            userPrompt: buildClassificationPrompt(
              described.title,
              described.description,
              described.descriptor.agentName ?? "",
              config.classification.descriptionChars,
            ),
            maxOutputTokens: config.classification.maxOutputTokens,
            requestTimeoutMs: config.classification.requestTimeoutMs,
            maxResponseBytes: config.classification.maxResponseBytes,
          },
          classificationHttp,
        );
        if (!classified.text) {
          ctx.logger.info("creation-pin classification skipped", {
            companyId,
            issueId,
            why: classified.error,
          });
          return null;
        }
        const judgement = parseClassificationResponse(classified.text);
        if (!judgement) {
          ctx.logger.info("creation-pin classification unparseable", { companyId, issueId });
          return null;
        }
        const { labelTier } = resolveClassifiedTiers(judgement, {
          t3ConfidenceFloor: config.classification.t3ConfidenceFloor,
          t2ConfidenceFloor: config.classification.t2ConfidenceFloor,
        });
        const labelId = config.tierLabelIds[labelTier];
        if (labelId) {
          // Union, never replace: the host REPLACES the label set on a
          // labelIds write (issues.ts syncIssueLabels).
          await ctx.issues.update(
            issueId,
            { labelIds: [...new Set([...described.existingLabelIds, labelId])] } as Parameters<
              typeof ctx.issues.update
            >[1],
            companyId,
          );
        }
        if (judgement.exclusion) {
          const exclusions = await readClassificationExclusions(companyId);
          await ctx.state.set(classificationExclusionsKey(companyId), { ...exclusions, [issueId]: true });
        }
        await ctx.activity.log({
          companyId,
          message: `Model Selection classified this issue as ${labelTier} (confidence ${judgement.confidence})${
            judgement.exclusion ? ", capability-excluded" : ""
          } at card creation`,
          entityType: "issue",
          entityId: issueId,
          metadata: {
            tier: labelTier,
            confidence: judgement.confidence,
            reason: judgement.reason,
            source,
          },
        });
        return labelTier;
      };

      /**
       * One guarded creation-path pin write at `tier`. `expectedPinnedModelId`
       * is the pin this write may replace: null for the first pin, or the
       * first pin's model for the classifier re-pin — any other pin (an
       * operator's, a pass's) landing in between wins. Returns the model it
       * wrote, or null when it wrote nothing.
       */
      const pinAtTier = async (
        companyId: string,
        issueId: string,
        identifier: string | null,
        source: string,
        config: ResolvedConfig,
        attempt: { tier: Tier; expectedPinnedModelId: string | null; receivedAtMs: number },
      ): Promise<string | null> => {
        // : the creation/assignment pin is retired once run-scoped
        // decisions are live; the run boundary decides instead.
        if (runResolveActive(config)) return null;
        const { tier, expectedPinnedModelId, receivedAtMs } = attempt;
        const isRepin = expectedPinnedModelId !== null;
        // `forceTier` passes the tier explicitly rather than re-reading it
        // from the issue: making the label-write -> label-read round trip
        // load-bearing within one tick would couple correctness to the host's
        // `issues.get` label enrichment, and the plugin already knows the
        // answer. A re-pin suppresses stickiness, which would otherwise
        // re-select the first pin it exists to replace.
        const result = await advise(companyId, { issueId }, false, tier, isRepin);
        if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) {
          await maybeLogUnpinnableCard(companyId, issueId, identifier, result?.decision ?? null);
          return null;
        }
        // Designated agents are exempt from router pinning: skip the
        // creation-time pin (first pin and classifier re-pin) and leave the
        // agent's own model in charge. A serviceability hard stop still
        // repins, so an exempt agent never fails on a dead lane.
        if (result.isAgentExempt && !result.isServiceabilityHardStop) {
          ctx.logger.info("creation-time pin skipped: agent exempt", { companyId, issueId, source });
          await ctx.activity.log({
            companyId,
            message: `Model Selection skipped the creation-time pin on ${identifier ?? issueId} (${source}): agent exempt from router pinning; agent model governs`,
            entityType: "issue",
            entityId: issueId,
            metadata: {
              modelId: result.decision.modelId,
              tier: result.decision.effectiveTier,
              source,
              phase: isRepin ? "classified-repin" : "first-pin",
              exempt: true,
              trace: result.decision.trace,
            },
          });
          return null;
        }
        // `advise` re-described the card: trust its fresher status/pin
        // reads, not the pre-decision ones — but NOT its idle read.
        // : the assignment wake's run is queued, and often already
        // claimed, by now, so strict idleness aborts nearly every pin.
        // `pinnableBeforeStart` re-reads the card's live runs and allows the
        // queued-but-unstarted window, which is safe because Paperclip reads
        // the override at run START, not queue time.
        if (!balanceOpenStatuses.has(result.status)) return null;
        const currentPinnedModelId = resolveConfiguredModelId(result.pinnedModelId, config.models) ?? result.pinnedModelId;
        if (currentPinnedModelId !== expectedPinnedModelId) return null;
        if (!(await pinnableBeforeStart(companyId, issueId))) {
          if (isRepin) {
            ctx.logger.info("classified tier applies from next boundary: run already started", {
              companyId,
              issueId,
              source,
              tier,
            });
          }
          return null;
        }
        if (result.decision.modelId === expectedPinnedModelId) return null;
        const floorModelId = resolveConfiguredModelId(result.agentFloorModelId, config.models);
        if (result.decision.modelId === floorModelId) {
          // The router decided, and its pick IS the floor model — same
          // convention as labelOnlyPass/balancePass: no redundant override on
          // a card already running exactly that model.
          ctx.logger.info("creation-time pin skipped: pick equals floor", { companyId, issueId, source });
          return null;
        }
        //  P2: candidate-carrying recovery (see the apply path).
        const selectedModel = recoverSelectedCandidate(config.models, result.decision);
        if (!selectedModel) return null;
        // : the creation path's own final read — the shared
        // `balanceWriteStillSafe` below stays strict-idle for the scheduled
        // passes, and would veto this pin on the wake's queued run.
        if (!(await creationWriteStillSafe(companyId, issueId, config.models, expectedPinnedModelId))) return null;
        // : the creation path classifies and labels in every
        // posture, but the override write needs enforcement. Advisory
        // installs decide and report; they pin nothing.
        const writesAllowed = selectionWritesAllowed(config);
        if (writesAllowed) {
          const creationPatch = modelOverrideForContext({
            model: selectedModel,
            agentEnvContextTokens: config.selection.agentEnvContextTokens,
            compactionRatio: config.selection.compactionRatio,
            agentEnv: result.agentEnv,
            agentAdapterType: result.agentAdapterType,
            agentAdapterConfig: result.agentAdapterConfig,
            existingOverrideEnv: result.existingOverrideEnv,
            provenance: fallbackPinProvenance(selectedModel, result.assigneeAgentId),
          });
          await ctx.issues.update(issueId, creationPatch as Parameters<typeof ctx.issues.update>[1], companyId);
          await recordFallbackPin(companyId, issueId, creationPatch);
        }
        // Event receipt -> write.  §8 targets p99 <= 250 ms for the
        // first pin; a re-pin carries the classifier's latency by design.
        const latencyMs = Date.now() - receivedAtMs;
        if (writesAllowed) {
          // : the run may have STARTED between the final gate and the
          // write. The pin still landed and applies from the next run, so say
          // so — informational, never a failure. Only meaningful after a write.
          const afterRows = (await ctx.db.query(CREATION_PIN_LIVE_RUNS_SQL, [
            companyId,
            issueId,
          ])) as unknown[];
          if (
            afterRows.some((row) => {
              const run = asRecord(row);
              return run.status !== "queued" || run.started_at != null;
            })
          ) {
            ctx.logger.info("creation-time pin landed after run start (applies from next run)", {
              companyId,
              issueId,
              source,
            });
          }
        } else {
          ctx.logger.info("creation-time pin skipped: advisory selection, nothing written", {
            companyId,
            issueId,
            source,
            modelId: result.decision.modelId,
          });
        }
        await ctx.activity.log({
          companyId,
          // : name the card that was actually pinned. This message
          // hardcoded  (the card that built this path), so every
          // creation-time pin pointed at the wrong card.
          message: isRepin
            ? `Model Selection re-pinned ${expectedPinnedModelId} -> ${result.decision.modelId} (${result.decision.effectiveTier}) after classification, before the first run started — ${identifier ?? issueId} (${source})${writesAllowed ? "" : " — advisory, nothing written"}`
            : `Model Selection pinned ${result.decision.modelId} (${result.decision.effectiveTier}) at card creation — ${identifier ?? issueId} (${source})${writesAllowed ? "" : " — advisory, nothing written"}`,
          entityType: "issue",
          entityId: issueId,
          metadata: {
            modelId: result.decision.modelId,
            tier: result.decision.effectiveTier,
            source,
            phase: isRepin ? "classified-repin" : "first-pin",
            ...(isRepin ? { from: expectedPinnedModelId } : {}),
            latencyMs,
            identifier,
            trace: result.decision.trace,
            //  P2: the served leg of the v2 identity — which
            // curated candidate this pin actually served (null on legacy).
            candidateId: selectedModel.candidateId,
            // : present only when the gate above skipped the write.
            ...(writesAllowed ? {} : { advisory: true, written: false }),
          },
        });
        return writesAllowed ? selectedModel.id : null;
      };

      ctx.events.on("issue.created", async (event) => {
        const issueId = typeof event.entityId === "string" ? event.entityId : null;
        if (!issueId) return;
        runIssueCache.invalidate(runIssueKey(event.companyId, issueId));
        try {
          await pinAtDecisionTime(event.companyId, issueId, "issue.created");
        } catch (cause) {
          // Never let a pin attempt break the event loop for other handlers.
          ctx.logger.error("creation-time pin failed", {
            companyId: event.companyId,
            issueId,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      });

      // ---  ( §4.3, §6): run-scoped model decision -------
      //
      // `onResolveRunModel` is called by the host inside `executeRun`, before
      // the adapter config merge, with a deadline. It answers from memory:
      //
      //  - the company snapshot (config, volume profiles, lane ledger, scores,
      //    availability, lane evidence, live lane weights) is loaded by the
      //    refresh job and by a background refresh once older than the TTL;
      //    it is served STALE when a refresh fails;
      //  - issue labels and agent facts are cached per id and invalidated by
      //    the issue events;
      //  - the previous decision comes from the decision cache, with one
      //    `heartbeat_runs` read as the miss path;
      //  - the classifier is never started here. A classification the event
      //    path already has in flight is awaited for at most `classifierWaitMs`.
      //
      // Anything the handler cannot get inside its budget becomes `defer`: the
      // host parks the run for a bounded retry and never falls back to the
      // agent default (owner directive, ).

      /** Time kept back from the host deadline for the answer's own trip. */
      const RUN_RESOLVE_DEADLINE_MARGIN_MS = 150;
      const RUN_RESOLVE_ISSUE_TTL_MS = 15_000;
      const RUN_RESOLVE_AGENT_TTL_MS = 60_000;
      const RUN_RESOLVE_PEAK_TTL_MS = 10 * 60_000;
      const RUN_RESOLVE_CACHE_ENTRIES = 5_000;

      const logRunResolveRefreshError = (key: string, error: unknown): void => {
        ctx.logger.warn("run-resolve cache refresh failed; serving stale", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      };

      const runSnapshotCache = new HotCache<RunResolveSnapshot>({
        ttlMs: 45_000,
        maxEntries: 64,
        onRefreshError: logRunResolveRefreshError,
      });
      const runIssueCache = new HotCache<RunIssueFacts | null>({
        ttlMs: RUN_RESOLVE_ISSUE_TTL_MS,
        maxEntries: RUN_RESOLVE_CACHE_ENTRIES,
        onRefreshError: logRunResolveRefreshError,
      });
      const runAgentCache = new HotCache<RunAgentFacts | null>({
        ttlMs: RUN_RESOLVE_AGENT_TTL_MS,
        maxEntries: 1_000,
        onRefreshError: logRunResolveRefreshError,
      });
      /** Previous-run peak context, filled by a background read after a decision (never on the path). */
      const runPeakCache = new HotCache<number | null>({
        ttlMs: RUN_RESOLVE_PEAK_TTL_MS,
        maxEntries: RUN_RESOLVE_CACHE_ENTRIES,
        onRefreshError: logRunResolveRefreshError,
      });
      /** `decisionId` -> the decision this worker made, so the next run's sticky check is a memory hit. */
      const runDecisionCache = new HotCache<RunDecisionRecord>({
        ttlMs: Number.MAX_SAFE_INTEGER,
        maxEntries: RUN_RESOLVE_CACHE_ENTRIES,
      });

      const runSnapshotKey = (companyId: string) => companyId;
      const runIssueKey = (companyId: string, issueId: string) => `${companyId}:${issueId}`;
      invalidateRunSnapshot = (companyId) => runSnapshotCache.invalidate(runSnapshotKey(companyId));

      const loadRunResolveSnapshot = async (companyId: string): Promise<RunResolveSnapshot> => {
        const config = await companyConfig(companyId);
        const loadedAtMs = Date.now();
        // A company that has not turned this on (or does not enforce) never
        // pays for the reads below: the handler answers `keep` from `config`.
        if (!runResolveActive(config) || config.models.length === 0) {
          return {
            config,
            profiles: [],
            signals: [],
            laneLedger: {},
            operatorOverrides: {},
            cardLedger: {},
            modelScores: {},
            laneOutageOverride: null,
            zaiPaceOverride: null,
            pinsWeightByLane: {},
            availabilityRaw: null,
            laneEvidence: { lanes: [], windowHours: LANE_EVIDENCE_WINDOW_HOURS, unreadableReason: "snapshot not loaded" },
            loadedAtMs,
          };
        }
        const [
          { profiles, signals },
          laneLedger,
          operatorOverrides,
          cardLedger,
          modelScores,
          laneOutageOverride,
          zaiPaceOverride,
          availabilityRaw,
          laneEvidence,
          pinsWeightByLane,
        ] = await Promise.all([
          readProfiles(companyId),
          readLaneLedger(companyId),
          readOperatorOverrides(companyId),
          readCardLedger(companyId),
          readModelScores(companyId),
          readLaneOutage(companyId),
          readZaiPaceOverride(companyId),
          ctx.state.get(laneAvailabilityKey(companyId)),
          readLaneEvidence(companyId, config.models, loadedAtMs),
          config.pacing.mode !== "off" ? runLaneWeights(companyId, config.models) : Promise.resolve({}),
        ]);
        return {
          config,
          profiles,
          signals,
          laneLedger,
          operatorOverrides,
          cardLedger,
          modelScores,
          laneOutageOverride,
          zaiPaceOverride,
          pinsWeightByLane,
          availabilityRaw,
          laneEvidence,
          loadedAtMs,
        };
      };

      /** Legacy pins still count (they exist until cleared) plus the live routed runs. */
      const runLaneWeights = async (
        companyId: string,
        models: ResolvedConfig["models"],
      ): Promise<Record<string, number>> => {
        const weights = await activePinsWeightByLane(companyId, models);
        const rows = (await ctx.db.query(ACTIVE_ROUTED_RUN_MODELS_SQL, [companyId])) as unknown[];
        for (const row of rows) {
          const rawModelId = asRecord(row).routed_model;
          const modelId = resolveConfiguredModelId(typeof rawModelId === "string" ? rawModelId : null, models);
          const model = models.find((candidate) => candidate.id === modelId);
          if (!model || !model.laneId) continue;
          weights[model.laneId] = (weights[model.laneId] ?? 0) + (blendedListPrice(model) < 1.0 ? 0.5 : 1.0);
        }
        return weights;
      };

      const loadRunIssueFacts = async (companyId: string, issueId: string): Promise<RunIssueFacts | null> => {
        const issue = await ctx.issues.get(issueId, companyId);
        if (!issue) return null;
        return {
          labelNames: (issue.labels ?? [])
            .map((label) => label.name)
            .filter((name): name is string => typeof name === "string"),
          priority: typeof issue.priority === "string" ? issue.priority : null,
          title: String(issue.title ?? ""),
          status: String(issue.status ?? ""),
        };
      };

      const loadRunAgentFacts = async (companyId: string, agentId: string): Promise<RunAgentFacts | null> => {
        const agent = asRecord(await ctx.agents.get(agentId, companyId));
        if (Object.keys(agent).length === 0) return null;
        return {
          name: typeof agent.name === "string" ? agent.name : null,
          adapterConfig: asRecord(agent.adapterConfig),
        };
      };

      const parseDecisionRecord = (raw: unknown, decisionId: string): RunDecisionRecord | null => {
        const record = asRecord(typeof raw === "string" ? safeJsonParse(raw) : raw);
        if (record.decisionId !== decisionId || typeof record.model !== "string" || record.model.length === 0) return null;
        const tier = typeof record.tier === "string" && (TIERS as readonly string[]).includes(record.tier)
          ? (record.tier as Tier)
          : null;
        return { decisionId, model: record.model, tier, fallback: record.fallback === true };
      };

      /**
       * The previous run's routed decision. Memory first; one primary-key read
       * on a miss. A read that fails or times out degrades to "the model the
       * previous run reported, tier unknown": sticky still holds while that
       * model is serviceable, only the tier-change switch is skipped.
       */
      const readPriorDecision = async (
        params: ResolveRunModelParams,
        budgetMs: number,
      ): Promise<RunDecisionRecord | null> => {
        const previous = params.previous;
        if (!previous || !previous.decisionId || !previous.model) return null;
        const cached = runDecisionCache.peek(previous.decisionId);
        if (cached) return cached.value;
        const degraded: RunDecisionRecord = {
          decisionId: previous.decisionId,
          model: previous.model,
          tier: null,
          fallback: false,
        };
        const read = (async (): Promise<RunDecisionRecord | null> => {
          const rows = (await ctx.db.query(PREVIOUS_RUN_DECISION_SQL, [params.companyId, previous.runId])) as unknown[];
          return parseDecisionRecord(asRecord(rows[0]).model_decision, previous.decisionId as string);
        })().catch(() => null);
        const record = await withinMs(read, budgetMs, null);
        if (!record) return degraded;
        runDecisionCache.set(previous.decisionId, record);
        return record;
      };

      const fireAndForget = (work: Promise<unknown>, what: string): void => {
        work.catch((error: unknown) => {
          ctx.logger.warn(`run-resolve ${what} failed`, { error: error instanceof Error ? error.message : String(error) });
        });
      };

      const resolveRunModel = async (params: ResolveRunModelParams): Promise<ResolveRunModelResult> => {
        const startedAt = performance.now();
        const elapsed = (): number => performance.now() - startedAt;
        const budgetMs = Math.max(50, params.deadlineMs - RUN_RESOLVE_DEADLINE_MARGIN_MS);
        const remaining = (): number => Math.max(0, budgetMs - elapsed());
        const finish = (result: ResolveRunModelResult, outcome: string): ResolveRunModelResult => {
          fireAndForget(
            Promise.all([
              ctx.metrics.write("model_selection.run_resolve.latency_ms", Math.round(elapsed() * 100) / 100),
              ctx.metrics.write(`model_selection.run_resolve.${outcome}`, 1),
            ]),
            "metrics",
          );
          return result;
        };
        let deferRetryMs = 5_000;
        try {
          if (!params.issueId) return finish({ kind: "keep" }, "keep.non_issue");
          const issueId = params.issueId;
          const companyId = params.companyId;

          const snapshotRead = await runSnapshotCache.get(
            runSnapshotKey(companyId),
            () => loadRunResolveSnapshot(companyId),
            remaining(),
          );
          const snapshot = snapshotRead.value;
          const { config } = snapshot;
          deferRetryMs = config.runResolve.deferRetryMs;
          runSnapshotCache.setTtl(config.runResolve.snapshotTtlMs);
          if (snapshotRead.stale) fireAndForget(Promise.resolve(ctx.metrics.write("model_selection.run_resolve.stale_snapshot", 1)), "metrics");
          // Off, or advisory: the handler routes nothing and says so. The
          // legacy paths (still live in this posture) own the pin.
          if (!runResolveActive(config)) return finish({ kind: "keep" }, "keep.inactive");
          // : the engine re-checks the override against the roster
          // (an orphan falls through to a fresh decision); this early return
          // only skips the snapshot reads for a live override on an enabled
          // row. The engine is the authority — the identical predicate here
          // is a fast path, never a second policy.
          if (params.issueOverrideModel) {
            const liveOverride = resolveConfiguredModelId(params.issueOverrideModel, config.models);
            if (liveOverride && config.models.some((model) => model.id === liveOverride && model.enabled)) {
              return finish({ kind: "keep" }, "keep.override");
            }
          }

          const [issueRead, agentRead] = await Promise.all([
            runIssueCache.get(runIssueKey(companyId, issueId), () => loadRunIssueFacts(companyId, issueId), remaining()),
            runAgentCache.get(`${companyId}:${params.agentId}`, () => loadRunAgentFacts(companyId, params.agentId), remaining()),
          ]);
          const issue = issueRead.value;
          const agent = agentRead.value;
          if (!issue) return finish({ kind: "keep" }, "keep.issue_unreadable");
          if (!agent) {
            return finish({ kind: "defer", retryAfterMs: deferRetryMs, reason: "assignee agent is unreadable" }, "defer");
          }

          // An unlabelled card whose classification is already running gets to
          // finish, within the cap. Never started from here.
          let classifiedTier: Tier | null = null;
          const hasTierLabel = issue.labelNames.some((name) => name.startsWith(TIER_LABEL_PREFIX));
          const inFlight = hasTierLabel ? undefined : classificationsInFlight.get(issueId);
          if (inFlight) {
            classifiedTier = await withinMs(
              inFlight,
              Math.min(config.runResolve.classifierWaitMs, Math.max(0, remaining() - 50)),
              null,
            );
          }

          const prior = await readPriorDecision(params, Math.min(100, remaining()));
          const peak = runPeakCache.peek(runIssueKey(companyId, issueId))?.value ?? null;

          const resolution = resolveRunDecision({
            params,
            issue,
            agent,
            snapshot,
            prior,
            classifiedTier,
            lastRunPeakTokens: peak,
            now: Date.now(),
          });

          if (resolution.kind === "keep") return finish({ kind: "keep" }, "keep.engine");
          if (resolution.kind === "defer") {
            return finish({ kind: "defer", retryAfterMs: deferRetryMs, reason: resolution.reason }, "defer");
          }

          const { result } = resolution;
          runDecisionCache.set(result.decisionId, {
            decisionId: result.decisionId,
            model: result.model,
            tier: resolution.tier,
            fallback: result.fallback === true,
          });
          // The measured context peak feeds the NEXT decision; read it off the
          // path, once per TTL, only for an issue that already has history.
          if ((prior || params.previous) && !runPeakCache.peek(runIssueKey(companyId, issueId))) {
            fireAndForget(
              runPeakCache.refresh(runIssueKey(companyId, issueId), async () => {
                const usage = await loadContextUsage(companyId, issueId, config.selection.contextRunLogRoot);
                return usage.lastRunPeakTokens;
              }),
              "context warm",
            );
          }
          fireAndForget(Promise.resolve(ctx.metrics.write(`model_selection.run_resolve.tier_source.${resolution.tierSource}`, 1)), "metrics");
          if (resolution.switch) {
            const change = resolution.switch;
            fireAndForget(
              ctx.activity.log({
                companyId,
                message: `Model Selection ${change.reason === "first-decision" ? "decided" : "switched"} the run model ${change.from ?? "(default)"} -> ${change.to} (${resolution.tier}, ${resolution.tierSource}): ${change.reason} — ${change.detail}`,
                entityType: "issue",
                entityId: issueId,
                metadata: {
                  runId: params.runId,
                  decisionId: result.decisionId,
                  from: change.from,
                  to: change.to,
                  reason: change.reason,
                  detail: change.detail,
                  tier: resolution.tier,
                  tierSource: resolution.tierSource,
                  fallback: result.fallback === true,
                  trace: resolution.trace,
                },
              }),
              "switch activity",
            );
          }
          return finish(result, "decide");
        } catch (error) {
          const reason =
            error instanceof HotCacheTimeout
              ? `hot cache cold: ${error.message}`
              : `internal error: ${error instanceof Error ? error.message : String(error)}`;
          ctx.logger.warn("run-resolve deferred", { runId: params.runId, reason });
          return finish({ kind: "defer", retryAfterMs: deferRetryMs, reason }, "defer");
        }
      };
      runResolveHandler = resolveRunModel;

      /** Warm every known company's snapshot once a minute, so the decision path finds it fresh. */
      ctx.jobs.register(JOB_KEYS.refreshRunResolve, async () => {
        for (const company of listKnownCompanies()) {
          await runSnapshotCache.refresh(runSnapshotKey(company.id), () => loadRunResolveSnapshot(company.id));
        }
      });

      ctx.tools.register(
        TOOL_NAMES.ancillaryDrift,
        {
          displayName: "Report ancillary model pin drift",
          description:
            "Report which agents' ancillary model pins disagree with the lane-aware T3 recommendation. Read-only.",
          parametersSchema: { type: "object" },
        },
        async (_params, runCtx): Promise<ToolResult> => {
          const config = await companyConfig(runCtx.companyId);
          if (config.models.length === 0) {
            return { content: "Model Selection is not configured for this company.", data: { recommendedModelId: null, drift: [] } };
          }
          const { profiles, signals } = await readProfiles(runCtx.companyId);
          const laneLedger = await readLaneLedger(runCtx.companyId);
          const decision = recommendAncillaryModel({
            config: {
              models: config.models,
              holdOnUntrustedProfile: config.selection.holdOnUntrustedProfile,
              pacingMode: config.pacing.mode,
              laneLedger,
              slotFloorFraction: config.pacing.slotFloorFraction,
            },
            profiles,
            signals,
            now: Date.now(),
          });

          if (decision.outcome !== "selected" && decision.outcome !== "held-at-floor") {
            return {
              content: `No ancillary recommendation: ${summary(decision)}`,
              data: { recommendedModelId: null, decision, drift: [] },
            };
          }
          const recommendedModelId = decision.modelId;

          const drift: AncillarySurfaceDrift[] = [];
          let offset = 0;
          const pageSize = 200;
          for (;;) {
            const page = await ctx.agents.list({ companyId: runCtx.companyId, limit: pageSize, offset });
            for (const agent of page) {
              drift.push(
                ...ancillaryDriftForAgent(
                  {
                    id: agent.id,
                    name: agent.name,
                    adapterConfig: asRecord(agent.adapterConfig),
                  },
                  recommendedModelId,
                  config.models,
                ),
              );
            }
            if (page.length < pageSize) break;
            offset += pageSize;
          }

          await ctx.metrics.write("model_selection.ancillary_drift.count", drift.length);
          const content =
            drift.length === 0
              ? `No ancillary drift: every reported ancillary surface already matches the recommended ${recommendedModelId}.`
              : `${drift.length} ancillary surface${drift.length === 1 ? "" : "s"} drifted from the recommended ${recommendedModelId}.`;
          return { content, data: { recommendedModelId, decision, drift } };
        },
      );

      ctx.tools.register(
        TOOL_NAMES.aaDriftReport,
        {
          displayName: "aa.ai drift report",
          description:
            "Per-model aa.ai Intelligence Index: the roster's configured value and snapshot date, alongside the latest fetched live value and whether it now implies a different tier. Read-only — never writes tier/enablement.",
          parametersSchema: { type: "object" },
        },
        async (_params, runCtx): Promise<ToolResult> => {
          const config = await companyConfig(runCtx.companyId);
          const snapshot = await readAaSnapshot();
          const knownSlugs = new Set(Object.keys(snapshot.bySlug));

          const rows = config.models.map((model) => {
            const slug = resolveAaSlug(model.id, knownSlugs, model.aaSlug ?? null);
            const liveRecord = slug ? snapshot.bySlug[slug] ?? null : null;
            const liveIndex = liveRecord?.intelligenceIndex ?? null;
            const configuredImpliedTier = model.aaIndex === null ? null : tierImpliedByIndex(model.aaIndex);
            const liveImpliedTier = liveIndex === null ? null : tierImpliedByIndex(liveIndex);
            return {
              modelId: model.id,
              configuredIndex: model.aaIndex,
              configuredAsOf: model.aaIndexUpdatedAt ?? null,
              liveIndex,
              liveAsOf: snapshot.fetchedAt,
              delta: model.aaIndex !== null && liveIndex !== null ? liveIndex - model.aaIndex : null,
              crossesBoundary: liveIndex !== null && configuredImpliedTier !== liveImpliedTier,
              //  scope expansion: full-record fields, surface only —
              // never fed back into tier/enablement decisions.
              aaCostPerTask: liveRecord?.intelligenceIndexCostPerTask ?? null,
              aaPriceIn: liveRecord?.price1mInputTokens ?? null,
              aaPriceOut: liveRecord?.price1mOutputTokens ?? null,
              aaTokensPerSec: liveRecord?.medianOutputTokensPerSecond ?? null,
              aaTtftSeconds: liveRecord?.medianTimeToFirstTokenSeconds ?? null,
              aaContextWindow: liveRecord?.contextWindowTokens ?? null,
              aaTerminalbenchHard: liveRecord?.terminalbenchHard ?? null,
              aaTau2: liveRecord?.tau2 ?? null,
              aaIfbench: liveRecord?.ifbench ?? null,
              aaGpqa: liveRecord?.gpqa ?? null,
              aaHle: liveRecord?.hle ?? null,
              aaEffort: slug ? effortSuffixOf(slug) : null,
              aaSnapshotAt: liveRecord ? snapshot.fetchedAt : null,
            };
          });

          return {
            content: `${rows.length} models; snapshot ${snapshot.fetchedAt ?? "never fetched"}${
              snapshot.lastError ? ` (last attempt error: ${snapshot.lastError})` : ""
            }`,
            data: { snapshot: { fetchedAt: snapshot.fetchedAt, lastAttemptAt: snapshot.lastAttemptAt, lastError: snapshot.lastError }, rows },
          };
        },
      );

      // --- scheduled volume-profile refresh ---------------------------------
      // Without this the cost term goes stale and the engine holds at the agent
      // floor rather than order candidates on a number it cannot defend.
      ctx.jobs.register(JOB_KEYS.refreshProfiles, async () => {
        const companies = listKnownCompanies();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            if (config.models.length === 0) continue;

            const rows = (await ctx.db.query(
              `select usage_json->>'model' as model,
                      (usage_json->>'inputTokens')::numeric as input_tokens,
                      (usage_json->>'cachedInputTokens')::numeric as cached_input_tokens,
                      (usage_json->>'outputTokens')::numeric as output_tokens
                 from heartbeat_runs
                where company_id = $1
                  and started_at > now() - ($2 || ' days')::interval
                  and status = 'succeeded'
                  and (usage_json->>'costUsd')::numeric > 0`,
              [company.id, String(config.profiles.windowDays)],
            )) as unknown[];

            const runRows: RunRow[] = (Array.isArray(rows) ? rows : []).map((row) => {
              const r = asRecord(row);
              return {
                model: typeof r.model === "string" ? r.model : null,
                inputTokens: Number(r.input_tokens ?? 0),
                cachedInputTokens: Number(r.cached_input_tokens ?? 0),
                outputTokens: Number(r.output_tokens ?? 0),
              };
            });

            const computedAt = new Date().toISOString();
            const profiles = buildVolumeProfiles(runRows, config.models, computedAt);
            const existing = await readProfiles(company.id);
            await ctx.state.set(profilesKey(company.id), {
              profiles,
              // Quality signals are refreshed by their own measurement path;
              // preserve whatever is stored rather than zeroing it here, which
              // would silently drop the escalation term to zero.
              signals: existing.signals,
            });
            ctx.logger.info("volume profiles refreshed", {
              companyId: company.id,
              tiers: profiles.map((p) => `${p.tier}:${p.sampleCount}`).join(","),
            });
          } catch (cause) {
            ctx.logger.error("volume profile refresh failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
      });

      // --- scheduled lane-capacity poll ---------------------------
      // : runs every 2 minutes, inside the tightest publisher-declared
      // freshness budget (180s live). At 5 minutes, picks older than 180s read
      // every lane UNKNOWN ~half the time. One company's failure, or one
      // lane's failure within a company, must never block any other company
      // or lane.
      ctx.jobs.register(JOB_KEYS.pollLanes, async () => {
        const companies = listKnownCompanies();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            if (config.pacing.lanes.length === 0) continue;

            // : resolve each lane's optional secret before it is
            // polled. Resolution failure fails only that lane — it is
            // recorded as a lane-scoped poll error, never thrown, so one
            // bad secret ref cannot abort the company's whole poll.
            const secretFailures: Array<{ laneId: string; fetchedAt: string; verdict: null; observation: null; error: string }> = [];
            const sources: LaneSourceDefinition[] = [];
            const fetchedAt = new Date().toISOString();
            for (const [laneIndex, lane] of config.pacing.lanes.entries()) {
              let apiKey: string | null = null;
              if (lane.apiKeySecretRef) {
                try {
                  apiKey = await ctx.secrets.resolve(lane.apiKeySecretRef as never, {
                    companyId: company.id,
                    // Must match the array-index path plugin-secrets-handler.ts's
                    // extractSecretRefBindingsFromConfig binds on config write
                    // — a laneId-keyed path here reads back nothing
                    // because syncSecretRefsForTarget replaceAll wipes non-matching rows.
                    configPath: `pacing.lanes.${laneIndex}.apiKeySecretRef`,
                  });
                } catch {
                  secretFailures.push({ laneId: lane.laneId, fetchedAt, verdict: null, observation: null, error: "lane-secret-unavailable" });
                  continue;
                }
              }
              sources.push({
                laneId: lane.laneId,
                statusUrl: lane.statusUrl,
                requestTimeoutMs: lane.requestTimeoutMs,
                maxResponseBytes: lane.maxResponseBytes,
                lane: lane.lane,
                policy: lane.policy,
                apiKey,
                authFilesProvider: lane.authFilesProvider,
                planWeights: lane.planWeights,
              });
            }

            const results = await pollLanes({
              sources,
              http: laneHttp,
              now: () => new Date().toISOString(),
            });

            let ledger = await readLaneLedger(company.id);
            for (const result of [...results, ...secretFailures]) {
              ledger = mergeLedgerEntry(ledger, result);
            }
            await ctx.state.set(laneLedgerKey(company.id), ledger);

            // . Per-tier poll-outcome counters: read-only telemetry,
            // never consulted by selection. Each lane result increments the
            // tiers that lane serves (roster `laneId` map). Fail-closed on a
            // corrupt stored value (normalize fails open to empty counters)
            // and on a write failure (the ledger above already landed; a lost
            // counter increment must not fail the poll).
            try {
              const stored = await ctx.state.get({
                scopeKind: "company" as const,
                scopeId: company.id,
                stateKey: PLUGIN_STATE_KEYS.tierPollOutcomes,
              });
              const outcomes = accumulateTierPollOutcomes(
                normalizeTierPollOutcomes(stored),
                [...results, ...secretFailures].map((result) => ({
                  laneId: result.laneId,
                  error: result.error,
                  serviceable: result.verdict?.serviceable ?? null,
                })),
                config.models,
                fetchedAt,
              );
              await ctx.state.set(
                {
                  scopeKind: "company" as const,
                  scopeId: company.id,
                  stateKey: PLUGIN_STATE_KEYS.tierPollOutcomes,
                },
                outcomes satisfies TierPollOutcomes,
              );
            } catch (cause) {
              ctx.logger.warn("tier poll outcome counters not updated", {
                companyId: company.id,
                error: cause instanceof Error ? cause.message : String(cause),
              });
            }

            //  AC-2: the availability term's writer. Published from the
            // same poll the ledger comes from, so the selector and the pacer can
            // never disagree about what was observed. Written on EVERY poll,
            // including one where nothing produced records — leaving the prior
            // document in place would let a dead poller keep publishing a
            // freshness it no longer has, and an empty document is read as
            // unreadable, which `select.ts` says rather than passes.
            const availabilityDocument = availabilityDocumentFrom({
              results,
              observedAt: fetchedAt,
            });
            await ctx.state.set(laneAvailabilityKey(company.id), availabilityDocument);

            ctx.logger.info("lane capacity polled", {
              companyId: company.id,
              lanes: [...results, ...secretFailures].map((r) => `${r.laneId}:${r.verdict?.state ?? "error"}`).join(","),
              availabilityRecords: availabilityDocument.records.length,
            });
          } catch (cause) {
            ctx.logger.error("lane capacity poll failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
      });

      // --- scheduled aa.ai Intelligence Index refresh -------------
      // Fetched once at instance scope (aa.ai data is not company-specific),
      // then diffed per company against that company's roster. A fetch/parse
      // failure preserves the prior snapshot untouched and just records the
      // attempt — stale-but-labelled beats a hard failure (AC4). This job
      // never writes `models[].tier`/`.enabled`/overrides: a boundary-crossing
      // delta is surfaced via `ctx.activity.log()` as a prompt to re-evaluate,
      // never applied.
      //
      // Extracted to a plain function (not just the job callback) so the
      // `refreshAaIndexNow` tool below can run the identical sweep on demand
      // ( reopen AC4) without duplicating the fetch/diff/surface
      // logic or waiting for the next cron tick.
      const runAaIndexRefresh = async (): Promise<{ fetchedAt: string | null; error: string | null; modelsFetched: number }> => {
        const nowIso = new Date().toISOString();
        const previous = await readAaSnapshot();

        const fetched = await fetchAaSnapshot({
          url: AA_LEADERBOARD_URL,
          http: aaHttp,
          timeoutMs: AA_FETCH_TIMEOUT_MS,
          maxResponseBytes: AA_MAX_RESPONSE_BYTES,
        });

        let snapshot = previous;
        if (!fetched.ok || !fetched.html) {
          snapshot = { ...previous, lastAttemptAt: nowIso, lastError: fetched.error ?? "aa-fetch-failed" };
          await ctx.state.set(aaSnapshotKey(), snapshot);
          ctx.logger.error("aa.ai snapshot fetch failed; keeping prior snapshot", {
            error: fetched.error,
            previousFetchedAt: previous.fetchedAt,
          });
        } else {
          const parsed = parseAaLeaderboardHtml(fetched.html);
          if (!parsed) {
            snapshot = { ...previous, lastAttemptAt: nowIso, lastError: "aa-parse-failed" };
            await ctx.state.set(aaSnapshotKey(), snapshot);
            ctx.logger.error("aa.ai snapshot parse failed; keeping prior snapshot", {
              previousFetchedAt: previous.fetchedAt,
            });
          } else {
            const bySlug: Record<string, AaModelRecord> = {};
            for (const row of parsed) bySlug[row.slug] = row;
            snapshot = { fetchedAt: nowIso, bySlug, lastAttemptAt: nowIso, lastError: null };
            await ctx.state.set(aaSnapshotKey(), snapshot);
            await appendAaSnapshotHistory({ fetchedAt: nowIso, bySlug });
            ctx.logger.info("aa.ai snapshot refreshed", { fetchedAt: nowIso, models: parsed.length });
          }
        }

        const freshBySlug = new Map(Object.entries(snapshot.bySlug));
        if (freshBySlug.size === 0) {
          return { fetchedAt: snapshot.fetchedAt, error: snapshot.lastError, modelsFetched: 0 };
        }
        const previousBySlug = new Map(Object.entries(previous.bySlug));

        const companies = listKnownCompanies();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            if (!config.aaSync.enabled || config.models.length === 0) continue;

            const knownSlugs = new Set(freshBySlug.keys());
            const diffInputs: AaDiffModelInput[] = config.models.map((model) => ({
              modelId: model.id,
              previousIndex: model.aaIndex,
              slug: resolveAaSlug(model.id, knownSlugs, model.aaSlug ?? null),
            }));

            const rows = diffSnapshot(diffInputs, freshBySlug, previousBySlug);
            for (const row of rows) {
              if (row.fieldDeltas.length > 0) {
                ctx.logger.info("aa.ai fields changed", {
                  companyId: company.id,
                  modelId: row.modelId,
                  fieldDeltas: row.fieldDeltas,
                });
              }
              if (row.delta !== null && row.delta !== 0) {
                ctx.logger.info("aa.ai index changed", {
                  companyId: company.id,
                  modelId: row.modelId,
                  previousIndex: row.previousIndex,
                  freshIndex: row.freshIndex,
                  delta: row.delta,
                });
              }
            }

            const crossing = rows.filter((row) => row.crossesBoundary);
            if (crossing.length === 0) continue;

            const surfaced = await readAaDriftSurfaced(company.id);
            let surfacedChanged = false;
            for (const row of crossing) {
              const dedupeKey = `${row.modelId}::${row.freshImpliedTier ?? "none"}`;
              if (surfaced.has(dedupeKey)) continue;
              await ctx.activity.log({
                companyId: company.id,
                message: `aa.ai drift crosses a tier boundary for ${row.modelId} — re-evaluate, do not auto-apply`,
                entityType: "model",
                entityId: row.modelId,
                metadata: {
                  modelId: row.modelId,
                  previousIndex: row.previousIndex,
                  freshIndex: row.freshIndex,
                  previousImpliedTier: row.previousImpliedTier,
                  freshImpliedTier: row.freshImpliedTier,
                },
              });
              surfaced.add(dedupeKey);
              surfacedChanged = true;
            }
            if (surfacedChanged) {
              await ctx.state.set(aaDriftSurfacedKey(company.id), { keys: [...surfaced] });
            }
          } catch (cause) {
            ctx.logger.error("aa.ai drift surfacing failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }

        return { fetchedAt: snapshot.fetchedAt, error: snapshot.lastError, modelsFetched: freshBySlug.size };
      };

      ctx.jobs.register(JOB_KEYS.refreshAaIndex, async () => {
        await runAaIndexRefresh();
      });

      // Manual operator escalation for the same sweep ( reopen AC4):
      // aa.ai revises rankings between scheduled ticks, and an operator who
      // just saw a revision shouldn't have to wait up to 6 hours to fold it
      // in. Runs the exact same fetch/diff/surface path as the cron job.
      ctx.tools.register(
        TOOL_NAMES.refreshAaIndexNow,
        {
          displayName: "Refresh aa.ai Intelligence Index now",
          description:
            "Manually run the aa.ai leaderboard fetch + drift-surfacing sweep instead of waiting for the next scheduled tick. Same logic as the cron job: never writes tier/enabled, only updates the snapshot and logs drift.",
          parametersSchema: { type: "object" },
        },
        async (): Promise<ToolResult> => {
          const result = await runAaIndexRefresh();
          if (result.error) {
            return { content: `aa.ai refresh attempted but failed: ${result.error}`, data: result };
          }
          return {
            content: `aa.ai snapshot refreshed: ${result.modelsFetched} models, fetched at ${result.fetchedAt}`,
            data: result,
          };
        },
      );

      // --- scheduled models.dev price reconciliation ------------
      //
      // ADR-0001's cost term is a sorter, and it reads `costPerMTokIn` /
      // `costPerMTokOut` / `costPerMTokCacheRead` straight off hand-entered
      // roster rows. A 2026-09-22 audit against models.dev found 26 of 117
      // rows wrong, including rows the selector was actively choosing, and
      // all five `muse-spark-*` rows priced 0/0/0 — which does not make the
      // cost term slightly wrong for those models, it makes it meaningless.
      // Drift in a sorter's input is silent: nothing errors, the fleet just
      // routes to the wrong model.
      //
      // This job closes the detection gap and nothing else. It REPORTS. A
      // price change reorders the entire fleet's routing, so the output is a
      // diff an operator approves — deliberately the same posture as the
      // thirteen pricing-confirmation rows shipped disabled rather than let an
      // estimated price silently win cost-sort over a proven model.
      //
      // Structured like `runAaIndexRefresh` above and for the same reasons:
      // fetched once at instance scope (models.dev is not company-specific),
      // diffed per company against that company's own roster, fail-neutral on
      // a bad fetch, and extracted to a plain function so the manual tool runs
      // the identical path.
      const priceReconcileReportKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.priceReconcileReport,
      });

      const priceDriftSurfacedKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.priceDriftSurfaced,
      });

      const readPriceDriftSurfaced = async (companyId: string): Promise<Set<string>> => {
        const stored = asRecord(await ctx.state.get(priceDriftSurfacedKey(companyId)));
        return new Set(Array.isArray(stored.keys) ? (stored.keys as string[]) : []);
      };

      const priceHttp: PriceHttpClient = {
        fetch: (url, init) => ctx.http.fetch(url, init),
      };

      interface PriceReconcileOutcome {
        ranAt: string;
        error: string | null;
        /** Per company: how many rows drifted. Empty when the fetch failed. */
        companies: Array<{ companyId: string; drifted: number; checked: number }>;
      }

      const runPriceReconcile = async (): Promise<PriceReconcileOutcome> => {
        const ranAt = new Date().toISOString();

        const fetched = await fetchPriceCatalog({
          url: MODELS_DEV_CATALOG_URL,
          userAgent: MODELS_DEV_USER_AGENT,
          http: priceHttp,
          timeoutMs: MODELS_DEV_FETCH_TIMEOUT_MS,
          maxResponseBytes: MODELS_DEV_MAX_RESPONSE_BYTES,
        });

        // Fail-neutral, same rule as the aa.ai sweep: a failed fetch leaves
        // the last good report in place and records the attempt. The stored
        // report is dated, so a stale one is legible as stale; an empty one
        // would read as "nothing is mispriced", which is a lie.
        if (!fetched.ok || !fetched.json) {
          const error = fetched.error ?? "price-fetch-failed";
          ctx.logger.error("models.dev fetch failed; keeping the prior price report", { error });
          return { ranAt, error, companies: [] };
        }

        const catalog = parsePriceCatalog(fetched.json);
        if (!catalog) {
          ctx.logger.error("models.dev parse failed; keeping the prior price report", { bytes: fetched.json.length });
          return { ranAt, error: "price-parse-failed", companies: [] };
        }

        const outcome: PriceReconcileOutcome = { ranAt, error: null, companies: [] };
        for (const company of listKnownCompanies()) {
          try {
            const config = await companyConfig(company.id);
            if (!config.priceSync.enabled || config.models.length === 0) continue;

            const rows: PriceRosterRow[] = config.models.map((model) => ({
              id: model.id,
              laneId: model.laneId ?? null,
              enabled: model.enabled,
              costPerMTokIn: model.costPerMTokIn,
              costPerMTokOut: model.costPerMTokOut,
              costPerMTokCacheRead: model.costPerMTokCacheRead,
              note: model.note,
            }));

            const report = reconcilePrices({ rows, catalog, fetchedAt: ranAt });
            await ctx.state.set(priceReconcileReportKey(company.id), { ranAt, report });
            outcome.companies.push({ companyId: company.id, drifted: report.drift.length, checked: report.checked });

            ctx.logger.info("models.dev price reconciliation complete", {
              companyId: company.id,
              checked: report.checked,
              unchanged: report.unchanged,
              drifted: report.drift.length,
              excluded: report.excluded.length,
              unresolved: report.unresolved.length,
            });

            // Dedupe on the FEED price, not just the model id: a row that
            // stays mispriced because nobody has applied the correction yet
            // must not re-alarm daily, but a SECOND, different price change
            // on the same row is new news and has to surface again.
            const surfaced = await readPriceDriftSurfaced(company.id);
            let surfacedChanged = false;
            for (const row of report.drift) {
              const dedupeKey = `${row.modelId}::${row.fields.map((f) => `${f.field}=${f.feed}`).join(",")}`;
              if (surfaced.has(dedupeKey)) continue;
              await ctx.activity.log({
                companyId: company.id,
                message:
                  `models.dev list price disagrees with the roster for ${row.modelId} (${row.severity}) — ` +
                  `review and apply by hand, this job never writes a price`,
                entityType: "model",
                entityId: row.modelId,
                metadata: {
                  modelId: row.modelId,
                  providerId: row.providerId,
                  enabled: row.enabled,
                  severity: row.severity,
                  maxRatio: row.maxRatio,
                  fields: row.fields,
                  suggestedNote: row.suggestedNote,
                  source: MODELS_DEV_CATALOG_URL,
                  fetchedAt: ranAt,
                  // Stated on every record, because the number itself does not
                  // carry the caveat and somebody will eventually quote it.
                  priceBasis: "vendor list price; not this company's marginal cost under a flat subscription",
                },
              });
              surfaced.add(dedupeKey);
              surfacedChanged = true;
            }
            if (surfacedChanged) {
              await ctx.state.set(priceDriftSurfacedKey(company.id), { keys: [...surfaced] });
            }
          } catch (cause) {
            ctx.logger.error("price reconciliation failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }

        return outcome;
      };

      ctx.jobs.register(JOB_KEYS.reconcilePrices, async () => {
        await runPriceReconcile();
      });

      // --- scheduled free-list sync ( P2) ---------------------------
      //
      // Default-off at every layer: the job returns before any network when
      // no company enables `aaFreeSync`, and per-company diffs are computed
      // only for companies that enabled it. The artifact is the per-company
      // diff (`aaFreeSyncReport` reads it back) — this job writes no binding
      // anywhere: no pins, no tiers, no enabled flags, no adapter models.
      //
      // Fetched once at instance scope (the free list is not
      // company-specific), diffed per company against that company's roster.
      // Quota (D1): at most one scheduled fetch/day; 429 honors Retry-After;
      // 401/403 stops the source for the day with no credential substitution.
      // A failed fetch keeps the last-good snapshot in place and records the
      // attempt; diffs still recompute from whatever snapshot is stored, so a
      // curation change reflects without waiting for the next fetch.
      interface AaFreeSyncOutcome {
        ranAt: string;
        fetched: boolean;
        error: string | null;
        digest: string | null;
        /** Per company: the reviewable diff tallies. Empty when nothing ran. */
        companies: Array<{
          companyId: string;
          verified: number;
          broken: number;
          ambiguous: number;
          unbound: number;
        }>;
      }

      const runAaFreeSync = async (): Promise<AaFreeSyncOutcome> => {
        const ranAt = new Date().toISOString();
        const nowMs = Date.now();
        const empty: AaFreeSyncOutcome = { ranAt, fetched: false, error: null, digest: null, companies: [] };

        const enabled: Array<{ id: string; config: ResolvedConfig }> = [];
        for (const company of listKnownCompanies()) {
          try {
            const config = await companyConfig(company.id);
            if (config.aaFreeSync.enabled) enabled.push({ id: company.id, config });
          } catch (cause) {
            ctx.logger.error("free-list sync config read failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
        if (enabled.length === 0) return empty;

        const previous = await readAaFreeSyncSnapshot();
        let snapshot = previous.snapshot;
        let digest = previous.digest;
        let fetchedAt = previous.fetchedAt;
        let fetchError: string | null = null;
        let fetched = false;

        if (shouldFetchFreeSync({ nextEligibleAt: previous.nextEligibleAt }, nowMs)) {
          // One credential for the instance-scoped fetch: the first enabled
          // company that configured one. A denial stops the source — the job
          // never tries a second company's credential for the same fetch.
          const provider = enabled.find((entry) => entry.config.aaFreeSync.apiKeySecretRef);
          if (!provider || !provider.config.aaFreeSync.apiKeySecretRef) {
            fetchError = "aa-free-no-credential";
            ctx.logger.error("free-list sync skipped: no enabled company configured aaFreeSync.apiKeySecretRef", {});
          } else {
            let apiKey: string | null = null;
            try {
              apiKey = await ctx.secrets.resolve(provider.config.aaFreeSync.apiKeySecretRef as never, {
                companyId: provider.id,
                configPath: "aaFreeSync.apiKeySecretRef",
              });
            } catch {
              fetchError = "aa-free-secret-unavailable";
              ctx.logger.error("free-list sync secret unavailable; keeping prior snapshot", {
                companyId: provider.id,
              });
            }
            if (!fetchError) {
              const result = await fetchAaFreeList({
                http: { fetch: (url, init) => ctx.http.fetch(url, init) },
                apiKey: apiKey ?? "",
                timeoutMs: AA_FREE_FETCH_TIMEOUT_MS,
                maxResponseBytes: AA_FREE_MAX_RESPONSE_BYTES,
              });
              const attemptAt = new Date().toISOString();
              if (!result.ok) {
                const outcome: FreeFetchOutcome =
                  result.error === "aa-access-denied"
                    ? "fatal"
                    : result.error === "aa-rate-limited"
                      ? "rate-limited"
                      : result.retryable
                        ? "retryable"
                        : "fatal";
                fetchError = result.error;
                await ctx.state.set(aaFreeSyncSnapshotKey(), {
                  fetchedAt: previous.fetchedAt,
                  digest: previous.digest,
                  snapshot: previous.snapshot,
                  lastAttemptAt: attemptAt,
                  lastError: result.error,
                  nextEligibleAt: nextEligibleAfter(outcome, nowMs,
                    result.error === "aa-rate-limited" ? result.retryAfterSeconds : null,
                    { successMs: AA_FREE_FETCH_INTERVAL_MS, retryMs: AA_FREE_RETRY_INTERVAL_MS }),
                });
                ctx.logger.error("free-list sync fetch failed; keeping prior snapshot", { error: result.error });
              } else {
                const parsed = parseAaFreeList(result.text, attemptAt);
                if (!parsed) {
                  fetchError = "aa-free-parse-failed";
                  await ctx.state.set(aaFreeSyncSnapshotKey(), {
                    fetchedAt: previous.fetchedAt,
                    digest: previous.digest,
                    snapshot: previous.snapshot,
                    lastAttemptAt: attemptAt,
                    lastError: fetchError,
                    nextEligibleAt: nextEligibleAfter("retryable", nowMs, null,
                      { successMs: AA_FREE_FETCH_INTERVAL_MS, retryMs: AA_FREE_RETRY_INTERVAL_MS }),
                  });
                  ctx.logger.error("free-list sync parse failed; keeping prior snapshot", {});
                } else {
                  fetched = true;
                  snapshot = parsed;
                  digest = freeSnapshotDigest(parsed);
                  fetchedAt = attemptAt;
                  await ctx.state.set(aaFreeSyncSnapshotKey(), {
                    fetchedAt,
                    digest,
                    snapshot: parsed,
                    lastAttemptAt: attemptAt,
                    lastError: null,
                    nextEligibleAt: nextEligibleAfter("ok", nowMs, null,
                      { successMs: AA_FREE_FETCH_INTERVAL_MS, retryMs: AA_FREE_RETRY_INTERVAL_MS }),
                  });
                  ctx.logger.info("free-list sync snapshot refreshed", {
                    fetchedAt,
                    digest,
                    rows: parsed.rows.length,
                  });
                }
              }
            }
          }
        }

        const outcome: AaFreeSyncOutcome = { ranAt, fetched, error: fetchError, digest, companies: [] };
        for (const { id, config } of enabled) {
          try {
            if (!snapshot || !digest || !fetchedAt) {
              await ctx.state.set(aaFreeSyncDiffKey(id), {
                ranAt,
                digest: null,
                error: fetchError ?? "aa-free-no-snapshot-yet",
                diff: null,
              });
              continue;
            }
            const bindings = config.aaFreeSync.bindings.map((b) => ({
              candidateId: b.candidateId,
              modelId: b.modelId,
              laneId: b.laneId,
              evaluatedEffort: b.evaluatedEffort as AaBinding["evaluatedEffort"],
              aaSlug: b.aaSlug,
              ...(b.observationalOnly !== undefined ? { observationalOnly: b.observationalOnly } : {}),
            }));
            const models = config.models.map((model) => ({
              id: model.id,
              laneId: model.laneId ?? null,
              fallbackOnly: model.fallbackOnly,
              enabled: model.enabled,
            }));
            const diff = buildSyncDiff({ bindings, models, snapshot, digest });
            await ctx.state.set(aaFreeSyncDiffKey(id), { ranAt, digest, error: fetchError, diff });
            outcome.companies.push({
              companyId: id,
              verified: diff.verified.length,
              broken: diff.broken.length,
              ambiguous: diff.ambiguous.length,
              unbound: diff.unbound.length,
            });
            ctx.logger.info("free-list sync diff complete", {
              companyId: id,
              verified: diff.verified.length,
              broken: diff.broken.length,
              ambiguous: diff.ambiguous.length,
              unbound: diff.unbound.length,
            });
          } catch (cause) {
            ctx.logger.error("free-list sync diff failed for a company", {
              companyId: id,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }

        return outcome;
      };

      ctx.jobs.register(JOB_KEYS.refreshAaFreeSync, async () => {
        await runAaFreeSync();
      });

      ctx.tools.register(
        TOOL_NAMES.aaFreeSyncReport,
        {
          displayName: "aa.ai free-list sync report",
          description:
            "The last free-list sync diff: which curated model x effort bindings verify against the snapshot, which break and why, which slugs are ambiguous, and which roster rows have no binding. Read-only; writes nothing.",
          parametersSchema: { type: "object" },
        },
        async (_args, toolCtx): Promise<ToolResult> => {
          const companyId = toolCtx?.companyId;
          if (!companyId) {
            return { content: "No company scope on this call; cannot read a per-company sync report.", data: toolRejection("missing-company-scope") };
          }
          const stored = asRecord(await ctx.state.get(aaFreeSyncDiffKey(companyId)));
          const diff = asRecord(stored.diff) as unknown as AaFreeSyncDiff | null;
          if (!stored.diff || !diff || !Array.isArray(diff.verified)) {
            return {
              content:
                "No free-list sync diff has completed for this company yet. Run " +
                `${TOOL_NAMES.refreshAaFreeSyncNow} or wait for the daily job.`,
              data: toolRejection("no-report-yet"),
            };
          }
          const lines: string[] = [];
          for (const v of diff.verified) {
            lines.push(
              `- verified ${v.binding.candidateId} (${v.binding.modelId} x ${v.binding.laneId} x ${v.binding.evaluatedEffort}): index ${v.aaIndex ?? "unknown"}${v.held ? ` [held: ${v.held}]` : ""}`,
            );
          }
          for (const b of diff.broken) {
            lines.push(`- BROKEN ${b.binding.candidateId} (${b.binding.modelId} x ${b.binding.laneId} x ${b.binding.evaluatedEffort}): ${b.reason} — ${b.detail}`);
          }
          for (const a of diff.ambiguous) {
            lines.push(`- AMBIGUOUS slug ${a.aaSlug}: claimed by ${a.candidateIds.join(", ")}`);
          }
          for (const u of diff.unbound) {
            lines.push(
              `- unbound ${u.modelId} (${u.laneId})${u.suggestedSlug ? `: exact slug ${u.suggestedSlug} is a curation proposal` : ""}${u.familySlugs.length > 0 ? ` [family: ${u.familySlugs.join(", ")}]` : ""}`,
            );
          }
          return {
            content:
              `free-list sync as of ${stored.ranAt ?? "unknown"} (snapshot ${String(stored.digest ?? "none")}): ` +
              `${diff.verified.length} verified, ${diff.broken.length} broken, ${diff.ambiguous.length} ambiguous, ` +
              `${diff.unbound.length} unbound, ${diff.unmatchedSlugs.length} unmatched snapshot slugs` +
              `${diff.unmatchedTruncated > 0 ? ` (+${diff.unmatchedTruncated} truncated)` : ""}` +
              `${stored.error ? ` [fetch: ${String(stored.error)}]` : ""}.\n` +
              `${lines.join("\n") || "No rows."}\n` +
              "A reviewable diff only — curate bindings by hand, this job never writes one.",
            data: { ranAt: stored.ranAt ?? null, digest: stored.digest ?? null, error: stored.error ?? null, diff },
          };
        },
      );

      ctx.tools.register(
        TOOL_NAMES.refreshAaFreeSyncNow,
        {
          displayName: "Refresh aa.ai free-list sync now",
          description:
            "Run the free-list fetch + per-company diff immediately instead of waiting for the daily tick. Same logic as the cron job, and just as report-only: it never writes a binding, pin, tier, or price.",
          parametersSchema: { type: "object" },
        },
        async (): Promise<ToolResult> => {
          const result = await runAaFreeSync();
          if (result.error) {
            return { content: `free-list sync attempted but failed: ${result.error}`, data: result };
          }
          const verified = result.companies.reduce((sum, c) => sum + c.verified, 0);
          const broken = result.companies.reduce((sum, c) => sum + c.broken, 0);
          return {
            content:
              result.companies.length === 0
                ? "free-list sync ran: no company has aaFreeSync enabled, so nothing was fetched. Reported only — nothing was written."
                : `free-list sync complete: ${verified} verified, ${broken} broken across ${result.companies.length} companies. Reported only — no binding was written.`,
            data: result,
          };
        },
      );

      ctx.tools.register(
        TOOL_NAMES.reconcilePricesNow,
        {
          displayName: "Reconcile roster prices against models.dev now",
          description:
            "Run the models.dev fetch + price reconciliation immediately instead of waiting for the daily tick. Same logic as the cron job, and just as report-only: it never writes a roster price.",
          parametersSchema: { type: "object" },
        },
        async (): Promise<ToolResult> => {
          const result = await runPriceReconcile();
          if (result.error) {
            return { content: `models.dev reconciliation failed: ${result.error}`, data: result };
          }
          const drifted = result.companies.reduce((sum, c) => sum + c.drifted, 0);
          const checked = result.companies.reduce((sum, c) => sum + c.checked, 0);
          return {
            content: `models.dev reconciliation complete: ${drifted} of ${checked} priced rows drifted. Reported only — no price was written.`,
            data: result,
          };
        },
      );

      // . Per-tier lane-poll outcome counters, queryable from agent
      // runs. Read-only: reads the counters the `pollLaneCapacity` job
      // maintains, never touches selection, the ledger, or the roster. No
      // "no report yet" failure — a company whose lanes have never polled
      // gets honest zeroes, not an error.
      ctx.tools.register(
        TOOL_NAMES.admissionShadowReport,
        {
          displayName: "Account admission shadow report",
          description: "Read the last explicitly enabled account shadow snapshot; never selects, reserves or actuates.",
          parametersSchema: { type: "object", additionalProperties: false },
        },
        async (_args, toolCtx): Promise<ToolResult> => {
          if (!toolCtx?.companyId) return { content: "Company scope required.", data: toolRejection("missing-company-scope") };
          const stored = asRecord(await ctx.state.get({
            scopeKind: "company", scopeId: toolCtx.companyId, stateKey: PLUGIN_STATE_KEYS.admissionShadowReport,
          }));
          return {
            content: stored.report ? "Last caller-supplied account shadow snapshot; no host starts or reservations governed. Check evaluatedAt and observation freshness; this is not a live admission decision."
              : "No explicitly enabled account shadow snapshot has been recorded.",
            data: stored.report ? stored : toolRejection("no-report-yet"),
          };
        },
      );

      ctx.tools.register(
        TOOL_NAMES.tierOutcomes,
        {
          displayName: "Tier poll outcomes",
          description:
            "Per-tier lane-poll success/fail counters: how many polls each tier's lanes served or missed. Read-only; writes nothing and never changes selection.",
          parametersSchema: { type: "object" },
        },
        async (_args, toolCtx): Promise<ToolResult> => {
          const companyId = toolCtx?.companyId;
          if (!companyId) {
            return { content: "No company scope on this call; cannot read per-tier poll outcomes.", data: toolRejection("missing-company-scope") };
          }
          const stored = await ctx.state.get({
            scopeKind: "company" as const,
            scopeId: companyId,
            stateKey: PLUGIN_STATE_KEYS.tierPollOutcomes,
          });
          const outcomes = normalizeTierPollOutcomes(stored);
          const lines = (Object.keys(outcomes.tiers) as Array<keyof typeof outcomes.tiers>).map((tier) => {
            const counter = outcomes.tiers[tier];
            return `- ${tier}: ${counter.polls} polls, ${counter.succeeded} served, ${counter.failed} missed${counter.lastAt ? ` (last ${counter.lastAt})` : ""}`;
          });
          return {
            content:
              `Tier poll outcomes${outcomes.updatedAt ? ` as of ${outcomes.updatedAt}` : " (no lane poll recorded yet)"}.\n` +
              `${lines.join("\n")}\n` +
              "Per-tier lane-poll outcomes — how often each tier's lanes served. Read-only; not a routing input.",
            data: { updatedAt: outcomes.updatedAt, tiers: outcomes.tiers },
          };
        },
      );

      // . First-party accepted-work posterior report. Read-only: reads
      // the overlay the `refreshScores` job maintains, never touches selection,
      // the ledger, or the roster. A company that never enabled the producer
      // gets an honest "no overlay yet", not an error — same discipline as the
      // tier-outcomes precedent above. Corrupt or superseded stored state
      // normalizes to the same answer rather than throwing.
      ctx.tools.register(
        TOOL_NAMES.acceptedWorkReport,
        {
          displayName: "Accepted-work posterior report",
          description:
            "Per-cohort accepted-work posteriors: which served model x effort x task-class cohorts have mature accept/rework evidence, and what each cohort's posterior is. Read-only; writes nothing and never changes selection.",
          parametersSchema: { type: "object" },
        },
        async (_args, toolCtx): Promise<ToolResult> => {
          const companyId = toolCtx?.companyId;
          if (!companyId) {
            return { content: "No company scope on this call; cannot read the accepted-work overlay.", data: toolRejection("missing-company-scope") };
          }
          const stored = await ctx.state.get({
            scopeKind: "company" as const,
            scopeId: companyId,
            stateKey: PLUGIN_STATE_KEYS.acceptedWorkOverlay,
          });
          const overlay = normalizeAcceptedWorkOverlay(stored);
          if (!overlay) {
            return {
              content:
                "No accepted-work overlay has been produced for this company yet. Enable `acceptedWork` and wait for the scheduled score refresh. Read-only; nothing was written.",
              data: toolRejection("no-report-yet"),
            };
          }
          const lines = overlay.cohorts.map((cohort) => {
            const held = cohort.held ? ` [held: ${cohort.held}]` : "";
            const maturity = cohort.proven ? "proven" : `sparse (${cohort.resolved}/8)`;
            return `- ${cohort.servedModel} x ${cohort.servedEffort} x ${cohort.taskClass}: ` +
              `p=${cohort.p.toFixed(3)} (prior ${cohort.priorP.toFixed(3)}), ` +
              `${cohort.accepted}/${cohort.resolved} accepted, ${cohort.pending} pending, ${maturity}${held}`;
          });
          return {
            content:
              `Accepted-work posterior as of ${overlay.computedAt} (${overlay.specVersion}): ` +
              `${overlay.cohorts.length} cohorts, ` +
              `${overlay.unattributed.closedCardsWithoutClosingRun} closed cards unattributed.\n` +
              `${lines.join("\n") || "No cohorts."}\n` +
              "First-party accepted-work posteriors — independent review/rework outcomes per served cohort. Read-only; not a routing input.",
            data: {
              specVersion: overlay.specVersion,
              computedAt: overlay.computedAt,
              cohorts: overlay.cohorts,
              unattributed: overlay.unattributed,
            },
          };
        },
      );

      ctx.tools.register(
        TOOL_NAMES.priceDriftReport,
        {
          displayName: "models.dev price drift report",
          description:
            "The latest roster-vs-models.dev price reconciliation: which rows are mispriced, by how much, and the exact note clause to record if the correction is approved. Read-only; writes nothing.",
          parametersSchema: { type: "object" },
        },
        async (_args, toolCtx): Promise<ToolResult> => {
          const companyId = toolCtx?.companyId;
          if (!companyId) {
            return { content: "No company scope on this call; cannot read a per-company price report.", data: toolRejection("missing-company-scope") };
          }
          const stored = asRecord(await ctx.state.get(priceReconcileReportKey(companyId)));
          const report = stored.report as PriceReconcileReport | undefined;
          if (!report) {
            return {
              content:
                "No models.dev price reconciliation has completed for this company yet. Run " +
                `${TOOL_NAMES.reconcilePricesNow} or wait for the daily job.`,
              data: toolRejection("no-report-yet"),
            };
          }
          const lines = report.drift.map((row) => {
            const fields = row.fields
              .map((f) => `${f.field}: ${f.roster} -> ${f.feed}${f.ratio === null ? "" : ` (x${f.ratio.toFixed(2)})`}`)
              .join("; ");
            return `- ${row.modelId} [${row.severity}${row.enabled ? ", enabled" : ", disabled"}] ${fields}`;
          });
          return {
            content:
              `models.dev reconciliation as of ${report.fetchedAt}: ${report.drift.length} of ${report.checked} priced rows drift ` +
              `(${report.unchanged} correct, ${report.excluded.length} out of scope by policy, ${report.unresolved.length} unresolved).\n` +
              `${lines.join("\n") || "No drift."}\n` +
              "List prices from models.dev — correct for the selector's relative cost ordering, NOT what this company pays on a flat subscription.",
            data: { ranAt: stored.ranAt ?? null, report },
          };
        },
      );

      // --- scheduled score + card-ledger refresh ( §2.2 / ) -
      // Ported from `model_scores.py`, with one structural change: the Python
      // original attributes tier via a live SQL join against
      // `issue_labels`/`labels` (lines 56-63), which this plugin cannot do —
      // those tables are absent from `coreReadTables`. Tier is instead read
      // per distinct issue id via `ctx.issues.get()`, which the host already
      // enriches with `.labels` (same mechanism `describeIssue()` uses above).
      ctx.jobs.register(JOB_KEYS.refreshScores, async () => {
        const companies = listKnownCompanies();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            if (config.models.length === 0) continue;

            const scoreRunRows = (await ctx.db.query(
              REFRESH_SCORE_RUNS_SQL,
              [company.id, String(SCORE_WINDOW_DAYS)],
            )) as unknown[];

            const closingRunRows = (await ctx.db.query(
              REFRESH_SCORE_CLOSING_RUNS_SQL,
              [company.id, String(CARD_LEDGER_WINDOW_DAYS)],
            )) as unknown[];

            const issueIds = new Set<string>();
            for (const row of scoreRunRows) {
              const r = asRecord(row);
              if (typeof r.issue_id === "string" && r.issue_id) issueIds.add(r.issue_id);
            }
            for (const row of closingRunRows) {
              const r = asRecord(row);
              if (typeof r.issue_id === "string" && r.issue_id) issueIds.add(r.issue_id);
            }

            const tierByIssue = new Map<string, Tier | null>();
            // : post-hoc cohort coordinates for the accepted-work
            // overlay. Read in the same per-issue pass as the tier label, so
            // the producer adds no extra `issues.get` calls: label names for
            // the `class:` task-class cell, and the pin's `adapterConfig` for
            // the served-effort cell (effort keys are written alongside the
            // model by `modelOverrideForContext`). An unreadable issue leaves
            // both null — unattributable, never guessed.
            const labelsByIssue = new Map<string, readonly string[]>();
            const pinConfigByIssue = new Map<string, Record<string, unknown> | null>();
            for (const issueId of issueIds) {
              try {
                const issue = await ctx.issues.get(issueId, company.id);
                const labelNames = (issue?.labels ?? [])
                  .map((label) => label.name)
                  .filter((name): name is string => typeof name === "string");
                const tierLabel = labelNames.find((name) => name.startsWith(TIER_LABEL_PREFIX));
                const tierValue = tierLabel ? tierLabel.slice(TIER_LABEL_PREFIX.length) : null;
                tierByIssue.set(
                  issueId,
                  tierValue && (TIERS as readonly string[]).includes(tierValue) ? (tierValue as Tier) : null,
                );
                labelsByIssue.set(issueId, labelNames);
                pinConfigByIssue.set(
                  issueId,
                  asRecord(asRecord(issue?.assigneeAdapterOverrides).adapterConfig),
                );
              } catch {
                // An issue we cannot read is unattributable, not tier:none —
                // the same "drop rather than guess" policy accumulateRunStats
                // applies to every other unattributable row.
                tierByIssue.set(issueId, null);
                labelsByIssue.set(issueId, []);
                pinConfigByIssue.set(issueId, null);
              }
            }

            const toNumber = (value: unknown): number | null => {
              if (typeof value === "number") return Number.isFinite(value) ? value : null;
              if (typeof value === "string" && value.length > 0) {
                const parsed = Number(value);
                return Number.isFinite(parsed) ? parsed : null;
              }
              return null;
            };

            // : `usage_json.costUsd` is the serving CLI's own figure,
            // and the Claude CLI lane stamps provider=anthropic for every
            // model it serves — so a CLIProxy-served Meta/Devin model lands an
            // Anthropic-priced cost. Drop those observations instead of
            // averaging them into the ledger. Counted so a refresh log shows
            // how much evidence the upstream bug is costing us.
            let unattributableCostRuns = 0;
            const attributableCost = (
              modelId: string,
              provider: unknown,
              costUsd: number | null,
            ): number | null => {
              if (costUsd === null) return null;
              const verdict = classifyCostAttribution(
                modelId,
                typeof provider === "string" ? provider : null,
              );
              if (verdict.attributable) return costUsd;
              unattributableCostRuns += 1;
              return null;
            };

            const runOutcomeRows: RunOutcomeRow[] = scoreRunRows.flatMap((row) => {
              const r = asRecord(row);
              const modelId = resolveConfiguredModelId(
                typeof r.model === "string" ? r.model : null,
                config.models,
              );
              if (!modelId) return [];
              const issueId = typeof r.issue_id === "string" ? r.issue_id : "";
              return [{
                modelId,
                tier: issueId ? tierByIssue.get(issueId) ?? null : null,
                status: r.status as RunOutcomeRow["status"],
                errorCode: typeof r.error_code === "string" && r.error_code ? r.error_code : null,
                error: typeof r.error === "string" && r.error ? r.error : null,
                costUsd: attributableCost(modelId, r.provider, toNumber(r.cost_usd)),
                mins: toNumber(r.mins),
                ageDays: toNumber(r.age_days) ?? 0,
              }];
            });

            let statsByModel = accumulateRunStats(runOutcomeRows);

            const closingRuns: Array<
              ClosingRunCandidate & { costUsd: number | null }
            > = closingRunRows.flatMap((row) => {
              const r = asRecord(row);
              const modelId = resolveConfiguredModelId(
                typeof r.model === "string" ? r.model : null,
                config.models,
              );
              if (!modelId) return [];
              const issueId = typeof r.issue_id === "string" ? r.issue_id : "";
              return [{
                issueId,
                modelId,
                tier: issueId ? tierByIssue.get(issueId) ?? null : null,
                finishedAtMs: toNumber(r.finished_at_ms) ?? 0,
                agentId: typeof r.agent_id === "string" && r.agent_id ? r.agent_id : null,
                costUsd: attributableCost(modelId, r.provider, toNumber(r.cost_usd)),
              }];
            });

            const reworkSignals = await readReworkSignals(company.id);
            const reworkEvents: ReworkClosingRun[] = [];
            const rejectedIssueIds = new Set<string>();
            for (const signal of reworkSignals) {
              const windowMs = signal.kind === "reopen" ? REOPEN_WINDOW_MS : REJECTION_WINDOW_MS;
              const closing = findClosingRun(signal.issueId, signal.atMs, windowMs, closingRuns, signal.excludeAgentId);
              if (!closing || closing.tier === null) continue;
              reworkEvents.push({ modelId: closing.modelId, tier: closing.tier, kind: signal.kind });
              rejectedIssueIds.add(signal.issueId);
            }
            statsByModel = foldReworkIntoStats(statsByModel, reworkEvents);

            const aaSnapshot = await readAaSnapshot();
            const aaKnownSlugs = new Set(Object.keys(aaSnapshot.bySlug));
            const liveAaIndex = (model: (typeof config.models)[number]): number | null => {
              const slug = resolveAaSlug(model.id, aaKnownSlugs, model.aaSlug ?? null);
              if (!slug) return model.aaIndex;
              const live = aaSnapshot.bySlug[slug]?.intelligenceIndex;
              return typeof live === "number" ? live : model.aaIndex;
            };
            // : the  five-benchmark basket, superseding the
            //  agentic sub-score average. Frozen `benchmark-prior-v1` vectors —
            // three of the five benchmarks are not aa.ai columns at all, and
            // mixing live aa.ai rows with the capture would blend effort levels
            // (see `benchmark-data.ts`). The composite index half stays live.
            const benchmarkRow = (model: (typeof config.models)[number]): BenchmarkRow | null =>
              FROZEN_BENCHMARK_ROWS[model.id] ?? null;

            const modelScores: ModelScore[] = config.models.map((model) =>
              buildModelScore(model.id, liveAaIndex(model), statsByModel[model.id] ?? {}, TIERS, benchmarkRow(model)),
            );

            //  owner directive: the router alone decides the tier, so
            // this is applied live rather than shadowed. An unscored model keeps
            // its configured tier — `derivedTier` is null there, never 0.8's T2.
            //
            // The log is diffed against the SAME overlay selection runs through,
            // row by row, rather than re-deriving it from the scores. A score is
            // per model id and the roster lists some ids twice, so a `find()` by
            // id reports the first row's move and hides the second's — and the
            // hidden one is exactly what an operator would need to reverse.
            const scoresByModelId: Record<string, ModelScore> = {};
            for (const score of modelScores) scoresByModelId[score.modelId] = score;
            const overlaid = applyDerivedTiers(config.models, scoresByModelId);
            const retierings = overlaid.flatMap((model, index) => {
              const configured = config.models[index];
              if (!configured || configured.tier === model.tier) return [];
              const p = scoresByModelId[model.id]?.overall.p;
              const lane = configured.laneId ? `@${configured.laneId}` : "";
              return [`${model.id}${lane} ${configured.tier} -> ${model.tier} (p=${p})`];
            });

            const cardIssueRows = (await ctx.db.query(
              `select id::text as id,
                      extract(epoch from coalesce(completed_at, cancelled_at)) * 1000 as closed_at_ms,
                      assignee_adapter_overrides->'adapterConfig'->>'model' as pinned_model
                 from issues
                where company_id = $1
                  and coalesce(completed_at, cancelled_at) is not null
                  and coalesce(completed_at, cancelled_at) > now() - ($2 || ' days')::interval`,
              [company.id, String(CARD_LEDGER_WINDOW_DAYS)],
            )) as unknown[];

            const latestClosingRunByIssue = new Map<string, ClosingRunCandidate & { costUsd: number | null }>();
            const runCountByIssue = new Map<string, number>();
            for (const run of closingRuns) {
              if (!run.issueId) continue;
              runCountByIssue.set(run.issueId, (runCountByIssue.get(run.issueId) ?? 0) + 1);
              const existing = latestClosingRunByIssue.get(run.issueId);
              if (!existing || run.finishedAtMs > existing.finishedAtMs) {
                latestClosingRunByIssue.set(run.issueId, run);
              }
            }
            // : the raw closing-run identity per issue, WITHOUT the
            // `resolveConfiguredModelId` pre-filter above. The overlay resolves
            // the served model itself — exact roster id or `unknown` — so an
            // alias-ambiguous or unrostered identity lands in the unknown cell
            // instead of vanishing before attribution. Read only by the
            // overlay block below; the legacy ledger keeps the filtered map.
            const rawClosingModelByIssue = new Map<string, string | null>();
            const rawClosingAtByIssue = new Map<string, number>();
            for (const row of closingRunRows) {
              const r = asRecord(row);
              const issueId = typeof r.issue_id === "string" ? r.issue_id : "";
              if (!issueId) continue;
              const atMs = toNumber(r.finished_at_ms) ?? 0;
              const currentMs = rawClosingAtByIssue.get(issueId) ?? -1;
              if (!rawClosingModelByIssue.has(issueId) || atMs > currentMs) {
                rawClosingModelByIssue.set(
                  issueId,
                  typeof r.model === "string" && r.model ? r.model : null,
                );
                rawClosingAtByIssue.set(issueId, atMs);
              }
            }

            const cardRows: CardRow[] = [];
            for (const row of cardIssueRows) {
              const r = asRecord(row);
              const issueId = typeof r.id === "string" ? r.id : null;
              if (!issueId) continue;
              const closingRun = latestClosingRunByIssue.get(issueId);
              // A closed card with no attributable succeeded run (still open
              // work handed off, or attribution lost to the window) carries no
              // ledger evidence — dropped, not guessed, same policy as scores.
              if (!closingRun || closingRun.tier === null) continue;
              const rawPinnedModel =
                typeof r.pinned_model === "string" && r.pinned_model
                  ? r.pinned_model
                  : null;
              const pinnedModel = resolveConfiguredModelId(
                rawPinnedModel,
                config.models,
              );
              cardRows.push({
                modelId: closingRun.modelId,
                tier: closingRun.tier,
                closedAtMs: toNumber(r.closed_at_ms) ?? 0,
                rejected: rejectedIssueIds.has(issueId),
                costUsd: closingRun.costUsd,
                runCount: runCountByIssue.get(issueId) ?? 1,
                foreignRun:
                  rawPinnedModel !== null && pinnedModel !== closingRun.modelId,
              });
            }

            const priorPByModel: Record<string, number> = {};
            const blendedListPriceByModel: Record<string, number | null> = {};
            for (const model of config.models) {
              priorPByModel[model.id] = blendedPriorP(liveAaIndex(model), benchmarkRow(model));
              blendedListPriceByModel[model.id] = null;
            }

            const cardLedger: Record<string, CardLedgerEntry> = buildCardLedger(
              cardRows,
              Date.now(),
              priorPByModel,
              blendedListPriceByModel,
            );

            // : first-party accepted-work posterior overlay,
            // shadow-only. Built from the SAME rows the ledger above already
            // read — no new query, no new `issues.get` calls — and only when
            // the operator enables it. The overlay is stored under its own
            // state key; nothing reads it for routing in this slice.
            const acceptedWorkKey = {
              scopeKind: "company" as const,
              scopeId: company.id,
              stateKey: PLUGIN_STATE_KEYS.acceptedWorkOverlay,
            };
            if (config.acceptedWork.enabled) {
              let closedCardsWithoutClosingRun = 0;
              const acceptedWorkCards: AcceptedWorkCardInput[] = [];
              for (const row of cardIssueRows) {
                const r = asRecord(row);
                const issueId = typeof r.id === "string" ? r.id : null;
                if (!issueId) continue;
                // No succeeded run in the window at all: unattributed, counted.
                // A run that IS present but resolves to no roster id still
                // produces a card — the overlay attributes it to the unknown
                // cell rather than dropping it before attribution.
                if (!rawClosingModelByIssue.has(issueId)) {
                  closedCardsWithoutClosingRun += 1;
                  continue;
                }
                acceptedWorkCards.push({
                  issueId,
                  rawServedModel: rawClosingModelByIssue.get(issueId) ?? null,
                  pinAdapterConfig: pinConfigByIssue.get(issueId) ?? null,
                  labelNames: labelsByIssue.get(issueId) ?? [],
                  closedAtMs: toNumber(r.closed_at_ms) ?? 0,
                  rejected: rejectedIssueIds.has(issueId),
                });
              }
              const nowMs = Date.now();
              const overlay: AcceptedWorkOverlay = buildAcceptedWorkOverlay({
                cards: acceptedWorkCards,
                models: config.models,
                priorPByModel,
                unattributed: { closedCardsWithoutClosingRun },
                nowMs,
                nowIso: new Date(nowMs).toISOString(),
              });
              await ctx.state.set(acceptedWorkKey, overlay);
              ctx.logger.info("accepted-work overlay refreshed", {
                companyId: company.id,
                cohorts: overlay.cohorts.length,
                cards: acceptedWorkCards.length,
                unattributed: closedCardsWithoutClosingRun,
                specVersion: overlay.specVersion,
                computedAt: overlay.computedAt,
              });
            }

            // `computedAt` stamps the capture itself. Without it a stalled
            // refresh (the failure  gates for) is undetectable from the
            // stored state: the fleet keeps routing on whatever tiers the last
            // successful pass wrote, and the spec-version guard cannot see it —
            // that guard catches a code change, never a stale capture.
            const computedAt = new Date().toISOString();
            await ctx.state.set(scoresKey(company.id), { modelScores, cardLedger, computedAt });
            ctx.logger.info("model scores refreshed", {
              companyId: company.id,
              models: modelScores.length,
              cardsInLedger: cardRows.length,
              // : runs whose recorded cost was priced against the
              // wrong provider's table and therefore excluded. Non-zero means
              // the upstream claude-local `provider: "anthropic"` literal is
              // still live; zero means it was fixed or no such runs landed.
              unattributableCostRuns,
              tierSpecVersion: BENCHMARK_SPEC_VERSION,
              computedAt,
              retiered: retierings.length,
              unscored: modelScores.filter((score) => score.derivedTier === null).length,
              belowT3Floor: modelScores.filter((score) => score.belowT3Floor).length,
              // Named, not just counted: a tier move is the one thing here an
              // operator may need to reverse, and a bare count cannot be acted on.
              retierings,
            });
          } catch (cause) {
            ctx.logger.error("score refresh failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
      });

      // --- scheduled LLM tier classification (, tier_dispatcher.py
      // main()) -----------------------------------------------------------
      // For every open, agent-assigned issue with no per-issue override, no
      // `pin:operator`, and no running/queued run, classify it with the RUBRIC
      // and write a tier:* label (never a status or assignee change — same
      // contract as the ported script's file-level docstring). The AC3 kill
      // switch is `classification.enabled: false` (default): a company that
      // never sets it true gets byte-identical behavior to before this job
      // existed.
      //
      //  removed "with no tier:* label" from that list. An existing
      // label now ends the candidate only when THIS job wrote it
      // (`classifierLabeledIssues` provenance); a label written by anybody else
      // is re-examined and replaced. `classification.reclassifyForeignLabels:
      // false` is the one-key rollback to the old unconditional skip.
      ctx.jobs.register(JOB_KEYS.classifyIssues, async () => {
        // : ONE budget for the whole firing. A per-company budget
        // multiplied the 200 s by the company count while the host's 300 s
        // `runJob` wall covers the firing, not a company.
        const classifyJobStartedAt = Date.now();
        const classifyDeadline = classifyJobStartedAt + CLASSIFY_JOB_BUDGET_MS;
        // Admission is 1.5x the slowest row of the FIRING: it carries across companies.
        let classifySlowestRowMs = 0;
        const companies = listKnownCompanies();
        for (const company of companies) {
          if (Date.now() >= classifyDeadline) {
            ctx.logger.warn("issue classification pass stopped before the host RPC wall", {
              companyId: company.id,
              jobDurationMs: Date.now() - classifyJobStartedAt,
            });
            break;
          }
          try {
            const config = await companyConfig(company.id);
            if (!config.classification.enabled) continue;
            if (!config.classification.baseUrl || !config.classification.modelId) continue;
            // Narrowed by the `continue` above; captured so the row closure
            // below keeps the narrowing.
            const classifyBaseUrl = config.classification.baseUrl;
            const classifyModelId = config.classification.modelId;

            let apiKey: string | null = null;
            if (config.classification.apiKeySecretRef) {
              try {
                apiKey = await ctx.secrets.resolve(config.classification.apiKeySecretRef as never, {
                  companyId: company.id,
                  configPath: "classification.apiKeySecretRef",
                });
              } catch {
                ctx.logger.error("classification secret unavailable", { companyId: company.id });
                continue;
              }
            }

            // Mirrors tier_dispatcher.py main()'s row query: open, agent-assigned,
            // no pin:operator, no existing override, no existing tier:* label, no
            // running/queued run. `labels`/`issue_labels` are not allowlisted
            // (PLUGIN_DATABASE_CORE_READ_TABLES), so label/pin state is read via
            // `ctx.issues.get()` per row below rather than a live SQL join.
            //
            // : over-fetch. Because every label-based skip happens
            // per-row AFTER this query, a `limit batchSize` returns the same
            // top-N skipped rows on every run and never reaches row N+1. The
            // walk below stops at `batchSize` actual classifications instead.
            const classifyFetchLimit = Math.min(
              config.classification.batchSize * CLASSIFY_FETCH_MULTIPLIER,
              CLASSIFY_FETCH_LIMIT_MAX,
            );
            // : incremental scan — only issues updated since this
            // pass's own watermark. A bare `updated_at` predicate on the
            // existing row query: strictly fewer rows than before, same shape.
            const classifyFiringStartMs = Date.now();
            const classifySinceIso = new Date(await readScanMark(company.id, PLUGIN_STATE_KEYS.classifyLastScanAt)).toISOString();
            const candidateRows = (await ctx.db.query(
              `select i.id::text as id,
                      i.identifier as identifier,
                      i.status as status,
                      coalesce(a.name,'') as agent_name,
                      i.title as title,
                      coalesce(i.description,'') as description,
                      i.updated_at as updated_at
                 from issues i
                 join agents a on a.id = i.assignee_agent_id
                where i.company_id = $1
                  and i.status in ('todo','in_progress','blocked','in_review')
                  and a.status <> 'terminated'
                  and i.assignee_agent_id is not null
                  and i.updated_at > $3
                  and (i.assignee_adapter_overrides is null
                       or i.assignee_adapter_overrides->'adapterConfig'->>'model' is null)
                  and not exists (
                    select 1 from heartbeat_runs r
                     where r.status in ('running','queued')
                       and r.context_snapshot->>'issueId' = i.id::text
                  )
                order by i.updated_at asc
                limit $2`,
              [company.id, String(classifyFetchLimit), classifySinceIso],
            )) as unknown[];
            if (candidateRows.length === 0) {
              // : the observable skip — nothing changed since the
              // watermark, so the firing costs one row query and zero
              // per-candidate reads. Logger only, never activity: a skip is
              // routine, not a state change.
              ctx.logger.info("issue classification pass skipped: no issues changed since last scan", {
                companyId: company.id,
                since: classifySinceIso,
              });
              await writeScanMark(company.id, PLUGIN_STATE_KEYS.classifyLastScanAt, classifyFiringStartMs);
              continue;
            }

            const exclusions = await readClassificationExclusions(company.id);
            const classifierLabeled = await readClassifierLabeled(company.id);
            let classified = 0;
            let reclassified = 0;
            // : the shared hard-return walk (`row-walk.ts`) — a
            // classify row (`ctx.issues.get` plus the classifier HTTP call)
            // pays the same contended host-RPC cost as an advise row, and
            // this pass hit 288 s max over the last 4 h. The WHOLE row body
            // races the remaining budget; every write below sits behind the
            // write gate, which also stops an abandoned row from committing.
            const walk = await walkRowsWithinDeadline(
              candidateRows,
              { deadlineAt: classifyDeadline, rowTimeoutMs: CLASSIFY_ROW_TIMEOUT_MS, slowestRowMs: classifySlowestRowMs },
              async (row, rowStartedAt) => {
                const r = asRecord(row);
                const issueId = typeof r.id === "string" ? r.id : null;
                const identifier = typeof r.identifier === "string" ? r.identifier : issueId;
                if (!issueId) return "settled";

                // The row query above cannot see labels (not allowlisted), so
                // label and pin state is read per candidate via
                // `ctx.issues.get()` — the same source `describeIssue` uses for
                // label reads elsewhere in this worker.
                let issue: Awaited<ReturnType<typeof ctx.issues.get>>;
                try {
                  issue = await ctx.issues.get(issueId, company.id);
                } catch {
                  return "settled";
                }
                if (!issue) return "settled";
                const labelNames = (issue.labels ?? [])
                  .map((label) => label.name)
                  .filter((name): name is string => typeof name === "string");
                const existingLabelIds =
                  issue.labelIds ?? (issue.labels ?? []).map((label) => label.id).filter((id) => typeof id === "string");

                // An operator pin means "leave the model choice on this issue
                // alone" — unchanged, and checked before anything else.
                if (labelNames.includes(OPERATOR_PIN_LABEL)) return "settled";

                // . An existing tier:* label used to end the candidate
                // here unconditionally, which made classification a one-shot
                // stamp. Measured 2026-09-17: 120 of 126 eligible open cards
                // carried one, 97% of them agent self-assessments rather than
                // this job's verdict, and the job classified 0 issues in 36 runs.
                //
                // The skip is now provenance-scoped. Our OWN recorded verdict
                // still ends the candidate — re-running the classifier against
                // its own last answer is pure spend. Somebody else's label is
                // re-examined and replaced, because it is exactly the input the
                // card says is wrong. `reclassifyForeignLabels: false` restores
                // the old unconditional skip.
                //
                // "Ours" is checked against BOTH label views the host exposes —
                // the `tier:*` name and the label id we actually wrote — and
                // either one matching is enough. The two can only disagree if a
                // caller returns them inconsistently, and the asymmetry of the
                // mistake decides which way to lean: wrongly calling a label
                // foreign re-runs the classifier on every job tick forever, while
                // wrongly calling it ours just leaves the card on the tier we
                // ourselves assigned. So a disagreement resolves to "ours".
                const existingLabelTier = tierFromLabels(labelNames);
                // : the classifier cannot emit T0, so re-classifying a
                // `tier:T0` label would only ever DROP an explicit opt-in.
                if (existingLabelTier === "T0") return "settled";
                const ourRecordedTier = classifierLabeled[issueId];
                const ourLabelId = ourRecordedTier ? config.tierLabelIds[ourRecordedTier] : undefined;
                const stillCarriesOurLabel =
                  ourRecordedTier !== undefined &&
                  (ourRecordedTier === existingLabelTier ||
                    (typeof ourLabelId === "string" && existingLabelIds.includes(ourLabelId)));
                const isForeignLabel = existingLabelTier !== null && !stillCarriesOurLabel;
                if (existingLabelTier !== null) {
                  if (!config.classification.reclassifyForeignLabels) return "settled";
                  if (!isForeignLabel) return "settled";
                }

                const agentName = typeof r.agent_name === "string" ? r.agent_name : "";
                const title = typeof r.title === "string" ? r.title : "";
                const description = typeof r.description === "string" ? r.description : "";
                const prompt = buildClassificationPrompt(title, description, agentName, config.classification.descriptionChars);

                const result = await callClassifier(
                  {
                    baseUrl: classifyBaseUrl,
                    protocol: config.classification.protocol,
                    modelId: classifyModelId,
                    apiKey,
                    system: RUBRIC,
                    userPrompt: prompt,
                    maxOutputTokens: config.classification.maxOutputTokens,
                    requestTimeoutMs: config.classification.requestTimeoutMs,
                    maxResponseBytes: config.classification.maxResponseBytes,
                  },
                  classificationHttp,
                );
                if (!result.text) {
                  ctx.logger.info("classification skipped", { companyId: company.id, issue: identifier, why: result.error });
                  return "settled";
                }

                const judgement = parseClassificationResponse(result.text);
                if (!judgement) {
                  ctx.logger.info("classification unparseable", { companyId: company.id, issue: identifier });
                  return "settled";
                }

                const { labelTier, pickTier } = resolveClassifiedTiers(judgement, {
                  t3ConfidenceFloor: config.classification.t3ConfidenceFloor,
                  t2ConfidenceFloor: config.classification.t2ConfidenceFloor,
                });
                void pickTier; // consumed by the apply-sweep ( task #6/#7), not this job

                //  write gate: the host fires at 300 s regardless, so
                // a write with no budget left — or after burning more than the
                // row's own slice — is an orphaned mutation: refuse it. This is
                // also what stops a row the walk abandoned at the deadline from
                // committing. The row is `unsettled`: the cursor stops before
                // it and next firing re-attempts it from live state.
                if (Date.now() >= classifyDeadline || Date.now() - rowStartedAt >= CLASSIFY_ROW_TIMEOUT_MS) {
                  ctx.logger.warn("classification pass skipped slow row write: row exceeded its time slice", {
                    companyId: company.id,
                    issue: identifier,
                    rowDurationMs: Date.now() - rowStartedAt,
                    rowTimeoutMs: CLASSIFY_ROW_TIMEOUT_MS,
                  });
                  return "unsettled";
                }

                const labelId = config.tierLabelIds[labelTier];
                if (labelId) {
                  // : adding is only correct when there was no tier label
                  // to begin with. Replacing a foreign one means DROPPING it —
                  // leaving both would be a two-tier card, and `tierFromLabels`
                  // resolves that by taking the most capable, so an additive
                  // write would silently preserve every T1 it was meant to
                  // correct. Drop every tier:* id, then add the one verdict.
                  const tierLabelIdsOnIssue = new Set(
                    (issue.labels ?? [])
                      .filter((label) => typeof label.name === "string" && label.name.startsWith(TIER_LABEL_PREFIX))
                      .map((label) => label.id)
                      .filter((id): id is string => typeof id === "string"),
                  );
                  for (const id of Object.values(config.tierLabelIds)) {
                    if (typeof id === "string") tierLabelIdsOnIssue.add(id);
                  }
                  const nextLabelIds = [
                    ...new Set([...existingLabelIds.filter((id) => !tierLabelIdsOnIssue.has(id)), labelId]),
                  ];
                  await ctx.issues.update(
                    issueId,
                    { labelIds: nextLabelIds } as Parameters<typeof ctx.issues.update>[1],
                    company.id,
                  );
                  // Record provenance only once the write landed — a label we
                  // failed to write is not a label we own, and claiming it would
                  // make this card permanently unreclassifiable.
                  await ctx.state.set(classifierLabeledKey(company.id), { ...classifierLabeled, [issueId]: labelTier });
                  classifierLabeled[issueId] = labelTier;
                }

                if (judgement.exclusion) {
                  await ctx.state.set(classificationExclusionsKey(company.id), { ...exclusions, [issueId]: true });
                  exclusions[issueId] = true;
                }

                await ctx.activity.log({
                  companyId: company.id,
                  message: `Model Selection classified this issue as ${labelTier} (confidence ${judgement.confidence})${judgement.exclusion ? ", capability-excluded" : ""}${isForeignLabel ? `, replacing an unattributed ${existingLabelTier} label` : ""}`,
                  entityType: "issue",
                  entityId: issueId,
                  metadata: {
                    tier: labelTier,
                    pickTier,
                    confidence: judgement.confidence,
                    reason: judgement.reason,
                    ...(isForeignLabel ? { replacedLabelTier: existingLabelTier } : {}),
                  },
                });
                classified += 1;
                if (isForeignLabel) reclassified += 1;
                return classified >= config.classification.batchSize ? "stop" : "settled";
              },
            );
            classifySlowestRowMs = walk.slowestRowMs;
            if (walk.abandoned) {
              const abandoned = asRecord(walk.abandoned.row);
              ctx.logger.warn("classification pass abandoned a slow row at the deadline", {
                companyId: company.id,
                issue: typeof abandoned.identifier === "string" ? abandoned.identifier : abandoned.id,
                rowDurationMs: walk.abandoned.rowDurationMs,
              });
            }

            await advanceScanCursor(
              company.id,
              PLUGIN_STATE_KEYS.classifyLastScanAt,
              candidateRows,
              walk.settledPrefix,
              classifyFetchLimit,
              classifyFiringStartMs,
            );
            ctx.logger.info("issue classification pass complete", {
              companyId: company.id,
              classified,
              reclassified,
              candidates: candidateRows.length,
              examined: walk.examined.length,
              skippedSlowRows: walk.unsettled,
              slowestRowMs: walk.slowestRowMs,
              budgetExhausted: walk.budgetExhausted,
              jobDurationMs: Date.now() - classifyJobStartedAt,
            });
            if (walk.budgetExhausted) break;
          } catch (cause) {
            ctx.logger.error("issue classification failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
      });

      // --- shared helpers for the three scheduled sweeps below (:
      // label_only_pass / repin_pass / balance_pass) -----------------------

      const balanceOpenStatuses = new Set(["todo", "in_progress", "blocked", "in_review"]);

      const activeBalanceRunIssueIds = async (companyId: string): Promise<Set<string>> => {
        const rows = (await ctx.db.query(
          `select distinct coalesce(context_snapshot->>'issueId', context_snapshot->>'taskId') as issue_id
             from heartbeat_runs
            where company_id = $1
              and status in ('running','queued')
              and coalesce(context_snapshot->>'issueId', context_snapshot->>'taskId') is not null`,
          [companyId],
        )) as unknown[];
        return new Set(
          rows
            .map((row) => asRecord(row).issue_id)
            .filter((issueId): issueId is string => typeof issueId === "string" && issueId.length > 0),
        );
      };

      /**
       * : incremental-scan watermarks. Each router pass reads only
       * issues updated since its own mark and advances the mark past what it
       * scanned. Three fail-open rules keep a broken clock from starving a
       * pass:
       *
       *   - an unreadable or unparseable mark reads as epoch (full scan);
       *   - the mark advances to the firing start only when the fetch did NOT
       *     hit its row limit (drained) and every row was settled; otherwise
       *     it is a cursor past the settled prefix (,
       *     `scanMarkAfterWalk`), so unreached and unsettled rows stay
       *     visible next firing;
       *   - rows without a parseable `updated_at` never move the mark.
       */
      const readScanMark = async (companyId: string, stateKey: string): Promise<number> => {
        const stored = asRecord(await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey }));
        const at = typeof stored.at === "string" ? Date.parse(stored.at) : Number.NaN;
        return Number.isFinite(at) ? at : 0;
      };

      const writeScanMark = async (companyId: string, stateKey: string, atMs: number): Promise<void> => {
        await ctx.state.set(
          { scopeKind: "company", scopeId: companyId, stateKey },
          { at: new Date(atMs).toISOString() },
        );
      };

      /**
       *  / : advance the watermark after a bounded walk.
       * `settledPrefix` is the walk's count of leading fetched rows that were
       * decided; the mark jumps to the firing start only when that is every
       * row of a drained fetch, and otherwise moves just past the settled
       * prefix (see `scanMarkAfterWalk`). A walk cut short by a deadline,
       * write limit, batch size or row cap — or holding a slow-skipped or
       * abandoned row — therefore resumes at the first row it did not
       * settle instead of re-walking the rows it already decided.
       */
      const advanceScanCursor = async (
        companyId: string,
        stateKey: string,
        rows: unknown[],
        settledPrefix: number,
        fetchLimit: number,
        firingStartMs: number,
      ): Promise<void> => {
        const mark = scanMarkAfterWalk(rows, settledPrefix, fetchLimit, firingStartMs);
        if (mark !== null) await writeScanMark(companyId, stateKey, mark);
      };

      /**
       * : the pin lifecycle's only clock. Pins carry no timestamp
       * (`adapterConfig.model` is a bare string) and `issues.updated_at`
       * moves on any comment, so this `issueId -> pinnedAt ISO` map —
       * written on every pin and clear, read by the repin pass — is what
       * ages a pin. Same `noEligibleNotices` map shape (`{issueId: ISO}`),
       * different state key and a different reason to exist.
       */
      const pinPinnedAtKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.pinPinnedAt,
      });

      const readPinPinnedAt = async (companyId: string): Promise<Record<string, string>> => {
        const stored = asRecord(await ctx.state.get(pinPinnedAtKey(companyId)));
        const out: Record<string, string> = {};
        for (const [issueId, at] of Object.entries(stored)) {
          if (typeof at === "string") out[issueId] = at;
        }
        return out;
      };

      /**
       * : a pin older than PIN_MAX_AGE_MS must be re-validated
       * through `advise` even when the pinned lane still reads usable.
       * Missing entry = expired: fail-safe toward re-validation, never
       * toward keeping a pin whose age we cannot prove.
       */
      const isPinExpired = (pinnedAt: Record<string, string>, issueId: string, nowMs: number): boolean => {
        const raw = pinnedAt[issueId];
        if (typeof raw !== "string") return true;
        const atMs = Date.parse(raw);
        if (!Number.isFinite(atMs)) return true;
        return nowMs - atMs >= PIN_MAX_AGE_MS;
      };

      /**
       * : stamp the lifecycle clock after a pin lands, or remove
       * the entry when the pin is cleared. Bounded like the
       * `maybeLogUnpinnableCard` throttle map: entries older than a week
       * can never make a pin look FRESH again, so drop them on write.
       * Best-effort — a lost stamp only re-validates one pin early.
       */
      const recordPinTimestamp = async (
        companyId: string,
        issueId: string,
        atIso: string | null,
      ): Promise<void> => {
        try {
          const stored = await readPinPinnedAt(companyId);
          const pruned: Record<string, string> = {};
          const nowMs = Date.parse(atIso ?? "") || Date.now();
          for (const [id, at] of Object.entries(stored)) {
            if (id !== issueId && nowMs - Date.parse(at) < 7 * 24 * 60 * 60 * 1000) pruned[id] = at;
          }
          if (atIso !== null) pruned[issueId] = atIso;
          await ctx.state.set(pinPinnedAtKey(companyId), pruned);
        } catch {
          // A lost timestamp only re-validates one pin early; never fail
          // the pass over the clock.
        }
      };

      /**
       *  ( §7 item 4). The fallback lease's bookkeeping.
       * A pin on a `fallbackOnly` model carries a provenance stamp in its
       * override env (`PIN_PROVENANCE_ENV_KEY`), and this index of stamped
       * issue ids lets the lease pass visit only those issues.
       * The stamp is the authority; the index is a pointer to it, and an
       * entry whose `decisionId` no longer matches the issue's stamp is
       * dropped on its next visit.
       */
      const fallbackPinsKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.fallbackPins,
      });

      interface FallbackPinEntry {
        decisionId: string;
        decidedAt: string;
        /** Last lease-pass visit; orders the examine cap's rotation. */
        checkedAt: string | null;
      }

      const readFallbackPins = async (companyId: string): Promise<Record<string, FallbackPinEntry>> => {
        const stored = asRecord(await ctx.state.get(fallbackPinsKey(companyId)));
        const out: Record<string, FallbackPinEntry> = {};
        for (const [issueId, raw] of Object.entries(stored)) {
          const entry = asRecord(raw);
          if (typeof entry.decisionId !== "string" || typeof entry.decidedAt !== "string") continue;
          out[issueId] = {
            decisionId: entry.decisionId,
            decidedAt: entry.decidedAt,
            checkedAt: typeof entry.checkedAt === "string" ? entry.checkedAt : null,
          };
        }
        return out;
      };

      /** The stamp a new pin on `model` must carry, or null for a non-fallback pin. */
      const fallbackPinProvenance = (
        model: { fallbackOnly?: boolean },
        agentId: string | null,
      ): PinProvenance | null =>
        model.fallbackOnly === true
          ? { decisionId: randomUUID(), agentId, fallback: true, decidedAt: new Date().toISOString() }
          : null;

      /**
       * Mirror what was just written into the index: add the issue when the
       * written env carries a stamp, drop it otherwise (a non-fallback pin,
       * or a clear). Reads the stamp back from the patch rather than from the
       * caller's intent, because `modelOverrideForContext` declines to write
       * a stamp into an unknown assignee's env. Best-effort like
       * `recordPinTimestamp`: a lost entry only leaves that pin to the 24 h
       * expiry, so it is logged, never thrown over a pin that already landed.
       */
      const recordFallbackPin = async (
        companyId: string,
        issueId: string,
        written: { assigneeAdapterOverrides?: { adapterConfig?: { env?: Record<string, unknown> } } | null } | null,
      ): Promise<void> => {
        try {
          const stamp = readPinProvenance(written?.assigneeAdapterOverrides?.adapterConfig?.env);
          const stored = await readFallbackPins(companyId);
          if (stamp === null) {
            if (!(issueId in stored)) return;
            delete stored[issueId];
          } else {
            stored[issueId] = { decisionId: stamp.decisionId, decidedAt: stamp.decidedAt, checkedAt: null };
            const entries = Object.entries(stored);
            if (entries.length > FALLBACK_PIN_INDEX_MAX) {
              // Evict the oldest decisions: an evicted pin is not lost, only
              // left to the repin pass's 24 h expiry.
              entries
                .sort(([, a], [, b]) => a.decidedAt.localeCompare(b.decidedAt))
                .slice(0, entries.length - FALLBACK_PIN_INDEX_MAX)
                .forEach(([id]) => delete stored[id]);
            }
          }
          await ctx.state.set(fallbackPinsKey(companyId), stored);
        } catch (cause) {
          ctx.logger.warn("fallback pin index write failed", {
            companyId,
            issueId,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      };

      /**
       * . Whether the creation-time pin may write this card's
       * override right now.
       *
       * The classifier and `advise` are slower than the assignment wake's
       * queue -> claim, so by the time the creation pin decides, the card's
       * run is queued and often claimed, and `describeIssue`'s `isIdle` is
       * false. Gating the creation pin on strict idleness aborted nearly
       * every pin (85% of runs were bypassing the pacer). A queued-but-
       * unstarted run is still safe to pin under: Paperclip reads
       * `assigneeAdapterOverrides` at run START, not at queue time.
       *
       * Keyed on the card's live `heartbeat_runs` rows
       * (`CREATION_PIN_LIVE_RUNS_SQL`), NOT on `executionRunId`: this fork
       * stamps that column at claim, so it cannot name a queued run
       * ( §2.3). Returns true when `checkoutRunId` is null, no
       * scheduled retry is queued/running, and every live run attributed to
       * the card is `queued` with `started_at IS NULL` (vacuously true with
       * none). Any `running` row, or any row with `started_at` set, reads as
       * "not pinnable": fail closed.
       *
       * Creation/assignment path ONLY. The scheduled repin/balance passes
       * keep the strict idle-only `balanceWriteStillSafe` below: they sweep
       * cards whose runs they did not just watch get queued.
       */
      const pinnableBeforeStart = async (companyId: string, issueId: string): Promise<boolean> => {
        const issue = await ctx.issues.get(issueId, companyId);
        if (!issue) return false;
        if (issue.checkoutRunId) return false;
        const scheduledRetryStatus = issue.scheduledRetry?.status ?? null;
        if (scheduledRetryStatus === "queued" || scheduledRetryStatus === "running") return false;
        // Keyed on the card's live runs, not `executionRunId`: the fork stamps
        // that column at claim, so a queued run is invisible through it.
        const liveRows = (await ctx.db.query(CREATION_PIN_LIVE_RUNS_SQL, [
          companyId,
          issueId,
        ])) as unknown[];
        return liveRows.every((row) => {
          const run = asRecord(row);
          return run.status === "queued" && run.started_at == null;
        });
      };

      /**
       * . The creation pin's final fail-closed read: the same
       * status/operator/pin checks as `balanceWriteStillSafe`, but the
       * run-attachment check goes through `pinnableBeforeStart` so the
       * assignment wake's already-queued run does not veto its own pin.
       */
      const creationWriteStillSafe = async (
        companyId: string,
        issueId: string,
        models: ResolvedConfig["models"],
        /** : the pin this write may replace; null = must be unpinned. */
        expectedPinnedModelId: string | null,
      ): Promise<boolean> => {
        const issue = await ctx.issues.get(issueId, companyId);
        if (!issue || !balanceOpenStatuses.has(String(issue.status ?? ""))) return false;
        if ((issue.labels ?? []).some((label) => label.name === OPERATOR_PIN_LABEL)) return false;

        const overrides = asRecord(issue.assigneeAdapterOverrides);
        const adapterConfig = asRecord(overrides.adapterConfig);
        const rawPinnedModelId = typeof adapterConfig.model === "string" ? adapterConfig.model : null;
        const currentPinnedModelId = resolveConfiguredModelId(rawPinnedModelId, models);
        if (rawPinnedModelId && !currentPinnedModelId) return false;
        if (currentPinnedModelId !== expectedPinnedModelId) return false;

        return pinnableBeforeStart(companyId, issueId);
      };

      /**
       *  ( §5). Re-home a pin's env when a card moves from
       * one agent to another.
       *
       * The override env was built from the PREVIOUS assignee's env, and the
       * host swaps it in wholesale for the new assignee's: left alone, the
       * new assignee's run carries the old agent's secret refs, which the
       * host validates against the run's agent and refuses ("configuration
       * incomplete"). This is not a new routing decision — the model stays
       * as pinned — only the env under it moves.
       *
       * Rebuild from the new assignee's env when the pin can be rewritten
       * before the next run starts (`pinnableBeforeStart`, ), so the
       * context ceiling and sub-call keys follow the pin. Otherwise (run
       * already started, operator pin, closed card, unknown assignee env, a
       * pin outside the roster, or classification off) drop the env and keep
       * everything else: the run then gets the new assignee's own env whole.
       * Either way none of the old env survives. A card with no override env
       * has nothing to carry and is not written.
       */
      const rehomePinOnReassignment = async (
        companyId: string,
        issueId: string,
        fromAgentId: string,
        toAgentId: string,
      ): Promise<void> => {
        const issue = await ctx.issues.get(issueId, companyId);
        // Moved on again: the later reassignment's own event re-homes it.
        if (!issue || issue.assigneeAgentId !== toAgentId) return;
        const adapterConfig = asRecord(asRecord(issue.assigneeAdapterOverrides).adapterConfig);
        if (adapterConfig.env == null) return;
        const rawPinnedModelId = typeof adapterConfig.model === "string" ? adapterConfig.model : null;

        const config = await companyConfig(companyId);
        // : the re-home is an override write like any other, so it
        // takes the same single gate as the five scheduled/event pin sites.
        // Advisory installs log the re-home and write nothing — the previous
        // assignee's env stays until enforcement (or the  repair
        // path, with its own advisory check) re-homes it. No exception.
        const writesAllowed = selectionWritesAllowed(config);
        const advisorySuffix = writesAllowed ? "" : " — advisory, nothing written";
        const pinnedModelId = resolveConfiguredModelId(rawPinnedModelId, config.models);
        const pinnedModel = config.models.find((model) => model.id === pinnedModelId) ?? null;
        const described = await describeIssue(companyId, issueId, {});
        if (
          config.classification.enabled &&
          pinnedModel !== null &&
          described !== null &&
          described.assigneeAgentId === toAgentId &&
          described.agentEnv !== null &&
          balanceOpenStatuses.has(described.status) &&
          !described.hasOperatorPin
        ) {
          const patch = modelOverrideForContext({
            model: pinnedModel,
            agentEnvContextTokens: config.selection.agentEnvContextTokens,
            compactionRatio: config.selection.compactionRatio,
            agentEnv: described.agentEnv,
            agentAdapterType: described.agentAdapterType,
            agentAdapterConfig: described.agentAdapterConfig,
            existingOverrideEnv: described.existingOverrideEnv,
            cheapModelId: cheapestHealthyModelIdForTier({
              models: config.models,
              tier: "T3",
              ledger: await readLaneLedger(companyId),
              laneOutageOverride: await readLaneOutage(companyId),
              nowIso: new Date().toISOString(),
              modelScores: await readModelScores(companyId),
              laneAvoidConfig: config.pacing.avoid,
              pacingMode: config.pacing.mode,
            }),
            // Same decision, new home: a fallback pin keeps its stamp, so the
            // lease pass still finds it.
            provenance: readPinProvenance(described.existingOverrideEnv),
          });
          // Final reads, last before the write: still this assignee, still
          // this pin, and no run has started that would read the old env.
          const fresh = await ctx.issues.get(issueId, companyId);
          const freshModel = asRecord(asRecord(fresh?.assigneeAdapterOverrides).adapterConfig).model;
          if (
            fresh?.assigneeAgentId === toAgentId &&
            freshModel === adapterConfig.model &&
            (await pinnableBeforeStart(companyId, issueId))
          ) {
            // : advisory installs decide and report; they pin
            // nothing — including here, on the rebuild.
            if (writesAllowed) {
              await ctx.issues.update(issueId, patch as Parameters<typeof ctx.issues.update>[1], companyId);
              await recordFallbackPin(companyId, issueId, patch);
            } else {
              ctx.logger.info("reassignment re-home advisory: would rebuild the pin env, nothing written", {
                companyId,
                issue: described.identifier ?? issueId,
                modelId: pinnedModel.id,
                fromAgentId,
                toAgentId,
              });
            }
            await ctx.activity.log({
              companyId,
              message: `Model Selection rebuilt the ${pinnedModel.id} pin's env for the new assignee on ${described.identifier ?? issueId}${advisorySuffix}`,
              entityType: "issue",
              entityId: issueId,
              metadata: {
                modelId: pinnedModel.id,
                fromAgentId,
                toAgentId,
                action: "rebuild-env",
                ...(writesAllowed ? {} : { advisory: true, written: false }),
              },
            });
            return;
          }
        }

        // Clear: re-read so the write starts from the override as it is now.
        const current = await ctx.issues.get(issueId, companyId);
        if (!current || current.assigneeAgentId !== toAgentId) return;
        const overrides = { ...asRecord(current.assigneeAdapterOverrides) };
        const keptAdapterConfig = { ...asRecord(overrides.adapterConfig) };
        if (keptAdapterConfig.env == null) return;
        delete keptAdapterConfig.env;
        delete overrides.adapterConfig;
        if (Object.keys(keptAdapterConfig).length > 0) overrides.adapterConfig = keptAdapterConfig;
        // : the clear mutates the override exactly like a repin, so
        // it is gated too — there is deliberately no hygiene exception (see
        // selectionWritesAllowed). Advisory installs keep the stale env on
        // paper and log the would-be clear.
        if (writesAllowed) {
          await ctx.issues.update(
            issueId,
            { assigneeAdapterOverrides: Object.keys(overrides).length > 0 ? overrides : null } as Parameters<
              typeof ctx.issues.update
            >[1],
            companyId,
          );
          await recordFallbackPin(companyId, issueId, null);
        } else {
          ctx.logger.info("reassignment re-home advisory: would clear the previous assignee's pin env, nothing written", {
            companyId,
            issue: described?.identifier ?? issueId,
            fromAgentId,
            toAgentId,
          });
        }
        await ctx.activity.log({
          companyId,
          message: `Model Selection cleared the previous assignee's pin env on ${described?.identifier ?? issueId}; model pin kept${advisorySuffix}`,
          entityType: "issue",
          entityId: issueId,
          metadata: {
            modelId: typeof keptAdapterConfig.model === "string" ? keptAdapterConfig.model : null,
            fromAgentId,
            toAgentId,
            action: "clear-env",
            ...(writesAllowed ? {} : { advisory: true, written: false }),
          },
        });
      };

      /**
       * . Fail-closed pre-write quarantine re-check. A pass loop can
       * run for minutes between its pass-start `readLaneOutage` and any one
       * card's write; an auto-quarantine written in between (the 2026-09-24
       * 15:20:46Z codex quarantine, 28s before a 15:21:14Z repin INTO that
       * lane) is invisible to every snapshot the decision was computed
       * from. Re-read the outage immediately before the write and refuse a
       * selected model the fresh snapshot excludes. Outage-only on purpose:
       * it is the one signal that can appear mid-pass with no poll cycle
       * behind it (a run rejection), and one extra `state.get` per write —
       * not per scanned candidate — keeps the  read budget intact.
       * A write skipped here is retried by the next pass firing; nothing is
       * wedged, nothing is lost.
       */
      const writeStillSafeFromQuarantine = async (
        companyId: string,
        selectedModel: ModelEntry,
      ): Promise<boolean> => {
        const freshOutage = await readLaneOutage(companyId);
        return !laneOutageExcluded(freshOutage, new Date().toISOString(), selectedModel);
      };

      /** Final fail-closed read immediately before a balance write. */
      const balanceWriteStillSafe = async (
        companyId: string,
        issueId: string,
        expectedPinnedModelId: string | null,
        models: ResolvedConfig["models"],
      ): Promise<boolean> => {
        const issue = await ctx.issues.get(issueId, companyId);
        if (!issue || !balanceOpenStatuses.has(String(issue.status ?? ""))) return false;
        const scheduledRetryStatus = issue.scheduledRetry?.status ?? null;
        if (
          issue.checkoutRunId ||
          issue.executionRunId ||
          scheduledRetryStatus === "queued" ||
          scheduledRetryStatus === "running"
        ) {
          return false;
        }
        if ((issue.labels ?? []).some((label) => label.name === OPERATOR_PIN_LABEL)) return false;

        const overrides = asRecord(issue.assigneeAdapterOverrides);
        const adapterConfig = asRecord(overrides.adapterConfig);
        const rawPinnedModelId = typeof adapterConfig.model === "string" ? adapterConfig.model : null;
        const currentPinnedModelId = resolveConfiguredModelId(rawPinnedModelId, models);
        if (rawPinnedModelId && !currentPinnedModelId) return false;
        if (currentPinnedModelId !== expectedPinnedModelId) return false;

        const activeRows = (await ctx.db.query(
          `select coalesce(context_snapshot->>'issueId', context_snapshot->>'taskId') as issue_id
             from heartbeat_runs
            where company_id = $1
              and status in ('running','queued')
              and coalesce(context_snapshot->>'issueId', context_snapshot->>'taskId') = $2
            limit 1`,
          [companyId, issueId],
        )) as unknown[];
        return !activeRows.some((row) => asRecord(row).issue_id === issueId);
      };

      /**
       * A model is "usable and capable" for a tier, ported from
       * `tier_dispatcher.py`'s `usable(model_id) and capable(model_id, tier)[0]`
       * combination used at `repin_pass`'s skip-check and `balance_pass`'s
       * `incapable` check. Reuses the exact same gates `select.ts` applies —
       * hard-stop serviceability, lane avoid, lane outage, and the
       * capability-score gate — rather than re-deriving Python's separate
       * `usage_state()`/`lane_util()` telemetry reads that this plugin does
       * not keep in that shape. Fail-open on an unconfigured/disabled model,
       * matching every other  gate.
       */
      const isUsableAndCapable = (
        modelId: string | null,
        tier: Tier,
        requiredContextTokens: number | undefined,
        config: ResolvedConfig,
        laneLedger: LaneLedger,
        laneOutageOverride: LaneOutageOverride | null,
        modelScores: Readonly<Record<string, ModelScore>>,
        nowIso: string,
      ): boolean => {
        if (!modelId) return false;
        const model = applyDerivedTiers(config.models, modelScores).find((m) => m.id === modelId && m.enabled);
        if (!model || tierIndex(model.tier) < tierIndex(tier)) return false;
        if (typeof requiredContextTokens === "number" && model.contextWindow < requiredContextTokens) return false;
        if (config.pacing.mode === "off") return true;
        if (hardStopExcluded(laneLedger, model)) return false;
        if (laneAvoidExcluded(laneLedger, model, config.pacing.avoid)) return false;
        if (laneWithdrawnExcluded(laneLedger, model, config.pacing.avoid, Date.parse(nowIso))) return false;
        if (laneOutageExcluded(laneOutageOverride, nowIso, model)) return false;
        const score = tierScoreFor(modelScores[model.id], tier);
        if (score && score.capable === false) return false;
        return true;
      };

      /**
       * Company-wide count of active (todo/in_progress/in_review/blocked)
       * issues pinned to exactly this model, ported from `balance_pass`'s
       * inline `probation` subquery. Used only to decide whether a second
       * unproven-cheap-model card may be demoted (the first is allowed to
       * stay as the one live exploration card for that model).
       */
      const countActivePinsOfModel = async (companyId: string, modelId: string): Promise<number> => {
        const rows = (await ctx.db.query(
          `select count(*)::int as n
             from issues i
            where i.company_id = $1
              and i.status in ('todo','in_progress','in_review','blocked')
              and i.assignee_adapter_overrides->'adapterConfig'->>'model' = $2`,
          [companyId, modelId],
        )) as unknown[];
        const r = asRecord(rows[0]);
        return typeof r.n === "number" ? r.n : 0;
      };

      /**
       *  ( root cause #3, 2026-09-16 16:40Z incident).
       * `labelOnlyPass`/`repinPass`/`balancePass` used to gate on
       * `tierFromLabels(...)` alone and `continue` when it returned null — so
       * a card with no tier:* label at all (label inherited-and-cleared,
       * classification disabled, or the classifier hasn't reached it yet) was
       * not routed conservatively, it was never considered by any of the
       * three passes. /2987/2989 sat exactly like this during the
       * incident until an operator hand-labelled them.
       *
       * `resolveTier()` supplies the capability exclusion and missing-label
       * fallback: pin's tier, assignee floor, then selection.defaultTier.
       * During a repin, retain that recorded requirement even if its lane is
       * unusable, and let a stronger label supersede a stale weaker pin.
       *
       * The fallback itself is `tierWithFallback` in `engine/tier.ts`,
       * so the scheduled passes share `selectModel`'s T0 admission boundary and
       * the boundary is unit-testable.
       */
      // --- scheduled label-only pass (, tier_dispatcher.py
      // label_only_pass()) --------------------------------------------------
      // 2026-09-07 01:0xZ owner rule: a card that already carries a tier:*
      // label but no pin (label inherited/copied from a parent card, e.g.
      //  cloned 's tier:T1) was skipped by the classify job
      // (which only looks at issues with NO tier:* label) and never pinned —
      // the model-selection plugin then chose the model on its own, putting
      // the Steward's  run on claude-sonnet-5 while the Claude lane
      // sat at 0.84 (AVOID). Pin these from the existing label without
      // re-classifying.
      ctx.jobs.register(JOB_KEYS.labelOnlyPass, async () => {
        const companies = listKnownCompanies();
        // : the 2026-09-27 incident — this pass fetched 100 rows and
        // walked every one with no elapsed-time budget, so a slow board ran
        // past the host's 300 s job RPC wall (two firings hit 300061 ms and
        // 300085 ms while the worker kept walking rows it could never
        // report). Same cooperative budget as classifyIssues and
        // balancePass (200 s since ): stop starting new rows with
        // headroom, keep the rows already settled, and let the scan cursor
        // resume the rest next firing.
        const jobStartedAt = Date.now();
        const deadlineAt = jobStartedAt + LABEL_ONLY_PASS_JOB_BUDGET_MS;
        // Admission is 1.5x the slowest row of the FIRING: it carries across companies.
        let slowestRowMs = 0;
        for (const company of companies) {
          if (Date.now() >= deadlineAt) {
            ctx.logger.warn("label-only pass stopped before the host RPC wall", {
              companyId: company.id,
              durationMs: Date.now() - jobStartedAt,
              budgetMs: LABEL_ONLY_PASS_JOB_BUDGET_MS,
            });
            break;
          }
          try {
            const config = await companyConfig(company.id);
            if (!config.classification.enabled) continue;
            // : retired once run-scoped decisions are live.
            if (runResolveActive(config)) {
              ctx.logger.info("label-only pass skipped: run-scoped model decisions are live", { companyId: company.id });
              continue;
            }
            // : advisory installs walk the same rows and log the
            // same decisions, but write no override.
            const writesAllowed = selectionWritesAllowed(config);
            const advisorySuffix = writesAllowed ? "" : " — advisory, nothing written";

            // Same allowlisted-table constraint as classifyIssues: the row
            // query can only see issues/agents, never labels — so this finds
            // "has no override" candidates here, and confirms the tier:*
            // label (and absence of pin:operator) per row via
            // `ctx.issues.get()` below, exactly like `describeIssue` does.
            // : incremental scan on this pass's own watermark.
            const labelOnlyFiringStartMs = Date.now();
            const labelOnlySinceIso = new Date(
              await readScanMark(company.id, PLUGIN_STATE_KEYS.labelOnlyLastScanAt),
            ).toISOString();
            const candidateRows = (await ctx.db.query(
              `select i.id::text as id,
                      i.identifier as identifier,
                      i.status as status,
                      coalesce(a.adapter_config->>'model','') as floor_model,
                      i.updated_at as updated_at
                 from issues i
                 join agents a on a.id = i.assignee_agent_id
                where i.company_id = $1
                  and i.status in ('todo','in_progress','blocked','in_review')
                  and a.status <> 'terminated'
                  -- : a user-assigned card rejects issues.update
                  -- with an agent override ("Issue can only have one
                  -- assignee"), which used to abort the whole pass.
                  and i.assignee_user_id is null
                  and i.updated_at > $3
                  and (i.assignee_adapter_overrides is null
                       or i.assignee_adapter_overrides->'adapterConfig'->>'model' is null)
                  and not exists (
                    select 1 from heartbeat_runs r
                     where r.status in ('running','queued')
                       and r.context_snapshot->>'issueId' = i.id::text
                  )
                order by i.updated_at asc
                limit $2`,
              [company.id, String(LABEL_ONLY_PASS_FETCH_LIMIT), labelOnlySinceIso],
            )) as unknown[];
            if (candidateRows.length === 0) {
              ctx.logger.info("label-only pass skipped: no issues changed since last scan", {
                companyId: company.id,
                since: labelOnlySinceIso,
              });
              await writeScanMark(company.id, PLUGIN_STATE_KEYS.labelOnlyLastScanAt, labelOnlyFiringStartMs);
              continue;
            }

            // . Read fresh, right before the floor-equality check
            // below — not reused from `advise()`'s own internal read — so a
            // lane that went bad between that internal read and this pass's
            // write decision is still caught.
            const laneLedger = await readLaneLedger(company.id);
            const laneOutageOverride = await readLaneOutage(company.id);
            const modelScores = await readModelScores(company.id);
            const nowIso = new Date().toISOString();

            // . One memo per company per pass: `advise` re-describes
            // the rows that survive the cheap rejections, and without this it
            // would repeat their `heartbeat_runs` read.
            const contextUsageCache: ContextUsageCache = new Map();

            let pinned = 0;
            //  / : the shared hard-return walk
            // (`row-walk.ts`). The 2026-09-28 reopen: a between-row deadline
            // check cannot contain an already-admitted slow row — 
            // spent ~98 s inside host calls AFTER the host's 300 s wall had
            // fired. The walk owns adaptive admission, the hard return (the
            // WHOLE row body below — `describeIssue` included — races the
            // remaining budget) and the per-firing ROW CAP: eight rows bound
            // the worst case below the 200 s budget at the slowest observed
            // row cost, and the scan cursor carries the excess to the next
            // firing. Every write sits behind the write gate.
            const walk = await walkRowsWithinDeadline(
              candidateRows,
              {
                deadlineAt,
                rowTimeoutMs: LABEL_ONLY_PASS_ROW_TIMEOUT_MS,
                maxRows: LABEL_ONLY_PASS_MAX_ROWS_PER_FIRING,
                slowestRowMs,
              },
              async (row, rowStartedAt) => {
                const r = asRecord(row);
                const issueId = typeof r.id === "string" ? r.id : null;
                const identifier = typeof r.identifier === "string" ? r.identifier : issueId;
                if (!issueId) return "settled";

                const described = await describeIssue(company.id, issueId, {}, contextUsageCache);
                if (!described) return "settled";
                if (described.hasOperatorPin) return "settled";
                // : backstop for the `assignee_user_id is null`
                // predicate above — a user-assigned card rejects issues.update
                // with an agent override ("Issue can only have one assignee").
                if (described.assigneeUserId) return "settled";
                const labelTier = tierFromLabels(described.descriptor.labelNames);
                const tier = tierWithFallback(described.descriptor, config.models, config.selection.defaultTier);
                const result = await advise(company.id, { issueId }, false, undefined, false, contextUsageCache);
                if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) {
                  // A row the walk abandoned must not write even its notice.
                  if (Date.now() >= deadlineAt) return "unsettled";
                  ctx.logger.info("label-only pass: no pick", { companyId: company.id, issue: identifier, tier });
                  //  AC3: a card the router cannot pin must be visible
                  // on its own activity feed, not just in this worker's log.
                  await maybeLogUnpinnableCard(company.id, issueId, identifier, result?.decision ?? null);
                  return "settled";
                }
                // Designated agents are exempt from router pinning: leave the
                // agent's own model in charge. Only a serviceability hard stop
                // may still write (unpinned rows have no pin, so this always
                // skips here — the exception lives in the repin passes).
                if (result.isAgentExempt && !result.isServiceabilityHardStop) {
                  ctx.logger.info("label-only pass skipped: agent exempt", {
                    companyId: company.id,
                    issue: identifier,
                    tier,
                  });
                  return "settled";
                }
                const floorModelId = resolveConfiguredModelId(result.agentFloorModelId, config.models);
                if (
                  result.decision.modelId === floorModelId &&
                  isUsableAndCapable(
                    floorModelId,
                    tier,
                    described.descriptor.requiredContextTokens,
                    config,
                    laneLedger,
                    laneOutageOverride,
                    modelScores,
                    nowIso,
                  )
                ) {
                  // : elide only while the floor is actually serviceable.
                  // An implicit NULL-override pin to a dead-lane floor is exactly
                  // the invariant violation this pass exists to close, and a
                  // NULL override is invisible to `repinPass` going forward.
                  ctx.logger.info("label-only pass skipped: pick equals healthy floor", {
                    companyId: company.id,
                    issue: identifier,
                    tier,
                  });
                  return "settled";
                }

                //  P2: candidate-carrying recovery (see the apply path).
                const selectedModel = recoverSelectedCandidate(config.models, result.decision);
                if (!selectedModel) return "settled";
                if (Date.now() >= deadlineAt || Date.now() - rowStartedAt >= LABEL_ONLY_PASS_ROW_TIMEOUT_MS) {
                  //  reopen: this row's own host calls consumed the
                  // budget — committing the pin now would write a mutation the
                  // host's RPC response can never carry (the orphaned-write half
                  // of the 2026-09-28 11:00Z incident), and a row the walk
                  // abandoned lands here too. Skip the write: the row is
                  // `unsettled`, the cursor stops before it, and next firing
                  // re-attempts it from live state. Logger-visible, never
                  // activity: a skip is routine flow control.
                  ctx.logger.warn("label-only pass skipped slow row write: row exceeded its time slice", {
                    companyId: company.id,
                    issue: identifier,
                    tier,
                    rowDurationMs: Date.now() - rowStartedAt,
                    rowTimeoutMs: LABEL_ONLY_PASS_ROW_TIMEOUT_MS,
                  });
                  return "unsettled";
                }
                // : the label-only pass previously wrote whatever
                // `advise()` returned with no re-check — a quarantine landing
                // between select and write pinned straight into a dead lane.
                // Write branch only (an advisory install writes nothing); an
                // unwritten row remains retryable and never counts as pinned.
                if (
                  writesAllowed &&
                  config.pacing.mode !== "off" &&
                  !(await writeStillSafeFromQuarantine(company.id, selectedModel))
                ) {
                  ctx.logger.info("label-only pass skipped: quarantine landed on the selected lane after select", {
                    companyId: company.id,
                    issue: identifier,
                    modelId: selectedModel.id,
                    laneId: selectedModel.laneId ?? null,
                  });
                  return "unsettled";
                }
                // The quarantine read can outlive the row's slice or the walk.
                if (Date.now() >= deadlineAt || Date.now() - rowStartedAt >= LABEL_ONLY_PASS_ROW_TIMEOUT_MS) {
                  return "unsettled";
                }
                // : one bad card must not abort the pass (and skip the
                // scan-mark advance below, re-hitting the same card forever).
                if (writesAllowed) {
                  try {
                    const labelOnlyPatch = modelOverrideForContext({
                      model: selectedModel,
                      agentEnvContextTokens: config.selection.agentEnvContextTokens,
                      compactionRatio: config.selection.compactionRatio,
                      agentEnv: described.agentEnv,
                      agentAdapterType: described.agentAdapterType,
                      agentAdapterConfig: described.agentAdapterConfig,
                      existingOverrideEnv: described.existingOverrideEnv,
                      // : haiku-class sub-call keys follow the cheapest
                      // healthy T3 pick (falls back to the pin when none).
                      cheapModelId: result.ancillaryModelId,
                      provenance: fallbackPinProvenance(selectedModel, described.assigneeAgentId),
                    });
                    await ctx.issues.update(issueId, labelOnlyPatch as Parameters<typeof ctx.issues.update>[1], company.id);
                    await recordFallbackPin(company.id, issueId, labelOnlyPatch);
                  } catch (cause) {
                    ctx.logger.warn("label-only pass skipped a card it could not pin", {
                      companyId: company.id,
                      issue: identifier,
                      error: cause instanceof Error ? cause.message : String(cause),
                    });
                    return "settled";
                  }
                } else {
                  ctx.logger.info("label-only pass advisory: would pin, nothing written", {
                    companyId: company.id,
                    issue: identifier,
                    tier,
                    modelId: result.decision.modelId,
                  });
                }
                await ctx.activity.log({
                  companyId: company.id,
                  message:
                    result.decision.modelId === floorModelId
                      ? `Model Selection explicitly pinned ${result.decision.modelId} (${tier}): floor lane unserviceable${advisorySuffix}`
                      : `Model Selection label-only pinned ${result.decision.modelId} (${tier}) from ${
                          labelTier ? "the existing tier label" : "the tier floor/default (no tier label present)"
                        }${advisorySuffix}`,
                  entityType: "issue",
                  entityId: issueId,
                  //  P2: the served leg of the v2 identity (null on legacy).
                  metadata: { modelId: result.decision.modelId, tier, fromLabel: labelTier !== null, trace: result.decision.trace, candidateId: selectedModel.candidateId, ...(writesAllowed ? {} : { advisory: true, written: false }) },
                });
                if (writesAllowed) pinned += 1;
                return "settled";
              },
            );
            slowestRowMs = walk.slowestRowMs;
            if (walk.abandoned) {
              const abandoned = asRecord(walk.abandoned.row);
              ctx.logger.warn("label-only pass abandoned a slow row at the deadline", {
                companyId: company.id,
                issue: typeof abandoned.identifier === "string" ? abandoned.identifier : abandoned.id,
                rowDurationMs: walk.abandoned.rowDurationMs,
              });
            }

            await advanceScanCursor(
              company.id,
              PLUGIN_STATE_KEYS.labelOnlyLastScanAt,
              candidateRows,
              walk.settledPrefix,
              LABEL_ONLY_PASS_FETCH_LIMIT,
              labelOnlyFiringStartMs,
            );
            ctx.logger.info("label-only pass complete", {
              companyId: company.id,
              pinned,
              candidates: candidateRows.length,
              examined: walk.examined.length,
              skippedSlowRows: walk.unsettled,
              slowestRowMs: walk.slowestRowMs,
              rowCapHit: walk.rowCapHit,
              budgetExhausted: walk.budgetExhausted,
              jobDurationMs: Date.now() - jobStartedAt,
            });
            // The row cap is per company; only an exhausted budget ends the
            // firing for every company after this one.
            if (walk.budgetExhausted) break;
          } catch (cause) {
            ctx.logger.error("label-only pass failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
      });

      // --- scheduled repin pass (, tier_dispatcher.py repin_pass()) --
      // Idle issues pinned to a model whose lane is now unusable, or that has
      // been measurably demoted for their tier, get re-pinned within the same
      // tier. Capped at REPIN_PASS_WRITE_LIMIT writes per run, same as the
      // Python source's `limit=6` default.
      /**
       * One company's repin sweep.
       *
       * Extracted from the job callback (same pattern and same reason as
       * `runAaIndexRefresh`) so 's `agent.run.failed` handler can run
       * the identical sweep for the affected company the moment a lane
       * rejects a run, instead of waiting out the remainder of the
       * ten-minute cron. There is exactly one repin rule and it lives here.
       *
       * : the scheduled job passes its incremental watermark
       * (`sinceIso` + `firingStartMs`) so the scan covers only issues updated
       * since the last firing, plus the firing's  `deadlineAt`. The
       * reactive `agent.run.failed` caller passes none of it — a lane
       * rejection must sweep the full candidate set immediately, never a
       * cursor-narrowed or deadline-cut one.
       */
      const runRepinPassForCompany = async (
        companyId: string,
        incremental?: { sinceIso: string; firingStartMs: number; deadlineAt: number; slowestRowMs: number },
      ): Promise<{ repinned: number; budgetExhausted: boolean; slowestRowMs: number }> => {
        const company = { id: companyId };
        let repinnedTotal = 0;
        let budgetExhausted = false;
        let repinSlowestRowMs = incremental?.slowestRowMs ?? 0;
        {
          try {
            const config = await companyConfig(company.id);
            if (!config.classification.enabled) return { repinned: 0, budgetExhausted: false, slowestRowMs: repinSlowestRowMs };
            // : the repin passes (scheduled and `agent.run.failed`)
            // are retired once run-scoped decisions are live: capacity is read
            // at the next run boundary instead.
            if (runResolveActive(config)) return { repinned: 0, budgetExhausted: false, slowestRowMs: repinSlowestRowMs };
            // : advisory installs walk the same rows and log the
            // same decisions, but write no override.
            const writesAllowed = selectionWritesAllowed(config);
            const advisorySuffix = writesAllowed ? "" : " — advisory, nothing written";
            // : this pass had NO job budget — it walked up to 400
            // fetched rows bounded only by the 6-write cap, and failed 2/24
            // firings at 301 s over the last 4 h. The scheduled caller passes
            // the firing's deadline (200 s beneath the host's 300 s wall);
            // the reactive `agent.run.failed` caller passes none (a lane
            // rejection must sweep the full candidate set immediately), so it
            // keeps the old unbounded shape.
            const repinJobStartedAt = Date.now();
            const repinDeadlineAt: number | null = incremental ? incremental.deadlineAt : null;

            const candidateRows = (await ctx.db.query(
              `select i.id::text as id,
                      i.identifier as identifier,
                      i.status as status,
                      i.updated_at as updated_at
                 from issues i
                 join agents a on a.id = i.assignee_agent_id
                where i.company_id = $1
                  and i.status in ('todo','in_progress','blocked','in_review')
                  and a.status <> 'terminated'
                  and i.assignee_adapter_overrides->'adapterConfig'->>'model' is not null
                  ${incremental ? "and i.updated_at > $3" : ""}
                  and not exists (
                    select 1 from heartbeat_runs r
                     where r.status in ('running','queued')
                       and r.context_snapshot->>'issueId' = i.id::text
                  )
                order by i.updated_at asc
                limit $2`,
              incremental
                ? [company.id, String(REPIN_PASS_FETCH_LIMIT), incremental.sinceIso]
                : [company.id, String(REPIN_PASS_FETCH_LIMIT)],
            )) as unknown[];
            if (incremental && candidateRows.length === 0) {
              ctx.logger.info("repin pass skipped: no issues changed since last scan", {
                companyId: company.id,
                since: incremental.sinceIso,
              });
              await writeScanMark(company.id, PLUGIN_STATE_KEYS.repinLastScanAt, incremental.firingStartMs);
              return { repinned: 0, budgetExhausted: false, slowestRowMs: repinSlowestRowMs };
            }

            const laneLedger = await readLaneLedger(company.id);
            const laneOutageOverride = await readLaneOutage(company.id);
            const modelScores = await readModelScores(company.id);
            const nowIso = new Date().toISOString();
            const nowMs = Date.parse(nowIso);
            // : the pin lifecycle's clock, read once per pass.
            const pinPinnedAt = await readPinPinnedAt(company.id);

            // . One memo per company per pass: `advise` re-describes
            // the rows that survive the cheap rejections, and without this it
            // would repeat their `heartbeat_runs` read.
            const contextUsageCache: ContextUsageCache = new Map();

            let repinned = 0;
            // : the write gate. A row whose own host calls consumed
            // the budget — or burned more than its own row slice, same
            // per-row-slice half as the label-only and balance gates —
            // commits no mutation past the deadline: the orphaned-write half
            // of the incident, and what stops a row the walk abandoned from
            // committing. The row is `unsettled`: the cursor stops before it
            // and next firing re-attempts it from live state. No deadline
            // (reactive path) never gates.
            const rowSliceSpent = (rowStartedAt: number): boolean =>
              repinDeadlineAt !== null &&
              (Date.now() >= repinDeadlineAt || Date.now() - rowStartedAt >= REPIN_PASS_ROW_TIMEOUT_MS);
            // : the shared hard-return walk (`row-walk.ts`). The
            // WHOLE row body — describe, the clear-on-blocked write, the
            // context measurement and the advise — races the remaining
            // budget; `deadlineAt: null` (reactive path) walks unbounded.
            const walk = await walkRowsWithinDeadline(
              candidateRows,
              {
                deadlineAt: repinDeadlineAt,
                rowTimeoutMs: REPIN_PASS_ROW_TIMEOUT_MS,
                slowestRowMs: incremental?.slowestRowMs,
              },
              async (row, rowStartedAt) => {
                const r = asRecord(row);
                const issueId = typeof r.id === "string" ? r.id : null;
                const identifier = typeof r.identifier === "string" ? r.identifier : issueId;
                if (!issueId) return "settled";

                const described = await describeIssue(company.id, issueId, {}, contextUsageCache);
                if (!described) return "settled";
                //  (#457, merged): preserve manual pins and active
                // runs with the idle guard — a non-idle card is not repinnable.
                if (described.hasOperatorPin || !described.isIdle) return "settled";
                const tier = tierWithFallback(described.descriptor, config.models, config.selection.defaultTier);

                const pinnedModelId = resolveConfiguredModelId(described.descriptor.pinnedModelId, config.models);
                //  (a) clear-on-blocked: a blocked card needs no lane
                // reservation — clear the pin instead of re-pinning it. Runs
                // before the usability check so a blocked card never spends
                // the advise call either. Operator pins are already exempt
                // above; the write shares REPIN_PASS_WRITE_LIMIT with repins.
                // Designated agents are exempt too: an exempt card keeps its
                // pin (usually none — the router never pinned it) even when
                // blocked; only a hard-stop repin below may move it.
                if (described.status === "blocked") {
                  if (isAgentExempt(described.assigneeAgentId, config)) return "settled";
                  if (rowSliceSpent(rowStartedAt)) {
                    ctx.logger.warn("repin pass skipped slow row write: row exceeded its time slice", {
                      companyId: company.id,
                      issue: identifier,
                      tier,
                      rowDurationMs: Date.now() - rowStartedAt,
                      rowTimeoutMs: REPIN_PASS_ROW_TIMEOUT_MS,
                    });
                    return "unsettled";
                  }
                  // : clearing a pin mutates a selection variable like
                  // any other write — advisory reports it without doing it.
                  if (writesAllowed) {
                    await ctx.issues.update(
                      issueId,
                      { assigneeAdapterOverrides: null } as Parameters<typeof ctx.issues.update>[1],
                      company.id,
                    );
                    await recordPinTimestamp(company.id, issueId, null);
                    await recordFallbackPin(company.id, issueId, null);
                  } else {
                    ctx.logger.info("repin pass advisory: would clear pin, nothing written", {
                      companyId: company.id,
                      issue: identifier,
                      tier,
                    });
                  }
                  await ctx.activity.log({
                    companyId: company.id,
                    message: `Model Selection cleared pin on ${identifier ?? issueId} (blocked): lane reservation released${advisorySuffix}`,
                    entityType: "issue",
                    entityId: issueId,
                    metadata: { from: pinnedModelId, modelId: null, tier, reason: "clear-on-blocked", ...(writesAllowed ? {} : { advisory: true, written: false }) },
                  });
                  if (writesAllowed) repinned += 1;
                  return repinned >= REPIN_PASS_WRITE_LIMIT ? "stop" : "settled";
                }
                // First point in the pass that actually needs the measurement —
                // every candidate rejected above cost zero `heartbeat_runs` reads.
                const usage = await described.contextUsage(config.selection.contextRunLogRoot);
                const contextEstimate = estimateIssueContext({
                  lastRunPeakTokens: usage.lastRunPeakTokens,
                  history: usage.history,
                  fleetCeilingTokens: config.selection.fleetContextCeilingTokens,
                });
                described.descriptor.requiredContextTokens = contextEstimate.tokens ?? undefined;
                //  (b) 24h expiry: a stale pin is re-validated through
                // `advise` even when the pinned lane still reads usable. Only
                // the usability early return is skipped — everything below
                // (fresh advise, same-model no-op, capability re-check) still
                // applies, so expiry can only ever re-affirm or move the pin,
                // never blank it.
                const pinExpired = isPinExpired(pinPinnedAt, issueId, nowMs);
                // : a usable fallback-only pin must not ride the
                // usability `return` below forever. While every normal lane
                // is down the fallback is the right place to be (and holding
                // it costs zero advise calls); once any non-fallback model is
                // usable and capable at this tier again, fall through to the
                // guarded advise path so the card moves back. The advise,
                // same-model, capability, and write-safety gates below stay
                // the deciders — this only re-opens the question.
                const pinnedIsFallbackOnly =
                  config.models.find((model) => model.id === pinnedModelId)?.fallbackOnly === true;
                const hasRecoveredNormal =
                  pinnedIsFallbackOnly &&
                  config.models.some(
                    (model) =>
                      !model.fallbackOnly &&
                      isUsableAndCapable(
                        model.id,
                        tier,
                        described.descriptor.requiredContextTokens,
                        config,
                        laneLedger,
                        laneOutageOverride,
                        modelScores,
                        nowIso,
                      ),
                  );
                if (
                  !pinExpired &&
                  !hasRecoveredNormal &&
                  isUsableAndCapable(
                    pinnedModelId,
                    tier,
                    described.descriptor.requiredContextTokens,
                    config,
                    laneLedger,
                    laneOutageOverride,
                    modelScores,
                    nowIso,
                  )
                ) {
                  return "settled";
                }

                //  (#457, merged): carry the tier into advise so a
                // deliberate repin keeps the caller's effective tier even
                // when the old pin's lane is dead.
                const result = await advise(company.id, { issueId }, false, tier, true, contextUsageCache);
                if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) return "settled";
                // Designated agents are exempt from router pinning: leave the
                // pin alone. A serviceability hard stop still repins, so an
                // exempt agent never fails on a dead lane.
                if (result.isAgentExempt && !result.isServiceabilityHardStop) {
                  ctx.logger.info("repin pass skipped: agent exempt", {
                    companyId: company.id,
                    issue: identifier,
                    tier,
                  });
                  return "settled";
                }
                if (result.decision.modelId === pinnedModelId) {
                  //  (b): an expired pin the fresh advise re-affirms is
                  // still alive — re-stamp it so the next pass does not pay
                  // for the same re-validation again. No issue write, so no
                  // write-limit cost; still no write past the deadline.
                  if (pinExpired) {
                    if (repinDeadlineAt !== null && Date.now() >= repinDeadlineAt) return "unsettled";
                    await recordPinTimestamp(company.id, issueId, nowIso);
                  }
                  return "settled";
                }
                if (
                  !isUsableAndCapable(
                    result.decision.modelId,
                    tier,
                    described.descriptor.requiredContextTokens,
                    config,
                    laneLedger,
                    laneOutageOverride,
                    modelScores,
                    nowIso,
                  )
                ) {
                  return "settled";
                }

                //  P2: candidate-carrying recovery (see the apply path).
                const selectedModel = recoverSelectedCandidate(config.models, result.decision);
                if (!selectedModel) return "settled";
                // : recovery moves back to a normal lane, never
                // sideways to another fallback-only row — that churn buys no
                // recovery. Re-stamp an expired pin so the sideways case does
                // not re-pay advise on every pass, mirroring the same-model
                // branch above.
                if (pinnedIsFallbackOnly && selectedModel.fallbackOnly) {
                  if (pinExpired) {
                    if (repinDeadlineAt !== null && Date.now() >= repinDeadlineAt) return "unsettled";
                    await recordPinTimestamp(company.id, issueId, nowIso);
                  }
                  return "settled";
                }
                if (rowSliceSpent(rowStartedAt)) {
                  // (order: deadline first — a spent row never pays the
                  // re-read below; both guards skip the write.)
                  ctx.logger.warn("repin pass skipped slow row write: row exceeded its time slice", {
                    companyId: company.id,
                    issue: identifier,
                    tier,
                    rowDurationMs: Date.now() - rowStartedAt,
                    rowTimeoutMs: REPIN_PASS_ROW_TIMEOUT_MS,
                  });
                  return "unsettled";
                }
                //  (#457, merged): final write-safety re-read — the
                // pin must still be safe after the row's own host calls.
                if (!(await balanceWriteStillSafe(company.id, issueId, pinnedModelId, config.models))) return "settled";
                // : the write needs enforcement; the decision and its
                // log do not.
                if (writesAllowed) {
                  // : the decision above was computed on snapshots read
                  // up to a full pass-loop ago; refuse to land it on a lane a
                  // quarantine written since has taken out. Write branch only,
                  // and an unwritten row remains retryable, never re-pinned.
                  if (config.pacing.mode !== "off" && !(await writeStillSafeFromQuarantine(company.id, selectedModel))) {
                    ctx.logger.info("repin pass skipped: quarantine landed on the selected lane after select", {
                      companyId: company.id,
                      issue: identifier,
                      modelId: selectedModel.id,
                      laneId: selectedModel.laneId ?? null,
                    });
                    return "unsettled";
                  }
                  if (rowSliceSpent(rowStartedAt)) return "unsettled";
                  const repinPatch = modelOverrideForContext({
                    model: selectedModel,
                    agentEnvContextTokens: config.selection.agentEnvContextTokens,
                    compactionRatio: config.selection.compactionRatio,
                    agentEnv: described.agentEnv,
                    agentAdapterType: described.agentAdapterType,
                    agentAdapterConfig: described.agentAdapterConfig,
                    existingOverrideEnv: described.existingOverrideEnv,
                    cheapModelId: result.ancillaryModelId,
                    provenance: fallbackPinProvenance(selectedModel, described.assigneeAgentId),
                  });
                  await ctx.issues.update(issueId, repinPatch as Parameters<typeof ctx.issues.update>[1], company.id);
                  await recordPinTimestamp(company.id, issueId, nowIso);
                  await recordFallbackPin(company.id, issueId, repinPatch);
                } else {
                  ctx.logger.info("repin pass advisory: would re-pin, nothing written", {
                    companyId: company.id,
                    issue: identifier,
                    tier,
                    from: pinnedModelId,
                    modelId: result.decision.modelId,
                  });
                }
                await ctx.activity.log({
                  companyId: company.id,
                  message: `Model Selection re-pinned ${pinnedModelId} -> ${result.decision.modelId} (${tier}): ${pinExpired ? "pin expired, re-validated" : hasRecoveredNormal ? "fallback lane recovered; normal lane serviceable again" : "lane unusable or measurably demoted"}${advisorySuffix}`,
                  entityType: "issue",
                  entityId: issueId,
                  //  P2: the served leg of the v2 identity (null on legacy).
                  metadata: { from: pinnedModelId, modelId: result.decision.modelId, tier, trace: result.decision.trace, candidateId: selectedModel.candidateId, ...(writesAllowed ? {} : { advisory: true, written: false }) },
                });
                if (writesAllowed) repinned += 1;
                return repinned >= REPIN_PASS_WRITE_LIMIT ? "stop" : "settled";
              },
            );
            repinSlowestRowMs = walk.slowestRowMs;
            if (walk.abandoned) {
              const abandoned = asRecord(walk.abandoned.row);
              ctx.logger.warn("repin pass abandoned a slow row at the deadline", {
                companyId: company.id,
                issue: typeof abandoned.identifier === "string" ? abandoned.identifier : abandoned.id,
                rowDurationMs: walk.abandoned.rowDurationMs,
              });
            }

            repinnedTotal = repinned;
            budgetExhausted = walk.budgetExhausted;
            if (incremental) {
              await advanceScanCursor(
                company.id,
                PLUGIN_STATE_KEYS.repinLastScanAt,
                candidateRows,
                walk.settledPrefix,
                REPIN_PASS_FETCH_LIMIT,
                incremental.firingStartMs,
              );
            }
            ctx.logger.info("repin pass complete", {
              companyId: company.id,
              repinned,
              candidates: candidateRows.length,
              examined: walk.examined.length,
              skippedSlowRows: walk.unsettled,
              slowestRowMs: walk.slowestRowMs,
              budgetExhausted: walk.budgetExhausted,
              jobDurationMs: Date.now() - repinJobStartedAt,
            });
          } catch (cause) {
            ctx.logger.error("repin pass failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
        return { repinned: repinnedTotal, budgetExhausted, slowestRowMs: repinSlowestRowMs };
      };

      /**
       *  ( §7 item 4). The fallback lease.
       *
       * A pin on a `fallbackOnly` model is a stopgap taken because no regular
       * model was serviceable. The repin pass leaves a usable pin alone for
       * 24 h (`PIN_MAX_AGE_MS`), so without this a card stays on the fallback
       * for up to a day after its primary comes back. This pass re-decides a
       * stamped fallback pin as soon as some regular model for its tier is
       * serviceable again, and touches nothing else: it walks only the
       * stamped-issue index (never all open issues, ), examines at
       * most `FALLBACK_LEASE_EXAMINE_LIMIT` entries, least recently checked
       * first, and writes at most `FALLBACK_LEASE_WRITE_LIMIT` pins.
       *
       * An entry whose issue is gone, closed, operator-held, no longer on a
       * roster model, or carries a different stamp than the index recorded
       * (re-pinned since, or never stamped) is dropped: the stamp on the
       * issue is the authority, the index only points at it.
       */
      const runFallbackLeasePass = async (companyId: string): Promise<number> => {
        let released = 0;
        try {
          const indexed = Object.entries(await readFallbackPins(companyId));
          if (indexed.length === 0) return 0;
          const config = await companyConfig(companyId);
          if (!config.classification.enabled) return 0;
          // : the lease release re-pins the card off the fallback,
          // so it takes the same single gate as every other override write.
          // Advisory installs walk the index and log the release; the lease
          // holds (the pin and its index entry stay, the visit is recorded).
          const writesAllowed = selectionWritesAllowed(config);
          const advisorySuffix = writesAllowed ? "" : " — advisory, nothing written";

          const laneLedger = await readLaneLedger(companyId);
          const laneOutageOverride = await readLaneOutage(companyId);
          const modelScores = await readModelScores(companyId);
          const nowIso = new Date().toISOString();
          const contextUsageCache: ContextUsageCache = new Map();
          const primaries = applyDerivedTiers(config.models, modelScores).filter(
            (model) => model.enabled && !model.fallbackOnly,
          );

          const dropped = new Map<string, string>();
          const checked = new Map<string, string>();
          indexed.sort(
            ([, a], [, b]) =>
              (a.checkedAt ?? "").localeCompare(b.checkedAt ?? "") || a.decidedAt.localeCompare(b.decidedAt),
          );
          for (const [issueId, entry] of indexed.slice(0, FALLBACK_LEASE_EXAMINE_LIMIT)) {
            if (released >= FALLBACK_LEASE_WRITE_LIMIT) break;
            const described = await describeIssue(companyId, issueId, {}, contextUsageCache);
            const stamp = described ? readPinProvenance(described.existingOverrideEnv) : null;
            const pinnedModelId = described
              ? resolveConfiguredModelId(described.descriptor.pinnedModelId, config.models)
              : null;
            if (
              !described ||
              stamp?.decisionId !== entry.decisionId ||
              !pinnedModelId ||
              described.hasOperatorPin ||
              !balanceOpenStatuses.has(described.status)
            ) {
              dropped.set(issueId, entry.decisionId);
              continue;
            }
            // Designated agents are exempt from router pinning: stop tracking
            // the lease without writing — the release would move the pin.
            if (isAgentExempt(described.assigneeAgentId, config)) {
              dropped.set(issueId, entry.decisionId);
              continue;
            }
            checked.set(issueId, entry.decisionId);
            // Blocked cards are the repin pass's: it releases their pin.
            if (!described.isIdle || described.status === "blocked") continue;

            const tier = tierWithFallback(described.descriptor, config.models, config.selection.defaultTier);
            const usage = await described.contextUsage(config.selection.contextRunLogRoot);
            described.descriptor.requiredContextTokens =
              estimateIssueContext({
                lastRunPeakTokens: usage.lastRunPeakTokens,
                history: usage.history,
                fleetCeilingTokens: config.selection.fleetContextCeilingTokens,
              }).tokens ?? undefined;
            const usable = (modelId: string) =>
              isUsableAndCapable(
                modelId,
                tier,
                described.descriptor.requiredContextTokens,
                config,
                laneLedger,
                laneOutageOverride,
                modelScores,
                nowIso,
              );
            // The lease holds while no regular model can take the card.
            if (!primaries.some((model) => usable(model.id))) continue;

            const result = await advise(companyId, { issueId }, false, tier, true, contextUsageCache);
            if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) continue;
            const selectedModel = config.models.find((model) => model.id === result.decision.modelId);
            if (!selectedModel || selectedModel.fallbackOnly || selectedModel.id === pinnedModelId) continue;
            if (!usable(selectedModel.id)) continue;
            if (!(await balanceWriteStillSafe(companyId, issueId, pinnedModelId, config.models))) continue;

            const patch = modelOverrideForContext({
              model: selectedModel,
              agentEnvContextTokens: config.selection.agentEnvContextTokens,
              compactionRatio: config.selection.compactionRatio,
              agentEnv: described.agentEnv,
              agentAdapterType: described.agentAdapterType,
              agentAdapterConfig: described.agentAdapterConfig,
              existingOverrideEnv: described.existingOverrideEnv,
              cheapModelId: result.ancillaryModelId,
              provenance: null,
            });
            // : `advise` already refuses advisory decisions for
            // writes that flow through `planApply`; this pass writes
            // directly, so it honors the same gate here. The index entry is
            // dropped only with the write: an unwritten release keeps the
            // lease findable, and the visit is still recorded via `checked`.
            if (writesAllowed) {
              await ctx.issues.update(issueId, patch as Parameters<typeof ctx.issues.update>[1], companyId);
              dropped.set(issueId, entry.decisionId);
              await recordPinTimestamp(companyId, issueId, nowIso);
            } else {
              ctx.logger.info("fallback lease pass advisory: would release the fallback pin, nothing written", {
                companyId,
                issue: described.identifier ?? issueId,
                from: pinnedModelId,
                modelId: selectedModel.id,
                tier,
              });
            }
            await ctx.activity.log({
              companyId,
              message: `Model Selection moved ${described.identifier ?? issueId} off fallback ${pinnedModelId} -> ${selectedModel.id} (${tier}): primary serviceable again${advisorySuffix}`,
              entityType: "issue",
              entityId: issueId,
              metadata: {
                from: pinnedModelId,
                modelId: selectedModel.id,
                tier,
                decisionId: entry.decisionId,
                reason: "fallback-lease",
                trace: result.decision.trace,
                ...(writesAllowed ? {} : { advisory: true, written: false }),
              },
            });
            if (writesAllowed) released += 1;
          }

          // Apply this pass's edits to a fresh read, and only to entries that
          // still describe the decision this pass saw: a pin written while the
          // pass ran keeps its new entry.
          const latest = await readFallbackPins(companyId);
          for (const [issueId, decisionId] of dropped) {
            if (latest[issueId]?.decisionId === decisionId) delete latest[issueId];
          }
          for (const [issueId, decisionId] of checked) {
            const current = latest[issueId];
            if (current?.decisionId === decisionId) current.checkedAt = nowIso;
          }
          await ctx.state.set(fallbackPinsKey(companyId), latest);
          ctx.logger.info("fallback lease pass complete", { companyId, released, indexed: indexed.length });
        } catch (cause) {
          ctx.logger.error("fallback lease pass failed for a company", {
            companyId,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
        return released;
      };

      ctx.jobs.register(JOB_KEYS.repinPass, async () => {
        // : ONE budget for the whole firing — the host's 300 s
        // `runJob` wall covers the firing, not a company.
        const jobStartedAt = Date.now();
        const deadlineAt = jobStartedAt + REPIN_PASS_JOB_BUDGET_MS;
        // Admission is 1.5x the slowest row of the FIRING: it carries across companies.
        let slowestRowMs = 0;
        for (const company of listKnownCompanies()) {
          if (Date.now() >= deadlineAt) {
            ctx.logger.warn("repin pass stopped before the host RPC wall", {
              companyId: company.id,
              jobDurationMs: Date.now() - jobStartedAt,
            });
            break;
          }
          // : the scheduled firing scans incrementally; the reactive
          // `agent.run.failed` caller below passes no cursor (full sweep).
          const firingStartMs = Date.now();
          const sinceIso = new Date(await readScanMark(company.id, PLUGIN_STATE_KEYS.repinLastScanAt)).toISOString();
          const sweep = await runRepinPassForCompany(company.id, { sinceIso, firingStartMs, deadlineAt, slowestRowMs });
          slowestRowMs = sweep.slowestRowMs;
          if (sweep.budgetExhausted) break;
          // : independent of the incremental scan, which skips a
          // firing when no issue changed; a lane recovering changes no issue.
          await runFallbackLeasePass(company.id);
        }
      });

      //  /  Class B. An override `env` REPLACES the
      // assignee's env wholesale (host `mergeModelProfileAdapterConfig`), so a
      // pin written while the assignee carried a secret binding it has since
      // lost keeps naming that ref. The host then refuses every run on the card
      // with `configuration_incomplete` before a session starts, and rule 2 of
      // `planApply` (never touch an existing override) kept the pin poisoned
      // until a human cleared it. A failed run with that code is the evidence;
      // this rebuilds the override env from the CURRENT assignee env on the
      // SAME model. It never changes the model and never writes in advisory.
      // Idempotent: after one repair no stale key remains, so a second failure
      // for an unrelated missing binding writes nothing.
      const repairPinEnvAfterConfigFailure = async (
        companyId: string,
        issueId: string,
        runId: string | null,
      ): Promise<void> => {
        let result: Awaited<ReturnType<typeof advise>>;
        try {
          result = await advise(companyId, { issueId }, false);
        } catch {
          return;
        }
        if (!result || !result.hasOverride || result.decision.advisory) return;
        const staleSecretRefKeys = staleOverrideSecretRefKeys(result.existingOverrideEnv, result.agentEnv);
        const plan = planEnvRepair({ pinnedModelId: result.pinnedModelId, staleSecretRefKeys }, issueId);
        if (!plan?.modelId) return;
        const pinnedModel = result.config.models.find((model) => model.id === plan.modelId);
        if (!pinnedModel) {
          ctx.logger.warn("pin env repair skipped: pinned model is absent from the resolved roster", {
            companyId,
            issueId,
            modelId: plan.modelId,
          });
          return;
        }
        const patch: IssueUpdatePatch = modelOverrideForContext({
          model: pinnedModel,
          agentEnvContextTokens: result.config.selection.agentEnvContextTokens,
          compactionRatio: result.config.selection.compactionRatio,
          agentEnv: result.agentEnv,
          agentAdapterType: result.agentAdapterType,
          agentAdapterConfig: result.agentAdapterConfig,
          existingOverrideEnv: result.existingOverrideEnv,
          cheapModelId: result.ancillaryModelId,
        });
        try {
          await ctx.issues.update(issueId, patch as Parameters<typeof ctx.issues.update>[1], companyId);
        } catch (cause) {
          // : a card with a user assignee rejects an agent override.
          ctx.logger.warn("pin env repair write rejected", {
            companyId,
            issueId,
            error: cause instanceof Error ? cause.message : String(cause),
          });
          return;
        }
        await ctx.activity.log({
          companyId,
          message:
            `Model Selection repaired the env of its ${plan.modelId} pin on this issue (model unchanged): `
            + `a run failed configuration_incomplete on secret refs the assignee no longer carries.`,
          entityType: "issue",
          entityId: issueId,
          metadata: { modelId: plan.modelId, staleSecretRefKeys, runId, trigger: "agent.run.failed" },
        });
      };

      // --- : immediate lane quarantine from a rejected run ----------
      //
      // The owner directive after the 2026-09-16 Codex exhaustion: "paperclip
      // should be able to handle this without your intervention". The router
      // already picked the right replacement model for all 14 affected cards
      // — it just did not know the lane was dead for ~5m50s (the `pollLanes`
      // cadence) and did not act for ~10m after that (the `repinPass`
      // cadence). 21 runs launched into the gap.
      //
      // `agent.run.failed` carries `heartbeat_runs.error` verbatim
      // (`heartbeat.ts` `publishRunLifecyclePluginEvent`), which means the
      // lane's own rejection reaches this plugin within milliseconds. A
      // rejection at the point of use is better evidence than a telemetry
      // snapshot: there is no freshness question about it.
      //
      // Deliberate scope limit, stated so nobody reads more into this than it
      // does: the plugin event bus is fire-and-forget
      // (`activity-log.ts:47`, `void bus.emit(...)`), so NO plugin handler can
      // gate a dispatch. This shrinks the window in which a run can start on a
      // dead lane from ~15 minutes to the round trip of this handler; it
      // cannot close it to zero. Closing it to zero requires dispatch itself
      // to consult the ledger, which is core, not plugin.
      ctx.events.on("agent.run.failed", async (event) => {
        const payload = asRecord(event.payload);
        const companyId = event.companyId;
        const issueId = typeof payload.issueId === "string" ? payload.issueId : null;

        let config: Awaited<ReturnType<typeof companyConfig>>;
        try {
          config = await companyConfig(companyId);
        } catch {
          return;
        }
        if (config.models.length === 0) return;

        // Fold the failure into the earn-in ledger FIRST, before the
        // lane-exhaustion path below can `return` early (no verdict) or
        // quarantine-and-sweep. `classifyEarnInResolution` separates model
        // evidence (folds into the first-8 window) from infra noise (releases
        // the slot, moves nothing) — so a dead lane cannot spend a model's
        // earn-in window, and a flaky host cannot stop it. A card with no
        // active earn-in entry resolves to null and writes nothing.
        if (issueId) {
          try {
            await resolveEarnInForIssue(companyId, issueId, {
              runStatus: "failed",
              errorText: typeof payload.error === "string" ? payload.error : null,
              errorCode: typeof payload.errorCode === "string" ? payload.errorCode : null,
              rejected: false,
              // The served model when the failure names one (payload
              // model/modelId); else null — the active entry names it.
              modelId:
                typeof payload.model === "string"
                  ? payload.model
                  : typeof payload.modelId === "string"
                    ? payload.modelId
                    : null,
            });
          } catch (cause) {
            ctx.logger.error("earn-in resolve on run failure failed", {
              companyId,
              issueId,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }

        // . A binding refusal is never a lane-capacity verdict, so it
        // takes its own path and skips the lane read below entirely.
        if (payload.errorCode === "configuration_incomplete") {
          if (issueId) {
            await repairPinEnvAfterConfigFailure(
              companyId,
              issueId,
              typeof payload.runId === "string" ? payload.runId : null,
            );
          }
          return;
        }

        // Only consulted for rejections that name no model (an `errorCode`-only
        // `usage_limit_reached`). Read lazily so an ordinary run failure —
        // overwhelmingly the common case — costs zero extra queries.
        const fallbackModelId = async (): Promise<string | null> => {
          if (!issueId) return null;
          try {
            const described = await describeIssue(companyId, issueId, {});
            return described?.descriptor.pinnedModelId ?? null;
          } catch {
            return null;
          }
        };

        const quickVerdict = laneExhaustionFromRunFailure({
          error: typeof payload.error === "string" ? payload.error : null,
          errorCode: typeof payload.errorCode === "string" ? payload.errorCode : null,
          models: config.models,
        });
        const verdict = quickVerdict
          ?? laneExhaustionFromRunFailure({
            error: typeof payload.error === "string" ? payload.error : null,
            errorCode: typeof payload.errorCode === "string" ? payload.errorCode : null,
            models: config.models,
            fallbackModelId: await fallbackModelId(),
          });
        if (!verdict) return;

        const nowMs = Date.parse(event.occurredAt) || Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const existing = await readLaneOutage(companyId);

        // Storm control. An exhausted lane rejects every run on it, so this
        // handler fires once per failure — 21 times in the 2026-09-16
        // incident. Re-running the repin sweep for each would be pure waste:
        // the first one already moved every card off the lane. If the lane is
        // ALREADY inside an active outage window, record nothing and sweep
        // nothing; the quarantine is doing its job.
        if (isLaneOutageActive(existing, nowIso) && existing!.lanes.includes(verdict.laneId)) {
          ctx.logger.info("lane already quarantined, skipping repeat sweep", {
            companyId,
            laneId: verdict.laneId,
            until: existing!.until,
          });
          return;
        }

        const addition = autoQuarantineFor(verdict, nowMs);
        await ctx.state.set(laneOutageKey(companyId), mergeLaneOutage(existing, addition, nowIso));
        await ctx.activity.log({
          companyId,
          message:
            `Model Selection quarantined lane ${verdict.laneId} until ${addition.until}: a run was rejected `
            + `on ${verdict.modelId} with a lane-capacity error. Re-pinning open cards off this lane now.`,
          ...(issueId ? { entityType: "issue" as const, entityId: issueId } : {}),
          metadata: {
            laneId: verdict.laneId,
            modelId: verdict.modelId,
            until: addition.until,
            matchedPhrase: verdict.matchedPhrase,
            modelFromErrorText: verdict.modelFromErrorText,
            runId: typeof payload.runId === "string" ? payload.runId : null,
          },
        });

        const { repinned } = await runRepinPassForCompany(companyId);
        ctx.logger.info("lane quarantine repin complete", { companyId, laneId: verdict.laneId, repinned });
      });

      // --- scheduled balance pass (, tier_dispatcher.py
      // balance_pass()) ------------------------------------------------------
      // Owner rule 2026-09-05 23:05Z (spread across all accounts): idle cards
      // that carry a tier label but no override were left on the floor by the
      // old exclusion rule; give them a balanced T1-class pin instead. Also
      // re-pin idle cards whose pinned model has gone cost-down-eligible,
      // measurably incapable/on-probation/over-cap, or whose lane is now far
      // busier (>=0.25) than another usable lane in their tier. Capped at
      // BALANCE_PASS_WRITE_LIMIT writes per run, same as the Python source's
      // `limit=8` default.
      ctx.jobs.register(JOB_KEYS.balancePass, async () => {
        const companies = listKnownCompanies();
        const jobStartedAt = Date.now();
        const deadlineAt = jobStartedAt + BALANCE_PASS_JOB_BUDGET_MS;
        // : admission is 1.5x the slowest row of the FIRING, so the
        // slowest row carries from one company's walk into the next.
        let slowestRowMs = 0;
        for (const company of companies) {
          if (Date.now() >= deadlineAt) {
            ctx.logger.warn("balance pass stopped before the host RPC wall", {
              companyId: company.id,
              durationMs: Date.now() - jobStartedAt,
              budgetMs: BALANCE_PASS_JOB_BUDGET_MS,
            });
            break;
          }
          const startedAt = Date.now();
          try {
            const config = await companyConfig(company.id);
            if (!config.classification.enabled) continue;
            // : retired once run-scoped decisions are live.
            if (runResolveActive(config)) {
              ctx.logger.info("balance pass skipped: run-scoped model decisions are live", { companyId: company.id });
              continue;
            }
            // : advisory installs walk the same rows and log the
            // same decisions, but write no override.
            const writesAllowed = selectionWritesAllowed(config);
            const advisorySuffix = writesAllowed ? "" : " — advisory, nothing written";

            // : incremental gate — one aggregate row before the page
            // fetch. When nothing in the candidate statuses changed since the
            // last scan, the whole per-row cycle (describe + advise per card)
            // is skipped. The keyset id-cycle below is untouched: a skip
            // advances only the scan mark, never the page cursor, so no card
            // is ever skipped past. Fail-open: an unreadable aggregate runs
            // the cycle instead of skipping it.
            const balanceFiringStartMs = startedAt;
            const cursorKey = {
              scopeKind: "company" as const,
              scopeId: company.id,
              stateKey: PLUGIN_STATE_KEYS.balancePassCursor,
            };
            const storedCursor = asRecord(await ctx.state.get(cursorKey));
            const afterId = typeof storedCursor.afterId === "string" ? storedCursor.afterId : "";
            const balanceScanMarkMs = await readScanMark(company.id, PLUGIN_STATE_KEYS.balanceLastScanAt);
            // Null/unparseable aggregate (or a thrown read) = instrument
            // failure, not proof of quiet — fall through and run the cycle.
            const balanceMaxMs = await (async (): Promise<number | null> => {
              try {
                // Alias-free on purpose: the balance page query below matches
                // on `from issues i`, and test fakes (like production
                // readers) key row shapes off that alias. The aggregate
                // returns a different shape and must not be mistaken for a
                // page fetch.
                const maxRows = (await ctx.db.query(
                  `select max(updated_at) as max_updated
                     from issues
                    where company_id = $1
                      -- : the gate watches routable cards only, so a
                      -- user-assigned card changing cannot force a cycle that
                      -- would only skip it again.
                      and assignee_user_id is null
                      and status in ('todo','in_progress','blocked','in_review')`,
                  [company.id],
                )) as unknown[];
                const rawMax = asRecord(maxRows[0]).max_updated;
                if (rawMax instanceof Date) return rawMax.getTime();
                if (typeof rawMax === "string") {
                  const ms = Date.parse(rawMax);
                  return Number.isFinite(ms) ? ms : null;
                }
                return null;
              } catch {
                return null;
              }
            })();
            if (storedCursor.retryPending !== true && balanceMaxMs !== null && balanceMaxMs <= balanceScanMarkMs) {
              ctx.logger.info("balance pass skipped: no issues changed since last scan", {
                companyId: company.id,
                since: new Date(balanceScanMarkMs).toISOString(),
              });
              await writeScanMark(company.id, PLUGIN_STATE_KEYS.balanceLastScanAt, balanceFiringStartMs);
              continue;
            }

            const candidateRows = (await ctx.db.query(
              `select i.id::text as id,
                      i.identifier as identifier
                 from issues i
                 join agents a on a.id = i.assignee_agent_id
                where i.company_id = $1
                  and i.id::text > $2
                  and i.status in ('todo','in_progress','blocked','in_review')
                  and a.status <> 'terminated'
                  -- : a user-assigned card rejects issues.update
                  -- with an agent override ("Issue can only have one
                  -- assignee"), which used to abort the whole pass.
                  and i.assignee_user_id is null
                order by i.id::text asc
                limit $3`,
              [company.id, afterId, String(BALANCE_PASS_FETCH_LIMIT)],
            )) as unknown[];
            const activeRunIssueIds = await activeBalanceRunIssueIds(company.id);

            const laneLedger = await readLaneLedger(company.id);
            const laneOutageOverride = await readLaneOutage(company.id);
            const modelScores = await readModelScores(company.id);
            const nowIso = new Date().toISOString();
            const now = Date.now();

            // . One memo per company per pass: `advise` re-describes
            // the rows that survive the cheap rejections, and without this it
            // would repeat their `heartbeat_runs` read.
            const contextUsageCache: ContextUsageCache = new Map();

            let balanced = 0;
            //  pace-pull: per-pass, per-target-lane move accounting.
            // `pacePullWeights` is the active-pins weight snapshot the free-
            // slot caps are computed from, read lazily on the first pace-pull
            // candidate so passes with no behind lane pay no extra query;
            // `pacePullMoved` counts committed pace-pull writes per target lane
            // so the pass stops pulling toward a lane once its free slots at
            // first sight are spent.
            let pacePullWeights: Record<string, number> | null = null;
            let pacePullZaiMargin: number | null = null;
            const pacePullFreeSlots = new Map<string, number>();
            const pacePullMoved = new Map<string, number>();
            // : the whole row body runs inside the shared walk
            // (`row-walk.ts`) — adaptive admission (remaining budget must
            // cover the fixed slice AND 1.5x the slowest row this firing), a
            // HARD RETURN racing every host call of the row (describe,
            // advise, the probation/over-cap/evidence reads) against the job
            // deadline, and the write gate below, which also stops an
            // abandoned row's body from committing after the timer won.
            const isPastWriteDeadline = (rowStartedAt: number): boolean =>
              Date.now() >= deadlineAt || Date.now() - rowStartedAt >= BALANCE_PASS_ROW_TIMEOUT_MS;
            const walk = await walkRowsWithinDeadline(
              candidateRows,
              { deadlineAt, rowTimeoutMs: BALANCE_PASS_ROW_TIMEOUT_MS, slowestRowMs },
              async (row, rowStartedAt) => {
                const r = asRecord(row);
                const issueId = typeof r.id === "string" ? r.id : null;
                const identifier = typeof r.identifier === "string" ? r.identifier : issueId;
                if (!issueId) return "settled";
                if (activeRunIssueIds.has(issueId)) return "settled";

                const described = await describeIssue(company.id, issueId, {}, contextUsageCache);
                if (!described) return "settled";
                if (!balanceOpenStatuses.has(described.status)) return "settled";
                if (!described.isIdle) return "settled";
                if (described.hasOperatorPin) return "settled";
                // : backstop for the `assignee_user_id is null`
                // predicate above — a user-assigned card rejects issues.update
                // with an agent override ("Issue can only have one assignee").
                if (described.assigneeUserId) return "settled";
                const status = described.status;
                const labelTier = tierFromLabels(described.descriptor.labelNames);
                const pinnedModelId = resolveConfiguredModelId(described.descriptor.pinnedModelId, config.models);
                const pinnedModel = pinnedModelId ? config.models.find((m) => m.id === pinnedModelId) : undefined;
                // : the unpinned branch below force-pins T1 for a
                // *recorded* former-exclusion judgement (an explicit tier:*
                // label with no pin yet) — that is a floor-lift, not a
                // rebalance, and must stay gated on an actual label rather than
                // defaulting every bare unpinned+unlabelled idle card straight
                // to T1. Only the pinned branch gets the tierWithFallback
                // treatment: a card that already has a pin just needs SOME
                // tier bucket to run its capability/cost checks against, same
                // as labelOnlyPass/repinPass.
                if (!labelTier && !pinnedModelId) return "settled";
                const tier = labelTier ?? tierWithFallback(described.descriptor, config.models, config.selection.defaultTier);
                // A row that went slow anyway commits no routing mutation:
                // `unsettled` (still examined, so the id-cycle passes it and
                // re-reads its live state when the cycle wraps, with no hot
                // loop on one slow card).
                const skipSlowWrite = (logTier: string): "unsettled" => {
                  ctx.logger.warn("balance pass skipped slow row write: row exceeded its time slice", {
                    companyId: company.id,
                    issue: identifier,
                    tier: logTier,
                    rowDurationMs: Date.now() - rowStartedAt,
                    rowTimeoutMs: BALANCE_PASS_ROW_TIMEOUT_MS,
                  });
                  return "unsettled";
                };

                if (pinnedModelId && pinnedModel) {
                  const currentUtilization = pinnedModel.laneId
                    ? laneEffectiveUtilization(laneLedger, pinnedModel.laneId)
                    : null;
                  const result = await advise(company.id, { issueId }, false, undefined, true, contextUsageCache);
                  if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) return "settled";
                  if (!result.isIdle || !balanceOpenStatuses.has(result.status)) return "settled";
                  if (resolveConfiguredModelId(result.pinnedModelId, config.models) !== pinnedModelId) return "settled";
                  // Designated agents are exempt from router pinning: leave
                  // the pin alone. A serviceability hard stop still repins,
                  // so an exempt agent never fails on a dead lane.
                  if (result.isAgentExempt && !result.isServiceabilityHardStop) {
                    ctx.logger.info("balance pass skipped: agent exempt", {
                      companyId: company.id,
                      issue: identifier,
                      tier,
                    });
                    return "settled";
                  }
                  // . A card whose pin is already correct but whose
                  // sub-call env is frozen on a dead lane must still be written.
                  // This is checked BEFORE the same-model short-circuit below,
                  // not alongside cheaper/incapable/busier: those are all
                  // properties of the PIN, and this row's pin is fine. Putting it
                  // after the short-circuit would make it unreachable for exactly
                  // the 149-card population it exists to drain.
                  const envDrifted = overrideEnvOnExcludedLane({
                    existingOverrideEnv: result.existingOverrideEnv,
                    models: config.models,
                    ledger: laneLedger,
                    laneOutageOverride,
                    nowIso,
                    laneAvoidConfig: config.pacing.avoid,
                    pacingMode: config.pacing.mode,
                  });
                  if (result.decision.modelId === pinnedModelId && !envDrifted) return "settled";
                  const newModel = config.models.find((m) => m.id === result.decision.modelId);
                  if (!newModel) return "settled";
                  const newUtilization = newModel.laneId ? laneEffectiveUtilization(laneLedger, newModel.laneId) : null;

                  const cheaper = blendedListPrice(newModel) <= BALANCE_PASS_COST_DOWN_MULTIPLIER * blendedListPrice(pinnedModel);
                  const pinnedScore = tierScoreFor(modelScores[pinnedModelId], tier);
                  let incapable = pinnedScore ? pinnedScore.capable === false : false;

                  // `probation` (balance_pass()): a pinned model priced under
                  // BALANCE_PASS_PROBATION_PRICE_USD and still unproven may hold
                  // only ONE active card company-wide — the exploration slot —
                  // before it is demoted. Only worth the extra DB round trip
                  // when the cheaper/incapable checks above have not already
                  // decided this row.
                  if (
                    !incapable &&
                    blendedListPrice(pinnedModel) < BALANCE_PASS_PROBATION_PRICE_USD &&
                    !(pinnedScore?.proven ?? false)
                  ) {
                    const activeCount = await countActivePinsOfModel(company.id, pinnedModelId);
                    if (activeCount > 1) incapable = true;
                  }

                  // `over_cap`: this card's own lane no longer has room for it
                  // (extra: -1 because this card already counts itself in the
                  // ledger's active-pins weight) — only checked for todo/
                  // in_progress, matching the Python source's `status in
                  // ("todo","in_progress")` guard.
                  if (
                    !incapable &&
                    (status === "todo" || status === "in_progress") &&
                    pinnedModel.laneId &&
                    config.pacing.mode !== "off"
                  ) {
                    const pinsWeightByLane = await activePinsWeightByLane(company.id, config.models);
                    const admitted = laneHasRoom({
                      laneId: pinnedModel.laneId,
                      activePinsWeight: pinsWeightByLane[pinnedModel.laneId] ?? 0,
                      extra: -1,
                      ledger: laneLedger,
                      capPerAccount: config.pacing.laneCapPerAccount,
                      fiveHourWindowName: config.pacing.fiveHourWindowName,
                      zaiLaneId: config.pacing.zai.laneId,
                      zaiWeeklyWindowName: config.pacing.zai.weeklyWindowName,
                      zaiWeeklyDefaultMargin: config.pacing.zai.weeklyDefaultMargin,
                      zaiPaceOverrideMargin: null,
                      nowMs: now,
                    });
                    if (!admitted) incapable = true;
                  }

                  const busier =
                    currentUtilization !== null &&
                    newUtilization !== null &&
                    currentUtilization - newUtilization >= BALANCE_PASS_BUSIER_UTILIZATION_DELTA;

                  //  pace-pull: `orderCandidatesByPace` ranks only NEW
                  // pins, so a pin that landed before its lane fell behind never
                  // moves until PIN_MAX_AGE_MS expiry. Pull an idle card toward
                  // a behind-pace lane when pacing is enforced, `advise()` picked
                  // a behind/behind-urgent model on a strictly better-ranked lane
                  // than the pin's, and the target lane has room (including the
                  // 06-10Z weekday zai peak cap, via `laneHasRoom`). Moves per
                  // pass are capped at the target lane's free slots at first
                  // sight; the reason is recorded as `pace-pull` in the activity
                  // trace. Advisory decisions and shadow/off pacing never pull:
                  // in those modes pace did not (or must not) choose the winner.
                  let pacePull = false;
                  let pacePullTargetLaneId: string | null = null;
                  if (
                    !cheaper &&
                    !incapable &&
                    !busier &&
                    !envDrifted &&
                    config.pacing.mode === "enforce" &&
                    !result.decision.advisory &&
                    result.decision.modelId !== pinnedModelId &&
                    isBehindPace(laneLedger, newModel) &&
                    pacePreferenceRank(laneLedger, newModel) < pacePreferenceRank(laneLedger, pinnedModel)
                  ) {
                    const targetLaneId = newModel.laneId ?? null;
                    if (targetLaneId) {
                      if (pacePullWeights === null) {
                        pacePullWeights = await activePinsWeightByLane(company.id, config.models);
                        pacePullZaiMargin = activeZaiPaceOverride(await readZaiPaceOverride(company.id), nowIso);
                      }
                      const moved = pacePullMoved.get(targetLaneId) ?? 0;
                      let freeSlots = pacePullFreeSlots.get(targetLaneId);
                      if (freeSlots === undefined) {
                        const per = config.pacing.laneCapPerAccount[targetLaneId];
                        const accounts = Math.max(1, laneHealthyAccountCount(laneLedger, targetLaneId));
                        freeSlots =
                          per === undefined
                            ? Number.POSITIVE_INFINITY
                            : Math.max(0, Math.floor(per * accounts - (pacePullWeights[targetLaneId] ?? 0)));
                        pacePullFreeSlots.set(targetLaneId, freeSlots);
                      }
                      const targetRoom =
                        moved < freeSlots &&
                        laneHasRoom({
                          laneId: targetLaneId,
                          activePinsWeight: pacePullWeights[targetLaneId] ?? 0,
                          ledger: laneLedger,
                          capPerAccount: config.pacing.laneCapPerAccount,
                          fiveHourWindowName: config.pacing.fiveHourWindowName,
                          zaiLaneId: config.pacing.zai.laneId,
                          zaiWeeklyWindowName: config.pacing.zai.weeklyWindowName,
                          zaiWeeklyDefaultMargin: config.pacing.zai.weeklyDefaultMargin,
                          zaiPaceOverrideMargin: pacePullZaiMargin,
                          nowMs: now,
                        });
                      if (targetRoom) {
                        pacePull = true;
                        pacePullTargetLaneId = targetLaneId;
                      }
                    }
                  }

                  if (!(cheaper || incapable || busier || envDrifted || pacePull)) return "settled";

                  //  P2: candidate-carrying recovery (see the apply path).
                  const selectedModel = recoverSelectedCandidate(config.models, result.decision);
                  if (!selectedModel) return "settled";

                  // . 2026-09-17 08:10:14Z this pass moved  off
                  // `claude-haiku-4-5-20251001` (the only healthy T3 lane) onto
                  // `deepseek-v4-flash` (0/3) for `cost-down`, and did the same to
                  // seven more cards in eleven hours. `selectModel` now excludes a
                  // PROVEN-DEAD lane outright, but `deepseek-v4-flash` at 0/3 is
                  // not proven dead — it is unproven, and nothing about a cheaper
                  // price is evidence it will serve.
                  //
                  // `incapable` and `busier` are deliberately exempt: those are
                  // "this card cannot stay here", and refusing to move it would
                  // wedge it on a lane already judged unusable. Only a move made
                  // PURELY to save money has to clear this bar.
                  if (cheaper && !incapable && !busier) {
                    const evidence = await readLaneEvidence(company.id, config.models, now);
                    const from = evidenceStateFor(evidence, pinnedModel.laneId ?? null);
                    const to = evidenceStateFor(evidence, selectedModel.laneId ?? null);
                    if (costDownWouldAbandonProvenLane(from, to)) {
                      // An abandoned row's body must not log after the
                      // deadline either: the next firing re-decides it.
                      if (Date.now() >= deadlineAt) return "unsettled";
                      await ctx.activity.log({
                        companyId: company.id,
                        message:
                          `Model Selection held ${pinnedModelId} (cost-down to ${selectedModel.id} refused): ` +
                          `lane ${pinnedModel.laneId ?? "(none)"} is proven-good over ` +
                          `${evidence.windowHours}h, lane ${selectedModel.laneId ?? "(none)"} is ${to}`,
                        entityType: "issue",
                        entityId: issueId,
                        metadata: {
                          from: pinnedModelId,
                          heldAgainst: selectedModel.id,
                          fromEvidence: from,
                          toEvidence: to,
                          reason: "lane-evidence",
                        },
                      });
                      return "settled";
                    }
                  }
                  if (!(await balanceWriteStillSafe(company.id, issueId, pinnedModelId, config.models))) return "settled";
                  if (isPastWriteDeadline(rowStartedAt)) return skipSlowWrite(tier);
                  // : one bad card must not abort the pass (and skip
                  // the cursor/scan-mark writes below, re-hitting the same
                  // card forever).
                  // : the write needs enforcement — including the
                  // env-evacuation, which mutates the override like any repin.
                  // The decision and its log do not.
                  if (writesAllowed) {
                    try {
                      // : `balanceWriteStillSafe` guards the pin
                      // expectation, not a quarantine that landed after select.
                      // Write branch only; an unwritten row remains retryable
                      // and never counts as balanced or against the pace-pull cap.
                      if (config.pacing.mode !== "off" && !(await writeStillSafeFromQuarantine(company.id, selectedModel))) {
                        ctx.logger.info("balance pass skipped: quarantine landed on the selected lane after select", {
                          companyId: company.id,
                          issue: identifier,
                          modelId: selectedModel.id,
                          laneId: selectedModel.laneId ?? null,
                        });
                        return "unsettled";
                      }
                      if (isPastWriteDeadline(rowStartedAt)) return skipSlowWrite(tier);
                      const balancePatch = modelOverrideForContext({
                        model: selectedModel,
                        agentEnvContextTokens: config.selection.agentEnvContextTokens,
                        compactionRatio: config.selection.compactionRatio,
                        agentEnv: result.agentEnv,
                        agentAdapterType: result.agentAdapterType,
                        agentAdapterConfig: result.agentAdapterConfig,
                        existingOverrideEnv: result.existingOverrideEnv,
                        // : haiku-class sub-call keys follow the
                        // cheapest healthy T3 pick (falls back to the pin).
                        cheapModelId: result.ancillaryModelId,
                        provenance: fallbackPinProvenance(selectedModel, result.assigneeAgentId),
                      });
                      await ctx.issues.update(issueId, balancePatch as Parameters<typeof ctx.issues.update>[1], company.id);
                      await recordFallbackPin(company.id, issueId, balancePatch);
                    } catch (cause) {
                      ctx.logger.warn("balance pass skipped a card it could not pin", {
                        companyId: company.id,
                        issue: identifier,
                        error: cause instanceof Error ? cause.message : String(cause),
                      });
                      return "settled";
                    }
                  } else {
                    ctx.logger.info("balance pass advisory: would balance, nothing written", {
                      companyId: company.id,
                      issue: identifier,
                      tier,
                      from: pinnedModelId,
                      modelId: result.decision.modelId,
                    });
                  }
                  await ctx.activity.log({
                    companyId: company.id,
                    message:
                      (result.decision.modelId === pinnedModelId
                        ? `Model Selection evacuated sub-call env off a dead lane on ${pinnedModelId} (${tier}): pin unchanged`
                        : `Model Selection balanced ${pinnedModelId} -> ${result.decision.modelId} (${tier}): ${
                            cheaper
                              ? "cost-down"
                              : incapable
                                ? "demote"
                                : busier
                                  ? "rebalance"
                                  : pacePull
                                    ? "pace-pull"
                                    : "env-evacuation"
                          }`) + advisorySuffix,
                    entityType: "issue",
                    entityId: issueId,
                    metadata: {
                      from: pinnedModelId,
                      modelId: result.decision.modelId,
                      tier,
                      cheaper,
                      incapable,
                      busier,
                      envDrifted,
                      pacePull,
                      //  P2: the served leg of the v2 identity (null on legacy).
                      candidateId: selectedModel.candidateId,
                      ...(writesAllowed ? {} : { advisory: true, written: false }),
                    },
                  });
                  // : a shadow install writes nothing, so neither the
                  // pass counter nor the per-lane pace-pull cap may count it.
                  if (writesAllowed) {
                    balanced += 1;
                    if (pacePullTargetLaneId) {
                      pacePullMoved.set(
                        pacePullTargetLaneId,
                        (pacePullMoved.get(pacePullTargetLaneId) ?? 0) + 1,
                      );
                    }
                  }
                  return balanced >= BALANCE_PASS_WRITE_LIMIT ? "stop" : "settled";
                }

                // Unpinned + labelled = former exclusion: give it a balanced
                // T1-class pin instead of leaving it on the agent floor.
                // `pick("T1", floor)` in Python — always T1, never this row's
                // own tier label.
                // : an explicit `tier:T0` card is never pinned DOWN to T1.
                const balancedTier: Tier = labelTier === "T0" ? "T0" : "T1";
                // `advise()` costs a full row of host RPC whether or not
                // earn-in is on — it always runs outside the earn-in lock. The
                // lock guards the reservation → pin → rollback section only,
                // and only when the card screens as an earn-in candidate at
                // all, so a disabled flag means no lock and no earn-in state
                // I/O anywhere on this path.
                const result = await advise(company.id, { issueId }, false, balancedTier, false, contextUsageCache);
                if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) {
                  if (Date.now() >= deadlineAt) return "unsettled";
                  //  AC3: same visibility as the label-only pass —
                  // this branch previously `continue`d without a trace.
                  await maybeLogUnpinnableCard(company.id, issueId, identifier, result?.decision ?? null);
                  return "settled";
                }
                if (!result.isIdle || !balanceOpenStatuses.has(result.status)) return "settled";
                if (result.pinnedModelId !== null) return "settled";
                // Designated agents are exempt from router pinning: an unpinned
                // exempt card stays on the agent's own model (no hard stop can
                // apply without a pin).
                if (result.isAgentExempt) {
                  ctx.logger.info("balance pass skipped unpinned card: agent exempt", {
                    companyId: company.id,
                    issue: identifier,
                    tier,
                  });
                  return "settled";
                }
                const floorModelId = resolveConfiguredModelId(result.agentFloorModelId, config.models);
                // : only elide onto the implicit NULL-override floor
                // pin while that floor's own lane is serviceable right now —
                // otherwise write the explicit pin `result.decision.modelId`
                // already resolved to, same as `floorModelId` in that case,
                // so `repinPass` can see and repair it later.
                const floorHealthy =
                  result.decision.modelId === floorModelId &&
                  isUsableAndCapable(
                    floorModelId,
                    tier,
                    described.descriptor.requiredContextTokens,
                    config,
                    laneLedger,
                    laneOutageOverride,
                    modelScores,
                    nowIso,
                  );
                //  P2: candidate-carrying recovery (see the apply path).
                const selectedModel = recoverSelectedCandidate(config.models, result.decision);
                if (!selectedModel) return "settled";
                // Recorded exclusions and selection survivors constrain earn-in.
                // T0 cards exit inside `maybeAdmitEarnIn` (T1 label gate, no
                // state I/O), so T0 keeps main's floor-elide behavior below.
                const earnInExclusions = await readClassificationExclusions(company.id);
                // Cheap screen on config + recorded card facts (no earn-in
                // state I/O): anything failing here makes `maybeAdmitEarnIn`
                // return null without writing, so skipping the lock changes
                // nothing but contention.
                const earnInScreen =
                  config.earnIn.enabled &&
                  selectionWritesAllowed(config) &&
                  !config.aaFreeSync.enabled &&
                  result.decision.candidates.length > 0 &&
                  isEarnInCandidateIssue({
                    status: described.status,
                    isIdle: described.isIdle,
                    hasOperatorPin: described.hasOperatorPin,
                    exclusionExcluded: earnInExclusions[issueId] === true,
                    hasExistingOverride: described.hasOverride,
                    assigneeUserId: described.assigneeUserId,
                    labelNames: described.descriptor.labelNames ?? [],
                    priority: described.descriptor.priority ?? null,
                    title: described.title,
                  });
                const pinUnpinnedRow = async (
                  earnInDecision: Awaited<ReturnType<typeof maybeAdmitEarnIn>>,
                ) => {
                  const earnInWinner = earnInDecision?.decision.dispatch ? earnInDecision.model : null;
                  const pinTarget = earnInWinner ?? selectedModel;
                  let pinCommitted = false;
                  try {
                    // An eligible cadence turn gets an explicit pin even at the
                    // floor, so the next scan cannot count the same pick again.
                    if (floorHealthy && !earnInDecision) return "settled";
                    if (!(await balanceWriteStillSafe(company.id, issueId, null, config.models))) return "settled";
                    if (isPastWriteDeadline(rowStartedAt)) return skipSlowWrite(balancedTier);
                    // : same per-issue isolation as the pinned branch.
                    // : this branch's write is gated like the pinned one.
                    if (writesAllowed) {
                      try {
                        // : re-check the actual winner, including earn-in.
                        if (config.pacing.mode !== "off" && !(await writeStillSafeFromQuarantine(company.id, pinTarget))) {
                          ctx.logger.info("balance pass skipped: quarantine landed on the selected lane after select", {
                            companyId: company.id,
                            issue: identifier,
                            modelId: pinTarget.id,
                            laneId: pinTarget.laneId ?? null,
                          });
                          return "unsettled";
                        }
                        if (isPastWriteDeadline(rowStartedAt)) return skipSlowWrite(balancedTier);
                        const balancePatch = modelOverrideForContext({
                          model: pinTarget,
                          agentEnvContextTokens: config.selection.agentEnvContextTokens,
                          compactionRatio: config.selection.compactionRatio,
                          agentEnv: result.agentEnv,
                          agentAdapterType: result.agentAdapterType,
                          agentAdapterConfig: result.agentAdapterConfig,
                          existingOverrideEnv: result.existingOverrideEnv,
                          // : sub-call keys follow the healthy T3 pick.
                          cheapModelId: result.ancillaryModelId,
                          provenance: fallbackPinProvenance(pinTarget, result.assigneeAgentId),
                        });
                        await ctx.issues.update(issueId, balancePatch as Parameters<typeof ctx.issues.update>[1], company.id);
                        // A landed pin remains accounted even if later logging fails.
                        pinCommitted = true;
                        await recordFallbackPin(company.id, issueId, balancePatch);
                      } catch (cause) {
                        ctx.logger.warn(pinCommitted
                          ? "balance pass pinned card but bookkeeping failed"
                          : "balance pass skipped a card it could not pin", {
                          companyId: company.id,
                          issue: identifier,
                          pinCommitted,
                          error: cause instanceof Error ? cause.message : String(cause),
                        });
                        if (!pinCommitted) return "settled";
                      }
                    } else {
                      ctx.logger.info("balance pass advisory: would pin unpinned card, nothing written", {
                        companyId: company.id,
                        issue: identifier,
                        modelId: pinTarget.id,
                      });
                    }
                    await ctx.activity.log({
                      companyId: company.id,
                      message:
                        (earnInWinner
                          ? `Model Selection earn-in admitted and pinned ${earnInWinner.id} (${balancedTier}): ${earnInDecision?.decision.reason}`
                          : pinTarget.id === floorModelId
                            ? `Model Selection explicitly pinned ${pinTarget.id} (${balancedTier}): ${floorHealthy ? "eligible earn-in cadence turn" : "floor lane unserviceable"}`
                            : `Model Selection balanced floor -> ${pinTarget.id} (${balancedTier}): unpinned labelled card given a balanced ${balancedTier} pin`) + advisorySuffix,
                      entityType: "issue",
                      entityId: issueId,
                      metadata: {
                        from: floorModelId, modelId: pinTarget.id, tier: balancedTier, candidateId: pinTarget.candidateId,
                        ...(earnInDecision ? { earnInReason: earnInDecision.decision.reason } : {}),
                        ...(earnInWinner ? {
                          earnIn: true,
                          cohortTag: earnInDecision?.decision.cohortTag ?? null,
                          idempotencyKey: earnInDecision?.decision.idempotencyKey ?? null,
                        } : {}),
                        ...(writesAllowed ? {} : { advisory: true, written: false }),
                      },
                    });
                    // : a shadow install writes nothing, so the pass
                    // counter must not count it.
                    if (writesAllowed) balanced += 1;
                    return balanced >= BALANCE_PASS_WRITE_LIMIT ? "stop" : "settled";
                  } finally {
                    if (earnInDecision && !pinCommitted) {
                      try {
                        await writeEarnInState(company.id, earnInDecision.priorState);
                      } catch (cause) {
                        ctx.logger.error("earn-in reservation rollback failed; capacity remains reserved", {
                          companyId: company.id,
                          issue: identifier,
                          modelId: earnInDecision.model.id,
                          error: cause instanceof Error ? cause.message : String(cause),
                        });
                      }
                    }
                  }
                };
                if (!earnInScreen) return pinUnpinnedRow(null);
                return withEarnInLock(company.id, async () =>
                  pinUnpinnedRow(await maybeAdmitEarnIn(company.id, {
                    described,
                    exclusionExcluded: earnInExclusions[issueId] === true,
                    agentAdapterType: described.agentAdapterType,
                    candidateModelIds: result.decision.candidates.map((candidate) => candidate.modelId),
                    nowMs: now,
                    nowIso,
                  })),
                );
              },
            );
            slowestRowMs = walk.slowestRowMs;
            if (walk.abandoned) {
              const abandoned = asRecord(walk.abandoned.row);
              ctx.logger.warn("balance pass abandoned a slow row at the deadline", {
                companyId: company.id,
                issue: typeof abandoned.identifier === "string" ? abandoned.identifier : abandoned.id,
                rowDurationMs: walk.abandoned.rowDurationMs,
              });
            }

            // : the id cursor passes every EXAMINED row (an
            // unsettled one included — the cycle re-reads it on wrap) and
            // stops before an abandoned or unreached one, so a row the timer
            // abandoned is the first row of the next firing, not skipped.
            const scanned = walk.examined.length;
            const lastExamined = scanned > 0 ? asRecord(walk.examined[scanned - 1]).id : undefined;
            const lastScannedId = typeof lastExamined === "string" ? lastExamined : afterId;
            const cycleComplete =
              scanned === candidateRows.length && candidateRows.length < BALANCE_PASS_FETCH_LIMIT;
            const nextAfterId = cycleComplete ? null : lastScannedId || null;
            // Carry transient skips across pages. At wrap, a new cycle earns
            // a clean mark only after every page settles; until then even a
            // quiet board must run so unchanged skipped cards are retried.
            const unsettledInCycle = (afterId !== "" && storedCursor.unsettledInCycle === true) || walk.unsettled > 0;
            const retryPending = unsettledInCycle || (!cycleComplete && storedCursor.retryPending === true);
            await ctx.state.set(cursorKey, {
              afterId: nextAfterId,
              ...(retryPending ? { retryPending: true } : {}),
              ...(!cycleComplete && unsettledInCycle ? { unsettledInCycle: true } : {}),
            });
            // : the id-cycle cursor above preserves position; the
            // scan mark records that this firing SAW the board, so the next
            // firing's aggregate gate can skip a quiet board. :
            // written only when the cycle completes — a mark written mid-cycle
            // let a quiet board skip the unvisited rest of the cycle forever,
            // and a deadline-bounded walk now ends mid-cycle routinely.
            if (cycleComplete && !retryPending) {
              await writeScanMark(company.id, PLUGIN_STATE_KEYS.balanceLastScanAt, balanceFiringStartMs);
            }
            ctx.logger.info("balance pass complete", {
              companyId: company.id,
              balanced,
              candidates: candidateRows.length,
              scanned,
              skippedSlowRows: walk.unsettled,
              slowestRowMs: walk.slowestRowMs,
              afterId: afterId || null,
              nextAfterId,
              cycleComplete,
              budgetExhausted: walk.budgetExhausted,
              durationMs: Date.now() - startedAt,
              jobDurationMs: Date.now() - jobStartedAt,
            });
            if (walk.budgetExhausted) break;
          } catch (cause) {
            ctx.logger.error("balance pass failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause),
              durationMs: Date.now() - startedAt,
              jobDurationMs: Date.now() - jobStartedAt,
            });
          }
        }
      });

      // --- scheduled dispatch sweep ( absorption of the standalone
      // `dispatch` plugin, /) -----------------------------------
      // Ported wholesale, not reimplemented: `dispatch-selection.ts` carries
      // the ADR 0001/0003/0004/Q2/Q5 owner decisions as comments, and this job
      // body is the same `sweepCompany` orchestration the standalone plugin
      // ran, so the `plugins` table shows one dispatcher instead of two.
      ctx.jobs.register(JOB_KEYS.dispatchSweep, async (job) => {
        const companies = listKnownCompanies();
        // : cooperative deadline mirroring the classify/balance
        // passes — stop starting new work with a full minute left before
        // the host's 300 s job RPC wall. Partial firings still emit their
        // metrics/summary with a partial-coverage note below.
        const jobStartedAt = Date.now();
        const deadlineAt = jobStartedAt + DISPATCH_SWEEP_JOB_BUDGET_MS;
        for (const company of companies) {
          if (Date.now() >= deadlineAt) {
            ctx.logger.warn("dispatch sweep stopped before the host RPC wall", {
              companyId: company.id,
              durationMs: Date.now() - jobStartedAt,
              budgetMs: DISPATCH_SWEEP_JOB_BUDGET_MS,
            });
            break;
          }
          try {
            const config = await companyConfig(company.id);
            const dispatchConfig = config.dispatch;

            //  fix 3/4: standalone-plugin notes, restored alongside the
            // metrics/logger lines that already cover the same events — see
            // dispatch-reporting.ts's logStateChange, which folds this array
            // into metadata.notes.
            const notes: string[] = [];

            const issues = (await ctx.issues.list({
              companyId: company.id,
              limit: DISPATCH_ISSUE_PAGE_LIMIT,
            })) as unknown as DispatchIssue[];
            if (issues.length >= DISPATCH_ISSUE_PAGE_LIMIT) {
              ctx.logger.warn("dispatch sweep: issue page saturated, some issues were not seen this firing", {
                companyId: company.id,
                pageLimit: DISPATCH_ISSUE_PAGE_LIMIT,
              });
              notes.push(
                `issue list saturated at limit ${DISPATCH_ISSUE_PAGE_LIMIT} — counters undercount the board`,
              );
            }

            const nonTerminal = issues.filter(
              (issue) => !(DISPATCH_TERMINAL_STATUSES as readonly string[]).includes(issue.status),
            );

            const routingGapBase = summariseRoutingGap(nonTerminal.map((issue) => ({ issue })));
            let routingGap: ReturnType<typeof summariseRoutingGap> = routingGapBase;
            if (routingGapBase.count > 0) {
              try {
                const agents = await ctx.agents.list({ companyId: company.id });
                routingGap = { ...routingGapBase, owners: identifyRoutingOwners(agents) };
                if (!routingGap.owners?.complete) {
                  notes.push(
                    `routing owners are a partial list: ${(routingGap.owners?.unreadableSources ?? []).join(", ")} ` +
                      "are not readable from the plugin capability surface",
                  );
                }
              } catch (cause) {
                ctx.logger.warn("dispatch sweep: could not read agents for routing-gap owners", {
                  companyId: company.id,
                  error: cause instanceof Error ? cause.message : String(cause),
                });
              }
            }

            const assigned = nonTerminal.filter((issue) => issue.assigneeAgentId);
            const population: DispatchPopulationEntry[] = [];
            // : assignees with a running/queued run seen in this
            // firing's orchestration reads. Union'd with the firing-wide
            // `agent_id` query below — an agent is busy if EITHER source says
            // so. A run on an unreadable or terminal card still keeps its
            // agent busy, which the orchestration union alone would miss.
            const busyAssigneesFromRuns = new Set<string>();
            let unreadable = 0;
            let budgetExhausted = false;
            let budgetStopLogged = false;
            // : one warn per partial company firing — later
            // checkpoints still break, but only the first logs.
            const stopOnBudget = (extra: Record<string, unknown>): boolean => {
              if (Date.now() < deadlineAt) return false;
              budgetExhausted = true;
              if (!budgetStopLogged) {
                budgetStopLogged = true;
                ctx.logger.warn("dispatch sweep stopped before the host RPC wall", {
                  companyId: company.id,
                  durationMs: Date.now() - jobStartedAt,
                  budgetMs: DISPATCH_SWEEP_JOB_BUDGET_MS,
                  ...extra,
                });
              }
              return true;
            };
            const sweepNowMs = Date.now();
            for (const issue of nonTerminal) {
              if (
                stopOnBudget({
                  gathered: population.length,
                  remaining: nonTerminal.length - population.length,
                })
              ) {
                break;
              }
              if (!issue.assigneeAgentId) {
                population.push({ issue });
                continue;
              }
              // : the row already answers the descriptor and
              // monitor rails — skip both per-issue RPCs for cards
              // `classifyIssue` will refuse on row data alone. This is a
              // pure RPC saving, not a policy change: classification
              // re-verifies from the same row.
              if (isParkedOnNamedOwner(issue) || isMonitorArmed(issue, sweepNowMs)) {
                population.push({ issue });
                continue;
              }
              try {
                const orchestration = await ctx.issues.summaries.getOrchestration({
                  issueId: issue.id,
                  companyId: company.id,
                });
                const relation = orchestration.relations[issue.id];
                // : re-check the cooperative deadline between the
                // two per-issue RPCs. The top-of-loop checkpoint passed
                // before `getOrchestration`, which can itself outlast the
                // budget — without this, `listInteractions` still fires
                // (the ~11 s overrun seen post-deploy on 2026-09-28).
                // Breaking here drops this issue from the population, the
                // same as a top-of-loop stop one iteration earlier.
                if (
                  stopOnBudget({
                    gathered: population.length,
                    remaining: nonTerminal.length - population.length,
                  })
                ) {
                  break;
                }
                // : neither a future monitor check nor a pending
                // interaction is on the orchestration summary — a monitor
                // wake and a human-only ask are both invisible to
                // getOrchestration, which is exactly how  and
                // /2455/1677 slipped past the sweep.
                const interactions = await ctx.issues.listInteractions(issue.id, company.id);
                const runs = orchestration.runs.map((r) => ({
                  issueId: r.issueId,
                  status: r.status,
                  finishedAt: r.finishedAt,
                  startedAt: r.startedAt,
                  createdAt: r.createdAt,
                }));
                // : an active run scoped to this card keeps its
                // assignee busy even if the firing-wide `agent_id` query
                // misses it — union'd into `busyAssignees` below.
                if (
                  issue.assigneeAgentId &&
                  runs.some((r) => r.issueId === issue.id && (r.status === "queued" || r.status === "running"))
                ) {
                  busyAssigneesFromRuns.add(issue.assigneeAgentId);
                }
                population.push({
                  issue,
                  blockedBy: (relation?.blockedBy ?? []).map((b) => ({ id: b.id, status: b.status })),
                  runs,
                  invocationBlock:
                    orchestration.invocationBlocks.find((b) => b.issueId === issue.id) ?? null,
                  pendingInteractions: interactions
                    .filter((i) => i.status === "pending")
                    .map((i) => ({
                      status: i.status,
                      addresseeAgentId: i.addresseeAgentId ?? null,
                      effectiveResolverPolicy: i.effectiveResolverPolicy ?? null,
                    })),
                });
              } catch (cause) {
                unreadable += 1;
                ctx.logger.warn("dispatch sweep: could not read orchestration for an issue, excluding it", {
                  companyId: company.id,
                  issueId: issue.id,
                  error: cause instanceof Error ? cause.message : String(cause),
                });
              }
            }
            if (unreadable > 0) {
              notes.push(`${unreadable} assigned issues could not be read and are excluded from selection`);
            }

            // : firing-wide agent busyness. The orchestration union
            // above sees runs on gathered cards; this query sees runs
            // ANYWHERE (terminal/unreadable cards included). One indexed
            // `(company_id, status)` scan per firing, not per issue.
            const busyAssignees = new Set<string>(busyAssigneesFromRuns);
            try {
              const busyRows = (await ctx.db.query(
                `select distinct agent_id::text as agent_id
                   from heartbeat_runs
                  where company_id = $1
                    and status in ('running','queued')
                    and agent_id is not null`,
                [company.id],
              )) as unknown[];
              for (const row of busyRows) {
                const agentId = asRecord(row).agent_id;
                if (typeof agentId === "string" && agentId.length > 0) busyAssignees.add(agentId);
              }
            } catch (cause) {
              // Fail-open: without the busy set every assignee reads idle and
              // the new class over-selects — but the per-issue active-run
              // guard inside selectDispatch still holds, and the note says so.
              notes.push("agent busyness unreadable this firing — idle-assignee class may over-select");
              ctx.logger.warn("dispatch sweep: could not read busy agents, failing open", {
                companyId: company.id,
                error: cause instanceof Error ? cause.message : String(cause),
              });
            }
            const idleAssignees = new Set<string>();
            for (const entry of population) {
              const assignee = entry.issue.assigneeAgentId;
              if (assignee && !busyAssignees.has(assignee)) idleAssignees.add(assignee);
            }

            // : lane-down gate, read once per firing. Three signals,
            // OR'd: the pace-ledger hard stop (a measured exhaustion), the
            // operator outage override ( quarantine), and the
            // collector availability snapshot's `unavailable` state. UNKNOWN
            // availability never gates — fail-neutral, a broken instrument
            // must not take dispatch down ( policy).
            const laneLedger = await readLaneLedger(company.id);
            const laneOutageOverride = await readLaneOutage(company.id);
            const availability = await readAvailability(company.id, sweepNowMs);
            const nowIso = new Date(sweepNowMs).toISOString();
            const unavailableLanes = new Set(
              availability.lanes.filter((lane) => lane.state === "unavailable").map((lane) => lane.laneId),
            );
            const isLaneDown = (laneId: string): boolean => {
              if (hardStopExcluded(laneLedger, { laneId } as never)) return true;
              if (
                isLaneOutageActive(laneOutageOverride, nowIso) &&
                (laneOutageOverride?.lanes ?? []).includes(laneId)
              ) {
                return true;
              }
              return unavailableLanes.has(laneId);
            };

            // : the lane a wake would run on, from rows already in
            // hand — pin model first, agent floor second, unknown last (and
            // unknown stays selectable). Agent rows are fetched once per
            // distinct assignee and cached for the firing; an unreadable
            // agent degrades to lane-unknown, never to a skip.
            const agentFloorLaneByAgent = new Map<string, string | null>();
            const laneOfModel = (modelId: string | null): string | null => {
              if (!modelId) return null;
              const resolved = resolveConfiguredModelId(modelId, config.models);
              return config.models.find((m) => m.id === resolved)?.laneId ?? null;
            };
            const floorLaneOf = async (assigneeAgentId: string): Promise<string | null> => {
              if (agentFloorLaneByAgent.has(assigneeAgentId)) {
                return agentFloorLaneByAgent.get(assigneeAgentId) ?? null;
              }
              let lane: string | null = null;
              try {
                const agent = await ctx.agents.get(assigneeAgentId, company.id);
                const adapterConfig = asRecord(asRecord(agent).adapterConfig);
                const floorModel = typeof adapterConfig.model === "string" ? adapterConfig.model : null;
                lane = laneOfModel(floorModel);
              } catch {
                lane = null;
              }
              agentFloorLaneByAgent.set(assigneeAgentId, lane);
              return lane;
            };
            const laneByIssueId = new Map<string, string | null>();
            for (const entry of population) {
              if (stopOnBudget({ lanesResolved: laneByIssueId.size, population: population.length })) {
                break;
              }
              const assignee = entry.issue.assigneeAgentId;
              if (!assignee) continue;
              const row = entry.issue as unknown as Record<string, unknown>;
              const overrides = asRecord(row.assigneeAdapterOverrides ?? row.assignee_adapter_overrides);
              const pinned = asRecord(overrides.adapterConfig).model;
              const pinnedLane = laneOfModel(typeof pinned === "string" ? pinned : null);
              laneByIssueId.set(
                entry.issue.id,
                pinnedLane ?? (await floorLaneOf(assignee)),
              );
            }

            const selection = selectDispatch(population, {
              idleMinutes: dispatchConfig.idleMinutes,
              maxWakesPerFiring: dispatchConfig.maxWakesPerFiring,
              focusProjectIds: [...dispatchConfig.focusProjectIds],
              now: sweepNowMs,
              idleAssignees,
              laneByIssueId,
              isLaneDown,
            });
            (selection as { routingGap?: typeof routingGap }).routingGap = routingGap;

            const wakeOutcomes: WakeOutcome[] = [];
            if (dispatchConfig.wakeEnabled) {
              // ADR 0004: one issue at a time, own try/catch each — never
              // `requestWakeups`, whose batched call throws on the first
              // refusal after already waking priors, discarding the rest of
              // the result set.
              for (const pick of selection.picks) {
                if (
                  stopOnBudget({
                    picksWoken: wakeOutcomes.filter((o) => o.queued).length,
                    picksRemaining: selection.picks.length - wakeOutcomes.length,
                  })
                ) {
                  break;
                }
                try {
                  const result = await ctx.issues.requestWakeup(pick.issue.id, company.id, {
                    reason: "dispatch_stalled_issue",
                    contextSource: "plugin.dispatch.sweep",
                    idempotencyKey: `dispatch:${job.runId}:${pick.issue.id}`,
                  });
                  // A `queued: false` answer without a throw is still a
                  // failure with a reason —  counts it, never drops it.
                  if (result.queued) {
                    wakeOutcomes.push({ issueId: pick.issue.id, queued: true });
                  } else {
                    const message = "requestWakeup answered queued:false without an error";
                    wakeOutcomes.push({
                      issueId: pick.issue.id,
                      queued: false,
                      error: { code: wakeFailureCodeFor(message), message },
                    });
                    ctx.logger.error("dispatch sweep: wake not queued", {
                      companyId: company.id,
                      issueId: pick.issue.id,
                      code: wakeFailureCodeFor(message),
                      error: message,
                    });
                  }
                } catch (cause) {
                  const message = cause instanceof Error ? cause.message : String(cause);
                  const code = wakeFailureCodeFor(message);
                  wakeOutcomes.push({ issueId: pick.issue.id, queued: false, error: { code, message } });
                  // : the plugin_logs half of failure persistence —
                  // code + message on the host log line, matching what lands
                  // in `dispatchLastFiring` via the summary.
                  ctx.logger.error("dispatch sweep: wake failed", {
                    companyId: company.id,
                    issueId: pick.issue.id,
                    code,
                    error: message,
                  });
                }
              }
            }

            if (budgetExhausted) {
              notes.push(
                `partial firing: job budget ${DISPATCH_SWEEP_JOB_BUDGET_MS}ms reached — ` +
                  `gathered ${population.length} of ${nonTerminal.length} issues, ` +
                  `resolved lanes for ${laneByIssueId.size} of ${population.length}, ` +
                  `woke ${wakeOutcomes.filter((o) => o.queued).length} of ${selection.picks.length} picks`,
              );
            }

            if (!dispatchConfig.wakeEnabled && selection.picks.length > 0) {
              notes.push(
                `report-only: would have woken ${selection.picks
                  .map((p) => p.issue.identifier ?? p.issue.id)
                  .join(", ")}`,
              );
            }

            const summary = summariseFiring(company.id, selection, wakeOutcomes);
            await emitMetrics(ctx, { companyId: company.id, summary, wakeEnabled: dispatchConfig.wakeEnabled });

            const previous = (await ctx.state.get(dispatchLastFiringKey(company.id))) as
              | ReturnType<typeof summariseFiring>
              | null;
            if (hasStateChanged(previous, summary)) {
              await logStateChange(ctx, { companyId: company.id, summary, wakeEnabled: dispatchConfig.wakeEnabled, notes });
              await ctx.state.set(dispatchLastFiringKey(company.id), summary);
            }

            ctx.logger.info("dispatch sweep complete", {
              companyId: company.id,
              budgetExhausted,
              woken: summary.counters.woken,
              candidatesReady: summary.legacy.candidates_ready,
              runnableQueue: summary.legacy.runnable_queue,
              routingGap: summary.routingGapCount,
              assignedGathered: assigned.length,
              idleAssigneePicks: summary.idleAssigneePickedIssueIds.length,
              laneDownSkips: summary.laneDownSkippedIssueIds.length,
              wakeFailures: summary.wakeFailures,
              wakeFailuresByReason: summary.wakeFailuresByReason,
            });
          } catch (cause) {
            ctx.logger.error("dispatch sweep failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
      });
      //  reopen: `onConfigChanged` only replays at worker startup for
      // a full plugin reload (plugin-loader.ts step 5b); a bare crash-restart
      // (`plugin-worker-manager.ts` autoRestart) respawns the process without
      // it, which would otherwise reset `knownCompanyIds` to empty and make
      // every scheduled job silently iterate zero companies. Seed from the
      // persisted set first so a crash-restarted worker still knows its
      // companies before the (possibly-skipped) replay arrives.
      const persistedCompanies = asRecord(await ctx.state.get(knownCompaniesKey()));
      if (Array.isArray(persistedCompanies.ids)) {
        for (const id of persistedCompanies.ids) {
          if (typeof id === "string") knownCompanyIds.add(id);
        }
      }

      void buildQualitySignals;
      ctx.logger.info("Model Selection worker ready", { version: PLUGIN_VERSION });
    },

    async onHealth() {
      return { status: "ok", message: `Model Selection ${PLUGIN_VERSION}` };
    },

    /**
     *  ( §4.3). Answers the host's run-scoped model
     * decision from hot caches only. Declared on the definition so the fork's
     * SDK advertises `resolveRunModel`; a host without the hook never calls it.
     */
    async onResolveRunModel(params: ResolveRunModelParams): Promise<ResolveRunModelResult> {
      if (!runResolveHandler) {
        return { kind: "defer", retryAfterMs: 2_000, reason: "model-selection worker is not ready" };
      }
      return runResolveHandler(params);
    },

    /**
     *  reopen: the sole feed for `knownCompanyIds` (see the comment
     * above its declaration). The host calls this unconditionally for every
     * configured company at worker startup (`plugin-loader.ts` step 5b) and
     * again on every operator config save — so this set converges to exactly
     * "companies with stored config for this plugin" without ever calling
     * `ctx.companies.list()` ourselves. `context.companyId === null` is an
     * instance/global save, which this plugin's config schema doesn't use;
     * skip it rather than tracking a non-company id.
     *
     * Persisted immediately (not just held in memory) so a bare crash-restart
     * — which respawns the worker without replaying `configChanged` — can
     * still recover the set from state in `setup()` above, instead of silently
     * running every scheduled job over zero companies.
     */
    async onConfigChanged(_newConfig, changeContext) {
      const companyId = changeContext?.companyId;
      // : a config save (the flag, the roster, the tier policy) must
      // not wait out the snapshot TTL.
      if (companyId) invalidateRunSnapshot?.(companyId);
      if (!companyId || knownCompanyIds.has(companyId)) return;
      knownCompanyIds.add(companyId);
      if (context) {
        await context.state.set(knownCompaniesKey(), { ids: [...knownCompanyIds] });
      }
    },

    async onValidateConfig(raw: Record<string, unknown>) {
      const { errors, warnings } = validateConfig(resolveConfig(raw));
      return { ok: errors.length === 0, errors, warnings };
    },

    async onApiRequest(input) {
      if (!context) return { status: 503, body: { error: "worker is not initialised" } };
      if (input.routeKey !== ROUTE_KEYS.advise && input.routeKey !== ROUTE_KEYS.applyIssue) {
        return { status: 404, body: { error: `unknown route ${input.routeKey}` } };
      }
      return { status: 501, body: { error: "use the registered tools; the HTTP surface is reserved" } };
    },
  } as PluginDefinitionWithRunResolve);
}

const plugin = createPlugin();
export default plugin;
runWorker(plugin, import.meta.url);
