import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mutationGateVitestInvocation } from "../plugins/model-selection/scripts/mutation-gate-runtime.mjs";

const plugin = resolve(process.argv[2]);
const directory = mkdtempSync(join(plugin, "tests", "pool-qualification-"));
try {
  for (const pool of ["forks", "threads"]) {
    const trace = join(directory, `${pool}.jsonl`);
    for (let index = 0; index < 4; index += 1) {
      writeFileSync(join(directory, `${index}.spec.ts`), `
        import { appendFileSync } from "node:fs";
        import { isMainThread, threadId } from "node:worker_threads";
        import { expect, it } from "vitest";
        it("uses the selected bounded pool", async () => {
          expect(isMainThread).toBe(${pool === "forks"});
          expect(process.env.VITEST_MAX_WORKERS).toBe("2");
          const id = process.pid + ":" + threadId;
          const record = (event) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ event, id, file: ${index} }) + "\\n");
          record("start");
          await new Promise(resolve => setTimeout(resolve, 200));
          record("end");
        });
      `);
    }
    // A conflicting inherited v4 limit must not override the gate's legacy cap.
    const invocation = mutationGateVitestInvocation({
      ...process.env, VITEST_MAX_FORKS: "2", VITEST_MAX_WORKERS: "99",
    });
    const result = spawnSync(process.execPath, [
      ...invocation.args.map(arg => arg === "--pool=forks" ? `--pool=${pool}` : arg),
      directory,
    ], {
      cwd: plugin, encoding: "utf8", env: invocation.env,
      timeout: 30_000, killSignal: invocation.killSignal, maxBuffer: invocation.maxBuffer,
    });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    assert.ifError(result.error);
    assert.equal(result.signal, null, `${pool}: incomplete run`);
    assert.equal(result.status, 0, `${pool}: fixture assertions failed`);
    const events = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.length, 8, `${pool}: not all fixture files ran`);
    const active = new Set();
    const files = new Set();
    let peak = 0;
    for (const { event, id, file } of events) {
      if (event === "start") {
        assert(!active.has(id), `${pool}: worker ran two files simultaneously`);
        assert(!files.has(file), `${pool}: duplicate file execution`);
        files.add(file);
        active.add(id);
        peak = Math.max(peak, active.size);
      } else {
        assert.equal(event, "end");
        assert(active.delete(id), `${pool}: end without start`);
      }
    }
    assert.equal(files.size, 4);
    assert.equal(active.size, 0);
    assert(peak > 0 && peak <= 2, `${pool}: observed ${peak} concurrent workers, expected at most 2`);
    console.log(`${pool}: four files completed, peak active workers ${peak}/2`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
