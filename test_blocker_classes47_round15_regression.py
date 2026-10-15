#!/usr/bin/env python3
"""Round-15 regression tests for the 4/5 findings on head `5baafff`.

Pins the exact reviewer probes so the fixes cannot regress. Frozen
suites and round-2..14 + review-acceptance files stay untouched.

- Plain column drop: PostgreSQL makes the COLUMN keyword optional
  (`ALTER TABLE t DROP [COLUMN] [IF EXISTS] col`), so the old
  `DROP COLUMN`-only match missed `DROP legacy`, `DROP IF EXISTS
  legacy` and multi-clause `DROP a, DROP b`. Any ALTER TABLE DROP
  clause now flags unless it is DROP CONSTRAINT; `DROP SCHEMA ..
  CASCADE` and `DROP DATABASE` join the table-drop pattern. Negatives
  (`DROP CONSTRAINT`, `ALTER COLUMN .. DROP NOT NULL`) stay clean,
  under every dialect.
- Runbook step 1b validator: the old list-comprehension filter printed
  nothing and exited 0 when the sha was still a placeholder or the
  repository id was not an integer. The step now asserts fail-closed;
  these tests run the exact step script against crafted payloads.
"""

import glob
import json
import os
import re
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
RULESETS = HERE / "templates" / "org-github" / "rulesets"
RUNBOOK = RULESETS / "SDLC-BASELINE-RUNBOOK.md"
CI = HERE / ".github" / "workflows" / "ci.yml"

sys.path.insert(0, str(HERE))
from blocker_migration_checks import check_migration_safety


def safety(contents, dialect="postgres"):
    return check_migration_safety(contents, dialect=dialect)


def mig(sql):
    return {"migrations/001.sql": sql}


class PlainDropWithoutKeywordTest(unittest.TestCase):
    def test_drop_without_column_keyword_flags(self):
        findings = safety(mig("ALTER TABLE t DROP legacy;\n"))
        self.assertTrue(
            any("destructive DDL" in f for f in findings), findings)

    def test_drop_if_exists_flags(self):
        findings = safety(mig("ALTER TABLE t DROP IF EXISTS legacy;\n"))
        self.assertTrue(
            any("destructive DDL" in f for f in findings), findings)

    def test_multi_clause_drop_flags(self):
        findings = safety(mig("ALTER TABLE t DROP a, DROP b;\n"))
        self.assertTrue(
            any("destructive DDL" in f for f in findings), findings)

    def test_explicit_drop_column_still_flags(self):
        findings = safety(mig("ALTER TABLE t DROP COLUMN legacy;\n"))
        self.assertTrue(
            any("destructive DDL" in f for f in findings), findings)

    def test_drop_mixed_with_constraint_drop_flags(self):
        findings = safety(
            mig("ALTER TABLE t DROP CONSTRAINT c, DROP d;\n"))
        self.assertTrue(
            any("destructive DDL" in f for f in findings), findings)

    def test_nested_alter_in_do_block_flags(self):
        findings = safety(
            mig("DO $$ BEGIN ALTER TABLE t DROP legacy; END $$;\n"))
        self.assertTrue(
            any("destructive DDL" in f for f in findings), findings)


class WholeObjectDropTest(unittest.TestCase):
    def test_drop_schema_cascade_flags(self):
        findings = safety(mig("DROP SCHEMA s CASCADE;\n"))
        self.assertTrue(
            any("destructive DDL" in f for f in findings), findings)

    def test_drop_database_flags(self):
        findings = safety(mig("DROP DATABASE d;\n"))
        self.assertTrue(
            any("destructive DDL" in f for f in findings), findings)

    def test_drop_table_still_flags(self):
        findings = safety(mig("DROP TABLE t;\n"))
        self.assertTrue(
            any("destructive DDL" in f for f in findings), findings)


class DropNegativeTest(unittest.TestCase):
    def test_drop_constraint_stays_clean(self):
        self.assertEqual(
            safety(mig("ALTER TABLE t DROP CONSTRAINT c;\n")), [])

    def test_alter_column_drop_not_null_stays_clean(self):
        self.assertEqual(
            safety(mig("ALTER TABLE t ALTER COLUMN x DROP NOT NULL;\n")),
            [])

    def test_alter_column_drop_default_stays_clean(self):
        self.assertEqual(
            safety(mig("ALTER TABLE t ALTER COLUMN x DROP DEFAULT;\n")),
            [])

    def test_plain_add_column_stays_clean(self):
        self.assertEqual(
            safety(mig("ALTER TABLE t ADD COLUMN c INT;\n")), [])

    def test_benign_select_stays_clean(self):
        self.assertEqual(safety(mig("SELECT 1;\n")), [])


