#!/usr/bin/env python3
"""Placement classifier controls: private needs a concrete rule."""
import subprocess
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from repo_placement import classify, main  # noqa: E402

TRACKER = "TO" + "G" + "-1234"


class Classify(unittest.TestCase):
    def test_generic_code_is_public_able(self):
        for path in ("github-runner/garm/validate_runner_image.py",
                     "github-runner/test_isolated_runner_image.py",
                     "protection-rule/src/decide.js",
                     "scripts/some_tool.py", "quota_brake.sh"):
            self.assertEqual(classify(path)[0], "PUBLIC-ABLE", path)

    def test_secret_and_key_material_is_private_data(self):
        for path in ("config/app.env", ".env", "keys/signing.pem",
                     "host/id_rsa.key", "certs/bundle.p12"):
            self.assertEqual(classify(path)[0], "PRIVATE-DATA", path)

    def test_suffixless_secret_and_credential_files_are_private_data(self):
        for path in ("id_rsa", "keys/id_ed25519", "keys/id_ecdsa",
                     "keys/id_dsa", ".netrc", ".npmrc", ".pypirc",
                     ".git-credentials", ".pgpass", ".htpasswd", "htpasswd",
                     ".my.cnf", "my.cnf",
                     ".docker/config.json",
                     "credentials.json", "config/credentials",
                     "secrets.yaml", "secret.txt", "kubeconfig",
                     "config/kubeconfig", ".kube/config",
                     "clusters/kubeconfig-prod.yaml", "my-kubeconfig",
                     "prod.tfvars", "prod.tfvars.json",
                     "AuthKey_X.p8", "key.ppk", "key.pk8",
                     "backup.gpg",
                     "token.age", "vault.kdbx", "app.jks", "app.keystore"):
            with self.subTest(path=path):
                self.assertEqual(classify(path)[0], "PRIVATE-DATA", path)

    def test_backup_copies_of_secrets_stay_private_data(self):
        for path in ("id_rsa.bak", "id_rsa.old", "id_rsa~",
                     "id_rsa.bak.bak", "credentials.json.bak.old",
                     "keys/id_ed25519.bak",
                     "credentials.json.bak", "credentials.bak",
                     "secrets.yaml.orig", "secret.txt~",
                     ".env.bak", "prod.tfvars.json.bak",
                     "token.age.orig", "AuthKey_X.p8.bak"):
            with self.subTest(path=path):
                self.assertEqual(classify(path)[0], "PRIVATE-DATA", path)

    def test_secret_stem_docs_stay_private_data(self):
        # A full secret/credentials stem is secret material even as docs;
        # only source code is excluded from this rule.
        for path in ("secrets.md", "docs/credentials.md",
                     "secret.rst", "credentials.markdown"):
            with self.subTest(path=path):
                self.assertEqual(classify(path)[0], "PRIVATE-DATA", path)

    def test_backup_copies_of_pin_sheets_stay_private_config(self):
        for path in ("upstream_draft_pins.txt.bak",
                     "external_disclosure_authorizers.json.old",
                     "operator_runbook_classification.json.orig",
                     "credential_chain_pins.txt~"):
            with self.subTest(path=path):
                self.assertEqual(classify(path)[0], "PRIVATE-CONFIG", path)

    def test_config_json_outside_docker_stays_public(self):
        # Only .docker/config.json is credential material; any other
        # config.json (or bare "config") is generic and stays public.
        for path in ("app/config.json", "docker/config.json",
                     "app/config", "docker/config"):
            with self.subTest(path=path):
                self.assertEqual(classify(path)[0], "PUBLIC-ABLE", path)

    def test_public_key_files_are_not_private_data(self):
        self.assertEqual(classify("keys/id_ed25519.pub")[0], "PUBLIC-ABLE")

    def test_secret_named_code_files_are_not_private_data(self):
        # Only a full secret/credentials stem is material; code that merely
        # handles secrets (or an English word starting with "secret") is
        # generic code and stays public-able. The same holds for kubeconfig:
        # a parser, helper or guide is code/docs, not cluster material.
        for path in ("src/secrets_manager.py", "src/credentials_provider.js",
                     "api/secrets.py", "secretary.py", "config/secretary.json",
                     "kubeconfig.py", "src/kubeconfig_loader.py",
                     "test_kubeconfig.py", "scripts/kubeconfig.sh",
                     "kubeconfig_test.go", "docs/kubeconfig-guide.md",
                     "docs/kubeconfig-guide.markdown",
                     "docs/kubeconfig-guide.rst"):
            with self.subTest(path=path):
                self.assertEqual(classify(path)[0], "PUBLIC-ABLE", path)

    def test_pin_and_allowlist_sheets_are_private_config(self):
        for path in ("credential_chain_pins.txt", "quota_brake_exempt.txt",
                     "vendor/toolchain-isolated-private.json",
                     "external_disclosure_authorizers.json"):
            self.assertEqual(classify(path)[0], "PRIVATE-CONFIG", path)

    def test_synthetic_fixtures_are_not_private_config(self):
        path = "tests/fixtures/combo-mapping/combo-allowlist.txt"
        self.assertEqual(classify(path)[0], "PUBLIC-ABLE")

    def test_host_config_stays_private(self):
        for path in ("systemd/paperclip-liveness-reconciler.service",
                     "host-ops/broker.py", "deploy/app/container.unit",
                     "host-bootstrap/install.sh",
                     "github-runner/actions-runner.service.in",
                     "github-runner/install.sh"):
            self.assertEqual(classify(path)[0], "PRIVATE-CONFIG", path)

    def test_internal_notes_and_evaluation_data_stay_private(self):
        for path in ("ops/research/ci-forensics.md",
                     "eval/review-bakeoff/results/run-a/case-1.json",
                     "eval/review-bakeoff/dataset/cases.json",
                     "patches/fix-1.patch", "upstream-memory/notes.md"):
            self.assertEqual(classify(path)[0], "PRIVATE-DATA", path)

    def test_tracker_named_file_needs_scrub_not_privacy(self):
        verdict, _ = classify(f"ops-notes/{TRACKER.lower()}-gate.sh")
        # Tracker-named paths outside private trees are public after scrub.
        self.assertEqual(verdict, "PUBLIC-AFTER-SCRUB")
        verdict, _ = classify(f"verification/{TRACKER.lower()}-gate.sh")
        self.assertEqual(verdict, "PUBLIC-AFTER-SCRUB")

    def test_workflow_logic_needs_scrub_not_privacy(self):
        self.assertEqual(classify(".github/workflows/ci.yml")[0],
                         "PUBLIC-AFTER-SCRUB")


class Cli(unittest.TestCase):
    def run_cli(self, *args, stdin=""):
        return subprocess.run(
            [sys.executable, str(Path(__file__).with_name("repo_placement.py")), *args],
            input=stdin, capture_output=True, text=True)

    def test_guard_mode_fails_when_public_paths_remain(self):
        result = self.run_cli("--fail-on-public", stdin="quota_brake.sh\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("PUBLIC-ABLE", result.stdout)

    def test_guard_mode_passes_when_only_private_paths_remain(self):
        result = self.run_cli("--fail-on-public",
                               stdin="systemd/app.service\nkeys/app.pem\n")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_empty_input_is_unmeasured(self):
        result = self.run_cli("--fail-on-public", stdin="")
        self.assertEqual(result.returncode, 2)

    def test_main_returns_guard_codes(self):
        self.assertEqual(main(["--fail-on-public"], stdin_text="x.sh\n"), 1)
        self.assertEqual(main(["--fail-on-public"], stdin_text="x.env\n"), 0)


if __name__ == "__main__":
    unittest.main()
