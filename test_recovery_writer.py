#!/usr/bin/env python3
# ===========================================================================
# test_recovery_writer.py — offline hostile suite for recovery_writer.py.
#
# Written to FAIL a plausible-but-wrong implementation, not to confirm the one
# that exists. Every section below is either a drift the old timers actually
# exhibited, or the specific shortcut a reimplementation would take.
#
# Deterministic: no network, no credentials, no clock reads. Fixture rows are
# inline so the suite survives the live board changing underneath it.
#
#   python3 -m unittest -v test_recovery_writer.py
# ===========================================================================

from __future__ import annotations

import copy
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import recovery_writer as rw

CEO = "00000000-0000-4000-8000-0000000000c1"
OWNER_USER = "u-owner-0000-1111-2222-333333333333"
OWNER_AGENT = "a-owner-0000-1111-2222-333333333333"
OTHER_USER = "u-stranger-0000-1111-2222-444444444444"
IMPL = "11111111-1111-4111-8111-111111111111"


def live(identifier: str = "ISSUE-1", **changes):
    base = {
        "id": "00000000-0000-4000-8000-000000000001",
        "identifier": identifier,
        "projectId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "companyId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "status": "todo",
        "assigneeAgentId": None,
        "assigneeUserId": None,
        "unblockDescriptor": None,
        "treeControlState": {},
    }
    base.update(changes)
    return base


def proposal(mutation: str, **changes):
    base = {
        "issueId": "00000000-0000-4000-8000-000000000001",
        "identifier": "ISSUE-1",
        "detector": "test-detector",
        "reason": "test_reason",
        "mutation": mutation,
        "before": {"status": "todo"},
        "after": {"status": "todo"},
        "note": "test proposal",
    }
    base.update(changes)
    return base


def decide(mutation: str, live_row=None, ceo=CEO, **kw):
    prop = proposal(mutation, **kw.pop("proposal", {}))
    prop.update({k: v for k, v in kw.items() if k in prop})
    extra = {k: v for k, v in kw.items() if k not in prop}
    prop.update(extra)
    return rw.decide(prop, live_row or live(), ceo,
                     kw.get("owner_user", OWNER_USER), kw.get("owner_agent", OWNER_AGENT))


class ArgvOnlyApply(unittest.TestCase):
    def test_decoy_env_does_not_enable_apply(self):
        # The drift: mode read from the environment, so an EnvironmentFile
        # meant for credentials flipped a detector into a writer. Here apply
        # is argv-only; the decoy that would have armed the old shape is
        # inert.
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump({"proposals": [proposal("none")]}, handle)
            path = handle.name
        try:
            with patch.dict(os.environ, {"RECOVERY_WRITER_APPLY": "1", "APPLY": "1",
                                          "RECOVERY_WRITER_MODE": "apply"}, clear=False):
                args = rw.parse_args(["--proposals", path])
            self.assertFalse(args.apply)
        finally:
            os.unlink(path)

    def test_no_environment_variable_is_read_for_apply(self):
        # Behavioural, not textual: with every plausible arming variable set,
        # a cycle without --apply still performs no mutation.
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump({"proposals": [proposal("none")]}, handle)
            path = handle.name
        try:
            env = {"RECOVERY_WRITER_APPLY": "1", "APPLY": "true",
                   "RECOVERY_WRITER_MODE": "apply", "DRY_RUN": "0"}
            with patch.dict(os.environ, env, clear=False):
                out = io.StringIO()
                with redirect_stdout(out):
                    rc = rw.main(["--proposals", path])
            self.assertEqual(rc, 0)
            summary = [json.loads(line) for line in out.getvalue().splitlines()
                       if '"type": "summary"' in line][0]
            self.assertEqual(summary["mode"], "dry-run")
            self.assertEqual(summary["applied"], 0)
        finally:
            os.unlink(path)

    def test_source_never_consults_env_for_mode(self):
        # The sibling guard: if someone later adds an env arming path, this
        # names the exact lines. os.environ reads are allowed for credentials
        # and identity plumbing, never for the write bit.
        import pathlib
        source = pathlib.Path(rw.__file__).read_text()
        for env_name in ("RECOVERY_WRITER_APPLY", "WRITER_APPLY", "APPLY_MODE",
                         "RECOVERY_MODE", "DRY_RUN", "DRY-RUN"):
            self.assertNotIn(f'"{env_name}"', source)
            self.assertNotIn(f"'{env_name}'", source)


