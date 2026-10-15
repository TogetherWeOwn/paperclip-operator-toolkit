#!/usr/bin/env python3
"""Acceptance coverage for review-trigger author identity and retry budget."""

import os
import unittest

import review_trigger_step as step

HEAD_SHA = "1234567890abcdef1234567890abcdef12345678"
TRIGGER = f"@togetherweown-reviewer review {HEAD_SHA}"
BOT_LOGIN = "github-actions[bot]"


def page_of(items, path):
    query = dict(part.split("=", 1) for part in path.split("?", 1)[1].split("&"))
    per_page, page = int(query["per_page"]), int(query["page"])
    return items[(page - 1) * per_page:page * per_page]


def ci_ok():
    return {"name": "ci-ok", "status": "completed", "conclusion": "success"}


def review_error():
    return {
        "name": "Paperclip Review",
        "status": "completed",
        "conclusion": "action_required",
    }


def marker_comment(login, user_type):
    return {
        "body": f"{TRIGGER}\n\nready head",
        "user": {"login": login, "type": user_type},
    }


class GitHubStub:
    def __init__(self, comments=None, runs=None):
        self.comments = list(comments or [])
        self.runs = list(runs or [])
        self.comment_posts = []

    def api(self, path, method="GET", body=None):
        if path.startswith("/commits/") and path.endswith("/pulls"):
            return [{
                "number": 7,
                "state": "open",
                "head": {"sha": HEAD_SHA, "ref": "change-branch"},
            }]
        if path == "/pulls/7":
            return {
                "number": 7,
                "draft": False,
                "head": {"sha": HEAD_SHA, "ref": "change-branch"},
                "user": {"login": "contributor"},
                "body": "",
                "labels": [],
                "additions": 1,
                "deletions": 1,
            }
        if path.startswith("/commits/") and "/check-runs?" in path:
            return {"check_runs": page_of(self.runs, path)}
        if path == "/pulls/7/files?per_page=100":
            return [{"filename": ".github/workflows/ci.yml"}]
        if path.startswith("/issues/7/comments?"):
            return page_of(self.comments, path)
        if path == "/issues/7/comments" and method == "POST":
            self.comment_posts.append(body["body"])
            self.comments.append(marker_comment(BOT_LOGIN, "Bot"))
            return {}
        if path == "/issues/7/labels" and method == "POST":
            return {}
        raise AssertionError(f"unexpected API call {method} {path}")

    @property
    def trigger_posts(self):
        return [body for body in self.comment_posts if TRIGGER in body]


def run_with(stub):
    old_api, old_env = step.api, dict(os.environ)
    step.api = stub.api
    os.environ.update({"HEAD_SHA": HEAD_SHA, "REPO": "owner/repo", "GH_TOKEN": "fake"})
    try:
        return step.main()
    finally:
        step.api = old_api
        os.environ.clear()
        os.environ.update(old_env)


class ReviewTriggerAuthAcceptanceTest(unittest.TestCase):
    def test_untrusted_marker_does_not_suppress_or_spend_retry(self):
        for login, user_type in (
            ("drive-by-user", "User"),
            (BOT_LOGIN, "User"),
        ):
            with self.subTest(login=login, user_type=user_type):
                stub = GitHubStub(
                    comments=[marker_comment(login, user_type)],
                    runs=[ci_ok(), review_error()],
                )

                self.assertEqual(run_with(stub), 0)
                self.assertEqual(len(stub.trigger_posts), 1)

    def test_one_bot_trigger_allows_one_retry_and_no_more(self):
        stub = GitHubStub(
            comments=[marker_comment(BOT_LOGIN, "Bot")],
            runs=[ci_ok(), review_error()],
        )

        self.assertEqual(run_with(stub), 0)
        self.assertEqual(len(stub.trigger_posts), 1)

        # The retry also errors. Its second workflow-authored marker exhausts
        # the budget, so another delivery must not post a third trigger.
        stub.runs.append(review_error())
        self.assertEqual(run_with(stub), 0)
        self.assertEqual(len(stub.trigger_posts), 1)


if __name__ == "__main__":
    unittest.main()
