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

for line in \
  'ReadOnly=true' \
  'ReadOnlyTmpfs=false' \
  'Volume=%h/.local/share/paperclip:/paperclip:Z' \
  'Tmpfs=/tmp:rw,nosuid,nodev,noexec,size=4g,mode=1777' \
  'Tmpfs=/run:rw,nosuid,nodev,noexec,size=64m,mode=0755' \
  'NoNewPrivileges=true' \
  'DropCapability=all'
do
  assert_contains "$CARRIER" "$line"
done

grep -Eq '^Image=[^[:space:]]+@sha256:' "$CARRIER" || fail 'server image is not digest-shaped'
if grep -Eq '^Volume=.*:/app([:,]|$)' "$CARRIER"; then
  fail 'server carrier overlays immutable /app with a writable volume'
fi

for line in \
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
  'ReadOnly=/app' \
  'KillMode=control-group'
do
  assert_contains "$RUN_CARRIER" "$line"
done
if grep -Eq '^Volume=.*:/paperclip([:,]|$)' "$RUN_CARRIER"; then
  fail 'agent carrier mounts live Paperclip state'
fi

fixture=${PAPERCLIP_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}/paperclip-immutable-fixture-$$}
fixture="$fixture/immutable-runtime-test"
rm -rf "$fixture"
mkdir -p "$fixture/source/app" "$fixture/mount/app" "$fixture/run/workspace"
printf 'baseline\n' > "$fixture/source/app/target"
printf '{"name":"fixture","version":"1.0.0"}\n' > "$fixture/run/workspace/package.json"
printf '#!/bin/sh\nprintf invoked > "$MUTATION_SENTINEL"\nexit 99\n' > "$fixture/run/fake-npm"
chmod 0755 "$fixture/run/fake-npm"

before=$(sha256sum "$fixture/source/app/target" | cut -d' ' -f1)
export FIXTURE_SOURCE="$fixture/source/app"
export FIXTURE_MOUNT="$fixture/mount/app"
export FIXTURE_RUN="$fixture/run"

unshare -Urnm bash <<'NS'
set -euo pipefail
mount --bind "$FIXTURE_SOURCE" "$FIXTURE_MOUNT"
mount -o remount,bind,ro "$FIXTURE_MOUNT"

expect_denied() {
  local name=$1
  shift
  if "$@" >"$FIXTURE_RUN/$name.stdout" 2>"$FIXTURE_RUN/$name.stderr"; then
    printf '%s unexpectedly succeeded\n' "$name" >&2
    exit 1
  fi
  printf '%s=denied\n' "$name"
}

expect_denied write sh -c 'printf changed > "$1/target"' sh "$FIXTURE_MOUNT"
expect_denied remove rm "$FIXTURE_MOUNT/target"
expect_denied rename mv "$FIXTURE_MOUNT/target" "$FIXTURE_MOUNT/moved"
expect_denied hardlink ln "$FIXTURE_MOUNT/target" "$FIXTURE_MOUNT/link"
expect_denied symlink ln -s "$FIXTURE_RUN/workspace/package.json" "$FIXTURE_MOUNT/escape"
expect_denied chmod chmod 0600 "$FIXTURE_MOUNT/target"
expect_denied chown chown 65534:65534 "$FIXTURE_MOUNT/target"

export MUTATION_SENTINEL="$FIXTURE_RUN/package-manager-reached"
expect_denied package-manager sh -c 'test -w "$1" || exit 73; cd "$1"; exec "$2" install --ignore-scripts' sh "$FIXTURE_MOUNT" "$FIXTURE_RUN/fake-npm"
test ! -e "$MUTATION_SENTINEL"

test -w "$FIXTURE_RUN/workspace"
printf normal > "$FIXTURE_RUN/workspace/output"
mkdir -p "$FIXTURE_RUN/cache/npm" "$FIXTURE_RUN/store/pnpm" "$FIXTURE_RUN/dependencies"
printf cache > "$FIXTURE_RUN/cache/npm/entry"
printf store > "$FIXTURE_RUN/store/pnpm/entry"
printf dependency > "$FIXTURE_RUN/dependencies/entry"
NS

after=$(sha256sum "$fixture/source/app/target" | cut -d' ' -f1)
[ "$before" = "$after" ] || fail 'deployed fixture changed despite denials'
[ "$(cat "$fixture/source/app/target")" = baseline ] || fail 'deployed fixture content changed'
[ ! -e "$fixture/source/app/moved" ] || fail 'rename created a deployed artifact'
[ ! -e "$fixture/source/app/link" ] || fail 'link created a deployed artifact'
[ ! -e "$fixture/source/app/escape" ] || fail 'symlink created a deployed artifact'
[ ! -e "$fixture/run/package-manager-reached" ] || fail 'package manager ran after preflight denial'
[ "$(cat "$fixture/run/workspace/output")" = normal ] || fail 'normal isolated workspace write failed'
[ "$(cat "$fixture/run/cache/npm/entry")" = cache ] || fail 'run-owned npm cache write failed'
[ "$(cat "$fixture/run/store/pnpm/entry")" = store ] || fail 'run-owned pnpm store write failed'
[ "$(cat "$fixture/run/dependencies/entry")" = dependency ] || fail 'run-owned dependency write failed'

printf 'PASS: immutable fixture denied write/rm/rename/link/chmod/chown/package-manager before mutation\n'
printf 'PASS: run-owned workspace/cache/store/dependency writes succeeded\n'
