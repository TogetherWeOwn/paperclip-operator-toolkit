#!/usr/bin/env python3
"""Offline suite for pr_closeout_ledger.py.

Pure synthetic fixtures: no API, database, credential or timer. Green here
means the EVALUATOR works -- it is never a statement about GitHub, which CI
cannot reach.

WHAT THIS SUITE IS BUILT TO CATCH:

  * A MERGEABLE GREEN. mergeable_state=clean read as proof of checks. §1 pins
    that a clean-mergeable PR with a failed required check at the exact head
    is RED, and that a clean-mergeable PR with no check read at all is
    UNKNOWN. This is the Operator pr-hygiene hole the card names.
  * A STALE PROOF. Checks or a verdict recorded at a previous SHA reused as
    current proof after the head moved. §2 pins that only exact-SHA attempts
    count and that the superseded record is kept as history.
  * A TRUNCATED SHA. The 7-char prefix treated as canonical. §3 pins that a
    short SHA is UNKNOWN, never GREEN.
  * THE DRAFT/RELEASE MERGE NUDGE. A green draft or release-please PR routed
    toward merge. §4 pins OWNED_NO_AUTOMERGE for both.
  * THE STRANDED HANDBACK. A CHANGES verdict with no findings link, no
    executable action or no owner scored as closed. §5 pins CHANGES_STRANDED
    while §6 pins the executable shape closes as CHANGES_HANDBACK.
  * THE SILENT EXCLUSION. A decision_pending or parked record woken for work.
    §7 pins EXCLUDED never wakes and §8 pins PARKED without CEO evidence stays
    owned.
  * THE MERGE FLAG. merged=true with no verified SHA/URL recorded as MERGED.
    §9 pins that shape stays UNKNOWN_CHECKS; §10 pins the verified shape.
  * THE APPROVAL AS CLOSEOUT. APPROVE with the PR still open scored terminal.
    §11 pins APPROVED_WAIT_CI keeps an owner and a monitor.
  * THE LIVE CARD MUTATION. A proposal that mutates a card with a live run, a
    hold, a pending interaction, or a cancelled edge. §12 pins every barrier.
  * THE UNOWNED REPAIR. A missing_disposition or lapsed monitor repaired by
    the sweep itself. §13 pins diagnostic-only proposals with a named owner.
  * THE EXCLUDED WAKE. The excluded/parked cohort emitting any proposal at
    all. §14 pins silence.
"""

from __future__ import annotations

import datetime as dt
import json
import unittest

import pr_closeout_ledger as ledger

NOW = dt.datetime(2026, 10, 2, 17, 0, 0, tzinfo=dt.timezone.utc)
HEAD_A = "a" * 40
HEAD_B = "b" * 40
MERGE_SHA = "c" * 40

REQUIRED = ["check", "gitleaks", "pr-lint"]


def entry(**changes):
    base = {
        "repo": "two-web-next",
        "pr": 291,
        "admission": "admitted",
        "kind": "standard",
        "authorCard": "CARD-12",
        "successorCard": "CARD-12",
        "reviewerCard": "CARD-10",
    }
    base.update(changes)
    return base


def checks_at(head, conclusions=("success", "success", "success")):
    return [
        {"name": name, "sha": head, "conclusion": conclusion}
        for name, conclusion in zip(REQUIRED, conclusions)
    ]


def snapshot(head=HEAD_A, **changes):
    base = {
        "repo": "two-web-next",
        "pr": 291,
        "headSha": head,
        "mergeableState": "clean",
        "merged": False,
        "draft": False,
        "releasePlease": False,
        "checks": checks_at(head),
        "requiredChecks": list(REQUIRED),
        "companyIndependentReviewRequired": True,
        "companySecurityReviewRequired": False,
    }
    base.update(changes)
    return base


def approve(head=HEAD_A):
    return {"verdict": "APPROVE", "sha": head}


def changes_handback(head=HEAD_A):
    return {
        "verdict": "CHANGES",
        "sha": head,
        "findingsUrl": "https://example.invalid/findings",
        "executableAction": "fix the four safety findings and push",
    }


def card(identifier="CARD-12", **changes):
    base = {
        "id": "00000000-0000-4000-8000-000000000012",
        "identifier": identifier,
        "status": "in_progress",
        "ownerCard": identifier,
        "runs": [],
    }
    base.update(changes)
    return base


class MergeableIsNotGreen(unittest.TestCase):
    def test_clean_mergeable_with_failed_check_is_red(self):
        snap = snapshot()
        snap["checks"] = checks_at(HEAD_A, ("success", "failure", "success"))
        record = ledger.evaluate(entry(), snap, approve(), None, NOW)
        self.assertEqual(record["disposition"], "NEEDS_FIX")
        self.assertEqual(record["checkState"], "RED")

    def test_clean_mergeable_with_no_check_read_is_unknown(self):
        snap = snapshot(checks=None)
        record = ledger.evaluate(entry(), snap, approve(), None, NOW)
        self.assertEqual(record["checkState"], "UNKNOWN")
        self.assertEqual(record["disposition"], "UNKNOWN_CHECKS")

    def test_clean_mergeable_with_absent_required_name_is_unknown(self):
        snap = snapshot()
        snap["checks"] = [c for c in checks_at(HEAD_A) if c["name"] != "gitleaks"]
        record = ledger.evaluate(entry(), snap, approve(), None, NOW)
        self.assertEqual(record["checkState"], "UNKNOWN")
        self.assertIn("gitleaks", record["blocker"])


class StaleProof(unittest.TestCase):
    def test_moved_head_voids_prior_verdict(self):
        prior = {
            "createdAt": "2026-10-01T00:00:00Z",
            "headSha": HEAD_B,
            "checkState": "GREEN",
            "verdict": "APPROVE",
            "verdictSha": HEAD_B,
            "lastProgressAt": "2026-10-01T00:00:00Z",
        }
        record = ledger.evaluate(entry(), snapshot(HEAD_A), approve(HEAD_B), prior, NOW)
        self.assertEqual(record["verdict"], "NONE")
        self.assertIn("stale SHA", record["blocker"])
        self.assertEqual(record["disposition"], "NEEDS_REVIEW")
        self.assertEqual(record["history"][-1]["headSha"], HEAD_B)

    def test_moved_head_voids_prior_checks(self):
        snap = snapshot(HEAD_A)
        snap["checks"] = checks_at(HEAD_B)  # attempts only at the old head
        record = ledger.evaluate(entry(), snap, None, None, NOW)
        self.assertEqual(record["checkState"], "UNKNOWN")

    def test_truncated_sha_is_unknown(self):
        snap = snapshot(HEAD_A[:7])
        record = ledger.evaluate(entry(), snap, None, None, NOW)
        self.assertEqual(record["checkState"], "UNKNOWN")
        self.assertIn("full SHA", record["blocker"])


