#!/usr/bin/env python3
# Hostile offline proofs for the reusable required-check auditor. A synthetic
# workflow/manifest is the subject: no private ruleset, workflow or live setting
# is shipped. Mutants still demand each finding code and exit status. Parser,
# no-measurement and fake-gh controls are retained. This is not a claim about
# this toolkit's live GitHub branch protection.
import atexit
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "ci_required_checks_audit.py")
# Explicit synthetic authority input; never discover installed private policy.
FIXTURE = tempfile.mkdtemp(prefix="required-check-subject-")
atexit.register(shutil.rmtree, FIXTURE, ignore_errors=True)
MANIFEST = os.path.join(FIXTURE, "synthetic-required.json")
WORKFLOWS = os.path.join(FIXTURE, "workflows")
os.mkdir(WORKFLOWS)
SYNTHETIC_CONTEXTS = [
    "Offline suites", "Long mutation gates", "Privilege ceiling suites",
    "dispatch suite", "pr-lint", "unit alpha", "unit beta", "unit gamma",
    "unit delta", "unit epsilon", "unit zeta",
]
with open(MANIFEST, "w", encoding="utf-8") as fh:
    json.dump({"branch": "main", "required": [
        {"context": name, "integration_id": None if name == "Offline suites" else 42}
        for name in SYNTHETIC_CONTEXTS
    ]}, fh)
with open(os.path.join(WORKFLOWS, "ci.yml"), "w", encoding="utf-8") as fh:
    fh.write("on:\n  push:\n    branches: [main]\n  pull_request:\n"
             "    types: [opened, synchronize, reopened, ready_for_review]\n"
             "  merge_group:\njobs:\n")
    for index, name in enumerate(SYNTHETIC_CONTEXTS):
        fh.write(f"  job-{index}:\n    name: {name}\n"
                 "    runs-on: ubuntu-latest\n    steps:\n      - run: true\n")

sys.path.insert(0, HERE)
import ci_required_checks_audit as audit  # noqa: E402


def run_tool(*args, env=None):
    proc = subprocess.run(
        [sys.executable, TOOL, *args], capture_output=True, text=True, env=env, timeout=60
    )
    return proc


def codes(args_json_stdout):
    return {(f["severity"], f["code"], f["context"]) for f in json.loads(args_json_stdout)["findings"]}


def audit_dir(manifest, workflows_dir, *extra):
    """Run the CLI in --json mode; returns (returncode, set of (sev, code, ctx))."""
    proc = run_tool("--manifest", manifest, "--workflows", workflows_dir, "--json", *extra)
    found = codes(proc.stdout) if proc.stdout.strip().startswith("{") else set()
    return proc.returncode, found


class Scratch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="crca-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def write(self, rel, text):
        path = os.path.join(self.tmp, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(textwrap.dedent(text))
        return path

    def manifest(self, contexts, branch="main"):
        return self.write(
            "required_checks.json",
            json.dumps({"branch": branch, "required": [{"context": c, "integration_id": 42} for c in contexts]}),
        )

    def mutated_copy(self, filename, old, new, count=1):
        """Copy the synthetic workflows and replace `old` with `new` in one file."""
        dest = os.path.join(self.tmp, "wf")
        shutil.copytree(WORKFLOWS, dest)
        path = os.path.join(dest, filename)
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn(old, text, f"mutation anchor missing from {filename}: the synthetic subject changed, re-pin this test")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text.replace(old, new, count))
        return dest


