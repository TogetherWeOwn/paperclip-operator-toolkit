#!/usr/bin/env python3
"""Pin the merged plugin sweep to change gating and the single aggregator."""
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest

WORKFLOW = Path(__file__).resolve().parents[1] / ".github/workflows/ci.yml"


def job(text, name):
    match = re.search(rf"^  {re.escape(name)}:\n(.*?)(?=^  \S|\Z)", text, re.M | re.S)
    if not match:
        raise AssertionError(f"missing job: {name}")
    return match.group(1)


class PluginWiring(unittest.TestCase):
    def setUp(self):
        self.text = WORKFLOW.read_text()

    def test_changed_heavy_jobs_are_gated(self):
        for name in ("model-selection-impact", "cliproxy-insight-suite", "ported-suites", "ported-mutation-gates"):
            with self.subTest(job=name):
                block = job(self.text, name)
                self.assertIn("needs: [changes]", block)
                self.assertIn("if: needs.changes.outputs.heavy == 'true'", block)
                self.assertIn("runs-on: ubuntu-latest", block)

    def test_scans_are_always_on(self):
        # Neither scan may sit behind the change gate: docs-only changes and
        # draft PRs must still be scanned. Not a prefix match: any `needs:` or
        # `if:` key at job level, in any spelling, is a re-gate.
        for name in ("secret-scan", "disclosure-scan"):
            with self.subTest(job=name):
                block = job(self.text, name)
                header = block.split("    steps:\n", 1)[0]
                self.assertNotRegex(header, r"(?m)^    needs:")
                self.assertNotRegex(header, r"(?m)^    if:")
                self.assertNotIn("outputs.heavy", block)
                self.assertIn("runs-on: ubuntu-latest", block)

    def test_nonplugin_disclosure_coverage_is_always_measured(self):
        block = job(self.text, "disclosure-scan")
        self.assertIn('run: python3 scripts/test_nonplugin_disclosure_scan.py', block)
        self.assertIn('run: python3 scripts/nonplugin-disclosure-scan.py --manifest scripts/nonplugin-disclosure-files.txt', block)
        self.assertIn('run: bash scripts/disclosure-scan.sh plugins', block)
        self.assertLess(block.index('test_nonplugin_disclosure_scan.py'),
                        block.index('nonplugin-disclosure-scan.py --manifest'))
        manifest = WORKFLOW.parents[2] / 'scripts/nonplugin-disclosure-files.txt'
        names = manifest.read_text().splitlines()
        self.assertTrue(names)
        self.assertEqual(names, sorted(set(names)))
        selected = set(names)
        for name in ('scripts/nonplugin-disclosure-scan.py',
                     'scripts/test_nonplugin_disclosure_scan.py',
                     'scripts/nonplugin-disclosure-files.txt',
                     'docs/nonplugin-disclosure-scan.md',
                     'ci_required_checks_audit.py', 'test_ci_required_checks_audit.py',
                     'runner_disk_pressure.sh', 'test_provisioned_transport_db.py',
                     'test_transport_db_guards.py', 'docs/transport-database-proof.md',
                     'red_main_poll.sh', 'red_main_poll.py', 'test_red_main_poll.py'):
            self.assertIn(name, selected)
        root = WORKFLOW.parents[2]
        for component in ('protection-rule', 'gh-event-capture'):
            paths = {path.relative_to(root).as_posix()
                     for path in (root / component).rglob('*')
                     if path.is_file() and '__pycache__' not in path.parts
                     and not path.name.endswith('.pyc')
                     and not any(part.startswith('.offline-tests-') for part in path.parts)}
            self.assertTrue(paths, component)
            self.assertFalse(paths - selected, sorted(paths - selected))

    def test_secret_scan_keeps_pinned_scanner_controls_and_full_history(self):
        block = job(self.text, "secret-scan")
        self.assertIn("fetch-depth: 0", block)
        self.assertRegex(block, r"GITLEAKS_SHA256: '[0-9a-f]{64}'")
        self.assertIn("sha256sum -c -", block)
        self.assertIn("python3 scripts/test_secret_scan.py", block)
        self.assertIn("bash scripts/secret-scan.sh", block)
        # Controls run before the real scan so a broken scanner cannot read clean.
        self.assertLess(block.index("test_secret_scan.py"), block.index("bash scripts/secret-scan.sh"))

    def run_ci_ok(self, results):
        """Render the aggregator's expressions from fixture job results and run it."""
        block = job(self.text, "ci-ok")
        script = textwrap.dedent(block.split("        run: |\n", 1)[1])
        script = re.sub(r"\$\{\{ needs\.([a-z-]+)\.result \}\}", lambda m: results[m.group(1)], script)
        for state in ("failure", "cancelled"):
            flag = "true" if state in results.values() else "false"
            script = script.replace("${{ contains(needs.*.result, '%s') }}" % state, flag)
        self.assertNotIn("${{", script)
        return subprocess.run(["/bin/bash", "-c", script], env={"PATH": "/usr/bin:/bin"},
                              capture_output=True, text=True)

    def test_ci_ok_refuses_a_skipped_or_failed_scan(self):
        everything = ("changes", "privilege-suites", "offline-suites", "long-mutation-gates",
                      "runbook-gates", "broker-suite", "omniroute-broker-suite", "dispatch-suite",
                      "mcp-suite", "ported-suites", "ported-mutation-gates",
                      "cliproxy-insight-suite", "disclosure-scan", "secret-scan",
                      "model-selection-impact", "model-selection-mutants", "model-selection-suite")
        gated = {n: "skipped" for n in everything}
        gated.update({"changes": "success", "disclosure-scan": "success", "secret-scan": "success"})
        self.assertEqual(self.run_ci_ok(gated).returncode, 0, "docs/draft skip with both scans green must pass")
        for scan in ("secret-scan", "disclosure-scan"):
            for bad in ("skipped", "failure", "cancelled"):
                with self.subTest(scan=scan, result=bad):
                    results = dict(gated, **{scan: bad})
                    result = self.run_ci_ok(results)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(scan, result.stdout + result.stderr)

    def test_ported_jobs_are_needed_by_aggregation_and_failure_drain(self):
        for consumer in ("ci-ok", "failure-log-drain"):
            for name in ("ported-suites", "ported-mutation-gates"):
                with self.subTest(consumer=consumer, job=name):
                    self.assertIn(f"      - {name}\n", job(self.text, consumer))
        success = {"changes": "success", "disclosure-scan": "success",
                   "secret-scan": "success"}
        for name in ("ported-suites", "ported-mutation-gates"):
            for state in ("failure", "cancelled"):
                with self.subTest(job=name, result=state):
                    self.assertNotEqual(
                        self.run_ci_ok(dict(success, **{name: state})).returncode, 0)

    def test_upgrade_proof_supplies_schema_and_disposable_database(self):
        block = job(self.text, "ported-suites")
        # No service containers: the runner-label gate forbids them, so the
        # disposable database is an ephemeral initdb cluster (same throwaway
        # pattern as privilege-suites), not a postgres image.
        self.assertNotIn("services:", block)
        self.assertIn("-U agent_test --auth-host=trust --auth-local=trust", block)
        self.assertIn("pg_ctl", block)
        self.assertIn("transport-pgdata", block)
        self.assertIn("repository: TogetherWeOwn/paperclip", block)
        self.assertRegex(block, r"ref: [0-9a-f]{40}\n")
        self.assertIn("persist-credentials: false", block)
        self.assertIn("PAPERCLIP_UPGRADE_MIGRATIONS_DIR: public-schema/packages/db/src/migrations", block)
        self.assertIn("PGHOST: localhost", block)
        self.assertIn("PGUSER: agent_test", block)
        self.assertIn("python-version: '3.12'", block)
        self.assertIn("pip install --isolated psycopg2-binary==2.9.10", block)
        self.assertNotIn("DATABASE_URL:", block)
        self.assertNotIn("PGPASSWORD:", block)

    def test_transport_database_proof_has_disposable_native_client_prerequisites(self):
        block = job(self.text, "ported-suites")
        self.assertIn("name: transport database proof", block)
        proof = block.split("name: transport database proof", 1)[1].split("      - ", 1)[0]
        clean = 'env -i PATH="$PATH" PGHOST=localhost PGPORT=5432 PGUSER=agent_test PGPASSWORD= PGDATABASE=toolkit_transport_fixture '
        self.assertIn(clean + 'createdb --no-password toolkit_transport_fixture', proof)
        self.assertIn(clean + 'python3 test_provisioned_transport_db.py --init', proof)
        self.assertIn(clean + 'python3 -m unittest -v test_provisioned_transport_db', proof)
        self.assertLess(proof.index('createdb --no-password'), proof.index('test_provisioned_transport_db.py --init'))
        self.assertLess(proof.index('test_provisioned_transport_db.py --init'), proof.index('-m unittest -v test_provisioned_transport_db'))
        self.assertEqual(block.count('python3 -m unittest -v test_provisioned_transport_db'), 1)
        self.assertLess(block.index('Start an ephemeral PostgreSQL cluster'),
                        block.index('name: transport database proof'))

    def test_protection_rule_suite_has_offline_guard_and_clean_environment(self):
        block = job(self.text, "ported-suites")
        self.assertIn("node-version: '24'", block)
        self.assertIn('env -i PATH="$PATH" node --import ./protection-rule/test/offline-guard.mjs', block)
        self.assertIn('--test protection-rule/test/*.test.mjs', block)
        self.assertIn('node --check "$source"', block)
        self.assertNotIn('npm install', block)

    def test_capture_suite_uses_supported_node_and_hermetic_entrypoints(self):
        block = job(self.text, "ported-suites")
        self.assertIn("node-version: '24'", block)
        self.assertIn('env -i PATH="$PATH" node gh-event-capture/scripts/check-source.mjs', block)
        self.assertIn('env -i PATH="$PATH" node gh-event-capture/scripts/run-offline-tests.mjs', block)
        self.assertNotIn('--test-name-pattern', block)

    def test_private_deployment_gates_are_not_ported_ci(self):
        block = job(self.text, "ported-mutation-gates")
        self.assertIn("verification/platform-watchdog-gate.sh", block)
        self.assertIn("verification/process-lost-mutation-gate.py", block)
        for private in ("recovery-writer-mutation-gate.sh",
                        "filing-strip-mutation-gate.sh",
                        "upstream-bundle-filing-strip-gate.sh"):
            self.assertNotIn(private, block)

    def test_plugin_aggregator_runs_after_failed_impacted_sweep(self):
        block = job(self.text, "model-selection-suite")
        self.assertIn("needs: [changes, model-selection-impact, model-selection-mutants]", block)
        self.assertIn("if: ${{ !cancelled() && needs.changes.outputs.heavy == 'true' }}", block)
        self.assertIn("success/true/success) ;;", block)
        self.assertIn("success/false/skipped) ;;", block)
        self.assertIn("exit 1", block)

    def test_single_aggregator_covers_all_plugin_checks_and_scans(self):
        block = job(self.text, "ci-ok")
        self.assertIn("if: ${{ !cancelled() }}", block)
        self.assertIn("needs.changes.result }}' != 'success'", block)
        self.assertIn("contains(needs.*.result, 'failure')", block)
        self.assertIn("contains(needs.*.result, 'cancelled')", block)
        for name in ("changes", "cliproxy-insight-suite", "disclosure-scan", "secret-scan",
                     "model-selection-impact", "model-selection-mutants", "model-selection-suite"):
            with self.subTest(job=name):
                self.assertIn(f"      - {name}\n", block)

    def test_draft_ci_and_dependency_changes_admit_full_suites(self):
        block = job(self.text, "changes")
        script = textwrap.dedent(block.split("        run: |\n", 1)[1])
        cases = [
            (".github/workflows/ci.yml", "true", "true"),
            ("plugins/model-selection/package-lock.json", "true", "true"),
            ("plugins/dispatch/package.json", "true", "true"),
            (".gitleaks.toml", "true", "true"),
            ("docs/unreferenced.md", "true", "false"),
            ("docs/unreferenced.md", "false", "false"),
            ("plugins/model-selection/src/worker.ts", "false", "true"),
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / "git"
            executable.write_text('''#!/bin/bash
case "$1" in
  merge-base) printf '%s\\n' fixture-base ;;
  diff) printf '%s\\n' "$FILES" ;;
  grep) exit 1 ;;
  *) exit 2 ;;
esac
''')
            executable.chmod(0o755)
            for files, draft, expected in cases:
                with self.subTest(files=files, draft=draft):
                    output = root / "output"
                    output.write_text("")
                    # No inherited credentials or shell startup hooks.
                    env = {"PATH": f"{root}:/usr/bin:/bin", "EVENT": "pull_request",
                           "DRAFT": draft, "BASE_SHA": "base", "HEAD_SHA": "head",
                           "FILES": files, "GITHUB_OUTPUT": str(output)}
                    result = subprocess.run(["/bin/bash", "-c", script], env=env, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(output.read_text().strip(), "heavy=" + expected)

    def test_preflight_baseline_failure_is_reported_not_swallowed(self):
        # The default step shell is `bash -e`: a bare baseline call exits with the
        # suite's status before the diagnostic prints, which is how a red step
        # once carried no output at all.
        block = job(self.text, "long-mutation-gates")
        self.assertIn('preflight_suite "$baseline" || base_rc=$?', block)
        self.assertIn("the UNMUTATED preflight copy fails", block)

    def test_explicit_manual_full_run_is_declared(self):
        trigger = self.text.split("on:\n", 1)[1].split("\npermissions:", 1)[0]
        self.assertTrue("  workflow_dispatch:" in trigger, "explicit manual full-run trigger is missing")

    def test_matrix_and_full_event_paths_survive_merge(self):
        block = job(self.text, "model-selection-mutants")
        self.assertIn("needs: model-selection-impact", block)
        self.assertIn("needs.model-selection-impact.outputs.impacted == 'true'", block)
        self.assertIn("shard: [1, 2, 3, 4, 5, 6, 7, 8]", block)
        self.assertIn("fail-fast: false", block)
        self.assertIn("run: npm run test:mutants", block)
        self.assertIn('if [ "$EVENT" != "pull_request" ]; then', job(self.text, "changes"))
        self.assertNotIn("<<<<<<<", self.text)
        self.assertNotIn(">>>>>>>", self.text)


if __name__ == "__main__":
    unittest.main()
