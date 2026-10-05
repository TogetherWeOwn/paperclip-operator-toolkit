#!/usr/bin/env python3
# ===========================================================================
# test_isolated_wave1_window_verdict.py — hostile tests for the Wave-1 window
# verdict evaluator (two-tier HOLD / NO-GO triggers as code)
#
# Written to FAIL a plausible-but-wrong evaluator, not to confirm the one
# that exists. Every section names the shortcut it kills:
#
# §1  Each HOLD trigger alone yields HOLD with exactly its own reason code,
#     and each NO-GO trigger alone yields NO-GO. An evaluator that only
#     checks the first trigger, or merges codes, goes red.
# §2  Tier precedence: NO-GO outranks HOLD outranks UNKNOWN outranks
#     PROCEED, and every reason of every tier is still reported.
# §3  Null or missing is UNKNOWN for EVERY field, never PROCEED. An
#     evaluator that defaults a null to 0 / False reads "no filesystem
#     pressure" and "no production-DB contact" it never observed.
# §4  Boundaries are pinned exact (900 s, 95 %, 24 h, 10 per arm). An
#     off-by-one (>= vs >) reads the boundary on the wrong side.
# §5  Fail-closed parser: unknown key (incl. an input that tries to carry
#     admission_authorized:true), wrong types, bool-as-int, out-of-range,
#     duplicate keys, non-finite numbers, NUL, nesting, oversize all refuse
#     (exit 1) and never echo the rejected value.
# §6  Every result, PROCEED included, carries admission_authorized:false,
#     host_verified:false, migration_complete:false.
# §7  CLI exit codes: 0 PROCEED, 2 HOLD, 3 UNKNOWN, 4 NO-GO, 1 invalid
#     (usage errors too, so a caller mistake never reads as HOLD).
# §8  Doc-drift: the numbers in runbook section 2 equal the code constants;
#     the extractor is itself proven non-vacuous on a doctored runbook.
# §9  LOAD-BEARING mutants: HOLD demoted to PROCEED, null treated as zero,
#     NO-GO not outranking HOLD (plus boundary/flag mutants) each turn the
#     contract suite red.
# §10 Offline by construction: the module imports only the stdlib subset it
#     needs (no network, clock, subprocess or environment access).
# ===========================================================================
import ast
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from garm import wave1_window_verdict as real

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "garm" / "wave1_window_verdict.py"
FIXTURE = HERE / "garm" / "fixture-wave1-window-green.json"
RUNBOOK = HERE.parent / "docs" / "runbooks" / "garm-wave1-cutover-dryrun.md"

NOGO_FIELDS = ("interrupted_active_job", "production_db_contact",
               "unauthorized_access_or_routing", "unexplained_lifecycle_leak",
               "cap_or_admission_increase", "host_pressure_stop_breach")
EXPECTED_FIELDS = {
    "pickup_observed", "pickup_wait_s", "tests_required", "tests_passed",
    "tests_skipped", "budget_evidence_age_s", "fs_max_use_pct",
    "pressure_incident_unresolved", "static_fallback_available",
    "trial_hours", "comparable_attempts_garm", "comparable_attempts_static",
} | set(NOGO_FIELDS)
SAFETY_FLAGS = {"admission_authorized": False, "host_verified": False,
                "migration_complete": False}


def green(**overrides):
    doc = {"schema": "garm-wave1-window.v1",
           "pickup_observed": True, "pickup_wait_s": 191,
           "tests_required": 16, "tests_passed": 16, "tests_skipped": 0,
           "budget_evidence_age_s": 120, "fs_max_use_pct": 61.5,
           "pressure_incident_unresolved": False,
           "static_fallback_available": True,
           "interrupted_active_job": False, "production_db_contact": False,
           "unauthorized_access_or_routing": False,
           "unexplained_lifecycle_leak": False,
           "cap_or_admission_increase": False,
           "host_pressure_stop_breach": False,
           "trial_hours": 26, "comparable_attempts_garm": 11,
           "comparable_attempts_static": 12}
    doc.update(overrides)
    return doc


