#!/usr/bin/env python3
"""Offline tests for watchdog/detectors.py (phase 1).

No credentials, no network, no board writes. Every case runs on fixtures.
"""

import contextlib
import datetime
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from watchdog.detectors import (
    ASSIGNMENT_VIOLATION_REVIEW_AUTHOR,
    ASSIGNMENT_VIOLATION_UNASSIGNED,
    CEO_DESK_ENV,
    REQUIRED_HOSTS_ENV,
    WRITER_COMPATIBLE_MUTATIONS,
    ConfigError,
    assignment_dedupe_key,
    detect,
)

NOW = datetime.datetime(2026, 10, 3, 14, 0, 0,
                        tzinfo=datetime.timezone.utc)

# Deployment settings the detectors read from the environment. The values
# are synthetic: the desk card identifier and the required host are
# configuration, not constants of the detectors.
DESK_ISSUE = "ISSUE-100"
REQUIRED_HOST = "192.0.2.10"
CONFIG_ENV = {CEO_DESK_ENV: DESK_ISSUE, REQUIRED_HOSTS_ENV: REQUIRED_HOST}


def setUpModule():
    patcher = mock.patch.dict(os.environ, CONFIG_ENV)
    patcher.start()
    unittest.addModuleCleanup(patcher.stop)


def snap(**overrides):
    base = {"now": "2026-10-03T14:00:00Z", "agents": [], "hosts": [],
            "ciJobs": [], "queueAge": [], "issues": [], "runEvents": [],
            "parks": [], "redMains": [], "secretHits": [],
            "pendingInteractions": [],
            "supply": {"readyNow": 12, "target": 12, "belowMin": 0.0,
                       "idleAgents": 2,
                       "censusAt": "2026-10-03T14:00:00Z"}}
    base.update(overrides)
    return base


def reasons(records, detector):
    return [r["reason"] for r in records
            if r.get("detector") == f"watchdog/{detector}"]


class AgentErrorTest(unittest.TestCase):
    def test_benign_signature_is_info_not_reset(self):
        records = detect(snap(agents=[{
            "agentId": "a1", "status": "error",
            "errorSince": "2026-10-03T13:30:00Z",
            "subtype": "success", "terminalResultSeen": True,
            "owningLead": "cto"}]))
        hits = [r for r in records
                if r.get("detector") == "watchdog/agent_error"]
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["severity"], "info")
        self.assertIn("benign", hits[0]["reason"].lower())

    def test_non_benign_routes_to_lead(self):
        records = detect(snap(agents=[{
            "agentId": "a2", "status": "error",
            "errorSince": "2026-10-03T13:00:00Z",
            "subtype": "crash", "owningLead": "cto"}]))
        hits = [r for r in records
                if r.get("detector") == "watchdog/agent_error"]
        self.assertEqual(hits[0]["severity"], "high")
        self.assertEqual(hits[0]["owner"], "cto")

    def test_under_threshold_is_silent(self):
        records = detect(snap(agents=[{
            "agentId": "a3", "status": "error",
            "errorSince": "2026-10-03T13:55:00Z",
            "subtype": "crash"}]))
        self.assertEqual(reasons(records, "agent_error"), [])

    def test_missing_section_is_unknown(self):
        records = detect(snap())
        del records  # replaced below
        s = snap()
        del s["agents"]
        records = detect(s)
        self.assertIn("agents snapshot missing",
                      reasons(records, "agent_error"))


