"""Offline tests for garm/storage_auto_reclaim.py.

Source-only: synthetic fixtures, no network, no host, no GitHub. Joins the
existing test_isolated_*.py discovery pattern. Run from the repo root:

python3 -B -m unittest discover -s github-runner -p 'test_isolated_storage_auto_reclaim.py' -v
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from garm.storage_auto_reclaim import (
    THRESHOLDS,
    InvalidInput,
    classify_volume,
    plan_observation,
    validate_observation,
)

HERE = Path(__file__).resolve().parent
PLANNER = HERE / "garm" / "storage_auto_reclaim.py"


def vol(name="vol-a", **overrides):
    base = {"name": name,
            "kind": "finished-job-volume",
            "finish": "natural",
            "minutes_since_finish": 90,
            "vm_present": False,
            "has_registration": False,
            "has_active_job": False,
            "protected": False,
            "parent_reclaimed": True}
    base.update(overrides)
    return base


def obs(volumes=None, used_pct=80, read_age_min=2):
    return {"schema": "garm-storage-reclaim.plan.v1",
            "source": "synthetic-fixture",
            "pool": {"used_pct": used_pct, "read_age_min": read_age_min},
            "volumes": list(volumes or [])}


class ThresholdsRecordedTest(unittest.TestCase):
    def test_thresholds_match_spec(self):
        self.assertEqual(THRESHOLDS, {
            "R2_reclaim_window_min": 30,
            "R3_stale_flag_min": 60,
            "R4_orphan_candidate_min": 1440,
            "R5_read_freshness_min": 5,
            "reclaim_trigger_used_pct": 75,
        })


class ValidationTest(unittest.TestCase):
    def test_accepts_minimal_empty_plan(self):
        self.assertEqual(plan_observation(obs())["result"],
                         "nothing_to_reclaim")

    def test_rejects_live_host_source(self):
        with self.assertRaises(InvalidInput):
            validate_observation(obs([vol()], used_pct=80) |
                                 {"source": "live-host"})

    def test_rejects_unknown_kind(self):
        with self.assertRaises(InvalidInput):
            validate_observation(obs([vol(kind="root-disk")]))

    def test_rejects_duplicate_names(self):
        with self.assertRaises(InvalidInput):
            validate_observation(obs([vol("dup"), vol("dup")]))

    def test_rejects_nonfinite(self):
        with self.assertRaises(InvalidInput):
            validate_observation(obs([vol(minutes_since_finish=float("inf"))]))


class ClassificationTest(unittest.TestCase):
    def test_protected_never_planned(self):
        item = classify_volume(vol(protected=True, minutes_since_finish=10**4),
                               99)
        self.assertEqual(item["decision"], "hold")
        self.assertFalse(item["delete_authorized"])

    def test_active_job_holds(self):
        item = classify_volume(vol(has_active_job=True,
                                   minutes_since_finish=10**4), 99)
        self.assertEqual(item["decision"], "hold")

    def test_registration_present_holds(self):
        item = classify_volume(vol(has_registration=True,
                                   minutes_since_finish=10**4), 99)
        self.assertEqual(item["decision"], "hold")

    def test_non_natural_finish_inconclusive(self):
        for finish in ("killed", "cancelled", "timeout"):
            item = classify_volume(vol(finish=finish,
                                       minutes_since_finish=10**4), 99)
            self.assertEqual(item["decision"], "inconclusive", finish)

    def test_within_r2_window_holds(self):
        item = classify_volume(vol(minutes_since_finish=10), 99)
        self.assertEqual(item["decision"], "hold")

    def test_below_r3_holds(self):
        item = classify_volume(vol(minutes_since_finish=45), 99)
        self.assertEqual(item["decision"], "hold")

    def test_stale_finished_plans_only_under_pressure(self):
        planned = classify_volume(vol(minutes_since_finish=90), 80)
        held = classify_volume(vol(minutes_since_finish=90), 50)
        self.assertEqual(planned["decision"], "reclaim_plan")
        self.assertEqual(held["decision"], "hold")

    def test_trigger_boundary_is_inclusive(self):
        item = classify_volume(vol(minutes_since_finish=90), 75)
        self.assertEqual(item["decision"], "reclaim_plan")

    def test_dangling_snapshot_needs_confirmed_parent(self):
        item = classify_volume(vol(kind="dangling-snapshot",
                                   parent_reclaimed=False,
                                   minutes_since_finish=90), 99)
        self.assertEqual(item["decision"], "hold")
        item = classify_volume(vol(kind="dangling-snapshot",
                                   parent_reclaimed=True,
                                   minutes_since_finish=90), 80)
        self.assertEqual(item["decision"], "reclaim_plan")

    def test_orphan_hygiene_unconditional_past_r4(self):
        item = classify_volume(vol(kind="orphan-volume",
                                   minutes_since_finish=1500), 10)
        self.assertEqual(item["decision"], "reclaim_plan")

    def test_orphan_between_r3_r4_flags_not_plans(self):
        item = classify_volume(vol(kind="orphan-volume",
                                   minutes_since_finish=120), 99)
        self.assertEqual(item["decision"], "hold")

    def test_no_output_ever_authorizes_mutation(self):
        result = plan_observation(obs([vol(minutes_since_finish=10**4)],
                                      used_pct=99))
        self.assertFalse(result["host_mutation_authorized"])
        self.assertFalse(result["delete_authorized"])
        for item in result["volumes"]:
            self.assertFalse(item["host_mutation_authorized"])
            self.assertFalse(item["delete_authorized"])


class PlanResultTest(unittest.TestCase):
    def test_stale_read_is_inconclusive(self):
        result = plan_observation(obs([vol(minutes_since_finish=10**4)],
                                      used_pct=99, read_age_min=9))
        self.assertEqual(result["result"], "inconclusive")
        self.assertEqual(result["volumes"], [])

    def test_plan_ready_names_planned(self):
        result = plan_observation(obs([vol("a", minutes_since_finish=90),
                                       vol("b", minutes_since_finish=5)],
                                      used_pct=80))
        self.assertEqual(result["result"], "plan_ready")
        self.assertEqual(result["planned"], ["a"])


def run_cli(*args, fixture=None):
    """Run the planner CLI offline; fixture dict is written to a temp file.

    The literal "OBS" in args is replaced with the fixture path.
    """
    with tempfile.TemporaryDirectory() as tmp:
        argv = list(args)
        if fixture is not None:
            path = Path(tmp) / "obs.json"
            path.write_text(json.dumps(fixture), encoding="utf-8")
            argv = [str(path) if a == "OBS" else a for a in argv]
        cmd = [sys.executable, str(PLANNER)] + argv
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        return proc


class CliDryRunTest(unittest.TestCase):
    def test_plan_cli_prints_verdict_lines_and_json(self):
        proc = run_cli("OBS", fixture=obs([vol(minutes_since_finish=90)],
                                           used_pct=80))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("garm-storage-reclaim: PLAN", proc.stdout)
        self.assertIn("host_mutation_authorized=false", proc.stdout)
        body = proc.stdout[proc.stdout.index("{"):]
        parsed = json.loads(body)
        self.assertEqual(parsed["result"], "plan_ready")
        self.assertFalse(parsed["delete_authorized"])

    def test_write_intent_refused(self):
        for flag in ("--apply", "--delete", "--prune", "--purge",
                     "--exec", "--force", "--yes", "apply"):
            proc = run_cli(flag, "OBS",
                           fixture=obs([vol(minutes_since_finish=90)],
                                       used_pct=80))
            self.assertEqual(proc.returncode, 2, flag)
            self.assertIn("REFUSED", proc.stderr)

    def test_write_intent_refusal_is_load_bearing(self):
        """A mutant with the refusal gate deleted must plan under --apply."""
        src = PLANNER.read_text(encoding="utf-8")
        start = src.index("# MUTATION-ANCHOR-START")
        end = src.index("# MUTATION-ANCHOR-END") + len("# MUTATION-ANCHOR-END")
        mutant = src[:start] + src[end:]
        with tempfile.TemporaryDirectory() as tmp:
            mutant_path = Path(tmp) / "mutant.py"
            mutant_path.write_text(mutant, encoding="utf-8")
            fix_path = Path(tmp) / "obs.json"
            fix_path.write_text(json.dumps(obs([vol(minutes_since_finish=90)],
                                               used_pct=80)),
                                 encoding="utf-8")
            proc = subprocess.run(
                [sys.executable, str(mutant_path), "--apply",
                 str(fix_path)],
                capture_output=True, text=True, timeout=10)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("garm-storage-reclaim: PLAN", proc.stdout)

    def test_bad_input_refused_exit2(self):
        proc = run_cli("OBS", fixture={"nope": True})
        self.assertEqual(proc.returncode, 2)
        self.assertIn("REFUSED", proc.stderr)


if __name__ == "__main__":
    unittest.main()
