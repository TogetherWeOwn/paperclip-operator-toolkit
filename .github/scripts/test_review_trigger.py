#!/usr/bin/env python3
"""Unit tests for review_trigger.py. Stdlib only, offline."""

import unittest

import review_trigger as rt

FULL_BODY = """
## Checklist

- [x] I wrote a thinking path that runs from the project to this change
- [x] I named the model used, with its version
- [x] I searched for duplicate or related PRs and linked them above
- [x] I ran the tests locally and they pass
- [x] I added or updated tests where applicable
- [x] I updated the documentation this change touches
"""

# Pinned by sha256(head) mod 10 (see review_trigger.in_audit_sample).
IN_SAMPLE_SHA = "1111111111111111111111111111111111111111"
OUT_OF_SAMPLE_SHA = "2222222222222222222222222222222222222222"


def base_payload(**overrides):
    payload = {
        "is_draft": False,
        "ci_ok_green": True,
        "head_sha": OUT_OF_SAMPLE_SHA,
        "head_ref": "card-1234-some-work",
        "author": "togetherweown[bot]",
        "body": FULL_BODY,
        "changed_files": ["docs/notes.md"],
        "labels": [],
        "additions": 10,
        "deletions": 5,
        "check_runs": [],
    }
    payload.update(overrides)
    return payload


