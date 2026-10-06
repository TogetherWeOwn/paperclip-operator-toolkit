#!/usr/bin/env python3
"""Offline CLI and read-only contract tests for watchdog/detectors.py.

``main()`` is the only entry the timer runs. These tests pin what a consumer of
its output relies on and that ``detect()`` leaves its input alone and does no
I/O. Every case runs on fixtures in a temporary directory: no credentials, no
network, no board writes. CLI children get a minimal environment and a
temporary working directory.

Detector decisions are covered in test_platform_watchdog.py; this file only
covers the process boundary. The mutation gate that proves these tests fail
when the contract breaks is verification/platform-watchdog-cli-mutation-gate.py.
"""

import builtins
import copy
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from watchdog.detectors import PHASE, detect

ROOT = os.path.dirname(os.path.abspath(__file__))
DETECTORS = os.path.join(ROOT, "watchdog", "detectors.py")

# A value no detector reads. If it ever shows up in output, a detector echoed
# raw snapshot content.
MARKER = "ZZ-UNRELATED-MARKER-0c7e41d9"

CONFIG_ENV = {"WATCHDOG_CEO_DESK_ISSUE": "ISSUE-100",
              "WATCHDOG_REQUIRED_HOSTS": "192.0.2.10"}


def setUpModule():
    patcher = mock.patch.dict(os.environ, CONFIG_ENV)
    patcher.start()
    unittest.addModuleCleanup(patcher.stop)


FAMILIES = ("agent_error", "host_health", "ci_health", "assignment", "churn",
            "pending_interactions", "autoscaler_slices", "red_main",
            "secret_hit", "supply_famine")


def clean_snapshot():
    """Every section present and quiet: detect() must return no records."""
    return {
        "now": "2026-10-03T14:00:00Z",
        "agents": [{"agentId": "a1", "status": "idle"}],
        "hosts": [{"host": "192.0.2.10", "diskPct": 10, "load": 1.0,
                   "vcpu": 4, "sustainedMin": 1}],
        "ciJobs": [{"repo": "r", "job": "j", "runtimeMin": 20,
                    "baselineMin": 20}],
        "queueAge": [{"label": "self-hosted", "ageMin": 5}],
        "issues": [], "runEvents": [], "parks": [],
        "redMains": [], "secretHits": [], "pendingInteractions": [],
        "supply": {"readyNow": 12, "target": 12, "belowMin": 0.0,
                   "idleAgents": 2, "censusAt": "2026-10-03T14:00:00Z"},
        "autoscalerSlices": [],
    }


def mixed_snapshot():
    """A snapshot that fires every detector family at once.

    The issue deliberately omits ``isReview`` and ``prAuthorAgentId`` so an
    in-place default-fill by a detector changes the input.
    """
    stalled = [{"issueId": "iid-1", "identifier": "ISSUE-1",
                "kind": "dispatch_stalled_issue",
                "at": f"2026-10-03T13:{minute}:00Z"}
               for minute in (10, 20, 30, 40)]
    return {
        "now": "2026-10-03T14:00:00Z",
        "agents": [{"agentId": "a1", "status": "error",
                    "errorSince": "2026-10-03T13:00:00Z", "subtype": "crash",
                    "owningLead": "cto"}],
        "hosts": [{"host": "192.0.2.10", "diskPct": 99, "load": 9.0,
                   "vcpu": 4, "sustainedMin": 10}],
        "ciJobs": [{"repo": "r", "job": "j", "runtimeMin": 45,
                    "baselineMin": 20}],
        "queueAge": [{"label": "self-hosted", "ageMin": 160}],
        "issues": [{"id": "iid-1", "identifier": "ISSUE-1", "inFocus": True,
                    "assigneeAgentId": None, "inBacklogMin": 90}],
        "runEvents": stalled,
        "parks": [{"issueId": "iid-1", "identifier": "ISSUE-1",
                   "missingDispositionCount": 4}],
        "redMains": [{"repo": "example-repo", "signature": "s1",
                      "incidentExists": False}],
        "secretHits": [{"source": "run-log:x", "patternName": "ghp_*",
                        "valueLen": 40, "at": "2026-10-03T13:00:00Z"}],
        "pendingInteractions": [{
            "issueId": "iid-7", "identifier": "ISSUE-7",
            "interactionId": "int-1", "kind": "request_confirmation",
            "createdAt": "2026-10-03T13:00:00Z",
            "resolverAgentId": "agent-r"}],
        "supply": {"readyNow": 0, "target": 12, "belowMin": 35.0,
                   "idleAgents": 2, "censusAt": "2026-10-03T14:00:00Z"},
        "autoscalerSlices": [{
            "sliceId": "slice-1", "identifier": "ISSUE-20",
            "status": "backlog", "assigneeAgentId": None,
            "unassignedSince": "2026-10-03T11:00:00Z"}],
    }


