#!/usr/bin/env node
// Classify the rows from extract-turn-endings.py with the hook's own classifier and print the rates.
//   node eval-turn-endings.mjs endings.jsonl [--sample announce|final|nodisp 25]
import { readFileSync } from "node:fs";
import { classifyLastTurn } from "../muse-stop-guard.mjs";

const [file, flag, which, count] = process.argv.slice(2);
if (!file) {
  process.stderr.write("usage: eval-turn-endings.mjs endings.jsonl [--sample announce|final|nodisp N]\n");
  process.exit(2);
}
const rows = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
// A turn really ended when a new prompt or the end of the file follows it.
const ended = rows.filter((row) => row.next === "u" || row.next === "EOF").map((row) => ({ ...row, kind: classifyLastTurn(row.text).kind }));
const flagged = ended.filter((row) => row.kind !== "final");
const parked = flagged.filter((row) => !row.disp);
const pct = (n) => `${((100 * n) / Math.max(1, ended.length)).toFixed(1)}%`;
process.stdout.write(
  `${JSON.stringify(
    {
      endedTurns: ended.length,
      flagged: { n: flagged.length, ofEnded: pct(flagged.length) },
      flaggedWithoutDispositionWrite: { n: parked.length, ofEnded: pct(parked.length), note: "the turns that end a run with nothing done" },
      finalWithoutDispositionWrite: ended.filter((row) => row.kind === "final" && !row.disp).length,
    },
    null,
    2,
  )}\n`,
);
if (flag === "--sample") {
  const pool = which === "announce" ? flagged : which === "nodisp" ? ended.filter((row) => row.kind === "final" && !row.disp) : ended.filter((row) => row.kind === "final");
  for (const row of pool.sort(() => Math.random() - 0.5).slice(0, Number(count || 25))) process.stdout.write(`${JSON.stringify(row.text.slice(-220))}\n`);
}
