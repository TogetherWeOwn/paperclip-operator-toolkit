#!/usr/bin/env python3
"""Hermetic regression coverage for promotion semantics and alert delivery.

These are implementer-owned regressions, separate from the original acceptance
suite. GitHub, public readiness, and issue writes are all replaced by fakes.
"""
import argparse
import contextlib
import io
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import release_lag as lag

NOW = lag.parse_ts("2026-10-19T03:00:00Z")
A, B, C = (letter * 40 for letter in "abc")


def run(sha=A, at="2026-10-17T00:00:00Z", conclusion="success", number=1):
    return {"sha": sha, "created_at": at, "updated_at": at,
            "status": "completed", "conclusion": conclusion,
            "number": number, "attempt": 1, "title": "deploy-production"}


def checkout_log(sha):
    return "\n".join("2026-10-19T01:00:00.1234567Z " + line for line in (
        "##[group]Run actions/checkout@pinned", "  ref: " + sha,
        "##[endgroup]", "##[group]Checking out the ref",
        "##[endgroup]", "[command]/usr/bin/git log -1 --format=%H", sha))


class PromotionEvidenceTests(unittest.TestCase):
    def test_invalid_identity_config_is_unknown_without_fetching(self):
        good = {"prod_url": "https://example.invalid/health", "prod_sha_path": "revision.commit"}
        for field in ("prod_url", "prod_sha_path"):
            for value in (None, 123, [], {}):
                with self.subTest(field=field, value=value), patch.object(lag, "urlopen") as get:
                    with self.assertRaises(RuntimeError):
                        lag.read_live_sha(dict(good, **{field: value}))
                    get.assert_not_called()

    def test_forbidden_identity_remains_unknown_without_retry(self):
        app = {"prod_url": "https://example.invalid/health", "prod_sha_path": "revision.commit"}
        error = HTTPError(app["prod_url"], 403, "Forbidden", {}, None)
        with patch.object(lag, "urlopen", side_effect=error) as get:
            with self.assertRaisesRegex(RuntimeError, "HTTP 403"):
                lag.read_live_sha(app)
        get.assert_called_once()

    def test_workflow_head_is_never_a_deployed_target(self):
        raw = {"head_sha": C, "head_commit": {"timestamp": "2026-10-19T01:00:00Z"}}
        got = lag.normalize_run(raw)
        self.assertIsNone(got["sha"])
        self.assertIsNone(got["head_ts"])

    def test_first_target_checkout_not_second_tooling_checkout(self):
        self.assertEqual(lag.checkout_sha(checkout_log(A) + "\n" + checkout_log(C)), A)

    def test_missing_or_inconsistent_checkout_ref_is_unknown(self):
        for log in ("", checkout_log(A).replace("  ref: " + A, "  ref: " + B),
                    checkout_log(A).replace("git log -1 --format=%H", "echo fake")):
            with self.subTest(log=log), self.assertRaises(RuntimeError):
                lag.checkout_sha(log)

    def test_successful_noop_has_no_sha_and_does_not_count_as_a_deploy(self):
        job = {"id": 8, "name": "deploy-production", "status": "completed",
               "conclusion": "skipped", "completed_at": "2026-10-19T01:00:00Z"}
        with patch.object(lag, "run_jobs", return_value=[job]), patch.object(lag, "gh_command") as gh:
            measured = lag.resolve_job_run("Example/app", run(None), "deploy-production")
        gh.assert_not_called()
        self.assertIsNone(measured["sha"])
        self.assertEqual(lag.compute_dora([measured], NOW)["deploys"], 0)
        verdict = lag.evaluate_app([run(A, "2026-10-01T00:00:00Z"), measured], [], NOW)
        self.assertEqual(verdict["status"], "stale-prod")

    def test_job_target_and_completion_replace_trigger_identity(self):
        job = {"id": 8, "name": "ship", "status": "completed", "conclusion": "success",
               "completed_at": "2026-10-19T01:00:00Z"}
        with patch.object(lag, "run_jobs", return_value=[job]), \
                patch.object(lag, "gh_command", return_value=checkout_log(B)):
            measured = lag.resolve_job_run("Example/app", run(None), "ship")
        self.assertEqual(measured["sha"], B)
        self.assertEqual(measured["updated_at"], job["completed_at"])

    def test_pinned_bot_staging_uses_same_target_resolver(self):
        app = {"repo": "Example/app", "staging_job": "ship"}
        with patch.object(lag, "resolve_job_run", return_value=run(B)) as resolve:
            measured = lag.measure_staging(app, [run(None)])
        self.assertEqual(measured[0]["sha"], B)
        resolve.assert_called_once()

    def test_web_title_requires_executed_journeys_and_quality(self):
        item = dict(run(None), title="e2e-staging deploy " + B)
        app = {"repo": "Example/app", "staging_source": "web-e2e-title"}
        steps = [{"name": name, "conclusion": "success"} for name in (
            "Lighthouse performance budgets (mobile, ci/lighthouserc.cjs)",
            "Lighthouse quality scores (desktop, categories vs ci/quality-budget.json)")]
        jobs = [{"name": "staging-journeys", "conclusion": "success"},
                {"name": "staging-quality / quality", "conclusion": "success", "steps": steps}]
        with patch.object(lag, "run_jobs", return_value=jobs):
            self.assertEqual(lag.measure_staging(app, [item])[0]["sha"], B)
        jobs[1]["steps"][0]["conclusion"] = "skipped"
        with patch.object(lag, "run_jobs", return_value=jobs):
            self.assertEqual(lag.measure_staging(app, [item]), [])


