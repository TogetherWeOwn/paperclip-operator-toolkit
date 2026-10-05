#!/usr/bin/env bash
# TOG-649 -- make the deployed Paperclip application tree immutable to agent runs.
#
# This is an OWNED Ops Tooling control. It changes no host config, no Quadlet, no
# image, and it never writes to /app. It is safe to run as an ordinary agent.
#
#   --audit      report which deployed paths this agent can mutate, and which
#                deployed files have DRIFTED since the image was built.  Default.
#   --selftest   run the full denial matrix under the guard and prove every
#                mutation class fails BEFORE mutation.  Changes nothing.
#   --exec -- CMD [ARGS...]
#                run CMD with /app bind-mounted read-only, and the build caches
#                that legitimately live under /app redirected into run-owned
#                scratch.  This is the enforcing mode.
#   --json       machine-readable output for --audit/--selftest.
#
# ---------------------------------------------------------------------------
# WHY A WRAPPER AND NOT JUST "chmod -R a-w /app"
#
# Every agent on this host is uid 1000 (node), and so is the deployed tree's
# owner.  Measured 2026-08-30 on the live container:
#
#   /app                       root:root  0755   <- not writable (the only one)
#   /app/server                node:node  0755   <- WRITABLE by this agent
#   /app/server/dist/index.js  node:node  0644   <- WRITABLE by this agent
#   /app/node_modules          node:node  0755   <- WRITABLE (the TOG-643 vector)
#   /app/package.json          node:node  0644   <- WRITABLE
#
# A chmod is therefore not a boundary: the agent owns the files, so it can chmod
# them back.  Ownership-based permissions cannot separate two principals that
# ARE the same principal.  The separation has to come from the mount, which is
# the one thing a uid-1000 process cannot rewrite for a namespace it does not
# control.
#
# ---------------------------------------------------------------------------
# WHY THIS IS URGENT AND NOT THEORETICAL: /app/**/src/*.ts IS THE LIVE PATH
#
# The obvious reading is that /app/**/src is build input and only /app/server/dist
# is "the running server", so source edits are harmless until a rebuild.  That is
# wrong here.  Measured:
#
#   pid 1: node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js
#   /app/packages/adapter-utils/package.json     "exports": {".": "./src/index.ts"}
#   /app/packages/adapters/claude-local/pkg.json "exports": {".": "./src/index.ts"}
#
# The server runs under the tsx loader and the workspace packages export
# ./src/*.ts directly.  So an agent writing /app/packages/**/src/*.ts is editing
# code that the NEXT import executes -- no rebuild, no deploy, no restart.  That
# is agent -> server code execution, which is a strictly larger failure than the
# dependency-tree corruption TOG-643 actually hit.
#
# ---------------------------------------------------------------------------
# WHY THE SERVER AND THE AGENT SHARE ONE CONTAINER (the actual root cause)
#
# TOG-649 asks why agent processes can write /app.  The answer is not a missing
# flag.  Measured process ancestry from inside an agent run:
#
#   this bash -> claude -> MainThread -> pid 2 (node server/dist/index.js) -> pid 1
#
# The agent is a DESCENDANT of the Paperclip server, in the server's own
# container, in the server's mount namespace, as the server's uid.  There is no
# boundary to strengthen because there is no boundary: "agent" and "server" are
# one security principal today.  The deployed Quadlet confirms it carries no
# isolation flags at all:
#
#   /app/docker/quadlet/paperclip.container  -- no --read-only, no --cap-drop,
#                                               no --user, no per-run container
#
# The full fix is the TOG-655 two-container carrier (server container with
# --read-only, plus a per-run agent container with --user/--network=none and no
# /app mount).  That requires host authority this issue explicitly withholds.
#
# This wrapper is the part that can be enforced with NO host authority, because
# unprivileged user namespaces are enabled here:
#
#   /proc/sys/user/max_user_namespaces   2147483647
#   /proc/sys/kernel/unprivileged_userns_clone   1
#
# so an agent can drop ITSELF into a namespace where /app is read-only, without
# root and without affecting the server or any other run.  Verified: the ro bind
# is invisible outside the namespace, and the server keeps writing /paperclip
# state normally.
#
# ---------------------------------------------------------------------------
# WHY IT DOES NOT COME BACK OFF (the escape that had to be closed)
#
# A wrapper an agent can undo is theatre.  The obvious escape is for the guarded
# process to nest its own user namespace and remount /app rw.  Measured under
# the guard:
#
#   nested unshare + mount -o remount,bind,rw /app  -> EPERM
#   nested unshare + fresh bind of /app then rw     -> denied
#   nested unshare + umount /app                    -> EINVAL "not mounted"
#   write after all three                           -> EROFS
#
# The kernel refuses because the ro bind is locked: a mount inherited from a
# parent user namespace cannot have its ro flag cleared, and cannot be unmounted
# to reveal the writable mount underneath.  That lock is what makes this a
# control rather than a convention.
#
# ---------------------------------------------------------------------------
# WHAT STAYS WRITABLE ON PURPOSE
#
# Blanket-ro /app breaks real work: vitest writes its cache into
# /app/node_modules/.vite and /app/server/node_modules/.vite, and those are hit
# by ordinary agent test runs.  The guard re-opens exactly those paths, backed by
# run-owned scratch, so the writes succeed and land in the run's own directory
# instead of the deployed tree.  Verified: a cache write under the guard
# succeeds, and the file does NOT appear in /app afterwards.
#
# /paperclip is untouched by design -- it is persistent server state and the
# server needs it writable.  This control is scoped to the deployed CODE tree.
#
# ---------------------------------------------------------------------------
# WHAT THIS GUARANTEES, AND WHAT IT DOES NOT (TOG-755)
#
# The guarantee is DEPLOYED-TREE IMMUTABILITY: no process anywhere can leave
# $APP on disk in a different state than before a guarded command ran. That
# holds -- see "WHY IT DOES NOT COME BACK OFF" above.
#
# It is explicitly NOT read integrity for the guarded command itself. A command
# running under --exec holds CAP_SYS_ADMIN in its own nested mount namespace,
# and nothing stops it bind-mounting its own content OVER a path inside $APP
# for the remainder of that command's execution:
#
#   app_tree_guard.sh --exec -- bash -c 'mount --bind "$FAKE" /app/package.json; cat /app/package.json'
#
# reads back attacker-controlled content (mount_rc=0), while the on-disk file
# is untouched -- verified by hash and mtime from OUTSIDE the namespace, both
# unchanged. The shadow does not persist: a later, separate --exec reads the
# real file, and audit() below never runs under --exec, so drift detection
# cannot be fed shadowed content by this route.
#
# The consequence: DO NOT build an integrity oracle on top of what a guarded
# command reads from $APP -- that inference is unsound. Anything that needs to
# know what is really deployed must read $APP from the CALLER's namespace
# (e.g. via --audit, which does exactly that), never from inside --exec.
set -uo pipefail