class DraftAndRelease(unittest.TestCase):
    def test_draft_never_automerges(self):
        record = ledger.evaluate(entry(kind="draft"), snapshot(), approve(), None, NOW)
        self.assertEqual(record["disposition"], "OWNED_NO_AUTOMERGE")

    def test_snapshot_draft_flag_never_automerges(self):
        record = ledger.evaluate(entry(), snapshot(draft=True), approve(), None, NOW)
        self.assertEqual(record["disposition"], "OWNED_NO_AUTOMERGE")

    def test_release_never_automerges(self):
        record = ledger.evaluate(
            entry(repo="two-bot-next", pr=71, kind="release",
                  standingOwner="Director"),
            snapshot(releasePlease=True), approve(), None, NOW)
        self.assertEqual(record["disposition"], "OWNED_NO_AUTOMERGE")
        self.assertEqual(record["nextActor"], "Director")

    def test_release_snapshot_flag_never_automerges(self):
        record = ledger.evaluate(entry(), snapshot(releasePlease=True), approve(), None, NOW)
        self.assertEqual(record["disposition"], "OWNED_NO_AUTOMERGE")

    def test_release_kind_only_never_automerges(self):
        record = ledger.evaluate(
            entry(kind="release", standingOwner="Director"),
            snapshot(), approve(), None, NOW)
        self.assertEqual(record["disposition"], "OWNED_NO_AUTOMERGE")

    def test_empty_required_checks_is_unknown(self):
        snap = snapshot(requiredChecks=[])
        record = ledger.evaluate(entry(), snap, approve(), None, NOW)
        self.assertEqual(record["checkState"], "UNKNOWN")
        self.assertEqual(record["disposition"], "UNKNOWN_CHECKS")

    def test_api_error_is_unknown(self):
        snap = snapshot(apiError="HTTP 403: rate limited")
        record = ledger.evaluate(entry(), snap, approve(), None, NOW)
        self.assertEqual(record["checkState"], "UNKNOWN")
        self.assertEqual(record["disposition"], "UNKNOWN_CHECKS")

    def test_pending_rerun_after_success_is_unknown(self):
        # An older success plus a newer result-less rerun at the same head
        # is a run still in flight, never green. The evidence keeps the
        # pending row with its id/time/status, not the stale success.
        snap = snapshot()
        snap["checks"] = [
            {"name": "check", "sha": HEAD_A, "conclusion": "success",
             "id": 101, "completedAt": "2026-10-02T15:00:00Z",
             "status": "completed"},
            {"name": "check", "sha": HEAD_A, "conclusion": None,
             "id": 102, "startedAt": "2026-10-02T16:00:00Z",
             "status": "in_progress"},
            {"name": "gitleaks", "sha": HEAD_A, "conclusion": "success",
             "id": 103, "completedAt": "2026-10-02T15:30:00Z",
             "status": "completed"},
            {"name": "pr-lint", "sha": HEAD_A, "conclusion": "success",
             "id": 104, "completedAt": "2026-10-02T15:30:00Z",
             "status": "completed"},
        ]
        record = ledger.evaluate(entry(), snap, approve(), None, NOW)
        self.assertEqual(record["checkState"], "UNKNOWN")
        self.assertIn("pending", record["blocker"])
        attempts = {a["name"]: a for a in record["requiredCheckAttempts"]}
        pending = attempts["check"]
        self.assertIsNone(pending["conclusion"])
        self.assertEqual(pending["attemptId"], 102)
        self.assertEqual(pending["status"], "in_progress")

    def test_reverse_api_order_picks_newest_result(self):
        # Rows may arrive newest-first: the verdict follows timestamps and
        # ids, never list position. Newer failure beats older success.
        snap = snapshot()
        snap["checks"] = [
            {"name": "check", "sha": HEAD_A, "conclusion": "failure",
             "id": 202, "completedAt": "2026-10-02T16:00:00Z",
             "status": "completed"},
            {"name": "check", "sha": HEAD_A, "conclusion": "success",
             "id": 201, "completedAt": "2026-10-02T15:00:00Z",
             "status": "completed"},
            {"name": "gitleaks", "sha": HEAD_A, "conclusion": "success",
             "id": 203, "completedAt": "2026-10-02T15:30:00Z",
             "status": "completed"},
            {"name": "pr-lint", "sha": HEAD_A, "conclusion": "success",
             "id": 204, "completedAt": "2026-10-02T15:30:00Z",
             "status": "completed"},
        ]
        record = ledger.evaluate(entry(), snap, approve(), None, NOW)
        self.assertEqual(record["checkState"], "RED")
        self.assertEqual(record["disposition"], "NEEDS_FIX")
        attempts = {a["name"]: a for a in record["requiredCheckAttempts"]}
        self.assertEqual(attempts["check"]["conclusion"], "failure")
        self.assertEqual(attempts["check"]["attemptId"], 202)


class ChangesHandback(unittest.TestCase):
    def test_executable_handback_closes(self):
        record = ledger.evaluate(entry(), snapshot(), changes_handback(), None, NOW)
        self.assertEqual(record["disposition"], "CHANGES_HANDBACK")
        self.assertEqual(record["nextActor"], "CARD-12")

    def test_identical_changes_reread_keeps_windows(self):
        # A reread with identical findings/action/head is not progress: the
        # stall windows must not renew. Only a changed verdict moves them.
        first = ledger.evaluate(entry(), snapshot(), changes_handback(), None, NOW)
        self.assertEqual(first["lastProgressAt"], "2026-10-02T17:00:00Z")
        reread = ledger.evaluate(
            entry(), snapshot(), changes_handback(),
            {"createdAt": first["createdAt"],
             "lastProgressAt": first["lastProgressAt"],
             "disposition": first["disposition"],
             "verdictSha": first["verdictSha"],
             "blocker": first["blocker"],
             "nextAction": first["nextAction"],
             "history": first["history"]},
            NOW + dt.timedelta(hours=2))
        self.assertEqual(reread["disposition"], "CHANGES_HANDBACK")
        self.assertEqual(reread["lastProgressAt"], "2026-10-02T17:00:00Z")
        self.assertEqual(reread["deadlineDirectorAt"], first["deadlineDirectorAt"])
        self.assertEqual(reread["deadlineCeoAt"], first["deadlineCeoAt"])
        self.assertEqual(reread["nextCheckAt"], "2026-10-02T20:00:00Z")

    def test_changed_changes_action_renews_windows(self):
        first = ledger.evaluate(entry(), snapshot(), changes_handback(), None, NOW)
        updated = changes_handback()
        updated["executableAction"] = "fix the four safety findings, add a test, and push"
        reread = ledger.evaluate(
            entry(), snapshot(), updated,
            {"createdAt": first["createdAt"],
             "lastProgressAt": first["lastProgressAt"],
             "disposition": first["disposition"],
             "verdictSha": first["verdictSha"],
             "blocker": first["blocker"],
             "nextAction": first["nextAction"],
             "history": first["history"]},
            NOW + dt.timedelta(hours=2))
        self.assertEqual(reread["lastProgressAt"], "2026-10-02T19:00:00Z")

    def test_handback_without_findings_is_stranded(self):
        review = changes_handback()
        del review["findingsUrl"]
        record = ledger.evaluate(entry(), snapshot(), review, None, NOW)
        self.assertEqual(record["disposition"], "CHANGES_STRANDED")
        self.assertEqual(record["nextActor"], "Director")

    def test_handback_without_action_is_stranded(self):
        review = changes_handback()
        del review["executableAction"]
        record = ledger.evaluate(entry(), snapshot(), review, None, NOW)
        self.assertEqual(record["disposition"], "CHANGES_STRANDED")

    def test_handback_without_owner_is_stranded(self):
        record = ledger.evaluate(
            entry(authorCard=None, successorCard=None), snapshot(),
            changes_handback(), None, NOW)
        self.assertEqual(record["disposition"], "CHANGES_STRANDED")


class ExcludedAndParked(unittest.TestCase):
    def test_decision_pending_is_excluded(self):
        record = ledger.evaluate(
            entry(admission="decision_pending"), snapshot(), approve(), None, NOW)
        self.assertEqual(record["disposition"], "EXCLUDED")
        self.assertEqual(record["nextActor"], "CEO")

    def test_parked_without_ceo_evidence_stays_owned(self):
        prior = {
            "createdAt": "2026-10-01T00:00:00Z",
            "disposition": "PARKED",
            "lastProgressAt": "2026-10-01T00:00:00Z",
        }
        record = ledger.evaluate(entry(), snapshot(), approve(), prior, NOW)
        self.assertEqual(record["disposition"], "UNKNOWN_CHECKS")
        self.assertEqual(record["nextActor"], "CEO")

    def test_parked_with_ceo_evidence_holds(self):
        prior = {
            "createdAt": "2026-10-01T00:00:00Z",
            "disposition": "PARKED",
            "lastProgressAt": "2026-10-01T00:00:00Z",
        }
        record = ledger.evaluate(
            entry(ceoEvidence="CEO decision link"), snapshot(), approve(), prior, NOW)
        self.assertEqual(record["disposition"], "PARKED")


