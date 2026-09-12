import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, ToolResult } from "@paperclipai/plugin-sdk";

import { planApply } from "./actuate/apply.js";
import { resolveConfig, validateConfig, type ResolvedConfig } from "./config/resolve.js";
import {
  CARD_LEDGER_WINDOW_DAYS,
  JOB_KEYS,
  OPERATOR_PIN_LABEL,
  PLUGIN_STATE_KEYS,
  REJECTION_WINDOW_MS,
  REOPEN_WINDOW_MS,
  ROUTE_KEYS,
  SCORE_WINDOW_DAYS,
  TIER_LABEL_PREFIX,
  TIERS,
  TOOL_NAMES,
  PLUGIN_VERSION,
  type Tier,
} from "./constants.js";
import { costOf } from "./engine/cost.js";
import { buildQualitySignals, buildVolumeProfiles, type RunRow } from "./engine/profiles.js";
import { selectModel } from "./engine/select.js";
import {
  accumulateRunStats,
  buildCardLedger,
  buildModelScore,
  findClosingRun,
  foldReworkIntoStats,
  priorP,
  type CardRow,
  type ClosingRunCandidate,
  type ReworkClosingRun,
  type RunOutcomeRow,
} from "./engine/scores.js";
import type {
  CardLedgerEntry,
  IssueDescriptor,
  ModelScore,
  QualitySignal,
  SelectionDecision,
  VolumeProfile,
} from "./engine/types.js";
import {
  activeOperatorOverride,
  hardStopExcluded,
  mergeLedgerEntry,
  recordOperatorOverride,
  repinAllowed,
  type LaneLedger,
  type OperatorOverrideLedger,
} from "./engine/pacing.js";
import { pollLanes, type LanePollHttpClient, type LaneSourceDefinition } from "./lane-capacity/poll.js";

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
  return "No eligible model for this issue.";
}

