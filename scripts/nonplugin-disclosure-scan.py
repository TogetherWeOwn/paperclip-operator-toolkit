#!/usr/bin/env python3
"""Offline, explicit-manifest coverage for the preserved disclosure scanner.

Each UTF-8 manifest line is one canonical repository-relative file name, not a
comment, glob or exclusion. A final newline is optional; blank lines are errors.
Exit 0 means manifest-scoped measured clean, 1 findings, 2 incomplete measurement.
None of these results grants repository/history coverage or disclosure approval.
"""
import argparse
from contextlib import ExitStack
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tempfile
import unicodedata

SCANNER = Path(__file__).resolve().with_name("disclosure-scan.sh")
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_FILES = 10000
READ_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
DIR_FLAGS = READ_FLAGS | os.O_DIRECTORY


class Unmeasured(Exception):
    pass


def clean_env(home):
    return {
        "PATH": "/usr/bin:/bin", "HOME": str(home), "TMPDIR": str(home),
        "LC_ALL": "C", "PYTHONDONTWRITEBYTECODE": "1",
        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0",
    }


def regular(fd):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or not info.st_mode & 0o444:
        raise Unmeasured("input is not a readable regular file")
    return info


def manifest_files(path):
    with os.fdopen(os.open(path, READ_FLAGS), "rb") as stream:
        regular(stream.fileno())
        raw = stream.read(MAX_MANIFEST_BYTES + 1)
    if len(raw) > MAX_MANIFEST_BYTES:
        raise Unmeasured("manifest exceeds byte limit")
    names = raw.decode("utf-8").split("\n")
    if names[-1] == "":
        names.pop()
    if not names or len(names) > MAX_FILES:
        raise Unmeasured("manifest must select a nonempty bounded file list")
    for name in names:
        path = PurePosixPath(name)
        if (not name or not path.parts or name != name.strip() or "\\" in name or ":" in name
                or any(not char.isprintable() for char in name)
                or unicodedata.normalize("NFC", name) != name
                or path.is_absolute() or path.as_posix() != name
                or any(part in (".", "..") for part in path.parts)):
            raise Unmeasured("manifest contains a noncanonical or ambiguous path")
    if len(set(names)) != len(names):
        raise Unmeasured("manifest contains duplicate paths")
    return names


def tracked_files(repo, env):
    def git(*args):
        result = subprocess.run(
            ["/usr/bin/git", "-c", "credential.helper=", "-c",
             "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
             "-C", str(repo), *args], env=env, capture_output=True)
        if result.returncode:
            raise Unmeasured(f"local Git {args[0]} failed (exit {result.returncode})")
        return result.stdout

    if git("rev-parse", "--show-toplevel").decode("utf-8").removesuffix("\n") != str(repo):
        raise Unmeasured("repo must be the repository root")
    raw = git("ls-files", "--stage", "-z")
    if raw and not raw.endswith(b"\0"):
        raise Unmeasured("malformed Git enumeration")
    entries = {}
    for row in raw.split(b"\0")[:-1]:
        header, separator, name = row.partition(b"\t")
        if not separator or not name or not re.fullmatch(
                rb"[0-7]{6} [0-9a-f]{40}(?:[0-9a-f]{24})? [0-3]", header):
            raise Unmeasured("malformed Git enumeration")
        mode, _, stage = header.split(b" ")
        entries.setdefault(name, []).append((mode, stage))
    return entries


def snapshot_file(repo_fd, tree, name):
    parts = PurePosixPath(name).parts
    with ExitStack() as opened:
        parent = repo_fd
        for part in parts[:-1]:
            parent = os.open(part, DIR_FLAGS, dir_fd=parent)
            opened.callback(os.close, parent)
            if not os.fstat(parent).st_mode & 0o111:
                raise Unmeasured("selected path has an unsearchable directory")
        with os.fdopen(os.open(parts[-1], READ_FLAGS, dir_fd=parent), "rb") as source:
            before = regular(source.fileno())
            target = tree / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as destination:
                remaining = before.st_size
                while remaining:
                    chunk = source.read(min(remaining, 1024 * 1024))
                    if not chunk:
                        raise Unmeasured("selected file changed during snapshot")
                    destination.write(chunk)
                    remaining -= len(chunk)
                after = os.fstat(source.fileno())
                identity = lambda info: (info.st_dev, info.st_ino, info.st_mode,
                                         info.st_size, info.st_mtime_ns, info.st_ctime_ns)
                if source.read(1) or identity(after) != identity(before):
                    raise Unmeasured("selected file changed during snapshot")
                os.fchmod(destination.fileno(), stat.S_IMODE(before.st_mode))


def scan_snapshot(tree, count, env):
    with os.fdopen(os.open(SCANNER, READ_FLAGS), "rb") as stream:
        regular(stream.fileno())
    result = subprocess.run(
        ["/bin/bash", str(SCANNER), "--no-git", str(tree)], env=env,
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode == 0:
        if (result.stdout.strip() != f"disclosure scan: clean ({count} files measured)"
                or result.stderr.strip()):
            raise Unmeasured("scanner did not confirm the complete selected measurement")
        print(f"non-plugin disclosure scan: manifest-scoped clean ({count} selected files measured)")
        print("Scope: selected working-tree snapshot only; not whole-repository/history coverage "
              "or same-meaning disclosure approval.")
        return 0
    # Never forward a contradictory clean marker after a failed measurement.
    for text, output in ((result.stdout, sys.stdout), (result.stderr, sys.stderr)):
        for line in text.splitlines():
            if "disclosure scan: clean" not in line:
                print(line, file=output)
    if result.returncode not in (1, 2):
        raise Unmeasured(f"scanner failed (exit {result.returncode})")
    print("non-plugin disclosure scan: manifest-scoped " +
          ("findings" if result.returncode == 1 else "UNMEASURED"), file=sys.stderr)
    return result.returncode


def main(args=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    options = parser.parse_args(args)
    try:
        names = manifest_files(options.manifest)
        repo = options.repo.resolve(strict=True)
        with tempfile.TemporaryDirectory(prefix="nonplugin-disclosure-") as temporary:
            private = Path(temporary)
            env = clean_env(private)
            entries = tracked_files(repo, env)
            for name in names:
                entry = entries.get(name.encode("utf-8"))
                if entry not in ([(b"100644", b"0")], [(b"100755", b"0")]):
                    raise Unmeasured("selected path is untracked, unmerged or nonregular in Git")
            tree = private / "snapshot"
            tree.mkdir(mode=0o700)
            repo_fd = os.open(repo, DIR_FLAGS)
            try:
                if not os.fstat(repo_fd).st_mode & 0o111:
                    raise Unmeasured("repo is unsearchable")
                for name in names:
                    snapshot_file(repo_fd, tree, name)
            finally:
                os.close(repo_fd)
            return scan_snapshot(tree, len(names), env)
    except (Unmeasured, OSError, UnicodeError, ValueError, subprocess.SubprocessError) as error:
        print(f"non-plugin disclosure scan: UNMEASURED — {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
