import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bridgeAt,
  classifyModel,
  formatText,
  runCli,
  shadowFiles,
  summarize,
  type BridgeLogLine,
  type ShadowRecord,
} from "../scripts/bridge-agreement.mjs";

/**
 * the agreement script from , productized. The python
 * original was a paste-in; the behaviors worth pinning are the ones that make
 * its number mean something: the join is "last bridge line at or before ts",
 * only `plugin-shadow` records count, and a decision from before the bridge
 * log began is skipped rather than compared with nothing.
 */

const MUSE = "muse-spark-1.3-contributor(xhigh)";
const bridge = (at: string, model: string, reason: string): BridgeLogLine => ({ at, model, reason });
const record = (ts: string, pickedModel: string, extra: Partial<ShadowRecord> = {}): ShadowRecord => ({
  writer: "plugin-shadow",
  tier: "T1",
  ts,
  pickedModel,
  candidates: [
    { model: MUSE, usable: true },
    { model: "claude-sonnet-5-5", usable: true },
    { model: "gpt-6.1-sol", usable: true },
  ],
  ...extra,
});

const LOG: BridgeLogLine[] = [
  bridge("2026-10-04T17:28:00.000000+00:00", MUSE, "meta_weekly_below_98"),
  bridge("2026-10-04T20:37:00.000000+00:00", "claude-sonnet-5-5", "claude_5h_below_98"),
];

describe("classifyModel", () => {
  it.each([
    [MUSE, "MUSE"],
    ["muse-spark-1.3-contributor", "MUSE"],
    ["muse-spark-1.3-contributor-free", "OTHER"],
    ["muse-spark-1.2-contributor", "OTHER"],
    ["claude-sonnet-5-5", "PRIMARY"],
    ["gpt-6.1-sol", "FALLBACK"],
    ["glm-5.3", "OTHER"],
    [null, null],
    [undefined, null],
    ["", null],
  ])("%s -> %s", (model, expected) => {
    expect(classifyModel(model as string | null | undefined)).toBe(expected);
  });
});

describe("bridgeAt", () => {
  it("returns the last line at or before the timestamp", () => {
    expect(bridgeAt(LOG, "2026-10-04T17:27:59.999Z")).toBeNull();
    expect(bridgeAt(LOG, "2026-10-04T17:28:00.500Z")?.reason).toBe("meta_weekly_below_98");
    expect(bridgeAt(LOG, "2026-10-04T20:36:59Z")?.reason).toBe("meta_weekly_below_98");
    expect(bridgeAt(LOG, "2026-10-04T20:37:00Z")?.reason).toBe("claude_5h_below_98");
    expect(bridgeAt(LOG, "2026-10-05T03:00:00Z")?.reason).toBe("claude_5h_below_98");
  });

  it("compares the UTC second, so `Z` and `+00:00` spellings order together", () => {
    expect(bridgeAt([bridge("2026-10-04T10:00:00+00:00", MUSE, "r")], "2026-10-04T10:00:00Z")).not.toBeNull();
  });

  it("is null for an empty log", () => {
    expect(bridgeAt([], "2026-10-04T10:00:00Z")).toBeNull();
  });
});

