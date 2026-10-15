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

    def test_dot_test_suffix_is_test(self):
        for path in ("src/foo.test.ts", "ci/a11y-build.test.mjs",
                     "src/a.test.mjs"):
            self.assertTrue(CHECK.is_test_path(path), path)

    def test_dot_spec_suffix_is_test(self):
        for path in ("src/foo.spec.js", "src/bar.spec.ts"):
            self.assertTrue(CHECK.is_test_path(path), path)

    def test_bare_test_spec_suffix_is_test(self):
        for path in ("release.test", "app.spec", "src/release.test",
                     "src/app.spec"):
            self.assertTrue(CHECK.is_test_path(path), path)

    def test_uppercase_test_spec_suffix_is_test(self):
        for path in ("src/Foo.TEST.ts", "src/Foo.SPEC.JS", "RELEASE.TEST",
                     "APP.SPEC", "src/a.Test.mjs", "src/b.Spec.ts"):
            self.assertTrue(CHECK.is_test_path(path), path)

    def test_uppercase_bare_suffix_is_test(self):
        for path in ("RELEASE.TEST", "APP.SPEC"):
            self.assertTrue(CHECK.is_test_path(path), path)

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

    def test_dot_test_spec_paths_are_not_src(self):
        for path in ("src/foo.test.ts", "src/foo.spec.js",
                     "ci/a11y-build.test.mjs"):
            self.assertFalse(CHECK.is_src_path(path), path)

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

    def test_src_plus_colocated_dot_test_passes(self):
        findings = CHECK.check_src_without_tests(
            ["src/foo.ts", "src/foo.test.ts"]
        )
        self.assertEqual(findings, [])

    def test_colocated_dot_test_only_passes(self):
        findings = CHECK.check_src_without_tests(["src/foo.test.ts"])
        self.assertEqual(findings, [])

    def test_colocated_dot_spec_only_passes(self):
        findings = CHECK.check_src_without_tests(["src/foo.spec.js"])
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

    def test_valid_shell_and_js_tests_produce_no_findings(self):
        findings = CHECK.check_test_guards(
            {
                "test_deploy.sh": "#!/usr/bin/env bash\nset -euo pipefail\n"
                                  'test "$(echo hi)" = hi\n',
                "tests/a.test.js": "import assert from 'node:assert';\n"
                                   "assert.equal(1 + 1, 2);\n",
            }
        )
        self.assertEqual(findings, [])


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


