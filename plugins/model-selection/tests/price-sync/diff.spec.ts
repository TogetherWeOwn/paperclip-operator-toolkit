import { describe, expect, it } from "vitest";

import { reconcilePrices, type PriceRosterRow } from "../../src/price-sync/diff.js";
import { parsePriceCatalog, type PriceCatalog } from "../../src/price-sync/parse.js";

const FETCHED_AT = "2026-09-22T05:41:00.000Z";

/** The real 2026-09-22 feed values for the models the audit named. */
const CATALOG: PriceCatalog = parsePriceCatalog(
  JSON.stringify({
    anthropic: { models: { "claude-sonnet-5": { cost: { input: 2, output: 10, cache_read: 0.2 } } } },
    openai: { models: { "gpt-5.5": { cost: { input: 5, output: 30, cache_read: 0.5 } } } },
    meta: {
      models: {
        "muse-spark-1.3": { cost: { input: 1.25, output: 4.25, cache_read: 0.15 } },
        "muse-spark-1.3-contributor": { cost: { input: 0.1, output: 0.2, cache_read: 0.002 } },
      },
    },
    zhipuai: { models: { "glm-4.5v": { cost: { input: 0.6, output: 1.8 } }, "glm-5.3": {} } },
  }),
)!;

function row(overrides: Partial<PriceRosterRow> & Pick<PriceRosterRow, "id">): PriceRosterRow {
  return {
    laneId: null,
    enabled: true,
    costPerMTokIn: 0,
    costPerMTokOut: 0,
    costPerMTokCacheRead: 0,
    ...overrides,
  };
}

function reconcile(rows: PriceRosterRow[]) {
  return reconcilePrices({ rows, catalog: CATALOG, fetchedAt: FETCHED_AT });
}

