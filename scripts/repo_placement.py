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

SECRET_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".env", ".tfvars",
                   ".gpg", ".age", ".kdbx", ".jks", ".keystore",
                   ".p8", ".ppk", ".pk8")
# Suffix-less secret material: bare SSH private keys (their ".pub" halves
# are public), credential dotfiles and kubeconfig. A basename whose full
# stem is "credentials"/"secret"/"secrets" is secret material; code that
# merely handles secrets (secrets_manager.py) or an English word that
# starts with "secret" (secretary.py) is not.
SECRET_BASENAMES = {"id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
                    "id_ecdsa_sk", "id_ed25519_sk",
                    ".netrc", ".npmrc", ".pypirc", "kubeconfig",
                    ".kubeconfig", ".git-credentials", ".pgpass",
                    ".htpasswd", "htpasswd", ".my.cnf", "my.cnf"}
SECRET_STEMS = {"credentials", "secret", "secrets"}
# Trailing backup/copy suffixes: "credentials.json.bak" is the same secret
# material as "credentials.json". Strip before matching names and suffixes.
BACKUP_SUFFIXES = (".bak", ".old", ".orig")
# Source code is never secret *material* by name alone (secrets.py is the
# stdlib module name); embedded secrets are a content scan, not placement.
CODE_SUFFIXES = (".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
                 ".go", ".rs", ".rb", ".java", ".kt", ".c", ".h", ".cpp",
                 ".hpp", ".cs", ".php", ".swift", ".scala", ".sh", ".bash",
                 ".zsh", ".pl", ".lua", ".r", ".m", ".mm")
# Docs are never secret material by name alone either.
DOC_SUFFIXES = (".md", ".markdown", ".rst")
CONFIG_BASENAMES = {"external_disclosure_authorizers.json",
                    "operator_runbook_classification.json"}


def _strip_backup(base: str) -> str:
    """Strip trailing backup/copy markers (".bak", ".old", ".orig", "~")."""
    stripped = base
    while stripped:
        if stripped.endswith("~") and len(stripped) > 1:
            stripped = stripped[:-1]
            continue
        for suffix in BACKUP_SUFFIXES:
            if stripped.endswith(suffix) and len(stripped) > len(suffix):
                stripped = stripped[:-len(suffix)]
                break
        else:
            return stripped
    return stripped


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
    match = _strip_backup(base)
    if (match.endswith(SECRET_SUFFIXES) or match == ".env"
            or match.startswith(".env.")
            or match.endswith(".tfvars.json")):
        return "PRIVATE-DATA", "secret-or-env-material"
    stem = match.rsplit(".", 1)[0] if "." in match[1:] else match
    # "kubeconfig" has no common English-word collisions, so an affixed
    # name (kubeconfig-prod.yaml, my-kubeconfig) is still cluster material;
    # the canonical ~/.kube/config path names it only by directory.
    # Source code and docs are excluded: a kubeconfig parser or guide is
    # generic code, not cluster material (same rule as the stem check).
    if not match.endswith(".pub") and (
            match in SECRET_BASENAMES
            or (stem in SECRET_STEMS
                and not match.endswith(CODE_SUFFIXES + DOC_SUFFIXES))
            or ("kubeconfig" in match
                and not match.endswith(CODE_SUFFIXES + DOC_SUFFIXES))
            or (match == "config" and ".kube" in p.lower().split("/"))
            or (match == "config.json" and ".docker" in p.lower().split("/"))):
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
