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

private_root="/paper""clip/"
public_paths=(
  'https://github.com/paperclipai/paperclip/actions'
  'paperclipai/paperclip/.github/x.yml'
  '  --signer-workflow paperclipai/paperclip/.github/x.yml'
  'req.url === https://api.github.com/repos/paperclipai/paperclip/x'
  'https://api.github.com/repos/paperclipai/paperclip/private-vulnerability-reporting'
  'https://example.com/paperclipai/paperclip/x'
  'https://github.com/someone/paperclip/x'
  'HTTPS://EXAMPLE.COM/PAPERCLIPAI/PAPERCLIP/X'
  'see paperclipai/paperclip/.github/workflows/ci.yml'
  'uses: paperclipai/paperclip/.github/a.yml@main # pinned'
  'cd /tmp && curl https://github.com/paperclipai/paperclip/actions'
  'https://example.com:8443/someone/paperclip/x'
  'r"https://github\.com/paperclipai/paperclip/actions/runs/[0-9]+"'
)
private_paths=(
  "DIR=${private_root}x"
  "x=\"${private_root}x\""
  "${private_root^^}x"
  "/var/log${private_root}x"
  "/home/node${private_root}x"
  "~${private_root}x"
  "\$HOME${private_root}x"
  "\${VAR:-${private_root}x}"
  "\${VAR:-${private_root}.github/x}"
  "file://${private_root}x"
  "ssh://host${private_root}x"
  "host:${private_root}x"
  "/paperclipai${private_root}x"
  "xgithub.com/paperclipai${private_root}x"
  "\$HOME/paperclipai${private_root}x"
  '~/repos/paperclipai/paper''clip/x'
  'x/repos/paperclipai/paper''clip/x'
  '/paperclipai/paper''clip/.github/x'
  'paperclipai/paper''clip/x'
  'paperclipai/paper''clip/x/paper''clip/y'
  'paperclipai/paperclip/.github/x /paper''clip/y'
  'https://github.com/paperclipai/paperclip/x /paper''clip/y'
  'https://github.com/paperclipai/paperclip/x/paper''clip/y'
  'https://example.com/paper''clip/x'
  'https://example.com/x /paper''clip/y'
  'git@github.com:paperclipai/paper''clip/x'
  'repo:paperclipai/paper''clip/x'
  "https://github.com/paperclipai/paperclip/x $tracker-1234"
  "https://example.com/paperclipai/paperclip/x/$tracker-9"
  'https://example.com/x/192.''168.0.9'
  '/Users/op/My Projects/paper''clip/.github/x'
  '~/My Projects/paper''clip/.github/x'
  '$HOME/My Projects/paper''clip/.github/x'
  '${HOME}/My Projects/paper''clip/.github/x'
  'DIR=/repos/op/paper''clip/instances/x'
  'host:/repos/op/paper''clip/instances/x'
  'cp /x /repos/op/paper''clip/instances/x'
  'workdir: /repos/op/paper''clip/instances/x'
  'cp /repos/op/paper''clip/instances/x'
  '`/Users/op/My Projects/paper''clip/.github/x`'
  '{/Users/op/My Projects/paper''clip/.github/x}'
  '`https://a.example/`/Users/op/My Projects/paper''clip/.github/x'
  'file:///Users/op/My Projects/paper''clip/.github/x'
  'vscode://file/Users/op/My Projects/paper''clip/.github/x'
  'ssh://host/srv/My Projects/paper''clip/.github/x'
  'file:///Users/op/My%20Projects/paper''clip/.github/x'
  'https://github.com/paperclipai/paperclip/x %paperclipai/paper''clip/.github/x'
  'uses: paperclipai/paper''clip/.github/a.yml@main # paperclipai/paper''clip/.github/b.yml'
  '-I/Users/op/My Projects/paper''clip/.github/include'
  'x_ssh://h/srv/My Projects/paper''clip/.github/x'
  'x_https://h/srv/My Projects/paper''clip/.github/x'
  '2file:///Users/op/My Projects/paper''clip/.github/x'
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa://h/Users/op/My Projects/paper''clip/.github/x'
  '--dir=op/paper''clip/.github/x'
  'https://100.100.1.2/op/paper''clip/x'
  'https://localhost/op/paper''clip/x'
  'https://a.b@100.100.1.2/op/paper''clip/x'
  'https://100.100.1.2:8443/op/paper''clip/x'
  'https://example.com/z,/Users/op/My Projects/paper''clip/.github/x'
  'https://github.com/paperclipai/paperclip/actions and paperclipai/paper''clip/.github/x.yml'
  'see https://x.y/z and paperclipai/paper''clip/.github/x.yml'
  'https://localhost/Users/op/My Projects/paper''clip/.github/x'
  'https://h.example/Users/op/My Projects/paper''clip/.github/x'
  'host:/Users/op/My Projects/paper''clip/.github/x'
)
i=0
for sample in "${public_paths[@]}"; do
  i=$((i+1)); d="$tmp/public$i"; mkdir -p "$d"; printf '%s\n' "$sample" >"$d/f.txt"
  expect "public namespace or URL sample $i passes" 0 bash "$scan" --no-git "$d"
