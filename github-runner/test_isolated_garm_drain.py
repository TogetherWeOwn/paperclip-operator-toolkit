"""Offline suite for the graceful-drain proposal.

Fully offline: validates the checked-in drain-contracts.json against the
GRACEFUL-DRAIN.md proposal through garm/validate_drain.py, plus fixture
mutations. No GARM/LXD mutation, no network, no credential, no host
privilege. Follows the repo contract: cases pin exit codes and stable
schema/result/reason strings, never human-readable message text.

What it pins:
  1. PASS — the checked-in contract exits 0 with offline_drain_valid and
     still authorizes nothing (admission/host/installed all False).
  2. VALUES — grace floor 150, poll 5, bootstrap 20; exact signal sets;
     exact graceful/force edge sets; exact reaper rule lists; exact timeout
     disposition.
  3. REJECTIONS — one mutation per gate (lowered grace, zero poll,
     bootstrap-mistaken-for-grace, widened/weakened signal sets, missing
     action ref, illegal/removed edge, weakened reaper rule, timeout
     auto-escalation, live status), each exiting 1.
  4. LOAD-BEARING — mutants with the grace gate / edge gate deleted accept
     the bad fixture (exit 0), proving case 3 measures the gate.
  5. DOC — GRACEFUL-DRAIN.md names the contract, the checker and this
     suite, and carries the grace floor and the force-delete vocabulary.
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

from garm.validate_drain import (
    ALLOWED_SIGNALS,
    DRAINED_REQUIRES,
    DRAIN_GRACE_MIN,
    FORCE_TRANSITIONS,
    FORBIDDEN_SIGNALS,
    GRACEFUL_TRANSITIONS,
    ORPHANED_RULES,
    POLL_INTERVAL_MIN,
    RUNNER_BOOTSTRAP_TIMEOUT_MIN,
    SIGNAL_REQUIRES,
    TIMEOUT_DISPOSITION,
    InvalidDrain,
    parse,
    validate,
)

HERE = Path(__file__).resolve().parent
GARM = HERE / "garm"
CONTRACT_PATH = GARM / "drain-contracts.json"
CHECKER = GARM / "validate_drain.py"
DOC = GARM / "GRACEFUL-DRAIN.md"


def contract():
    return parse(CONTRACT_PATH.read_bytes())


class DrainTest(unittest.TestCase):
    def reject(self, mutate, label):
        receipt = contract()
        mutate(receipt)
        with self.assertRaises(InvalidDrain, msg=label):
            validate(receipt)

    # ---- 1. checked-in contract passes and authorizes nothing ---------------
    def test_checked_in_contract_valid_and_never_authorizes(self):
        result = validate(contract())
        self.assertEqual(result["result"], "offline_drain_valid")
        for key in ("admission_authorized", "host_verified", "installed"):
            self.assertIs(result[key], False)

    def test_checked_in_cli_passes(self):
        proc = subprocess.run(
            [sys.executable, str(CHECKER), str(CONTRACT_PATH)],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(json.loads(proc.stdout)["result"],
                         "offline_drain_valid")

    # ---- 2. proposed values are exactly the documented ones -----------------
    def test_grace_values(self):
        grace = contract()["grace"]
        self.assertEqual(grace["drain_grace_min"], DRAIN_GRACE_MIN)
        self.assertEqual(grace["drain_grace_min"], 150)
        self.assertEqual(grace["poll_interval_min"], POLL_INTERVAL_MIN)
        self.assertEqual(grace["poll_interval_min"], 5)
        self.assertEqual(grace["runner_bootstrap_timeout_min"],
                         RUNNER_BOOTSTRAP_TIMEOUT_MIN)
        self.assertEqual(grace["runner_bootstrap_timeout_min"], 20)

    def test_signal_sets(self):
        signal = contract()["drain_signal"]
        self.assertEqual(set(signal["allowed"]), ALLOWED_SIGNALS)
        self.assertEqual(set(signal["forbidden"]), FORBIDDEN_SIGNALS)
        self.assertEqual(set(signal["requires"]), SIGNAL_REQUIRES)

    def test_transition_edge_sets(self):
        reaper = contract()["reaper"]
        graceful = {(e["from"], e["to"])
                    for e in reaper["graceful_transitions"]}
        self.assertEqual(graceful, GRACEFUL_TRANSITIONS)
        force = {(e["from"], e["to"]) for e in reaper["force_transitions"]}
        self.assertEqual(force, FORCE_TRANSITIONS)

    def test_reaper_rule_lists(self):
        reaper = contract()["reaper"]
        self.assertEqual(set(reaper["drained_requires_all"]), DRAINED_REQUIRES)
        self.assertEqual(set(reaper["orphaned_if_any"]), ORPHANED_RULES)

    def test_timeout_disposition(self):
        self.assertEqual(contract()["timeout_disposition"], TIMEOUT_DISPOSITION)

    # ---- 3. one rejection per gate ------------------------------------------
    def test_lowered_grace_rejected(self):
        self.reject(lambda c: c["grace"].__setitem__("drain_grace_min", 30),
                    "lowered grace")

    def test_zero_poll_rejected(self):
        self.reject(lambda c: c["grace"].__setitem__("poll_interval_min", 0),
                    "zero poll")

    def test_bootstrap_mistaken_for_grace_rejected(self):
        self.reject(lambda c: c["grace"].__setitem__(
            "runner_bootstrap_timeout_min", 150), "bootstrap as grace")

    def test_weakened_allowed_signal_rejected(self):
        def mutate(c):
            c["drain_signal"]["allowed"].remove("pool_disabled")
        self.reject(mutate, "allowed signal removed")

    def test_job_cancel_as_signal_rejected(self):
        def mutate(c):
            c["drain_signal"]["allowed"].append("job_cancel")
        self.reject(mutate, "job_cancel allowed")

    def test_missing_action_ref_rejected(self):
        def mutate(c):
            c["drain_signal"]["requires"].remove("recorded_action_ref")
        self.reject(mutate, "action ref not required")

    def test_illegal_transition_rejected(self):
        def mutate(c):
            c["reaper"]["graceful_transitions"].append(
                {"from": "running", "to": "deleting"})
        self.reject(mutate, "shortcut edge")

    def test_removed_graceful_edge_rejected(self):
        def mutate(c):
            c["reaper"]["graceful_transitions"] = [
                e for e in c["reaper"]["graceful_transitions"]
                if (e["from"], e["to"]) != ("pending_delete", "deleting")]
        self.reject(mutate, "graceful edge removed")

    def test_removed_force_cleanup_edge_rejected(self):
        def mutate(c):
            c["reaper"]["force_transitions"] = [
                e for e in c["reaper"]["force_transitions"]
                if (e["from"], e["to"]) != ("error", "deleting")]
        self.reject(mutate, "force cleanup edge removed")

    def test_weakened_drained_rule_rejected(self):
        def mutate(c):
            c["reaper"]["drained_requires_all"].remove(
                "vm_absent_and_registration_absent_correlated")
        self.reject(mutate, "drained correlation dropped")

    def test_weakened_orphan_rule_rejected(self):
        def mutate(c):
            c["reaper"]["orphaned_if_any"].remove(
                "vm_absent_xor_registration_absent")
        self.reject(mutate, "half-cleanup orphan dropped")

    def test_timeout_cancel_rejected(self):
        def mutate(c):
            c["timeout_disposition"]["running_job"] = "cancelled_at_timeout"
        self.reject(mutate, "cancel at timeout")

    def test_timeout_auto_force_rejected(self):
        def mutate(c):
            c["timeout_disposition"]["force_delete"] = "automatic"
        self.reject(mutate, "automatic force delete")

    def test_live_status_rejected(self):
        def mutate(c):
            c["status"] = "live"
        self.reject(mutate, "live status")

    def test_authorizing_contract_rejected(self):
        def mutate(c):
            c["admission_authorized"] = True
        self.reject(mutate, "authorizing contract")

    def test_cli_rejects_bad_contract(self):
        bad = contract()
        bad["grace"]["drain_grace_min"] = 30
        with tempfile.NamedTemporaryFile("w", suffix=".json",
                                         delete=False) as stream:
            json.dump(bad, stream)
            path = stream.name
        proc = subprocess.run(
            [sys.executable, str(CHECKER), path],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(json.loads(proc.stdout)["result"],
                         "offline_drain_rejected")

    # ---- 4. load-bearing mutants ---------------------------------------------
    def gate_mutant(self, anchor):
        text = CHECKER.read_text()
        start = text.index("# MUTATION-ANCHOR-START: " + anchor)
        end = text.index("# MUTATION-ANCHOR-END", start)
        mutant = text[:start] + text[end:]
        compile(mutant, str(CHECKER), "exec")
        path = Path(tempfile.mkdtemp()) / "mutant.py"
        path.write_text(mutant)
        return path

    def test_grace_gate_is_load_bearing(self):
        mutant = self.gate_mutant("grace gate")
        bad = contract()
        bad["grace"]["drain_grace_min"] = 30
        with tempfile.NamedTemporaryFile("w", suffix=".json",
                                         delete=False) as stream:
            json.dump(bad, stream)
            path = stream.name
        proc = subprocess.run(
            [sys.executable, str(mutant), path],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0,
                         "grace-gate mutant must accept the lowered grace")

    def test_edge_gate_is_load_bearing(self):
        mutant = self.gate_mutant("edge gate")
        bad = contract()
        bad["reaper"]["graceful_transitions"].append(
            {"from": "running", "to": "deleting"})
        with tempfile.NamedTemporaryFile("w", suffix=".json",
                                         delete=False) as stream:
            json.dump(bad, stream)
            path = stream.name
        proc = subprocess.run(
            [sys.executable, str(mutant), path],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0,
                         "edge-gate mutant must accept the shortcut edge")

    # ---- 5. doc names the artifacts and the floor ----------------------------
    def test_doc_records_proposal(self):
        text = DOC.read_text()
        for anchor in ("drain-contracts.json", "validate_drain.py",
                       "test_isolated_garm_drain.py", "pending_delete",
                       "pending_force_delete", "separate reviewed operator",
                       "150"):
            self.assertIn(anchor, text)

    # ---- 6. hermetic: stdlib only, no leaked env -----------------------------
    def test_checker_is_stdlib_only(self):
        text = CHECKER.read_text()
        for module in ("socket", "subprocess", "urllib", "requests",
                       "os.system", "os.popen"):
            self.assertNotIn("import " + module, text)

    def test_sentinel_never_leaks(self):
        proc = subprocess.run(
            [sys.executable, str(CHECKER), str(CONTRACT_PATH)],
            capture_output=True, text=True, timeout=60,
            env={"PATH": "/usr/bin:/bin",
                 "SENTINEL_GARM_TEST": "s3cr3t-sentinel-xyz"})
        self.assertEqual(proc.returncode, 0)
        self.assertNotIn("s3cr3t-sentinel-xyz", proc.stdout + proc.stderr)

    # ---- 7. usage: unreadable and malformed input fail closed -----------------
    def test_missing_file_exits_1(self):
        proc = subprocess.run(
            [sys.executable, str(CHECKER),
             str(GARM / "does-not-exist.json")],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 1)

    def test_malformed_input_never_echoes(self):
        with tempfile.NamedTemporaryFile("wb", suffix=".json",
                                         delete=False) as stream:
            stream.write(b'{"sentinel": "s3cr3t-sentinel-xyz", broken')
            path = stream.name
        proc = subprocess.run(
            [sys.executable, str(CHECKER), path],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 1)
        self.assertNotIn("s3cr3t-sentinel-xyz", proc.stdout + proc.stderr)

    def test_duplicate_key_rejected(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json",
                                         delete=False) as stream:
            stream.write('{"schema": "a", "schema": "b"}')
            path = stream.name
        proc = subprocess.run(
            [sys.executable, str(CHECKER), path],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 1)


if __name__ == "__main__":
    unittest.main()
