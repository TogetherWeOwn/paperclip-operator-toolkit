#!/usr/bin/env python3
# ===========================================================================
# test-dispatch-acceptance-measurement.py — hostile tests for the acceptance module
#
# Written to FAIL a plausible-but-wrong implementation. Every section has a
# positive control: a mutant input that must NOT pass (uncoded failure,
# missing run id, 16th run in a day, empty feed claimed as zero, proxy
# latency standing in for acceptance, candidate standing in for confirmed,
# card standing in for a wake, malformed envelope coerced to zero).
#
# Deterministic: no network, no clock read, no env. Imports only the pure
# functions of dispatch-acceptance-measurement.py. Network wrappers (fetch_all/_get) are
# exercised only through monkeypatched module attributes — never a socket.
# ===========================================================================
from __future__ import annotations

import importlib.util
import os
import sys
import unittest

MODULE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "dispatch-acceptance-measurement.py")
SPEC = importlib.util.spec_from_file_location("dispatch_acceptance_measurement", MODULE_PATH)
ACC = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ACC)

WS = "2026-09-22T03:25:00Z"
WE = "2026-09-29T03:25:00Z"


def sweep_row(created, details):
    return {"createdAt": created, "action": "Dispatch sweep (live): x",
            "actorId": ACC.PLUGIN_ID, "details": details}


def wake_req(created, run_id, issue_id="i1"):
    return {"createdAt": created, "action": "issue.assignment_wakeup_requested",
            "actorId": ACC.PLUGIN_ID,
            "details": {"runId": run_id, "issueId": issue_id,
                        "reason": "dispatch_stalled_issue"}}


def run_row(rid, started, status="succeeded", reason="dispatch_stalled_issue"):
    return {"id": rid, "startedAt": started, "finishedAt": started,
            "status": status,
            "contextSnapshot": {"wakeReason": reason}}


def touch_activity(iid, created="2026-09-23T00:07:00Z"):
    return {"createdAt": created, "action": "issue.updated",
            "actorId": ACC.PLUGIN_ID,
            "details": {"issueId": iid}}


class WindowTest(unittest.TestCase):
    def test_start_inclusive_end_exclusive(self):
        self.assertTrue(ACC.in_window(WS, WS, WE))
        self.assertFalse(ACC.in_window(WE, WS, WE))  # end is exclusive
        self.assertFalse(ACC.in_window("2026-09-22T03:24:59Z", WS, WE))
        self.assertIsNone(ACC.parse_iso("not-a-time"))
        self.assertFalse(ACC.in_window(None, WS, WE))


class PercentileTest(unittest.TestCase):
    def test_empty_is_none_not_zero(self):
        self.assertIsNone(ACC.percentile([], 50))  # missing, never 0

    def test_nearest_rank(self):
        self.assertEqual(ACC.percentile([1, 2, 3, 4], 50), 2)
        self.assertEqual(ACC.percentile([1, 2, 3, 4], 90), 4)