# ---------------------------------------------------------------------------
class SyntheticRepoGate(unittest.TestCase):
    """Every required synthetic context has a measured producer."""

    def test_manifest_and_workflows_have_no_fail(self):
        proc = run_tool("--manifest", MANIFEST, "--workflows", WORKFLOWS, "--json")
        self.assertEqual(proc.returncode, 0, proc.stdout[-2000:] + proc.stderr)
        doc = json.loads(proc.stdout)
        self.assertEqual(doc["counts"]["FAIL"], 0)

    def test_every_manifest_context_was_measured_against_a_fixture_job(self):
        # Coverage assertion: zero FAIL is also what "compared nothing" prints.
        with open(MANIFEST, encoding="utf-8") as fh:
            required = json.load(fh)["required"]
        self.assertGreaterEqual(len(required), 11)
        workflows, errors = audit.load_workflows(WORKFLOWS)
        self.assertEqual(errors, {})
        produced = {j.context for wf in workflows for j in wf.jobs}
        missing = [r["context"] for r in required if r["context"] not in produced]
        self.assertEqual(missing, [])

    def test_the_audit_reads_its_own_workflow_directory_completely(self):
        names = {f for f in os.listdir(WORKFLOWS) if f.endswith((".yml", ".yaml"))}
        workflows, errors = audit.load_workflows(WORKFLOWS)
        self.assertEqual({os.path.basename(w.path) for w in workflows} | {os.path.basename(p) for p in errors}, names)


# ---------------------------------------------------------------------------
class MutantsOfTheSyntheticWorkflows(Scratch):
    """2. Each mutation must produce its exact finding. A gate that stays green
    against one of these is asserting nothing."""

    def test_renaming_a_required_job_is_NO_PRODUCER(self):
        wf = self.mutated_copy("ci.yml", "    name: Offline suites\n", "    name: Offline suites (renamed)\n")
        rc, found = audit_dir(MANIFEST, wf)
        self.assertEqual(rc, 1)
        self.assertIn(("FAIL", "NO_PRODUCER", "Offline suites"), found)

    def test_dropping_pull_request_and_merge_group_is_NO_PR_TRIGGER(self):
        # The fixture pins pull_request activity types (ready_for_review); the
        # anchor carries the types line so the mutant drops the whole trigger.
        wf = self.mutated_copy("ci.yml", "  pull_request:\n    types: [opened, synchronize, reopened, ready_for_review]\n  merge_group:\n", "")
        rc, found = audit_dir(MANIFEST, wf)
        self.assertEqual(rc, 1)
        self.assertIn(("FAIL", "NO_PR_TRIGGER", "Offline suites"), found)

    def test_continue_on_error_on_a_required_job_is_JOB_ALWAYS_PASSES(self):
        wf = self.mutated_copy(
            "ci.yml", "    name: Long mutation gates\n", "    name: Long mutation gates\n    continue-on-error: true\n"
        )
        rc, found = audit_dir(MANIFEST, wf)
        self.assertEqual(rc, 1)
        self.assertIn(("FAIL", "JOB_ALWAYS_PASSES", "Long mutation gates"), found)

    def test_a_job_level_if_is_a_WARN_that_strict_turns_into_exit_1(self):
        wf = self.mutated_copy(
            "ci.yml",
            "    name: Privilege ceiling suites\n",
            "    name: Privilege ceiling suites\n    if: github.event_name == 'push'\n",
        )
        rc, found = audit_dir(MANIFEST, wf)
        self.assertEqual(rc, 0)
        self.assertIn(("WARN", "JOB_CAN_SKIP", "Privilege ceiling suites"), found)
        rc_strict, _ = audit_dir(MANIFEST, wf, "--strict")
        self.assertEqual(rc_strict, 1)

    def test_always_and_not_cancelled_ifs_are_not_flagged(self):
        for expr in ("always()", "${{ always() }}", "!cancelled()", "${{ !cancelled() }}"):
            wf = self.mutated_copy(
                "ci.yml", "    name: dispatch suite\n", f"    name: dispatch suite\n    if: {expr}\n"
            )
            _, found = audit_dir(MANIFEST, wf)
            self.assertNotIn(("WARN", "JOB_CAN_SKIP", "dispatch suite"), found, expr)
            shutil.rmtree(wf)

    def test_a_flow_mapping_on_block_is_UNPARSEABLE_not_skipped(self):
        wf = self.mutated_copy("ci.yml", "on:\n  push:\n", "on: {push: {branches: [main]}}\nx:\n  push:\n")
        rc, found = audit_dir(MANIFEST, wf)
        self.assertEqual(rc, 1)
        self.assertIn(("FAIL", "UNPARSEABLE", None), found)

    def test_a_path_filter_on_the_producer_is_a_WARN(self):
        wf = self.mutated_copy("ci.yml", "  pull_request:\n    types: [opened, synchronize, reopened, ready_for_review]\n  merge_group:\n", "  pull_request:\n    types: [opened, synchronize, reopened, ready_for_review]\n    paths: ['docs/**']\n  merge_group:\n")
        rc, found = audit_dir(MANIFEST, wf)
        self.assertEqual(rc, 0)
        self.assertIn(("WARN", "PATH_FILTERED", "Offline suites"), found)

    def test_an_unpinned_manifest_entry_is_ANY_SOURCE(self):
        _, found = audit_dir(MANIFEST, WORKFLOWS)
        self.assertIn(("WARN", "ANY_SOURCE", "Offline suites"), found)
        self.assertNotIn(("WARN", "ANY_SOURCE", "pr-lint"), found)  # pinned to 42 in the manifest


