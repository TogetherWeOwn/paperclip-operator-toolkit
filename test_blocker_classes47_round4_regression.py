#!/usr/bin/env python3
"""Round-4 regression tests for blocker-ledger classes 4-7 review fixes.

Pins the three warnings from the 4/5 review of head `05603ba`. The frozen
acceptance suites (65 tests) and the round-2/round-3 regression files stay
untouched; this file pins the new behaviour separately.

- Migrating jobs are decided from step `run:` text (lib `job_step_blocks` /
  `step_runs_migrations`), never the raw block text: a `needs: migrate`
  deploy job, a step named `...migrate...`, or a comment mentioning
  migrate must not make a non-migrating job count as migrating.
- The migration gate reads wrangler configs from the BASE commit (never the
  PR checkout), so a PR-added `wrangler.toml` cannot flip the dialect; the
  required wrapper passes a `dialect` input through; unknown dialect values
  are rejected instead of falling back to auto.
- `migrations_dir` parsing accepts quoted JSON keys, normalises a leading
  `./`, and resolves relative to the wrangler config's own directory.
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


# A correctly serialised migrate job plus a deploy job that only depends
# on it via `needs: migrate` (its steps never run migrations).
NEEDS_MIGRATE_WF = """\
name: deploy
on: [push]
jobs:
  migrate:
    runs-on: ubuntu-latest
    concurrency:
      group: migrate-${{ github.ref }}
    steps:
      - run: npm run migrate
  deploy:
    runs-on: ubuntu-latest
    needs: migrate
    steps:
      - run: wrangler deploy
"""

# A step NAME mentioning migrate must not make the job migrating.
STEP_NAME_WF = """\
name: deploy
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    concurrency:
      group: db-${{ github.ref }}
    steps:
      - name: Smoke test after migrate
        run: echo ok
"""

# A comment mentioning migrate must not make the job migrating.
COMMENT_WF = """\
name: deploy
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    concurrency:
      group: db-${{ github.ref }}
    steps:
      # migrate happens elsewhere
      - run: echo ok
"""

# A deploy job with needs: migrate but NO concurrency anywhere and a locked
# migrate job must still pass (deploy is not migrating).
NEEDS_MIGRATE_BARE_DEPLOY_WF = NEEDS_MIGRATE_WF

D1_TOML_SUBDIR = """\
name = "worker"
[[d1_databases]]
binding = "DB"
database_id = "x"
"""

D1_JSONC = """\
{
  // d1 database
  "d1_databases": [{"binding": "DB"}],
  "migrations_dir": "db/migrations"
}
"""

D1_TOML_DOTSLASH = """\
name = "worker"
[[d1_databases]]
binding = "DB"
database_id = "x"
migrations_dir = "./db/migrations"
"""


class MigratingFromRunTextTest(unittest.TestCase):
    def test_needs_migrate_deploy_job_passes(self):
        self.assertTrue(CONC.has_concurrency_group(NEEDS_MIGRATE_WF))
        self.assertEqual(
            CONC.check_workflow_concurrency(
                {".github/workflows/deploy.yml": NEEDS_MIGRATE_WF}
            ),
            [],
        )

    def test_step_name_mentioning_migrate_is_not_migrating(self):
        # No step runs migrations, so there is nothing to serialise:
        # the workflow passes with or without a group.
        self.assertEqual(
            CONC.check_workflow_concurrency(
                {".github/workflows/deploy.yml": STEP_NAME_WF}
            ),
            [],
        )

    def test_comment_mentioning_migrate_is_not_migrating(self):
        self.assertEqual(
            CONC.check_workflow_concurrency(
                {".github/workflows/deploy.yml": COMMENT_WF}
            ),
            [],
        )

    def test_bare_migrate_job_still_fails_with_needs_deploy_present(self):
        wf = NEEDS_MIGRATE_WF.replace(
            "    concurrency:\n      group: migrate-${{ github.ref }}\n", ""
        )
        self.assertFalse(CONC.has_concurrency_group(wf))
        findings = CONC.check_workflow_concurrency(
            {".github/workflows/deploy.yml": wf}
        )
        self.assertEqual(len(findings), 1)


class DialectStrictnessTest(unittest.TestCase):
    def test_detect_rejects_capitalised_postgres(self):
        with self.assertRaises(ValueError):
            MIG.detect_migration_dialect("Postgres", changed_paths=["migrations/a.sql"])

    def test_detect_rejects_unknown_dialect(self):
        with self.assertRaises(ValueError):
            MIG.detect_migration_dialect("mysql", changed_paths=["migrations/a.sql"])

    def test_safety_rejects_unknown_dialect(self):
        with self.assertRaises(ValueError):
            MIG.check_migration_safety({"migrations/a.sql": "DROP TABLE t;"}, dialect="Bogus")


class MigrationsDirDetectionTest(unittest.TestCase):
    def test_quoted_json_key_matches(self):
        self.assertEqual(
            MIG.detect_migration_dialect(
                "auto",
                changed_paths=["db/migrations/0001.sql"],
                wrangler_texts=[D1_JSONC],
            ),
            "sqlite",
        )

    def test_dot_slash_prefix_normalised(self):
        self.assertEqual(
            MIG.detect_migration_dialect(
                "auto",
                changed_paths=["db/migrations/0001.sql"],
                wrangler_texts=[D1_TOML_DOTSLASH],
            ),
            "sqlite",
        )

    def test_subdir_config_default_dir_is_config_relative(self):
        self.assertEqual(
            MIG.detect_migration_dialect(
                "auto",
                changed_paths=["worker/migrations/0001.sql"],
                wrangler_texts=[D1_TOML_SUBDIR],
                wrangler_paths=["worker/wrangler.toml"],
            ),
            "sqlite",
        )

    def test_subdir_config_does_not_cover_root_migrations(self):
        self.assertEqual(
            MIG.detect_migration_dialect(
                "auto",
                changed_paths=["migrations/0002.sql"],
                wrangler_texts=[D1_TOML_SUBDIR],
                wrangler_paths=["worker/wrangler.toml"],
            ),
            "postgres",
        )

    def test_subdir_migrations_dir_is_config_relative(self):
        wrangler = D1_TOML_SUBDIR + 'migrations_dir = "db/migrations"\n'
        self.assertEqual(
            MIG.detect_migration_dialect(
                "auto",
                changed_paths=["worker/db/migrations/0001.sql"],
                wrangler_texts=[wrangler],
                wrangler_paths=["worker/wrangler.toml"],
            ),
            "sqlite",
        )


class MigrationGateBaseCommitTest(unittest.TestCase):
    def test_gate_reads_wrangler_from_base_commit(self):
        text = gate_text("migration")
        self.assertIn("git show", text)
        self.assertIn("ls-tree", text)

    def test_gate_does_not_glob_workspace_wrangler(self):
        text = gate_text("migration")
        # Wrangler configs must come from the base commit (git show),
        # never from a workspace glob over PR-controlled files.
        self.assertNotIn("glob.glob", text)
        self.assertNotIn("import glob", text)

    def test_gate_rejects_unknown_dialect(self):
        text = gate_text("migration")
        self.assertIn("unknown dialect", text.lower())

    def test_required_wrapper_passes_dialect(self):
        text = (STAGE / "migration-required.yml").read_text()
        self.assertIn("dialect", text)


class CiWiringTest(unittest.TestCase):
    def test_ci_runs_round4_regression_module(self):
        self.assertIn(
            "test_blocker_classes47_round4_regression",
            CI.read_text(),
            "CI must run the round-4 regression module",
        )


if __name__ == "__main__":
    unittest.main()
