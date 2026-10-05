import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url).pathname;
const gate = new URL("../scripts/mutation-gate.mjs", import.meta.url).pathname;
const runtime = new URL("../scripts/mutation-gate-runtime.mjs", import.meta.url).href;
// the step runs in the sharded `model-selection mutants` matrix; the
// required `model-selection suite` job only aggregates its verdict.
const ciJob = "model-selection mutants";
const ciStep = "Kill named selection mutants";
const requiredCheck = "model-selection suite";
const refusal = `run on CI (private runner) — cite the PR's "${ciJob}" shard jobs, step "${ciStep}"`;
const workflow = new URL("../../../.github/workflows/ci.yml", import.meta.url).pathname;
const manifest = new URL("../package.json", import.meta.url).pathname;

// Extract the `model-selection-suite:` job block: from its key line to the next
// line at the same indent. Deliberately literal — a rename or a re-quoting of
// any of these lines fails the match, which is the direction that is safe.
function jobBlock(text: string, key: string) {
  const lines = text.split("\n");
  const start = lines.indexOf(`  ${key}:`);
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && /^  \S/.test(line));
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

// The lines of one `- name: <name>` step inside a job block: from its name line
// up to (not including) the next step. Returns null when no such step exists.
function stepLines(block: string[], name: string) {
  const start = block.indexOf(`      - name: ${name}`);
  if (start === -1) return null;
  const end = block.findIndex((line, index) => index > start && /^ {6}- /.test(line));
  return block.slice(start, end === -1 ? block.length : end);
}

function deniedEnv() {
  const env = { ...process.env };
  delete env.CI;
  delete env.MUTATION_GATE_LOCAL;
  return env;
}

function probe(code: string) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