HOLD_CASES = [
    ("pickup late", {"pickup_wait_s": 901}, "HOLD_PICKUP_SLO"),
    ("no pickup, window elapsed",
     {"pickup_observed": False, "pickup_wait_s": 901}, "HOLD_PICKUP_SLO"),
    ("skipped test", {"tests_skipped": 1}, "HOLD_TESTS_SKIPPED"),
    ("missing test", {"tests_passed": 15}, "HOLD_TESTS_MISSING"),
    ("zero required tests",
     {"tests_required": 0, "tests_passed": 0}, "HOLD_TESTS_MISSING"),
    ("stale budget evidence", {"budget_evidence_age_s": 901},
     "HOLD_BUDGET_EVIDENCE_STALE"),
    ("filesystem at floor", {"fs_max_use_pct": 95},
     "HOLD_FILESYSTEM_PRESSURE"),
    ("filesystem near full", {"fs_max_use_pct": 99.9},
     "HOLD_FILESYSTEM_PRESSURE"),
    ("unresolved pressure incident", {"pressure_incident_unresolved": True},
     "HOLD_PRESSURE_INCIDENT_UNRESOLVED"),
    ("static fallback unavailable", {"static_fallback_available": False},
     "HOLD_STATIC_FALLBACK_UNAVAILABLE"),
]


