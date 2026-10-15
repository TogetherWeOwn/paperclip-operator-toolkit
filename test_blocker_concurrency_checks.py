#!/usr/bin/env python3
"""Acceptance tests for the deterministic concurrency checks.

Covers blocker-ledger class 'concurrency' (class 6): deploy races where
concurrent runners migrate at once, or a seeder runs outside the
migration lock (cf. the Kofra migrate/seed mutex race). Staging/advisory
first: the Builder wires the gate in warn mode; the deterministic logic
itself is pinned here.

Contract under test (to be implemented by the Builder in
`blocker_concurrency_checks.py`, repo root):

- `MIGRATION_RUN_MARKERS`: tuple of substrings that identify a step
  running migrations. Must contain at least `"migrate"` and
  `"alembic upgrade"`.
- `ISOLATION_MARKERS`: tuple of substrings that identify a mutex-held
  migration step. Must contain at least `"--isolated"`.
- `SEED_MARKERS`: tuple of substrings that identify a seeding step.
  Must contain at least `"seed"`.
- `step_runs_migrations(step) -> bool`: `step` is a mapping with a
  `"run"` shell string; true when the run text contains a migration
  marker (case-insensitive).
- `has_concurrency_group(workflow_text) -> bool`: true when the workflow
  YAML text declares a top-level `concurrency:` block.
- `check_workflow_concurrency(workflows) -> list[str]`: `workflows` maps
  path -> workflow text. One finding per workflow whose text runs
  migrations (any `MIGRATION_RUN_MARKERS` hit) without a concurrency
  group. Findings name the workflow path.
- `check_migration_seed_same_lock(steps) -> list[str]`: `steps` is a
  list of `{"name": ..., "run": ...}` mappings in deploy order. One
  finding when an isolation-marked migration step is followed by a
  separate seeding step (seed runs after the mutex is released). A single
  step whose run text both migrates and seeds passes, as do runs with no
  migration step or no seed step. Findings name both step names.

Style: stdlib unittest, in-memory fixtures, one behavior per test. No
network, no clock, no filesystem writes. The module under test is loaded
via importlib so a missing module fails every test for the right reason.
"""

import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "blocker_concurrency_checks.py"


def load_module():
    spec = importlib.util.spec_from_file_location(
        "blocker_concurrency_checks", MODULE_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CHECK = load_module()

MIGRATE_WF = """\
name: deploy
on: [push]
jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - run: alembic upgrade head
"""

MIGRATE_WF_LOCKED = "concurrency:\n  group: migrate-${{ github.ref }}\n" + MIGRATE_WF


class MarkersTest(unittest.TestCase):
    def test_marker_tuples_pin_core_values(self):
        self.assertIn("migrate", CHECK.MIGRATION_RUN_MARKERS)
        self.assertIn("alembic upgrade", CHECK.MIGRATION_RUN_MARKERS)
        self.assertIn("--isolated", CHECK.ISOLATION_MARKERS)
        self.assertIn("seed", CHECK.SEED_MARKERS)


class StepDetectionTest(unittest.TestCase):
    def test_migration_step_detected(self):
        self.assertTrue(
            CHECK.step_runs_migrations({"run": "alembic upgrade head"})
        )

    def test_non_migration_step_rejected(self):
        self.assertFalse(
            CHECK.step_runs_migrations({"run": "echo hello"})
        )


class ConcurrencyGroupTest(unittest.TestCase):
    def test_workflow_with_group_passes(self):
        self.assertEqual(
            CHECK.check_workflow_concurrency(
                {".github/workflows/deploy.yml": MIGRATE_WF_LOCKED}
            ),
            [],
        )

    def test_migration_workflow_without_group_fails(self):
        findings = CHECK.check_workflow_concurrency(
            {".github/workflows/deploy.yml": MIGRATE_WF}
        )
        self.assertEqual(len(findings), 1)
        self.assertIn(".github/workflows/deploy.yml", findings[0])

    def test_workflow_without_migrations_passes_without_group(self):
        self.assertEqual(
            CHECK.check_workflow_concurrency(
                {
                    ".github/workflows/ci.yml": (
                        "name: ci\non: [push]\njobs:\n"
                        "  t:\n    runs-on: ubuntu-latest\n"
                        "    steps:\n      - run: echo hi\n"
                    )
                }
            ),
            [],
        )

    def test_has_concurrency_group_true_and_false(self):
        self.assertTrue(CHECK.has_concurrency_group(MIGRATE_WF_LOCKED))
        self.assertFalse(CHECK.has_concurrency_group(MIGRATE_WF))


class MigrationSeedLockTest(unittest.TestCase):
    def test_migrate_then_separate_seed_fails(self):
        findings = CHECK.check_migration_seed_same_lock(
            [
                {"name": "migrate", "run": "migrate --force --isolated"},
                {"name": "seed", "run": "seed catalogue"},
            ]
        )
        self.assertEqual(len(findings), 1)
        self.assertIn("migrate", findings[0])
        self.assertIn("seed", findings[0])

    def test_single_step_migrate_and_seed_passes(self):
        findings = CHECK.check_migration_seed_same_lock(
            [
                {
                    "name": "migrate-and-seed",
                    "run": "migrate --force --isolated && seed catalogue",
                }
            ]
        )
        self.assertEqual(findings, [])

    def test_migrate_alone_passes(self):
        findings = CHECK.check_migration_seed_same_lock(
            [{"name": "migrate", "run": "migrate --force --isolated"}]
        )
        self.assertEqual(findings, [])

    def test_seed_alone_passes(self):
        findings = CHECK.check_migration_seed_same_lock(
            [{"name": "seed", "run": "seed catalogue"}]
        )
        self.assertEqual(findings, [])


if __name__ == "__main__":
    unittest.main()
