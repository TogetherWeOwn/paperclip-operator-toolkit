#!/usr/bin/env python3
"""Supplementary fault-coverage tests for pr_hygiene_sweep.py.

These complement (and never edit) the frozen acceptance suite
test_pr_hygiene_fault_visibility.py: they pin the wider fault-visibility
behaviour the sweep docstring claims -- board api/api_get status handling,
sql() faults, the GitHub breaker, the fail-closed live-work guard and its
redaction, mint failure, cooldown, MAX_NUDGES, the parked guard,
blocked->todo, PAUSE, the run lock, torn state, dry-run, and board rows
whose agent name contains the field separator.

Stdlib only, offline; reuses the acceptance harness by import.
"""

import json
import os
import subprocess
import sys
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pr_hygiene_sweep as sweep
import test_pr_hygiene_fault_visibility as base


def http_error(code):
    return urllib.error.HTTPError("https://api.github.com/x", code, "err", {}, None)


def curl_proc(stdout, returncode=0):
    def run(argv, **kwargs):
        return subprocess.CompletedProcess(argv, returncode, stdout, "")
    return run


class Coverage(base.SweepCase):
    def run_main(self, *args):
        return sweep.main(list(args))

    # --- Finding 1: listing shapes that used to read as clean ---

    def test_org_listing_404_is_a_fault(self):
        self.net.route("orgs/", http_error(404))
        self.assertEqual(self.run_main(), 1)
        self.assertTrue(any("HTTP 404" in f for f in sweep.RUN["faults"]),
                        "the org 404 itself must be a counted fault, not only the empty result")
        self.assertEqual(self.proc.board_writes(), [])

    def test_org_listing_empty_is_a_fault(self):
        self.net.route("orgs/", [])
        self.assertEqual(self.run_main(), 1)
        self.assertIn("org discovery returned no repositories", self.log_text())

    def test_org_listing_nonlist_body_is_a_fault(self):
        self.net.route("orgs/", {"unexpected": "object"})
        self.assertEqual(self.run_main(), 1)
        self.assertTrue(any("non-list" in f for f in sweep.RUN["faults"]))

    def test_pulls_listing_nonlist_body_is_a_fault(self):
        self.route_org()
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls?state=open", {"unexpected": 1})
        self.assertEqual(self.run_main(), 1)
        self.assertIn("FAULT", self.log_text())

    def test_pulls_listing_404_is_a_logged_miss(self):
        self.route_org()
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls?state=open", http_error(404))
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(sweep.RUN["faults"], [])

    # --- Board api / api_get ---

    def test_api_curl_refused_sets_breaker_and_faults(self):
        with mock.patch("subprocess.run", curl_proc("", returncode=7)):
            self.assertEqual(sweep.api("PATCH", "issues/x", {}), {"_err": "curl-7"})
        self.assertTrue(sweep.RUN["api_down"])
        self.assertEqual(len(sweep.RUN["faults"]), 1)

    def test_api_non2xx_is_a_fault(self):
        with mock.patch("subprocess.run", curl_proc('{"e":1}\n500')):
            self.assertEqual(sweep.api("PATCH", "issues/x", {}), {"_err": "http-500"})
        self.assertEqual(len(sweep.RUN["faults"]), 1)

    def test_api_invalid_trailer_is_a_fault(self):
        with mock.patch("subprocess.run", curl_proc('{"id":"x"} no-trailer')):
            self.assertEqual(sweep.api("PATCH", "issues/x", {}), {"_err": "invalid-status"})
        self.assertEqual(len(sweep.RUN["faults"]), 1)

    def test_api_get_5xx_is_a_fault(self):
        with mock.patch("subprocess.run", curl_proc('err\n503')):
            self.assertIsNone(sweep.api_get("issues/x"))
        self.assertEqual(len(sweep.RUN["faults"]), 1)

    # --- sql() ---

    def test_sql_timeout_sets_breaker_and_faults(self):
        def boom(argv, **kwargs):
            raise subprocess.TimeoutExpired(argv, 60)
        with mock.patch("subprocess.run", boom):
            self.assertIsNone(sweep.sql("select 1"))
        self.assertTrue(sweep.RUN["sql_down"])
        self.assertEqual(len(sweep.RUN["faults"]), 1)

    def test_sql_nonzero_is_a_fault(self):
        with mock.patch("subprocess.run", curl_proc("", returncode=2)):
            # curl_proc builds stdout-only process; stderr attr exists as ""
            self.assertIsNone(sweep.sql("select 1"))
        self.assertEqual(len(sweep.RUN["faults"]), 1)

    # --- GitHub breaker ---

    def test_gh_breaker_opens_after_three_faults(self):
        self.net.route("x", http_error(500))
        for _ in range(3):
            sweep.gh("x")
        calls_before = len(self.net.calls)
        self.assertEqual(sweep.gh("x"), {"_err": "skipped"})
        self.assertEqual(len(self.net.calls), calls_before)

    # --- Live-work guard ---

    def test_live_work_guard_fails_closed_on_psql_error(self):
        proc = subprocess.CompletedProcess(["docker"], 1, "f", "boom")
        with mock.patch("subprocess.run", return_value=proc):
            self.assertTrue(sweep.issue_has_live_work(base.IID),
                            "a non-zero psql exit must fail closed even when stdout says 'f'")
        proc2 = subprocess.CompletedProcess(["docker"], 0, "maybe", "")
        with mock.patch("subprocess.run", return_value=proc2):
            self.assertTrue(sweep.issue_has_live_work(base.IID))

    def test_live_work_fault_redacts_token_shapes(self):
        sweep.live_work_fault("lookup failed ghp_" + "A" * 20)
        self.assertNotIn("ghp_" + "A" * 20, self.log_text())
        self.assertTrue(sweep.RUN["sql_down"])
        self.assertEqual(len(sweep.RUN["faults"]), 1)

    # --- Mint, cooldown, caps and guards through main() ---

    def test_mint_failure_exits_one(self):
        def run(argv, **kwargs):
            if argv[0] == "bash":
                raise subprocess.CalledProcessError(1, argv)
            return self.proc(argv, **kwargs)
        with mock.patch("subprocess.run", run):
            self.assertEqual(self.run_main(), 1)

    def _patch_capture(self, patch_body):
        captured = []
        orig = self.proc
        def run(argv, **kwargs):
            if argv[0] == "curl" and "-X" in argv:
                captured.append(argv[argv.index("-d") + 1] if "-d" in argv else "")
                trailer = "\n200"
                return subprocess.CompletedProcess(argv, 0, json.dumps(patch_body) + trailer, "")
            return orig(argv, **kwargs)
        return captured, run

    def test_cooldown_after_failed_patch(self):
        self.route_one_green_pr()
        captured, run = self._patch_capture({})
        with mock.patch("subprocess.run", run):
            self.assertEqual(self.run_main(), 0)
            self.assertEqual(self.run_main(), 0)
        self.assertEqual(len(captured), 1, "a failed PATCH must still observe the cooldown")

    def test_max_nudges_caps_writes(self):
        self.route_org()
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls?state=open",
                       [base.pull_list(7)[0], base.pull_list(8)[0]])
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls/7", base.pull_detail())
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls/8", base.pull_detail())
        self.proc.docker = self.docker_rows
        products = [{"type": "pull_request", "provider": "github", "status": "active",
                     "externalId": f"{base.ORG_REPO}#{n}", "url": None} for n in (7, 8)]
        self.proc.curl_get = {f"issues/{base.IID}": {"id": base.IID, "executionWorkspaceId": None, "projectId": None},
                              f"issues/{base.IID}/work-products": products}
        with mock.patch.object(sweep, "MAX_NUDGES", 1):
            self.assertEqual(self.run_main(), 0)
        self.assertEqual(len(self.proc.board_writes()), 1)

    def test_parked_blocked_card_is_not_nudged(self):
        self.route_one_green_pr()
        self.proc.docker = lambda q: "f" if "heartbeat_runs" in q else f"{base.IID}|{base.REF}|blocked|Some Agent|f"
        self.proc.curl_get[f"issues/{base.IID}"] = {"id": base.IID, "executionWorkspaceId": None,
                                                    "projectId": None, "monitorNextCheckAt": "2099-01-01"}
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.proc.board_writes(), [])

    def test_blocked_card_moves_to_todo_on_nudge(self):
        self.route_one_green_pr()
        self.proc.docker = lambda q: "f" if "heartbeat_runs" in q else f"{base.IID}|{base.REF}|blocked|Some Agent|f"
        captured, run = self._patch_capture({"id": base.IID})
        # route_one_green_pr's Proc answers PATCH itself; replace it fully.
        orig = self.proc
        def run2(argv, **kwargs):
            if argv[0] == "curl" and "-X" in argv:
                captured.append(argv[argv.index("-d") + 1])
                return subprocess.CompletedProcess(argv, 0, json.dumps({"id": base.IID}) + "\n200", "")
            return orig(argv, **kwargs)
        with mock.patch("subprocess.run", run2):
            self.assertEqual(self.run_main(), 0)
        self.assertIn('"status": "todo"', captured[0])

    def test_pause_file_stops_the_run(self):
        with open(sweep.PAUSE, "w") as f:
            f.write("")
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.net.calls, [])

    def test_run_lock_blocks_a_second_holder(self):
        first = sweep.acquire_run_lock(sweep.LOCK)
        self.assertIsNotNone(first)
        try:
            self.assertIsNone(sweep.acquire_run_lock(sweep.LOCK))
        finally:
            first.close()

    def test_torn_state_is_a_fault(self):
        with open(sweep.STATE, "w") as f:
            f.write("{torn")
        self.assertEqual(sweep.load_state(), {})
        self.assertEqual(len(sweep.RUN["faults"]), 1)

    def test_state_write_failure_is_a_fault(self):
        sweep.atomic_write_state("/nonexistent-dir-xyz/state.json", {})
        self.assertEqual(len(sweep.RUN["faults"]), 1)

    def test_dry_run_writes_nothing(self):
        self.route_one_green_pr()
        self.assertEqual(self.run_main("--dry-run"), 0)
        self.assertEqual(self.proc.board_writes(), [])

    # --- Board row parsing (finding 5) ---

    def test_agent_name_with_pipe_still_nudges(self):
        self.route_one_green_pr()
        self.proc.docker = lambda q: "f" if "heartbeat_runs" in q else f"{base.IID}|{base.REF}|todo|Ops | Agent|f"
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(len(self.proc.board_writes()), 1)

    def test_malformed_board_row_is_a_fault_not_a_crash(self):
        self.route_one_green_pr()
        self.proc.docker = lambda q: "f" if "heartbeat_runs" in q else "only|two"
        self.assertEqual(self.run_main(), 1)
        self.assertIn("FAULT", self.log_text())
        self.assertEqual(self.proc.board_writes(), [])

    def test_draft_and_release_please_are_skipped(self):
        self.route_org()
        draft = dict(base.pull_list(7)[0]); draft["draft"] = True
        rel = dict(base.pull_list(8)[0]); rel["head"] = {"ref": "release-please--branches--main"}
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls?state=open", [draft, rel])
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.proc.board_writes(), [])


if __name__ == "__main__":
    unittest.main()
