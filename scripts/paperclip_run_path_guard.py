#!/usr/bin/env python3
"""Fail closed unless every mutable run path is owned by one run.

This is a deterministic preflight for the Paperclip run launcher. It is not a
replacement for mount namespaces: the launcher must expose only the approved
paths writable and must keep /app and server state read-only or absent.
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
from pathlib import Path

DEFAULT_DENIED_ROOTS = (
    "/app",
    "/paperclip/instances",
    "/paperclip/deployments",
    "/paperclip/operator-handoff",
)


class PathGuardError(ValueError):
    pass


def resolved(path: Path) -> Path:
    return Path(os.path.realpath(path))


def is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def existing_components(root: Path, target: Path) -> list[Path]:
    relative = target.relative_to(root)
    components = [root]
    current = root
    for part in relative.parts:
        current = current / part
        if current.exists() or current.is_symlink():
            components.append(current)
        else:
            break
    return components


def reject_symlink_components(root: Path, target: Path, label: str) -> None:
    for component in existing_components(root, target):
        if component.is_symlink():
            raise PathGuardError(f"{label}: symlink component is forbidden: {component}")


def check_private_owned_directory(path: Path, label: str) -> None:
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode):
        raise PathGuardError(f"{label}: not a directory: {path}")
    if info.st_uid != os.geteuid():
        raise PathGuardError(
            f"{label}: owner uid {info.st_uid} does not match launcher uid {os.geteuid()}: {path}"
        )
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise PathGuardError(f"{label}: group/other permission bits must be zero: {path}")


def load_marker(run_root: Path, expected_run_id: str) -> None:
    marker = run_root / ".paperclip-run-scratch.json"
    if marker.is_symlink():
        raise PathGuardError(f"run marker must not be a symlink: {marker}")
    try:
        marker_info = marker.stat()
        payload = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PathGuardError(f"run marker is missing or invalid: {marker}: {exc}") from exc
    if marker_info.st_uid != os.geteuid():
        raise PathGuardError(f"run marker has the wrong owner uid: {marker}")
    if stat.S_IMODE(marker_info.st_mode) & 0o077:
        raise PathGuardError(f"run marker exposes group/other permission bits: {marker}")
    if payload.get("version") != 1 or payload.get("runId") != expected_run_id:
        raise PathGuardError("run marker does not bind this directory to the expected run id")


def validate_paths(
    *,
    run_root: Path,
    run_id: str,
    mutable_paths: dict[str, Path],
    denied_roots: list[Path],
) -> dict[str, str]:
    if run_root.is_symlink():
        raise PathGuardError(f"run root must not be a symlink: {run_root}")
    run_root = resolved(run_root)
    check_private_owned_directory(run_root, "run root")
    load_marker(run_root, run_id)

    denied = [resolved(path) for path in denied_roots]
    for deny_root in denied:
        if is_within(run_root, deny_root) or is_within(deny_root, run_root):
            raise PathGuardError(f"run root overlaps denied root: {deny_root}")

    result: dict[str, str] = {}
    seen: set[Path] = set()
    for label, requested in mutable_paths.items():
        absolute = requested if requested.is_absolute() else Path.cwd() / requested
        lexical = Path(os.path.abspath(absolute))
        if lexical == run_root or not is_within(lexical, run_root):
            raise PathGuardError(f"{label}: path escapes run root: {requested} -> {lexical}")
        reject_symlink_components(run_root, lexical, label)
        target = resolved(lexical)
        if target == run_root or not is_within(target, run_root):
            raise PathGuardError(f"{label}: path escapes run root: {requested} -> {target}")
        for deny_root in denied:
            if is_within(target, deny_root):
                raise PathGuardError(f"{label}: path resolves into denied root: {deny_root}")
        if target in seen:
            raise PathGuardError(f"{label}: mutable paths must be distinct: {target}")
        seen.add(target)
        if target.exists():
            check_private_owned_directory(target, label)
        result[label] = str(target)
    return result


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-root", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--dependency-root", required=True, type=Path)
    parser.add_argument("--cache-root", required=True, type=Path)
    parser.add_argument("--store-root", required=True, type=Path)
    parser.add_argument("--tmp-root", required=True, type=Path)
    parser.add_argument("--deny-root", action="append", default=[], type=Path)
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    mutable_paths = {
        "workspace": args.workspace,
        "dependencyRoot": args.dependency_root,
        "cacheRoot": args.cache_root,
        "storeRoot": args.store_root,
        "tmpRoot": args.tmp_root,
    }
    denied_roots = [Path(path) for path in DEFAULT_DENIED_ROOTS] + args.deny_root
    try:
        result = validate_paths(
            run_root=args.run_root,
            run_id=args.run_id,
            mutable_paths=mutable_paths,
            denied_roots=denied_roots,
        )
    except (OSError, PathGuardError) as exc:
        print(f"DENY run_path_invalid: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({"decision": "allow", "runId": args.run_id, "paths": result}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
