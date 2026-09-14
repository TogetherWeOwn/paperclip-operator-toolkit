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
