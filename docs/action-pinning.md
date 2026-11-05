# Immutable GitHub Actions references

Every remote `uses:` in `.github/workflows/*.yml` or `*.yaml` must use a full
40-hex commit SHA. This includes job-level reusable workflow calls. Step-level
`docker://` references must use a full `sha256` digest. Repository-local `./`
references remain local and do not need a commit pin.

`python3 scripts/test_action_pins.py` checks the entire workflow directory and
runs positive controls for mutable tags, branches, short hashes, quoted/flow YAML,
reusable workflows and malformed/empty inputs. CI executes it in required
**Offline suites**, using the existing isolated, hash-pinned PyYAML installation.
All workflow changes admit that suite, including draft PRs. Unrelated docs-only
PRs can still skip the heavy suites; the always-on disclosure and secret scans
are unchanged. The independent change-gating test rejects removal of the pinning
step.

## Updating a pin

1. Resolve the intended upstream tag through the authenticated GitHub connection.
   Dereference annotated tags to their commit object. Verify that commit in the
   expected repository; a SHA's shape alone does not prove its provenance.
2. Replace the SHA and keep a version comment for review and Dependabot.
   Existing weekly GitHub Actions Dependabot updates remain enabled.
3. Run the pinning contract, runner-pool and change-gating suites:

   ```sh
   python3 scripts/test_action_pins.py
   bash test-selfhosted-runner-gate.sh
   bash test_ci_gating.sh
   python3 scripts/test_plugin_ci_wiring.py
   ```

   Locally, install `scripts/static-label-guard-requirements.txt` into an isolated
   directory with `--require-hashes --no-deps --only-binary=:all:` and put that
   directory on `PYTHONPATH`, as CI does. Do not install into the system Python.

## What this does not prove

Immutable references prevent a tag move from changing the selected Action code.
They do not attest the Action's code, recursively pin its dependencies, check
package vulnerabilities or certify that a dependency exploit is closed. A
version bump is not exploit verification. Those require their own scanner and
staging regression evidence. No production tests, host jobs, new credentials or
new permissions are introduced by this contract.

Rollback is a reviewed revert of the pinning change, not a skipped check or a
security-gate bypass.
