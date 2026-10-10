#!/usr/bin/env bash
# Exit 0 measured clean, 1 findings, 2 usage error or incomplete measurement.
# Git mode scans tracked files under ROOT... (default: the whole tracked tree).
# --no-git DIR scans one plain directory. Neither mode exempts lockfiles.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$here/disclosure-scan.py" "$@"
