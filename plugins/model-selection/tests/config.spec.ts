import { describe, expect, it } from "vitest";

import { resolveConfig, validateConfig } from "../src/config/resolve.js";

describe("config resolution", () => {
  it("is inert with no configuration at all", () => {
    // Installing the plugin must not change a live selection variable.
    const config = resolveConfig(undefined);
    expect(config.selection.mode).toBe("advise");
    expect(config.selection.defaultTier).toBe("T3");
    expect(config.selection.holdOnUntrustedProfile).toBe(true);
    expect(config.models).toEqual([]);
  });

  it("keeps only well-formed tier label ids", () => {
    const config = resolveConfig({
      tierLabelIds: { T1: "lbl-1", T2: "", T3: 7 },
    });
    expect(config.tierLabelIds).toEqual({ T1: "lbl-1" });
  });

  it("treats an absent tier label id as a supported configuration", () => {
    // The label is additive information, not a gate (ADR-0008), so a missing id
    // is a warning at most — never an error that blocks the override write.
    const config = resolveConfig({
      selection: { mode: "enforce" },
      models: [
        {
          id: "claude-opus-5",
          tier: "T3",
          costPerMTokIn: 15,
          costPerMTokOut: 75,
          costPerMTokCacheRead: 1.5,
        },
      ],
    });
    const { errors, warnings } = validateConfig(config);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes("no tierLabelIds configured"))).toBe(true);
  });

  it("rejects a duplicate model id", () => {
    const entry = {
      id: "claude-opus-5",
      tier: "T3",
      costPerMTokIn: 15,
      costPerMTokOut: 75,
      costPerMTokCacheRead: 1.5,
    };
    const { errors } = validateConfig(resolveConfig({ models: [entry, entry] }));
    expect(errors).toContain("duplicate model id: claude-opus-5");
  });

  it("warns when a zero cache-read rate would hide the largest cost line", () => {
    const { warnings } = validateConfig(
      resolveConfig({
        models: [
          {
            id: "claude-opus-5",
            tier: "T3",
            costPerMTokIn: 15,
            costPerMTokOut: 75,
            costPerMTokCacheRead: 0,
          },
        ],
      }),
    );
    expect(warnings.some((w) => w.includes("cache read is the largest cost line"))).toBe(true);
  });
});
