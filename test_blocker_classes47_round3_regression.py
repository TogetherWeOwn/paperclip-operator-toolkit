#!/usr/bin/env python3
"""Round-3 regression tests for blocker-ledger classes 4-7 review fixes.

Pins the seven warnings from the 4/5 review of head `e410379`. The frozen
acceptance suites (65 tests) and the round-2 regression file (22 tests)
stay untouched; this file pins the new behaviour separately.

- CI runs every regression module (round-2 omission left the last review's
  pins unrunnable on PRs).
- Block-comment stripping is quote-aware with Postgres nesting depth.
- EVERY migrating job needs its own concurrency (or a top-level one); one
  serialised migrating job never covers a second migrating job.
- Job-key indent is derived, not assumed +2; quoted job keys match
  (4-space workflows no longer false-positive).
- The down-path check is postgres-only (D1 forward-only migrations pass).
- The `dialect` input defaults to `auto`; explicit `postgres` is final;
  auto selects sqlite only when a wrangler `migrations_dir` covers a
  changed migration path (comment-aware, PR-diff-proof).
- Compact `steps:` lists (a `- ` item at the `steps:` indent) parse.
"""

import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MIG = load("blocker_migration_checks")
CONC = load("blocker_concurrency_checks")

STAGE = HERE / "templates" / "org-github" / "blocker-classes47"
CI = HERE / ".github" / "workflows" / "ci.yml"


def gate_text(gate):
    return (STAGE / f"{gate}-gate.yml").read_text()


FOUR_SPACE_WF = """\
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

FOUR_SPACE_WF_BARE = """\
name: deploy
on: [push]
jobs:
    deploy:
        runs-on: ubuntu-latest
        steps:
            - run: npm run migrate
"""

QUOTED_KEY_WF = """\
name: deploy
on: [push]
jobs:
  "deploy":
    runs-on: ubuntu-latest
    concurrency:
      group: db-${{ github.ref }}
    steps:
      - run: npm run migrate
"""

TWO_MIGRATING_JOBS_ONE_BARE = """\
name: deploy
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: npm run migrate
  b:
    runs-on: ubuntu-latest
    concurrency:
      group: db-${{ github.ref }}
    steps:
      - run: npm run migrate
"""

TWO_MIGRATING_JOBS_BOTH_LOCKED = """\
name: deploy
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    concurrency:
      group: a-${{ github.ref }}
    steps:
      - run: npm run migrate
  b:
    runs-on: ubuntu-latest
    concurrency:
      group: b-${{ github.ref }}
    steps:
      - run: npm run migrate
"""

COMPACT_STEPS_WF = """\
name: deploy
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
    - name: migrate
      run: npm run migrate --isolated
    - name: seed
      run: npm run seed
