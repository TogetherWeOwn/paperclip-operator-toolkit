#!/usr/bin/env python3
"""Round-16 regression tests for the 4/5 findings on head `f0edd9b`.

Pins the exact reviewer probes so the fixes cannot regress. Frozen
suites and round-2..15 + review-acceptance files stay untouched.

- DROP CONSTRAINT backtracking: `_ALTER_DROP_CLAUSE_RE` was
  `^\\s*drop\\s+(?!constraint\\b)`. The greedy `\\s+` gives one space
  back when two or more follow DROP, so the lookahead sees a space
  instead of `constraint` and a metadata-only `DROP CONSTRAINT` reports
  as a column drop. The lookahead now sits before the whitespace
  (`^\\s*drop\\b(?!\\s+constraint\\b)`). Negatives cover two spaces, a
  newline, aligned multi-clause DDL, a block comment and a line comment
  between DROP and CONSTRAINT, under every dialect; positives prove real
  drops (including a column literally named `constraints`) still flag.
- Runbook step 1b validator: `include == ['*']`, the `wfs` non-empty
  guard, the `ref == 'refs/heads/main'` check and the `workflows`-type
  filter had no failing-payload test, and the validator never checked
  the exclude list it exists to inject. These tests run the exact step
  script against crafted payloads: one failing case per unpinned
  condition plus an empty-exclude render, and the valid case uses a real
  exclude list.
"""

import glob
import json
import os
import re
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
RULESETS = HERE / "templates" / "org-github" / "rulesets"
RUNBOOK = RULESETS / "SDLC-BASELINE-RUNBOOK.md"
CI = HERE / ".github" / "workflows" / "ci.yml"

sys.path.insert(0, str(HERE))

from blocker_migration_checks import check_migration_safety, DIALECTS


def safety(contents, dialect="postgres"):
    return check_migration_safety(contents, dialect=dialect)


def mig(sql):
    return {"migrations/001.sql": sql + "\n-- DOWN\nSELECT 1;\n"}


class DropConstraintWhitespaceTest(unittest.TestCase):
    # Every negative must stay clean under every dialect: a safe
    # constraint swap must never block a PR.
    NEGATIVES = [
        "ALTER TABLE t DROP CONSTRAINT c;",
        "ALTER TABLE t DROP  CONSTRAINT c;",
        "ALTER TABLE t DROP\n    CONSTRAINT c;",
        ("ALTER TABLE t\n"
         "    DROP   CONSTRAINT c,\n"
         "    ADD    CONSTRAINT c CHECK (a > 0);"),
        "ALTER TABLE t DROP /* old fk */ CONSTRAINT c;",
        "ALTER TABLE t DROP -- note\n CONSTRAINT c;",
        "ALTER TABLE t ALTER COLUMN x DROP NOT NULL;",
        "ALTER TABLE t ALTER COLUMN x DROP DEFAULT;",
    ]
    # Every positive must still report under every dialect.
    POSITIVES = [
        "ALTER TABLE t DROP legacy;",
        "ALTER TABLE t DROP IF EXISTS legacy;",
        "ALTER TABLE t DROP a, DROP b;",
        "ALTER TABLE t DROP constraints;",
        "ALTER TABLE t DROP CONSTRAINT c, DROP legacy;",
    ]

    def test_drop_constraint_whitespace_variants_stay_clean(self):
        for dialect in DIALECTS:
            for sql in self.NEGATIVES:
                self.assertEqual(
                    safety(mig(sql), dialect=dialect), [],
                    (dialect, sql),
                )

    def test_plain_drops_still_flag(self):
        for dialect in DIALECTS:
            for sql in self.POSITIVES:
                self.assertTrue(
                    safety(mig(sql), dialect=dialect),
                    (dialect, sql),
                )


def extract_step_1b_script():
    """The exact python the runbook step 1b executes."""
    text = RUNBOOK.read_text()
    match = re.search(r"<<'PY'\n(.*?)\nPY(?:\n|$)", text, re.S)
    assert match, "runbook step 1b python heredoc must be extractable"
    return match.group(1) + "\n"


REAL_EXCLUDE = [".github", "replay-mirror"]


def payload(repo_id, sha, include=("*",), exclude=REAL_EXCLUDE,
            ref="refs/heads/main", rule_type="workflows"):
    return {
        "conditions": {
            "repository_name": {
                "include": list(include),
                "exclude": list(exclude),
            },
        },
        "rules": [
            {
                "type": rule_type,
                "parameters": {
                    "workflows": [
                        {
                            "repository_id": repo_id,
                            "ref": ref,
                            "sha": sha,
                        },
                    ],
                },
            },
        ],
    }


