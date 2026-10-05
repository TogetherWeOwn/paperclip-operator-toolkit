import { describe, expect, it } from "vitest";

import { resolveAaSlug, tierImpliedByIndex } from "../../src/aa-index/match.js";

describe("resolveAaSlug", () => {
  const knownSlugs = new Set(["claude-opus-5", "claude-sonnet-5", "glm-4-5v"]);

  it("strips known routing-provenance prefixes before matching", () => {
    expect(resolveAaSlug("cliproxy/claude-opus-5", knownSlugs)).toBe("claude-opus-5");
    expect(resolveAaSlug("openrouter/claude-opus-5", knownSlugs)).toBe("claude-opus-5");
    expect(resolveAaSlug("opencode-go/claude-opus-5", knownSlugs)).toBe("claude-opus-5");
    expect(resolveAaSlug("zai/claude-opus-5", knownSlugs)).toBe("claude-opus-5");
  });

  it("lowercases and turns dots into dashes to match aa.ai's slug shape", () => {
    expect(resolveAaSlug("GLM-4.5V", knownSlugs)).toBe("glm-4-5v");
  });

  it("an explicit aaSlug always wins over normalized-id matching", () => {
    expect(resolveAaSlug("some-internal-id", knownSlugs, "glm-4-5v")).toBe("glm-4-5v");
  });

  it("an explicit aaSlug that isn't in the known set is still a miss, not a wrong match", () => {
    expect(resolveAaSlug("some-internal-id", knownSlugs, "not-a-real-slug")).toBeNull();
  });

  it("returns null on a normalized id with no exact match — never fuzzy", () => {
    expect(resolveAaSlug("cliproxy/totally-unknown-model", knownSlugs)).toBeNull();
  });
});

describe("tierImpliedByIndex", () => {
  // priorP(idx) = clamp(0.55 + 0.45*(idx/60), 0.55, 1.0); thresholds T1=0.85 T2=0.8 T3=0.75.
  // Solving priorP(idx) = threshold: idx = (threshold - 0.55) * 60 / 0.45
  // T1 boundary: idx = 40 exactly -> priorP(40) = 0.85 -> T1
  // T2 boundary: idx = 33.33.. -> priorP >= 0.8 at idx >= 33.33
  // T3 boundary: idx = 26.67.. -> priorP >= 0.75 at idx >= 26.67

  it("39 does not clear T1's bar, 40 does", () => {
    expect(tierImpliedByIndex(39)).not.toBe("T1");
    expect(tierImpliedByIndex(40)).toBe("T1");
  });

  it("33 does not clear T2's bar, 34 does (and clears no higher tier)", () => {
    expect(tierImpliedByIndex(33)).not.toBe("T2");
    expect(tierImpliedByIndex(34)).toBe("T2");
  });

  it("26 does not clear T3's bar, 27 does (and clears no higher tier)", () => {
    expect(tierImpliedByIndex(26)).toBeNull();
    expect(tierImpliedByIndex(27)).toBe("T3");
  });

  it("returns null for an index that clears no tier's threshold", () => {
    expect(tierImpliedByIndex(0)).toBeNull();
  });

  it("46 does not clear T0's cut, 47 does ()", () => {
    expect(tierImpliedByIndex(46)).toBe("T1");
    expect(tierImpliedByIndex(47)).toBe("T0");
  });

  it("returns T0 for a very high index", () => {
    expect(tierImpliedByIndex(100)).toBe("T0");
  });
});
