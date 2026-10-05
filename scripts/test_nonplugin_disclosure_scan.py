#!/usr/bin/env python3
"""Hermetic manifest coverage tests; all detector fixtures are synthetic."""
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

WRAPPER = Path(__file__).with_name("nonplugin-disclosure-scan.py").resolve()
SPEC = importlib.util.spec_from_file_location("nonplugin_scan", WRAPPER)
scan = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scan)
TRACKER = "TO" + "G"
OTHER = "PA" + "P"
CAPABILITY = "CA" + "P"


class ManifestCoverage(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="synthetic-coverage-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.env = scan.clean_env(self.root)
        self.manifest = self.root / "manifest.txt"
        self.git("init", "-q")

    def git(self, *args):
        result = subprocess.run(
            ["/usr/bin/git", "-C", str(self.repo), *args], env=self.env,
            capture_output=True, check=True)
        return result.stdout

    def file(self, name="selected.txt", data=b"synthetic plain text\n", tracked=True, mode=0o644):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(mode)
        if tracked:
            self.git("add", "--", name)
        return path

    def select(self, *names):
        self.manifest.write_text("\n".join(names) + "\n", encoding="utf-8")

    def cli(self, *args, wrapper=WRAPPER, env=None):
        index = self.repo / ".git/index"
        before = index.read_bytes() if index.exists() else None
        result = subprocess.run(
            ["/usr/bin/python3", str(wrapper), *map(str, args)], cwd=self.root,
            env=env or self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(index.read_bytes() if index.exists() else None, before)
        return result

    def run_selected(self):
        return self.cli("--repo", self.repo, "--manifest", self.manifest)

    def refuses(self, result, status=2):
        self.assertEqual(result.returncode, status, result.stdout + result.stderr)
        self.assertNotIn("disclosure scan: clean", result.stdout + result.stderr)
        self.assertNotIn("manifest-scoped clean", result.stdout + result.stderr)

    def in_process(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = scan.main(["--repo", str(self.repo), "--manifest", str(self.manifest)])
        return subprocess.CompletedProcess([], code, stdout.getvalue(), stderr.getvalue())

    def test_clean_is_nonempty_measured_and_manifest_scoped(self):
        self.file("policy.txt")
        self.file("scripts/helper.py", b"print('synthetic')\n", mode=0o751)
        self.file("docs/naive-\u00ef.txt", b"binary\x00plain\n")
        self.file("omitted.txt", (TRACKER + "-1234\n").encode())
        self.select("policy.txt", "scripts/helper.py", "docs/naive-\u00ef.txt")
        result = self.run_selected()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("manifest-scoped clean (3 selected files measured)", result.stdout)
        self.assertIn("not whole-repository/history coverage", result.stdout)
        self.assertIn("same-meaning disclosure approval", result.stdout)
        self.assertNotIn("omitted.txt", result.stdout)

    def test_default_repo_is_the_script_owner_not_callers_cwd(self):
        scripts = self.repo / "scripts"
        scripts.mkdir()
        for source in (WRAPPER, scan.SCANNER, scan.SCANNER.with_suffix(".py")):
            shutil.copyfile(source, scripts / source.name)
        self.file("selected.txt")
        self.select("selected.txt")
        result = self.cli("--manifest", self.manifest, wrapper=scripts / WRAPPER.name)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("1 selected files measured", result.stdout)

    def test_root_content_outside_plugins_preserves_every_detector(self):
        samples = [
            TRACKER + "-1234", OTHER + "-77", CAPABILITY + "-061",
            TRACKER.lower() + "2138-decision-v1",
            "ops/" + TRACKER.lower() + "-2138/gate_harness.py",
            "embedded_" + OTHER.lower() + "77_suffix",
            "router.infe" + "xtion.net", "10." + "1.2.3",
            "172." + "17.0.1", "192." + "168.0.9",
            "/paper" + "clip/synthetic/x", "~/secure" + "-drop/key.env",
        ]
        self.select("operator.sh")
        for sample in samples:
            with self.subTest(detector=sample):
                self.file("operator.sh", (sample + "\n").encode())
                result = self.run_selected()
                self.refuses(result, 1)
                self.assertIn("operator.sh:1: disclosure pattern", result.stdout)
                self.assertNotIn(sample, result.stdout)

    def test_filename_lockfile_and_binary_are_not_exempt(self):
        cases = [
            (TRACKER.lower() + "2438-evidence.mjs", b"plain\n", "tracker-shaped filename"),
            ("package-lock.json", ('{"reference":"' + OTHER + '-12"}\n').encode(), "disclosure pattern"),
            ("assets/data.bin", b"\x00" + (TRACKER + "-12").encode(), "disclosure pattern"),
        ]
        for name, data, finding in cases:
            with self.subTest(name=name):
                self.file(name, data)
                self.select(name)
                result = self.run_selected()
                self.refuses(result, 1)
                self.assertIn(name + ":", result.stdout)
                self.assertIn(finding, result.stdout)

    def test_invalid_manifest_lists_refuse_before_git(self):
        invalid = [
            b"", b"\n", b"selected.txt\nselected.txt\n", b"/selected.txt\n",
            b".\n", b"..\n", b"./selected.txt\n", b"../selected.txt\n",
            b"dir/../selected.txt\n", b"dir//file.txt\n", b"dir/\n",
            b" selected.txt\n", b"selected.txt \n", b"\tselected.txt\n",
            b"selected.txt\r\n", b"selected.txt\n\n", b"dir\\file.txt\n",
            b"C:/file.txt\n", b"selected\x00.txt\n", b"\xff\n",
            b"\xef\xbb\xbfselected.txt\n", "cafe\u0301.txt\n".encode(),
            b"a" * (scan.MAX_MANIFEST_BYTES + 1),
            "\n".join(f"file-{i}.txt" for i in range(scan.MAX_FILES + 1)).encode(),
        ]
        for data in invalid:
            with self.subTest(case=invalid.index(data)):
                self.manifest.write_bytes(data)
                with patch.object(scan, "tracked_files", side_effect=AssertionError("Git must not run")):
                    self.refuses(self.in_process())

    def test_missing_or_nonregular_manifest_refuses(self):
        self.refuses(self.run_selected())
        for shape in ("unreadable", "directory", "symlink", "fifo"):
            with self.subTest(shape=shape):
                if self.manifest.exists() or self.manifest.is_symlink():
                    if self.manifest.is_dir():
                        self.manifest.rmdir()
                    else:
                        self.manifest.unlink()
                if shape == "unreadable":
                    self.manifest.write_text("selected.txt\n")
                    self.manifest.chmod(0)
                elif shape == "directory":
                    self.manifest.mkdir()
                elif shape == "symlink":
                    target = self.root / "other-manifest"
                    target.write_text("selected.txt\n")
                    self.manifest.symlink_to(target)
                else:
                    os.mkfifo(self.manifest)
                self.refuses(self.run_selected())

    def test_omitted_manifest_missing_repo_and_nested_repo_refuse(self):
        self.refuses(self.cli("--repo", self.repo))
        self.file()
        self.select("selected.txt")
        for repo in (self.root / "missing", self.root, self.repo / "nested"):
            with self.subTest(repo=repo.name):
                if repo.name == "nested":
                    repo.mkdir()
                self.refuses(self.cli("--repo", repo, "--manifest", self.manifest))

    def test_missing_and_untracked_selected_files_refuse(self):
        path = self.file()
        self.select("selected.txt")
        path.unlink()
        self.refuses(self.run_selected())
        self.file("untracked.txt", tracked=False)
        self.select("untracked.txt")
        self.refuses(self.run_selected())

    def test_symlink_unreadable_and_nonregular_selected_files_refuse(self):
        target = self.root / "external.txt"
        target.write_text("synthetic plain text\n")
        for shape in ("symlink", "unreadable", "directory", "fifo"):
            with self.subTest(shape=shape):
                name = shape + ".txt"
                path = self.file(name)
                self.select(name)
                if shape == "unreadable":
                    path.chmod(0)
                else:
                    path.unlink()
                    if shape == "symlink":
                        path.symlink_to(target)
                    elif shape == "directory":
                        path.mkdir()
                    else:
                        os.mkfifo(path)
                self.refuses(self.run_selected())
        link = self.repo / "indexed-link.txt"
        link.symlink_to(target)
        self.git("add", "--", link.name)
        link.unlink()
        link.write_text("synthetic plain text\n")
        self.select(link.name)
        self.refuses(self.run_selected())

    def test_symlink_and_unsearchable_ancestor_refuse(self):
        self.file("nested/selected.txt")
        self.select("nested/selected.txt")
        directory = self.repo / "nested"
        directory.chmod(0)
        self.refuses(self.run_selected())
        directory.chmod(0o700)
        shutil.rmtree(directory)
        external = self.root / "external"
        external.mkdir()
        (external / "selected.txt").write_text("synthetic plain text\n")
        directory.symlink_to(external, target_is_directory=True)
        self.refuses(self.run_selected())

    def test_failed_empty_malformed_and_unmerged_git_enumeration_refuse(self):
        self.file()
        self.select("selected.txt")
        real_run = subprocess.run
        cases = [
            ("rev-parse", 128, b""), ("ls-files", 128, b""),
            ("ls-files", 0, b""), ("ls-files", 0, b"not-nul-terminated"),
            ("ls-files", 0, b"malformed\0"),
            ("ls-files", 0, ("100644 " + "1" * 40 + " 1\tselected.txt\0").encode()),
            ("ls-files", 0, (("100644 " + "1" * 40 + " 0\tselected.txt\0") * 2).encode()),
        ]
        for operation, status, data in cases:
            with self.subTest(operation=operation, status=status, data=data):
                def fake_run(command, **kwargs):
                    if command[0] == "/bin/bash":
                        self.fail("scanner must not run after Git refusal")
                    if operation in command:
                        return subprocess.CompletedProcess(command, status, data, b"")
                    return real_run(command, **kwargs)
                with patch.object(scan.subprocess, "run", side_effect=fake_run):
                    self.refuses(self.in_process())
        with patch.object(scan.subprocess, "run", side_effect=FileNotFoundError("synthetic missing Git")):
            self.refuses(self.in_process())

    def test_snapshot_preserves_names_bytes_modes_and_ignores_atime_change(self):
        path = self.file("nested/selected.txt", b"synthetic\x00plain\n", mode=0o751)
        info = path.stat()
        os.utime(path, ns=(0, info.st_mtime_ns))
        self.select("nested/selected.txt")
        original = scan.scan_snapshot
        def inspect(tree, count, env):
            self.assertEqual(count, 1)
            self.assertEqual(stat.S_IMODE(tree.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(tree.parent.stat().st_mode), 0o700)
            copied = tree / "nested/selected.txt"
            self.assertEqual(copied.read_bytes(), b"synthetic\x00plain\n")
            self.assertEqual(stat.S_IMODE(copied.stat().st_mode), 0o751)
            path.write_text(TRACKER + "-1234\n")
            return original(tree, count, env)
        with patch.object(scan, "scan_snapshot", side_effect=inspect):
            result = self.in_process()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("manifest-scoped clean", result.stdout)

    def test_file_change_during_snapshot_refuses_before_scanner(self):
        path = self.file(data=b"plain text\n")
        self.select("selected.txt")
        original = scan.regular
        def mutate(fd):
            info = original(fd)
            if info.st_ino == path.stat().st_ino:
                path.write_bytes(b"other text\n")
                os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns - 1))
            return info
        with patch.object(scan, "regular", side_effect=mutate), patch.object(
                scan, "scan_snapshot", side_effect=AssertionError("scanner must not run")):
            result = self.in_process()
        self.refuses(result)
        self.assertIn("changed during snapshot", result.stderr)

    def test_clean_child_environment_ignores_credentials_git_and_shell_injection(self):
        self.file()
        self.select("selected.txt")
        marker = self.root / "must-not-exist"
        poison = self.root / "poison.sh"
        poison.write_text(f"printf injected > '{marker}'\n")
        env = dict(self.env, GH_TOKEN="synthetic-canary-not-a-credential",
                   GITHUB_TOKEN="synthetic-canary-not-a-credential", BASH_ENV=str(poison),
                   GIT_DIR=str(self.root / "missing-git"),
                   GIT_INDEX_FILE=str(self.root / "missing-index"),
                   GIT_CONFIG_COUNT="1", GIT_CONFIG_KEY_0="core.fsmonitor",
                   GIT_CONFIG_VALUE_0=str(poison))
        self.git("config", "core.fsmonitor", str(poison))
        result = self.cli("--repo", self.repo, "--manifest", self.manifest, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(marker.exists())
        real_run = subprocess.run
        calls = []
        def inspect(command, **kwargs):
            calls.append(command)
            child_env = kwargs["env"]
            self.assertEqual(child_env["PATH"], "/usr/bin:/bin")
            self.assertEqual(child_env["GIT_CONFIG_GLOBAL"], "/dev/null")
            for key in ("GH_TOKEN", "GITHUB_TOKEN", "BASH_ENV", "GIT_DIR", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT"):
                self.assertNotIn(key, child_env)
            return real_run(command, **kwargs)
        with patch.dict(os.environ, env), patch.object(scan.subprocess, "run", side_effect=inspect):
            result = self.in_process()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[-1][0], "/bin/bash")
        self.assertIn("--no-git", calls[-1])

    def test_scanner_findings_incomplete_failure_and_false_clean_propagation(self):
        self.file()
        self.select("selected.txt")
        real_run = subprocess.run
        cases = [
            (1, "selected.txt:1: disclosure pattern\n", "findings\n", 1),
            (2, "", "incomplete synthetic measurement\n", 2),
            (17, "", "synthetic runtime failure\n", 2),
            (-9, "", "", 2), (0, "", "", 2),
            (0, "disclosure scan: clean (0 files measured)\n", "", 2),
            (0, "disclosure scan: clean (2 files measured)\n", "", 2),
            (0, "disclosure scan: clean (1 files measured)\n", "unexpected warning\n", 2),
            (1, "disclosure scan: clean (1 files measured)\n", "findings\n", 1),
        ]
        for code, stdout, stderr, expected in cases:
            with self.subTest(code=code, stdout=stdout, stderr=stderr):
                def fake_run(command, **kwargs):
                    if command[0] == "/bin/bash":
                        return subprocess.CompletedProcess(command, code, stdout, stderr)
                    return real_run(command, **kwargs)
                with patch.object(scan.subprocess, "run", side_effect=fake_run):
                    self.refuses(self.in_process(), expected)
        with patch.object(scan, "SCANNER", self.root / "missing-scanner.sh"):
            self.refuses(self.in_process())


if __name__ == "__main__":
    unittest.main(verbosity=2)
