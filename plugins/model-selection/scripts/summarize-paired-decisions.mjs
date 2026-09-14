#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultGate = join(root, "ops/tog-2138/gate_harness.py");

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
const gateIndex = process.argv.indexOf("--gate-harness");
const gatePath = gateIndex >= 0 ? process.argv[gateIndex + 1] : defaultGate;
const startMs = parseUtc(startText, "--start");
const endMs = parseUtc(endText, "--end");
if (endMs <= startMs) fail("--end must be later than --start");
if (endMs - startMs > 24 * 60 * 60 * 1000) fail("interval must be no longer than 24 hours");

let source;
try {
  source = await readFile(inputPath, "utf8");
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

const scratch = await mkdtemp(join(tmpdir(), "tog2504-summary-"));
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
    schema: "tog2504-bounded-summary-v2",
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
