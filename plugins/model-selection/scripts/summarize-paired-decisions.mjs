#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fail(message) {
  console.error(`DATA GAP: ${message}`);
  process.exit(1);
}

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) fail(`${name} is required`);
  return process.argv[index + 1];
}

function parseUtc(value, name) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || !/(Z|[+-]\d\d:\d\d)$/.test(value)) fail(`${name} must be an ISO-8601 timestamp with timezone`);
  return ms;
}

const inputPath = arg("--input");
const startText = arg("--start");
const endText = arg("--end");
const outIndex = process.argv.indexOf("--out");
const outPath = outIndex >= 0 ? process.argv[outIndex + 1] : null;
const gatePath = arg("--gate-harness");
const reportSchema = process.argv.includes("--report-schema") ? arg("--report-schema") : "paired-decision-summary-v2";
if (reportSchema.length > 80 || !/^[a-z0-9][a-z0-9._:-]*-v2$/.test(reportSchema)) {
  fail("--report-schema must be an exact v2 identifier");
}
const startMs = parseUtc(startText, "--start");
const endMs = parseUtc(endText, "--end");
if (endMs <= startMs) fail("--end must be later than --start");
if (endMs - startMs > 24 * 60 * 60 * 1000) fail("interval must be no longer than 24 hours");

/**
 * `--input` accepts a single JSONL file (legacy `decisions.jsonl`)
 * or a directory of UTC-hour shards (`decisions-YYYY-MM-DD-HHZ.jsonl`). A
 * directory reads every matching shard in lexical (= chronological) order and
 * concatenates their lines; non-shard files are ignored.
 */
const SHARD_FILE_PATTERN = /^decisions-\d{4}-\d{2}-\d{2}-\d{2}Z\.jsonl$/;
let source;
try {
  const inputStat = await stat(inputPath);
  if (inputStat.isDirectory()) {
    const names = (await readdir(inputPath)).filter((name) => SHARD_FILE_PATTERN.test(name)).sort();
    if (names.length === 0) fail(`no shadow shards (decisions-YYYY-MM-DD-HHZ.jsonl) in ${inputPath}`);
    const parts = [];
    for (const name of names) parts.push(await readFile(join(inputPath, name), "utf8"));
    source = parts.join("");
    if (!source.endsWith("\n")) source += "\n";
  } else {
    source = await readFile(inputPath, "utf8");
  }
  await readFile(gatePath, "utf8");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const host = [];
const shadow = [];
const malformed = [];
for (const [index, line] of source.split("\n").entries()) {
  if (!line.trim()) continue;
  try {
    const record = JSON.parse(line);
    const ts = parseUtc(String(record.ts ?? ""), `line ${index + 1} ts`);
    if (ts < startMs || ts >= endMs) continue;
    if (record.writer === "host") host.push(record);
    else if (record.writer === "plugin-shadow") shadow.push(record);
    else malformed.push({ line: index + 1, error: `invalid writer ${JSON.stringify(record.writer)}` });
  } catch (error) {
    malformed.push({ line: index + 1, error: error instanceof Error ? error.message : String(error) });
  }
}

const scratch = await mkdtemp(join(tmpdir(), "paired-summary-"));
try {
  const hostPath = join(scratch, "host.jsonl");
  const shadowPath = join(scratch, "shadow.jsonl");
  const reportPath = join(scratch, "agreement.json");
  await writeFile(hostPath, host.map((record) => JSON.stringify(record)).join("\n") + (host.length ? "\n" : ""));
  await writeFile(shadowPath, shadow.map((record) => JSON.stringify(record)).join("\n") + (shadow.length ? "\n" : ""));
  const run = spawnSync("python3", [gatePath, "agreement", "--host", hostPath, "--shadow", shadowPath, "--out", reportPath], {
    encoding: "utf8",
  });
  let agreement;
  try {
    agreement = JSON.parse(await readFile(reportPath, "utf8"));
  } catch {
    fail(`agreement harness produced no readable report (exit ${run.status ?? "unknown"}): ${run.stderr || run.stdout}`);
  }

  const denominators = agreement.denominators ?? {};
  const dataGap =
    malformed.length > 0 ||
    Number(denominators.hostRecords ?? 0) === 0 ||
    Number(denominators.shadowRecords ?? 0) === 0 ||
    Number(denominators.comparablePairs ?? 0) === 0 ||
    Number(denominators.nonComparable ?? 0) > 0 ||
    Number(denominators.malformed?.host ?? 0) > 0 ||
    Number(denominators.malformed?.shadow ?? 0) > 0;

  const pairedTimestamps = [];
  if (!dataGap) {
    const unusedShadow = new Set(shadow.map((_, index) => index));
    for (const hostRecord of host) {
      let bestIndex = null;
      let bestDelta = null;
      for (const shadowIndex of unusedShadow) {
        const shadowRecord = shadow[shadowIndex];
        if (hostRecord.issueId !== shadowRecord.issueId || hostRecord.tier !== shadowRecord.tier) continue;
        if (JSON.stringify(hostRecord.stateFingerprint) !== JSON.stringify(shadowRecord.stateFingerprint)) continue;
        const delta = Math.abs(Date.parse(hostRecord.ts) - Date.parse(shadowRecord.ts));
        if (delta > 600_000 || (bestDelta !== null && delta >= bestDelta)) continue;
        bestIndex = shadowIndex;
        bestDelta = delta;
      }
      if (bestIndex !== null) {
        unusedShadow.delete(bestIndex);
        pairedTimestamps.push(new Date(Math.max(Date.parse(hostRecord.ts), Date.parse(shadow[bestIndex].ts))).toISOString());
      }
    }
  }

  const report = {
    schema: reportSchema,
    window: { start: startText, end: endText, maxHours: 24 },
    dataGap,
    denominators,
    agreementTable: agreement.agreementTable ?? {},
    nonComparableSample: agreement.nonComparableSample ?? [],
    malformedInputSample: malformed.slice(0, 10),
    cleanWindowGateEvaluated: false,
    fullCleanWindowGateExit: run.status,
    observationStart: dataGap ? null : pairedTimestamps.sort()[0] ?? null,
    note: "Bounded comparison only; this does not assert the separate 48h/200-decision clean-window gate.",
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (outPath) await writeFile(outPath, text);
  process.stdout.write(text);
  process.exitCode = dataGap ? 1 : 0;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
