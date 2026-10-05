#!/usr/bin/env bash
# Read-only guard for NEW retired static labels, not a fleet reconfiguration.
# Complete before/after workflow selectors are compared per job, so editing a
# block item cannot lose an unchanged runs-on key. Existing usage is grandfathered.
# Denylist: two-selfhosted / two-isolated (retired static-fleet labels).
# Usage: bash scripts/ci_no_new_static_labels.sh <base> [head]
#    or: bash scripts/ci_no_new_static_labels.sh --event
# Event mode reads GITHUB_EVENT_PATH: PR merge-base, push before/after, merge_group.
# Missing/zero push baselines fail closed. Check out with fetch-depth: 0.
# Requires Python 3 + PyYAML. Exit 0 clean, 1 violation, 2 unmeasurable.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec "${STATIC_LABEL_PYTHON:-python3}" "$ROOT/ci_no_new_static_labels.py" "$@"