class CanonicalEvidence(unittest.TestCase):
    def test_record_preserves_required_check_attempts(self):
        # The canonical output keeps the per-name latest exact-head attempts
        # the verdict rested on -- names, SHAs, conclusions, attempt id,
        # timestamps and status -- not only the summary checkState. A missing
        # required name is a marked gap.
        snap = snapshot()
        snap["checks"] = [c for c in checks_at(HEAD_A) if c["name"] != "gitleaks"]
        record = ledger.evaluate(entry(), snap, approve(), None, NOW)
        attempts = {a["name"]: a for a in record["requiredCheckAttempts"]}
        self.assertEqual(set(attempts), set(REQUIRED))
        self.assertEqual(attempts["check"]["sha"], HEAD_A)
        self.assertEqual(attempts["check"]["conclusion"], "success")
        self.assertIn("attemptId", attempts["check"])
        self.assertIn("completedAt", attempts["check"])
        self.assertIn("status", attempts["check"])
        self.assertEqual(attempts["pr-lint"]["conclusion"], "success")
        self.assertEqual(attempts["gitleaks"],
                         {"name": "gitleaks", "sha": None, "conclusion": "missing"})

    def test_record_preserves_off_head_attempt_as_unknown(self):
        # Attempts at any other SHA are still recorded as evidence rows (a
        # reviewer replays from them) while the verdict stays UNKNOWN.
        snap = snapshot(HEAD_A)
        snap["checks"] = checks_at(HEAD_B)
        record = ledger.evaluate(entry(), snap, None, None, NOW)
        self.assertEqual(record["checkState"], "UNKNOWN")
        for attempt in record["requiredCheckAttempts"]:
            self.assertEqual(attempt["sha"], None)
            self.assertEqual(attempt["conclusion"], "missing")

    def test_admission_age_and_delivery_deadline_preserved(self):
        record = ledger.evaluate(
            entry(admittedAt="2026-10-01T17:00:00Z",
                  deliveryDeadline="2026-10-03T14:00:00Z"),
            snapshot(), approve(), None, NOW)
        self.assertEqual(record["admittedAt"], "2026-10-01T17:00:00Z")
        self.assertEqual(record["admissionProvenance"], "registry")
        self.assertEqual(record["admissionAgeHours"], 24.0)
        self.assertEqual(record["deliveryDeadline"], "2026-10-03T14:00:00Z")

    def test_admission_age_defaults_to_first_sight(self):
        record = ledger.evaluate(entry(), snapshot(), approve(), None, NOW)
        self.assertEqual(record["admittedAt"], record["createdAt"])
        self.assertEqual(record["admissionProvenance"], "first_sight")
        self.assertEqual(record["admissionAgeHours"], 0.0)
        self.assertIsNone(record["deliveryDeadline"])

    def test_bad_optional_evidence_is_a_gap_not_a_refusal(self):
        # An unparseable optional timestamp must not refuse the board: it is
        # carried as a None gap alongside the verdict.
        record = ledger.evaluate(
            entry(admittedAt="not-a-time"), snapshot(), approve(), None, NOW)
        self.assertIsNone(record["admittedAt"])
        self.assertEqual(record["admissionProvenance"], "missing")
        self.assertIsNone(record["admissionAgeHours"])
        self.assertEqual(record["checkState"], "GREEN")

    def test_invalid_delivery_deadline_is_none_not_raw(self):
        # A corrupt delivery promise normalizes like admittedAt: None gap,
        # never the raw string.
        record = ledger.evaluate(
            entry(deliveryDeadline="soon-ish"), snapshot(), approve(), None, NOW)
        self.assertIsNone(record["deliveryDeadline"])
        self.assertEqual(record["checkState"], "GREEN")


class MergeProof(unittest.TestCase):
    def test_merge_flag_without_sha_is_not_merged(self):
        snap = snapshot(merged=True, mergeCommitSha=None, mergeUrl=None)
        record = ledger.evaluate(entry(), snap, approve(), None, NOW)
        self.assertNotEqual(record["disposition"], "MERGED")
        self.assertEqual(record["disposition"], "UNKNOWN_CHECKS")

    def test_verified_merge_closes(self):
        snap = snapshot(merged=True, mergeCommitSha=MERGE_SHA,
                        mergeUrl="https://github.com/o/r/pull/291#merge")
        record = ledger.evaluate(entry(), snap, approve(), None, NOW)
        self.assertEqual(record["disposition"], "MERGED")
        self.assertEqual(record["mergeCommitSha"], MERGE_SHA)


class ApprovalIsNotCloseout(unittest.TestCase):
    def test_approve_open_pr_stays_owned_monitored(self):
        record = ledger.evaluate(entry(), snapshot(), approve(), None, NOW)
        self.assertEqual(record["disposition"], "APPROVED_WAIT_CI")
        self.assertEqual(record["nextActor"], "CARD-10")
        self.assertIsNotNone(record["nextCheckAt"])

    def test_approve_without_reviewer_card_needs_review(self):
        record = ledger.evaluate(
            entry(reviewerCard=None), snapshot(), approve(), None, NOW)
        self.assertEqual(record["disposition"], "NEEDS_REVIEW")

    def test_approve_with_open_security_gate_needs_review(self):
        snap = snapshot(companySecurityReviewRequired=True)
        record = ledger.evaluate(
            entry(securityCard="CARD-11"), snap, approve(), None, NOW)
        self.assertEqual(record["disposition"], "NEEDS_REVIEW")
        self.assertEqual(record["nextActor"], "CARD-11")