class WakeCoverageTest(unittest.TestCase):
    def test_full_coverage(self):
        rows = [sweep_row("2026-09-23T00:00:00Z",
                          {"wakeFailureDetails":
                           [{"issueId": "a", "code": "unknown",
                             "message": "m"}]})]
        cov = ACC.wake_error_coverage(rows)
        self.assertEqual((cov["numerator"], cov["denominator"]), (1, 1))
        self.assertEqual(cov["ratio"], 1.0)

    def test_missing_code_is_caught(self):
        # POSITIVE CONTROL: an uncoded failure must break 100%.
        rows = [sweep_row("2026-09-23T00:00:00Z",
                          {"wakeFailureDetails":
                           [{"issueId": "a", "code": "",
                             "message": "m"},
                            {"issueId": "b"}]})]
        cov = ACC.wake_error_coverage(rows)
        self.assertEqual((cov["numerator"], cov["denominator"]), (0, 2))
        self.assertEqual(cov["ratio"], 0.0)

    def test_no_rows_is_zero_over_zero_not_hundred(self):
        # 0/0 carries ratio None — never 100%.
        cov = ACC.wake_error_coverage([])
        self.assertEqual((cov["numerator"], cov["denominator"]), (0, 0))
        self.assertIsNone(cov["ratio"])
        rep = ACC.build_report(WS, WE, [], [], [])
        m = rep["metrics"]["wake_error_coverage"]
        self.assertEqual(m["status"], "missing")
        self.assertIsNone(m["ratio"])
        self.assertNotIn("100%", m["note"])

    def test_absent_details_are_not_coverage(self):
        # POSITIVE CONTROL: sweeps with no wakeFailureDetails key must not
        # read as 100% covered — absent details are incomplete, not complete.
        rows = [sweep_row("2026-09-23T00:00:00Z", {"idleAssigneePickedIssueIds": []}),
                sweep_row("2026-09-23T00:01:00Z",
                          {"wakeFailureDetails": "truncated-string"})]
        cov = ACC.wake_error_coverage(rows)
        self.assertEqual(cov["sweeps_with_details"], 0)
        self.assertEqual((cov["numerator"], cov["denominator"]), (0, 0))
        rep = ACC.build_report(WS, WE, rows, [], [])
        m = rep["metrics"]["wake_error_coverage"]
        self.assertEqual(m["status"], "missing")
        self.assertNotIn("100%", m["note"])

    def test_partial_details_break_ok(self):
        # One sweep with details, one without: ratio over the observed
        # population, but verdict is missing (never ok/100%).
        rows = [sweep_row("2026-09-23T00:00:00Z",
                          {"wakeFailureDetails":
                           [{"issueId": "a", "code": "c", "message": "m"}]}),
                sweep_row("2026-09-23T00:01:00Z", {})]
        rep = ACC.build_report(WS, WE, rows, [], [])
        m = rep["metrics"]["wake_error_coverage"]
        self.assertEqual((m["numerator"], m["denominator"]), (1, 1))
        self.assertEqual(m["status"], "missing")
        self.assertNotIn("100%", m["note"])


class JoinTest(unittest.TestCase):
    def test_only_sweep_reason_joins(self):
        runs = [run_row("r1", "2026-09-23T00:00:00Z"),
                run_row("r2", "2026-09-23T00:01:00Z",
                        reason="issue_commented"),
                {"id": "r3", "startedAt": "2026-09-23T00:02:00Z",
                 "status": "succeeded"}]  # no snapshot at all
        got = ACC.sweep_woken_runs(runs)
        self.assertEqual([r["id"] for r in got], ["r1"])

    def test_latency_ok(self):
        by_id = {"r1": run_row("r1", "2026-09-23T00:05:00Z")}
        s, kind, why = ACC.wake_latency_seconds(
            wake_req("2026-09-23T00:00:00Z", "r1"), by_id)
        self.assertEqual(s, 300.0)
        self.assertEqual(kind, "ok")
        self.assertEqual(why, "ok")

    def test_negative_latency_is_clock_skew_not_ok(self):
        # POSITIVE CONTROL: write-lag (run row commits before the wake
        # activity row) must not read as a negative or zero latency sample.
        by_id = {"r1": run_row("r1", "2026-09-23T00:00:00Z")}
        s, kind, why = ACC.wake_latency_seconds(
            wake_req("2026-09-23T00:05:00Z", "r1"), by_id)
        self.assertIsNone(s)
        self.assertEqual(kind, "clock_skew")

    def test_zero_joins_is_missing_not_ok(self):
        # POSITIVE CONTROL: no successful joins must not report status ok.
        rep = ACC.build_report(
            WS, WE,
            [wake_req("2026-09-23T00:05:00Z", None)],
            [], [])
        proxy = rep["metrics"]["wake_request_to_run_start_proxy"]
        self.assertEqual(proxy["status"], "missing")
        self.assertEqual(proxy["n"], 0)
        self.assertTrue(proxy["is_proxy"])
        actual = rep["metrics"]["idle_assignee_wake_latency"]
        self.assertEqual(actual["status"], "missing")
        self.assertFalse(actual["is_proxy"])

    def test_latency_missing_run_is_none(self):
        # POSITIVE CONTROL: queued:false wake must not read as 0s latency,
        # and the two unjoined kinds must stay distinct.
        s, kind, why = ACC.wake_latency_seconds(
            wake_req("2026-09-23T00:00:00Z", None), {})
        self.assertIsNone(s)
        self.assertEqual(kind, "never_queued")
        s2, kind2, why2 = ACC.wake_latency_seconds(
            wake_req("2026-09-23T00:00:00Z", "ghost"), {})
        self.assertIsNone(s2)
        self.assertEqual(kind2, "missing")
        self.assertIn("missing", why2.lower())


