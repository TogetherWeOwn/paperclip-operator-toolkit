#!/usr/bin/env python3
"""Round-8 regression tests for the five 4/5 warnings on head `b8a11e1`.

Pins the exact reviewer probes so the fixes cannot regress. Frozen
suites (65 tests) and round-2/3/4/5/6/7 + review-acceptance files stay
untouched except the two corrected pins noted below; this file pins the
new behaviour separately.

- Run-token matcher matches path/word segments (`migrate-prod`,
  `db-migrate`, `migrate_db`, `./run_migrate.sh`) and judges chained
  `&&`/`||`/`;`/`|` segments alone, so `git pull && npm run migrate`
  flags while bare `echo`/`git`/`cargo test`/`selftest` prose stays
  clean. `preCommands` inputs still flag.
- `CREATE TABLE IF NOT EXISTS` counts as same-file proof (the idempotent
  pair is the dominant forward-only shape); a column named
  `executed_at` never skips the statement — only a statement-opening
  `EXECUTE` does.
- The gate `case` allow-list is shell-executed: `postgres-transactional`
  exits 0, unknown values exit 1.
- Lockfiles recognise `bun.lock`/`bun.lockb` and
  `requirements*.txt`/`Pipfile.lock`; tool-only `pyproject.toml` (via
  contents) and library crates (`src/lib.rs` without `src/main.rs`)
  never report; `lockfile: none` and `ignore_manifests` opt out.
"""

import importlib.util
import re
import subprocess
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
LOCK = load("blocker_lockfile_checks")

STAGE = HERE / "templates" / "org-github" / "blocker-classes47"
CI = HERE / ".github" / "workflows" / "ci.yml"


def workflow_for_run(run_text):
    return (
        "name: x\non: [push]\njobs:\n  deploy:\n"
        "    runs-on: ubuntu-latest\n    steps:\n"
        "      - run: %s\n" % run_text
    )


class RunTokenSegmentsTest(unittest.TestCase):
    def assert_flags(self, run_text):
        findings = CONC.check_workflow_concurrency(
            {"w.yml": workflow_for_run(run_text)}
        )
        self.assertEqual(len(findings), 1, "must flag: %r" % run_text)

    def assert_clean(self, run_text):
        self.assertEqual(CONC.check_workflow_concurrency(
            {"w.yml": workflow_for_run(run_text)}
        ), [], "must not flag: %r" % run_text)

    def test_hyphenated_migrate_prod_flags(self):
        self.assert_flags("npm run migrate-prod")

    def test_make_migrate_up_flags(self):
        self.assert_flags("make migrate-up")

    def test_migrate_prod_script_flags(self):
        self.assert_flags("./migrate-prod.sh")

    def test_db_migrate_package_flags(self):
        self.assert_flags("npx db-migrate up")

    def test_npm_db_migrate_flags(self):
        self.assert_flags("npm run db-migrate")

    def test_underscore_migrate_prod_flags(self):
        self.assert_flags("yarn migrate_prod")

    def test_underscore_migrate_db_flags(self):
        self.assert_flags("make migrate_db")

    def test_run_migrate_script_flags(self):
        self.assert_flags("./scripts/run_migrate.sh")

    def test_git_chain_still_flags(self):
        self.assert_flags("git pull --ff-only && npm run migrate")

    def test_echo_chain_still_flags(self):
        self.assert_flags('echo "go" && npm run db:migrate')

    def test_cargo_chain_still_flags(self):
        self.assert_flags("cargo test && ./deploy.sh migrate")

    def test_benign_prose_stays_clean(self):
        self.assert_clean("cargo test -p cutover --test staging_migrate_db")
        self.assert_clean("npm run db:migrate:selftest")
        self.assert_clean('echo "rows migrated: 3"')
        self.assert_clean("./scripts/check-no-unmigrated-files.sh")
        self.assert_clean("git log --grep=migrate")

    def test_step_helper_segment_chains(self):
        self.assertTrue(CONC.step_runs_migrations(
            {"run": "git pull --ff-only && npm run migrate"}))
        self.assertTrue(CONC.step_runs_migrations(
            {"run": 'echo "go" && npm run db:migrate'}))
        self.assertFalse(CONC.step_runs_migrations(
            {"run": "git log --grep=migrate"}))


class WithPreCommandsTest(unittest.TestCase):
    def workflow_with(self, key, value):
        return (
            "name: x\non: [push]\njobs:\n  a:\n"
            "    runs-on: ubuntu-latest\n    steps:\n"
            "      - uses: actions/checkout@v4\n"
            "        with:\n          %s: %s\n" % (key, value)
        )

    def test_precommands_input_still_migrating(self):
        findings = CONC.check_workflow_concurrency({
            "w.yml": self.workflow_with(
                "preCommands", "d1 migrations apply DB --remote"),
        })
        self.assertEqual(len(findings), 1)


