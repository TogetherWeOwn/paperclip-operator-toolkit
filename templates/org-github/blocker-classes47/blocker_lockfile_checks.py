#!/usr/bin/env python3
"""Deterministic lockfile checks (blocker-ledger class 7).

Flags manifest changes that land without their lockfile
(non-reproducible installs) or with an empty/corrupt lockfile.

Stdlib only, pure functions, no network/clock/filesystem.
"""

import os

MANIFEST_TO_LOCK = {
    "package.json": (
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "npm-shrinkwrap.json",
    ),
    "Cargo.toml": ("Cargo.lock",),
    "pyproject.toml": ("poetry.lock", "pdm.lock", "uv.lock"),
    "go.mod": ("go.sum",),
    "Gemfile": ("Gemfile.lock",),
}


def _basename(path):
    return os.path.basename(str(path))


def is_manifest(path):
    """True when the basename is a known manifest."""
    return _basename(path) in MANIFEST_TO_LOCK


def is_lockfile(path):
    """True when the basename is a known lockfile."""
    name = _basename(path)
    return any(name in locks for locks in MANIFEST_TO_LOCK.values())


def check_lockfile_present(changed_files, present_files):
    """One finding per changed manifest whose accepted lockfile is in
    neither changed_files nor present_files (basename comparison).
    Findings name the manifest and the expected lockfile name(s)."""
    have = {_basename(p) for p in list(changed_files) + list(present_files)}
    findings = []
    for path in changed_files:
        name = _basename(path)
        if name not in MANIFEST_TO_LOCK:
            continue
        accepted = MANIFEST_TO_LOCK[name]
        if not any(lock in have for lock in accepted):
            findings.append(
                "%s: manifest changed without its lockfile "
                "(expected one of: %s)" % (name, ", ".join(accepted))
            )
    return findings


def check_lockfile_parseable(lock_contents):
    """One finding per empty file, per package-lock.json with neither
    "packages" nor "dependencies", per pnpm-lock.yaml without
    "lockfileVersion", and per Cargo.lock without "[[package]]".
    Other non-empty lockfiles pass."""
    findings = []
    for path, text in lock_contents.items():
        name = _basename(path)
        if not (text or "").strip():
            findings.append("%s: lockfile is empty" % path)
            continue
        if name == "package-lock.json":
            if '"packages"' not in text and '"dependencies"' not in text:
                findings.append(
                    "%s: package-lock.json has neither "
                    '"packages" nor "dependencies"' % path
                )
        elif name == "pnpm-lock.yaml":
            if "lockfileVersion" not in text:
                findings.append(
                    "%s: pnpm-lock.yaml has no lockfileVersion" % path
                )
        elif name == "Cargo.lock":
            if "[[package]]" not in text:
                findings.append(
                    "%s: Cargo.lock has no [[package]] entries" % path
                )
    return findings