class ProxyVsActualLatencyTest(unittest.TestCase):
    def test_late_wake_with_fast_proxy_is_actual_breach(self):
        # POSITIVE CONTROL: issue eligible >30min, run starts 10s after a
        # late wake. The proxy (wake->run = 10s) looks fine; the ACCEPTANCE
        # metric (eligible->wake = 40min) breaches. A proxy-only method
        # reports a pass here — this method must not.
        w = wake_req("2026-09-23T00:40:00Z", "r1", issue_id="i1")
        by_id = {"r1": run_row("r1", "2026-09-23T00:40:10Z")}
        ps, pkind, _ = ACC.wake_latency_seconds(w, by_id)
        self.assertEqual(pkind, "ok")
        self.assertEqual(ps, 10.0)
        asec, akind, _ = ACC.eligible_idle_to_wake_seconds(
            "2026-09-23T00:00:00Z", "2026-09-23T00:40:00Z")
        self.assertEqual(akind, "ok")
        self.assertGreater(asec, 30 * 60)
        rep = ACC.build_report(
            WS, WE, [w], [run_row("r1", "2026-09-23T00:40:10Z")], [],
            eligibility_by_issue={"i1": "2026-09-23T00:00:00Z"})
        proxy = rep["metrics"]["wake_request_to_run_start_proxy"]
        actual = rep["metrics"]["idle_assignee_wake_latency"]
        self.assertEqual(proxy["breaches_over_30min"], 0)
        self.assertEqual(actual["status"], "ok")
        self.assertEqual(actual["breaches_over_30min"], 1)
        self.assertEqual(actual["numerator"], 1)

    def test_actual_missing_without_eligibility_population(self):
        # Without an authorized eligibility population the acceptance
        # metric is missing — the proxy must not stand in for it.
        w = wake_req("2026-09-23T00:00:00Z", "r1", issue_id="i1")
        rep = ACC.build_report(
            WS, WE, [w], [run_row("r1", "2026-09-23T00:00:10Z")], [])
        actual = rep["metrics"]["idle_assignee_wake_latency"]
        self.assertEqual(actual["status"], "missing")
        self.assertIsNotNone(actual["note_missing"])
        self.assertEqual(actual["numerator"], 0)


class KillRuleTest(unittest.TestCase):
    def _day(self, n, day="2026-09-23"):
        return [{"startedAt": "%sT%02d:00:00Z" % (day, h % 24)}
                for h in range(n)]

    def test_fifteen_passes(self):
        self.assertFalse(
            ACC.kill_breach(
                ACC.per_day_counts(self._day(15), lambda r: r["startedAt"]))[0])

    def test_sixteen_breaches(self):
        # POSITIVE CONTROL: the 16th run in one day trips the kill rule.
        breached, bad = ACC.kill_breach(
            ACC.per_day_counts(self._day(16), lambda r: r["startedAt"]))
        self.assertTrue(breached)
        self.assertEqual(bad, {"2026-09-23": 16})


