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

# TOG-2677 has two halves, and only the first was ever pinned here:
#   1. jobs run on the private self-hosted pool, never a paid fallback;
#   2. "jobs must not receive the Docker socket".
# Half 2 was violated in practice for weeks (every runner's .env exported
# DOCKER_HOST into every job) precisely because nothing checked it. TOG-3051
# split the fleet by label -- `isolated` runners have no DOCKER_HOST, plain
# `two-selfhosted` ones still do, for other repos whose CI needs a daemon -- and
# moved the last job that wanted a container (a `postgres` service) onto an
# ephemeral PostgreSQL cluster it starts itself.
#
# So the invariant this workflow can now hold is the strong one: NO job here
# needs a container daemon, therefore no job may sit on the Docker-enabled pool
# and no job may declare a service container (which would silently require one
# again). GitHub-hosted runners are not an escape hatch either -- Actions
# billing is disabled on this account, so `runs-on: ubuntu-latest` never starts.
ISOLATED = "    runs-on: [self-hosted, isolated]\n"

unisolated = sorted(n for n, b in bodies.items() if ISOLATED not in b)
# A `services:` block is the quiet way back to needing a daemon.
with_services = sorted(n for n, b in bodies.items() if re.search(r"(?m)^    services:\s*$", b))

checks = {
    "required check name is unchanged": "    name: Offline suites\n" in body,
    "offline-suites runs on the isolated pool": ISOLATED in body,
    "every job runs on the isolated pool": not unisolated,
    "no job declares a service container": not with_services,
    "Docker-enabled pool is unused by this workflow":
        re.search(r"(?m)^    runs-on: \[self-hosted, two-selfhosted\]\s*$", text) is None,
    "paid fallback is absent": re.search(r"(?m)^    runs-on: ubuntu-latest\s*$", text) is None,
    "no runs-on value outside the isolated pool": all(
        l.strip() == "runs-on: [self-hosted, isolated]"
        for l in text.splitlines() if l.strip().startswith("runs-on:")),
    "runner identity is a positive control": all(
        value in body for value in ("RUNNER_NAME", "RUNNER_OS", "RUNNER_ARCH", "coolify-vps-*")),
    "checkout cleans the workspace": re.search(
        r"(?ms)- uses: actions/checkout@v4\n\s+with:\n\s+clean: true", body) is not None,
}
failed = [name for name, ok in checks.items() if not ok]
for name, ok in checks.items():
    print(("PASS" if ok else "FAIL") + ": " + name)
if unisolated:
    print("  jobs not on the isolated pool: " + ", ".join(unisolated))
if with_services:
    print("  jobs declaring a service container: " + ", ".join(with_services))
if failed:
    raise SystemExit(1)
PY
