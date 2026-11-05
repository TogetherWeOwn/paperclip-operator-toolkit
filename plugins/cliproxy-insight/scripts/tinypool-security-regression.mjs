import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Tinypool from "tinypool";

const marker = "TINYPOOL_SECURITY_REGRESSION_MARKER";

// GHSA-5gmw-xhrv-c9v3 and GHSA-85c8-ppgw-ccpr: observe harmless
// option/worker markers, never load an executable payload or start a server.
async function probe(scenario, runtime, directory) {
  const filename = join(directory, "worker.mjs");
  const alternate = join(directory, "alternate.mjs");
  const options = { filename, runtime, minThreads: 1, maxThreads: 1 };
  let pool;
  let pollutedKey;
  let previous;
  delete process.env[marker];
  try {
    if (scenario === "own-options") {
      options.env = { [marker]: "explicit" };
      options.execArgv = ["--no-warnings"];
    } else {
      const pollution = {
        env: { [marker]: "inherited" },
        execArgv: ["--no-warnings"],
        filename: alternate,
      };
      pollutedKey = scenario;
      previous = Object.getOwnPropertyDescriptor(Object.prototype, pollutedKey);
      Object.defineProperty(Object.prototype, pollutedKey, {
        value: pollution[scenario], configurable: true, writable: true,
      });
    }
    pool = new Tinypool(options);
    const result = await pool.run(21, scenario === "own-options" ? { filename: alternate } : {});
    assert.equal(result.value, 42, "normal task execution must still work");
    assert.equal(result.worker, scenario === "own-options" ? "explicit" : "default",
      "run() must ignore an inherited filename but honor an explicit filename");
    assert.equal(result.marker, scenario === "own-options" ? "explicit" : null,
      "workers must ignore inherited env but honor explicit env");
    assert.equal(result.noWarnings, scenario === "own-options",
      "workers must ignore inherited execArgv but honor explicit execArgv");
  } finally {
    // Remove pollution even on an assertion failure; the outer runner also
    // isolates every case in a bounded subprocess so its prototype stays clean.
    if (pollutedKey) {
      if (previous) Object.defineProperty(Object.prototype, pollutedKey, previous);
      else delete Object.prototype[pollutedKey];
    }
    if (pool) await pool.destroy();
  }
}

if (process.argv[2] === "--probe") {
  await probe(process.argv[3], process.argv[4], process.argv[5]);
} else {
  for (const runtime of ["worker_threads", "child_process"]) {
    for (const scenario of ["env", "execArgv", "filename", "own-options"]) {
      test(`${runtime}: ${scenario}`, { timeout: 15_000 }, () => {
        const directory = mkdtempSync(join(tmpdir(), "tinypool-security-"));
        try {
          for (const [name, worker] of [["worker", "default"], ["alternate", "explicit"]]) {
            writeFileSync(join(directory, `${name}.mjs`), `
              export default (value) => ({
                value: value * 2,
                worker: ${JSON.stringify(worker)},
                marker: process.env[${JSON.stringify(marker)}] ?? null,
                noWarnings: process.execArgv.includes('--no-warnings'),
              });
            `);
          }
          const result = spawnSync(process.execPath, [
            fileURLToPath(import.meta.url), "--probe", scenario, runtime, directory,
          ], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
          assert.ifError(result.error);
          assert.equal(result.status, 0, result.stderr || result.stdout);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  }
}