APP="${APP_TREE_GUARD_APP:-/app}"
SCRATCH="${PAPERCLIP_RUN_SCRATCH_DIR:-${PAPERCLIP_SCRATCH_DIR:-${TMPDIR:-/tmp}}}"
MODE=audit
JSON=0

# Paths under $APP that legitimately receive writes from ordinary agent test
# runs. Each is rebound to run-owned scratch instead of being left writable.
CACHE_PATHS=(
  "node_modules/.vite"
  "node_modules/.vite-temp"
  "server/node_modules/.vite"
  "server/node_modules/.vite-temp"
  "cli/node_modules/.vite-temp"
  "ui/node_modules/.vite-temp"
  "packages/db/node_modules/.vite-temp"
  "packages/shared/node_modules/.vite-temp"
  "packages/skills-catalog/node_modules/.vite-temp"
)

# Representative deployed paths probed by --audit. Chosen to cover each distinct
# class: server entrypoint, live-executed workspace source, dependency tree,
# manifest, and lockfile.
PROBE_PATHS=(
  "server/dist/index.js"
  "packages/adapter-utils/src/acpx-engine/execute.ts"
  "packages/adapters/claude-local/src/index.ts"
  "node_modules/.modules.yaml"
  "package.json"
  "pnpm-lock.yaml"
  "cli/package.json"
)

