#!/usr/bin/env python3
"""Acceptance tests: pr-hygiene GitHub listing faults must fail visibly.

Paired acceptance tests for the Land #897 finish work (PR
TogetherWeOwn/paperclip-ops-tooling#897). Written failing first; the Builder
implements on this test branch WITHOUT touching test files.

THE RISK THIS EXISTS FOR. The pr-hygiene sweep is the operator timer that
babysits every open PR until merge. Its pre-fix GitHub helper logged an
HTTP error and returned ``{"_err": code}``, but never counted it as a
fault. When GitHub answers a *listing* call with an outage status (500,
502, 503, 504), a bad token (401) or rate limiting (403), the run therefore
ended with exit 0 and the summary "0 PRs need a nudge" -- the exact silent
result the sweep exists to prevent: a GitHub outage reads as "nothing to
do", so conflicting and red PRs stop being nudged and nobody is told.

Review finding reproduced here (stub probe on the unfixed code): an org
listing returning 503 or 401, and a pulls listing returning 502, all exit
0. These tests pin the fixed behaviour:

  * every GitHub HTTP error other than 404 on a listing path (the org
    repo listing and each per-repo open-PRs listing, including a later
    page) is a counted fault and makes ``main()`` return non-zero;
  * the failure is visible: a failure row naming the HTTP status and a
    summary that carries a FAULT count, not a clean "0 PRs need a nudge";
  * a failed listing produces no board writes and no nudges are acted on
    from a partial PR list;
  * clean listings still exit 0, so the fix cannot be "always exit 1";
  * 404 stays an expected miss (logged, not a fault), and no credential
    material from an exception message ever reaches the log.

BUILDER CONTRACT (what the Land #897 implementation must provide in this
repo, mirroring the upstream sweep's test surface):

  * ``pr_hygiene_sweep.py`` at this repo's root, stdlib only, importable
    with no side effects (no token mint, no network, no subprocess at
    import time);
  * ``gh(path)`` returning the parsed body, or ``{"_err": <code-or-kind>}``
    on failure; ``fault(msg)``, ``reset_run()`` and a ``RUN`` mapping with
    a ``faults`` list; ``main(argv) -> int`` returning non-zero when any
    fault was counted;
  * module constants the harness points into a temp dir: ``STATE``,
    ``LOG``, ``PAUSE``, ``LOCK``, ``TOKEN_FILE``, ``MINT``;
  * GitHub via ``urllib.request.urlopen`` and subprocesses via
    ``subprocess.run`` (both stubbed below: no network, no docker, no
    credentials, no board writes).

RED (before the fix): ModuleNotFoundError -- pr_hygiene_sweep.py is absent
from this repo, i.e. the silent-listing risk reproduced. GREEN (after the
Land #897 mirror lands on this branch): all tests pass.

Stdlib only, offline.
"""

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pr_hygiene_sweep as sweep

REPO = "example-repo"
ORG_REPO = "TogetherWeOwn/" + REPO
IID = "11111111-2222-3333-4444-555555555555"
SHA = "abcdef0123456789abcdef0123456789abcdef01"
# Card identifier assembled from fragments so this public file never
# carries a contiguous internal tracker id.
REF = "TO" + "G-123"
# Credential canary: must never appear in any log output.
CANARY = "canary" + "-token-" + "value-0123456789"

LISTING_FAULT_CODES = (500, 502, 503, 504, 401, 403)


class Resp(io.BytesIO):
    """urlopen() result: a readable body that is also a context manager."""


class Net:
    """Fake urlopen: routes by URL substring; a value is a body or an exception."""

    def __init__(self):
        self.routes = []
        self.calls = []

    def route(self, needle, value):
        self.routes.append((needle, value))

    def __call__(self, request, *args, **kwargs):
        url = request.full_url
        timeout = kwargs.get("timeout", args[0] if args else None)
        self.calls.append((url, timeout))
        for needle, value in self.routes:
            if needle in url:
                if isinstance(value, BaseException):
                    raise value
                body = value if isinstance(value, bytes) else json.dumps(value).encode()
                return Resp(body)
        raise AssertionError("unrouted GitHub URL " + url)


