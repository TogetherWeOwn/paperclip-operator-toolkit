#!/usr/bin/env python3
"""Release-lag + DORA acceptance tests.

THE RISK THIS EXISTS FOR. Production drifted 647 commits / 9 days behind the
default branch unnoticed. The detector that would have paged must prove two
things before it earns its schedule: it FIRES on a lagging history, and it
STAYS SILENT on a fresh one. A suite that only covers the firing case cannot
tell a pager from an alarm that never stops ringing.

RED/GREEN PROOF. Every verdict below is driven by a fixture under
test/fixtures/release-lag/, so reintroducing the bug is a fixture edit away:
point fresh.json's prod SHA at an old commit and the silence case goes red;
point lagging.json's staging run at the prod SHA and the firing case goes red.

Stdlib only, offline: no gh, no network, no credentials.
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import release_lag as lag

HERE = os.path.dirname(os.path.abspath(__file__))


def fixture(name):
    path = os.path.join(HERE, "test", "fixtures", "release-lag", name)
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def evaluate_fixture(name):
    data = fixture(name)
    now = lag.parse_ts(data["now"])
    return lag.evaluate_app(data["prod_runs"], data["staging_runs"], now)


class LagVerdictTests(unittest.TestCase):
    def test_lagging_fixture_fires(self):
        verdict = evaluate_fixture("lagging.json")
        self.assertEqual(verdict["status"], "lagging")
        self.assertTrue(verdict["alert"])
        self.assertTrue(verdict["measured"])
        self.assertGreater(verdict["lag_hours"], 24)
        self.assertNotEqual(verdict["prod_sha"], verdict["staging_sha"])

    def test_fresh_fixture_stays_silent(self):
        verdict = evaluate_fixture("fresh.json")
        self.assertEqual(verdict["status"], "ok")
        self.assertFalse(verdict["alert"])
        self.assertTrue(verdict["measured"])

    def test_stale_prod_fires_without_candidate(self):
        verdict = evaluate_fixture("stale-prod.json")
        self.assertEqual(verdict["status"], "stale-prod")
        self.assertTrue(verdict["alert"])
        self.assertTrue(verdict["measured"])

    def test_empty_history_is_unknown_not_ok(self):
        now = lag.parse_ts("2026-10-19T03:00:00Z")
        verdict = lag.evaluate_app([], [], now)
        self.assertEqual(verdict["status"], "unknown")
        self.assertFalse(verdict["alert"])
        self.assertFalse(verdict["measured"])

    def test_candidate_younger_than_threshold_stays_silent(self):
        data = fixture("lagging.json")
        now = lag.parse_ts(data["now"])
        verdict = lag.evaluate_app(data["prod_runs"], data["staging_runs"], now,
                                   lag_hours=72)
        self.assertEqual(verdict["status"], "ok")
        self.assertFalse(verdict["alert"])


class DoraTests(unittest.TestCase):
    def test_weekly_numbers_match_hand_computed_fixture(self):
        data = fixture("dora-runs.json")
        now = lag.parse_ts(data["now"])
        got = lag.compute_dora(data["prod_runs"], now, data["window_days"])
        want = data["expected"]
        self.assertEqual(got["deploys"], want["deploys"])
        self.assertEqual(got["deploys_per_week"], want["deploys_per_week"])
        self.assertEqual(got["completed"], want["completed"])
        self.assertEqual(got["failed"], want["failed"])
        self.assertAlmostEqual(got["change_fail_rate"], want["change_fail_rate"])
        self.assertAlmostEqual(got["median_lead_seconds"], want["median_lead_seconds"])
        self.assertAlmostEqual(got["median_restore_seconds"], want["median_restore_seconds"])
        self.assertEqual(got["incidents"], want["incidents"])

    def test_empty_window_reports_no_numbers_not_zeroes(self):
        now = lag.parse_ts("2026-10-19T00:00:00Z")
        got = lag.compute_dora([], now, 28)
        self.assertEqual(got["deploys"], 0)
        self.assertIsNone(got["change_fail_rate"])
        self.assertIsNone(got["median_lead_seconds"])
        self.assertIsNone(got["median_restore_seconds"])

    def test_dora_markdown_posts_the_numbers(self):
        data = fixture("dora-runs.json")
        now = lag.parse_ts(data["now"])
        dora = lag.compute_dora(data["prod_runs"], now, data["window_days"])
        text = lag.render_dora_markdown({"Example/app": dora}, data["window_days"])
        self.assertIn("1.25", text)
        self.assertIn("28.6%", text)
        self.assertIn("1h 0m", text)
        self.assertIn("1h 25m", text)


class DiscoveryTests(unittest.TestCase):
    def test_discovery_adds_but_never_rewrites_config(self):
        explicit = [{"repo": "Example/known", "prod_workflow": "ship-it",
                     "staging_workflow": "stage-it"}]
        discovered = [{"repo": "Example/known"}, {"repo": "Example/new"}]
        merged = lag.merge_apps(explicit, discovered)
        by_repo = {app["repo"]: app for app in merged}
        self.assertEqual(by_repo["Example/known"]["prod_workflow"], "ship-it")
        self.assertEqual(by_repo["Example/new"]["prod_workflow"], "deploy-production")
        self.assertEqual(len(merged), 2)

    def test_dedupe_key_is_stable_per_repo(self):
        self.assertEqual(lag.dedupe_key("Example/app"), "release-lag:v1:Example/app")


class LayoutTests(unittest.TestCase):
    def test_config_and_workflow_ship_with_the_detector(self):
        self.assertTrue(os.path.isfile(
            os.path.join(HERE, "ops", "release-lag", "apps.json")))
        self.assertTrue(os.path.isfile(
            os.path.join(HERE, ".github", "workflows", "release-lag.yml")))

    def test_config_lists_the_deployed_apps(self):
        with open(os.path.join(HERE, "ops", "release-lag", "apps.json"),
                  encoding="utf-8") as handle:
            config = json.load(handle)
        repos = {app["repo"] for app in config["apps"]}
        self.assertIn("TogetherWeOwn/two-web-next", repos)
        self.assertIn("TogetherWeOwn/two-bot-next", repos)


if __name__ == "__main__":
    unittest.main(verbosity=2)
