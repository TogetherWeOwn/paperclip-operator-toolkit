#!/usr/bin/env python3
# ===========================================================================
# test_auth_denial_discriminator.py — hostile tests for the auth-denial
# discriminator (TOG-4062).
#
# These are written to FAIL a plausible-but-wrong implementation, not to
# confirm the one that exists. Each section below names the specific shortcut
# a reimplementation would take, and is the only check that can see it:
#
#   §1  classify on `errorCode` instead of the message  -> §1 goes red
#   §2  believe the error WORDING over the interleaving -> §2 goes red
#   §3  treat "no successes" as proof of withdrawal     -> §3 goes red
#   §4  count non-terminal runs as evidence             -> §4 goes red
#   §5  pad the window instead of measuring interior    -> §5 goes red
#   §6  merge every denial into one burst               -> §6 goes red
#   §7  report on a clean window / mis-rank exit codes   -> §7 goes red
#   §8  drift away from the incident it was built for   -> §8 goes red
#
# §8 is the corrected real-incident fixture: INSUFFICIENT once recorded model
# metadata is joined by run ID. Synthetic same-model controls exercise the
# INTERMITTENT and ENTITLEMENT signatures; neither proves account identity.
# ===========================================================================

import json
import os
import subprocess
import sys
import unittest
from unittest.mock import patch
from datetime import datetime, timedelta, timezone

import auth_denial_discriminator as mod

HERE = os.path.dirname(os.path.abspath(__file__))
INCIDENT = os.path.join(HERE, "tests", "auth-denial-incident-2026-09-22.json")

BASE = datetime(2026, 9, 22, 21, 0, 0, tzinfo=timezone.utc)

OAUTH_TEXT = (
    "Claude run failed: subtype=success: API Error: 503 auth_unavailable: no "
    "auth available (providers=claude, model=claude-opus-5; last upstream "
    "error: permission_error: OAuth authentication is currently not allowed "
    "for this organization.)"
)
DISABLED_TEXT = (
    "Claude run failed: subtype=success: Your organization has disabled "
    "Claude subscription access for Claude Code - Use an Anthropic API key "
    "instead, or ask your admin to enable access"
)
WORKTREE_TEXT = (
    "Claude run failed: subtype=error_during_execution: Error: could not "
    "verify worktree /paperclip/.../kofra/.claude/worktrees/tog-4035-s50 for "
    "this resume, so the resume was aborted rather than continuing without "
    "isolation."
)


ATTEMPT_ERROR = "tool execution failed after inference"


def run(minute, status, agent="agent-a", error=None, code=None, second=0,
        model="claude-opus-5", tokens=10):
    """One run record, placed at BASE + minute."""
    stamp = (BASE + timedelta(minutes=minute, seconds=second)).isoformat().replace(
        "+00:00", "Z"
    )
    return {
        "id": f"{agent}-{minute}-{second}-{status}",
        "agentId": agent,
        "status": status,
        "errorCode": code,
        "error": error,
        "createdAt": stamp,
        "finishedAt": stamp if status in ("succeeded", "failed") else None,
        "usageJson": {"model": model, "inputTokens": tokens},
    }


def verdicts(runs, **kw):
    return [b["verdict"] for b in mod.discriminate(runs, **kw)["bursts"]]


class ErrorCodeIsNotTheClassifier(unittest.TestCase):
    """§1 The message is the evidence; `errorCode` is neither sufficient nor
    necessary. Measured on 2026-09-22: `adapter_failed` covered both an
    entitlement-worded denial and an unrelated worktree abort, while the 503
    denials arrived under `claude_transient_upstream`."""

    def test_worktree_abort_sharing_a_code_is_not_a_denial(self):
        self.assertFalse(
            mod.is_auth_denial(
                run(5, "failed", error=WORKTREE_TEXT, code="adapter_failed")
            )
        )

    def test_denial_under_adapter_failed_is_caught(self):
        self.assertTrue(
            mod.is_auth_denial(
                run(5, "failed", error=DISABLED_TEXT, code="adapter_failed")
            )
        )

    def test_denial_under_transient_upstream_is_caught(self):
        self.assertTrue(
            mod.is_auth_denial(
                run(5, "failed", error=OAUTH_TEXT, code="claude_transient_upstream")
            )
        )

    def test_a_worktree_burst_alone_produces_no_finding(self):
        runs = [
            run(m, "failed", error=WORKTREE_TEXT, code="adapter_failed")
            for m in (1, 2, 3, 4)
        ]
        self.assertEqual(verdicts(runs), [])

    def test_success_is_never_a_denial_whatever_it_carries(self):
        self.assertFalse(mod.is_auth_denial(run(5, "succeeded", error=OAUTH_TEXT)))


