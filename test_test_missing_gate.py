#!/usr/bin/env python3
"""Behavioral acceptance tests for the deterministic test-missing gate.

Paired tests for the Land #942 finish work (PR
TogetherWeOwn/paperclip-ops-tooling#942): a changed-src-without-changed-tests
gate, a changed-line coverage gate, and test-guard (vacuity) rules, warn by
default with an enforce mode that fails. The shared logic is public,
stdlib-only code, so the repo-placement gate requires it to live in this
public repo as blocker_test_checks.py. The Builder implements that mirror on
this branch WITHOUT touching test files; these tests fail until the mirror
lands, then pass.

THE RISK THIS EXISTS FOR. The blocker ledger's 'test missing/wrong' class
is decided by model judgment today, so a src-only change can sail through
with no test and a vacuous test file (no assertions, or unparseable) reads
as coverage. The gate's rules, pinned below:

- changed src without changed tests fails, unless the `tests-exempt`
  label waives it; docs-only (or tests-only) changes pass;
- every changed-but-uncovered line fails, naming `file:line`;
- every changed test file that is empty, unparseable, or assertion-free
  fails; warn prints findings and exits 0, enforce exits 1.

RED (before the fix): ModuleNotFoundError -- blocker_test_checks.py is
absent from this repo, i.e. the gate risk reproduced (no deterministic
check decides the class). GREEN (after): all pass.

Stdlib only, offline. Mirrors the upstream contract
(test_blocker_test_checks.py in paperclip-ops-tooling) so the two copies
can be diffed.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import blocker_test_checks as CHECK


class ExemptLabelTest(unittest.TestCase):
    def test_exempt_label_name_is_pinned(self):
        self.assertEqual(CHECK.TEST_EXEMPT_LABEL, "tests-exempt")


class IsTestPathTest(unittest.TestCase):
    def test_test_prefix_basename_is_test(self):
        self.assertTrue(CHECK.is_test_path("test_warn_first_inventory.py"))

    def test_test_suffix_basename_is_test(self):
        self.assertTrue(CHECK.is_test_path("warn_first_inventory_test.py"))

    def test_tests_dir_is_test(self):
        self.assertTrue(CHECK.is_test_path("tests/test_something.py"))

    def test_test_dir_is_test(self):
        self.assertTrue(CHECK.is_test_path("test/test_something.py"))

    def test_dunder_tests_dir_is_test(self):
        self.assertTrue(CHECK.is_test_path("__tests__/suite.mjs"))

    def test_plain_src_is_not_test(self):
        self.assertFalse(CHECK.is_test_path("warn_first_inventory.py"))

    def test_docs_are_not_test(self):
        self.assertFalse(CHECK.is_test_path("docs/runbook.md"))


class IsSrcPathTest(unittest.TestCase):
    def test_py_src_is_src(self):
        self.assertTrue(CHECK.is_src_path("warn_first_inventory.py"))

    def test_sh_src_is_src(self):
        self.assertTrue(CHECK.is_src_path("sibling_guard.sh"))

    def test_js_family_src_is_src(self):
        for path in ("probe.js", "probe.ts", "probe.mjs"):
            self.assertTrue(CHECK.is_src_path(path), path)

    def test_test_path_is_not_src_even_with_src_suffix(self):
        self.assertFalse(CHECK.is_src_path("test_warn_first_inventory.py"))

    def test_docs_are_not_src(self):
        self.assertFalse(CHECK.is_src_path("README.md"))


class SrcWithoutTestsTest(unittest.TestCase):
    def test_src_change_without_test_change_fails_naming_the_file(self):
        findings = CHECK.check_src_without_tests(["warn_first_inventory.py"])
        self.assertTrue(findings, "src-only change must produce a finding")
        self.assertIn("warn_first_inventory.py", findings[0])

    def test_each_changed_src_file_gets_its_own_finding(self):
        findings = CHECK.check_src_without_tests(["a.py", "b.sh"])
        self.assertEqual(len(findings), 2)

    def test_src_change_with_changed_test_passes(self):
        findings = CHECK.check_src_without_tests(
            ["warn_first_inventory.py", "test_warn_first_inventory.py"]
        )
        self.assertEqual(findings, [])

    def test_exempt_label_waives_src_without_tests(self):
        findings = CHECK.check_src_without_tests(
            ["warn_first_inventory.py"], labels=["tests-exempt"]
        )
        self.assertEqual(findings, [])

    def test_docs_only_change_passes_without_tests(self):
        findings = CHECK.check_src_without_tests(["README.md", "docs/runbook.md"])
        self.assertEqual(findings, [])

    def test_tests_only_change_passes_without_src(self):
        findings = CHECK.check_src_without_tests(["test_warn_first_inventory.py"])
        self.assertEqual(findings, [])


class ChangedLineCoverageTest(unittest.TestCase):
    def test_uncovered_changed_lines_fail_naming_file_and_line(self):
        findings = CHECK.check_changed_line_coverage(
            {"warn_first_inventory.py": {10, 11}},
            {"warn_first_inventory.py": {10}},
        )
        self.assertEqual(len(findings), 1)
        self.assertIn("warn_first_inventory.py:11", findings[0])

    def test_fully_covered_changed_lines_pass(self):
        findings = CHECK.check_changed_line_coverage(
            {"warn_first_inventory.py": {10, 11}},
            {"warn_first_inventory.py": {10, 11, 12}},
        )
        self.assertEqual(findings, [])

    def test_no_changed_lines_passes(self):
        self.assertEqual(CHECK.check_changed_line_coverage({}, {}), [])


class TestGuardTest(unittest.TestCase):
    def test_new_test_without_assertions_fails_naming_the_file(self):
        findings = CHECK.check_test_guards(
            {"test_new_thing.py": "def test_it():\n    x = 1\n"}
        )
        self.assertTrue(findings, "assertion-free test must produce a finding")
        self.assertIn("test_new_thing.py", findings[0])

    def test_empty_test_file_fails(self):
        findings = CHECK.check_test_guards({"test_empty.py": "\n"})
        self.assertTrue(findings, "empty test file must produce a finding")
        self.assertIn("test_empty.py", findings[0])

    def test_new_test_with_assertions_passes(self):
        findings = CHECK.check_test_guards(
            {"test_new_thing.py": "def test_it():\n    assert 1 + 1 == 2\n"}
        )
        self.assertEqual(findings, [])

    def test_expect_style_assertion_counts(self):
        findings = CHECK.check_test_guards(
            {"test_new_thing.mjs": "expect(total).toBe(3)\n"}
        )
        self.assertEqual(findings, [])

    def test_unparseable_test_file_fails_naming_the_file(self):
        findings = CHECK.check_test_guards(
            {"test_broken.py": "def test_it(:\n    assert False\n"}
        )
        self.assertTrue(findings, "unparseable test must produce a finding")
        self.assertIn("test_broken.py", findings[0])


class MainModeTest(unittest.TestCase):
    def test_warn_mode_exits_zero_despite_findings(self):
        rc = CHECK.main(["--changed-files", "warn_first_inventory.py",
                         "--mode", "warn"])
        self.assertEqual(rc, 0)

    def test_enforce_mode_exits_nonzero_on_findings(self):
        rc = CHECK.main(["--changed-files", "warn_first_inventory.py",
                         "--mode", "enforce"])
        self.assertNotEqual(rc, 0)

    def test_no_findings_exits_zero_in_both_modes(self):
        for mode in ("warn", "enforce"):
            rc = CHECK.main(["--changed-files", "README.md",
                             "--mode", mode])
            self.assertEqual(rc, 0, mode)

    def test_unreadable_files_list_fails_closed(self):
        rc = CHECK.main(["--changed-files-file", "/nonexistent-dir/missing.txt"])
        self.assertEqual(rc, 2)


if __name__ == "__main__":
    unittest.main()