class VerdictRegressionTests(unittest.TestCase):
    def test_newest_success_selected_from_out_of_order_history(self):
        newer = run(B, "2026-10-19T02:00:00Z", number=2)
        older = run(A, "2026-10-16T02:00:00Z")
        verdict = lag.evaluate_app([newer, older], [newer], NOW)
        self.assertEqual(verdict["prod_sha"], B)
        self.assertEqual(verdict["status"], "ok")

    def test_old_equal_sha_candidate_with_recent_production_stays_ok(self):
        verdict = lag.evaluate_app([run(A, "2026-10-19T02:00:00Z")], [run(A)], NOW)
        self.assertEqual(verdict["status"], "ok")
        self.assertFalse(verdict["alert"])

    def test_equal_sha_reverification_must_not_alert_either(self):
        verdict = lag.evaluate_app([run(A, "2026-10-16T00:00:00Z")], [run(A)], NOW,
                                   candidate_ahead=True)
        self.assertEqual(verdict["status"], "ok")
        self.assertFalse(verdict["alert"])

    def test_production_ahead_of_old_candidate_is_not_lagging(self):
        verdict = lag.evaluate_app([run(B, "2026-10-19T01:00:00Z")], [run(A)], NOW,
                                   candidate_ahead=False)
        self.assertEqual(verdict["status"], "ok")
        self.assertFalse(verdict["alert"])

    def test_unreadable_ancestry_is_unknown(self):
        verdict = lag.evaluate_app([run(A)], [run(B, "2026-10-17T02:00:00Z")], NOW,
                                   candidate_ahead=None)
        self.assertEqual(verdict["status"], "unknown")
        self.assertFalse(verdict["measured"])

    def test_missing_staging_is_unknown_not_recovered(self):
        verdict = lag.evaluate_app([run(A)], [], NOW)
        self.assertEqual(verdict["status"], "unknown")
        self.assertFalse(verdict["measured"])

    def test_partial_measurement_has_nonzero_exit_even_when_other_app_ok(self):
        payload = {"results": {"Example/good": {"measured": True, "alert": False},
                               "Example/bad": {"measured": False, "alert": False}}}
        self.assertEqual(lag.check_exit(payload), 2)

    def test_divergent_or_unreadable_comparison_does_not_assert_ahead(self):
        for result in ({"status": "diverged", "ahead_by": 5, "behind_by": 1}, {}):
            with patch.object(lag, "gh_json", return_value=result):
                self.assertIsNone(lag.compare_ahead_by("Example/app", A, B))
        with patch.object(lag, "gh_json", return_value={"status": "ahead", "ahead_by": 5, "behind_by": 0}):
            self.assertEqual(lag.compare_ahead_by("Example/app", A, B), 5)


class DoraRegressionTests(unittest.TestCase):
    def test_skipped_cancelled_neutral_are_not_failures_or_incidents(self):
        successes = [run(A), run(B, "2026-10-18T00:00:00Z")]
        nonchanges = [run(None, conclusion=c) for c in ("skipped", "cancelled", "neutral")]
        expected = lag.compute_dora(successes, NOW)
        self.assertEqual(lag.compute_dora(successes + nonchanges, NOW), expected)
        self.assertEqual(expected["failed"], 0)
        self.assertEqual(expected["incidents"], 0)

    def test_timed_out_and_startup_failure_are_attempts(self):
        got = lag.compute_dora([run(None, conclusion=c) for c in ("failure", "timed_out", "startup_failure")], NOW)
        self.assertEqual(got["failed"], 3)
        self.assertEqual(got["change_fail_rate"], 1)

    def test_live_lead_uses_target_merge_to_verified_completion(self):
        item = dict(run(A, "2026-10-18T04:00:00Z"), merged_at="2026-10-18T00:00:00Z")
        got = lag.compute_dora([item], NOW)
        self.assertEqual(got["median_lead_seconds"], 14400)
        self.assertIsNone(lag.compute_dora([run(A)], NOW)["median_lead_seconds"])

    def test_unknown_discovered_app_is_visible_in_digest(self):
        self.assertIn("| Example/new | unknown | n/a", lag.render_dora_markdown({"Example/new": None}, 28))


