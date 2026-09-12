import { describe, expect, it } from "vitest";

import { buildVolumeProfiles } from "../src/engine/profiles.js";
import roster from "../config/reviewed-roster.json";
import type { ModelEntry } from "../src/engine/types.js";

const models = roster.models as ModelEntry[];

describe("volume profile attribution", () => {
  it("ignores a disabled duplicate tier when attributing an enabled model", () => {
    const profiles = buildVolumeProfiles(
      [
        {
          model: "cliproxy/glm-5.3",
          inputTokens: 120,
          cachedInputTokens: 30,
          outputTokens: 15,
        },
      ],
      models,
      "2026-09-11T00:00:00.000Z",
    );

    expect(profiles).toEqual([
      {
        tier: "T2",
        sampleCount: 1,
        computedAt: "2026-09-11T00:00:00.000Z",
        avgInputTokens: 120,
        avgCacheReadTokens: 30,
        avgOutputTokens: 15,
      },
    ]);
  });
});
