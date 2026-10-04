import { copyFile, cp, mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { spawnSync } from "node:child_process";

// The job and step that actually execute this gate on CI. The refusal names
// the mutants matrix, not the required suite job: the suite job only
// aggregates the shards' verdict and never runs the sweep itself, so an agent
// told to cite the suite has no evidence to cite and falls back to running
// the gate locally — the storm this refusal exists to stop.
// `mutation-gate-runtime.spec.ts` pins both names to ci.yml.
//
// The sweep is sharded, so the step lives in the `model-selection mutants`
// matrix (one job per shard) rather than in the required
// `model-selection suite` job, which only aggregates their verdict.
export const MUTATION_GATE_CI_JOB = "model-selection mutants";
export const MUTATION_GATE_CI_STEP = "Kill named selection mutants";
export const MUTATION_GATE_CI_MESSAGE = `run on CI (standard runner) — cite the PR's "${MUTATION_GATE_CI_JOB}" shard jobs, step "${MUTATION_GATE_CI_STEP}"`;

export function mutationGateAllowed(env = process.env) {
  return env.CI === "true" || env.MUTATION_GATE_LOCAL === "1";
}

export async function copyMutationTree(sourceRoot, targetRoot) {
  const sourceNodeModules = join(sourceRoot, "node_modules");
  await mkdir(dirname(targetRoot), { recursive: true });
  await cp(sourceRoot, targetRoot, {
    recursive: true,
    filter: (source) => source !== sourceNodeModules,
  });
  await symlink(sourceNodeModules, join(targetRoot, "node_modules"), "dir");
}

// Repo files the suite reads from OUTSIDE the plugin directory, via a
// `../../../` URL. Mutants run from a scratch copy rooted elsewhere, so any
// such file that is not staged makes its spec throw ENOENT — and the mutant
// loop scores every nonzero exit as a kill, so an unrunnable suite reports a
// clean sweep while testing nothing (an unmutated run from the copy
// exited 1 on `.github/workflows/ci.yml`, making `18/18 killed` meaningless).
// This list is the fix; `isolated baseline` in mutation-gate.mjs is what keeps
// it honest, because a new out-of-copy dependency fails there rather than
// silently passing here.
//
// That honesty has now been paid out once. `test/fixtures/orgdb/
// schema.sql` is read by `context-lookup.spec.ts`, which did not exist on this
// branch — it arrived from main in the merge-forward. The gate
// went red on the isolated baseline at 21s, before the first mutant, rather
// than inflating to a clean 20/20 on an unstaged fixture. Expect this list to
// need an entry whenever main adds an out-of-plugin read; the
// "stages every repo file the suite reads from outside the plugin" spec names
// the missing path, so the fix is mechanical.
// `CONTRIBUTING.md` is read by tests/fixture-scan-control/
// nested-out-of-plugin-read.spec.ts, a spec deliberately nested one directory
// under tests/ so the scan test proves it walks subdirectories and resolves
// `../` depth relative to each spec's own location, not a fixed count.
export const MUTATION_TREE_REPO_FIXTURES = Object.freeze([
  ".github/workflows/ci.yml",
  "test/fixtures/orgdb/schema.sql",
  "CONTRIBUTING.md",
]);

export async function stageRepoFixtures(repoRoot, scratchRoot, fixtures = MUTATION_TREE_REPO_FIXTURES) {
  for (const relativePath of fixtures) {
    const target = join(scratchRoot, relativePath);
    // Mirror the checkout. The isolated baseline must establish whether the
    // suite can run with the available repository fixtures; absence must not
    // manufacture successful mutant kills.
    if (!existsSync(join(repoRoot, relativePath))) continue;
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(repoRoot, relativePath), target);
  }
}

export async function runSequentially(items, run) {
  for (const item of items) {
    await run(item);
  }
}

