#!/usr/bin/env python3
"""Deterministic test-missing/wrong checks (TOG-24380).

Covers blocker-ledger class 'test missing/wrong' (ledger subtype
`test_gap`, 24% of Claude blockers): a changed-src-without-changed-tests
gate, a changed-line coverage gate, and test-guard (vacuity) rules.

Rule: deterministic first; AI proposes, code disposes. Staging-first:
callers land in warn (advisory) mode; enforce only after the FP rate is
measured. No network, no clock, stdlib only.
"""

from __future__ import annotations

import argparse
import ast
import os
import sys
from pathlib import PurePosixPath

TEST_EXEMPT_LABEL = "tests-exempt"

SRC_SUFFIXES = (".py", ".sh", ".js", ".ts", ".mjs")
TEST_DIR_NAMES = ("test", "tests", "__tests__")


def is_test_path(path: str) -> bool:
    """Basename `test_*` / `*_test.*`, or under a test(s)/__tests__ dir."""
    posix = PurePosixPath(path.replace(os.sep, "/"))
    name = posix.name
    stem = name.rsplit(".", 1)[0] if "." in name else name
    if name.startswith("test_") or stem.endswith("_test"):
        return True
    return any(part in TEST_DIR_NAMES for part in posix.parts[:-1])


def is_src_path(path: str) -> bool:
    """Code suffix that is not a test path."""
    if is_test_path(path):
        return False
    lower = path.lower()
    return lower.endswith(SRC_SUFFIXES)


def check_src_without_tests(changed_files, labels=()) -> list:
    """One finding per changed src file when no changed test file exists.

    Waived by the exempt label. Docs-only (or tests-only) changes pass.
    """
    if TEST_EXEMPT_LABEL in (labels or ()):
        return []
    files = list(changed_files or ())
    src = [f for f in files if is_src_path(f)]
    if not src:
        return []
    if any(is_test_path(f) for f in files):
        return []
    return [f"src change without tests: {f}" for f in src]


def check_changed_line_coverage(changed_lines, covered_lines) -> list:
    """One finding per changed-but-uncovered line, naming `file:line`."""
    findings = []
    for path in sorted((changed_lines or {}).keys()):
        changed = set((changed_lines or {}).get(path) or set())
        covered = set((covered_lines or {}).get(path) or set())
        for line in sorted(changed - covered):
            findings.append(f"{path}:{line}: changed line not covered by tests")
    return findings


_ASSERT_CALL_PREFIXES = ("assert", "expect", "should", "verify", "check")


def _has_assertion(tree: ast.AST) -> bool:
    for node in ast.walk(tree):
        if isinstance(node, ast.Assert):
            return True
        if isinstance(node, ast.Call):
            func = node.func
            name = ""
            if isinstance(func, ast.Name):
                name = func.id
            elif isinstance(func, ast.Attribute):
                name = func.attr
            if name.lower().startswith(_ASSERT_CALL_PREFIXES):
                return True
    return False


def check_test_guards(test_contents) -> list:
    """One finding per changed test file that is empty, unparseable, or
    contains zero assertions (vacuous-test guard)."""
    findings = []
    for path in sorted((test_contents or {}).keys()):
        content = (test_contents or {}).get(path) or ""
        if not content.strip():
            findings.append(f"{path}: empty test file (no test content)")
            continue
        try:
            tree = ast.parse(content)
        except SyntaxError as exc:
            findings.append(f"{path}: unparseable test file ({exc.msg})")
            continue
        if not _has_assertion(tree):
            findings.append(f"{path}: no assertions (vacuous test)")
    return findings


def _parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Deterministic test-missing/wrong gate (warn by default)."
    )
    parser.add_argument("--changed-files", default="",
                        help="Newline- or comma-separated changed paths.")
    parser.add_argument("--changed-files-file", default="",
                        help="File with one changed path per line.")
    parser.add_argument("--labels", default="",
                        help="Comma-separated PR labels.")
    parser.add_argument("--mode", default="warn", choices=("warn", "enforce"),
                        help="warn prints findings and exits 0; "
                             "enforce exits 1 on findings.")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = _parse_args(argv)
    files: list = []
    if args.changed_files_file:
        try:
            with open(args.changed_files_file) as handle:
                files.extend(line.strip() for line in handle if line.strip())
        except OSError as exc:
            print(f"test-missing gate: cannot read files list: {exc}",
                  file=sys.stderr)
            return 2
    if args.changed_files:
        raw = args.changed_files.replace(",", "\n")
        files.extend(line.strip() for line in raw.splitlines() if line.strip())
    labels = [part.strip() for part in (args.labels or "").replace(",", "\n").splitlines()
              if part.strip()]
    findings = check_src_without_tests(files, labels)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if findings:
        print("test-missing gate findings:")
        for finding in findings:
            print(f"- {finding}")
        if summary:
            try:
                with open(summary, "a") as handle:
                    handle.write("## test-missing gate\n")
                    for finding in findings:
                        handle.write(f"- {finding}\n")
            except OSError:
                pass
        return 1 if args.mode == "enforce" else 0
    print("test-missing gate: no findings")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