done
i=0
for sample in "${private_paths[@]}"; do
  i=$((i+1)); d="$tmp/private$i"; mkdir -p "$d"; printf '%s\n' "$sample" >"$d/f.txt"
  expect "path-root or mixed sample $i is flagged" 1 bash "$scan" --no-git "$d"
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

mkdir -p "$tmp/whole/plugins" "$tmp/whole/docs" "$tmp/bare" "$tmp/leak/plugins" "$tmp/leak/docs"
git -C "$tmp/whole" init -q; git -C "$tmp/bare" init -q; git -C "$tmp/leak" init -q
printf 'plain prose\n' >"$tmp/whole/plugins/a.md"
printf 'plain prose\n' >"$tmp/whole/docs/b.md"
git -C "$tmp/whole" add -A
expect 'default root passes a clean whole tree' 0 env -C "$tmp/whole" bash "$scan"
expect 'default root refuses an empty tracked tree' 2 env -C "$tmp/bare" bash "$scan"
expect 'default root outside a repository refuses' 2 env -C "$tmp/outside" bash "$scan"
printf 'plain prose\n' >"$tmp/leak/plugins/a.md"
printf 'DIR=%s\n' "${private_root}x" >"$tmp/leak/docs/b.md"
git -C "$tmp/leak" add -A
expect 'default root fails a violation outside plugins' 1 env -C "$tmp/leak" bash "$scan"
expect 'default root from a subdirectory covers the whole tree' 1 env -C "$tmp/leak/plugins" bash "$scan"
expect 'explicit dot covers the whole tree' 1 env -C "$tmp/leak" bash "$scan" .

# Each population slice gets its own violation, so narrowing the enumeration to
# drop dot directories or root-level files turns exactly one control green.
for slice in dot root; do
  mkdir -p "$tmp/$slice/plugins" "$tmp/$slice/.github"
  git -C "$tmp/$slice" init -q
  printf 'plain prose\n' >"$tmp/$slice/plugins/a.md"
done
printf 'DIR=%s\n' "${private_root}x" >"$tmp/dot/.github/w.yml"
printf 'DIR=%s\n' "${private_root}x" >"$tmp/root/README.md"
git -C "$tmp/dot" add -A; git -C "$tmp/root" add -A
expect 'default root fails a violation in a dot directory' 1 env -C "$tmp/dot" bash "$scan"
expect 'default root fails a violation in a root-level file' 1 env -C "$tmp/root" bash "$scan"

# A corrupt index makes ls-files fail without shadowing git on PATH.
printf 'not an index\n' >"$tmp/corrupt-index"
expect 'Git enumeration failure refuses' 2 env -C "$tmp/repo" GIT_INDEX_FILE="$tmp/corrupt-index" bash "$scan" plugins

# A failing ls-files that already printed paths must not leave a clean-looking partial measurement.
expect 'Git failure after partial output refuses' 2 python3 - "$here/disclosure-scan.py" "$tmp/repo" <<'PY'
import importlib.util, os, subprocess, sys

spec = importlib.util.spec_from_file_location("scan", sys.argv[1])
scan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan)
real = subprocess.run


def run(cmd, **kwargs):
    if cmd[:2] == ["git", "ls-files"]:
        return subprocess.CompletedProcess(cmd, 1, stdout=b"plugins/a.md\0", stderr=b"")
    return real(cmd, **kwargs)


subprocess.run = run
os.chdir(sys.argv[2])
sys.exit(scan.main(["plugins"]))
PY

exit "$rc"
