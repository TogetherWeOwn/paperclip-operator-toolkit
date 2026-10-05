import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// : the offline bridge-vs-selector probe. Fixture matrix in, the
// pre-registered  predicate judges, per-minute report out. No live
// lanes, no roster rows, no wiring — so this spec pins the full verdict
// spread the matrix was built to exercise.
const probe = new URL("../scripts/bridge-selector-agreement-probe.py", import.meta.url).pathname;
const matrix = new URL("./fixtures/bridge-selector-agreement-matrix.json", import.meta.url).pathname;
const gate = new URL("../../../ops/gate_harness.py", import.meta.url).pathname;

// Remove every scratch dir when the file finishes; unremoved they pile up in
// the shared runner /tmp.
const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function runProbe() {
  const dir = mkdtempSync(join(tmpdir(), "ex-14134-probe-test-"));
  scratchDirs.push(dir);
  const out = join(dir, "report.json");
  const result = spawnSync("python3", [probe, "--matrix", matrix, "--gate-harness", gate, "--out", out], {
    encoding: "utf8",
  });
  const report = result.status === 0 ? JSON.parse(readFileSync(out, "utf8")) : null;
  return { ...result, report };
}

describe("bridge-vs-selector agreement probe", () => {
  it("runs offline over the 8-minute fixture matrix and reports every verdict path", () => {
    const result = runProbe();
    expect(result.status).toBe(0);
    expect(result.report).toMatchObject({
      schema: "bridge-selector-report-v1",
      offline: true,
      denominators: {
        minutes: 8,
        hostRecords: 8,
        shadowRecords: 8,
        comparablePairs: 7,
        nonComparable: 2,
      },
      agreementTable: {
        "agree/-": 3,
        "defect/DF-1": 1,
        "pace-intended/PI-1": 1,
        "stale-agreement/DF-2*": 1,
        "unexplained/-": 1,
      },
    });
    expect(result.report.minutes.map((row: { verdict: string }) => row.verdict)).toEqual([
      "agree",
      "agree",
      "agree",
      "pace-intended",
      "defect",
      "unexplained",
      "stale-agreement",
      "non-comparable",
    ]);
  });

  it("covers all three bridge models through the epic's bridge vocabulary", () => {
    const result = runProbe();
    expect(result.status).toBe(0);
    expect(result.report.minutes.map((row: { bridgeModel: string }) => row.bridgeModel)).toContain(
      "muse-spark-1.3-contributor",
    );
    expect(result.report.minutes.map((row: { bridgeModel: string }) => row.bridgeModel)).toContain(
      "claude-sonnet-5-5",
    );
    expect(result.report.minutes.map((row: { bridgeModel: string }) => row.bridgeModel)).toContain("gpt-6.1-sol");
    expect(new Set(result.report.minutes.map((row: { bridge: string }) => row.bridge))).toEqual(
      new Set(["MUSE", "PRIMARY", "FALLBACK"]),
    );
  });

  it("refuses a missing matrix instead of reporting an empty agreement", () => {
    const result = spawnSync("python3", [probe, "--matrix", join(tmpdir(), "ex-14134-no-such-matrix.json")], {
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ERROR/);
  });
});
