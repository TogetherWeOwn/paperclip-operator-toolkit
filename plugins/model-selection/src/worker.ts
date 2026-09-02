import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, ToolResult } from "@paperclipai/plugin-sdk";

import { planApply } from "./actuate/apply.js";
import { resolveConfig, validateConfig, type ResolvedConfig } from "./config/resolve.js";
import {
  JOB_KEYS,
  PLUGIN_STATE_KEYS,
  PLUGIN_VERSION,
  ROUTE_KEYS,
  TIER_LABEL_PREFIX,
  TOOL_NAMES,
} from "./constants.js";
import { buildQualitySignals, buildVolumeProfiles, type RunRow } from "./engine/profiles.js";
import { selectModel } from "./engine/select.js";
import type {
  IssueDescriptor,
  QualitySignal,
  SelectionDecision,
  VolumeProfile,
} from "./engine/types.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

interface StoredProfiles {
  profiles: VolumeProfile[];
  signals: QualitySignal[];
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
        config: ResolvedConfig;
      } | null> => {
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
            stickyWithinIssue: config.selection.stickyModelWithinIssue,
          },
          profiles,
          signals,
          now: Date.now(),
        });

        await ctx.metrics.write(`model_selection.decision.${decision.outcome}`, 1);
        return {
          decision,
          issueId,
          status: described.status,
          hasOverride: described.hasOverride,
          existingLabelIds: described.existingLabelIds,
          hasTierLabel: described.hasTierLabel,
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

          return { content: plan.reason + labelNote, data: { decision: result.decision, plan } };
        },
      );

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
