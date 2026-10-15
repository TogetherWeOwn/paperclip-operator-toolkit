#!/usr/bin/env python3
"""Round-5 regression tests for blocker-ledger classes 4-7 review fixes.

Pins the seven warnings from the 4/5 review of head `6dfc871`. The frozen
acceptance suites (65 tests) and the round-2/round-3/round-4 regression
files stay untouched; this file pins the new behaviour separately.

- Migrations run via `uses:`/`with:` steps (wrangler-action command,
  local composite action, reusable-workflow job) count as migrating,
  while `needs:`, names, and comments still never count.
- The base-commit wrangler read is pinned behaviourally: a temp git repo
  proves a PR-added `wrangler.toml` cannot flip the dialect under
  enforce, and `GATE_BASE` is asserted to be the base sha.
- `migrations_dir` normalises `../..` segments (posix normpath) and
  resolves per `[[d1_databases]]` binding (each binding without its own
  value keeps the config-relative `migrations` default).
- Dialect resolves per migration file (a non-SQL file under a D1 dir
  never flips a Postgres migration), and the required wrapper falls
  back to the `BLOCKER_MIGRATION_DIALECT` repo variable on
  `pull_request` (where `workflow_call` inputs are empty).
- A `-- down...` prose comment never ends the up-section; only an exact
  `-- down` marker line does.
- `ALTER COLUMN <ident> TYPE` matches the TYPE keyword right after the
  column identifier: a column named `type` or a `'type'` literal never
  reports.
- The api-contract gate checks for a missing schema before writing the
  `{}` placeholder, so the skip branch is reachable.
"""

import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
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


WRANGLER_ACTION_WF = """\
name: d1
on: [push]
jobs:
  mig:
    runs-on: ubuntu-latest
    steps:
      - uses: cloudflare/wrangler-action@v3
        with:
          command: d1 migrations apply DB --remote
"""

COMPOSITE_ACTION_WF = """\
name: d1
on: [push]
jobs:
  mig:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/run-migrations
"""

REUSABLE_JOB_WF = """\
name: d1
on: [push]
jobs:
  mig:
    runs-on: ubuntu-latest
    uses: ./.github/workflows/migrate.yml
"""

LOCKED_NEEDS_WF = """\
name: deploy
on: [push]
jobs:
  migrate:
    runs-on: ubuntu-latest
    concurrency:
      group: migrate-x
    steps:
      - run: npm run migrate
  deploy:
    runs-on: ubuntu-latest
    needs: migrate
    steps:
      - run: wrangler deploy
"""

D1_ROOT_TOML = """\
name = "w"
[[d1_databases]]
binding = "DB"
database_id = "x"
"""


class UsesStepsMigratingTest(unittest.TestCase):
    def test_wrangler_action_migrations_apply_flags(self):
        findings = CONC.check_workflow_concurrency(
            {".github/workflows/d1.yml": WRANGLER_ACTION_WF}
        )
        self.assertEqual(len(findings), 1)

    def test_local_composite_action_flags(self):
        findings = CONC.check_workflow_concurrency(
            {".github/workflows/d1.yml": COMPOSITE_ACTION_WF}
        )
        self.assertEqual(len(findings), 1)

    def test_reusable_workflow_job_flags(self):
        findings = CONC.check_workflow_concurrency(
            {".github/workflows/d1.yml": REUSABLE_JOB_WF}
        )
        self.assertEqual(len(findings), 1)

    def test_locked_uses_job_passes_with_own_group(self):
        locked = WRANGLER_ACTION_WF.replace(
            "    steps:",
            "    concurrency:\n      group: d1-x\n    steps:",
        )
        self.assertEqual(
            CONC.check_workflow_concurrency(
                {".github/workflows/d1.yml": locked}
            ),
            [],
        )

    def test_needs_migrate_still_not_migrating(self):
        self.assertEqual(
            CONC.check_workflow_concurrency(
                {".github/workflows/deploy.yml": LOCKED_NEEDS_WF}
            ),
            [],
        )

    def test_step_runs_migrations_sees_uses_and_with(self):
        self.assertTrue(
            CONC.step_runs_migrations(
                {
                    "uses": "cloudflare/wrangler-action@v3",
                    "with": "command: d1 migrations apply DB --remote",
                }
            )
        )
        self.assertTrue(
            CONC.step_runs_migrations(
                {"uses": "./.github/actions/run-migrations"}
            )
        )
        self.assertFalse(
            CONC.step_runs_migrations({"name": "Smoke test after migrate"})
        )


