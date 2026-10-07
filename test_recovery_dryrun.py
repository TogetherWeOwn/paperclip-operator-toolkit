#!/usr/bin/env python3
# ===========================================================================
# test_recovery_dryrun.py — offline hostile suite for the recovery-writer
# dry-run harness.
#
# Written to FAIL a plausible-but-wrong implementation, not to confirm the one
# that exists. Every section is either a drift the old host timers actually
# exhibited, or the specific shortcut a reimplementation would take:
#
#   * a "dry-run" that writes (drift 1 of recovery_writer.py): the harness
#     has no apply path at all, and the suite proves the snapshot is
#     byte-identical after a run and no socket is ever opened;
#   * repeat polls that duplicate (the stall-sweep re-wake):
#     the second run over one signature must log skip, never propose;
#   * info diagnostics scored as proposals (a digest green that
#     never delivered): benign/info rows skip, high rows propose;
#   * volatile evidence in the dedupe key (ageMin moves every poll): one
#     signature keeps one key while its measurements move.
#
# Deterministic: no network, no credentials, no clock reads, no board.
# Fixture rows are inline so the suite survives the live board changing.
#
#   python3 -m unittest -v test_recovery_dryrun.py
# ===========================================================================

from __future__ import annotations

import io
import json
import pathlib
import socket
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from watchdog import recovery_dryrun as dry
from watchdog.recovery_dryrun import dedupe_key, load_seen_keys, run, scope_of

HERE = pathlib.Path(__file__).resolve().parent


def snap(**overrides):
    base = {"now": "2026-10-03T14:00:00Z", "agents": [], "hosts": [],
            "ciJobs": [], "queueAge": [], "issues": [], "runEvents": [],
            "parks": [], "redMains": [], "secretHits": []}
    base.update(overrides)
    return base


def write_snapshot(tmp, payload):
    path = pathlib.Path(tmp) / "snap.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return str(path)


def read_log(path):
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


class SchemaTest(unittest.TestCase):
    def test_every_decision_carries_schema(self):
        with tempfile.TemporaryDirectory() as tmp:
            snapshot = write_snapshot(tmp, snap(
                agents=[{"agentId": "a1", "status": "error",
                         "errorSince": "2026-10-03T13:00:00Z",
                         "subtype": "crash", "owningLead": "cto"}]))
            log = str(pathlib.Path(tmp) / "decisions.jsonl")
            summary, decisions = run(snapshot, log, [])
            self.assertGreater(len(decisions), 0)
            for row in decisions:
                self.assertEqual(row["type"], "decision")
                self.assertEqual(row["harness"], "recovery-dryrun/1")
                self.assertTrue(row["detector"].startswith("watchdog/"))
                self.assertIn(row["verdict"], ("propose", "skip"))
                self.assertTrue(row["reason"])
                self.assertRegex(row["dedupeKey"], r"^[0-9a-f]{24}$")
                self.assertTrue(row["dryRun"])
                for field in ("mutation", "issueId", "identifier",
                              "severity", "note", "phase"):
                    self.assertIn(field, row)

    def test_decisions_are_labelled_dry_run_with_no_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            snapshot = write_snapshot(tmp, snap(
                agents=[{"agentId": "a1", "status": "error",
                         "errorSince": "2026-10-03T13:00:00Z",
                         "subtype": "crash", "owningLead": "cto"}]))
            log = str(pathlib.Path(tmp) / "decisions.jsonl")
            summary, decisions = run(snapshot, log, [])
            self.assertGreater(len(decisions), 0)
            for row in decisions:
                self.assertEqual(row["mutation"], "none")
                self.assertEqual(row["phase"], "dry-run-propose-only")
                self.assertIs(row["dryRun"], True)
            self.assertEqual(summary["phase"], "dry-run-propose-only")

    def test_no_secret_values_in_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            snapshot = write_snapshot(tmp, snap(
                secretHits=[{"source": "run-log:x", "patternName": "ghp_*",
                             "valueLen": 40,
                             "at": "2026-10-03T13:00:00Z"}]))
            log = str(pathlib.Path(tmp) / "decisions.jsonl")
            _, decisions = run(snapshot, log, [])
            blob = json.dumps(decisions)
            self.assertNotIn("ghp_", blob.replace("ghp_*", ""))