class EmbeddedGateScriptTest(unittest.TestCase):
    """Behavioural pin for the SHIPPED gate: the embedded python in the
    staged reusable workflow (not blocker_test_checks.py).

    The workflow runs its own inline copy of is_test/is_src, the
    tests-exempt waiver, mode validation and the merge_group skip. Grepping
    the YAML cannot catch a logic regression there, so this matrix extracts
    the `python3 - <<'PY'` body and executes it over
    event x mode x labels x changed-files, asserting exit codes 0/1/2.
    """

    STAGED_GATE = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "templates", "org-github", "test-missing", "test-missing-gate.yml",
    )
    _script = None

    @classmethod
    def _load_script(cls):
        import re
        import textwrap
        if cls._script is None:
            text = open(cls.STAGED_GATE).read()
            match = re.search(
                r"python3 - <<'PY'\n(.*?)\n\s+PY", text, re.DOTALL)
            assert match, "embedded gate python block not found in staged workflow"
            cls._script = textwrap.dedent(match.group(1))
        return cls._script

    def _run_gate(self, event, mode, changed, labels=()):
        import subprocess
        import tempfile
        script = self._load_script()
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "GATE_EVENT": event,
            "GATE_MODE": mode,
            "GATE_CHANGED": "\n".join(changed),
            "GATE_LABELS": ",".join(labels),
        }
        with tempfile.TemporaryDirectory() as tmp:
            proc = subprocess.run(
                [sys.executable, "-"],
                input=script, capture_output=True, text=True,
                env=env, cwd=tmp, timeout=60,
            )
        return proc.returncode

    def test_enforcing_src_only_fails(self):
        self.assertEqual(
            self._run_gate("pull_request", "enforcing", ["src/a.py"]), 1)

    def test_enforce_spelling_also_fails(self):
        self.assertEqual(
            self._run_gate("pull_request", "enforce", ["src/a.py"]), 1)

    def test_warn_never_fails_on_findings(self):
        self.assertEqual(
            self._run_gate("pull_request", "warn", ["src/a.py"]), 0)

    def test_exempt_waives_in_enforcing(self):
        self.assertEqual(
            self._run_gate("pull_request", "enforcing", ["src/a.py"],
                           labels=["tests-exempt"]), 0)

    def test_src_plus_colocated_dot_test_passes(self):
        self.assertEqual(
            self._run_gate("pull_request", "enforcing",
                           ["src/foo.ts", "src/foo.test.ts"]), 0)

    def test_colocated_dot_test_only_passes(self):
        self.assertEqual(
            self._run_gate("pull_request", "enforcing",
                           ["src/foo.test.ts"]), 0)

    def test_merge_group_skips_in_enforcing(self):
        self.assertEqual(
            self._run_gate("merge_group", "enforcing", ["src/a.py"]), 0)

    def test_merge_group_skips_even_when_exempt(self):
        self.assertEqual(
            self._run_gate("merge_group", "enforcing", ["src/a.py"],
                           labels=["tests-exempt"]), 0)

    def test_unknown_mode_exits_2(self):
        self.assertEqual(
            self._run_gate("pull_request", "Enforcing", ["src/a.py"]), 2)

    def test_empty_mode_exits_2(self):
        self.assertEqual(
            self._run_gate("pull_request", "", ["src/a.py"]), 2)

    def test_push_behaves_like_pr(self):
        self.assertEqual(
            self._run_gate("push", "enforcing", ["src/a.py"]), 1)

    def test_docs_only_passes(self):
        self.assertEqual(
            self._run_gate("pull_request", "enforcing", ["README.md"]), 0)

    def test_embedded_dot_spec_colocated_passes(self):
        self.assertEqual(
            self._run_gate("pull_request", "enforcing",
                           ["src/foo.ts", "src/foo.spec.js"]), 0)

    def test_embedded_dot_spec_only_passes(self):
        self.assertEqual(
            self._run_gate("pull_request", "enforcing",
                           ["src/foo.spec.js"]), 0)

    def test_embedded_uppercase_dot_test_passes(self):
        self.assertEqual(
            self._run_gate("pull_request", "enforcing",
                           ["src/a.py", "src/FOO.TEST.TS"]), 0)

    def test_embedded_uppercase_dot_spec_passes(self):
        self.assertEqual(
            self._run_gate("pull_request", "enforcing",
                           ["src/a.py", "src/FOO.SPEC.JS"]), 0)

    def test_embedded_bare_test_suffix_passes(self):
        self.assertEqual(
            self._run_gate("pull_request", "enforcing",
                           ["src/a.py", "release.test"]), 0)

    def test_embedded_bare_spec_suffix_passes(self):
        self.assertEqual(
            self._run_gate("pull_request", "enforcing",
                           ["src/a.py", "app.spec"]), 0)

    def test_embedded_filtered_src_only_still_fails(self):
        # The detect job drops deleted paths (and pure renames) before the
        # script runs: a src edit whose only accompanying test was deleted
        # arrives here as src-only.
        self.assertEqual(
            self._run_gate("pull_request", "enforcing", ["src/a.py"]), 1)

    def test_embedded_filtered_empty_passes(self):
        # A deleted src file or a pure rename arrives here as an empty
        # list once the detect job excludes it: no present src change.
        self.assertEqual(
            self._run_gate("pull_request", "enforcing", []), 0)


