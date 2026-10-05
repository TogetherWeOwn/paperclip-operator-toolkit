import { describe, expect, it } from "vitest";

import { diffSnapshot, type AaDiffModelInput } from "../../src/aa-index/diff.js";
import type { AaModelRecord } from "../../src/aa-index/parse.js";

function rec(slug: string, overrides: Partial<AaModelRecord> = {}): AaModelRecord {
  return {
    slug,
    name: null,
    shortName: null,
    modelCreatorName: null,
    deprecated: null,
    isReasoning: null,
    isOpenWeights: null,
    paramClass: null,
    priceClass: null,
    intelligenceIndex: null,
    intelligenceIndexIsEstimated: null,
    intelligenceIndexCostPerTask: null,
    price1mInputTokens: null,
    price1mOutputTokens: null,
    cacheHitPrice: null,
    cacheWritePrice: null,
    medianOutputTokensPerSecond: null,
    outputTokensPerSecondP5: null,
    outputTokensPerSecondP25: null,
    outputTokensPerSecondP75: null,
    outputTokensPerSecondP95: null,
    medianTimeToFirstTokenSeconds: null,
    medianTimeToFirstAnswerTokenSeconds: null,
    medianEndToEndResponseTimeSeconds: null,
    medianReasoningTimeSeconds: null,
    contextWindowTokens: null,
    gpqa: null,
    hle: null,
    critpt: null,
    lcr: null,
    ifbench: null,
    tau2: null,
    terminalbenchHard: null,
    mmmuPro: null,
    gdpvalNormalized: null,
    terminalbenchV21: null,
    tauBanking: null,
    scicode: null,
    terminalbenchV40: null,
    itbenchSre: null,
    analystAgent: null,
    apexAgents: null,
    omniscience: null,
    omniscienceAccuracy: null,
    omniscienceNonHallucination: null,
    ...overrides,
  };
}

function idx(slug: string, intelligenceIndex: number): AaModelRecord {
  return rec(slug, { intelligenceIndex });
}