def with_marker(snapshot):
    """Plant MARKER in fields no detector reads, at several depths."""
    planted = copy.deepcopy(snapshot)
    planted["operatorNote"] = MARKER
    planted["unrelatedSection"] = {"debug": [MARKER]}
    for section in ("agents", "hosts", "ciJobs", "secretHits"):
        planted[section][0]["scratch"] = MARKER
    return planted


class CliCase(unittest.TestCase):
    """Temp-file CLI helper: one temp directory per test, minimal child env."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="watchdog-cli-")
        self.addCleanup(tmp.cleanup)
        self.tmp = tmp.name

    def write(self, content, name="snapshot.json"):
        path = os.path.join(self.tmp, name)
        data = content.encode("utf-8") if isinstance(content, str) else content
        with open(path, "wb") as handle:
            handle.write(data)
        return path

    def write_json(self, snapshot, name="snapshot.json"):
        return self.write(json.dumps(snapshot), name)

    def cli(self, *args, seed="0"):
        # No inherited credentials or API settings: only interpreter knobs.
        env = {"PYTHONDONTWRITEBYTECODE": "1", "PYTHONHASHSEED": seed,
               "PYTHONIOENCODING": "utf-8", **CONFIG_ENV}
        return subprocess.run(
            [sys.executable, DETECTORS, *args], cwd=self.tmp, env=env,
            capture_output=True, text=True, encoding="utf-8", timeout=30)

    def run_snapshot(self, path, **kwargs):
        return self.cli("--snapshot", path, **kwargs)


class CliRefusalTest(CliCase):
    def assert_refused(self, proc):
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertEqual(proc.stdout, "")
        lines = proc.stderr.splitlines()
        self.assertEqual(len(lines), 1, proc.stderr)
        self.assertTrue(lines[0].startswith("watchdog: "), lines[0])
        self.assertNotIn("Traceback", proc.stderr)

    # NOTE (rebase): the detector does not gate on CEO-desk/host-coverage
    # config (no private counterpart); refusal tests for that invented
    # behavior were removed. The env knobs above remain as benign fixtures.

    def test_unreadable_snapshot_exits_2(self):
        # Missing file: the exact case the timer hits when a snapshot job dies.
        proc = self.run_snapshot(os.path.join(self.tmp, "absent.json"))
        self.assert_refused(proc)
        self.assertIn("cannot read snapshot", proc.stderr)

    def test_directory_as_snapshot_exits_2(self):
        self.assert_refused(self.run_snapshot(self.tmp))

    def test_invalid_json_exits_2(self):
        for label, text in (("empty", ""), ("truncated", '{"agents": ['),
                            ("not-json", "not json at all"),
                            ("single-quoted", "{'agents': []}"),
                            ("trailing-comma", '{"agents": [],}')):
            with self.subTest(label):
                proc = self.run_snapshot(self.write(text))
                self.assert_refused(proc)
                self.assertIn("cannot read snapshot", proc.stderr)

    def test_non_utf8_snapshot_exits_2(self):
        # json.load raises UnicodeDecodeError (a ValueError, not a
        # JSONDecodeError) on bytes that are not UTF-8; without its own
        # except clause the CLI exits 1 with a traceback.
        for label, data in (
                ("invalid-start-byte", b"\xff\xfe{\x80"),
                ("utf-16-with-bom", "{}".encode("utf-16")),
                ("latin-1-high-byte", b'{"agents": ["caf\xe9"]}'),
                ("truncated-multibyte", b'{"a": "\xe2\x82')):
            with self.subTest(label):
                proc = self.run_snapshot(self.write(data))
                self.assert_refused(proc)
                self.assertIn("cannot read snapshot", proc.stderr)

    def test_non_object_json_exits_2(self):
        for label, text in (("array", "[]"), ("array-of-objects", "[{}]"),
                            ("string", '"snapshot"'), ("number", "7"),
                            ("true", "true"), ("null", "null")):
            with self.subTest(label):
                proc = self.run_snapshot(self.write(text))
                self.assert_refused(proc)
                self.assertIn("snapshot must be a JSON object", proc.stderr)

    def test_missing_snapshot_argument_exits_2(self):
        proc = self.cli()
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, "")
        self.assertIn("--snapshot", proc.stderr)

    def test_refusals_never_echo_snapshot_content(self):
        hostile = {
            "invalid-json": '{"note": "' + MARKER + '", ',
            "array": json.dumps([MARKER]),
            "string": json.dumps(MARKER),
            "non-utf8": MARKER.encode("utf-8") + b"\xff\xfe{\x80",
        }
        for label, text in hostile.items():
            with self.subTest(label):
                proc = self.run_snapshot(self.write(text))
                self.assert_refused(proc)
                self.assertNotIn(MARKER, proc.stdout + proc.stderr)


class CliOutputContractTest(CliCase):
    def lines(self, proc):
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stderr, "")
        self.assertTrue(proc.stdout.endswith("\n"))
        return proc.stdout.splitlines()

    def test_clean_snapshot_prints_exactly_the_summary_line(self):
        self.assertEqual(detect(clean_snapshot()), [],
                         "fixture is not clean; the test below would be vacuous")
        proc = self.run_snapshot(self.write_json(clean_snapshot()))
        expected = json.dumps(
            {"type": "summary", "detector": "watchdog/cycle",
             "records": 0, "phase": PHASE}, sort_keys=True) + "\n"
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stderr, "")
        self.assertEqual(proc.stdout, expected)
        self.assertEqual(json.loads(proc.stdout)["records"], 0)

    def test_mixed_snapshot_is_sorted_jsonl_with_a_matching_summary(self):
        snapshot = mixed_snapshot()
        in_process = detect(copy.deepcopy(snapshot))
        fired = {r["detector"] for r in in_process}
        for family in FAMILIES:
            self.assertIn(f"watchdog/{family}", fired,
                          f"fixture does not fire {family}; test is vacuous")
        proc = self.run_snapshot(self.write_json(snapshot))
        lines = self.lines(proc)

        def sorted_keys_only(pairs):
            keys = [key for key, _ in pairs]
            self.assertEqual(keys, sorted(keys), "keys are not sorted")
            return dict(pairs)

        parsed = []
        for line in lines:
            self.assertTrue(line.strip(), "blank line in JSONL output")
            parsed.append(json.loads(line, object_pairs_hook=sorted_keys_only))
        *records, summary = parsed
        self.assertEqual(summary["type"], "summary")
        self.assertEqual(summary["detector"], "watchdog/cycle")
        self.assertEqual(summary["phase"], PHASE)
        self.assertEqual(summary["records"], len(records))
        self.assertGreater(len(records), 0)
        for record in records:
            self.assertIn(record["type"], ("finding", "proposal"))
        # Exactly one summary, and it is last.
        self.assertEqual(
            sum(1 for p in parsed if p.get("type") == "summary"), 1)
        # The CLI prints what detect() returns, in the same order.
        self.assertEqual(records, json.loads(json.dumps(in_process)))

    def test_two_runs_with_pinned_now_are_byte_identical(self):
        path = self.write_json(mixed_snapshot())
        first = self.run_snapshot(path)
        second = self.run_snapshot(path)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(first.stdout, second.stdout)
        # Hash-seed independent, so no ordering rides on set/dict hashing.
        for seed in ("1", "4242"):
            with self.subTest(seed=seed):
                other = self.run_snapshot(path, seed=seed)
                self.assertEqual(other.returncode, 0, other.stderr)
                self.assertEqual(other.stdout, first.stdout)

    def test_cli_leaves_the_snapshot_file_and_directory_alone(self):
        path = self.write_json(mixed_snapshot())
        with open(path, "rb") as handle:
            before = handle.read()
        listing = sorted(os.listdir(self.tmp))
        proc = self.run_snapshot(path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        with open(path, "rb") as handle:
            self.assertEqual(handle.read(), before)
        self.assertEqual(sorted(os.listdir(self.tmp)), listing)

    def test_unrelated_snapshot_content_is_never_echoed(self):
        planted = with_marker(mixed_snapshot())
        self.assertNotIn(MARKER, json.dumps(detect(copy.deepcopy(planted))),
                         "detect() echoed an unrelated field")
        proc = self.run_snapshot(self.write_json(planted))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertGreater(len(proc.stdout.splitlines()), 1)
        self.assertNotIn(MARKER, proc.stdout)
        self.assertNotIn(MARKER, proc.stderr)
        # Control: the marker really is in the file the CLI read.
        with open(os.path.join(self.tmp, "snapshot.json"),
                  encoding="utf-8") as handle:
            self.assertIn(MARKER, handle.read())


class ReadOnlyContractTest(unittest.TestCase):
    SNAPSHOTS = (("clean", clean_snapshot), ("mixed", mixed_snapshot),
                 ("marker", lambda: with_marker(mixed_snapshot())),
                 ("empty", dict))

    def test_detect_leaves_its_input_equal(self):
        for label, build in self.SNAPSHOTS:
            with self.subTest(label):
                snapshot = build()
                before = copy.deepcopy(snapshot)
                before_json = json.dumps(snapshot, sort_keys=True)
                detect(snapshot)
                self.assertEqual(snapshot, before)
                self.assertEqual(json.dumps(snapshot, sort_keys=True),
                                 before_json)

    def test_detect_is_repeatable_on_the_same_input(self):
        snapshot = mixed_snapshot()
        self.assertEqual(detect(snapshot), detect(snapshot))

    def blocked_io(self):
        deny = AssertionError("detect() attempted I/O")
        return (mock.patch.object(socket, "socket", side_effect=deny),
                mock.patch.object(subprocess, "Popen", side_effect=deny),
                mock.patch.object(builtins, "open", side_effect=deny),
                mock.patch.object(io, "open", side_effect=deny))

    def test_io_guards_are_live(self):
        # Control for the test below: each guard raises when it is used.
        sock, popen, opn, io_open = self.blocked_io()
        with sock, popen, opn, io_open:
            with self.assertRaises(AssertionError):
                socket.socket()
            with self.assertRaises(AssertionError):
                subprocess.Popen([sys.executable, "-c", "pass"])
            with self.assertRaises(AssertionError):
                open(DETECTORS)
            with self.assertRaises(AssertionError):
                io.open(DETECTORS)

    def test_detect_does_no_io(self):
        for label, build in self.SNAPSHOTS:
            with self.subTest(label):
                snapshot = build()
                expected = detect(copy.deepcopy(snapshot))
                sock, popen, opn, io_open = self.blocked_io()
                with sock as m_sock, popen as m_popen, opn as m_open, \
                        io_open as m_io:
                    got = detect(copy.deepcopy(snapshot))
                for guard in (m_sock, m_popen, m_open, m_io):
                    guard.assert_not_called()
                self.assertEqual(got, expected)


if __name__ == "__main__":
    unittest.main()
