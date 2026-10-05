#!/usr/bin/env python3

from __future__ import annotations

import copy
import io
import json
import os
import pathlib
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import liveness_reconciler as lr

ROOT = pathlib.Path(__file__).resolve().parent
A_IMPL = "11111111-1111-4111-8111-111111111111"
A_REVIEW = "22222222-2222-4222-8222-222222222222"
A_CREATOR = "33333333-3333-4333-8333-333333333333"


def issue(identifier: str, **changes):
    base = {
        "id": f"00000000-0000-4000-8000-{int(identifier.split('-')[-1]):012d}",
        "identifier": identifier,
        "projectId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "companyId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "status": "todo",
        "assigneeAgentId": A_IMPL,
        "assigneeAgentName": "Implementer",
        "createdByAgentId": A_CREATOR,
        "unblockDescriptor": None,
        "interactions": [],
        "runs": [],
        "comments": [],
        "activity": [],
        "recoveryActions": {"active": None, "actions": []},
    }
    base.update(changes)
    return base


def proposal_map(rows):
    return {(row.identifier, row.reason): row for row in rows}


class FourReproductions(unittest.TestCase):
    def test_human_only_review_verdict_is_alarm_only(self):
        row = issue("CASE-548", status="in_review", reviewPolicy="human_only", interactions=[{
            "id": "review-card", "status": "pending", "effectiveResolverPolicy": "board_only",
            "isReviewVerdict": True, "addresseeAgentId": A_REVIEW,
        }])
        proposals = lr.proposals_for_issue(row, retry_limit=1)
        self.assertEqual([(p.reason, p.mutation) for p in proposals], [("interaction_not_agent_resolvable", "none")])

    def test_board_only_addressed_interaction_is_alarm_only(self):
        row = issue("CASE-548", status="in_review", interactions=[{
            "id": "board-card", "status": "pending", "effectiveResolverPolicy": "board_only",
            "addresseeAgentId": A_REVIEW,
        }])
        proposals = lr.proposals_for_issue(row, retry_limit=1)
        self.assertEqual([(p.reason, p.mutation) for p in proposals], [("interaction_not_agent_resolvable", "none")])

    def test_active_pause_hold_is_unconditional_reviewer_barrier(self):
        row = issue(
            "CASE-548", status="in_review",
            interactions=[{
                "id": "card", "status": "pending",
                "effectiveResolverPolicy": "board_or_agents",
                "addresseeAgentId": A_REVIEW,
            }],
            treeControlState={"activePauseHold": {
                "id": "pause", "mode": "pause", "status": "active",
            }},
        )
        proposals = lr.proposals_for_issue(row, retry_limit=1)
        self.assertEqual([(p.reason, p.mutation) for p in proposals], [("active_pause_hold", "none")])

    def test_active_pause_hold_is_unconditional_orphan_barrier(self):
        row = issue(
            "CASE-573", status="in_progress",
            runs=[{"runId": "orphan", "agentId": A_IMPL, "status": "interrupted", "errorCode": "orphaned_running_run"}],
            treeControlState={"activePauseHold": {
                "id": "pause", "mode": "pause", "status": "active",
            }},
        )
        proposals = lr.proposals_for_issue(row, retry_limit=1)
        self.assertEqual([(p.reason, p.mutation) for p in proposals], [("active_pause_hold", "none")])

    def test_reviewer_mismatch_is_diagnostic_and_never_bounces(self):
        row = issue(
            "CASE-548",
            status="in_review",
            interactions=[{
                "id": "aaaaaaaa-0000-4000-8000-000000000548",
                "status": "pending",
                "effectiveResolverPolicy": "board_or_agents",
                "addresseeAgentId": A_REVIEW,
            }],
        )
        proposal = lr.proposals_for_issue(row, retry_limit=1)[0]
        self.assertEqual((proposal.reason, proposal.mutation), ("interaction_addressee_mismatch", "none"))
        self.assertEqual(proposal.target_agent_id, A_REVIEW)
        self.assertEqual(proposal.after["assigneeAgentId"], A_IMPL)
        self.assertIn("typed executionPolicy", proposal.note)

    def test_reviewer_routing_never_bounces_active_implementer(self):
        row = issue(
            "CASE-565",
            status="in_progress",
            interactions=[{
                "id": "aaaaaaaa-0000-4000-8000-000000000565",
                "status": "pending",
                "effectiveResolverPolicy": "board_or_agents",
                "addresseeAgentId": A_REVIEW,
            }],
            runs=[{"runId": "bbbbbbbb-0000-4000-8000-000000000565", "agentId": A_IMPL, "status": "running"}],
        )
        proposals = lr.proposals_for_issue(row, retry_limit=1)
        self.assertEqual([p.mutation for p in proposals], ["none"])
        self.assertEqual(proposals[0].reason, "interaction_addressee_mismatch_active_run")

    def test_tog573_orphan_is_native_recovery_diagnostic(self):
        source = {
            "runId": "825334e4-4db2-434b-a100-2b1eeb7bda31",
            "agentId": A_IMPL,
            "status": "interrupted",
            "errorCode": "orphaned_running_run",
            "createdAt": "2026-08-28T01:23:00Z",
            "finishedAt": "2026-08-28T03:06:02Z",
        }
        row = issue("CASE-573", status="in_progress", runs=[source])
        proposal = lr.proposals_for_issue(row, retry_limit=1)[0]
        self.assertEqual((proposal.reason, proposal.mutation), ("native_recovery_pending", "none"))
        self.assertEqual(proposal.target_agent_id, A_IMPL)
        self.assertEqual(proposal.source_id, source["runId"])

    def test_native_replacement_evidence_suppresses_orphan_diagnostic(self):
        source = {
            "runId": "825334e4-4db2-434b-a100-2b1eeb7bda31",
            "agentId": A_IMPL,
            "status": "interrupted",
            "errorCode": "orphaned_running_run",
        }
        replacement = {
            "runId": "replacement",
            "agentId": A_IMPL,
            "status": "queued",
            "retryOfRunId": source["runId"],
        }
        row = issue("CASE-573", status="in_progress", runs=[source, replacement])
        self.assertEqual(lr.proposals_for_issue(row, retry_limit=1), [])

    def test_active_native_recovery_suppresses_orphan_diagnostic(self):
        row = issue(
            "CASE-573",
            status="in_progress",
            runs=[{
                "runId": "825334e4-4db2-434b-a100-2b1eeb7bda31",
                "agentId": A_IMPL,
                "status": "interrupted",
                "errorCode": "orphaned_running_run",
            }],
            recoveryActions={
                "active": None,
                "actions": [{
                    "id": "eeeeeeee-0000-4000-8000-000000000573",
                    "status": "active",
                    "kind": "stranded_issue_recovery",
                    "evidence": {"cause": "process_lost"},
                }],
            },
        )
        self.assertEqual(lr.proposals_for_issue(row, retry_limit=1), [])

    def test_legacy_reviewer_assignment_proposal_is_refused(self):
        row = issue("CASE-548", status="in_review")
        proposal = lr.Proposal(
            row["id"], row["identifier"], "interaction_addressee_mismatch", "assign_reviewer",
            A_REVIEW, "card", {}, {}, "legacy",
        )
        with self.assertRaisesRegex(lr.ReconcilerError, "native execution-policy work"):
            lr.validate_live_preconditions(row, proposal)

    def test_legacy_orphan_wake_proposal_is_refused(self):
        row = issue("CASE-573", status="in_progress")
        proposal = lr.Proposal(
            row["id"], row["identifier"], "orphaned_running_run", "wake_same_agent",
            A_IMPL, "source", {}, {}, "legacy",
        )
        with self.assertRaisesRegex(lr.ReconcilerError, "native recovery work"):
            lr.validate_live_preconditions(row, proposal)

    def test_project_move_refuses_apply(self):
        row = issue(
            "CASE-584", status="blocked", assigneeAgentId=None,
            unblockDescriptor={"owner": {"agentId": A_CREATOR}, "action": "Take the ready blocker."},
            readyBlocker=True,
        )
        proposal = lr.proposals_for_issue(row, retry_limit=1)[0]
        live = copy.deepcopy(row)
        live["projectId"] = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        with self.assertRaisesRegex(lr.ReconcilerError, "moved outside"):
            lr.validate_live_preconditions(
                live, proposal,
                {"id": A_CREATOR, "companyId": row["companyId"], "status": "idle", "orgChainHealth": {"status": "healthy"}},
            )

    def test_explicit_publish_prohibition_is_owner_hold(self):
        row = issue("CASE-570", comments=[{
            "id": "hold", "authorType": "user", "authorUserId": "owner",
            "createdAt": "2026-08-28T01:00:00Z",
            "body": "Do not publish this advisory until I approve.",
        }])
        self.assertTrue(lr.issue_has_owner_hold(row)[0])

    def test_released_descriptor_does_not_override_owner_release(self):
        row = issue(
            "CASE-570",
            unblockDescriptor={
                "owner": {"agentId": A_IMPL},
                "action": "Owner vendor-channel HOLD is superseded; work may resume.",
            },
        )
        self.assertEqual(lr.issue_has_owner_hold(row), (False, None))

    def test_latest_owner_release_supersedes_historical_hold(self):
        row = issue("CASE-570", comments=[
            {
                "id": "hold", "authorType": "user", "authorUserId": "owner",
                "createdAt": "2026-08-28T01:00:00Z",
                "body": "Owner vendor-channel HOLD. Do not publish this advisory.",
            },
            {
                "id": "release", "authorType": "user", "authorUserId": "owner",
                "createdAt": "2026-08-28T02:00:00Z",
                "body": "The hold is superseded; work may resume.",
            },
        ])
        self.assertEqual(lr.issue_has_owner_hold(row), (False, None))

    def test_mixed_release_and_restated_hold_in_one_comment_holds(self):
        # A single owner comment that lifts one hold while restating another must
        # read as HELD. Release-before-hold ordering made this fail open and let
        # assign_blocker_owner through the apply gate (CASE-567/570 shape).
        row = issue("CASE-570", comments=[{
            "id": "c-hold", "authorType": "user", "authorUserId": "owner",
            "createdAt": "2026-08-28T01:00:00Z",
            "body": (
                "The vendor-channel hold on the transport rehearsal is lifted, that work "
                "may resume. This card stays put though - do not publish or deploy "
                "anything from it until I say so."
            ),
        }])
        held, evidence = lr.issue_has_owner_hold(row)
        self.assertTrue(held)
        self.assertIn("c-hold", evidence)

    def test_mixed_release_and_hold_descriptor_holds(self):
        row = issue("CASE-570", unblockDescriptor={
            "owner": {"agentId": A_IMPL},
            "action": "Vendor-channel hold is lifted for the rehearsal; do not publish from this card.",
        })
        self.assertTrue(lr.issue_has_owner_hold(row)[0])

    def test_mixed_release_and_hold_comment_refuses_blocker_assignment(self):
        # End-to-end: the planner must not emit an assignment, and the apply gate
        # must refuse it, for a card whose owner restated a hold while lifting another.
        row = issue(
            "CASE-584",
            status="blocked",
            assigneeAgentId=None,
            unblockDescriptor={"owner": {"agentId": A_CREATOR}, "action": "Take the ready blocker."},
            readyBlocker=True,
            comments=[{
                "id": "c-hold", "authorType": "user", "authorUserId": "owner",
                "createdAt": "2026-08-28T01:00:00Z",
                "body": (
                    "The vendor-channel hold on the transport rehearsal is lifted, that work "
                    "may resume. This card stays put though - do not publish or deploy "
                    "anything from it until I say so."
                ),
            }],
        )
        proposals = lr.proposals_for_issue(row, retry_limit=1)
        self.assertNotIn("assign_blocker_owner", [p.mutation for p in proposals])
        assignment = lr.Proposal(
            row["id"], row["identifier"], "ready_unassigned_blocker_owned", "assign_blocker_owner",
            A_CREATOR, None, {"projectId": row["projectId"], "status": "blocked"}, {}, "assign",
        )
        with self.assertRaisesRegex(lr.ReconcilerError, "live owner HOLD"):
            lr.validate_live_preconditions(
                row, assignment,
                {"id": A_CREATOR, "companyId": row["companyId"], "status": "idle",
                 "orgChainHealth": {"status": "healthy"}},
            )

    def test_owner_hold_in_issue_description_is_detected(self):
        row = issue("CASE-567", description=(
            "## Scope\n\nOwner task-specific HOLD: do not publish anything from this card "
            "until the credential rotation lands."
        ))
        held, evidence = lr.issue_has_owner_hold(row)
        self.assertTrue(held)
        self.assertIn("description", evidence)

    def test_owner_hold_in_issue_title_is_detected(self):
        row = issue("CASE-567", title="HOLD external execution - do not deploy the reconciler timer")
        self.assertTrue(lr.issue_has_owner_hold(row)[0])

    def test_scoped_description_instruction_is_not_owner_hold(self):
        # Measured against 200 live company issues: the loose descriptor pattern
        # matches 6 scoped build instructions ("do not start from scratch",
        # "do not merge db8eee5"). The body scan must use the strict comment
        # pattern so ordinary task text cannot fabricate a hold.
        for body in (
            "Do not start from scratch. org_request_queue.sh is already a sound core.",
            "PR #115 remains owned by CASE-523; do not merge db8eee5.",
            "Do not modify generated files; update only the source.",
        ):
            with self.subTest(body=body):
                self.assertEqual(lr.issue_has_owner_hold(issue("CASE-548", description=body)), (False, None))

    def test_body_hold_refuses_mutation_but_never_initiates_containment(self):
        # A description is ordinary task prose, not an authenticated owner
        # directive. Measured on 374 live project issues the body scan finds 8
        # holds, 2 of them false (CASE-586 quotes the failure mode; CASE-713 says
        # "I do not contact the owner directly"). create_pause_hold cancels live
        # runs, so body text may raise the barrier and never start containment.
        row = issue(
            "CASE-586",
            status="in_review",
            description="Resolving an interaction violates an owner hold: do not publish.",
            treeControlState={"activePauseHold": None},
        )
        self.assertTrue(lr.issue_has_owner_hold(row)[0])
        self.assertEqual(lr.issue_has_owner_hold(row, include_body=False), (False, None))
        self.assertEqual(
            [p.mutation for p in lr.proposals_for_issue(row, retry_limit=1)], [],
        )

    def test_body_hold_still_refuses_a_blocker_assignment_at_the_apply_gate(self):
        row = issue(
            "CASE-602",
            status="blocked",
            assigneeAgentId=None,
            description="Do not publish, message external parties, or make the system public.",
            unblockDescriptor={"owner": {"agentId": A_CREATOR}, "action": "Take the ready blocker."},
            readyBlocker=True,
        )
        self.assertNotIn(
            "assign_blocker_owner", [p.mutation for p in lr.proposals_for_issue(row, retry_limit=1)],
        )
        assignment = lr.Proposal(
            row["id"], row["identifier"], "ready_unassigned_blocker_owned", "assign_blocker_owner",
            A_CREATOR, None, {"projectId": row["projectId"], "status": "blocked"}, {}, "assign",
        )
        with self.assertRaisesRegex(lr.ReconcilerError, "live owner HOLD"):
            lr.validate_live_preconditions(
                row, assignment,
                {"id": A_CREATOR, "companyId": row["companyId"], "status": "idle",
                 "orgChainHealth": {"status": "healthy"}},
            )

    def test_body_only_hold_cannot_pass_the_create_pause_hold_apply_gate(self):
        row = issue("CASE-586", status="in_review", treeControlState={"activePauseHold": None})
        containment = lr.Proposal(
            row["id"], row["identifier"], "owner_hold_unenforced", "create_pause_hold",
            None, None, {"projectId": row["projectId"], "status": "in_review"}, {}, "contain",
        )
        live = copy.deepcopy(row)
        live["description"] = "Resolving an interaction violates an owner hold: do not publish."
        with self.assertRaisesRegex(lr.ReconcilerError, "no longer needed"):
            lr.validate_live_preconditions(live, containment)

    def test_owner_comment_hold_still_initiates_containment(self):
        row = issue(
            "CASE-567",
            status="in_progress",
            description="Routine implementation notes with no hold language.",
            comments=[{
                "id": "hold", "authorType": "user", "authorUserId": "owner",
                "createdAt": "2026-08-28T01:00:00Z",
                "body": "Owner task-specific HOLD. Do not publish from this card.",
            }],
            treeControlState={"activePauseHold": None},
        )
        self.assertEqual(
            [p.mutation for p in lr.proposals_for_issue(row, retry_limit=1)], ["create_pause_hold"],
        )

    def test_description_hold_is_released_by_a_later_owner_comment(self):
        row = issue(
            "CASE-567",
            description="Owner vendor-channel HOLD. Do not publish this advisory.",
            comments=[{
                "id": "release", "authorType": "user", "authorUserId": "owner",
                "createdAt": "2026-08-28T02:00:00Z",
                "body": "The hold is lifted; work may resume.",
            }],
        )
        self.assertEqual(lr.issue_has_owner_hold(row), (False, None))

    def test_agent_on_behalf_comment_is_not_owner_hold_authority(self):
        row = issue("CASE-570", comments=[{
            "id": "delegated", "authorType": "user", "authorUserId": "owner-proxy",
            "authorAgentId": A_CREATOR, "body": "Do not publish this advisory.",
        }])
        self.assertEqual(lr.issue_has_owner_hold(row), (False, None))

    def test_apply_revalidates_new_owner_hold(self):
        row = issue("CASE-548", status="in_review")
        proposal = lr.Proposal(row["id"], row["identifier"], "interaction_addressee_mismatch", "assign_reviewer", A_REVIEW, "card", {}, {}, "assign")
        live = issue("CASE-548", status="in_review", comments=[{
            "id": "hold", "authorType": "user", "authorUserId": "owner", "body": "Owner task-specific HOLD. Do not proceed.",
        }])
        live["interactions"] = [{"id": "card", "status": "pending", "effectiveResolverPolicy": "board_or_agents", "addresseeAgentId": A_REVIEW}]
        class Api:
            def get(self, path):
                if path.endswith("/interactions"): return live["interactions"]
                if path.endswith("/runs"): return live["runs"]
                if "/comments" in path: return live["comments"]
                if path.endswith("/activity"): return live["activity"]
                if path.endswith("/recovery-actions"): return live["recoveryActions"]
                if path.endswith("/diagnostics/blockers"): return {"readiness": {"isDependencyReady": True}}
                return dict(live)
        with self.assertRaisesRegex(lr.ReconcilerError, "live owner HOLD"):
            lr.apply_proposal(Api(), row, proposal)

    def test_tog584_unassigned_blocker_routes_unique_first_class_owner(self):
        row = issue(
            "CASE-584",
            status="blocked",
            assigneeAgentId=None,
            unblockDescriptor={"owner": {"agentId": A_CREATOR}, "action": "Take the ready blocker."},
            readyBlocker=True,
        )
        proposals = lr.proposals_for_issue(row, retry_limit=1)
        self.assertEqual([p.mutation for p in proposals], ["assign_blocker_owner"])
        self.assertEqual(proposals[0].reason, "ready_unassigned_blocker_owned")
        self.assertEqual(proposals[0].target_agent_id, A_CREATOR)

    def test_creator_provenance_is_not_treated_as_owner(self):
        row = issue(
            "CASE-584",
            status="todo",
            assigneeAgentId=None,
            createdByAgentId=A_CREATOR,
            readyBlocker=True,
        )
        proposals = lr.proposals_for_issue(row, retry_limit=1)
        self.assertEqual([p.mutation for p in proposals], ["operator_decision"])
        self.assertEqual(proposals[0].reason, "ready_unassigned_blocker_ambiguous")

    def test_fixture_only_intended_owner_is_not_authority(self):
        row = issue(
            "CASE-480",
            status="todo",
            assigneeAgentId=None,
            intendedOwnerAgentId=A_REVIEW,
            readyBlocker=True,
        )
        proposals = lr.proposals_for_issue(row, retry_limit=1)
        self.assertEqual([p.mutation for p in proposals], ["operator_decision"])
        self.assertEqual(proposals[0].reason, "ready_unassigned_blocker_ambiguous")

    def test_conflicting_pending_reviewers_never_bounce_assignment(self):
        row = issue(
            "CASE-548", status="in_review", assigneeAgentId=A_IMPL,
            interactions=[
                {"id": "card-a", "status": "pending", "effectiveResolverPolicy": "board_or_agents", "addresseeAgentId": A_REVIEW},
                {"id": "card-b", "status": "pending", "effectiveResolverPolicy": "board_or_agents", "addresseeAgentId": A_CREATOR},
            ],
        )
        proposals = lr.proposals_for_issue(row, retry_limit=1)
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].mutation, "none")
        self.assertEqual(proposals[0].reason, "interaction_addressee_conflict")

    def test_reviewer_diagnostic_precedes_blocker_assignment(self):
        row = issue(
            "CASE-584",
            status="blocked",
            assigneeAgentId=None,
            unblockDescriptor={"owner": {"agentId": A_CREATOR}, "action": "Take the ready blocker."},
            readyBlocker=True,
            interactions=[{"id": "card", "status": "pending", "effectiveResolverPolicy": "board_or_agents", "addresseeAgentId": A_REVIEW}],
        )
        proposals = lr.proposals_for_issue(row, retry_limit=1)
        self.assertEqual(len(proposals), 1)
        self.assertEqual((proposals[0].reason, proposals[0].mutation), ("interaction_addressee_mismatch", "none"))

    def test_tog567_and_570_owner_holds_persist_pause_before_containment(self):
        for identifier, action in [
            ("CASE-567", "Owner task-specific HOLD. No external action is authorized."),
            ("CASE-570", "Owner vendor-channel HOLD. Do not contact the vendor or modify the advisory."),
        ]:
            row = issue(
                identifier,
                status="blocked",
                unblockDescriptor={"owner": {"agentId": A_IMPL}, "action": action},
                interactions=[{
                    "id": f"aaaaaaaa-0000-4000-8000-{int(identifier.split('-')[-1]):012d}",
                    "status": "pending",
                    "effectiveResolverPolicy": "board_or_agents",
                    "addresseeAgentId": A_REVIEW,
                }],
                runs=[{
                    "runId": f"bbbbbbbb-0000-4000-8000-{int(identifier.split('-')[-1]):012d}",
                    "agentId": A_IMPL,
                    "status": "running",
                }],
                treeControlState={"activePauseHold": None},
            )
            proposals = lr.proposals_for_issue(row, retry_limit=1)
            self.assertEqual([(p.reason, p.mutation) for p in proposals], [("owner_hold_unenforced", "create_pause_hold")])
            self.assertEqual(proposals[0].after["activePauseHold"]["mode"], "pause")

            enforced = copy.deepcopy(row)
            enforced["runs"] = []
            enforced["treeControlState"] = {"activePauseHold": {
                "id": "pause-hold", "mode": "pause", "status": "active",
            }}
            proposals = lr.proposals_for_issue(enforced, retry_limit=1)
            self.assertEqual({p.mutation for p in proposals}, {"none"})
            self.assertEqual({p.reason for p in proposals}, {"owner_hold"})

    def test_all_owner_hold_trigger_variants_converge_to_one_pause_hold(self):
        descriptor = {"owner": {"agentId": A_IMPL}, "action": "Owner task-specific HOLD. Do not proceed."}
        for trigger, changes in [
            ("interaction_resolution", {"interactions": [{"id": "card", "status": "accepted", "addresseeAgentId": A_REVIEW}]}),
            ("comment_reopen", {"comments": [{"id": "hold", "authorType": "user", "authorUserId": "owner", "body": descriptor["action"]}]}),
            ("blocked_status_patch", {}),
        ]:
            row = issue(
                "CASE-567", status="in_progress", unblockDescriptor=descriptor,
                runs=[{"runId": trigger, "agentId": A_IMPL, "status": "queued"}],
                treeControlState={"activePauseHold": None},
                **changes,
            )
            proposals = lr.proposals_for_issue(row, retry_limit=1)
            self.assertEqual([(p.reason, p.mutation) for p in proposals], [("owner_hold_unenforced", "create_pause_hold")])

    def test_pause_hold_apply_makes_no_issue_patch_or_comment(self):
        row = issue(
            "CASE-567", status="in_progress",
            unblockDescriptor={"owner": {"agentId": A_IMPL}, "action": "Owner task-specific HOLD. Do not proceed."},
            runs=[{"runId": "mutation-wake", "agentId": A_IMPL, "status": "running"}],
            treeControlState={"activePauseHold": None},
        )
        proposal = lr.proposals_for_issue(row, retry_limit=1)[0]

        class RecordingApi:
            def __init__(self): self.calls = []; self.held = False
            def get(self, path):
                if path.endswith("/interactions"): return row["interactions"]
                if path.endswith("/runs"): return [] if self.held else row["runs"]
                if "/comments" in path: return row["comments"]
                if path.endswith("/activity"): return row["activity"]
                if path.endswith("/recovery-actions"): return row["recoveryActions"]
                if path.endswith("/tree-control/state"):
                    return {"activePauseHold": {"id": "pause", "mode": "pause", "status": "active"}} if self.held else row["treeControlState"]
                if path.endswith("/diagnostics/blockers"): return {"readiness": {"isDependencyReady": True}}
                return dict(row)
            def post(self, path, body):
                self.calls.append((path, body))
                self.held = True
                return {"hold": {"id": "pause", "mode": "pause", "status": "active"}, "preview": {}}
            def patch(self, path, body):
                raise AssertionError("held issue must not be patched")

        api = RecordingApi()
        result = lr.apply_proposal(api, row, proposal)
        self.assertEqual(result["outcome"], "applied")
        self.assertEqual([path for path, _ in api.calls], [f"/api/issues/{row['id']}/tree-holds"])
        self.assertEqual(api.calls[0][1]["mode"], "pause")
        self.assertEqual(api.calls[0][1]["releasePolicy"]["strategy"], "manual")

    def test_existing_pause_hold_deduplicates_containment(self):
        row = issue(
            "CASE-567", status="blocked",
            unblockDescriptor={"owner": {"agentId": A_IMPL}, "action": "Owner task-specific HOLD. Do not proceed."},
            runs=[],
            treeControlState={"activePauseHold": {"id": "pause", "mode": "pause", "status": "active"}},
        )
        proposals = lr.proposals_for_issue(row, retry_limit=1)
        self.assertFalse(any(p.mutation == "create_pause_hold" for p in proposals))

    def test_pause_hold_live_revalidation_refuses_duplicate(self):
        row = issue(
            "CASE-567", status="blocked",
            unblockDescriptor={"owner": {"agentId": A_IMPL}, "action": "Owner task-specific HOLD. Do not proceed."},
            treeControlState={"activePauseHold": None},
        )
        proposal = lr.proposals_for_issue(row, retry_limit=1)[0]
        live = copy.deepcopy(row)
        live["treeControlState"] = {"activePauseHold": {"id": "pause", "mode": "pause", "status": "active"}}
        with self.assertRaisesRegex(lr.ReconcilerError, "no longer needed"):
            lr.validate_live_preconditions(live, proposal, {"id": A_REVIEW, "companyId": row["companyId"], "status": "idle", "orgChainHealth": {"status": "healthy"}})

    def test_pause_hold_apply_fails_if_run_survives_containment(self):
        row = issue(
            "CASE-570", status="blocked",
            unblockDescriptor={"owner": {"agentId": A_IMPL}, "action": "Owner vendor-channel HOLD. Do not contact the vendor."},
            runs=[{"runId": "survivor", "agentId": A_IMPL, "status": "queued"}],
            treeControlState={"activePauseHold": None},
        )
        proposal = lr.proposals_for_issue(row, retry_limit=1)[0]

        class Api:
            def __init__(self): self.held = False
            def get(self, path):
                if path.endswith("/interactions"): return row["interactions"]
                if path.endswith("/runs"): return row["runs"]
                if "/comments" in path: return row["comments"]
                if path.endswith("/activity"): return row["activity"]
                if path.endswith("/recovery-actions"): return row["recoveryActions"]
                if path.endswith("/tree-control/state"):
                    return {"activePauseHold": {"id": "pause", "mode": "pause", "status": "active"}} if self.held else row["treeControlState"]
                if path.endswith("/diagnostics/blockers"): return {"readiness": {"isDependencyReady": True}}
                return dict(row)
            def post(self, path, body):
                if path.endswith("/tree-holds"):
                    self.held = True
                    return {"hold": {"id": "pause", "mode": "pause", "status": "active"}, "preview": {}}
                return {"runId": "survivor", "status": "running"}

        with self.assertRaisesRegex(lr.ReconcilerError, "fallback cancellation did not cancel"):
            lr.apply_proposal(Api(), row, proposal)

    def test_pause_hold_fallback_cancels_surviving_run(self):
        row = issue(
            "CASE-570", status="blocked",
            unblockDescriptor={"owner": {"agentId": A_IMPL}, "action": "Owner vendor-channel HOLD. Do not contact the vendor."},
            runs=[{"runId": "survivor", "agentId": A_IMPL, "status": "queued"}],
            treeControlState={"activePauseHold": None},
        )
        proposal = lr.proposals_for_issue(row, retry_limit=1)[0]

        class Api:
            def __init__(self): self.held = False; self.cancelled = False; self.calls = []
            def get(self, path):
                if path.endswith("/interactions"): return row["interactions"]
                if path.endswith("/runs"): return [] if self.cancelled else row["runs"]
                if "/comments" in path: return row["comments"]
                if path.endswith("/activity"): return row["activity"]
                if path.endswith("/recovery-actions"): return row["recoveryActions"]
                if path.endswith("/tree-control/state"):
                    return {"activePauseHold": {"id": "pause", "mode": "pause", "status": "active"}} if self.held else row["treeControlState"]
                if path.endswith("/diagnostics/blockers"): return {"readiness": {"isDependencyReady": True}}
                return dict(row)
            def post(self, path, body):
                self.calls.append((path, body))
                if path.endswith("/tree-holds"):
                    self.held = True
                    return {"hold": {"id": "pause", "mode": "pause", "status": "active"}, "preview": {}}
                self.cancelled = True
                return {"runId": "survivor", "status": "cancelled"}

        api = Api()
        result = lr.apply_proposal(api, row, proposal)
        self.assertEqual(result["outcome"], "applied")
        self.assertEqual([path for path, _ in api.calls], [
            f"/api/issues/{row['id']}/tree-holds",
            "/api/heartbeat-runs/survivor/cancel",
        ])

    def test_owner_hold_status_drift_enforces_pause_then_restores_blocked(self):
        descriptor = {"owner": {"agentId": A_IMPL}, "action": "Owner task-specific HOLD. Do not proceed."}
        row = issue("CASE-567", status="in_progress", unblockDescriptor=descriptor, treeControlState={"activePauseHold": None})
        proposals = lr.proposals_for_issue(row, retry_limit=1)
        self.assertEqual([p.mutation for p in proposals], ["create_pause_hold"])
        self.assertEqual(proposals[0].reason, "owner_hold_unenforced")

        held = copy.deepcopy(row)
        held["treeControlState"] = {"activePauseHold": {"id": "pause", "mode": "pause", "status": "active"}}
        proposals = lr.proposals_for_issue(held, retry_limit=1)
        self.assertEqual([(p.reason, p.mutation) for p in proposals], [("owner_hold_status_drift", "restore_blocked")])
        self.assertEqual(proposals[0].after["status"], "blocked")

    def test_restore_blocked_apply_cancels_mutation_triggered_run(self):
        descriptor = {"owner": {"agentId": A_IMPL}, "action": "Owner task-specific HOLD. Do not proceed."}
        row = issue(
            "CASE-567", status="in_progress", unblockDescriptor=descriptor,
            treeControlState={"activePauseHold": {"id": "pause", "mode": "pause", "status": "active"}},
        )
        proposal = lr.proposals_for_issue(row, retry_limit=1)[0]
        class Api:
            def __init__(self): self.restored = False; self.cancelled = False; self.calls = []
            def get(self, path):
                if path.endswith("/interactions"): return []
                if path.endswith("/runs"):
                    if self.cancelled: return []
                    return [{"runId": "wake", "status": "queued", "agentId": A_IMPL}] if self.restored else []
                if "/comments" in path: return []
                if path.endswith("/activity"): return []
                if path.endswith("/recovery-actions"): return {"actions": []}
                if path.endswith("/tree-control/state"): return row["treeControlState"]
                if path.endswith("/diagnostics/blockers"): return {"readiness": {"isDependencyReady": False}}
                return dict(row, status="blocked" if self.restored else "in_progress")
            def patch(self, path, body):
                self.calls.append(("PATCH", path, body)); self.restored = True
                return {"status": "blocked"}
            def post(self, path, body):
                self.calls.append(("POST", path, body)); self.cancelled = True
                return {"status": "cancelled"}
        api = Api()
        result = lr.apply_proposal(api, row, proposal)
        self.assertEqual(result["outcome"], "applied")
        self.assertEqual(api.calls[0], ("PATCH", f"/api/issues/{row['id']}", {"status": "blocked", "unblockDescriptor": descriptor}))
        self.assertEqual(api.calls[1][1], "/api/heartbeat-runs/wake/cancel")

    def test_terminal_issue_with_historical_hold_is_not_reopened(self):
        row = issue(
            "CASE-561",
            status="done",
            comments=[{
                "id": "dddddddd-0000-4000-8000-000000000561",
                "authorType": "user",
                "authorUserId": "owner",
                "body": "HOLD external execution. Do not proceed.",
            }],
        )
        self.assertEqual(lr.proposals_for_issue(row, retry_limit=1), [])

    def test_scoped_do_not_modify_instruction_is_not_owner_hold(self):
        row = issue("CASE-548", comments=[{
            "id": "instruction", "authorType": "user", "authorUserId": "owner",
            "body": "Do not modify generated files; update only the source.",
        }])
        self.assertEqual(lr.issue_has_owner_hold(row), (False, None))

    def test_historical_review_do_not_merge_comment_is_not_owner_hold(self):
        row = issue("CASE-542", comments=[{
            "id": "review", "authorType": "user", "authorUserId": "owner",
            "body": "Perform an independent review; do not infer approval and do not merge without a merits verdict.",
        }])
        self.assertEqual(lr.issue_has_owner_hold(row), (False, None))

    def test_historical_dependency_do_not_resume_comment_is_not_owner_hold(self):
        row = issue("CASE-542", comments=[{
            "id": "dependency", "authorType": "user", "authorUserId": "owner",
            "body": "Do not resume blocker-dependent implementation yet; keep the task blocked until CI is terminal-success.",
        }])
        self.assertEqual(lr.issue_has_owner_hold(row), (False, None))

    def test_explicit_comment_hold_remains_detected(self):
        row = issue("CASE-567", comments=[{
            "id": "hold", "authorType": "user", "authorUserId": "owner",
            "body": "Owner scope directive: HOLD external execution. Do not deploy Cloudflare resources.",
        }])
        self.assertTrue(lr.issue_has_owner_hold(row)[0])

    def test_nonterminal_comment_hold_enforces_pause_without_inventing_descriptor(self):
        row = issue(
            "CASE-567",
            status="in_progress",
            unblockDescriptor=None,
            comments=[{
                "id": "dddddddd-0000-4000-8000-000000000567",
                "authorType": "user",
                "authorUserId": "owner",
                "body": "Owner task-specific HOLD. Do not proceed.",
            }],
            treeControlState={"activePauseHold": None},
        )
        proposals = lr.proposals_for_issue(row, retry_limit=1)
        self.assertEqual([p.mutation for p in proposals], ["create_pause_hold"])
        self.assertEqual(proposals[0].reason, "owner_hold_unenforced")
        self.assertIsNone(proposals[0].after.get("unblockDescriptor"))


