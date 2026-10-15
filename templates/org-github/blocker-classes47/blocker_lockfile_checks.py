#!/usr/bin/env python3
"""Deterministic lockfile checks (blocker-ledger class 7).

Flags manifest changes that land with no accepted lockfile basename in
the change or the tree (missing lockfile, non-reproducible installs),
or with an empty/corrupt lockfile.

Presence, not freshness: a repo that already vendors a lockfile passes
even when the manifest changes without it, and matching is by basename
(any lockfile anywhere satisfies any manifest). Recognised lockfiles:
npm (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`,
`npm-shrinkwrap.json`, `bun.lock`, `bun.lockb`), Cargo (`Cargo.lock`;
a library crate hint — `src/lib.rs` present with no `src/main.rs` —
never reports), Python (`poetry.lock`, `pdm.lock`, `uv.lock`,
`Pipfile.lock`, `requirements.txt` and `requirements-*.txt`; a
`pyproject.toml` carrying only tool config is not a manifest — see
`manifest_contents`), Go (`go.sum`), Ruby (`Gemfile.lock`).
A manifest containing `lockfile: none` opts out. Stale-lockfile and
monorepo directory-scoped detection are follow-ups.

Stdlib only, pure functions, no network/clock/filesystem.
"""

import os
import re

MANIFEST_TO_LOCK = {
    "package.json": (
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "npm-shrinkwrap.json",
        "bun.lock",
        "bun.lockb",
    ),
    "Cargo.toml": ("Cargo.lock",),
    "pyproject.toml": (
        "poetry.lock",
        "pdm.lock",
        "uv.lock",
        "Pipfile.lock",
        "requirements.txt",
    ),
    "go.mod": ("go.sum",),
    "Gemfile": ("Gemfile.lock",),
}

# `requirements-*.txt` variants (`requirements-dev.txt`, ...) satisfy a
# `pyproject.toml` the same way the bare `requirements.txt` does.
_REQUIREMENTS_TXT_RE = re.compile(r"^requirements.*\.txt$", re.IGNORECASE)

# A `pyproject.toml` is a dependency manifest only when it declares a
# dependency table. Tool-only files (`[tool.ruff]`, `[tool.pytest]`,
# `[tool.black]` with no `[project]`/`[tool.poetry]`/...) never report —
# but only when the caller passes `manifest_contents`; without contents
# the check fails closed and treats the file as a manifest.
_PYPROJECT_MANIFEST_RE = re.compile(
    r"(?m)^\s*\[(?:project|tool\.poetry|tool\.pdm|tool\.uv)\b"
)


def _basename(path):
    return os.path.basename(str(path))


def is_manifest(path):
    """True when the basename is a known manifest."""
    return _basename(path) in MANIFEST_TO_LOCK


def _norm_path(path):
    return str(path or "").replace("\\", "/").strip()


def is_lockfile(path):
    """True when the basename is a known lockfile.

    `requirements*.txt` variants count (`requirements-dev.txt`), as do
    `bun.lock`/`bun.lockb` and `Pipfile.lock`.
    """
    name = _basename(path)
    if any(name in locks for locks in MANIFEST_TO_LOCK.values()):
        return True
    return bool(_REQUIREMENTS_TXT_RE.match(name))


def _is_library_crate_hint(changed_files, present_files):
    """True when the tree looks like a library crate that never commits
    a lockfile: `src/lib.rs` present with no `src/main.rs` (Cargo itself
    recommends against committing `Cargo.lock` for libraries)."""
    paths = [
        _norm_path(p).lstrip("/")
        for p in list(changed_files) + list(present_files)
    ]
    has_lib = any(
        p == "lib.rs" or p.endswith("/lib.rs") for p in paths
    )
    has_bin = any(
        p == "main.rs" or p.endswith("/main.rs") for p in paths
    )
    return has_lib and not has_bin


def check_lockfile_present(
    changed_files, present_files, manifest_contents=None,
    ignore_manifests=(),
):
    """One finding per changed manifest whose accepted lockfile is in
    neither changed_files nor present_files (basename comparison).
    Findings name the manifest and the expected lockfile name(s).
    Non-manifest changes pass. A lockfile already present in the tree
    satisfies the check even when the manifest changes without it
    (presence, not freshness).

    `manifest_contents` (optional path -> text) enables two opt-outs:
    a manifest containing `lockfile: none` never reports, and a
    `pyproject.toml` without a dependency table (`[project]`,
    `[tool.poetry]`, `[tool.pdm]`, `[tool.uv]`) is tool config, not a
    manifest. Without contents the check fails closed (every
    `pyproject.toml` counts). `ignore_manifests` lists basenames a repo
    opts out of. `requirements-*.txt` satisfies `pyproject.toml`, and a
    library-crate hint (`src/lib.rs` without `src/main.rs`) satisfies
    `Cargo.toml`.
    """
    have = {_basename(p) for p in list(changed_files) + list(present_files)}
    ignored = {_basename(p) for p in (ignore_manifests or ())}
    contents = manifest_contents or {}
    findings = []
    for path in changed_files:
        name = _basename(path)
        if name not in MANIFEST_TO_LOCK:
            continue
        if name in ignored:
            continue
        text = contents.get(path) if isinstance(contents, dict) else None
        if text is None and contents:
            # Contents keyed by basename still opt out.
            for key, value in contents.items():
                if _basename(key) == name:
                    text = value
                    break
        if isinstance(text, str) and "lockfile: none" in text.lower():
            continue
        if name == "pyproject.toml" and contents is not None and text is not None:
            if not _PYPROJECT_MANIFEST_RE.search(text):
                continue
        if name == "Cargo.toml" and _is_library_crate_hint(
            changed_files, present_files
        ):
            continue
        accepted = MANIFEST_TO_LOCK[name]
        if any(lock in have for lock in accepted):
            continue
        if name == "pyproject.toml" and any(
            _REQUIREMENTS_TXT_RE.match(h) for h in have
        ):
            continue
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
