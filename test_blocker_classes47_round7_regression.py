#!/usr/bin/env python3
"""Round-7 regression tests for the four 4/5 warnings on head `202a2d4`.

Pins the exact reviewer probes so the fixes cannot regress. Frozen
suites, round-2/3/4/5/6 files, and the review-acceptance module stay
untouched; this file pins the new behaviour separately.

- `-- no-transaction` never skips CONCURRENTLY (sqlx semantics): a marked
  file with a plain index flags, including a marker in the DOWN half.
- Same-file CREATE INDEX exemption is strict: schema-qualified mismatch,
  TEMP, string-literal prose, and DO-guard creations all flag; plain,
  qualified, and `IF NOT EXISTS` same-table creations stay exempt
  (round-8: the idempotent pair is the dominant forward-only shape).
- `postgres-transactional` gate wiring is harness-pinned: the delivered
  migration-gate heredoc exits 0 for a plain index / missing DOWN under
  the transactional pin and 1 for ALTER TYPE without USING.
- `run:` migration detection is token-based: `cargo test`, `selftest`,
  `echo`, `git`, `staging_migrate_db`, `unmigrated`, and `migrated`
  prose never flag; real `db:migrate` / `migrations apply` / `alembic
  upgrade` commands still do. `args:` with-inputs still flag and
  `forward-only: acknowledged` still skips DOWN.
"""

import importlib.util
import os
import re
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


def isolated_env():
    return {
        "PATH": "/usr/bin:/bin",
        "HOME": os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR", str(HERE)),
        "LANG": "C.UTF-8",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "PYTHONDONTWRITEBYTECODE": "1",
    }


class NoTransactionSemanticsTest(unittest.TestCase):
    def test_marker_does_not_waive_concurrently(self):
        findings = MIG.check_migration_safety({
            "m/1.sql": "-- no-transaction\nCREATE INDEX i ON existing(x);\n",
        })
        self.assertTrue(findings)
        self.assertIn("CONCURRENTLY", findings[0])

    def test_marker_in_down_half_does_not_waive_up_half(self):
        findings = MIG.check_migration_safety({
            "m/1.sql": (
                "CREATE INDEX i ON existing(x);\n-- DOWN\n"
                "-- no-transaction\nDROP INDEX i;\n"
            ),
        })
        self.assertTrue(findings)
        self.assertIn("CONCURRENTLY", findings[0])


class SameFileExemptionStrictnessTest(unittest.TestCase):
    def assert_flags(self, sql):
        findings = MIG.check_migration_safety({"m/1.sql": sql})
        self.assertTrue(findings, "must flag: %r" % sql[:80])
        self.assertIn("CONCURRENTLY", findings[0])

    def test_different_schema_same_bare_name_flags(self):
        self.assert_flags(
            "CREATE TABLE archive.events(id int);\n"
            "CREATE INDEX i ON public.events(id);\n"
        )

    def test_temp_table_does_not_exempt_persistent_index(self):
        self.assert_flags(
            "CREATE TEMP TABLE events(id int);\n"
            "CREATE INDEX i ON public.events(id);\n"
        )

    def test_temporary_keyword_does_not_exempt(self):
        self.assert_flags(
            "CREATE TEMPORARY TABLE events(id int);\n"
            "CREATE INDEX i ON events(id);\n"
        )

    def test_literal_prose_does_not_count_as_creation(self):
        self.assert_flags(
            "COMMENT ON TABLE events IS "
            "'create table events (id int)';\n"
            "CREATE INDEX i ON events(id);\n"
        )

    def test_if_not_exists_counts_as_new_table(self):
        # Round-8 correction: the idempotent IF NOT EXISTS pair is the
        # dominant forward-only shape; excluding it flagged ~half of a
        # real corpus, so it counts as proof (TEMP/literals/DO still do
        # not). Updated per the 4/5 review on head b8a11e1.
        self.assertEqual(MIG.check_migration_safety({
            "m/1.sql": (
                "CREATE TABLE IF NOT EXISTS events(id int);\n"
                "CREATE INDEX i ON events(id);\n"
            ),
        }), [])

    def test_if_not_exists_idempotent_pair_stays_exempt(self):
        self.assertEqual(MIG.check_migration_safety({
            "m/1.sql": (
                "CREATE TABLE IF NOT EXISTS events(id int);\n"
                "CREATE INDEX IF NOT EXISTS i ON events(id);\n"
            ),
        }), [])

    def test_do_guard_creation_does_not_exempt(self):
        self.assert_flags(
            "DO $$ BEGIN IF NOT EXISTS "
            "(SELECT 1 FROM pg_class WHERE relname='events') THEN "
            "CREATE TABLE events(id int); END IF; END $$;\n"
            "CREATE INDEX i ON events(id);\n"
        )

    def test_plain_same_file_stays_exempt(self):
        self.assertEqual(MIG.check_migration_safety({
            "m/1.sql": "CREATE TABLE t(id int);\nCREATE INDEX i ON t(id);\n",
        }), [])

    def test_qualified_same_schema_stays_exempt(self):
        self.assertEqual(MIG.check_migration_safety({
            "m/1.sql": (
                "CREATE TABLE public.t(id int);\n"
                "CREATE INDEX i ON public.t(id);\n"
            ),
        }), [])

    def test_qualified_vs_unqualified_does_not_exempt(self):
        self.assert_flags(
            "CREATE TABLE t(id int);\nCREATE INDEX i ON public.t(id);\n"
        )