class InterleavingOverridesWording(unittest.TestCase):
    """§2 Synthetic positive controls: same-model successes outweigh error
    wording. Unlike the real fixture, these explicitly record the SAME model.
    Neither evidence pattern proves upstream account identity."""

    def test_entitlement_wording_with_interleaved_successes_is_intermittent(self):
        runs = [
            run(0, "failed", agent="a", error=DISABLED_TEXT),
            run(2, "succeeded", agent="b"),
            run(4, "succeeded", agent="c"),
            run(6, "failed", agent="a", error=DISABLED_TEXT),
        ]
        self.assertEqual(verdicts(runs), ["INTERMITTENT"])

    def test_same_agent_denied_and_served_inside_burst_is_reported(self):
        runs = [
            run(0, "failed", agent="a", error=OAUTH_TEXT),
            run(3, "succeeded", agent="a"),
            run(6, "failed", agent="a", error=OAUTH_TEXT),
        ]
        burst = mod.discriminate(runs)["bursts"][0]
        self.assertEqual(burst["verdict"], "INTERMITTENT")
        self.assertEqual(burst["recovered_same_agents"], ["a"])

    def test_mixed_wording_same_agent_success_is_intermittent(self):
        rows = [run(0, "failed", agent="a", error=DISABLED_TEXT),
                run(3, "succeeded", agent="a"),
                run(6, "failed", agent="b", error=OAUTH_TEXT)]
        b = mod.discriminate(rows)["bursts"][0]
        self.assertEqual(b["verdict"], "INTERMITTENT")
        self.assertEqual(b["recovered_same_agents"], ["a"])

    def test_both_signatures_in_one_burst_are_one_incident(self):
        runs = [
            run(0, "failed", agent="a", error=DISABLED_TEXT),
            run(2, "succeeded", agent="b"),
            run(4, "failed", agent="c", error=OAUTH_TEXT),
        ]
        bursts = mod.discriminate(runs)["bursts"]
        self.assertEqual(len(bursts), 1)
        self.assertEqual(bursts[0]["denials"], 2)


class SilenceIsNotProof(unittest.TestCase):
    """§3 "No successes" means either "nothing else tried" or "everything was
    refused". Collapsing those is how a monitor cries wolf -- and here the
    false alarm escalates a non-incident to the owner."""

    def test_total_blackout_with_control_runs_is_entitlement(self):
        runs = [
            run(0, "failed", agent="a", error=OAUTH_TEXT),
            run(2, "failed", agent="b", error=ATTEMPT_ERROR, code="adapter_failed"),
            run(4, "failed", agent="c", error=ATTEMPT_ERROR, code="adapter_failed"),
            run(6, "failed", agent="d", error=OAUTH_TEXT),
        ]
        self.assertEqual(verdicts(runs), ["ENTITLEMENT"])

    def test_blackout_without_enough_control_runs_is_insufficient(self):
        runs = [
            run(0, "failed", agent="a", error=OAUTH_TEXT),
            run(6, "failed", agent="b", error=OAUTH_TEXT),
        ]
        self.assertEqual(verdicts(runs), ["INSUFFICIENT"])

    def test_single_denial_can_never_discriminate(self):
        runs = [
            run(0, "succeeded", agent="b"),
            run(3, "failed", agent="a", error=OAUTH_TEXT),
            run(6, "succeeded", agent="c"),
        ]
        self.assertEqual(verdicts(runs), ["INSUFFICIENT"])

    def test_control_run_threshold_is_the_only_thing_deciding(self):
        """Same runs, threshold moved by one: the verdict must move with it."""
        runs = [
            run(0, "failed", agent="a", error=OAUTH_TEXT),
            run(2, "failed", agent="b", error=ATTEMPT_ERROR, code="adapter_failed"),
            run(4, "failed", agent="d", error=ATTEMPT_ERROR, code="adapter_failed"),
            run(6, "failed", agent="c", error=OAUTH_TEXT),
        ]
        self.assertEqual(verdicts(runs, min_control_runs=2), ["ENTITLEMENT"])
        self.assertEqual(verdicts(runs, min_control_runs=3), ["INSUFFICIENT"])
        with self.assertRaises(ValueError):
            verdicts(runs, min_control_runs=1)

    def test_default_threshold_is_two_control_runs(self):
        """Pin the default evidence floor, not just explicit thresholds.
        A one-control window cannot support the ENTITLEMENT label."""
        self.assertEqual(mod.MIN_CONTROL_RUNS, 2)
        runs = [
            run(0, "failed", agent="a", error=OAUTH_TEXT),
            run(3, "failed", agent="b", error=ATTEMPT_ERROR, code="adapter_failed"),
            run(6, "failed", agent="c", error=OAUTH_TEXT),
        ]
        # One control run only: the DEFAULT must refuse to escalate.
        self.assertEqual(verdicts(runs), ["INSUFFICIENT"])

    def test_default_path_refuses_a_single_control_run(self):
        """Independent kill of a halved default, through the default code
        path with a different fixture: one interior control run and no
        explicit threshold must stay INSUFFICIENT. Assert the CLI exit and
        verdict rather than the constant; an invalid default is not a verdict."""
        runs = [
            run(0, "failed", agent="a", error=DISABLED_TEXT),
            run(3, "failed", agent="b", error=ATTEMPT_ERROR, code="adapter_failed"),
            run(6, "failed", agent="c", error=DISABLED_TEXT),
        ]
        result = subprocess.run(
            [sys.executable, "-B", os.path.join(HERE, "auth_denial_discriminator.py"),
             "--input", "-", "--json"], input=json.dumps(runs), text=True,
            capture_output=True, timeout=10, env={"PATH": os.environ.get("PATH", "")},
        )
        self.assertEqual(result.returncode, 4)
        self.assertEqual(json.loads(result.stdout)["bursts"][0]["verdict"],
                         "INSUFFICIENT")


