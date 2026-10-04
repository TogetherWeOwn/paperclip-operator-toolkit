import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Positive control. This spec sits one directory below the rest of
// tests/, so its read needs one more `../` than a top-level spec's to reach
// the repo root. Without a nested case like this, the recursive,
// depth-agnostic fixture scan in mutation-gate-runtime.spec.ts is
// unfalsifiable: a scan that silently stayed non-recursive, or stayed pinned
// to exactly three `../`, would still pass every other spec's check, because
// none of the other specs read anything from outside the plugin through a
// nested directory.
describe("nested out-of-plugin fixture read (scan control)", () => {
  it("reads CONTRIBUTING.md from the repo root", () => {
    const content = readFileSync(new URL("../../../../CONTRIBUTING.md", import.meta.url), "utf8");
    expect(content).toContain("# Contributing");
  });
});
