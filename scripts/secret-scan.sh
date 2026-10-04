#!/usr/bin/env bash
# Full-history scan. Only reviewed commit/path/rule/line fingerprints may be
# suppressed; changed secrets on the same fixture line have a new commit.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
[ "$#" -le 1 ] || { printf 'usage: secret-scan.sh [REPO]\n' >&2; exit 2; }
source="${1:-.}"
scanner="${GITLEAKS:-gitleaks}"
if ! shallow="$(git -C "$source" rev-parse --is-shallow-repository)"; then
  printf 'secret scan: UNMEASURED — not a repository\n' >&2; exit 2
fi
[ "$shallow" = false ] || { printf 'secret scan: UNMEASURED — shallow history\n' >&2; exit 2; }
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
: >"$work/empty-ignore"
rc=0
"$scanner" detect --source "$source" --config "$here/../.gitleaks.toml" \
  --gitleaks-ignore-path "$work/empty-ignore" --ignore-gitleaks-allow \
  --redact=100 --no-banner --report-format=json --report-path "$work/findings.json" || rc=$?
case "$rc" in
  0|1) ;;
  *) printf 'secret scan: UNMEASURED — scanner exit %s\n' "$rc" >&2; exit 2 ;;
esac
python3 "$here/gitleaks_fixtures.py" "$work/findings.json" \
  "$here/gitleaks-history-fixtures.json" >"$work/exact-ignore"
# Rescan with gitleaks' native exact-fingerprint ignore file. Unknown findings
# remain red; the first pass cannot report clean by classifying them as fixtures.
"$scanner" detect --source "$source" --config "$here/../.gitleaks.toml" \
  --gitleaks-ignore-path "$work/exact-ignore" --ignore-gitleaks-allow \
  --redact=100 --no-banner
