# Model-selection review runbook

The model-selection mutation gate runs the full Vitest suite once for the baseline and once per named mutant. It belongs on the private CI runner, not on the shared Paperclip host.

## Local review

Run only the spec that covers the changed behavior, with a bounded forks pool:

```bash
cd plugins/model-selection
npm test -- tests/<changed>.spec.ts --pool=forks --maxWorkers=2
```

Do not run `npm run verify` or `npm run test:mutants` locally. Both commands refuse unless `CI=true` or the operator deliberately sets `MUTATION_GATE_LOCAL=1`.

## Mutation evidence

For a PR review, cite:

1. the exact commit SHA reviewed; and
2. the PR's **model-selection suite** job, step `Kill named selection mutants` — the only place in CI that executes this plugin's mutants.

A local mutation-gate transcript is not required review evidence. The private runner is the canonical execution environment.

Do **not** cite **Offline suites** for this plugin. That job runs the repo-level `verification/*-mutation-gate.sh` set; it never invokes `plugins/model-selection/scripts/mutation-gate.mjs`, so it cannot carry this evidence either way it lands. A `grep mutation-gate.mjs .github/workflows/ci.yml` returns `0` and is *not* evidence the gate is unwired — CI reaches it one level of indirection away, through `npm run test:mutants`.

## Explicit local override

`MUTATION_GATE_LOCAL=1` exists for deliberate diagnostics only. Outside CI, the gate defaults both `VITEST_MAX_FORKS` and `VITEST_MAX_THREADS` to `2`, uses `--pool=forks`, and runs mutant callbacks strictly one at a time. Existing values for either worker variable are preserved. Mutants are applied to an isolated temporary plugin copy, never to tracked source files.

Vitest 2.1.9 **does** read both variables, but `VITEST_MAX_FORKS` only reaches `poolOptions.forks`, and the resolved pool defaults to `threads` — which this plugin's `vitest.config.ts` does not override. An env-only cap therefore bounded a fork pool that never ran: measured on the 8-core host, it still peaked at 10 concurrent vitest processes and was killed by memguard before finishing. The gate now pins `--pool=forks` *and* translates the limit into `--poolOptions.forks.maxForks`, `--poolOptions.forks.minForks=1` and `--maxWorkers`, so the cap binds the pool actually in use rather than depending on a config default that is not ours to hold still. Measured with the flags on the same host: peak **4** concurrent vitest processes, 18/18 killed in **7.8 min** (two baselines plus 18 sequential mutants).

## The isolated baseline is a positive control, not a formality

Mutants run from a scratch copy of the plugin, and the loop scores **every** nonzero exit as a kill. So a suite that cannot run from that copy at all reports a clean sweep while testing nothing. This is not hypothetical: `tests/mutation-gate-runtime.spec.ts` reads `../../../.github/workflows/ci.yml`, which was never staged into the copy, so an unmutated run there exited 1 with `ENOENT` and a reported `18/18 killed` was measuring the missing file, not the mutations. The first baseline could not see it because it runs in the source tree.

The gate now stages `MUTATION_TREE_REPO_FIXTURES` and re-runs the **unmutated** suite from the copy before applying any mutant, aborting with `BROKEN GATE` if it is red. **Every kill count is only meaningful relative to that baseline being green.** If you add a spec that reads a repo file outside the plugin, add it to that list — `tests/mutation-gate-runtime.spec.ts` derives the expected set from the specs themselves and will fail until you do.
