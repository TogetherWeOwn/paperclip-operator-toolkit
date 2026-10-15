# Bootstrap: a new repo gets everything on day 1 (TOG-24386)

Stays in this repo; the Operator follows it when creating the public
template repo and when cutting a repo from it. No step runs from CI.

## One-time: create the template repo

1. Create public `TogetherWeOwn/repo-template` from the
   `sdlc-foundation/repo-template/` file set in this directory
   (`ci.yml` -> `.github/workflows/ci.yml`, plus `CODEOWNERS`,
   `policy-bot.yml.disabled`, `STAGING-MIGRATE-CONTRACT.md`). Scrub private
   card IDs from file content first; the staged headers name this card.
2. Mark it a template repository (Settings > Template repository).

## Per repo: cut from the template (zero per-repo setup)

1. Create with the template (owner: TogetherWeOwn, visibility per plan).
2. Fill the two pins in `.github/workflows/ci.yml` from live org main:
   `<PINNED_CHANGES_SHA>` and `<PINNED_GATE_SHA>` become the 40-hex commit
   SHAs of `.github/workflows/changes.yml` and
   `.github/workflows/tier-0-quality-gate.yml`. No `uses:` into the org repo
   may float on a branch name after this step.
3. Replace `<OWNING-TEAM>` in `.github/CODEOWNERS` with the owning team.
   Leave `policy-bot.yml.disabled` renamed until the risk-lanes track leaves
   advisory shadow (TOG-24383); the staging-migrate contract applies now.
4. Open a docs-only PR and a code PR. Acceptance: both show `ci-ok`,
   `pr-lint` and the tier-0 gate with no further setup; the docs-only PR
   skips heavy jobs with `ci-ok` green.
5. Merge queue: leave org custom property `merge_queue_ready` unset (false).
   Set it `true` only after all required producing workflows handle
   `merge_group` and review carry is available — the day-1 `ci.yml` already
   carries `merge_group: {}` so the caller is ready; the queue itself is
   materialized later by the shared reconciler as a repository rule, never
   by an org ruleset (org-rules schema excludes it, verified 2026-10-15).
6. Paperclip project hook: if a project-template hook is available, attach
   the template's CODEOWNERS, policy-bot stub and staging-migrate contract
   to the new Paperclip project at creation; otherwise seed them manually
   and note the gap on the repo's tracking card.

## Rollback

Delete the repo before its first promotion, or revert the template commit
and re-cut. No org ruleset change is part of cutting a repo; the baseline
evaluate ruleset already covers new repos with zero setup.
