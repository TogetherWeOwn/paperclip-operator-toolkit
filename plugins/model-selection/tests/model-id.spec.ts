import { describe, expect, it } from "vitest";

import { resolveConfiguredModelId } from "../src/engine/model-id.js";
import type { ModelEntry } from "../src/engine/types.js";
import { MODELS } from "./fixtures.js";

describe("runtime model id resolution", () => {
  it("keeps an exact direct CLIProxy model id", () => {
    expect(resolveConfiguredModelId("claude-opus-5", MODELS)).toBe("claude-opus-5");
  });

  it("maps a legacy OmniRoute wrapper to the exact direct roster id", () => {
    expect(resolveConfiguredModelId("cliproxy/claude-opus-5", MODELS)).toBe(
      "claude-opus-5",
    );
  });

  it("preserves CLIProxy-native provider namespaces", () => {
    const providerModels: ModelEntry[] = [
      { ...MODELS[2]!, id: "zai/glm-5.3" },
      { ...MODELS[2]!, id: "zai-openai/glm-5.3" },
    ];
    expect(resolveConfiguredModelId("zai/glm-5.3", providerModels)).toBe("zai/glm-5.3");
    expect(resolveConfiguredModelId("cliproxy/zai/glm-5.3", providerModels)).toBe(
      "zai/glm-5.3",
    );
  });

  it("does not guess a provider from a shared suffix", () => {
    const providerModels: ModelEntry[] = [
      { ...MODELS[2]!, id: "glm-5.3" },
      { ...MODELS[2]!, id: "zai/glm-5.3" },
    ];
    expect(resolveConfiguredModelId("other/glm-5.3", providerModels)).toBeNull();
  });

  it("does not unwrap an unknown legacy model id", () => {
    expect(resolveConfiguredModelId("cliproxy/unknown-model", MODELS)).toBeNull();
  });
});
