#!/usr/bin/env python3
"""Additional offline boundary cases for publication readiness."""

import copy
import unittest

from test_review_ready_head_acceptance import MovingEvidence, NEW_HEAD, ci_run
from test_review_trigger_step import PR, run_with


class HeadEvidenceTest(unittest.TestCase):
    def test_insufficient_latest_ci_evidence_withholds_publication(self):
        green = ci_run()
        cases = [[], [dict(green, head_sha=None)],
                 [dict(green, head_sha=NEW_HEAD)],
                 [dict(green, status="in_progress", conclusion=None)],
                 [dict(green, conclusion="neutral")]]
        for later in cases:
            with self.subTest(later=later):
                stub = MovingEvidence(runs=[green], later_runs=later)
                self.assertEqual(run_with(stub), 0)
                self.assertEqual(stub.posts, [])

    def test_insufficient_pr_facts_withhold_publication(self):
        for field in ("state", "draft", "head"):
            with self.subTest(field=field):
                later = copy.deepcopy(PR)
                later.pop(field)
                stub = MovingEvidence(runs=[ci_run()], later_pr=later)
                self.assertEqual(run_with(stub), 0)
                self.assertEqual(stub.posts, [])

    def test_closed_pr_withholds_publication(self):
        stub = MovingEvidence(runs=[ci_run()], later_pr=dict(PR, state="closed"))
        self.assertEqual(run_with(stub), 0)
        self.assertEqual(stub.posts, [])

    def test_removed_checklist_withholds_publication(self):
        stub = MovingEvidence(runs=[ci_run()], later_pr=dict(PR, body=""))
        self.assertEqual(run_with(stub), 0)
        self.assertEqual(stub.posts, [])

    def test_latest_red_or_pending_rerun_overrides_old_success(self):
        for status, conclusion in (("completed", "failure"), ("queued", None)):
            with self.subTest(status=status):
                stub = MovingEvidence(runs=[ci_run()], later_runs=[
                    dict(ci_run(), id=10),
                    dict(ci_run(), id=11, status=status, conclusion=conclusion)])
                self.assertEqual(run_with(stub), 0)
                self.assertEqual(stub.posts, [])

    def test_review_history_preserves_retry_budget_and_verdicts(self):
        cases = ((["action_required"], True),
                 (["action_required", "timed_out"], False),
                 (["failure", "timed_out"], False),
                 (["success", "timed_out"], False))
        for conclusions, publish in cases:
            with self.subTest(conclusions=conclusions):
                runs = [ci_run()] + [
                    {"name": "Paperclip Review", "head_sha": ci_run()["head_sha"],
                     "status": "completed", "conclusion": c} for c in conclusions]
                stub = MovingEvidence(runs=runs)
                self.assertEqual(run_with(stub), 0)
                self.assertEqual("label:review-ready" in stub.posts, publish)

    def test_latest_green_rerun_can_replace_an_old_failure(self):
        for runs in ([dict(ci_run(conclusion="failure"), id=10),
                      dict(ci_run(), id=11)],
                     [dict(ci_run(), id=11),
                      dict(ci_run(conclusion="failure"), id=10)]):
            with self.subTest(runs=runs):
                stub = MovingEvidence(runs=[ci_run()], later_runs=runs)
                self.assertEqual(run_with(stub), 0)
                self.assertIn("label:review-ready", stub.posts)

    def test_ambiguous_ci_history_withholds_publication(self):
        for runs in ([ci_run(), ci_run()],
                     [dict(ci_run(), id=10), dict(ci_run(), id=10)]):
            with self.subTest(runs=runs):
                stub = MovingEvidence(runs=[ci_run()], later_runs=runs)
                self.assertEqual(run_with(stub), 0)
                self.assertEqual(stub.posts, [])

    def test_success_from_another_app_does_not_hide_red_ci(self):
        stub = MovingEvidence(runs=[ci_run()], later_runs=[
            dict(ci_run(conclusion="failure"), id=10, app={"id": 1}),
            dict(ci_run(), id=11, app={"id": 2})])
        self.assertEqual(run_with(stub), 0)
        self.assertEqual(stub.posts, [])


if __name__ == "__main__":
    unittest.main()
