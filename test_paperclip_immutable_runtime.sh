#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CARRIER="$ROOT/deploy/paperclip-immutable/paperclip.container"
RUN_CARRIER="$ROOT/deploy/paperclip-immutable/agent-run.container.in"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_contains() {
  local file=$1 expected=$2
  grep -Fqx "$expected" "$file" || fail "$file lacks exact line: $expected"
}
assert_count() {
  local file=$1 expected=$2 pattern=$3 actual
  actual=$(grep -Ec "$pattern" "$file" || true)
  [ "$actual" -eq "$expected" ] || fail "$file count for $pattern is $actual, expected $expected"
}

for line in \
  'Network=paperclip.network' \
  'ReadOnly=true' \
  'ReadOnlyTmpfs=false' \
  'Volume=%h/.local/share/paperclip:/paperclip:Z' \
  'Tmpfs=/tmp:rw,nosuid,nodev,noexec,size=24g,mode=1777' \
  'Tmpfs=/run:rw,nosuid,nodev,noexec,size=64m,mode=0755' \
  'NoNewPrivileges=true' \
  'DropCapability=all'
do
  assert_contains "$CARRIER" "$line"
done
assert_count "$CARRIER" 1 '^ReadOnly=true$'
assert_count "$CARRIER" 0 '^ReadOnly=/'
assert_count "$CARRIER" 0 '^Pod='
grep -Eq '^Image=[^[:space:]]+@sha256:' "$CARRIER" || fail 'server image is not digest-shaped'
if grep -Eq '^Volume=.*:/app([:,]|$)' "$CARRIER"; then
  fail 'server carrier overlays immutable /app with a writable volume'
fi

for line in \
  'Network=none' \
  'ReadOnly=true' \
  'ReadOnlyTmpfs=false' \
  'User=@RUN_UID@:@RUN_GID@' \
  'Volume=@RUN_ROOT@:/run/paperclip-run:rw,Z' \
  'Volume=@WORKSPACE@:/workspace:rw,Z' \
  'Environment=HOME=/run/paperclip-run/home' \
  'Environment=TMPDIR=/tmp' \
  'Environment=XDG_CACHE_HOME=/run/paperclip-run/cache' \
  'Environment=npm_config_cache=/run/paperclip-run/cache/npm' \
  'Environment=npm_config_prefix=/run/paperclip-run/dependencies/npm-prefix' \
  'Environment=PNPM_STORE_DIR=/run/paperclip-run/store/pnpm' \
  'NoNewPrivileges=true' \
  'DropCapability=all' \
  'KillMode=control-group'
do
  assert_contains "$RUN_CARRIER" "$line"
done
assert_count "$RUN_CARRIER" 1 '^ReadOnly=true$'
assert_count "$RUN_CARRIER" 0 '^ReadOnly=/'
if grep -Eq '^Volume=.*:/paperclip([:,]|$)' "$RUN_CARRIER"; then
  fail 'agent carrier mounts live Paperclip state'
fi

# These sanitized authoritative ExecStart fixtures reproduce the Podman 4.9.3/systemd 255
# generated shape recorded by TOG-654. TOG-657 owns revised-carrier host generation.
server_exec='podman run --name paperclip --network paperclip.network --read-only --read-only-tmpfs=false --volume %h/.local/share/paperclip:/paperclip:Z --tmpfs /tmp:rw,nosuid,nodev,noexec,size=24g,mode=1777 --tmpfs /run:rw,nosuid,nodev,noexec,size=64m,mode=0755 --cap-drop all --security-opt no-new-privileges'
run_exec='podman run --name paperclip-run-run-a --network none --read-only --read-only-tmpfs=false --user 61111:61112 --volume /run/paperclip-runs/run-a:/run/paperclip-run:rw,Z --volume /run/paperclip-runs/run-a/workspace:/workspace:rw,Z --cap-drop all --security-opt no-new-privileges'
for exec_start in "$server_exec" "$run_exec"; do
  [ "$(grep -oE -- '(^|[[:space:]])--read-only([[:space:]]|$)' <<<"$exec_start" | wc -l)" -eq 1 ] || fail 'generated ExecStart lacks exactly one whole-root --read-only'
  ! grep -q -- '--read-only=false' <<<"$exec_start" || fail 'generated ExecStart contains fail-open --read-only=false'
done
grep -Fq -- '--network paperclip.network' <<<"$server_exec" || fail 'server ExecStart lacks host-compatible network'
grep -Fq -- '--tmpfs /tmp:rw,nosuid,nodev,noexec,size=24g,mode=1777' <<<"$server_exec" || fail 'server ExecStart lacks measured /tmp sizing'
grep -Fq -- '--network none' <<<"$run_exec" || fail 'run ExecStart is not network-isolated'

