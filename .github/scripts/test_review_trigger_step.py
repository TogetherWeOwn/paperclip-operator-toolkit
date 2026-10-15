#!/usr/bin/env python3
"""Unit tests for review_trigger_step.py. Stdlib only, offline.

The GitHub API is faked by replacing review_trigger_step.api with an
in-memory stub; no network, no token, no credentials.
"""

import os
import unittest

import review_trigger_step as step
from test_review_trigger import FULL_BODY, OUT_OF_SAMPLE_SHA

PR = {
    "number": 7,
    "state": "open",
    "head": {"sha": OUT_OF_SAMPLE_SHA, "ref": "card-1-work"},
    "draft": False,
    "user": {"login": "togetherweown[bot]"},
    "body": FULL_BODY,
    "labels": [],
    "additions": 10,
    "deletions": 5,
}


def page_of(items, path):
    """Slice `items` the way GitHub serves ?per_page=N&page=M."""
    query = dict(kv.split("=") for kv in path.split("?", 1)[1].split("&"))
    per, page = int(query["per_page"]), int(query["page"])
    return items[(page - 1) * per:page * per]


class Stub:
    def __init__(self, pr=None, runs=None, files=None, comments=None,
                 fail_labels_404=False, endless_comments=False):
        self.pr = dict(PR if pr is None else pr)
        self.runs = runs if runs is not None else []
        self.files = files if files is not None else [
            {"filename": "docs/notes.md"}]
        self.comments = list(comments or [])
        self.posts = []
        self.fail_labels_404 = fail_labels_404
        self.endless_comments = endless_comments
        self.created_label = False

    def api(self, path, method="GET", body=None):
        if path.startswith("/commits/") and path.endswith("/pulls"):
            return [dict(self.pr, state="open",
                         head={"sha": OUT_OF_SAMPLE_SHA, "ref": "card-1-work"})]
        if path == "/pulls/7":
            return dict(self.pr)
        if path.startswith("/commits/") and "/check-runs?" in path:
            query = dict(kv.split("=") for kv in path.split("?", 1)[1].split("&"))
            runs = self.runs
            if query.get("filter", "latest") != "all":
                # Fixtures append newer runs last. GitHub defaults to only
                # the newest run for each name, before pagination.
                runs = list({r["name"]: r for r in runs}.values())
            return {"check_runs": page_of(runs, path)}
        if path == "/pulls/7/files?per_page=100":
            return list(self.files)
        if path.startswith("/issues/7/comments?"):
            if self.endless_comments:
                return [{"body": "filler"}] * 100
            return page_of(self.comments, path)
        if path == "/issues/7/comments" and method == "POST":
            self.posts.append(body["body"])
            self.comments.append({"body": body["body"],
                                  "user": {"login": "github-actions[bot]", "type": "Bot"}})
            return {}
        if path == "/issues/7/labels" and method == "POST":
            if self.fail_labels_404 and not self.created_label:
                raise SystemExit("::error::GitHub API POST labels -> HTTP 404")
            self.posts.append("label:review-ready")
            return {}
        if path == "/labels" and method == "POST":
            self.created_label = True
            return {}
        raise AssertionError("unexpected API call %s %s" % (method, path))


def run_with(stub):
    old_api, old_env = step.api, dict(os.environ)
    step.api = stub.api
    os.environ.update({"HEAD_SHA": OUT_OF_SAMPLE_SHA,
                       "REPO": "o/r", "GH_TOKEN": "fake"})
    try:
        return step.main()
    finally:
        step.api = old_api
        os.environ.clear()
        os.environ.update(old_env)


def green_runs():
    return [{"name": "ci-ok", "status": "completed", "conclusion": "success"}]