class OnlyTerminalRunsAreEvidence(unittest.TestCase):
    """§4 The real sample is full of `queued`, `running` and `cancelled`
    records. A queued run never reached the lane, so it proves nothing about
    whether the lane was serving; counting one as a control run turns an
    honest INSUFFICIENT into a false ENTITLEMENT escalation."""

    def test_queued_and_running_are_not_control_runs(self):
        runs = [
            run(0, "failed", agent="a", error=OAUTH_TEXT),
            run(2, "queued", agent="b"),
            run(3, "running", agent="c"),
            run(6, "failed", agent="d", error=OAUTH_TEXT),
        ]
        self.assertEqual(verdicts(runs), ["INSUFFICIENT"])

    def test_cancelled_is_not_a_control_run(self):
        runs = [
            run(0, "failed", agent="a", error=OAUTH_TEXT),
            run(2, "cancelled", agent="b"),
            run(3, "cancelled", agent="c"),
            run(6, "failed", agent="d", error=OAUTH_TEXT),
        ]
        self.assertEqual(verdicts(runs), ["INSUFFICIENT"])

    def test_cancelled_is_not_a_success(self):
        runs = [
            run(0, "failed", agent="a", error=OAUTH_TEXT),
            run(3, "cancelled", agent="b"),
            run(6, "failed", agent="c", error=OAUTH_TEXT),
        ]
        burst = mod.discriminate(runs)["bursts"][0]
        self.assertEqual(burst["interleaved_successes"], 0)


class TheWindowIsStrictlyInterior(unittest.TestCase):
    """§5 A success before the first denial or after the last one says nothing
    about whether the lane was serving DURING the burst -- recovery afterward
    is exactly what a resolved withdrawal looks like too. Padding the window
    silently converts every ENTITLEMENT into an INTERMITTENT."""

    def test_flanking_successes_do_not_count_as_interleaving(self):
        runs = [
            run(0, "succeeded", agent="b"),
            run(2, "failed", agent="a", error=OAUTH_TEXT),
            run(4, "failed", agent="c", error=ATTEMPT_ERROR, code="adapter_failed"),
            run(5, "failed", agent="d", error=ATTEMPT_ERROR, code="adapter_failed"),
            run(6, "failed", agent="a", error=OAUTH_TEXT),
            run(8, "succeeded", agent="b"),
        ]
        bursts = mod.discriminate(runs)["bursts"]
        self.assertEqual(bursts[0]["interleaved_successes"], 0)
        self.assertEqual(bursts[0]["verdict"], "ENTITLEMENT")

    def test_outcome_time_not_dispatch_time_places_a_run(self):
        """A run queued before the burst but FINISHED inside it is interior."""
        late = run(0, "succeeded", agent="b")
        late["createdAt"] = (BASE - timedelta(minutes=30)).isoformat().replace(
            "+00:00", "Z"
        )
        late["finishedAt"] = (BASE + timedelta(minutes=3)).isoformat().replace(
            "+00:00", "Z"
        )
        runs = [
            run(0, "failed", agent="a", error=OAUTH_TEXT),
            late,
            run(6, "failed", agent="a", error=OAUTH_TEXT),
        ]
        self.assertEqual(verdicts(runs), ["INTERMITTENT"])


