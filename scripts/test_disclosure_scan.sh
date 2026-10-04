#!/usr/bin/env bash
# Each detector must go red; incomplete measurements must never report clean.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
scan="$here/disclosure-scan.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
rc=0

expect() { # name want command...
  local name="$1" want="$2" got; shift 2
  "$@" >"$tmp/output" 2>&1; got=$?
  if [ "$got" -ne "$want" ]; then
    printf 'FAIL: %s (want rc=%s, got rc=%s)\n' "$name" "$want" "$got"
    rc=1
  elif [ "$want" -ne 0 ] && grep -q 'disclosure scan: clean' "$tmp/output"; then
    printf 'FAIL: %s reports clean after failure\n' "$name"
    rc=1
  else
    printf 'ok: %s\n' "$name"
  fi
}

mkdir -p "$tmp/clean" "$tmp/empty"
printf '%s\n' 'plain prose and 192.0.2.7 documentation address' \
  'T1CAP080 is a policy threshold, not a joined issue identifier' >"$tmp/clean/a.md"
expect 'clean tree passes' 0 bash "$scan" --no-git "$tmp/clean"
expect 'missing root refuses' 2 bash "$scan" --no-git "$tmp/missing"
expect 'empty directory refuses' 2 bash "$scan" --no-git "$tmp/empty"
expect 'file instead of directory refuses' 2 bash "$scan" --no-git "$tmp/clean/a.md"
expect 'extra plain-directory arguments refuse' 2 bash "$scan" --no-git "$tmp/clean" ignored

# Compose tracker controls so the test itself is safe to publish and scan.
tracker='TO''G'; other='PA''P'; capability='CA''P'
samples=(
  "// see $tracker-1234 for the design"
  "refs $other-77"
  "blocked on $capability-061"
  "${tracker,,}2138-decision-v1"
  "ops/${tracker,,}-2138/gate_harness.py"
  "embedded_${other,,}77_suffix"
  'host router.infextion'".net"
  'addr 10.'"1.2.3"
  'addr 172.'"17.0.1"
  'addr 192.'"168.0.9"
  'path /paper'"clip/operator"'-handoff/x'
  '~/secure'"-drop/key.env"
)
i=0
for sample in "${samples[@]}"; do
  i=$((i+1)); d="$tmp/case$i"; mkdir -p "$d"; printf '%s\n' "$sample" >"$d/f.txt"
  expect "content sample $i is flagged" 1 bash "$scan" --no-git "$d"
done

mkdir -p "$tmp/name" "$tmp/lock" "$tmp/link" "$tmp/unreadable"
printf 'ok\n' >"$tmp/name/${tracker,,}2438-evidence.mjs"
printf '{"reference":"%s-12"}\n' "$other" >"$tmp/lock/package-lock.json"
ln -s "$tmp/clean/a.md" "$tmp/link/a.md"
printf 'plain prose\n' >"$tmp/unreadable/a.md"
chmod 000 "$tmp/unreadable/a.md"
expect 'tracker-bearing filename is flagged' 1 bash "$scan" --no-git "$tmp/name"
expect 'lockfile content is scanned' 1 bash "$scan" --no-git "$tmp/lock"
expect 'symlink coverage refuses' 2 bash "$scan" --no-git "$tmp/link"
expect 'unreadable file refuses' 2 bash "$scan" --no-git "$tmp/unreadable"
chmod 600 "$tmp/unreadable/a.md"

mkdir -p "$tmp/repo/plugins" "$tmp/outside"
git -C "$tmp/repo" init -q
printf 'plain prose\n' >"$tmp/repo/plugins/a.md"
git -C "$tmp/repo" add plugins/a.md
expect 'tracked clean tree passes' 0 env -C "$tmp/repo" bash "$scan" plugins
expect 'Git mode outside repository refuses' 2 env -C "$tmp/outside" bash "$scan" .
expect 'missing tracked root refuses' 2 env -C "$tmp/repo" bash "$scan" missing
mkdir "$tmp/repo/untracked"
printf 'plain prose\n' >"$tmp/repo/untracked/a.md"
expect 'zero tracked coverage refuses' 2 env -C "$tmp/repo" bash "$scan" untracked
printf '{"reference":"%s-12"}\n' "$other" >"$tmp/repo/plugins/package-lock.json"
git -C "$tmp/repo" add plugins/package-lock.json
expect 'tracked lockfile is scanned' 1 env -C "$tmp/repo" bash "$scan" plugins

mkdir "$tmp/bin"
real_git="$(command -v git)"
cat >"$tmp/bin/git" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = 'ls-files' ]; then exit 128; fi
exec "$REAL_GIT" "$@"
STUB
chmod +x "$tmp/bin/git"
expect 'Git enumeration failure refuses' 2 env -C "$tmp/repo" PATH="$tmp/bin:$PATH" REAL_GIT="$real_git" bash "$scan" plugins

exit "$rc"
