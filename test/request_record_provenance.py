#!/usr/bin/env python3
"""Test-only snapshots; observations are not atomic with lock acquisition."""

import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import sys
import time


def identity(path, *, executable=False, interpreter=True):
    result = {"path": str(path), "observed_ns": time.time_ns()}
    try:
        # A proc executable link can name an unlinked image. Open the handle,
        # never its readlink/realpath text, and stat/hash that same open image.
        if Path(path).is_symlink():
            result["symlink_target"] = os.readlink(path)
        result["canonical"] = str(Path(path).resolve(strict=False))
        if executable:
            with open(path, "rb") as stream:
                stat = os.fstat(stream.fileno())
                result.update(device=stat.st_dev, inode=stat.st_ino)
                first = stream.readline(256)
                stream.seek(0)
                digest = hashlib.sha256()
                for chunk in iter(lambda: stream.read(65536), b""):
                    digest.update(chunk)
                result["sha256"] = digest.hexdigest()
            result["format"] = "ELF" if first.startswith(b"\x7fELF") else "other"
            if first.startswith(b"#!"):
                result["shebang"] = first.decode(errors="replace").strip()
                if interpreter:
                    words = shlex.split(result["shebang"][2:])
                    if words:
                        result["interpreter"] = identity(words[0], executable=True, interpreter=False)
                        if Path(words[0]).name == "env" and len(words) == 2:
                            candidate = shutil.which(words[1])
                            result["env_interpreter_candidate"] = (
                                identity(candidate, executable=True, interpreter=False) if candidate else None)
        else:
            stat = Path(path).stat()
            result.update(device=stat.st_dev, inode=stat.st_ino)
    except ValueError as error:
        result["shebang_error"] = str(error)
    except (OSError, RuntimeError) as error:
        result["error"] = str(error)
    return result


def snapshot(pid, phase, command, status, resolved, queue_lock, status_lock):
    queue = Path(os.environ["QUEUE"])
    parent = queue.parent.resolve()
    result = {"phase": phase, "pid": pid, "timestamp_ns": time.time_ns(),
              "command": command, "next_boundary_status": status,
              "path": os.environ["PATH"].split(":"),
              "shell": identity(f"/proc/{pid}/exe", executable=True),
              "observer": identity(sys.executable, executable=True),
              "queue": identity(queue), "parent": identity(parent),
              "locks": [identity(path) if path else {"uninitialized": True}
                        for path in (queue_lock, status_lock)]}
    try:
        result["mount_namespace"] = os.readlink(f"/proc/{pid}/ns/mnt")
        # Keep only mount entries covering this synthetic queue's parent.
        entries = []
        for line in Path(f"/proc/{pid}/mountinfo").read_text().splitlines():
            fields = line.split()
            mount = fields[4].replace("\\040", " ").replace("\\134", "\\")
            if str(parent) == mount or str(parent).startswith(mount.rstrip("/") + "/"):
                entries.append(line)
        result["covering_mounts"] = entries
    except OSError as error:
        result["mount_error"] = str(error)
    result["resolved_executable"] = identity(resolved, executable=True) if resolved else None
    # For scripts the shebang plus traced execve records identify the interpreter;
    # a PATH lookup alone is deliberately not called actual execution proof.
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    snapshot(int(sys.argv[1]), sys.argv[2], sys.argv[3], int(sys.argv[4]), *sys.argv[5:8])
