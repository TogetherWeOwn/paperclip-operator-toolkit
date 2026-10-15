#!/usr/bin/env python3
"""Offline acceptance coverage for fault-visible PR hygiene sweeps."""

import contextlib
import io
import json
import os
import subprocess
import tempfile
import unittest
import urllib.error
from unittest import mock

import pr_hygiene_sweep as sweep

REPO = "sample-repo"
ORG_REPO = "TogetherWeOwn/" + REPO
ISSUE_ID = "11111111-2222-3333-4444-555555555555"
ISSUE_REF = "AB-7"
SHA = "abcdef0123456789abcdef0123456789abcdef01"


class Response(io.BytesIO):
    pass


class GitHub:
    def __init__(self):
        self.routes = []
        self.calls = []

    def route(self, needle, value):
        self.routes.append((needle, value))

    def __call__(self, request, *args, **kwargs):
        url = request.full_url
        self.calls.append(url)
        for needle, value in self.routes:
            if needle in url:
                if isinstance(value, BaseException):
                    raise value
                body = value if isinstance(value, bytes) else json.dumps(value).encode()
                return Response(body)
        raise AssertionError("unrouted GitHub URL: " + url)


class Commands:
    def __init__(self):
        self.calls = []
        self.docker = lambda query: ""
        self.curl_get = {}

    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        if argv[0] == "bash":
            return subprocess.CompletedProcess(argv, 0, "", "")
        if argv[0] == "docker":
            query = argv[argv.index("-c") + 1]
            result = self.docker(query)
            if isinstance(result, subprocess.CompletedProcess):
                return result
            return subprocess.CompletedProcess(argv, 0, result, "")
        if argv[0] == "curl":
            url = next(arg for arg in argv if "/api/" in arg)
            path = url.split("/api/", 1)[1]
            body = {"id": ISSUE_ID} if "-X" in argv else self.curl_get.get(path)
            trailer = ""
            if "-w" in argv:
                trailer = argv[argv.index("-w") + 1].replace(r"\n", "\n").replace("%{http_code}", "200")
            return subprocess.CompletedProcess(argv, 0, json.dumps(body) + trailer, "")
        raise AssertionError("unexpected subprocess: " + repr(argv))

    def board_writes(self):
        return [argv for argv, _ in self.calls if argv[0] == "curl" and "-X" in argv]


