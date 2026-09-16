import type { ModelEntry } from "./types.js";

export const CONTEXT_LIMIT_ENV_KEY = "CLAUDE_CODE_MAX_CONTEXT_TOKENS";

export interface ContextEstimate {
  tokens: number | null;
  source: "explicit" | "last-run-context" | "none";
}

export interface ContextEstimateInput {
  explicitTokens?: number;
  lastRunInputTokens?: number | null;
  lastRunCachedInputTokens?: number | null;
  fleetCeilingTokens: number;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

/**
 * Estimate the largest prompt an issue needs to survive before selection.
 *
 * An explicit caller requirement is authoritative and is never capped. The
 * latest issue run is the only automatic fallback: tier volume profiles contain
 * cumulative multi-turn billing totals, so treating one as a request-sized
 * context estimate would wrongly exclude narrow models before the issue runs.
 * Observed run totals are bounded by the fleet's own compaction ceiling: above
 * that point the harness would compact rather than submit a still-larger request
 * on a correctly configured fleet model.
 */
export function estimateIssueContext(input: ContextEstimateInput): ContextEstimate {
  const explicit = positiveInteger(input.explicitTokens);
  if (explicit !== null) return { tokens: explicit, source: "explicit" };

  const fleetCeiling = positiveInteger(input.fleetCeilingTokens);
  const capObserved = (value: unknown): number | null => {
    const tokens = positiveInteger(value);
    if (tokens === null) return null;
    return fleetCeiling === null ? tokens : Math.min(tokens, fleetCeiling);
  };
  const inputContextTotal = (uncached: unknown, cached: unknown): number | null => {
    const parts = [uncached, cached].filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
    );
    if (parts.length === 0) return null;
    return positiveInteger(parts.reduce((total, value) => total + Math.floor(value), 0));
  };

  const lastRun = capObserved(
    inputContextTotal(input.lastRunInputTokens, input.lastRunCachedInputTokens),
  );
  if (lastRun !== null) return { tokens: lastRun, source: "last-run-context" };

  return { tokens: null, source: "none" };
}

export type AdapterEnv = Record<string, unknown>;

export interface ModelOverrideInput {
  model: Pick<ModelEntry, "id" | "contextWindow">;
  fleetCeilingTokens: number;
  compactionRatio: number;
  agentEnv?: AdapterEnv;
  existingOverrideEnv?: AdapterEnv;
}

/**
 * Build the complete issue-level adapter override.
 *
 * The host shallow-spreads `issueOverrides.adapterConfig` over the agent
 * adapter config, so an issue-level `env` object replaces the agent's `env`
 * object. Merge the maps here before writing; otherwise adding the compaction
 * ceiling silently deletes every unrelated agent env binding.
 */
export function modelOverrideForContext(input: ModelOverrideInput): {
  assigneeAdapterOverrides: { adapterConfig: { model: string; env?: AdapterEnv } };
} {
  const agentEnv = input.agentEnv ?? {};
  const overrideEnv = input.existingOverrideEnv ?? {};
  const env: AdapterEnv = { ...agentEnv, ...overrideEnv };
  const fleetCeiling = positiveInteger(input.fleetCeilingTokens);
  const modelWindow = positiveInteger(input.model.contextWindow);
  const ratio =
    Number.isFinite(input.compactionRatio) && input.compactionRatio > 0 && input.compactionRatio < 1
      ? input.compactionRatio
      : 0.75;

  if (fleetCeiling !== null && modelWindow !== null && modelWindow < fleetCeiling) {
    env[CONTEXT_LIMIT_ENV_KEY] = {
      type: "plain",
      value: String(Math.max(1, Math.floor(modelWindow * ratio))),
    };
  } else {
    delete env[CONTEXT_LIMIT_ENV_KEY];
  }

  const mustWriteEnv =
    Object.keys(env).length > 0 ||
    CONTEXT_LIMIT_ENV_KEY in agentEnv ||
    CONTEXT_LIMIT_ENV_KEY in overrideEnv;

  return {
    assigneeAdapterOverrides: {
      adapterConfig: {
        model: input.model.id,
        ...(mustWriteEnv ? { env } : {}),
      },
    },
  };
}