class ClassifyRunTest(unittest.TestCase):
    def _productive_day(self, n=16, day="2026-09-23"):
        # 16 succeeded runs that ALSO comment — but each touched issue
        # co-occurs with a state change, so all are productive (active).
        runs, touched, comments, acts = [], {}, {}, []
        for k in range(n):
            rid, iid = "r%d" % k, "i%d" % k
            runs.append(run_row(rid, "%sT%02d:00:00Z" % (day, k % 24)))
            touched[rid] = [iid]
            comments[iid] = [{"createdByRunId": rid,
                              "createdAt": "%sT%02d:01:00Z" % (day, k % 24)}]
            acts.append(touch_activity(iid))
        return runs, touched, comments, acts

    def test_sixteen_productive_commenting_runs_are_not_comment_only(self):
        # POSITIVE CONTROL: 16 productive runs which also comment must not
        # classify as comment-only and must not trip the kill rule.
        runs, touched, comments, acts = self._productive_day()
        activity = [sweep_row("2026-09-23T00:00:00Z",
                              {"wakeFailureDetails": []})] + acts
        rep = ACC.build_report(WS, WE, activity, runs, [], comments, touched,
                               activity_coverage_complete=True)
        m = rep["metrics"]["comment_only_runs_per_day"]
        self.assertEqual(m["confirmed"], 0)
        self.assertEqual(m["status"], "ok")
        self.assertFalse(m["kill_breach_over_15"])
        self.assertFalse(rep["kill_rule"]["breached"])
        actives = [v for v in m["classes"].values()
                   if v["class"] == "active"]
        self.assertEqual(len(actives), 16)

    def test_sixteen_candidates_never_trigger_kill_rule(self):
        # POSITIVE CONTROL: 16 succeeded+commenting runs with INCOMPLETE
        # coverage are candidates: kill rule stays quiet AND the report
        # stays missing (candidates prove no non-breach either).
        runs, touched, comments, _ = self._productive_day()
        rep = ACC.build_report(WS, WE, [], runs, [], comments, touched,
                               activity_coverage_complete=False)
        m = rep["metrics"]["comment_only_runs_per_day"]
        self.assertEqual(m["candidates"], 16)
        self.assertEqual(m["confirmed"], 0)
        self.assertEqual(m["status"], "missing")
        self.assertFalse(m["kill_breach_over_15"])
        self.assertFalse(rep["kill_rule"]["breached"])

    def test_sixteen_confirmed_trigger_kill_rule(self):
        # Complete coverage, no state changes: 16 confirmed trip the rule.
        runs, touched, comments, _ = self._productive_day()
        rep = ACC.build_report(WS, WE, [], runs, [], comments, touched,
                               activity_coverage_complete=True)
        m = rep["metrics"]["comment_only_runs_per_day"]
        self.assertEqual(m["confirmed"], 16)
        self.assertEqual(m["status"], "ok")
        self.assertTrue(m["kill_breach_over_15"])
        self.assertTrue(rep["kill_rule"]["breached"])

    def test_partial_join_yields_unknowns_not_confirmed(self):
        # POSITIVE CONTROL: runs whose touched issues were never fetched
        # (partial join) are unknown — never confirmed, never zero.
        runs = [run_row("r1", "2026-09-23T00:05:00Z"),
                run_row("r2", "2026-09-23T00:06:00Z")]
        touched = {"r1": ["i1"]}  # r2 join missing entirely
        comments = {"i1": [{"createdByRunId": "r1"}]}
        rep = ACC.build_report(WS, WE, [], runs, [], comments, touched,
                               activity_coverage_complete=True)
        m = rep["metrics"]["comment_only_runs_per_day"]
        self.assertEqual(m["unclassified_unknown"], 1)
        self.assertEqual(m["confirmed"], 1)
        self.assertEqual(m["status"], "missing")