"""

D1_WRANGLER = """\
name = "worker"
[[d1_databases]]
binding = "DB"
database_id = "x"
migrations_dir = "migrations"
"""


class CiWiringTest(unittest.TestCase):
    def test_ci_runs_round2_regression_module(self):
        self.assertIn(
            "test_blocker_classes47_round2_regression",
            CI.read_text(),
            "CI must run the round-2 regression module",
        )

    def test_ci_runs_round3_regression_module(self):
        self.assertIn(
            "test_blocker_classes47_round3_regression",
            CI.read_text(),
            "CI must run the round-3 regression module",
        )


class BlockCommentStrippingTest(unittest.TestCase):
    def test_literal_glob_markers_do_not_mask_index(self):
        findings = MIG.check_migration_safety(
            {
                "migrations/0001_idx.sql": (
                    "INSERT INTO routes VALUES ('/api/*');\n"
                    "CREATE INDEX i ON t(x);\n"
                    "INSERT INTO routes VALUES ('*/health');\n"
                )
            }
        )
        self.assertTrue(
            any("CONCURRENTLY" in f for f in findings),
            "/* and */ inside literals must not eat the index statement",
        )

    def test_literal_markers_do_not_mask_drop_table(self):
        findings = MIG.check_migration_safety(
            {
                "migrations/0002_drop.sql": (
                    "INSERT INTO t VALUES ('/*');\n"
                    "DROP TABLE users;\n"
                    "INSERT INTO t VALUES ('*/');\n"
                )
            }
        )
        self.assertTrue(
            any("destructive DDL" in f for f in findings),
            "literals must not hide DROP TABLE",
        )

    def test_nested_block_comment_is_removed_by_depth(self):
        # Postgres nests block comments: the whole comment (including the
        # word CONCURRENTLY inside it) is removed, so the bare index flags.
        findings = MIG.check_migration_safety(
            {
                "migrations/0003_idx.sql": (
                    "/* a /* b */ CONCURRENTLY */ CREATE INDEX i ON t(x);\n"
                )
            }
        )
        self.assertTrue(
            any("CONCURRENTLY" in f for f in findings),
            "nested comment must not leak CONCURRENTLY over the statement",
        )

    def test_real_block_comment_still_stripped(self):
        findings = MIG.check_migration_safety(
            {
                "migrations/0004_ok.sql": (
                    "/* creates the index concurrently */\n"
                    "CREATE INDEX CONCURRENTLY i ON t(x);\n"
                )
            }
        )
        self.assertEqual(findings, [])


class EveryMigratingJobTest(unittest.TestCase):
    def test_second_migrating_job_without_group_fails(self):
        self.assertFalse(
            CONC.has_concurrency_group(TWO_MIGRATING_JOBS_ONE_BARE)
        )
        findings = CONC.check_workflow_concurrency(
            {".github/workflows/deploy.yml": TWO_MIGRATING_JOBS_ONE_BARE}
        )
        self.assertEqual(len(findings), 1)

    def test_two_migrating_jobs_both_locked_pass(self):
        self.assertTrue(
            CONC.has_concurrency_group(TWO_MIGRATING_JOBS_BOTH_LOCKED)
        )
        self.assertEqual(
            CONC.check_workflow_concurrency(
                {".github/workflows/deploy.yml": TWO_MIGRATING_JOBS_BOTH_LOCKED}
            ),
            [],
        )


class YamlIndentTest(unittest.TestCase):
    def test_four_space_job_level_concurrency_satisfies(self):
        self.assertTrue(CONC.has_concurrency_group(FOUR_SPACE_WF))
        self.assertEqual(
            CONC.check_workflow_concurrency(
                {".github/workflows/deploy.yml": FOUR_SPACE_WF}
            ),
            [],
        )

    def test_four_space_without_group_still_fails(self):
        self.assertFalse(CONC.has_concurrency_group(FOUR_SPACE_WF_BARE))
        findings = CONC.check_workflow_concurrency(
            {".github/workflows/deploy.yml": FOUR_SPACE_WF_BARE}
        )
        self.assertEqual(len(findings), 1)

    def test_quoted_job_key_with_concurrency_satisfies(self):
        self.assertTrue(CONC.has_concurrency_group(QUOTED_KEY_WF))


class DownPathDialectTest(unittest.TestCase):
    PATH = "migrations/0001_create_users.sql"
    BODY = "CREATE TABLE t (id INT);\n"

    def test_forward_only_d1_migration_passes_under_sqlite(self):
        self.assertEqual(
            MIG.check_migration_down([self.PATH], {self.PATH: self.BODY}, dialect="sqlite"),
            [],
        )

    def test_same_migration_flags_under_postgres(self):
        self.assertTrue(
            MIG.check_migration_down([self.PATH], {self.PATH: self.BODY})
        )

    def test_down_check_rejects_unknown_dialect(self):
        with self.assertRaises(ValueError):
            MIG.check_migration_down([self.PATH], {self.PATH: self.BODY}, dialect="mysql")


class DialectDetectionTest(unittest.TestCase):
    PATHS = ["migrations/0001_idx.sql"]

    def test_explicit_postgres_is_final_despite_d1_wrangler(self):
        self.assertEqual(
            MIG.detect_migration_dialect(
                "postgres",
                changed_paths=self.PATHS,
                wrangler_texts=[D1_WRANGLER],
            ),
            "postgres",
        )

    def test_explicit_sqlite_is_final_without_wrangler(self):
        self.assertEqual(
            MIG.detect_migration_dialect("sqlite", changed_paths=self.PATHS),
            "sqlite",
        )

    def test_auto_selects_sqlite_when_migrations_dir_covers_path(self):
        self.assertEqual(
            MIG.detect_migration_dialect(
                "auto", changed_paths=self.PATHS, wrangler_texts=[D1_WRANGLER]
            ),
            "sqlite",
        )

    def test_auto_ignores_commented_d1_line(self):
        self.assertEqual(
            MIG.detect_migration_dialect(
                "auto",
                changed_paths=self.PATHS,
                wrangler_texts=["# d1_databases\nname = \"w\"\n"],
            ),
            "postgres",
        )

    def test_auto_ignores_pr_diff_string_without_wrangler(self):
        # A PR adding the bare string elsewhere never flips detection:
        # only wrangler config texts are consulted.
        self.assertEqual(
            MIG.detect_migration_dialect(
                "auto", changed_paths=self.PATHS, wrangler_texts=[]
            ),
            "postgres",
        )

    def test_auto_stays_postgres_when_migrations_dir_misses_path(self):
        wrangler = D1_WRANGLER.replace('"migrations"', '"d1"')
        self.assertEqual(
            MIG.detect_migration_dialect(
                "auto", changed_paths=self.PATHS, wrangler_texts=[wrangler]
            ),
            "postgres",
        )

    def test_auto_without_d1_is_postgres(self):
        self.assertEqual(
            MIG.detect_migration_dialect(
                "auto",
                changed_paths=self.PATHS,
                wrangler_texts=['name = "w"\n'],
            ),
            "postgres",
        )


class CompactStepsTest(unittest.TestCase):
    def test_compact_list_parses_steps(self):
        blocks = CONC.job_step_blocks(COMPACT_STEPS_WF)
        flat = [s for b in blocks for s in b]
        self.assertTrue(
            any("migrate" in s.get("run", "") for s in flat),
            "compact steps list must yield the migrate step",
        )

    def test_compact_seed_outside_lock_reports(self):
        blocks = CONC.job_step_blocks(COMPACT_STEPS_WF)
        self.assertTrue(blocks and blocks[0])
        self.assertTrue(CONC.check_migration_seed_same_lock(blocks[0]))


class MigrationGateDialectWiringTest(unittest.TestCase):
    def test_gate_defaults_to_auto(self):
        text = gate_text("migration")
        self.assertIn('default: "auto"', text)

    def test_gate_uses_tested_detection_not_shell_grep(self):
        text = gate_text("migration")
        self.assertIn("detect_migration_dialect", text)
        self.assertNotIn("grep -rqi", text)

    def test_gate_passes_dialect_to_down_check(self):
        text = gate_text("migration")
        self.assertIn("check_migration_down(", text)
        self.assertIn("dialect=dialect", text)

    def test_gate_keeps_python_I(self):
        self.assertIn("python3 -I -", gate_text("migration"))


if __name__ == "__main__":
    unittest.main()