class Contract:
    """Behaviour contract, module-agnostic: run against the real module and
    against every mutant. Not a TestCase on its own."""

    mod = None

    def verdict(self, **overrides):
        return self.mod.evaluate(green(**overrides))

    # ---- 1. each trigger alone ---------------------------------------------
    def test_all_green_proceeds(self):
        result = self.verdict()
        self.assertEqual(result["verdict"], "PROCEED")
        self.assertEqual(result["reasons"], [])

    def test_each_hold_trigger_alone(self):
        for label, overrides, code in HOLD_CASES:
            with self.subTest(label):
                result = self.verdict(**overrides)
                self.assertEqual(result["verdict"], "HOLD")
                self.assertEqual(result["reasons"], [code])

    def test_each_nogo_trigger_alone(self):
        for name in NOGO_FIELDS:
            with self.subTest(name):
                result = self.verdict(**{name: True})
                self.assertEqual(result["verdict"], "NO-GO")
                self.assertEqual(result["reasons"],
                                 ["NOGO_" + name.upper()])

    def test_fixture_field_set_is_pinned(self):
        self.assertEqual(set(self.mod.FIELDS), EXPECTED_FIELDS)
        self.assertEqual(self.mod.NOGO_FIELDS, NOGO_FIELDS)

    # ---- 2. precedence ------------------------------------------------------
    def test_nogo_outranks_hold(self):
        result = self.verdict(interrupted_active_job=True, fs_max_use_pct=99)
        self.assertEqual(result["verdict"], "NO-GO")
        self.assertEqual(result["reasons"],
                         ["NOGO_INTERRUPTED_ACTIVE_JOB",
                          "HOLD_FILESYSTEM_PRESSURE"])

    def test_nogo_outranks_hold_and_unknown(self):
        result = self.verdict(production_db_contact=True, tests_skipped=2,
                              trial_hours=None)
        self.assertEqual(result["verdict"], "NO-GO")
        self.assertEqual(result["reasons"],
                         ["NOGO_PRODUCTION_DB_CONTACT", "HOLD_TESTS_SKIPPED",
                          "UNKNOWN_TRIAL_HOURS"])

    def test_hold_outranks_unknown(self):
        result = self.verdict(static_fallback_available=False,
                              fs_max_use_pct=None)
        self.assertEqual(result["verdict"], "HOLD")
        self.assertEqual(result["reasons"],
                         ["HOLD_STATIC_FALLBACK_UNAVAILABLE",
                          "UNKNOWN_FS_MAX_USE_PCT"])

    def test_known_adverse_fact_fires_beside_a_null_sibling(self):
        result = self.verdict(tests_skipped=3, tests_required=None)
        self.assertEqual(result["verdict"], "HOLD")
        self.assertIn("HOLD_TESTS_SKIPPED", result["reasons"])
        self.assertIn("UNKNOWN_TESTS_REQUIRED", result["reasons"])

    def test_multiple_nogo_and_hold_reasons_are_all_reported(self):
        result = self.verdict(production_db_contact=True,
                              host_pressure_stop_breach=True,
                              pickup_wait_s=2000, fs_max_use_pct=97)
        self.assertEqual(result["verdict"], "NO-GO")
        self.assertEqual(result["reasons"],
                         ["NOGO_PRODUCTION_DB_CONTACT",
                          "NOGO_HOST_PRESSURE_STOP_BREACH",
                          "HOLD_PICKUP_SLO", "HOLD_FILESYSTEM_PRESSURE"])

    # ---- 3. null / missing is UNKNOWN, never PROCEED -----------------------
    def test_every_null_field_is_unknown(self):
        for name in sorted(EXPECTED_FIELDS):
            with self.subTest(name):
                result = self.verdict(**{name: None})
                self.assertEqual(result["verdict"], "UNKNOWN")
                self.assertEqual(result["reasons"],
                                 ["UNKNOWN_" + name.upper()])

    def test_every_missing_field_is_unknown(self):
        for name in sorted(EXPECTED_FIELDS):
            with self.subTest(name):
                doc = green()
                del doc[name]
                result = self.mod.evaluate(doc)
                self.assertEqual(result["verdict"], "UNKNOWN")
                self.assertEqual(result["reasons"],
                                 ["UNKNOWN_" + name.upper()])

    def test_schema_only_observation_is_unknown_not_proceed(self):
        result = self.mod.evaluate({"schema": "garm-wave1-window.v1"})
        self.assertEqual(result["verdict"], "UNKNOWN")
        self.assertEqual(len(result["reasons"]), len(EXPECTED_FIELDS))

    def test_pickup_not_yet_observed_is_unknown(self):
        result = self.verdict(pickup_observed=False, pickup_wait_s=300)
        self.assertEqual(result["verdict"], "UNKNOWN")
        self.assertEqual(result["reasons"], ["UNKNOWN_PICKUP_NOT_OBSERVED"])

    def test_inadequate_trial_is_inconclusive_unknown(self):
        cases = [({"trial_hours": 23.99}, "UNKNOWN_TRIAL_TOO_SHORT"),
                 ({"comparable_attempts_garm": 9},
                  "UNKNOWN_ATTEMPTS_GARM_BELOW_FLOOR"),
                 ({"comparable_attempts_static": 9},
                  "UNKNOWN_ATTEMPTS_STATIC_BELOW_FLOOR")]
        for overrides, code in cases:
            with self.subTest(code):
                result = self.verdict(**overrides)
                self.assertEqual(result["verdict"], "UNKNOWN")
                self.assertEqual(result["reasons"], [code])

    # ---- 4. boundaries ------------------------------------------------------
    def test_values_exactly_on_the_threshold_proceed(self):
        for overrides in ({"pickup_wait_s": 900},
                          {"budget_evidence_age_s": 900},
                          {"fs_max_use_pct": 94.99},
                          {"trial_hours": 24},
                          {"comparable_attempts_garm": 10,
                           "comparable_attempts_static": 10},
                          {"tests_passed": 17},
                          {"pickup_wait_s": 0}):
            with self.subTest(overrides):
                result = self.verdict(**overrides)
                self.assertEqual(result["verdict"], "PROCEED")
                self.assertEqual(result["reasons"], [])

    # ---- 6. safety flags ----------------------------------------------------
    def test_every_verdict_carries_the_safety_flags(self):
        docs = [green(), green(fs_max_use_pct=99),
                green(production_db_contact=True), green(trial_hours=None)]
        seen = set()
        for doc in docs:
            result = self.mod.evaluate(doc)
            seen.add(result["verdict"])
            for key, value in SAFETY_FLAGS.items():
                self.assertIs(result[key], value, key)
        self.assertEqual(seen, {"PROCEED", "HOLD", "NO-GO", "UNKNOWN"})

    # ---- 5. fail-closed parsing --------------------------------------------
    def test_unknown_key_is_refused(self):
        with self.assertRaises(self.mod.InvalidObservation):
            self.mod.evaluate(green(surprise=True))

    def test_input_cannot_assert_its_own_authorization(self):
        for key in SAFETY_FLAGS:
            with self.subTest(key):
                with self.assertRaises(self.mod.InvalidObservation):
                    self.mod.evaluate(green(**{key: True}))

    def test_wrong_schema_is_refused(self):
        for schema in (None, "garm-wave1-window.v2", 1):
            with self.subTest(schema):
                with self.assertRaises(self.mod.InvalidObservation):
                    self.mod.evaluate(green(schema=schema))

    def test_wrong_types_and_ranges_are_refused(self):
        bad = {"pickup_observed": [1, "yes", 0],
               "pickup_wait_s": [True, "191", -1, 1.5, 7 * 86400 + 1],
               "tests_required": [True, "16", -1, 16.0, 1_000_001],
               "budget_evidence_age_s": [False, "9", -5, 7 * 86400 + 1],
               "fs_max_use_pct": [True, "61", -0.1, 100.1, 1e999],
               "static_fallback_available": [1, 0, "true"],
               "production_db_contact": [0, 1, "false"],
               "trial_hours": [True, "26", -1, 24 * 366 + 1, 1e999],
               "comparable_attempts_garm": [True, 11.0, -1]}
        for name, values in bad.items():
            for value in values:
                with self.subTest((name, value)):
                    with self.assertRaises(self.mod.InvalidObservation):
                        self.mod.evaluate(green(**{name: value}))

    def test_top_level_must_be_an_object(self):
        for doc in ([], "x", 3, None):
            with self.subTest(doc):
                with self.assertRaises(self.mod.InvalidObservation):
                    self.mod.evaluate(doc)

    def test_rejection_never_echoes_the_value(self):
        secret = "SECRET-VALUE-9f3a"
        for doc in (green(production_db_contact=secret),
                    green(**{secret: 1})):
            with self.assertRaises(self.mod.InvalidObservation) as ctx:
                self.mod.evaluate(doc)
            self.assertNotIn(secret, str(ctx.exception))

    def test_parser_refuses_hostile_text(self):
        hostile = {
            "duplicate key": '{"schema": "a", "schema": "b"}',
            "non-finite": '{"schema": "garm-wave1-window.v1", '
                          '"trial_hours": NaN}',
            "infinity": '{"schema": "garm-wave1-window.v1", '
                        '"fs_max_use_pct": -Infinity}',
            "NUL": '{"schema": "garm-wave1-window.v1"}\x00',
            "malformed": '{"schema": ',
            "list": "[]",
            "huge integer": '{"schema": "garm-wave1-window.v1", '
                            '"pickup_wait_s": ' + "9" * 6000 + "}",
            "deep nesting": "[" * 200_000,
            "oversize": '{"schema": "' + "x" * (1024 * 1024) + '"}',
        }
        for label, raw in hostile.items():
            with self.subTest(label):
                with self.assertRaises(self.mod.InvalidObservation) as ctx:
                    self.mod.parse(raw)
                self.assertNotIn("999999", str(ctx.exception))


