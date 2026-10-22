#!/usr/bin/env python3
"""Blind acceptance coverage for the six outstanding review findings.

Written from the published review/spec, without reading implementation diffs.
Run beside the blocker modules and templates with:
    python3 -B -m unittest -v test_blocker_classes47_review_acceptance

Expected RED on public head 3b0b1c91; an authorized Builder owns GREEN.
CI must execute this file alongside the existing, unchanged acceptance suites.
"""

import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest

HERE = Path(__file__).resolve().parent
STAGE = HERE / "templates/org-github/blocker-classes47"


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MIG = load("blocker_migration_checks")
CONC = load("blocker_concurrency_checks")


def isolated_env():
    # Do not forward run credentials or identity into template execution.
    return {
        "PATH": "/usr/bin:/bin",
        "HOME": os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR", str(HERE)),
        "LANG": "C.UTF-8",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "PYTHONDONTWRITEBYTECODE": "1",
    }


class WranglerDialectAcceptanceTest(unittest.TestCase):
    def detect(self, text, path="wrangler.toml"):
        return MIG.detect_migration_dialect(
            "auto",
            changed_paths=["db/migrations/0001.sql"],
            wrangler_texts=[text],
            wrangler_paths=[path],
        )

    def test_environment_only_toml_binding_uses_its_declared_directory(self):
        self.assertEqual(self.detect(
            '[[env.production.d1_databases]]\n'
            'binding = "DB"\ndatabase_id = "x"\n'
            'migrations_dir = "db/migrations"\n'
        ), "sqlite")

    def test_environment_toml_binding_is_not_swallowed_by_root_binding(self):
        self.assertEqual(self.detect(
            '[[d1_databases]]\nbinding = "ROOT"\ndatabase_id = "r"\n'
            '[[env.production.d1_databases]]\nbinding = "DB"\n'
            'database_id = "x"\nmigrations_dir = "db/migrations"\n'
        ), "sqlite")

    def test_environment_json_binding_is_scanned_after_root_array(self):
        config = {
            "d1_databases": [{"binding": "ROOT", "database_id": "r"}],
            "env": {"production": {"d1_databases": [{
                "binding": "DB", "database_id": "x",
                "migrations_dir": "db/migrations",
            }]}},
        }
        self.assertEqual(self.detect(json.dumps(config), "wrangler.json"), "sqlite")

    def test_line_comment_apostrophe_does_not_change_jsonc_directory(self):
        self.assertEqual(self.detect(
            '{"d1_databases": [ // don\'t forget the id\n'
            '{"binding":"DB","database_id":"x",'
            '"migrations_dir":"db/migrations"}]}',
            "wrangler.jsonc",
        ), "sqlite")

    def test_block_comment_apostrophe_does_not_change_jsonc_directory(self):
        self.assertEqual(self.detect(
            '{"d1_databases": [ /* it\'s the primary */\n'
            '{"binding":"DB","database_id":"x",'
            '"migrations_dir":"db/migrations"}]}',
            "wrangler.jsonc",
        ), "sqlite")


class WithBlockScalarAcceptanceTest(unittest.TestCase):
    def workflow(self, key, header, command, locked=False):
        lock = "    concurrency: database-migrations\n" if locked else ""
        return (
            "name: apply\non: [push]\njobs:\n  apply:\n"
            "    runs-on: ubuntu-latest\n" + lock +
            "    steps:\n      - uses: cloudflare/wrangler-action@v3\n"
            "        with:\n" + f"          {key}: {header}\n" +
            f"            {command}\n"
        )

    def assert_needs_lock(self, key, header, command):
        findings = CONC.check_workflow_concurrency({
            ".github/workflows/apply.yml": self.workflow(key, header, command),
        })
        self.assertEqual(len(findings), 1, "a real migration command must require a lock")

    def test_literal_command_requires_serialization(self):
        self.assert_needs_lock("command", "|", "d1 migrations apply DB --remote")

    def test_folded_command_requires_serialization(self):
        self.assert_needs_lock("command", ">-", "d1 migrations apply DB --remote")

    def test_literal_post_commands_require_serialization(self):
        self.assert_needs_lock("postCommands", "|", "wrangler d1 migrations apply DB --remote")

    def test_locked_multiline_migration_passes(self):
        self.assertEqual(CONC.check_workflow_concurrency({
            ".github/workflows/apply.yml": self.workflow(
                "command", "|", "d1 migrations apply DB --remote", locked=True,
            ),
        }), [])

    def test_multiline_non_migration_does_not_require_lock(self):
        self.assertEqual(CONC.check_workflow_concurrency({
            ".github/workflows/apply.yml": self.workflow("command", "|", "deploy"),
        }), [])


class OptionalColumnAcceptanceTest(unittest.TestCase):
    def test_short_alter_type_requires_using(self):
        findings = MIG.check_migration_safety({
            "migrations/0001.sql": "ALTER TABLE t ALTER c TYPE bigint;",
        })
        self.assertEqual(len(findings), 1)
        self.assertIn("USING", findings[0])

    def test_using_in_one_clause_cannot_mask_another_short_clause(self):
        findings = MIG.check_migration_safety({
            "migrations/0001.sql": (
                "ALTER TABLE t ALTER a TYPE bigint USING a::bigint, "
                "ALTER b TYPE bigint;"
            ),
        })
        self.assertEqual(len(findings), 1)
        self.assertIn("USING", findings[0])

    def test_short_alter_type_with_using_is_safe(self):
        self.assertEqual(MIG.check_migration_safety({
            "migrations/0001.sql": "ALTER TABLE t ALTER c TYPE bigint USING c::bigint;",
        }), [])

    def test_table_named_type_is_not_a_type_conversion(self):
        self.assertEqual(MIG.check_migration_safety({
            "migrations/0001.sql": "ALTER TABLE type ADD COLUMN c bigint;",
        }), [])


