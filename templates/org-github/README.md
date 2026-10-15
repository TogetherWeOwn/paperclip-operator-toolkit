# Staged org-level GitHub files

Files staged here are public templates. An operator applies each one once
to its destination; consumer repos never copy the checker logic.

| Staged file | Destination | Applied by |
| --- | --- | --- |
| `config-deploy/config-deploy.yml` | Org `.github` repository, `.github/workflows/config-deploy.yml` (reusable `workflow_call` workflow) | Operator |
| `config-deploy/host-context-workflow.yml` | Org `.github` repository, `.github/workflows/config-deploy-host-context.yml` (produces the required composite context on the host repo) | Operator |
| `config-deploy/caller-workflow.yml` | Each consumer repo, `.github/workflows/config-deploy.yml` (the only per-repo file; replace both `CONFIG_DEPLOY_ORG_GITHUB_SHA` markers with the same merged `.github` commit SHA first) | Repo maintainer |
| `config-deploy/config_deploy_check.py` | Org `.github` repository, `.github/scripts/config_deploy_check.py` (verbatim copy of the root `config_deploy_check.py` in this repo; fix upstream here, then re-copy) | Operator |
| `config-deploy/org-ruleset.json` | Org rulesets API, applied once after every in-scope consumer reports the expected check | Operator (org admin) |

The reusable workflow checks out the consumer repo for analysis and the
`.github` repo at the caller's pinned SHA for the shared checker. It verifies
the checker digest before execution, so a caller cannot substitute arbitrary
code through `checker_ref`. Both workflows use GitHub-hosted runners. The
caller markers are intentionally not a usable release pin until that central
commit exists. The host-context workflow ensures the `.github` repository
also produces the required `config-deploy / config-deploy` context. The
ruleset does not enable merge queues or change unrelated branch-protection
policy; the caller and host workflow both support existing merge queues.

The rollout, check catalogue and fail-closed contract are documented in
`docs/config-deploy-checks.md` in this repo.