def extract_gate_python(gate_yml_text):
    marker = "<<'PY'"
    start = gate_yml_text.index(marker)
    body_start = gate_yml_text.index("\n", start) + 1
    end = gate_yml_text.index("\n          PY", body_start)
    # The YAML literal block strips the common indentation on the
    # runner; dedent here so the extracted script runs as it does in
    # the gate.
    return textwrap.dedent(gate_yml_text[body_start:end])


class MigrationGateBaseCommitBehaviourTest(unittest.TestCase):
    def test_gate_base_is_base_sha_not_head(self):
        text = gate_text("migration")
        self.assertIn('GATE_BASE="$base"', text)
        self.assertNotIn('GATE_BASE="HEAD"', text)

    def test_pr_added_wrangler_cannot_flip_enforce(self):
        if shutil.which("git") is None:
            self.skipTest("git required")
        py = extract_gate_python(gate_text("migration"))
        with tempfile.TemporaryDirectory() as repo:
            def git(*args, **kw):
                return subprocess.run(
                    ["git", *args],
                    cwd=repo,
                    capture_output=True,
                    text=True,
                    check=True,
                    **kw,
                )

            git("init", "-q")
            git("config", "user.email", "t@t.t")
            git("config", "user.name", "t")
            (Path(repo) / "README.md").write_text("base\n")
            git("add", "README.md")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD").stdout.strip()
            mig_dir = Path(repo) / "migrations"
            mig_dir.mkdir()
            (mig_dir / "0002_idx.sql").write_text(
                "CREATE INDEX i ON t (x);\n"
            )
            (Path(repo) / "wrangler.toml").write_text(
                'name = "w"\n[[d1_databases]]\nbinding = "DB"\n'
                'database_id = "x"\n'
            )
            git("add", "migrations/0002_idx.sql", "wrangler.toml")
            git("commit", "-qm", "pr")
            changed = git(
                "diff", "--name-only", "--no-renames",
                "--diff-filter=d", base, "HEAD", "--",
            ).stdout
            changed_file = Path(repo) / "changed.txt"
            changed_file.write_text(changed)
            env = dict(
                os.environ,
                GATE_CHANGED=str(changed_file),
                GATE_BASE=base,
                GATE_DIALECT="auto",
                GATE_LOGIC=str(HERE),
                GATE_MODE="enforce",
            )
            proc = subprocess.run(
                [sys.executable, "-I", "-"],
                input=py,
                cwd=repo,
                capture_output=True,
                text=True,
                env=env,
                timeout=120,
            )
            self.assertIn("dialect=postgres", proc.stdout)
            self.assertIn("CONCURRENTLY", proc.stdout)
            self.assertEqual(proc.returncode, 1)


class MigrationsDirResolutionTest(unittest.TestCase):
    def test_dotdot_segments_normalised(self):
        wrangler = (
            'name = "w"\n[[d1_databases]]\nbinding = "DB"\n'
            'database_id = "x"\nmigrations_dir = "../../db/migrations"\n'
        )
        self.assertEqual(
            MIG.detect_migration_dialect(
                "auto",
                changed_paths=["db/migrations/0001.sql"],
                wrangler_texts=[wrangler],
                wrangler_paths=["worker/api/wrangler.toml"],
            ),
            "sqlite",
        )

    def test_second_binding_keeps_default_dir(self):
        wrangler = (
            'name = "w"\n[[d1_databases]]\nbinding = "A"\n'
            'database_id = "a"\nmigrations_dir = "db2"\n'
            '[[d1_databases]]\nbinding = "B"\ndatabase_id = "b"\n'
        )
        self.assertEqual(
            MIG.detect_migration_dialect(
                "auto",
                changed_paths=["migrations/0001.sql"],
                wrangler_texts=[wrangler],
                wrangler_paths=["wrangler.toml"],
            ),
            "sqlite",
        )

    def test_mirror_binding_keeps_declared_dir(self):
        wrangler = (
            'name = "w"\n[[d1_databases]]\nbinding = "A"\n'
            'database_id = "a"\n[[d1_databases]]\nbinding = "B"\n'
            'database_id = "b"\nmigrations_dir = "db/migrations"\n'
        )
        self.assertEqual(
            MIG.detect_migration_dialect(
                "auto",
                changed_paths=["db/migrations/0001.sql"],
                wrangler_texts=[wrangler],
                wrangler_paths=["wrangler.toml"],
            ),
            "sqlite",
        )


