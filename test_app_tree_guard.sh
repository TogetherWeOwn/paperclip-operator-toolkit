#!/usr/bin/env bash
# Hermetic tests for app_tree_guard.sh.
#
# No network, and -- importantly -- NO DEPENDENCE ON THE REAL /app. Every test
# builds a throwaway fixture tree and points the SUT at it via
# APP_TREE_GUARD_APP. A test that asserted against the live deployed tree would
# pass or fail based on whatever another run happened to be doing at the time,
# and would mutate deployed state to prove that mutation is blocked.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$HERE/app_tree_guard.sh"
pass=0; fail=0
ok(){ pass=$((pass+1)); echo "  ok   - $1"; }
no(){ fail=$((fail+1)); echo "  FAIL - $1"; }

STAGE="$(mktemp -d)"; trap 'chmod -R u+w "$STAGE" 2>/dev/null; rm -rf "$STAGE"' EXIT

# Skip the enforcing tests -- not the whole file -- when the kernel will not give
# us an unprivileged user namespace. Reporting "0 failed" on a box that cannot
# run the control would be a check that measured nothing.
USERNS=1
command -v unshare >/dev/null 2>&1 || USERNS=0
[ "$USERNS" = 1 ] && { unshare --mount --map-root-user true >/dev/null 2>&1 || USERNS=0; }

# --- fixture -----------------------------------------------------------------
# Mimics the deployed tree's shape: a dist entrypoint, live-executed workspace
# source, a dependency tree, manifests, and a vite cache dir.
mkfixture(){
  local app="$1"
  mkdir -p "$app"/{server/dist,server/node_modules/.vite,node_modules/.vite} \
           "$app"/packages/adapter-utils/src/acpx-engine \
           "$app"/packages/adapters/claude-local/src "$app"/cli
  echo 'console.log("server")'      > "$app/server/dist/index.js"
  echo 'export const x = 1'         > "$app/packages/adapter-utils/src/acpx-engine/execute.ts"
  echo 'export const y = 1'         > "$app/packages/adapters/claude-local/src/index.ts"
  echo 'deps: {}'                   > "$app/node_modules/.modules.yaml"
  echo '{"name":"paperclip"}'       > "$app/package.json"
  echo 'lockfileVersion: 9'         > "$app/pnpm-lock.yaml"
  echo '{"name":"cli"}'             > "$app/cli/package.json"
  # Image-extracted files carry whole-second mtimes; the drift detector keys on
  # exactly that. Stamp the fixture the way `tar -x` would.
  find "$app" -exec touch -d '2026-08-18 03:23:05' {} +
}

# ============================================================================
echo "[audit]"
# ============================================================================
APP="$STAGE/app1"; mkfixture "$APP"

out=$(APP_TREE_GUARD_APP="$APP" "$SUT" --audit 2>&1); rc=$?
grep -q "agent-writable deployed paths: 7 of 7" <<<"$out" \
  && ok "audit reports every fixture path writable when unguarded" \
  || no "audit writable count (got: $(grep -m1 writable <<<"$out"))"
grep -q "modified since image build: 0" <<<"$out" \
  && ok "clean fixture reports zero drift" || no "clean fixture drift != 0"
[ "$rc" = 1 ] && ok "audit exits 1 while the tree is mutable" || no "audit exit=$rc (want 1)"

# Drift must key on nanosecond granularity, not on a timestamp threshold. A file
# written NOW gets a real ns clock; a file backdated with whole seconds does not.
printf 'tampered\n' > "$APP/server/dist/index.js"
out=$(APP_TREE_GUARD_APP="$APP" "$SUT" --audit 2>&1)
grep -q "DRIFT     server/dist/index.js" <<<"$out" \
  && ok "a runtime write is reported as drift" || no "runtime write not detected"

# The bug the first draft had: build artifacts newer than the tree's own mtime
# must NOT be reported. Add a whole-second-stamped file dated AFTER the others.
touch -d '2026-08-18 03:25:00' "$APP/server/dist/late-build-artifact.js"
out=$(APP_TREE_GUARD_APP="$APP" "$SUT" --audit 2>&1)
grep -q "late-build-artifact" <<<"$out" \
  && no "whole-second build artifact wrongly reported as drift" \
  || ok "later-but-whole-second build artifact is not drift"

# JSON shape
out=$(APP_TREE_GUARD_APP="$APP" "$SUT" --audit --json 2>&1)
node -e '
  const j=JSON.parse(require("fs").readFileSync(0,"utf8"));
  if(typeof j.agentWritable!=="number") throw new Error("agentWritable");
  if(!Array.isArray(j.drift)) throw new Error("drift");
  if(!j.drift.includes("server/dist/index.js")) throw new Error("drift content");
' <<<"$out" 2>/dev/null && ok "--json emits parseable audit with drift list" || no "--json shape"

# ============================================================================
echo "[selftest baseline]"
# ============================================================================
# A guard selftest that runs against an ALREADY-immutable tree would report every
# mutation DENIED and pass while proving nothing. The SUT must refuse to score
# that as a pass.
if [ "$USERNS" = 1 ]; then
  APP="$STAGE/app2"; mkfixture "$APP"; chmod -R a-w "$APP"
  out=$(APP_TREE_GUARD_APP="$APP" "$SUT" --selftest 2>&1); rc=$?
  grep -q "FAIL - baseline" <<<"$out" && [ "$rc" != 0 ] \
    && ok "selftest fails when the tree was already immutable (no vacuous pass)" \
    || no "selftest passed vacuously on an immutable tree (rc=$rc)"
  chmod -R u+w "$APP"