class DropDialectTest(unittest.TestCase):
    PROBES = (
        "ALTER TABLE t DROP legacy;\n",
        "ALTER TABLE t DROP IF EXISTS legacy;\n",
        "ALTER TABLE t DROP a, DROP b;\n",
        "DROP SCHEMA s CASCADE;\n",
        "DROP DATABASE d;\n",
    )

    def test_destructive_reports_under_every_dialect(self):
        for sql in self.PROBES:
            for dialect in (
                "postgres", "sqlite", "postgres-transactional",
            ):
                findings = safety(mig(sql), dialect=dialect)
                self.assertTrue(
                    any("destructive DDL" in f for f in findings),
                    (dialect, sql, findings),
                )

    def test_negatives_clean_under_every_dialect(self):
        for sql in (
            "ALTER TABLE t DROP CONSTRAINT c;\n",
            "ALTER TABLE t ALTER COLUMN x DROP NOT NULL;\n",
        ):
            for dialect in (
                "postgres", "sqlite", "postgres-transactional",
            ):
                self.assertEqual(
                    safety(mig(sql), dialect=dialect), [],
                    (dialect, sql),
                )

    def test_safety_ack_still_waives_new_forms(self):
        for sql in self.PROBES:
            findings = safety(
                mig("-- safety: acknowledged\n" + sql))
            self.assertEqual(findings, [], sql)


def extract_step_1b_script():
    """The exact python the runbook step 1b executes."""
    text = RUNBOOK.read_text()
    match = re.search(r"<<'PY'\n(.*?)\nPY(?:\n|$)", text, re.S)
    assert match, "runbook step 1b python heredoc must be extractable"
    return match.group(1) + "\n"


def payload(repo_id, sha, include=("*",)):
    return {
        "conditions": {
            "repository_name": {
                "include": list(include),
                "exclude": [],
            },
        },
        "rules": [
            {
                "type": "workflows",
                "parameters": {
                    "workflows": [
                        {
                            "repository_id": repo_id,
                            "ref": "refs/heads/main",
                            "sha": sha,
                        },
                    ],
                },
            },
        ],
    }


class RunbookStep1bValidatorTest(unittest.TestCase):
    def setUp(self):
        self.saved = {}
        for name in glob.glob("/tmp/blocker-classes47-*.json"):
            with open(name, "rb") as fh:
                self.saved[name] = fh.read()
            os.unlink(name)
        self.addCleanup(self._restore)

    def _restore(self):
        for name in glob.glob("/tmp/blocker-classes47-*.json"):
            try:
                os.unlink(name)
            except OSError:
                pass
        for name, data in self.saved.items():
            with open(name, "wb") as fh:
                fh.write(data)

    def write(self, name, obj):
        with open("/tmp/%s" % name, "w") as fh:
            json.dump(obj, fh)

    def run_validator(self):
        return subprocess.run(
            [sys.executable, "-I", "-"],
            input=extract_step_1b_script(),
            capture_output=True, text=True, timeout=30,
        )

    def test_valid_payloads_pass(self):
        self.write("blocker-classes47-test-a.json", payload(123, "abc123"))
        self.write("blocker-classes47-test-b.json", payload(123, "def456"))
        proc = self.run_validator()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(
            proc.stdout.count("payload-valid"), 2, proc.stdout)

    def test_pinned_sha_fails(self):
        self.write(
            "blocker-classes47-test-a.json", payload(123, "PINNED_SHA"))
        proc = self.run_validator()
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn("payload-valid", proc.stdout)

    def test_empty_sha_fails(self):
        self.write("blocker-classes47-test-a.json", payload(123, ""))
        proc = self.run_validator()
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn("payload-valid", proc.stdout)

    def test_non_integer_repo_id_fails(self):
        self.write(
            "blocker-classes47-test-a.json", payload("123", "abc123"))
        proc = self.run_validator()
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn("payload-valid", proc.stdout)

    def test_no_files_fails(self):
        proc = self.run_validator()
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn("payload-valid", proc.stdout)

    def test_one_bad_file_fails_closed(self):
        self.write("blocker-classes47-test-a.json", payload(123, "abc123"))
        self.write(
            "blocker-classes47-test-b.json", payload(123, "PINNED_SHA"))
        proc = self.run_validator()
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("payload-valid", proc.stdout)
        self.assertIn("blocker-classes47-test-a.json", proc.stdout)


class CiWiringTest(unittest.TestCase):
    def test_ci_runs_round15_regression_module(self):
        self.assertIn(
            "test_blocker_classes47_round15_regression",
            CI.read_text(),
            "CI must run the round-15 regression module",
        )


if __name__ == "__main__":
    unittest.main()