class DedupeTest(unittest.TestCase):
    def test_second_poll_skips_same_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            snapshot = write_snapshot(tmp, snap(
                hosts=[{"host": "host-1", "diskPct": 99, "load": 9.0,
                        "vcpu": 4, "sustainedMin": 10}]))
            log = str(pathlib.Path(tmp) / "decisions.jsonl")
            _, first = run(snapshot, log, [])
            self.assertTrue(any(d["verdict"] == "propose" for d in first))
            first_keys = [d["dedupeKey"] for d in first]
            _, second = run(snapshot, log, [])
            self.assertEqual(len(second), len(first))
            for row in second:
                self.assertEqual(row["verdict"], "skip")
                self.assertIn(row["dedupeKey"], first_keys)
                self.assertIn("duplicate", row["reason"].lower())

    def test_duplicate_rows_inside_one_poll_skip_after_the_first(self):
        host = {"host": "host-1", "diskPct": 99, "load": 9.0,
                "vcpu": 4, "sustainedMin": 10}
        with tempfile.TemporaryDirectory() as tmp:
            snapshot = write_snapshot(tmp, snap(hosts=[host, dict(host)]))
            log = str(pathlib.Path(tmp) / "decisions.jsonl")
            _, decisions = run(snapshot, log, [])
        by_key = {}
        for row in decisions:
            by_key.setdefault(row["dedupeKey"], []).append(row["verdict"])
        repeated = [verdicts for verdicts in by_key.values() if len(verdicts) > 1]
        self.assertTrue(repeated, "fixture must produce a repeated signature")
        for verdicts in repeated:
            self.assertEqual(verdicts[0], "propose")
            self.assertEqual(set(verdicts[1:]), {"skip"})

    def test_key_separates_detector_reason_and_mutation(self):
        base = {"detector": "watchdog/x", "reason": "r", "mutation": "none"}
        keys = {
            dedupe_key(base),
            dedupe_key(dict(base, detector="watchdog/y")),
            dedupe_key(dict(base, reason="s")),
            dedupe_key(dict(base, mutation="comment")),
        }
        self.assertEqual(len(keys), 4)

    def test_log_is_append_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            snapshot = write_snapshot(tmp, snap(
                hosts=[{"host": "host-1", "diskPct": 99, "load": 9.0,
                        "vcpu": 4, "sustainedMin": 10}]))
            log = str(pathlib.Path(tmp) / "decisions.jsonl")
            run(snapshot, log, [])
            before = pathlib.Path(log).read_bytes()
            run(snapshot, log, [])
            after = pathlib.Path(log).read_bytes()
            self.assertTrue(after.startswith(before))
            self.assertGreater(len(after), len(before))

    def test_measured_values_do_not_change_key(self):
        disk_99 = {"detector": "watchdog/host_health",
                   "reason": "disk at or above 85%", "mutation": "none",
                   "type": "finding",
                   "evidence": {"host": "host-1", "diskPct": 99}}
        disk_96 = {"detector": "watchdog/host_health",
                   "reason": "disk at or above 85%", "mutation": "none",
                   "type": "finding",
                   "evidence": {"host": "host-1", "diskPct": 96}}
        other_host = {"detector": "watchdog/host_health",
                      "reason": "disk at or above 85%", "mutation": "none",
                      "type": "finding",
                      "evidence": {"host": "garm-1", "diskPct": 99}}
        self.assertEqual(dedupe_key(disk_99), dedupe_key(disk_96))
        self.assertNotEqual(dedupe_key(disk_99), dedupe_key(other_host))

    def test_known_log_suppresses_across_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            payload = snap(
                redMains=[{"repo": "paperclip-ops-tooling", "signature": "s1",
                           "incidentExists": False}])
            snapshot = write_snapshot(tmp, payload)
            first_log = str(pathlib.Path(tmp) / "first.jsonl")
            run(snapshot, first_log, [])
            second_log = str(pathlib.Path(tmp) / "second.jsonl")
            _, decisions = run(snapshot, second_log, [first_log])
            self.assertTrue(decisions)
            for row in decisions:
                self.assertEqual(row["verdict"], "skip")

    def test_proposals_dedupe_by_issue(self):
        left = {"detector": "watchdog/churn", "type": "proposal",
                "reason": "repeated stall re-wake", "mutation": "none",
                "issueId": "iid-1", "identifier": "CARD-1"}
        right = dict(left, note="different note text")
        self.assertEqual(dedupe_key(left), dedupe_key(right))
        other = dict(left, issueId="iid-2", identifier="CARD-2")
        self.assertNotEqual(dedupe_key(left), dedupe_key(other))


class VerdictTest(unittest.TestCase):
    def test_high_finding_proposes_info_skips(self):
        with tempfile.TemporaryDirectory() as tmp:
            snapshot = write_snapshot(tmp, snap(
                agents=[
                    {"agentId": "bad", "status": "error",
                     "errorSince": "2026-10-03T13:00:00Z", "subtype": "crash",
                     "owningLead": "cto"},
                    {"agentId": "good", "status": "error",
                     "errorSince": "2026-10-03T13:00:00Z", "subtype": "success",
                     "terminalResultSeen": True, "owningLead": "cto"},
                ]))
            log = str(pathlib.Path(tmp) / "decisions.jsonl")
            _, decisions = run(snapshot, log, [])
            by_detector = [d for d in decisions
                           if d["detector"] == "watchdog/agent_error"]
            self.assertEqual(len(by_detector), 2)
            verdicts = {d["verdict"] for d in by_detector}
            self.assertEqual(verdicts, {"propose", "skip"})

    def test_proposal_row_proposes_first_sight(self):
        record = {"detector": "watchdog/assignment", "type": "proposal",
                  "reason": "review assigned to PR author", "mutation": "none",
                  "issueId": "iid-9", "identifier": "CARD-9",
                  "note": "phase-2 candidate"}
        decision = dry.to_decision(record, set())
        self.assertEqual(decision["verdict"], "propose")
        self.assertEqual(decision["mutation"], "none")

    def test_unknown_severity_proposes_never_silent(self):
        record = {"detector": "watchdog/host_health", "type": "finding",
                  "reason": "hosts snapshot missing", "severity": "unknown",
                  "evidence": {"section": "hosts"},
                  "suggestedAction": "supply the snapshot"}
        decision = dry.to_decision(record, set())
        self.assertEqual(decision["verdict"], "propose")

    def test_scope_prefers_issue_over_evidence(self):
        record = {"issueId": "iid-1", "identifier": "CARD-1",
                  "evidence": {"host": "h"}}
        self.assertEqual(scope_of(record), "iid-1")


