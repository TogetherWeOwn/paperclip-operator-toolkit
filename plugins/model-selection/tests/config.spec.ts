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
    expect(config.selection.agentEnvContextTokens).toBe(1_000_000);
    expect(config.selection.compactionRatio).toBe(0.75);
    expect(config.models).toEqual([]);
    expect(config.accountAdmissionShadow.enabled).toBe(false);
  });

  it("requires an explicit absolute context log root without changing the fleet ceiling", () => {
    expect(resolveConfig({}).selection.contextRunLogRoot).toBeNull();
    const configured = resolveConfig({ selection: { contextRunLogRoot: "/test/run-logs", fleetContextCeilingTokens: 200_000 } });
    expect(configured.selection.contextRunLogRoot).toBe("/test/run-logs");
    expect(configured.selection.fleetContextCeilingTokens).toBe(200_000);
    expect(validateConfig(resolveConfig({ selection: { contextRunLogRoot: "relative/logs" } })).errors)
      .toContain("selection.contextRunLogRoot must be an absolute path");
  });

  it("resolves an unset agent-env cap to the fleet ceiling", () => {
    // Unset behaves exactly as before the split: the pin stamps against the
    // fleet ceiling until the operator sets `agentEnvContextTokens`.
    expect(resolveConfig({}).selection.agentEnvContextTokens).toBe(1_000_000);
    expect(
      resolveConfig({ selection: { fleetContextCeilingTokens: 200_000 } }).selection
        .agentEnvContextTokens,
    ).toBe(200_000);
    expect(
      resolveConfig({
        selection: { fleetContextCeilingTokens: 200_000, agentEnvContextTokens: 1_000_000 },
      }).selection.agentEnvContextTokens,
    ).toBe(1_000_000);
  });

  it("rejects a non-positive agent-env cap", () => {
    const { errors } = validateConfig(
      resolveConfig({ selection: { agentEnvContextTokens: 0 } }),
    );
    expect(errors).toContain("selection.agentEnvContextTokens must be a positive number");
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
          id: "gpt-5.6-sol",
          tier: "T1",
          costPerMTokIn: 4,
          costPerMTokOut: 20,
          costPerMTokCacheRead: 0.4,
        },
        {
          id: "glm-5.3",
          tier: "T2",
          costPerMTokIn: 3,
          costPerMTokOut: 15,
          costPerMTokCacheRead: 0.3,
        },
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
    expect(config.pacing.lanes[0]!.lane.accountKeyFields).toEqual([
      "account_key",
      "accountKey",
      "name",
      "id",
    ]);
    expect(config.pacing.lanes[0]!.lane.weightFields).toEqual(["plan_weight", "weight"]);
    expect(validateConfig(config).errors).toEqual([]);
  });

  it("threads configured account identity fields into the lane pace definition", () => {
    const config = resolveConfig({
      pacing: {
        lanes: [
          {
            laneId: "lane-a",
            statusUrl: "https://status.example.com/lane-a",
            accountKeyFields: ["lane", "account_id"],
            windows: [{ name: "primary", role: "serviceability", utilizationFields: ["utilization"] }],
          },
        ],
      },
    });

    expect(config.pacing.lanes[0]!.lane.accountKeyFields).toEqual(["lane", "account_id"]);
  });

  it("preserves explicit weight fields and restores production defaults for empty lists", () => {
    const lane = (weightFields: unknown) => ({
      laneId: "lane-a",
      statusUrl: "https://status.example.com/lane-a",
      weightFields,
      windows: [{ name: "primary", role: "serviceability", utilizationFields: ["utilization"] }],
    });

    const explicit = resolveConfig({ pacing: { lanes: [lane(["capacity_weight"])] } });
    expect(explicit.pacing.lanes[0]!.lane.weightFields).toEqual(["capacity_weight"]);

    for (const weightFields of [[], [null, 7, ""]]) {
      const fallback = resolveConfig({ pacing: { lanes: [lane(weightFields)] } });
      expect(fallback.pacing.lanes[0]!.lane.weightFields).toEqual(["plan_weight", "weight"]);
    }
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

  describe(" Defect 6: a roster laneId must resolve to a configured lane", () => {
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

  describe(" P2: aaFreeSync is default-off and fail-loud when enabled", () => {
    const SECRET = { type: "secret_ref", secretId: "153ddc6c-4d7d-4ad8-b71d-882d6cfd5ad4" };
    const BINDING = {
      candidateId: "opus-high",
      modelId: "claude-opus-5",
      laneId: "lane-claude",
      evaluatedEffort: "high",
      aaSlug: "opus-high",
    };

    it("is disabled with no bindings and a 49h freshness bound out of the box", () => {
      const config = resolveConfig(undefined);
      expect(config.aaFreeSync.enabled).toBe(false);
      expect(config.aaFreeSync.apiKeySecretRef).toBeNull();
      expect(config.aaFreeSync.bindings).toEqual([]);
      expect(config.aaFreeSync.maxSnapshotAgeHours).toBe(49);
      expect(validateConfig(config).errors).toEqual([]);
    });

    it("resolves a well-formed section and drops malformed binding rows", () => {
      const config = resolveConfig({
        aaFreeSync: {
          enabled: true,
          apiKeySecretRef: SECRET,
          bindings: [BINDING, { candidateId: "", modelId: "x" }, "junk", { ...BINDING, candidateId: "opus-max", evaluatedEffort: "max", aaSlug: "opus-max", observationalOnly: true }],
          maxSnapshotAgeHours: 24,
        },
      });
      expect(config.aaFreeSync.enabled).toBe(true);
      expect(config.aaFreeSync.apiKeySecretRef).toMatchObject({ type: "secret_ref" });
      expect(config.aaFreeSync.bindings).toEqual([BINDING, { ...BINDING, candidateId: "opus-max", evaluatedEffort: "max", aaSlug: "opus-max", observationalOnly: true }]);
      expect(config.aaFreeSync.maxSnapshotAgeHours).toBe(24);
      expect(validateConfig(config).errors).toEqual([]);
    });

    it("errors when enabled without a secret, with duplicate bindings, or a bad freshness bound", () => {
      expect(validateConfig(resolveConfig({ aaFreeSync: { enabled: true, bindings: [BINDING] } })).errors)
        .toContain("aaFreeSync.enabled is true but no aaFreeSync.apiKeySecretRef is configured; the free list cannot be fetched");
      expect(validateConfig(resolveConfig({ aaFreeSync: { enabled: true, apiKeySecretRef: SECRET, bindings: [BINDING, BINDING] } })).errors)
        .toContain("duplicate aaFreeSync binding: claude-opus-5 lane-claude high");
      expect(validateConfig(resolveConfig({ aaFreeSync: { enabled: true, apiKeySecretRef: SECRET, maxSnapshotAgeHours: 0 } })).errors)
        .toContain("aaFreeSync.maxSnapshotAgeHours must be a positive number of hours");
    });

    it("rejects a pasted credential and warns on zero bindings", () => {
      const raw = resolveConfig({ aaFreeSync: { enabled: true, apiKeySecretRef: "sk-live-key" } });
      expect(validateConfig(raw).errors.some((e) => e.includes("aaFreeSync.apiKeySecretRef") && e.includes("not a string"))).toBe(true);
      const { errors, warnings } = validateConfig(
        resolveConfig({ aaFreeSync: { enabled: true, apiKeySecretRef: SECRET } }),
      );
      expect(errors).toEqual([]);
      expect(warnings.some((w) => w.includes("no aaFreeSync.bindings are curated"))).toBe(true);
    });
  });

  describe(": acceptedWork is default-off", () => {
    it("is disabled out of the box, with no validation errors", () => {
      const config = resolveConfig(undefined);
      expect(config.acceptedWork.enabled).toBe(false);
      expect(validateConfig(config).errors).toEqual([]);
    });

    it("resolves an explicit enable and stays a pure kill switch", () => {
      const config = resolveConfig({ acceptedWork: { enabled: true } });
      expect(config.acceptedWork.enabled).toBe(true);
      expect(validateConfig(config).errors).toEqual([]);
      // A truthy non-boolean is not an enable: the producer must never start
      // on an ambiguous value.
      expect(resolveConfig({ acceptedWork: { enabled: "yes" } }).acceptedWork.enabled).toBe(false);
    });
  });

  describe(" enforce preflight: refuse enforce while any tier has zero enabled rows", () => {
    const row = (id: string, tier: string, enabled = true) => ({
      id,
      tier,
      enabled,
      releasedAt: "2026-06-01",
      costPerMTokIn: 5,
      costPerMTokOut: 25,
      costPerMTokCacheRead: 0.5,
    });

    it("resolves enforce OK when every tier has an enabled row", () => {
      const { errors } = validateConfig(
        resolveConfig({
          selection: { mode: "enforce" },
          models: [row("t1-model", "T1"), row("t2-model", "T2"), row("t3-model", "T3")],
        }),
      );
      expect(errors).toEqual([]);
    });

    it("refuses enforce with the empty tier named", () => {
      const { errors } = validateConfig(
        resolveConfig({
          selection: { mode: "enforce" },
          models: [row("t1-model", "T1"), row("t3-model", "T3"), row("t2-off", "T2", false)],
        }),
      );
      expect(errors.some((e) => e.includes("tier T2") && e.includes("no enabled models"))).toBe(true);
    });

    it("leaves advise mode on a warning when a tier is empty", () => {
      const { errors, warnings } = validateConfig(
        resolveConfig({
          selection: { mode: "advise" },
          models: [row("t1-model", "T1"), row("t3-model", "T3")],
        }),
      );
      expect(errors).toEqual([]);
      expect(warnings.some((w) => w.includes("no enabled model at tier T2"))).toBe(true);
    });

    it("skips the enforce gate when selection is disabled", () => {
      const { errors } = validateConfig(
        resolveConfig({
          selection: { enabled: false, mode: "enforce" },
          models: [row("t1-model", "T1"), row("t3-model", "T3")],
        }),
      );
      expect(errors).toEqual([]);
    });
  });
});
