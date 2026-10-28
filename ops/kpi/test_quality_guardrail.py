#!/usr/bin/env python3
"""Offline guardrail contracts. All identities and observations are synthetic."""
import copy
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("escape_ledger", Path(__file__).with_name("escape_ledger.py"))
ledger = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ledger)


def fixture():
    meta = {"schema_version": 5, "run_id": "fixture-run", "mode": "shadow",
            "generated_at": "2026-10-24T00:00:01Z", "start": "2026-10-01T00:00:00Z",
            "end": "2026-10-24T00:00:00Z", "status": "complete", "errors": [],
            "repos": ["Org/app"], "unlinked_incident_mentions": 0,
            "coverage": [{"repo": "Org/app", "status": "complete", "merges": 3,
                          "analyzed": 3, "unlinked_fixes": 0, "unresolved_revert_commits": 0}]}
    merges = [{"type": "merge", "repo": "Org/app", "number": n,
               "mergedAt": at, "head": str(n) * 40, "merge_commit": "a" * 40,
               "opened_at": "2026-10-01T00:00:00Z", "review": {}}
              for n, at in [(1, "2026-10-01T01:00:00Z"),
                            (2, "2026-10-17T00:00:00Z"),
                            (3, "2026-10-17T00:00:01Z")]]
    events = [{"type": "escape", "repo": "Org/app", "id": "fix-1", "kind": "hotfix",
               "at": "2026-10-08T01:00:00Z", "introducers": [{"repo": "Org/app", "number": 1}]}]
    return meta, merges, events


class QualityGuardrail(unittest.TestCase):
    def summary(self, meta=None, merges=None, events=None):
        m, p, e = fixture()
        return ledger.quality_summary(m if meta is None else meta, p if merges is None else merges,
                                      e if events is None else events)

    def test_overlap_counts_one_merge_and_exact_seven_day_boundary(self):
        meta, merges, events = fixture()
        incident = dict(events[0], id="incident-1", kind="incident")
        revert = dict(events[0], id="revert-1", kind="revert")
        result = self.summary(events=[*events, incident, revert, copy.deepcopy(incident)])
        self.assertEqual(result["n"], 2)
        self.assertEqual(result["immature_n"], 1)
        self.assertEqual(result["escape_n"], 1)
        self.assertEqual(result["rework_n"], 1)
        self.assertEqual(result["affected_n"], 1)
        self.assertEqual(result["escape_rework_rate"], 0.5)
        self.assertEqual(result["affected_merges"][0]["event_ids"], ["fix-1", "incident-1", "revert-1"])
        self.assertEqual(result["affected_merges"][0]["head"], "1" * 40)

    def test_events_after_seven_days_or_at_snapshot_end_are_excluded(self):
        for at in ("2026-10-08T01:00:01Z", "2026-10-24T00:00:00Z", "2026-10-01T01:00:00Z"):
            event = dict(fixture()[2][0], at=at)
            with self.subTest(at=at):
                self.assertEqual(self.summary(events=[event])["escape_n"], 0)

    def test_old_introducers_and_foreign_pr_numbers_never_enter_numerator(self):
        event = dict(fixture()[2][0], introducers=[{"repo": "Org/other", "number": 1},
                                               {"repo": "Org/app", "number": 999}])
        self.assertEqual(self.summary(events=[event])["affected_n"], 0)

    def test_day_precision_incident_on_day_seven_is_not_guessed(self):
        event = dict(fixture()[2][0], kind="incident", time_precision="day",
                     at="2026-10-08T00:00:00Z")
        result = self.summary(events=[event])
        self.assertIsNone(result["escape_rework_rate"])
        self.assertIn("ambiguous_incident_time", result["reasons"])

    def test_day_precision_incident_with_whole_day_inside_window_counts(self):
        event = dict(fixture()[2][0], kind="incident", time_precision="day",
                     at="2026-10-03T00:00:00Z")
        self.assertEqual(self.summary(events=[event])["escape_rework_rate"], 0.5)

    def test_missing_coverage_or_linkage_never_looks_healthy(self):
        for change in ({"status": "partial"}, {"coverage": []}, {"unlinked_incident_mentions": 1},
                       {"coverage": [dict(fixture()[0]["coverage"][0], unlinked_fixes=1)]},
                       {"coverage": [dict(fixture()[0]["coverage"][0], unresolved_revert_commits=1)]}):
            with self.subTest(change=change):
                result = self.summary(meta=dict(fixture()[0], **change))
                self.assertIsNone(result["escape_rework_rate"])
                self.assertEqual(result["coverage_status"], "partial")
                self.assertEqual(result["n"], 2)

    def test_empty_n_is_na_not_zero(self):
        meta = fixture()[0]
        meta["coverage"][0].update(merges=0, analyzed=0)
        result = self.summary(meta=meta, merges=[], events=[])
        self.assertEqual(result["n"], 0)
        self.assertIsNone(result["escape_rework_rate"])

    def test_measured_spans_publish_samples_and_missing_not_queue_inference(self):
        meta, merges, events = fixture()
        merges[0]["review"] = {"completed_at": "2026-10-01T00:30:00Z",
                                "reviewed_head": merges[0]["head"]}
        result = self.summary(merges=merges)
        spans = result["stage_waits"]
        self.assertEqual(spans["pr_open_to_merge"]["n"], 3)
        self.assertEqual(spans["review_complete_to_merge"]["n"], 1)
        self.assertEqual(spans["review_complete_to_merge"]["missing_n"], 2)
        self.assertEqual(spans["review_complete_to_merge"]["p50_seconds"], 1800)
        self.assertNotIn("ci_queue", spans)

    def test_wrong_head_or_postmerge_review_is_missing_not_negative_wait(self):
        for review in ({"completed_at": "2026-10-01T00:30:00Z", "reviewed_head": "f" * 40},
                       {"completed_at": "2026-10-02T00:00:00Z", "reviewed_head": "1" * 40}):
            meta, merges, events = fixture()
            merges[0]["review"] = review
            self.assertEqual(self.summary(merges=merges)["stage_waits"]["review_complete_to_merge"]["n"], 0)

    def test_duplicate_merge_identity_rejected_not_diluted(self):
        meta, merges, events = fixture()
        with self.assertRaises(ValueError):
            self.summary(merges=[*merges, merges[0]])


if __name__ == "__main__":
    unittest.main()
