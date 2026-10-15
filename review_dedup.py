#!/usr/bin/env python3
"""Same-head review idempotency guard (TOG-24349 Phase 0 item 1).

Measured 2026-10-06..14 (Paperclip DB chat_github_reviews): 633 same-head
groups, 970 extra rows in 7d, all with DISTINCT delivery_ids (separately
triggered, not fan-out). Second rows by triggering event: ready_for_review
501, mention 365, synchronize 136, opened 92, reopened 20, comment 7.

One shared rule for every host path that can request a Paperclip Review:

- never request (repository, pull_number, head_sha) while a completed or
  in-flight review already covers that head;
- an errored head gets at most one retry (error -> one retry max).

Consumers: ops/productivity/review_error_rerequest.py (host reconciler, which
reads server rows) and .github/scripts/review_trigger_step.py (CI gate, which
reads GitHub check-runs). Pure stdlib, no network, no DB, no credentials, so
both runtimes import this one file; the step resolves it relative to the repo
root because its workflow sparse-checkout does not include ops/ by default.

Server row vocabulary (chat_github_reviews.state) follows the TOG-20869
review-gate taxonomy: completed = published verdict; queued/running = live;
error/incomplete = failed attempt; manual_required = needs a human mention.
A state this file does not recognize fails closed toward suppress: piling a
second request onto a head we cannot prove is bare is the harm being removed,
and a wrongly suppressed request surfaces as a visible skip notice (the
reconciler and manual-mention paths still exist) while a duplicate review
burns reviewer budget silently.
"""

REVIEW_CHECK_NAME = 'Paperclip Review'

# GitHub check-run side. Any non-completed Paperclip Review run means a review
# is already covering the head. Completed runs suppress only on a real verdict
# (success/failure); error outcomes (action_required, cancelled, timed_out,
# stale) stay retryable so gateway-outage recovery keeps its re-request path.
LIVE_CHECK_STATUSES = frozenset({'queued', 'in_progress', 'waiting', 'requested', 'pending'})
TERMINAL_CHECK_CONCLUSIONS = frozenset({'success', 'failure'})

# Server row side (chat_github_reviews.state).
LIVE_ROW_STATES = frozenset({'queued', 'running'})
PUBLISHED_ROW_STATES = frozenset({'completed'})
ERROR_ROW_STATES = frozenset({'error', 'incomplete'})
MANUAL_ROW_STATES = frozenset({'manual_required'})
MAX_ERROR_RETRIES = 1


def idempotency_key(repo, number, head_sha):
    """Canonical key for one (repo, PR, head): ``owner/name#n@sha``.

    The repo is lowercased because both ``togetherweown/`` and
    ``TogetherWeOwn/`` occur in stored rows. Matches the ``R#P@H`` state keys
    already used by review_error_rerequest.py and the review gate.
    """
    return f'{(repo or "").lower()}#{number}@{head_sha or ""}'


def check_run_suppresses(name, status, conclusion):
    """True when a GitHub check-run means "do not request another review".

    Only Paperclip Review runs suppress; every other check is ignored. A
    non-completed review run (queued, in progress, waiting) suppresses, as
    does a completed success/failure verdict. Completed error outcomes stay
    retryable. An unknown status fails closed toward suppress.
    """
    if name != REVIEW_CHECK_NAME:
        return False
    if (status or '') != 'completed':
        return True
    return (conclusion or '') in TERMINAL_CHECK_CONCLUSIONS


def head_decision(row_states):
    """Return (action, reason) for one head given its server row states.

    Action is 'request' or 'suppress'. Precedence: published verdict ->
    in-flight attempt -> exhausted error budget -> unrecognized state ->
    request. A bare head, a first error, or a manual_required head requests;
    anything else suppresses.
    """
    states = [(s or '').strip().lower() for s in row_states]
    if any(s in PUBLISHED_ROW_STATES for s in states):
        return 'suppress', 'head already has a completed review'
    if any(s in LIVE_ROW_STATES for s in states):
        return 'suppress', 'a review is already in flight for this head'
    errors = sum(1 for s in states if s in ERROR_ROW_STATES)
    if errors > MAX_ERROR_RETRIES:
        return 'suppress', 'error retry budget exhausted (one retry max)'
    known = LIVE_ROW_STATES | PUBLISHED_ROW_STATES | ERROR_ROW_STATES | MANUAL_ROW_STATES
    unknown = sorted({s for s in states if s and s not in known})
    if unknown:
        return 'suppress', 'unrecognized row state(s) %s; refusing to pile on' % ', '.join(unknown)
    if errors:
        return 'request', 'first retry after an errored attempt'
    return 'request', 'no live, completed, or repeated-error row for this head'