class BoundedLiveness(unittest.TestCase):
    def ledger_row(self, **changes):
        record = ledger.evaluate(entry(), snapshot(), approve(), None, NOW)
        record.update(changes)
        return record

    def plan(self, record, cards):
        return ledger.plan_proposals(
            {record["key"]: record},
            {c["ownerCard"]: c for c in cards},
            NOW,
        )

    def test_live_run_blocks_mutation(self):
        proposals = self.plan(
            self.ledger_row(disposition="NEEDS_REVIEW", authorCard="CARD-1",
                            successorCard="CARD-1"),
            [card("CARD-1", runs=[{"status": "running"}])])
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "live_run")
        self.assertEqual(proposals[0].mutation, "none")

    def test_hold_blocks_mutation(self):
        proposals = self.plan(
            self.ledger_row(disposition="NEEDS_REVIEW", authorCard="CARD-1",
                            successorCard="CARD-1"),
            [card("CARD-1", holds=["owner hold on scope"])])
        self.assertEqual(proposals[0].reason, "owner_hold")

    def test_pending_interaction_blocks_mutation(self):
        proposals = self.plan(
            self.ledger_row(disposition="NEEDS_REVIEW", authorCard="CARD-1",
                            successorCard="CARD-1"),
            [card("CARD-1", pendingInteraction=True)])
        self.assertEqual(proposals[0].reason, "pending_interaction")

    def test_cancelled_edge_blocks_mutation(self):
        proposals = self.plan(
            self.ledger_row(disposition="NEEDS_REVIEW", authorCard="CARD-1",
                            successorCard="CARD-1"),
            [card("CARD-1", blockedBy=[{"status": "cancelled"}])])
        self.assertEqual(proposals[0].reason, "cancelled_edge")

    def test_terminal_card_blocks_mutation(self):
        proposals = self.plan(
            self.ledger_row(disposition="NEEDS_REVIEW", authorCard="CARD-1",
                            successorCard="CARD-1"),
            [card("CARD-1", status="done")])
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "terminal_card")
        self.assertEqual(proposals[0].mutation, "none")

    def test_native_recovery_blocks_mutation(self):
        proposals = self.plan(
            self.ledger_row(disposition="NEEDS_REVIEW", authorCard="CARD-1",
                            successorCard="CARD-1"),
            [card("CARD-1", recovery={"active": True})])
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "native_recovery_pending")
        self.assertEqual(proposals[0].mutation, "none")

    def test_review_gate_blocks_mutation(self):
        proposals = self.plan(
            self.ledger_row(disposition="NEEDS_REVIEW", authorCard="CARD-1",
                            successorCard="CARD-1"),
            [card("CARD-1", gated=True)])
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "review_gate")
        self.assertEqual(proposals[0].mutation, "none")

    def test_missing_disposition_is_diagnostic_with_owner(self):
        proposals = self.plan(
            self.ledger_row(disposition="UNKNOWN_CHECKS", authorCard="CARD-1",
                            successorCard="CARD-1"),
            [card("CARD-1")])
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "missing_disposition")
        self.assertEqual(proposals[0].mutation, "none")
        self.assertEqual(proposals[0].owner, "CARD-1")

    def test_lapsed_monitor_proposes_owned_recheck(self):
        proposals = self.plan(
            self.ledger_row(disposition="APPROVED_WAIT_CI", reviewerCard="CARD-9"),
            [card("CARD-9", monitor={"nextCheckAt": "2026-10-01T00:00:00Z",
                                    "attemptsLeft": 0, "maxAttempts": 3})])
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "monitor_lapsed")
        self.assertEqual(proposals[0].mutation, "none")
        self.assertEqual(proposals[0].owner, "CARD-9")

    def test_healthy_monitor_stays_silent_on_healthy_card(self):
        proposals = self.plan(
            self.ledger_row(disposition="APPROVED_WAIT_CI", reviewerCard="CARD-9"),
            [card("CARD-9", monitor={"nextCheckAt": "2026-10-03T00:00:00Z",
                                    "attemptsLeft": 2, "maxAttempts": 3})])
        self.assertEqual(proposals, [])

    def test_excluded_cohort_never_wakes(self):
        excluded = self.ledger_row(disposition="EXCLUDED", authorCard="CARD-1",
                                   successorCard="CARD-1", admission="decision_pending")
        parked = self.ledger_row(disposition="PARKED", authorCard="CARD-2",
                                 successorCard="CARD-2", ceoEvidence="link")
        proposals = ledger.plan_proposals(
            {excluded["key"]: excluded, parked["key"]: parked},
            {"CARD-1": card("CARD-1"), "CARD-2": card("CARD-2")},
            NOW,
        )
        self.assertEqual(proposals, [])

    def test_one_action_per_card_per_pass(self):
        first = self.ledger_row(disposition="UNKNOWN_CHECKS", authorCard="CARD-1",
                                successorCard="CARD-1", reviewerCard=None)
        second = dict(first)
        second["key"] = "two-web-next#292"
        second["pr"] = 292
        proposals = ledger.plan_proposals(
            {first["key"]: first, second["key"]: second},
            {"CARD-1": card("CARD-1")},
            NOW,
        )
        self.assertEqual(len(proposals), 1)

    def test_successor_preferred_over_author(self):
        record = self.ledger_row(disposition="UNKNOWN_CHECKS", authorCard="CARD-A",
                                 successorCard="CARD-B", reviewerCard=None,
                                 standingOwner=None)
        proposals = ledger.plan_proposals(
            {record["key"]: record},
            {"CARD-A": card("CARD-A"), "CARD-B": card("CARD-B")},
            NOW,
        )
        self.assertEqual([p.owner for p in proposals], ["CARD-B"])

    def test_unmapped_owner_routes_to_director(self):
        record = self.ledger_row(disposition="UNKNOWN_CHECKS", authorCard="CARD-X",
                                 successorCard="CARD-X", reviewerCard=None)
        proposals = ledger.plan_proposals({record["key"]: record}, {}, NOW)
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "owner_unmapped")
        self.assertEqual(proposals[0].owner, "Director")

    def test_approved_wait_ci_healthy_card_proposes_hold(self):
        record = self.ledger_row(disposition="APPROVED_WAIT_CI", authorCard="CARD-1",
                                 successorCard="CARD-1", reviewerCard=None)
        proposals = self.plan(record, [card("CARD-1")])
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "approved_wait_ci_owned")

    def test_proposal_carries_record_next_check_at(self):
        # The runbook says the plan provides nextCheckAt: every proposal must
        # carry the record's hourly recheck, barrier-held or not.
        record = self.ledger_row(disposition="NEEDS_REVIEW", authorCard="CARD-1",
                                 successorCard="CARD-1")
        proposals = self.plan(record, [card("CARD-1", holds=["owner hold"])])
        self.assertEqual(proposals[0].reason, "owner_hold")
        self.assertEqual(proposals[0].as_dict()["nextCheckAt"],
                         record["nextCheckAt"])
        self.assertEqual(record["nextCheckAt"], "2026-10-02T18:00:00Z")

    def test_blocked_dependency_is_diagnostic_with_owner(self):
        # A blocked author whose waited-on reviewer has no live row is an
        # owned wait on the blocked card, never missing_disposition -- and
        # never a promotion of the waited-on edge. The strand stays
        # off-chain: the wait is never resolved to the blocked card itself.
        record = self.ledger_row(disposition="NEEDS_REVIEW", authorCard="CARD-1",
                                 successorCard="CARD-1", reviewerCard="CARD-2")
        proposals = self.plan(
            record,
            [card("CARD-1", blockedBy=[{"identifier": "CARD-2",
                                       "status": "in_progress"}])])
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "blocked_dependency")
        self.assertEqual(proposals[0].mutation, "none")
        self.assertEqual(proposals[0].owner, "CARD-1")
        self.assertIn("waits on CARD-2", proposals[0].note)

    def test_dependency_check_reaches_live_reviewer(self):
        # The author row is absent but the reviewer row is live: the fallback
        # chain must surface the reviewer's own state, not owner_unmapped.
        record = self.ledger_row(disposition="NEEDS_REVIEW", authorCard="CARD-1",
                                 successorCard="CARD-1", reviewerCard="CARD-2")
        proposals = ledger.plan_proposals(
            {record["key"]: record},
            {"CARD-2": card("CARD-2", runs=[{"status": "running"}])},
            NOW,
        )
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "live_run")
        self.assertEqual(proposals[0].card_id, "CARD-2")

    def test_blocked_author_yields_to_live_reviewer(self):
        # Both rows present: the blocked author never absorbs the reviewer's
        # live run. The held reviewer owns the barrier, not the author.
        # The reviewer is deliberately FIRST in dict order here: only the
        # ownership-ordered walk (not dict position) puts CARD-R first.
        record = self.ledger_row(disposition="NEEDS_REVIEW", authorCard="CARD-A",
                                 successorCard="CARD-A", reviewerCard="CARD-R")
        proposals = ledger.plan_proposals(
            {record["key"]: record},
            {"CARD-R": card("CARD-R", runs=[{"status": "running"}]),
             "CARD-A": card("CARD-A", blockedBy=[{"identifier": "CARD-R",
                                                "status": "in_progress"}])},
            NOW,
        )
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "live_run")
        self.assertEqual(proposals[0].owner, "CARD-R")
        self.assertNotEqual(proposals[0].owner, "CARD-A")

    def test_second_chain_card_hold_wins_over_first_wait(self):
        # Order, not position: the author is merely waiting, but the reviewer
        # later in ownership order is hard-held. The walk must reach the
        # reviewer instead of stopping at the author's wait.
        # CARD-R is deliberately FIRST in dict order: only the
        # ownership-ordered walk (not dict position) checks CARD-A first and
        # still lands on CARD-R's hold. CARD-A is deliberately unblocked here:
        # the walk's job is reaching past a barrier-free first card, not
        # merely preferring a hold over an edge on the same card.
        record = self.ledger_row(disposition="NEEDS_REVIEW", authorCard="CARD-A",
                                 successorCard="CARD-A", reviewerCard="CARD-R")
        proposals = ledger.plan_proposals(
            {record["key"]: record},
            {"CARD-R": card("CARD-R", holds=["scope freeze"]),
             "CARD-A": card("CARD-A")},
            NOW,
        )
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "owner_hold")
        self.assertEqual(proposals[0].owner, "CARD-R")

    def test_idle_reviewer_owns_the_wait(self):
        # The reviewer is present but idle: the wait resolves to the reviewer,
        # who owns the unblock -- the author is not promoted into acting.
        record = self.ledger_row(disposition="NEEDS_REVIEW", authorCard="CARD-A",
                                 successorCard="CARD-A", reviewerCard="CARD-R")
        proposals = ledger.plan_proposals(
            {record["key"]: record},
            {"CARD-A": card("CARD-A", blockedBy=[{"identifier": "CARD-R",
                                                "status": "in_progress"}]),
             "CARD-R": card("CARD-R")},
            NOW,
        )
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "blocked_dependency")
        self.assertEqual(proposals[0].mutation, "none")
        self.assertEqual(proposals[0].owner, "CARD-R")
        self.assertIn("CARD-A", proposals[0].note)
        self.assertIn("CARD-R", proposals[0].note)

    def test_exhausted_reviewer_monitor_is_named(self):
        # The reviewer's liveness is checked, not assumed: a lapsed monitor
        # on the waited-on card is named with its re-arm action. The
        # reviewer is deliberately FIRST in dict order: only the
        # ownership-ordered walk (not dict position) resolves CARD-A's wait
        # to CARD-R at all.
        record = self.ledger_row(disposition="NEEDS_REVIEW", authorCard="CARD-A",
                                 successorCard="CARD-A", reviewerCard="CARD-R")
        proposals = ledger.plan_proposals(
            {record["key"]: record},
            {"CARD-R": card("CARD-R", monitor={"nextCheckAt": "2026-10-01T00:00:00Z",
                                             "attemptsLeft": 0, "maxAttempts": 3}),
             "CARD-A": card("CARD-A", blockedBy=[{"identifier": "CARD-R",
                                                "status": "in_progress"}])},
            NOW,
        )
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "blocked_dependency")
        self.assertEqual(proposals[0].owner, "CARD-R")
        self.assertIn("lapsed", proposals[0].note)
        self.assertIn("re-arm", proposals[0].note)

    def test_steward_edge_resolves_to_steward(self):
        # A wait on the DevOps CI steward resolves to the steward's own row:
        # its liveness (here a live run) is surfaced, not the author's.
        record = self.ledger_row(disposition="UNKNOWN_CHECKS", authorCard="CARD-A",
                                 successorCard="CARD-A", reviewerCard=None)
        proposals = ledger.plan_proposals(
            {record["key"]: record},
            {"CARD-A": card("CARD-A", blockedBy=[{"identifier": "STEWARD",
                                                "status": "in_progress"}]),
             "STEWARD": card("STEWARD", runs=[{"status": "queued"}])},
            NOW,
        )
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "live_run")
        self.assertEqual(proposals[0].owner, "STEWARD")

    def test_stall_overrides_soft_wait_with_ceo_row(self):
        # A soft dependency wait past the 24h window emits a real CEO
        # escalation row: timed diagnostics are owned rows, not annotations.
        prior = {
            "createdAt": "2026-10-01T00:00:00Z",
            "lastProgressAt": "2026-10-01T00:00:00Z",
        }
        record = ledger.evaluate(entry(), snapshot(), None, prior, NOW)
        proposals = ledger.plan_proposals(
            {record["key"]: record},
            {"CARD-12": card("CARD-12",
                               blockedBy=[{"identifier": "CARD-R",
                                           "status": "in_progress"}]),
             "CARD-R": card("CARD-R")},
            NOW,
        )
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "stall_ceo")
        self.assertEqual(proposals[0].mutation, "none")
        self.assertEqual(proposals[0].owner, "CEO")
        self.assertIn("CARD-R", proposals[0].note)

    def test_hard_hold_keeps_owner_with_stall_awareness(self):
        # A hard hold past the stall window keeps its owner and reason --
        # holds are never overridden -- but the timed diagnostic rides along.
        prior = {
            "createdAt": "2026-10-01T00:00:00Z",
            "lastProgressAt": "2026-10-01T00:00:00Z",
        }
        record = ledger.evaluate(entry(), snapshot(), None, prior, NOW)
        proposals = ledger.plan_proposals(
            {record["key"]: record},
            {"CARD-12": card("CARD-12", runs=[{"status": "running"}])},
            NOW,
        )
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "live_run")
        self.assertEqual(proposals[0].owner, "CARD-12")
        self.assertIn("24h", proposals[0].recommended_action)
        self.assertIn("CEO", proposals[0].recommended_action)

    def test_terminal_blocker_edge_is_not_a_dependency(self):
        # A done blocker is moot, not a wait: no ghost dependency may strand
        # the record behind it.
        record = self.ledger_row(disposition="NEEDS_REVIEW", authorCard="CARD-1",
                                 successorCard="CARD-1", reviewerCard=None)
        proposals = self.plan(
            record,
            [card("CARD-1", blockedBy=[{"identifier": "CARD-9",
                                       "status": "done"}])])
        self.assertEqual(proposals[0].reason, "missing_disposition")

    def test_stall_past_director_deadline_proposes_director(self):
        prior = {
            "createdAt": "2026-10-02T10:00:00Z",
            "lastProgressAt": "2026-10-02T10:00:00Z",
        }
        record = ledger.evaluate(entry(), snapshot(), None, prior, NOW)
        self.assertEqual(record["disposition"], "NEEDS_REVIEW")
        proposals = self.plan(record, [card("CARD-12")])
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "stall_director")
        self.assertEqual(proposals[0].mutation, "none")
        self.assertEqual(proposals[0].owner, "Director")
        self.assertIn("6h", proposals[0].recommended_action)

    def test_stall_past_ceo_deadline_proposes_ceo(self):
        prior = {
            "createdAt": "2026-10-01T00:00:00Z",
            "lastProgressAt": "2026-10-01T00:00:00Z",
        }
        record = ledger.evaluate(entry(), snapshot(), None, prior, NOW)
        proposals = self.plan(record, [card("CARD-12")])
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "stall_ceo")
        self.assertEqual(proposals[0].owner, "CEO")
        self.assertIn("24h", proposals[0].recommended_action)

    def test_stall_escalation_survives_reread_without_progress(self):
        # Looking at a stalled record is not progress: the escalation must
        # still fire on the next pass with the same lastProgressAt.
        prior = {
            "createdAt": "2026-10-02T10:00:00Z",
            "lastProgressAt": "2026-10-02T10:00:00Z",
        }
        first = ledger.evaluate(entry(), snapshot(), None, prior, NOW)
        reread = ledger.evaluate(
            entry(), snapshot(), None,
            {"createdAt": first["createdAt"],
             "lastProgressAt": first["lastProgressAt"],
             "history": first["history"]},
            NOW + dt.timedelta(hours=1))
        proposals = ledger.plan_proposals(
            {reread["key"]: reread}, {"CARD-12": card("CARD-12")},
            NOW + dt.timedelta(hours=1))
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "stall_director")
        self.assertEqual(proposals[0].owner, "Director")

    def test_needs_fix_proposes_owned_repair(self):
        snap = snapshot()
        snap["checks"] = checks_at(HEAD_A, ("success", "failure", "success"))
        record = ledger.evaluate(entry(), snap, None, None, NOW)
        self.assertEqual(record["disposition"], "NEEDS_FIX")
        proposals = self.plan(record, [card("CARD-12")])
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "missing_disposition")


