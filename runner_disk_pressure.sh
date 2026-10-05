#!/usr/bin/env bash
# Read-only filesystem-pressure detector; all site policy is explicit.
#
# Measure: ./runner_disk_pressure.sh --config /absolute/policy.json --json
# Propose: add --propose --dedupe-file /absolute/existing-keys.json
# Proposals go to stdout only. This command never deletes, repairs, posts,
# acknowledges, or persists a dedupe key. It does not select runner labels.
#
# Policy (regular local file, owned by root/current uid, not group/other
# writable; symlink files refused), with no omitted-key policy fallback:
# {"schema_version":1,"scope":"example","targets":[{"id":"volume-a",
#   "path":"/example/data","warn_pct":80,"crit_pct":90}],"runner_roots":[]}
# Dedupe snapshot: {"schema_version":1,"existing_keys":[]} (explicitly empty
# is valid; absent/unreadable/malformed is not). Keys are SHA-256 hex strings.
# Config trust is a local uid/file-mode boundary, not independent approval.
#
# Exit 0: ALL explicit targets measured below warning.
# Exit 1: at least one measured target at warning/critical, ALL measured.
# Exit 2: refused/inconclusive, including partial measurement coverage.
# Dedupe and optional corroborating du never turn pressure into health.
# DF_BIN / DU_BIN are explicit trusted executable test hooks, not policy.
# Requires Bash, Python 3, and POSIX-table-capable df/du (GNU -k/-x options).
set -euo pipefail
HERE="${BASH_SOURCE[0]%/*}"
[[ "$HERE" != "${BASH_SOURCE[0]}" ]] || HERE=.
exec python3 -B "$HERE/lib/runner_disk_pressure.py" "$@"
