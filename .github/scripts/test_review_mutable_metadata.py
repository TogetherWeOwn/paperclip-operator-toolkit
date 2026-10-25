#!/usr/bin/env python3
"""Offline workflow regressions for mutable PR risk evidence."""

import copy
import unittest

from test_review_ready_head_acceptance import MovingEvidence, ci_run
from test_review_trigger_step import PR, run_with


class MovingFiles(MovingEvidence):
    def __init__(self, later_files, **kwargs):
        super().__init__(**kwargs)
        self.later_files = later_files
        self.file_reads = 0

    def api(self, path, method="GET", body=None):
        if method == "GET" and path == "/pulls/7/files?per_page=100":
            self.file_reads += 1
            if self.file_reads > 1:
                return copy.deepcopy(self.later_files)
        return super().api(path, method, body)


class MutableMetadataTest(unittest.TestCase):
    def test_base_retarget_uses_current_files_before_publication(self):
        initial = dict(PR, body="", base={"ref": "main", "sha": "a" * 40})
        current = dict(initial, base={"ref": "release", "sha": "b" * 40})
        for later_files in ([], [{"filename": "docs/notes.md"}]):
            with self.subTest(later_files=later_files):
                stub = MovingFiles(
                    pr=initial, later_pr=current, runs=[ci_run()],
                    files=[{"filename": "ops/deploy.py"}], later_files=later_files)
                self.assertEqual(run_with(stub), 0)
                self.assertEqual(stub.posts, [])

    def test_base_retarget_with_current_risky_path_still_publishes(self):
        initial = dict(PR, body="", base={"ref": "main", "sha": "a" * 40})
        current = dict(initial, base={"ref": "release", "sha": "b" * 40})
        stub = MovingFiles(
            pr=initial, later_pr=current, runs=[ci_run()],
            files=[{"filename": "ops/deploy.py"}],
            later_files=[{"filename": "ops/auth.py"}])
        self.assertEqual(run_with(stub), 0)
        self.assertEqual(len(stub.posts), 2)
        self.assertIn("label:review-ready", stub.posts)
        comment = next(p for p in stub.posts if p != "label:review-ready")
        self.assertIn("ops/auth.py", comment)
        self.assertNotIn("ops/deploy.py", comment)

    def test_final_truncated_files_keep_conservative_review_routing(self):
        stub = MovingFiles(
            pr=dict(PR, body=""), runs=[ci_run()],
            files=[{"filename": "ops/deploy.py"}],
            later_files=[{"filename": "docs/note-%d.md" % i} for i in range(100)])
        self.assertEqual(run_with(stub), 0)
        self.assertEqual(len(stub.posts), 2)
        self.assertIn("label:review-ready", stub.posts)
        self.assertTrue(any("TRUNCATED-FILE-LIST-unknown" in p for p in stub.posts))

    def test_final_risk_labels_control_publication(self):
        initial = dict(PR, body="", labels=[{"name": "security"}])
        for retained in (False, True):
            with self.subTest(retained=retained):
                current = dict(initial, labels=initial["labels"] if retained else [])
                stub = MovingEvidence(pr=initial, later_pr=current, runs=[ci_run()])
                self.assertEqual(run_with(stub), 0)
                if retained:
                    self.assertEqual(len(stub.posts), 2)
                    self.assertIn("label:review-ready", stub.posts)
                    self.assertTrue(any("risk labels: security" in p for p in stub.posts))
                else:
                    self.assertEqual(stub.posts, [])


if __name__ == "__main__":
    unittest.main()
