#!/usr/bin/env node
// Summarise the guard's decision log: how often it handed a turn back, and why it let one go.
//   node summarize-decisions.mjs [decisions.jsonl] [--since 2026-10-03T00:00:00Z]
// The log holds lengths and reasons only, never the model's text.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const sinceIndex = args.indexOf("--since");
const since = sinceIndex >= 0 ? Date.parse(args.splice(sinceIndex, 2)[1]) : 0;
const file = args[0] ?? join(HERE, "decisions.jsonl");
if (!existsSync(file)) {
  process.stderr.write(`no decision log at ${file}\n`);
  process.exit(1);
}
const rows = readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter((row) => row && Date.parse(row.ts) >= since);

const count = (items, key) => items.reduce((acc, row) => ({ ...acc, [row[key] ?? "null"]: (acc[row[key] ?? "null"] ?? 0) + 1 }), {});
const blocks = rows.filter((row) => row.action === "block");
const runs = new Set(rows.map((row) => row.run ?? row.session));
const blockedRuns = new Set(blocks.map((row) => row.run ?? row.session));
const perRun = {};
for (const row of blocks) perRun[row.run ?? row.session] = (perRun[row.run ?? row.session] ?? 0) + 1;
const histogram = {};
for (const n of Object.values(perRun)) histogram[n] = (histogram[n] ?? 0) + 1;

process.stdout.write(
  `${JSON.stringify(
    {
      from: rows[0]?.ts ?? null,
      to: rows.at(-1)?.ts ?? null,
      stopsSeen: rows.length,
      runsSeen: runs.size,
      blocks: blocks.length,
      runsNudged: blockedRuns.size,
      nudgesPerNudgedRun: histogram,
      blockedBy: count(blocks, "why"),
      allowedBecause: count(rows.filter((row) => row.action === "allow"), "why"),
      capReached: rows.filter((row) => row.why === "nudge-cap-reached").length,
      unsavedWorkObserved: rows.filter((row) => row.why === "unsaved-work-observed").length,
    },
    null,
    2,
  )}\n`,
);