class FetchAndDiscoveryTests(unittest.TestCase):
    def test_inventory_and_runs_paginate_instead_of_truncating(self):
        batches = [[{"id": i} for i in range(100)], [{"id": 100}]]
        with patch.object(lag, "gh_json", side_effect=batches) as get:
            self.assertEqual(len(lag.gh_api("orgs/Example/repos")), 101)
        self.assertIn("page=2", get.call_args_list[1].args[0])

    def test_pagination_bound_is_unknown_not_partial_success(self):
        with patch.object(lag, "gh_json", return_value=[{}] * 100):
            with self.assertRaises(RuntimeError):
                lag.gh_api("orgs/Example/repos", max_pages=2)

    def test_file_stem_matches_differently_named_workflow(self):
        with patch.object(lag, "gh_api", return_value=[{"id": 5, "name": "Ship safely",
                    "path": ".github/workflows/deploy-production.yaml", "state": "active"}]):
            self.assertEqual(lag.workflow_id_for("Example/app", "deploy-production"), 5)

    def test_unresolved_workflow_is_not_empty_deploy_history(self):
        with patch.object(lag, "workflow_id_for", return_value=None):
            with self.assertRaises(RuntimeError):
                lag.fetch_runs("Example/app", "renamed")

    def test_candidate_beyond_ten_failures_is_still_fetched(self):
        rows = [{"id": n, "status": "completed", "conclusion": "failure"} for n in range(12)]
        rows.append({"id": 99, "status": "completed", "conclusion": "success"})
        with patch.object(lag, "workflow_id_for", return_value=1), \
                patch.object(lag, "gh_api", return_value=rows):
            got = lag.fetch_runs("Example/app", "stage", NOW)
        self.assertEqual(got[-1]["number"], 99)
        self.assertEqual(len(got), 13)

    def test_discovery_failure_keeps_explicit_inventory_and_records_error(self):
        args = argparse.Namespace(no_discover=False)
        with patch.object(lag, "discover_repos", side_effect=RuntimeError("outage")):
            apps, errors = lag.configured_apps(args, {"org": "Example", "apps": [{"repo": "Example/known"}]})
        self.assertEqual(apps, [{"repo": "Example/known"}])
        self.assertTrue(errors)

    def test_discovery_preserves_staging_signal_and_explicit_contract(self):
        result = lag.merge_apps([{"repo": "Example/known", "prod_job": "ship"}],
                                [{"repo": "Example/known"}, {"repo": "Example/new", "staging_workflow": "stage"}])
        self.assertEqual(result[0]["prod_job"], "ship")
        self.assertEqual(result[1]["staging_workflow"], "stage")
        with self.assertRaises(RuntimeError):
            lag.measure_production(result[1], [])