class AcceptanceHandbackRegressions(unittest.TestCase):
    """Director handback: six concrete counterexamples from the closeout loop,
    each pinned here with an executable regression."""

    def ledger_row(self, **changes):
        record = ledger.evaluate(entry(), snapshot(), approve(), None, NOW)
        record.update(changes)
        return record

    def test_hard_guard_wins_over_dependency_on_same_card(self):
        # Case 1 (ledger 674-683): a card with BOTH a live run and a blocked
        # edge is barrier-held, not merely waiting. The hard guard wins, so
        # the walk emits the barrier instead of a wait.
        record = self.ledger_row(disposition="NEEDS_REVIEW", authorCard="CARD-A",
                                 successorCard="CARD-A", reviewerCard=None)
        proposals = ledger.plan_proposals(
            {record["key"]: record},
            {"CARD-A": card("CARD-A", runs=[{"status": "running"}],
                           blockedBy=[{"identifier": "CARD-R",
                                       "status": "in_progress"}]),
             "CARD-R": card("CARD-R")},
            NOW,
        )
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "live_run")
        self.assertEqual(proposals[0].owner, "CARD-A")
        self.assertEqual(proposals[0].mutation, "none")

    def test_terminal_chain_end_is_moot_not_a_stall(self):
        # Case 2 (ledger 848-898): a wait chain ending at a done card is moot
        # evidence, not a stall to escalate. The terminal guard wins even past
        # the 24h window.
        prior = {
            "createdAt": "2026-10-01T00:00:00Z",
            "lastProgressAt": "2026-10-01T00:00:00Z",
        }
        record = ledger.evaluate(entry(), snapshot(), None, prior, NOW)
        proposals = ledger.plan_proposals(
            {record["key"]: record},
            {"CARD-12": card("CARD-12",
                               blockedBy=[{"identifier": "CARD-R",
                                           "status": "in_progress"}]),
             "CARD-R": card("CARD-R", status="done")},
            NOW,
        )
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "terminal_card")
        self.assertEqual(proposals[0].owner, "CARD-R")
        self.assertEqual(proposals[0].mutation, "none")

    def test_wait_chain_follows_reviewer_to_steward(self):
        # Case 3 (ledger 774-936): the wait follows actual edges, not just
        # the first one. Author waits on reviewer, reviewer waits on steward:
        # the terminal steward's own live run surfaces.
        record = self.ledger_row(disposition="NEEDS_REVIEW", authorCard="CARD-A",
                                 successorCard="CARD-A", reviewerCard="CARD-R")
        proposals = ledger.plan_proposals(
            {record["key"]: record},
            {"CARD-A": card("CARD-A", blockedBy=[{"identifier": "CARD-R",
                                                "status": "in_progress"}]),
             "CARD-R": card("CARD-R", blockedBy=[{"identifier": "STEWARD",
                                                 "status": "in_progress"}]),
             "STEWARD": card("STEWARD", runs=[{"status": "queued"}])},
            NOW,
        )
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "live_run")
        self.assertEqual(proposals[0].owner, "STEWARD")

    def test_wait_cycle_strands_with_path_named(self):
        # A dependency cycle cannot spin: the walk stops at the first repeat
        # and strands with the travelled path named, not truncated. Two
        # records on the same stranded card still emit once: the cap covers
        # the strand branch too.
        record = self.ledger_row(disposition="NEEDS_REVIEW", authorCard="CARD-A",
                                 successorCard="CARD-A", reviewerCard="CARD-R")
        second = dict(record)
        second["key"] = "two-web-next#292"
        second["pr"] = 292
        proposals = ledger.plan_proposals(
            {record["key"]: record, second["key"]: second},
            {"CARD-A": card("CARD-A", blockedBy=[{"identifier": "CARD-R",
                                                "status": "in_progress"}]),
             "CARD-R": card("CARD-R", blockedBy=[{"identifier": "CARD-A",
                                                 "status": "in_progress"}])},
            NOW,
        )
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "blocked_dependency")
        self.assertEqual(proposals[0].owner, "CARD-A")
        self.assertIn("CARD-A -> CARD-R -> CARD-A", proposals[0].note)
        self.assertNotIn("CARD-A -> CARD-R -> CARD-A -> CARD-R",
                         proposals[0].note)

    def test_long_chain_strands_at_hop_budget(self):
        # The hop budget bounds pathological graphs: a 10-deep chain of
        # distinct cards strands with the travelled path named, even though
        # the terminal steward is live. Without the budget the walk would
        # reach the terminal and emit its barrier instead.
        record = self.ledger_row(disposition="NEEDS_REVIEW", authorCard="T0",
                                 successorCard="T0", reviewerCard="T1")
        cards = {}
        names = [f"T{i}" for i in range(10)]
        for i, name in enumerate(names):
            if i < len(names) - 1:
                cards[name] = card(name, blockedBy=[{"identifier": names[i + 1],
                                                     "status": "in_progress"}])
            else:
                cards[name] = card(name, runs=[{"status": "queued"}])
        proposals = ledger.plan_proposals({record["key"]: record}, cards, NOW)
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "blocked_dependency")
        self.assertEqual(proposals[0].owner, "T0")
        self.assertIn("T0 -> T1 -> T2", proposals[0].note)
        self.assertNotIn("T9", proposals[0].note)

    def test_older_pending_row_does_not_veto_newer_result(self):
        # Case 4 (ledger 162-235): verdict and evidence read the SAME newest
        # row. A result-less OLDER attempt superseded by a newer success --
        # including an untimestamped queued row, which sorts oldest -- is not
        # a run in flight: GREEN, with the success as evidence.
        snap = snapshot()
        snap["checks"] = [
            {"name": "check", "sha": HEAD_A, "conclusion": None,
             "id": 99, "status": "queued"},
            {"name": "check", "sha": HEAD_A, "conclusion": None,
             "id": 101, "startedAt": "2026-10-02T14:00:00Z",
             "status": "queued"},
            {"name": "check", "sha": HEAD_A, "conclusion": "success",
             "id": 102, "completedAt": "2026-10-02T16:00:00Z",
             "status": "completed"},
            {"name": "gitleaks", "sha": HEAD_A, "conclusion": "success",
             "id": 103, "completedAt": "2026-10-02T15:30:00Z",
             "status": "completed"},
            {"name": "pr-lint", "sha": HEAD_A, "conclusion": "success",
             "id": 104, "completedAt": "2026-10-02T15:30:00Z",
             "status": "completed"},
        ]
        record = ledger.evaluate(entry(), snap, approve(), None, NOW)
        self.assertEqual(record["checkState"], "GREEN")
        attempts = {a["name"]: a for a in record["requiredCheckAttempts"]}
        self.assertEqual(attempts["check"]["conclusion"], "success")
        self.assertEqual(attempts["check"]["attemptId"], 102)

    def test_first_sight_provenance_survives_persisted_reread(self):
        # Case 5 (ledger 528-547): first sight is an unproven lower bound. A
        # persisted reread keeps it marked first_sight, never relabeled as a
        # tracked admission date.
        first = ledger.evaluate(entry(), snapshot(), approve(), None, NOW)
        self.assertEqual(first["admissionProvenance"], "first_sight")
        reread = ledger.evaluate(
            entry(), snapshot(), approve(),
            {"createdAt": first["createdAt"],
             "lastProgressAt": first["lastProgressAt"],
             "admittedAt": first["admittedAt"],
             "admissionProvenance": first["admissionProvenance"],
             "history": first["history"]},
            NOW + dt.timedelta(hours=1))
        self.assertEqual(reread["admittedAt"], first["admittedAt"])
        self.assertEqual(reread["admissionProvenance"], "first_sight")

    def test_per_card_cap_covers_barrier_branches(self):
        # Case 6 (ledger 789-941): the one-action cap is not healthy-path
        # only. Two barrier-held records on the same card emit one proposal.
        first = self.ledger_row(disposition="NEEDS_REVIEW", authorCard="CARD-1",
                                successorCard="CARD-1", reviewerCard=None)
        second = dict(first)
        second["key"] = "two-web-next#292"
        second["pr"] = 292
        proposals = ledger.plan_proposals(
            {first["key"]: first, second["key"]: second},
            {"CARD-1": card("CARD-1", runs=[{"status": "running"}])},
            NOW,
        )
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].reason, "live_run")