else
  echo "  skip - selftest baseline (no unprivileged userns)"
fi

# ============================================================================
echo "[enforcement]"
# ============================================================================
if [ "$USERNS" = 1 ]; then
  APP="$STAGE/app3"; mkfixture "$APP"

  out=$(APP_TREE_GUARD_APP="$APP" "$SUT" --selftest 2>&1); rc=$?
  [ "$rc" = 0 ] && ok "selftest passes on a writable fixture" || no "selftest rc=$rc"$'\n'"$out"
  for cls in write_truncate write_src_ts unlink rename hardlink symlink chmod chown \
             mkdir create pkgmgr_installdir symlink_escape; do
    grep -q "ok   - $cls = DENIED" <<<"$out" && ok "denied: $cls" || no "not denied: $cls"
  done
  for cls in read_manifest resolve_module cache_write; do
    grep -q "ok   - $cls = ALLOWED" <<<"$out" && ok "still allowed: $cls" || no "broke: $cls"
  done

  # --exec must actually deny, and must not corrupt the tree.
  before=$(cd "$APP" && find . -type f | sort | xargs sha256sum 2>/dev/null | sha256sum)
  APP_TREE_GUARD_APP="$APP" "$SUT" --exec -- bash -c ": > $APP/package.json" 2>/dev/null \
    && no "--exec allowed a write to the guarded tree" \
    || ok "--exec denies a write to the guarded tree"
  after=$(cd "$APP" && find . -type f | sort | xargs sha256sum 2>/dev/null | sha256sum)
  [ "$before" = "$after" ] && ok "--exec left the tree byte-identical" || no "--exec altered the tree"

  # Exit status of the guarded command must propagate; a guard that swallows
  # failures turns a red test run green.
  APP_TREE_GUARD_APP="$APP" "$SUT" --exec -- true >/dev/null 2>&1 \
    && ok "--exec propagates success" || no "--exec lost a success"
  APP_TREE_GUARD_APP="$APP" "$SUT" --exec -- bash -c 'exit 42' >/dev/null 2>&1
  [ $? = 42 ] && ok "--exec propagates exit code 42" || no "--exec dropped the exit code"

  # Reads must survive: the guarded command can still consume the tree.
  got=$(APP_TREE_GUARD_APP="$APP" "$SUT" --exec -- cat "$APP/package.json" 2>/dev/null)
  [ "$got" = '{"name":"paperclip"}' ] && ok "--exec preserves reads" || no "--exec broke reads"

  # Post-guard audit on an untouched fixture must be clean.
  APP="$STAGE/app4"; mkfixture "$APP"
  APP_TREE_GUARD_APP="$APP" "$SUT" --exec -- true >/dev/null 2>&1
  out=$(APP_TREE_GUARD_APP="$APP" "$SUT" --audit 2>&1)
  grep -q "modified since image build: 0" <<<"$out" \
    && ok "a guarded run introduces no drift" || no "guarded run left drift"

  # TOG-711 regression: the guarded command must NOT hold CAP_SYS_ADMIN over
  # the namespace that owns the read-only bind. A single unnested
  # `mount -o remount,bind,rw` must not clear it. See repro_tog711_escape.sh
  # for the standalone, more detailed repro this mirrors.
  "$HERE/repro_tog711_escape.sh" "$SUT" >/dev/null 2>&1
  [ $? = 1 ] && ok "TOG-711: --exec is not escapable via a single remount,bind,rw" \
             || no "TOG-711: --exec REGRESSED -- remount escape defeats the guard"

  # A cache path that is itself a SYMLINK into real code must NOT be bind-shadowed:
  # `[ -d ]` alone follows the link, so the guard would mount empty scratch over
  # whatever it points at and hide deployed code from the guarded command.
  # Without the `[ ! -L ]` half of the fix this reads MISSING instead of the file.
  APP="$STAGE/app6"; mkfixture "$APP"
  rm -rf "$APP/node_modules/.vite"
  ln -s ../server/dist "$APP/node_modules/.vite"
  got=$(APP_TREE_GUARD_APP="$APP" "$SUT" --exec -- \
        cat "$APP/node_modules/.vite/index.js" 2>/dev/null | tail -1)
  [ "$got" = 'console.log("server")' ] \
    && ok "a symlinked cache path is not shadowed over real code" \
    || no "symlinked cache path SHADOWED real code (got: ${got:-empty})"
else
  echo "  skip - enforcement (no unprivileged userns)"
fi

# ============================================================================
echo "[fail closed]"
# ============================================================================
# If unshare is unavailable the guard must REFUSE, never fall through to running
# the command unprotected. Verified by shadowing unshare with a failing stub.
mkdir -p "$STAGE/bin"
printf '#!/bin/sh\nexit 1\n' > "$STAGE/bin/unshare"; chmod +x "$STAGE/bin/unshare"
APP="$STAGE/app5"; mkfixture "$APP"
out=$(PATH="$STAGE/bin:$PATH" APP_TREE_GUARD_APP="$APP" "$SUT" --exec -- \
      bash -c "echo BREACH > $APP/package.json" 2>&1); rc=$?
[ "$rc" != 0 ] && ok "refuses to run when userns is unavailable" || no "ran unguarded (rc=0)"
grep -q "refusing to run UNGUARDED" <<<"$out" \
  && ok "refusal names the reason" || no "refusal message missing"
grep -q BREACH "$APP/package.json" \
  && no "command executed despite the refusal" || ok "command did not execute"

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
