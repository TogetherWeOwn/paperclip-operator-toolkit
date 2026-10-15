# Staged org-level GitHub files

Files staged here are public templates. An operator applies each one once
to its destination; consumer repos never copy the checker logic.

| Staged file | Destination | Applied by |
| --- | --- | --- |
| `config-deploy/config-deploy.yml` | Org `.github` repository, `.github/workflows/config-deploy.yml` (reusable `workflow_call` workflow) | Operator |
| `config-deploy/caller-workflow.yml` | Each consumer repo, `.github/workflows/config-deploy.yml` (the only per-repo file) | Repo maintainer |
| `config-deploy/config_deploy_check.py` | Org `.github` repository, `.github/scripts/config_deploy_check.py` (verbatim copy of the root `config_deploy_check.py` in this repo; fix upstream here, then re-copy) | Operator |
| `config-deploy/org-ruleset.json` | Org rulesets API, applied once for the org | Operator (org admin) |

The rollout, check catalogue and fail-closed contract are documented in
`docs/config-deploy-checks.md` in this repo.
