import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { resolveConfig, validateConfig } from "../src/config/resolve.js";
import { selectModel } from "../src/engine/select.js";
import type { QualitySignal, VolumeProfile } from "../src/engine/types.js";

const raw = JSON.parse(
  readFileSync(new URL("../config/reviewed-roster.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const resolved = resolveConfig(raw);
const now = Date.parse("2026-09-10T12:00:00.000Z");
const computedAt = new Date(now - 60 * 60 * 1000).toISOString();
const profiles: VolumeProfile[] = ["T1", "T2", "T3"].map((tier) => ({
  tier: tier as "T1" | "T2" | "T3",
  sampleCount: 100,
  computedAt,
  avgInputTokens: 3,
  avgCacheReadTokens: 0,
  avgOutputTokens: 1,
}));
const signals: QualitySignal[] = [];

function decide(label: "T1" | "T2" | "T3", exclusion = false) {
  return selectModel({
    descriptor: {
      issueId: `fixture-${label}`,
      labelNames: [`tier:${label}`],
      exclusion: exclusion ? { excluded: true, reasons: ["credential access"] } : undefined,
    },
    config: {
      enforcementEnabled: false,
      defaultTier: resolved.selection.defaultTier,
      models: resolved.models,
      holdOnUntrustedProfile: false,
      stickyWithinIssue: false,
    },
    profiles,
    signals,
    now,
  });
}

describe("reviewed live-config fixture", () => {
  it("is valid and carries the authoritative roster metadata", () => {
    expect(validateConfig(resolved).errors).toEqual([]);
    expect(resolved.models.length).toBeGreaterThan(20);
    for (const model of resolved.models) {
      expect(model.releasedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof model.fallbackOnly).toBe("boolean");
      expect(typeof model.note).toBe("string");
      expect(model.earnIn === null || typeof model.earnIn === "object").toBe(true);
    }
  });

  it("selects sol for tier:T1 under exact list-price ordering", () => {
    expect(decide("T1").modelId).toBe("gpt-5.6-sol");
  });

  it("keeps the canonical Z.ai GLM routes enabled without an obsolete T1 duplicate", () => {
    expect(
      resolved.models.find((model) => model.id === "glm-5.3" && model.tier === "T2"),
    ).toMatchObject({ enabled: true });
    expect(
      resolved.models.find((model) => model.id === "glm-5.3-flash" && model.tier === "T3"),
    ).toMatchObject({ enabled: true });
    expect(resolved.models.filter((model) => model.id === "glm-5.3" && model.tier === "T1")).toEqual([]);
  });

  it("never selects Claude for tier:T2", () => {
    const decision = decide("T2");
    expect(decision.modelId).toBe("glm-5.3");
    expect(decision.modelId).not.toContain("claude");
  });

  it("routes an excluded sensitive card through T1", () => {
    const decision = decide("T3", true);
    expect(decision.judgement.tier).toBe("T1");
    expect(decision.modelId).toBe("gpt-5.6-sol");
  });

  it("never returns disabled Sonnet or Haiku rows", () => {
    for (const tier of ["T1", "T2", "T3"] as const) {
      const decision = decide(tier);
      expect(decision.modelId).not.toBe("claude-sonnet-5");
      expect(decision.modelId).not.toBe("claude-haiku-4-5-20251001");
    }
  });
});
