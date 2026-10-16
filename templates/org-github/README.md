# Staged org-level GitHub files

Files staged here are public templates. An operator applies each one once
to its destination; consumer repos never copy the checker logic.

This tree stages org-level additions for the `TogetherWeOwn/.github`
repo. Our credential scope does not cover that repo, so an Operator
applies these files there after this change merges. Nothing here is
live by existing in this repo; each file reaches its destination only
through the apply path in the maps below.

It currently stages these independent additions:

- the **config-deploy shared checks**;
- the **test-missing gate** (reusable workflow + wrapper + ruleset twins);
- the **blocker-ledger classes 4-7 gates** (four reusable workflows +
  wrappers + ruleset twins; see below);
- the **SDLC 1.0 shared CI/policy foundation stage** (baseline ruleset
  twins, exclude list, discovery, repo template, decision + runbook).

## config-deploy shared checks

| Staged file | Destination | Applied by |
| --- | --- | --- |
| `config-deploy/config-deploy.yml` | Org `.github` repository, `.github/workflows/config-deploy.yml` (reusable `workflow_call` workflow) | Operator |
| `config-deploy/caller-workflow.yml` | Each consumer repo, `.github/workflows/config-deploy.yml` (the only per-repo file; replace both `CONFIG_DEPLOY_ORG_GITHUB_SHA` markers with the same merged `.github` commit SHA first) | Repo maintainer |
| `config-deploy/config_deploy_check.py` | Org `.github` repository, `.github/scripts/config_deploy_check.py` (verbatim copy of the root `config_deploy_check.py` in this repo; fix upstream here, then re-copy) | Operator |
| `config-deploy/org-ruleset.json` | Org rulesets API, applied once after every in-scope consumer reports the expected check | Operator (org admin) |

The reusable workflow checks out the consumer repo for analysis and the
`.github` repo at the caller's pinned SHA for the shared checker. It verifies
the checker digest before execution, so a caller cannot substitute arbitrary
code through `checker_ref`. The workflow takes no mode input and always runs
in error mode, so a pull request cannot weaken the gate by editing the caller.
Both workflows use GitHub-hosted runners. The caller markers are intentionally
not a usable release pin until that central commit exists. The `.github`
policy repo and `replay-*` mirrors are excluded from the ruleset (mirroring
the single exclude list in `sdlc-foundation/repo-exclude-list.txt`), so no
host-context workflow is staged. The ruleset does not enable merge queues,
lock renames, or change unrelated branch-protection policy; the caller
supports existing merge queues via `merge_group`.

The rollout, check catalogue and fail-closed contract are documented in
`docs/config-deploy-checks.md` in this repo.

## Blocker-ledger classes 4-7 gates

Staged source for the org `TogetherWeOwn/.github` repo. Our credential
scope does not cover that repo, so an Operator applies these files there
after this PR merges.

### Destination map

| This file | Goes to (in `TogetherWeOwn/.github`) |
|---|---|
| `blocker-classes47/migration-gate.yml` | `.github/workflows/blocker-migration-gate.yml` (reusable `workflow_call`) |
| `blocker-classes47/migration-required.yml` | `.github/workflows/blocker-migration-required.yml` (thin `pull_request` + `merge_group` wrapper) |
| `blocker-classes47/blocker_migration_checks.py` | repo-root `blocker-classes47/blocker_migration_checks.py` in the org repo (imported by the gate from the logic checkout; verbatim of the repo-root module — fix upstream, then re-copy) |
| `blocker-classes47/api-contract-gate.yml` | `.github/workflows/blocker-api-contract-gate.yml` (reusable `workflow_call`) |
| `blocker-classes47/api-contract-required.yml` | `.github/workflows/blocker-api-contract-required.yml` (thin `pull_request` + `merge_group` wrapper) |
| `blocker-classes47/blocker_api_contract_checks.py` | repo-root `blocker-classes47/blocker_api_contract_checks.py` in the org repo (imported by the gate from the logic checkout; verbatim of the repo-root module — fix upstream, then re-copy) |
| `blocker-classes47/concurrency-gate.yml` | `.github/workflows/blocker-concurrency-gate.yml` (reusable `workflow_call`) |
| `blocker-classes47/concurrency-required.yml` | `.github/workflows/blocker-concurrency-required.yml` (thin `pull_request` + `merge_group` wrapper) |
| `blocker-classes47/blocker_concurrency_checks.py` | repo-root `blocker-classes47/blocker_concurrency_checks.py` in the org repo (imported by the gate from the logic checkout; verbatim of the repo-root module — fix upstream, then re-copy) |
| `blocker-classes47/lockfile-gate.yml` | `.github/workflows/blocker-lockfile-gate.yml` (reusable `workflow_call`) |
| `blocker-classes47/lockfile-required.yml` | `.github/workflows/blocker-lockfile-required.yml` (thin `pull_request` + `merge_group` wrapper) |
| `blocker-classes47/blocker_lockfile_checks.py` | repo-root `blocker-classes47/blocker_lockfile_checks.py` in the org repo (imported by the gate from the logic checkout; verbatim of the repo-root module — fix upstream, then re-copy) |
| `blocker-classes47/ADOPTION.md` | adoption guide (caller snippets, warn mode, single-context wiring) |
| `rulesets/blocker-classes47-report-only.json` | org ruleset payload, stage 1 (`evaluate`); applied via `gh api`, not copied |
| `rulesets/blocker-classes47-required.json` | org ruleset payload, stage 2 (`active`, no earlier than 24h after stage 1); applied via `gh api`, not copied |