class PerFileDialectTest(unittest.TestCase):
    def test_non_sql_under_d1_dir_does_not_flip(self):
        self.assertEqual(
            MIG.detect_migration_dialect(
                "auto",
                changed_paths=[
                    "migrations/NOTES.md",
                    "db/pg/0002_idx.sql",
                ],
                wrangler_texts=[D1_ROOT_TOML],
                wrangler_paths=["wrangler.toml"],
            ),
            "postgres",
        )

    def test_per_file_dialect_splits_mixed_pr(self):
        helper = getattr(MIG, "dialect_for_migration_path", None)
        self.assertTrue(
            callable(helper),
            "lib must resolve the dialect per migration file",
        )
        self.assertEqual(
            helper(
                "migrations/0001.sql",
                wrangler_texts=[D1_ROOT_TOML],
                wrangler_paths=["wrangler.toml"],
            ),
            "sqlite",
        )
        self.assertEqual(
            helper(
                "db/pg/0002_idx.sql",
                wrangler_texts=[D1_ROOT_TOML],
                wrangler_paths=["wrangler.toml"],
            ),
            "postgres",
        )

    def test_required_wrapper_falls_back_to_repo_variable(self):
        text = (STAGE / "migration-required.yml").read_text()
        self.assertIn("BLOCKER_MIGRATION_DIALECT", text)


class DownMarkerStrictnessTest(unittest.TestCase):
    def test_prose_down_comment_does_not_hide_index(self):
        findings = MIG.check_migration_safety(
            {
                "m/0001.sql": (
                    "CREATE TABLE a(id int);\n"
                    "-- down-sizing the cache table\n"
                    "CREATE INDEX i ON a(id);\n"
                )
            }
        )
        self.assertTrue(findings, "later CREATE INDEX must still report")
        self.assertIn("CONCURRENTLY", findings[0])

    def test_exact_down_marker_still_ends_up_section(self):
        findings = MIG.check_migration_safety(
            {
                "m/0001.sql": (
                    "CREATE INDEX i ON a(id);\n-- DOWN\nDROP TABLE a;\n"
                )
            }
        )
        self.assertEqual(len(findings), 1)
        self.assertIn("CONCURRENTLY", findings[0])

    def test_down_check_ignores_prose_down_comment(self):
        findings = MIG.check_migration_down(
            ["migrations/0001.sql"],
            {
                "migrations/0001.sql": (
                    "CREATE TABLE t (id INT);\n"
                    "-- down-sizing the cache table\n"
                )
            },
        )
        self.assertTrue(findings, "prose down text is not a DOWN marker")


class AlterTypeStrictnessTest(unittest.TestCase):
    def test_column_named_type_set_not_null_passes(self):
        self.assertEqual(
            MIG.check_migration_safety(
                {"m/1.sql": "ALTER TABLE t ALTER COLUMN type SET NOT NULL;"}
            ),
            [],
        )

    def test_default_literal_type_passes(self):
        self.assertEqual(
            MIG.check_migration_safety(
                {
                    "m/1.sql":
                    "ALTER TABLE t ALTER COLUMN c SET DEFAULT 'type';"
                }
            ),
            [],
        )

    def test_real_type_change_still_flags(self):
        findings = MIG.check_migration_safety(
            {"m/1.sql": "ALTER TABLE t ALTER COLUMN a TYPE int;"}
        )
        self.assertTrue(findings)
        self.assertIn("USING", findings[0])

    def test_set_data_type_still_flags(self):
        findings = MIG.check_migration_safety(
            {
                "m/1.sql":
                "ALTER TABLE t ALTER COLUMN a SET DATA TYPE numeric;"
            }
        )
        self.assertTrue(findings)


class ApiContractSkipTest(unittest.TestCase):
    def test_skip_check_runs_before_placeholder(self):
        text = gate_text("api-contract")
        skip = text.index("! -e docs/api-schema.json")
        writes = [
            i for i in range(len(text))
            if text.startswith("echo '{}'", i)
        ]
        self.assertTrue(writes, "gate must default a missing schema to {}")
        self.assertTrue(
            "base_has" in text or skip < min(writes),
            "the no-schema skip must not depend on the placeholder write",
        )


class CiWiringTest(unittest.TestCase):
    def test_ci_runs_round5_regression_module(self):
        self.assertIn(
            "test_blocker_classes47_round5_regression",
            CI.read_text(),
            "CI must run the round-5 regression module",
        )


if __name__ == "__main__":
    unittest.main()
