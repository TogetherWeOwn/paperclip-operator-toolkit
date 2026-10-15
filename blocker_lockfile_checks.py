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
a library crate hint — `src/lib.rs` present with no binary evidence —
never reports), Python (`poetry.lock`, `pdm.lock`, `uv.lock`,
`Pipfile.lock`, `requirements.txt` and `requirements-*.txt`; a
`pyproject.toml` carrying only tool config is not a manifest — see
`manifest_contents`), Go (`go.sum`, except a `go.mod` with no `require`
directive — stdlib-only, no `go.sum` exists after `go mod tidy`),
Ruby (`Gemfile.lock`).
A manifest containing `lockfile: none` opts out (for `package.json`
use the JSON-valid form `"//": "lockfile: none"`); the delivered gate
honours the marker only from the base revision (an opt-out must be
merged first — a PR cannot waive itself). Stale-lockfile and
monorepo directory-scoped detection are follow-ups.

Parseability (`check_lockfile_parseable` / `is_parseable_lockfile`)
covers text lockfiles only: the binary `bun.lockb` is never opened as
text and `requirements*.txt` files are never emptiness-checked (an
empty requirements file is a legitimate empty constraint set).

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

# A `go.mod` with no `require` directive has no dependencies, so `go mod
# tidy` leaves no `go.sum` (verified with go 1.27.1 on a stdlib-only
# module). Such a file never reports — but only when the caller passes
# `manifest_contents` with the `go.mod` text; without contents the check
# fails closed and still demands `go.sum`.
_GO_REQUIRE_RE = re.compile(r"(?m)^\s*require\b")


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


def is_parseable_lockfile(path):
    """True when the path should be fed to `check_lockfile_parseable`.

    Text lockfiles only: the binary `bun.lockb` is never opened as
    UTF-8 text (it would raise `UnicodeDecodeError`, a `ValueError`
    the gate must not mistake for a missing file), and
    `requirements*.txt` files are never emptiness-checked (an empty
    requirements file is a legitimate empty constraint set). Every
    other recognised lockfile basename parses as text.
    """
    name = _basename(path)
    if _REQUIREMENTS_TXT_RE.match(name):
        return False
    if name == "bun.lockb":
        return False
    if any(name in locks for locks in MANIFEST_TO_LOCK.values()):
        return True
    return False


def _manifest_scope_dir(manifest_path):
    """Directory owning a manifest, normalised without leading slash.

    `Cargo.toml` -> `""` (repo root, whole tree); `crates/a/Cargo.toml`
    -> `"crates/a"`. Used to scope the library-crate hint to the crate
    that owns the changed manifest instead of the whole repo.
    """
    normed = _norm_path(manifest_path).lstrip("/")
    if "/" not in normed:
        return ""
    return normed.rsplit("/", 1)[0]


def _is_library_crate_hint(
    changed_files, present_files, manifest_path=None, manifest_text=None,
):
    """True when the crate owning the manifest looks like a library crate
    that never commits a lockfile (Cargo itself recommends against
    committing `Cargo.lock` for libraries).

    Library evidence: a `lib.rs` in the manifest's scope. Binary
    evidence (any one waives the exemption): a `main.rs` anywhere in
    scope, a `src/bin/*.rs` file in scope (`src/bin/tool.rs`,
    `crates/cli/src/bin/cli.rs`, `src/bin/tool/main.rs`), or a
    `[[bin]]` target in the manifest text. Scoping matters in
    workspaces: a `lib.rs` under `crates/a/` never exempts a binary
    crate under `crates/cli/`.
    """
    paths = [
        _norm_path(p).lstrip("/")
        for p in list(changed_files) + list(present_files)
    ]
    if manifest_path is not None:
        scope = _manifest_scope_dir(manifest_path)
        if scope:
            prefix = scope + "/"
            paths = [p for p in paths if p == scope or p.startswith(prefix)]
    has_lib = any(
        p == "lib.rs" or p.endswith("/lib.rs") for p in paths
    )
    has_bin = any(
        p == "main.rs" or p.endswith("/main.rs") for p in paths
    )
    if not has_bin:
        has_bin = any("/src/bin/" in "/" + p for p in paths)
    if not has_bin and isinstance(manifest_text, str):
        if "[[bin]]" in manifest_text:
            has_bin = True
    return has_lib and not has_bin


