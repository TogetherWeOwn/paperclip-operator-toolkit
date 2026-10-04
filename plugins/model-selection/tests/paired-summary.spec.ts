import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const script = new URL("../scripts/summarize-paired-decisions.mjs", import.meta.url).pathname;
const gate = new URL("../../../ops/tog-2138/gate_harness.py", import.meta.url).pathname;
const start = "2026-09-14T00:00:00Z";
const end = "2026-09-15T00:00:00Z";

function record(writer: "host" | "plugin-shadow", overrides: Record<string, unknown> = {}) {
  return {
    schema: "tog2138-decision-v1",
    writer,
    issueId: "issue-1",
    issueIdentifier: "TOG-1",
    ts: "2026-09-14T12:00:00Z",
    trigger: "new-card",
    tier: "T2",
    pickedModel: "claude-sonnet-5",
    keptPin: null,
    stateFingerprint: { status: "todo", hadOverride: false, hadRunningRun: false, pinOperator: false },
    laneSnapshot: {
      ageSeconds: 0,
      quality: "live",
      laneFetchErrors: [],
      lanes: { claude: { weekly: 0.2, fiveHour: 0.2, state: "available", paceDeviation: 0 } },
    },
    candidates: [
      { model: "claude-sonnet-5", lane: "claude", tier: "T2", capable: true, proven: true, usable: true, blended: 3 },
    ],
    explanations: [],
    operatorOverride: null,
    pickWhy: "test",
    ...overrides,
  };
}

// Remove every scratch dir when the file finishes; unremoved they pile up in the
// shared runner /tmp (TOG-12483).
const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "tog2504-summary-test-"));
  scratchDirs.push(dir);
  return dir;
}

function run(lines: unknown[]) {
  const dir = scratch();
  const input = join(dir, "decisions.jsonl");
  const out = join(dir, "summary.json");
  writeFileSync(input, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n");
  const result = spawnSync(process.execPath, [script, "--input", input, "--start", start, "--end", end, "--gate-harness", gate, "--out", out], {
    encoding: "utf8",
  });
  const report = result.status === null || !result.stdout.trim() ? null : JSON.parse(result.stdout);
  return { ...result, report, out };
}

// TOG-13566: --input also accepts a directory of UTC-hour shards.
function runShardDir(files: Record<string, unknown[]>) {
  const dir = scratch();
  const shards = join(dir, "shards");
  mkdirSync(shards);
  for (const [name, lines] of Object.entries(files)) {
    writeFileSync(join(shards, name), lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n");
  }
  const result = spawnSync(process.execPath, [script, "--input", shards, "--start", start, "--end", end, "--gate-harness", gate], {
    encoding: "utf8",
  });
  const report = result.status === null || !result.stdout.trim() ? null : JSON.parse(result.stdout);
  return { ...result, report };
}

// Public tree has no ops/ gate harness (stays private): skip the block
// rather than failing it. Upstream runs these; the seed adapted them.
describe.skipIf(!existsSync(gate))("bounded paired decision summary", () => {
  it("accepts one correlated pair without claiming the 48h clean window", () => {
    const result = run([record("host"), record("plugin-shadow")]);
    expect(result.status).toBe(0);
    expect(result.report).toMatchObject({
      dataGap: false,
      cleanWindowGateEvaluated: false,
      denominators: { hostRecords: 1, shadowRecords: 1, comparablePairs: 1, nonComparable: 0 },
      observationStart: "2026-09-14T12:00:00.000Z",
    });
    expect(result.report.fullCleanWindowGateExit).not.toBe(0);
    expect(JSON.parse(readFileSync(result.out, "utf8"))).toEqual(result.report);
  });

  it("refuses a missing writer as a data gap", () => {
    const result = run([record("plugin-shadow")]);
    expect(result.status).toBe(1);
    expect(result.report).toMatchObject({ dataGap: true, denominators: { hostRecords: 0, shadowRecords: 1, comparablePairs: 0 } });
  });

  it("refuses an unpaired fingerprint as a data gap", () => {
    const result = run([
      record("host"),
      record("plugin-shadow", { stateFingerprint: { status: "in_progress", hadOverride: false, hadRunningRun: false, pinOperator: false } }),
    ]);
    expect(result.status).toBe(1);
    expect(result.report).toMatchObject({ dataGap: true, denominators: { comparablePairs: 0, nonComparable: 2 } });
  });

  it("reads a correlated pair split across hourly shards", () => {
    const result = runShardDir({
      "decisions-2026-09-14-12Z.jsonl": [record("host")],
      "decisions-2026-09-14-13Z.jsonl": [record("plugin-shadow")],
      "notes.txt": ["not a shard and must be ignored"],
    });
    expect(result.status).toBe(0);
    expect(result.report).toMatchObject({
      dataGap: false,
      denominators: { hostRecords: 1, shadowRecords: 1, comparablePairs: 1, nonComparable: 0 },
    });
  });

  it("refuses a shard directory with no shard files", () => {
    const result = runShardDir({ "notes.txt": ["junk"] });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no shadow shards/);
  });

  it("refuses intervals longer than 24 hours", () => {
    const dir = scratch();
    const input = join(dir, "decisions.jsonl");
    writeFileSync(input, `${JSON.stringify(record("host"))}\n${JSON.stringify(record("plugin-shadow"))}\n`);
    expect(() => execFileSync(process.execPath, [script, "--input", input, "--start", start, "--end", "2026-09-15T00:00:01Z", "--gate-harness", gate])).toThrow();
  });
});
