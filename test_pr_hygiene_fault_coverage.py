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

import http.client
import json
import os
import subprocess
import sys
import time
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
        for prefix in ("ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"):
            with self.subTest(prefix=prefix):
                sweep.reset_run()
                token = prefix + "A" * 20
                sweep.live_work_fault("lookup failed " + token)
                self.assertNotIn(token, self.log_text())
                self.assertTrue(sweep.RUN["sql_down"])
                self.assertEqual(len(sweep.RUN["faults"]), 1)

    def test_api_curl_hang_sets_breaker(self):
        for code in (7, 28):
            with self.subTest(code=code):
                sweep.reset_run()
                with mock.patch("subprocess.run", curl_proc("", returncode=code)):
                    self.assertEqual(sweep.api("PATCH", "issues/x", {}), {"_err": f"curl-{code}"})
                self.assertTrue(sweep.RUN["api_down"])

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

    # --- Finding 1 (round 2): live-run deferral and owner-trust gates ---

    def test_live_run_defers_nudge(self):
        self.route_one_green_pr()
        self.proc.docker = lambda q: "t" if "heartbeat_runs" in q else f"{base.IID}|{base.REF}|todo|Some Agent|f"
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.proc.board_writes(), [])
        self.assertIn("deferred:", self.log_text())

    def test_live_work_guard_returns_live_only_on_t(self):
        for out, expected in (("t", True), ("f", False)):
            with mock.patch("subprocess.run", return_value=subprocess.CompletedProcess(["docker"], 0, out, "")):
                self.assertIs(sweep.issue_has_live_work(base.IID), expected)

    def test_live_work_guard_rejects_invalid_issue_id(self):
        proc = subprocess.CompletedProcess(["docker"], 0, "f", "")
        with mock.patch("subprocess.run", return_value=proc):
            self.assertTrue(sweep.issue_has_live_work("not-a-uuid"),
                            "an invalid id must fail closed, never read as no live work")
            self.assertTrue(sweep.issue_has_live_work(""))

    def test_sql_down_break_stops_remaining_nudges(self):
        self.route_org()
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls?state=open",
                       [base.pull_list(7)[0], base.pull_list(8)[0]])
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls/7", base.pull_detail())
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls/8", base.pull_detail())
        guard_calls = []
        def docker(q):
            if "heartbeat_runs" in q:
                guard_calls.append(q)
                return subprocess.CompletedProcess(["docker"], 1, "", "boom")
            return f"{base.IID}|{base.REF}|todo|Some Agent|f"
        self.proc.docker = docker
        products = [{"type": "pull_request", "provider": "github", "status": "active",
                     "externalId": f"{base.ORG_REPO}#{n}", "url": None} for n in (7, 8)]
        self.proc.curl_get = {f"issues/{base.IID}": {"id": base.IID, "executionWorkspaceId": None, "projectId": None},
                              f"issues/{base.IID}/work-products": products}
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.proc.board_writes(), [])
        self.assertIn("remaining nudges deferred", self.log_text())
        self.assertEqual(len(guard_calls), 1, "the sql_down break must stop guard calls for later nudges")

    @staticmethod
    def _card(products, workspace_repo=None, project_repos=None, identifier=None, iid=None):
        return {"iid": iid or base.IID, "identifier": identifier or base.REF, "status": "todo",
                "agent": "Some Agent", "has_edge": "f", "products": products,
                "workspace_repo": workspace_repo, "project_repos": project_repos or []}

    @staticmethod
    def _product(number=7, **over):
        product = {"type": "pull_request", "provider": "github", "status": "active",
                   "externalId": f"{base.ORG_REPO}#{number}", "url": None}
        product.update(over)
        return product

    def _choose(self, cards, branch=None, head_repo=None):
        pr = {"repo": base.ORG_REPO, "number": 7, "branch": branch or (base.REF + "-fix"),
              "head_repo": base.ORG_REPO if head_repo is None else head_repo}
        return sweep.choose_owner(pr, cards)

    def test_owner_fork_branch_card_is_rejected(self):
        card = self._card([], workspace_repo=f"https://github.com/{base.ORG_REPO}")
        owner, why = self._choose([card], head_repo="someone/example-repo")
        self.assertIsNone(owner)
        self.assertIn("another repo", why)

    def test_owner_unregistered_branch_card_is_rejected(self):
        card = self._card([], workspace_repo="https://github.com/TogetherWeOwn/other-repo")
        owner, why = self._choose([card])
        self.assertIsNone(owner)
        self.assertIn("not registered", why)

    def test_owner_two_trusted_cards_are_ambiguous(self):
        iid2 = "22222222-3333-4444-5555-666666666666"
        cards = [self._card([self._product()]),
                 self._card([self._product()], identifier="TO" + "G-124", iid=iid2)]
        owner, why = self._choose(cards)
        self.assertIsNone(owner)
        self.assertIn("ambiguous", why)

    def test_owner_facts_unavailable_is_refused(self):
        owner, why = self._choose([self._card(None)])
        self.assertIsNone(owner)
        self.assertIn("facts unavailable", why)

    def test_owner_untrusted_products_are_rejected(self):
        cases = [
            self._product(status="merged"),
            self._product(status="closed"),
            self._product(status="archived"),
            self._product(url=f"https://github.com/{base.ORG_REPO}/pull/8"),
            self._product(externalId="bogus!!", url=f"https://github.com/{base.ORG_REPO}/pull/7"),
            self._product(provider="gitlab"),
            self._product(type="issue"),
        ]
        for product in cases:
            with self.subTest(product=product):
                owner, _why = self._choose([self._card([product])])
                self.assertIsNone(owner)

    def test_owner_branch_name_boundary(self):
        card = self._card([], workspace_repo=f"https://github.com/{base.ORG_REPO}")
        owner, _why = self._choose([card], branch=base.REF + "9-fix")
        self.assertIsNone(owner, base.REF + "9 must not name the " + base.REF + " card")
        owner, _why = self._choose([card], branch=base.REF + "-fix")
        self.assertIsNotNone(owner)

    def test_owner_branch_left_boundary(self):
        card = self._card([], workspace_repo=f"https://github.com/{base.ORG_REPO}")
        owner, _why = self._choose([card], branch="X" + base.REF + "-fix")
        self.assertIsNone(owner, "a letter glued to the left of the id must not name the card")
        owner, _why = self._choose([card], branch=base.REF + "-fix")
        self.assertIsNotNone(owner)

    def test_owner_workspace_repo_takes_precedence_over_project(self):
        card = self._card([], workspace_repo="https://github.com/TogetherWeOwn/other-repo",
                          project_repos=[f"https://github.com/{base.ORG_REPO}"])
        owner, why = self._choose([card])
        self.assertIsNone(owner)
        self.assertIn("not registered", why)

    def test_board_query_filters_are_pinned(self):
        self.route_one_green_pr()
        self.assertEqual(self.run_main(), 0)
        queries = [argv[argv.index("-c") + 1] for argv, _ in self.proc.calls
                   if argv[0] == "docker" and "from issues" in argv[argv.index("-c") + 1]]
        self.assertEqual(len(queries), 1)
        query = queries[0]
        for fragment in (f"i.company_id='{sweep.C}'", "i.status not in ('done','cancelled')",
                         "i.assignee_agent_id is not null", "ir.type='blocks'",
                         "join issues b on b.id=ir.issue_id", "where ir.related_issue_id=i.id",
                         "b.status not in ('done','cancelled')"):
            self.assertIn(fragment, query)

    def _route_pr(self, detail, check_runs=None):
        self.route_org()
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls?state=open", base.pull_list())
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls/7", detail)
        if check_runs is not None:
            self.net.route(f"repos/TogetherWeOwn/{base.REPO}/commits/{base.SHA}/check-runs",
                           {"check_runs": check_runs})
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/compare/main...{base.SHA}", {"behind_by": 3})
        self.proc.docker = self.docker_rows
        self.proc.curl_get = {f"issues/{base.IID}": {"id": base.IID, "executionWorkspaceId": None, "projectId": None},
                              f"issues/{base.IID}/work-products": [self._product()]}

    def test_red_timed_out_check_is_a_red_nudge(self):
        self._route_pr(base.pull_detail("unstable"),
                       check_runs=[{"name": "ci-slow", "conclusion": "timed_out"}])
        captured, run = self._patch_capture({"id": base.IID})
        with mock.patch("subprocess.run", run):
            self.assertEqual(self.run_main(), 0)
        self.assertEqual(len(captured), 1)
        comment = json.loads(captured[0])["comment"]
        self.assertIn("failing CI", comment)
        self.assertIn("ci-slow", comment)

    def test_owner_project_repo_fallback_is_trusted(self):
        card = self._card([], workspace_repo=None,
                          project_repos=[f"https://github.com/{base.ORG_REPO}"])
        owner, _why = self._choose([card])
        self.assertIsNotNone(owner)

    def test_owner_missing_head_repo_does_not_crash(self):
        pr = {"repo": base.ORG_REPO, "number": 7, "branch": base.REF + "-fix", "head_repo": None}
        owner, _why = sweep.choose_owner(pr, [self._card([self._product()])])
        self.assertIsNotNone(owner)

    def test_red_startup_failure_check_is_a_red_nudge(self):
        self._route_pr(base.pull_detail("unstable"),
                       check_runs=[{"name": "ci-boot", "conclusion": "startup_failure"}])
        captured, run = self._patch_capture({"id": base.IID})
        with mock.patch("subprocess.run", run):
            self.assertEqual(self.run_main(), 0)
        self.assertEqual(len(captured), 1)
        self.assertIn("ci-boot", json.loads(captured[0])["comment"])

    def test_blocked_state_pr_with_failing_check_is_red(self):
        self._route_pr(base.pull_detail("blocked"),
                       check_runs=[{"name": "ci", "conclusion": "failure"}])
        captured, run = self._patch_capture({"id": base.IID})
        with mock.patch("subprocess.run", run):
            self.assertEqual(self.run_main(), 0)
        self.assertEqual(len(captured), 1)
        self.assertIn("failing CI", json.loads(captured[0])["comment"])

    def test_unstable_all_green_checks_are_not_nudged(self):
        self._route_pr(base.pull_detail("unstable"),
                       check_runs=[{"name": "ci", "conclusion": "success"}])
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.proc.board_writes(), [])

    def test_red_nameless_failing_check_does_not_crash(self):
        self._route_pr(base.pull_detail("unstable"),
                       check_runs=[{"conclusion": "failure"},
                                   {"name": "ci", "conclusion": "failure"}])
        captured, run = self._patch_capture({"id": base.IID})
        with mock.patch("subprocess.run", run):
            self.assertEqual(self.run_main(), 0)
        self.assertEqual(len(captured), 1)
        self.assertIn("ci", json.loads(captured[0])["comment"])

    def test_dirty_pr_reports_compare_behind_count(self):
        self._route_pr(base.pull_detail("dirty"))
        captured, run = self._patch_capture({"id": base.IID})
        with mock.patch("subprocess.run", run):
            self.assertEqual(self.run_main(), 0)
        self.assertEqual(len(captured), 1)
        self.assertIn("3 commits behind", json.loads(captured[0])["comment"])

    # --- Finding 2: PR-controlled text is sanitized in the comment ---

    def test_comment_sanitizes_pr_controlled_text(self):
        detail = base.pull_detail("unstable")
        detail["head"]["ref"] = "bad`ref\n@evil"
        self._route_pr(detail, check_runs=[{"name": "evil check\n@evil`x", "conclusion": "failure"}])
        captured, run = self._patch_capture({"id": base.IID})
        with mock.patch("subprocess.run", run):
            self.assertEqual(self.run_main(), 0)
        self.assertEqual(len(captured), 1)
        comment = json.loads(captured[0])["comment"]
        self.assertNotIn("bad`ref", comment)
        self.assertNotIn("@evil", comment)
        self.assertNotIn("evil check", comment)
        self.assertIn("bad_ref__evil", comment)
        self.assertIn("evil_check__evil_x", comment)

    # --- Finding 3: every subprocess call carries a timeout ---

    def _calls_of(self, program):
        return [(argv, kwargs) for argv, kwargs in self.proc.calls if argv[0] == program]

    def test_mint_call_carries_a_timeout(self):
        self.route_one_green_pr()
        self.assertEqual(self.run_main(), 0)
        calls = self._calls_of("bash")
        self.assertTrue(calls)
        for _argv, kwargs in calls:
            self.assertEqual(kwargs.get("timeout"), sweep.MINT_TIMEOUT)

    def test_docker_calls_carry_timeouts(self):
        self.route_one_green_pr()
        self.assertEqual(self.run_main(), 0)
        calls = self._calls_of("docker")
        self.assertGreaterEqual(len(calls), 2, "board sql and the live-work guard both shell to docker")
        for argv, kwargs in calls:
            query = argv[argv.index("-c") + 1]
            expected = 30 if "heartbeat_runs" in query else sweep.SQL_TIMEOUT
            self.assertEqual(kwargs.get("timeout"), expected, query[:60])

    def test_curl_calls_carry_timeouts(self):
        self.route_one_green_pr()
        self.assertEqual(self.run_main(), 0)
        calls = self._calls_of("curl")
        self.assertGreaterEqual(len(calls), 2, "board api_get facts and the api PATCH both shell to curl")
        for argv, kwargs in calls:
            self.assertEqual(kwargs.get("timeout"), sweep.API_TIMEOUT)
            self.assertEqual(argv[argv.index("-m") + 1], "90")

    # --- Round 3 finding 1: fork/branch wiring into choose_owner, end to end ---

    def _route_branch_pr(self, head_repo_name):
        self.route_org()
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls?state=open", base.pull_list())
        detail = base.pull_detail()
        detail["body"] = ""
        detail["head"]["repo"] = None if head_repo_name is None else {"full_name": head_repo_name}
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls/7", detail)
        self.proc.docker = self.docker_rows
        self.proc.curl_get = {
            f"issues/{base.IID}": {"id": base.IID, "executionWorkspaceId": "ws-1", "projectId": None},
            f"issues/{base.IID}/work-products": [],
            "execution-workspaces/ws-1": {"id": "ws-1", "repoUrl": f"https://github.com/{base.ORG_REPO}"},
        }

    def test_fork_pr_branch_card_is_not_nudged_end_to_end(self):
        self._route_branch_pr("attacker/example-repo")
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.proc.board_writes(), [],
                         "a fork PR whose branch names a card must never steer a board write")

    def test_same_repo_branch_card_is_nudged_end_to_end(self):
        self._route_branch_pr(base.ORG_REPO)
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(len(self.proc.board_writes()), 1)

    def test_deleted_fork_pr_branch_card_is_not_nudged_end_to_end(self):
        self._route_branch_pr(None)
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.proc.board_writes(), [],
                         "a deleted fork (head.repo null) must never steer a board write")

    # --- Round 4 finding 2: board-fact id validation ---

    def _route_facts_pr(self, issue, extra_get=None):
        self.route_org()
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls?state=open", base.pull_list())
        detail = base.pull_detail()
        detail["body"] = ""
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls/7", detail)
        self.proc.docker = self.docker_rows
        self.proc.curl_get = {f"issues/{base.IID}": issue,
                              f"issues/{base.IID}/work-products": []}
        self.proc.curl_get.update(extra_get or {})

    def test_board_facts_issue_id_mismatch_is_a_fault(self):
        self._route_facts_pr({"id": "99999999-8888-7777-6666-555555555555",
                              "executionWorkspaceId": None, "projectId": None})
        self.assertEqual(self.run_main(), 1)
        self.assertTrue(any("board facts invalid" in f for f in sweep.RUN["faults"]))
        self.assertEqual(self.proc.board_writes(), [])

    def test_board_facts_workspace_id_mismatch_is_a_fault(self):
        self._route_facts_pr(
            {"id": base.IID, "executionWorkspaceId": "ws-1", "projectId": None},
            {"execution-workspaces/ws-1": {"id": "ws-2",
                                           "repoUrl": f"https://github.com/{base.ORG_REPO}"}})
        self.assertEqual(self.run_main(), 1)
        self.assertTrue(any("board facts invalid" in f for f in sweep.RUN["faults"]))
        self.assertEqual(self.proc.board_writes(), [])

    def test_board_facts_project_id_mismatch_is_a_fault(self):
        self._route_facts_pr(
            {"id": base.IID, "executionWorkspaceId": None, "projectId": "proj-1"},
            {"projects/proj-1": {"id": "proj-2",
                                 "workspaces": [{"repoUrl": f"https://github.com/{base.ORG_REPO}"}]}})
        self.assertEqual(self.run_main(), 1)
        self.assertTrue(any("board facts invalid" in f for f in sweep.RUN["faults"]))
        self.assertEqual(self.proc.board_writes(), [])

    # --- Round 4 finding 5: cooldown and prune boundaries ---

    def _seed_cooldown(self, age_seconds):
        key = f"{base.REPO}#7@{base.SHA[:10]}:green"
        with open(sweep.STATE, "w") as f:
            json.dump({key: time.time() - age_seconds}, f)

    def test_cooldown_five_hour_old_key_blocks_nudge(self):
        self.route_one_green_pr()
        self._seed_cooldown(5 * 3600)
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.proc.board_writes(), [],
                         "a nudge 5h ago is inside the 6h cooldown")

    def test_cooldown_seven_hour_old_key_allows_nudge(self):
        self.route_one_green_pr()
        self._seed_cooldown(7 * 3600)
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(len(self.proc.board_writes()), 1,
                         "a nudge 7h ago is outside the 6h cooldown")

    def test_load_state_prunes_entries_older_than_24h(self):
        now = time.time()
        with open(sweep.STATE, "w") as f:
            json.dump({"fresh": now - 23 * 3600, "stale": now - 25 * 3600}, f)
        state = sweep.load_state()
        self.assertIn("fresh", state)
        self.assertNotIn("stale", state)

    # --- Round 3 finding 2: live-work SQL predicate text ---

    def test_live_work_sql_predicate_is_pinned(self):
        captured = []
        def run(argv, **kwargs):
            captured.append(argv[argv.index("-c") + 1])
            return subprocess.CompletedProcess(argv, 0, "f", "")
        with mock.patch("subprocess.run", run):
            self.assertFalse(sweep.issue_has_live_work(base.IID))
        self.assertEqual(len(captured), 1)
        query = captured[0]
        for fragment in ("'queued'", "'running'", "'scheduled_retry'",
                         "h.context_snapshot->>'issueId'", "h.context_snapshot->>'taskId'",
                         base.IID):
            self.assertIn(fragment, query)

    # --- Round 3 finding 3: blocked->todo guards ---

    def _route_blocked(self, has_edge="f", **issue_over):
        self.route_one_green_pr()
        self.proc.docker = lambda q: "f" if "heartbeat_runs" in q else (
            f"{base.IID}|{base.REF}|blocked|Some Agent|{has_edge}")
        if issue_over:
            issue = dict(self.proc.curl_get[f"issues/{base.IID}"])
            issue.update(issue_over)
            self.proc.curl_get[f"issues/{base.IID}"] = issue

    def test_blocked_with_open_edge_keeps_blocked_status(self):
        self._route_blocked(has_edge="t")
        captured, run = self._patch_capture({"id": base.IID})
        with mock.patch("subprocess.run", run):
            self.assertEqual(self.run_main(), 0)
        self.assertEqual(len(captured), 1)
        body = json.loads(captured[0])
        self.assertIn("comment", body)
        self.assertNotIn("status", body,
                         "a card waiting on an open blocker must not be flipped to todo")

    def test_blocked_parked_via_unblock_descriptor_is_not_nudged(self):
        self._route_blocked(unblockDescriptor="waiting on an external reply")
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.proc.board_writes(), [])

    def test_blocked_parked_via_parked_until_line_is_not_nudged(self):
        self._route_blocked(description="Notes\nParked until the owner replies\n")
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.proc.board_writes(), [])

    def test_blocked_parked_via_do_not_mutate_line_is_not_nudged(self):
        self._route_blocked(description="Do not mutate this card while parked\n")
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.proc.board_writes(), [])

    # --- Round 3 finding 4: run-continuity and state-heal guards ---

    def test_pr_detail_404_skips_that_pr_and_nudges_others(self):
        self.route_org()
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls?state=open",
                       [base.pull_list(7)[0], base.pull_list(8)[0]])
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls/7", http_error(404))
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls/8", base.pull_detail())
        self.proc.docker = self.docker_rows
        self.proc.curl_get = {f"issues/{base.IID}": {"id": base.IID, "executionWorkspaceId": None, "projectId": None},
                              f"issues/{base.IID}/work-products": [self._product(8)]}
        self.assertEqual(self.run_main(), 0)
        self.assertIn("PR detail unavailable", self.log_text())
        self.assertEqual(len(self.proc.board_writes()), 1)

    def test_pr_without_tracker_id_issues_no_board_query(self):
        self.route_org()
        item = {"number": 7, "draft": False, "title": "chore: bump dependency",
                "head": {"ref": "dependabot/pip/requests-2"}}
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls?state=open", [item])
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls/7",
                       {"mergeable_state": "clean", "title": "chore: bump dependency", "body": "",
                        "head": {"sha": base.SHA, "ref": "dependabot/pip/requests-2",
                                 "repo": {"full_name": base.ORG_REPO}}})
        self.proc.docker = self.docker_rows
        self.assertEqual(self.run_main(), 0)
        board_queries = [argv for argv, _ in self.proc.calls
                         if argv[0] == "docker" and "from issues" in argv[argv.index("-c") + 1]]
        self.assertEqual(board_queries, [], "a PR with no tracker id must issue no board query")
        self.assertEqual(self.proc.board_writes(), [])

    def test_incomplete_read_on_listing_is_a_counted_fault(self):
        self.net.route("orgs/", http.client.IncompleteRead(b"partial", 10))
        self.assertEqual(self.run_main(), 1)
        self.assertTrue(sweep.RUN["faults"], "a truncated listing body must be a counted fault")

    def test_skipped_patch_records_no_cooldown(self):
        self.route_one_green_pr()
        with mock.patch.object(sweep, "api", return_value={"_err": "skipped"}):
            self.assertEqual(self.run_main(), 0)
        state = {}
        if os.path.exists(sweep.STATE):
            with open(sweep.STATE) as f:
                state = json.load(f)
        self.assertEqual(state, {}, "a PATCH skipped by the board breaker records no cooldown")

    def test_torn_state_heals_on_quiet_run(self):
        self.route_org()
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls?state=open", [])
        with open(sweep.STATE, "w") as f:
            f.write("{torn")
        self.assertEqual(self.run_main(), 1, "the torn state is a counted fault on the first run")
        self.assertEqual(self.run_main(), 0, "the final state save must heal the torn file")

    def test_nonobject_state_is_a_fault_not_a_crash(self):
        with open(sweep.STATE, "w") as f:
            f.write("[]")
        self.assertEqual(sweep.load_state(), {})
        self.assertEqual(len(sweep.RUN["faults"]), 1)

    # --- Round 3 finding 5: sql/board breakers are set and honoured ---

    def test_api_get_curl_hang_sets_breaker(self):
        for code in (7, 28):
            with self.subTest(code=code):
                sweep.reset_run()
                with mock.patch("subprocess.run", curl_proc("", returncode=code)):
                    self.assertIsNone(sweep.api_get("issues/x"))
                self.assertTrue(sweep.RUN["api_down"])

    def test_api_get_timeout_sets_breaker(self):
        def boom(argv, **kwargs):
            raise subprocess.TimeoutExpired(argv, sweep.API_TIMEOUT)
        with mock.patch("subprocess.run", boom):
            self.assertIsNone(sweep.api_get("issues/x"))
        self.assertTrue(sweep.RUN["api_down"])

    def test_api_get_oserror_sets_breaker(self):
        def boom(argv, **kwargs):
            raise OSError("curl missing")
        with mock.patch("subprocess.run", boom):
            self.assertIsNone(sweep.api_get("issues/x"))
        self.assertTrue(sweep.RUN["api_down"])

    def test_api_timeout_and_oserror_set_breaker(self):
        def timeout(argv, **kwargs):
            raise subprocess.TimeoutExpired(argv, sweep.API_TIMEOUT)
        with mock.patch("subprocess.run", timeout):
            self.assertEqual(sweep.api("PATCH", "issues/x", {}), {"_err": "timeout"})
        self.assertTrue(sweep.RUN["api_down"])
        sweep.reset_run()
        def oserror(argv, **kwargs):
            raise OSError("curl missing")
        with mock.patch("subprocess.run", oserror):
            self.assertEqual(sweep.api("PATCH", "issues/x", {}), {"_err": "unavailable"})
        self.assertTrue(sweep.RUN["api_down"])

    def test_sql_oserror_sets_breaker(self):
        def boom(argv, **kwargs):
            raise OSError("docker missing")
        with mock.patch("subprocess.run", boom):
            self.assertIsNone(sweep.sql("select 1"))
        self.assertTrue(sweep.RUN["sql_down"])

    def test_sql_breaker_skips_next_call(self):
        sweep.RUN["sql_down"] = True
        with mock.patch("subprocess.run") as run:
            self.assertIsNone(sweep.sql("select 1"))
        run.assert_not_called()

    def test_api_breaker_skips_next_call(self):
        sweep.RUN["api_down"] = True
        with mock.patch("subprocess.run") as run:
            self.assertEqual(sweep.api("PATCH", "issues/x", {}), {"_err": "skipped"})
        run.assert_not_called()

    def test_api_get_breaker_skips_next_call(self):
        sweep.RUN["api_down"] = True
        with mock.patch("subprocess.run") as run:
            self.assertIsNone(sweep.api_get("issues/x"))
        run.assert_not_called()

    # --- Round 5 findings: owner key, guard exceptions, parsing, headers ---

    def test_owner_product_for_other_pr_or_repo_is_rejected(self):
        cases = [self._product(number=8),
                 self._product(externalId="TogetherWeOwn/other-repo#7")]
        for product in cases:
            with self.subTest(product=product):
                owner, _why = self._choose([self._card([product])])
                self.assertIsNone(owner,
                                  "a well-formed product for another PR/repo must not pick the owner")

    def test_product_for_other_pr_is_not_nudged_end_to_end(self):
        self.route_one_green_pr()
        self.proc.curl_get[f"issues/{base.IID}/work-products"] = [self._product(number=8)]
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.proc.board_writes(), [],
                         "a PR whose body names a card whose only product is for another PR gets no write")

    def test_owner_product_key_strict_parsing_is_pinned(self):
        cases = [
            self._product(externalId="evil/" + base.ORG_REPO + "#7"),
            self._product(externalId=None,
                          url="https://evil.example/https://github.com/" + base.ORG_REPO + "/pull/7"),
            self._product(url="https://example.com/not-a-pr"),
        ]
        for product in cases:
            with self.subTest(product=product):
                owner, _why = self._choose([self._card([product])])
                self.assertIsNone(owner, "embedded, prefixed or unparseable product identity must not be trusted")

    def test_live_work_guard_exception_fails_closed(self):
        errors = [subprocess.TimeoutExpired(["docker"], 30),
                  OSError("docker missing"), RuntimeError("boom")]
        for error in errors:
            with self.subTest(error=type(error).__name__):
                sweep.reset_run()
                seen = []
                with mock.patch("subprocess.run", side_effect=error):
                    self.assertTrue(sweep.issue_has_live_work(base.IID, on_error=seen.append),
                                    "a guard exception must fail closed as live work")
                self.assertEqual(len(seen), 1)

    def test_live_work_guard_exception_in_main_fails_closed(self):
        self.route_one_green_pr()
        orig = self.proc
        def run(argv, **kwargs):
            if argv[0] == "docker" and "heartbeat_runs" in argv[argv.index("-c") + 1]:
                raise OSError("docker missing")
            return orig(argv, **kwargs)
        with mock.patch("subprocess.run", run):
            self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.proc.board_writes(), [])

    def test_gh_sends_bearer_token_header(self):
        captured = {}
        def urlopen(request, *args, **kwargs):
            captured["auth"] = request.get_header("Authorization")
            captured["accept"] = request.get_header("Accept")
            return base.Resp(json.dumps({"ok": 1}).encode())
        with mock.patch.object(sweep.urllib.request, "urlopen", urlopen):
            self.assertEqual(sweep.gh("x"), {"ok": 1})
        self.assertEqual(captured.get("auth"), "Bearer " + base.CANARY)
        self.assertEqual(captured.get("accept"), "application/vnd.github+json")

    # --- Round 5 finding 5: scan scope, check classification, ref sources ---

    def test_archived_repo_is_not_scanned(self):
        self.route_org(repos=[{"name": base.REPO, "archived": True},
                              {"name": "live-repo", "archived": False}])
        self.net.route("repos/TogetherWeOwn/live-repo/pulls?state=open", [])
        self.assertEqual(self.run_main(), 0)
        pulls_calls = [url for url, _timeout in self.net.calls if f"{base.REPO}/pulls" in url]
        self.assertEqual(pulls_calls, [], "an archived repo must never be scanned for PRs")

    def test_cancelled_check_is_not_a_red_nudge(self):
        self._route_pr(base.pull_detail("unstable"),
                       check_runs=[{"name": "ci", "conclusion": "cancelled"},
                                   {"name": "docs", "conclusion": "neutral"}])
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.proc.board_writes(), [],
                         "a cancelled or neutral check must not read as failing CI")

    def test_title_only_reference_is_nudged(self):
        self.route_org()
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls?state=open", base.pull_list())
        detail = base.pull_detail()
        detail["body"] = ""
        detail["title"] = "fix: " + base.REF + " thing"
        detail["head"]["ref"] = "plain-branch"
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls/7", detail)
        self.proc.docker = self.docker_rows
        self.proc.curl_get = {f"issues/{base.IID}": {"id": base.IID, "executionWorkspaceId": None, "projectId": None},
                              f"issues/{base.IID}/work-products": [self._product()]}
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(len(self.proc.board_writes()), 1,
                         "a tracker id carried only by the PR title must still be nudged")

    # --- Round 5 finding 6: dry-run, log, state and sent-count contracts ---

    def test_dry_run_skips_live_work_and_log_file(self):
        self.route_one_green_pr()
        self.assertEqual(self.run_main("--dry-run"), 0)
        self.assertEqual(self.proc.board_writes(), [])
        guard_calls = [argv for argv, _ in self.proc.calls
                       if argv[0] == "docker" and "heartbeat_runs" in argv[argv.index("-c") + 1]]
        self.assertEqual(guard_calls, [], "dry-run must not run the live-work lookup")
        self.assertFalse(os.path.exists(sweep.LOG), "dry-run must not append to the sweep log")

    def test_unwritable_log_does_not_crash_the_sweep(self):
        with mock.patch.object(sweep, "LOG", self.tmp.name), mock.patch.object(sweep, "DRY", False):
            sweep.log("unwritable log probe")
        self.assertIn("unwritable log probe", self.log_text())

    def test_non_numeric_state_value_is_dropped(self):
        with open(sweep.STATE, "w") as f:
            json.dump({"bad": "x", "fresh": time.time()}, f)
        self.assertEqual(set(sweep.load_state()), {"fresh"})

    def test_empty_patch_response_counts_as_not_sent(self):
        self.route_one_green_pr()
        _captured, run = self._patch_capture({})
        with mock.patch("subprocess.run", run):
            self.assertEqual(self.run_main(), 0)
        self.assertIn("sent 0", self.log_text(),
                      "a PATCH response without an id must not count as sent")

    def test_held_lock_exits_zero_with_skip_log(self):
        first = sweep.acquire_run_lock(sweep.LOCK)
        self.assertIsNotNone(first)
        try:
            self.assertEqual(self.run_main(), 0)
        finally:
            first.close()
        self.assertIn("holds the run lock", self.log_text())

    def test_draft_and_release_please_are_skipped(self):
        self.route_org()
        draft = dict(base.pull_list(7)[0]); draft["draft"] = True
        rel = dict(base.pull_list(8)[0]); rel["head"] = {"ref": "release-please--branches--main"}
        self.net.route(f"repos/TogetherWeOwn/{base.REPO}/pulls?state=open", [draft, rel])
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.proc.board_writes(), [])


if __name__ == "__main__":
    unittest.main()