fixture=${PAPERCLIP_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}/paperclip-immutable-fixture-$$}
fixture="$fixture/immutable-runtime-test"
rm -rf "$fixture"
mkdir -p "$fixture/source/app/dir" "$fixture/mount/app" "$fixture/run/workspace"
printf 'baseline\n' > "$fixture/source/app/target"
printf 'nested\n' > "$fixture/source/app/dir/nested"
ln -s dir/nested "$fixture/source/app/link"
chmod 0644 "$fixture/source/app/target"
chmod 0755 "$fixture/source/app/dir"
printf '{"name":"fixture","version":"1.0.0"}\n' > "$fixture/run/workspace/package.json"
printf '#!/bin/sh\nprintf invoked > "$MUTATION_SENTINEL"\nexit 99\n' > "$fixture/run/fake-npm"
chmod 0755 "$fixture/run/fake-npm"

manifest_tree() {
  local tree=$1 output=$2
  python3 - "$tree" >"$output" <<'PY'
import hashlib
import json
import os
import stat
import sys
from pathlib import Path

root = Path(sys.argv[1])
rows = []
for path in sorted([root, *root.rglob("*")], key=lambda item: os.fsencode(str(item.relative_to(root)))):
    info = path.lstat()
    relative = "." if path == root else str(path.relative_to(root))
    kind = (
        "file" if stat.S_ISREG(info.st_mode) else
        "directory" if stat.S_ISDIR(info.st_mode) else
        "symlink" if stat.S_ISLNK(info.st_mode) else
        "other"
    )
    digest = None
    target = None
    if kind == "file":
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
    elif kind == "symlink":
        target = os.readlink(path)
    rows.append({
        "path": relative,
        "type": kind,
        "mode": f"{stat.S_IMODE(info.st_mode):04o}",
        "uid": info.st_uid,
        "gid": info.st_gid,
        "linkTarget": target,
        "sha256": digest,
    })
print(json.dumps(rows, sort_keys=True, separators=(",", ":")))
PY
}

manifest_tree "$fixture/source/app" "$fixture/before.manifest.json"
export FIXTURE_SOURCE="$fixture/source/app"
export FIXTURE_MOUNT="$fixture/mount/app"
export FIXTURE_RUN="$fixture/run"

unshare -Urnm bash <<'NS'
set -euo pipefail
mount --bind "$FIXTURE_SOURCE" "$FIXTURE_MOUNT"
mount -o remount,bind,ro "$FIXTURE_MOUNT"

manifest_tree() {
  local tree=$1 output=$2
  python3 - "$tree" >"$output" <<'PY'
import hashlib, json, os, stat, sys
from pathlib import Path
root = Path(sys.argv[1])
rows = []
for path in sorted([root, *root.rglob("*")], key=lambda item: os.fsencode(str(item.relative_to(root)))):
    info = path.lstat()
    relative = "." if path == root else str(path.relative_to(root))
    kind = "file" if stat.S_ISREG(info.st_mode) else "directory" if stat.S_ISDIR(info.st_mode) else "symlink" if stat.S_ISLNK(info.st_mode) else "other"
    rows.append({"path": relative, "type": kind, "mode": f"{stat.S_IMODE(info.st_mode):04o}", "uid": info.st_uid, "gid": info.st_gid, "linkTarget": os.readlink(path) if kind == "symlink" else None, "sha256": hashlib.sha256(path.read_bytes()).hexdigest() if kind == "file" else None})
print(json.dumps(rows, sort_keys=True, separators=(",", ":")))
PY
}

expect_denied_unchanged() {
  local name=$1
  shift
  if "$@" >"$FIXTURE_RUN/$name.stdout" 2>"$FIXTURE_RUN/$name.stderr"; then
    printf '%s unexpectedly succeeded\n' "$name" >&2
    exit 1
  fi
  manifest_tree "$FIXTURE_MOUNT" "$FIXTURE_RUN/$name.manifest.json"
  cmp "$FIXTURE_RUN/baseline.manifest.json" "$FIXTURE_RUN/$name.manifest.json"
  printf '%s=denied-and-manifest-identical\n' "$name"
}

manifest_tree "$FIXTURE_MOUNT" "$FIXTURE_RUN/baseline.manifest.json"
expect_denied_unchanged write sh -c 'printf changed > "$1/target"' sh "$FIXTURE_MOUNT"
expect_denied_unchanged remove rm "$FIXTURE_MOUNT/target"
expect_denied_unchanged rename mv "$FIXTURE_MOUNT/target" "$FIXTURE_MOUNT/moved"
expect_denied_unchanged hardlink ln "$FIXTURE_MOUNT/target" "$FIXTURE_MOUNT/new-hardlink"
expect_denied_unchanged symlink ln -s "$FIXTURE_RUN/workspace/package.json" "$FIXTURE_MOUNT/escape"
expect_denied_unchanged chmod chmod 0600 "$FIXTURE_MOUNT/target"
expect_denied_unchanged chown chown 65534:65534 "$FIXTURE_MOUNT/target"

