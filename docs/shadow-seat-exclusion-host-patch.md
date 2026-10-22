# Shadow seat exclusion — host-ready integration patch (TOG-31214)

Status: **reviewed public source, NOT installed on the host.** Do not claim
the host is protected until the host operator installs and verifies the patch
below on `/home/ubuntu/paperclip-enterprise-company`.

## What this is

Portable guard: `shadow_seat_exclusion.py` (repo root, stdlib-only). It
excludes exactly two append-once shadow comparison seats from generic host
recovery/admission:

- `4ed63cba-3c05-435b-8cf9-20b922264bd6` (shadow Meta)
- `21060a96-b0cf-431c-a861-d89c47838944` (shadow Meta v2)

Interrupted or isolation-failed shadow candidates are LOST PAIRS, not
retryable samples. Generic automation must never retry, restore, reassign,
or comment-wake these cards, regardless of `project_id`. The earlier
`TOG-30978` and `TOG-30974` remain cancelled and must never be reopened.

## Host files (private, not in this repo)

Live files under `/home/ubuntu/paperclip-enterprise-company`:

1. `ops/productivity/board_recovery_retrier.py` — `candidates()`
2. `ops/paperclip/recovery_reconciler.py` — `replay_candidates()`
3. `ops/paperclip/idle_waker.py` — generic assignment/admission

Do not run `recovery_reconciler.py --apply`, `idle_waker.py --apply`, or the
retrier `--apply --limit 12` during this task. The operator owns installation
after normal review.

## Patch 1 — board retrier `candidates()`

Add an explicit seat exclusion; stop relying on `project_id IS NULL`:

```sql
-- inside candidates() WHERE, alongside the active/escalated stranded filters:
AND assignee_agent_id NOT IN (
  '4ed63cba-3c05-435b-8cf9-20b922264bd6',
  '21060a96-b0cf-431c-a861-d89c47838944'
)
```

Plus a python filter (covers the non-null-project row the SQL used to miss):

```python
from shadow_seat_exclusion import exclude_from_board_retrier_candidate

candidates = [row for row in candidates
              if not exclude_from_board_retrier_candidate(row)]
```

Or with the helper: `sql_exclusion_clause("assignee_agent_id")`.

## Patch 2 — recovery reconciler `replay_candidates()`

Exclude before ANY generic issue/recovery mutation or admission — replay
evidence rewrite, PATCH todo, comment, missing-disposition branch, routine
close, CI-monitor accelerate:

```python
from shadow_seat_exclusion import exclude_from_replay_candidate, exclude_from_comment_wake

# at the top of replay_candidates(), per (issue, recovery) pair:
if exclude_from_replay_candidate(issue, recovery):
    continue
# before ANY comment wake on any branch:
if exclude_from_comment_wake(issue):
    continue
```

## Patch 3 — idle waker generic admission

Exclude from generic candidate/adoption/wake paths; preserve the dedicated
shadow endpoint dispatch (separate path, untouched by this guard):

```python
from shadow_seat_exclusion import exclude_from_idle_admission

# generic paths only:
if exclude_from_idle_admission(candidate, agent):
    continue
```

## Install (operator, on the host)

1. Copy reviewed `shadow_seat_exclusion.py` to the host company root (same
   level the three scripts import from) or a shared import path.
2. Apply patches 1–3 above; keep the exact seat IDs (no prefixes, no
   substrings).
3. Offline check: `python3 -m unittest -v test_shadow_seat_exclusion.py`
   from this repo (no live mutation).
4. Dry-run only: run each host script WITHOUT `--apply` and confirm shadow
   seats produce zero candidates/mutations.
5. Record install evidence on TOG-31214; only then is the host protected.

## Rollback (operator, on the host)

1. Revert the three host hunks (`git diff` on the host company checkout).
2. Remove the copied `shadow_seat_exclusion.py` from the host import path.
3. Re-run the same dry-runs; confirm the diff is empty.
4. Record rollback on TOG-31214.

## Verification already done here (offline)

- `python3 -m unittest -v test_shadow_seat_exclusion.py`: both seats
  excluded across null and non-null projects; ordinary rows stay eligible;
  replay rewrite, status restore, comment wake, idle admission each pinned.
- No network, no credentials, no live Paperclip mutation in tests.