class StepTest(unittest.TestCase):
    def test_ready_head_posts_trigger_and_label(self):
        stub = Stub(runs=green_runs())
        self.assertEqual(run_with(stub), 0)
        self.assertTrue(any("@togetherweown-reviewer review %s"
                            % OUT_OF_SAMPLE_SHA in p for p in stub.posts))
        self.assertIn("label:review-ready", stub.posts)

    def test_existing_trigger_is_not_reposted(self):
        stub = Stub(runs=green_runs(), comments=[
            {"body": "@togetherweown-reviewer review %s\n\nready head"
             % OUT_OF_SAMPLE_SHA,
             "user": {"login": "github-actions[bot]", "type": "Bot"}}])
        self.assertEqual(run_with(stub), 0)
        self.assertEqual(stub.posts, [])

    def test_non_bot_marker_does_not_suppress_the_post(self):
        stub = Stub(runs=green_runs(), comments=[
            {"body": "@togetherweown-reviewer review %s\n\nready head"
             % OUT_OF_SAMPLE_SHA,
             "user": {"login": "drive-by-user", "type": "User"}}])
        self.assertEqual(run_with(stub), 0)
        self.assertTrue(any("@togetherweown-reviewer review %s"
                            % OUT_OF_SAMPLE_SHA in p for p in stub.posts))

    def test_other_bot_marker_does_not_suppress_the_post(self):
        # The login check matters, not just the type: a marker from another
        # bot account (same type "Bot", different login) must not count as
        # this workflow's own post.
        stub = Stub(runs=green_runs(), comments=[
            {"body": "@togetherweown-reviewer review %s\n\nready head"
             % OUT_OF_SAMPLE_SHA,
             "user": {"login": "dependabot[bot]", "type": "Bot"}}])
        self.assertEqual(run_with(stub), 0)
        self.assertTrue(any("@togetherweown-reviewer review %s"
                            % OUT_OF_SAMPLE_SHA in p for p in stub.posts))

    def test_ci_red_exits_zero_without_posting(self):
        stub = Stub(runs=[{"name": "ci-ok", "status": "completed",
                           "conclusion": "failure"}])
        self.assertEqual(run_with(stub), 0)
        self.assertEqual(stub.posts, [])

    def test_draft_exits_zero_without_posting(self):
        pr = dict(PR, draft=True)
        stub = Stub(pr=pr, runs=green_runs())
        self.assertEqual(run_with(stub), 0)
        self.assertEqual(stub.posts, [])

    def test_missing_label_is_created_then_applied(self):
        stub = Stub(runs=green_runs(), fail_labels_404=True)
        self.assertEqual(run_with(stub), 0)
        self.assertTrue(stub.created_label)
        self.assertIn("label:review-ready", stub.posts)

    def test_truncated_file_list_fails_toward_review(self):
        pr = dict(PR, body="")
        files = [{"filename": "docs/note-%d.md" % i} for i in range(100)]
        stub = Stub(pr=pr, runs=green_runs(), files=files)
        self.assertEqual(run_with(stub), 0)
        self.assertTrue(any("@togetherweown-reviewer review %s"
                            % OUT_OF_SAMPLE_SHA in p for p in stub.posts))

    def test_ci_ok_past_first_check_run_page_still_requests(self):
        filler = [{"name": "job-%d" % i, "status": "completed",
                   "conclusion": "success"} for i in range(120)]
        stub = Stub(runs=filler + green_runs())
        self.assertEqual(run_with(stub), 0)
        self.assertTrue(any("@togetherweown-reviewer review %s"
                            % OUT_OF_SAMPLE_SHA in p for p in stub.posts))

    def test_trigger_marker_past_first_comment_page_is_not_reposted(self):
        filler = [{"body": "chatter %d" % i} for i in range(150)]
        marker = {"body": "@togetherweown-reviewer review %s\n\nready head"
                  % OUT_OF_SAMPLE_SHA,
                  "user": {"login": "github-actions[bot]", "type": "Bot"}}
        stub = Stub(runs=green_runs(), comments=filler + [marker])
        self.assertEqual(run_with(stub), 0)
        self.assertEqual(stub.posts, [])

    def test_exactly_one_full_page_still_terminates(self):
        filler = [{"body": "chatter %d" % i} for i in range(100)]
        stub = Stub(runs=green_runs(), comments=filler)
        self.assertEqual(run_with(stub), 0)
        self.assertTrue(any("@togetherweown-reviewer review %s"
                            % OUT_OF_SAMPLE_SHA in p for p in stub.posts))

    def test_unbounded_comment_list_fails_closed(self):
        stub = Stub(runs=green_runs(), endless_comments=True)
        with self.assertRaises(SystemExit) as caught:
            run_with(stub)
        self.assertIn("partial view", str(caught.exception))
        self.assertEqual(stub.posts, [])

    def test_live_review_run_suppresses_the_post(self):
        runs = green_runs() + [{"name": "Paperclip Review", "status": "in_progress",
                                "conclusion": None}]
        stub = Stub(runs=runs)
        self.assertEqual(run_with(stub), 0)
        self.assertEqual(stub.posts, [])

    def test_error_outcome_still_posts_when_no_marker(self):
        # One error attempt leaves the single shared retry available, for
        # every retryable error conclusion.
        for conclusion in self.ERROR_CONCLUSIONS:
            with self.subTest(conclusion=conclusion):
                stub = Stub(runs=self.error_runs(1, conclusion))
                self.assertEqual(run_with(stub), 0)
                self.assertTrue(any("@togetherweown-reviewer review %s"
                                    % OUT_OF_SAMPLE_SHA in p for p in stub.posts))

    ERROR_CONCLUSIONS = ("action_required", "cancelled", "timed_out", "stale")

    def error_runs(self, n=1, conclusion="action_required"):
        return (green_runs()
                + [{"name": "Paperclip Review", "status": "completed",
                    "conclusion": conclusion}
                   for _ in range(n)])

    def own_marker(self):
        return {"body": "@togetherweown-reviewer review %s\n\nready head"
                % OUT_OF_SAMPLE_SHA,
                "user": {"login": "github-actions[bot]", "type": "Bot"}}

    def test_marker_plus_error_outcome_posts_one_retry(self):
        # Every retryable error conclusion (not just action_required) earns
        # the single retry.
        for conclusion in self.ERROR_CONCLUSIONS:
            with self.subTest(conclusion=conclusion):
                stub = Stub(runs=self.error_runs(1, conclusion),
                            comments=[self.own_marker()])
                self.assertEqual(run_with(stub), 0)
                self.assertTrue(any("@togetherweown-reviewer review %s"
                                    % OUT_OF_SAMPLE_SHA in p for p in stub.posts))

    def test_second_marker_means_retry_already_used(self):
        for conclusion in self.ERROR_CONCLUSIONS:
            with self.subTest(conclusion=conclusion):
                marker = self.own_marker()
                stub = Stub(runs=self.error_runs(1, conclusion),
                            comments=[dict(marker), dict(marker)])
                self.assertEqual(run_with(stub), 0)
                self.assertEqual(stub.posts, [])

    def test_marker_plus_exhausted_error_budget_posts_nothing(self):
        # One marker plus two errored runs: the retry was already spent
        # (possibly by the reconciler or a manual mention), so the shared
        # one-retry budget suppresses a further CI-driven trigger.
        for conclusion in self.ERROR_CONCLUSIONS:
            with self.subTest(conclusion=conclusion):
                stub = Stub(runs=self.error_runs(2, conclusion),
                            comments=[self.own_marker()])
                self.assertEqual(run_with(stub), 0)
                self.assertEqual(stub.posts, [])

    def test_no_marker_plus_exhausted_error_budget_posts_nothing(self):
        # Same budget on the first-post path: a head whose manual reviews
        # already errored twice gets no CI-driven trigger either.
        for conclusion in self.ERROR_CONCLUSIONS:
            with self.subTest(conclusion=conclusion):
                stub = Stub(runs=self.error_runs(2, conclusion))
                self.assertEqual(run_with(stub), 0)
                self.assertEqual(stub.posts, [])

    def test_stub_filters_latest_before_paginating_unless_all_requested(self):
        runs = self.error_runs(1, "action_required")
        runs += self.error_runs(1, "timed_out")[1:]
        stub = Stub(runs=runs)
        path = "/commits/%s/check-runs?" % OUT_OF_SAMPLE_SHA
        latest = [runs[0], runs[-1]]
        for query in ("", "filter=latest&"):
            with self.subTest(query=query):
                self.assertEqual(stub.api(path + query + "per_page=100&page=1"),
                                 {"check_runs": latest})
                self.assertEqual(stub.api(path + query + "per_page=1&page=2"),
                                 {"check_runs": [runs[-1]]})
        self.assertEqual(stub.api(path + "filter=all&per_page=100&page=1"),
                         {"check_runs": runs})

    def test_mixed_error_conclusions_share_the_exhausted_budget(self):
        for markers in ([], [self.own_marker()]):
            for conclusions in (("action_required", "timed_out"),
                                ("cancelled", "stale"),
                                ("action_required",) * 5):
                with self.subTest(markers=len(markers), conclusions=conclusions):
                    runs = green_runs() + [
                        {"name": "Paperclip Review", "status": "completed",
                         "conclusion": conclusion} for conclusion in conclusions]
                    stub = Stub(runs=runs, comments=markers)
                    self.assertEqual(run_with(stub), 0)
                    self.assertEqual(stub.posts, [])

    def test_older_verdict_is_not_hidden_by_a_later_error(self):
        for verdict in ("success", "failure"):
            with self.subTest(verdict=verdict):
                runs = self.error_runs(1, verdict)
                runs += self.error_runs(1, "timed_out")[1:]
                stub = Stub(runs=runs)
                self.assertEqual(run_with(stub), 0)
                self.assertEqual(stub.posts, [])

    def test_error_history_beyond_first_page_exhausts_budget(self):
        filler = [{"name": "job-%d" % i, "status": "completed",
                   "conclusion": "success"} for i in range(100)]
        stub = Stub(runs=self.error_runs(1) + filler
                    + self.error_runs(1, "timed_out")[1:])
        self.assertEqual(run_with(stub), 0)
        self.assertEqual(stub.posts, [])


    def test_second_overlapping_delivery_posts_no_second_trigger(self):
        stub = Stub(runs=green_runs())
        self.assertEqual(run_with(stub), 0)
        first_posts = list(stub.posts)
        self.assertTrue(any("@togetherweown-reviewer review %s"
                            % OUT_OF_SAMPLE_SHA in p for p in first_posts))
        # Delivery 2 overlaps delivery 1: its comment read predates delivery
        # 1's post, but the review delivery 1 requested is now visible as a
        # live check-run. One head, one trigger.
        stub.comments = [c for c in stub.comments
                         if "@togetherweown-reviewer review" not in c.get("body", "")]
        stub.runs.append({"name": "Paperclip Review", "status": "in_progress",
                          "conclusion": None})
        self.assertEqual(run_with(stub), 0)
        self.assertEqual(stub.posts, first_posts)

    def test_same_head_guard_is_wired(self):
        self.assertIsNotNone(step.review_dedup)

    def test_missing_env_fails_closed(self):
        old_api = step.api
        step.api = Stub(runs=green_runs()).api
        old_env = dict(os.environ)
        os.environ.pop("HEAD_SHA", None)
        os.environ.update({"REPO": "o/r", "GH_TOKEN": "fake"})
        try:
            with self.assertRaises(SystemExit):
                step.main()
        finally:
            step.api = old_api
            os.environ.clear()
            os.environ.update(old_env)


if __name__ == "__main__":
    unittest.main()