class ReportTest(unittest.TestCase):
    def test_comment_only_with_join_measures(self):
        # Join wired with complete coverage and no state change: a
        # succeeded sweep run with a run-attributed comment classifies as
        # CONFIRMED and counts per day.
        runs = [run_row("r1", "2026-09-23T00:05:00Z")]
        touched = {"r1": ["i1"]}
        comments = {"i1": [{"createdByRunId": "r1",
                            "createdAt": "2026-09-23T00:06:00Z"}]}
        rep = ACC.build_report(WS, WE, [], runs, [], comments, touched,
                               activity_coverage_complete=True)
        m = rep["metrics"]["comment_only_runs_per_day"]
        self.assertEqual(m["status"], "ok")
        self.assertEqual(m["days"], {"2026-09-23": 1})
        self.assertEqual(m["confirmed"], 1)
        self.assertFalse(rep["kill_rule"]["breached"])

    def test_unjoined_runs_are_missing_not_zero_days(self):
        # POSITIVE CONTROL: sweep-woken runs with no fetched join must not
        # report ok with empty days.
        runs = [run_row("r1", "2026-09-23T00:05:00Z")]
        rep = ACC.build_report(WS, WE, [], runs, [])
        m = rep["metrics"]["comment_only_runs_per_day"]
        self.assertEqual(m["status"], "missing")
        self.assertEqual(m["unclassified_unknown"], 1)

    def test_empty_inputs_are_missing_not_zero(self):
        # POSITIVE CONTROL: an empty feed must never claim measured zeros.
        rep = ACC.build_report(WS, WE, [], [], [])
        m = rep["metrics"]
        self.assertEqual(m["wake_error_coverage"]["status"], "missing")
        self.assertEqual((m["wake_error_coverage"]["numerator"],
                          m["wake_error_coverage"]["denominator"]), (0, 0))
        self.assertEqual(m["dispatch_sweep_p50"]["status"], "missing")
        self.assertEqual(m["rpc_timeouts"]["status"], "missing")
        self.assertEqual(m["balance_pass"]["status"], "missing")
        self.assertEqual(m["comment_only_runs_per_day"]["status"], "missing")
        self.assertEqual(m["exhausted_lane"]["status"], "missing")
        self.assertEqual(m["idle_assignee_wake_latency"]["status"], "missing")
        self.assertFalse(rep["kill_rule"]["breached"])

    def test_exhausted_cards_alone_are_not_a_breach(self):
        # POSITIVE CONTROL: a tier-exhausted card without independent wake
        # evidence is a proxy — never a breach. Empty search is not a
        # verified zero either (status missing, not ok).
        rep = ACC.build_report(
            WS, WE, [], [], [{"createdAt": "2026-09-24T00:00:00Z"}])
        ex = rep["metrics"]["exhausted_lane"]
        self.assertFalse(ex["breach"])
        self.assertEqual(ex["status"], "missing")
        self.assertIsNone(ex["actual_wake_count"])
        self.assertIsNotNone(ex["unknown"])
        rep0 = ACC.build_report(WS, WE, [], [], [])
        self.assertEqual(rep0["metrics"]["exhausted_lane"]["status"],
                         "missing")
        # lane-down refused skips are gate evidence, not a breach by itself
        rep2 = ACC.build_report(
            WS, WE,
            [sweep_row("2026-09-24T00:00:00Z",
                       {"laneDownSkippedIssueIds": ["x"],
                        "idleAssigneePickedIssueIds": ["y"],
                        "wakeFailureDetails": []})],
            [], [])
        ex2 = rep2["metrics"]["exhausted_lane"]
        self.assertEqual(ex2["lane_down_skips_refused"], 1)
        self.assertFalse(ex2["breach"])
        self.assertEqual(
            rep2["metrics"]["wake_request_to_run_start_proxy"]
            ["idle_assignee_picks_in_sweeps"], 1)

    def test_exhausted_wake_evidence_decides(self):
        # Independently evidenced wake counts DO decide: verified zero is
        # ok/non-breach, nonzero is a breach.
        rep0 = ACC.build_report(WS, WE, [], [], [], exhausted_wake_evidence=0)
        self.assertEqual(rep0["metrics"]["exhausted_lane"]["status"], "ok")
        self.assertFalse(rep0["metrics"]["exhausted_lane"]["breach"])
        rep2 = ACC.build_report(
            WS, WE, [], [], [{"createdAt": "2026-09-24T00:00:00Z"}],
            exhausted_wake_evidence=2)
        ex2 = rep2["metrics"]["exhausted_lane"]
        self.assertEqual(ex2["status"], "ok")
        self.assertTrue(ex2["breach"])
        self.assertEqual(ex2["actual_wake_count"], 2)

    def test_out_of_window_rows_ignored(self):
        rows = [sweep_row("2026-09-20T00:00:00Z",  # pre-deploy
                          {"wakeFailureDetails":
                           [{"issueId": "a", "code": "timeout",
                             "message": "t"}]})]
        rep = ACC.build_report(WS, WE, rows, [], [])
        self.assertEqual(rep["metrics"]["wake_error_coverage"]["status"],
                         "missing")
        self.assertEqual(rep["metrics"]["rpc_timeouts"]
                         ["proxy_wake_timeout_codes"], 0)