class BurstGrouping(unittest.TestCase):
    """§6 Two incidents a day apart are not one 24-hour outage. Lumping them
    reports a single enormous burst whose interior is full of ordinary
    successes -- which reads as INTERMITTENT no matter what happened."""

    def test_denials_separated_by_more_than_the_gap_are_separate_bursts(self):
        runs = [
            run(0, "failed", agent="a", error=OAUTH_TEXT),
            run(2, "failed", agent="b", error=OAUTH_TEXT),
            run(120, "failed", agent="c", error=OAUTH_TEXT),
            run(122, "failed", agent="d", error=OAUTH_TEXT),
        ]
        self.assertEqual(len(mod.discriminate(runs)["bursts"]), 2)

    def test_denials_inside_the_gap_are_one_burst(self):
        runs = [
            run(0, "failed", agent="a", error=OAUTH_TEXT),
            run(14, "failed", agent="b", error=OAUTH_TEXT),
        ]
        self.assertEqual(len(mod.discriminate(runs)["bursts"]), 1)

    def test_gap_boundary_is_exclusive_at_the_threshold(self):
        runs = [
            run(0, "failed", agent="a", error=OAUTH_TEXT),
            run(15, "failed", agent="b", error=OAUTH_TEXT),
        ]
        self.assertEqual(len(mod.discriminate(runs, gap_minutes=15)["bursts"]), 2)


class ExitCodesAndSilence(unittest.TestCase):
    """§7 A monitor that posts on a clean window trains everyone to ignore it.
    Exit 0 must mean silence, and the worst verdict must win."""

    def test_clean_window_is_silent(self):
        runs = [run(m, "succeeded", agent="a") for m in range(5)]
        result = mod.discriminate(runs)
        self.assertEqual(result["bursts"], [])
        self.assertEqual(mod.worst_exit(result["bursts"]), 0)

    def test_failures_that_are_not_auth_are_silent(self):
        runs = [
            run(m, "failed", agent="a", error=WORKTREE_TEXT, code="adapter_failed")
            for m in range(4)
        ]
        self.assertEqual(mod.worst_exit(mod.discriminate(runs)["bursts"]), 0)

    def test_entitlement_outranks_intermittent_across_bursts(self):
        self.assertEqual(
            mod.worst_exit(
                [{"verdict": "INTERMITTENT"}, {"verdict": "ENTITLEMENT"}]
            ),
            mod.EXIT_ENTITLEMENT,
        )

    def test_insufficient_outranks_intermittent(self):
        self.assertEqual(
            mod.worst_exit(
                [{"verdict": "INTERMITTENT"}, {"verdict": "INSUFFICIENT"}]
            ),
            mod.EXIT_INSUFFICIENT,
        )

    def test_entitlement_outranks_insufficient_across_bursts(self):
        """A zero-success window with controls outranks insufficient evidence.

        max() over raw exits inverts this pair (4 > 3). Severity is a separate
        ordering; neither label proves an upstream entitlement change."""
        self.assertEqual(
            mod.worst_exit(
                [{"verdict": "INSUFFICIENT"}, {"verdict": "ENTITLEMENT"}]
            ),
            mod.EXIT_ENTITLEMENT,
        )

    def test_entitlement_wins_a_three_way_split(self):
        """All three labels at once: ENTITLEMENT ranks highest regardless of
        burst order. A second, independent kill of the max-over-exits shortcut."""
        self.assertEqual(
            mod.worst_exit(
                [
                    {"verdict": "INSUFFICIENT"},
                    {"verdict": "INTERMITTENT"},
                    {"verdict": "ENTITLEMENT"},
                ]
            ),
            mod.EXIT_ENTITLEMENT,
        )

    def test_each_verdict_maps_to_its_documented_code(self):
        self.assertEqual(mod.worst_exit([{"verdict": "INTERMITTENT"}]), 2)
        self.assertEqual(mod.worst_exit([{"verdict": "ENTITLEMENT"}]), 3)
        self.assertEqual(mod.worst_exit([{"verdict": "INSUFFICIENT"}]), 4)


