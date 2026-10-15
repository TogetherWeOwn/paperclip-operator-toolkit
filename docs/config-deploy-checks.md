# Shared config/deploy checks (org level)

Deterministic checks for the config/deploy class of deploy blockers.
Defined **once**, consumed by every repo. Per-repo files are not allowed
except the tiny caller workflow.

## What runs

Checker: `config_deploy_check.py` at this repo's root (stdlib only,
offline), staged verbatim at
`templates/org-github/config-deploy/config_deploy_check.py`.
Reusable workflow: `templates/org-github/config-deploy/config-deploy.yml`
(`workflow_call`), staged for the org `.github` repository. It checks out
the calling repo for analysis and checks out the `.github` repo separately
for the shared checker. The checker digest is verified before execution, so a
caller-controlled `checker_ref` cannot substitute arbitrary code. Both
workflows use GitHub-hosted runners; a separate host-context workflow ensures
the `.github` repo itself produces the required composite check context.

Consumer: copy `templates/org-github/config-deploy/caller-workflow.yml`
to a repo as `.github/workflows/config-deploy.yml`. The caller contains the
explicit `CONFIG_DEPLOY_ORG_GITHUB_SHA` rollout marker in both its reusable
workflow pin and `checker_ref` input. Only after the reusable workflow and
checker are released in `TogetherWeOwn/.github`, replace both markers with
the same real 40-character SHA (one identical commit in both refs). The
placement gate keeps the marker in
the staged template and rejects the prior private-repository pin; do not
apply the template to consumers while the marker remains.

| Check | Code | Catches |
|---|---|---|
| Wrangler parse/name/compat-date/main | `WRANGLER_*` | broken or unnamed Worker config before deploy |
| Compose services + image pin | `COMPOSE_*` | empty compose, mutable `:latest` deploys |
| Env/secret name contract | `ENV_*` | lowercase keys, secrets committed in examples, undeclared Worker vars |
| Workflow lint | `WORKFLOW_*` | missing job timeouts, unpinned actions |
| Required-check stability | `REQUIRED_CHECK_*` | ruleset names a check no job produces |

Fail-closed: a tree with zero measured files exits 2, never 0. Malformed
JSON shapes are findings, never crashes. Required-check matching accepts
exact, reusable-workflow, matrix, and dynamic job contexts. Reusable-workflow
matching is best-effort: it accepts a non-empty `caller / inner-job` context
because the referenced workflow's internal jobs are unavailable to this offline
checker.

## Org rollout

1. Stage the reusable workflow, host-context workflow and verbatim checker
   into `TogetherWeOwn/.github` and merge that repository change.
2. Record its merge SHA, replace both caller markers with that exact SHA,
   and copy the caller into each consumer repo (one PR each, or via the repo
template for new repos). Verify the reported check context is
   `config-deploy / config-deploy`.
3. Only after every in-scope consumer reports that check, have the Operator
   (org admin) apply `templates/org-github/config-deploy/org-ruleset.json`
   once via `POST /orgs/TogetherWeOwn/rulesets`. The ruleset requires only
   `config-deploy / config-deploy`; it deliberately does not turn on merge
   queues or modify unrelated branch-protection policy. The caller also handles
   `merge_group` checks so it can run with an existing queue. It excludes this
   toolkit because it does not use the caller.
4. Host scripts must discover repos dynamically with one exclude list;
   no hardcoded repo lists.

The checker/templates PR does not itself modify the org repository or apply
the org ruleset. Both are separate, reviewed rollout actions.

## Coverage

The acceptance suites are `test_config_deploy_check.py` and
`test_config_deploy_placement.sh`; both are wired into this repo's CI.