class RecipientConfig(unittest.TestCase):
    def test_no_builtin_recipient(self):
        args = rw.parse_args(["--proposals", "fixture.json"])
        self.assertIsNone(args.ceo_agent_id)

    def test_explicit_recipient_is_preserved(self):
        args = rw.parse_args(["--proposals", "fixture.json", "--ceo-agent-id", CEO])
        self.assertEqual(args.ceo_agent_id, CEO)

    def test_unconfigured_recipient_refuses_owner_redirect(self):
        args = rw.parse_args(["--proposals", "fixture.json"])
        decision = rw.decide(
            proposal("assign_blocker_owner", targetUserId=OWNER_USER,
                     after={"assigneeAgentId": CEO},
                     ownerEvidence="unblockDescriptor.owner.agentId"),
            live(status="blocked", unblockDescriptor={
                "owner": {"agentId": CEO}, "action": "Take it."}),
            args.ceo_agent_id, OWNER_USER, OWNER_AGENT)
        self.assertTrue(decision.outcome.startswith("refused:"), decision)
        self.assertIsNone(decision.target_agent_id)


class OwnerRedirect(unittest.TestCase):
    def test_owner_user_target_is_redirected_to_chief_executive(self):
        prop = proposal("assign_blocker_owner", targetUserId=OWNER_USER,
                        after={"assigneeAgentId": CEO},
                        ownerEvidence="unblockDescriptor.owner.agentId")
        row = live(status="blocked",
                   unblockDescriptor={"owner": {"agentId": CEO}, "action": "Take it."})
        decision = rw.decide(prop, row, CEO, OWNER_USER, OWNER_AGENT)
        self.assertEqual(decision.outcome, "decided")
        self.assertEqual(decision.target_agent_id, CEO)
        self.assertEqual(decision.redirected, "user-target->chief-executive")

    def test_owner_agent_target_is_redirected_to_chief_executive(self):
        prop = proposal("assign_blocker_owner", targetAgentId=OWNER_AGENT,
                        after={"assigneeAgentId": CEO},
                        ownerEvidence="unblockDescriptor.owner.agentId")
        row = live(status="blocked",
                   unblockDescriptor={"owner": {"agentId": CEO}, "action": "Take it."})
        decision = rw.decide(prop, row, CEO, OWNER_USER, OWNER_AGENT)
        self.assertEqual(decision.outcome, "decided")
        self.assertEqual(decision.target_agent_id, CEO)
        self.assertEqual(decision.redirected, "owner-agent->chief-executive")

    def test_owner_target_with_no_executive_refuses_never_delivers(self):
        prop = proposal("assign_blocker_owner", targetUserId=OWNER_USER,
                        after={"assigneeUserId": OWNER_USER},
                        ownerEvidence="unblockDescriptor.owner.agentId")
        row = live(status="blocked",
                   unblockDescriptor={"owner": {"agentId": IMPL}, "action": "Take it."})
        decision = rw.decide(prop, row, None, OWNER_USER, OWNER_AGENT)
        self.assertTrue(decision.outcome.startswith("refused:"))
        self.assertIsNone(decision.target_agent_id)

    def test_unknown_user_target_refuses_even_with_executive(self):
        # The plausible hole: "any user target redirects to the chief
        # executive" would let a detector assign arbitrary humans by way of
        # the redirect. Only the configured owner identity redirects.
        prop = proposal("assign_blocker_owner", targetUserId=OTHER_USER,
                        after={"assigneeUserId": OTHER_USER})
        decision = rw.decide(prop, live(status="blocked"), CEO, OWNER_USER, OWNER_AGENT)
        self.assertTrue(decision.outcome.startswith("refused:"))
        self.assertIsNone(decision.target_agent_id)

    def test_user_target_with_unconfigured_owner_identity_refuses(self):
        # Fail closed: without --owner-user-id the writer cannot verify a
        # user target IS the owner, so every user target refuses.
        prop = proposal("assign_blocker_owner", targetUserId=OWNER_USER,
                        after={"assigneeUserId": OWNER_USER})
        decision = rw.decide(prop, live(status="blocked"), CEO, None, None)
        self.assertTrue(decision.outcome.startswith("refused:"))

    def test_patch_route_refuses_user_assignment_without_network(self):
        # Structural: the guard fires before any byte leaves the process, so
        # this test proves it with a client that could not reach anything.
        client = rw.PaperclipClient("http://127.0.0.1:9", "dead-key", None)
        with self.assertRaises(rw.WriterError) as caught:
            client.patch("/api/issues/x", {"assigneeUserId": OWNER_USER})
        self.assertIn("agents only", str(caught.exception))


