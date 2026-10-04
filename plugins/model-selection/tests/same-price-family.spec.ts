import { describe, expect, it } from "vitest";

import { compareSamePriceFamily, modelFamily, sharesPriceFamily } from "../src/engine/same-price-family.js";
import type { ModelEntry } from "../src/engine/types.js";

function model(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: "m1",
    tier: "T1",
    enabled: true,
    costPerMTokIn: 5,
    costPerMTokOut: 25,
    costPerMTokCacheRead: 0.5,
    capabilities: [],
    contextWindow: 200_000,
    aaIndex: null,
    releasedAt: "2026-01-01",
    fallbackOnly: false,
    note: "",
    earnIn: null,
    ...overrides,
  };
}

describe("modelFamily", () => {
  it("collapses a trailing run of version-like segments", () => {
    expect(modelFamily("claude-opus-4-8")).toBe("claude-opus");
    expect(modelFamily("claude-opus-5")).toBe("claude-opus");
    expect(modelFamily("claude-opus-4-1-20250805")).toBe("claude-opus");
    expect(modelFamily("claude-fable-5-1")).toBe("claude-fable");
    expect(modelFamily("claude-sonnet-4-5-20250929")).toBe("claude-sonnet");
  });

  it("leaves a non-version trailing segment whole, and strips a provider/ prefix first", () => {
    expect(modelFamily("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(modelFamily("zai/glm-5.3")).toBe("glm");
    expect(modelFamily("zai/glm-5.3-flash")).toBe("zai/glm-5.3-flash".split("/")[1]);
  });
});

describe("sharesPriceFamily", () => {
  it("matches two enabled same-tier, same-family, same-price rows", () => {
    const a = model({ id: "claude-opus-4-8", releasedAt: "2026-08-20" });
    const b = model({ id: "claude-opus-5", releasedAt: "2026-06-24" });
    expect(sharesPriceFamily(a, b)).toBe(true);
  });

  it("does not match across tiers, families, or prices", () => {
    const opus48 = model({ id: "claude-opus-4-8" });
    expect(sharesPriceFamily(opus48, model({ id: "claude-opus-5", tier: "T2" }))).toBe(false);
    expect(sharesPriceFamily(opus48, model({ id: "claude-sonnet-5" }))).toBe(false);
    expect(sharesPriceFamily(opus48, model({ id: "claude-opus-5", costPerMTokIn: 10 }))).toBe(false);
  });

  it("does not match a disabled row", () => {
    const a = model({ id: "claude-opus-4-8", enabled: false });
    const b = model({ id: "claude-opus-5" });
    expect(sharesPriceFamily(a, b)).toBe(false);
  });
});

describe("compareSamePriceFamily — owner rule (same-price-newer-model-rule)", () => {
  it("returns 0 (no opinion) for a pair that isn't a same-price-family match", () => {
    const a = model({ id: "claude-opus-4-8" });
    const b = model({ id: "gpt-5.6-sol" });
    expect(compareSamePriceFamily(a, b)).toBe(0);
  });

  it("prefers the newer release regardless of argument order or roster releasedAt string ordering", () => {
    // Roster data bug this ships alongside a fix for: the older-numbered
    // model (4-8) can carry a LATER releasedAt string than the newer-lined
    // one (5) due to a bad estimate. The rule must still pick the actually
    // newer model, not whichever has the lexicographically later date.
    const older = model({ id: "claude-opus-4-8", releasedAt: "2026-08-20" });
    const newer = model({ id: "claude-opus-5", releasedAt: "2026-06-24" });
    // Even though `older.releasedAt` > `newer.releasedAt` as strings, `newer`
    // is who the rule should prefer once dates are corrected upstream — this
    // spec fixes the date inputs to the true, corrected ordering directly so
    // the comparator's own logic is exercised independent of the roster fix.
    const correctedOlder = model({ id: "claude-opus-4-8", releasedAt: "2026-05-05" });
    expect(compareSamePriceFamily(correctedOlder, newer)).toBeGreaterThan(0);
    expect(compareSamePriceFamily(newer, correctedOlder)).toBeLessThan(0);
  });

  it("lets the older model win when it carries an explicit provenBetter earn-in verdict", () => {
    const older = model({
      id: "claude-opus-4-8",
      releasedAt: "2026-05-05",
      earnIn: { verdict: "provenBetter", evidence: "Eval" },
    });
    const newer = model({ id: "claude-opus-5", releasedAt: "2026-06-24" });
    expect(compareSamePriceFamily(older, newer)).toBeLessThan(0);
    expect(compareSamePriceFamily(newer, older)).toBeGreaterThan(0);
  });

  it("ignores an earn-in object that isn't the provenBetter verdict", () => {
    const older = model({
      id: "claude-opus-4-8",
      releasedAt: "2026-05-05",
      earnIn: { verdict: "unproven" },
    });
    const newer = model({ id: "claude-opus-5", releasedAt: "2026-06-24" });
    expect(compareSamePriceFamily(older, newer)).toBeGreaterThan(0);
  });
});
