# Review trigger: Paperclip Review only on ready heads

The reviewer is the FINAL review and runs far less often. PRs exceed 5/5
**before** review is requested. Deterministic checks first, then Muse; the
design must not depend on Claude or Codex.

## Decision

Request Paperclip Review exactly once per ready head, from a workflow, not
from every push:

- **Ready** = `ci-ok` green on the exact head + non-draft + template
  checklist complete + no success/failure Paperclip Review verdict on that head.
- **Never**: drafts, every-push triggers, re-reviews of an already-reviewed
  head (a new review needs a new push).
- **Auto-invoked without the checklist**: release-please PRs
  (`github-actions[bot]` / `release-please/*` branches) and risky paths.
- **Risky paths**: security boundary
  (auth/permissions/secrets/credentials/tokens), migrations, infra and
  workflow files, host/runner/provisioning/broker/deploy code, PRs carrying
  risk/security/tier labels, diffs over 600 lines, plus a deterministic 10%
  audit sample (`sha256(head) mod 10 == 0`, stable under re-evaluation).

## How it works (this repo)

| Piece | Role |
|---|---|
| `.github/workflows/review-trigger.yml` | Fires on CI completion; runs the step below. |
| `.github/scripts/review_trigger.py` | Pure stdlib decision (`decide()`); no network, no model. |
| `.github/scripts/review_trigger_step.py` | GitHub reads + idempotent trigger post. |
| `review_dedup.py` (repo root) | Shared same-head idempotency guard, single source, also used by `review_error_rerequest.py`. The step resolves it relative to the repo root, so the workflow sparse-checkout includes the root file (non-cone). |
| `test_review_trigger.py`, `test_review_trigger_step.py` | Offline unit tests, run in CI. |

Precedence: draft → already-reviewed head → ci-ok red → release-please →
risky → audit sample → checklist → ready head. The audit sample waives the
checklist (like risky/release-please); every skip exits 0 with a
notice; anything that prevents reaching a decision exits 1 (fail closed).
Check-run and comment reads follow `page=N` to the last page, and exit 1 past
3000 items rather than decide on a partial view. The file list is capped at
one page; a full page routes the PR to review.

Trigger record per head: one `@togetherweown-reviewer review <sha>` comment
(audit trail: only comments authored by github-actions[bot] count, so a
third-party or manual mention can never suppress the automatic trigger)
plus the `review-ready` label (machine signal). The verdict check-run test
is the one-review-per-head enforcer: a success/failure verdict is never
re-requested on the same head. Incomplete runs (action_required, cancelled,
timed_out, stale) never block decide(). The one-retry budget is shared
across every trigger path (this workflow, the reconciler, manual mentions):
the step maps each completed non-verdict Paperclip Review run on the head to
one spent error attempt and calls the shared guard, so a head the reconciler
already retried gets no further CI-driven trigger; a second bot marker
likewise suppresses, and further recovery belongs to the reconciler.
Same-head idempotency: just
before posting, the step re-reads the head's check-runs and suppresses the
post when a live Paperclip Review run already covers the head (manual
mention, gate listing, or an overlapping delivery started it without leaving
the sha marker the comment check looks for).

## Same-head idempotency guard

`review_dedup.py` (repo root) is pure stdlib decision logic over GitHub
check-runs and server review row states: no network, no DB, no credentials.
It is the single source; there is no second copy under `ops/productivity/`.

- Never request (repository, pull_number, head_sha) with a completed or
  in-flight review already covering that head.
- An errored head gets at most one retry (error → one retry max).
- Unrecognized row states fail closed toward suppress.

Consumers: `review_error_rerequest.py` consults `head_decision()` over each
errored head's recent row states before waking its card; the workflow step
re-reads check-runs just before posting. Acceptance cover: two deliveries for
the same head → one row (`test_review_dedup.py`).

## Platform half (Operator)

The workflow posts the request; the bot invocation must honor it and stop
firing on every push:

1. Disable auto-review on `synchronize`/every-push for all repos.
2. Invoke the reviewer when the `review-ready` label lands from this
   workflow (actor `github-actions[bot]`, comment marker
   `@togetherweown-reviewer review <sha>`), reviewing that exact `head_sha`.
3. Keep drafts excluded and keep the existing risky-path always-review list
   aligned with `RISKY_PATH_PATTERNS` in `review_trigger.py` (one list owns
   both; the workflow copy is authoritative until the platform reads it).
4. Reviewer model: Muse only. No Claude/Codex path may gate a review.

Rollback of this repo half: delete `review-trigger.yml`; reviews return to
manual `@togetherweown-reviewer review` mentions, nothing else changes.

## Rollout and measure

1. Land here, watch 5+ PRs: one trigger per ready head,
   zero drafts, release-please auto-invoked.
2. Adopting repos copy the five files (the four above plus
   `review_dedup.py`, which the step imports) and widen the
   workflow sparse-checkout to include the root file (non-cone mode), or the
   step fails closed instead of posting.
3. Measure weekly: first-pass 5/5 rate per repo (target ≥80%), reviews per
   merged PR, reviewer cost. Tune `LARGE_DIFF_LINES` from data, not by feel.

## Configuration

The reconciler and sweeper read their deployment from the environment:

| Variable | Role | Default |
|---|---|---|
| `PAPERCLIP_COMPANY_ID` | Company scope for review-row queries | `00000000-…` placeholder (fail-closed) |
| `PAPERCLIP_API` | Control-plane base URL for card comments | loopback default |
| `REVIEW_REPOS` / `REVIEW_ORG` | Repos the reconciler scans (comma-separated `org/name`) | `example-org/example-repo` |
| `ORPHAN_REPOS_JSON` | Sweeper map of repo → (assignee, project) | single example repo |
| `REVIEW_RERQ_*_TIMEOUT_S`, `ORPHAN_PRS_*_TIMEOUT_SECONDS` | Subprocess bounds | see module headers |
