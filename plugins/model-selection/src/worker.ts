import { definePlugin, runWorker, type PluginContext, type ToolResult } from "@paperclipai/plugin-sdk";

import { planApply } from "./actuate/apply.js";
import { resolveConfig, validateConfig, type ResolvedConfig } from "./config/resolve.js";
import {
  AA_FETCH_TIMEOUT_MS,
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
  BALANCE_PASS_WRITE_LIMIT,
  CARD_LEDGER_WINDOW_DAYS,
  CLASSIFY_FETCH_LIMIT_MAX,
  CLASSIFY_FETCH_MULTIPLIER,
  CLASSIFY_JOB_BUDGET_MS,
  DISPATCH_ISSUE_PAGE_LIMIT,
  LANE_EVIDENCE_TTL_MS,
  LANE_EVIDENCE_WINDOW_HOURS,
  JOB_KEYS,
  LOCAL_FOLDER_KEYS,
  LABEL_ONLY_PASS_FETCH_LIMIT,
  NO_ELIGIBLE_NOTICE_THROTTLE_MS,
  OPERATOR_PIN_LABEL,
  PLUGIN_STATE_KEYS,
  REJECTION_WINDOW_MS,
  REOPEN_WINDOW_MS,
  REPIN_PASS_FETCH_LIMIT,
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
import { effortSuffixOf, resolveAaSlug, tierImpliedByIndex } from "./aa-index/match.js";
import { parseAaLeaderboardHtml, type AaModelRecord } from "./aa-index/parse.js";
import { reconcilePrices, type PriceReconcileReport, type PriceRosterRow } from "./price-sync/diff.js";
import { fetchPriceCatalog, type PriceHttpClient } from "./price-sync/fetch.js";
import { parsePriceCatalog } from "./price-sync/parse.js";
import { ancillaryDriftForAgent, recommendAncillaryModel, type AncillarySurfaceDrift } from "./engine/ancillary.js";
import { estimateIssueContext, modelOverrideForContext } from "./engine/context.js";
import { resolveConfiguredModelId } from "./engine/model-id.js";
import { classifyCostAttribution } from "./engine/cost-attribution.js";
import { buildQualitySignals, buildVolumeProfiles, type RunRow } from "./engine/profiles.js";
import { selectModel } from "./engine/select.js";
import { normalizeAvailability, type AvailabilitySnapshot } from "./engine/availability.js";
import { resolveTier, tierFromLabels, tierOfModel } from "./engine/tier.js";
import {
  accumulateRunStats,
  applyDerivedTiers,
  blendedPriorP,
  buildCardLedger,
  buildModelScore,
  findClosingRun,
  foldReworkIntoStats,
  type CardRow,
  type ClosingRunCandidate,
  type ReworkClosingRun,
  type RunOutcomeRow,
} from "./engine/scores.js";
import { BENCHMARK_SPEC_VERSION, type BenchmarkRow } from "./engine/benchmark-prior.js";
import { FROZEN_BENCHMARK_ROWS } from "./engine/benchmark-data.js";
import type {
  CardLedgerEntry,
  IssueDescriptor,
  ModelEntry,
  ModelScore,
  QualitySignal,
  SelectionDecision,
  VolumeProfile,
} from "./engine/types.js";
import {
  activeOperatorOverride,
  activeZaiPaceOverride,
  blendedListPrice,
  hardStopExcluded,
  isLaneOutageActive,
  laneAvoidExcluded,
  laneEffectiveUtilization,
  laneHasRoom,
  laneOutageExcluded,
  mergeLedgerEntry,
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
  LANE_EVIDENCE_RUNS_SQL,
  LAST_RUN_CONTEXT_USAGE_SQL,
  REFRESH_SCORE_CLOSING_RUNS_SQL,
  REFRESH_SCORE_RUNS_SQL,
} from "./sql.js";
import {
  buildLaneEvidence,
  costDownWouldAbandonProvenLane,
  evidenceStateFor,
  type LaneEvidenceSnapshot,
} from "./engine/lane-evidence.js";
import { callClassifier, type ClassificationHttpClient } from "./engine/classify-call.js";
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
    return `${decision.modelId} at ${decision.effectiveTier} (tier via ${decision.judgement.source})${
      decision.advisory ? " — advisory, nothing written" : ""
    }${wakeNote}`;
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
 * TOG-2862. The measured half of an issue's context estimate: the input and
 * cached-input token counts of the most recent heartbeat run scoped to it.
 */
type ContextUsage = { lastRunInputTokens: number | null; lastRunCachedInputTokens: number | null };

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
   * TOG-2438 reopen: `ctx.companies.list()` is a wildcard host call that,
   * unlike every other call this worker makes, is not carried by the
   * per-company `proactiveCompanyScopes` authorization the host seeds
   * from this plugin's configured companies (LOOA-629/695). A scheduled
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

      // --- TOG-2137: lane pace ledger, operator overrides, repin history ----

      const laneLedgerKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.laneLedger,
      });

      const readLaneLedger = async (companyId: string): Promise<LaneLedger> => {
        const stored = await ctx.state.get(laneLedgerKey(companyId));
        return stored && typeof stored === "object" ? (stored as LaneLedger) : {};
      };

      // --- TOG-3132: lane availability -------------------------------------

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
       * TOG-3132, second failure shape: the lane-evidence term's input.
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
       * TOG-2137, Defect 2. `tier-exhausted` is a capacity dead end — every
       * model from the required tier through the T1 ceiling is
       * pace-unserviceable, and there is nowhere left for the ladder walk in
       * `select.ts` to climb to. `ctx.metrics.write` records the outcome for
       * dashboards, but a metric is not something an operator sees; this is
       * the "must reach an operator card, never a silent no-op" half.
       *
       * This reuses the instance's existing `Operator: <title>` + `operator`
       * label issue-creation convention (confirmed against 20+ live examples
       * — TOG-2318, TOG-2324, TOG-2333, etc. — all plain `manual`-origin
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

      // --- TOG-2137/2138/2504: paired decision emitter -----------------

      const SHADOW_DECISIONS_FILE = "decisions.jsonl";

      /**
       * A missing shadow-decisions file is the ordinary first-write case (folder
       * just configured, or `maxRecords` history not yet created) and the only
       * read failure that may be treated as "start from empty". Both the real
       * host (`fs` ENOENT surfaced through the RPC error message, since the
       * ENOENT string `code` does not survive the JSON-RPC error-code coercion)
       * and the SDK test harness (`Local folder file not found: ...`) signal it
       * this way, so it must be detected on the message text, not a numeric
       * code. Any other error — folder not configured, not readable, transient
       * I/O — is NOT this case, and treating it as "empty" is exactly the QA
       * TOG-2373 defect: it silently truncates the on-disk history.
       */
      const isMissingShadowFileError = (err: unknown): boolean => {
        const message = err instanceof Error ? err.message : String(err);
        return /not found/i.test(message) || /ENOENT/.test(message);
      };

      // Per-company promise chain so overlapping `advise()`/`apply()` calls
      // serialize their read-modify-write against the same JSONL file instead
      // of racing: two emits that both read the same "before" content and then
      // both write collapse to whichever write lands last, silently dropping
      // the other's record (TOG-2373).
      const decisionEmitChains = new Map<string, Promise<void>>();

      /**
       * Off by default (`shadowEmit.enabled`). Each authoritative decision
       * appends one `host` and one `plugin-shadow` projection to the same JSONL
       * file, capped at `maxRecords` — `ctx.localFolders` has no native
       * append, and the host only offers whole-file atomic replace. A write
       * failure is logged and swallowed: shadow emission is a side channel for
       * the TOG-2138 comparison stream, and must never fail the
       * `advise()`/`apply` call it rides on. A read failure is swallowed only
       * when it means "no file yet" — any other read failure aborts the emit
       * instead of overwriting real history with a one-record file.
       */
      const emitDecisionPairSerialized = async (
        companyId: string,
        records: readonly ReturnType<typeof buildShadowRecord>[],
      ): Promise<void> => {
        let existing = "";
        try {
          existing = await ctx.localFolders.readText(companyId, LOCAL_FOLDER_KEYS.shadowDecisions, SHADOW_DECISIONS_FILE);
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
        const config = await companyConfig(companyId);
        // A retained history must never split the newest host/shadow pair. An
        // odd configured cap is rounded down, with two records as the floor.
        const pairAlignedCap = Math.max(2, config.shadowEmit.maxRecords - (config.shadowEmit.maxRecords % 2));
        const capped = lines.length > pairAlignedCap ? lines.slice(-pairAlignedCap) : lines;
        try {
          await ctx.localFolders.writeTextAtomic(
            companyId,
            LOCAL_FOLDER_KEYS.shadowDecisions,
            SHADOW_DECISIONS_FILE,
            capped.join("\n") + "\n",
          );
        } catch (err) {
          ctx.logger.warn("model-selection: shadow decision emit failed", { error: String(err) });
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

      // --- TOG-2481: LLM tier classification (tier_dispatcher.py classify()) --

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
       * TOG-3200. Provenance for the `tier:*` labels this job wrote:
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

      const shadowDiffsKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.shadowDiffs,
      });

      // --- TOG-2481: absorbed dispatch stall-sweep (TOG-747/TOG-706) ---------

      const dispatchLastFiringKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.dispatchLastFiring,
      });

      /**
       * TOG-2481 port of `tier_dispatcher.py`'s `lane_active_pins()`: current
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

      // --- TOG-2438: aa.ai Intelligence Index snapshot + per-company drift dedup ---

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
        /** Every aa.ai slug (one per model x effort-level) mapped to its full parsed record (TOG-2438 scope expansion). */
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
       * TOG-2438 scope expansion ("store the raw snapshot per fetch ... so
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
       * TOG-2862. The one genuinely expensive read behind a descriptor: the
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
      ): Promise<{ lastRunInputTokens: number | null; lastRunCachedInputTokens: number | null }> => {
        const contextRows = (await ctx.db.query(LAST_RUN_CONTEXT_USAGE_SQL, [companyId, issueId])) as unknown[];
        const contextRow = asRecord(contextRows[0]);
        const rawInput = Number(contextRow.input_tokens);
        const rawCached = Number(contextRow.cached_input_tokens);
        return {
          lastRunInputTokens: Number.isFinite(rawInput) && rawInput >= 0 ? Math.floor(rawInput) : null,
          lastRunCachedInputTokens: Number.isFinite(rawCached) && rawCached >= 0 ? Math.floor(rawCached) : null,
        };
      };

      const loadContextUsage = (
        companyId: string,
        issueId: string,
        cache?: ContextUsageCache,
      ): Promise<ContextUsage> => {
        if (!cache) return readLastRunContextUsage(companyId, issueId);
        const key = `${companyId}:${issueId}`;
        const memo = cache.get(key);
        if (memo) return memo;
        const pending = readLastRunContextUsage(companyId, issueId);
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
        /** TOG-3995. `null` = UNKNOWN; decides the effort key and vocabulary. */
        agentAdapterType: string | null;
        /** TOG-3995. `null` = UNKNOWN; read only for the effort it already carries. */
        agentAdapterConfig: Record<string, unknown> | null;
        existingOverrideEnv: Record<string, unknown>;
        /** Lazy + per-pass memoized; see {@link loadContextUsage}. */
        contextUsage: () => Promise<ContextUsage>;
        /** TOG-3111: the assignment signal a creation-time pin keys on. */
        assigneeAgentId: string | null;
        /** TOG-3111: raw description for the classification prompt. */
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
        // would wipe the agent's real bindings for the run (TOG-3045).
        let agentEnv: Record<string, unknown> | null = null;
        // TOG-3995. Same UNKNOWN discipline: the effort a pin may legally write
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
          // TOG-3210: the caller's PAPERCLIP_WAKE_REASON for this run, if any.
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
          description: String(issue.description ?? ""),
          agentEnv,
          agentAdapterType,
          agentAdapterConfig,
          existingOverrideEnv,
          contextUsage: () => loadContextUsage(companyId, issueId, contextUsageCache),
        };
      };

      const advise = async (
        companyId: string,
        params: Record<string, unknown>,
        /**
         * TOG-2481 port of `tier_dispatcher.py` `pick(..., explore=False)`.
         * `labelOnlyPass`/`repinPass`/`balancePass`'s pinned-branch calls set
         * this `false` — they are re-affirming or replacing an existing pin,
         * not seeding new evidence. Defaults `true`: unchanged tool behavior.
         */
        allowExplore = true,
        /**
         * TOG-2481 port of `balance_pass()`'s unpinned branch:
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
         * TOG-2862. The owning pass's per-issue context memo. A scheduled pass
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
        nowIso: string;
        config: ResolvedConfig;
        title: string;
        identifier: string | null;
        agentFloorModelId: string | null;
        pinnedModelId: string | null;
        /** `null` means UNKNOWN, not empty — see ModelOverrideInput.agentEnv in engine/context.ts. */
        agentEnv: Record<string, unknown> | null;
        /** TOG-3995. `null` = UNKNOWN; decides the effort key and vocabulary. */
        agentAdapterType: string | null;
        /** TOG-3995. `null` = UNKNOWN; read only for the effort it already carries. */
        agentAdapterConfig: Record<string, unknown> | null;
        existingOverrideEnv: Record<string, unknown>;
      } | null> => {
        const issueId = typeof params.issueId === "string" ? params.issueId : null;
        if (!issueId) return null;
        const config = await companyConfig(companyId);
        const described = await describeIssue(companyId, issueId, params, contextUsageCache);
        if (!described) return null;
        if (forceTier) {
          described.descriptor.labelNames = [`${TIER_LABEL_PREFIX}${forceTier}`];
        }
        if (suppressSticky) {
          described.descriptor.stickyModelId = null;
        }
        const { profiles, signals } = await readProfiles(companyId);
        const laneLedger = await readLaneLedger(companyId);
        const pacingActive = config.pacing.mode !== "off";
        const profileTier = resolveTier(
          described.descriptor,
          config.models,
          config.selection.defaultTier,
          {
            isLaneUnserviceable: (model) => pacingActive && hardStopExcluded(laneLedger, model),
          },
        ).tier;
        const profile = profiles.find((entry) => entry.tier === profileTier) ?? null;
        // The measured half of the estimate. This is the only place `advise`
        // needs the `heartbeat_runs` read, and it sits AFTER `resolveTier`,
        // which reads labels and lane state only — so nothing above this line
        // depends on it.
        const usage = await described.contextUsage();
        const contextEstimate = estimateIssueContext({
          explicitTokens:
            typeof params.requiredContextTokens === "number" ? params.requiredContextTokens : undefined,
          lastRunInputTokens: usage.lastRunInputTokens,
          lastRunCachedInputTokens: usage.lastRunCachedInputTokens,
          fleetCeilingTokens: config.selection.fleetContextCeilingTokens,
        });
        described.descriptor.requiredContextTokens = contextEstimate.tokens ?? undefined;
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
          descriptor: described.descriptor,
          config: {
            enforcementEnabled: config.selection.enabled && config.selection.mode === "enforce",
            defaultTier: config.selection.defaultTier,
            // TOG-2988: the roster's hand-placed tier is overlaid with the tier
            // `refreshScores` derived from the model's posterior. Unscored models
            // and scores from a superseded spec version keep the configured tier.
            models: applyDerivedTiers(config.models, modelScores),
            holdOnUntrustedProfile: config.selection.holdOnUntrustedProfile,
            stickyWithinIssue: config.selection.stickyModelWithinIssue,
            pacingMode: config.pacing.mode,
            laneLedger,
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

        // Whether the CURRENTLY PINNED model (not the newly-computed winner) sits
        // on an unserviceable lane — this, not a routine pace-preference change,
        // is the only thing allowed to force a repin through `pin:operator`.
        const pinnedModelId = resolveConfiguredModelId(
          described.descriptor.pinnedModelId,
          config.models,
        );
        const pinnedModel = config.models.find((model) => model.id === pinnedModelId);
        const isServiceabilityHardStop =
          config.pacing.mode !== "off" && !!pinnedModel && hardStopExcluded(laneLedger, pinnedModel);

        await ctx.metrics.write(`model_selection.decision.${decision.outcome}`, 1);

        // TOG-3132 AC-6, the operational half: the term is the metric name, so
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
            descriptor: described.descriptor,
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
              wakeReason: {
                type: "string",
                description:
                  "TOG-3210. Pass the run's PAPERCLIP_WAKE_REASON here so a cheap re-check (e.g. a monitor tick) can get a lower advisory floor without ever changing the card's own tier — see wakeScopedFloor config.",
              },
            },
          },
        },
        async (params, runCtx): Promise<ToolResult> => {
          const result = await advise(runCtx.companyId, asRecord(params));
          if (!result) return { content: "Issue not found, or issueId was missing.", data: null };
          await raiseOrClearTierExhaustedAlarm(
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
              wakeReason: {
                type: "string",
                description:
                  "TOG-3210. A wake-scoped decision is always forced advisory, so passing this on `apply` never writes a lowered tier — it only ever affects the returned recommendation for this call.",
              },
            },
          },
        },
        async (params, runCtx): Promise<ToolResult> => {
          const result = await advise(runCtx.companyId, asRecord(params));
          if (!result) return { content: "Issue not found, or issueId was missing.", data: null };
          await raiseOrClearTierExhaustedAlarm(
            runCtx.companyId,
            result.issueId,
            result.title,
            result.identifier,
            result.decision,
            runCtx.agentId ?? null,
          );

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

          const selectedModel = result.config.models.find((model) => model.id === plan.modelId);
          if (!selectedModel) {
            return {
              content: `No write: selected model ${plan.modelId} is absent from the resolved roster`,
              data: { decision: result.decision, plan },
            };
          }
          const patch: IssueUpdatePatch = modelOverrideForContext({
            model: selectedModel,
            fleetCeilingTokens: result.config.selection.fleetContextCeilingTokens,
            compactionRatio: result.config.selection.compactionRatio,
            agentEnv: result.agentEnv,
            agentAdapterType: result.agentAdapterType,
            agentAdapterConfig: result.agentAdapterConfig,
            existingOverrideEnv: result.existingOverrideEnv,
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
            return { content: "issueId and modelId are both required.", data: null };
          }
          const config = await companyConfig(runCtx.companyId);
          const configuredModelId = resolveConfiguredModelId(modelId, config.models);
          if (!configuredModelId) {
            return {
              content: `modelId ${modelId} is not a configured roster entry.`,
              data: null,
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
            "TOG-2481 port of lane_outage.json: declare a telemetry-invisible outage on named lanes/models until an ISO timestamp, or clear it by omitting both lanes and models.",
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
          if (!until) return { content: "until is required (ISO-8601 UTC timestamp).", data: null };
          if (lanes.length === 0 && models.length === 0) {
            await ctx.state.set(laneOutageKey(runCtx.companyId), null);
            return { content: "lane outage cleared.", data: null };
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
            "TOG-2481 port of zai_pace_override.json: temporarily widen (or tighten) the margin zaiWeeklyPaceOk allows above elapsed-week fraction, e.g. during a Codex outage. Clear by omitting margin.",
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
          if (!until) return { content: "until is required (ISO-8601 UTC timestamp).", data: null };
          if (typeof supplied.margin !== "number") {
            await ctx.state.set(zaiPaceOverrideKey(runCtx.companyId), null);
            return { content: "zai pace override cleared.", data: null };
          }
          const override: ZaiPaceOverride = { margin: supplied.margin, until };
          await ctx.state.set(zaiPaceOverrideKey(runCtx.companyId), override);
          return { content: `zai pace override recorded: margin ${supplied.margin} until ${until}`, data: override };
        },
      );

      // --- rework-signal capture (TOG-1917 §2.2 / model_scores.py:93-131) ---
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

      ctx.events.on("issue.updated", async (event) => {
        const payload = asRecord(event.payload);
        const changes = asRecord(payload.changes);
        const issueId = typeof event.entityId === "string" ? event.entityId : null;

        // TOG-3111: fresh assignment (null -> agent id) is the other
        // "creation moment" — cards are frequently created unassigned and
        // assigned by a later PATCH, after `issue.created` already fired and
        // found no assignee. Agent-to-agent reassignment is deliberately out
        // of scope: that card already had its creation moment under the
        // previous assignee, and moving an existing card is repinPass
        // territory, not a creation pin.
        const assignment = asRecord(changes.assigneeAgentId);
        const assignedTo = typeof assignment.to === "string" ? assignment.to : null;
        if (issueId && assignedTo && assignment.from == null) {
          try {
            await pinAtDecisionTime(event.companyId, issueId, "issue.updated:assignment");
          } catch (cause) {
            ctx.logger.error("assignment-time pin failed", {
              companyId: event.companyId,
              issueId,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }

        const status = asRecord(changes.status);
        const from = typeof status.from === "string" ? status.from : null;
        const to = typeof status.to === "string" ? status.to : null;
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
        await appendReworkSignal(event.companyId, {
          issueId,
          atMs: Date.parse(event.occurredAt) || Date.now(),
          kind: "rejected",
          excludeAgentId: typeof event.actorId === "string" ? event.actorId : null,
        });
      });

      // --- TOG-3111: creation-time pin + unpinnable-card visibility ---------
      // The scheduled passes are `*/10` and their row queries EXCLUDE cards
      // with a running/queued run — a card dispatched within seconds of
      // creation (measured 0.2-0.3 s create-to-first-run,
      // docs/routing/TOG-3008-issue-created-pin-feasibility.md) is already
      // running at every pass firing, so it stays unlabelled and unpinned for
      // its whole first turn and lands on the agent floor. These handlers see
      // the card from the event stream the moment it exists. They cannot own
      // the first turn either (the bus is fire-and-forget and loses the same
      // measured race); they pin every card the passes were missing as soon
      // as it is idle — exactly the release mechanism the core-side dispatch
      // gate (TOG-3111 half 1) needs once it lands.

      /**
       * TOG-3111 AC3. One visible activity notice per throttle window for a
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
       * TOG-3111 half 2. Classify (if needed), label, and pin one card from
       * the event stream instead of waiting for the 10-minute passes. Label-tier
       * semantics — the pin is decided at the card's own tier label (existing,
       * or just written by the classification above), the same outcome
       * `labelOnlyPass` would produce, NOT balancePass's forced T1: an event
       * path that changed routing policy would be a silent policy change, and
       * this only moves the same decision earlier in time. Never writes unless
       * the card is agent-assigned, open, idle and unpinned;
       * `balanceWriteStillSafe` re-reads all of that immediately before the
       * write, because an override landing on a card that just dispatched
       * would reset a warm session.
       */
      const pinAtDecisionTime = async (companyId: string, issueId: string, source: string): Promise<void> => {
        const config = await companyConfig(companyId);
        if (!config.classification.enabled) return;

        const described = await describeIssue(companyId, issueId, {});
        if (!described) return;
        // `issue.created` carries no assignee (TOG-3008 §3) — an unassigned
        // card returns here and is picked up by the assignment arm below.
        if (!described.assigneeAgentId) return;
        if (!balanceOpenStatuses.has(described.status)) return;
        if (described.hasOperatorPin) return;
        if (described.descriptor.pinnedModelId) return;

        // The tier this card is pinned at: its existing label's tier, or the
        // tier the classification below is about to write. Passed explicitly
        // to `advise` (its `forceTier` slot) rather than re-read from the
        // issue: making the label-write -> label-read round trip
        // load-bearing within one tick would couple correctness to the
        // host's `issues.get` label enrichment, and the plugin already
        // knows the answer.
        let tier: Tier | null = described.hasTierLabel
          ? tierFromLabels(described.descriptor.labelNames)
          : null;

        if (!described.hasTierLabel) {
          // Mirror of classifyIssues' per-row path minus the row query: the
          // event already named this card; classifyIssues cannot see it
          // precisely because it dispatches before the next pass fires.
          if (!config.classification.baseUrl || !config.classification.modelId) return;
          let apiKey: string | null = null;
          if (config.classification.apiKeySecretRef) {
            try {
              apiKey = await ctx.secrets.resolve(config.classification.apiKeySecretRef as never, {
                companyId,
                configPath: "classification.apiKeySecretRef",
              });
            } catch {
              ctx.logger.error("creation-pin classification secret unavailable", { companyId, issueId });
              return;
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
            return;
          }
          const judgement = parseClassificationResponse(classified.text);
          if (!judgement) {
            ctx.logger.info("creation-pin classification unparseable", { companyId, issueId });
            return;
          }
          const { labelTier } = resolveClassifiedTiers(judgement, {
            t3ConfidenceFloor: config.classification.t3ConfidenceFloor,
            t2ConfidenceFloor: config.classification.t2ConfidenceFloor,
          });
          tier = labelTier;
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
        }

        if (!tier) return; // no label, no classification, nothing to pin at
        const result = await advise(companyId, { issueId }, false, tier, false);
        if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) {
          await maybeLogUnpinnableCard(companyId, issueId, described.identifier, result?.decision ?? null);
          return;
        }
        // `advise` re-described the card: trust its fresher idle/pin reads,
        // not the pre-classification ones.
        if (!result.isIdle || !balanceOpenStatuses.has(result.status)) return;
        if (result.pinnedModelId !== null) return;
        const floorModelId = resolveConfiguredModelId(result.agentFloorModelId, config.models);
        if (result.decision.modelId === floorModelId) {
          // The router decided, and its pick IS the floor model — same
          // convention as labelOnlyPass/balancePass: no redundant override on
          // a card already running exactly that model.
          ctx.logger.info("creation-time pin skipped: pick equals floor", { companyId, issueId, source });
          return;
        }
        const selectedModel = config.models.find((model) => model.id === result.decision.modelId);
        if (!selectedModel) return;
        if (!(await balanceWriteStillSafe(companyId, issueId, null, config.models))) return;
        await ctx.issues.update(
          issueId,
          modelOverrideForContext({
            model: selectedModel,
            fleetCeilingTokens: config.selection.fleetContextCeilingTokens,
            compactionRatio: config.selection.compactionRatio,
            agentEnv: result.agentEnv,
            agentAdapterType: result.agentAdapterType,
            agentAdapterConfig: result.agentAdapterConfig,
            existingOverrideEnv: result.existingOverrideEnv,
          }) as Parameters<typeof ctx.issues.update>[1],
          companyId,
        );
        await ctx.activity.log({
          companyId,
          message: `Model Selection pinned ${result.decision.modelId} (${result.decision.effectiveTier}) at card creation — TOG-3111 (${source})`,
          entityType: "issue",
          entityId: issueId,
          metadata: {
            modelId: result.decision.modelId,
            tier: result.decision.effectiveTier,
            source,
            trace: result.decision.trace,
          },
        });
      };

      ctx.events.on("issue.created", async (event) => {
        const issueId = typeof event.entityId === "string" ? event.entityId : null;
        if (!issueId) return;
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
              // TOG-2438 scope expansion: full-record fields, surface only —
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

      // --- scheduled lane-capacity poll (TOG-2137) ---------------------------
      // Runs every 5 minutes, well inside pace's own ~15-minute default
      // freshness budget. One company's failure, or one lane's failure within
      // a company, must never block any other company or lane.
      ctx.jobs.register(JOB_KEYS.pollLanes, async () => {
        const companies = listKnownCompanies();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            if (config.pacing.lanes.length === 0) continue;

            // TOG-2379: resolve each lane's optional secret before it is
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
                    // (TOG-2500) — a laneId-keyed path here reads back nothing
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

            // TOG-3132 AC-2: the availability term's writer. Published from the
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

      // --- scheduled aa.ai Intelligence Index refresh (TOG-2438) -------------
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
      // (TOG-2438 reopen AC4) without duplicating the fetch/diff/surface
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

      // Manual operator escalation for the same sweep (TOG-2438 reopen AC4):
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

      // --- scheduled models.dev price reconciliation (TOG-3996) ------------
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
      // thirteen CAP-061-marked rows shipped disabled rather than let an
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
            return { content: "No company scope on this call; cannot read a per-company price report." };
          }
          const stored = asRecord(await ctx.state.get(priceReconcileReportKey(companyId)));
          const report = stored.report as PriceReconcileReport | undefined;
          if (!report) {
            return {
              content:
                "No models.dev price reconciliation has completed for this company yet. Run " +
                `${TOOL_NAMES.reconcilePricesNow} or wait for the daily job.`,
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

      // --- scheduled score + card-ledger refresh (TOG-1917 §2.2 / TOG-2136) -
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
              } catch {
                // An issue we cannot read is unattributable, not tier:none —
                // the same "drop rather than guess" policy accumulateRunStats
                // applies to every other unattributable row.
                tierByIssue.set(issueId, null);
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

            // TOG-4022: `usage_json.costUsd` is the serving CLI's own figure,
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
            // TOG-2988: the TOG-2636 five-benchmark basket, superseding the
            // TOG-2438 agentic sub-score average. Frozen `tog2636-v1` vectors —
            // three of the five benchmarks are not aa.ai columns at all, and
            // mixing live aa.ai rows with the capture would blend effort levels
            // (see `benchmark-data.ts`). The composite index half stays live.
            const benchmarkRow = (model: (typeof config.models)[number]): BenchmarkRow | null =>
              FROZEN_BENCHMARK_ROWS[model.id] ?? null;

            const modelScores: ModelScore[] = config.models.map((model) =>
              buildModelScore(model.id, liveAaIndex(model), statsByModel[model.id] ?? {}, TIERS, benchmarkRow(model)),
            );

            // TOG-2974 owner directive: the router alone decides the tier, so
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

            // `computedAt` stamps the capture itself. Without it a stalled
            // refresh (the failure TOG-2862 gates for) is undetectable from the
            // stored state: the fleet keeps routing on whatever tiers the last
            // successful pass wrote, and the spec-version guard cannot see it —
            // that guard catches a code change, never a stale capture.
            const computedAt = new Date().toISOString();
            await ctx.state.set(scoresKey(company.id), { modelScores, cardLedger, computedAt });
            ctx.logger.info("model scores refreshed", {
              companyId: company.id,
              models: modelScores.length,
              cardsInLedger: cardRows.length,
              // TOG-4022: runs whose recorded cost was priced against the
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

      // --- scheduled LLM tier classification (TOG-2481, tier_dispatcher.py
      // main()) -----------------------------------------------------------
      // For every open, agent-assigned issue with no per-issue override, no
      // `pin:operator`, and no running/queued run, classify it with the RUBRIC
      // and write a tier:* label (never a status or assignee change — same
      // contract as the ported script's file-level docstring). The AC3 kill
      // switch is `classification.enabled: false` (default): a company that
      // never sets it true gets byte-identical behavior to before this job
      // existed.
      //
      // TOG-3200 removed "with no tier:* label" from that list. An existing
      // label now ends the candidate only when THIS job wrote it
      // (`classifierLabeledIssues` provenance); a label written by anybody else
      // is re-examined and replaced. `classification.reclassifyForeignLabels:
      // false` is the one-key rollback to the old unconditional skip.
      ctx.jobs.register(JOB_KEYS.classifyIssues, async () => {
        const companies = listKnownCompanies();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            if (!config.classification.enabled) continue;
            if (!config.classification.baseUrl || !config.classification.modelId) continue;

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
            // TOG-3200: over-fetch. Because every label-based skip happens
            // per-row AFTER this query, a `limit batchSize` returns the same
            // top-N skipped rows on every run and never reaches row N+1. The
            // loop below stops at `batchSize` actual classifications instead.
            const classifyFetchLimit = Math.min(
              config.classification.batchSize * CLASSIFY_FETCH_MULTIPLIER,
              CLASSIFY_FETCH_LIMIT_MAX,
            );
            const classifyDeadline = Date.now() + CLASSIFY_JOB_BUDGET_MS;
            // TOG-3585: incremental scan — only issues updated since this
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
              // TOG-3585: the observable skip — nothing changed since the
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
            // TOG-3585: rows this loop actually reached, for the watermark
            // fix below — a `break` on the batch/deadline budget must not be
            // mistaken for having examined every fetched row.
            const examinedRows: unknown[] = [];
            let brokeEarly = false;
            for (const row of candidateRows) {
              const r = asRecord(row);
              const issueId = typeof r.id === "string" ? r.id : null;
              const identifier = typeof r.identifier === "string" ? r.identifier : issueId;
              if (!issueId) {
                examinedRows.push(row);
                continue;
              }

              if (classified >= config.classification.batchSize || Date.now() >= classifyDeadline) {
                brokeEarly = true;
                break;
              }
              examinedRows.push(row);

              // The row query above cannot see labels (not allowlisted), so
              // label and pin state is read per candidate via
              // `ctx.issues.get()` — the same source `describeIssue` uses for
              // label reads elsewhere in this worker.
              let issue: Awaited<ReturnType<typeof ctx.issues.get>>;
              try {
                issue = await ctx.issues.get(issueId, company.id);
              } catch {
                continue;
              }
              if (!issue) continue;
              const labelNames = (issue.labels ?? [])
                .map((label) => label.name)
                .filter((name): name is string => typeof name === "string");
              const existingLabelIds =
                issue.labelIds ?? (issue.labels ?? []).map((label) => label.id).filter((id) => typeof id === "string");

              // An operator pin means "leave the model choice on this issue
              // alone" — unchanged, and checked before anything else.
              if (labelNames.includes(OPERATOR_PIN_LABEL)) continue;

              // TOG-3200. An existing tier:* label used to end the candidate
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
              const ourRecordedTier = classifierLabeled[issueId];
              const ourLabelId = ourRecordedTier ? config.tierLabelIds[ourRecordedTier] : undefined;
              const stillCarriesOurLabel =
                ourRecordedTier !== undefined &&
                (ourRecordedTier === existingLabelTier ||
                  (typeof ourLabelId === "string" && existingLabelIds.includes(ourLabelId)));
              const isForeignLabel = existingLabelTier !== null && !stillCarriesOurLabel;
              if (existingLabelTier !== null) {
                if (!config.classification.reclassifyForeignLabels) continue;
                if (!isForeignLabel) continue;
              }

              const agentName = typeof r.agent_name === "string" ? r.agent_name : "";
              const title = typeof r.title === "string" ? r.title : "";
              const description = typeof r.description === "string" ? r.description : "";
              const prompt = buildClassificationPrompt(title, description, agentName, config.classification.descriptionChars);

              const result = await callClassifier(
                {
                  baseUrl: config.classification.baseUrl,
                  protocol: config.classification.protocol,
                  modelId: config.classification.modelId,
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
                continue;
              }

              const judgement = parseClassificationResponse(result.text);
              if (!judgement) {
                ctx.logger.info("classification unparseable", { companyId: company.id, issue: identifier });
                continue;
              }

              const { labelTier, pickTier } = resolveClassifiedTiers(judgement, {
                t3ConfidenceFloor: config.classification.t3ConfidenceFloor,
                t2ConfidenceFloor: config.classification.t2ConfidenceFloor,
              });
              void pickTier; // consumed by the apply-sweep (TOG-2481 task #6/#7), not this job

              const labelId = config.tierLabelIds[labelTier];
              if (labelId) {
                // TOG-3200: adding is only correct when there was no tier label
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
            }

            await advanceScanMark(
              company.id,
              PLUGIN_STATE_KEYS.classifyLastScanAt,
              examinedRows,
              classifyFetchLimit,
              classifyFiringStartMs,
              !brokeEarly,
            );
            ctx.logger.info("issue classification pass complete", {
              companyId: company.id,
              classified,
              reclassified,
              candidates: candidateRows.length,
            });
          } catch (cause) {
            ctx.logger.error("issue classification failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
      });

      // --- shared helpers for the three scheduled sweeps below (TOG-2481:
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
       * TOG-3585: incremental-scan watermarks. Each router pass reads only
       * issues updated since its own mark and advances the mark past what it
       * scanned. Three fail-open rules keep a broken clock from starving a
       * pass:
       *
       *   - an unreadable or unparseable mark reads as epoch (full scan);
       *   - the mark advances to the firing start only when the fetch did NOT
       *     hit its row limit (drained); on a capped fetch it advances to the
       *     oldest `updated_at` actually seen, so cap-skipped rows stay
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

      const oldestUpdatedAtMs = (rows: unknown[]): number | null => {
        let oldest: number | null = null;
        for (const row of rows) {
          const raw = asRecord(row).updated_at;
          const ms = raw instanceof Date ? raw.getTime() : typeof raw === "string" ? Date.parse(raw) : Number.NaN;
          if (!Number.isFinite(ms)) continue;
          if (oldest === null || ms < oldest) oldest = ms;
        }
        return oldest;
      };

      /**
       * TOG-3585: advance the watermark after a bounded fetch. Drained (fewer
       * rows than the limit) AND fully examined means everything newer than
       * the mark was seen — jump to the firing start. Otherwise (capped
       * fetch, or the caller's own loop broke early on a write/time budget
       * before working through every fetched row) rows remain unexamined —
       * creep to the oldest of the rows the caller actually looked at, so
       * next firing overlaps rather than skips.
       *
       * `fullyExamined` defaults to true for callers whose loop has no early
       * break other than draining `rows` itself (e.g. `labelOnlyPass`).
       * Callers with a batch-size or wall-clock break (`classifyIssues`,
       * `runRepinPassForCompany`) must pass `false` — and only the subset of
       * rows their loop actually reached — whenever that break fires, even
       * if the underlying fetch was itself uncapped. Conflating "fetch
       * wasn't capped" with "loop wasn't cut short" is exactly the
       * starvation bug this pass fixes: it silently dropped fetched-but-
       * unexamined rows from every future scan until they were touched
       * again.
       */
      const advanceScanMark = async (
        companyId: string,
        stateKey: string,
        rows: unknown[],
        fetchLimit: number,
        firingStartMs: number,
        fullyExamined = true,
      ): Promise<void> => {
        if (fullyExamined && rows.length < fetchLimit) {
          await writeScanMark(companyId, stateKey, firingStartMs);
          return;
        }
        const oldest = oldestUpdatedAtMs(rows);
        if (oldest !== null) await writeScanMark(companyId, stateKey, oldest);
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
       * matching every other TOG-2481 gate.
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
        const model = config.models.find((m) => m.id === modelId && m.enabled);
        if (!model) return false;
        if (typeof requiredContextTokens === "number" && model.contextWindow < requiredContextTokens) return false;
        if (config.pacing.mode === "off") return true;
        if (hardStopExcluded(laneLedger, model)) return false;
        if (laneAvoidExcluded(laneLedger, model, config.pacing.avoid)) return false;
        if (laneOutageExcluded(laneOutageOverride, nowIso, model)) return false;
        const score = modelScores[model.id]?.tiers[tier];
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
       * TOG-3024 (TOG-3012 root cause #3, 2026-09-16 16:40Z incident).
       * `labelOnlyPass`/`repinPass`/`balancePass` used to gate on
       * `tierFromLabels(...)` alone and `continue` when it returned null — so
       * a card with no tier:* label at all (label inherited-and-cleared,
       * classification disabled, or the classifier hasn't reached it yet) was
       * not routed conservatively, it was never considered by any of the
       * three passes. TOG-2983/2987/2989 sat exactly like this during the
       * incident until an operator hand-labelled them.
       *
       * `resolveTier()` (engine/tier.ts) already establishes the fallback a
       * missing label should take — pin's own tier, then the assignee's
       * floor, then `selection.defaultTier` — per ADR-0008's "a missing
       * label is not a missing decision." This mirrors that same precedence
       * (skipping the pin-serviceability and capability-exclusion steps,
       * which these three passes don't otherwise evaluate) so a label-less
       * candidate resolves to the same answer `advise()` would give it,
       * instead of being invisible to the sweep that is supposed to catch it.
       */
      const tierWithFallback = (descriptor: IssueDescriptor, models: ResolvedConfig["models"], defaultTier: Tier): Tier =>
        tierFromLabels(descriptor.labelNames) ??
        tierOfModel(descriptor.pinnedModelId, models) ??
        tierOfModel(descriptor.agentFloorModelId, models) ??
        defaultTier;

      // --- scheduled label-only pass (TOG-2481, tier_dispatcher.py
      // label_only_pass()) --------------------------------------------------
      // 2026-09-07 01:0xZ owner rule: a card that already carries a tier:*
      // label but no pin (label inherited/copied from a parent card, e.g.
      // TOG-1348 cloned TOG-1334's tier:T1) was skipped by the classify job
      // (which only looks at issues with NO tier:* label) and never pinned —
      // the model-selection plugin then chose the model on its own, putting
      // the Steward's TOG-1348 run on claude-sonnet-5 while the Claude lane
      // sat at 0.84 (AVOID). Pin these from the existing label without
      // re-classifying.
      ctx.jobs.register(JOB_KEYS.labelOnlyPass, async () => {
        const companies = listKnownCompanies();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            if (!config.classification.enabled) continue;

            // Same allowlisted-table constraint as classifyIssues: the row
            // query can only see issues/agents, never labels — so this finds
            // "has no override" candidates here, and confirms the tier:*
            // label (and absence of pin:operator) per row via
            // `ctx.issues.get()` below, exactly like `describeIssue` does.
            // TOG-3585: incremental scan on this pass's own watermark.
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

            // TOG-3037. Read fresh, right before the floor-equality check
            // below — not reused from `advise()`'s own internal read — so a
            // lane that went bad between that internal read and this pass's
            // write decision is still caught.
            const laneLedger = await readLaneLedger(company.id);
            const laneOutageOverride = await readLaneOutage(company.id);
            const modelScores = await readModelScores(company.id);
            const nowIso = new Date().toISOString();

            // TOG-2862. One memo per company per pass: `advise` re-describes
            // the rows that survive the cheap rejections, and without this it
            // would repeat their `heartbeat_runs` read.
            const contextUsageCache: ContextUsageCache = new Map();

            let pinned = 0;
            for (const row of candidateRows) {
              const r = asRecord(row);
              const issueId = typeof r.id === "string" ? r.id : null;
              const identifier = typeof r.identifier === "string" ? r.identifier : issueId;
              if (!issueId) continue;

              const described = await describeIssue(company.id, issueId, {}, contextUsageCache);
              if (!described) continue;
              if (described.hasOperatorPin) continue;
              const labelTier = tierFromLabels(described.descriptor.labelNames);
              const tier = tierWithFallback(described.descriptor, config.models, config.selection.defaultTier);

              const result = await advise(company.id, { issueId }, false, undefined, false, contextUsageCache);
              if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) {
                ctx.logger.info("label-only pass: no pick", { companyId: company.id, issue: identifier, tier });
                // TOG-3111 AC3: a card the router cannot pin must be visible
                // on its own activity feed, not just in this worker's log.
                await maybeLogUnpinnableCard(company.id, issueId, identifier, result?.decision ?? null);
                continue;
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
                // TOG-3037: elide only while the floor is actually serviceable.
                // An implicit NULL-override pin to a dead-lane floor is exactly
                // the invariant violation this pass exists to close, and a
                // NULL override is invisible to `repinPass` going forward.
                ctx.logger.info("label-only pass skipped: pick equals healthy floor", {
                  companyId: company.id,
                  issue: identifier,
                  tier,
                });
                continue;
              }

              const selectedModel = config.models.find((model) => model.id === result.decision.modelId);
              if (!selectedModel) continue;
              await ctx.issues.update(
                issueId,
                modelOverrideForContext({
                  model: selectedModel,
                  fleetCeilingTokens: config.selection.fleetContextCeilingTokens,
                  compactionRatio: config.selection.compactionRatio,
                  agentEnv: described.agentEnv,
                  agentAdapterType: described.agentAdapterType,
                  agentAdapterConfig: described.agentAdapterConfig,
                  existingOverrideEnv: described.existingOverrideEnv,
                }) as Parameters<typeof ctx.issues.update>[1],
                company.id,
              );
              await ctx.activity.log({
                companyId: company.id,
                message:
                  result.decision.modelId === floorModelId
                    ? `Model Selection explicitly pinned ${result.decision.modelId} (${tier}): floor lane unserviceable`
                    : `Model Selection label-only pinned ${result.decision.modelId} (${tier}) from ${
                        labelTier ? "the existing tier label" : "the tier floor/default (no tier label present)"
                      }`,
                entityType: "issue",
                entityId: issueId,
                metadata: { modelId: result.decision.modelId, tier, fromLabel: labelTier !== null, trace: result.decision.trace },
              });
              pinned += 1;
            }

            await advanceScanMark(
              company.id,
              PLUGIN_STATE_KEYS.labelOnlyLastScanAt,
              candidateRows,
              LABEL_ONLY_PASS_FETCH_LIMIT,
              labelOnlyFiringStartMs,
            );
            ctx.logger.info("label-only pass complete", { companyId: company.id, pinned, candidates: candidateRows.length });
          } catch (cause) {
            ctx.logger.error("label-only pass failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
      });

      // --- scheduled repin pass (TOG-2481, tier_dispatcher.py repin_pass()) --
      // Idle issues pinned to a model whose lane is now unusable, or that has
      // been measurably demoted for their tier, get re-pinned within the same
      // tier. Capped at REPIN_PASS_WRITE_LIMIT writes per run, same as the
      // Python source's `limit=6` default.
      /**
       * One company's repin sweep.
       *
       * Extracted from the job callback (same pattern and same reason as
       * `runAaIndexRefresh`) so TOG-3012's `agent.run.failed` handler can run
       * the identical sweep for the affected company the moment a lane
       * rejects a run, instead of waiting out the remainder of the
       * ten-minute cron. There is exactly one repin rule and it lives here.
       *
       * TOG-3585: the scheduled job passes its incremental watermark
       * (`sinceIso` + `firingStartMs`) so the scan covers only issues updated
       * since the last firing. The reactive `agent.run.failed` caller passes
       * neither — a lane rejection must sweep the full candidate set
       * immediately, never a cursor-narrowed one.
       */
      const runRepinPassForCompany = async (
        companyId: string,
        incremental?: { sinceIso: string; firingStartMs: number },
      ): Promise<number> => {
        const company = { id: companyId };
        let repinnedTotal = 0;
        {
          try {
            const config = await companyConfig(company.id);
            if (!config.classification.enabled) return 0;

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
              return 0;
            }

            const laneLedger = await readLaneLedger(company.id);
            const laneOutageOverride = await readLaneOutage(company.id);
            const modelScores = await readModelScores(company.id);
            const nowIso = new Date().toISOString();

            // TOG-2862. One memo per company per pass: `advise` re-describes
            // the rows that survive the cheap rejections, and without this it
            // would repeat their `heartbeat_runs` read.
            const contextUsageCache: ContextUsageCache = new Map();

            let repinned = 0;
            // TOG-3585: rows this loop actually reached, for the watermark
            // fix below — a `break` on the write limit must not be mistaken
            // for having examined every fetched row.
            const examinedRows: unknown[] = [];
            let brokeEarly = false;
            for (const row of candidateRows) {
              if (repinned >= REPIN_PASS_WRITE_LIMIT) {
                brokeEarly = true;
                break;
              }
              examinedRows.push(row);
              const r = asRecord(row);
              const issueId = typeof r.id === "string" ? r.id : null;
              const identifier = typeof r.identifier === "string" ? r.identifier : issueId;
              if (!issueId) continue;

              const described = await describeIssue(company.id, issueId, {}, contextUsageCache);
              if (!described) continue;
              if (described.hasOperatorPin) continue;
              const tier = tierWithFallback(described.descriptor, config.models, config.selection.defaultTier);

              const pinnedModelId = resolveConfiguredModelId(described.descriptor.pinnedModelId, config.models);
              // First point in the pass that actually needs the measurement —
              // every candidate rejected above cost zero `heartbeat_runs` reads.
              const usage = await described.contextUsage();
              const contextEstimate = estimateIssueContext({
                lastRunInputTokens: usage.lastRunInputTokens,
                lastRunCachedInputTokens: usage.lastRunCachedInputTokens,
                fleetCeilingTokens: config.selection.fleetContextCeilingTokens,
              });
              described.descriptor.requiredContextTokens = contextEstimate.tokens ?? undefined;
              if (
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
                continue;
              }

              const result = await advise(company.id, { issueId }, false, undefined, true, contextUsageCache);
              if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) continue;
              if (result.decision.modelId === pinnedModelId) continue;
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
                continue;
              }

              const selectedModel = config.models.find((model) => model.id === result.decision.modelId);
              if (!selectedModel) continue;
              await ctx.issues.update(
                issueId,
                modelOverrideForContext({
                  model: selectedModel,
                  fleetCeilingTokens: config.selection.fleetContextCeilingTokens,
                  compactionRatio: config.selection.compactionRatio,
                  agentEnv: described.agentEnv,
                  agentAdapterType: described.agentAdapterType,
                  agentAdapterConfig: described.agentAdapterConfig,
                  existingOverrideEnv: described.existingOverrideEnv,
                }) as Parameters<typeof ctx.issues.update>[1],
                company.id,
              );
              await ctx.activity.log({
                companyId: company.id,
                message: `Model Selection re-pinned ${pinnedModelId} -> ${result.decision.modelId} (${tier}): lane unusable or measurably demoted`,
                entityType: "issue",
                entityId: issueId,
                metadata: { from: pinnedModelId, modelId: result.decision.modelId, tier, trace: result.decision.trace },
              });
              repinned += 1;
              void identifier;
            }

            repinnedTotal = repinned;
            if (incremental) {
              await advanceScanMark(
                company.id,
                PLUGIN_STATE_KEYS.repinLastScanAt,
                examinedRows,
                REPIN_PASS_FETCH_LIMIT,
                incremental.firingStartMs,
                !brokeEarly,
              );
            }
            ctx.logger.info("repin pass complete", { companyId: company.id, repinned, candidates: candidateRows.length });
          } catch (cause) {
            ctx.logger.error("repin pass failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
        return repinnedTotal;
      };

      ctx.jobs.register(JOB_KEYS.repinPass, async () => {
        for (const company of listKnownCompanies()) {
          // TOG-3585: the scheduled firing scans incrementally; the reactive
          // `agent.run.failed` caller below passes no cursor (full sweep).
          const firingStartMs = Date.now();
          const sinceIso = new Date(await readScanMark(company.id, PLUGIN_STATE_KEYS.repinLastScanAt)).toISOString();
          await runRepinPassForCompany(company.id, { sinceIso, firingStartMs });
        }
      });

      // --- TOG-3012: immediate lane quarantine from a rejected run ----------
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

        const repinned = await runRepinPassForCompany(companyId);
        ctx.logger.info("lane quarantine repin complete", { companyId, laneId: verdict.laneId, repinned });
      });

      // --- scheduled balance pass (TOG-2481, tier_dispatcher.py
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

            // TOG-3585: incremental gate — one aggregate row before the page
            // fetch. When nothing in the candidate statuses changed since the
            // last scan, the whole per-row cycle (describe + advise per card)
            // is skipped. The keyset id-cycle below is untouched: a skip
            // advances only the scan mark, never the page cursor, so no card
            // is ever skipped past. Fail-open: an unreadable aggregate runs
            // the cycle instead of skipping it.
            const balanceFiringStartMs = startedAt;
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
            if (balanceMaxMs !== null && balanceMaxMs <= balanceScanMarkMs) {
              ctx.logger.info("balance pass skipped: no issues changed since last scan", {
                companyId: company.id,
                since: new Date(balanceScanMarkMs).toISOString(),
              });
              await writeScanMark(company.id, PLUGIN_STATE_KEYS.balanceLastScanAt, balanceFiringStartMs);
              continue;
            }

            const cursorKey = {
              scopeKind: "company" as const,
              scopeId: company.id,
              stateKey: PLUGIN_STATE_KEYS.balancePassCursor,
            };
            const storedCursor = asRecord(await ctx.state.get(cursorKey));
            const afterId = typeof storedCursor.afterId === "string" ? storedCursor.afterId : "";
            const candidateRows = (await ctx.db.query(
              `select i.id::text as id,
                      i.identifier as identifier
                 from issues i
                 join agents a on a.id = i.assignee_agent_id
                where i.company_id = $1
                  and i.id::text > $2
                  and i.status in ('todo','in_progress','blocked','in_review')
                  and a.status <> 'terminated'
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

            // TOG-2862. One memo per company per pass: `advise` re-describes
            // the rows that survive the cheap rejections, and without this it
            // would repeat their `heartbeat_runs` read.
            const contextUsageCache: ContextUsageCache = new Map();

            let balanced = 0;
            let scanned = 0;
            let lastScannedId = afterId;
            let budgetExhausted = false;
            for (const row of candidateRows) {
              if (balanced >= BALANCE_PASS_WRITE_LIMIT) break;
              if (Date.now() >= deadlineAt) {
                budgetExhausted = true;
                break;
              }
              const r = asRecord(row);
              const issueId = typeof r.id === "string" ? r.id : null;
              const identifier = typeof r.identifier === "string" ? r.identifier : issueId;
              if (!issueId) continue;
              scanned += 1;
              lastScannedId = issueId;
              if (activeRunIssueIds.has(issueId)) continue;

              const described = await describeIssue(company.id, issueId, {}, contextUsageCache);
              if (!described) continue;
              if (!balanceOpenStatuses.has(described.status)) continue;
              if (!described.isIdle) continue;
              if (described.hasOperatorPin) continue;
              const status = described.status;
              const labelTier = tierFromLabels(described.descriptor.labelNames);
              const pinnedModelId = resolveConfiguredModelId(described.descriptor.pinnedModelId, config.models);
              const pinnedModel = pinnedModelId ? config.models.find((m) => m.id === pinnedModelId) : undefined;
              // TOG-3024: the unpinned branch below force-pins T1 for a
              // *recorded* former-exclusion judgement (an explicit tier:*
              // label with no pin yet) — that is a floor-lift, not a
              // rebalance, and must stay gated on an actual label rather than
              // defaulting every bare unpinned+unlabelled idle card straight
              // to T1. Only the pinned branch gets the tierWithFallback
              // treatment: a card that already has a pin just needs SOME
              // tier bucket to run its capability/cost checks against, same
              // as labelOnlyPass/repinPass.
              if (!labelTier && !pinnedModelId) continue;
              const tier = labelTier ?? tierWithFallback(described.descriptor, config.models, config.selection.defaultTier);

              if (pinnedModelId && pinnedModel) {
                const currentUtilization = pinnedModel.laneId
                  ? laneEffectiveUtilization(laneLedger, pinnedModel.laneId)
                  : null;
                const result = await advise(company.id, { issueId }, false, undefined, true, contextUsageCache);
                if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) continue;
                if (!result.isIdle || !balanceOpenStatuses.has(result.status)) continue;
                if (resolveConfiguredModelId(result.pinnedModelId, config.models) !== pinnedModelId) continue;
                if (result.decision.modelId === pinnedModelId) continue;
                const newModel = config.models.find((m) => m.id === result.decision.modelId);
                if (!newModel) continue;
                const newUtilization = newModel.laneId ? laneEffectiveUtilization(laneLedger, newModel.laneId) : null;

                const cheaper = blendedListPrice(newModel) <= BALANCE_PASS_COST_DOWN_MULTIPLIER * blendedListPrice(pinnedModel);
                const pinnedScore = modelScores[pinnedModelId]?.tiers[tier];
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

                if (!(cheaper || incapable || busier)) continue;

                const selectedModel = config.models.find((model) => model.id === result.decision.modelId);
                if (!selectedModel) continue;

                // TOG-3132. 2026-09-17 08:10:14Z this pass moved TOG-3088 off
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
                    continue;
                  }
                }
                if (!(await balanceWriteStillSafe(company.id, issueId, pinnedModelId, config.models))) continue;
                await ctx.issues.update(
                  issueId,
                  modelOverrideForContext({
                    model: selectedModel,
                    fleetCeilingTokens: config.selection.fleetContextCeilingTokens,
                    compactionRatio: config.selection.compactionRatio,
                    agentEnv: result.agentEnv,
                    agentAdapterType: result.agentAdapterType,
                    agentAdapterConfig: result.agentAdapterConfig,
                    existingOverrideEnv: result.existingOverrideEnv,
                  }) as Parameters<typeof ctx.issues.update>[1],
                  company.id,
                );
                await ctx.activity.log({
                  companyId: company.id,
                  message: `Model Selection balanced ${pinnedModelId} -> ${result.decision.modelId} (${tier}): ${
                    cheaper ? "cost-down" : incapable ? "demote" : "rebalance"
                  }`,
                  entityType: "issue",
                  entityId: issueId,
                  metadata: { from: pinnedModelId, modelId: result.decision.modelId, tier, cheaper, incapable, busier },
                });
                balanced += 1;
                void identifier;
              } else {
                // Unpinned + labelled = former exclusion: give it a balanced
                // T1-class pin instead of leaving it on the agent floor.
                // `pick("T1", floor)` in Python — always T1, never this row's
                // own tier label.
                const result = await advise(company.id, { issueId }, false, "T1", false, contextUsageCache);
                if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) {
                  // TOG-3111 AC3: same visibility as the label-only pass —
                  // this branch previously `continue`d without a trace.
                  await maybeLogUnpinnableCard(company.id, issueId, identifier, result?.decision ?? null);
                  continue;
                }
                if (!result.isIdle || !balanceOpenStatuses.has(result.status)) continue;
                if (result.pinnedModelId !== null) continue;
                const floorModelId = resolveConfiguredModelId(result.agentFloorModelId, config.models);
                // TOG-3037: only elide onto the implicit NULL-override floor
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
                if (floorHealthy) continue;

                const selectedModel = config.models.find((model) => model.id === result.decision.modelId);
                if (!selectedModel) continue;
                if (!(await balanceWriteStillSafe(company.id, issueId, null, config.models))) continue;
                await ctx.issues.update(
                  issueId,
                  modelOverrideForContext({
                    model: selectedModel,
                    fleetCeilingTokens: config.selection.fleetContextCeilingTokens,
                    compactionRatio: config.selection.compactionRatio,
                    agentEnv: result.agentEnv,
                    agentAdapterType: result.agentAdapterType,
                    agentAdapterConfig: result.agentAdapterConfig,
                    existingOverrideEnv: result.existingOverrideEnv,
                  }) as Parameters<typeof ctx.issues.update>[1],
                  company.id,
                );
                await ctx.activity.log({
                  companyId: company.id,
                  message:
                    result.decision.modelId === floorModelId
                      ? `Model Selection explicitly pinned ${result.decision.modelId} (T1): floor lane unserviceable`
                      : `Model Selection balanced floor -> ${result.decision.modelId} (T1): unpinned labelled card given a balanced T1 pin`,
                  entityType: "issue",
                  entityId: issueId,
                  metadata: { from: floorModelId, modelId: result.decision.modelId, tier: "T1" },
                });
                balanced += 1;
                void identifier;
              }
            }

            const cycleComplete =
              scanned === candidateRows.length && candidateRows.length < BALANCE_PASS_FETCH_LIMIT;
            const nextAfterId = cycleComplete ? null : lastScannedId || null;
            await ctx.state.set(cursorKey, { afterId: nextAfterId });
            // TOG-3585: the id-cycle cursor above preserves position; the
            // scan mark records that this firing SAW the board, so the next
            // firing's aggregate gate can skip a quiet board. Always advanced
            // on a completed cycle — even budget-exhausted — because the mark
            // is about "board seen", not "cycle drained".
            await writeScanMark(company.id, PLUGIN_STATE_KEYS.balanceLastScanAt, balanceFiringStartMs);
            ctx.logger.info("balance pass complete", {
              companyId: company.id,
              balanced,
              candidates: candidateRows.length,
              scanned,
              afterId: afterId || null,
              nextAfterId,
              cycleComplete,
              budgetExhausted,
              durationMs: Date.now() - startedAt,
              jobDurationMs: Date.now() - jobStartedAt,
            });
            if (budgetExhausted) break;
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

      // --- scheduled dispatch sweep (TOG-2481 absorption of the standalone
      // `dispatch` plugin, TOG-747/TOG-706) -----------------------------------
      // Ported wholesale, not reimplemented: `dispatch-selection.ts` carries
      // the ADR 0001/0003/0004/Q2/Q5 owner decisions as comments, and this job
      // body is the same `sweepCompany` orchestration the standalone plugin
      // ran, so the `plugins` table shows one dispatcher instead of two.
      ctx.jobs.register(JOB_KEYS.dispatchSweep, async (job) => {
        const companies = listKnownCompanies();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            const dispatchConfig = config.dispatch;

            // TOG-2533 fix 3/4: standalone-plugin notes, restored alongside the
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
            // TOG-3585: assignees with a running/queued run seen in this
            // firing's orchestration reads. Union'd with the firing-wide
            // `agent_id` query below — an agent is busy if EITHER source says
            // so. A run on an unreadable or terminal card still keeps its
            // agent busy, which the orchestration union alone would miss.
            const busyAssigneesFromRuns = new Set<string>();
            let unreadable = 0;
            const sweepNowMs = Date.now();
            for (const issue of nonTerminal) {
              if (!issue.assigneeAgentId) {
                population.push({ issue });
                continue;
              }
              // TOG-3585: the row already answers the descriptor and
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
                // TOG-2572: neither a future monitor check nor a pending
                // interaction is on the orchestration summary — a monitor
                // wake and a human-only ask are both invisible to
                // getOrchestration, which is exactly how TOG-2426 and
                // TOG-2319/2455/1677 slipped past the sweep.
                const interactions = await ctx.issues.listInteractions(issue.id, company.id);
                const runs = orchestration.runs.map((r) => ({
                  issueId: r.issueId,
                  status: r.status,
                  finishedAt: r.finishedAt,
                  startedAt: r.startedAt,
                  createdAt: r.createdAt,
                }));
                // TOG-3585: an active run scoped to this card keeps its
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

            // TOG-3585: firing-wide agent busyness. The orchestration union
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

            // TOG-3585: lane-down gate, read once per firing. Three signals,
            // OR'd: the pace-ledger hard stop (a measured exhaustion), the
            // operator outage override (TOG-3012 quarantine), and the
            // collector availability snapshot's `unavailable` state. UNKNOWN
            // availability never gates — fail-neutral, a broken instrument
            // must not take dispatch down (TOG-3132 policy).
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

            // TOG-3585: the lane a wake would run on, from rows already in
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
                try {
                  const result = await ctx.issues.requestWakeup(pick.issue.id, company.id, {
                    reason: "dispatch_stalled_issue",
                    contextSource: "plugin.dispatch.sweep",
                    idempotencyKey: `dispatch:${job.runId}:${pick.issue.id}`,
                  });
                  // A `queued: false` answer without a throw is still a
                  // failure with a reason — TOG-3585 counts it, never drops it.
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
                  // TOG-3585: the plugin_logs half of failure persistence —
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
      // TOG-2438 reopen: `onConfigChanged` only replays at worker startup for
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
     * TOG-2438 reopen: the sole feed for `knownCompanyIds` (see the comment
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
  });
}

const plugin = createPlugin();
export default plugin;
runWorker(plugin, import.meta.url);
