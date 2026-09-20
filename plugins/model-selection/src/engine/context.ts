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

/**
 * TOG-3045. The sub-call model surfaces a pin must carry alongside the main
 * model, or the evacuation is partial.
 *
 * TOG-3034 measured the fleet (`docs/routing/TOG-3012-lane-exhaustion-autoheal.md`
 * §#1b): 24 of 26 agents point both of these at the CLIProxy Codex lane. Repin
 * the main model away from an exhausted lane and leave these behind, and the
 * card's haiku-class sub-calls still resolve to the dead lane — a run that reads
 * as successfully evacuated and then fails on a sub-call.
 *
 * Deliberately NOT in this list:
 *
 * - `CLAUDE_CODE_SUBAGENT_MODEL` — an `env.*` surface this write path could
 *   reach, but out of TOG-3045's scope; it steers Task-tool subagents, not the
 *   harness's own haiku-class calls, so its correct target is a separate
 *   question. `ANCILLARY_ENV_KEYS` in `engine/ancillary.ts` still *reports*
 *   drift on it.
 * - `runtimeConfig.modelProfiles.cheap` — genuinely unreachable from here. It is
 *   read off the agent row only (`readAgentRuntimeModelProfile`,
 *   `heartbeat.ts:~1246`) and `assigneeAdapterOverrides` never touches it, so
 *   covering it needs an agent-row write. Forbidden per the owner rule and
 *   ADR-0010; it is on the doc's core-blocked list.
 */
export const ANCILLARY_MODEL_ENV_KEYS = [
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const;

/**
 * A secret-bound env value. We can neither read what it resolves to nor
 * reconstruct it, so we never overwrite one — the same rule
 * `ancillaryDriftForAgent` applies when it refuses to call a secret-bound
 * surface "drifted".
 */
function isSecretBinding(binding: unknown): boolean {
  if (!binding || typeof binding !== "object") return false;
  const type = (binding as Record<string, unknown>).type;
  return type === "secret_ref" || type === "user_secret_ref";
}

export interface ModelOverrideInput {
  model: Pick<ModelEntry, "id" | "contextWindow">;
  fleetCeilingTokens: number;
  compactionRatio: number;
  /**
   * The assignee agent's `adapterConfig.env`, or `null`/absent when it is
   * UNKNOWN — no assignee, or the agent read failed.
   *
   * The distinction is load-bearing, not cosmetic. Because the host replaces the
   * whole `env` object (see below), writing an env map we built from an unknown
   * base would delete every binding the agent actually carries — GH tokens and
   * all. So an unknown agent env suppresses the ancillary writes entirely: the
   * main model pin still lands, and the run keeps the agent's env untouched.
   * A known-but-empty env (`{}`) is a different fact and does get them.
   */
  agentEnv?: AdapterEnv | null;
  existingOverrideEnv?: AdapterEnv;
}

/**
 * Env keys this plugin writes, and is therefore entitled to carry forward from
 * a previous pin. Everything else in an existing override is a value some other
 * writer owns, which this plugin can neither re-derive nor re-validate.
 */
const PLUGIN_OWNED_ENV_KEYS: readonly string[] = [CONTEXT_LIMIT_ENV_KEY];

/**
 * Build the complete issue-level adapter override.
 *
 * The host shallow-spreads `issueOverrides.adapterConfig` over the agent
 * adapter config — `{...baseConfig, ...modelProfile.adapterConfig, ...issueAdapterConfig}`,
 * `mergeModelProfileAdapterConfig`, `heartbeat.ts:3705-3714` — so an issue-level
 * `env` object replaces the agent's `env` object wholesale, per key it does not
 * carry included. Merge the maps here before writing; otherwise adding the
 * compaction ceiling or a sub-call pin silently deletes every unrelated agent
 * env binding.
 *
 * The agent side of that merge (`agentEnv`) is re-read from the agent record on
 * every pass (`worker.ts` describeIssue), so it always describes the assignee as
 * of now. The existing override is not: it is a snapshot written by an earlier
 * repin, under whatever assignment held at the time. Spreading it wholesale
 * ratchets that snapshot onto every later pin — so reassigning a card injects
 * the previous assignee's secret refs (TOG-3235), and unbinding a secret never
 * takes effect because the pin keeps re-supplying the dead ref. So when the
 * assignee env is KNOWN we rebuild from it and carry forward only the keys this
 * plugin owns; the assignee's own bindings come back from `agentEnv`, the source
 * of truth, and never needed the snapshot. When the assignee env is UNKNOWN we
 * cannot rebuild, so we fall back to preserving the existing override rather than
 * clobber bindings we cannot see.
 */
export function modelOverrideForContext(input: ModelOverrideInput): {
  assigneeAdapterOverrides: { adapterConfig: { model: string; env?: AdapterEnv } };
} {
  const agentEnvKnown = input.agentEnv !== null && input.agentEnv !== undefined;
  const agentEnv = input.agentEnv ?? {};
  const overrideEnv = input.existingOverrideEnv ?? {};
  // Known assignee: rebuild from `agentEnv` and carry forward only plugin-owned
  // keys from the old pin. Unknown assignee: we have no current base to rebuild
  // from, so preserve the existing override instead of clobbering unseen bindings.
  let carriedOverrideEnv: AdapterEnv;
  if (agentEnvKnown) {
    carriedOverrideEnv = {};
    for (const key of PLUGIN_OWNED_ENV_KEYS) {
      if (key in overrideEnv) carriedOverrideEnv[key] = overrideEnv[key];
    }
  } else {
    carriedOverrideEnv = overrideEnv;
  }
  const env: AdapterEnv = { ...agentEnv, ...carriedOverrideEnv };
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

  // Point the haiku-class sub-call surfaces at the same model the main pin just
  // selected. That model cleared the lane ledger, the serviceability hard stop
  // and the pace gate to be chosen at all, so it is healthy BY CONSTRUCTION —
  // which is the property the sub-calls were missing. It may be dearer than a
  // dedicated T3 pick; a sub-call on a live lane beats a cheap one on a dead
  // lane, and these are per-issue, not a fleet default.
  if (agentEnvKnown) {
    for (const key of ANCILLARY_MODEL_ENV_KEYS) {
      if (isSecretBinding(env[key])) continue;
      env[key] = { type: "plain", value: input.model.id };
    }
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