## Test-missing gate

Staged source for the org `TogetherWeOwn/.github` repo. The gate logic
is public, stdlib-only code: the canonical source is the repo-root
`blocker_test_checks.py`, and the staged copy under `test-missing/` is
verbatim — fix the root source first, then re-copy, never hand-edit
the copy.

### Destination map

| This file | Goes to (in `TogetherWeOwn/.github`) |
|---|---|
| `test-missing/test-missing-gate.yml` | `.github/workflows/test-missing-gate.yml` (reusable `workflow_call`, warn default) |
| `test-missing/test-missing-required.yml` | `.github/workflows/test-missing-required.yml` (thin `pull_request` + `merge_group` wrapper) |
| `test-missing/blocker_test_checks.py` | `.github/scripts/blocker_test_checks.py` (verbatim copy of the repo-root source; fix upstream, then re-copy) |
| `test-missing/ADOPTION.md` | `TEST-MISSING-ADOPTION.md` (repo root: caller snippet, ci-ok wiring, rollout) |
| `rulesets/test-missing-report-only.json` | org ruleset payload, stage 1 (`evaluate`); applied via `gh api`, not copied |
| `rulesets/test-missing-required.json` | org ruleset payload, stage 2 (`active`, no earlier than 24h after stage 1); applied via `gh api`, not copied |

The ruleset payloads are never copied as files; an org admin applies them
with `gh api`. The two payloads differ only in `enforcement`, so the flip
from report-only to required smuggles in no rule change. This repo's own
warn-only caller is deliberately NOT part of this change: the staged pin
names no commit containing the reusable workflow, and GitHub resolves
called workflows at parse time, so landing a caller now would fail the
whole workflow on every PR (0 jobs, "workflow not found").

Stage 1 is also the resolution proof for the wrapper's `./` call to the
co-landed gate: both files land together in `TogetherWeOwn/.github`, so the
relative call resolves inside that repo. The Operator confirms the required
check resolves (rather than reporting 'workflow not found') during stage 1
`evaluate` before any stage 2 `active` flip; on a resolution failure the
wrapper is repinned to the full
`TogetherWeOwn/.github/.github/workflows/test-missing-gate.yml@<sha>` form.

After applying the staged gate to the org repo, the follow-up PR adds the
caller at `.github/workflows/test-missing.yml`, pinned to the org-repo
merge SHA that first contains `test-missing-gate.yml` — a pinned SHA,
never a moving tag.

### Local verification (no credentials)

```sh
python3 -B -m unittest test_test_missing_gate
bash test_test_missing_gate_placement.sh
```

Rollback: revert the commit that added this staging directory; no ruleset
or credential change is part of this change.

## SDLC 1.0 shared CI/policy foundation stage

This section stages the org SDLC baseline for adoption: the evaluate/active
ruleset twins, the one repo exclude list, dynamic repo discovery, the
day-1 repo template, the central-repo decision and the operator runbook.

### Destination map

| Staged file | Destination |
| --- | --- |
| `rulesets/sdlc-baseline-evaluate.json` | org SDLC baseline ruleset, stage 1 (`evaluate`); applied via `gh api`, not copied |
| `rulesets/sdlc-baseline-active.json` | org SDLC baseline ruleset, stage 2 (`active`, no earlier than 24h after stage 1 + pre-flip audit); applied via `gh api`, not copied |
| `rulesets/SDLC-BASELINE-RUNBOOK.md` | reference only (stays here; exact admin commands, exclude injection, rename-trap procedure, rollback) |
| `sdlc-foundation/DECISION-central-repo.md` | reference only (stays here; why `.github` is the central repo, no `ci-shared`, responsibility split) |
| `sdlc-foundation/repo-exclude-list.txt` | reference only (stays here; THE one exclude list, injected into ruleset payloads + read by discovery) |
| `sdlc-foundation/discover-repos.sh` | reference only (stays here; dynamic `gh repo list` minus excludes for host scripts) |
| `sdlc-foundation/BOOTSTRAP-new-repo.md` | reference only (stays here; template-repo creation + day-1 per-repo steps) |
| `sdlc-foundation/repo-template/ci.yml` | new public `repo-template` repo as `.github/workflows/ci.yml` (pins filled at creation) |
| `sdlc-foundation/repo-template/pr-lint.yml` | new public `repo-template` repo as `.github/workflows/pr-lint.yml` (the baseline's required `pr-lint` producer; copied from the org workflow template, which GitHub never applies automatically) |
| `sdlc-foundation/repo-template/CODEOWNERS` | new public `repo-template` repo as `.github/CODEOWNERS` (owning team filled at creation) |
| `sdlc-foundation/repo-template/policy-bot.yml.disabled` | new public `repo-template` repo, renamed to `.github/policy-bot.yml` only after risk lanes leave advisory shadow |
| `sdlc-foundation/repo-template/STAGING-MIGRATE-CONTRACT.md` | new public `repo-template` repo (day-1 contract) |
| `tests/test_sdlc_foundation.sh` | reference only (stays here; structural contract for everything above) |

### Verify

```bash
./templates/org-github/tests/test_sdlc_foundation.sh
./test_sdlc_foundation_placement.sh
python3 -m unittest test_sdlc_foundation_acceptance
python3 -m unittest test_config_deploy_check
./test_config_deploy_placement.sh
```
