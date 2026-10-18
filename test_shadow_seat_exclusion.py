#!/usr/bin/env python3
"""Offline suite for the shadow seat exclusion guard (TOG-31214).

Written to FAIL a plausible-but-wrong implementation, not to confirm the one
that exists. Every section is either the exact accident the host exhibits
today or the shortcut a reimplementation would take:

- seat exclusion that only works while project_id is null (the retrier's
  current accidental exclusion): fixtures carry non-null projects and must
  still be excluded;
- one seat covered, the other missed: BOTH full IDs are exercised in every
  operation;
- replay blocked but comment/idle left open: replay evidence rewrite, status
  restore, comment wake and idle admission are each pinned separately;
- origin-prefix matching instead of seat-exact matching: an unrelated
  chat_channel shadow: row on an ordinary seat must stay eligible, and an
  ordinary origin on a shadow seat must stay excluded;
- a filter that drops order or drops ordinary rows: filter_generic_candidates
  keeps order and keeps every non-shadow row.

Deterministic: no network, no credentials, no clock reads, no board, no live
Paperclip mutation. Fixture rows are inline so the suite survives the live
board changing.

  python3 -m unittest -v test_shadow_seat_exclusion.py
"""

from __future__ import annotations

import unittest

from shadow_seat_exclusion import (
    EXCLUSION_REASON,
    SHADOW_COMPARISON_SEAT_IDS,
    exclude_from_board_retrier_candidate,
    exclude_from_comment_wake,
    exclude_from_idle_admission,
    exclude_from_replay_candidate,
    filter_generic_candidates,
    is_excluded_from_generic_recovery,
    is_shadow_comparison_card,
    is_shadow_comparison_seat,
    is_shadow_origin,
    sql_exclusion_clause,
)

SEAT_A = "4ed63cba-3c05-435b-8cf9-20b922264bd6"
SEAT_B = "21060a96-b0cf-431c-a861-d89c47838944"
ORDINARY = "11111111-2222-3333-4444-555555555555"


def retrier_row(agent_id, project_id=None, **over):
    row = {
        "assignee_agent_id": agent_id,
        "project_name": "Fixture",
        "recovery_kind": "stranded_assigned_issue",
        "recovery_status": "escalated",
    }
    row["project_id"] = project_id
    row.update(over)
    return row


def reconciler_issue(agent_id, project_id="proj-live", status="todo", **over):
    issue = {
        "id": "issue-1",
        "identifier": "TOG-00001",
        "status": status,
        "projectId": project_id,
        "assigneeAgentId": agent_id,
        "originKind": "chat_channel",
        "originId": "shadow:fixture-pair-1",
    }
    issue.update(over)
    return issue


def replay_evidence(replay="blocked"):
    return {"automaticRecovery": {"replay": replay}}


class SeatIdentityTest(unittest.TestCase):
    def test_both_seats_are_exact(self):
        self.assertEqual(
            SHADOW_COMPARISON_SEAT_IDS,
            frozenset({SEAT_A, SEAT_B}),
        )
        self.assertTrue(is_shadow_comparison_seat(SEAT_A))
        self.assertTrue(is_shadow_comparison_seat(SEAT_B))

    def test_seat_match_is_exact_not_prefix(self):
        self.assertFalse(is_shadow_comparison_seat(SEAT_A[:8]))
        self.assertFalse(is_shadow_comparison_seat(SEAT_A + "x"))
        self.assertFalse(is_shadow_comparison_seat(ORDINARY))
        self.assertFalse(is_shadow_comparison_seat(None))
        self.assertFalse(is_shadow_comparison_seat(12345))
        self.assertFalse(is_shadow_comparison_seat(""))

    def test_origin_helper_is_context_not_key(self):
        self.assertTrue(is_shadow_origin("chat_channel", "shadow:abc"))
        self.assertFalse(is_shadow_origin("chat_channel", "other:abc"))
        self.assertFalse(is_shadow_origin("board", "shadow:abc"))
        self.assertFalse(is_shadow_origin("chat_channel", None))


class BoardRetrierTest(unittest.TestCase):
    def test_both_seats_excluded_with_null_project(self):
        for seat in (SEAT_A, SEAT_B):
            with self.subTest(seat=seat):
                row = retrier_row(seat, project_id=None)
                self.assertTrue(exclude_from_board_retrier_candidate(row))
                self.assertTrue(is_excluded_from_generic_recovery(row))

    def test_both_seats_excluded_with_non_null_project(self):
        # The live accident: exclusion works only because project_id is null.
        for seat in (SEAT_A, SEAT_B):
            with self.subTest(seat=seat):
                row = retrier_row(seat, project_id="proj-live")
                self.assertTrue(exclude_from_board_retrier_candidate(row))

    def test_camel_and_snake_slots_both_excluded(self):
        self.assertTrue(is_excluded_from_generic_recovery({"assigneeAgentId": SEAT_A}))
        self.assertTrue(is_excluded_from_generic_recovery({"assignee_agent_id": SEAT_B}))
        self.assertTrue(is_excluded_from_generic_recovery({"agentId": SEAT_A}))
        self.assertTrue(is_excluded_from_generic_recovery({"addresseeAgentId": SEAT_B}))

    def test_ordinary_row_stays_eligible(self):
        for project in (None, "proj-live"):
            with self.subTest(project=project):
                row = retrier_row(ORDINARY, project_id=project)
                self.assertFalse(exclude_from_board_retrier_candidate(row))
                self.assertFalse(is_excluded_from_generic_recovery(row))

    def test_shadow_origin_on_ordinary_seat_stays_eligible(self):
        # Origin alone must not block: exclusion is by seat.
        row = retrier_row(
            ORDINARY,
            project_id="proj-live",
            origin_kind="chat_channel",
            origin_id="shadow:other-pair",
        )
        self.assertFalse(is_excluded_from_generic_recovery(row))

    def test_sql_clause_names_both_seats(self):
        clause = sql_exclusion_clause()
        self.assertIn(SEAT_A, clause)
        self.assertIn(SEAT_B, clause)
        self.assertIn("NOT IN", clause)


