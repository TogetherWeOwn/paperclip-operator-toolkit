#!/usr/bin/env node
/**
 *  step 3/5: shadow verification that no ordinary card lands on a T0
 * row, recorded BEFORE enforcement is considered. Reads the decision stream
 * (`decisions.jsonl`, or a directory of `decisions-YYYY-MM-DD-HHZ.jsonl`
 * shards) and answers one question: did any decision that did not opt in to T0
 * pick or cost a T0 row?
 *
 * A decision opted in only when its recorded tier judgement is the explicit
 * `tier T0 via issue-label` / `tier T0 via issue-override` trace line. Anything
 * else that picked a T0 model, or kept a T0 candidate in its costed set, is a
 * violation — the admission ceiling removes T0 rows from the pool before
 * costing, so a T0 candidate on a non-opt-in card means the ceiling is not
 * running.
 *
 * Exit codes: 0 verified; 1 violations; 2 INSUFFICIENT EVIDENCE (too few
 * decisions, or no decision carries the `tier ceiling` marker — i.e. no proof
 * the T0-aware build was emitting, so a clean count would be vacuous).
 *
 * Usage: verify-t0-shadow.mjs --input <file|dir> [--t0-ids a,b,c] [--min-decisions 50] [--out <json>]
 */
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const DEFAULT_T0_IDS = Object.freeze(["gpt-6-astra", "claude-opus-5-5", "claude-fable-5-1"]);
const DEFAULT_MIN_DECISIONS = 50;
const SHARD_FILE = /^decisions-\d{4}-\d{2}-\d{2}-\d{2}Z\.jsonl$/;
const OPT_IN = /tier T0 via (?:issue-label|issue-override)\b/;
const CEILING_MARKER = /tier ceiling T1:/;

export function evaluateT0Shadow(lines, options = {}) {
  const t0Ids = new Set(options.t0Ids ?? DEFAULT_T0_IDS);
  const minDecisions = options.minDecisions ?? DEFAULT_MIN_DECISIONS;
  const summary = {
    decisions: 0,
    malformed: 0,
    optedInT0Decisions: 0,
    ceilingMarkerDecisions: 0,
    violations: [],
  };

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      summary.malformed += 1;
      continue;
    }
    if (typeof record !== "object" || record === null || typeof record.pickWhy !== "string") {
      summary.malformed += 1;
      continue;
    }
    summary.decisions += 1;
    const optedIn = OPT_IN.test(record.pickWhy);
    if (optedIn) summary.optedInT0Decisions += 1;
    if (CEILING_MARKER.test(record.pickWhy)) summary.ceilingMarkerDecisions += 1;
    if (optedIn) continue;

    const picked = typeof record.pickedModel === "string" && t0Ids.has(record.pickedModel);
    const costed = Array.isArray(record.candidates)
      ? record.candidates.filter((candidate) => candidate?.tier === "T0" || t0Ids.has(candidate?.model)).map((candidate) => candidate.model)
      : [];
    if (picked || costed.length > 0) {
      summary.violations.push({
        issue: record.issueIdentifier ?? record.issueId ?? null,
        ts: record.ts ?? null,
        tier: record.tier ?? null,
        pickedModel: record.pickedModel ?? null,
        t0Candidates: costed,
      });
    }
  }

  let verdict = "verified";
  if (summary.violations.length > 0) verdict = "violations";
  else if (summary.decisions < minDecisions) verdict = "insufficient-evidence";
  else if (summary.ceilingMarkerDecisions === 0) verdict = "insufficient-evidence";
  return { ...summary, minDecisions, verdict };
}

async function readLines(input) {
  const info = await stat(input);
  if (!info.isDirectory()) return (await readFile(input, "utf8")).split("\n");
  const names = (await readdir(input)).filter((name) => SHARD_FILE.test(name)).sort();
  const lines = [];
  for (const name of names) lines.push(...(await readFile(join(input, name), "utf8")).split("\n"));
  return lines;
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

async function main() {
  const input = argument("input");
  if (!input) throw new Error("usage: verify-t0-shadow.mjs --input <file|dir> [--t0-ids a,b,c] [--min-decisions 50] [--out <json>]");
  const minArg = argument("min-decisions");
  const minDecisions = minArg === null ? DEFAULT_MIN_DECISIONS : Number.parseInt(minArg, 10);
  if (!Number.isInteger(minDecisions) || minDecisions < 1) throw new Error("--min-decisions must be a positive integer");
  const idsArg = argument("t0-ids");
  const t0Ids = idsArg ? idsArg.split(",").map((id) => id.trim()).filter(Boolean) : undefined;

  const result = evaluateT0Shadow(await readLines(resolve(input)), { t0Ids, minDecisions });
  const outPath = argument("out");
  if (outPath) await writeFile(resolve(outPath), `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    `T0 shadow ${result.verdict}: ${result.decisions} decisions, ${result.optedInT0Decisions} explicit T0 opt-ins, ` +
      `${result.ceilingMarkerDecisions} carrying the tier-ceiling marker, ${result.violations.length} violation(s)`,
  );
  if (result.verdict === "violations") process.exitCode = 1;
  else if (result.verdict === "insufficient-evidence") process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
}