class RealContract(Contract, unittest.TestCase):
    mod = real


# ---- 7. CLI -----------------------------------------------------------------
def run_cli(*args, script=SCRIPT):
    return subprocess.run([sys.executable, "-B", str(script), *args],
                          capture_output=True, text=True, timeout=30)


class CliExitCodes(unittest.TestCase):
    def run_doc(self, doc):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "obs.json"
            path.write_text(json.dumps(doc), encoding="utf-8")
            return run_cli(str(path))

    def test_exit_codes_and_machine_readable_stdout(self):
        cases = [(green(), 0, "PROCEED"),
                 (green(fs_max_use_pct=96), 2, "HOLD"),
                 (green(trial_hours=None), 3, "UNKNOWN"),
                 (green(production_db_contact=True), 4, "NO-GO"),
                 (green(production_db_contact=True, fs_max_use_pct=96),
                  4, "NO-GO")]
        for doc, code, verdict in cases:
            with self.subTest(verdict):
                proc = self.run_doc(doc)
                self.assertEqual(proc.returncode, code, proc.stderr)
                body = json.loads(proc.stdout)
                self.assertEqual(body["verdict"], verdict)
                for key, value in SAFETY_FLAGS.items():
                    self.assertIs(body[key], value)

    def test_invalid_input_exits_1_with_nothing_on_stdout(self):
        proc = self.run_doc(green(surprise=True))
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(proc.stdout, "")
        self.assertIn("unknown key", proc.stderr)

    def test_invalid_value_diagnostic_names_field_not_value(self):
        proc = self.run_doc(green(production_db_contact="SECRET-xyz"))
        self.assertEqual(proc.returncode, 1)
        self.assertIn("production_db_contact", proc.stderr)
        self.assertNotIn("SECRET-xyz", proc.stderr + proc.stdout)

    def test_missing_file_and_bad_encoding_exit_1(self):
        self.assertEqual(run_cli("/nonexistent/obs.json").returncode, 1)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.json"
            path.write_bytes(b'{"schema": "\xff\xfe"}')
            self.assertEqual(run_cli(str(path)).returncode, 1)

    def test_oversize_file_exits_1(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "big.json"
            path.write_text('{"schema": "' + "x" * (1024 * 1024) + '"}')
            proc = run_cli(str(path))
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(proc.stdout, "")

    def test_usage_error_is_not_a_hold(self):
        # argparse's own usage error would exit 2, which reads as HOLD.
        self.assertEqual(run_cli().returncode, 1)
        self.assertEqual(run_cli("a.json", "b.json").returncode, 1)

    def test_checked_in_green_fixture_proceeds(self):
        proc = run_cli(str(FIXTURE))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["verdict"], "PROCEED")

    def test_checked_in_fixture_equals_the_test_baseline(self):
        self.assertEqual(json.loads(FIXTURE.read_text()), green())

    def test_output_is_deterministic(self):
        first = run_cli(str(FIXTURE)).stdout
        self.assertEqual(first, run_cli(str(FIXTURE)).stdout)