class NoMutationTest(unittest.TestCase):
    def test_snapshot_bytes_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            snapshot = write_snapshot(tmp, snap(
                hosts=[{"host": "host-1", "diskPct": 99, "load": 9.0,
                        "vcpu": 4, "sustainedMin": 10}],
                agents=[{"agentId": "a1", "status": "error",
                         "errorSince": "2026-10-03T13:00:00Z",
                         "subtype": "crash", "owningLead": "cto"}]))
            before = pathlib.Path(snapshot).read_bytes()
            log = str(pathlib.Path(tmp) / "decisions.jsonl")
            run(snapshot, log, [])
            run(snapshot, log, [])
            self.assertEqual(pathlib.Path(snapshot).read_bytes(), before)

    def test_no_socket_ever_opened(self):
        real_socket = socket.socket

        def forbidden(*args, **kwargs):
            raise AssertionError("harness opened a socket")

        with tempfile.TemporaryDirectory() as tmp:
            snapshot = write_snapshot(tmp, snap(
                hosts=[{"host": "host-1", "diskPct": 99, "load": 9.0,
                        "vcpu": 4, "sustainedMin": 10}]))
            log = str(pathlib.Path(tmp) / "decisions.jsonl")
            with patch.object(socket, "socket", forbidden):
                self.assertIs(socket.socket, forbidden)
                run(snapshot, log, [])
            self.assertIs(socket.socket, real_socket)

    def test_source_has_no_write_path(self):
        source = (HERE / "watchdog" / "recovery_dryrun.py").read_text()
        for token in ("urllib", "socket", "subprocess", "PaperclipClient",
                      "apply_decision", "api_key", "Bearer"):
            self.assertNotIn(token, source,
                             f"harness source must not contain {token!r}")
        # Code-aware, not substring: the docstring names --apply only to say
        # it does not exist. What must not exist is the flag definition.
        self.assertNotIn('add_argument("--apply"', source)
        self.assertNotIn("add_argument('--apply'", source)
        self.assertIn("mutate nothing", source.lower())

    def test_only_log_file_created(self):
        with tempfile.TemporaryDirectory() as tmp:
            before = set(pathlib.Path(tmp).iterdir())
            snapshot = write_snapshot(tmp, snap())
            log = str(pathlib.Path(tmp) / "decisions.jsonl")
            run(snapshot, log, [])
            created = set(pathlib.Path(tmp).iterdir()) - before - {pathlib.Path(snapshot)}
            self.assertEqual(created, {pathlib.Path(log)})

    def test_cli_never_offers_apply(self):
        buffer = io.StringIO()
        with redirect_stdout(buffer), self.assertRaises(SystemExit) as ctx:
            dry.main(["--help"])
        self.assertEqual(ctx.exception.code, 0)
        self.assertNotIn("apply", buffer.getvalue().lower())


class LoudFailureTest(unittest.TestCase):
    def test_missing_snapshot_fails_loud(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = str(pathlib.Path(tmp) / "decisions.jsonl")
            with self.assertRaises(ValueError):
                run(str(pathlib.Path(tmp) / "nope.json"), log, [])

    def test_corrupt_log_fails_loud(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = pathlib.Path(tmp) / "decisions.jsonl"
            log.write_text('{"type": "decision", "dedupeKey": "abc"}\nNOT JSON\n',
                           encoding="utf-8")
            with self.assertRaises(ValueError):
                load_seen_keys([str(log)])

    def test_non_object_snapshot_fails_loud(self):
        with tempfile.TemporaryDirectory() as tmp:
            snapshot = write_snapshot(tmp, ["not", "an", "object"])
            log = str(pathlib.Path(tmp) / "decisions.jsonl")
            with self.assertRaisesRegex(ValueError, "JSON object"):
                run(snapshot, log, [])
            self.assertFalse(pathlib.Path(log).exists())

    def test_cli_bad_input_exits_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = str(pathlib.Path(tmp) / "decisions.jsonl")
            rc = dry.main(["--snapshot", str(pathlib.Path(tmp) / "nope.json"),
                           "--log", log])
            self.assertEqual(rc, 2)


if __name__ == "__main__":
    unittest.main()
