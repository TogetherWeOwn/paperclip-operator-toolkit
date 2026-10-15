# Bootstrap: a new repo gets everything on day 1 (TOG-24386)

Stays in this repo; the Operator follows it when creating the public
template repo and when cutting a repo from it. No step runs from CI.

## One-time: create the template repo

1. Create public `TogetherWeOwn/repo-template` from the
   `sdlc-foundation/repo-template/` file set in this directory
   (`ci.yml` -> `.github/workflows/ci.yml`, `pr-lint.yml` ->
   `.github/workflows/pr-lint.yml`, plus `CODEOWNERS`,
   `policy-bot.yml.disabled`, `STAGING-MIGRATE-CONTRACT.md`). The
   `pr-lint.yml` copy is load-bearing: the org baseline requires the
   `pr-lint` context on every repo, and GitHub never applies the org
   `workflow-templates/pr-lint.yml` to a repo by itself, so the producer
   must ship inside the template. Scrub private card IDs from file content
   first; the staged headers name this card.
2. Fill `<PINNED_CHANGES_SHA>` in the template repo's OWN
   `.github/workflows/ci.yml` with the valid 40-hex pin from live org
   main (per-repo step 2). The template repo is deliberately NOT on the
   exclude list (exactly `replay-*` and `.github`), GitHub runs Actions
   in template repos, and its only org `uses:` is that one fillable pin
   (the tier-0 job is a plain job with no `uses:`) -- so with the pin
   filled it reports `ci-ok` and `pr-lint` like any other repo. Keep
   that pin valid on every template-repo change; an unfilled pin there
   would strand its PRs under the active baseline.
3. Mark it a template repository (Settings > Template repository).

## Per repo: cut from the template (zero per-repo setup)

1. Create with the template (owner: TogetherWeOwn, visibility per plan).
2. Fill the pins in `.github/workflows/ci.yml` from live org main.
   `<PINNED_CHANGES_SHA>` becomes the 40-hex commit SHA of
   `.github/workflows/changes.yml` on org `.github` main — fillable today.
   `<PINNED_GATE_SHA>` is BLOCKED: `.github/workflows/tier-0-quality-gate.yml`
   is staged on the tier-0 adoption branch only and is NOT on org main
   (verified 2026-10-15, org main `82c5b36`). The day-1 `ci.yml` therefore
   ships tier-0 as a plain `if: false` job with NO `uses:` -- nothing to
   resolve when the workflow loads, so it reads `skipped` and `ci-ok`
   reports. Do not claim tier-0 coverage and never pin an unmerged branch
   SHA. When the gate lands on org main, replace the plain job with this
   copy-in snippet (keeping the job name and the `ci-ok` `needs:` entry),
   fill `<PINNED_GATE_SHA>` with its 40-hex SHA, and re-run step 4:

   ```yaml
     tier-0:
       name: tier-0
       uses: TogetherWeOwn/.github/.github/workflows/tier-0-quality-gate.yml@<PINNED_GATE_SHA>
       with:
         mode: report-only
   ```

   No `uses:` into the org repo may float on a branch name after this step.
3. Replace `<OWNING-TEAM>` in `.github/CODEOWNERS` with the owning team.
   Leave `policy-bot.yml.disabled` renamed until the risk-lanes track leaves
   advisory shadow (TOG-24383); the staging-migrate contract applies now.
4. Open a docs-only PR and a code PR. Acceptance: both report `ci-ok` and
   `pr-lint`; the docs-only PR skips `lint` via the `changes` outputs with
   `ci-ok` green (`secret-scan` always runs; pushes to main always run
   `lint` -- main never skips). The plain tier-0 job must read `skipped`
   — never a startup failure — until step 2's copy-in snippet replaces
   it, after which it must report green before the repo counts as
   day-1 complete.
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
and re-cut. No org ruleset change is part of cutting a repo: the baseline
ruleset already targets new repos, and its required checks report because
the day-1 file set above ships their producers (`ci-ok` in `ci.yml`,
`pr-lint` in `pr-lint.yml`).
