#!/usr/bin/env python3
"""Run one mutation suite in a contained session with an outer deadline."""

import ctypes
import errno
import os
import signal
import subprocess
import sys
import time


def positive_seconds(value: str) -> float:
    try:
        seconds = float(value)
    except ValueError:
        raise SystemExit("mutation watchdog timeout must be a positive number")
    if seconds <= 0:
        raise SystemExit("mutation watchdog timeout must be a positive number")
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


def reap_children() -> None:
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def signal_session(proc: subprocess.Popen[bytes], sig: signal.Signals) -> None:
    try:
        os.killpg(proc.pid, sig)
    except ProcessLookupError:
        pass
    for pid in direct_children():
        try:
            os.kill(pid, sig)
        except (ProcessLookupError, PermissionError):
            pass


def descendants_gone(deadline: float) -> bool:
    while time.monotonic() < deadline:
        reap_children()
        if not direct_children():
            return True
        time.sleep(0.02)
    reap_children()
    return not direct_children()


def stop_session(proc: subprocess.Popen[bytes]) -> None:
    signal_session(proc, signal.SIGTERM)
    if descendants_gone(time.monotonic() + 0.2):
        return
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        signal_session(proc, signal.SIGKILL)
        if descendants_gone(time.monotonic() + 0.05):
            return
    signal_session(proc, signal.SIGKILL)
    reap_children()


def watched_process() -> tuple[int, int] | None:
    path = os.environ.get("MUTATION_WATCHDOG_PROCESS_FILE", "")
    if not path:
        return None
    try:
        pid_value, sid_value = open(path, encoding="utf-8").read().split()
        return int(pid_value), int(sid_value)
    except (OSError, ValueError):
        return None


def watched_process_gone() -> bool:
    watched = watched_process()
    if watched is None:
        return False
    pid, sid = watched
    try:
        current_sid = os.getsid(pid)
    except ProcessLookupError:
        return True
    return current_sid != sid


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: mutation_watchdog.py DIR SUITE TIMEOUT", file=sys.stderr)
        return 125
    directory, suite, timeout_value = sys.argv[1:]
    timeout = positive_seconds(timeout_value)

    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        err = ctypes.get_errno()
        print(f"mutation watchdog cannot become subreaper: {os.strerror(err)}", file=sys.stderr)
        return 125

    proc = subprocess.Popen(
        [f"./{suite}"],
        cwd=directory,
        start_new_session=True,
    )
    timed_out = False
    try:
        rc = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        rc = 124
    finally:
        stop_session(proc)
        try:
            proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            signal_session(proc, signal.SIGKILL)
            proc.wait()

    if timed_out and os.environ.get("MUTATION_WATCHDOG_PROCESS_FILE", ""):
        if watched_process_gone():
            print("MUTATION_WATCHDOG: watched descendant terminated", file=sys.stderr)
        else:
            print("MUTATION_WATCHDOG: watched descendant survived cleanup", file=sys.stderr)
            return 126
    return 124 if timed_out else rc


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except OSError as exc:
        if exc.errno == errno.ENOENT:
            print(f"mutation watchdog could not exec: {exc}", file=sys.stderr)
            raise SystemExit(125)
        raise
