#!/usr/bin/env python3
"""Append-once shadow comparison seat exclusion (TOG-31214).

Bounded safety fix: generic host recovery/admission automation must never
retry, restore, reassign, or comment-wake append-once shadow comparison
cards. Interrupted or isolation-failed shadow candidates are LOST PAIRS, not
retryable samples (comparison custodian E7, 2026-10-18 21:30Z).

Excluded seats (exact agent IDs only):

- 4ed63cba-3c05-435b-8cf9-20b922264bd6 (shadow Meta)
- 21060a96-b0cf-431c-a861-d89c47838944 (shadow Meta v2)

Their origin_kind is chat_channel with origin_id beginning ``shadow:``; the
origin is identifying context, NOT the exclusion key. Exclusion is by seat:
any record naming either seat in any assignee/agent/addressee/target slot is
excluded from generic recovery, regardless of project placement. The current
host retrier excludes these seats only accidentally (shadow cards have
project_id null and its query requires a non-null project); this guard is the
explicit exclusion that survives a non-null project.

Scope and non-goals:

- Source and tests only. No deploys, timer changes, or live issue/recovery
  mutation. The host operator owns installation after normal review.
- No model changes, credential changes, generic replay, sealed-evidence
  edits, or alternate-principal workarounds.
- A ``configuration_validation`` error reading
  ``github_candidate_isolation_error: no candidate provider work permitted``
  is containment/no-proof, not evidence of a missing secret.
- ``exclude_from_idle_admission`` covers generic candidate/adoption/wake
  paths only; the real shadow endpoint dispatch is a separate dedicated path
  and is unaffected (this file never allows or denies that path, it only
  keeps generic admission off these seats).

Host integration (live files under /home/ubuntu/paperclip-enterprise-company,
NOT in this repo -- see docs/shadow-seat-exclusion-host-patch.md):

1. ops/productivity/board_recovery_retrier.py ``candidates()``: add the seat
   exclusion (SQL fragment + python filter) instead of relying on project
   placement.
2. ops/paperclip/recovery_reconciler.py ``replay_candidates()``: call
   ``is_excluded_from_generic_recovery`` before ANY generic issue/recovery
   mutation or admission (replay evidence rewrite, PATCH todo, comment).
3. ops/paperclip/idle_waker.py: call ``exclude_from_idle_admission`` on
   generic candidate/adoption/wake paths; preserve shadow endpoint dispatch.

Pure stdlib, no network, no DB, no credentials, no clock, so every consumer
runtime imports this one file. Do NOT run host ``--apply`` paths from this
task.
"""

SHADOW_COMPARISON_SEAT_IDS = frozenset({
    "4ed63cba-3c05-435b-8cf9-20b922264bd6",
    "21060a96-b0cf-431c-a861-d89c47838944",
})

SHADOW_ORIGIN_KIND = "chat_channel"
SHADOW_ORIGIN_PREFIX = "shadow:"

EXCLUSION_REASON = (
    "shadow_comparison_seat: append-once LOST PAIR, "
    "never retry/restore/reassign/comment-wake via generic recovery"
)

# SQL fragment for the host retrier query. The retrier must exclude these
# seats explicitly rather than relying on project_id being null.
SQL_SEAT_EXCLUSION_IDS = (
    "'4ed63cba-3c05-435b-8cf9-20b922264bd6',"
    "'21060a96-b0cf-431c-a861-d89c47838944'"
)

# Record slots that can carry the assigned seat, across the three host
# scripts' row shapes (camelCase API rows and snake_case DB rows).
_AGENT_KEYS = (
    "assigneeAgentId",
    "assignee_agent_id",
    "agentId",
    "agent_id",
    "addresseeAgentId",
    "addressee_agent_id",
    "targetAgentId",
    "target_agent_id",
    "candidateAgentId",
    "candidate_agent_id",
)

# Containers one level down that may hold the card when the host row wraps
# it (recovery row -> issue, candidate -> source, etc.).
_NESTED_CONTAINERS = ("issue", "source", "candidate", "card", "origin")

_ORIGIN_KIND_KEYS = ("originKind", "origin_kind")
_ORIGIN_ID_KEYS = ("originId", "origin_id")


def sql_exclusion_clause(column="assignee_agent_id"):
    """SQL predicate excluding both shadow seats on the given column."""
    return "{col} NOT IN ({ids})".format(col=column, ids=SQL_SEAT_EXCLUSION_IDS)


def is_shadow_comparison_seat(agent_id):
    """True iff the value is exactly one of the two shadow seat IDs."""
    if not isinstance(agent_id, str):
        return False
    return agent_id.strip() in SHADOW_COMPARISON_SEAT_IDS


def is_shadow_origin(origin_kind, origin_id):
    """True iff a chat_channel origin with a shadow: id (identifying context).

    This identifies shadow comparison sources for logging; it is NOT the
    exclusion key. Exclusion is by seat (see is_excluded_from_generic_recovery)
    so unrelated chat_channel shadow: rows are never blocked by this guard.
    """
    return (
        origin_kind == SHADOW_ORIGIN_KIND
        and isinstance(origin_id, str)
        and origin_id.startswith(SHADOW_ORIGIN_PREFIX)
    )