class CollectionTests(unittest.TestCase):
    def test_real_collection_path_excludes_noop_and_publishes_both_inventories(self):
        app = {"repo": "Example/app", "prod_workflow": "prod", "prod_job": "ship",
               "staging_workflow": "stage", "staging_job": "stage"}
        discovered = {"repo": "Example/new", "prod_workflow": "prod", "staging_workflow": None}
        prod = [run(None, number=1), run(None, "2026-10-19T02:00:00Z", number=2)]
        stage = [run(None, "2026-10-17T02:00:00Z", number=3)]
        def jobs(repo, item):
            name = "stage" if item["number"] == 3 else "ship"
            return [{"id": item["number"], "name": name, "status": "completed",
                     "conclusion": "skipped" if item["number"] == 2 else "success",
                     "completed_at": item["updated_at"]}]
        def fetch(repo, workflow, since):
            return stage if workflow == "stage" else prod
        def command(*args):
            return checkout_log(B if args[-1].endswith("/3/logs") else A)
        with patch.object(lag, "configured_apps", return_value=([app, discovered], [])), \
                patch.object(lag, "fetch_runs", side_effect=fetch), \
                patch.object(lag, "run_jobs", side_effect=jobs), \
                patch.object(lag, "gh_command", side_effect=command), \
                patch.object(lag, "read_live_sha", return_value=A), \
                patch.object(lag, "compare_ahead_by", return_value=2), \
                patch.object(lag, "add_merge_times"), contextlib.redirect_stderr(io.StringIO()):
            payload = lag.collect(argparse.Namespace(), {}, NOW, 28)
        verdict = payload["results"]["Example/app"]
        self.assertEqual(verdict["status"], "lagging")
        self.assertEqual(verdict["prod_sha"], A)
        self.assertEqual(verdict["prod_deployed_at"], prod[0]["updated_at"])
        self.assertEqual(payload["dora"]["Example/app"]["deploys"], 1)
        self.assertIsNone(payload["dora"]["Example/new"])
        self.assertEqual(payload["results"]["Example/new"]["status"], "unknown")
        self.assertEqual(lag.check_exit(payload), 2)

    def test_serving_identity_mismatch_cannot_close_an_alert(self):
        app = {"repo": "Example/app", "prod_workflow": "prod", "staging_workflow": "stage"}
        with patch.object(lag, "configured_apps", return_value=([app], [])), \
                patch.object(lag, "fetch_runs", return_value=[]), \
                patch.object(lag, "measure_production", return_value=[run(A)]), \
                patch.object(lag, "measure_staging", return_value=[run(A)]), \
                patch.object(lag, "add_merge_times"), \
                patch.object(lag, "read_live_sha", return_value=B), \
                contextlib.redirect_stderr(io.StringIO()):
            payload = lag.collect(argparse.Namespace(), {}, NOW, 28)
        self.assertFalse(payload["results"]["Example/app"]["measured"])
        self.assertEqual(lag.check_exit(payload), 2)

    def test_dora_reuses_snapshot_including_discovered_unknown_app(self):
        payload = {"now": NOW.isoformat(), "dora_window_days": 28, "errors": [],
                   "dora": {"Example/new": None}}
        args = argparse.Namespace(from_check="snapshot.json", out=None)
        with patch.object(lag, "load_config", return_value=payload), \
                patch.object(lag, "collect") as collect, contextlib.redirect_stdout(io.StringIO()) as out:
            result = lag.cmd_dora(args)
        collect.assert_not_called()
        self.assertEqual(result, 2)
        self.assertIn("Example/new", out.getvalue())


class IssueDeliveryTests(unittest.TestCase):
    def test_unknown_does_not_read_or_close_existing_alert(self):
        with patch.object(lag, "gh_command") as gh:
            lag.sync_alerts("Example/monitor", {"Example/app": {"measured": False, "status": "unknown"}})
        gh.assert_not_called()

    def test_changed_alert_updates_saved_body_and_next_run_is_silent(self):
        verdict = lag.evaluate_app([run(A)], [run(B, "2026-10-17T02:00:00Z")], NOW)
        issue = {"number": 7, "title": "[release-lag:v1:Example/app] Production is behind", "body": "old"}
        calls = []
        def fake(*args):
            calls.append(args)
            if args[:2] == ("issue", "edit"):
                issue["body"] = args[-1]
            return ""
        with patch.object(lag, "find_open_issue", return_value=issue), patch.object(lag, "gh_command", side_effect=fake):
            lag.sync_alerts("Example/monitor", {"Example/app": verdict})
            lag.sync_alerts("Example/monitor", {"Example/app": verdict})
        self.assertEqual([c[1] for c in calls], ["comment", "edit"])

    def test_only_measured_ok_closes_alert(self):
        verdict = lag.evaluate_app([run(A)], [run(A)], NOW)
        with patch.object(lag, "find_open_issue", return_value={"number": 7}), patch.object(lag, "gh_command") as gh:
            lag.sync_alerts("Example/monitor", {"Example/app": verdict})
        self.assertEqual(gh.call_args.args[0:2], ("issue", "close"))

    def test_digest_creates_issue_using_supported_url_output(self):
        with patch.object(lag, "find_open_issue", return_value=None), \
                patch.object(lag, "gh_command", side_effect=["https://github.com/Example/monitor/issues/9\n", ""]) as gh:
            lag.publish_digest("Example/monitor", "weekly numbers")
        create, comment = [call.args for call in gh.call_args_list]
        self.assertNotIn("--jq", create)
        self.assertEqual(comment[4], "9")

    def test_workflow_digest_has_failure_independent_condition_and_shared_auth(self):
        text = Path(".github/workflows/release-lag.yml").read_text()
        digest = text.split("- name: Weekly DORA digest", 1)[1].split("- name:", 1)[0]
        self.assertIn("!cancelled()", digest)
        self.assertIn("github.event.schedule == '47 8 * * 1'", digest)
        self.assertIn("--from-check", digest)
        self.assertIn("GH_TOKEN: ${{ github.token }}", text)
        self.assertLess(text.index("Weekly DORA digest"), text.index("Fail the run for alerts"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
