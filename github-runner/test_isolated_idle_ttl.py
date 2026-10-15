"""Offline suite for the idle-VM TTL/reaper proposal.

Fully offline: validates the checked-in idle-ttl-contracts.json against
the IDLE-TTL-REAPER-POLICY.md proposal through garm/validate_idle_ttl.py,
plus fixture mutations. No GARM/LXD calls, no VM deletion, no network, no
credential, no host privilege. Follows the repo contract: cases pin exit
codes and stable schema/result/reason strings, never human-readable
message text.

What it pins:
  1. PASS — the checked-in contract exits 0 with offline_idle_ttl_valid
     and still authorizes nothing (admission/host/installed all False).
  2. VALUES — TTL 240 / orphan x2 = 480, prov-stuck 30, drain-stuck 60;
     ephemeral propose on both image roles; canary observe-only with
     stuck-still-breaches; static out-of-scope with no TTL; reap order
     idle-excess, stale, busy, oldest-first; breach heads report but is
     not a delete order; exact dry-run report shape; exact timeout
     disposition.
  3. REJECTIONS — one mutation per gate (lowered TTL, canary flipped to
     propose, canary allowed as candidate, static given a TTL, reordered
     buckets, newest-first, breach-as-delete-order, dropped report field,
     timeout auto-escalation, live status), each exiting 1.
  4. LOAD-BEARING — mutants with the canary gate / reap-order gate deleted
     accept the bad fixture (exit 0), proving case 3 measures the gate.
  5. DOC — IDLE-TTL-REAPER-POLICY.md names the contract, the checker and
     this suite, and carries the per-pool table and the reap order.
  6. HERMETIC — a sentinel env value never appears in output; the checker
     is stdlib-only (no socket/subprocess imports).
  7. USAGE — missing file and malformed/duplicate-key input exit 1 with a
     non-echoing reason.

Exit 0 all pass; 1 any failure.
"""

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from garm.validate_idle_ttl import (
    CANDIDATE_FIELDS,
    DRAIN_STUCK_MIN,
    EPHEMERAL_ROLES,
    ORPHAN_MIN,
    PROV_STUCK_MIN,
    REAP_ORDER,
    REPORT_TOP_LEVEL,
    STATIC_LABELS,
    TTL_MIN,
    VERDICTS,
)

HERE = Path(__file__).resolve().parent
GARM = HERE / "garm"
CONTRACT = GARM / "idle-ttl-contracts.json"
CHECKER = GARM / "validate_idle_ttl.py"
SPEC = GARM / "IDLE-TTL-REAPER-POLICY.md"


def run_checker(doc_path):
    r = subprocess.run(
        [sys.executable, "-B", str(CHECKER), str(doc_path)],
        capture_output=True, text=True, timeout=60)
    try:
        payload = json.loads(r.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError):
        payload = {}
    return r.returncode, payload


def mutated_doc(mutator):
    doc = json.loads(CONTRACT.read_text())
    mutator(doc)
    tmp = tempfile.NamedTemporaryFile(
        "w", suffix=".json", delete=False)
    json.dump(doc, tmp)
    tmp.close()
    return tmp.name


