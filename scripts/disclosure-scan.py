#!/usr/bin/env python3
"""Scan measured public files; incomplete coverage is a refusal, never clean."""
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

TRACKER = re.compile(r"(TOG|PAP)-?[0-9]+|(CAP|LOOA)-[0-9]+", re.IGNORECASE)
CONTENT = re.compile(
    r"(TOG|PAP)-?[0-9]+|(CAP|LOOA)-[0-9]+|infextion\.net|"
    r"\b10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b|"
    r"\b172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}\b|"
    r"\b192\.168\.[0-9]{1,3}\.[0-9]{1,3}\b|"
    r"secure" r"-drop|operator" r"-handoff",
    re.IGNORECASE,
)
# Namespace spans skip only the root rule; CONTENT still judges every line.
# A web URL span (host/owner/paperclip on a dotted, non-numeric host) is always
# a namespace. A bare owner/repo span is one only at a token start and only when
# no slash precedes it on the line: a file path can hold spaces, so any earlier
# slash, in a path or a URL, makes the span ambiguous and the root rule judges it.
NAMESPACE = re.compile(
    r"(?P<url>https?://(?![\d.:]*/)(?=[^/]*\.)[^\s/'\"`<>()\[\]{}$;&|,?#]+"
    r"/(?:repos/)?\w[\w-]*/paperclip(?=/))"
    r"|(?P<owner>(?<![^\s\"'`(\[{])\w[\w-]*/paperclip(?=/\.github/))",
    re.IGNORECASE,
)
ROOT = re.compile(r"/paper" r"clip/", re.IGNORECASE)


def outside_namespaces(text):
    first_slash = text.find("/")

    def blank(match):
        if match.group("url") or first_slash >= match.start():
            return " "
        return match.group(0)

    return NAMESPACE.sub(blank, text)


class Unmeasured(Exception):
    pass


def git(*args, cwd=None):
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True)
    if result.returncode:
        raise Unmeasured(f"Git {args[0]} failed (exit {result.returncode})")
    return result.stdout


def readable(path, directory=False):
    mode = path.lstat().st_mode
    if stat.S_ISLNK(mode):
        raise Unmeasured(f"symlink cannot establish coverage: {path.name}")
    if directory and not stat.S_ISDIR(mode):
        raise Unmeasured(f"not a directory: {path.name}")
    if not directory and not stat.S_ISREG(mode):
        raise Unmeasured(f"not a regular file: {path.name}")
    if not mode & 0o444 or not os.access(path, os.R_OK):
        raise Unmeasured(f"unreadable input: {path.name}")
    if directory and (not mode & 0o111 or not os.access(path, os.X_OK)):
        raise Unmeasured(f"unsearchable directory: {path.name}")


def tracked(roots):
    repo = Path(os.fsdecode(git("rev-parse", "--show-toplevel")).strip())
    files = set()
    for root in roots or [repo]:
        path = Path(root)
        # Resolve the path only after checking the input is not a symlink.
        mode = path.lstat().st_mode
        readable(path, directory=stat.S_ISDIR(mode))
        relative = path.resolve().relative_to(repo.resolve())
        entries = git("ls-files", "-z", "--", str(relative), cwd=repo).split(b"\0")
        found = [repo / os.fsdecode(entry) for entry in entries if entry]
        if not found:
            raise Unmeasured(f"no tracked coverage for root: {root}")
        files.update(found)
    return repo, sorted(files)


def plain(root):
    path = Path(root)
    readable(path, directory=True)
    files = []

    def walk_error(error):
        raise error

    for directory, dirs, names in os.walk(path, onerror=walk_error):
        readable(Path(directory), directory=True)
        for name in dirs:
            readable(Path(directory) / name, directory=True)
        files.extend(Path(directory) / name for name in names)
    if not files:
        raise Unmeasured("no file coverage")
    return path.resolve(), sorted(files)


def main(args):
    try:
        if args and args[0] == "--no-git":
            if len(args) != 2:
                raise Unmeasured("usage: --no-git DIR")
            base, files = plain(args[1])
        else:
            if any(arg.startswith("--") for arg in args):
                raise Unmeasured("unknown option")
            base, files = tracked(args)
        findings = 0
        for path in files:
            readable(path)
            name = path.resolve().relative_to(base).as_posix()
            if TRACKER.search(name):
                print(f"{name}: tracker-shaped filename")
                findings += 1
            # Lockfiles and binary files are not exemptions: their metadata can
            # disclose private registry URLs or embedded tracker references too.
            for line_number, line in enumerate(path.read_bytes().splitlines(), 1):
                text = line.decode("utf-8", errors="replace")
                if CONTENT.search(text) or ROOT.search(outside_namespaces(text)):
                    # Do not echo content: a line can carry unrelated secrets.
                    print(f"{name}:{line_number}: disclosure pattern")
                    findings += 1
        if findings:
            print(f"disclosure scan: FAIL ({findings} findings in {len(files)} files)", file=sys.stderr)
            return 1
        print(f"disclosure scan: clean ({len(files)} files measured)")
        return 0
    except (Unmeasured, OSError, ValueError) as error:
        print(f"disclosure scan: UNMEASURED — {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