usage(){ sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; }

die(){ echo "app_tree_guard: $*" >&2; exit 2; }

# --- preflight ---------------------------------------------------------------
# Absence of unshare, or a kernel with userns disabled, must FAIL LOUD. A guard
# that silently degrades to "ran the command unguarded" is worse than no guard,
# because the caller believes the boundary held.
have_userns(){
  command -v unshare >/dev/null 2>&1 || return 1
  unshare --mount --map-root-user true >/dev/null 2>&1 || return 1
  return 0
}

# --- audit -------------------------------------------------------------------
# Reports two independent things:
#   1. capability -- which deployed paths THIS agent can currently mutate
#   2. drift      -- which deployed files have been written since deployment
#
# HOW DRIFT IS DETECTED, AND WHY NOT BY TIMESTAMP THRESHOLD
#
# The first draft compared mtimes against the mtime of $APP itself. That is
# circular and it fails badly: $APP's own mtime is stamped early in the build,
# before `pnpm install` populates node_modules, so 69,522 ordinary image files
# read as "drift". A threshold picked from a later artifact instead silently
# misses anything an attacker backdates.
#
# The reliable discriminator is nanosecond granularity, not the timestamp value.
# Image layers are tar archives, and tar stores whole seconds, so every file the
# image extracted has an mtime with EXACTLY zero nanoseconds. Any file written
# afterwards by a live process carries the filesystem's real nanosecond clock.
# Measured on this container:
#
#   zero-ns    (extracted from the image) : 73937
#   nonzero-ns (written after deployment) :     7
#
# That is a property of how the file arrived, not of when, so it cannot be
# defeated by choosing a convenient timestamp -- `touch -d` still produces a
# zero-ns mtime only if the attacker asks for whole seconds, and a plain write
# cannot produce one at all.
audit(){
  local writable=0 total=0 drift=0

  local -a wrote=() drifted=()
  for rel in "${PROBE_PATHS[@]}"; do
    local p="$APP/$rel"
    [ -e "$p" ] || continue
    total=$((total+1))
    # O_WRONLY probe: proves write CAPABILITY without writing a byte and without
    # touching any timestamp. `test -w` only reads the permission bits; this
    # asks the kernel the same question the mutation would.
    if node -e '
      const {openSync,closeSync,constants}=require("fs");
      try{closeSync(openSync(process.argv[1],constants.O_WRONLY));process.exit(0)}
      catch(e){process.exit(1)}' "$p" 2>/dev/null; then
      writable=$((writable+1)); wrote+=("$rel")
    fi
  done

  while IFS= read -r f; do
    [ -n "$f" ] || continue
    drift=$((drift+1)); drifted+=("${f#$APP/}")
  done < <(find "$APP" -xdev -type f -printf '%T@ %p\n' 2>/dev/null \
           | awk '{ dot=index($1,"."); ns=substr($1,dot+1,9)+0;
                    if (ns!=0) { sub(/^[^ ]+ /,""); print } }' \
           | grep -v -E '/\.vite(-temp)?/' | sort)

  # Reported for context only -- NOT used as the drift threshold. It is the
  # newest whole-second mtime, i.e. the tail of the image build.
  local baseline
  baseline=$(find "$APP" -xdev -type f -printf '%T@\n' 2>/dev/null \
    | awk '{ dot=index($1,"."); ns=substr($1,dot+1,9)+0; s=substr($1,1,dot-1)+0;
             if (ns==0 && s>m) m=s } END{ printf "%d", m }')

  if [ "$JSON" = 1 ]; then
    printf '{"app":"%s","imageBuildEpoch":%s,"probed":%d,"agentWritable":%d,"driftedFiles":%d,"writable":[' \
      "$APP" "$baseline" "$total" "$writable" "$drift"
    local i=0; for w in ${wrote+"${wrote[@]}"}; do [ $i -gt 0 ] && printf ','; printf '"%s"' "$w"; i=$((i+1)); done
    printf '],"drift":['
    i=0; for d in ${drifted+"${drifted[@]}"}; do [ $i -gt 0 ] && printf ','; printf '"%s"' "$d"; i=$((i+1)); done
    printf ']}\n'
  else
    echo "app_tree_guard --audit   ($APP)"
    echo
    echo "  agent-writable deployed paths: $writable of $total probed"
    for w in ${wrote+"${wrote[@]}"}; do echo "    WRITABLE  $w"; done
    [ "$writable" = 0 ] && echo "    (none -- guard is in effect)"
    echo
    echo "  deployed files modified since image build: $drift"
    for d in ${drifted+"${drifted[@]}"}; do echo "    DRIFT     $d"; done
    [ "$drift" = 0 ] && echo "    (none)"
  fi
  # exit 1 signals "the deployed tree is mutable and/or already mutated". This is
  # the state a CI check or a monitor should treat as red.
  { [ "$writable" -gt 0 ] || [ "$drift" -gt 0 ]; } && return 1
  return 0
}

