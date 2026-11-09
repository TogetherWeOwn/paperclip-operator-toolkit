import { copyFile, cp, mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

// The job and step that actually execute this gate on the private runner.
// : the refusal first named `Offline suites`, which never runs this
// plugin's mutants — that job runs the repo-level verification/*-mutation-gate.sh
// set. An agent told to cite a job that cannot hold the evidence has no
// alternative to running the gate locally, which is the storm this refusal
// exists to stop. `mutation-gate-runtime.spec.ts` pins both names to ci.yml.
//
// : the sweep is sharded, so the step now lives in the
// `model-selection mutants` matrix (one job per shard) rather than in the
// required `model-selection suite` job, which only aggregates their verdict.
export const MUTATION_GATE_CI_JOB = "model-selection mutants";
export const MUTATION_GATE_CI_STEP = "Kill named selection mutants";
export const MUTATION_GATE_CI_MESSAGE = `run on CI (private runner) — cite the PR's "${MUTATION_GATE_CI_JOB}" shard jobs, step "${MUTATION_GATE_CI_STEP}"`;

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
// clean sweep while testing nothing (: an unmutated run from the copy
// exited 1 on `.github/workflows/ci.yml`, making `18/18 killed` meaningless).
// This list is the fix; `isolated baseline` in mutation-gate.mjs is what keeps
// it honest, because a new out-of-copy dependency fails there rather than
// silently passing here.
//
// : that honesty has now been paid out once. `test/fixtures/orgdb/
// schema.sql` is read by `context-lookup.spec.ts`, which did not exist on this
// branch — it arrived from main in the merge-forward (, #205). The gate
// went red on the isolated baseline at 21s, before the first mutant, rather
// than inflating to a clean 20/20 on an unstaged fixture. Expect this list to
// need an entry whenever main adds an out-of-plugin read; the
// "stages every repo file the suite reads from outside the plugin" spec names
// the missing path, so the fix is mechanical.
// : `CONTRIBUTING.md` is read by tests/fixture-scan-control/
// nested-out-of-plugin-read.spec.ts, a spec deliberately nested one directory
// under tests/ so the scan test proves it walks subdirectories and resolves
// `../` depth relative to each spec's own location, not a fixed count.
// : `tests/fixtures/bridge/bridge-assembled-rows.json` is read by
// assembled-snapshot-freshness.spec.ts via `../../../` from the
// plugin tests dir; without staging, the isolated baseline throws ENOENT and
// the gate reports BROKEN GATE.
export const MUTATION_TREE_REPO_FIXTURES = Object.freeze([
  "ops/gate_harness.py",
  ".github/workflows/ci.yml",
  "test/fixtures/orgdb/schema.sql",
  "CONTRIBUTING.md",
  "tests/fixtures/bridge/bridge-assembled-rows.json",
]);

export async function stageRepoFixtures(repoRoot, scratchRoot, fixtures = MUTATION_TREE_REPO_FIXTURES) {
  for (const relativePath of fixtures) {
    const target = join(scratchRoot, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(repoRoot, relativePath), target);
  }
}

// . `MUTATION_SHARD=i/N` splits the sweep across N independent jobs.
// Three properties are the whole contract, and each has a spec:
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

export async function runSequentially(items, run) {
  for (const item of items) {
    await run(item);
  }
}

// Pin the pool AND an unconditional worker cap, including CI. The original
// env-only limit capped an idle pool while the default pool fanned out until
// memguard killed the run. Vitest 4 removed poolOptions and its per-pool limits;
// maxWorkers now caps the selected native pool. Keep accepting the old gate
// inputs, but translate them into the supported CLI and environment controls.
export const MUTATION_GATE_DEFAULT_FORKS = 2;

// . A single wedged run must not be able to spend the whole job budget.
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

// . `spawnSync` caps each of stdout and stderr at 1 MiB by default and,
// past that, SIGKILLs the child and reports `{ status: null, signal: "SIGKILL",
// error: ENOBUFS }` — byte for byte what a host OOM kill or a sibling sweeper
// looks like. A mutant the suite catches LOUDLY (the shard-split spec prints
// whole arrays for every failing size/N row) crossed that line in CI, so a
// mutant that was killed read as BROKEN GATE, twice, on the same mutant, on
// different runners. A real kill must never depend on how much the failing
// assertions print. 64 MiB is far above any failing run of this suite (~1.5 MB
// worst case) and still bounded, so a runaway writer ends as BROKEN GATE
// instead of exhausting the runner's memory.
export const MUTATION_GATE_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;

// Returns a positive integer, never null. An empty, absent, zero or unparseable
// value falls back to the default rather than to "unbounded" — `VITEST_MAX_FORKS:
// ${{ ... }}` resolving empty in a workflow is a realistic way to get `""`, and
// the old code turned that into no flags at all. There is deliberately no way to
// ask this gate for an uncapped run; that configuration is the defect.
function forkLimit(env) {
  for (const raw of [env.VITEST_MAX_FORKS, env.VITEST_MAX_THREADS, env.VITEST_MAX_WORKERS]) {
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
  // Vitest 4 replaced the pool-specific environment limits. Its config resolver
  // reads VITEST_MAX_WORKERS after CLI options, so overwrite a conflicting
  // inherited value as well as propagating the cap to nested runs.
  const childEnv = {
    ...env,
    VITEST_MAX_FORKS: `${limit}`,
    VITEST_MAX_THREADS: `${limit}`,
    VITEST_MAX_WORKERS: `${limit}`,
  };

  const args = [
    "node_modules/vitest/vitest.mjs",
    "run",
    // : no results cache. The gate scores each run from process
    // exit/stdout, never from the cache — and a nested vitest resolving
    // `node_modules/.vite/vitest/results.json` through a root-owned shared
    // install (package-root symlink chain) dies EACCES on write even when the
    // tests themselves pass (flag-probe: 1/1 pass, exit 1). `--cache=false`
    // isolates the run without chowning shared node_modules and without
    // waiving the suite; CI (writable workspace) is unaffected either way.
    "--cache=false",
    "--pool=forks",
    `--maxWorkers=${limit}`,
  ];

  return {
    args,
    env: childEnv,
    timeout: MUTATION_GATE_RUN_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: MUTATION_GATE_OUTPUT_LIMIT_BYTES,
  };
}