class HostHealthTest(unittest.TestCase):
    def test_disk_threshold_fires(self):
        records = detect(snap(hosts=[
            {"host": REQUIRED_HOST, "diskPct": 85, "load": 1.0,
             "vcpu": 4, "sustainedMin": 10}]))
        self.assertIn("disk at or above 85%",
                      reasons(records, "host_health"))

    def test_disk_just_below_is_silent(self):
        records = detect(snap(hosts=[
            {"host": REQUIRED_HOST, "diskPct": 84.9, "load": 1.0,
             "vcpu": 4, "sustainedMin": 10}]))
        self.assertNotIn("disk at or above 85%",
                         reasons(records, "host_health"))

    def test_missing_required_host_is_coverage_gap(self):
        records = detect(snap(hosts=[
            {"host": "garm-1", "diskPct": 10, "load": 1.0,
             "vcpu": 4, "sustainedMin": 10}]))
        self.assertIn("required host missing from snapshot",
                      reasons(records, "host_health"))
        gap = [r for r in records
               if r.get("reason") == "required host missing from snapshot"]
        self.assertEqual(gap[0]["evidence"], {"host": REQUIRED_HOST})

    def test_present_required_host_is_not_a_gap(self):
        records = detect(snap(hosts=[
            {"host": REQUIRED_HOST, "diskPct": 10, "load": 1.0,
             "vcpu": 4, "sustainedMin": 10}]))
        self.assertNotIn("required host missing from snapshot",
                         reasons(records, "host_health"))

    def test_required_hosts_come_from_the_environment(self):
        # No host is baked into the detectors; every configured host is required.
        snapshot = snap(hosts=[
            {"host": "garm-1", "diskPct": 10, "load": 1.0,
             "vcpu": 4, "sustainedMin": 10}])
        for value in (None, "", "   ", ", ,"):
            with self.subTest(value=value):
                env = {k: v for k, v in os.environ.items()
                       if k != REQUIRED_HOSTS_ENV}
                if value is not None:
                    env[REQUIRED_HOSTS_ENV] = value
                with mock.patch.dict(os.environ, env, clear=True):
                    with self.assertRaisesRegex(ConfigError, REQUIRED_HOSTS_ENV):
                        detect(snapshot)
        with mock.patch.dict(
                os.environ,
                {REQUIRED_HOSTS_ENV: "garm-1, 192.0.2.20,198.51.100.7"}):
            missing = [r["evidence"]["host"] for r in detect(snapshot)
                       if r.get("reason")
                       == "required host missing from snapshot"]
        self.assertEqual(missing, ["192.0.2.20", "198.51.100.7"])

    def test_load_threshold(self):
        records = detect(snap(hosts=[
            {"host": REQUIRED_HOST, "diskPct": 10, "load": 6.1,
             "vcpu": 4, "sustainedMin": 5}]))
        self.assertIn("load above 1.5x vCPU sustained",
                      reasons(records, "host_health"))


class CiHealthTest(unittest.TestCase):
    def test_runtime_above_2x_fires(self):
        records = detect(snap(ciJobs=[{
            "repo": "r", "job": "j", "runtimeMin": 41, "baselineMin": 20}]))
        self.assertIn("CI job runtime above 2x baseline",
                      reasons(records, "ci_health"))

    def test_runtime_at_2x_is_silent(self):
        records = detect(snap(ciJobs=[{
            "repo": "r", "job": "j", "runtimeMin": 40, "baselineMin": 20}]))
        self.assertNotIn("CI job runtime above 2x baseline",
                         reasons(records, "ci_health"))

    def test_zero_baseline_is_unknown(self):
        records = detect(snap(ciJobs=[{
            "repo": "r", "job": "j", "runtimeMin": 5, "baselineMin": 0}]))
        self.assertIn("CI job with non-positive baseline",
                      reasons(records, "ci_health"))

    def test_queue_high(self):
        records = detect(snap(queueAge=[{"label": "self-hosted",
                                         "ageMin": 160}]))
        hits = [r for r in records
                if r.get("reason") == "runner queue age elevated"]
        self.assertEqual(hits[0]["severity"], "high")