# ---------------------------------------------------------------------------
class ParserShapes(Scratch):
    """The reader's own edge cases, each a shape represented by synthetic workflows."""

    def wf(self, body, on="on:\n  pull_request:\n"):
        return self.write("wf/a.yml", on + "jobs:\n" + textwrap.indent(textwrap.dedent(body), "  "))

    def run_ctx(self, contexts, **kw):
        self.wf(kw.pop("body"), **kw)
        return audit_dir(self.manifest(contexts), os.path.join(self.tmp, "wf"))

    def test_name_defaults_to_the_job_id(self):
        rc, found = self.run_ctx(["unit"], body="unit:\n  runs-on: x\n  steps:\n    - run: true\n")
        self.assertEqual(rc, 0)
        self.assertNotIn(("FAIL", "NO_PRODUCER", "unit"), found)

    def test_an_explicit_name_wins_over_the_id(self):
        rc, found = self.run_ctx(["unit"], body="u:\n  name: unit\n  runs-on: x\n  steps:\n    - run: true\n")
        self.assertEqual(rc, 0, found)
        rc, found = self.run_ctx(["u"], body="u:\n  name: unit\n  runs-on: x\n  steps:\n    - run: true\n")
        self.assertEqual(rc, 1)
        self.assertIn(("FAIL", "NO_PRODUCER", "u"), found)

    def test_block_scalar_if_is_read_and_flagged(self):
        body = "u:\n  name: unit\n  if: >-\n    github.event_name == 'push' &&\n    github.ref == 'refs/heads/main'\n  runs-on: x\n  steps:\n    - run: true\n"
        _, found = self.run_ctx(["unit"], body=body)
        self.assertIn(("WARN", "JOB_CAN_SKIP", "unit"), found)

    def test_block_scalar_if_that_is_always_is_read_as_safe(self):
        body = "u:\n  name: unit\n  if: >-\n    always()\n  runs-on: x\n  steps:\n    - run: true\n"
        _, found = self.run_ctx(["unit"], body=body)
        self.assertNotIn(("WARN", "JOB_CAN_SKIP", "unit"), found)

    def test_text_inside_a_run_block_is_not_read_as_a_step_key(self):
        body = (
            "u:\n  name: unit\n  runs-on: x\n  steps:\n"
            "    - name: build\n      run: |\n        echo 'continue-on-error: true'\n        echo 'name: sneaky'\n"
        )
        _, found = self.run_ctx(["unit"], body=body)
        self.assertFalse([f for f in found if f[1] == "STEP_CONTINUE_ON_ERROR"])

    def test_a_quoted_name_containing_a_hash_survives(self):
        body = "u:\n  name: \"unit # not a comment\"\n  runs-on: x\n  steps:\n    - run: true\n"
        rc, found = self.run_ctx(["unit # not a comment"], body=body)
        self.assertEqual(rc, 0, found)

    def test_a_trailing_comment_on_name_is_dropped(self):
        body = "u:\n  name: unit # why\n  runs-on: x\n  steps:\n    - run: true\n"
        rc, _ = self.run_ctx(["unit"], body=body)
        self.assertEqual(rc, 0)

    def test_push_only_to_main_is_not_visible_on_a_pr(self):
        rc, found = self.run_ctx(
            ["unit"],
            body="unit:\n  runs-on: x\n  steps:\n    - run: true\n",
            on="on:\n  push:\n    branches: [main]\n",
        )
        self.assertEqual(rc, 1)
        self.assertIn(("FAIL", "NO_PR_TRIGGER", "unit"), found)

    def test_unfiltered_push_reaches_a_pr_head(self):
        rc, found = self.run_ctx(["unit"], body="unit:\n  runs-on: x\n  steps:\n    - run: true\n", on="on: push\n")
        self.assertEqual(rc, 0, found)

    def test_scalar_and_flow_list_triggers(self):
        for on in ("on: pull_request\n", "on: [push, pull_request]\n"):
            rc, found = self.run_ctx(["unit"], body="unit:\n  runs-on: x\n  steps:\n    - run: true\n", on=on)
            self.assertEqual(rc, 0, (on, found))

    def test_a_branches_filter_that_excludes_the_target_is_NO_PR_TRIGGER(self):
        rc, found = self.run_ctx(
            ["unit"],
            body="unit:\n  runs-on: x\n  steps:\n    - run: true\n",
            on="on:\n  pull_request:\n    branches: [release/*]\n",
        )
        self.assertEqual(rc, 1)
        self.assertIn(("FAIL", "NO_PR_TRIGGER", "unit"), found)

    def test_label_only_pull_request_types_is_OPT_IN(self):
        rc, found = self.run_ctx(
            ["unit"],
            body="unit:\n  runs-on: x\n  steps:\n    - run: true\n",
            on="on:\n  pull_request:\n    types: [labeled]\n",
        )
        self.assertEqual(rc, 0)
        self.assertIn(("WARN", "OPT_IN_TRIGGER", "unit"), found)

    def test_matrix_job_without_a_name_is_flagged_unresolved_not_exact(self):
        body = "t:\n  runs-on: x\n  strategy:\n    matrix:\n      v: [1, 2]\n  steps:\n    - run: true\n"
        rc, found = self.run_ctx(["t (1)"], body=body)
        self.assertEqual(rc, 0, found)
        self.assertIn(("WARN", "UNRESOLVED_MATRIX", "t (1)"), found)

    def test_reusable_workflow_caller_is_flagged_unresolved(self):
        body = "call:\n  name: sbom\n  uses: ./.github/workflows/s.yml\n"
        rc, found = self.run_ctx(["sbom / image"], body=body)
        self.assertEqual(rc, 0, found)
        self.assertIn(("WARN", "UNRESOLVED_REUSABLE", "sbom / image"), found)

    def test_a_dynamic_name_matches_by_pattern_and_is_flagged(self):
        body = "m:\n  name: migrate (${{ inputs.mode }})\n  runs-on: x\n  steps:\n    - run: true\n"
        rc, found = self.run_ctx(["migrate (dry)"], body=body)
        self.assertEqual(rc, 0, found)
        self.assertIn(("WARN", "UNRESOLVED_DYNAMIC", "migrate (dry)"), found)

    def test_two_producers_of_one_name_are_AMBIGUOUS(self):
        body = "a:\n  name: unit\n  runs-on: x\n  steps:\n    - run: true\nb:\n  name: unit\n  runs-on: x\n  steps:\n    - run: true\n"
        _, found = self.run_ctx(["unit"], body=body)
        self.assertIn(("WARN", "AMBIGUOUS", "unit"), found)

    def test_a_step_with_continue_on_error_is_surfaced(self):
        body = "u:\n  name: unit\n  runs-on: x\n  steps:\n    - name: lint\n      continue-on-error: true\n      run: x\n    - run: y\n"
        _, found = self.run_ctx(["unit"], body=body)
        self.assertIn(("WARN", "STEP_CONTINUE_ON_ERROR", "unit"), found)

    def test_continue_on_error_false_is_not_flagged(self):
        body = "u:\n  name: unit\n  continue-on-error: false\n  runs-on: x\n  steps:\n    - continue-on-error: false\n      run: y\n"
        rc, found = self.run_ctx(["unit"], body=body)
        self.assertEqual(rc, 0)
        self.assertFalse([f for f in found if f[1] in ("JOB_ALWAYS_PASSES", "STEP_CONTINUE_ON_ERROR")])

    def test_an_unrequired_pr_job_is_info_only(self):
        body = "a:\n  name: unit\n  runs-on: x\n  steps:\n    - run: true\nb:\n  name: extra\n  runs-on: x\n  steps:\n    - run: true\n"
        rc, found = self.run_ctx(["unit"], body=body)
        self.assertEqual(rc, 0)
        self.assertIn(("INFO", "NOT_REQUIRED", "extra"), found)

    def test_four_space_indentation_is_read(self):
        self.write(
            "wf/a.yml",
            "on:\n    pull_request:\n        types: [opened]\njobs:\n    u:\n        name: unit\n        runs-on: x\n        steps:\n            - run: true\n",
        )
        rc, found = audit_dir(self.manifest(["unit"]), os.path.join(self.tmp, "wf"))
        self.assertEqual(rc, 0, found)


