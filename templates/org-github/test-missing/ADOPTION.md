# Test-missing adoption: one caller line per repo (TOG-24380)

Destination: the staged `test-missing/` files land in `TogetherWeOwn/.github`
(`test-missing-gate.yml` and `test-missing-required.yml` at
`.github/workflows/`, `blocker_test_checks.py` at `.github/scripts/`,
`ADOPTION.md` beside them as `TEST-MISSING-ADOPTION.md`). The public org
`.github` repo is the only home that serves every repo. An Operator applies
these files there after the source PR merges.

## Caller snippet (copy-paste)

```yaml
jobs:
  detect:
    name: Detect changed code or test files
    runs-on: [self-hosted, two-ephemeral] # or ubuntu-latest on GitHub-hosted repos
    timeout-minutes: 5
    outputs:
      relevant: ${{ steps.diff.outputs.relevant }}
    steps:
      - uses: actions/checkout@<pinned-sha> # v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - name: Compute whether code or test files changed
        id: diff
        env:
          GATE_PR_BASE: ${{ github.event.pull_request.base.sha }}
        run: |
          set -euo pipefail
          if [ -n "${GATE_PR_BASE:-}" ]; then
            git diff --name-only "${GATE_PR_BASE}" HEAD > changed.txt
          else
            git diff --name-only HEAD~1 HEAD > changed.txt || true
          fi
          relevant=$(python3 - <<'PY'
          suffixes = (".py", ".sh", ".js", ".ts", ".mjs")
          test_dirs = ("test", "tests", "__tests__")
          def is_test(p):
              parts = p.replace("\\", "/").split("/")
              name = parts[-1]
              stem = name.rsplit(".", 1)[0] if "." in name else name
              if name.startswith("test_") or stem.endswith("_test"):
                  return True
              return any(d in test_dirs for d in parts[:-1])
          def is_src(p):
              return not is_test(p) and p.lower().endswith(suffixes)
          try:
              with open("changed.txt") as h:
                  files = [l.strip() for l in h if l.strip()]
          except OSError:
              files = []
          print("true" if any(is_src(f) or is_test(f) for f in files) else "false")
          PY
          )
          echo "relevant=${relevant}" >> "${GITHUB_OUTPUT}"

  test-missing:
    name: test-missing
    needs: [detect]
    if: needs.detect.outputs.relevant == 'true'
    uses: TogetherWeOwn/.github/.github/workflows/test-missing-gate.yml@<pinned-sha>
    with:
      mode: warn # flip to enforcing once the FP rate is <5% over 20 PRs
    permissions:
      contents: read
```

Cross-repo `uses:` needs a pinned SHA, never a branch name. `timeout-minutes`
is rejected on `uses:` jobs by GitHub schema — the gate sets its own
per-job timeouts internally. Keep the `detect` + `needs:`/`if:` wiring:
docs-only PRs skip the gate instead of burning a runner, which is what the
CI change-gating policy (TOG-14912) requires of every heavy job.

## Feed `ci-ok` (one context, exactly once)

Add the caller job name (`test-missing`) to the repo's required aggregator
`needs:` list. `test-missing-ok` is the gate's only aggregator — never wire
an individual gate job into a required set. In `warn` mode `test-missing-ok`
always passes; findings land in the step summary and the
`test-missing-findings` artifact.

## Rollout: warn 24h, then required

1. Land the caller in `warn` (default). The workflow never fails the run for
   its own findings — every gate job sets `continue-on-error` in warn mode.
2. After 24h, read the `test-missing-findings` artifacts across PRs. Flip to
   `mode: enforcing` once the false-positive rate over the last 20 PRs
   measures under 5%.
3. The org ruleset (`../rulesets/test-missing-report-only.json`, then
   `test-missing-required.json`) requires the wrapper workflow on every
   active repo, so the gate rides the existing required check — no
   branch-protection edit per repo.

## Exemptions

Add the `tests-exempt` label to waive the src-without-tests gate (docs-only
changes pass without the label). Changed-line coverage and test-guard
(vacuity) checks always run on changed test files.