class SameFileProofTest(unittest.TestCase):
    def test_if_not_exists_pair_stays_exempt(self):
        self.assertEqual(MIG.check_migration_safety({
            "m/1.sql": (
                "CREATE TABLE IF NOT EXISTS events(id int);\n"
                "CREATE INDEX IF NOT EXISTS i ON events(id);\n"
            ),
        }), [])

    def test_executed_at_column_stays_exempt(self):
        self.assertEqual(MIG.check_migration_safety({
            "m/1.sql": (
                "CREATE TABLE jobs (id int primary key,"
                " executed_at timestamptz);\n"
                "CREATE INDEX idx_jobs_exec ON jobs (executed_at);\n"
            ),
        }), [])

    def test_execute_string_creation_does_not_exempt(self):
        findings = MIG.check_migration_safety({
            "m/1.sql": (
                "EXECUTE 'CREATE TABLE events(id int)';\n"
                "CREATE INDEX i ON events(id);\n"
            ),
        })
        self.assertTrue(findings)
        self.assertIn("CONCURRENTLY", findings[0])


class GateCaseShellTest(unittest.TestCase):
    def _case_block(self):
        text = (STAGE / "migration-gate.yml").read_text()
        match = re.search(
            r"(?m)^\s*case \"\$\{GATE_DIALECT:-auto\}\" in\n"
            r"(?:.*\n)*?"
            r"^\s*esac\s*$",
            text,
        )
        self.assertIsNotNone(match, "gate case block must run")
        return match.group(0)

    def _run_case(self, dialect):
        script = self._case_block() + "\n"
        proc = subprocess.run(
            ["/bin/bash", "-c", script],
            capture_output=True, text=True, timeout=20,
            env={"PATH": "/usr/bin:/bin", "GATE_DIALECT": dialect},
        )
        return proc

    def test_case_block_pins_exact_allow_list(self):
        text = (STAGE / "migration-gate.yml").read_text()
        self.assertRegex(
            text,
            r"(?m)^\s*auto\|postgres\|sqlite\|postgres-transactional\)\s*;;",
        )

    def test_transactional_exits_zero(self):
        proc = self._run_case("postgres-transactional")
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_unknown_dialect_exits_nonzero(self):
        proc = self._run_case("bogus")
        self.assertNotEqual(proc.returncode, 0)


class LockfilePolicyTest(unittest.TestCase):
    def test_bun_lockfiles_satisfy_npm_manifest(self):
        self.assertEqual(
            LOCK.check_lockfile_present(
                ["package.json"], ["bun.lockb", "package.json"]), [])
        self.assertEqual(
            LOCK.check_lockfile_present(
                ["package.json"], ["bun.lock", "package.json"]), [])

    def test_requirements_txt_satisfies_pyproject(self):
        self.assertEqual(
            LOCK.check_lockfile_present(
                ["pyproject.toml"], ["requirements.txt"]), [])

    def test_requirements_variant_satisfies_pyproject(self):
        self.assertEqual(
            LOCK.check_lockfile_present(
                ["pyproject.toml"], ["requirements-dev.txt"]), [])

    def test_pipfile_lock_satisfies_pyproject(self):
        self.assertEqual(
            LOCK.check_lockfile_present(
                ["pyproject.toml"], ["Pipfile.lock"]), [])

    def test_library_crate_without_lock_passes(self):
        self.assertEqual(
            LOCK.check_lockfile_present(
                ["Cargo.toml"], ["src/lib.rs"]), [])

    def test_binary_crate_without_lock_still_flags(self):
        findings = LOCK.check_lockfile_present(["Cargo.toml"], [])
        self.assertTrue(findings)

    def test_tool_only_pyproject_with_contents_passes(self):
        self.assertEqual(LOCK.check_lockfile_present(
            ["pyproject.toml"], [],
            manifest_contents={"pyproject.toml": "[tool.ruff]\n"},
        ), [])

    def test_dependency_pyproject_with_contents_still_flags(self):
        findings = LOCK.check_lockfile_present(
            ["pyproject.toml"], [],
            manifest_contents={"pyproject.toml": "[project]\nname = \"x\"\n"},
        )
        self.assertTrue(findings)

    def test_lockfile_none_marker_opts_out(self):
        self.assertEqual(LOCK.check_lockfile_present(
            ["package.json"], [],
            manifest_contents={"package.json": "{}\n# lockfile: none\n"},
        ), [])

    def test_is_lockfile_recognises_new_names(self):
        self.assertTrue(LOCK.is_lockfile("bun.lockb"))
        self.assertTrue(LOCK.is_lockfile("requirements-dev.txt"))
        self.assertTrue(LOCK.is_lockfile("Pipfile.lock"))


class CiWiringTest(unittest.TestCase):
    def test_ci_runs_round8_regression_module(self):
        self.assertIn(
            "test_blocker_classes47_round8_regression",
            CI.read_text(),
            "CI must run the round-8 regression module",
        )


if __name__ == "__main__":
    unittest.main()