export function createPlugin() {
  let context: PluginContext | null = null;

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

      const readCardLedger = async (companyId: string): Promise<Record<string, CardLedgerEntry>> => {
        const stored = asRecord(await ctx.state.get(scoresKey(companyId)));
        const ledger = asRecord(stored.cardLedger);
        return ledger as Record<string, CardLedgerEntry>;
      };

      const shadowDiffsKey = (companyId: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey: PLUGIN_STATE_KEYS.shadowDiffs,
      });

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
        const assigneeAgentId = issue.assigneeAgentId;
        if (typeof assigneeAgentId === "string") {
          try {
            const agent = await ctx.agents.get(assigneeAgentId, companyId);
            const config = asRecord(asRecord(agent).adapterConfig);
            if (typeof config.model === "string") agentFloorModelId = config.model;
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
        };
      };

      const advise = async (
        companyId: string,
        params: Record<string, unknown>,
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
      } | null> => {
        const issueId = typeof params.issueId === "string" ? params.issueId : null;
        if (!issueId) return null;
        const config = await companyConfig(companyId);
        const described = await describeIssue(companyId, issueId, params);
        if (!described) return null;
        const { profiles, signals } = await readProfiles(companyId);
        const laneLedger = await readLaneLedger(companyId);
        const nowIso = new Date().toISOString();
        const overrides = await readOperatorOverrides(companyId);
        const liveOverride = activeOperatorOverride(overrides, issueId, nowIso);
        const cardLedger = await readCardLedger(companyId);

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
            objective: config.selection.objective,
          },
          profiles,
          signals,
          now: Date.now(),
          cardLedger,
        });

        // Whether the CURRENTLY PINNED model (not the newly-computed winner) sits
        // on an unserviceable lane — this, not a routine pace-preference change,
        // is the only thing allowed to force a repin through `pin:operator`.
        const pinnedModel = config.models.find((model) => model.id === described.descriptor.pinnedModelId);
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
          const ttlSeconds =
            typeof supplied.ttlSeconds === "number" && supplied.ttlSeconds > 0
              ? supplied.ttlSeconds
              : config.pacing.operatorOverrideTtlSeconds;

          const nowIso = new Date().toISOString();
          const existing = await readOperatorOverrides(runCtx.companyId);
          const updated = recordOperatorOverride(existing, issueId, modelId, nowIso, ttlSeconds);
          await ctx.state.set(operatorOverridesKey(runCtx.companyId), updated);

          const entry = updated[issueId]!;
          return {
            content: `operator override recorded: ${issueId} -> ${modelId}, expires ${entry.expiresAt}`,
            data: entry,
          };
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

      // --- scheduled volume-profile refresh ---------------------------------
      // Without this the cost term goes stale and the engine holds at the agent
      // floor rather than order candidates on a number it cannot defend.
      ctx.jobs.register(JOB_KEYS.refreshProfiles, async () => {
        const companies = await ctx.companies.list();
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
        const companies = await ctx.companies.list();
        for (const company of companies) {
          try {
            const config = await companyConfig(company.id);
            if (config.pacing.lanes.length === 0) continue;

            const sources: LaneSourceDefinition[] = config.pacing.lanes.map((lane) => ({
              laneId: lane.laneId,
              statusUrl: lane.statusUrl,
              requestTimeoutMs: lane.requestTimeoutMs,
              maxResponseBytes: lane.maxResponseBytes,
              lane: lane.lane,
              policy: lane.policy,
            }));

            const results = await pollLanes({
              sources,
              http: laneHttp,
              now: () => new Date().toISOString(),
            });

            let ledger = await readLaneLedger(company.id);
            for (const result of results) {
              ledger = mergeLedgerEntry(ledger, result);
            }
            await ctx.state.set(laneLedgerKey(company.id), ledger);

            ctx.logger.info("lane capacity polled", {
              companyId: company.id,
              lanes: results.map((r) => `${r.laneId}:${r.verdict?.state ?? "error"}`).join(","),
            });
          } catch (cause) {
            ctx.logger.error("lane capacity poll failed for a company", {
              companyId: company.id,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
      });

      // --- scheduled score + card-ledger refresh (TOG-1917 §2.2 / TOG-2136) -
      // Ported from `model_scores.py`, with one structural change: the Python
      // original attributes tier via a live SQL join against
      // `issue_labels`/`labels` (lines 56-63), which this plugin cannot do —
      // those tables are absent from `coreReadTables`. Tier is instead read
      // per distinct issue id via `ctx.issues.get()`, which the host already
      // enriches with `.labels` (same mechanism `describeIssue()` uses above).
      ctx.jobs.register(JOB_KEYS.refreshScores, async () => {
        const companies = await ctx.companies.list();
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

            const runOutcomeRows: RunOutcomeRow[] = scoreRunRows.map((row) => {
              const r = asRecord(row);
              const issueId = typeof r.issue_id === "string" ? r.issue_id : "";
              return {
                modelId: typeof r.model === "string" ? r.model : "",
                tier: issueId ? tierByIssue.get(issueId) ?? null : null,
                status: r.status as RunOutcomeRow["status"],
                errorCode: typeof r.error_code === "string" && r.error_code ? r.error_code : null,
                error: typeof r.error === "string" && r.error ? r.error : null,
                costUsd: toNumber(r.cost_usd),
                mins: toNumber(r.mins),
                ageDays: toNumber(r.age_days) ?? 0,
              };
            });

            let statsByModel = accumulateRunStats(runOutcomeRows);

            const closingRuns: ClosingRunCandidate[] = closingRunRows.map((row) => {
              const r = asRecord(row);
              const issueId = typeof r.issue_id === "string" ? r.issue_id : "";
              return {
                issueId,
                modelId: typeof r.model === "string" ? r.model : "",
                tier: issueId ? tierByIssue.get(issueId) ?? null : null,
                finishedAtMs: toNumber(r.finished_at_ms) ?? 0,
                agentId: typeof r.agent_id === "string" && r.agent_id ? r.agent_id : null,
              };
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

            const modelScores: ModelScore[] = config.models.map((model) =>
              buildModelScore(model.id, model.aaIndex, statsByModel[model.id] ?? {}, TIERS),
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
            for (const [index, run] of closingRuns.entries()) {
              if (!run.issueId) continue;
              runCountByIssue.set(run.issueId, (runCountByIssue.get(run.issueId) ?? 0) + 1);
              const existing = latestClosingRunByIssue.get(run.issueId);
              if (!existing || run.finishedAtMs > existing.finishedAtMs) {
                const costUsd = toNumber(asRecord(closingRunRows[index]).cost_usd);
                latestClosingRunByIssue.set(run.issueId, { ...run, costUsd });
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
              const pinnedModel = typeof r.pinned_model === "string" && r.pinned_model ? r.pinned_model : null;
              cardRows.push({
                modelId: closingRun.modelId,
                tier: closingRun.tier,
                closedAtMs: toNumber(r.closed_at_ms) ?? 0,
                rejected: rejectedIssueIds.has(issueId),
                costUsd: closingRun.costUsd,
                runCount: runCountByIssue.get(issueId) ?? 1,
                foreignRun: pinnedModel !== null && pinnedModel !== closingRun.modelId,
              });
            }

            const priorPByModel: Record<string, number> = {};
            const blendedListPriceByModel: Record<string, number | null> = {};
            for (const model of config.models) {
              priorPByModel[model.id] = priorP(model.aaIndex);
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

      void buildQualitySignals;
      ctx.logger.info("Model Selection worker ready", { version: PLUGIN_VERSION });
    },

    async onHealth() {
      return { status: "ok", message: `Model Selection ${PLUGIN_VERSION}` };
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
