# Org `.github` additions: test-missing gate

Staged source for the org `TogetherWeOwn/.github` repo. Our credential
scope does not cover that repo, so an Operator applies these files there
after this change merges. The gate logic is public, stdlib-only code: the
canonical source is the repo-root `blocker_test_checks.py`, and the staged
copy under `test-missing/` is verbatim — fix the root source first, then
re-copy, never hand-edit the copy.

## Destination map

| This file | Goes to (in `TogetherWeOwn/.github`) |
|---|---|
| `test-missing/test-missing-gate.yml` | `.github/workflows/test-missing-gate.yml` (reusable `workflow_call`, warn default) |
| `test-missing/test-missing-required.yml` | `.github/workflows/test-missing-required.yml` (thin `pull_request` + `merge_group` wrapper) |
| `test-missing/blocker_test_checks.py` | `.github/scripts/blocker_test_checks.py` (verbatim copy of the repo-root source; fix upstream, then re-copy) |
| `test-missing/ADOPTION.md` | `TEST-MISSING-ADOPTION.md` (repo root: caller snippet, ci-ok wiring, rollout) |
| `rulesets/test-missing-report-only.json` | org ruleset payload, stage 1 (`evaluate`); applied via `gh api`, not copied |
| `rulesets/test-missing-required.json` | org ruleset payload, stage 2 (`active`, no earlier than 24h after stage 1); applied via `gh api`, not copied |

The ruleset payloads are never copied as files; an org admin applies them
with `gh api`. The two payloads differ only in `enforcement`, so the flip
from report-only to required smuggles in no rule change. This repo's own
warn-only caller is deliberately NOT part of this change: the staged pin
names no commit containing the reusable workflow, and GitHub resolves
called workflows at parse time, so landing a caller now would fail the
whole workflow on every PR (0 jobs, "workflow not found").

Stage 1 is also the resolution proof for the wrapper's `./` call to the
co-landed gate: both files land together in `TogetherWeOwn/.github`, so the
relative call resolves inside that repo. The Operator confirms the required
check resolves (rather than reporting 'workflow not found') during stage 1
`evaluate` before any stage 2 `active` flip; on a resolution failure the
wrapper is repinned to the full
`TogetherWeOwn/.github/.github/workflows/test-missing-gate.yml@<sha>` form.

After applying the staged gate to the org repo, the follow-up PR adds the
caller at `.github/workflows/test-missing.yml`, pinned to the org-repo
merge SHA that first contains `test-missing-gate.yml` — a pinned SHA,
never a moving tag.

## Local verification (no credentials)

```sh
python3 -B -m unittest test_test_missing_gate
bash test_test_missing_gate_placement.sh
```

Rollback: revert the commit that added this staging directory; no ruleset
or credential change is part of this change.