class RealIncidentAcceptance(unittest.TestCase):
    """§8 Real incident plus model/usage metadata recovered by run ID.
    The earlier INTERMITTENT claim mixed models; the corrected oracle is
    INSUFFICIENT. Provenance is in the adjacent .provenance.md file."""

    def setUp(self):
        with open(INCIDENT) as fh:
            self.runs = json.load(fh)

    def test_reproduces_the_incident(self):
        bursts = mod.discriminate(self.runs)["bursts"]
        self.assertEqual(len(bursts), 1)
        burst = bursts[0]
        self.assertEqual(burst["verdict"], "INSUFFICIENT")
        self.assertEqual(burst["model"], "claude-opus-5")
        self.assertEqual(burst["denials"], 8)
        self.assertEqual(len(burst["denied_agents"]), 3)
        self.assertEqual(burst["interleaved_successes"], 0)
        self.assertEqual(burst["control_runs"], 0)

    def test_cross_model_same_agent_success_is_not_recovery(self):
        recovery = next(r for r in self.runs
                        if r["id"] == "209386ae-0574-462f-8586-fff446bf0391")
        self.assertEqual(recovery["usageJson"]["model"], "gpt-6-astra")
        burst = mod.discriminate(self.runs)["bursts"][0]
        self.assertEqual(burst["recovered_same_agents"], [])

    def test_both_observed_signatures_are_present(self):
        burst = mod.discriminate(self.runs)["bursts"][0]
        self.assertIn("auth_unavailable", burst["signatures"])
        self.assertIn("disabled claude subscription access", burst["signatures"])

    def test_the_unrelated_worktree_abort_is_not_counted(self):
        self.assertEqual(
            sum(1 for r in self.runs if mod.is_auth_denial(r)),
            8,
            "only the 8 auth-class failures may be classified as denials",
        )


