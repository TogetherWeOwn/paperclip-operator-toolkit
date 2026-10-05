#!/usr/bin/env python3
# ===========================================================================
# test_agent_error_proposer.py — offline hostile suite for the benign
# agent-error proposer.
#
# The writer re-verifies every conjunct against fresh reads, so a proposer
# bug can only cause refusals or missed resets, never a wrong reset. The
# suite pins exactly that: benign proposes exactly once per agent, non-benign
# routes to the owning lead, and the benign check agrees with the writer's
# gate on shared fixtures. Deterministic: no network, no credentials.
#
#   python3 -m unittest -v test_agent_error_proposer.py
# ===========================================================================

from __future__ import annotations

import datetime
import unittest

import agent_error_proposer as proposer
import recovery_writer as rw

NOW = datetime.datetime(2026, 10, 3, 20, 0, 0,
                        tzinfo=datetime.timezone.utc)


def agent(agent_id="a1", status="error", **overrides):
    base = {"id": agent_id, "name": f"Agent {agent_id}",
            "status": status, "reportsTo": "lead-1"}
    base.update(overrides)
    return base


def run(run_id="r1", agent_id="a1", **overrides):
    base = {"id": run_id, "agentId": agent_id, "status": "failed",
            "finishedAt": "2026-10-03T19:30:00Z",
            "resultJson": {
                "subtype": "success",
                "unmanagedBackgroundTask": {"terminalResultSeen": True},
            }}
    base.update(overrides)
    return base


def propose(agents, runs_by_agent, **kw):
    return proposer.propose(NOW, agents, runs_by_agent, **kw)


class ProposeReset(unittest.TestCase):
    def test_benign_error_proposes_reset_once(self):
        records = propose([agent()], {"a1": [run()]})
        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertEqual(record["type"], "proposal")
        self.assertEqual(record["mutation"], "reset_agent_error")
        self.assertEqual(record["agentId"], "a1")
        self.assertEqual(record["runId"], "r1")

    def test_proposal_carries_the_full_evidence(self):
        # The writer needs the exact run, its result, and its finishedAt.
        # A proposal missing any of them refuses by design.
        record = propose([agent()], {"a1": [run()]})[0]
        self.assertEqual(record["finishedAt"], "2026-10-03T19:30:00Z")
        self.assertEqual(record["result"]["subtype"], "success")
        self.assertTrue(
            record["result"]["unmanagedBackgroundTask"]["terminalResultSeen"])

    def test_non_benign_routes_to_lead_not_reset(self):
        records = propose(
            [agent()], {"a1": [run(resultJson={"subtype": "crash"})]})
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["type"], "finding")
        self.assertEqual(records[0]["owner"], "lead-1")
        self.assertEqual(records[0]["route"], "owning-lead")
        self.assertNotIn("mutation", records[0])

    def test_latest_failed_run_decides_not_an_older_benign_one(self):
        # An older benign run plus a NEWER real failure must route to the
        # lead: resetting on the stale benign run would clear evidence the
        # lead needs for the live failure.
        runs = [run("old", finishedAt="2026-10-03T18:00:00Z"),
                run("new", finishedAt="2026-10-03T19:40:00Z",
                    resultJson={"subtype": "crash"})]
        records = propose([agent()], {"a1": runs})
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["type"], "finding")

    def test_newer_benign_supersedes_older_crash(self):
        # The reverse: the newest failure is benign, the older crash is
        # history. The agent is still stuck on the benign signature.
        runs = [run("old", finishedAt="2026-10-03T18:00:00Z",
                    resultJson={"subtype": "crash"}),
                run("new", finishedAt="2026-10-03T19:30:00Z")]
        records = propose([agent()], {"a1": runs})
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["type"], "proposal")
        self.assertEqual(records[0]["runId"], "new")

    def test_non_failed_runs_are_invisible(self):
        records = propose(
            [agent()], {"a1": [run(status="succeeded"),
                               run("r2", status="cancelled")]})
        self.assertEqual(records, [])

    def test_fresh_benign_is_silent(self):
        records = propose(
            [agent()], {"a1": [run(finishedAt="2026-10-03T19:55:00Z")]})
        self.assertEqual(records, [])

    def test_boundary_is_silent(self):
        records = propose(
            [agent()], {"a1": [run(finishedAt="2026-10-03T19:50:00Z")]})
        self.assertEqual(records, [])

    def test_idle_agents_are_invisible(self):
        records = propose([agent("a1", status="idle")], {"a1": [run()]})
        self.assertEqual(records, [])

    def test_error_agent_with_no_failed_runs_is_silent(self):
        records = propose([agent()], {"a1": []})
        self.assertEqual(records, [])

    def test_run_without_id_is_silent(self):
        bad = run()
        del bad["id"]
        records = propose([agent()], {"a1": [bad]})
        self.assertEqual(records, [])

    def test_run_without_finished_is_silent(self):
        bad = run()
        del bad["finishedAt"]
        records = propose([agent()], {"a1": [bad]})
        self.assertEqual(records, [])


class WriterAgreement(unittest.TestCase):
    def test_proposer_and_writer_agree_on_shared_fixtures(self):
        # The detector proposes; the writer decides. If their benign checks
        # drift apart, benign agents stop resetting (missed recovery) or --
        # worse -- the proposer emits what the writer always refuses (noise
        # the CEO routine must triage). Shared fixtures must agree.
        benign = {"subtype": "success",
                  "unmanagedBackgroundTask": {"terminalResultSeen": True}}
        non_benign = [
            {"subtype": "crash",
             "unmanagedBackgroundTask": {"terminalResultSeen": True}},
            {"subtype": "success",
             "unmanagedBackgroundTask": {"terminalResultSeen": False}},
            {"subtype": "success",
             "unmanagedBackgroundTask": {"terminalResultSeen": "true"}},
            {"subtype": "success",
             "unmanagedBackgroundTask": {"terminalResultSeen": 1}},
            {"subtype": "success"},
            {"other": 1},
        ]
        ok, _ = proposer.run_is_benign({"resultJson": benign})
        self.assertTrue(ok)
        wok, _ = rw.benign_reset_evidence(benign)
        self.assertTrue(wok)
        for result in non_benign:
            pok, _ = proposer.run_is_benign({"resultJson": result})
            self.assertFalse(pok, f"proposer accepted {result}")
            wok, _ = rw.benign_reset_evidence(result)
            self.assertFalse(wok, f"writer accepted {result}")

    def test_accepted_proposal_passes_the_writer_offline_gate(self):
        # End to end on fixtures: what the proposer emits, the writer's
        # decide() must accept (past-10m benign). A refusal here means the
        # two halves disagree on the evidence shape.
        record = propose([agent()], {"a1": [run()]})[0]
        decision = rw.decide_agent_reset(
            {"identifier": record["identifier"],
             "detector": record["detector"],
             "reason": record["reason"],
             "mutation": record["mutation"],
             "agentId": record["agentId"],
             "runId": record["runId"],
             "finishedAt": record["finishedAt"],
             "result": record["result"],
             "before": record["before"],
             "after": record["after"],
             "note": record["note"]},
            now=NOW)
        self.assertEqual(decision.outcome, "decided")


if __name__ == "__main__":
    unittest.main(verbosity=2, argv=[__file__])
