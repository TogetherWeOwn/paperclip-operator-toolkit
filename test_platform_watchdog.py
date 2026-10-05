#!/usr/bin/env python3
"""Offline tests for watchdog/detectors.py (phase 1).

No credentials, no network, no board writes. Every case runs on fixtures.
"""

import datetime
import json
import unittest

from watchdog.detectors import (
    ASSIGNMENT_VIOLATION_REVIEW_AUTHOR,
    ASSIGNMENT_VIOLATION_UNASSIGNED,
    WRITER_COMPATIBLE_MUTATIONS,
    assignment_dedupe_key,
    detect,
)

NOW = datetime.datetime(2026, 10, 3, 14, 0, 0,
                        tzinfo=datetime.timezone.utc)


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
            {"host": "203.0.113.23", "diskPct": 85, "load": 1.0,
             "vcpu": 4, "sustainedMin": 10}]))
        self.assertIn("disk at or above 85%",
                      reasons(records, "host_health"))

    def test_disk_just_below_is_silent(self):
        records = detect(snap(hosts=[
            {"host": "203.0.113.23", "diskPct": 84.9, "load": 1.0,
             "vcpu": 4, "sustainedMin": 10}]))
        self.assertNotIn("disk at or above 85%",
                         reasons(records, "host_health"))

    def test_load_threshold(self):
        records = detect(snap(hosts=[
            {"host": "203.0.113.23", "diskPct": 10, "load": 6.1,
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
            "id": "iid-1", "identifier": "TASK-1", "status": "backlog",
            "assigneeAgentId": None, "inFocus": True, "inBacklogMin": 90,
            "isReview": False, "prAuthorAgentId": None}]))
        self.assertIn("in-focus card unassigned or in backlog over 1h",
                      reasons(records, "assignment"))
        proposals = [r for r in records if r.get("type") == "proposal"]
        self.assertTrue(all(p["mutation"] == "none" for p in proposals))

    def test_review_by_author_fires(self):
        records = detect(snap(issues=[{
            "id": "iid-2", "identifier": "TASK-2", "status": "in_review",
            "assigneeAgentId": "agent-x", "inFocus": True, "inBacklogMin": 0,
            "isReview": True, "prAuthorAgentId": "agent-x"}]))
        self.assertIn("review card assigned to the PR author",
                      reasons(records, "assignment"))

    def test_out_of_focus_is_silent(self):
        records = detect(snap(issues=[{
            "id": "iid-3", "identifier": "TASK-3", "status": "backlog",
            "assigneeAgentId": None, "inFocus": False, "inBacklogMin": 999,
            "isReview": False, "prAuthorAgentId": None}]))
        self.assertEqual(reasons(records, "assignment"), [])

    def test_assigned_in_time_is_silent_green(self):
        # Positive green control: correctly assigned, fresh backlog,
        # independent reviewer stays silent.
        records = detect(snap(issues=[{
            "id": "iid-4", "identifier": "TASK-4", "status": "todo",
            "assigneeAgentId": "agent-a", "inFocus": True,
            "inBacklogMin": 10, "isReview": True,
            "prAuthorAgentId": "agent-b"}]))
        self.assertEqual(reasons(records, "assignment"), [])

    def test_review_by_independent_reviewer_is_silent(self):
        records = detect(snap(issues=[{
            "id": "iid-5", "identifier": "TASK-5", "status": "in_review",
            "assigneeAgentId": "agent-a", "inFocus": True, "inBacklogMin": 0,
            "isReview": True, "prAuthorAgentId": "agent-b"}]))
        self.assertEqual(reasons(records, "assignment"), [])

    def test_backlog_at_threshold_is_silent_over_fires(self):
        at = snap(issues=[{
            "id": "iid-6", "identifier": "TASK-6", "status": "todo",
            "assigneeAgentId": "agent-a", "inFocus": True,
            "inBacklogMin": 60, "isReview": False,
            "prAuthorAgentId": None}])
        self.assertEqual(reasons(detect(at), "assignment"), [])
        over = snap(issues=[{
            "id": "iid-6", "identifier": "TASK-6", "status": "backlog",
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
            "id": "iid-7", "identifier": "TASK-7", "status": "backlog",
            "assigneeAgentId": "agent-x", "inFocus": True,
            "inBacklogMin": 999, "isReview": True,
            "prAuthorAgentId": "agent-x"}]))
        second = detect(snap(issues=[{
            "id": "iid-7", "identifier": "TASK-7", "status": "backlog",
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
        events = [{"issueId": "iid-9", "identifier": "TASK-9",
                   "kind": "dispatch_stalled_issue",
                   "at": f"2026-10-03T13:0{i}:00Z"} for i in range(4)]
        records = detect(snap(runEvents=events))
        self.assertIn("card re-woken more than 3 times in 6h",
                      reasons(records, "churn"))

    def test_three_rewokes_silent(self):
        events = [{"issueId": "iid-9", "identifier": "TASK-9",
                   "kind": "dispatch_stalled_issue",
                   "at": f"2026-10-03T13:0{i}:00Z"} for i in range(3)]
        records = detect(snap(runEvents=events))
        self.assertNotIn("card re-woken more than 3 times in 6h",
                         reasons(records, "churn"))

    def test_park_count_fires(self):
        records = detect(snap(parks=[{
            "issueId": "iid-8", "identifier": "TASK-8",
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
    def test_hit_is_critical_and_value_free(self):
        records = detect(snap(secretHits=[{
            "source": "run-log:abc", "patternName": "ghp_*",
            "valueLen": 40, "at": "2026-10-03T13:00:00Z"}]))
        hits = [r for r in records
                if r.get("detector") == "watchdog/secret_hit"]
        self.assertEqual(hits[0]["severity"], "critical")
        self.assertEqual(hits[0]["route"], "ciso")
        blob = json.dumps(hits[0])
        self.assertNotIn("ghp_", blob.replace('"patternName": "ghp_*"', ""))


class PendingInteractionsTest(unittest.TestCase):
    def stale(self, **overrides):
        item = {"issueId": "iid-7", "identifier": "TASK-7",
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
        self.assertIn("owning desk card", hits[0]["suggestedAction"])

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
        self.assertIn("owning desk card", hits[0]["suggestedAction"])
        proposals = [r for r in records
                     if r.get("detector") == "watchdog/supply_famine"
                     and r.get("type") == "proposal"]
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0]["mutation"], "none")

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
        item = {"sliceId": "slice-1", "identifier": "TASK-13264",
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


class WriterCompatTest(unittest.TestCase):
    def test_phase1_proposals_are_none_mutation(self):
        s = snap(
            issues=[{"id": "i1", "identifier": "TASK-1", "inFocus": True,
                     "assigneeAgentId": None, "inBacklogMin": 90}],
            runEvents=[{"issueId": "i1", "identifier": "TASK-1",
                        "kind": "dispatch_stalled_issue",
                        "at": "2026-10-03T13:00:00Z"}] * 4,
            hosts=[{"host": "203.0.113.23", "diskPct": 10,
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
