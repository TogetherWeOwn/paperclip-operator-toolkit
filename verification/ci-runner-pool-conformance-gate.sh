#!/usr/bin/env bash
set -Eeuo pipefail

workflow=${1:-.github/workflows/ci.yml}
[[ -f "$workflow" ]] || { printf 'FAIL: missing %s\n' "$workflow" >&2; exit 1; }

python3 - "$workflow" <<'PY'
from pathlib import Path
import re
import sys

text = Path(sys.argv[1]).read_text()
jobs_match = re.search(r"(?ms)^jobs:\n(?P<jobs>.*)\Z", text)
if not jobs_match:
    raise SystemExit("FAIL: jobs block is missing")
jobs_text = jobs_match.group("jobs")
jobs = re.findall(r"(?m)^  ([a-zA-Z0-9_-]+):\n", jobs_text)
if not jobs:
    raise SystemExit("FAIL: no jobs found")
bodies = {}
for name in jobs:
    m = re.search(r"(?ms)^  " + re.escape(name) + r":\n(?P<body>.*?)(?=^  [a-zA-Z0-9_-]+:\n|\Z)", jobs_text)
    bodies[name] = m.group("body") if m else ""
if "offline-suites" not in bodies:
    raise SystemExit("FAIL: offline-suites job is missing")
body = bodies["offline-suites"]

# The runner-pool policy has two halves: jobs run only on the pinned runner pool, and jobs
# must not receive a container daemon socket. In this tree the pinned pool is
# GitHub-hosted `ubuntu-latest`. A self-hosted fleet is an operator choice made
# in a fork (see the example in ci.yml); moving a job onto a self-hosted label
# here would silently hand it whatever that host exposes, so it must go red.
#
# NO job needs a container daemon, therefore no job may declare a service
# container either (the quiet way back to needing one).
PINNED = "    runs-on: ubuntu-latest\n"

unpinned = sorted(n for n, b in bodies.items() if PINNED not in b)
# A `services:` block is the quiet way back to needing a daemon.
with_services = sorted(n for n, b in bodies.items() if re.search(r"(?m)^    services:\s*$", b))

checks = {
    "required check name is unchanged": "    name: Offline suites\n" in body,
    "offline-suites runs on the pinned pool": PINNED in body,
    "every job runs on the pinned pool": not unpinned,
    "no job declares a service container": not with_services,
    "no self-hosted label in this workflow":
        re.search(r"(?m)^\s*runs-on:.*self-hosted", text) is None,
    "no runs-on value outside the pinned pool": all(
        l.strip() == "runs-on: ubuntu-latest"
        for l in text.splitlines() if l.strip().startswith("runs-on:")),
    "runner platform is a positive control": all(
        value in body for value in (
            '[[ "${RUNNER_OS:-}" == Linux ]]', '[[ "${RUNNER_ARCH:-}" == X64 ]]')),
    "checkout cleans the workspace": re.search(
        r"(?ms)- uses: actions/checkout@v4\n\s+with:\n\s+clean: true", body) is not None,
}
failed = [name for name, ok in checks.items() if not ok]
for name, ok in checks.items():
    print(("PASS" if ok else "FAIL") + ": " + name)
if unpinned:
    print("  jobs not on the pinned pool: " + ", ".join(unpinned))
if with_services:
    print("  jobs declaring a service container: " + ", ".join(with_services))
if failed:
    raise SystemExit(1)
PY