class SameModelAttemptsOnly(unittest.TestCase):
    def burst(self, controls, model="claude-opus-5"):
        return mod.discriminate([
            run(0, "failed", agent="a", error=OAUTH_TEXT, model=model),
            *controls,
            run(6, "failed", agent="a", error=OAUTH_TEXT, model=model),
        ])["bursts"][0]

    def test_other_model_success_is_not_recovery(self):
        b = self.burst([run(3, "succeeded", agent="a", model="gpt-6-astra")])
        self.assertEqual(b["verdict"], "INSUFFICIENT")
        self.assertEqual(b["recovered_same_agents"], [])

    def test_other_model_failures_cannot_escalate(self):
        b = self.burst([run(m, "failed", model="other", error=ATTEMPT_ERROR)
                        for m in (2, 4)])
        self.assertEqual(b["verdict"], "INSUFFICIENT")
        self.assertEqual(b["control_runs"], 0)

    def test_missing_model_success_is_not_recovery(self):
        b = self.burst([run(3, "succeeded", model=None)])
        self.assertEqual(b["verdict"], "INSUFFICIENT")

    def test_unknown_denial_identity_never_matches_unknown_controls(self):
        b = self.burst([run(m, "failed", model=None, error=ATTEMPT_ERROR)
                        for m in (2, 4)], model=None)
        self.assertEqual(b["verdict"], "INSUFFICIENT")

    def test_unknown_denials_remain_findings_despite_success(self):
        b = self.burst([run(3, "succeeded", agent="a", model=None)], model=None)
        self.assertEqual(b["verdict"], "INSUFFICIENT")
        self.assertIsNone(b["model"])

    def test_worktree_abort_is_not_a_control_even_with_stale_usage(self):
        b = self.burst([run(m, "failed", error=WORKTREE_TEXT) for m in (2, 4)])
        self.assertEqual(b["verdict"], "INSUFFICIENT")
        self.assertEqual(b["control_runs"], 0)

    def test_configuration_failure_is_not_a_control(self):
        b = self.burst([run(m, "failed", error="configuration incomplete")
                        for m in (2, 4)])
        self.assertEqual(b["verdict"], "INSUFFICIENT")

    def test_zero_usage_failures_do_not_prove_attempts(self):
        b = self.burst([run(m, "failed", error=ATTEMPT_ERROR, tokens=0)
                        for m in (2, 4)])
        self.assertEqual(b["verdict"], "INSUFFICIENT")

    def test_zero_usage_success_does_not_prove_attempt(self):
        b = self.burst([run(3, "succeeded", tokens=0)])
        self.assertEqual(b["verdict"], "INSUFFICIENT")

    def test_missing_or_invalid_usage_is_not_positive_evidence(self):
        for usage in (None, [], {}, {"model": []}, {"model": " "},
                      {"model": "claude-opus-5", "inputTokens": True},
                      {"model": "claude-opus-5", "inputTokens": "10"},
                      {"model": "claude-opus-5", "inputTokens": float("inf")}):
            with self.subTest(usage=usage):
                control = run(3, "succeeded")
                control["usageJson"] = usage
                self.assertEqual(self.burst([control])["verdict"], "INSUFFICIENT")

    def test_output_only_and_cached_only_are_positive_evidence(self):
        for key in ("outputTokens", "cachedInputTokens"):
            with self.subTest(key=key):
                control = run(3, "succeeded", tokens=0)
                control["usageJson"][key] = 12
                self.assertEqual(self.burst([control])["verdict"], "INTERMITTENT")

    def test_other_model_denial_cannot_extend_window(self):
        rows = [run(0, "failed", error=OAUTH_TEXT),
                run(6, "succeeded"),
                run(12, "failed", error=OAUTH_TEXT, model="other")]
        bursts = mod.discriminate(rows)["bursts"]
        self.assertEqual(len(bursts), 2)
        self.assertEqual([b["verdict"] for b in bursts],
                         ["INSUFFICIENT", "INSUFFICIENT"])

    def test_model_bursts_have_independent_counts(self):
        rows = [run(m, "failed", error=OAUTH_TEXT, model=model)
                for m, model in ((0, "a"), (1, "b"), (4, "a"), (5, "b"))]
        bursts = mod.discriminate(rows)["bursts"]
        self.assertEqual([(b["model"], b["denials"]) for b in bursts],
                         [("a", 2), ("b", 2)])

    def test_success_before_same_agent_denial_is_not_recovery(self):
        rows = [run(0, "failed", agent="a", error=OAUTH_TEXT),
                run(3, "succeeded", agent="b"),
                run(6, "failed", agent="b", error=OAUTH_TEXT)]
        b = mod.discriminate(rows)["bursts"][0]
        self.assertEqual(b["verdict"], "INTERMITTENT")
        self.assertEqual(b["recovered_same_agents"], [])


class CommandLineContract(unittest.TestCase):
    def cli(self, payload, *args):
        return subprocess.run(
            [sys.executable, "-B", os.path.join(HERE, "auth_denial_discriminator.py"),
             "--input", "-", *args], input=json.dumps(payload),
            text=True, capture_output=True, timeout=10,
            env={"PATH": os.environ.get("PATH", "")},
        )

    def test_clean_stdin_is_exit_zero_and_silent(self):
        result = self.cli([run(3, "succeeded")])
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "")

    def test_real_fixture_cli_is_insufficient(self):
        with open(INCIDENT) as fh:
            result = self.cli(json.load(fh), "--json")
        self.assertEqual(result.returncode, 4)
        b = json.loads(result.stdout)["bursts"][0]
        self.assertEqual((b["model"], b["denials"], b["control_runs"]),
                         ("claude-opus-5", 8, 0))

    def test_unknown_payload_is_error_not_silence(self):
        result = self.cli({"error": "unavailable"})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")

    def test_cli_cannot_lower_control_floor(self):
        self.assertEqual(self.cli([], "--min-control-runs", "1").returncode, 1)

    def test_invalid_timestamp_is_error(self):
        self.assertEqual(self.cli([], "--since", "garbage").returncode, 1)

    def test_empty_and_wrapped_lists_are_valid(self):
        for payload in ([], {"runs": []}, {"items": []}):
            with self.subTest(payload=payload):
                self.assertEqual(self.cli(payload).returncode, 0)

    def test_api_reader_uses_only_history_get(self):
        from io import BytesIO
        with patch.object(mod.urllib.request, "urlopen", return_value=BytesIO(b'[]')) as fetch:
            self.assertEqual(mod.fetch_runs("https://board.test/api", "test-value", "company", 200), [])
        request = fetch.call_args.args[0]
        self.assertEqual(request.full_url,
                         "https://board.test/api/companies/company/heartbeat-runs?limit=200")
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(fetch.call_count, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
