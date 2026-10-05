#!/usr/bin/env python3
"""Tests for ci_homepc_guard.py.

Every contract carries a positive control: a mutated world in which the
guard MUST refuse or diverge. A gate that has gone vacuous fails here
instead of passing quietly. Offline: the GitHub API is a stubbed
urllib.request.urlopen in-process. No network, no credential on disk, no
host, no systemd.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import unittest
import urllib.error
import urllib.request

import ci_homepc_guard as guard

TOKEN = "SYNTHETIC_DO_NOT_PRINT_7f3a"
VALUE = '["self-hosted","two-homepc"]'


def runner(name, status="online", busy=False, labels=("self-hosted", "two-homepc")):
    return {
        "name": name,
        "status": status,
        "busy": busy,
        "labels": [{"name": l} for l in labels],
    }


class StubTransport:
    """Canned GitHub API. Records every call; raises where told to."""

    def __init__(self):
        self.calls = []
        self.runners_pages = [[
            runner("homepc-r1", busy=False),
            runner("homepc-r2", busy=False),
            runner("vps-runner-1", labels=("self-hosted", "two-isolated")),
        ]]
        self.variable = None  # None = absent (404)
        self.fail_runners_with = None
        self.fail_variable_with = None

    def __call__(self, req, timeout=None):
        method = req.get_method()
        url = req.full_url
        self.calls.append((method, url))
        if "/orgs/" in url and "/actions/runners" in url:
            if self.fail_runners_with:
                raise self.fail_runners_with
            page = 1
            for part in url.split("?")[-1].split("&"):
                if part.startswith("page="):
                    page = int(part.split("=", 1)[1])
            batch = self.runners_pages[page - 1] if page <= len(self.runners_pages) else []
            return FakeResponse(200, {"runners": batch})
        if "/actions/variables/" in url:
            if self.fail_variable_with:
                raise self.fail_variable_with
            if method == "GET":
                if self.variable is None:
                    raise urllib.error.HTTPError(url, 404, "not found", {}, None)
                return FakeResponse(200, {"name": "CI_HOMEPC_RUNNER", "value": self.variable})
            if method == "DELETE":
                self.variable = None
                return FakeResponse(204, {})
            raise AssertionError(f"unexpected variable method {method}")
        if url.endswith("/actions/variables") and method == "POST":
            body = json.loads(req.data.decode())
            self.variable = body["value"]
            return FakeResponse(201, {"name": body["name"], "value": body["value"]})
        if "/actions/variables/" in url and method == "PATCH":
            body = json.loads(req.data.decode())
            self.variable = body["value"]
            return FakeResponse(200, {"name": body["name"], "value": body["value"]})
        raise AssertionError(f"unstubbed call {method} {url}")


class FakeResponse:
    def __init__(self, status, payload):
        self.status = status
        self._payload = json.dumps(payload).encode()

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class GuardCase(unittest.TestCase):
    def setUp(self):
        self.stub = StubTransport()
        self._real = urllib.request.urlopen
        urllib.request.urlopen = self.stub
        self.addCleanup(setattr, urllib.request, "urlopen", self._real)
        self._env = dict(os.environ)
        os.environ["GH_TOKEN"] = TOKEN
        self.addCleanup(os.environ.clear)
        self.addCleanup(os.environ.update, self._env)
        self.out = io.StringIO()
        self.err = io.StringIO()

    def run_guard(self, *argv):
        with contextlib.redirect_stdout(self.out), contextlib.redirect_stderr(self.err):
            return guard.main(list(argv))

    def wrote(self):
        return [c for c in self.stub.calls if c[0] in ("POST", "PATCH", "DELETE")]

    def all_output(self):
        return self.out.getvalue() + self.err.getvalue()


class Decision(GuardCase):
    def test_idle_runner_var_absent_is_drift(self):
        self.stub.variable = None
        self.assertEqual(self.run_guard("--mode", "check"), 1)

    def test_idle_runner_var_set_is_aligned(self):
        self.stub.variable = VALUE
        self.assertEqual(self.run_guard("--mode", "check"), 0)

    def test_no_idle_var_absent_is_aligned(self):
        self.stub.runners_pages = [[runner("homepc-r1", busy=True)]]
        self.stub.variable = None
        self.assertEqual(self.run_guard("--mode", "check"), 0)

    def test_no_idle_var_set_is_drift(self):
        self.stub.runners_pages = [[runner("homepc-r1", busy=True)]]
        self.stub.variable = VALUE
        self.assertEqual(self.run_guard("--mode", "check"), 1)

    def test_busy_runner_is_not_idle(self):
        self.stub.runners_pages = [[
            runner("homepc-r1", busy=True), runner("homepc-r2", busy=True),
        ]]
        rc = self.run_guard("--mode", "apply")
        self.assertEqual(rc, 0)
        self.assertEqual(self.stub.variable, None)
        self.assertNotIn("homepc-r1", self.out.getvalue().split("idle_names=")[1].split()[0])

    def test_offline_runner_is_not_idle(self):
        self.stub.runners_pages = [[
            runner("homepc-r1", status="offline"), runner("homepc-r2", busy=True),
        ]]
        self.assertEqual(self.run_guard("--mode", "check"), 0)

    def test_foreign_label_is_ignored(self):
        self.stub.runners_pages = [[
            runner("vps-runner-1", labels=("self-hosted", "two-isolated")),
            runner("other-box", labels=("self-hosted", "other")),
        ]]
        self.assertEqual(self.run_guard("--mode", "check"), 0)

    def test_apply_sets_when_idle_and_absent(self):
        self.stub.variable = None
        self.assertEqual(self.run_guard("--mode", "apply"), 0)
        self.assertEqual(self.stub.variable, VALUE)

    def test_apply_clears_when_var_set_and_none_idle(self):
        self.stub.runners_pages = [[runner("homepc-r1", status="offline")]]
        self.stub.variable = VALUE
        self.assertEqual(self.run_guard("--mode", "apply"), 0)
        self.assertIsNone(self.stub.variable)

    def test_apply_keeps_aligned_without_writing(self):
        self.stub.variable = VALUE
        self.assertEqual(self.run_guard("--mode", "apply"), 0)
        self.assertEqual(self.wrote(), [])

    def test_positive_control_idle_identity_is_load_bearing(self):
        # The flip side of test_busy_runner_is_not_idle: if the busy flag
        # were ignored, a fully-busy PC would read idle and the var would
        # be set. One idle runner among busy ones must route.
        self.stub.runners_pages = [[
            runner("homepc-r1", busy=True), runner("homepc-r2", busy=False),
        ]]
        self.stub.variable = None
        self.assertEqual(self.run_guard("--mode", "apply"), 0)
        self.assertEqual(self.stub.variable, VALUE)


class FailClosed(GuardCase):
    def test_runner_list_failure_refuses_before_any_write(self):
        self.stub.variable = None
        self.stub.fail_runners_with = urllib.error.HTTPError(
            "https://api.github.com/x", 403, "forbidden", {}, None)
        rc = self.run_guard("--mode", "apply")
        self.assertEqual(rc, 3)
        self.assertEqual(self.wrote(), [])
        self.assertIn("REFUSED", self.err.getvalue())

    def test_check_mode_runner_failure_is_unmeasured(self):
        self.stub.fail_runners_with = OSError("boom")
        self.assertEqual(self.run_guard("--mode", "check"), 3)

    def test_missing_credential_refuses_without_any_call(self):
        del os.environ["GH_TOKEN"]
        self.assertEqual(self.run_guard("--mode", "check"), 2)
        self.assertEqual(self.stub.calls, [])

    def test_credential_never_reaches_output(self):
        self.stub.variable = VALUE
        self.assertEqual(self.run_guard("--mode", "check"), 0)
        self.assertNotIn(TOKEN, self.all_output())

    def test_non_json_value_refuses(self):
        self.assertEqual(self.run_guard("--mode", "check", "--value", "not-json"), 2)

    def test_empty_list_value_refuses(self):
        self.assertEqual(self.run_guard("--mode", "check", "--value", "[]"), 2)

    def variable_reads(self):
        return [url for method, url in self.stub.calls
                if method == "GET" and "/actions/variables/" in url]

    def test_default_repo_is_the_public_toolkit_repo(self):
        os.environ.pop("HOMEPC_GH_REPO", None)
        self.stub.variable = VALUE
        self.assertEqual(self.run_guard("--mode", "check"), 0)
        self.assertEqual(self.variable_reads(), [
            "https://api.github.com/repos/TogetherWeOwn/"
            "paperclip-operator-toolkit/actions/variables/CI_HOMEPC_RUNNER"])

    def test_repo_comes_from_the_environment_when_set(self):
        os.environ["HOMEPC_GH_REPO"] = "example-org/example-repo"
        self.stub.variable = VALUE
        self.assertEqual(self.run_guard("--mode", "check"), 0)
        self.assertEqual(self.variable_reads(), [
            "https://api.github.com/repos/example-org/"
            "example-repo/actions/variables/CI_HOMEPC_RUNNER"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
