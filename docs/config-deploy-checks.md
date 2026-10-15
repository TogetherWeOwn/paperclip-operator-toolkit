# Shared config/deploy checks (org level)

Deterministic checks for the config/deploy class of deploy blockers.
Defined **once**, consumed by every repo. Per-repo files are not allowed
except the tiny caller workflow.

## What runs

Checker: `config_deploy_check.py` at this repo's root (stdlib only,
offline), staged verbatim at
`templates/org-github/config-deploy/config_deploy_check.py`.
Reusable workflow: `templates/org-github/config-deploy/config-deploy.yml`
(`workflow_call`), staged for the org `.github` repository.
Consumer: copy `templates/org-github/config-deploy/caller-workflow.yml`
to a repo as `.github/workflows/config-deploy.yml`, pin the reviewed
release SHA, done. New repos start from the repo template carrying
that caller.

| Check | Code | Catches |
|---|---|---|
| Wrangler parse/name/compat-date/main | `WRANGLER_*` | broken or unnamed Worker config before deploy |
| Compose services + image pin | `COMPOSE_*` | empty compose, mutable `:latest` deploys |
| Env/secret name contract | `ENV_*` | lowercase keys, secrets committed in examples, undeclared Worker vars |
| Workflow lint | `WORKFLOW_*` | missing job timeouts, unpinned actions |
| Required-check stability | `REQUIRED_CHECK_*` | ruleset names a check no job produces |

Fail-closed: a tree with zero measured files exits 2, never 0. Malformed
JSON shapes are findings, never crashes.

## Org rollout (durable by default)

1. Merge the mirror PR. Note the merge SHA.
2. Repin `templates/org-github/config-deploy/caller-workflow.yml` to
   that SHA; an Operator stages the reusable workflow, the verbatim
   checker copy and the caller into their destinations (see
   `templates/org-github/README.md`), then copies the caller into each
   consumer repo (one PR each, or via the repo template for new repos).
3. Operator (org admin) applies
   `templates/org-github/config-deploy/org-ruleset.json` once via
   `POST /orgs/TogetherWeOwn/rulesets`. This makes `config-deploy` a
   required check on `main` in every repo (exclusions listed in the
   file). Agent tokens cannot write org rulesets, so this step is an
   operator action, not an agent action.
4. Host scripts must discover repos dynamically with one exclude list;
   no hardcoded repo lists.

## Coverage

Behavioural suite: `test_config_deploy_check.py` (run in this repo's
CI), including the reusable-caller timeout exemption (a caller job
cannot carry `timeout-minutes`). Placement suite:
`test_config_deploy_placement.sh` (also run in CI) pins the mirror
layout, the verbatim staged copy, the caller-pin regression and public
hygiene. The config/deploy blocker class is now covered by a
deterministic gate; AI review no longer spends rounds on these five
mechanical classes.
