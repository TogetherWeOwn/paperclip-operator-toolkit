// Reproduces how a 20-byte empty .sql.gz survives the pg_dump branch's cleanup.
//
// Mirrors runPgDumpBackup (backup-lib.ts:325-353) and the catch-block cleanup at
// backup-lib.ts:565-572, with pg_dump absent (as on this host: `which pg_dump` rc=1).
//
// Usage: node empty-gzip-residue-repro.mjs [iterations]
// Exits 0 and prints a tally. Reports WHY the file survives, not just that it does.

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, unlinkSync, statSync, rmSync, mkdtempSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";

const iterations = Number(process.argv[2] || 40);
const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "gzip-residue-"));

async function waitForChildExit(child, label) {
  const r = await new Promise((res, rej) => {
    child.once("error", rej);
    child.once("exit", (code, signal) => res({ code, signal }));
  });
  if (r.code !== 0) throw new Error(`${label} failed ${r.code}`);
}

async function attempt(backupFile) {
  // Tracks the state the vendor's `if (existsSync(backupFile))` guard actually sees.
  let existedAtCleanup = null;

  try {
    const child = spawn("pg_dump_definitely_absent", ["--x"], { stdio: ["ignore", "pipe", "pipe"] });

    // spawn() emits 'error' asynchronously on ENOENT. waitForChildExit attaches its
    // own handler, but pipeline() rejects first and Promise.all abandons the other
    // arm, leaving the 'error' emit unhandled -> hard crash. The vendor is not
    // exposed to this (its child has a live listener either way); the repro needs a
    // standing no-op handler so the process survives to observe the cleanup.
    child.on("error", () => {});

    if (!child.stdout) throw new Error("no stdout");
    await Promise.all([
      pipeline(child.stdout, createGzip(), createWriteStream(backupFile)),
      waitForChildExit(child, "pg_dump"),
    ]);
  } catch {
    // backup-lib.ts:565-567, verbatim in shape.
    existedAtCleanup = existsSync(backupFile);
    if (existedAtCleanup) {
      try { unlinkSync(backupFile); } catch { /* ignore */ }
    }
  }

  // The JS-engine fallback (backup-lib.ts:572+) then runs for many seconds. Any
  // write stream still settling in the background lands during that window.
  await new Promise((r) => setTimeout(r, 300));

  const survived = existsSync(backupFile);
  return { existedAtCleanup, survived, size: survived ? statSync(backupFile).size : null };
}

const tally = { survivedMissedByGuard: 0, survivedRacedUnlink: 0, cleaned: 0 };
const sizes = new Set();

for (let i = 0; i < iterations; i++) {
  const f = join(dir, `r${i}.sql.gz`);
  const { existedAtCleanup, survived, size } = await attempt(f);
  if (survived) {
    sizes.add(size);
    if (existedAtCleanup === false) tally.survivedMissedByGuard++;
    else tally.survivedRacedUnlink++;
  } else {
    tally.cleaned++;
  }
}

rmSync(dir, { recursive: true, force: true });

const survived = tally.survivedMissedByGuard + tally.survivedRacedUnlink;
console.log(`iterations: ${iterations}`);
console.log(`survived:   ${survived}/${iterations}  sizes=${[...sizes].join(",") || "-"}`);
console.log(`  - guard saw no file yet (existsSync false), stream landed after: ${tally.survivedMissedByGuard}`);
console.log(`  - guard unlinked, stream recreated the file after:              ${tally.survivedRacedUnlink}`);
console.log(`cleaned:    ${tally.cleaned}/${iterations}`);
