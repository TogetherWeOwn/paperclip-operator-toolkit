#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
import os
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
        self.run_base = self.root / "run" / "paperclip-runs"
        self.run_root = self.run_base / "run-a"
        self.run_root.mkdir(parents=True, mode=0o700)
        os.chmod(self.run_root, 0o700)
        self.run_uid = os.geteuid()
        self.run_gid = os.getegid()
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
        for path in self.paths.values():
            path.mkdir(mode=0o700)
            os.chmod(path, 0o700)
        self.write_handoff()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_handoff(self, **overrides: object) -> None:
        payload = {
            "version": 1,
            "runId": "run-a",
            "runUid": self.run_uid,
            "runGid": self.run_gid,
            "runHostUid": self.run_uid,
            "runHostGid": self.run_gid,
            "paths": {label: str(path) for label, path in self.paths.items()},
        } | overrides
        handoff = self.run_root / ".paperclip-run-ownership.json"
        handoff.write_text(json.dumps(payload), encoding="utf-8")
        os.chmod(handoff, 0o600)

    def validate(self, **overrides: Path) -> dict[str, str]:
        paths = self.paths | overrides
        return GUARD.validate_paths(
            run_root=self.run_root,
            run_id="run-a",
            run_uid=self.run_uid,
            run_gid=self.run_gid,
            run_host_uid=self.run_uid,
            run_host_gid=self.run_gid,
            mutable_paths=paths,
            required_run_base=self.run_base,
            live_state_root=self.root / "paperclip",
        )

    def test_accepts_exact_modes_and_bound_paths(self) -> None:
        result = self.validate()
        self.assertEqual(result["workspace"], str(self.paths["workspace"]))
        self.assertEqual(set(result), set(self.paths))

    def test_rejects_parent_traversal_into_deployment(self) -> None:
        deployment = self.root / "app"
        deployment.mkdir()
        with self.assertRaisesRegex(GUARD.PathGuardError, "escapes run root"):
            self.validate(workspace=self.run_root / ".." / ".." / ".." / "app")

    def test_rejects_symlink_into_deployment(self) -> None:
        deployment = self.root / "app"
        deployment.mkdir()
        (self.run_root / "escape").symlink_to(deployment, target_is_directory=True)
        with self.assertRaisesRegex(GUARD.PathGuardError, "symlink component"):
            self.validate(workspace=self.run_root / "escape" / "workspace")

    def test_rejects_symlink_into_another_run(self) -> None:
        other = self.run_base / "run-b"
        other.mkdir(mode=0o700)
        (self.run_root / "other").symlink_to(other, target_is_directory=True)
        with self.assertRaisesRegex(GUARD.PathGuardError, "symlink component"):
            self.validate(storeRoot=self.run_root / "other" / "store")

    def test_rejects_run_root_outside_immutable_base(self) -> None:
        with self.assertRaisesRegex(GUARD.PathGuardError, "immutable run base"):
            GUARD.validate_paths(
                run_root=self.run_root,
                run_id="run-a",
                run_uid=self.run_uid,
                run_gid=self.run_gid,
                run_host_uid=self.run_uid,
                run_host_gid=self.run_gid,
                mutable_paths=self.paths,
                required_run_base=self.root / "elsewhere",
                live_state_root=self.root / "paperclip",
            )

    def test_rejects_run_root_anywhere_under_live_paperclip_state(self) -> None:
        for relative in ("server-cache/run-a", ".npm/run-a", ".local/share/pnpm/run-a"):
            live_root = self.root / "paperclip"
            candidate = live_root / relative
            candidate.mkdir(parents=True, mode=0o700)
            os.chmod(candidate, 0o700)
            with self.subTest(relative=relative), self.assertRaisesRegex(
                GUARD.PathGuardError, "immutable run base"
            ):
                GUARD.validate_paths(
                    run_root=candidate,
                    run_id="run-a",
                    run_uid=self.run_uid,
                    run_gid=self.run_gid,
                    run_host_uid=self.run_uid,
                    run_host_gid=self.run_gid,
                    mutable_paths=self.paths,
                    required_run_base=self.run_base,
                    live_state_root=live_root,
                )

    def test_rejects_duplicate_mutable_paths(self) -> None:
        duplicate_paths = {label: str(path) for label, path in self.paths.items()}
        duplicate_paths["cacheRoot"] = str(self.paths["storeRoot"])
        self.write_handoff(paths=duplicate_paths)
        with self.assertRaisesRegex(GUARD.PathGuardError, "must be distinct"):
            self.validate(cacheRoot=self.paths["storeRoot"])

    def test_rejects_marker_for_another_run(self) -> None:
        marker = self.run_root / ".paperclip-run-scratch.json"
        marker.write_text(json.dumps({"version": 1, "runId": "run-b"}), encoding="utf-8")
        with self.assertRaisesRegex(GUARD.PathGuardError, "expected run id"):
            self.validate()

    def test_rejects_run_root_mode_0500(self) -> None:
        os.chmod(self.run_root, 0o500)
        with self.assertRaisesRegex(GUARD.PathGuardError, "exactly 0700"):
            self.validate()

    def test_rejects_run_root_mode_0750(self) -> None:
        os.chmod(self.run_root, 0o750)
        with self.assertRaisesRegex(GUARD.PathGuardError, "exactly 0700"):
            self.validate()

    def test_rejects_marker_mode_0400(self) -> None:
        os.chmod(self.run_root / ".paperclip-run-scratch.json", 0o400)
        with self.assertRaisesRegex(GUARD.PathGuardError, "exactly 0600"):
            self.validate()

    def test_rejects_marker_mode_0640(self) -> None:
        os.chmod(self.run_root / ".paperclip-run-scratch.json", 0o640)
        with self.assertRaisesRegex(GUARD.PathGuardError, "exactly 0600"):
            self.validate()

    def test_rejects_handoff_mode_0400(self) -> None:
        os.chmod(self.run_root / ".paperclip-run-ownership.json", 0o400)
        with self.assertRaisesRegex(GUARD.PathGuardError, "exactly 0600"):
            self.validate()

    def test_rejects_handoff_mode_0640(self) -> None:
        os.chmod(self.run_root / ".paperclip-run-ownership.json", 0o640)
        with self.assertRaisesRegex(GUARD.PathGuardError, "exactly 0600"):
            self.validate()

    def test_rejects_existing_mutable_path_wrong_mode(self) -> None:
        os.chmod(self.paths["workspace"], 0o500)
        with self.assertRaisesRegex(GUARD.PathGuardError, "exactly 0700"):
            self.validate()

    def test_rejects_handoff_identity_mismatch(self) -> None:
        self.write_handoff(runUid=self.run_uid + 1)
        with self.assertRaisesRegex(GUARD.PathGuardError, "expected run identity"):
            self.validate()

    def test_rejects_handoff_path_mismatch(self) -> None:
        wrong_paths = {label: str(path) for label, path in self.paths.items()}
        wrong_paths["cacheRoot"] = str(self.run_root / "other-cache")
        self.write_handoff(paths=wrong_paths)
        with self.assertRaisesRegex(GUARD.PathGuardError, "handoff path mismatch"):
            self.validate()


if __name__ == "__main__":
    unittest.main()