class SweepAcceptance(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        self.stdout = io.StringIO()
        self.stderr = io.StringIO()
        stack.enter_context(contextlib.redirect_stdout(self.stdout))
        stack.enter_context(contextlib.redirect_stderr(self.stderr))
        self.net = GitHub()
        self.commands = Commands()
        path = lambda name: os.path.join(self.tmp.name, name)
        for attr, value in (
            ("STATE", path("state.json")),
            ("LOG", path("sweep.log")),
            ("PAUSE", path("PAUSE")),
            ("TOKEN_FILE", path("token")),
            ("MINT", "/stub/mint.sh"),
            ("LOCK", path("sweep.lock")),
        ):
            stack.enter_context(mock.patch.object(sweep, attr, value))
        stack.enter_context(mock.patch.object(sweep.urllib.request, "urlopen", self.net))
        stack.enter_context(mock.patch("subprocess.run", self.commands))
        stack.enter_context(mock.patch.object(sweep.time, "sleep", lambda _: None))
        with open(sweep.TOKEN_FILE, "w", encoding="utf-8") as token:
            token.write("test-token\n")
        sweep.reset_run()
        sweep.T = "test-token"

    def log_text(self):
        return self.stdout.getvalue() + self.stderr.getvalue()

    def route_org(self):
        self.net.route("orgs/TogetherWeOwn/repos?per_page=100&page=1", [{"name": REPO, "archived": False}])
        self.net.route("orgs/", [])

    def route_pr(self, state="clean", detail=None, check_runs=None):
        self.route_org()
        self.net.route(f"repos/{ORG_REPO}/pulls?state=open", [{
            "number": 7,
            "draft": False,
            "title": "fix",
            "head": {"ref": ISSUE_REF + "-fix"},
        }])
        self.net.route(f"repos/{ORG_REPO}/pulls/7", detail or {
            "mergeable_state": state,
            "title": "fix",
            "body": "Refs: " + ISSUE_REF,
            "head": {"sha": SHA, "ref": ISSUE_REF + "-fix", "repo": {"full_name": ORG_REPO}},
        })
        if state in ("unstable", "blocked"):
            self.net.route(f"repos/{ORG_REPO}/commits/{SHA}/check-runs", check_runs or {"check_runs": []})
        self.commands.docker = lambda query: "f" if "heartbeat_runs" in query else (
            f"{ISSUE_ID}|{ISSUE_REF}|todo|Some Agent|f"
        )
        self.commands.curl_get = {
            f"issues/{ISSUE_ID}": {"id": ISSUE_ID, "executionWorkspaceId": None, "projectId": None},
            f"issues/{ISSUE_ID}/work-products": [{
                "type": "pull_request",
                "provider": "github",
                "status": "active",
                "externalId": f"{ORG_REPO}#7",
                "url": None,
            }],
        }

    def assert_no_traceback(self):
        self.assertNotIn("Traceback", self.log_text())

    def test_org_listing_404_is_counted_and_exits_one(self):
        self.net.route("orgs/TogetherWeOwn/repos?per_page=100&page=1", self.http_error(404))
        self.net.route("orgs/", [])

        self.assertEqual(sweep.main([]), 1)
        self.assertIn("HTTP 404", self.log_text())
        self.assertTrue(any("HTTP 404" in fault for fault in sweep.RUN["faults"]))
        self.assertIn("FAULTS", self.log_text())
        self.assertEqual(self.commands.board_writes(), [])
        self.assert_no_traceback()

    def test_repo_pulls_404_is_a_miss_and_exits_zero(self):
        self.route_org()
        self.net.route(f"repos/{ORG_REPO}/pulls?state=open", self.http_error(404))

        self.assertEqual(sweep.main([]), 0)
        self.assertNotIn("FAULTS", self.log_text())
        self.assertEqual(self.commands.board_writes(), [])
        self.assert_no_traceback()

    def test_agent_name_with_pipe_is_preserved_without_crash(self):
        self.route_pr()
        self.commands.docker = lambda query: "f" if "heartbeat_runs" in query else (
            f"{ISSUE_ID}|{ISSUE_REF}|todo|Agent|with|pipe|f"
        )

        self.assertEqual(sweep.main([]), 0)
        self.assertEqual(len(self.commands.board_writes()), 1)
        self.assertNotIn("FAULTS", self.log_text())
        self.assert_no_traceback()

    def test_nameless_failing_check_run_does_not_crash(self):
        self.route_pr(state="blocked", check_runs={"check_runs": [{"conclusion": "failure"}]})

        self.assertEqual(sweep.main([]), 0)
        self.assertEqual(self.commands.board_writes(), [])
        self.assertNotIn("FAULTS", self.log_text())
        self.assert_no_traceback()

    def test_null_head_repo_does_not_crash_when_work_product_matches(self):
        self.route_pr(detail={
            "mergeable_state": "clean",
            "title": "fix",
            "body": "Refs: " + ISSUE_REF,
            "head": {"sha": SHA, "ref": ISSUE_REF + "-fix", "repo": None},
        })

        self.assertEqual(sweep.main([]), 0)
        self.assertEqual(len(self.commands.board_writes()), 1)
        self.assertNotIn("FAULTS", self.log_text())
        self.assert_no_traceback()

    def test_malformed_board_row_is_counted_without_crash(self):
        self.route_pr()
        self.commands.docker = lambda query: "f" if "heartbeat_runs" in query else "malformed-row"

        self.assertEqual(sweep.main([]), 1)
        self.assertIn("FAULTS", self.log_text())
        self.assertEqual(self.commands.board_writes(), [])
        self.assert_no_traceback()

    @staticmethod
    def http_error(code):
        return urllib.error.HTTPError("https://api.github.com/orgs/TogetherWeOwn/repos", code, "gone", {}, None)


if __name__ == "__main__":
    unittest.main()