describe("reconcilePrices", () => {
  it("reports a correctly-priced row as unchanged, with no drift", () => {
    const report = reconcile([
      row({
        id: "cliproxy/claude-sonnet-5",
        laneId: "cliproxy-claude",
        costPerMTokIn: 2,
        costPerMTokOut: 10,
        costPerMTokCacheRead: 0.2,
      }),
    ]);
    expect(report).toMatchObject({ checked: 1, unchanged: 1 });
    expect(report.drift).toEqual([]);
  });

  // The exact row the 2026-09-22 audit found: roster 3/15/0.3 vs real 2/10/0.2.
  it("reports every drifting field with the direction and magnitude", () => {
    const report = reconcile([
      row({
        id: "cliproxy/claude-sonnet-5",
        laneId: "cliproxy-claude",
        costPerMTokIn: 3,
        costPerMTokOut: 15,
        costPerMTokCacheRead: 0.3,
      }),
    ]);
    expect(report.drift).toHaveLength(1);
    expect(report.drift[0]).toMatchObject({
      modelId: "cliproxy/claude-sonnet-5",
      providerId: "anthropic",
      bareId: "claude-sonnet-5",
      severity: "overstated",
    });
    expect(report.drift[0]!.fields).toEqual([
      { field: "costPerMTokIn", roster: 3, feed: 2, ratio: 2 / 3 },
      { field: "costPerMTokOut", roster: 15, feed: 10, ratio: 10 / 15 },
      { field: "costPerMTokCacheRead", roster: 0.3, feed: 0.2, ratio: 0.2 / 0.3 },
    ]);
  });

  // gpt-5.5 carried 1.5/7.5/0.15 against a real 5/30/0.5 — a 3.3x
  // understatement, the direction that actually costs money.
  it("calls an understated row understated", () => {
    const report = reconcile([
      row({
        id: "gpt-5.5",
        laneId: "cliproxy-codex",
        costPerMTokIn: 1.5,
        costPerMTokOut: 7.5,
        costPerMTokCacheRead: 0.15,
      }),
    ]);
    expect(report.drift[0]!.severity).toBe("understated");
    expect(report.drift[0]!.maxRatio).toBeCloseTo(30 / 7.5, 10);
  });

  // The muse-spark class. A 0 cost term is identically 0 at every volume, so
  // the row wins every cost comparison it enters — a different failure from
  // any finite misprice, and it outranks all of them.
  it("ranks a zero-priced row above every finite misprice", () => {
    const report = reconcile([
      row({ id: "gpt-5.5", laneId: "cliproxy-codex", costPerMTokIn: 1.5, costPerMTokOut: 7.5, costPerMTokCacheRead: 0.15 }),
      row({ id: "muse-spark-1.3", laneId: "cliproxy-meta" }),
    ]);
    expect(report.drift.map((d) => d.modelId)).toEqual(["muse-spark-1.3", "gpt-5.5"]);
    expect(report.drift[0]).toMatchObject({ severity: "zero-priced", maxRatio: null });
    expect(report.drift[0]!.fields.every((f) => f.ratio === null)).toBe(true);
  });

  it("puts an enabled row ahead of a disabled one at the same severity", () => {
    const report = reconcile([
      row({ id: "muse-spark-1.3-contributor", laneId: "cliproxy-meta", enabled: false }),
      row({ id: "muse-spark-1.3", laneId: "cliproxy-meta", enabled: true }),
    ]);
    expect(report.drift.map((d) => d.modelId)).toEqual(["muse-spark-1.3", "muse-spark-1.3-contributor"]);
  });

  // Prices round-trip through JSON and config storage; an exact !== would
  // report a 1e-16 difference as industry price drift.
  it("does not report float round-trip noise as drift", () => {
    const report = reconcile([
      row({
        id: "cliproxy/claude-sonnet-5",
        laneId: "cliproxy-claude",
        costPerMTokIn: 2 + 1e-15,
        costPerMTokOut: 10,
        costPerMTokCacheRead: 0.1 + 0.1,
      }),
    ]);
    expect(report.drift).toEqual([]);
    expect(report.unchanged).toBe(1);
  });

  // zhipuai publishes no cache rate for glm-4.5v. Comparing against an
  // implied 0 would manufacture a finding on a correctly-priced row.
  it("skips a field the provider does not publish instead of comparing it to zero", () => {
    const report = reconcile([
      row({
        id: "glm-4.5v",
        laneId: "cliproxy-zai",
        costPerMTokIn: 0.6,
        costPerMTokOut: 1.8,
        costPerMTokCacheRead: 0.12,
      }),
    ]);
    expect(report.drift).toEqual([]);
    expect(report.unchanged).toBe(1);
  });

  it("still reports the published fields of a partially-published model", () => {
    const report = reconcile([
      row({ id: "glm-4.5v", laneId: "cliproxy-zai", costPerMTokIn: 9, costPerMTokOut: 1.8, costPerMTokCacheRead: 0.12 }),
    ]);
    expect(report.drift[0]!.fields.map((f) => f.field)).toEqual(["costPerMTokIn"]);
  });

  // "Present but unpriced" is its own outcome: it is not drift and it is not
  // absence, and it must not be counted as a checked, correct row.
  it("reports a model with no cost block at all as unpriced-in-feed", () => {
    const report = reconcile([row({ id: "glm-5.3", laneId: "cliproxy-zai", costPerMTokIn: 1 })]);
    expect(report.checked).toBe(0);
    expect(report.unresolved).toEqual([
      { modelId: "glm-5.3", kind: "unpriced-in-feed", detail: expect.stringContaining("no cost block") },
    ]);
  });

  it("routes each non-match to its own named unresolved kind", () => {
    const report = reconcile([
      row({ id: "claude-sonnet-5", laneId: null }),
      row({ id: "claude-sonnet-5", laneId: "cliproxy-unknown" }),
      row({ id: "claude-sonnet-99", laneId: "cliproxy-claude" }),
    ]);
    expect(report.unresolved.map((u) => u.kind)).toEqual(["no-lane", "unmapped-lane", "absent-from-feed"]);
    expect(report.drift).toEqual([]);
    expect(report.checked).toBe(0);
  });

  it.each(["free Zen model", "NO GO QUOTA"])("excludes a non-suffixed free row marked %s before lane lookup", (note) => {
    const report = reconcile([
      row({ id: "big-pickle", laneId: "cliproxy-zen", note }),
      row({ id: "muse-spark-1.3", laneId: "cliproxy-meta" }),
      row({ id: "unknown-zen-model", laneId: "cliproxy-zen" }),
    ]);
    expect(report.excluded).toEqual([{ modelId: "big-pickle", reason: "free-tier" }]);
    expect(report.drift.map((d) => d.modelId)).toEqual(["muse-spark-1.3"]);
    expect(report.unresolved.map((u) => u.modelId)).toEqual(["unknown-zen-model"]);
    expect(report.checked).toBe(1);
  });

  it("keeps unbounded overstatements JSON-safe and sorts ties by model id", () => {
    const catalog = parsePriceCatalog(JSON.stringify({
      meta: { models: {
        "z-zero": { cost: { input: 0 } },
        "a-zero": { cost: { input: 0 } },
        finite: { cost: { input: 1 } },
      } },
    }))!;
    const report = reconcilePrices({
      rows: ["finite", "z-zero", "a-zero"].map((id) =>
        row({ id, laneId: "cliproxy-meta", costPerMTokIn: 2 })),
      catalog,
      fetchedAt: FETCHED_AT,
    });
    expect(report.drift.map((d) => d.modelId)).toEqual(["a-zero", "z-zero", "finite"]);
    expect(report.drift.map((d) => d.maxRatio)).toEqual([null, null, 2]);
    expect(report.drift.every((d) => d.severity === "overstated")).toBe(true);
    expect(report.drift[0]!.fields[0]!.ratio).toBe(0);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("excludes the policy classes without checking them", () => {
    const report = reconcile([
      row({ id: "devin/devin-1", laneId: "cliproxy-claude" }),
      row({ id: "muse-spark-1.3-contributor-free", laneId: "cliproxy-meta" }),
      row({ id: "cliproxy/claude-opus-4-20250514", laneId: "cliproxy-claude", costPerMTokIn: 15 }),
      row({ id: "gpt-image-2", laneId: "cliproxy-codex" }),
    ]);
    expect(report.excluded.map((e) => e.reason)).toEqual([
      "metered-not-per-token",
      "free-tier",
      "retired-verified",
      "per-image",
    ]);
    expect(report.drift).toEqual([]);
    expect(report.unresolved).toEqual([]);
    expect(report.checked).toBe(0);
  });

  // The invariant the whole report shape exists to hold: a row that quietly
  // matched nothing and was never mentioned is the failure being prevented.
  it("accounts for every row in exactly one bucket", () => {
    const rows = [
      row({ id: "cliproxy/claude-sonnet-5", laneId: "cliproxy-claude", costPerMTokIn: 2, costPerMTokOut: 10, costPerMTokCacheRead: 0.2 }),
      row({ id: "muse-spark-1.3", laneId: "cliproxy-meta" }),
      row({ id: "devin/devin-1", laneId: "cliproxy-claude" }),
      row({ id: "claude-sonnet-99", laneId: "cliproxy-claude" }),
      row({ id: "orphan", laneId: null }),
    ];
    const report = reconcile(rows);
    expect(report.unchanged + report.drift.length + report.excluded.length + report.unresolved.length).toBe(rows.length);
    expect(report.checked).toBe(report.unchanged + report.drift.length);
  });

  it("stamps the report with the fetch timestamp it was derived from", () => {
    expect(reconcile([]).fetchedAt).toBe(FETCHED_AT);
  });

  // Requirement 5: record the source and fetch date. Emitted, not written —
  // this job reports and an operator applies.
  it("suggests a dated, sourced note clause naming the provider and the list-price caveat", () => {
    const report = reconcile([
      row({ id: "muse-spark-1.3", laneId: "cliproxy-meta" }),
    ]);
    const note = report.drift[0]!.suggestedNote;
    expect(note).toContain("2026-09-22 models.dev price reconciliation");
    expect(note).toContain("source: https://models.dev/api.json");
    expect(note).toContain("provider meta");
    expect(note).toContain("in 0 → 1.25, out 0 → 4.25, cache read 0 → 0.15");
    expect(note).toContain("not what we actually pay on a flat plan");
  });
});