class AssignmentTest(unittest.TestCase):
    def test_unassigned_in_focus_fires_with_proposal(self):
        records = detect(snap(issues=[{
            "id": "iid-1", "identifier": "ISSUE-1", "status": "backlog",
            "assigneeAgentId": None, "inFocus": True, "inBacklogMin": 90,
            "isReview": False, "prAuthorAgentId": None}]))
        self.assertIn("in-focus card unassigned or in backlog over 1h",
                      reasons(records, "assignment"))
        proposals = [r for r in records if r.get("type") == "proposal"]
        self.assertTrue(all(p["mutation"] == "none" for p in proposals))

    def test_review_by_author_fires(self):
        records = detect(snap(issues=[{
            "id": "iid-2", "identifier": "ISSUE-2", "status": "in_review",
            "assigneeAgentId": "agent-x", "inFocus": True, "inBacklogMin": 0,
            "isReview": True, "prAuthorAgentId": "agent-x"}]))
        self.assertIn("review card assigned to the PR author",
                      reasons(records, "assignment"))

    def test_out_of_focus_is_silent(self):
        records = detect(snap(issues=[{
            "id": "iid-3", "identifier": "ISSUE-3", "status": "backlog",
            "assigneeAgentId": None, "inFocus": False, "inBacklogMin": 999,
            "isReview": False, "prAuthorAgentId": None}]))
        self.assertEqual(reasons(records, "assignment"), [])

    def test_assigned_in_time_is_silent_green(self):
        # Positive green control: correctly assigned, fresh backlog,
        # independent reviewer stays silent.
        records = detect(snap(issues=[{
            "id": "iid-4", "identifier": "ISSUE-4", "status": "todo",
            "assigneeAgentId": "agent-a", "inFocus": True,
            "inBacklogMin": 10, "isReview": True,
            "prAuthorAgentId": "agent-b"}]))
        self.assertEqual(reasons(records, "assignment"), [])

    def test_review_by_independent_reviewer_is_silent(self):
        records = detect(snap(issues=[{
            "id": "iid-5", "identifier": "ISSUE-5", "status": "in_review",
            "assigneeAgentId": "agent-a", "inFocus": True, "inBacklogMin": 0,
            "isReview": True, "prAuthorAgentId": "agent-b"}]))
        self.assertEqual(reasons(records, "assignment"), [])

    def test_backlog_at_threshold_is_silent_over_fires(self):
        at = snap(issues=[{
            "id": "iid-6", "identifier": "ISSUE-6", "status": "todo",
            "assigneeAgentId": "agent-a", "inFocus": True,
            "inBacklogMin": 60, "isReview": False,
            "prAuthorAgentId": None}])
        self.assertEqual(reasons(detect(at), "assignment"), [])
        over = snap(issues=[{
            "id": "iid-6", "identifier": "ISSUE-6", "status": "backlog",
            "assigneeAgentId": "agent-a", "inFocus": True,
            "inBacklogMin": 61, "isReview": False,
            "prAuthorAgentId": None}])
        self.assertIn("in-focus card unassigned or in backlog over 1h",
                      reasons(detect(over), "assignment"))

    def test_dedupe_keys_stable_per_card_violation(self):
        # Positive control: repeat polls emit the same key (no timestamps
        # in the key), finding and proposal share it, and the two
        # violations use distinct keys so one card can hold both without
        # duplicate incident cards.
        first = detect(snap(issues=[{
            "id": "iid-7", "identifier": "ISSUE-7", "status": "backlog",
            "assigneeAgentId": "agent-x", "inFocus": True,
            "inBacklogMin": 999, "isReview": True,
            "prAuthorAgentId": "agent-x"}]))
        second = detect(snap(issues=[{
            "id": "iid-7", "identifier": "ISSUE-7", "status": "backlog",
            "assigneeAgentId": "agent-x", "inFocus": True,
            "inBacklogMin": 1000, "isReview": True,
            "prAuthorAgentId": "agent-x"}]))
        keys_first = sorted(
            r["dedupeKey"] for r in first
            if r.get("detector") == "watchdog/assignment"
            and "dedupeKey" in r)
        keys_second = sorted(
            r["dedupeKey"] for r in second
            if r.get("detector") == "watchdog/assignment"
            and "dedupeKey" in r)
        self.assertEqual(keys_first, keys_second)
        self.assertEqual(
            keys_first,
            [f"watchdog/assignment:{ASSIGNMENT_VIOLATION_REVIEW_AUTHOR}:iid-7"] * 2
            + [f"watchdog/assignment:{ASSIGNMENT_VIOLATION_UNASSIGNED}:iid-7"] * 2)
        findings = [r for r in first
                    if r.get("detector") == "watchdog/assignment"
                    and r.get("type") == "finding"]
        proposals = [r for r in first
                     if r.get("detector") == "watchdog/assignment"
                     and r.get("type") == "proposal"]
        self.assertEqual(
            sorted(r["dedupeKey"] for r in findings),
            sorted(r["dedupeKey"] for r in proposals))

    def test_dedupe_helper_format(self):
        self.assertEqual(
            assignment_dedupe_key(ASSIGNMENT_VIOLATION_UNASSIGNED, "iid-9"),
            "watchdog/assignment:unassigned-backlog:iid-9")