class RunTokenDetectionTest(unittest.TestCase):
    def workflow_for_run(self, run_text):
        return (
            "name: x\non: [push]\njobs:\n  a:\n"
            "    runs-on: ubuntu-latest\n    steps:\n"
            "      - run: %s\n" % run_text
        )

    def assert_clean(self, run_text):
        self.assertEqual(CONC.check_workflow_concurrency({
            "w.yml": self.workflow_for_run(run_text),
        }), [], "must not flag: %r" % run_text)

    def assert_flags(self, run_text):
        findings = CONC.check_workflow_concurrency({
            "w.yml": self.workflow_for_run(run_text),
        })
        self.assertEqual(len(findings), 1, "must flag: %r" % run_text)

    def test_cargo_test_with_migrate_db_is_clean(self):
        self.assert_clean("cargo test -p cutover --test staging_migrate_db")

    def test_selftest_command_is_clean(self):
        self.assert_clean("npm run db:migrate:selftest")

    def test_echo_migrated_prose_is_clean(self):
        self.assert_clean('echo "rows migrated: 3"')

    def test_unmigrated_script_name_is_clean(self):
        self.assert_clean("./scripts/check-no-unmigrated-files.sh")

    def test_git_grep_migrate_is_clean(self):
        self.assert_clean("git log --grep=migrate")

    def test_real_db_migrate_flags(self):
        self.assert_flags("npm run db:migrate")

    def test_migrations_apply_flags(self):
        self.assert_flags("d1 migrations apply DB --remote")

    def test_alembic_upgrade_flags(self):
        self.assert_flags("alembic upgrade head")

    def test_step_helper_agrees(self):
        self.assertFalse(CONC.step_runs_migrations(
            {"run": 'echo "rows migrated: 3"'}))
        self.assertFalse(CONC.step_runs_migrations(
            {"run": "cargo test -p cutover --test staging_migrate_db"}))
        self.assertTrue(CONC.step_runs_migrations(
            {"run": "npm run db:migrate"}))


class WithArgsAndForwardOnlyTest(unittest.TestCase):
    def workflow_with(self, key, value):
        return (
            "name: x\non: [push]\njobs:\n  a:\n"
            "    runs-on: ubuntu-latest\n    steps:\n"
            "      - uses: actions/checkout@v4\n"
            "        with:\n          %s: %s\n" % (key, value)
        )

    def test_args_input_with_migration_flags(self):
        findings = CONC.check_workflow_concurrency({
            "w.yml": self.workflow_with(
                "args", "d1 migrations apply DB --remote"),
        })
        self.assertEqual(len(findings), 1)

    def test_forward_only_acknowledged_form_skips_down(self):
        self.assertEqual(MIG.check_migration_down(
            ["migrations/1.sql"],
            {"migrations/1.sql": (
                "CREATE TABLE t(id int);\nforward-only: acknowledged\n"
            )},
        ), [])


class TransactionalGateHarnessTest(unittest.TestCase):
    def setUp(self):
        scratch = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR")
        self.temp = tempfile.TemporaryDirectory(
            prefix="gate-round7-", dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.env = isolated_env()
        self.git("init", "-q")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Acceptance fixture")

    def git(self, *args):
        return subprocess.run(
            ["/usr/bin/git", *args], cwd=self.repo, env=self.env,
            capture_output=True, text=True, check=True, timeout=20,
        ).stdout.strip()

    def commit_files(self, files):
        for name, text in files.items():
            p = self.repo / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text)
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def run_gate(self, base_files, changes, dialect):
        base = self.commit_files({"README.md": "fixture\n", **base_files})
        self.commit_files(changes)
        changed = self.repo / "changed.txt"
        changed.write_text(self.git(
            "diff", "--name-only", "--no-renames", "--diff-filter=d",
            base, "HEAD", "--",
        ) + "\n")
        text = (STAGE / "migration-gate.yml").read_text()
        match = re.search(r"<<'PY'[^\n]*\n(.*?)\n[ \t]*PY(?:\n|$)", text, re.S)
        self.assertIsNotNone(match, "migration gate heredoc must run")
        env = dict(self.env, GATE_CHANGED=str(changed), GATE_BASE=base,
                   GATE_DIALECT=dialect, GATE_MODE="enforce",
                   GATE_LOGIC=str(HERE))
        return subprocess.run(
            [sys.executable, "-I", "-"],
            input=textwrap.dedent(match.group(1)),
            cwd=self.repo, env=env, capture_output=True, text=True,
            timeout=30,
        )

    def test_transactional_plain_index_and_missing_down_are_clean(self):
        proc = self.run_gate(
            {}, {"migrations/0002.sql": "CREATE INDEX i ON t(x);\n"},
            "postgres-transactional",
        )
        output = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 0, output)
        self.assertNotIn("CONCURRENTLY", output)
        self.assertNotIn("no -- DOWN", output)

    def test_transactional_alter_type_without_using_still_fails(self):
        proc = self.run_gate(
            {},
            {"migrations/0002.sql":
             "ALTER TABLE t ALTER COLUMN c TYPE bigint;\n"},
            "postgres-transactional",
        )
        output = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 1, output)
        self.assertIn("USING", output)

    def test_plain_postgres_still_flags_plain_index(self):
        proc = self.run_gate(
            {}, {"migrations/0002.sql": "CREATE INDEX i ON t(x);\n"},
            "postgres",
        )
        output = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 1, output)
        self.assertIn("CONCURRENTLY", output)


class CiWiringTest(unittest.TestCase):
    def test_ci_runs_round7_regression_module(self):
        self.assertIn(
            "test_blocker_classes47_round7_regression",
            CI.read_text(),
            "CI must run the round-7 regression module",
        )


if __name__ == "__main__":
    unittest.main()
