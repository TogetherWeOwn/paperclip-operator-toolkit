#!/usr/bin/env python3
"""Durably append JSONL records, atomically for multi-row batches."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import signal
import sys
import tempfile


def write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError("queue write made no progress")
        view = view[written:]


def fsync_parent(path: Path) -> None:
    parent_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)


def append(path: Path, data: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.fchmod(fd, 0o600)
        write_all(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    fsync_parent(path)


def interrupt_parent() -> None:
    os.kill(os.getppid(), signal.SIGKILL)
    os._exit(86)


def append_batch(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=False, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.batch.", dir=path.parent)
    tmp = Path(tmp_name)
    interrupt_after = int(os.environ.get("REQRECORD_TEST_INTERRUPT_AFTER_LINES", "0"))
    interrupt_after_commit = os.environ.get("REQRECORD_TEST_INTERRUPT_AFTER_COMMIT") == "1"

    try:
        os.fchmod(fd, 0o600)
        if path.exists():
            with path.open("rb") as source, os.fdopen(os.dup(fd), "wb", closefd=True) as target:
                shutil.copyfileobj(source, target)
                target.flush()

        lines = data.splitlines(keepends=True)
        for index, line in enumerate(lines, start=1):
            write_all(fd, line)
            if index == interrupt_after:
                os.fsync(fd)
                interrupt_parent()
        os.fsync(fd)
        os.close(fd)
        fd = -1

        os.replace(tmp, path)
        fsync_parent(path)
        if interrupt_after_commit:
            interrupt_parent()
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in {"append", "append-batch"}:
        print(f"usage: {sys.argv[0]} append|append-batch QUEUE", file=sys.stderr)
        return 2

    data = sys.stdin.buffer.read()
    if not data:
        print("refusing an empty queue append", file=sys.stderr)
        return 2

    path = Path(sys.argv[2])
    try:
        if sys.argv[1] == "append":
            append(path, data)
        else:
            append_batch(path, data)
    except (OSError, ValueError) as exc:
        print(f"durable queue append failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