class ChurnTest(unittest.TestCase):
    def test_rewoke_burst_fires(self):
        events = [{"issueId": "iid-9", "identifier": "ISSUE-9",
                   "kind": "dispatch_stalled_issue",
                   "at": f"2026-10-03T13:0{i}:00Z"} for i in range(4)]
        records = detect(snap(runEvents=events))
        self.assertIn("card re-woken more than 3 times in 6h",
                      reasons(records, "churn"))

    def test_three_rewokes_silent(self):
        events = [{"issueId": "iid-9", "identifier": "ISSUE-9",
                   "kind": "dispatch_stalled_issue",
                   "at": f"2026-10-03T13:0{i}:00Z"} for i in range(3)]
        records = detect(snap(runEvents=events))
        self.assertNotIn("card re-woken more than 3 times in 6h",
                         reasons(records, "churn"))

    def test_park_count_fires(self):
        records = detect(snap(parks=[{
            "issueId": "iid-8", "identifier": "ISSUE-8",
            "missingDispositionCount": 3}]))
        self.assertIn("card parked for missing disposition more than twice",
                      reasons(records, "churn"))


class RedMainTest(unittest.TestCase):
    def test_new_red_fires_high(self):
        records = detect(snap(redMains=[{
            "repo": "example-repo", "signature": "s1",
            "incidentExists": False}]))
        hits = [r for r in records
                if r.get("detector") == "watchdog/red_main"]
        self.assertEqual(hits[0]["severity"], "high")

    def test_existing_incident_is_info_repeat(self):
        records = detect(snap(redMains=[{
            "repo": "example-repo", "signature": "s1",
            "incidentExists": True}]))
        hits = [r for r in records
                if r.get("detector") == "watchdog/red_main"]
        self.assertEqual(hits[0]["severity"], "info")
        self.assertEqual(
            len([r for r in records if r.get("type") == "proposal"]), 0)