describe("summarize", () => {
  it("reports 100% when the bridge picks MUSE and 0% once it withdraws MUSE", () => {
    const summary = summarize({
      bridgeLog: LOG,
      records: [
        record("2026-10-04T18:00:00Z", MUSE),
        record("2026-10-04T19:00:00Z", MUSE),
        record("2026-10-04T21:00:00Z", MUSE),
        record("2026-10-04T22:00:00Z", MUSE),
      ],
    });
    expect(summary.records).toBe(4);
    expect(summary.totals).toEqual({ agree: 2, disagree: 2, selOTHER: 0 });
    expect(summary.agreementPct).toBe(50);
    expect(summary.byRegime).toEqual([
      { key: "MUSE/meta_weekly_below_98", n: 2, agree: 2, disagree: 0, selOTHER: 0, agreementPct: 100 },
      { key: "PRIMARY/claude_5h_below_98", n: 2, agree: 0, disagree: 2, selOTHER: 0, agreementPct: 0 },
    ]);
    expect(summary.byHour.map((row) => row.key)).toEqual([
      "2026-10-04T18",
      "2026-10-04T19",
      "2026-10-04T21",
      "2026-10-04T22",
    ]);
  });

  it("books a selector pick outside the three classes as selOTHER, not as disagreement", () => {
    const summary = summarize({ bridgeLog: LOG, records: [record("2026-10-04T18:00:00Z", "glm-5.3")] });
    expect(summary.totals).toEqual({ agree: 0, disagree: 0, selOTHER: 1 });
  });

  it("separates a roster gap from a policy gap with the expressible count", () => {
    const summary = summarize({
      bridgeLog: LOG,
      records: [
        record("2026-10-04T18:00:00Z", MUSE),
        record("2026-10-04T18:01:00Z", "gpt-6.1-sol", { candidates: [{ model: "gpt-6.1-sol", usable: true }] }),
        record("2026-10-04T18:02:00Z", MUSE, { candidates: [{ model: MUSE, usable: false }] }),
      ],
    });
    expect(summary.expressible).toEqual({ bridge_model_usable_candidate: 1, bridge_model_not_candidate: 2 });
    expect(summary.expressiblePct).toBe(33.3);
  });

  it("counts only plugin-shadow records: host records project the same advise() call and prove nothing", () => {
    const summary = summarize({
      bridgeLog: LOG,
      records: [record("2026-10-04T18:00:00Z", MUSE, { writer: "host" }), record("2026-10-04T18:00:00Z", MUSE)],
    });
    expect(summary.records).toBe(1);
    expect(summary.skipped.notShadowWriter).toBe(1);
  });

  it("filters to T1 by default and to every tier on request", () => {
    const records = [record("2026-10-04T18:00:00Z", MUSE), record("2026-10-04T18:01:00Z", MUSE, { tier: "T2" })];
    expect(summarize({ bridgeLog: LOG, records }).records).toBe(1);
    const all = summarize({ bridgeLog: LOG, records, tier: "all" });
    expect(all.records).toBe(2);
    expect(all.byTier.map((row) => row.key)).toEqual(["T1", "T2"]);
  });

  it("skips a decision from before the bridge log began instead of comparing it with nothing", () => {
    const summary = summarize({ bridgeLog: LOG, records: [record("2026-10-04T09:00:00Z", MUSE)] });
    expect(summary.records).toBe(0);
    expect(summary.skipped.beforeBridgeLog).toBe(1);
    expect(summary.agreementPct).toBeNull();
  });

  it("bounds the window with since inclusive and until exclusive", () => {
    const records = [
      record("2026-10-04T18:00:00Z", MUSE),
      record("2026-10-04T19:00:00Z", MUSE),
      record("2026-10-04T20:00:00Z", MUSE),
    ];
    const summary = summarize({ bridgeLog: LOG, records, since: "2026-10-04T19:00:00Z", until: "2026-10-04T20:00:00Z" });
    expect(summary.records).toBe(1);
    expect(summary.skipped.outsideWindow).toBe(2);
  });
});