describe("mutation gate runtime controls", () => {
  it("refuses the gate before starting Vitest outside CI", () => {
    const result = spawnSync(process.execPath, [gate], {
      cwd: root,
      encoding: "utf8",
      env: deniedEnv(),
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(refusal);
  });

  it.each(["test:mutants", "verify"])("guards the npm %s script", (script) => {
    const result = spawnSync("npm", ["run", "--silent", script], {
      cwd: root,
      encoding: "utf8",
      env: deniedEnv(),
    });

    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe(refusal);
  });

  it.each([{ CI: "true" }, { MUTATION_GATE_LOCAL: "1" }])("admits an approved execution context: %o", (env) => {
    const result = probe(`
      import { mutationGateAllowed } from ${JSON.stringify(runtime)};
      console.log(JSON.stringify(mutationGateAllowed(${JSON.stringify(env)})));
    `);

    expect(result).toBe(true);
  });

  // The `{ CI: "true" }` row is the one that matters: the refusal
  // above means CI is the ONLY context this gate ever runs in, and `ci.yml`
  // sets no VITEST_* for the `model-selection suite` job, so this bare
  // environment IS the real job env. It previously yielded `run --pool=forks`
  // with no cap — the uncapped fan-out this card exists to stop, on 100% of the
  // runs that can happen, while the covered `MUTATION_GATE_LOCAL` row (a path
  // the refusal makes rare) looked correct. Both rows are pinned now so the
  // default can never go back to being conditional on CI.
  it.each([{ MUTATION_GATE_LOCAL: "1" }, { CI: "true" }])(
    "uses the forks pool and defaults workers to two: %o",
    (env) => {
      const result = probe(`
      import { mutationGateVitestInvocation } from ${JSON.stringify(runtime)};
      const invocation = mutationGateVitestInvocation(${JSON.stringify(env)});
      console.log(JSON.stringify({ args: invocation.args, forks: invocation.env.VITEST_MAX_FORKS, threads: invocation.env.VITEST_MAX_THREADS }));
    `);

      expect(result).toEqual({
        args: [
          "node_modules/vitest/vitest.mjs",
          "run",
          "--cache=false",
          "--pool=forks",
          "--poolOptions.forks.maxForks=2",
          "--poolOptions.forks.minForks=1",
          "--maxWorkers=2",
        ],
        forks: "2",
        threads: "2",
      });
    },
  );

  // A value that parses to nothing usable must land on the default, not on
  // "omit the flags". `VITEST_MAX_FORKS: ${{ inputs.forks }}` resolving empty in
  // a workflow is the realistic way to reach the first row, and the old
  // `Number.parseInt(...) > 0 ? limit : null` turned every row here into an
  // uncapped invocation.
  it.each([
    { CI: "true", VITEST_MAX_FORKS: "" },
    { CI: "true", VITEST_MAX_FORKS: "0" },
    { CI: "true", VITEST_MAX_FORKS: "all" },
    { CI: "true", VITEST_MAX_FORKS: "-4", VITEST_MAX_THREADS: "" },
  ])("falls back to the default cap on an unusable limit: %o", (env) => {
    const result = probe(`
      import { mutationGateVitestInvocation } from ${JSON.stringify(runtime)};
      const invocation = mutationGateVitestInvocation(${JSON.stringify(env)});
      console.log(JSON.stringify(invocation.args));
    `) as string[];

    expect(result).toContain("--poolOptions.forks.maxForks=2");
    expect(result).toContain("--maxWorkers=2");
  });

  // The cap is an invariant, not a default: there is no environment that yields
  // an invocation without one. Asserted over the whole matrix rather than row by
  // row, so a future branch that reintroduces an uncapped path fails here even
  // if nobody thought to add a row for it.
  it("never produces an invocation without a worker cap", () => {
    const envs = [
      {},
      { CI: "true" },
      { CI: "false" },
      { MUTATION_GATE_LOCAL: "1" },
      { CI: "true", MUTATION_GATE_LOCAL: "1" },
      { CI: "true", VITEST_MAX_FORKS: "3" },
      { CI: "true", VITEST_MAX_THREADS: "3" },
      { CI: "true", VITEST_MAX_FORKS: "", VITEST_MAX_THREADS: "" },
    ];

    const results = probe(`
      import { mutationGateVitestInvocation } from ${JSON.stringify(runtime)};
      console.log(JSON.stringify(${JSON.stringify(envs)}.map((env) => mutationGateVitestInvocation(env).args)));
    `) as string[][];

    expect(results).toHaveLength(envs.length);
    for (const [index, args] of results.entries()) {
      const label = JSON.stringify(envs[index]);
      expect(args, `${label} did not pin the forks pool`).toContain("--pool=forks");
      expect(
        args.filter((arg) => /^--poolOptions\.forks\.maxForks=[1-9]\d*$/.test(arg)),
        `${label} produced an uncapped invocation`,
      ).toHaveLength(1);
      expect(
        args.filter((arg) => /^--maxWorkers=[1-9]\d*$/.test(arg)),
        `${label} produced an unbounded worker count`,
      ).toHaveLength(1);
    }
  });

  it.each([
    { CI: "true", VITEST_MAX_FORKS: "3", VITEST_MAX_THREADS: "4" },
    { MUTATION_GATE_LOCAL: "1", VITEST_MAX_FORKS: "5", VITEST_MAX_THREADS: "6" },
  ])("preserves configured Vitest limits: %o", (env) => {
    const result = probe(`
      import { mutationGateVitestInvocation } from ${JSON.stringify(runtime)};
      const invocation = mutationGateVitestInvocation(${JSON.stringify(env)});
      console.log(JSON.stringify({ args: invocation.args, forks: invocation.env.VITEST_MAX_FORKS, threads: invocation.env.VITEST_MAX_THREADS }));
    `);

    // Vitest 2.1.9 does read these variables, but VITEST_MAX_FORKS only
    // populates poolOptions.forks -- and the resolved pool defaults to
    // "threads", which this plugin's config does not override. Passing the
    // value through the environment therefore caps a pool that never runs, so
    // assert the flags that reach the CLI, not just the pass-through.
    //
    // `threads` is now the RESOLVED limit, not the caller's
    // VITEST_MAX_THREADS. The run is `--pool=forks`, so a differing thread
    // budget could never take effect; carrying it forward only left two numbers
    // in the child env disagreeing about one budget. VITEST_MAX_FORKS wins and
    // both vars state it.
    expect(result).toEqual({
      args: [
        "node_modules/vitest/vitest.mjs",
        "run",
        "--cache=false",
        "--pool=forks",
        `--poolOptions.forks.maxForks=${env.VITEST_MAX_FORKS}`,
        "--poolOptions.forks.minForks=1",
        `--maxWorkers=${env.VITEST_MAX_FORKS}`,
      ],
      forks: env.VITEST_MAX_FORKS,
      threads: env.VITEST_MAX_FORKS,
    });
  });

  // `spawnSync` without `timeout` blocks forever, so a single wedged
  // run could spend the job's entire `timeout-minutes` and take the job down
  // with no mutant named. Assert three things together, because any one alone
  // is satisfiable while the bound does nothing: the invocation carries a
  // positive timeout, the gate actually forwards it to `spawnSync`, and a run
  // killed by it scores as BROKEN GATE rather than as a kill.
  it("bounds each run and forwards the bound to spawnSync", () => {
    const invocation = probe(`
      import { mutationGateVitestInvocation, MUTATION_GATE_RUN_TIMEOUT_MS } from ${JSON.stringify(runtime)};
      const invocation = mutationGateVitestInvocation({ CI: "true" });
      console.log(JSON.stringify({
        timeout: invocation.timeout,
        killSignal: invocation.killSignal,
        constant: MUTATION_GATE_RUN_TIMEOUT_MS,
      }));
    `) as { timeout: number; killSignal: string; constant: number };

    expect(invocation.timeout).toBe(invocation.constant);
    expect(invocation.timeout).toBeGreaterThan(0);
    expect(invocation.killSignal).toBe("SIGKILL");

    // The gate must destructure and pass it. A `runTests` that builds the
    // invocation and drops `timeout` leaves the unbounded wait in place, and
    // the two assertions above would still be green.
    const gateSource = readFileSync(gate, "utf8");
    const runTests = gateSource.slice(gateSource.indexOf("function runTests("));
    const body = runTests.slice(0, runTests.indexOf("\n}\n") + 3);
    expect(body).toContain("timeout,");
    expect(body).toContain("killSignal,");
  });

  // `spawnSync` SIGKILLs a child that prints past 1 MiB on either
  // stream and reports it as `{ status: null, signal: "SIGKILL" }` — the shape of
  // a host kill, which `completed()` rightly reads as BROKEN GATE. A mutant the
  // suite catches LOUDLY (the shard-split spec dumps whole arrays) hit exactly
  // that in CI, twice, on the same mutant. So the budget must exceed the default,
  // be what the invocation carries, and be forwarded; and the control run shows
  // the default really is the trap, so a larger number is not asserted in a vacuum.
  it("gives each run an output budget past spawnSync's 1 MiB default and forwards it", () => {
    const result = probe(`
      import { spawnSync } from "node:child_process";
      import { mutationGateVitestInvocation, MUTATION_GATE_OUTPUT_LIMIT_BYTES } from ${JSON.stringify(runtime)};
      const { maxBuffer } = mutationGateVitestInvocation({ CI: "true" });
      const noisy = "process.stdout.write('x'.repeat(3 * 1024 * 1024)); process.stderr.write('y'.repeat(3 * 1024 * 1024));";
      const run = (options) => {
        const r = spawnSync(process.execPath, ["-e", noisy], { encoding: "utf8", killSignal: "SIGKILL", ...options });
        return { status: r.status, signal: r.signal, stdout: (r.stdout ?? "").length, stderr: (r.stderr ?? "").length };
      };
      console.log(JSON.stringify({
        limit: MUTATION_GATE_OUTPUT_LIMIT_BYTES,
        maxBuffer,
        withBudget: run({ maxBuffer }),
        withDefault: run({}),
      }));
    `) as {
      limit: number;
      maxBuffer: number;
      withBudget: { status: number | null; signal: string | null; stdout: number; stderr: number };
      withDefault: { status: number | null; signal: string | null };
    };

    expect(result.maxBuffer).toBe(result.limit);
    expect(result.limit).toBeGreaterThan(1024 * 1024);
    // Control: without the budget a 3 MiB failure is a SIGKILL, not a result.
    expect(result.withDefault.status).toBeNull();
    expect(result.withDefault.signal).toBe("SIGKILL");
    // With the invocation's budget the same output completes and is read whole.
    expect(result.withBudget).toEqual({ status: 0, signal: null, stdout: 3 * 1024 * 1024, stderr: 3 * 1024 * 1024 });

    const gateSource = readFileSync(gate, "utf8");
    const runTests = gateSource.slice(gateSource.indexOf("function runTests("));
    const body = runTests.slice(0, runTests.indexOf("\n}\n") + 3);
    expect(body).toContain("maxBuffer,");
  });

  // The timeout above is only a safety net if its result is read as a failure.
  // `spawnSync` reports a timeout kill as `{ status: null, signal: "SIGKILL" }`,
  // and the mutant loop scores every nonzero exit as a kill -- so without
  // `completed()` a wedged run would report as the mutant being caught.
  it("scores a timed-out run as a broken gate, not a kill", () => {
    const result = probe(`
      import { spawnSync } from "node:child_process";
      const result = spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
        encoding: "utf8",
        timeout: 250,
        killSignal: "SIGKILL",
      });
      // Mirrors completed() in mutation-gate.mjs.
      const completed = result.signal === null && result.status !== null &&
        \`\${result.stdout}\`.includes("Test Files");
      console.log(JSON.stringify({ status: result.status, signal: result.signal, completed, nonzero: result.status !== 0 }));
    `) as { status: number | null; signal: string | null; completed: boolean; nonzero: boolean };

    // The shape the bare loop would have mis-scored as a kill...
    expect(result.status).toBeNull();
    expect(result.signal).not.toBeNull();
    expect(result.nonzero).toBe(true);
    // ...and the guard that stops it.
    expect(result.completed).toBe(false);
  });

  // The flags above are only worth asserting if this Vitest actually accepts
  // them -- a renamed or dropped option would otherwise sail through as a
  // string comparison against itself. Spawn the real binary on a trivial spec
  // and require a clean exit.
  it("passes worker-limit flags this Vitest build accepts", () => {
    // Lives under the plugin's own tests/ dir so `vitest/config` and the shared
    // node_modules resolve; a tmpdir sandbox cannot see either.
    const probeSpec = join(realpathSync(root), "tests", "flag-probe.generated.spec.ts");
    try {
      writeFileSync(
        probeSpec,
        'import { expect, it } from "vitest";\nit("runs", () => expect(1).toBe(1));\n',
      );

      const invocation = probe(`
        import { mutationGateVitestInvocation } from ${JSON.stringify(runtime)};
        const invocation = mutationGateVitestInvocation({ MUTATION_GATE_LOCAL: "1" });
        console.log(JSON.stringify({ args: invocation.args }));
      `) as { args: string[] };

      const [entry, ...flags] = invocation.args;
      expect(entry, "invocation produced no vitest entrypoint").toBeDefined();

      const result = spawnSync(
        process.execPath,
        [join(realpathSync(root), entry as string), ...flags, probeSpec],
        { cwd: realpathSync(root), encoding: "utf8", env: { ...process.env, CI: "true" } },
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    } finally {
      rmSync(probeSpec, { force: true });
    }
  });

  it("isolates mutations from the source tree", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "mutation-tree-test-"));
    const source = join(sandbox, "source");
    const target = join(sandbox, "scratch", "plugins", "model-selection");
    try {
      mkdirSync(join(source, "src"), { recursive: true });
      mkdirSync(join(source, "node_modules"), { recursive: true });
      writeFileSync(join(source, "src", "value.ts"), "original\n");

      probe(`
        import { copyMutationTree } from ${JSON.stringify(runtime)};
        await copyMutationTree(${JSON.stringify(source)}, ${JSON.stringify(target)});
        console.log(JSON.stringify(true));
      `);
      writeFileSync(join(target, "src", "value.ts"), "mutant\n");

      expect(readFileSync(join(source, "src", "value.ts"), "utf8")).toBe("original\n");
      expect(realpathSync(join(target, "node_modules"))).toBe(realpathSync(join(source, "node_modules")));
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  // The refusal sends the reader somewhere instead of running the
  // gate, so the pointer has to be true or the refusal is worse than no gate:
  // it costs the agent the local run AND the evidence. Three links are pinned —
  // the job name exists in ci.yml, a step by that name lives inside THAT job,
  // and its `run:` reaches this plugin's mutation-gate.mjs through the npm
  // script. This asserts the wiring is present, not that it passes; a green
  // run of the step is what the citation is for.
  //
  // the job is now the sharded `model-selection-mutants` matrix, and
  // its step carries the shard it runs through MUTATION_SHARD.
  it("names a CI job and step that actually execute this gate", () => {
    const block = jobBlock(readFileSync(workflow, "utf8"), "model-selection-mutants");
    expect(block, "ci.yml has no model-selection-mutants job").not.toBeNull();

    expect(block).toContain("    name: " + ciJob + " (shard ${{ matrix.shard }}/${{ strategy.job-total }})");

    const step = stepLines(block!, ciStep);
    expect(step, `no "${ciStep}" step inside the ${ciJob} job`).not.toBeNull();
    expect(step).toContain("        run: npm run test:mutants");
    expect(step).toContain("          MUTATION_SHARD: ${{ matrix.shard }}/${{ strategy.job-total }}");

    const scripts = JSON.parse(readFileSync(manifest, "utf8")).scripts as Record<string, string>;
    expect(scripts["test:mutants"]).toContain("scripts/mutation-gate.mjs");

    expect(refusal).toContain(ciJob);
    expect(refusal).toContain(ciStep);
  });

  // Sharding moves the verdict out of the required job, so each rule
  // below closes one way for the sweep to go green while testing less than the
  // whole list. All are pinned against ci.yml by literal line, the same way the
  // job/step names are: a re-quoting fails the match, which is the safe side.
  describe("sharded mutation workflow", () => {
    const text = readFileSync(workflow, "utf8");
    const mutants = jobBlock(text, "model-selection-mutants")!;
    const impact = jobBlock(text, "model-selection-impact")!;
    const suite = jobBlock(text, "model-selection-suite")!;

    it("keeps the matrix a contiguous 1..N, so every shard i/N is actually run", () => {
      // `strategy.job-total` is N, so a matrix missing a middle entry (1,2,3,5,
      // 6,7 of 6) silently skips a slice: shard 4 never runs and shard 6 of 6 is
      // asked for twice-removed. Contiguity from 1 is the invariant.
      const row = mutants.find((line) => /^ {8}shard: \[[0-9, ]+\]$/.test(line));
      expect(row, "no `shard: [...]` matrix row").toBeDefined();
      const shards = row!.replace(/^ {8}shard: \[|\]$/g, "").split(",").map((n) => Number.parseInt(n, 10));
      expect(shards.length).toBeGreaterThan(1);
      expect(shards).toEqual(shards.map((_, index) => index + 1));
    });

    it.each([
      "    needs: model-selection-impact",
      "    if: ${{ needs.model-selection-impact.outputs.impacted == 'true' }}",
      "    timeout-minutes: 40",
      "      fail-fast: false",
      "    permissions:",
      "      contents: read",
    ])("pins the mutants job to %s", (line) => {
      expect(mutants).toContain(line);
    });

    it("exposes the impact verdict from the step that computes it", () => {
      expect(impact).toContain("    name: model-selection impact");
      expect(impact).toContain("      impacted: ${{ steps.impact.outputs.impacted }}");
      const step = stepLines(impact, "Decide whether this change can affect the plugin mutants");
      expect(step, "no impact step").not.toBeNull();
      expect(step).toContain("        id: impact");
      expect(step).toContain("        run: node plugins/model-selection/scripts/mutation-impact.mjs");
    });

    it("leaves the required context name and an always-reporting condition on the aggregator", () => {
      expect(suite).toContain(`    name: ${requiredCheck}`);
      // `!cancelled()` still runs after a red or skipped dependency, so the
      // required check always reports a verdict; only a cancelled run (which is
      // red or absent, never green) skips it. The gating contract
      // additionally requires `changes` in needs and the heavy gate in the
      // if, so docs-only PRs skip the sweep while the check reports.
      expect(suite).toContain("    if: ${{ !cancelled() && needs.changes.outputs.heavy == 'true' }}");
      expect(suite).toContain("    needs: [changes, model-selection-impact, model-selection-mutants]");
      expect(suite).toContain("    timeout-minutes: 40");
    });

    it("does not run the sweep inside the required job any more", () => {
      expect(suite.some((line) => line.includes(ciStep))).toBe(false);
      expect(suite.some((line) => line.includes("npm run test:mutants"))).toBe(false);
      expect(suite.some((line) => line.includes("MUTATION_SHARD"))).toBe(false);
    });

    it("fails the required job unless the sweep passed or was legitimately skipped", () => {
      const step = stepLines(suite, "Require the sharded mutation gate");
      expect(step, "no aggregation step in the suite job").not.toBeNull();
      // First step: it must not wait behind the install, and only an impacted
      // run with all shards green, or a proven-unimpacted run with the matrix
      // skipped, may pass. Anything else — failed, cancelled, skipped while
      // impacted, impact job red — falls through to the red default.
      expect(suite.findIndex((line) => line.includes("- name: Require the sharded mutation gate"))).toBe(
        suite.findIndex((line) => line.startsWith("      - ")),
      );
      expect(step).toContain("        working-directory: .");
      expect(step).toContain("          IMPACT_RESULT: ${{ needs.model-selection-impact.result }}");
      expect(step).toContain("          IMPACTED: ${{ needs.model-selection-impact.outputs.impacted }}");
      expect(step).toContain("          MUTANTS_RESULT: ${{ needs.model-selection-mutants.result }}");
      expect(step).toContain('            success/true/success) ;;');
      expect(step).toContain('            success/false/skipped) ;;');
      expect(step!.filter((line) => /^ {12}[a-z*/]+\)/.test(line))).toEqual([
        "            success/true/success) ;;",
        "            success/false/skipped) ;;",
        "            *)",
      ]);
    });

    it("feeds both new jobs to the failure-log drain", () => {
      const drain = jobBlock(text, "failure-log-drain")!;
      expect(drain).toContain("      - model-selection-impact");
      expect(drain).toContain("      - model-selection-mutants");
      expect(drain).toContain("      - model-selection-suite");
    });
  });

  // The shard split is what lets N jobs cover one sweep, so its two
  // properties are checked over every N the workflow could plausibly use and
  // over list sizes that straddle N (empty, one, fewer than N, a prime, the
  // real ~300): shards are pairwise disjoint and their union is the whole list.
  // A mutant that falls between shards is one nobody kills — a sweep that
  // reports green having tested less than it claims.
  describe("mutation shard selection", () => {
    const shardRuns = probe(`
      import { parseMutationShard, selectMutationShard } from ${JSON.stringify(runtime)};
      const out = {};
      for (const size of [0, 1, 7, 8, 9, 97, 302]) {
        const items = Array.from({ length: size }, (_, index) => index);
        for (let total = 1; total <= 16; total += 1) {
          const slices = [];
          for (let index = 1; index <= total; index += 1) {
            slices.push(selectMutationShard(items, parseMutationShard(index + "/" + total)));
          }
          out[size + "/" + total] = slices;
        }
      }
      console.log(JSON.stringify(out));
    `) as Record<string, number[][]>;

    it.each(Object.keys(shardRuns))("splits a list of size/N %s into disjoint slices that cover it exactly", (key) => {
      const [size = 0, total = 1] = key.split("/").map(Number);
      const slices = shardRuns[key]!;
      expect(slices).toHaveLength(total);
      // flat + sorted equals 0..size-1 only if there is no duplicate (disjoint)
      // and no gap (union is the whole list).
      expect(slices.flat().sort((a, b) => a - b)).toEqual(Array.from({ length: size }, (_, index) => index));
      // Round-robin keeps the slices balanced to within one mutant.
      const lengths = slices.map((slice) => slice.length);
      expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(1);
    });

    it("assigns by index % N == i - 1, so adjacent (similarly expensive) mutants spread across shards", () => {
      const result = probe(`
        import { parseMutationShard, selectMutationShard } from ${JSON.stringify(runtime)};
        const items = Array.from({ length: 16 }, (_, index) => index);
        console.log(JSON.stringify({
          second: selectMutationShard(items, parseMutationShard("2/8")),
          last: selectMutationShard(items, parseMutationShard("8/8")),
        }));
      `);
      expect(result).toEqual({ second: [1, 9], last: [7, 15] });
    });

    it("treats an unset spec as not sharded, and reads a padded one", () => {
      const result = probe(`
        import { parseMutationShard, selectMutationShard } from ${JSON.stringify(runtime)};
        const items = ["a", "b", "c"];
        console.log(JSON.stringify({
          unset: parseMutationShard(undefined),
          all: selectMutationShard(items, parseMutationShard(undefined)),
          padded: parseMutationShard(${JSON.stringify(" 3/8\n")}),
        }));
      `);
      expect(result).toEqual({ unset: null, all: ["a", "b", "c"], padded: { index: 3, total: 8 } });
    });

    // A set but malformed spec must THROW. Each row is a way for a workflow
    // expression to go wrong that, treated leniently, becomes either "run the
    // whole sweep serially again" or "run no mutants and report green".
    const malformed = ["", " ", "0/8", "9/8", "1/0", "a/b", "1/8/2", "1", "3/", "/8", "-1/8", "1.5/8", "01/8", "1/99999999999999999999"];
    it.each(malformed)("rejects the malformed spec %j", (spec) => {
      const result = probe(`
        import { parseMutationShard } from ${JSON.stringify(runtime)};
        let outcome;
        try { outcome = { parsed: parseMutationShard(${JSON.stringify(spec)}) }; }
        catch (error) { outcome = { error: error.message }; }
        console.log(JSON.stringify(outcome));
      `) as { parsed?: unknown; error?: string };
      expect(result.parsed).toBeUndefined();
      expect(result.error).toMatch(/invalid MUTATION_SHARD/);
    });

    // The same refusals, end to end through the real gate script. Selection
    // precedes the baseline, so every row exits before the first Vitest run —
    // but "precedes" is exactly what a regression breaks, and a regression would
    // otherwise launch a real sweep from inside a test that is itself run by the
    // sweep. So the gate runs in a sandbox whose `vitest` is a stub that exits 97:
    // a gate that wrongly proceeds reaches the stub, fails with a different
    // message, and fails the row — no nested suite is ever started.
    const stubbedGate = () => {
      const sandbox = mkdtempSync(join(tmpdir(), "mutation-shard-gate-"));
      const pluginRoot = join(sandbox, "plugins", "model-selection");
      mkdirSync(join(pluginRoot, "scripts"), { recursive: true });
      mkdirSync(join(pluginRoot, "node_modules", "vitest"), { recursive: true });
      copyFileSync(gate, join(pluginRoot, "scripts", "mutation-gate.mjs"));
      copyFileSync(new URL("../scripts/mutation-gate-runtime.mjs", import.meta.url).pathname, join(pluginRoot, "scripts", "mutation-gate-runtime.mjs"));
      writeFileSync(join(pluginRoot, "node_modules", "vitest", "vitest.mjs"), "process.exit(97);\n");
      return { sandbox, pluginRoot, script: join(pluginRoot, "scripts", "mutation-gate.mjs") };
    };
    const gateEnv = (extra: Record<string, string>) => {
      const env: NodeJS.ProcessEnv = { ...process.env, MUTATION_GATE_LOCAL: "1", ...extra };
      for (const name of ["MUTATION_SHARD", "MUTANTS"]) if (!(name in extra)) delete env[name];
      return env;
    };
    it.each([
      [{ MUTATION_SHARD: "" }, /invalid MUTATION_SHARD/],
      [{ MUTATION_SHARD: "0/8" }, /invalid MUTATION_SHARD/],
      [{ MUTATION_SHARD: "9/8" }, /invalid MUTATION_SHARD/],
      [{ MUTATION_SHARD: "x" }, /invalid MUTATION_SHARD/],
      [{ MUTATION_SHARD: "1/2", MUTANTS: "obs-adapter-provenance-dropped" }, /mutually exclusive/],
      [{ MUTATION_SHARD: "100000/100000" }, /selects no mutants/],
    ] as Array<[Record<string, string>, RegExp]>)("the gate refuses %o before running anything", (extra, message) => {
      const { sandbox, pluginRoot, script } = stubbedGate();
      try {
        const result = spawnSync(process.execPath, [script], {
          cwd: pluginRoot,
          encoding: "utf8",
          env: gateEnv(extra),
          timeout: 20_000,
          killSignal: "SIGKILL",
        });

        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toMatch(/BROKEN GATE:/);
        expect(result.stderr).toMatch(message);
        expect(result.stderr).not.toMatch(/baseline/);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    });

    // The converse, which the refusals above cannot show: a well-formed shard
    // does get past selection and reaches the baseline. With the stub as vitest
    // that is a BROKEN GATE naming the baseline — i.e. "selection accepted this
    // spec" — and, because the baseline never completed, no mutant ran and no
    // `shard ... killed` line was printed. A shard summary is therefore only ever
    // the product of a real sweep.
    it("a well-formed shard passes selection and stops at the baseline, printing no summary", () => {
      const { sandbox, pluginRoot, script } = stubbedGate();
      try {
        const result = spawnSync(process.execPath, [script], {
          cwd: pluginRoot,
          encoding: "utf8",
          env: gateEnv({ MUTATION_SHARD: "3/8" }),
          timeout: 20_000,
          killSignal: "SIGKILL",
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/BROKEN GATE: baseline run did not complete/);
        expect(result.stdout).not.toMatch(/mutation gate/);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    });
  });

  //  /. Mutants run from a scratch copy of the plugin, so a
  // spec that reads a repo file through one or more `../` segments finds
  // nothing there unless the gate stages it. That is not a benign skip: the
  // mutant loop reads any nonzero exit as a kill, so one ENOENT turns the
  // whole sweep green while testing nothing -- which is what `18/18 killed`
  // was actually reporting.
  //
  // Derive the dependencies from the specs rather than restating them, so a
  // NEW out-of-copy read fails here instead of silently inflating the score.
  // The walk is recursive -- matching vitest's own `tests/**/*.spec.ts`
  // include, which is not flat -- and each match is resolved against its own
  // spec file's directory rather than pinned to a fixed `../` count, so a
  // spec nested under a tests/ subdirectory needs no special-casing.
  it("stages every repo file the suite reads from outside the plugin", () => {
    const pluginRoot = realpathSync(root);
    const repoRoot = resolve(pluginRoot, "..", "..");
    const testsDir = join(pluginRoot, "tests");
    const referenced = new Set<string>();

    const specFiles = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return specFiles(full);
        return entry.isFile() && entry.name.endsWith(".spec.ts") ? [full] : [];
      });

    for (const specFile of specFiles(testsDir)) {
      const source = readFileSync(specFile, "utf8");
      for (const [, path] of source.matchAll(/["'`](\.\.\/[^"'`]+)["'`]/g)) {
        if (path === undefined) continue;
        const resolved = resolve(dirname(specFile), path);
        if (resolved === pluginRoot || resolved.startsWith(pluginRoot + sep)) continue;

        const repoRelative = relative(repoRoot, resolved);
        // A prose `../../../`-shaped code span with no file segment after it
        // resolves to repoRoot itself, not a real read -- drop it rather than
        // stage an empty path.
        if (repoRelative === "") continue;
        referenced.add(repoRelative);
      }
    }

    // A bad regex or a walk that found nothing would make this test vacuously
    // green.
    expect(referenced, "found no out-of-plugin ../ references -- the scan is broken").not.toEqual(new Set());

    const staged = probe(`
      import { MUTATION_TREE_REPO_FIXTURES } from ${JSON.stringify(runtime)};
      console.log(JSON.stringify(MUTATION_TREE_REPO_FIXTURES));
    `) as string[];

    expect([...referenced].sort()).toEqual([...staged].sort());
  });

  it("copies each declared fixture into the mutation scratch root", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "mutation-fixtures-test-"));
    const repo = join(sandbox, "repo");
    const scratch = join(sandbox, "scratch");
    try {
      mkdirSync(join(repo, "nested", "deep"), { recursive: true });
      writeFileSync(join(repo, "nested", "deep", "fixture.yml"), "staged\n");

      probe(`
        import { stageRepoFixtures } from ${JSON.stringify(runtime)};
        await stageRepoFixtures(${JSON.stringify(repo)}, ${JSON.stringify(scratch)}, ["nested/deep/fixture.yml"]);
        console.log(JSON.stringify(true));
      `);

      expect(readFileSync(join(scratch, "nested", "deep", "fixture.yml"), "utf8")).toBe("staged\n");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("runs one mutant callback at a time", () => {
    const result = probe(`
      import { runSequentially } from ${JSON.stringify(runtime)};
      let active = 0;
      let maxActive = 0;
      const order = [];
      await runSequentially(["a", "b", "c"], async (item) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push("start:" + item);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("end:" + item);
        active -= 1;
      });
      console.log(JSON.stringify({ maxActive, order }));
    `);

    expect(result).toEqual({
      maxActive: 1,
      order: ["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"],
    });
  });
});