# ---- 8. doc-drift -----------------------------------------------------------
def rollback_section(text):
    start = text.index("## 2. Rollback note")
    return text[start:text.index("## 3.", start)]


def drift(text, mod=real):
    """Return the mismatches between runbook section 2 and the code
    constants. A number the runbook no longer states is a mismatch too."""
    section = re.sub(r"\s+", " ", rollback_section(text))
    checks = [
        ("pickup SLO", r"no pickup within (\d+) min",
         lambda m: int(m[0]) * 60 == mod.PICKUP_SLO_S),
        ("filesystem floor", r"at or above (\d+)%",
         lambda m: int(m[0]) == mod.FILESYSTEM_STOP_PCT),
        ("budget evidence age", r"Budget evidence older than (\d+) min",
         lambda m: int(m[0]) * 60 == mod.BUDGET_EVIDENCE_MAX_AGE_S),
        ("trial adequacy table",
         r"≥(\d+) h from routing merge AND ≥(\d+) comparable completed "
         r"attempts per arm",
         lambda m: (int(m[0]), int(m[1])) == (
             mod.TRIAL_MIN_HOURS, mod.TRIAL_MIN_ATTEMPTS_PER_ARM)),
        ("trial adequacy thresholds", r"trial (\d+) h plus (\d+)/arm",
         lambda m: (int(m[0]), int(m[1])) == (
             mod.TRIAL_MIN_HOURS, mod.TRIAL_MIN_ATTEMPTS_PER_ARM)),
    ]
    problems = []
    for label, pattern, agrees in checks:
        found = re.findall(pattern, section)
        if not found:
            problems.append(label + ": not stated in runbook section 2")
        for match in found:
            groups = match if isinstance(match, tuple) else (match,)
            if not agrees(groups):
                problems.append(label + ": runbook and code disagree")
    return problems


class DocDrift(unittest.TestCase):
    def setUp(self):
        self.text = RUNBOOK.read_text(encoding="utf-8")

    def test_runbook_numbers_equal_code_constants(self):
        self.assertEqual(drift(self.text), [])

    def test_constants_are_the_expected_numbers(self):
        self.assertEqual((real.PICKUP_SLO_S, real.FILESYSTEM_STOP_PCT,
                          real.TRIAL_MIN_HOURS,
                          real.TRIAL_MIN_ATTEMPTS_PER_ARM,
                          real.BUDGET_EVIDENCE_MAX_AGE_S),
                         (900, 95, 24, 10, 900))

    def test_drift_check_is_not_vacuous(self):
        doctored = {
            "pickup SLO": (r"(no pickup within\s+)15", r"\g<1>20"),
            "filesystem floor": (r"(at or above\s+)95", r"\g<1>90"),
            "budget evidence age": (r"(Budget\s+evidence\s+older\s+than\s+)15",
                                    r"\g<1>30"),
            "trial adequacy table": (r"(≥)24(\s+h\s+from\s+routing\s+merge)",
                                     r"\g<1>48\g<2>"),
            "trial adequacy thresholds": (r"(trial\s+)24(\s+h\s+plus)",
                                          r"\g<1>12\g<2>"),
        }
        for label, (pattern, repl) in doctored.items():
            with self.subTest(label):
                changed = re.sub(pattern, repl, self.text)
                self.assertTrue(changed != self.text, "doctoring did not apply")
                self.assertTrue(
                    any(p.startswith(label) for p in drift(changed)),
                    drift(changed))

    def test_a_reworded_runbook_fails_loudly(self):
        reworded = self.text.replace("## 2. Rollback note",
                                     "## 2. Rollback note\n\n"
                                     "(numbers removed)", 1)
        reworded = re.sub(r"no pickup within\s+15 min", "no pickup", reworded)
        self.assertTrue(any("pickup SLO: not stated" in p
                            for p in drift(reworded)))

    def test_runbook_names_the_artifacts(self):
        for anchor in ("wave1_window_verdict.py", "garm-wave1-window.v1",
                       "test_isolated_wave1_window_verdict.py",
                       "admission_authorized:false"):
            self.assertIn(anchor, rollback_section(self.text), anchor)


