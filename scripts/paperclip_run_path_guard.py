#!/usr/bin/env python3
"""Fail closed unless every mutable run path is owned by one isolated run."""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
from pathlib import Path

LIVE_STATE_ROOT = Path("/paperclip")
REQUIRED_RUN_BASE = Path("/run/paperclip-runs")
RUN_ROOT_MODE = 0o700
MARKER_MODE = 0o600
HANDOFF_MODE = 0o600


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


def check_directory(path: Path, label: str, expected_uid: int, expected_mode: int) -> None:
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode):
        raise PathGuardError(f"{label}: not a directory: {path}")
    if info.st_uid != expected_uid:
        raise PathGuardError(
            f"{label}: owner uid {info.st_uid} does not match expected uid {expected_uid}: {path}"
        )
    actual_mode = stat.S_IMODE(info.st_mode)
    if actual_mode != expected_mode:
        raise PathGuardError(
            f"{label}: mode {actual_mode:04o} must be exactly {expected_mode:04o}: {path}"
        )


def load_json_file(
    path: Path, label: str, expected_uid: int, expected_mode: int
) -> dict[str, object]:
    if path.is_symlink():
        raise PathGuardError(f"{label} must not be a symlink: {path}")
    try:
        info = path.stat()
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PathGuardError(f"{label} is missing or invalid: {path}: {exc}") from exc
    if not stat.S_ISREG(info.st_mode):
        raise PathGuardError(f"{label} is not a regular file: {path}")
    if info.st_uid != expected_uid:
        raise PathGuardError(f"{label} has the wrong owner uid: {path}")
    actual_mode = stat.S_IMODE(info.st_mode)
    if actual_mode != expected_mode:
        raise PathGuardError(
            f"{label} mode {actual_mode:04o} must be exactly {expected_mode:04o}: {path}"
        )
    if not isinstance(payload, dict):
        raise PathGuardError(f"{label} payload must be a JSON object: {path}")
    return payload


def validate_paths(
    *,
    run_root: Path,
    run_id: str,
    run_uid: int,
    run_gid: int,
    run_host_uid: int,
    run_host_gid: int,
    mutable_paths: dict[str, Path],
    launcher_uid: int | None = None,
    required_run_base: Path = REQUIRED_RUN_BASE,
    live_state_root: Path = LIVE_STATE_ROOT,
) -> dict[str, str]:
    if launcher_uid is None:
        launcher_uid = os.geteuid()
    if run_root.is_symlink():
        raise PathGuardError(f"run root must not be a symlink: {run_root}")
    run_root = resolved(run_root)
    required_base = resolved(required_run_base)
    live_state = resolved(live_state_root)
    if run_root == required_base or not is_within(run_root, required_base):
        raise PathGuardError(f"run root must be below immutable run base {required_base}: {run_root}")
    if is_within(run_root, live_state) or is_within(live_state, run_root):
        raise PathGuardError(f"run root overlaps live service state: {live_state}")
    check_directory(run_root, "run root", launcher_uid, RUN_ROOT_MODE)

    marker = load_json_file(
        run_root / ".paperclip-run-scratch.json",
        "run marker",
        launcher_uid,
        MARKER_MODE,
    )
    if marker.get("version") != 1 or marker.get("runId") != run_id:
        raise PathGuardError("run marker does not bind this directory to the expected run id")

    handoff = load_json_file(
        run_root / ".paperclip-run-ownership.json",
        "ownership handoff",
        launcher_uid,
        HANDOFF_MODE,
    )
    if (
        handoff.get("version") != 1
        or handoff.get("runId") != run_id
        or handoff.get("runUid") != run_uid
        or handoff.get("runGid") != run_gid
        or handoff.get("runHostUid") != run_host_uid
        or handoff.get("runHostGid") != run_host_gid
    ):
        raise PathGuardError("ownership handoff does not bind the expected run identity")
    ownership_paths = handoff.get("paths")
    if not isinstance(ownership_paths, dict):
        raise PathGuardError("ownership handoff paths must be a JSON object")

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
        if is_within(target, live_state):
            raise PathGuardError(f"{label}: path resolves into live service state: {live_state}")
        if target in seen:
            raise PathGuardError(f"{label}: mutable paths must be distinct: {target}")
        seen.add(target)
        if ownership_paths.get(label) != str(target):
            raise PathGuardError(f"{label}: ownership handoff path mismatch: {target}")
        check_directory(target, label, run_host_uid, RUN_ROOT_MODE)
        target_info = target.stat()
        if target_info.st_gid != run_host_gid:
            raise PathGuardError(
                f"{label}: owner gid {target_info.st_gid} does not match run host gid {run_host_gid}: {target}"
            )
        result[label] = str(target)
    return result


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-root", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-uid", required=True, type=int)
    parser.add_argument("--run-gid", required=True, type=int)
    parser.add_argument("--run-host-uid", required=True, type=int)
    parser.add_argument("--run-host-gid", required=True, type=int)
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--dependency-root", required=True, type=Path)
    parser.add_argument("--cache-root", required=True, type=Path)
    parser.add_argument("--store-root", required=True, type=Path)
    parser.add_argument("--tmp-root", required=True, type=Path)
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
    try:
        result = validate_paths(
            run_root=args.run_root,
            run_id=args.run_id,
            run_uid=args.run_uid,
            run_gid=args.run_gid,
            run_host_uid=args.run_host_uid,
            run_host_gid=args.run_host_gid,
            mutable_paths=mutable_paths,
        )
    except (OSError, PathGuardError) as exc:
        print(f"DENY run_path_invalid: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({"decision": "allow", "runId": args.run_id, "paths": result}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
