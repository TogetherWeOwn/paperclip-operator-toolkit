import { describe, expect, it } from "vitest";

import { resolveConfig, validateConfig } from "../src/config/resolve.js";

describe("config resolution", () => {
  it("is inert with no configuration at all", () => {
    // Installing the plugin must not change a live selection variable.
    const config = resolveConfig(undefined);
    expect(config.selection.mode).toBe("advise");
    expect(config.selection.defaultTier).toBe("T1");
    expect(config.selection.holdOnUntrustedProfile).toBe(true);
    expect(config.selection.fleetContextCeilingTokens).toBe(1_000_000);
    expect(config.selection.compactionRatio).toBe(0.75);
    expect(config.models).toEqual([]);
  });

  it("rejects an invalid context compaction ratio", () => {
    const { errors } = validateConfig(
      resolveConfig({ selection: { compactionRatio: 1 } }),
    );
    expect(errors).toContain("selection.compactionRatio must be greater than 0 and less than 1");
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

  it("rejects the OmniRoute cliproxy wrapper in the direct CLIProxy roster", () => {
    const { errors } = validateConfig(
      resolveConfig({
        models: [
          {
            id: "cliproxy/claude-opus-5",
            tier: "T1",
            releasedAt: "2026-06-24",
            costPerMTokIn: 5,
            costPerMTokOut: 25,
            costPerMTokCacheRead: 0.5,
          },
        ],
      }),
    );
    expect(errors).toContain(
      "model id must use the direct CLIProxy namespace without an OmniRoute cliproxy/ wrapper: cliproxy/claude-opus-5",
    );
  });

  it("allows one runtime model at multiple tiers but rejects a duplicate model+tier row", () => {
    const entry = {
      id: "gpt-5.6-sol",
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
    expect(errors).toContain("duplicate model+tier row: gpt-5.6-sol T1");
  });

  it("keeps all reviewed roster metadata", () => {
    const config = resolveConfig({
      models: [
        {
          id: "gpt-6-astra",
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
    expect(errors.some((error) => error.includes("invalid releasedAt date"))).toBe(true);
  });

  it("accepts a well-formed lane apiKeySecretRef and threads it through to resolveConfig", () => {
    const config = resolveConfig({
      pacing: {
        lanes: [
          {
            laneId: "lane-a",
            statusUrl: "https://status.example.com/lane-a",
            apiKeySecretRef: { type: "secret_ref", secretId: "153ddc6c-4d7d-4ad8-b71d-882d6cfd5ad4" },
            windows: [{ name: "primary", role: "serviceability", utilizationFields: ["utilization"] }],
          },
        ],
      },
    });
    expect(config.pacing.lanes[0]!.apiKeySecretRef).toEqual({
      type: "secret_ref",
      secretId: "153ddc6c-4d7d-4ad8-b71d-882d6cfd5ad4",
    });
    expect(validateConfig(config).errors).toEqual([]);
  });

  it("rejects a lane apiKeySecretRef holding a raw string instead of a reference", () => {
    const config = resolveConfig({
      pacing: {
        lanes: [
          {
            laneId: "lane-a",
            statusUrl: "https://status.example.com/lane-a",
            apiKeySecretRef: "sk-live-not-a-reference",
            windows: [{ name: "primary", role: "serviceability", utilizationFields: ["utilization"] }],
          },
        ],
      },
    });
    // A string bypasses the object-shaped `secretRef()` coercion in resolve.ts
    // and stays present as-is, so validateConfig's shape check is what must
    // catch it — nothing upstream silently drops it to null first.
    const { errors } = validateConfig(config);
    expect(errors.some((e) => e.includes("pacing.lanes.lane-a.apiKeySecretRef") && e.includes("not a string"))).toBe(
      true,
    );
  });

  it("rejects a lane apiKeySecretRef object missing the secret_ref discriminant", () => {
    const config = resolveConfig({
      pacing: {
        lanes: [
          {
            laneId: "lane-a",
            statusUrl: "https://status.example.com/lane-a",
            apiKeySecretRef: { value: "sk-smuggled-credential" },
            windows: [{ name: "primary", role: "serviceability", utilizationFields: ["utilization"] }],
          },
        ],
      },
    });
    const { errors } = validateConfig(config);
    expect(errors.some((e) => e.includes("pacing.lanes.lane-a.apiKeySecretRef") && e.includes("not a secret reference"))).toBe(
      true,
    );
  });

  it("leaves a lane with no apiKeySecretRef configured exactly as before (null, no errors)", () => {
    const config = resolveConfig({
      pacing: {
        lanes: [
          {
            laneId: "lane-a",
            statusUrl: "https://status.example.com/lane-a",
            windows: [{ name: "primary", role: "serviceability", utilizationFields: ["utilization"] }],
          },
        ],
      },
    });
    expect(config.pacing.lanes[0]!.apiKeySecretRef).toBeNull();
    expect(validateConfig(config).errors).toEqual([]);
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

  describe("TOG-2137 Defect 6: a roster laneId must resolve to a configured lane", () => {
    const validLane = {
      laneId: "lane-t1",
      statusUrl: "https://example.test/status",
      windows: [
        {
          name: "primary",
          role: "serviceability",
          utilizationFields: ["utilization"],
        },
      ],
    };

    it("errors when a model references a laneId absent from pacing.lanes", () => {
      const { errors } = validateConfig(
        resolveConfig({
          pacing: { mode: "shadow", lanes: [validLane] },
          models: [
            {
              id: "claude-opus-5",
              tier: "T1",
              releasedAt: "2026-06-01",
              costPerMTokIn: 15,
              costPerMTokOut: 75,
              costPerMTokCacheRead: 1.5,
              laneId: "lane-typo",
            },
          ],
        }),
      );
      expect(errors.some((e) => e.includes('references laneId "lane-typo"'))).toBe(true);
    });

    it("does not error when the referenced laneId is configured", () => {
      const { errors } = validateConfig(
        resolveConfig({
          pacing: { mode: "shadow", lanes: [validLane] },
          models: [
            {
              id: "claude-opus-5",
              tier: "T1",
              releasedAt: "2026-06-01",
              costPerMTokIn: 15,
              costPerMTokOut: 75,
              costPerMTokCacheRead: 1.5,
              laneId: "lane-t1",
            },
          ],
        }),
      );
      expect(errors).toEqual([]);
    });

    it("does not error on an unresolved laneId when pacing.mode is off", () => {
      const { errors } = validateConfig(
        resolveConfig({
          pacing: { mode: "off", lanes: [] },
          models: [
            {
              id: "claude-opus-5",
              tier: "T1",
              releasedAt: "2026-06-01",
              costPerMTokIn: 15,
              costPerMTokOut: 75,
              costPerMTokCacheRead: 1.5,
              laneId: "lane-typo",
            },
          ],
        }),
      );
      expect(errors.some((e) => e.includes("references laneId"))).toBe(false);
    });
  });
});