class DetectDiffFixtureTest(unittest.TestCase):
    """End-to-end pin for the detect step's git diff: the changed-file list
    is the gate's central input, and grep-only pins let diff mutants through
    (dropping the filter, or widening AM to AMR, passes both suites). This
    fixture builds real git repos, runs the SHIPPED detect run block with
    GATE_PR_BASE set, and feeds the resulting changed.txt to the SHIPPED
    embedded script in enforcing mode.
    """

    STAGED_GATE = EmbeddedGateScriptTest.STAGED_GATE
    _detect_block = None

    @classmethod
    def _load_detect_block(cls):
        import re
        import textwrap
        if cls._detect_block is None:
            text = open(cls.STAGED_GATE).read()
            region = re.search(
                r"(?m)^  detect:\n(.*?)(?=^  \w)",
                text, re.DOTALL)
            assert region, "detect job not found in staged workflow"
            run = re.search(
                r"(?m)^(?P<ind>\s*)run: \|\s*$\n(?P<body>(?:(?P=ind) +\S.*\n?)+)",
                region.group(1))
            assert run, "detect run block not found in staged workflow"
            cls._detect_block = textwrap.dedent(run.group("body"))
        return cls._detect_block

    def _run_scenario(self, base_files, mutate):
        import subprocess
        import tempfile
        block = self._load_detect_block()
        script = EmbeddedGateScriptTest._load_script()
        with tempfile.TemporaryDirectory() as tmp:
            repo = os.path.join(tmp, "repo")
            os.makedirs(repo)
            out = os.path.join(tmp, "github_output.txt")
            open(out, "w").close()

            def git(*args, **kwargs):
                return subprocess.run(
                    ["git", "-c", "user.email=t@t", "-c", "user.name=t",
                     *args], cwd=repo, capture_output=True, text=True,
                    timeout=60, check=True, **kwargs)

            git("init", "-qb", "main")
            for path, content in base_files.items():
                full = os.path.join(repo, path)
                os.makedirs(os.path.dirname(full), exist_ok=True)
                with open(full, "w") as handle:
                    handle.write(content)
            git("add", "-A")
            git("commit", "-qm", "base")
            base_sha = git("rev-parse", "HEAD").stdout.strip()
            mutate(repo)
            git("add", "-A")
            git("commit", "-qm", "head")
            env = {
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "GATE_EVENT": "pull_request",
                "GATE_PR_BASE": base_sha,
                "GATE_MERGE_BASE": "",
                "GATE_MODE": "enforcing",
                "GATE_LABELS": "",
                "GITHUB_OUTPUT": out,
            }
            detect = subprocess.run(
                ["bash", "-c", block], cwd=repo, capture_output=True,
                text=True, env=env, timeout=60)
            assert detect.returncode == 0, detect.stderr[-2000:]
            with open(os.path.join(repo, "changed.txt")) as handle:
                changed = [line.strip() for line in handle if line.strip()]
            gate_env = dict(env, GATE_CHANGED="\n".join(changed))
            gate = subprocess.run(
                [sys.executable, "-"], input=script, capture_output=True,
                text=True, env=gate_env, cwd=tmp, timeout=60)
        return changed, gate.returncode

    @staticmethod
    def _big_src(tag="a", edits=()):
        lines = ["# %s line %d" % (tag, i) for i in range(60)]
        for lineno, text in edits:
            lines[lineno] = text
        return "\n".join(lines) + "\n"

    @staticmethod
    def _rename(repo, old, new):
        os.rename(os.path.join(repo, old), os.path.join(repo, new))

    def test_edit_src_alone_fails(self):
        def mutate(repo):
            with open(os.path.join(repo, "src/a.py"), "a") as handle:
                handle.write("# edited\n")
        changed, rc = self._run_scenario(
            {"src/a.py": self._big_src()}, mutate)
        self.assertEqual(changed, ["src/a.py"])
        self.assertEqual(rc, 1)

    def test_edit_src_plus_delete_test_fails(self):
        def mutate(repo):
            with open(os.path.join(repo, "src/a.py"), "a") as handle:
                handle.write("# edited\n")
            os.remove(os.path.join(repo, "test_a.py"))
        changed, rc = self._run_scenario(
            {"src/a.py": self._big_src(),
             "test_a.py": "def test_it():\n    assert True\n"}, mutate)
        self.assertEqual(changed, ["src/a.py"])
        self.assertEqual(rc, 1)

    def test_delete_src_passes(self):
        def mutate(repo):
            os.remove(os.path.join(repo, "src/a.py"))
        changed, rc = self._run_scenario(
            {"src/a.py": self._big_src()}, mutate)
        self.assertEqual(changed, [])
        self.assertEqual(rc, 0)

    def test_pure_rename_passes(self):
        def mutate(repo):
            self._rename(repo, "src/a.py", "src/b.py")
        changed, rc = self._run_scenario(
            {"src/a.py": self._big_src()}, mutate)
        self.assertEqual(changed, [])
        self.assertEqual(rc, 0)

    def test_rename_and_edit_src_without_tests_fails(self):
        def mutate(repo):
            self._rename(repo, "src/a.py", "src/b.py")
            with open(os.path.join(repo, "src/b.py"), "a") as handle:
                handle.write("# edited line one\n# edited line two\n")
        changed, rc = self._run_scenario(
            {"src/a.py": self._big_src()}, mutate)
        self.assertEqual(changed, ["src/b.py"])
        self.assertEqual(rc, 1)

    def test_edit_src_plus_rename_and_edit_test_passes(self):
        def mutate(repo):
            with open(os.path.join(repo, "src/keep.py"), "a") as handle:
                handle.write("# edited\n")
            self._rename(repo, "test_keep.py", "test_kept.py")
            with open(os.path.join(repo, "test_kept.py"), "a") as handle:
                handle.write("# edited test\nassert True\n")
        changed, rc = self._run_scenario(
            {"src/keep.py": self._big_src(tag="keep"),
             "test_keep.py": self._big_src(tag="test")}, mutate)
        self.assertIn("src/keep.py", changed)
        self.assertTrue(
            any("test_kept.py" in path for path in changed),
            "renamed test must stay in the changed list: %r" % (changed,))
        self.assertEqual(rc, 0)