class SecretHitTest(unittest.TestCase):
    REFUSAL = "finding evidence carries a possible secret value"

    def metadata_snapshot(self, field, value):
        snapshot = snap(
            secretHits=[{"source": "fixture:secret-hit", "patternName": "ghp_*",
                         "valueLen": 40, "at": "2026-10-03T13:00:00Z"}],
            issues=[{"id": "fixture-assignment", "identifier": "fixture-card",
                     "inFocus": True, "assigneeAgentId": None,
                     "inBacklogMin": 90}])
        if field == "assignment.identifier":
            snapshot["issues"][0]["identifier"] = value
        else:
            snapshot["secretHits"][0][field] = value
        return snapshot

    def metadata_cases(self, lengths):
        # Build unmistakably fake values at runtime, never token-shaped literals.
        prefixes = (("classic", "ghp_", "FAKE000"),
                    ("fine-grained", "github_pat_", "FAKE000"),
                    ("fine-grained-underscore", "github_pat_", "FAKE_00"))
        for name, prefix, stem in prefixes:
            for length in lengths:
                value = prefix + stem + "0" * (length - len(stem))
                for field in ("source", "patternName", "assignment.identifier"):
                    yield name, length, field, value

    def assert_ciso_and_none_proposal(self, records):
        hits = [r for r in records
                if r.get("detector") == "watchdog/secret_hit"]
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["severity"], "critical")
        self.assertEqual(hits[0]["owner"], "ciso")
        self.assertEqual(hits[0]["route"], "ciso")
        proposals = [r for r in records if r.get("type") == "proposal"]
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0]["mutation"], "none")

    def assert_metadata_preserved(self, records, field, value):
        self.assert_ciso_and_none_proposal(records)
        detector = ("watchdog/assignment" if field == "assignment.identifier"
                    else "watchdog/secret_hit")
        key = "identifier" if field == "assignment.identifier" else field
        hits = [r for r in records if r.get("type") == "finding"
                and r.get("detector") == detector]
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["evidence"][key], value)

    def run_cli(self, snapshot):
        scratch = (os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR")
                   or os.environ.get("PAPERCLIP_SCRATCH_DIR"))
        with tempfile.TemporaryDirectory(prefix="watchdog-secret-fixture-",
                                         dir=scratch) as directory:
            path = Path(directory) / "snapshot.json"
            path.write_text(json.dumps(snapshot), encoding="utf-8")
            return subprocess.run(
                [sys.executable,
                 str(Path(__file__).resolve().parent / "watchdog/detectors.py"),
                 "--snapshot", str(path)],
                capture_output=True, text=True, timeout=10,
                # No inherited credentials or API configuration in the child.
                env={"PYTHONIOENCODING": "utf-8",
                     "PYTHONDONTWRITEBYTECODE": "1",
                     **CONFIG_ENV})

    def cli_records(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        records = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(records[-1]["type"], "summary")
        self.assertEqual(records[-1]["records"], len(records) - 1)
        return records[:-1]

    def test_hit_is_critical_and_value_free(self):
        for pattern in ("ghp_*", "github_pat_*"):
            with self.subTest(pattern=pattern):
                records = detect(self.metadata_snapshot("patternName", pattern))
                self.assert_metadata_preserved(records, "patternName", pattern)
                hits = [r for r in records
                        if r.get("detector") == "watchdog/secret_hit"]
                blob = json.dumps(hits[0])
                without_pattern = blob.replace(
                    f'"patternName": "{pattern}"', "")
                self.assertNotIn("ghp_", without_pattern)
                self.assertNotIn("github_pat_", without_pattern)

    def test_value_shaped_metadata_is_refused_without_echo(self):
        for prefix, length, field, value in self.metadata_cases((8, 9)):
            with self.subTest(prefix=prefix, length=length, field=field):
                stdout, stderr = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(stdout), \
                        contextlib.redirect_stderr(stderr):
                    with self.assertRaises(ValueError) as caught:
                        detect(self.metadata_snapshot(field, value))
                self.assertEqual(str(caught.exception), self.REFUSAL)
                self.assertNotIn(value, str(caught.exception))
                self.assertNotIn(value, stdout.getvalue())
                self.assertNotIn(value, stderr.getvalue())
                self.assertEqual(stdout.getvalue(), "")
                self.assertEqual(stderr.getvalue(), "")

    def test_value_shaped_metadata_cli_is_refused_without_echo(self):
        for prefix, length, field, value in self.metadata_cases((8, 9)):
            with self.subTest(prefix=prefix, length=length, field=field):
                result = self.run_cli(self.metadata_snapshot(field, value))
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, "")
                self.assertTrue(result.stderr.endswith(
                    f"ValueError: {self.REFUSAL}\n"))
                self.assertNotIn(value, result.stdout)
                self.assertNotIn(value, result.stderr)

    def test_below_length_boundary_metadata_is_preserved(self):
        for prefix, length, field, value in self.metadata_cases((7,)):
            with self.subTest(prefix=prefix, length=length, field=field):
                records = detect(self.metadata_snapshot(field, value))
                self.assert_metadata_preserved(records, field, value)

    def test_below_length_boundary_metadata_cli_is_preserved(self):
        for prefix, length, field, value in self.metadata_cases((7,)):
            with self.subTest(prefix=prefix, length=length, field=field):
                result = self.run_cli(self.metadata_snapshot(field, value))
                records = self.cli_records(result)
                self.assert_metadata_preserved(records, field, value)

    def test_wildcard_patterns_cli_keep_ciso_route_and_none_proposals(self):
        for pattern in ("ghp_*", "github_pat_*"):
            with self.subTest(pattern=pattern):
                result = self.run_cli(
                    self.metadata_snapshot("patternName", pattern))
                records = self.cli_records(result)
                self.assert_metadata_preserved(records, "patternName", pattern)


