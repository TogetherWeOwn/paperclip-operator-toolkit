#!/usr/bin/env python3
"""Round-6 regression tests for the five 4/5 warnings on head `2a38dce`.

Pins the exact reviewer probes so the fixes cannot regress. The frozen
suites (65 tests), round-2/3/4/5 files, and the review-acceptance module
stay untouched; this file pins the new behaviour separately.

- ALTER ... TYPE inside DO blocks, function bodies, and EXECUTE strings
  still flags (searched, not start-anchored); top-level short/long forms
  still flag; USING still safe; table/column named `type` still safe.
- The ADOPTION.md caller snippet and every `*-required.yml` wrapper pass
  `check_workflow_concurrency` clean (gate refs never count as migrating).
- Same-file CREATE INDEX never reports; `-- no-transaction` skips
  CONCURRENTLY per file; `postgres-transactional` skips CONCURRENTLY+DOWN
  globally but keeps USING; `-- forward-only` skips DOWN per file.
- Only command-carrying `with:` inputs count: `ref`/`name`/cache-`key`
  mentioning migrate never flag; `command`/`postCommands` still do.
- Mutation pins: invalid TOML/JSONC keeps postgres without crashing; a
  PR that deletes `docs/api-schema.json` reports (never skips); a `>-`
  command split across lines still flags; a `# npm run migrate` comment
  inside `run: |` never flags.
"""

import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
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


class AlterInProceduralBodiesTest(unittest.TestCase):
    def test_do_block_alter_type_flags(self):
        findings = MIG.check_migration_safety({
            "m/1.sql": (
                "DO $$ BEGIN IF EXISTS (...) THEN "
                "ALTER TABLE t ALTER COLUMN c TYPE bigint; "
                "END IF; END $$;"
            ),
        })
        self.assertTrue(findings)
        self.assertIn("USING", findings[0])

    def test_function_body_alter_type_flags(self):
        findings = MIG.check_migration_safety({
            "m/1.sql": (
                "CREATE FUNCTION f() RETURNS void AS $$ BEGIN "
                "ALTER TABLE t ALTER COLUMN c TYPE bigint; "
                "END $$ LANGUAGE plpgsql;"
            ),
        })
        self.assertTrue(findings)
        self.assertIn("USING", findings[0])

    def test_execute_string_alter_type_flags(self):
        findings = MIG.check_migration_safety({
            "m/1.sql": (
                "DO $$ BEGIN EXECUTE "
                "'ALTER TABLE t ALTER COLUMN c TYPE bigint'; END $$;"
            ),
        })
        self.assertTrue(findings)
        self.assertIn("USING", findings[0])

    def test_do_block_alter_type_with_using_is_safe(self):
        self.assertEqual(MIG.check_migration_safety({
            "m/1.sql": (
                "DO $$ BEGIN "
                "ALTER TABLE t ALTER COLUMN c TYPE bigint USING c::bigint; "
                "END $$;"
            ),
        }), [])


class GateSelfReferenceTest(unittest.TestCase):
    def test_adoption_snippet_passes_concurrency(self):
        text = (STAGE / "ADOPTION.md").read_text()
        blocks = re.findall(r"```yaml(.*?)```", text, re.S)
        self.assertTrue(blocks, "ADOPTION.md must carry a caller snippet")
        for block in blocks:
            self.assertEqual(
                CONC.check_workflow_concurrency({"caller.yml": block}), [],
                "adopter caller snippet must not trip the concurrency check",
            )

    def test_required_wrappers_pass_concurrency(self):
        for wrapper in sorted(STAGE.glob("*-required.yml")):
            self.assertEqual(
                CONC.check_workflow_concurrency(
                    {wrapper.name: wrapper.read_text()}
                ),
                [],
                "%s must not trip the concurrency check" % wrapper.name,
            )