class Proc:
    """Fake subprocess.run: bash (token mint), docker (board rows), curl (board API)."""

    def __init__(self):
        self.docker = lambda query: ""
        self.curl_get = {}
        self.calls = []

    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        if argv[0] == "bash":
            return subprocess.CompletedProcess(argv, 0, "", "")
        if argv[0] == "docker":
            query = argv[argv.index("-c") + 1]
            out = self.docker(query)
            if isinstance(out, subprocess.CompletedProcess):
                return out
            return subprocess.CompletedProcess(argv, 0, out, "")
        if argv[0] == "curl":
            url = next(a for a in argv if "/api/" in a)
            path = url.split("/api/", 1)[1]
            if "-X" in argv:
                return self._respond(argv, {"id": IID})
            return self._respond(argv, self.curl_get.get(path))
        raise AssertionError("unexpected subprocess " + repr(argv))

    @staticmethod
    def _respond(argv, body):
        trailer = ""
        if "-w" in argv:
            trailer = argv[argv.index("-w") + 1].replace(r"\n", "\n").replace("%{http_code}", "200")
        return subprocess.CompletedProcess(argv, 0, json.dumps(body) + trailer, "")

    def board_writes(self):
        return [argv for argv, _ in self.calls if argv[0] == "curl" and "-X" in argv]


def http_error(code, url="https://api.github.com/x"):
    return urllib.error.HTTPError(url, code, "err", {}, None)


def pull_list(number=7):
    return [{"number": number, "draft": False, "title": "fix",
             "head": {"ref": REF + "-fix"}}]


def pull_detail(state="clean"):
    return {"mergeable_state": state, "title": "fix", "body": "Refs: " + REF,
            "head": {"sha": SHA, "ref": REF + "-fix", "repo": {"full_name": ORG_REPO}}}


class SweepCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        self.out, self.err = io.StringIO(), io.StringIO()
        stack.enter_context(contextlib.redirect_stdout(self.out))
        stack.enter_context(contextlib.redirect_stderr(self.err))
        self.net, self.proc = Net(), Proc()
        path = lambda name: os.path.join(self.tmp.name, name)
        for attr, value in (("STATE", path("state.json")), ("LOG", path("sweep.log")),
                            ("PAUSE", path("PAUSE")), ("TOKEN_FILE", path("token")),
                            ("MINT", "/stub/mint.sh"), ("LOCK", path("sweep.lock"))):
            stack.enter_context(mock.patch.object(sweep, attr, value))
        stack.enter_context(mock.patch.object(sweep.urllib.request, "urlopen", self.net))
        if hasattr(sweep, "urlopen"):
            stack.enter_context(mock.patch.object(sweep, "urlopen", self.net))
        stack.enter_context(mock.patch("subprocess.run", self.proc))
        if hasattr(sweep, "time"):
            stack.enter_context(mock.patch.object(sweep.time, "sleep", lambda s: None))
        with open(sweep.TOKEN_FILE, "w") as f:
            f.write(CANARY + "\n")
        sweep.reset_run()
        if hasattr(sweep, "T"):
            sweep.T = CANARY
        if hasattr(sweep, "DRY"):
            sweep.DRY = True  # direct gh() calls must not touch the real log file

    def log_text(self):
        return self.out.getvalue() + self.err.getvalue()

    def route_org(self, repos=None):
        self.net.route("orgs/TogetherWeOwn/repos?per_page=100&page=1",
                       [{"name": REPO, "archived": False}] if repos is None else repos)
        self.net.route("orgs/", [])

    def route_one_green_pr(self):
        self.route_org()
        self.net.route(f"repos/TogetherWeOwn/{REPO}/pulls?state=open", pull_list())
        self.net.route(f"repos/TogetherWeOwn/{REPO}/pulls/7", pull_detail())
        self.proc.docker = self.docker_rows
        product = {"type": "pull_request", "provider": "github", "status": "active",
                   "externalId": f"{ORG_REPO}#7", "url": None}
        self.proc.curl_get = {f"issues/{IID}": {"id": IID, "executionWorkspaceId": None, "projectId": None},
                              f"issues/{IID}/work-products": [product]}

    @staticmethod
    def docker_rows(query):
        if "heartbeat_runs" in query:
            return "f"  # live-work guard: no live run
        return f"{IID}|{REF}|todo|Some Agent|f"