class SinglePolicy(unittest.TestCase):
    def test_unknown_mutations_are_diagnostic_never_applied(self):
        # Resumes, review handbacks, releases and resets belong to the native
        # paths. A detector proposing them gets a diagnostic, not a write.
        for mutation in ("resume", "wake_same_agent", "release",
                         "reset", "unblock", "handback", "assign_reviewer"):
            decision = decide(mutation)
            self.assertEqual(decision.mutation, mutation)
            self.assertEqual(decision.outcome, "refused:unknown_mutation")

    def test_terminal_card_never_reopens(self):
        prop = proposal("assign_blocker_owner", targetAgentId=IMPL)
        decision = rw.decide(prop, live(status="done"), CEO, OWNER_USER, OWNER_AGENT)
        self.assertEqual(decision.outcome, "refused:terminal")
        prop = proposal("restore_blocked")
        decision = rw.decide(prop, live(status="cancelled",
                                        unblockDescriptor={"action": "x"}),
                             CEO, OWNER_USER, OWNER_AGENT)
        self.assertEqual(decision.outcome, "refused:terminal")

    def test_hold_barrier_refuses_everything_but_maintenance(self):
        held = live(status="blocked", treeControlState={
            "activePauseHold": {"id": "pause", "mode": "pause", "status": "active"}})
        prop = proposal("assign_blocker_owner", targetAgentId=IMPL,
                        ownerEvidence="unblockDescriptor.owner.agentId")
        row = copy.deepcopy(held)
        row["unblockDescriptor"] = {"owner": {"agentId": IMPL}, "action": "Take it."}
        decision = rw.decide(prop, row, CEO, OWNER_USER, OWNER_AGENT)
        self.assertEqual(decision.outcome, "refused:hold_barrier")

        prop = proposal("create_pause_hold", holdEvidence="owner comment 1: hold")
        decision = rw.decide(prop, held, CEO, OWNER_USER, OWNER_AGENT)
        self.assertEqual(decision.outcome, "refused:already_held")

        prop = proposal("restore_blocked")
        row = copy.deepcopy(held)
        row.update(status="todo", unblockDescriptor={"owner": {"agentId": IMPL},
                                                     "action": "hold: do not proceed"})
        decision = rw.decide(prop, row, CEO, OWNER_USER, OWNER_AGENT)
        self.assertEqual(decision.outcome, "decided")

    def test_body_prose_alone_neither_holds_nor_contains(self):
        # Unauthenticated title/body prose may not steer the writer: it
        # refuses nothing here and initiates nothing.
        row = live(status="blocked",
                   title="HOLD do not proceed",
                   description="owner hold on everything",
                   unblockDescriptor={"owner": {"agentId": IMPL}, "action": "Take it."})
        prop = proposal("assign_blocker_owner", targetAgentId=IMPL,
                        ownerEvidence="unblockDescriptor.owner.agentId")
        decision = rw.decide(prop, row, CEO, OWNER_USER, OWNER_AGENT)
        self.assertEqual(decision.outcome, "decided")

    def test_stale_owner_refuses(self):
        row = live(status="todo",
                   unblockDescriptor={"owner": {"agentId": "99999999-9999-4999-8999-999999999999"},
                                      "action": "Take it."})
        prop = proposal("assign_blocker_owner", targetAgentId=IMPL,
                        ownerEvidence="unblockDescriptor.owner.agentId")
        decision = rw.decide(prop, row, CEO, OWNER_USER, OWNER_AGENT)
        self.assertEqual(decision.outcome, "refused:owner_changed")

    def test_manual_pin_never_clears(self):
        row = live(status="blocked",
                   assigneeAdapterOverrides={"adapterConfig": {"model": "muse"}})
        prop = proposal("clear_pin", provenance="manual", pinModel="muse")
        decision = rw.decide(prop, row, CEO, OWNER_USER, OWNER_AGENT)
        self.assertEqual(decision.outcome, "refused:manual_pin")

    def test_missing_provenance_never_clears(self):
        # The quiet default matters: a detector that forgot to classify must
        # not clear by omission.
        row = live(status="blocked",
                   assigneeAdapterOverrides={"adapterConfig": {"model": "muse"}})
        prop = proposal("clear_pin", pinModel="muse")
        decision = rw.decide(prop, row, CEO, OWNER_USER, OWNER_AGENT)
        self.assertEqual(decision.outcome, "refused:manual_pin")

    def test_changed_pin_refuses_stale_clear(self):
        row = live(status="blocked",
                   assigneeAdapterOverrides={"adapterConfig": {"model": "opus"}})
        prop = proposal("clear_pin", provenance="auto", pinModel="muse")
        decision = rw.decide(prop, row, CEO, OWNER_USER, OWNER_AGENT)
        self.assertEqual(decision.outcome, "refused:pin_changed")

    def test_gone_pin_refuses(self):
        prop = proposal("clear_pin", provenance="auto", pinModel="muse")
        decision = rw.decide(prop, live(status="blocked"), CEO, OWNER_USER, OWNER_AGENT)
        self.assertEqual(decision.outcome, "refused:pin_gone")

    def test_receipt_carries_single_schema(self):
        prop = proposal("assign_blocker_owner", targetAgentId=IMPL,
                        ownerEvidence="unblockDescriptor.owner.agentId")
        row = live(status="blocked",
                   unblockDescriptor={"owner": {"agentId": IMPL}, "action": "Take it."})
        decision = rw.decide(prop, row, CEO, OWNER_USER, OWNER_AGENT)
        receipt = decision.receipt("dry-run", "dry_run_held")
        for key in ("writer", "policyVersion", "mode", "issueId", "identifier",
                    "detector", "reason", "mutation", "targetAgentId", "sourceId",
                    "redirected", "fingerprint", "before", "after", "note",
                    "decision", "apply"):
            self.assertIn(key, receipt, f"receipt missing {key}")
        self.assertEqual(receipt["writer"], rw.WRITER_NAME)
        self.assertEqual(receipt["policyVersion"], rw.POLICY_VERSION)
        self.assertRegex(receipt["fingerprint"], r"^[0-9a-f]{24}$")