class PendingInteractionsTest(unittest.TestCase):
    def stale(self, **overrides):
        item = {"issueId": "iid-7", "identifier": "ISSUE-7",
                "interactionId": "int-1", "kind": "request_confirmation",
                "createdAt": "2026-10-03T13:00:00Z"}
        item.update(overrides)
        return item

    def test_stale_with_resolver_wakes_resolver(self):
        records = detect(snap(pendingInteractions=[
            self.stale(resolverAgentId="agent-r")]))
        hits = [r for r in records
                if r.get("reason") == "pending interaction older than "
                "30m with addressed resolver"]
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["severity"], "info")
        self.assertEqual(hits[0]["owner"], "agent-r")
        self.assertEqual(hits[0]["route"], "agent-r")

    def test_stale_without_resolver_routes_to_ceo_desk(self):
        records = detect(snap(pendingInteractions=[self.stale()]))
        hits = [r for r in records
                if r.get("reason") == "pending interaction older than "
                "30m with no clear resolver"]
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["owner"], "ceo")
        self.assertEqual(hits[0]["route"], "ceo-desk")
        self.assertIn(DESK_ISSUE, hits[0]["suggestedAction"])

    def test_under_threshold_fires_metric_only(self):
        records = detect(snap(pendingInteractions=[
            self.stale(createdAt="2026-10-03T13:45:00Z",
                       resolverAgentId="agent-r")]))
        self.assertEqual(reasons(records, "pending_interactions"),
                         ["pending-interaction backlog metric"])
        per_item = [r for r in records
                    if r.get("reason", "").startswith("pending interaction")]
        self.assertEqual(per_item, [])

    def test_over_2h_is_high_and_metric_alerts(self):
        records = detect(snap(pendingInteractions=[
            self.stale(createdAt="2026-10-03T11:00:00Z",
                       resolverAgentId="agent-r"),
            self.stale(interactionId="int-2",
                       createdAt="2026-10-03T13:00:00Z")]))
        per_item = [r for r in records
                    if r.get("type") == "finding"
                    and r.get("reason", "").startswith("pending interaction")]
        by_int = {r["evidence"]["interactionId"]: r for r in per_item}
        self.assertEqual(by_int["int-1"]["severity"], "high")
        self.assertEqual(by_int["int-2"]["severity"], "info")
        metric = [r for r in records
                  if r.get("reason") == "pending-interaction backlog metric"]
        self.assertEqual(len(metric), 1)
        self.assertEqual(metric[0]["severity"], "high")
        self.assertEqual(metric[0]["evidence"]["count"], 2)
        self.assertEqual(metric[0]["evidence"]["over2h"], 1)

    def test_metric_carries_count_and_median(self):
        records = detect(snap(pendingInteractions=[
            self.stale(createdAt="2026-10-03T13:00:00Z",
                       resolverAgentId="agent-r"),
            self.stale(interactionId="int-2",
                       createdAt="2026-10-03T13:30:00Z",
                       resolverAgentId="agent-r")]))
        metric = [r for r in records
                  if r.get("reason") == "pending-interaction backlog metric"]
        self.assertEqual(len(metric), 1)
        self.assertEqual(metric[0]["severity"], "info")
        self.assertEqual(metric[0]["evidence"]["count"], 2)
        self.assertEqual(metric[0]["evidence"]["medianAgeMin"], 45.0)
        self.assertEqual(metric[0]["evidence"]["over2h"], 0)

    def test_stale_emits_none_mutation_proposal(self):
        records = detect(snap(pendingInteractions=[
            self.stale(resolverAgentId="agent-r")]))
        proposals = [r for r in records
                     if r.get("detector") == "watchdog/pending_interactions"
                     and r.get("type") == "proposal"]
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0]["mutation"], "none")

    def test_missing_section_is_unknown(self):
        s = snap()
        del s["pendingInteractions"]
        records = detect(s)
        self.assertIn("pending-interactions snapshot missing",
                      reasons(records, "pending_interactions"))


