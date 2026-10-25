#!/usr/bin/env python3
"""Spec-derived acceptance tests for exact-head review readiness.

Written blind to implementation diffs. A low-risk lane must not reuse green
CI evidence after a push or after checks turn red. This suite exercises the
existing workflow entrypoint; it does not define repair budgets or waive review.
Run: python3 -B -m unittest discover -s .github/scripts \
    -p 'test_review_ready_head_acceptance.py' -v
"""

import copy
import unittest

from test_review_trigger import OUT_OF_SAMPLE_SHA
from test_review_trigger_step import PR, Stub, run_with


NEW_HEAD = "3333333333333333333333333333333333333333"


def ci_run(sha=OUT_OF_SAMPLE_SHA, conclusion="success"):
    return {
        "name": "ci-ok",
        "head_sha": sha,
        "status": "completed",
        "conclusion": conclusion,
    }


class MovingEvidence(Stub):
    """GitHub boundary fixture: facts change after the initial response.

    No real API calls or credentials. Snapshot values are independent of the
    production decision, so stale reads cannot silently observe newer facts.
    """

    def __init__(self, later_pr=None, later_runs=None, **kwargs):
        super().__init__(**kwargs)
        self.later_pr = later_pr
        self.later_runs = later_runs
        self.pr_reads = 0
        self.check_reads = 0

    def api(self, path, method="GET", body=None):
        if method == "GET" and path == "/pulls/7":
            self.pr_reads += 1
            if self.pr_reads > 1 and self.later_pr is not None:
                return copy.deepcopy(self.later_pr)
            return copy.deepcopy(self.pr)
        if method == "GET" and "/check-runs?" in path:
            self.check_reads += 1
            if self.check_reads > 1 and self.later_runs is not None:
                self.runs = copy.deepcopy(self.later_runs)
        return super().api(path, method, body)


class ReadyHeadAcceptance(unittest.TestCase):
    def test_unchanged_green_head_still_gets_review(self):
        stub = MovingEvidence(runs=[ci_run()])
        self.assertEqual(run_with(stub), 0)
        self.assertIn("label:review-ready", stub.posts)
        self.assertTrue(any(
            "@togetherweown-reviewer review " + OUT_OF_SAMPLE_SHA in post
            for post in stub.posts
        ))

    def test_red_head_never_gets_review_ready(self):
        stub = MovingEvidence(runs=[ci_run(conclusion="failure")])
        self.assertEqual(run_with(stub), 0)
        self.assertEqual(stub.posts, [])

    def test_green_ci_for_another_sha_cannot_ready_this_head(self):
        # Break caught: accepting a green name/conclusion without SHA binding.
        stub = MovingEvidence(runs=[ci_run(sha=NEW_HEAD)])
        self.assertEqual(run_with(stub), 0)
        self.assertEqual(stub.posts, [], "foreign-head CI must not authorize review")

    def test_repush_before_publication_invalidates_original_readiness(self):
        # Break caught: publishing from a stale PR snapshot after a new push.
        later_pr = copy.deepcopy(PR)
        later_pr["head"]["sha"] = NEW_HEAD
        stub = MovingEvidence(runs=[ci_run()], later_pr=later_pr)
        self.assertEqual(run_with(stub), 0)
        self.assertEqual(stub.posts, [], "re-pushed head needs its own green evidence")

    def test_draft_transition_before_publication_withholds_readiness(self):
        # Break caught: a PR moved back to draft still receives a ready signal.
        later_pr = dict(PR, draft=True)
        stub = MovingEvidence(runs=[ci_run()], later_pr=later_pr)
        self.assertEqual(run_with(stub), 0)
        self.assertEqual(stub.posts, [], "draft transition must invalidate readiness")

    def test_ci_red_on_final_read_withholds_readiness(self):
        # Break caught: re-reading checks for dedup but ignoring new CI failure.
        stub = MovingEvidence(
            runs=[ci_run()], later_runs=[ci_run(conclusion="failure")]
        )
        self.assertEqual(run_with(stub), 0)
        self.assertEqual(stub.posts, [], "current failed CI must override stale green")


if __name__ == "__main__":
    unittest.main()