class GhListingFaultUnit(SweepCase):
    """gh() itself: listing-shaped HTTP failures are counted faults."""

    def test_http_5xx_401_403_are_counted_faults_not_silent(self):
        for code in LISTING_FAULT_CODES:
            with self.subTest(code=code):
                sweep.reset_run()
                self.net.routes.clear()
                self.net.route("x", http_error(code))
                result = sweep.gh("x")
                self.assertEqual(result, {"_err": code})
                self.assertIn(f"HTTP {code}", self.log_text())
                self.assertEqual(len(sweep.RUN["faults"]), 1,
                                 f"HTTP {code} must be a counted fault, not a silent log row")
                self.assertNotIn(CANARY, self.log_text())

    def test_http_404_is_an_expected_miss_not_a_fault(self):
        self.net.route("x", http_error(404))
        self.assertEqual(sweep.gh("x"), {"_err": 404})
        self.assertIn("404", self.log_text())
        self.assertEqual(sweep.RUN["faults"], [])

    def test_network_failure_on_a_listing_call_is_a_counted_fault(self):
        self.net.route("x", TimeoutError("timed out"))
        self.assertEqual(sweep.gh("x"), {"_err": "timeout"})
        self.assertEqual(len(sweep.RUN["faults"]), 1)

    def test_credential_material_from_an_exception_never_reaches_the_log(self):
        self.net.route("x", OSError("proxy rejected Authorization: " + CANARY))
        sweep.gh("x")
        self.assertNotIn(CANARY, self.log_text())
        self.assertEqual(len(sweep.RUN["faults"]), 1)

    def test_every_github_request_carries_a_bounded_timeout(self):
        self.net.route("x", {"ok": 1})
        self.assertEqual(sweep.gh("x"), {"ok": 1})
        timeout = self.net.calls[0][1]
        self.assertIsNotNone(timeout, "a listing call without a timeout can stall the timer run")
        self.assertTrue(0 < timeout <= 60)

    def test_successful_list_and_object_bodies_are_unchanged(self):
        self.net.route("list", [{"a": 1}])
        self.net.route("obj", {"b": 2})
        self.assertEqual(sweep.gh("list"), [{"a": 1}])
        self.assertEqual(sweep.gh("obj"), {"b": 2})
        self.assertEqual(sweep.RUN["faults"], [])


class MainListingFaultVisibility(SweepCase):
    """main(): a failed listing ends the run non-zero and visibly."""

    def run_main(self, *args):
        return sweep.main(list(args))

    def test_org_listing_http_errors_exit_nonzero(self):
        for code in LISTING_FAULT_CODES:
            with self.subTest(code=code):
                sweep.reset_run()
                self.net.routes.clear()
                self.net.calls.clear()
                self.proc.calls.clear()
                self.out.seek(0); self.out.truncate()
                self.net.route("orgs/", http_error(code, "https://api.github.com/orgs/x"))
                self.assertEqual(self.run_main(), 1,
                                 f"org listing HTTP {code} must not exit 0")
                self.assertIn(f"HTTP {code}", self.log_text())
                self.assertIn("FAULT", self.log_text(),
                              "the summary must carry a fault count, not a clean '0 PRs need a nudge'")
                self.assertEqual(self.proc.board_writes(), [])
                self.assertNotIn(CANARY, self.log_text())

    def test_org_listing_timeout_exits_nonzero_with_a_row_and_no_writes(self):
        self.net.route("orgs/", TimeoutError("timed out"))
        self.assertEqual(self.run_main(), 1)
        self.assertIn("org repo list page 1 failed", self.log_text())
        self.assertIn("FAULT", self.log_text())
        self.assertEqual(self.proc.board_writes(), [])

    def test_pulls_listing_http_errors_exit_nonzero(self):
        for code in LISTING_FAULT_CODES:
            with self.subTest(code=code):
                sweep.reset_run()
                self.net.routes.clear()
                self.net.calls.clear()
                self.proc.calls.clear()
                self.out.seek(0); self.out.truncate()
                self.route_org()
                self.net.route(f"repos/TogetherWeOwn/{REPO}/pulls?state=open",
                               http_error(code, "https://api.github.com/pulls"))
                self.assertEqual(self.run_main(), 1,
                                 f"pulls listing HTTP {code} must not exit 0")
                self.assertIn(f"HTTP {code}", self.log_text())
                self.assertIn("FAULT", self.log_text())
                self.assertEqual(self.proc.board_writes(), [])

    def test_failed_second_pulls_page_exits_nonzero_and_acts_on_nothing(self):
        self.route_org()
        page_one = [dict(pull_list(7)[0]) for _ in range(100)]  # a full page forces page 2
        self.net.route("pulls?state=open&per_page=100&page=1", page_one)
        self.net.route("pulls?state=open&per_page=100&page=2",
                       http_error(502, "https://api.github.com/pulls"))
        self.net.route(f"repos/TogetherWeOwn/{REPO}/pulls/7", pull_detail())
        self.assertEqual(self.run_main(), 1)
        self.assertIn("list page 2 failed", self.log_text())
        self.assertEqual(self.proc.board_writes(), [],
                         "never act on a partial PR list")

    def test_clean_empty_listing_exits_zero(self):
        self.route_org()
        self.net.route(f"repos/TogetherWeOwn/{REPO}/pulls?state=open", [])
        self.assertEqual(self.run_main(), 0)
        self.assertNotIn("FAULT", self.log_text())
        self.assertEqual(self.proc.board_writes(), [])

    def test_clean_run_with_one_green_pr_exits_zero_and_sends_one_nudge(self):
        self.route_one_green_pr()
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(sweep.RUN["faults"], [])
        self.assertEqual(len(self.proc.board_writes()), 1)


if __name__ == "__main__":
    unittest.main()