class SupplyFamineTest(unittest.TestCase):
    def famine(self, **overrides):
        supply = {"readyNow": 0, "target": 12, "belowMin": 35.0,
                  "idleAgents": 2, "censusAt": "2026-10-03T14:00:00Z"}
        supply.update(overrides)
        return supply

    def test_below_target_sustained_fires_high_with_proposal(self):
        records = detect(snap(supply=self.famine()))
        hits = [r for r in records
                if r.get("detector") == "watchdog/supply_famine"
                and r.get("type") == "finding"]
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["severity"], "high")
        self.assertEqual(hits[0]["owner"], "ceo")
        self.assertEqual(hits[0]["route"], "ceo-hourly-routine")
        self.assertIn(DESK_ISSUE, hits[0]["suggestedAction"])
        proposals = [r for r in records
                     if r.get("detector") == "watchdog/supply_famine"
                     and r.get("type") == "proposal"]
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0]["mutation"], "none")
        self.assertEqual(proposals[0]["identifier"], DESK_ISSUE)

    def test_below_target_under_30m_is_info_to_coo(self):
        records = detect(snap(supply=self.famine(belowMin=10.0)))
        hits = [r for r in records
                if r.get("detector") == "watchdog/supply_famine"]
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["severity"], "info")
        self.assertEqual(hits[0]["owner"], "coo")

    def test_at_target_is_silent(self):
        records = detect(snap(supply=self.famine(readyNow=12)))
        self.assertEqual(reasons(records, "supply_famine"), [])

    def test_missing_section_is_unknown(self):
        s = snap()
        del s["supply"]
        records = detect(s)
        self.assertIn("supply snapshot missing",
                      reasons(records, "supply_famine"))


class AutoscalerSlicesTest(unittest.TestCase):
    def idle_slice(self, **overrides):
        item = {"sliceId": "slice-1", "identifier": "ISSUE-20",
                "status": "backlog", "assigneeAgentId": None,
                "unassignedSince": "2026-10-03T11:00:00Z"}
        item.update(overrides)
        return item

    def test_unassigned_over_2h_fires_high_with_proposal(self):
        records = detect(snap(autoscalerSlices=[self.idle_slice()]))
        hits = [r for r in records
                if r.get("detector") == "watchdog/autoscaler_slices"
                and r.get("type") == "finding"]
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["severity"], "high")
        self.assertEqual(hits[0]["owner"], "coo")
        self.assertEqual(hits[0]["route"], "ceo-hourly-routine")
        self.assertIn("over 2h", hits[0]["reason"])
        self.assertEqual(hits[0]["evidence"]["ageMin"], 180.0)
        proposals = [r for r in records
                     if r.get("detector") == "watchdog/autoscaler_slices"
                     and r.get("type") == "proposal"]
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0]["mutation"], "none")

    def test_assigned_slice_is_silent(self):
        records = detect(snap(autoscalerSlices=[
            self.idle_slice(assigneeAgentId="agent-a")]))
        self.assertEqual(reasons(records, "autoscaler_slices"), [])

    def test_fresh_slice_is_silent(self):
        records = detect(snap(autoscalerSlices=[
            self.idle_slice(unassignedSince="2026-10-03T13:30:00Z")]))
        self.assertEqual(reasons(records, "autoscaler_slices"), [])

    def test_at_threshold_is_silent(self):
        records = detect(snap(autoscalerSlices=[
            self.idle_slice(unassignedSince="2026-10-03T12:00:00Z")]))
        self.assertEqual(reasons(records, "autoscaler_slices"), [])

    def test_missing_section_is_unknown(self):
        s = snap()
        self.assertNotIn("autoscalerSlices", s)
        self.assertIn("autoscaler-slices snapshot missing",
                      reasons(detect(s), "autoscaler_slices"))

    def test_unreadable_since_is_unknown(self):
        records = detect(snap(autoscalerSlices=[
            self.idle_slice(unassignedSince="not-a-time")]))
        self.assertIn("autoscaler slice with unreadable unassignedSince",
                      reasons(records, "autoscaler_slices"))


