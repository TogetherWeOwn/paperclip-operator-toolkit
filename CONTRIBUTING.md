# Contributing

This public MIT toolkit contains reusable operator scripts, tests and Paperclip
plugins. Deployment-specific hosts, accounts, credentials, permission pins and
service units belong in a private deployment repository, not here.

## Non-negotiables

- **No secrets in source control.** Keep credentials outside the checkout in
  protected storage, and pass them by inherited environment or a protected
  configuration file, never argv. Do not print tokens while probing a tool.
- **Default to refusal.** Unknown commands, an unreadable authority source and
  incomplete measurements must not become a successful credential operation or
  a clean report. Distinguish a measured failure from an unmeasured result.
- **Scope every credential mint on both axes.** Repository and permission
  restrictions are independent. A project permission pin replaces a broker
  default; changing that default alone does not update deployed project pins.
  Review the actual grant surface, not just the edited constant.
- **Back up before an authorized mutation, and verify the backup.** Exit zero
  alone is not a restore proof. Check integrity and the relevant row or file
  coverage. Never use production state as a test fixture.
- **Test behavior and exit status, not prose.** A tool that prints a refusal
  but exits zero is not refusing. A suite that also passes with the defect
  restored is not proving the guard.
- **Keep authority separate from execution.** Authentication, an accepted
  review and a green build do not grant permission to deploy, rotate a
  credential or change an operator's infrastructure.

## Branch and pull request contract

Work on a feature branch. Never push to `main`. Squash merges only.

Use a Conventional Commits title: `type(scope): summary`, at most 100 characters,
with no trailing period. The scope names the code area, not a tracker. Supported
types are `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`,
`revert`, `style` and `security`.

Fill every section of [the PR template](.github/pull_request_template.md):

1. Thinking Path: at least three real steps from the subsystem to the change.
2. Linked Issues or Issue Description: describe the problem or link a public
   GitHub issue.
3. What Changed: one bullet per logical unit.
4. Verification: commands, observed outcomes and anything not run.
5. Risks: behavior changes, credential blast radius and rollback where relevant.
6. Model Used: provider and exact model/version, or `None — human-authored`.
7. Checklist: tick only statements established by evidence.

Search for overlapping open and recent PRs before implementing. Reuse the
existing branch when addressing feedback. Credit contributors whose work you
build on. Address every finding or explain why it does not apply.

This repository is public. Never include private tracker identifiers, private
URLs, hostnames or credentials in filenames, source, branch names, commits, PR
text, comments or reviews. Use a branch such as `fix/queue-refusal`. Keep private
board-to-PR linkage in your private tracker. Run the public-text hygiene check
before posting, and the disclosure and secret scans before publishing files.

If running under Paperclip, run `sibling_guard.sh` for the current issue before
implementing and immediately before each push. A nonzero result is not a pass.
Run `gh_push_preflight.sh --issue <uuid>` alongside it to check the broker's
repository scope and issue lifecycle. These checks are not publication approval.

## Verification and CI

Run the suites affected by the change. Representative offline entry points:

```sh
./test_sql_backend.sh
./test_provisioned_cheap_profile.sh
node --test mcp/test/org-request-mcp.test.mjs
node --test hooks/muse-stop-guard/muse-stop-guard.test.mjs
python3 -m unittest -v test_platform_watchdog
python3 scripts/test_plugin_ci_wiring.py
```

Read a suite's preconditions before running it. Host, database and live-company
acceptance suites are not offline tests. Provisioning suites can create and
remove real agents; do not point them at production merely to obtain a result.
Use stubs or explicitly disposable CI services. A missing backend is an
unmeasured result, never evidence of enforcement.

The toolkit uses standard GitHub-hosted `ubuntu-latest` runners. Do not import
private runner labels, infrastructure manifests or secret-bearing configuration.
Heavy jobs use a job-level `changes` gate, not workflow-level PR `paths` filters
on required-check producers. Dependency, lockfile and workflow changes run the
full suite; `main` and nightly runs are full runs. Disclosure and secret scans
stay always on. The single `ci-ok` aggregator must fail for failed/cancelled
jobs or an unsuccessful required scan, while allowing intentional suite skips.
Add new jobs to the aggregator and test their wiring.

When editing a mutation-tested subject, update its gate anchors consistently.
Run the unmutated suite first, then prove the intended assertion rejects the
mutant. An import error, missing fixture or syntax failure is not a valid kill.
Use temporary copies and restore them reliably; never strand a mutant in the
checkout.

## Review and delivery

Keep a PR to one logical change. Obtain independent review of the exact head
that will merge; a new push needs a new verdict on the same review record.
Required CI must be green on that head. The approving reviewer, not the author,
squash-merges through the repository's approved path.

A public re-home also needs fresh independent disclosure review of the exact
candidate: changed filenames and content, history, licenses, credentials and
host-specific configuration. A previous slice's verdict does not cover it.

Done means merged, not merely opened or approved. Record the merge SHA and
verification. If a PR is superseded, close it with a public-safe comment naming
its replacement. Do not leave an orphan PR while marking its task complete.

Deployment is a separate deliverable with its own access, staging, rollback and
production gates. Nothing in this contribution contract authorizes a host
operation or changes an existing operator approval requirement.