def _lookup_contents(contents, path, name, basename_fallback=True):
    """Return the text for a manifest path, accepting basename keys.

    The basename fallback exists for unit-test convenience (a bare
    `"package.json"` key covers `"sub/dir/package.json"`) and only
    applies to directory-less keys: a key that names another directory
    (`"docs/package.json"`) never satisfies a different path with the
    same basename. The delivered gate keys `marker_contents` by exact
    base-revision path, so the gate path must pass
    `basename_fallback=False` (exact path only): without it a root
    `package.json` key (directory-less by construction) would still
    satisfy a new `packages/new/package.json`. Pass
    `basename_fallback=False` to require an exact path match.
    """
    if not isinstance(contents, dict):
        return None
    text = contents.get(path)
    if text is None and basename_fallback and contents:
        for key, value in contents.items():
            if "/" in str(key).replace("\\", "/"):
                continue
            if _basename(key) == name:
                text = value
                break
    return text


def check_lockfile_present(
    changed_files, present_files, manifest_contents=None,
    ignore_manifests=(), marker_contents=None,
):
    """One finding per changed manifest whose accepted lockfile is in
    neither changed_files nor present_files (basename comparison).
    Findings name the manifest and the expected lockfile name(s).
    Non-manifest changes pass. A lockfile already present in the tree
    satisfies the check even when the manifest changes without it
    (presence, not freshness).

    `manifest_contents` (optional path -> text) enables content-aware
    exemptions: a `pyproject.toml` without a dependency table
    (`[project]`, `[tool.poetry]`, `[tool.pdm]`, `[tool.uv]`) is tool
    config, not a manifest; a `go.mod` with no `require` directive is
    stdlib-only (no `go.sum` exists after `go mod tidy`). Without
    contents both checks fail closed. `ignore_manifests` lists basenames
    a repo opts out of. `requirements-*.txt` satisfies `pyproject.toml`,
    and a library-crate hint (a `lib.rs` in the changed manifest's own
    directory with no binary evidence: no `main.rs`, no `src/bin/`
    file, no `[[bin]]` target) satisfies `Cargo.toml`.

    `marker_contents` (optional path -> text) is the opt-out source for
    the `lockfile: none` marker (case-insensitive; for `package.json`
    use the JSON-valid form `"//": "lockfile: none"`). When provided
    (even as an empty dict) only it is consulted with exact-path
    matching only (`basename_fallback=False`): the delivered gate
    passes base-revision contents here so an opt-out must be merged
    first and a PR cannot waive itself, and a new nested manifest
    never inherits another directory's opt-out — not even a root
    manifest's directory-less key. When omitted (`None`) the marker
    falls back to `manifest_contents` for backward compatibility
    with library callers and unit tests, and only that legacy path
    keeps the directory-less basename fallback.
    """
    have = {_basename(p) for p in list(changed_files) + list(present_files)}
    ignored = {_basename(p) for p in (ignore_manifests or ())}
    contents = manifest_contents or {}
    markers = marker_contents if marker_contents is not None else contents
    findings = []
    for path in changed_files:
        name = _basename(path)
        if name not in MANIFEST_TO_LOCK:
            continue
        if name in ignored:
            continue
        text = _lookup_contents(contents, path, name)
        if marker_contents is not None:
            marker_text = _lookup_contents(
                markers, path, name, basename_fallback=False)
        else:
            marker_text = _lookup_contents(markers, path, name)
        if isinstance(marker_text, str) and "lockfile: none" in marker_text.lower():
            continue
        if name == "pyproject.toml" and contents is not None and text is not None:
            if not _PYPROJECT_MANIFEST_RE.search(text):
                continue
        if name == "go.mod" and contents is not None and text is not None:
            if not _GO_REQUIRE_RE.search(text):
                continue
        if name == "Cargo.toml" and _is_library_crate_hint(
            changed_files, present_files, path,
            text if isinstance(text, str) else None,
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
    Other non-empty lockfiles pass. Paths that are not parseable
    lockfiles (`bun.lockb`, `requirements*.txt`) are skipped: the
    former is binary, the latter is legitimately empty as a constraint
    set (see `is_parseable_lockfile`)."""
    findings = []
    for path, text in lock_contents.items():
        if not is_parseable_lockfile(path):
            continue
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