// `MUTATION_SHARD=i/N` splits the sweep across N independent jobs. Three
// properties are the whole contract, and each has a spec:
//   * COVERAGE: for any N, the N shards are pairwise disjoint and their union is
//     the whole list — a mutant that falls between shards is a mutant nobody
//     kills, which reads as a green sweep that tested less than it claims.
//   * LOUD: unset means "not sharded" (the gate runs everything, as before), but
//     a value that is present and malformed THROWS. A workflow expression that
//     resolves empty must never degrade into "run everything" (silently serial
//     again) or "run nothing" (silently green).
//   * ROUND-ROBIN: `index % N == i - 1`, so a mutant block that is expensive
//     because it was added together does not land on one shard.
export function parseMutationShard(spec) {
  if (spec === undefined || spec === null) return null;
  const text = `${spec}`.trim();
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(text);
  if (match === null) {
    throw new Error(`invalid MUTATION_SHARD ${JSON.stringify(`${spec}`)}: expected "i/N" with 1 <= i <= N (e.g. "3/8")`);
  }
  const index = Number.parseInt(match[1], 10);
  const total = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total) {
    throw new Error(`invalid MUTATION_SHARD ${JSON.stringify(text)}: shard index must satisfy 1 <= i <= N`);
  }
  return { index, total };
}

export function selectMutationShard(items, shard) {
  if (shard === null || shard === undefined) return [...items];
  return items.filter((_, position) => position % shard.total === shard.index - 1);
}

// Vitest 2.1.9 DOES read both variables — resolveConfig applies
// VITEST_MAX_THREADS to poolOptions.threads/vmThreads and VITEST_MAX_FORKS to
// poolOptions.forks/vmForks. What makes an env-only cap useless here is which
// pool those land on: the same file resolves `pool ??= "threads"`, and this
// plugin's vitest.config.ts sets no `pool`, so VITEST_MAX_FORKS was capping a
// fork pool that never ran. Measured on the 8-core host with the CI refusal
// lifted, that env-only configuration still peaked at 10 concurrent vitest
// processes and was killed by memguard before finishing — the storm this card
// exists to stop.
//
// So the invocation pins `--pool=forks` AND translates the limit into explicit
// flags. Either alone would be fragile: the flags without the pool would cap an
// idle pool again, and the env var without the flags depends on a config
// default that is not ours to hold still.
// The default used to be conditional — `if (env.CI !== "true")` — so
// the cap applied everywhere EXCEPT the one context the refusal above permits.
// `ci.yml` sets no VITEST_* for the `model-selection suite` job, and that job
// runs on `[self-hosted, two-selfhosted]`, so bare `{ CI: "true" }` produced
// `run --pool=forks` with no bound: an uncapped fan-out on a shared runner, on
// 100% of the runs that can actually happen. The cap is now unconditional and
// an explicit VITEST_MAX_FORKS/VITEST_MAX_THREADS still wins over it.
export const MUTATION_GATE_DEFAULT_FORKS = 2;

// A single wedged run must not be able to spend the whole job budget.
// `spawnSync` with no `timeout` blocks forever, so one hung mutant consumed
// `timeout-minutes` and the job died with an opaque "cancelled" and no mutant
// name — the aggregate budget was the only bound on an individual run. Each run
// is now bounded on its own, and `completed()` in mutation-gate.mjs already
// reads the resulting `{ status: null, signal: ... }` as BROKEN GATE, so a
// wedge now fails loudly AND names the mutant that wedged.
//
// 10 minutes is a wedge detector, not a performance budget: a healthy run of
// this suite is ~13 s wall at maxForks=2 (35 files / 591 tests), so this is
// ~45x headroom and cannot fire on a merely slow runner.
export const MUTATION_GATE_RUN_TIMEOUT_MS = 10 * 60 * 1000;

// Returns a positive integer, never null. An empty, absent, zero or unparseable
// value falls back to the default rather than to "unbounded" — `VITEST_MAX_FORKS:
// ${{ ... }}` resolving empty in a workflow is a realistic way to get `""`, and
// the old code turned that into no flags at all. There is deliberately no way to
// ask this gate for an uncapped run; that configuration is the defect.
function forkLimit(env) {
  for (const raw of [env.VITEST_MAX_FORKS, env.VITEST_MAX_THREADS]) {
    const limit = Number.parseInt(raw ?? "", 10);
    if (Number.isInteger(limit) && limit > 0) return limit;
  }
  return MUTATION_GATE_DEFAULT_FORKS;
}