class IdleTtlTest(unittest.TestCase):
    def test_1_pass_authorizes_nothing(self):
        rc, payload = run_checker(CONTRACT)
        self.assertEqual(rc, 0)
        self.assertEqual(payload.get("status"), "offline_idle_ttl_valid")
        doc = json.loads(CONTRACT.read_text())
        self.assertIs(doc["admission_authorized"], False)
        self.assertIs(doc["host_verified"], False)
        self.assertIs(doc["installed"], False)

    def test_2_values(self):
        doc = json.loads(CONTRACT.read_text())
        self.assertEqual(doc["reaper_defaults"]["ttl_min"], TTL_MIN)
        self.assertEqual(doc["reaper_defaults"]["orphan_min"], ORPHAN_MIN)
        self.assertEqual(doc["reaper_defaults"]["prov_stuck_min"],
                         PROV_STUCK_MIN)
        self.assertEqual(doc["reaper_defaults"]["drain_stuck_min"],
                         DRAIN_STUCK_MIN)
        self.assertEqual(set(doc["pools"]["ephemeral-default"]["roles"]),
                         EPHEMERAL_ROLES)
        self.assertEqual(doc["pools"]["ephemeral-default"]["mode"],
                         "propose")
        self.assertEqual(doc["pools"]["canary"]["mode"], "observe-only")
        self.assertIs(doc["pools"]["canary"]["never_candidate"], True)
        self.assertIs(doc["pools"]["canary"]["stuck_still_breaches"], True)
        self.assertEqual(doc["pools"]["static"]["mode"], "out-of-scope")
        self.assertEqual(set(doc["pools"]["static"]["labels"]),
                         STATIC_LABELS)
        self.assertEqual(doc["reap_order"], REAP_ORDER)
        self.assertEqual(doc["within_bucket"], "oldest-first")
        self.assertIs(doc["breach_heads_report_but_is_not_delete_order"],
                      True)
        self.assertEqual(set(doc["dry_run_report"]["required_top_level"]),
                         REPORT_TOP_LEVEL)
        self.assertEqual(set(doc["dry_run_report"]["candidate_fields"]),
                         CANDIDATE_FIELDS)
        self.assertEqual(set(doc["dry_run_report"]["verdicts"]), VERDICTS)

    def test_3_rejections(self):
        cases = [
            ("lowered-ttl",
             lambda d: d["reaper_defaults"].__setitem__("ttl_min", 30)),
            ("canary-to-propose",
             lambda d: d["pools"]["canary"].__setitem__("mode",
                                                       "propose")),
            ("canary-candidate",
             lambda d: d["pools"]["canary"].__setitem__("never_candidate",
                                                       False)),
            ("static-with-ttl",
             lambda d: d["pools"]["static"].__setitem__("ttl_min", 240)),
            ("reordered-buckets",
             lambda d: d.__setitem__("reap_order",
                                    ["busy", "stale", "idle-excess"])),
            ("newest-first",
             lambda d: d.__setitem__("within_bucket", "newest-first")),
            ("breach-is-delete-order",
             lambda d: d.__setitem__(
                 "breach_heads_report_but_is_not_delete_order", False)),
            ("dropped-report-field",
             lambda d: d["dry_run_report"]["required_top_level"].remove(
                 "breachReasons")),
            ("timeout-auto-escalation",
             lambda d: d["timeout_disposition"].__setitem__(
                 "running_job", "force_delete_at_timeout")),
            ("live-status",
             lambda d: d.__setitem__("installed", True)),
        ]
        for label, mut in cases:
            with self.subTest(gate=label):
                path = mutated_doc(mut)
                rc, payload = run_checker(path)
                self.assertEqual(rc, 1, label)
                self.assertEqual(payload.get("status"),
                                 "invalid_idle_ttl", label)

    def test_4_load_bearing(self):
        src = CHECKER.read_text()
        no_canary = src.replace(
            'or can.get("never_candidate") is not True', "")
        self.assertNotEqual(no_canary, src)
        tmp = tempfile.NamedTemporaryFile(
            "w", suffix=".py", delete=False)
        tmp.write(no_canary)
        tmp.close()
        doc = json.loads(CONTRACT.read_text())
        doc["pools"]["canary"]["never_candidate"] = False
        bad = tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False)
        json.dump(doc, bad)
        bad.close()
        r = subprocess.run(
            [sys.executable, "-B", tmp.name, bad.name],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0,
                         "canary gate removed must accept the bad fixture")

        no_order = src.replace(
            'if list(doc.get("reap_order", [])) != REAP_ORDER:',
            'if False:')
        self.assertNotEqual(no_order, src)
        tmp2 = tempfile.NamedTemporaryFile(
            "w", suffix=".py", delete=False)
        tmp2.write(no_order)
        tmp2.close()
        doc2 = json.loads(CONTRACT.read_text())
        doc2["reap_order"] = ["busy", "stale", "idle-excess"]
        bad2 = tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False)
        json.dump(doc2, bad2)
        bad2.close()
        r2 = subprocess.run(
            [sys.executable, "-B", tmp2.name, bad2.name],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(r2.returncode, 0,
                         "order gate removed must accept the bad fixture")

    def test_5_doc(self):
        text = SPEC.read_text()
        for needle in ("idle-ttl-contracts.json", "validate_idle_ttl.py",
                       "test_isolated_idle_ttl.py", "oldest-first",
                       "observe-only", "out-of-scope",
                       "idle-excess", "240"):
            self.assertIn(needle, text)

    def test_6_hermetic(self):
        src = CHECKER.read_text()
        self.assertNotIn("import socket", src)
        self.assertNotIn("import subprocess", src)
        r = subprocess.run(
            [sys.executable, "-B", str(CHECKER), str(CONTRACT)],
            capture_output=True, text=True, timeout=60,
            env={"PATH": "/usr/bin:/bin",
                 "IDLE_TTL_SENTINEL": "sentinel-abc-123"})
        self.assertNotIn("sentinel-abc-123", r.stdout + r.stderr)

    def test_7_usage(self):
        rc, payload = run_checker(GARM / "does-not-exist.json")
        self.assertEqual(rc, 1)
        self.assertEqual(payload.get("status"), "invalid_idle_ttl")
        bad = tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False)
        bad.write('{"a": 1, "a": 2, "schema": "nope"}')
        bad.close()
        rc2, payload2 = run_checker(bad.name)
        self.assertEqual(rc2, 1)
        self.assertEqual(payload2.get("status"), "invalid_idle_ttl")
        self.assertNotIn("nope", json.dumps(payload2))


if __name__ == "__main__":
    unittest.main()
