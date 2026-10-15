#!/usr/bin/env bash
# discover-repos.sh — dynamic org repo discovery minus the one exclude list
# (TOG-24386). Host scripts read repos from here, never from a hardcoded list.
#
# Usage:
#   discover-repos.sh [--exclude-file PATH] [--org NAME] [--json]
#
# Inputs: live `gh repo list` (needs `gh` authenticated), minus the entries in
# repo-exclude-list.txt (`#` comments and blanks ignored, trailing `*` is a
# prefix glob). Offline/test seam: GH_REPO_LIST_FIXTURE points at a file with
# one `owner/repo` per line and no `gh` call happens.
#
# Output: one `owner/repo` per line (default), or a JSON array with --json.
# Read-only: lists names, touches nothing. No credentials printed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORG="TogetherWeOwn"
EXCLUDE_FILE="$HERE/repo-exclude-list.txt"
JSON_OUT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --exclude-file) EXCLUDE_FILE="$2"; shift 2 ;;
    --org) ORG="$2"; shift 2 ;;
    --json) JSON_OUT=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "discover-repos: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

[[ -f "$EXCLUDE_FILE" ]] || { echo "discover-repos: exclude file missing: $EXCLUDE_FILE" >&2; exit 2; }

if [[ -n "${GH_REPO_LIST_FIXTURE:-}" ]]; then
  [[ -f "$GH_REPO_LIST_FIXTURE" ]] || { echo "discover-repos: fixture missing: $GH_REPO_LIST_FIXTURE" >&2; exit 2; }
  mapfile -t REPOS < "$GH_REPO_LIST_FIXTURE"
else
  command -v gh >/dev/null || { echo "discover-repos: gh required (or set GH_REPO_LIST_FIXTURE)" >&2; exit 2; }
  mapfile -t REPOS < <(gh repo list "$ORG" --limit 1000 --json nameWithOwner --jq '.[].nameWithOwner')
fi

[[ "${#REPOS[@]}" -gt 0 ]] || { echo "discover-repos: measured zero repos — refusing to report an empty org (fail closed)" >&2; exit 2; }

mapfile -t PATTERNS < <(grep -vE '^\s*(#|$)' "$EXCLUDE_FILE" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

OUT=()
for entry in "${REPOS[@]}"; do
  name="${entry#*/}"
  skip=0
  for pat in "${PATTERNS[@]}"; do
    # Patterns are validated names with an optional trailing glob; match
    # with a case glob so `replay-*` cannot become a regex surprise.
    case "$name" in
      $pat) skip=1; break ;;
    esac
  done
  [[ "$skip" == 0 ]] && OUT+=("$entry")
done

if [[ "$JSON_OUT" == 1 ]]; then
  printf '['; sep=""
  for r in "${OUT[@]}"; do printf '%s"%s"' "$sep" "$r"; sep=","; done
  printf ']\n'
else
  printf '%s\n' "${OUT[@]}"
fi