class OutputAndBounds(unittest.TestCase):
    def test_dry_run_names_reason_and_mutation_without_api_calls(self):
        data = {"issues": [issue(
            "CASE-548",
            status="in_review",
            interactions=[{"id": "aaaaaaaa-0000-4000-8000-000000000548", "status": "pending", "effectiveResolverPolicy": "board_or_agents", "addresseeAgentId": A_REVIEW}],
        )]}
        with patch.object(lr.FixtureDataSource, "load", return_value=data):
            out = io.StringIO()
            with redirect_stdout(out):
                rc = lr.main(["--fixture", "unused.json"])
        self.assertEqual(rc, 0)
        records = [json.loads(line) for line in out.getvalue().splitlines()]
        proposal = next(record for record in records if record["type"] == "proposal")
        self.assertEqual(proposal["mode"], "dry-run")
        self.assertEqual(proposal["reason"], "interaction_addressee_mismatch")
        self.assertEqual(proposal["mutation"], "none")
        self.assertNotIn("apply", proposal)

    def test_apply_deduplicates_existing_marker(self):
        row = issue(
            "CASE-584", status="blocked", assigneeAgentId=None,
            unblockDescriptor={"owner": {"agentId": A_CREATOR}, "action": "Take the ready blocker."},
            readyBlocker=True,
        )
        proposal = lr.proposals_for_issue(row, retry_limit=1)[0]
        marker = f"liveness-reconciler:{proposal.fingerprint}"
        live = dict(row)
        live.pop("readyBlocker")
        live["blockedBy"] = []
        live["comments"] = [{"id": "old", "body": marker}]
        class Api:
            def get(self, path):
                if path == f"/api/agents/{A_CREATOR}":
                    return {"id": A_CREATOR, "companyId": row["companyId"], "status": "idle", "orgChainHealth": {"status": "healthy"}}
                if path.endswith("/interactions"): return live["interactions"]
                if path.endswith("/runs"): return live["runs"]
                if "/comments" in path: return live["comments"]
                if path.endswith("/activity"): return live["activity"]
                if path.endswith("/recovery-actions"): return live["recoveryActions"]
                if path.endswith("/diagnostics/blockers"): return {"readiness": {"isDependencyReady": True}}
                return dict(live)
        self.assertEqual(lr.apply_proposal(Api(), row, proposal)["outcome"], "deduplicated")

    def test_apply_against_fixture_is_simulated(self):
        data = {"issues": [issue(
            "CASE-573",
            status="in_progress",
            runs=[{
                "runId": "825334e4-4db2-434b-a100-2b1eeb7bda31",
                "agentId": A_IMPL,
                "status": "interrupted",
                "errorCode": "orphaned_running_run",
            }],
        )]}
        with patch.object(lr.FixtureDataSource, "load", return_value=data):
            out = io.StringIO()
            with redirect_stdout(out):
                rc = lr.main(["--fixture", "unused.json", "--apply"])
        self.assertEqual(rc, 0)
        proposal = next(json.loads(line) for line in out.getvalue().splitlines() if '"type": "proposal"' in line)
        self.assertEqual(proposal["apply"]["outcome"], "fixture_simulated")

    def test_service_preflight_refuses_non_board_key(self):
        class Api:
            def get(self, path): return {"source": "agent_key", "userId": None}
        with self.assertRaisesRegex(lr.ReconcilerError, "dedicated board API key"):
            lr.check_service_credential(Api(), "company", "issue", "agent")

    def test_service_preflight_is_read_only_and_names_unprobed_writes(self):
        class Api:
            def __init__(self): self.calls = []
            def get(self, path):
                self.calls.append(path)
                if path == "/api/cli-auth/me":
                    return {"source": "board_key", "userId": "board-user", "isInstanceAdmin": False,
                            "memberships": [{"companyId": "company", "status": "active", "role": "admin"}]}
                return {"ok": True}
        api = Api()
        out = io.StringIO()
        with redirect_stdout(out):
            rc = lr.check_service_credential(api, "company", "controlled", "agent")
        self.assertEqual(rc, 0)
        record = json.loads(out.getvalue())
        self.assertIn("tree_control_state", record["capabilities"])
        self.assertIn("agent_manage_authority", record["capabilities"])
        self.assertIn("tasks:assign", record["unprobedWriteAuthorities"])
        self.assertEqual(api.calls[-1], "/api/agents/agent/keys")
        self.assertFalse(any("preview" in path for path in api.calls))

    def test_service_preflight_fails_on_missing_board_only_read(self):
        class Api:
            def get(self, path):
                if path == "/api/cli-auth/me":
                    return {"source": "board_key", "userId": "board-user", "isInstanceAdmin": True, "memberships": []}
                if path.endswith("/tree-control/state"):
                    raise lr.ReconcilerError("HTTP 403 Board access required")
                return {"ok": True}
        with self.assertRaisesRegex(lr.ReconcilerError, "Board access required"):
            lr.check_service_credential(Api(), "company", "controlled", "agent")

    def test_service_preflight_requires_active_write_membership(self):
        class Api:
            def get(self, path):
                return {"source": "board_key", "userId": "board-user", "isInstanceAdmin": False,
                        "memberships": [{"companyId": "company", "status": "active", "role": "viewer"}]}
        with self.assertRaisesRegex(lr.ReconcilerError, "active write membership"):
            lr.check_service_credential(Api(), "company", "controlled", "agent")

    def test_live_apply_without_api_credentials_is_usage_error(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(lr.sys, "argv", ["liveness_reconciler.py"]):
            with self.assertRaises(SystemExit) as caught:
                lr.parse_args(["--apply", "--source-cmd", "fixture-source"])
        self.assertEqual(caught.exception.code, 2)

    def test_source_command_failure_is_not_clean(self):
        with patch("subprocess.run") as run:
            run.return_value.returncode = 7
            run.return_value.stderr = "database unavailable"
            run.return_value.stdout = ""
            with self.assertRaisesRegex(lr.ReconcilerError, "exited 7"):
                lr.CommandDataSource("fixture-source").load()

    def test_planning_dedup_does_not_starve_later_repairs(self):
        marked = issue("CASE-100", status="todo", assigneeAgentId=None, readyBlocker=True)
        decision = lr.proposals_for_issue(marked, retry_limit=1)[0]
        marked["comments"] = [{"id": "old", "body": f"liveness-reconciler:{decision.fingerprint}"}]
        actionable = issue(
            "CASE-900", status="blocked", assigneeAgentId=None, readyBlocker=True,
            unblockDescriptor={"owner": {"agentId": A_CREATOR}, "action": "Take the ready blocker."},
        )
        proposals = lr.plan({"issues": [marked, actionable]}, retry_limit=1, max_repairs=1)
        self.assertEqual([(p.identifier, p.mutation) for p in proposals], [("CASE-900", "assign_blocker_owner")])

    def test_repair_cap_is_explicit_not_silent(self):
        data = {"issues": [
            issue("CASE-548", status="blocked", assigneeAgentId=None, readyBlocker=True,
                  unblockDescriptor={"owner": {"agentId": A_CREATOR}, "action": "Take the ready blocker."}),
            issue("CASE-565", status="blocked", assigneeAgentId=None, readyBlocker=True,
                  unblockDescriptor={"owner": {"agentId": A_REVIEW}, "action": "Take the ready blocker."}),
        ]}
        proposals = lr.plan(data, retry_limit=1, max_repairs=1)
        self.assertEqual(proposals[0].mutation, "assign_blocker_owner")
        self.assertEqual(proposals[1].reason, "rate_limited")
        self.assertEqual(proposals[1].mutation, "none")

    def test_repair_cap_counts_operator_decision_comments(self):
        data = {"issues": [
            issue(f"CASE-{600+i}", status="todo", assigneeAgentId=None, readyBlocker=True)
            for i in range(4)
        ]}
        proposals = lr.plan(data, retry_limit=1, max_repairs=1)
        self.assertEqual(proposals[0].mutation, "operator_decision")
        self.assertEqual(sum(p.reason == "rate_limited" for p in proposals), 3)

    def test_committed_four_case_fixture_is_load_bearing(self):
        data = lr.FixtureDataSource(str(ROOT / "test/fixtures/liveness-reconciler-four-cases.json")).load()
        proposals = lr.plan(data, retry_limit=1, max_repairs=5)
        self.assertEqual(
            [(p.identifier, p.mutation) for p in proposals],
            [("CASE-548", "none"), ("CASE-573", "none"),
             ("CASE-584", "operator_decision"), ("CASE-567", "create_pause_hold")],
        )

    def test_terminal_issue_suppresses_every_trigger(self):
        row = issue(
            "CASE-573", status="done", assigneeAgentId=None, readyBlocker=True,
            interactions=[{"id": "card", "status": "pending", "effectiveResolverPolicy": "board_or_agents", "addresseeAgentId": A_REVIEW}],
            runs=[{"runId": "orphan", "agentId": A_IMPL, "status": "interrupted", "errorCode": "orphaned_running_run"}],
        )
        self.assertEqual(lr.proposals_for_issue(row, retry_limit=1), [])

    def test_zero_issues_refuses_clean_cycle(self):
        with self.assertRaisesRegex(lr.ReconcilerError, "zero issues"):
            lr.plan({"issues": []}, retry_limit=1, max_repairs=5)

    def test_max_repairs_zero_is_accepted_as_an_observe_only_cycle(self):
        # A first live cycle must be able to be *provably* incapable of a write,
        # not merely bounded to a few. --max-repairs 0 is the knob for that.
        with patch.dict(os.environ, {}, clear=True):
            args = lr.parse_args(["--max-repairs", "0", "--source-cmd", "fixture-source"])
        self.assertEqual(args.max_repairs, 0)

    def test_max_repairs_zero_proposes_but_mutates_nothing(self):
        data = {"issues": [
            issue("CASE-548", status="blocked", assigneeAgentId=None, readyBlocker=True,
                  unblockDescriptor={"owner": {"agentId": A_CREATOR}, "action": "Take the ready blocker."}),
            issue("CASE-565", status="blocked", assigneeAgentId=None, readyBlocker=True,
                  unblockDescriptor={"owner": {"agentId": A_REVIEW}, "action": "Take the ready blocker."}),
        ]}
        proposals = lr.plan(data, retry_limit=1, max_repairs=0)
        # Still reports what it would do -- observability is not sacrificed --
        # but every proposal is downgraded to a non-mutating rate_limited record.
        self.assertEqual(len(proposals), 2)
        self.assertTrue(all(p.mutation == "none" for p in proposals))
        self.assertTrue(all(p.reason == "rate_limited" for p in proposals))

    def test_negative_max_repairs_is_still_a_usage_error(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(SystemExit) as caught:
                lr.parse_args(["--max-repairs", "-1", "--source-cmd", "fixture-source"])
        self.assertEqual(caught.exception.code, 2)

    def test_retry_limit_zero_is_still_a_usage_error(self):
        # Only --max-repairs gains a zero floor; --retry-limit 0 would make the
        # staleness window meaningless rather than making the cycle safer.
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(SystemExit) as caught:
                lr.parse_args(["--retry-limit", "0", "--source-cmd", "fixture-source"])
        self.assertEqual(caught.exception.code, 2)


if __name__ == "__main__":
    unittest.main(verbosity=2, argv=[__file__])
