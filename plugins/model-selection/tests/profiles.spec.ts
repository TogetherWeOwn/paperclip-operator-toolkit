import { describe, expect, it } from "vitest";

import { buildVolumeProfiles } from "../src/engine/profiles.js";
import roster from "../config/reviewed-roster.json";
import type { ModelEntry } from "../src/engine/types.js";

const models = roster.models as ModelEntry[];

describe("volume profile attribution", () => {
  it("attributes direct CLIProxy traffic to the matching roster row", () => {
    const profiles = buildVolumeProfiles(
      [
        {
          model: "claude-opus-5",
          inputTokens: 510,
          cachedInputTokens: 120,
          outputTokens: 55,
        },
      ],
      models,
      "2026-09-11T00:00:00.000Z",
    );

    expect(profiles).toEqual([
      {
        tier: "T1",
        sampleCount: 1,
        computedAt: "2026-09-11T00:00:00.000Z",
        avgInputTokens: 510,
        avgCacheReadTokens: 120,
        avgOutputTokens: 55,
      },
    ]);
  });

  it("accepts legacy OmniRoute-wrapped usage without changing the direct roster", () => {
    const profiles = buildVolumeProfiles(
      [
        {
          model: "cliproxy/claude-opus-5",
          inputTokens: 510,
          cachedInputTokens: 120,
          outputTokens: 55,
        },
      ],
      models,
      "2026-09-11T00:00:00.000Z",
    );

    expect(profiles[0]).toMatchObject({ tier: "T1", sampleCount: 1 });
  });

  it("ignores a disabled duplicate tier when attributing an enabled model", () => {
    const duplicateModels: ModelEntry[] = [
      ...models,
      { ...models[0]!, id: "duplicate-runtime", tier: "T1", enabled: false },
      { ...models[0]!, id: "duplicate-runtime", tier: "T2", enabled: true },
    ];
    const profiles = buildVolumeProfiles(
      [
        {
          model: "cliproxy/duplicate-runtime",
          inputTokens: 120,
          cachedInputTokens: 30,
          outputTokens: 15,
        },
      ],
      duplicateModels,
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
