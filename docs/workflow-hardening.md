# Workflow hardening baseline

The workflow hardening contract runs in required Offline suites, using the
existing hash-pinned PyYAML parser. It complements immutable Action reference
checks; it is not a substitute for full static analysis.

## Current controls

- Every repository checkout explicitly disables credential persistence. These
  jobs consume local history or public source; none needs authenticated pushes.
- The failure summary passes `toJSON(needs)` through an environment variable,
  not a shell template. Job outputs can contain arbitrary quotes and shell
  metacharacters without becoming commands.
- `ci-ok` also receives result expressions through environment variables. Failed
  or cancelled dependencies remain fatal. A skipped change detector or either
  always-on scan remains fatal; intentionally skipped heavy suites remain valid.
- Release-lag and review-trigger keep their existing token grants, but only on
  the jobs that use them. Workflow defaults are read-only. Each non-contents
  permission has an inline explanation.
- A separate change-gating control rejects removal of the hardening test step.

Run the focused controls locally:

```sh
python3 scripts/test_workflow_hardening.py
python3 scripts/test_plugin_ci_wiring.py
bash test_ci_gating.sh
bash test-selfhosted-runner-gate.sh
bash test_ci_dark_steps.sh
```

The injection test executes the real workflow shell with synthetic job outputs
in an isolated environment and temporary canary path. Its positive control
reintroduces literal template interpolation and requires the canary to execute.
No credentials, API calls, production data or services are involved.

## Measured inventory

Offline zizmor 1.31.1, full auditor persona, eight workflow files:

| Rule | Main at `00f4edd` | After pinning and hardening |
| --- | ---: | ---: |
| unpinned-uses | 29 | 0 |
| artipacked | 15 | 0 |
| template-injection | 6 | 0 |
| undocumented-permissions | 3 | 0 |
| excessive-permissions | 2 | 0 |
| dangerous-triggers | 1 | 1 |
| misfeature | 1 | 1 |
| **Total** | **57** | **2** |

The original non-pinning inventory was 27 findings. Full auditor mode additionally
reports the custom Python shell in PR lint. Five result-template findings are
conservative auditor findings on enumerated/boolean values; removing shell
interpolation also closes that class without changing aggregation semantics.

The remaining `workflow_run` trigger needs a bounded follow-up that preserves
trusted, exact-head, exactly-once review delivery. PR lint's custom shell also
remains unchanged. Do not delete the review trigger merely to silence the
scanner, exclude a workflow, lower the persona/severity, or add suppressions.

A full static-analysis CI gate is deliberately **not yet enabled**: the complete
baseline still fails. The follow-up must first eliminate both residual findings,
then add an immutable/hash-verified, fail-closed scanner and executable positive
controls covering every workflow through required `ci-ok`.

Rollback is a reviewed revert. No repository protection changes or token grants
are needed for this slice.