class ReplayRewriteTest(unittest.TestCase):
    def test_both_seats_skip_replay_evidence_rewrite(self):
        for seat in (SEAT_A, SEAT_B):
            with self.subTest(seat=seat):
                issue = reconciler_issue(seat, project_id="proj-live")
                self.assertTrue(exclude_from_replay_candidate(issue, replay_evidence()))
                self.assertTrue(is_shadow_comparison_card(issue))

    def test_seat_in_recovery_row_alone_excludes(self):
        issue = reconciler_issue(ORDINARY, project_id="proj-live")
        recovery = {"assigneeAgentId": SEAT_B, "automaticRecovery": {"replay": "blocked"}}
        self.assertTrue(exclude_from_replay_candidate(issue, recovery))

    def test_ordinary_replay_stays_eligible(self):
        issue = reconciler_issue(ORDINARY, project_id="proj-live")
        self.assertFalse(exclude_from_replay_candidate(issue, replay_evidence()))
        self.assertFalse(exclude_from_replay_candidate(issue))


class StatusRestoreTest(unittest.TestCase):
    def test_both_seats_skip_status_restore(self):
        for seat in (SEAT_A, SEAT_B):
            with self.subTest(seat=seat):
                issue = reconciler_issue(seat, project_id="proj-live", status="todo")
                # A generic restore would PATCH todo->blocked; seats refuse.
                self.assertTrue(is_excluded_from_generic_recovery(issue))

    def test_cancelled_lost_pair_stays_excluded(self):
        # Earlier TOG-30978 / TOG-30974 remain cancelled and must never reopen.
        for seat in (SEAT_A, SEAT_B):
            with self.subTest(seat=seat):
                issue = reconciler_issue(seat, project_id="proj-live", status="cancelled")
                self.assertTrue(is_excluded_from_generic_recovery(issue))

    def test_ordinary_status_drift_stays_eligible(self):
        issue = reconciler_issue(ORDINARY, project_id="proj-live", status="todo")
        self.assertFalse(is_excluded_from_generic_recovery(issue))


class CommentWakeTest(unittest.TestCase):
    def test_both_seats_skip_comment_wake(self):
        for seat in (SEAT_A, SEAT_B):
            with self.subTest(seat=seat):
                issue = reconciler_issue(seat, project_id="proj-live")
                self.assertTrue(exclude_from_comment_wake(issue))

    def test_ordinary_missing_disposition_stays_eligible(self):
        issue = reconciler_issue(ORDINARY, project_id="proj-live")
        self.assertFalse(exclude_from_comment_wake(issue))


class IdleAdmissionTest(unittest.TestCase):
    def test_both_seats_skip_idle_admission(self):
        for seat in (SEAT_A, SEAT_B):
            with self.subTest(seat=seat):
                candidate = {"status": "todo", "assigneeAgentId": seat, "projectId": "proj-live"}
                agent = {"id": seat, "status": "active"}
                self.assertTrue(exclude_from_idle_admission(candidate, agent))
                self.assertTrue(exclude_from_idle_admission(candidate))
                self.assertTrue(exclude_from_idle_admission({"status": "todo"}, seat))

    def test_shadow_agent_dict_alone_excludes_unassigned_candidate(self):
        # The agent-dict branch in isolation: the candidate names no seat,
        # so only the agent row's ``id`` key can exclude. Both seats pinned.
        for seat in (SEAT_A, SEAT_B):
            with self.subTest(seat=seat):
                candidate = {"status": "todo", "projectId": "proj-live"}
                agent = {"id": seat, "status": "active"}
                self.assertTrue(exclude_from_idle_admission(candidate, agent))

    def test_ordinary_idle_candidate_stays_eligible(self):
        candidate = {"status": "todo", "assigneeAgentId": ORDINARY, "projectId": "proj-live"}
        agent = {"id": ORDINARY, "status": "active"}
        self.assertFalse(exclude_from_idle_admission(candidate, agent))
        self.assertFalse(exclude_from_idle_admission({"status": "todo"}, ORDINARY))

    def test_unassigned_non_shadow_stays_eligible(self):
        candidate = {"status": "todo", "projectId": "proj-live"}
        self.assertFalse(exclude_from_idle_admission(candidate))
        # An ordinary agent-row ``id`` must not trigger exclusion either.
        self.assertFalse(
            exclude_from_idle_admission(candidate, {"id": ORDINARY, "status": "active"})
        )


class FilterTest(unittest.TestCase):
    def test_filter_drops_only_seats_and_keeps_order(self):
        rows = [
            retrier_row(ORDINARY, project_id="proj-live"),
            retrier_row(SEAT_A, project_id="proj-live"),
            retrier_row(ORDINARY, project_id=None),
            retrier_row(SEAT_B, project_id=None),
            retrier_row(ORDINARY, project_id="proj-live"),
        ]
        kept = filter_generic_candidates(rows)
        self.assertEqual(len(kept), 3)
        for row in kept:
            self.assertFalse(is_excluded_from_generic_recovery(row))
        self.assertEqual(kept, [rows[0], rows[2], rows[4]])

    def test_reason_names_seat(self):
        from shadow_seat_exclusion import exclusion_explanation

        text = exclusion_explanation({"assigneeAgentId": SEAT_A})
        self.assertIn(SEAT_A, text)
        self.assertTrue(EXCLUSION_REASON.split(":")[0] in text)


if __name__ == "__main__":
    unittest.main()