class WorkflowWiringTest(unittest.TestCase):
    """Pin the workflow env/output wiring the behavioural matrix cannot see.

    The matrix sets GATE_* directly, so a mis-wired YAML value (empty
    GATE_CHANGED, hard-wired warn mode, blank labels/output, wrong base
    SHA, missing fetch-depth) turns enforcing into a silent no-op with
    no failing test. These pins assert the exact wiring lines plus the
    --diff-filter=AMR plus the awk R100 drop that keeps deleted paths and
    pure renames out of the gate while renamed-and-edited files still gate.
    """

    STAGED_GATE = EmbeddedGateScriptTest.STAGED_GATE

    @classmethod
    def _text(cls):
        with open(cls.STAGED_GATE) as handle:
            return handle.read()

    def test_detect_output_wiring(self):
        text = self._text()
        self.assertIn("changed: ${{ steps.diff.outputs.changed }}", text)

    def test_gate_changed_wiring(self):
        text = self._text()
        self.assertIn(
            "GATE_CHANGED: ${{ needs.detect.outputs.changed }}", text)

    def test_gate_labels_wiring(self):
        text = self._text()
        self.assertIn(
            "GATE_LABELS: ${{ join(github.event.pull_request.labels.*.name, ',') }}",
            text)

    def test_gate_mode_wiring_in_check_job(self):
        text = self._text()
        self.assertGreaterEqual(
            text.count("GATE_MODE: ${{ inputs.mode }}"), 2,
            "check and aggregator jobs must both wire GATE_MODE from inputs.mode")

    def test_pr_base_sha_wiring(self):
        text = self._text()
        self.assertIn(
            "GATE_PR_BASE: ${{ github.event.pull_request.base.sha }}", text)

    def test_fetch_depth_zero_in_both_checkouts(self):
        text = self._text()
        self.assertGreaterEqual(
            text.count("fetch-depth: 0"), 2,
            "both checkouts need full history so the base SHA is fetchable")

    def test_diff_excludes_deleted_and_pure_renames(self):
        text = self._text()
        diff_lines = [line for line in text.splitlines()
                      if "git diff " in line]
        self.assertTrue(diff_lines, "no git diff line found")
        for line in diff_lines:
            self.assertIn("--diff-filter=AMR", line,
                          "diff line must keep renames for the R100 drop: %s"
                          % line.strip())
            self.assertIn("'R100'", line.replace('"', "'"),
                          "diff line must drop only pure renames: %s"
                          % line.strip())
        # The old --diff-filter=AM form drops renamed-and-edited files
        # (R<100) from the gate: a silent pass in enforcing mode.
        for line in diff_lines:
            self.assertNotIn("--diff-filter=AM ", line + " ",
                             "bare AM filter drops every rename: %s"
                             % line.strip())


if __name__ == "__main__":
    unittest.main()