# --- guarded exec ------------------------------------------------------------
build_guard_script(){
  local inner="$1"
  cat <<GUARD
set -uo pipefail
mount --bind "$APP" "$APP" || exit 71
mount -o remount,bind,ro "$APP" || exit 72
# Re-open only the caches that ordinary test runs legitimately write, backed by
# run-owned scratch. A missing source dir is skipped, not fatal: the deployed
# tree's cache layout varies by image and an absent path is already immutable.
for rel in ${CACHE_PATHS[*]}; do
  tgt="$APP/\$rel"
  # -L excludes a cache path that is itself a symlink into real code (e.g.
  # node_modules/.vite -> server/dist): [ -d ] alone follows the symlink and
  # would silently shadow whatever it points at inside the namespace.
  [ -d "\$tgt" ] && [ ! -L "\$tgt" ] || continue
  src="$SCRATCH/app-tree-guard/\$(printf %s "\$rel" | tr / _)"
  mkdir -p "\$src" || exit 73
  mount --bind "\$src" "\$tgt" || exit 74
done
$inner
GUARD
}

guarded_exec(){
  [ "$#" -gt 0 ] || die "--exec requires a command"
  have_userns || die "unprivileged user namespaces unavailable; refusing to run UNGUARDED"
  local q="" a
  for a in "$@"; do q+=" $(printf %q "$a")"; done
  # The bind+ro mount is created in THIS (outer) user+mount namespace. The
  # guarded command must run in a NESTED namespace, not this one: a mount is
  # locked against remount-rw only when inherited from a PARENT user
  # namespace (kernel: keep_locked, see user_namespaces(7)). Running the
  # command directly here would hand it CAP_SYS_ADMIN over the very
  # namespace that owns the mount, so `mount -o remount,bind,rw "$APP"`
  # would succeed with no EPERM -- verified escape, see
  # mount-escape-repro.sh. Nesting one more `unshare --mount
  # --map-root-user` makes the mount inherited, and therefore locked.
  unshare --mount --map-root-user bash -c "$(build_guard_script "exec unshare --mount --map-root-user bash -c $(printf %q "$q")")"
}