describe("diffSnapshot", () => {
  it("omits a model with no resolved slug entirely", () => {
    const models: AaDiffModelInput[] = [{ modelId: "unmatched", previousIndex: 30, slug: null }];
    const fresh = new Map([["some-slug", idx("some-slug", 50)]]);
    expect(diffSnapshot(models, fresh)).toEqual([]);
  });

  it("omits a model whose resolved slug is absent from the fresh snapshot", () => {
    const models: AaDiffModelInput[] = [{ modelId: "gone", previousIndex: 30, slug: "vanished-slug" }];
    const fresh = new Map([["other-slug", idx("other-slug", 50)]]);
    expect(diffSnapshot(models, fresh)).toEqual([]);
  });

  it("reports a same-tier wobble as a nonzero delta that does not cross a boundary", () => {
    // 40 and 45 both imply T1 (idx>=40) — a real move, but not tier-relevant.
    const models: AaDiffModelInput[] = [{ modelId: "claude-opus-5", previousIndex: 40, slug: "claude-opus-5" }];
    const fresh = new Map([["claude-opus-5", idx("claude-opus-5", 45)]]);
    const [row] = diffSnapshot(models, fresh);
    expect(row).toMatchObject({
      modelId: "claude-opus-5",
      previousIndex: 40,
      freshIndex: 45,
      delta: 5,
      previousImpliedTier: "T1",
      freshImpliedTier: "T1",
      crossesBoundary: false,
    });
  });

  it("flags a delta that crosses a tier boundary", () => {
    // 39 implies T2 (idx>=34, below the idx=40 T1 bar), 40 implies T1.
    const models: AaDiffModelInput[] = [{ modelId: "claude-opus-5", previousIndex: 39, slug: "claude-opus-5" }];
    const fresh = new Map([["claude-opus-5", idx("claude-opus-5", 40)]]);
    const [row] = diffSnapshot(models, fresh);
    expect(row).toMatchObject({
      previousIndex: 39,
      freshIndex: 40,
      delta: 1,
      previousImpliedTier: "T2",
      freshImpliedTier: "T1",
      crossesBoundary: true,
    });
  });

  it("treats a never-before-set previousIndex as null delta but still reports the fresh implied tier", () => {
    const models: AaDiffModelInput[] = [{ modelId: "new-model", previousIndex: null, slug: "new-slug" }];
    const fresh = new Map([["new-slug", idx("new-slug", 50)]]);
    const [row] = diffSnapshot(models, fresh);
    expect(row).toMatchObject({
      previousIndex: null,
      freshIndex: 50,
      delta: null,
      previousImpliedTier: null,
      freshImpliedTier: "T0",
      // No previous tier to compare against, so implied-tier "changed" from
      // null to T0 — still worth surfacing as a first placement, not silently
      // dropped as "no prior to compare."
      crossesBoundary: true,
    });
  });

  it("reports zero delta and no crossing when nothing moved", () => {
    const models: AaDiffModelInput[] = [{ modelId: "steady", previousIndex: 50, slug: "steady-slug" }];
    const fresh = new Map([["steady-slug", idx("steady-slug", 50)]]);
    const [row] = diffSnapshot(models, fresh);
    expect(row).toMatchObject({ delta: 0, crossesBoundary: false });
  });

  it("processes multiple models independently in the same call", () => {
    const models: AaDiffModelInput[] = [
      { modelId: "a", previousIndex: 39, slug: "a-slug" },
      { modelId: "b", previousIndex: 50, slug: "b-slug" },
      { modelId: "c", previousIndex: 10, slug: null },
    ];
    const fresh = new Map([
      ["a-slug", idx("a-slug", 40)],
      ["b-slug", idx("b-slug", 50)],
    ]);
    const rows = diffSnapshot(models, fresh);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.modelId === "a")!.crossesBoundary).toBe(true);
    expect(rows.find((r) => r.modelId === "b")!.crossesBoundary).toBe(false);
  });

  it("skips a slug whose fresh record has no numeric intelligenceIndex", () => {
    const models: AaDiffModelInput[] = [{ modelId: "sparse", previousIndex: 30, slug: "sparse-slug" }];
    const fresh = new Map([["sparse-slug", rec("sparse-slug", { price1mInputTokens: 2 })]]);
    expect(diffSnapshot(models, fresh)).toEqual([]);
  });

  it("reports every changed numeric field between the previous and fresh snapshot", () => {
    const models: AaDiffModelInput[] = [{ modelId: "m", previousIndex: 40, slug: "m-slug" }];
    const prevRecord = rec("m-slug", { intelligenceIndex: 40, price1mInputTokens: 2, terminalbenchHard: 0.5 });
    const freshRecord = rec("m-slug", { intelligenceIndex: 40, price1mInputTokens: 3, terminalbenchHard: 0.5 });
    const previousBySlug = new Map([["m-slug", prevRecord]]);
    const freshBySlug = new Map([["m-slug", freshRecord]]);
    const [row] = diffSnapshot(models, freshBySlug, previousBySlug);
    expect(row!.fieldDeltas).toEqual([{ field: "price1mInputTokens", previous: 2, fresh: 3, delta: 1 }]);
  });

  it("reports a field newly present in the fresh snapshot with previous null", () => {
    const models: AaDiffModelInput[] = [{ modelId: "m", previousIndex: 40, slug: "m-slug" }];
    const prevRecord = rec("m-slug", { intelligenceIndex: 40 });
    const freshRecord = rec("m-slug", { intelligenceIndex: 40, intelligenceIndexCostPerTask: 0.02 });
    const previousBySlug = new Map([["m-slug", prevRecord]]);
    const freshBySlug = new Map([["m-slug", freshRecord]]);
    const [row] = diffSnapshot(models, freshBySlug, previousBySlug);
    expect(row!.fieldDeltas).toEqual([
      { field: "intelligenceIndexCostPerTask", previous: null, fresh: 0.02, delta: null },
    ]);
  });

  it("reports every non-null fresh field as newly-appeared when there is no previous snapshot at all", () => {
    const models: AaDiffModelInput[] = [{ modelId: "m", previousIndex: 40, slug: "m-slug" }];
    const freshRecord = rec("m-slug", { intelligenceIndex: 40, gpqa: 0.7 });
    const freshBySlug = new Map([["m-slug", freshRecord]]);
    const [row] = diffSnapshot(models, freshBySlug);
    expect(row!.fieldDeltas).toEqual([
      { field: "intelligenceIndex", previous: null, fresh: 40, delta: null },
      { field: "gpqa", previous: null, fresh: 0.7, delta: null },
    ]);
  });
});
