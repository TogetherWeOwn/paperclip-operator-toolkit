#!/usr/bin/env python3
"""Acceptance tests for the deterministic lockfile checks.

Covers blocker-ledger class 'lockfile' (class 7): manifest changes that
land without their lockfile (non-reproducible installs) or with an
empty/corrupt lockfile. Staging/advisory first: the Builder wires the
gate in warn mode; the deterministic logic itself is pinned here.

Contract under test (to be implemented by the Builder in
`blocker_lockfile_checks.py`, repo root):

- `MANIFEST_TO_LOCK`: mapping of manifest basename -> tuple of accepted
  lockfile basenames. Must pin at least `package.json`,
  `Cargo.toml`, `pyproject.toml`, `go.mod` and `Gemfile`.
- `is_manifest(path) -> bool`: true when the basename is a known
  manifest.
- `is_lockfile(path) -> bool`: true when the basename is a known
  lockfile (any value in `MANIFEST_TO_LOCK`).
- `check_lockfile_present(changed_files, present_files) -> list[str]`:
  one finding per changed manifest whose accepted lockfile is in
  neither `changed_files` nor `present_files` (basename comparison).
  Findings name the manifest and the expected lockfile name(s).
  Non-manifest changes pass.
- `check_lockfile_parseable(lock_contents) -> list[str]`:
  `lock_contents` maps path -> text. One finding per empty file, per
  `package-lock.json` with neither `"packages"` nor `"dependencies"`,
  per `pnpm-lock.yaml` without `"lockfileVersion"`, and per
  `Cargo.lock` without `"[[package]]"`. Other non-empty lockfiles pass.

Style: stdlib unittest, in-memory fixtures, one behavior per test. No
network, no clock, no filesystem writes. The module under test is loaded
via importlib so a missing module fails every test for the right reason.
"""

import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "blocker_lockfile_checks.py"


def load_module():
    spec = importlib.util.spec_from_file_location(
        "blocker_lockfile_checks", MODULE_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CHECK = load_module()


class ManifestMapTest(unittest.TestCase):
    def test_manifest_map_pins_core_ecosystems(self):
        for manifest in (
            "package.json",
            "Cargo.toml",
            "pyproject.toml",
            "go.mod",
            "Gemfile",
        ):
            self.assertIn(manifest, CHECK.MANIFEST_TO_LOCK)

    def test_is_manifest_and_is_lockfile(self):
        self.assertTrue(CHECK.is_manifest("pkg/package.json"))
        self.assertTrue(CHECK.is_lockfile("package-lock.json"))
        self.assertTrue(CHECK.is_lockfile("sub/dir/Cargo.lock"))
        self.assertFalse(CHECK.is_manifest("src/app.py"))
        self.assertFalse(CHECK.is_lockfile("src/app.py"))


class LockfilePresentTest(unittest.TestCase):
    def test_manifest_with_lock_passes(self):
        findings = CHECK.check_lockfile_present(
            ["package.json", "package-lock.json"], ["README.md"]
        )
        self.assertEqual(findings, [])

    def test_manifest_without_lock_fails(self):
        findings = CHECK.check_lockfile_present(["package.json"], [])
        self.assertEqual(len(findings), 1)
        self.assertIn("package.json", findings[0])
        self.assertIn("package-lock.json", findings[0])

    def test_pnpm_lock_satisfies_npm_manifest(self):
        findings = CHECK.check_lockfile_present(
            ["package.json", "pnpm-lock.yaml"], []
        )
        self.assertEqual(findings, [])

    def test_lock_already_present_in_tree_passes(self):
        findings = CHECK.check_lockfile_present(
            ["Cargo.toml"], ["Cargo.lock", "README.md"]
        )
        self.assertEqual(findings, [])

    def test_cargo_manifest_without_lock_fails(self):
        findings = CHECK.check_lockfile_present(["Cargo.toml"], [])
        self.assertTrue(findings, "missing Cargo.lock must fail")
        self.assertIn("Cargo.toml", findings[0])

    def test_non_manifest_change_passes(self):
        findings = CHECK.check_lockfile_present(["src/app.py"], [])
        self.assertEqual(findings, [])


class LockfileParseableTest(unittest.TestCase):
    def test_empty_lockfile_fails(self):
        findings = CHECK.check_lockfile_parseable({"yarn.lock": ""})
        self.assertTrue(findings, "empty lockfile must fail")
        self.assertIn("yarn.lock", findings[0])

    def test_package_lock_without_packages_or_deps_fails(self):
        findings = CHECK.check_lockfile_parseable(
            {"package-lock.json": '{"name": "x", "version": "1.0.0"}\n'}
        )
        self.assertTrue(findings, "content-free package-lock must fail")

    def test_valid_package_lock_passes(self):
        findings = CHECK.check_lockfile_parseable(
            {
                "package-lock.json": (
                    '{"name": "x", "packages": {"": {"version": "1.0.0"}}}\n'
                )
            }
        )
        self.assertEqual(findings, [])

    def test_pnpm_without_version_fails(self):
        findings = CHECK.check_lockfile_parseable(
            {"pnpm-lock.yaml": "dependencies:\n  foo: 1.0.0\n"}
        )
        self.assertTrue(findings, "version-less pnpm lock must fail")

    def test_pnpm_with_version_passes(self):
        findings = CHECK.check_lockfile_parseable(
            {"pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters: {}\n"}
        )
        self.assertEqual(findings, [])

    def test_cargo_lock_without_package_fails(self):
        findings = CHECK.check_lockfile_parseable(
            {"Cargo.lock": "# empty\nversion = 3\n"}
        )
        self.assertTrue(findings, "package-less Cargo.lock must fail")

    def test_cargo_lock_with_package_passes(self):
        findings = CHECK.check_lockfile_parseable(
            {"Cargo.lock": '[[package]]\nname = "x"\nversion = "1.0.0"\n'}
        )
        self.assertEqual(findings, [])


if __name__ == "__main__":
    unittest.main()