# ---------------------------------------------------------------------------
class FailClosed(Scratch):
    """3. Nothing measured is never exit 0."""

    def good(self):
        self.write("wf/a.yml", "on: pull_request\njobs:\n  u:\n    name: unit\n    runs-on: x\n    steps:\n      - run: true\n")

    def test_empty_required_list_is_exit_2(self):
        self.good()
        proc = run_tool("--manifest", self.manifest([]), "--workflows", os.path.join(self.tmp, "wf"))
        self.assertEqual(proc.returncode, 2)

    def test_empty_workflow_directory_is_exit_2(self):
        os.makedirs(os.path.join(self.tmp, "wf"))
        proc = run_tool("--manifest", self.manifest(["unit"]), "--workflows", os.path.join(self.tmp, "wf"))
        self.assertEqual(proc.returncode, 2)

    def test_missing_workflow_directory_is_exit_2(self):
        proc = run_tool("--manifest", self.manifest(["unit"]), "--workflows", os.path.join(self.tmp, "nope"))
        self.assertEqual(proc.returncode, 2)

    def test_missing_manifest_is_exit_2(self):
        self.good()
        proc = run_tool("--manifest", os.path.join(self.tmp, "nope.json"), "--workflows", os.path.join(self.tmp, "wf"))
        self.assertEqual(proc.returncode, 2)

    def test_manifest_entry_without_a_context_is_exit_2(self):
        self.good()
        path = self.write("m.json", json.dumps({"required": [{"integration_id": 1}]}))
        proc = run_tool("--manifest", path, "--workflows", os.path.join(self.tmp, "wf"))
        self.assertEqual(proc.returncode, 2)

    def test_workflows_flag_is_required_offline(self):
        proc = run_tool("--manifest", self.manifest(["unit"]))
        self.assertEqual(proc.returncode, 2)

    def test_a_job_without_steps_is_unparseable_not_ignored(self):
        self.write("wf/a.yml", "on: pull_request\njobs:\n  u:\n    name: unit\n    runs-on: x\n")
        rc, found = audit_dir(self.manifest(["unit"]), os.path.join(self.tmp, "wf"))
        self.assertEqual(rc, 1)
        self.assertTrue(any(code == "UNPARSEABLE" for _, code, _ in found))

    def test_a_file_without_jobs_is_unparseable(self):
        self.write("wf/a.yml", "on: pull_request\n")
        self.write("wf/b.yml", "on: pull_request\njobs:\n  u:\n    name: unit\n    runs-on: x\n    steps:\n      - run: true\n")
        rc, found = audit_dir(self.manifest(["unit"]), os.path.join(self.tmp, "wf"))
        self.assertEqual(rc, 1)
        self.assertTrue(any(code == "UNPARSEABLE" for _, code, _ in found))

    def test_rules_json_that_is_not_a_list_is_exit_2(self):
        self.good()
        path = self.write("rules.json", json.dumps({"message": "Not Found"}))
        proc = run_tool("--rules-json", path, "--workflows", os.path.join(self.tmp, "wf"))
        self.assertEqual(proc.returncode, 2)

    def test_rules_without_a_status_check_rule_is_exit_2(self):
        self.good()
        path = self.write("rules.json", json.dumps([{"type": "deletion"}]))
        proc = run_tool("--rules-json", path, "--workflows", os.path.join(self.tmp, "wf"))
        self.assertEqual(proc.returncode, 2)