# ---- 9. load-bearing mutants ------------------------------------------------
# (label, exact original text, replacement). Each `old` must occur exactly
# once, so a refactor that moves the code breaks the anchor loudly instead of
# leaving a vacuous mutant.
MUTANTS = [
    ("hold demoted to proceed",
     '    if HOLD in tiers:\n        return "HOLD"\n',
     '    if HOLD in tiers:\n        return "PROCEED"\n'),
    ("null treated as zero",
     '    if value is None:\n        return None\n    kind = FIELDS[name]',
     '    if value is None:\n        return 0\n    kind = FIELDS[name]'),
    ("no-go does not outrank hold",
     '    if NOGO in tiers:\n        return "NO-GO"\n'
     '    if HOLD in tiers:\n        return "HOLD"\n',
     '    if HOLD in tiers:\n        return "HOLD"\n'
     '    if NOGO in tiers:\n        return "NO-GO"\n'),
    ("unknown dropped from resolution",
     '    if UNKNOWN in tiers:\n        return "UNKNOWN"\n', ''),
    ("filesystem floor off by one",
     "fs >= FILESYSTEM_STOP_PCT", "fs > FILESYSTEM_STOP_PCT"),
    ("pickup SLO off by one",
     "wait is not None and wait > PICKUP_SLO_S",
     "wait is not None and wait >= PICKUP_SLO_S"),
    ("attempts floor off by one",
     "attempts < TRIAL_MIN_ATTEMPTS_PER_ARM",
     "attempts <= TRIAL_MIN_ATTEMPTS_PER_ARM"),
    ("skipped tests ignored",
     "if skipped is not None and skipped > 0:", "if False:"),
    ("unknown key accepted",
     '    require(set(doc) <= set(FIELDS) | {"schema"}, "unknown key")\n',
     '    pass\n'),
    ("admission flag flipped",
     '"admission_authorized": False', '"admission_authorized": True'),
]


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_contract_against(module):
    suite_case = type("Subject", (Contract, unittest.TestCase),
                      {"mod": module})
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(suite_case)
    return unittest.TextTestRunner(stream=io.StringIO(),
                                   verbosity=0).run(suite)


class LoadBearingMutants(unittest.TestCase):
    def setUp(self):
        self.source = SCRIPT.read_text(encoding="utf-8")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def mutant_module(self, index, old, new):
        self.assertEqual(self.source.count(old), 1,
                         "mutation anchor must occur exactly once")
        text = self.source.replace(old, new)
        compile(text, str(SCRIPT), "exec")
        path = Path(self.tmp.name) / f"mutant_{index}.py"
        path.write_text(text, encoding="utf-8")
        return load_module(path, f"wave1_mutant_{index}")

    def test_positive_control_unmutated_copy_passes(self):
        path = Path(self.tmp.name) / "control.py"
        path.write_text(self.source, encoding="utf-8")
        result = run_contract_against(load_module(path, "wave1_control"))
        self.assertTrue(result.wasSuccessful(), result.failures + result.errors)
        self.assertGreater(result.testsRun, 15)

    def test_every_mutant_turns_the_contract_red(self):
        for index, (label, old, new) in enumerate(MUTANTS):
            with self.subTest(label):
                result = run_contract_against(
                    self.mutant_module(index, old, new))
                self.assertFalse(result.wasSuccessful(),
                                 label + " survived the contract suite")

    def test_the_three_required_mutants_are_present(self):
        labels = {label for label, _, _ in MUTANTS}
        for required in ("hold demoted to proceed", "null treated as zero",
                         "no-go does not outrank hold"):
            self.assertIn(required, labels)


# ---- 10. offline by construction -------------------------------------------
class OfflineByConstruction(unittest.TestCase):
    def test_module_imports_only_the_offline_stdlib_subset(self):
        tree = ast.parse(SCRIPT.read_text(encoding="utf-8"))
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported |= {alias.name.split(".")[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom):
                imported.add((node.module or "").split(".")[0])
        self.assertEqual(imported, {"argparse", "json", "math", "sys",
                                    "pathlib"})

    def test_module_reads_no_environment_or_clock(self):
        text = SCRIPT.read_text(encoding="utf-8")
        for needle in ("os.environ", "getenv", "time.", "datetime"):
            self.assertNotIn(needle, text, needle)


if __name__ == "__main__":
    unittest.main()