class InputAndBounds(unittest.TestCase):
    def test_zero_proposals_is_an_error_not_a_clean_cycle(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump({"proposals": []}, handle)
            path = handle.name
        try:
            with self.assertRaises(rw.WriterError):
                rw.load_proposals(path)
        finally:
            os.unlink(path)

    def test_malformed_proposals_fail_loudly(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            handle.write('{"proposals": [oops')
            path = handle.name
        try:
            with self.assertRaises(rw.WriterError):
                rw.load_proposals(path)
        finally:
            os.unlink(path)

    def test_max_repairs_zero_is_accepted_as_observe_only(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump({"proposals": [proposal("none")]}, handle)
            path = handle.name
        try:
            args = rw.parse_args(["--proposals", path, "--max-repairs", "0"])
            self.assertEqual(args.max_repairs, 0)
        finally:
            os.unlink(path)

    def test_negative_max_repairs_is_a_usage_error(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump({"proposals": [proposal("none")]}, handle)
            path = handle.name
        try:
            with patch.dict(os.environ, {}, clear=True):
                with self.assertRaises(SystemExit) as caught:
                    rw.parse_args(["--proposals", path, "--max-repairs", "-1"])
            self.assertEqual(caught.exception.code, 2)
        finally:
            os.unlink(path)

    def test_jsonl_detector_output_feeds_unmodified(self):
        lines = [
            json.dumps({"type": "cycle", "mode": "dry-run"}),
            json.dumps({"type": "proposal", **proposal("none")}),
            json.dumps({"type": "summary", "mode": "dry-run"}),
        ]
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as handle:
            handle.write("\n".join(lines) + "\n")
            path = handle.name
        try:
            rows = rw.load_proposals(path)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["mutation"], "none")
        finally:
            os.unlink(path)

    def test_refusals_do_not_fail_a_cycle(self):
        # A refused proposal is the policy working. The suite's own sibling
        # (test_liveness_reconciler.py) counts failures the old way; this
        # writer must stay green on a diagnostic-only cycle.
        rows = [
            proposal("resume"),
            proposal("assign_blocker_owner", targetAgentId=IMPL),
        ]
        rows[1]["live"] = live(status="done")
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump({"proposals": rows}, handle)
            path = handle.name
        try:
            out = io.StringIO()
            with redirect_stdout(out):
                rc = rw.main(["--proposals", path])
            self.assertEqual(rc, 0, out.getvalue())
            summary = [json.loads(line) for line in out.getvalue().splitlines()
                       if '"type": "summary"' in line][0]
            self.assertEqual(summary["failed"], 0)
        finally:
            os.unlink(path)

    def test_decided_dry_run_records_without_applying(self):
        row = live(status="blocked",
                   unblockDescriptor={"owner": {"agentId": IMPL}, "action": "Take it."})
        rows = [dict(proposal("assign_blocker_owner", targetAgentId=IMPL,
                              ownerEvidence="unblockDescriptor.owner.agentId"),
                     live=row)]
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump({"proposals": rows}, handle)
            path = handle.name
        try:
            out = io.StringIO()
            with redirect_stdout(out):
                rc = rw.main(["--proposals", path])
            self.assertEqual(rc, 0, out.getvalue())
            receipts = [json.loads(line) for line in out.getvalue().splitlines()
                        if '"type": "receipt"' in line]
            self.assertEqual(len(receipts), 1)
            self.assertEqual(receipts[0]["apply"], "dry_run_held")
        finally:
            os.unlink(path)


class BenignAgentReset(unittest.TestCase):
    # First and only auto-action: reset_agent_error for the known-benign
    # exit-143 false-failure (subtype=success plus
    # unmanagedBackgroundTask.terminalResultSeen=true), past 10m. Every
    # case runs offline against fixtures: decide() with an injectable clock,
    # apply_decision() against a stub client. No network, no credentials.
    AGENT = "22222222-2222-4222-8222-222222222222"
    RUN = "33333333-3333-4333-8333-333333333333"
    NOW = rw.datetime.datetime(2026, 10, 3, 20, 0, 0,
                               tzinfo=rw.datetime.timezone.utc)

    def benign_result(self):
        return {
            "subtype": "success",
            "unmanagedBackgroundTask": {"terminalResultSeen": True},
        }

    def reset_proposal(self, **overrides):
        base = proposal("reset_agent_error",
                        agentId=self.AGENT, runId=self.RUN,
                        finishedAt="2026-10-03T19:30:00Z",
                        result=self.benign_result())
        # Agent-targeted resets name no board card: the shared helper's
        # issueId must go, or the writer (correctly) refuses the proposal.
        base.pop("issueId", None)
        base.update(overrides)
        return base

    def benign_decision(self, **overrides):
        return rw.decide_agent_reset(self.reset_proposal(**overrides),
                                     now=self.NOW)

    def test_benign_past_10m_is_decided(self):
        decision = self.benign_decision()
        self.assertEqual(decision.outcome, "decided")
        self.assertEqual(decision.mutation, "reset_agent_error")
        self.assertEqual(decision.target_agent_id, self.AGENT)
        self.assertEqual(decision.source_id, self.RUN)

    def test_evidence_lives_in_before_after(self):
        # A receipt reader must see what justified the reset without
        # chasing proposal plumbing: the pinned evidence is in before/after.
        decision = self.benign_decision()
        self.assertEqual(decision.before["subtype"], "success")
        self.assertTrue(decision.before["terminalResultSeen"])
        self.assertEqual(decision.after, {"agentId": self.AGENT,
                                          "status": "idle"})

    def test_wrong_subtype_refuses(self):
        decision = self.benign_decision(
            result={"subtype": "crash",
                    "unmanagedBackgroundTask": {"terminalResultSeen": True}})
        self.assertEqual(decision.outcome, "refused:non_benign")
        self.assertNotEqual(decision.after.get("status"), "idle")

    def test_seen_false_refuses(self):
        decision = self.benign_decision(
            result={"subtype": "success",
                    "unmanagedBackgroundTask": {"terminalResultSeen": False}})
        self.assertEqual(decision.outcome, "refused:non_benign")

    def test_missing_result_refuses_never_resets_by_omission(self):
        # The quiet default matters: a detector that forgot to classify must
        # not reset by omission. Absence refuses exactly like a wrong value.
        bare = proposal("reset_agent_error", agentId=self.AGENT,
                        runId=self.RUN,
                        finishedAt="2026-10-03T19:30:00Z")
        decision = rw.decide_agent_reset(bare, now=self.NOW)
        self.assertEqual(decision.outcome, "refused:non_benign")

    def test_missing_key_refuses(self):
        # Tricky shape: a result dict with neither key. Not benign.
        decision = self.benign_decision(result={"other": 1})
        self.assertEqual(decision.outcome, "refused:non_benign")

    def test_truthy_string_is_not_true(self):
        # Strict identity: "true"/1 must not pass a `is True` gate.
        for seen in ("true", 1, "True"):
            decision = self.benign_decision(
                result={"subtype": "success", "unmanagedBackgroundTask":
                        {"terminalResultSeen": seen}})
            self.assertEqual(decision.outcome, "refused:non_benign",
                             f"seen={seen!r} passed the gate")

    def test_fresh_run_refuses(self):
        decision = self.benign_decision(
            finishedAt="2026-10-03T19:55:00Z")
        self.assertEqual(decision.outcome, "refused:too_fresh")

    def test_boundary_is_not_past(self):
        # Exactly 10m is not PAST 10m: the threshold is strict.
        decision = self.benign_decision(
            finishedAt="2026-10-03T19:50:00Z")
        self.assertEqual(decision.outcome, "refused:too_fresh")

    def test_missing_run_refuses(self):
        bare = self.reset_proposal()
        del bare["runId"]
        decision = rw.decide_agent_reset(bare, now=self.NOW)
        self.assertEqual(decision.outcome, "refused:no_run")

    def test_missing_agent_refuses(self):
        bare = self.reset_proposal()
        del bare["agentId"]
        decision = rw.decide_agent_reset(bare, now=self.NOW)
        self.assertEqual(decision.outcome, "refused:no_agent")

    def test_unparseable_finished_refuses(self):
        decision = self.benign_decision(finishedAt="not-a-time")
        self.assertEqual(decision.outcome, "refused:unaged")

    def test_decide_routes_reset_through_the_reset_gate(self):
        decision = decide("reset_agent_error",
                          proposal={"agentId": self.AGENT, "runId": self.RUN,
                                    "finishedAt": "2020-01-01T00:00:00Z",
                                    "result": self.benign_result()})
        self.assertEqual(decision.mutation, "reset_agent_error")
        self.assertEqual(decision.outcome, "decided")

    def test_reset_with_card_id_is_undecidable(self):
        # Agent-targeted resets name no board card: an issueId here is a
        # detector bug, and the cycle fails loudly rather than resetting
        # the wrong scope.
        rows = [self.reset_proposal(issueId="00000000-0000-4000-8000-000000000001")]
        with tempfile.NamedTemporaryFile("w", suffix=".json",
                                         delete=False) as handle:
            json.dump({"proposals": rows}, handle)
            path = handle.name
        try:
            out = io.StringIO()
            with redirect_stdout(out):
                rc = rw.main(["--proposals", path])
            self.assertEqual(rc, 1, out.getvalue())
            receipts = [json.loads(line) for line in out.getvalue().splitlines()
                        if '"type": "receipt"' in line]
            self.assertEqual(receipts[0]["decision"], "refused:undecidable")
        finally:
            os.unlink(path)

    def test_decided_reset_dry_run_held(self):
        rows = [self.reset_proposal()]
        with tempfile.NamedTemporaryFile("w", suffix=".json",
                                         delete=False) as handle:
            json.dump({"proposals": rows}, handle)
            path = handle.name
        try:
            out = io.StringIO()
            with redirect_stdout(out):
                rc = rw.main(["--proposals", path])
            self.assertEqual(rc, 0, out.getvalue())
            receipts = [json.loads(line) for line in out.getvalue().splitlines()
                        if '"type": "receipt"' in line]
            self.assertEqual(len(receipts), 1)
            self.assertEqual(receipts[0]["decision"], "decided")
            self.assertEqual(receipts[0]["apply"], "dry_run_held")
        finally:
            os.unlink(path)


class BenignAgentResetApply(unittest.TestCase):
    AGENT = BenignAgentReset.AGENT
    RUN = BenignAgentReset.RUN

    def benign(self):
        return BenignAgentReset().benign_decision()

    class StubClient(rw.PaperclipClient):
        def __init__(self, agent_status="error", run=None):
            self.agent_status = agent_status
            self.run = run
            self.posts = []

        def get(self, path):
            if path == f"/api/agents/{BenignAgentReset.AGENT}":
                return {"id": BenignAgentReset.AGENT,
                        "status": self.agent_status}
            if path == f"/api/heartbeat-runs/{BenignAgentReset.RUN}":
                return self.run
            raise AssertionError(f"unexpected GET {path}")

        def post(self, path, body):
            self.posts.append(path)
            if path == f"/api/agents/{BenignAgentReset.AGENT}/clear-error":
                self.agent_status = "idle"
                return {"status": "idle"}
            raise AssertionError(f"unexpected POST {path}")

    def live_run(self, **overrides):
        base = {
            "id": self.RUN, "agentId": self.AGENT, "status": "failed",
            "finishedAt": "2026-10-03T19:30:00Z",
            "resultJson": BenignAgentReset().benign_result(),
        }
        base.update(overrides)
        return base

    def test_apply_resets_and_verifies_idle(self):
        client = self.StubClient(run=self.live_run())
        result = rw.apply_decision(client, self.benign())
        self.assertEqual(result, {"outcome": "applied", "wrote": True})
        self.assertEqual(
            client.posts,
            [f"/api/agents/{self.AGENT}/clear-error"])

    def test_apply_refuses_live_agent_not_error(self):
        client = self.StubClient(agent_status="idle", run=self.live_run())
        with self.assertRaises(rw.WriterError):
            rw.apply_decision(client, self.benign())
        self.assertEqual(client.posts, [])

    def test_apply_refuses_live_run_not_failed(self):
        client = self.StubClient(run=self.live_run(status="succeeded"))
        with self.assertRaises(rw.WriterError):
            rw.apply_decision(client, self.benign())
        self.assertEqual(client.posts, [])

    def test_apply_refuses_wrong_agent_run(self):
        client = self.StubClient(
            run=self.live_run(agentId="99999999-9999-4999-8999-999999999999"))
        with self.assertRaises(rw.WriterError):
            rw.apply_decision(client, self.benign())
        self.assertEqual(client.posts, [])

    def test_apply_refuses_live_non_benign(self):
        client = self.StubClient(
            run=self.live_run(resultJson={"subtype": "crash"}))
        with self.assertRaises(rw.WriterError):
            rw.apply_decision(client, self.benign())
        self.assertEqual(client.posts, [])

    def test_apply_refuses_fresh_live_run(self):
        # Offline evidence said past-10m; the live run finished a minute
        # ago. The live read wins: no write.
        fresh = self.live_run(
            finishedAt=rw.datetime.datetime.now(
                rw.datetime.timezone.utc).isoformat())
        client = self.StubClient(run=fresh)
        with self.assertRaises(rw.WriterError):
            rw.apply_decision(client, self.benign())
        self.assertEqual(client.posts, [])

    def test_apply_refuses_when_idle_never_confirms(self):
        class StuckClient(self.StubClient):
            def post(self, path, body):
                self.posts.append(path)
                return {"status": "error"}
        client = StuckClient(run=self.live_run())
        with self.assertRaises(rw.WriterError):
            rw.apply_decision(client, self.benign())
        self.assertEqual(
            client.posts,
            [f"/api/agents/{self.AGENT}/clear-error"])

    def test_non_decided_never_writes(self):
        refused = rw.decide_agent_reset(
            proposal("reset_agent_error"),
            now=BenignAgentReset.NOW)
        self.assertTrue(refused.outcome.startswith("refused:"))
        client = self.StubClient(run=self.live_run())
        result = rw.apply_decision(client, refused)
        self.assertEqual(result["wrote"], False)
        self.assertEqual(client.posts, [])


if __name__ == "__main__":
    unittest.main(verbosity=2, argv=[__file__])