class DeskConfigTest(unittest.TestCase):
    """The CEO desk card is configuration with no default: fail closed."""

    def cli(self, snapshot, env):
        with tempfile.TemporaryDirectory(prefix="watchdog-config-") as tmp:
            path = Path(tmp) / "snapshot.json"
            path.write_text(json.dumps(snapshot), encoding="utf-8")
            return subprocess.run(
                [sys.executable,
                 str(Path(__file__).resolve().parent / "watchdog/detectors.py"),
                 "--snapshot", str(path)],
                capture_output=True, text=True, timeout=10,
                env={"PYTHONIOENCODING": "utf-8",
                     "PYTHONDONTWRITEBYTECODE": "1", **env})

    def test_unset_desk_issue_refuses_to_detect(self):
        for value in (None, "", "   "):
            with self.subTest(value=value):
                env = {k: v for k, v in os.environ.items()
                       if k != CEO_DESK_ENV}
                if value is not None:
                    env[CEO_DESK_ENV] = value
                with mock.patch.dict(os.environ, env, clear=True):
                    with self.assertRaises(ConfigError) as caught:
                        detect(snap())
                self.assertIn(CEO_DESK_ENV, str(caught.exception))

    def test_cli_exits_2_with_a_clear_message_and_no_records(self):
        result = self.cli(snap(), {REQUIRED_HOSTS_ENV: REQUIRED_HOST})
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertIn(CEO_DESK_ENV, result.stderr)

    def test_cli_refuses_unconfigured_host_coverage_even_without_hosts(self):
        for value in (None, "", "   ", ", ,"):
            with self.subTest(value=value):
                env = {CEO_DESK_ENV: DESK_ISSUE}
                if value is not None:
                    env[REQUIRED_HOSTS_ENV] = value
                snapshot = snap()
                del snapshot["hosts"]
                result = self.cli(snapshot, env)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertEqual(result.stdout, "")
                self.assertIn(REQUIRED_HOSTS_ENV, result.stderr)

    def test_cli_runs_when_the_desk_issue_is_supplied(self):
        result = self.cli(snap(), CONFIG_ENV)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout.splitlines()[-1])["type"], "summary")


class WriterCompatTest(unittest.TestCase):
    def test_phase1_proposals_are_none_mutation(self):
        s = snap(
            issues=[{"id": "i1", "identifier": "ISSUE-1", "inFocus": True,
                     "assigneeAgentId": None, "inBacklogMin": 90}],
            runEvents=[{"issueId": "i1", "identifier": "ISSUE-1",
                        "kind": "dispatch_stalled_issue",
                        "at": "2026-10-03T13:00:00Z"}] * 4,
            hosts=[{"host": REQUIRED_HOST, "diskPct": 10,
                    "load": 1.0, "vcpu": 4, "sustainedMin": 1}])
        for record in detect(s):
            if record.get("type") == "proposal":
                self.assertEqual(record["mutation"], "none")
                self.assertIn(record["mutation"],
                              WRITER_COMPATIBLE_MUTATIONS)

    def test_compat_set_covers_writer_allowlist(self):
        self.assertEqual(WRITER_COMPATIBLE_MUTATIONS,
                         {"none", "create_pause_hold", "assign_blocker_owner",
                          "restore_blocked", "operator_decision",
                          "clear_pin"})


if __name__ == "__main__":
    unittest.main()
