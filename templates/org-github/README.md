# Org `.github` additions: blocker-ledger classes 4-7 gates

Staged source for the org `TogetherWeOwn/.github` repo. Our credential
scope does not cover that repo, so an Operator applies these files there
after this PR merges.

## Destination map

| This file | Goes to (in `TogetherWeOwn/.github`) |
|---|---|
| `blocker-classes47/migration-gate.yml` | `.github/workflows/blocker-migration-gate.yml` (reusable `workflow_call`) |
| `blocker-classes47/migration-required.yml` | `.github/workflows/blocker-migration-required.yml` (thin `pull_request` + `merge_group` wrapper) |
| `blocker-classes47/blocker_migration_checks.py` | staged logic copy (verbatim of repo-root module; fix upstream, then re-copy) |
| `blocker-classes47/api-contract-gate.yml` | `.github/workflows/blocker-api-contract-gate.yml` (reusable `workflow_call`) |
| `blocker-classes47/api-contract-required.yml` | `.github/workflows/blocker-api-contract-required.yml` (thin `pull_request` + `merge_group` wrapper) |
| `blocker-classes47/blocker_api_contract_checks.py` | staged logic copy (verbatim of repo-root module; fix upstream, then re-copy) |
| `blocker-classes47/concurrency-gate.yml` | `.github/workflows/blocker-concurrency-gate.yml` (reusable `workflow_call`) |
| `blocker-classes47/concurrency-required.yml` | `.github/workflows/blocker-concurrency-required.yml` (thin `pull_request` + `merge_group` wrapper) |
| `blocker-classes47/blocker_concurrency_checks.py` | staged logic copy (verbatim of repo-root module; fix upstream, then re-copy) |
| `blocker-classes47/lockfile-gate.yml` | `.github/workflows/blocker-lockfile-gate.yml` (reusable `workflow_call`) |
| `blocker-classes47/lockfile-required.yml` | `.github/workflows/blocker-lockfile-required.yml` (thin `pull_request` + `merge_group` wrapper) |
| `blocker-classes47/blocker_lockfile_checks.py` | staged logic copy (verbatim of repo-root module; fix upstream, then re-copy) |
| `blocker-classes47/ADOPTION.md` | adoption guide (caller snippets, warn mode, single-context wiring) |
| `rulesets/blocker-classes47-report-only.json` | org ruleset payload, stage 1 (`evaluate`); applied via `gh api`, not copied |
| `rulesets/blocker-classes47-required.json` | org ruleset payload, stage 2 (`active`, no earlier than 24h after stage 1); applied via `gh api`, not copied |