class FetchValidationTest(unittest.TestCase):
    def test_malformed_envelope_raises_not_empty(self):
        # POSITIVE CONTROL: malformed primary-source data must fail loudly,
        # never coerce to [] (which would read as measured zero).
        with self.assertRaises(ValueError):
            ACC.require_row_list("activity", {"unexpected": "shape"})
        with self.assertRaises(ValueError):
            ACC.require_row_list("heartbeat-runs", "not-a-list")
        with self.assertRaises(ValueError):
            ACC.require_row_list("issues", [{"ok": 1}, "bad-row"])

    def test_wrapped_envelope_unwraps(self):
        rows = [{"id": 1}]
        for key in ("data", "items", "results"):
            self.assertEqual(
                ACC.require_row_list("activity", {key: rows}), rows)

    def test_fetch_join_records_partial_failures(self):
        # Partial joins surface as missing with coverage (sanitized, no
        # secrets), never as empty evidence.
        calls = []

        def fake_get(base, key, path):
            calls.append(path)
            if path == "/heartbeat-runs/r-good/issues":
                return [{"issueId": "i1"}]
            if path == "/heartbeat-runs/r-bad/issues":
                raise IOError("boom SECRET-KEY-abc123 " + base + key)
            if path == "/issues/i1/comments":
                return [{"createdByRunId": "other"}]
            raise AssertionError("unexpected " + path)

        old = ACC._get
        ACC._get = fake_get
        try:
            touched, comments, jr = ACC.fetch_join(
                "http://bridge", "K", ["r-good", "r-bad"])
        finally:
            ACC._get = old
        self.assertEqual(touched, {"r-good": ["i1"]})
        self.assertEqual(len(jr["failures"]), 1)
        blob = str(jr)
        self.assertNotIn("SECRET-KEY-abc123", blob)
        self.assertNotIn("http://bridge", blob)
        self.assertEqual(jr["runs_ok"], 1)
        self.assertEqual(jr["runs_attempted"], 2)

    def test_normalize_api_base(self):
        self.assertEqual(ACC.normalize_api_base("http://h:3000/api"),
                         "http://h:3000/api")
        self.assertEqual(ACC.normalize_api_base("http://h:3000/api/"),
                         "http://h:3000/api")
        self.assertEqual(ACC.normalize_api_base("http://h:3000"),
                         "http://h:3000/api")
        self.assertEqual(ACC.normalize_api_base(""), "")

    def test_window_end_never_drifts(self):
        # Default observation end must not drift beyond 2026-09-29T03:25:00Z.
        self.assertEqual(ACC.cap_window_end("2026-10-05T00:00:00Z"), WE)
        self.assertEqual(
            ACC.cap_window_end(now_iso="2026-10-05T00:00:00Z"), WE)
        self.assertEqual(
            ACC.cap_window_end(now_iso="2026-09-23T00:00:00Z"),
            "2026-09-23T00:00:00Z")
        self.assertEqual(ACC.cap_window_end("2026-09-23T00:00:00Z"),
                         "2026-09-23T00:00:00Z")


class CoverageShapeTest(unittest.TestCase):
    def test_every_metric_carries_span_and_limits(self):
        # Every metric carries numerator/denominator (or explicit unknown),
        # an observed span, and incomplete-window/retention limits.
        rep = ACC.build_report(WS, WE, [], [], [])
        for name, m in rep["metrics"].items():
            with self.subTest(metric=name):
                has_ratio = ("numerator" in m and "denominator" in m)
                self.assertTrue(has_ratio or "unknown" in m,
                                "metric %s has neither ratio nor unknown"
                                % name)
                self.assertIn("observed_span", m)
                self.assertTrue("coverage_limits" in m or "reason" in m,
                                "metric %s has no limits/reason" % name)

    def test_no_overall_seven_day_pass_from_snapshots(self):
        # POSITIVE CONTROL: even perfect-looking inputs never yield an
        # overall seven-day pass from capped snapshots.
        runs = [run_row("r1", "2026-09-23T00:05:00Z")]
        rep = ACC.build_report(
            WS, WE,
            [sweep_row("2026-09-23T00:00:00Z",
                       {"wakeFailureDetails":
                        [{"issueId": "a", "code": "c", "message": "m"}]})],
            runs, [], {"i1": [{"createdByRunId": "r1"}]}, {"r1": ["i1"]},
            activity_coverage_complete=True,
            exhausted_wake_evidence=0)
        self.assertFalse(rep["overall"]["seven_day_pass"])
        self.assertIn("capped", rep["overall"]["note"].lower())

    def test_join_wired_note_has_no_stale_unwired_text(self):
        rep = ACC.build_report(WS, WE, [], [run_row(
            "r1", "2026-09-23T00:05:00Z")], [])
        blob = str(rep)
        self.assertNotIn("unwired to fetch_all", blob)
        self.assertIn("fetch_all calls fetch_join", blob)


if __name__ == "__main__":
    unittest.main()
