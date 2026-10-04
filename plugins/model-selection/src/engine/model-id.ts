import type { ModelEntry } from "./types.js";

const OMNIROUTE_PROVIDER_PREFIX = "cliproxy/";

/**
 * Resolve an observed model id into the roster's CLIProxy-native namespace.
 *
 * The direct CLIProxy API accepts bare ids such as `claude-opus-5`, plus
 * provider-qualified ids that CLIProxy itself exposes such as `zai/glm-5.3`.
 * OmniRoute historically prepended `cliproxy/` to both forms in pins and
 * telemetry. Accept that legacy wrapper only when stripping it identifies an
 * exact configured id. Never guess by suffix: `glm-5.3`, `zai/glm-5.3`, and
 * `zai-openai/glm-5.3` are distinct routable models.
 */
export function resolveConfiguredModelId(
  modelId: string | null | undefined,
  models: readonly ModelEntry[],
): string | null {
  if (!modelId) return null;
  if (models.some((model) => model.id === modelId)) return modelId;
  if (!modelId.startsWith(OMNIROUTE_PROVIDER_PREFIX)) return null;

  const directModelId = modelId.slice(OMNIROUTE_PROVIDER_PREFIX.length);
  return models.some((model) => model.id === directModelId) ? directModelId : null;
}

/**
 * Roster id prefix for Devin rows (mirrors the price-sync
 * `DEVIN_PREFIX`: Devin meters by subscription/ACU, not per token).
 */
const DEVIN_MODEL_PREFIX = "devin/";

/** The adapter whose system banner Devin's content filter rejects. */
export const ADAPTER_CLAUDE_LOCAL = "claude_local";

/** Whether this roster id names a Devin model. Prefix match only — never a suffix guess. */
export function isDevinModelId(modelId: string | null | undefined): boolean {
  return typeof modelId === "string" && modelId.startsWith(DEVIN_MODEL_PREFIX);
}

/**
 * Adapter-compatibility: `devin/*` models cannot serve a
 * `claude_local` assignee. Devin's content filter rejects the Claude Code /
 * Agent SDK system banner (Cognition ticket 71806) — measured 25 failed / 3
 * succeeded runs on claude_local+devin. Devin works via opencode/codex
 * adapters, so only this pair is excluded. An unknown adapter never excludes.
 */
export function isAdapterBlockedModel(
  modelId: string | null | undefined,
  adapterType: string | null | undefined,
): boolean {
  return adapterType === ADAPTER_CLAUDE_LOCAL && isDevinModelId(modelId);
}
