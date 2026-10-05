#!/usr/bin/env python3
# ===========================================================================
# test_pacer_admission_audit.py — hostile tests for the append-only pacer
# admission audit writer
#
# Written to FAIL a plausible-but-wrong implementation, not to confirm the
# one that exists:
#
# * §3 kills the overwrite mutant: a writer that opens "w" instead of "a"
#   keeps every single-record case green while destroying history. The
#   two-append ordering case is the only one that can see it.
# * §5 kills the swapped/no-op rotation mutant: rotation that keeps the
#   OLDEST lines (prefix) instead of the newest (suffix) still shrinks the
#   file and still passes a "cap is enforced" assertion. Only a case that
#   names WHICH lines survive can see it.
# * §6 kills the dead-validation mutant: any removed check must go red.
#   NaN/Inf matter because Python's json emits them as bare words by
#   default, which is not JSON and poisons every downstream reader.
# * §7 pins the shadow contract: the writer stamps mode="shadow" itself
#   and never touches selection. An audit writer that can flip enforcement
#   is the enforce flip wearing a different filename.
#
# Deterministic: every case pins `now`/`ts` explicitly. No network, no
# clock read, no write outside a temp dir.
# ===========================================================================
import datetime
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pacer_admission_audit import (  # noqa: E402
    AUDIT_BASENAME,
    AuditError,
    build_record,
    default_audit_path,
    read_records,
    record_decision,
)

UTC = datetime.timezone.utc
NOW = datetime.datetime(2026, 10, 3, 12, 0, 0, tzinfo=UTC)
HERE = os.path.dirname(os.path.abspath(__file__))
WRITER = os.path.join(HERE, "pacer_admission_audit.py")


