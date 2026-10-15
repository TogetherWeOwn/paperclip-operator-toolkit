#!/usr/bin/env python3
"""Classify repo paths as private-only or public-able.

Owner rule: only private data may live in a private repo; everything else
is public. This classifier is the deterministic form of that rule. The
default verdict is PUBLIC-ABLE: a path stays private only when a concrete
rule below names why. A tracker-shaped filename or a workflow that mixes
generic logic with private runner labels is PUBLIC-AFTER-SCRUB, never a
reason to keep code private.

Verdicts:
  PRIVATE-DATA    secrets, key material, evaluation/internal-note data
  PRIVATE-CONFIG  pin/allowlist sheets and host/deploy configuration
  PUBLIC-AFTER-SCRUB  public code that must lose internal references first
  PUBLIC-ABLE     generic code, docs, tests and synthetic fixtures

Usage:
  git -C PRIVATE_REPO ls-files | repo_placement.py --fail-on-public
  repo_placement.py --fail-on-public < paths.txt

Exit codes: 0 no public paths in the input, 1 public paths remain (or a
plain listing was requested), 2 unmeasured (no input). A listing without
--fail-on-public always exits 0 when input was measured.
"""
from __future__ import annotations

import re
import sys

TRACKER_NAME = re.compile(r"(tog|pap)-?[0-9]+", re.IGNORECASE)

# Host/deploy configuration trees: units, broker and bootstrap code whose
# reviewed form names the hosts it installs on. The generic GARM profile
# validators under github-runner/garm/ are the recorded exception.
PRIVATE_CONFIG_TREES = ("host-ops/", "host-bootstrap/", "deploy/", "systemd/")
PRIVATE_DATA_TREES = ("ops/", "patches/", "upstream-memory/")

SECRET_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".env")
CONFIG_BASENAMES = {"external_disclosure_authorizers.json",
                    "operator_runbook_classification.json"}


def _is_fixture(path: str) -> bool:
    base = path.rsplit("/", 1)[-1]
    return ("/fixtures/" in f"/{path}" or base.startswith("fixture-")
            or path.startswith(("test/fixtures/", "tests/fixtures/")))


def classify(path: str) -> tuple[str, str]:
    """Return (verdict, rule) for one repo-relative path."""
    p = path.strip()
    while p.startswith("./"):
        p = p[2:]
    base = p.rsplit("/", 1)[-1].lower()

    if base in CONFIG_BASENAMES:
        return "PRIVATE-CONFIG", "named-config"
    if base.endswith(SECRET_SUFFIXES) or base == ".env" or base.startswith(".env."):
        return "PRIVATE-DATA", "secret-or-env-material"
    if p.startswith(PRIVATE_DATA_TREES):
        return "PRIVATE-DATA", "internal-notes-tree"
    if "/results/" in f"/{p}" or "/dataset/" in f"/{p}":
        if p.startswith("eval/"):
            return "PRIVATE-DATA", "evaluation-data"
    if p.startswith(PRIVATE_CONFIG_TREES):
        return "PRIVATE-CONFIG", "host-config-tree"
    if p.startswith("github-runner/test_isolated_"):
        return "PUBLIC-ABLE", "garm-offline-test"
    if p.startswith("github-runner/") and not p.startswith("github-runner/garm/"):
        return "PRIVATE-CONFIG", "runner-host-config"
    if not _is_fixture(p):
        if base.endswith(("_pins.txt", "_exempt.txt", "_allowlist.txt",
                          "_pins.json", "-private.json", "_private.json")):
            return "PRIVATE-CONFIG", "pin-or-allowlist-sheet"
    if p.startswith(".github/workflows/"):
        return "PUBLIC-AFTER-SCRUB", "workflow-split"
    if TRACKER_NAME.search(p):
        return "PUBLIC-AFTER-SCRUB", "tracker-shaped-name"
    return "PUBLIC-ABLE", "default-public"


def main(argv=None, stdin_text=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    fail_on_public = "--fail-on-public" in args
    unknown = [a for a in args if a != "--fail-on-public"]
    if unknown:
        print(f"repo placement: unknown argument: {unknown[0]}", file=sys.stderr)
        return 2
    text = sys.stdin.read() if stdin_text is None else stdin_text
    paths = [line.strip() for line in text.splitlines() if line.strip()]
    if not paths:
        print("repo placement: UNMEASURED - no paths", file=sys.stderr)
        return 2
    counts: dict[str, int] = {}
    public_remaining = 0
    for path in paths:
        verdict, rule = classify(path)
        counts[verdict] = counts.get(verdict, 0) + 1
        if verdict.startswith("PUBLIC"):
            public_remaining += 1
        print(f"{path}\t{verdict}\t{rule}")
    summary = ", ".join(f"{k}={counts[k]}" for k in sorted(counts))
    print(f"repo placement: {len(paths)} paths ({summary})", file=sys.stderr)
    if fail_on_public and public_remaining:
        print(f"repo placement: FAIL ({public_remaining} public paths remain)",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
