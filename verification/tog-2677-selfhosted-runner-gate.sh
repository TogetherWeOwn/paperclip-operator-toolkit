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
LABEL = "    runs-on: [self-hosted, two-selfhosted]\n"
checks = {
    "required check name is unchanged": "    name: Offline suites\n" in body,
    "runner label is exact": LABEL in body,
    "every job runs on the private runner": all(LABEL in b for b in bodies.values()),
    "paid fallback is absent": re.search(r"(?m)^    runs-on: ubuntu-latest\s*$", text) is None,
    "no other runs-on value anywhere": all(l.strip() == "runs-on: [self-hosted, two-selfhosted]" for l in text.splitlines() if l.strip().startswith("runs-on:")),
    "runner identity is a positive control": all(value in body for value in ("RUNNER_NAME", "RUNNER_OS", "RUNNER_ARCH", "coolify-vps-*")),
    "checkout cleans the workspace": re.search(r"(?ms)- uses: actions/checkout@v4\n\s+with:\n\s+clean: true", body) is not None,
}
failed = [name for name, ok in checks.items() if not ok]
for name, ok in checks.items():
    print(("PASS" if ok else "FAIL") + ": " + name)
if failed:
    raise SystemExit(1)
PY
