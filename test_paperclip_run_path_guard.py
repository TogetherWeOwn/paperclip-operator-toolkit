#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).parent / "scripts" / "paperclip_run_path_guard.py"
SPEC = importlib.util.spec_from_file_location("paperclip_run_path_guard", MODULE_PATH)
assert SPEC and SPEC.loader
GUARD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GUARD)


class RunPathGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="paperclip-path-guard-")
        self.root = Path(self.temp.name)
        self.run_root = self.root / "runs" / "run-a"
        self.run_root.mkdir(parents=True, mode=0o700)
        os.chmod(self.run_root, 0o700)
        marker = self.run_root / ".paperclip-run-scratch.json"
        marker.write_text(json.dumps({"version": 1, "runId": "run-a"}), encoding="utf-8")
        os.chmod(marker, 0o600)
        self.paths = {
            "workspace": self.run_root / "workspace",
            "dependencyRoot": self.run_root / "dependencies",
            "cacheRoot": self.run_root / "cache",
            "storeRoot": self.run_root / "store",
            "tmpRoot": self.run_root / "tmp",
        }

    def tearDown(self) -> None:
        self.temp.cleanup()

    def validate(self, **overrides: Path) -> dict[str, str]:
        paths = self.paths | overrides
        return GUARD.validate_paths(
            run_root=self.run_root,
            run_id="run-a",
            mutable_paths=paths,
            denied_roots=[self.root / "app", self.root / "shared", self.root / "live-data"],
        )

    def test_accepts_distinct_paths_below_run_root(self) -> None:
        result = self.validate()
        self.assertEqual(result["workspace"], str(self.paths["workspace"]))
        self.assertEqual(set(result), set(self.paths))

    def test_rejects_parent_traversal_into_deployment(self) -> None:
        deployment = self.root / "app"
        deployment.mkdir()
        with self.assertRaisesRegex(GUARD.PathGuardError, "escapes run root"):
            self.validate(workspace=self.run_root / ".." / ".." / "app")

    def test_rejects_symlink_into_deployment(self) -> None:
        deployment = self.root / "app"
        deployment.mkdir()
        (self.run_root / "escape").symlink_to(deployment, target_is_directory=True)
        with self.assertRaisesRegex(GUARD.PathGuardError, "symlink component"):
            self.validate(workspace=self.run_root / "escape" / "workspace")

    def test_rejects_symlink_into_another_run(self) -> None:
        other = self.root / "runs" / "run-b"
        other.mkdir(mode=0o700)
        (self.run_root / "other").symlink_to(other, target_is_directory=True)
        with self.assertRaisesRegex(GUARD.PathGuardError, "symlink component"):
            self.validate(storeRoot=self.run_root / "other" / "store")

    def test_rejects_shared_staging_and_live_data(self) -> None:
        for label, target in (
            ("cacheRoot", self.root / "shared" / "cache"),
            ("storeRoot", self.root / "live-data" / "store"),
        ):
            target.parent.mkdir(parents=True, exist_ok=True)
            with self.subTest(label=label), self.assertRaisesRegex(
                GUARD.PathGuardError, "escapes run root"
            ):
                self.validate(**{label: target})

    def test_rejects_duplicate_mutable_paths(self) -> None:
        with self.assertRaisesRegex(GUARD.PathGuardError, "must be distinct"):
            self.validate(cacheRoot=self.paths["storeRoot"])

    def test_rejects_marker_for_another_run(self) -> None:
        marker = self.run_root / ".paperclip-run-scratch.json"
        marker.write_text(json.dumps({"version": 1, "runId": "run-b"}), encoding="utf-8")
        with self.assertRaisesRegex(GUARD.PathGuardError, "expected run id"):
            self.validate()

    def test_rejects_group_access_to_run_root(self) -> None:
        os.chmod(self.run_root, 0o750)
        with self.assertRaisesRegex(GUARD.PathGuardError, "permission bits must be zero"):
            self.validate()

    def test_rejects_existing_mutable_path_with_group_access(self) -> None:
        self.paths["workspace"].mkdir(mode=0o750)
        os.chmod(self.paths["workspace"], 0o750)
        with self.assertRaisesRegex(GUARD.PathGuardError, "permission bits must be zero"):
            self.validate()


if __name__ == "__main__":
    unittest.main()
