#!/usr/bin/env python3
"""Offline acceptance suite for landing PR #80 (repo placement + GARM move).

Acceptance side, test files only: the fix for the blockers below lives
outside this file (the landing side must not touch test files). This
file, and the CI step that runs it, are owned here.

Each class pins one landing blocker from the Paperclip Review thread on
PR #80 at head 6289050 (all three open findings plus the failing
Paperclip Review check they hold red):

  SecretStemDocsStayPrivateData  -- finding "Docs exclusion also frees
      secrets/credentials stem files" (repo_placement.py:112). FAILS on
      6289050 (secrets.md et al. come out PUBLIC-ABLE), passes once the
      stem rule excludes code suffixes only.
  PinSheetBackupsStayPrivateConfig -- finding "Backup stripping not
      applied to PRIVATE-CONFIG rules" (repo_placement.py:98). FAILS on
      6289050 (pin-sheet backups come out PUBLIC-ABLE), passes once the
      backup-stripped name feeds the named-config and pin/allowlist checks.
  NarrowingIsPinned -- finding "New classifier rules survive mutation, no
      negative controls" (test_repo_placement.py:43). These pins hold on
      6289050 AND after the fix; they go red under each of the reviewer's
      listed mutants (config.json matched anywhere, bare htpasswd/my.cnf
      dropped, DOC_SUFFIXES shrunk, single-pass backup strip), so the
      narrowing cannot silently widen or loosen later.
  FastTierWiring -- pins that this suite runs in the always-on
      disclosure-scan job (required via ci-ok), so a regression fails the
      build instead of going dark.

Run: python3 scripts/test_repo_placement_acceptance.py (also wired into
the disclosure-scan job in .github/workflows/ci.yml). Offline: no
network, no credential.
"""
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from repo_placement import classify  # noqa: E402

WORKFLOW = Path(__file__).resolve().parents[1] / ".github/workflows/ci.yml"
THIS_FILE = Path(__file__).name


def verdict(path):
    return classify(path)[0]


class SecretStemDocsStayPrivateData(unittest.TestCase):
    """A file whose full stem is secret/secrets/credentials is secret
    material even when it is a doc: credentials.md is a more plausible
    place for pasted credentials than a source file. Only the code-suffix
    exclusion applies here; the docs exclusion belongs to the kubeconfig
    substring rule alone."""

    def test_secret_stem_docs_are_private_data(self):
        for path in ("secrets.md",
                     "docs/credentials.md",
                     "secret.rst",
                     "credentials.markdown"):
            with self.subTest(path=path):
                self.assertEqual(verdict(path), "PRIVATE-DATA", path)

    def test_code_exclusion_still_holds_for_secret_stems(self):
        # secrets.py is the stdlib module name: code is never secret
        # material by name alone. Must stay public on both heads.
        for path in ("src/secrets_manager.py", "api/secrets.py"):
            with self.subTest(path=path):
                self.assertEqual(verdict(path), "PUBLIC-ABLE", path)

    def test_kubeconfig_docs_stay_public(self):
        # The kubeconfig rule keeps the docs exclusion: a parser or guide
        # is generic code, not cluster material. Must stay public.
        for path in ("kubeconfig.py", "docs/kubeconfig-guide.md"):
            with self.subTest(path=path):
                self.assertEqual(verdict(path), "PUBLIC-ABLE", path)


class PinSheetBackupsStayPrivateConfig(unittest.TestCase):
    """A backup copy is the same material as the original: the
    backup-stripped name must feed the named-config check and the
    pin/allowlist-suffix check, not just the secret branches."""

    def test_backup_copies_of_pin_sheets_stay_private_config(self):
        for path in ("upstream_draft_pins.txt.bak",
                     "external_disclosure_authorizers.json.bak",
                     "external_disclosure_authorizers.json.old",
                     "operator_runbook_classification.json.orig"):
            with self.subTest(path=path):
                self.assertEqual(verdict(path), "PRIVATE-CONFIG", path)

    def test_original_pin_sheets_stay_private_config(self):
        for path in ("upstream_draft_pins.txt",
                     "external_disclosure_authorizers.json",
                     "operator_runbook_classification.json"):
            with self.subTest(path=path):
                self.assertEqual(verdict(path), "PRIVATE-CONFIG", path)


class NarrowingIsPinned(unittest.TestCase):
    """Negative controls and edge positives for the narrowed rules, so the
    mutants from the review thread go red instead of surviving green."""

    def test_plain_config_json_is_public_able(self):
        # config.json is private ONLY under a .docker directory; matching
        # it anywhere would sweep every config.json in the repo private.
        for path in ("app/config.json", "docker/config.json"):
            with self.subTest(path=path):
                self.assertEqual(verdict(path), "PUBLIC-ABLE", path)

    def test_docker_config_json_stays_private_data(self):
        self.assertEqual(verdict(".docker/config.json"), "PRIVATE-DATA")

    def test_bare_config_without_privileged_dir_is_public_able(self):
        self.assertEqual(verdict("app/config"), "PUBLIC-ABLE")

    def test_bare_credential_basenames_are_private_data(self):
        # Only the dotted forms were tested before; dropping the bare
        # htpasswd or bare my.cnf entry survived green.
        for path in ("htpasswd", "my.cnf"):
            with self.subTest(path=path):
                self.assertEqual(verdict(path), "PRIVATE-DATA", path)

    def test_double_backup_stripping_is_private_data(self):
        # Single-pass backup stripping survived green; the strip loops.
        self.assertEqual(verdict("id_rsa.bak.bak"), "PRIVATE-DATA")

    def test_kubeconfig_docs_in_all_doc_suffixes_stay_public(self):
        # Shrinking DOC_SUFFIXES to (".md",) survived green; every doc
        # suffix must keep kubeconfig guides public.
        for path in ("kubeconfig-guide.markdown",
                     "docs/kubeconfig-guide.rst"):
            with self.subTest(path=path):
                self.assertEqual(verdict(path), "PUBLIC-ABLE", path)


class FastTierWiring(unittest.TestCase):
    """This suite must run in the always-on disclosure-scan job (required
    via ci-ok): a regression fails the build, it never goes dark."""

    def test_acceptance_suite_runs_in_disclosure_scan(self):
        text = WORKFLOW.read_text()
        match = re.search(r"^  disclosure-scan:\n(.*?)(?=^  \S|\Z)",
                          text, re.M | re.S)
        self.assertIsNotNone(match, "missing job: disclosure-scan")
        self.assertIn(THIS_FILE, match.group(1))


if __name__ == "__main__":
    unittest.main()