class SameTableAndTransactionalTest(unittest.TestCase):
    def test_same_file_index_is_exempt(self):
        self.assertEqual(MIG.check_migration_safety({
            "m/1.sql": "CREATE TABLE t(id int);\nCREATE INDEX i ON t(id);\n",
        }), [])

    def test_other_table_index_still_flags(self):
        findings = MIG.check_migration_safety({
            "m/1.sql": "CREATE TABLE a(id int);\nCREATE INDEX i ON other(id);\n",
        })
        self.assertTrue(findings)
        self.assertIn("CONCURRENTLY", findings[0])

    def test_no_transaction_marker_does_not_skip_concurrently(self):
        # `-- no-transaction` is the sqlx marker for a file that does NOT
        # run in a transaction: CONCURRENTLY works there, so the gate
        # still requires it (transactional runners pin the
        # `postgres-transactional` dialect instead).
        findings = MIG.check_migration_safety({
            "m/1.sql": "CREATE INDEX i ON t(x);\n-- no-transaction\n",
        })
        self.assertTrue(findings)
        self.assertIn("CONCURRENTLY", findings[0])

    def test_no_transaction_marker_in_down_half_does_not_skip(self):
        findings = MIG.check_migration_safety({
            "m/1.sql": (
                "CREATE INDEX i ON t(x);\n-- DOWN\n-- no-transaction\n"
                "DROP INDEX i;\n"
            ),
        })
        self.assertTrue(findings)
        self.assertIn("CONCURRENTLY", findings[0])

    def test_no_transaction_marker_keeps_using(self):
        findings = MIG.check_migration_safety({
            "m/1.sql": (
                "ALTER TABLE t ALTER COLUMN c TYPE bigint;\n"
                "-- no-transaction\n"
            ),
        })
        self.assertTrue(findings)
        self.assertIn("USING", findings[0])

    def test_transactional_dialect_skips_concurrently_and_down(self):
        self.assertEqual(MIG.check_migration_safety(
            {"m/1.sql": "CREATE INDEX i ON t(x);\n"},
            dialect="postgres-transactional",
        ), [])
        self.assertEqual(MIG.check_migration_down(
            ["migrations/1.sql"],
            {"migrations/1.sql": "CREATE TABLE t(id int);\n"},
            dialect="postgres-transactional",
        ), [])

    def test_transactional_dialect_keeps_using(self):
        findings = MIG.check_migration_safety(
            {"m/1.sql": "ALTER TABLE t ALTER COLUMN c TYPE bigint;\n"},
            dialect="postgres-transactional",
        )
        self.assertTrue(findings)
        self.assertIn("USING", findings[0])

    def test_forward_only_marker_skips_down(self):
        self.assertEqual(MIG.check_migration_down(
            ["migrations/1.sql"],
            {"migrations/1.sql": (
                "CREATE TABLE t(id int);\n-- forward-only\n"
            )},
        ), [])

    def test_explicit_transactional_pin_is_final(self):
        self.assertEqual(
            MIG.detect_migration_dialect("postgres-transactional"), "postgres-transactional"
        )

    def test_gate_accepts_transactional_dialect(self):
        text = (STAGE / "migration-gate.yml").read_text()
        self.assertIn("postgres-transactional", text)
        # The gate's `case` allow-list must accept the new value: the
        # input description already mentions it, so a bare `assertIn`
        # survives dropping it from the case statement.
        self.assertRegex(
            text,
            r"auto\|postgres\|sqlite\|postgres-transactional",
        )


class WithInputScopeTest(unittest.TestCase):
    def workflow_with(self, key, value):
        return (
            "name: x\non: [push]\njobs:\n  a:\n"
            "    runs-on: ubuntu-latest\n    steps:\n"
            "      - uses: actions/checkout@v4\n"
            "        with:\n          %s: %s\n" % (key, value)
        )

    def assert_clean(self, key, value):
        self.assertEqual(CONC.check_workflow_concurrency({
            "w.yml": self.workflow_with(key, value),
        }), [], "%s input must not make a job migrating" % key)

    def test_checkout_ref_is_not_migrating(self):
        self.assert_clean("ref", "migrate-to-v2")

    def test_artifact_name_is_not_migrating(self):
        self.assert_clean("name", "migrate-logs")

    def test_cache_key_is_not_migrating(self):
        self.assert_clean("key", "${{ hashFiles('db/migrate/**') }}")

    def test_command_input_still_migrating(self):
        findings = CONC.check_workflow_concurrency({
            "w.yml": self.workflow_with(
                "command", "d1 migrations apply DB --remote"
            ),
        })
        self.assertEqual(len(findings), 1)

    def test_direct_with_ref_is_not_migrating(self):
        self.assertFalse(CONC.step_runs_migrations(
            {"uses": "actions/checkout@v4", "with": "ref: migrate-to-v2"}
        ))

    def test_direct_with_command_is_migrating(self):
        self.assertTrue(CONC.step_runs_migrations(
            {"uses": "cloudflare/wrangler-action@v3",
             "with": "command: d1 migrations apply DB --remote"}
        ))