describe("command line", () => {
  let dir: string;
  const sink = () => {
    let text = "";
    return { write: (chunk: string) => { text += chunk; }, text: () => text };
  };
  const jsonl = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridge-agreement-"));
    await writeFile(join(dir, "bridge.log"), jsonl(LOG));
    await writeFile(
      join(dir, "decisions-2026-10-04-18Z.jsonl"),
      `${jsonl([record("2026-10-04T18:00:00Z", MUSE), { ...record("2026-10-04T18:01:00Z", MUSE), writer: "host" }])}{not json "plugin-shadow"\n`,
    );
    await writeFile(join(dir, "decisions-2026-10-04-21Z.jsonl"), jsonl([record("2026-10-04T21:00:00Z", MUSE)]));
    await writeFile(join(dir, "decisions.jsonl"), jsonl([record("2026-10-04T17:30:00Z", MUSE)]));
    await writeFile(join(dir, "notes.txt"), "not a decision file");
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const args = (...extra: string[]) => ["--shadow-dir", dir, "--bridge-log", join(dir, "bridge.log"), ...extra];

  it("lists the hourly files, and the legacy file only on request", async () => {
    expect((await shadowFiles(dir, false)).map((file) => file.split("/").pop())).toEqual([
      "decisions-2026-10-04-18Z.jsonl",
      "decisions-2026-10-04-21Z.jsonl",
    ]);
    expect((await shadowFiles(dir, true)).map((file) => file.split("/").pop())[0]).toBe("decisions.jsonl");
  });

  it("prints the regime table and tolerates a torn line", async () => {
    const stdout = sink();
    expect(await runCli(args("--json"), { stdout, stderr: sink() })).toBe(0);
    const summary = JSON.parse(stdout.text());
    expect(summary.records).toBe(2);
    expect(summary.totals).toEqual({ agree: 1, disagree: 1, selOTHER: 0 });
    expect(summary.inputs).toMatchObject({ decisionFiles: 2, bridgeLines: 2, malformedShadowLines: 1, malformedBridgeLines: 0 });
  });

  it("reads the legacy file under --include-legacy", async () => {
    const stdout = sink();
    await runCli(args("--json", "--include-legacy"), { stdout, stderr: sink() });
    expect(JSON.parse(stdout.text()).records).toBe(3);
  });

  it("renders text with the headline, the expressible line and every section", async () => {
    const stdout = sink();
    expect(await runCli(args(), { stdout, stderr: sink() })).toBe(0);
    const text = stdout.text();
    expect(text).toContain("tier T1: 2 records, agreement 50%");
    expect(text).toContain("expressible: bridge model among usable candidates in 2/2");
    for (const heading of ["by bridge regime", "by tier", "by hour (UTC)"]) expect(text).toContain(heading);
    expect(text).toContain("MUSE/meta_weekly_below_98");
    expect(formatText).toBeTypeOf("function");
  });

  it("uses MODEL_SELECTION_SHADOW_DIR when no directory flag is given", async () => {
    const stdout = sink();
    const code = await runCli(["--bridge-log", join(dir, "bridge.log"), "--json"], {
      stdout,
      stderr: sink(),
      env: { MODEL_SELECTION_SHADOW_DIR: dir },
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout.text()).records).toBe(2);
  });

  it.each([
    ["no directory anywhere", ["--bridge-log", "x"], "no shadow directory"],
    ["an unknown flag", ["--nope"], "unknown argument --nope"],
    ["a flag missing its value", ["--tier"], "--tier needs a value"],
    ["a bad timestamp", ["--since", "yesterday"], "--since is not a timestamp"],
  ])("exits 2 for %s", async (_name, argv, message) => {
    const stderr = sink();
    expect(await runCli(argv, { stdout: sink(), stderr, env: {} })).toBe(2);
    expect(stderr.text()).toContain(message);
  });

  it("exits 2 when an input is unreadable or empty, rather than printing a clean-looking zero", async () => {
    const missing = sink();
    expect(await runCli(["--shadow-dir", dir, "--bridge-log", join(dir, "absent.log")], { stdout: sink(), stderr: missing })).toBe(2);
    expect(missing.text()).toContain("cannot read input");

    await writeFile(join(dir, "empty.log"), "");
    const empty = sink();
    expect(await runCli(["--shadow-dir", dir, "--bridge-log", join(dir, "empty.log")], { stdout: sink(), stderr: empty })).toBe(2);
    expect(empty.text()).toContain("no readable lines");
  });

  it("prints usage for --help and exits 0", async () => {
    const stdout = sink();
    expect(await runCli(["--help"], { stdout, stderr: sink() })).toBe(0);
    expect(stdout.text()).toContain("usage: bridge-agreement.mjs");
  });
});
