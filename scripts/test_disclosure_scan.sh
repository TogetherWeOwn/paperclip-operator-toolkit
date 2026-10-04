#!/usr/bin/env bash
# Self-test for disclosure-scan.sh: every pattern must be able to fail the scan
# (a gate that cannot go red proves nothing) and a clean tree must pass.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
scan="$here/disclosure-scan.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
rc=0

expect() { # name want dir
  local got
  "$scan" --no-git "$3" >/dev/null 2>&1; got=$?
  if [ "$got" -ne "$2" ]; then echo "FAIL: $1 (want rc=$2, got rc=$got)"; rc=1; else echo "ok: $1"; fi
}

mkdir -p "$tmp/clean"; echo "plain prose and 192.0.2.7 documentation address" > "$tmp/clean/a.md"
expect "clean tree passes" 0 "$tmp/clean"

i=0
while IFS= read -r sample; do
  i=$((i+1)); d="$tmp/case$i"; mkdir -p "$d"; printf '%s\n' "$sample" > "$d/f.txt"
  expect "content sample $i is flagged" 1 "$d"
done <<'SAMPLES'
// see TOG-1234 for the design
refs PAP-77
blocked on CAP-061
host router.infextion.net
addr 10.1.2.3
addr 172.17.0.1
addr 192.168.0.9
path /paperclip/operator-handoff/x
~/secure-drop/key.env
SAMPLES

mkdir -p "$tmp/name"; echo ok > "$tmp/name/tog2438-evidence.mjs"
expect "file name with a tracker ID is flagged" 1 "$tmp/name"

exit $rc
