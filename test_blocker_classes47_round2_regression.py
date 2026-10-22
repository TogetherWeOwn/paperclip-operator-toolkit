#!/usr/bin/env python3
"""Round-2 regression tests for blocker-ledger classes 4-7 review fixes.

Covers the four remaining 4/5 blockers plus the round-1 wiring that had
zero test delta. The frozen acceptance suites (65 tests) stay untouched;
this file pins the new behaviour separately.

- Concurrency binds to the migration job (or top-level), not any
  `concurrency:` line (unrelated job, `with:` inputs).
- Migration strips SQL comments and checks USING per ALTER COLUMN clause.
- Migration supports a `sqlite` dialect (D1) that skips CONCURRENTLY/USING.
- Every gate runs `python3 -I -`; migration/lockfile diff with
  `--diff-filter=d`; concurrency gate imports the job parser from the
  lib and wires the seed check; migration gate exposes a dialect input.
"""

import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(
        name, HERE / f"{name}.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MIG = load("blocker_migration_checks")
CONC = load("blocker_concurrency_checks")

STAGE = HERE / "templates" / "org-github" / "blocker-classes47"
GATES = ("migration", "api-contract", "concurrency", "lockfile")


def gate_text(gate):
    return (STAGE / f"{gate}-gate.yml").read_text()


class ConcurrencyBindingTest(unittest.TestCase):
    UNRELATED_JOB_WF = """\
name: deploy
on: [push]
jobs:
  lint:
    runs-on: ubuntu-latest
    concurrency:
      group: lint-${{ github.ref }}
    steps:
      - run: echo lint
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: npm run migrate
"""

    WITH_INPUT_WF = """\
name: deploy
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          concurrency: 8
      - run: npm run migrate
"""

    JOB_LEVEL_WF = """\
name: deploy
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    concurrency:
      group: db-${{ github.ref }}
    steps:
      - run: npm run migrate
"""

    TOP_LEVEL_WF = (
        "concurrency:\n  group: migrate-${{ github.ref }}\n"
        "name: deploy\non: [push]\njobs:\n"
        "  migrate:\n    runs-on: ubuntu-latest\n"
        "    steps:\n      - run: alembic upgrade head\n"
    )

    def test_unrelated_job_concurrency_does_not_satisfy(self):
        self.assertFalse(
            CONC.has_concurrency_group(self.UNRELATED_JOB_WF)
        )
        findings = CONC.check_workflow_concurrency(
            {".github/workflows/deploy.yml": self.UNRELATED_JOB_WF}
        )
        self.assertEqual(len(findings), 1)

    def test_with_input_concurrency_does_not_satisfy(self):
        self.assertFalse(
            CONC.has_concurrency_group(self.WITH_INPUT_WF)
        )
        findings = CONC.check_workflow_concurrency(
            {".github/workflows/deploy.yml": self.WITH_INPUT_WF}
        )
        self.assertEqual(len(findings), 1)

    def test_job_level_concurrency_on_migration_job_satisfies(self):
        self.assertTrue(
            CONC.has_concurrency_group(self.JOB_LEVEL_WF)
        )
        self.assertEqual(
            CONC.check_workflow_concurrency(
                {".github/workflows/deploy.yml": self.JOB_LEVEL_WF}
            ),
            [],
        )

    def test_top_level_concurrency_satisfies(self):
        self.assertTrue(CONC.has_concurrency_group(self.TOP_LEVEL_WF))

    def test_migrations_apply_marker_detected(self):
        self.assertIn("migrations apply", CONC.MIGRATION_RUN_MARKERS)
        self.assertTrue(
            CONC.step_runs_migrations(
                {"run": "npx wrangler d1 migrations apply DB"}
            )
        )

    def test_job_step_parser_lives_in_lib(self):
        self.assertTrue(
            hasattr(CONC, "job_step_blocks")
            or hasattr(CONC, "_job_step_blocks"),
            "job step parser must live in blocker_concurrency_checks",
        )
        parser = getattr(
            CONC, "job_step_blocks", None
        ) or getattr(CONC, "_job_step_blocks")
        blocks = parser(self.JOB_LEVEL_WF)
        self.assertTrue(blocks)
        flat = [s for b in blocks for s in b]
        self.assertTrue(
            any("migrate" in s.get("run", "") for s in flat)
        )


class MigrationCommentAndClauseTest(unittest.TestCase):
    def test_line_comment_concurrently_does_not_mask(self):
        findings = MIG.check_migration_safety(
            {
                "migrations/0001_idx.sql": (
                    "-- must be CONCURRENTLY in prod\n"
                    "CREATE INDEX i ON t(x);\n"
                )
            }
        )
        self.assertTrue(findings, "comment CONCURRENTLY must not mask")

    def test_block_comment_concurrently_does_not_mask(self):
        findings = MIG.check_migration_safety(
            {
                "migrations/0001_idx.sql": (
                    "/* TODO: CONCURRENTLY */ CREATE INDEX i ON t(x);\n"
                )
            }
        )
        self.assertTrue(findings, "block comment must not mask")

    def test_line_comment_using_does_not_mask(self):
        findings = MIG.check_migration_safety(
            {
                "migrations/0002_alter.sql": (
                    "-- backfill using script\n"
                    "ALTER TABLE t ALTER COLUMN a TYPE int;\n"
                )
            }
        )
        self.assertTrue(findings, "comment USING must not mask")

    def test_multiclause_alter_second_clause_flagged(self):
        findings = MIG.check_migration_safety(
            {
                "migrations/0003_alter.sql": (
                    "ALTER TABLE t ALTER COLUMN a TYPE int USING a::int, "
                    "ALTER COLUMN b TYPE int;\n"
                )
            }
        )
        self.assertTrue(
            findings, "unguarded second ALTER COLUMN clause must fail"
        )

    def test_guarded_statements_still_pass(self):
        findings = MIG.check_migration_safety(
            {
                "migrations/0004_ok.sql": (
                    "CREATE INDEX CONCURRENTLY i ON t(x);\n"
                    "ALTER TABLE t ALTER COLUMN a TYPE int USING a::int;\n"
                )
            }
        )
        self.assertEqual(findings, [])

    def test_up_down_pair_passes(self):
        findings = MIG.check_migration_down(
            ["migrations/001_a.up.sql", "migrations/001_a.down.sql"],
            {"migrations/001_a.up.sql": "CREATE TABLE t (id INT);\n"},
        )
        self.assertEqual(findings, [])

    def test_deleted_path_skipped(self):
        # Deleted files are absent from contents (gate uses --diff-filter=d).
        findings = MIG.check_migration_down(
            ["migrations/old.sql"], {}
        )
        self.assertEqual(findings, [])


class MigrationDialectTest(unittest.TestCase):
    def test_plain_index_passes_under_sqlite(self):
        findings = MIG.check_migration_safety(
            {"migrations/0001_idx.sql": "CREATE INDEX i ON t(x);\n"},
            dialect="sqlite",
        )
        self.assertEqual(findings, [])

    def test_plain_index_fails_under_postgres_default(self):
        findings = MIG.check_migration_safety(
            {"migrations/0001_idx.sql": "CREATE INDEX i ON t(x);\n"}
        )
        self.assertTrue(findings)

    def test_alter_without_using_passes_under_sqlite(self):
        findings = MIG.check_migration_safety(
            {
                "migrations/0002_alter.sql": (
                    "ALTER TABLE t ALTER COLUMN a TYPE int;\n"
                )
            },
            dialect="sqlite",
        )
        self.assertEqual(findings, [])

    def test_destructive_still_flagged_under_sqlite(self):
        findings = MIG.check_migration_safety(
            {"migrations/0003_drop.sql": "DROP TABLE users;\n"},
            dialect="sqlite",
        )
        self.assertTrue(findings)


class GateWiringTest(unittest.TestCase):
    def test_every_gate_uses_python_I(self):
        for gate in GATES:
            self.assertIn(
                "python3 -I -", gate_text(gate), f"{gate} must use python3 -I -"
            )

    def test_migration_and_lockfile_diff_filter(self):
        for gate in ("migration", "lockfile"):
            self.assertIn(
                "--diff-filter=d", gate_text(gate), f"{gate} must exclude deleted"
            )

    def test_concurrency_gate_imports_parser_and_wires_seed(self):
        text = gate_text("concurrency")
        self.assertIn("check_migration_seed_same_lock", text)
        self.assertIn("check_workflow_concurrency", text)
        self.assertTrue(
            "job_step_blocks" in text or "_job_step_blocks" in text,
            "gate must use the lib job-step parser",
        )
        self.assertIn(
            "from blocker_concurrency_checks import", text
        )
        self.assertNotIn("def _job_step_blocks", text)
        self.assertNotIn("def job_step_blocks", text)

    def test_migration_gate_exposes_dialect_and_passes_it(self):
        text = gate_text("migration")
        self.assertIn("dialect", text)
        self.assertIn("sqlite", text.lower())
        self.assertIn("check_migration_safety", text)

    def test_migration_gate_checks_out_logic_by_ref(self):
        text = gate_text("migration")
        self.assertIn("TogetherWeOwn/.github", text)


if __name__ == "__main__":
    unittest.main()