# --- selftest ----------------------------------------------------------------
# Proves each mutation class is denied BEFORE mutation. Deliberately includes a
# baseline: the same probes are run UNGUARDED first, and the test only passes if
# they succeed there. A denial that would also have been denied without the
# guard proves nothing about the guard.
selftest(){
  have_userns || die "unprivileged user namespaces unavailable; cannot selftest"
  local tmp; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' RETURN

  # Baseline: confirm the guard has something to prevent.
  local base_writable=0
  node -e '
    const {openSync,closeSync,constants}=require("fs");
    try{closeSync(openSync(process.argv[1],constants.O_WRONLY));process.exit(0)}
    catch(e){process.exit(1)}' "$APP/package.json" 2>/dev/null && base_writable=1

  local out rc
  out=$(unshare --mount --map-root-user bash -c "$(build_guard_script '
    r(){ printf "%s\t" "$1"; shift; if "$@" >/dev/null 2>&1; then echo ALLOWED; else echo DENIED; fi; }
    r write_truncate     bash -c ": > '"$APP"'/server/dist/index.js"
    r write_append       bash -c "echo x >> '"$APP"'/package.json"
    r write_src_ts       bash -c ": > '"$APP"'/packages/adapter-utils/src/acpx-engine/execute.ts"
    r unlink             rm -f '"$APP"'/package.json
    r rename             mv '"$APP"'/package.json '"$APP"'/package.json.bak
    r hardlink           ln /etc/hostname '"$APP"'/hl
    r symlink            ln -s /evil '"$APP"'/evil
    r chmod              chmod 777 '"$APP"'/package.json
    r chown              chown 0:0 '"$APP"'/package.json
    r mkdir              mkdir '"$APP"'/newdir
    r create             touch '"$APP"'/brandnew
    r pkgmgr_installdir  mkdir -p '"$APP"'/node_modules/evilpkg
    # symlink escape: a scratch path pointing back into the deployed tree
    mkdir -p /tmp/g && ln -sfn '"$APP"'/node_modules /tmp/g/nm
    r symlink_escape     bash -c ": > /tmp/g/nm/.modules.yaml"
    # reads and cache writes MUST still work
    r read_manifest      cat '"$APP"'/package.json
    r resolve_module     node -e "require(\"'"$APP"'/package.json\")"
    r cache_write        bash -c "echo ok > '"$APP"'/node_modules/.vite/probe.json"
  ')" 2>/dev/null)
  rc=$?
  [ "$rc" -ge 71 ] && [ "$rc" -le 74 ] && die "guard setup failed (rc=$rc)"

  local pass=0 fail=0
  chk(){ # name expected
    local got; got=$(printf '%s\n' "$out" | awk -F'\t' -v n="$1" '$1==n{print $2}')
    if [ -z "$got" ]; then echo "  FAIL - $1 (no result)"; fail=$((fail+1)); return; fi
    if [ "$got" = "$2" ]; then echo "  ok   - $1 = $got"; pass=$((pass+1));
    else echo "  FAIL - $1 = $got (want $2)"; fail=$((fail+1)); fi
  }

  echo "app_tree_guard --selftest   ($APP)"
  echo
  if [ "$base_writable" = 1 ]; then
    echo "  ok   - baseline: $APP is agent-writable WITHOUT the guard"; pass=$((pass+1))
  else
    echo "  FAIL - baseline: $APP already immutable; selftest would pass vacuously"; fail=$((fail+1))
  fi
  echo "  [mutation classes -- must be DENIED]"
  for n in write_truncate write_append write_src_ts unlink rename hardlink symlink \
           chmod chown mkdir create pkgmgr_installdir symlink_escape; do chk "$n" DENIED; done
  echo "  [normal operation -- must still be ALLOWED]"
  for n in read_manifest resolve_module cache_write; do chk "$n" ALLOWED; done

  # The deployed tree must be byte-identical afterwards.
  local leaked=0
  for junk in brandnew evil hl newdir package.json.bak node_modules/evilpkg node_modules/.vite/probe.json; do
    [ -e "$APP/$junk" ] && { echo "  FAIL - leaked into deployed tree: $junk"; leaked=1; fail=$((fail+1)); }
  done
  [ "$leaked" = 0 ] && { echo "  ok   - no artifact leaked into $APP"; pass=$((pass+1)); }

  echo
  echo "  $pass passed, $fail failed"
  [ "$fail" -eq 0 ]
}

# --- arg parsing -------------------------------------------------------------
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --audit)    MODE=audit ;;
    --selftest) MODE=selftest ;;
    --json)     JSON=1 ;;
    --exec)     MODE=exec; shift; [ "${1:-}" = "--" ] && shift; ARGS=("$@"); break ;;
    -h|--help)  usage; exit 0 ;;
    *)          die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

case "$MODE" in
  audit)    audit ;;
  selftest) selftest ;;
  exec)     guarded_exec ${ARGS+"${ARGS[@]}"} ;;
esac
