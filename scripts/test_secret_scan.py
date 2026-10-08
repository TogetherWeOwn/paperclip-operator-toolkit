#!/usr/bin/env python3
"""Real scanner controls: unrelated canaries must not inherit fixture suppression."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from gitleaks_fixtures import fixture_exceptions

ROOT = Path(__file__).resolve().parents[1]
GITLEAKS = os.environ.get("GITLEAKS", "gitleaks")


class SecretScan(unittest.TestCase):
    def test_exceptions_are_bound_to_exact_immutable_finding(self):
        commit = 'a' * 40
        fingerprint = commit + ':fixture.txt:github-pat:1'
        registry = {'version': 1, 'fingerprintSha256': [hashlib.sha256(fingerprint.encode()).hexdigest()]}
        finding = {'Commit': commit, 'Fingerprint': fingerprint}
        self.assertEqual(fixture_exceptions([finding], registry), [fingerprint])
        for changed in (
            {'Commit': 'b' * 40, 'Fingerprint': 'b' * 40 + ':fixture.txt:github-pat:1'},
            {'Commit': commit, 'Fingerprint': commit + ':fixture.txt:github-pat:2'},
            {'Commit': commit, 'Fingerprint': commit + ':other.txt:github-pat:1'},
        ):
            with self.subTest(changed=changed):
                self.assertEqual(fixture_exceptions([changed], registry), [])
        for invalid in ({'Commit': '', 'Fingerprint': fingerprint},
                        {'Commit': 'b' * 40, 'Fingerprint': fingerprint}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                fixture_exceptions([invalid], registry)
        with self.assertRaises(ValueError):
            fixture_exceptions([], {'version': 1, 'fingerprintSha256': ['not-a-hash']})

    def test_historical_work_supply_storage_identifiers_are_exact_exceptions_only(self):
        # These two generic-api-key matches are the same public ledger record name,
        # not credentials. Source/docs no longer use credential-shaped assignment.
        # Preserve history, and do not let a later commit/path/rule/line inherit this.
        commit = '3593d46d6fd3ba145981538fc8bfed1a931baeb9'
        registry = json.loads((ROOT / 'scripts/gitleaks-history-fixtures.json').read_text())
        for path, line in (('plugins/work-supply/src/plugin.mjs', 8),
                           ('plugins/work-supply/README.md', 38)):
            fingerprint = f'{commit}:{path}:generic-api-key:{line}'
            finding = {'Commit': commit, 'Fingerprint': fingerprint}
            with self.subTest(path=path):
                self.assertEqual(fixture_exceptions([finding], registry), [fingerprint])
                for new_commit, new_path, rule, new_line in (
                    ('b' * 40, path, 'generic-api-key', line),
                    (commit, path + '.other', 'generic-api-key', line),
                    (commit, path, 'github-pat', line),
                    (commit, path, 'generic-api-key', line + 1),
                ):
                    changed = {'Commit': new_commit,
                               'Fingerprint': f'{new_commit}:{new_path}:{rule}:{new_line}'}
                    self.assertEqual(fixture_exceptions([changed], registry), [])

    def test_full_history_script_still_refuses_new_canary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = {**os.environ, 'GITLEAKS': GITLEAKS}
            subprocess.run(['git', '-C', str(root), 'init', '-q'], check=True, capture_output=True)
            canary = 'ghp_' + 'ABCDef012345' * 3
            (root / 'control.txt').write_text(f"token = '{canary}' # sk-live-abc123\n")
            subprocess.run(['git', '-C', str(root), 'add', 'control.txt'], check=True, capture_output=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=Fixture',
                            '-c', 'user.email=fixture@example.invalid', 'commit', '-q',
                            '-m', 'test: synthetic scanner control',
                            '-m', 'Co-Authored-By: Paperclip <noreply@paperclip.ing>'],
                           check=True, capture_output=True)
            result = subprocess.run(['bash', str(ROOT / 'scripts/secret-scan.sh'), str(root)],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn('0 exact exceptions', result.stderr)

    def test_fixture_marker_does_not_suppress_unrelated_canary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            # Deliberately synthetic; build the token-shaped control at runtime.
            canary = "ghp_" + "ABCDef012345" * 3
            for suffix in ("", " # sk-live-abc123", " # gitleaks:allow"):
                with self.subTest(suffix=suffix):
                    (root / "control.txt").write_text(f"token = '{canary}'{suffix}\n")
                    report = root.parent / (root.name + ".json")
                    try:
                        result = subprocess.run([
                            GITLEAKS, "dir", str(root), "--config", str(ROOT / ".gitleaks.toml"),
                            "--ignore-gitleaks-allow", "--redact=100", "--no-banner",
                            "--report-format=json", "--report-path", str(report),
                        ], capture_output=True, text=True)
                        self.assertEqual(result.returncode, 1)
                        findings = json.loads(report.read_text())
                        self.assertTrue(any(f["RuleID"] == "github-pat" for f in findings))
                    finally:
                        report.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