class ReviewReworkRegressions(unittest.TestCase):
    """Review CHANGES, three blocking evaluator defects plus one advisory, each
    pinned here: (1) lastProgressAt never advanced on real progress, (2) MERGED was
    not sticky across a failed or absent read, (3) history grew one row per
    read. The read-gap cases beside them close the laundering variants of (1):
    a flapping read must not restart a genuine stall, and a head move across
    a read gap must still count."""

    def red(self, head=HEAD_A):
        snap = snapshot(head)
        snap["checks"] = checks_at(head, ("success", "failure", "success"))
        return snap

    def stalled_prior(self, snap=None, hours=7):
        # Admitted `hours` ago; nothing has happened since.
        return ledger.evaluate(
            entry(), snap or self.red(), None, None, NOW - dt.timedelta(hours=hours))

    def stall_reasons(self, record):
        proposals = ledger.plan_proposals(
            {record["key"]: record},
            {"CARD-12": card("CARD-12"),
             "CARD-10": card("CARD-10", status="todo")},
            NOW,
        )
        return [p.reason for p in proposals]

    def reread(self, record, snap, review=None, when=NOW):
        # Persist-and-reread exactly as the hourly loop does: JSON round trip.
        prior = json.loads(json.dumps(record))
        return ledger.evaluate(entry(), snap, review, prior, when)

    # --- finding 1: progress renews the 6h/24h windows -----------------

    def test_head_move_renews_progress_clock(self):
        # GREEN at both heads, so only the head move can explain the renewal
        # (a red -> green fixture would pass on the RED->GREEN rule alone).
        prior = self.stalled_prior(snapshot(HEAD_A))
        record = ledger.evaluate(entry(), snapshot(HEAD_B), None, prior, NOW)
        self.assertEqual(record["lastProgressAt"], "2026-10-02T17:00:00Z")
        self.assertEqual(record["deadlineDirectorAt"], "2026-10-02T23:00:00Z")
        self.assertNotIn("stall_director", self.stall_reasons(record))
        self.assertNotIn("stall_ceo", self.stall_reasons(record))

    def test_red_to_green_renews_progress_clock(self):
        prior = self.stalled_prior()
        record = ledger.evaluate(entry(), snapshot(HEAD_A), None, prior, NOW)
        self.assertEqual(record["checkState"], "GREEN")
        self.assertEqual(record["lastProgressAt"], "2026-10-02T17:00:00Z")
        self.assertNotIn("stall_director", self.stall_reasons(record))

    def test_new_approve_at_head_renews_progress_clock(self):
        prior = self.stalled_prior(snapshot(HEAD_A))
        self.assertEqual(prior["verdict"], "NONE")
        record = ledger.evaluate(entry(), snapshot(HEAD_A), approve(), prior, NOW)
        self.assertEqual(record["disposition"], "APPROVED_WAIT_CI")
        self.assertEqual(record["lastProgressAt"], "2026-10-02T17:00:00Z")

    def test_unchanged_reread_keeps_progress_clock(self):
        # The positive control for all three renewals above: with nothing
        # changed the clock stays and the stall row still fires.
        prior = self.stalled_prior()
        record = ledger.evaluate(entry(), self.red(), None, prior, NOW)
        self.assertEqual(record["lastProgressAt"], "2026-10-02T10:00:00Z")
        self.assertIn("stall_director", self.stall_reasons(record))
        green = self.stalled_prior(snapshot(HEAD_A))
        again = ledger.evaluate(entry(), snapshot(HEAD_A), None, green, NOW)
        self.assertEqual(again["lastProgressAt"], "2026-10-02T10:00:00Z")

    def test_failed_read_between_greens_does_not_launder_clock(self):
        # GREEN -> failed read (UNKNOWN) -> GREEN is the same GREEN: a flap
        # is not progress, so a genuine stall cannot be reset by an API blip.
        first = self.stalled_prior(snapshot(HEAD_A))
        blip = self.reread(first, {"headSha": HEAD_A, "apiError": "HTTP 502",
                                   "requiredChecks": list(REQUIRED), "checks": []},
                           when=NOW - dt.timedelta(hours=1))
        self.assertEqual(blip["checkState"], "UNKNOWN")
        back = self.reread(blip, snapshot(HEAD_A))
        self.assertEqual(back["lastProgressAt"], "2026-10-02T10:00:00Z")

    def test_approve_flap_at_same_head_does_not_launder_clock(self):
        # APPROVE -> review read gone (NONE) -> APPROVE at one head is one
        # approval seen twice, not a new one.
        first = self.stalled_prior(snapshot(HEAD_A))
        approved = self.reread(first, snapshot(HEAD_A), approve(),
                               when=NOW - dt.timedelta(hours=2))
        self.assertEqual(approved["lastProgressAt"], "2026-10-02T15:00:00Z")
        gone = self.reread(approved, snapshot(HEAD_A), None,
                           when=NOW - dt.timedelta(hours=1))
        self.assertEqual(gone["verdict"], "NONE")
        back = self.reread(gone, snapshot(HEAD_A), approve())
        self.assertEqual(back["lastProgressAt"], "2026-10-02T15:00:00Z")

    def test_head_move_across_read_gap_still_renews(self):
        # A snapshot-absent read records headSha None; the head the ledger
        # last READ survives in lastKnownHeadSha so a push during the gap
        # still counts as progress when the read comes back.
        first = self.stalled_prior(snapshot(HEAD_A))
        gap = self.reread(first, None, when=NOW - dt.timedelta(hours=1))
        self.assertIsNone(gap["headSha"])
        self.assertEqual(gap["lastKnownHeadSha"], HEAD_A)
        back = self.reread(gap, snapshot(HEAD_B))
        self.assertEqual(back["lastProgressAt"], "2026-10-02T17:00:00Z")
        same = self.reread(gap, snapshot(HEAD_A))
        self.assertEqual(same["lastProgressAt"], "2026-10-02T10:00:00Z")

    def test_approved_wait_ci_next_action_names_the_merger(self):
        record = ledger.evaluate(entry(), snapshot(), approve(), None, NOW)
        self.assertEqual(record["disposition"], "APPROVED_WAIT_CI")
        self.assertIn("approving reviewer squash-merges", record["nextAction"])

    # --- finding 2: MERGED is sticky -----------------------------------

    def merged_record(self):
        merged = snapshot(merged=True, mergeCommitSha=MERGE_SHA,
                          mergeUrl="https://example.invalid/commit/" + MERGE_SHA)
        record = ledger.evaluate(entry(), merged, approve(), None,
                                 NOW - dt.timedelta(hours=1))
        self.assertEqual(record["disposition"], "MERGED")
        return record

    def merged_plan(self, record):
        return ledger.plan_proposals(
            {record["key"]: record}, {"CARD-12": card("CARD-12")}, NOW)

    def test_merged_survives_failed_read(self):
        # A failed read still carries the PR payload's merged=false default;
        # it is the apiError that makes it a gap rather than a measurement.
        record = self.reread(self.merged_record(),
                             {"headSha": HEAD_A, "merged": False,
                              "apiError": "HTTP 502",
                              "requiredChecks": list(REQUIRED), "checks": []})
        self.assertEqual(record["disposition"], "MERGED")
        self.assertEqual(record["mergeCommitSha"], MERGE_SHA)
        self.assertTrue(record["mergeUrl"].endswith(MERGE_SHA))
        self.assertEqual(self.merged_plan(record), [])

    def test_merged_survives_absent_snapshot(self):
        record = self.reread(self.merged_record(), None)
        self.assertEqual(record["disposition"], "MERGED")
        self.assertEqual(record["mergeCommitSha"], MERGE_SHA)
        self.assertEqual(self.merged_plan(record), [])
        # And it stays merged on the NEXT gap too: sticky, not one-shot.
        again = self.reread(record, None)
        self.assertEqual(again["disposition"], "MERGED")
        self.assertEqual(self.merged_plan(again), [])

    def test_merged_without_prior_proof_is_not_sticky(self):
        # A prior MERGED row with no full merge SHA/URL was never verified;
        # a failed read must not launder it into a durable terminal state.
        prior = self.merged_record()
        prior["mergeUrl"] = None
        record = self.reread(prior, None)
        self.assertEqual(record["disposition"], "UNKNOWN_CHECKS")
        short = self.merged_record()
        short["mergeCommitSha"] = MERGE_SHA[:7]
        self.assertEqual(self.reread(short, None)["disposition"], "UNKNOWN_CHECKS")

    def test_measured_open_read_overrules_prior_merged(self):
        # Only a read that MEASURED the PR may speak over the record: a clean
        # merged=false snapshot is a contradiction to surface, not to hide.
        record = self.reread(self.merged_record(), snapshot(HEAD_A))
        self.assertNotEqual(record["disposition"], "MERGED")
        self.assertIsNone(record.get("mergeCommitSha"))

    # --- finding 3: history is bounded --------------------------------

    def test_identical_rereads_do_not_grow_history(self):
        record = ledger.evaluate(entry(), snapshot(HEAD_A), None, None,
                                 NOW - dt.timedelta(hours=12))
        for hours in range(11, 1, -1):
            record = self.reread(record, snapshot(HEAD_A),
                                 when=NOW - dt.timedelta(hours=hours))
        self.assertEqual(record["history"], [])

    def test_head_move_appends_exactly_one_history_row(self):
        record = ledger.evaluate(entry(), snapshot(HEAD_A), None, None,
                                 NOW - dt.timedelta(hours=3))
        record = self.reread(record, snapshot(HEAD_B), when=NOW - dt.timedelta(hours=2))
        self.assertEqual([h["headSha"] for h in record["history"]], [HEAD_A])
        for hours in (1, 0):
            record = self.reread(record, snapshot(HEAD_B),
                                 when=NOW - dt.timedelta(hours=hours))
        self.assertEqual([h["headSha"] for h in record["history"]], [HEAD_A])

    def test_history_is_capped_keeping_the_newest_rows(self):
        old = [{"headSha": f"{i:040x}", "supersededAt": "2026-10-01T00:00:00Z"}
               for i in range(ledger.HISTORY_CAP + 10)]
        prior = ledger.evaluate(entry(), snapshot(HEAD_A), None, None,
                                NOW - dt.timedelta(hours=1))
        prior["history"] = old
        record = self.reread(prior, snapshot(HEAD_B))
        self.assertEqual(len(record["history"]), ledger.HISTORY_CAP)
        self.assertEqual(record["history"][-1]["headSha"], HEAD_A)
        self.assertEqual(record["history"][0]["headSha"], old[11]["headSha"])

    def test_read_gap_supersedes_prior_head_once(self):
        # A snapshot-absent read cannot name a head, so the prior read is
        # kept as history ONCE; a gap that persists has no prior head left
        # to supersede and appends nothing.
        record = ledger.evaluate(entry(), snapshot(HEAD_A), None, None,
                                 NOW - dt.timedelta(hours=3))
        record = self.reread(record, None, when=NOW - dt.timedelta(hours=2))
        self.assertEqual(len(record["history"]), 1)
        self.assertIn("unread", record["history"][0]["reason"])
        for hours in (1, 0):
            record = self.reread(record, None, when=NOW - dt.timedelta(hours=hours))
        self.assertEqual(len(record["history"]), 1)


