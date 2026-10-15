# Decision: TogetherWeOwn/.github is the central CI/policy repo (TOG-24386)

No new `ci-shared` repo. Anything used on more than one repo is defined ONCE
at org level in the repo that already holds that role.

## Why `.github`

- It exists and is public (`TogetherWeOwn/.github`, main): free Actions
  minutes on public repos, no provisioning step, no second source of truth.
- It already hosts org reusable workflows (`.github/workflows/changes.yml`,
  `test-guard.yml`, `test-guard-required.yml`; the tier-0 quality gate
  reusable is staged on the tier-0 adoption branch, not yet on main — see
  below),
  new-repo workflow templates (`workflow-templates/starter-ci.yml`,
  `pr-lint.yml`, `test-guard.yml`, `gitleaks.yml`, deploy/staging/production,
  web-quality, web-zap-staging) and the standards (`CI-STANDARD.md`,
  `PIPELINE-STANDARD.md`). A second repo would split callers across two
  `uses:` roots for no privilege or visibility gain.
- Tier-0-home rule: reusable workflows for public repos must live in a public
  repo. `.github` is that home; `ci-shared` would need the same public
  visibility and the same admin attention, duplicating both.

## Why not `ci-shared`

A reusable workflow resolves cross-repo through `uses:` regardless of which
central repo hosts it, so `ci-shared` adds no capability — only a second pin
root, a second review queue and a second drift surface. One central repo,
one pin root.

## Split of responsibilities

| Piece | Lives in | Applied by |
|---|---|---|
| Reusable workflows, workflow templates, standards docs | `TogetherWeOwn/.github` (staged here first) | Operator copies files, opens org PR |
| Org ruleset payloads (`rulesets/*.json`) | Here (staging only, never copied as files) | Human org admin via `gh api` (ruleset writes are 403 for the GitHub App) |
| Repo exclude list (`repo-exclude-list.txt`) | Here (single source) | Injected into ruleset payloads by the runbook `jq` step; read by `discover-repos.sh` |
| Repo discovery (`discover-repos.sh`) | Here (host scripts run from this repo) | Host/Operator, dynamic `gh repo list` minus excludes |
| Repo template file set (`repo-template/`) | New public template repo (Operator creates) | `BOOTSTRAP-new-repo.md` day-1 steps |

## What already existed vs what this slice adds

Already live/staged before this slice (reused, not duplicated):

- `changes.yml` reusable + `starter-ci.yml` caller with `merge_group`,
  concurrency, timeouts and inline `ci-ok` aggregator.
- `tier-0-quality-gate.yml` reusable — STAGED on the tier-0 adoption branch
  only, NOT yet on org `.github` main (verified 2026-10-15, org main
  `82c5b36`): actionlint, zizmor, gitleaks, semgrep and squawk run inside it
  at pinned versions, report-only first. There is deliberately NO standalone
  `actionlint.yml` / `security-scan.yml` / `squawk.yml` reusable: one gate,
  one aggregator (`tier-0-ok`), fed into each caller's `ci-ok`. A second
  aggregator per scanner would multiply required-check names for no extra
  signal. Until the gate lands on org main, the day-1 template ships its
  tier-0 caller disabled (`if: false`): an enabled caller against a missing
  reusable fails at workflow startup and reports no `ci-ok` at all.
- `tier0-report-only.json` / `tier0-required.json` ruleset pair + runbook.

This slice adds:

- `rulesets/sdlc-baseline-evaluate.json` / `sdlc-baseline-active.json`:
  org baseline (required `ci-ok` + `pr-lint` by stable name, PR thread
  resolution) targeting all repos with the injected exclude list.
  Merge queue is deliberately absent and can never ride an org ruleset
  (verified 2026-10-15: org-rules schema excludes the merge-queue rule type,
  HTTP 422): stage 3 is the org `merge_queue_ready` property + one shared
  reconciler materializing repository queue rules for property-ready repos.
  Paperclip Review is deliberately
  absent: review is requested only on ready heads after ci-ok green (TOG-19598
  trigger); a required review context would block merges where review is
  intentionally skipped.
- Reserved required-check names for sibling tracks (documented in the payload
  `_comment` and the runbook, NOT required yet — producers do not exist):
  `size-label` (TOG-24377), `squawk-pg-lint` (TOG-24379),
  `test-missing` (TOG-24380), `security-scan` (TOG-24381). Each track adds
  its check to the ruleset following the rename-trap procedure in the runbook
  (add the producing job first, require it only when all open PRs report it).
- `repo-exclude-list.txt` + `discover-repos.sh`: the one exclude list and
  dynamic discovery for host scripts. No hardcoded repo lists in new code.
- `repo-template/` + `BOOTSTRAP-new-repo.md`: day-1 file set (pinned caller,
  the `pr-lint.yml` producer the baseline requires on every repo, CODEOWNERS,
  disabled policy-bot stub, staging-migrate contract).
