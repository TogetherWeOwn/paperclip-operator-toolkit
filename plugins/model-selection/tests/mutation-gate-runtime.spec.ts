import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url).pathname;
const gate = new URL("../scripts/mutation-gate.mjs", import.meta.url).pathname;
const runtime = new URL("../scripts/mutation-gate-runtime.mjs", import.meta.url).href;
// The step runs in the sharded `model-selection mutants` matrix; the
// required `model-selection suite` job only aggregates its verdict.
const ciJob = "model-selection mutants";
const ciStep = "Kill named selection mutants";
const requiredCheck = "model-selection suite";
const refusal = `run on CI (standard runner) — cite the PR's "${ciJob}" shard jobs, step "${ciStep}"`;
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

  // TOG-3129. The `{ CI: "true" }` row is the one that matters: the refusal
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
    // TOG-3129: `threads` is now the RESOLVED limit, not the caller's
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

  // TOG-3129. `spawnSync` without `timeout` blocks forever, so a single wedged
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

  // TOG-2789. The refusal sends the reader somewhere instead of running the
  // gate, so the pointer has to be true or the refusal is worse than no gate:
  // it costs the agent the local run AND the evidence. Three links are pinned —
  // the job name exists in ci.yml, a step by that name lives inside THAT job,
  // and its `run:` reaches this plugin's mutation-gate.mjs through the npm
  // script. This asserts the wiring is present, not that it passes; a green
  // run of the step is what the citation is for.
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

  // TOG-2980 / TOG-3049. Mutants run from a scratch copy of the plugin, so a
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

  describe("gate run output redirection", () => {
    // spawnSync buffers both streams against one shared 1MB default cap and
    // reports the overflow as ENOBUFS after killing the child -- a shape
    // identical to an outside kill. A verbose failing mutant run sat near that
    // cap locally and over it on CI, dying deterministically on CI while
    // passing locally. runGateCommand redirects to per-run files instead, so
    // output volume can never fake a kill again.
    it("completes a run whose combined output exceeds the 1MB buffer cliff", () => {
      const result = probe(`
        import { mkdtempSync } from "node:fs";
        import { tmpdir } from "node:os";
        import { join } from "node:path";
        import { runGateCommand } from ${JSON.stringify(runtime)};
        const logDir = mkdtempSync(join(tmpdir(), "gate-output-test-"));
        const run = runGateCommand({
          command: process.execPath,
          args: ["-e", "process.stdout.write('o'.repeat(600 * 1024)); process.stderr.write('e'.repeat(600 * 1024));"],
          cwd: ${JSON.stringify(root)},
          env: process.env,
          timeout: 60000,
          killSignal: "SIGKILL",
          logDir,
          label: "over-the-cliff",
        });
        console.log(JSON.stringify({
          status: run.status,
          signal: run.signal,
          error: run.error?.code ?? null,
          stdoutLength: run.stdout.length,
          stderrLength: run.stderr.length,
          stdoutHead: run.stdout.slice(0, 1),
          stderrTail: run.stderr.slice(-1),
        }));
      `) as { status: number | null; signal: string | null; error: string | null; stdoutLength: number; stderrLength: number; stdoutHead: string; stderrTail: string };

      // 600KB + 600KB would ENOBUFS through spawnSync's default buffer; here
      // the run completes on its own with every byte captured.
      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.error).toBeNull();
      expect(result.stdoutLength).toBe(600 * 1024);
      expect(result.stderrLength).toBe(600 * 1024);
      expect(result.stdoutHead).toBe("o");
      expect(result.stderrTail).toBe("e");
    });

    it("tails very large output instead of loading it all", () => {
      const result = probe(`
        import { mkdtempSync } from "node:fs";
        import { tmpdir } from "node:os";
        import { join } from "node:path";
        import { MUTATION_GATE_RUN_LOG_TAIL_BYTES, runGateCommand } from ${JSON.stringify(runtime)};
        const logDir = mkdtempSync(join(tmpdir(), "gate-output-test-"));
        const run = runGateCommand({
          command: process.execPath,
          args: ["-e", "process.stderr.write('e'.repeat(3 * 1024 * 1024)); process.stderr.write('ENDMARKER');"],
          cwd: ${JSON.stringify(root)},
          env: process.env,
          timeout: 60000,
          killSignal: "SIGKILL",
          logDir,
          label: "huge-output",
        });
        console.log(JSON.stringify({
          status: run.status,
          truncated: run.stderr.startsWith("[truncated"),
          hasEnd: run.stderr.includes("ENDMARKER"),
          stderrLength: run.stderr.length,
          cap: MUTATION_GATE_RUN_LOG_TAIL_BYTES,
        }));
      `) as { status: number | null; truncated: boolean; hasEnd: boolean; stderrLength: number; cap: number };

      // A wedged run spewing for the whole timeout must not OOM the gate, and
      // the summary the gate scores ("Test Files") prints at the END of a
      // completed run, so the tail is the part that matters.
      expect(result.status).toBe(0);
      expect(result.truncated).toBe(true);
      expect(result.hasEnd).toBe(true);
      expect(result.stderrLength).toBeLessThan(result.cap + 100);
    });

    it("still reports a nonzero exit through file redirection", () => {
      const result = probe(`
        import { mkdtempSync } from "node:fs";
        import { tmpdir } from "node:os";
        import { join } from "node:path";
        import { runGateCommand } from ${JSON.stringify(runtime)};
        const logDir = mkdtempSync(join(tmpdir(), "gate-output-test-"));
        const run = runGateCommand({
          command: process.execPath,
          args: ["-e", "console.log('Test Files  1 failed'); process.exit(3);"],
          cwd: ${JSON.stringify(root)},
          env: process.env,
          timeout: 60000,
          killSignal: "SIGKILL",
          logDir,
          label: "nonzero-exit",
        });
        const completed = run.signal === null && run.status !== null && run.stdout.includes("Test Files");
        console.log(JSON.stringify({ status: run.status, completed, stdout: run.stdout.trim() }));
      `) as { status: number | null; completed: boolean; stdout: string };

      expect(result.status).toBe(3);
      expect(result.completed).toBe(true);
      expect(result.stdout).toContain("Test Files  1 failed");
    });

    it("wires the gate's runTests through runGateCommand, not spawnSync", () => {
      const gateSource = readFileSync(gate, "utf8");
      const runTests = gateSource.slice(gateSource.indexOf("function runTests("));
      const body = runTests.slice(0, runTests.indexOf("\n}\n") + 3);
      expect(body).toContain("runGateCommand(");
      expect(body).not.toContain("spawnSync");
      expect(body).toContain("timeout,");
      expect(body).toContain("killSignal,");
    });
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