class Deadlines(unittest.TestCase):
    def test_six_and_twentyfour_hour_deadlines(self):
        record = ledger.evaluate(entry(), snapshot(), approve(), None, NOW)
        self.assertEqual(record["deadlineDirectorAt"], "2026-10-02T23:00:00Z")
        self.assertEqual(record["deadlineCeoAt"], "2026-10-03T17:00:00Z")

    def test_hourly_recheck_is_separate_from_stall_deadlines(self):
        # The parent requires active rechecks at least hourly; the 6h/24h
        # windows are stall escalations, not the cadence. A read at NOW
        # schedules the next read at NOW+1h even though no stall is near.
        record = ledger.evaluate(entry(), snapshot(), approve(), None, NOW)
        self.assertEqual(record["nextCheckAt"], "2026-10-02T18:00:00Z")
        self.assertEqual(record["nextCheckKind"], "recheck")
        self.assertNotEqual(record["nextCheckAt"], record["deadlineDirectorAt"])

    def test_stall_past_director_deadline(self):
        prior = {
            "createdAt": "2026-10-01T00:00:00Z",
            "lastProgressAt": "2026-10-01T00:00:00Z",
        }
        snap = snapshot()
        snap["checks"] = checks_at(HEAD_A, ("success", "failure", "success"))
        record = ledger.evaluate(entry(), snap, None, prior, NOW)
        self.assertEqual(record["deadlineDirectorAt"], "2026-10-01T06:00:00Z")
        self.assertEqual(record["deadlineCeoAt"], "2026-10-02T00:00:00Z")

    def test_reread_without_progress_keeps_stall_deadlines(self):
        # Reset-on-read is the failure: a second read with no fresh progress
        # must keep the original stall windows, not restart them.
        prior = {
            "createdAt": "2026-10-01T00:00:00Z",
            "lastProgressAt": "2026-10-01T00:00:00Z",
        }
        snap = snapshot()
        snap["checks"] = checks_at(HEAD_A, ("success", "failure", "success"))
        first = ledger.evaluate(entry(), snap, None, prior, NOW)
        second = ledger.evaluate(
            entry(), snap, None,
            {"createdAt": first["createdAt"],
             "lastProgressAt": first["lastProgressAt"],
             "history": first["history"]},
            NOW + dt.timedelta(hours=1))
        self.assertEqual(second["deadlineDirectorAt"], "2026-10-01T06:00:00Z")
        self.assertEqual(second["deadlineCeoAt"], "2026-10-02T00:00:00Z")
        self.assertEqual(second["nextCheckAt"], "2026-10-02T19:00:00Z")