def _record_agent_ids(record):
    """Collect every agent-id-like string on a record and its nested card."""
    found = []
    if not isinstance(record, dict):
        return found
    for key in _AGENT_KEYS:
        value = record.get(key)
        if isinstance(value, str) and value:
            found.append(value)
    for container in _NESTED_CONTAINERS:
        nested = record.get(container)
        if isinstance(nested, dict):
            for key in _AGENT_KEYS:
                value = nested.get(key)
                if isinstance(value, str) and value:
                    found.append(value)
    return found


def _record_origins(record):
    """Collect (origin_kind, origin_id) pairs on a record and nested card."""
    pairs = []
    if not isinstance(record, dict):
        return pairs
    scopes = [record]
    for container in _NESTED_CONTAINERS:
        nested = record.get(container)
        if isinstance(nested, dict):
            scopes.append(nested)
    for scope in scopes:
        for kind_key in _ORIGIN_KIND_KEYS:
            for id_key in _ORIGIN_ID_KEYS:
                kind = scope.get(kind_key)
                origin_id = scope.get(id_key)
                if kind is not None or origin_id is not None:
                    pairs.append((kind, origin_id))
    return pairs


def is_shadow_comparison_card(record):
    """True iff the record names either shadow seat in any agent slot.

    Project placement is irrelevant: non-null-project fixtures are excluded
    exactly like null-project ones. Status is irrelevant: cancelled lost-pair
    cards (including the earlier TOG-30978 / TOG-30974) stay excluded so no
    generic path can reopen them.
    """
    for agent_id in _record_agent_ids(record):
        if is_shadow_comparison_seat(agent_id):
            return True
    return False


def is_excluded_from_generic_recovery(record):
    """Primary gate: True means generic recovery/admission must skip this row.

    Call this BEFORE any generic issue/recovery mutation or admission:
    replay evidence rewrite, status restore (PATCH todo/blocked), comment
    wake, or idle adoption. Returns False for ordinary non-shadow rows so
    existing eligible recovery behavior is unchanged.
    """
    return is_shadow_comparison_card(record)


def exclude_from_board_retrier_candidate(row):
    """board_recovery_retrier.candidates() gate: skip shadow seats.

    Mirrors is_excluded_from_generic_recovery under the retrier's name so the
    host diff reads at the call site. Apply in SQL (sql_exclusion_clause)
    AND as a python filter, so a non-null project never re-admits a seat.
    """
    return is_excluded_from_generic_recovery(row)


def exclude_from_replay_candidate(issue, recovery=None):
    """recovery_reconciler gate: skip replay evidence rewrite / PATCH / comment.

    Checks both the issue row and the recovery evidence row (either may carry
    the seat). Call before ANY generic issue/recovery mutation or admission,
    including the missing-disposition comment branch and the routine-firing /
    CI-monitor branches.
    """
    if is_excluded_from_generic_recovery(issue):
        return True
    if recovery is not None and is_excluded_from_generic_recovery(recovery):
        return True
    if isinstance(issue, dict) and isinstance(recovery, dict):
        merged = dict(issue)
        for key, value in recovery.items():
            merged.setdefault(key, value)
        return is_excluded_from_generic_recovery(merged)
    return False


def exclude_from_comment_wake(issue):
    """Comment-wake gate: never comment-wake a shadow seat card.

    Commenting wakes the assignee, which is itself a continuation of a LOST
    PAIR. Route nothing; the host operator owns any direct action after
    normal review.
    """
    return is_excluded_from_generic_recovery(issue)


def exclude_from_idle_admission(candidate, agent=None):
    """idle_waker generic admission gate: skip shadow seats, keep dispatch.

    Checks the candidate source row plus the agent row/string when given.
    An agent row carries the seat under its ``id`` key (agent rows have no
    assignee slot); that key is read here ONLY, never on candidate/issue
    rows, where ``id`` is the record id and must not trigger exclusion.
    Generic candidate/adoption/wake paths must skip on True. The dedicated
    shadow endpoint dispatch is a separate path and is unaffected.
    """
    if is_excluded_from_generic_recovery(candidate):
        return True
    if agent is not None:
        if isinstance(agent, str):
            if is_shadow_comparison_seat(agent):
                return True
        elif isinstance(agent, dict):
            if is_shadow_comparison_seat(agent.get("id")):
                return True
            if is_excluded_from_generic_recovery(agent):
                return True
    return False


def filter_generic_candidates(rows):
    """Return the rows generic recovery/admission may still consider."""
    return [row for row in (rows or []) if not is_excluded_from_generic_recovery(row)]


def exclusion_explanation(record):
    """Short audit string naming why a record is excluded (seat id, if any)."""
    for agent_id in _record_agent_ids(record):
        if is_shadow_comparison_seat(agent_id):
            return "{reason} (seat {seat})".format(reason=EXCLUSION_REASON, seat=agent_id.strip())
    return EXCLUSION_REASON
