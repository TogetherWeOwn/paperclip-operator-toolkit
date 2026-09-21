import { copyFile, cp, mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

// The job and step that actually execute this gate on the private runner.
// TOG-2789: the refusal first named `Offline suites`, which never runs this
// plugin's mutants — that job runs the repo-level verification/*-mutation-gate.sh
// set. An agent told to cite a job that cannot hold the evidence has no
// alternative to running the gate locally, which is the storm this refusal
// exists to stop. `mutation-gate-runtime.spec.ts` pins both names to ci.yml.
export const MUTATION_GATE_CI_JOB = "model-selection suite";
export const MUTATION_GATE_CI_STEP = "Kill named selection mutants";
export const MUTATION_GATE_CI_MESSAGE = `run on CI (private runner) — cite the PR's "${MUTATION_GATE_CI_JOB}" job, step "${MUTATION_GATE_CI_STEP}"`;

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
// clean sweep while testing nothing (TOG-2980: an unmutated run from the copy
// exited 1 on `.github/workflows/ci.yml`, making `18/18 killed` meaningless).
// This list is the fix; `isolated baseline` in mutation-gate.mjs is what keeps
// it honest, because a new out-of-copy dependency fails there rather than
// silently passing here.
//
// TOG-3030: that honesty has now been paid out once. `test/fixtures/orgdb/
// schema.sql` is read by `context-lookup.spec.ts`, which did not exist on this
// branch — it arrived from main in the merge-forward (TOG-870, #205). The gate
// went red on the isolated baseline at 21s, before the first mutant, rather
// than inflating to a clean 20/20 on an unstaged fixture. Expect this list to
// need an entry whenever main adds an out-of-plugin read; the
// "stages every repo file the suite reads from outside the plugin" spec names
// the missing path, so the fix is mechanical.
// TOG-3049: `CONTRIBUTING.md` is read by tests/fixture-scan-control/
// nested-out-of-plugin-read.spec.ts, a spec deliberately nested one directory
// under tests/ so the scan test proves it walks subdirectories and resolves
// `../` depth relative to each spec's own location, not a fixed count.
export const MUTATION_TREE_REPO_FIXTURES = Object.freeze([
  "ops/tog-2138/gate_harness.py",
  ".github/workflows/ci.yml",
  "test/fixtures/orgdb/schema.sql",
  "CONTRIBUTING.md",
]);

export async function stageRepoFixtures(repoRoot, scratchRoot, fixtures = MUTATION_TREE_REPO_FIXTURES) {
  for (const relativePath of fixtures) {
    const target = join(scratchRoot, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(repoRoot, relativePath), target);
  }
}

export async function runSequentially(items, run) {
  for (const item of items) {
    await run(item);
  }
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
// TOG-3129: the default used to be conditional — `if (env.CI !== "true")` — so
// the cap applied everywhere EXCEPT the one context the refusal above permits.
// `ci.yml` sets no VITEST_* for the `model-selection suite` job, and that job
// runs on `[self-hosted, two-selfhosted]`, so bare `{ CI: "true" }` produced
// `run --pool=forks` with no bound: an uncapped fan-out on a shared runner, on
// 100% of the runs that can actually happen. The cap is now unconditional and
// an explicit VITEST_MAX_FORKS/VITEST_MAX_THREADS still wins over it.
export const MUTATION_GATE_DEFAULT_FORKS = 2;

// TOG-3129. A single wedged run must not be able to spend the whole job budget.
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
