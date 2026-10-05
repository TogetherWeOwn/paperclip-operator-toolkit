#!/usr/bin/env python3
"""Tests for ci_policy.py. Run: python3 -m unittest discover -s .github/scripts -p 'test_ci_policy.py'

Fixture convention: runner labels are the synthetic example-isolated/example-ephemeral pools.
The policy never asserts label values (only gating shape), so no operator's pool names appear.
"""
import io
import os
import unittest
from contextlib import redirect_stdout

import ci_policy as cp

GATED_HEAVY = """
on:
  pull_request:
  push:
    branches: [main]

jobs:
  changes:
    runs-on: [self-hosted, example-isolated]
    timeout-minutes: 5
    outputs:
      core: ${{ steps.detect.outputs.core }}
    steps:
      - run: echo detect
  heavy:
    needs: [changes]
    if: needs.changes.outputs.core == 'true'
    runs-on: [self-hosted, example-isolated]
    timeout-minutes: 20
    steps:
      - run: echo heavy
  light:
    runs-on: [self-hosted, example-isolated]
    timeout-minutes: 5
    steps:
      - run: echo light
  ci-ok:
    needs: [changes, heavy]
    if: always()
    runs-on: [self-hosted, example-isolated]
    timeout-minutes: 5
    steps:
      - run: echo ok
"""

UNGATED_HEAVY = """
on:
  pull_request:

jobs:
  heavy:
    runs-on: [self-hosted, example-isolated]
    timeout-minutes: 60
    steps:
      - run: echo heavy
"""

WORKFLOW_PATHS = """
on:
  pull_request:
    paths:
      - plugins/**
  push:
    branches: [main]

jobs:
  heavy:
    needs: [changes]
    if: needs.changes.outputs.core == 'true'
    runs-on: [self-hosted, example-isolated]
    timeout-minutes: 20
    steps:
      - run: echo heavy
"""

SCHEDULE_ONLY = """
on:
  schedule:
    - cron: "41 2 * * *"

jobs:
  heavy:
    runs-on: [self-hosted, example-isolated]
    timeout-minutes: 60
    steps:
      - run: echo heavy
"""

NON_REQUIRED = """
# ci-policy: non-required -- self-scoped audit, no required check.
on:
  pull_request:
    paths:
      - .github/workflows/self-audit.yml

jobs:
  audit:
    runs-on: [self-hosted, example-ephemeral]
    timeout-minutes: 15
    steps:
      - run: echo audit
"""


def write(tmp, name, text):
    path = os.path.join(tmp, name)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    return path


class Policy(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.mkdtemp()

    def findings(self, text, **kw):
        path = write(self.tmp, "wf.yml", text)
        return cp.lint_file(path, kw.get("mode", "warning"), kw.get("heavy_after", 10))

    def levels(self, findings):
        return sorted((f.level, f.title) for f in findings)

    def test_gated_standard_passes(self):
        f, _ = self.findings(GATED_HEAVY)
        self.assertEqual([], f)

    def test_ungated_heavy_warns_in_warn_mode(self):
        f, _ = self.findings(UNGATED_HEAVY, mode="warning")
        self.assertEqual([("warning", "Change gating")], self.levels(f))

    def test_ungated_heavy_fails_in_error_mode(self):
        f, _ = self.findings(UNGATED_HEAVY, mode="error")
        self.assertEqual([("error", "Change gating")], self.levels(f))

    def test_missing_timeout_is_heavy(self):
        f, _ = self.findings(UNGATED_HEAVY.replace("    timeout-minutes: 60\n", ""))
        self.assertEqual([("warning", "Change gating")], self.levels(f))

    def test_workflow_paths_flagged(self):
        f, _ = self.findings(WORKFLOW_PATHS)
        self.assertIn(("warning", "Change gating"), self.levels(f))

    def test_failure_drain_lifecycle_guard_not_flagged(self):
        text = UNGATED_HEAVY.replace("    timeout-minutes: 60",
                                     "    timeout-minutes: 10\n    needs: [heavy]\n    if: failure()")
        f, _ = self.findings(text)
        self.assertEqual([], f)

    def test_schedule_only_is_out_of_scope(self):
        f, notes = self.findings(SCHEDULE_ONLY)
        self.assertEqual([], f)
        self.assertTrue(notes)

    def test_non_required_marker_is_out_of_scope(self):
        f, notes = self.findings(NON_REQUIRED)
        self.assertEqual([], f)
        self.assertTrue(notes)

    def test_detector_outputs_not_flagged(self):
        f, _ = self.findings(GATED_HEAVY)
        self.assertFalse(any("changes" in x.message for x in f))


class Main(unittest.TestCase):
    def run_main(self, e, files):
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = cp.main(e, ["ci_policy.py"] + files)
        return rc, buf.getvalue()

    def test_exit_code_follows_errors_only(self):
        import tempfile
        tmp = tempfile.mkdtemp()
        good = write(tmp, "good.yml", GATED_HEAVY)
        bad = write(tmp, "bad.yml", UNGATED_HEAVY)
        self.assertEqual(0, self.run_main({"CI_POLICY_MODE": "warn"}, [good])[0])
        rc, out = self.run_main({"CI_POLICY_MODE": "warn"}, [bad])
        self.assertEqual(0, rc)
        self.assertIn("::warning title=Change gating::", out)
        rc, out = self.run_main({"CI_POLICY_MODE": "error"}, [bad])
        self.assertEqual(1, rc)
        self.assertTrue(out.startswith("::error title=Change gating::"), out)


if __name__ == "__main__":
    unittest.main()
