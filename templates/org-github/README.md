# Org `.github` additions: blocker-ledger classes 4-7 gates

Staged source for the org `TogetherWeOwn/.github` repo. Our credential
scope does not cover that repo, so an Operator applies these files there
after this PR merges.

## Destination map

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

# Org `.github` additions: SDLC 1.0 shared CI/policy foundation stage

This tree stages the org SDLC baseline for adoption: the evaluate/active
ruleset twins, the one repo exclude list, dynamic repo discovery, the
day-1 repo template, the central-repo decision and the operator runbook.
Nothing here is live by existing in this repo; each file reaches its
destination only through the apply path in the map below.

## Destination map

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

## Verify

```bash
./templates/org-github/tests/test_sdlc_foundation.sh
./test_sdlc_foundation_placement.sh
python3 -m unittest test_sdlc_foundation_acceptance
```