class DeliveredGateAcceptanceTest(unittest.TestCase):
    def setUp(self):
        scratch = os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR")
        self.temp = tempfile.TemporaryDirectory(prefix="gate-acceptance-", dir=scratch)
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

    def migration_gate(self, base_files, changes, dialect):
        base = self.commit_files({"README.md": "fixture\n", **base_files})
        self.commit_files(changes)
        changed = self.repo / "changed.txt"
        changed.write_text(self.git(
            "diff", "--name-only", "--no-renames", "--diff-filter=d", base, "HEAD", "--",
        ) + "\n")
        # Extract the delivered heredoc as data. Do not duplicate its decisions.
        text = (STAGE / "migration-gate.yml").read_text()
        match = re.search(r"<<'PY'[^\n]*\n(.*?)\n[ \t]*PY(?:\n|$)", text, re.S)
        self.assertIsNotNone(match, "migration gate Python heredoc must be executable")
        env = dict(self.env, GATE_CHANGED=str(changed), GATE_BASE=base,
                   GATE_DIALECT=dialect, GATE_MODE="enforce", GATE_LOGIC=str(HERE))
        return subprocess.run(
            [sys.executable, "-I", "-"], input=textwrap.dedent(match.group(1)),
            cwd=self.repo, env=env, capture_output=True, text=True, timeout=30,
        )

    def test_explicit_postgres_overrides_base_d1_configuration(self):
        proc = self.migration_gate(
            {"wrangler.toml": '[[d1_databases]]\nbinding="DB"\ndatabase_id="x"\n'},
            {"migrations/0002.sql": "CREATE INDEX i ON t(x);\n"},
            "postgres",
        )
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("CONCURRENTLY", proc.stdout + proc.stderr)
        self.assertIn("DOWN", proc.stdout + proc.stderr)

    def test_explicit_sqlite_overrides_no_wrangler_default(self):
        proc = self.migration_gate(
            {}, {"migrations/0002.sql": "CREATE INDEX i ON t(x);\n"}, "sqlite",
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertNotIn("CONCURRENTLY", proc.stdout + proc.stderr)
        self.assertNotIn("no -- DOWN", proc.stdout + proc.stderr)

    def test_auto_dialect_is_resolved_per_file_in_mixed_pr(self):
        proc = self.migration_gate(
            {"wrangler.toml": '[[d1_databases]]\nbinding="DB"\ndatabase_id="x"\n'},
            {
                "migrations/0002_d1.sql": "CREATE INDEX d1_i ON t(x);\n",
                "db/pg/migrations/0003_pg.sql": "CREATE INDEX pg_i ON t(x);\n-- DOWN\n",
            }, "auto",
        )
        output = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 1, output)
        self.assertIn("db/pg/migrations/0003_pg.sql", output)
        self.assertIn("CONCURRENTLY", output)
        self.assertNotIn("migrations/0002_d1.sql:", output)

    def test_api_gate_skips_missing_schema_before_creating_placeholders(self):
        base = self.commit_files({"README.md": "fixture\n"})
        # Parse only the delivered YAML run block. No source-pattern assertion
        # may stand in for executing the skip branch.
        import yaml
        document = yaml.safe_load((STAGE / "api-contract-gate.yml").read_text())
        scripts = [step["run"] for job in document["jobs"].values()
                   for step in job.get("steps", [])
                   if "docs/api-schema.json" in step.get("run", "")]
        self.assertEqual(len(scripts), 1)
        script = re.sub(r"\$\{\{.*?\}\}", base, scripts[0])
        # Isolate the gate's fixed scratch paths from concurrent real runs.
        script = script.replace("/tmp/blocker-", str(self.repo / "blocker-"))
        env = dict(self.env, GATE_LOGIC=str(HERE), GATE_MODE="enforce",
                   GATE_EVENT="pull_request", GATE_PR_BASE=base, GATE_BEFORE=base,
                   GITHUB_OUTPUT=str(self.repo / "github-output"))
        proc = subprocess.run(
            ["/bin/bash", "-e", "-o", "pipefail", "-c", script],
            cwd=self.repo, env=env, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertRegex(proc.stdout.lower(), r"\bskip(?:ping|ped)?\b")
        self.assertFalse((self.repo / "docs/api-schema.json").exists())

    def test_required_wrapper_variable_is_in_executable_dialect_mapping(self):
        import yaml
        document = yaml.safe_load((STAGE / "migration-required.yml").read_text())
        forwarded = [job.get("with", {}).get("dialect", "")
                     for job in document["jobs"].values() if "uses" in job]
        self.assertEqual(len(forwarded), 1)
        self.assertRegex(forwarded[0],
                         r"inputs\.dialect\s*\|\|\s*vars\.BLOCKER_MIGRATION_DIALECT\s*\|\|")


if __name__ == "__main__":
    unittest.main()
