#!/usr/bin/env python3
"""Acceptance tests for the deterministic migration checks.

Covers blocker-ledger class 'migration' (class 4): unsafe or
non-reversible schema migrations are a recurring Claude blocker.
Staging/advisory first: the Builder wires the gate in warn mode; the
deterministic logic itself is pinned here.

Contract under test (to be implemented by the Builder in
`blocker_migration_checks.py`, repo root):

- `MIGRATION_DIRS`: tuple of directory markers that identify a migration
  file. Must contain at least `"migrations/"` and `"alembic/versions/"`.
- `is_migration_path(path) -> bool`: true when the path is under one of
  the `MIGRATION_DIRS` markers.
- `SAFETY_ACK == "safety: acknowledged"`: case-insensitive marker that
  waives destructive-DDL findings for that file (explicit human review).
- `check_migration_safety(contents) -> list[str]`: `contents` maps
  path -> SQL/text. One finding per file that contains destructive DDL
  (`DROP TABLE`, `DROP COLUMN`, `TRUNCATE`) without the ack marker, a
  `CREATE INDEX` without `CONCURRENTLY`, or an `ALTER COLUMN .. TYPE`
  without `USING`. Findings name the file. Safe migrations pass.
- `check_migration_down(changed_files, contents) -> list[str]`:
  every changed `*.sql` migration file must carry a `-- DOWN` marker
  (case-insensitive) or have a sibling `<same-stem>.down.sql` present in
  `changed_files`. One finding per migration missing both. Non-migration
  files are ignored.

Style: stdlib unittest, in-memory fixtures, one behavior per test. No
network, no clock, no filesystem writes. The module under test is loaded
via importlib so a missing module fails every test for the right reason.
"""

import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "blocker_migration_checks.py"


def load_module():
    spec = importlib.util.spec_from_file_location(
        "blocker_migration_checks", MODULE_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CHECK = load_module()


class MigrationDirsTest(unittest.TestCase):
    def test_migration_dirs_pin_core_markers(self):
        self.assertIn("migrations/", CHECK.MIGRATION_DIRS)
        self.assertIn("alembic/versions/", CHECK.MIGRATION_DIRS)

    def test_is_migration_path_detects_markers(self):
        for path in (
            "migrations/0001_init.sql",
            "alembic/versions/abc123_add_users.py",
            "prisma/migrations/20240101_init/migration.sql",
        ):
            self.assertTrue(
                CHECK.is_migration_path(path), f"must detect {path}"
            )

    def test_is_migration_path_rejects_non_migrations(self):
        for path in ("src/app.py", "README.md", "migrations_readme.md"):
            self.assertFalse(
                CHECK.is_migration_path(path), f"must reject {path}"
            )


class MigrationSafetyTest(unittest.TestCase):
    def test_safe_create_table_passes(self):
        findings = CHECK.check_migration_safety(
            {
                "migrations/0001_init.sql": (
                    "CREATE TABLE users (id SERIAL PRIMARY KEY);\n"
                    "-- DOWN\nDROP TABLE users;\n"
                )
            }
        )
        self.assertEqual(findings, [])

    def test_drop_table_without_ack_fails(self):
        findings = CHECK.check_migration_safety(
            {"migrations/0002_drop.sql": "ALTER TABLE x;\nDROP TABLE users;\n"}
        )
        self.assertTrue(findings, "destructive DDL must produce a finding")
        self.assertIn("migrations/0002_drop.sql", findings[0])

    def test_truncate_without_ack_fails(self):
        findings = CHECK.check_migration_safety(
            {"migrations/0003_trunc.sql": "TRUNCATE sessions;\n"}
        )
        self.assertTrue(findings, "TRUNCATE must produce a finding")

    def test_ack_marker_waives_destructive(self):
        findings = CHECK.check_migration_safety(
            {
                "migrations/0002_drop.sql": (
                    "-- safety: acknowledged by DBA review\n"
                    "DROP TABLE legacy_users;\n"
                )
            }
        )
        self.assertEqual(findings, [])

    def test_create_index_without_concurrently_fails(self):
        findings = CHECK.check_migration_safety(
            {"migrations/0004_idx.sql": "CREATE INDEX idx ON users (email);\n"}
        )
        self.assertTrue(
            findings, "non-concurrent index must produce a finding"
        )
        self.assertIn("migrations/0004_idx.sql", findings[0])

    def test_create_index_concurrently_passes(self):
        findings = CHECK.check_migration_safety(
            {
                "migrations/0004_idx.sql": (
                    "CREATE INDEX CONCURRENTLY idx ON users (email);\n"
                )
            }
        )
        self.assertEqual(findings, [])

    def test_alter_column_type_without_using_fails(self):
        findings = CHECK.check_migration_safety(
            {
                "migrations/0005_alter.sql": (
                    "ALTER TABLE users ALTER COLUMN age TYPE bigint;\n"
                )
            }
        )
        self.assertTrue(
            findings, "TYPE change without USING must produce a finding"
        )

    def test_alter_column_type_with_using_passes(self):
        findings = CHECK.check_migration_safety(
            {
                "migrations/0005_alter.sql": (
                    "ALTER TABLE users ALTER COLUMN age TYPE bigint "
                    "USING age::bigint;\n"
                )
            }
        )
        self.assertEqual(findings, [])


class MigrationDownTest(unittest.TestCase):
    def test_migration_with_down_marker_passes(self):
        findings = CHECK.check_migration_down(
            ["migrations/0001_init.sql"],
            {"migrations/0001_init.sql": "CREATE TABLE t (id INT);\n-- DOWN\n"},
        )
        self.assertEqual(findings, [])

    def test_migration_without_down_marker_fails(self):
        findings = CHECK.check_migration_down(
            ["migrations/0001_init.sql"],
            {"migrations/0001_init.sql": "CREATE TABLE t (id INT);\n"},
        )
        self.assertTrue(findings, "marker-less migration must fail")
        self.assertIn("migrations/0001_init.sql", findings[0])

    def test_sibling_down_file_satisfies(self):
        findings = CHECK.check_migration_down(
            ["migrations/0001_init.sql", "migrations/0001_init.down.sql"],
            {"migrations/0001_init.sql": "CREATE TABLE t (id INT);\n"},
        )
        self.assertEqual(findings, [])

    def test_non_migration_files_ignored(self):
        findings = CHECK.check_migration_down(
            ["src/app.py"], {"src/app.py": "print('hi')\n"}
        )
        self.assertEqual(findings, [])


if __name__ == "__main__":
    unittest.main()
