#!/usr/bin/env bash
# Public-tree disclosure scan: fails when a tracked file under the given roots
# (default: plugins) carries an internal tracker ID, an internal hostname, a
# private address or a host-local path. File NAMES are scanned too.
#
# Usage: scripts/disclosure-scan.sh [--no-git DIR]... | [ROOT]...
#   ROOT...          tracked paths to scan with `git grep` / `git ls-files`
#   --no-git DIR     scan a plain directory (used by the self-test)
#
# Exit 0 clean, 1 findings, 2 usage error. Package lockfiles are excluded: they
# carry integrity hashes and registry URLs, never prose.
set -uo pipefail

# Content patterns (extended regex). Keep in sync with the self-test below.
CONTENT_PATTERNS=(
  '\b(TOG|PAP|CAP|LOOA)-[0-9]+\b'
  'infextion\.net'
  '\b10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b'
  '\b172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}\b'
  '\b192\.168\.[0-9]{1,3}\.[0-9]{1,3}\b'
  '/paperclip/'
  'secure-drop'
  'operator-handoff'
)
NAME_PATTERN='(TOG|PAP)-?[0-9]+'

join() { local IFS='|'; echo "$*"; }
CONTENT_RE="$(join "${CONTENT_PATTERNS[@]}")"
fail=0

scan_git() {
  local roots=("$@")
  if git grep -nIE "$CONTENT_RE" -- "${roots[@]}" ':!*package-lock.json'; then fail=1; fi
  if git ls-files -- "${roots[@]}" | grep -Ei "$NAME_PATTERN"; then
    echo "scan: file name carries a tracker ID (above)" >&2
    fail=1
  fi
}

scan_dir() {
  local dir="$1"
  if grep -rnIE "$CONTENT_RE" "$dir" --exclude=package-lock.json; then fail=1; fi
  if (cd "$dir" && find . -type f) | grep -Ei "$NAME_PATTERN"; then
    echo "scan: file name carries a tracker ID (above)" >&2
    fail=1
  fi
}

if [ "${1:-}" = "--no-git" ]; then
  [ -n "${2:-}" ] || { echo "usage: --no-git DIR" >&2; exit 2; }
  scan_dir "$2"
else
  [ "$#" -gt 0 ] || set -- plugins
  scan_git "$@"
fi

if [ "$fail" -ne 0 ]; then
  echo "disclosure scan: FAIL — remove the internal references listed above" >&2
  exit 1
fi
echo "disclosure scan: clean"