class DecideTest(unittest.TestCase):
    def test_ready_head_requests_review(self):
        action, reason = rt.decide(base_payload())
        self.assertEqual(action, "request")
        self.assertIn("ready head", reason)

    def test_draft_never_reviewed(self):
        action, reason = rt.decide(base_payload(is_draft=True))
        self.assertEqual(action, "skip")
        self.assertIn("draft", reason)

    def test_draft_beats_risky(self):
        action, _ = rt.decide(
            base_payload(is_draft=True, changed_files=["ops/provisioner.sh"])
        )
        self.assertEqual(action, "skip")

    def test_ci_red_skips(self):
        action, reason = rt.decide(base_payload(ci_ok_green=False))
        self.assertEqual(action, "skip")
        self.assertIn("ci-ok", reason)

    def test_already_reviewed_head_skips(self):
        runs = [
            {
                "name": "Paperclip Review",
                "status": "completed",
                "conclusion": "success",
                "head_sha": OUT_OF_SAMPLE_SHA,
            }
        ]
        action, reason = rt.decide(base_payload(check_runs=runs))
        self.assertEqual(action, "skip")
        self.assertIn("already", reason)

    def test_failure_verdict_blocks_rerequest(self):
        runs = [
            {
                "name": "Paperclip Review",
                "status": "completed",
                "conclusion": "failure",
                "head_sha": OUT_OF_SAMPLE_SHA,
            }
        ]
        action, reason = rt.decide(base_payload(check_runs=runs))
        self.assertEqual(action, "skip")
        self.assertIn("already", reason)

    def test_incomplete_conclusions_do_not_block(self):
        for conclusion in (
            "action_required",
            "cancelled",
            "timed_out",
            "stale",
            "skipped",
            None,
        ):
            with self.subTest(conclusion=conclusion):
                runs = [
                    {
                        "name": "Paperclip Review",
                        "status": "completed",
                        "conclusion": conclusion,
                        "head_sha": OUT_OF_SAMPLE_SHA,
                    }
                ]
                action, _ = rt.decide(base_payload(check_runs=runs))
                self.assertEqual(action, "request")

    def test_token_substring_names_are_risky(self):
        for path in (
            "ops/refresh_token.py",
            "ops/refresh_tokens.py",
            "ops/tokens/rotate.sh",
            "ops/rotate_tokens.sh",
        ):
            with self.subTest(path=path):
                risky, _ = rt.is_risky([path], [], 1, 1)
                self.assertTrue(risky, path)

    def test_truncation_marker_is_risky(self):
        risky, reasons = rt.is_risky(
            [".github/workflows/TRUNCATED-FILE-LIST-unknown"], [], 10, 5
        )
        self.assertTrue(risky)
        self.assertTrue(reasons)

    def test_review_on_other_head_does_not_block(self):
        runs = [
            {
                "name": "Paperclip Review",
                "status": "completed",
                "conclusion": "success",
                "head_sha": "aaaa" + "0" * 36,
            }
        ]
        action, _ = rt.decide(base_payload(check_runs=runs))
        self.assertEqual(action, "request")

    def test_in_progress_review_does_not_block(self):
        runs = [
            {
                "name": "Paperclip Review",
                "status": "in_progress",
                "conclusion": None,
                "head_sha": OUT_OF_SAMPLE_SHA,
            }
        ]
        action, _ = rt.decide(base_payload(check_runs=runs))
        self.assertEqual(action, "request")

    def test_other_check_runs_ignored(self):
        runs = [
            {
                "name": "ci-ok",
                "status": "completed",
                "conclusion": "success",
                "head_sha": OUT_OF_SAMPLE_SHA,
            }
        ]
        action, _ = rt.decide(base_payload(check_runs=runs))
        self.assertEqual(action, "request")

    def test_release_please_by_author_auto_invokes(self):
        action, reason = rt.decide(
            base_payload(author="github-actions[bot]", body="no checklist here")
        )
        self.assertEqual(action, "request")
        self.assertIn("release-please", reason)

    def test_release_please_by_branch_auto_invokes(self):
        action, _ = rt.decide(
            base_payload(head_ref="release-please--branches--main", body="")
        )
        self.assertEqual(action, "request")

    def test_risky_path_waives_checklist(self):
        action, reason = rt.decide(
            base_payload(changed_files=["ops/provisioner.sh"], body="empty")
        )
        self.assertEqual(action, "request")
        self.assertIn("risky", reason)

    def test_risky_workflow_path(self):
        action, _ = rt.decide(
            base_payload(changed_files=[".github/workflows/ci.yml"], body="")
        )
        self.assertEqual(action, "request")

    def test_risk_label_triggers(self):
        action, _ = rt.decide(base_payload(labels=["security"], body=""))
        self.assertEqual(action, "request")

    def test_large_diff_triggers(self):
        action, reason = rt.decide(
            base_payload(body="", additions=500, deletions=200)
        )
        self.assertEqual(action, "request")
        self.assertIn("large diff", reason)

    def test_small_diff_with_complete_checklist_requests(self):
        action, _ = rt.decide(base_payload(additions=600, deletions=0))
        self.assertEqual(action, "request")

    def test_checklist_incomplete_skips(self):
        body = FULL_BODY.replace(
            "- [x] I updated the documentation this change touches",
            "- [ ] I updated the documentation this change touches",
        )
        action, reason = rt.decide(base_payload(body=body))
        self.assertEqual(action, "skip")
        self.assertIn("checklist incomplete", reason)
        self.assertIn("updated the documentation", reason)

    def test_empty_body_skips(self):
        action, _ = rt.decide(base_payload(body=""))
        self.assertEqual(action, "skip")

    def test_audit_sample_requests(self):
        action, reason = rt.decide(base_payload(head_sha=IN_SAMPLE_SHA))
        self.assertEqual(action, "request")
        self.assertIn("audit sample", reason)

    def test_audit_sample_is_deterministic(self):
        self.assertTrue(rt.in_audit_sample(IN_SAMPLE_SHA))
        self.assertFalse(rt.in_audit_sample(OUT_OF_SAMPLE_SHA))
        self.assertEqual(
            rt.in_audit_sample(IN_SAMPLE_SHA), rt.in_audit_sample(IN_SAMPLE_SHA)
        )

    def test_audit_sample_rate_is_about_ten_percent(self):
        shas = ["%040d" % i for i in range(1000)]
        hits = sum(1 for s in shas if rt.in_audit_sample(s))
        self.assertTrue(50 <= hits <= 150, "hits=%d" % hits)

    def test_old_template_machine_boxes_do_not_count(self):
        body = (
            "- [x] CI is green on the exact head\n"
            "- [x] No secrets in the diff\n"
        )
        complete, missing = rt.checklist_status(body)
        self.assertFalse(complete)
        self.assertTrue(missing)

    def test_never_returns_empty(self):
        for payload in (
            base_payload(),
            base_payload(is_draft=True),
            {},
            {"head_sha": None},
        ):
            action, reason = rt.decide(payload)
            self.assertIn(action, ("request", "skip"))
            self.assertTrue(reason)


if __name__ == "__main__":
    unittest.main()