export function mutationGateVitestInvocation(env = process.env) {
  const limit = forkLimit(env);

  // Both halves carry the SAME resolved number: the flags are what actually
  // bind (see the note above on the idle-pool trap), and the env vars keep any
  // nested vitest the suite itself spawns on the same budget.
  const childEnv = { ...env, VITEST_MAX_FORKS: `${limit}`, VITEST_MAX_THREADS: `${limit}` };

  const args = [
    "node_modules/vitest/vitest.mjs",
    "run",
    // No results cache. The gate scores each run from process exit/stdout,
    // never from the cache — and a nested vitest resolving its results file
    // through a root-owned shared install dies on write even when the tests
    // themselves pass. `--cache=false` isolates the run without chowning
    // shared node_modules and without waiving the suite; CI (writable
    // workspace) is unaffected either way.
    "--cache=false",
    "--pool=forks",
    `--poolOptions.forks.maxForks=${limit}`,
    "--poolOptions.forks.minForks=1",
    `--maxWorkers=${limit}`,
  ];

  return {
    args,
    env: childEnv,
    timeout: MUTATION_GATE_RUN_TIMEOUT_MS,
    killSignal: "SIGKILL",
  };
}

// How much of a run's captured output the gate keeps in memory for scoring
// and failure printing. Full logs always land on disk; only the in-memory
// copy is tailed.
export const MUTATION_GATE_RUN_LOG_TAIL_BYTES = 1024 * 1024;

let gateRunCounter = 0;

function readLogTail(path) {
  const fd = openSync(path, "r");
  try {
    const { size } = fstatSync(fd);
    if (size <= MUTATION_GATE_RUN_LOG_TAIL_BYTES) return readFileSync(path, "utf8");
    const length = MUTATION_GATE_RUN_LOG_TAIL_BYTES;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return `[truncated ${size} bytes to the last ${length}]\n${buffer.toString("utf8")}`;
  } finally {
    closeSync(fd);
  }
}

// Run one gate command with stdout/stderr redirected to per-run log files,
// never buffered through spawnSync.
//
// spawnSync buffers both streams against a single shared 1MB default cap and
// reports the overflow as `error.code === "ENOBUFS"` after killing the child
// with the configured kill signal — a shape (`status: null, signal:
// SIGKILL`) identical to an outside kill or the per-run timeout. One mutant
// whose failing specs print large assertion diffs sat at ~75% of that cap
// locally and over it on CI, so the same healthy run died deterministically
// at the same second on every CI attempt while passing locally. Redirecting
// to files removes the cliff entirely: a run now only fails to complete when
// it really was killed or wedged, which is what the retry and the BROKEN
// GATE paths are for. The returned shape matches spawnSync's (`status`,
// `signal`, `error`, `stdout`, `stderr`) plus the log paths, so existing
// scoring keeps working unchanged.
export function runGateCommand({ command, args, cwd, env, timeout, killSignal, logDir, label }) {
  gateRunCounter += 1;
  const tag = `${String(gateRunCounter).padStart(3, "0")}-${label}`;
  mkdirSync(logDir, { recursive: true });
  const stdoutPath = join(logDir, `${tag}.stdout.log`);
  const stderrPath = join(logDir, `${tag}.stderr.log`);
  const outFd = openSync(stdoutPath, "w");
  const errFd = openSync(stderrPath, "w");
  let result;
  try {
    result = spawnSync(command, args, {
      cwd,
      env,
      timeout,
      killSignal,
      stdio: ["ignore", outFd, errFd],
    });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: readLogTail(stdoutPath),
    stderr: readLogTail(stderrPath),
    stdoutPath,
    stderrPath,
  };
}