def parse_deadline(value):
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    return dt.datetime.fromisoformat(text)


class EndToEndOffline(unittest.TestCase):
    def test_unknown_inputs_refuse_clean(self):
        with self.assertRaises(ledger.LedgerError):
            ledger.load_registry("/nonexistent/registry.json")

    def test_empty_registry_refuses(self):
        import tempfile
        import os
        handle, path = tempfile.mkstemp(suffix=".json")
        try:
            with open(path, "w", encoding="utf-8") as out:
                json.dump({"entries": []}, out)
            with self.assertRaises(ledger.LedgerError):
                ledger.load_registry(path)
        finally:
            os.unlink(path)

    def test_registry_rejects_unknown_admission(self):
        import tempfile
        import os
        handle, path = tempfile.mkstemp(suffix=".json")
        try:
            with open(path, "w", encoding="utf-8") as out:
                json.dump({"entries": [{"repo": "two-web-next", "pr": 1,
                                         "admission": "auto"}]}, out)
            with self.assertRaises(ledger.LedgerError):
                ledger.load_registry(path)
        finally:
            os.unlink(path)

    def test_empty_snapshot_refuses_through_main(self):
        import os
        import subprocess
        import sys
        import tempfile
        work = tempfile.mkdtemp()
        try:
            registry_path = os.path.join(work, "registry.json")
            snapshot_path = os.path.join(work, "snapshot.json")
            with open(registry_path, "w", encoding="utf-8") as out:
                json.dump({"entries": [{"repo": "two-web-next", "pr": 291,
                                         "admission": "admitted"}]}, out)
            with open(snapshot_path, "w", encoding="utf-8") as out:
                json.dump({"snapshots": {}, "reviews": {}, "cards": {}}, out)
            tool = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "pr_closeout_ledger.py")
            proc = subprocess.run(
                [sys.executable, tool,
                 "--registry", registry_path, "--snapshot", snapshot_path,
                 "--ledger-out", os.path.join(work, "ledger.json"),
                 "--plan-out", os.path.join(work, "plan.json")],
                capture_output=True, text=True, timeout=60)
            self.assertEqual(proc.returncode, 5)
            self.assertIn("refusing to report a clean board", proc.stderr)
        finally:
            import shutil
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()