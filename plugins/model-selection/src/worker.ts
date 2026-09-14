import { definePlugin, runWorker, type PluginContext, type ToolResult } from "@paperclipai/plugin-sdk";

import { planApply } from "./actuate/apply.js";
import { resolveConfig, validateConfig, type ResolvedConfig } from "./config/resolve.js";
import {
  AA_FETCH_TIMEOUT_MS,
  AA_LEADERBOARD_URL,
  AA_MAX_RESPONSE_BYTES,
  AA_SNAPSHOT_HISTORY_LIMIT,
  BALANCE_PASS_BUSIER_UTILIZATION_DELTA,
  BALANCE_PASS_COST_DOWN_MULTIPLIER,
  BALANCE_PASS_FETCH_LIMIT,
  BALANCE_PASS_PROBATION_PRICE_USD,
  BALANCE_PASS_WRITE_LIMIT,
  CARD_LEDGER_WINDOW_DAYS,
  DISPATCH_ISSUE_PAGE_LIMIT,
  JOB_KEYS,
  LOCAL_FOLDER_KEYS,
  LABEL_ONLY_PASS_FETCH_LIMIT,
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
import { ancillaryDriftForAgent, recommendAncillaryModel, type AncillarySurfaceDrift } from "./engine/ancillary.js";
import { resolveConfiguredModelId } from "./engine/model-id.js";
import { buildQualitySignals, buildVolumeProfiles, type RunRow } from "./engine/profiles.js";
import { selectModel } from "./engine/select.js";
import { tierFromLabels } from "./engine/tier.js";
import {
  accumulateRunStats,
  blendedPriorP,
  buildCardLedger,
  buildModelScore,
  findClosingRun,
  foldReworkIntoStats,
  type AgenticSubScores,
  type CardRow,
  type ClosingRunCandidate,
  type ReworkClosingRun,
  type RunOutcomeRow,
} from "./engine/scores.js";
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
import { pollLanes, type LanePollHttpClient, type LaneSourceDefinition } from "./lane-capacity/poll.js";
import { buildShadowRecord } from "./shadow-emit.js";
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
  TERMINAL_STATUSES as DISPATCH_TERMINAL_STATUSES,
  type DispatchIssue,
  type DispatchPopulationEntry,
} from "./engine/dispatch-selection.js";
import { summariseFiring, hasStateChanged, emitMetrics, logStateChange, type WakeOutcome } from "./dispatch-reporting.js";

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
  assigneeAdapterOverrides: { adapterConfig: { model: string } };
  labelIds?: string[];
}

