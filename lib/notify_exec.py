#!/usr/bin/env python3
"""Run one notification courier and leave no descendant behind."""

import ctypes
import errno
import os
import signal
import subprocess
import sys
import tempfile
import time


def positive_seconds(name: str) -> float:
    value = os.environ.get(name, "")
    try:
        seconds = float(value)
    except ValueError:
        raise SystemExit(f"{name} must be a positive number")
    if seconds <= 0:
        raise SystemExit(f"{name} must be a positive number")
    return seconds


def direct_children() -> set[int]:
    children: set[int] = set()
    try:
        entries = os.listdir("/proc")
    except OSError:
        return children
    for entry in entries:
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/status", encoding="utf-8") as status:
                for line in status:
                    if line.startswith("PPid:"):
                        if int(line.split()[1]) == os.getpid():
                            children.add(int(entry))
                        break
        except (OSError, ValueError):
            continue
    return children


def signal_children(sig: signal.Signals) -> None:
    for pid in direct_children():
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            pass


def reap_children() -> None:
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def children_gone(deadline: float) -> bool:
    while time.monotonic() < deadline:
        reap_children()
        if not direct_children():
            return True
        time.sleep(0.02)
    reap_children()
    return not direct_children()


def stop_tree(proc: subprocess.Popen[bytes], grace: float) -> None:
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    signal_children(signal.SIGTERM)
    if children_gone(time.monotonic() + grace):
        return

    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + max(grace, 1.0)
    while time.monotonic() < deadline:
        signal_children(signal.SIGKILL)
        if children_gone(time.monotonic() + 0.05):
            return
    signal_children(signal.SIGKILL)
    reap_children()


def main() -> int:
    command = os.environ.get("REQUEST_NOTIFY_CMD", "")
    if not command:
        print("REQUEST_NOTIFY_CMD is empty", file=sys.stderr)
        return 125
    timeout = positive_seconds("REQUEST_NOTIFY_TIMEOUT")
    grace = positive_seconds("REQUEST_NOTIFY_KILL_AFTER")
    payload = sys.stdin.buffer.read()

    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        err = ctypes.get_errno()
        print(f"cannot become notification subreaper: {os.strerror(err)}", file=sys.stderr)
        return 125

    with tempfile.TemporaryFile() as output:
        proc = subprocess.Popen(
            ["bash", "-c", command],
            stdin=subprocess.PIPE,
            stdout=output,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        timed_out = False
        try:
            # communicate() starts the deadline while stdin is still being sent.
            # A courier that never reads its pipe must not block us before the
            # timeout begins, which a synchronous proc.stdin.write() would do.
            proc.communicate(input=payload, timeout=timeout)
            rc = proc.returncode
        except subprocess.TimeoutExpired:
            timed_out = True
            rc = 124

        # The configured shell can exit while a detached grandchild keeps
        # descriptors or plans a later queue mutation. As a subreaper, this
        # process adopts those descendants and kills/reaps them before returning.
        stop_tree(proc, grace)
        try:
            proc.communicate(timeout=max(grace, 1.0))
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            proc.communicate()

        output.seek(0)
        sys.stdout.buffer.write(output.read())

    if timed_out:
        return 124
    if rc < 0:
        return 128 + (-rc)
    return rc


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except OSError as exc:
        if exc.errno == errno.ENOENT:
            print(f"notification runner could not exec: {exc}", file=sys.stderr)
            raise SystemExit(125)
        raise