class MutationPinTest(unittest.TestCase):
    def test_invalid_toml_keeps_postgres_without_crash(self):
        self.assertEqual(MIG.detect_migration_dialect(
            "auto",
            changed_paths=["migrations/1.sql"],
            wrangler_texts=["[[[invalid"],
            wrangler_paths=["wrangler.toml"],
        ), "postgres")

    def test_invalid_json_keeps_postgres_without_crash(self):
        self.assertEqual(MIG.detect_migration_dialect(
            "auto",
            changed_paths=["migrations/1.sql"],
            wrangler_texts=['{"d1_databases": ['],
            wrangler_paths=["wrangler.json"],
        ), "postgres")

    def test_folded_command_split_across_lines_flags(self):
        wf = (
            "name: apply\non: [push]\njobs:\n  apply:\n"
            "    runs-on: ubuntu-latest\n    steps:\n"
            "      - uses: cloudflare/wrangler-action@v3\n"
            "        with:\n          command: >-\n"
            "            d1 migrations\n"
            "            apply DB --remote\n"
        )
        findings = CONC.check_workflow_concurrency(
            {".github/workflows/apply.yml": wf}
        )
        self.assertEqual(len(findings), 1)

    def test_commented_migrate_in_run_block_is_clean(self):
        wf = (
            "name: apply\non: [push]\njobs:\n  apply:\n"
            "    runs-on: ubuntu-latest\n    steps:\n"
            "      - run: |\n"
            "          echo start\n"
            "          # npm run migrate\n"
            "          echo done\n"
        )
        self.assertEqual(CONC.check_workflow_concurrency(
            {".github/workflows/apply.yml": wf}
        ), [])

    def test_pr_deleting_schema_reports_instead_of_skipping(self):
        scratch = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR")
        tmp = tempfile.TemporaryDirectory(prefix="api-delete-", dir=scratch)
        self.addCleanup(tmp.cleanup)
        repo = Path(tmp.name)
        env = {
            "PATH": "/usr/bin:/bin",
            "HOME": str(repo),
            "LANG": "C.UTF-8",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "PYTHONDONTWRITEBYTECODE": "1",
        }

        def git(*args):
            return subprocess.run(
                ["/usr/bin/git", *args], cwd=repo, env=env,
                capture_output=True, text=True, check=True, timeout=20,
            ).stdout.strip()

        git("init", "-q")
        git("config", "user.email", "test@example.invalid")
        git("config", "user.name", "Acceptance fixture")
        schema = {
            "GET /v1/things": {"req_required": [], "resp_required": ["id"]},
        }
        (repo / "docs").mkdir(parents=True)
        (repo / "docs" / "api-schema.json").write_text(json.dumps(schema))
        (repo / "README.md").write_text("fixture\n")
        git("add", ".")
        git("commit", "-qm", "base")
        base = git("rev-parse", "HEAD")
        (repo / "docs" / "api-schema.json").unlink()
        (repo / "README.md").write_text("fixture\npr\n")
        git("add", ".")
        git("commit", "-qm", "pr")
        import yaml
        document = yaml.safe_load(
            (STAGE / "api-contract-gate.yml").read_text()
        )
        scripts = [step["run"] for job in document["jobs"].values()
                   for step in job.get("steps", [])
                   if "docs/api-schema.json" in step.get("run", "")]
        self.assertEqual(len(scripts), 1)
        script = re.sub(r"\$\{\{.*?\}\}", base, scripts[0])
        script = script.replace("/tmp/blocker-", str(repo / "blocker-"))
        # Point the gate at the local logic (the script otherwise uses
        # GITHUB_WORKSPACE/.org-gate-logic, which does not exist locally).
        script = script.replace(
            '${GITHUB_WORKSPACE}/.org-gate-logic/blocker-classes47',
            str(HERE),
        )
        run_env = dict(env, GATE_LOGIC=str(HERE), GATE_MODE="enforce",
                       GATE_EVENT="pull_request", GATE_PR_BASE=base,
                       GATE_BEFORE=base,
                       GITHUB_WORKSPACE=str(repo),
                       GITHUB_OUTPUT=str(repo / "github-output"))
        proc = subprocess.run(
            ["/bin/bash", "-e", "-o", "pipefail", "-c", script],
            cwd=repo, env=run_env, capture_output=True, text=True,
            timeout=30,
        )
        output = proc.stdout + proc.stderr
        self.assertNotEqual(proc.returncode, 0, output)
        self.assertRegex(output, r"(?i)removed|delete|endpoint")


class CiWiringTest(unittest.TestCase):
    def test_ci_runs_round6_regression_module(self):
        self.assertIn(
            "test_blocker_classes47_round6_regression",
            CI.read_text(),
            "CI must run the round-6 regression module",
        )


if __name__ == "__main__":
    unittest.main()