function summary(decision: SelectionDecision): string {
  if (decision.outcome === "selected") {
    return `${decision.modelId} at ${decision.effectiveTier} (tier via ${decision.judgement.source})${
      decision.advisory ? " — advisory, nothing written" : ""
    }`;
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

      // --- TOG-2137/2138: shadow decision emitter -----------------------

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
      const shadowEmitChains = new Map<string, Promise<void>>();

      /**
       * Off by default (`shadowEmit.enabled`). Read-modify-write against one
       * JSONL file, capped at `maxRecords` — `ctx.localFolders` has no native
       * append, and the host only offers whole-file atomic replace. A write
       * failure is logged and swallowed: shadow emission is a side channel for
       * the TOG-2138 comparison stream, and must never fail the
       * `advise()`/`apply` call it rides on. A read failure is swallowed only
       * when it means "no file yet" — any other read failure aborts the emit
       * instead of overwriting real history with a one-record file.
       */
      const emitShadowRecordSerialized = async (
        companyId: string,
        record: ReturnType<typeof buildShadowRecord>,
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
        lines.push(JSON.stringify(record));
        const config = await companyConfig(companyId);
        const capped = lines.length > config.shadowEmit.maxRecords ? lines.slice(-config.shadowEmit.maxRecords) : lines;
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

      const emitShadowRecord = (companyId: string, record: ReturnType<typeof buildShadowRecord>): Promise<void> => {
        const previous = shadowEmitChains.get(companyId) ?? Promise.resolve();
        const next = previous.catch(() => {}).then(() => emitShadowRecordSerialized(companyId, record));
        shadowEmitChains.set(companyId, next);
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
       * Build the descriptor from what the board actually records. Everything
       * here is read, never inferred — the tier key is a recorded judgement
       * (ADR-0007 / ratified Q8-a), so the only classifier in this plugin is
       * the absence of one.
       */
      const describeIssue = async (
        companyId: string,
        issueId: string,
        supplied: Record<string, unknown>,
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
      } | null> => {
        const issue = await ctx.issues.get(issueId, companyId);
        if (!issue) return null;

        const overrides = asRecord(issue.assigneeAdapterOverrides);
        const adapterConfig = asRecord(overrides.adapterConfig);
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
        const assigneeAgentId = issue.assigneeAgentId;
        if (typeof assigneeAgentId === "string") {
          try {
            const agent = await ctx.agents.get(assigneeAgentId, companyId);
            const agentRecord = asRecord(agent);
            const config = asRecord(agentRecord.adapterConfig);
            if (typeof config.model === "string") agentFloorModelId = config.model;
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
          requiredContextTokens:
            typeof supplied.requiredContextTokens === "number" ? supplied.requiredContextTokens : undefined,
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
      } | null> => {
        const issueId = typeof params.issueId === "string" ? params.issueId : null;
        if (!issueId) return null;
        const config = await companyConfig(companyId);
        const described = await describeIssue(companyId, issueId, params);
        if (!described) return null;
        if (forceTier) {
          described.descriptor.labelNames = [`${TIER_LABEL_PREFIX}${forceTier}`];
        }
        if (suppressSticky) {
          described.descriptor.stickyModelId = null;
        }
        const { profiles, signals } = await readProfiles(companyId);
        const laneLedger = await readLaneLedger(companyId);
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
            models: config.models,
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
          },
          profiles,
          signals,
          now,
          cardLedger,
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
          const shadowRecord = buildShadowRecord({
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
            operatorOverride: liveOverride,
          });
          await emitShadowRecord(companyId, shadowRecord);
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
        };
      };

      ctx.tools.register(
        TOOL_NAMES.advise,
        {
          displayName: "Advise a model for an issue",
          description: "Return the tier judgement and costed candidates for one issue. Writes nothing.",
          parametersSchema: { type: "object" },
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
          parametersSchema: { type: "object" },
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

          if (!plan.write || !plan.patch) {
            return { content: `No write: ${plan.reason}`, data: { decision: result.decision, plan } };
          }

          const patch: IssueUpdatePatch = { ...plan.patch };
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
        const status = asRecord(changes.status);
        const from = typeof status.from === "string" ? status.from : null;
        const to = typeof status.to === "string" ? status.to : null;
        const issueId = typeof event.entityId === "string" ? event.entityId : null;
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
                    runtimeConfig: asRecord(agent.runtimeConfig),
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

            ctx.logger.info("lane capacity polled", {
              companyId: company.id,
              lanes: [...results, ...secretFailures].map((r) => `${r.laneId}:${r.verdict?.state ?? "error"}`).join(","),
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
              `select r.usage_json->>'model' as model,
                      r.status as status,
                      coalesce(r.context_snapshot->>'issueId','') as issue_id,
                      coalesce(r.error_code,'') as error_code,
                      left(coalesce(r.error,''),200) as error,
                      coalesce(r.usage_json->>'costUsd','') as cost_usd,
                      extract(epoch from (r.finished_at - r.started_at))/60.0 as mins,
                      extract(epoch from (now() - r.created_at))/86400.0 as age_days
                 from heartbeat_runs r
                where r.company_id = $1
                  and r.created_at > now() - ($2 || ' days')::interval
                  and r.usage_json ? 'model'
                  and r.status in ('succeeded','failed','timed_out')
                  and r.usage_json->>'model' not in ('unknown','auto/best-coding')
                  and r.finished_at is not null`,
              [company.id, String(SCORE_WINDOW_DAYS)],
            )) as unknown[];

            const closingRunRows = (await ctx.db.query(
              `select coalesce(r.context_snapshot->>'issueId','') as issue_id,
                      r.usage_json->>'model' as model,
                      coalesce(r.agent_id::text,'') as agent_id,
                      coalesce(r.usage_json->>'costUsd','') as cost_usd,
                      extract(epoch from r.finished_at) * 1000 as finished_at_ms
                 from heartbeat_runs r
                where r.company_id = $1
                  and r.status = 'succeeded'
                  and r.finished_at > now() - ($2 || ' days')::interval
                  and r.usage_json ? 'model'`,
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
                costUsd: toNumber(r.cost_usd),
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
                costUsd: toNumber(r.cost_usd),
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
            // TOG-2438 scope expansion: agentic sub-scores as an additional
            // prior alongside the composite index (blendedPriorP), never a
            // replacement for it — null when the model has no resolved slug
            // or aa.ai has no sub-benchmark data for it.
            const liveAgenticScores = (model: (typeof config.models)[number]): AgenticSubScores | null => {
              const slug = resolveAaSlug(model.id, aaKnownSlugs, model.aaSlug ?? null);
              const record = slug ? aaSnapshot.bySlug[slug] : null;
              if (!record) return null;
              return {
                terminalbenchHard: record.terminalbenchHard,
                tau2: record.tau2,
                ifbench: record.ifbench,
                gpqa: record.gpqa,
                hle: record.hle,
              };
            };

            const modelScores: ModelScore[] = config.models.map((model) =>
              buildModelScore(model.id, liveAaIndex(model), statsByModel[model.id] ?? {}, TIERS, liveAgenticScores(model)),
            );

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
              priorPByModel[model.id] = blendedPriorP(liveAaIndex(model), liveAgenticScores(model));
              blendedListPriceByModel[model.id] = null;
            }

            const cardLedger: Record<string, CardLedgerEntry> = buildCardLedger(
              cardRows,
              Date.now(),
              priorPByModel,
              blendedListPriceByModel,
            );

            await ctx.state.set(scoresKey(company.id), { modelScores, cardLedger });
            ctx.logger.info("model scores refreshed", {
              companyId: company.id,
              models: modelScores.length,
              cardsInLedger: cardRows.length,
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
      // For every open, agent-assigned issue with no tier:* label, no
      // per-issue override, no `pin:operator`, and no running/queued run,
      // classify it with the RUBRIC and write a tier:* label (never a status
      // or assignee change — same contract as the ported script's file-level
      // docstring). The AC3 kill switch is `classification.enabled: false`
      // (default): a company that never sets it true gets byte-identical
      // behavior to before this job existed.
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
            const candidateRows = (await ctx.db.query(
              `select i.id::text as id,
                      i.identifier as identifier,
                      i.status as status,
                      coalesce(a.name,'') as agent_name,
                      i.title as title,
                      coalesce(i.description,'') as description
                 from issues i
                 join agents a on a.id = i.assignee_agent_id
                where i.company_id = $1
                  and i.status in ('todo','in_progress','blocked','in_review')
                  and a.status <> 'terminated'
                  and i.assignee_agent_id is not null
                  and (i.assignee_adapter_overrides is null
                       or i.assignee_adapter_overrides->'adapterConfig'->>'model' is null)
                  and not exists (
                    select 1 from heartbeat_runs r
                     where r.status in ('running','queued')
                       and r.context_snapshot->>'issueId' = i.id::text
                  )
                order by case i.status when 'todo' then 0 when 'blocked' then 1 when 'in_review' then 2 else 3 end,
                         i.updated_at desc
                limit $2`,
              [company.id, String(config.classification.batchSize)],
            )) as unknown[];

            const exclusions = await readClassificationExclusions(company.id);
            let classified = 0;
            for (const row of candidateRows) {
              const r = asRecord(row);
              const issueId = typeof r.id === "string" ? r.id : null;
              const identifier = typeof r.identifier === "string" ? r.identifier : issueId;
              if (!issueId) continue;

              // Skip an issue that already carries a tier:* label — the row query
              // above cannot see labels (not allowlisted), so this check happens
              // per candidate via `ctx.issues.get()`, same source `describeIssue`
              // uses for label reads elsewhere in this worker.
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
              if (labelNames.some((name) => name.startsWith(TIER_LABEL_PREFIX))) continue;
              if (labelNames.includes(OPERATOR_PIN_LABEL)) continue;

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
                const existingLabelIds =
                  issue.labelIds ?? (issue.labels ?? []).map((label) => label.id).filter((id) => typeof id === "string");
                const nextLabelIds = [...new Set([...existingLabelIds, labelId])];
                await ctx.issues.update(
                  issueId,
                  { labelIds: nextLabelIds } as Parameters<typeof ctx.issues.update>[1],
                  company.id,
                );
              }

              if (judgement.exclusion) {
                await ctx.state.set(classificationExclusionsKey(company.id), { ...exclusions, [issueId]: true });
                exclusions[issueId] = true;
              }

              await ctx.activity.log({
                companyId: company.id,
                message: `Model Selection classified this issue as ${labelTier} (confidence ${judgement.confidence})${judgement.exclusion ? ", capability-excluded" : ""}`,
                entityType: "issue",
                entityId: issueId,
                metadata: { tier: labelTier, pickTier, confidence: judgement.confidence, reason: judgement.reason },
              });
              classified += 1;
            }

            ctx.logger.info("issue classification pass complete", { companyId: company.id, classified, candidates: candidateRows.length });
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
        config: ResolvedConfig,
        laneLedger: LaneLedger,
        laneOutageOverride: LaneOutageOverride | null,
        modelScores: Readonly<Record<string, ModelScore>>,
        nowIso: string,
      ): boolean => {
        if (!modelId) return false;
        const model = config.models.find((m) => m.id === modelId && m.enabled);
        if (!model) return false;
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
            const candidateRows = (await ctx.db.query(
              `select i.id::text as id,
                      i.identifier as identifier,
                      i.status as status,
                      coalesce(a.adapter_config->>'model','') as floor_model
                 from issues i
                 join agents a on a.id = i.assignee_agent_id
                where i.company_id = $1
                  and i.status in ('todo','in_progress','blocked','in_review')
                  and a.status <> 'terminated'
                  and (i.assignee_adapter_overrides is null
                       or i.assignee_adapter_overrides->'adapterConfig'->>'model' is null)
                  and not exists (
                    select 1 from heartbeat_runs r
                     where r.status in ('running','queued')
                       and r.context_snapshot->>'issueId' = i.id::text
                  )
                order by i.updated_at desc
                limit $2`,
              [company.id, String(LABEL_ONLY_PASS_FETCH_LIMIT)],
            )) as unknown[];

            let pinned = 0;
            for (const row of candidateRows) {
              const r = asRecord(row);
              const issueId = typeof r.id === "string" ? r.id : null;
              const identifier = typeof r.identifier === "string" ? r.identifier : issueId;
              if (!issueId) continue;

              const described = await describeIssue(company.id, issueId, {});
              if (!described) continue;
              if (described.hasOperatorPin) continue;
              const tier = tierFromLabels(described.descriptor.labelNames);
              if (!tier) continue;

              const result = await advise(company.id, { issueId }, false);
              if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) {
                ctx.logger.info("label-only pass: no pick", { companyId: company.id, issue: identifier, tier });
                continue;
              }
              const floorModelId = resolveConfiguredModelId(result.agentFloorModelId, config.models);
              if (result.decision.modelId === floorModelId) {
                ctx.logger.info("label-only pass skipped: pick equals floor", {
                  companyId: company.id,
                  issue: identifier,
                  tier,
                });
                continue;
              }

              await ctx.issues.update(
                issueId,
                {
                  assigneeAdapterOverrides: { adapterConfig: { model: result.decision.modelId } },
                } as Parameters<typeof ctx.issues.update>[1],
                company.id,
              );
              await ctx.activity.log({
                companyId: company.id,
                message: `Model Selection label-only pinned ${result.decision.modelId} (${tier}) from the existing tier label`,
                entityType: "issue",
                entityId: issueId,
                metadata: { modelId: result.decision.modelId, tier, trace: result.decision.trace },
              });
              pinned += 1;
            }

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
      ctx.jobs.register(JOB_KEYS.repinPass, async () => {
        const companies = listKnownCompanies();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            if (!config.classification.enabled) continue;

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
                  and not exists (
                    select 1 from heartbeat_runs r
                     where r.status in ('running','queued')
                       and r.context_snapshot->>'issueId' = i.id::text
                  )
                order by i.updated_at asc
                limit $2`,
              [company.id, String(REPIN_PASS_FETCH_LIMIT)],
            )) as unknown[];

            const laneLedger = await readLaneLedger(company.id);
            const laneOutageOverride = await readLaneOutage(company.id);
            const modelScores = await readModelScores(company.id);
            const nowIso = new Date().toISOString();

            let repinned = 0;
            for (const row of candidateRows) {
              if (repinned >= REPIN_PASS_WRITE_LIMIT) break;
              const r = asRecord(row);
              const issueId = typeof r.id === "string" ? r.id : null;
              const identifier = typeof r.identifier === "string" ? r.identifier : issueId;
              if (!issueId) continue;

              const described = await describeIssue(company.id, issueId, {});
              if (!described) continue;
              if (described.hasOperatorPin) continue;
              const tier = tierFromLabels(described.descriptor.labelNames);
              if (!tier) continue;

              const pinnedModelId = resolveConfiguredModelId(described.descriptor.pinnedModelId, config.models);
              if (isUsableAndCapable(pinnedModelId, tier, config, laneLedger, laneOutageOverride, modelScores, nowIso)) {
                continue;
              }

              const result = await advise(company.id, { issueId }, false, undefined, true);
              if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) continue;
              if (result.decision.modelId === pinnedModelId) continue;
              if (
                !isUsableAndCapable(
                  result.decision.modelId,
                  tier,
                  config,
                  laneLedger,
                  laneOutageOverride,
                  modelScores,
                  nowIso,
                )
              ) {
                continue;
              }

              await ctx.issues.update(
                issueId,
                {
                  assigneeAdapterOverrides: { adapterConfig: { model: result.decision.modelId } },
                } as Parameters<typeof ctx.issues.update>[1],
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

            ctx.logger.info("repin pass complete", { companyId: company.id, repinned, candidates: candidateRows.length });
          } catch (cause) {
            ctx.logger.error("repin pass failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
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
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            if (!config.classification.enabled) continue;

            const candidateRows = (await ctx.db.query(
              `select i.id::text as id,
                      i.identifier as identifier,
                      i.status as status
                 from issues i
                 join agents a on a.id = i.assignee_agent_id
                where i.company_id = $1
                  and i.status in ('todo','in_progress','blocked','in_review')
                  and a.status <> 'terminated'
                  and not exists (
                    select 1 from heartbeat_runs r
                     where r.status in ('running','queued')
                       and r.context_snapshot->>'issueId' = i.id::text
                  )
                order by case i.status when 'in_progress' then 0 when 'todo' then 1 when 'in_review' then 2 else 3 end,
                         i.updated_at desc
                limit $2`,
              [company.id, String(BALANCE_PASS_FETCH_LIMIT)],
            )) as unknown[];

            const laneLedger = await readLaneLedger(company.id);
            const laneOutageOverride = await readLaneOutage(company.id);
            const modelScores = await readModelScores(company.id);
            const nowIso = new Date().toISOString();
            const now = Date.now();

            let balanced = 0;
            for (const row of candidateRows) {
              if (balanced >= BALANCE_PASS_WRITE_LIMIT) break;
              const r = asRecord(row);
              const issueId = typeof r.id === "string" ? r.id : null;
              const status = typeof r.status === "string" ? r.status : "";
              const identifier = typeof r.identifier === "string" ? r.identifier : issueId;
              if (!issueId) continue;

              const described = await describeIssue(company.id, issueId, {});
              if (!described) continue;
              if (described.hasOperatorPin) continue;
              const tier = tierFromLabels(described.descriptor.labelNames);
              if (!tier) continue;

              const pinnedModelId = resolveConfiguredModelId(described.descriptor.pinnedModelId, config.models);
              const pinnedModel = pinnedModelId ? config.models.find((m) => m.id === pinnedModelId) : undefined;

              if (pinnedModelId && pinnedModel) {
                const currentUtilization = pinnedModel.laneId
                  ? laneEffectiveUtilization(laneLedger, pinnedModel.laneId)
                  : null;
                const result = await advise(company.id, { issueId }, false, undefined, true);
                if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) continue;
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

                await ctx.issues.update(
                  issueId,
                  {
                    assigneeAdapterOverrides: { adapterConfig: { model: result.decision.modelId } },
                  } as Parameters<typeof ctx.issues.update>[1],
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
                const result = await advise(company.id, { issueId }, false, "T1");
                if (!result || result.decision.outcome !== "selected" || !result.decision.modelId) continue;
                const floorModelId = resolveConfiguredModelId(result.agentFloorModelId, config.models);
                if (result.decision.modelId === floorModelId) continue;

                await ctx.issues.update(
                  issueId,
                  {
                    assigneeAdapterOverrides: { adapterConfig: { model: result.decision.modelId } },
                  } as Parameters<typeof ctx.issues.update>[1],
                  company.id,
                );
                await ctx.activity.log({
                  companyId: company.id,
                  message: `Model Selection balanced floor -> ${result.decision.modelId} (T1): unpinned labelled card given a balanced T1 pin`,
                  entityType: "issue",
                  entityId: issueId,
                  metadata: { from: floorModelId, modelId: result.decision.modelId, tier: "T1" },
                });
                balanced += 1;
                void identifier;
              }
            }

            ctx.logger.info("balance pass complete", { companyId: company.id, balanced, candidates: candidateRows.length });
          } catch (cause) {
            ctx.logger.error("balance pass failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause),
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
            let unreadable = 0;
            for (const issue of nonTerminal) {
              if (!issue.assigneeAgentId) {
                population.push({ issue });
                continue;
              }
              try {
                const orchestration = await ctx.issues.summaries.getOrchestration({
                  issueId: issue.id,
                  companyId: company.id,
                });
                const relation = orchestration.relations[issue.id];
                population.push({
                  issue,
                  blockedBy: (relation?.blockedBy ?? []).map((b) => ({ id: b.id, status: b.status })),
                  runs: orchestration.runs.map((r) => ({
                    issueId: r.issueId,
                    status: r.status,
                    finishedAt: r.finishedAt,
                    startedAt: r.startedAt,
                    createdAt: r.createdAt,
                  })),
                  invocationBlock:
                    orchestration.invocationBlocks.find((b) => b.issueId === issue.id) ?? null,
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

            const selection = selectDispatch(population, {
              idleMinutes: dispatchConfig.idleMinutes,
              maxWakesPerFiring: dispatchConfig.maxWakesPerFiring,
              focusProjectIds: [...dispatchConfig.focusProjectIds],
              now: Date.now(),
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
                  wakeOutcomes.push({ issueId: pick.issue.id, queued: result.queued });
                } catch (cause) {
                  wakeOutcomes.push({
                    issueId: pick.issue.id,
                    queued: false,
                    error: cause instanceof Error ? cause.message : String(cause),
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