class RunbookStep1bPinTest(unittest.TestCase):
    def setUp(self):
        self.saved = {}
        for name in glob.glob("/tmp/blocker-classes47-*.json"):
            with open(name, "rb") as fh:
                self.saved[name] = fh.read()
            os.unlink(name)
        self.addCleanup(self._restore)

    def _restore(self):
        for name in glob.glob("/tmp/blocker-classes47-*.json"):
            try:
                os.unlink(name)
            except OSError:
                pass
        for name, data in self.saved.items():
            with open(name, "wb") as fh:
                fh.write(data)

    def write(self, name, obj):
        with open("/tmp/%s" % name, "w") as fh:
            json.dump(obj, fh)

    def run_validator(self, excl=REAL_EXCLUDE):
        env = dict(os.environ, EXCL_JSON=json.dumps(excl))
        return subprocess.run(
            [sys.executable, "-I", "-"],
            input=extract_step_1b_script(),
            capture_output=True, text=True, timeout=30,
            env=env,
        )

    def test_valid_payload_with_real_exclude_passes(self):
        self.write(
            "blocker-classes47-test-a.json",
            payload(123, "abc123", exclude=REAL_EXCLUDE))
        self.write(
            "blocker-classes47-test-b.json",
            payload(123, "def456", exclude=REAL_EXCLUDE))
        proc = self.run_validator()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(
            proc.stdout.count("payload-valid"), 2, proc.stdout)

    def test_non_star_include_fails(self):
        self.write(
            "blocker-classes47-test-a.json",
            payload(123, "abc123", include=("repo",)))
        proc = self.run_validator()
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn("payload-valid", proc.stdout)

    def test_no_workflows_rule_fails(self):
        obj = payload(123, "abc123")
        obj["rules"] = []
        self.write("blocker-classes47-test-a.json", obj)
        proc = self.run_validator()
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn("payload-valid", proc.stdout)

    def test_non_workflows_rule_type_fails(self):
        obj = payload(
            123, "abc123", rule_type="required_status_checks")
        self.write("blocker-classes47-test-a.json", obj)
        proc = self.run_validator()
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn("payload-valid", proc.stdout)

    def test_wrong_ref_fails(self):
        self.write(
            "blocker-classes47-test-a.json",
            payload(123, "abc123", ref="refs/heads/other"))
        proc = self.run_validator()
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn("payload-valid", proc.stdout)

    def test_empty_exclude_render_fails(self):
        # An empty render (wrong STAGE path, empty exclude file, jq step
        # skipped) must not validate even though every other field is
        # well-formed. Both sides empty so only `assert expected_exclude`
        # stops it (deleting the assert would print payload-valid).
        self.write(
            "blocker-classes47-test-a.json",
            payload(123, "abc123", exclude=[]))
        proc = self.run_validator(excl=[])
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn("payload-valid", proc.stdout)

    def test_empty_exclude_env_unset_fails_closed(self):
        # EXCL_JSON unset (jq step skipped entirely) against an
        # empty-exclude payload must fail closed; only the
        # `assert expected_exclude` (via `or "[]"`) stops the
        # both-empty equality from validating.
        self.write(
            "blocker-classes47-test-a.json",
            payload(123, "abc123", exclude=[]))
        env = dict(os.environ)
        env.pop("EXCL_JSON", None)
        proc = subprocess.run(
            [sys.executable, "-I", "-"],
            input=extract_step_1b_script(),
            capture_output=True, text=True, timeout=30,
            env=env,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn("payload-valid", proc.stdout)

    def test_empty_injected_exclude_fails_closed(self):
        self.write(
            "blocker-classes47-test-a.json",
            payload(123, "abc123", exclude=REAL_EXCLUDE))
        proc = self.run_validator(excl=[])
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn("payload-valid", proc.stdout)

    def test_exclude_mismatch_fails(self):
        self.write(
            "blocker-classes47-test-a.json",
            payload(123, "abc123", exclude=["something-else"]))
        proc = self.run_validator()
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn("payload-valid", proc.stdout)


class CiWiringTest(unittest.TestCase):
    def test_ci_runs_round16_regression_module(self):
        self.assertIn(
            "test_blocker_classes47_round16_regression",
            CI.read_text(),
            "CI must run the round-16 regression module",
        )


if __name__ == "__main__":
    unittest.main()
