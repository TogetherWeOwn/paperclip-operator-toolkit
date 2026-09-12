import { describe, expect, it } from "vitest";

import { resolveConfig, validateConfig } from "../src/config/resolve.js";

describe("config resolution", () => {
  it("is inert with no configuration at all", () => {
    // Installing the plugin must not change a live selection variable.
    const config = resolveConfig(undefined);
    expect(config.selection.mode).toBe("advise");
    expect(config.selection.defaultTier).toBe("T1");
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

  it("allows one runtime model at multiple tiers but rejects a duplicate model+tier row", () => {
    const entry = {
      id: "cliproxy/gpt-5.6-sol",
      tier: "T1",
      releasedAt: "2026-06-01",
      costPerMTokIn: 4,
      costPerMTokOut: 20,
      costPerMTokCacheRead: 0.4,
    };
    const multiTier = validateConfig(
      resolveConfig({ models: [entry, { ...entry, tier: "T2" }] }),
    );
    expect(multiTier.errors).toEqual([]);

    const { errors } = validateConfig(resolveConfig({ models: [entry, entry] }));
    expect(errors).toContain("duplicate model+tier row: cliproxy/gpt-5.6-sol T1");
  });

  it("keeps all reviewed roster metadata", () => {
    const config = resolveConfig({
      models: [
        {
          id: "cliproxy/gpt-6-astra",
          tier: "T1",
          enabled: true,
          costPerMTokIn: 10,
          costPerMTokOut: 50,
          costPerMTokCacheRead: 1,
          aaIndex: 53,
          releasedAt: "2026-09-03",
          fallbackOnly: true,
          note: "reviewed",
          earnIn: { enabled: false },
        },
      ],
    });
    expect(config.models[0]).toMatchObject({
      aaIndex: 53,
      releasedAt: "2026-09-03",
      fallbackOnly: true,
      note: "reviewed",
      earnIn: { enabled: false },
    });
  });

  it("rejects an invalid releasedAt date", () => {
    const { errors } = validateConfig(
      resolveConfig({
        models: [
          {
            id: "bad-date",
            tier: "T1",
            releasedAt: "not-a-date",
            costPerMTokIn: 1,
            costPerMTokOut: 1,
            costPerMTokCacheRead: 1,
          },
        ],
      }),
    );
    expect(errors[0]).toContain("invalid releasedAt date");
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