export MUTATION_SENTINEL="$FIXTURE_RUN/package-manager-reached"
expect_denied_unchanged package-manager sh -c 'test -w "$1" || exit 73; cd "$1"; exec "$2" install --ignore-scripts' sh "$FIXTURE_MOUNT" "$FIXTURE_RUN/fake-npm"
test ! -e "$MUTATION_SENTINEL"
NS

manifest_tree "$fixture/source/app" "$fixture/after.manifest.json"
cmp "$fixture/before.manifest.json" "$fixture/after.manifest.json"
[ ! -e "$fixture/run/package-manager-reached" ] || fail 'package manager ran after preflight denial'

# Distinct-UID handoff fixture: a user namespace maps fixture uid/gid 0 to host uid/gid,
# while the run executes as mapped 61111:61112. The launcher creates, chowns, and seals
# every mutable directory before the guard validates the ownership artifact.
export GUARD="$ROOT/scripts/paperclip_run_path_guard.py"
export ORIGINAL_FIXTURE_RUN="$FIXTURE_RUN"
run_base="$ORIGINAL_FIXTURE_RUN/distinct-uid/run/paperclip-runs"
run_root="$run_base/run-a"
run_uid=61111
run_gid=61112
run_host_uid=$(id -u)
run_host_gid=$(id -g)
install -d -m 0700 "$run_root"
printf '{"version":1,"runId":"run-a"}\n' >"$run_root/.paperclip-run-scratch.json"
chmod 0600 "$run_root/.paperclip-run-scratch.json"
for path in workspace dependencies cache store tmp; do
  install -d -m 0700 "$run_root/$path"
done
python3 - "$run_root" "$run_uid" "$run_gid" "$run_host_uid" "$run_host_gid" >"$run_root/.paperclip-run-ownership.json" <<'PY'
import json, sys
root, uid, gid, host_uid, host_gid = sys.argv[1], *map(int, sys.argv[2:])
print(json.dumps({"version": 1, "runId": "run-a", "runUid": uid, "runGid": gid, "runHostUid": host_uid, "runHostGid": host_gid, "paths": {"workspace": f"{root}/workspace", "dependencyRoot": f"{root}/dependencies", "cacheRoot": f"{root}/cache", "storeRoot": f"{root}/store", "tmpRoot": f"{root}/tmp"}}, sort_keys=True))
PY
chmod 0600 "$run_root/.paperclip-run-ownership.json"
python3 - "$GUARD" "$run_base" "$run_root" "$run_uid" "$run_gid" "$run_host_uid" "$run_host_gid" \
  >"$ORIGINAL_FIXTURE_RUN/distinct-uid-guard.json" <<'PY'
import importlib.util
import json
import sys
from pathlib import Path
module_path, run_base, run_root, run_uid, run_gid, host_uid, host_gid = sys.argv[1:]
spec = importlib.util.spec_from_file_location("paperclip_run_path_guard", module_path)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
root = Path(run_root)
paths = {"workspace": root / "workspace", "dependencyRoot": root / "dependencies", "cacheRoot": root / "cache", "storeRoot": root / "store", "tmpRoot": root / "tmp"}
result = module.validate_paths(run_root=root, run_id="run-a", run_uid=int(run_uid), run_gid=int(run_gid), run_host_uid=int(host_uid), run_host_gid=int(host_gid), mutable_paths=paths, required_run_base=Path(run_base), live_state_root=Path(run_base).parent / "paperclip")
print(json.dumps({"decision": "allow", "runId": "run-a", "paths": result}, sort_keys=True))
PY
export DISTINCT_RUN_ROOT="$run_root"
unshare --map-user="$run_uid" --map-group="$run_gid" sh -ceu '
  test "$(id -u):$(id -g)" = "61111:61112"
  printf workspace >"$DISTINCT_RUN_ROOT/workspace/output"
  printf cache >"$DISTINCT_RUN_ROOT/cache/output"
  printf store >"$DISTINCT_RUN_ROOT/store/output"
  printf dependency >"$DISTINCT_RUN_ROOT/dependencies/output"
  printf tmp >"$DISTINCT_RUN_ROOT/tmp/output"
'
test "$(cat "$run_root/workspace/output")" = workspace
test "$(cat "$run_root/cache/output")" = cache
test "$(cat "$run_root/store/output")" = store
test "$(cat "$run_root/dependencies/output")" = dependency
test "$(cat "$run_root/tmp/output")" = tmp
rm -rf "$run_base"

printf 'PASS: carrier source and authoritative ExecStart fixtures have exactly one whole-root read-only setting\n'
printf 'PASS: every negative mutation preserved the complete path/type/mode/uid/gid/link/content manifest\n'
printf 'PASS: launcher ownership handoff enabled distinct-UID workspace/cache/store/dependency/tmp writes\n'