# ---------------------------------------------------------------------------
class RulesAndLive(Scratch):
    RULES = [
        {"type": "deletion", "ruleset_id": 1, "parameters": None},
        {
            "type": "required_status_checks",
            "ruleset_id": 1,
            "parameters": {"required_status_checks": [{"context": "unit"}, {"context": "gone", "integration_id": 42}]},
        },
        {
            "type": "required_status_checks",
            "ruleset_id": 2,
            "parameters": {"required_status_checks": [{"context": "unit"}]},
        },
    ]

    def good(self):
        self.write("wf/a.yml", "on: pull_request\njobs:\n  u:\n    name: unit\n    runs-on: x\n    steps:\n      - run: true\n")

    def test_rules_json_flattens_two_rulesets_and_catches_the_stale_entry(self):
        self.good()
        path = self.write("rules.json", json.dumps(self.RULES))
        proc = run_tool("--rules-json", path, "--workflows", os.path.join(self.tmp, "wf"), "--json")
        self.assertEqual(proc.returncode, 1)
        doc = json.loads(proc.stdout)
        self.assertEqual([r["context"] for r in doc["required"]], ["unit", "gone"])
        self.assertIn(("FAIL", "NO_PRODUCER", "gone"), codes(proc.stdout))

    def test_only_status_check_rules_contribute_required_checks(self):
        self.good()
        rules = [{"type": "workflows", "parameters": {"required_status_checks": [{"context": "impostor"}]}}, self.RULES[1]]
        path = self.write("rules.json", json.dumps(rules))
        proc = run_tool("--rules-json", path, "--workflows", os.path.join(self.tmp, "wf"), "--json")
        self.assertEqual([r["context"] for r in json.loads(proc.stdout)["required"]], ["unit", "gone"])

    def fake_gh(self, rules):
        """A `gh` stand-in that serves recorded JSON from the scratch dir."""
        with open(os.path.join(self.tmp, "rules.json"), "w", encoding="utf-8") as fh:
            json.dump(rules, fh)
        with open(os.path.join(self.tmp, "listing.json"), "w", encoding="utf-8") as fh:
            json.dump([{"name": "a.yml"}, {"name": "README.md"}], fh)
        script = os.path.join(self.tmp, "gh")
        with open(script, "w", encoding="utf-8") as fh:
            fh.write(
                "#!/usr/bin/env python3\n"
                "import sys\n"
                f"d = {self.tmp!r}\n"
                "a = ' '.join(sys.argv[1:])\n"
                "def out(name):\n"
                "    sys.stdout.write(open(d + '/' + name).read())\n"
                "if a.endswith('contents/.github/workflows'): out('listing.json')\n"
                "elif 'Accept: application/vnd.github.raw' in a: out('wf/a.yml')\n"
                "elif '/rules/branches/' in a: out('rules.json')\n"
                "elif '--jq' in a: print('main')\n"
                "else: sys.exit(9)\n"
            )
        os.chmod(script, os.stat(script).st_mode | stat.S_IEXEC)
        return script

    def test_live_mode_reads_rules_and_workflows_through_gh(self):
        self.good()
        gh = self.fake_gh([self.RULES[1]])
        proc = run_tool("--repo", "o/r", "--gh-bin", gh, "--json")
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn(("FAIL", "NO_PRODUCER", "gone"), codes(proc.stdout))
        self.assertNotIn(("FAIL", "NO_PRODUCER", "unit"), codes(proc.stdout))

    def test_a_failing_gh_is_exit_2_not_a_clean_audit(self):
        gh = os.path.join(self.tmp, "gh")
        with open(gh, "w", encoding="utf-8") as fh:
            fh.write("#!/bin/sh\nexit 1\n")
        os.chmod(gh, 0o755)
        proc = run_tool("--repo", "o/r", "--gh-bin", gh)
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