class AuditWriterTest(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".jsonl")
        os.close(fd)
        os.unlink(self.path)  # writer must create, not require
        self._extra = []

    def tearDown(self):
        for p in [self.path] + self._extra:
            try:
                os.unlink(p)
            except OSError:
                pass

    def raw_lines(self):
        with open(self.path, encoding="utf-8") as fh:
            return fh.read().splitlines()

    # -- §1  record shape ----------------------------------------------------
    def test_01_allow_record_carries_all_fields(self):
        r = record_decision(self.path, "claude-sonnet", "allow", 0.42,
                            "under pace", ts="2026-10-03T12:00:00Z")
        self.assertEqual(r["v"], 1)
        self.assertEqual(r["ts"], "2026-10-03T12:00:00Z")
        self.assertEqual(r["lane"], "claude-sonnet")
        self.assertEqual(r["decision"], "allow")
        self.assertEqual(r["headroom"], 0.42)
        self.assertEqual(r["reason"], "under pace")
        self.assertEqual(r["mode"], "shadow")
        # And the file holds exactly that object as one JSON line.
        self.assertEqual(json.loads(self.raw_lines()[0]), r)

    def test_01_deny_record_shape(self):
        r = record_decision(self.path, "codex", "deny", 0.0,
                            "window exhausted", ts="2026-10-03T12:01:00Z")
        self.assertEqual(r["decision"], "deny")
        self.assertEqual(r["headroom"], 0.0)
        self.assertEqual(json.loads(self.raw_lines()[0]), r)

    def test_01_default_ts_is_pinned_now(self):
        r = record_decision(self.path, "opus", "allow", 0.9, now=NOW)
        self.assertEqual(r["ts"], "2026-10-03T12:00:00Z")

    # -- §2  headroom snapshot values -----------------------------------------
    def test_02_negative_headroom_is_recorded_not_refused(self):
        # Overdrawn is a real state an audit must be able to say, not a
        # validation failure. Refusing it would blind the log exactly when
        # the pacer is most interesting.
        r = record_decision(self.path, "opus", "deny", -0.05,
                            ts="2026-10-03T12:00:00Z")
        self.assertEqual(json.loads(self.raw_lines()[0])["headroom"], -0.05)

    def test_02_zero_headroom_deny_is_recorded(self):
        r = record_decision(self.path, "opus", "deny", 0,
                            ts="2026-10-03T12:00:00Z")
        self.assertEqual(r["headroom"], 0.0)

    # -- §3  append-only: history is never rewritten --------------------------
    def test_03_two_appends_preserve_both_in_order(self):
        # Kills the "w"-instead-of-"a" mutant: with truncation the first
        # record vanishes and this is the only case that notices.
        first = record_decision(self.path, "lane-a", "allow", 0.5,
                                ts="2026-10-03T12:00:00Z")
        second = record_decision(self.path, "lane-b", "deny", 0.1,
                                 ts="2026-10-03T12:01:00Z")
        lines = self.raw_lines()
        self.assertEqual(len(lines), 2)
        self.assertEqual(json.loads(lines[0]), first)
        self.assertEqual(json.loads(lines[1]), second)

    def test_03_third_append_keeps_all_three(self):
        for i, lane in enumerate(("a", "b", "c")):
            record_decision(self.path, lane, "allow", 0.5 - i * 0.1,
                            ts="2026-10-03T12:0%d:00Z" % i)
        recs = read_records(self.path)
        self.assertEqual([r["lane"] for r in recs], ["a", "b", "c"])

    def test_03_partial_tail_line_does_not_blank_the_log(self):
        record_decision(self.path, "a", "allow", 0.5,
                        ts="2026-10-03T12:00:00Z")
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write('{"v":1,"ts":"2026-10-03T12:0')  # half-flushed line
        recs = read_records(self.path)
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["lane"], "a")

    # -- §4  rotation / size cap ------------------------------------------------
    def test_04_max_lines_keeps_newest(self):
        for i in range(5):
            record_decision(self.path, "lane-%d" % i, "allow", 0.5,
                            ts="2026-10-03T12:0%d:00Z" % i,
                            max_lines=3, max_bytes=0)
        recs = read_records(self.path)
        # Kills the keep-oldest mutant: a prefix-keeping rotation returns
        # lane-0..2 and still satisfies "length <= 3".
        self.assertEqual([r["lane"] for r in recs],
                         ["lane-2", "lane-3", "lane-4"])

    def test_04_max_bytes_keeps_newest_and_stays_valid_jsonl(self):
        for i in range(6):
            record_decision(self.path, "lane-%d" % i, "allow", 0.5,
                            ts="2026-10-03T12:0%d:00Z" % i,
                            max_lines=0, max_bytes=400)
        lines = self.raw_lines()
        with open(self.path, "rb") as fh:
            self.assertLessEqual(len(fh.read()), 800)  # suffix, not exact
        for ln in lines:
            json.loads(ln)  # every surviving line still parses
        recs = read_records(self.path)
        self.assertEqual(recs[-1]["lane"], "lane-5")
        self.assertNotIn("lane-0", [r["lane"] for r in recs])

    def test_04_single_record_larger_than_cap_is_still_kept(self):
        # Evidence beats accounting: one decision larger than max_bytes
        # must survive rotation, not vanish the write that just happened.
        record_decision(self.path, "a", "allow", 0.5,
                        ts="2026-10-03T12:00:00Z",
                        max_lines=0, max_bytes=10)
        self.assertEqual(len(read_records(self.path)), 1)

    def test_04_no_rotation_under_cap(self):
        record_decision(self.path, "a", "allow", 0.5,
                        ts="2026-10-03T12:00:00Z")
        record_decision(self.path, "b", "deny", 0.1,
                        ts="2026-10-03T12:01:00Z")
        self.assertEqual(len(read_records(self.path)), 2)

    # -- §5  validation refuses before touching the file -----------------------
    def test_05_bad_decision_refuses_and_writes_nothing(self):
        with self.assertRaises(AuditError):
            record_decision(self.path, "a", "maybe", 0.5,
                            ts="2026-10-03T12:00:00Z")
        self.assertFalse(os.path.exists(self.path))

    def test_05_empty_lane_refuses(self):
        for bad in ("", "   "):
            with self.assertRaises(AuditError):
                build_record(bad, "allow", 0.5, now=NOW)

    def test_05_lane_with_newline_refuses(self):
        with self.assertRaises(AuditError):
            build_record("a\nb", "allow", 0.5, now=NOW)

    def test_05_non_numeric_headroom_refuses(self):
        for bad in ("0.5", None, [0.5], {"h": 0.5}, True):
            with self.assertRaises(AuditError):
                build_record("a", "allow", bad, now=NOW)

    def test_05_nan_and_inf_headroom_refuse(self):
        for bad in (float("nan"), float("inf"), float("-inf")):
            with self.assertRaises(AuditError):
                build_record("a", "allow", bad, now=NOW)

    def test_05_bad_ts_refuses(self):
        for bad in ("tomorrow", "2026-10-03 12:00 UTC", "2026-10-03T12:00:00",
                    "2026-10-03", ""):
            with self.assertRaises(AuditError):
                build_record("a", "allow", 0.5, ts=bad)

    def test_05_oversize_reason_refuses(self):
        with self.assertRaises(AuditError):
            build_record("a", "allow", 0.5, reason="x" * 513, now=NOW)

    def test_05_negative_caps_refuse_and_write_nothing(self):
        # A negative cap is not "extra disabled": silently treating it as
        # disabled lets a sign typo turn rotation off without saying so.
        # Zero stays an open disable; negatives refuse before any write.
        for kwargs in ({"max_bytes": -1}, {"max_lines": -100},
                       {"max_bytes": -1, "max_lines": -1}):
            with self.assertRaises(AuditError):
                record_decision(self.path, "a", "allow", 0.5,
                                ts="2026-10-03T12:00:00Z", **kwargs)
        self.assertFalse(os.path.exists(self.path))

    def test_05_zero_caps_disable_openly(self):
        r = record_decision(self.path, "a", "allow", 0.5,
                            ts="2026-10-03T12:00:00Z",
                            max_bytes=0, max_lines=0)
        self.assertEqual(r["decision"], "allow")
        self.assertEqual(len(read_records(self.path)), 1)

    # -- §6  shadow contract: mode stamped, selection untouched -----------------
    def test_06_mode_is_always_shadow(self):
        r = record_decision(self.path, "a", "deny", 0.0,
                            ts="2026-10-03T12:00:00Z")
        self.assertEqual(r["mode"], "shadow")
        self.assertEqual(json.loads(self.raw_lines()[0])["mode"], "shadow")

    def test_06_record_has_no_enforcement_keys(self):
        # The writer's vocabulary ends at the record. Any selection,
        # enforce, weight, or throttle key in the output is scope creep
        # toward the enforce flip.
        r = record_decision(self.path, "a", "allow", 0.5, reason="enforce?",
                            ts="2026-10-03T12:00:00Z")
        for forbidden in ("selection", "enforce", "weight", "throttle",
                          "priority", "disabled"):
            self.assertNotIn(forbidden, r)

    def test_06_module_does_not_import_selection(self):
        # Code coupling, not prose: the header may SAY "selection" (it
        # names what this module refuses to touch), but no import, call,
        # or file access may bind to it. A mutant that wires the writer
        # into the enforce path must trip one of these.
        with open(WRITER, encoding="utf-8") as fh:
            code = "\n".join(
                ln for ln in fh.read().splitlines()
                if not ln.lstrip().startswith("#"))
        for coupling in ("import selection", "from selection", "selection.",
                         "select_model", "selection_mode", "enforce("):
            self.assertNotIn(coupling, code)

    # -- §7  CLI end to end ------------------------------------------------------
    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, WRITER, "--file", self.path, *args],
            capture_output=True, text=True)

    def test_07_cli_allow_exits_0_and_appends(self):
        cp = self.run_cli("--lane", "claude-sonnet", "--decision", "allow",
                          "--headroom", "0.42", "--reason", "under pace",
                          "--ts", "2026-10-03T12:00:00Z")
        self.assertEqual(cp.returncode, 0, cp.stderr)
        recs = read_records(self.path)
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["decision"], "allow")

    def test_07_cli_bad_decision_exits_2_and_writes_nothing(self):
        cp = self.run_cli("--lane", "a", "--decision", "maybe",
                          "--headroom", "0.5")
        self.assertEqual(cp.returncode, 2)
        self.assertFalse(os.path.exists(self.path))

    def test_07_cli_nan_headroom_exits_2(self):
        cp = self.run_cli("--lane", "a", "--decision", "allow",
                          "--headroom", "nan")
        self.assertEqual(cp.returncode, 2)
        self.assertFalse(os.path.exists(self.path))

    # -- §8  default log location comes from the environment ----------------
    def test_08_default_path_follows_handoff_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = {"HANDOFF_DIR": tmp, "HOME": os.path.join(tmp, "home")}
            with mock.patch.dict(os.environ, env):
                self.assertEqual(default_audit_path(),
                                 os.path.join(tmp, AUDIT_BASENAME))

    def test_08_default_path_falls_back_to_home_handoff(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = {"HOME": tmp}
            with mock.patch.dict(os.environ, env, clear=True):
                self.assertEqual(
                    default_audit_path(),
                    os.path.join(tmp, "handoff", AUDIT_BASENAME))

    def test_08_cli_without_file_appends_under_handoff_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            cp = subprocess.run(
                [sys.executable, WRITER, "--lane", "claude-sonnet",
                 "--decision", "allow", "--headroom", "0.42",
                 "--ts", "2026-10-03T12:00:00Z"],
                capture_output=True, text=True,
                env={"HANDOFF_DIR": tmp, "HOME": os.path.join(tmp, "home"),
                     "PATH": os.environ.get("PATH", "")})
            self.assertEqual(cp.returncode, 0, cp.stderr)
            recs = read_records(os.path.join(tmp, AUDIT_BASENAME))
            self.assertEqual([r["lane"] for r in recs], ["claude-sonnet"])

    def test_07_cli_negative_cap_exits_2_and_writes_nothing(self):
        cp = self.run_cli("--lane", "a", "--decision", "allow",
                          "--headroom", "0.5", "--max-bytes", "-5")
        self.assertEqual(cp.returncode, 2)
        self.assertFalse(os.path.exists(self.path))


if __name__ == "__main__":
    unittest.main(verbosity=2)
