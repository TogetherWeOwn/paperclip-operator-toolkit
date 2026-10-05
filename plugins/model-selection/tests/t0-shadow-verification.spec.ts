import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { evaluateT0Shadow } from "../scripts/verify-t0-shadow.mjs";
import { buildShadowRecord } from "../src/shadow-emit.js";
import { selectModel } from "../src/engine/select.js";
import type { IssueDescriptor, ModelEntry } from "../src/engine/types.js";
import { FRESH, MODELS, NO_ESCALATION, NOW, PROFILES, config } from "./fixtures.js";

/**
 *  step 3/5. The verifier greps the decision stream for the engine's
 * own trace lines, so these tests build the records with the REAL selector and
 * the REAL record builder — rewording a trace line breaks them, instead of
 * silently turning the verifier vacuous.
 */

const NOW_ISO = new Date(NOW).toISOString();
const T0_ID = "claude-opus-5-5";
const T0_ROW: ModelEntry = {
  ...MODELS.find((entry) => entry.tier === "T1")!,
  id: T0_ID,
  tier: "T0",
  laneId: "lane-t0",
  costPerMTokIn: 1,
  costPerMTokOut: 5,
};
const ROSTER = [...MODELS.map((model) => ({ ...model, laneId: "lane-a" })), T0_ROW];
const PROFILES_T0 = [
  ...PROFILES,
  { tier: "T0" as const, sampleCount: 40, computedAt: FRESH, avgInputTokens: 510_327, avgCacheReadTokens: 6_081_872, avgOutputTokens: 55_532 },
];

function record(descriptor: IssueDescriptor, models: readonly ModelEntry[] = ROSTER): string {
  const decision = selectModel({
    profiles: PROFILES_T0,
    signals: NO_ESCALATION,
    now: NOW,
    descriptor,
    config: config({ models: [...models] }),
  });
  return JSON.stringify(
    buildShadowRecord({
      issueId: descriptor.issueId,
      issueIdentifier: descriptor.issueId.toUpperCase(),
      nowIso: NOW_ISO,
      decision,
      descriptor,
      status: "todo",
      hasOverride: false,
      hasOperatorPin: false,
      isIdle: true,
      models,
      laneLedger: {},
      slotFloorFraction: 0.25,
      windowNames: { weekly: "weekly", fiveHour: "five_hour" },
      operatorOverride: null,
    }),
  );
}

const ordinary = (n: number) => record({ issueId: `i${n}`, labelNames: ["tier:T1"] });

describe("evaluateT0Shadow", () => {
  it("verifies a stream of ordinary decisions that never touched the T0 row", () => {
    const lines = Array.from({ length: 5 }, (_, n) => ordinary(n));
    const result = evaluateT0Shadow(lines, { t0Ids: [T0_ID], minDecisions: 5 });
    expect(result.verdict).toBe("verified");
    expect(result.violations).toEqual([]);
    expect(result.ceilingMarkerDecisions).toBe(5);
  });

  it("accepts an explicit tier:T0 opt-in that picks the T0 row", () => {
    const optIn = record({ issueId: "t0", labelNames: ["tier:T0"] });
    expect(JSON.parse(optIn).pickedModel).toBe(T0_ID);
    const result = evaluateT0Shadow([optIn, ...Array.from({ length: 4 }, (_, n) => ordinary(n))], { t0Ids: [T0_ID], minDecisions: 5 });
    expect(result.verdict).toBe("verified");
    expect(result.optedInT0Decisions).toBe(1);
  });

  it("flags a non-opt-in decision that picked a T0 row (positive control: the ceiling mutated away)", () => {
    // The shadow stream a build WITHOUT the ceiling would write: a T1 card whose
    // pick is the T0 row and whose judgement says T1.
    const leaked = JSON.stringify({ ...JSON.parse(ordinary(0)), pickedModel: T0_ID, issueIdentifier: "TOG-LEAK" });
    const result = evaluateT0Shadow([leaked, ...Array.from({ length: 4 }, (_, n) => ordinary(n))], { t0Ids: [T0_ID], minDecisions: 5 });
    expect(result.verdict).toBe("violations");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ issue: "TOG-LEAK", pickedModel: T0_ID });
  });

  it("flags a non-opt-in decision that merely costed a T0 candidate", () => {
    const base = JSON.parse(ordinary(0));
    const costed = JSON.stringify({
      ...base,
      candidates: [...base.candidates, { model: T0_ID, lane: "lane-t0", tier: "T0", capable: true, proven: true, usable: true, blended: 3 }],
    });
    const result = evaluateT0Shadow([costed], { t0Ids: [T0_ID], minDecisions: 1 });
    expect(result.verdict).toBe("violations");
    expect(result.violations[0]!.t0Candidates).toEqual([T0_ID]);
  });

  it("is INSUFFICIENT with too few decisions", () => {
    const result = evaluateT0Shadow([ordinary(0)], { t0Ids: [T0_ID], minDecisions: 50 });
    expect(result.verdict).toBe("insufficient-evidence");
  });

  it("is INSUFFICIENT when no decision carries the ceiling marker — a clean count would be vacuous", () => {
    // A roster with no T0 row emits no marker: the stream says nothing about T0.
    const lines = Array.from({ length: 5 }, (_, n) => record({ issueId: `i${n}`, labelNames: ["tier:T1"] }, MODELS));
    const result = evaluateT0Shadow(lines, { t0Ids: [T0_ID], minDecisions: 5 });
    expect(result.ceilingMarkerDecisions).toBe(0);
    expect(result.verdict).toBe("insufficient-evidence");
  });

  it("counts malformed lines instead of dropping them silently", () => {
    const result = evaluateT0Shadow(["not json", "{}", ordinary(0)], { t0Ids: [T0_ID], minDecisions: 1 });
    expect(result.malformed).toBe(2);
    expect(result.decisions).toBe(1);
  });
});

describe("verify-t0-shadow CLI", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  function run(lines: string[], extra: string[] = []) {
    const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? process.cwd();
    const dir = mkdtempSync(join(root, "t0-shadow-test-"));
    directories.push(dir);
    const input = join(dir, "decisions.jsonl");
    writeFileSync(input, `${lines.join("\n")}\n`);
    const out = join(dir, "result.json");
    const result = spawnSync(
      process.execPath,
      [new URL("../scripts/verify-t0-shadow.mjs", import.meta.url).pathname, "--input", input, "--t0-ids", T0_ID, "--out", out, ...extra],
      { encoding: "utf8", timeout: 10_000 },
    );
    return { result, out };
  }

  it("exits 0 and records the result when verified", () => {
    const { result, out } = run(Array.from({ length: 3 }, (_, n) => ordinary(n)), ["--min-decisions", "3"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).verdict).toBe("verified");
  });

  it("exits 1 on a violation", () => {
    const leaked = JSON.stringify({ ...JSON.parse(ordinary(0)), pickedModel: T0_ID });
    const { result } = run([leaked, ordinary(1), ordinary(2)], ["--min-decisions", "3"]);
    expect(result.status).toBe(1);
  });

  it("exits 2 on insufficient evidence", () => {
    const { result } = run([ordinary(0)], ["--min-decisions", "10"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("insufficient-evidence");
  });
});
