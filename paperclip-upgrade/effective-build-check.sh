#!/usr/bin/env bash
# ===========================================================================
# paperclip-upgrade/effective-build-check.sh — provenance proof that the
# tested candidate actually contains the patched adapter-utils server-utils
#, not a stale overlay shadowing it.
#
# WHAT IT PROVES. For one target it collects, as `key|value` evidence lines:
#   * the full sha256 of every server-utils candidate file found (host path
#     mode and/or image/container mode),
#   * whether each file contains the EPIPE marker (default: the string EPIPE;
#     the EPIPE guard),
#   * the effective Node resolution of @paperclipai/adapter-utils (which file
#     actually loads),
#   * the mount/overlay table covering those paths (host /proc/mounts longest
#     prefix; container Mounts from docker inspect), so a stale overlay that
#     shadows the patched file is visible instead of trusted away.
#
# WHAT IT NEVER DOES. Reads and hashes only. No container is started except
# the throwaway `--rm --network none --read-only` inspectors below (never the
# production server); nothing is mounted into production; no secret is printed
# (paths, hashes, mount points and counts only).
#
# MODES (pick exactly one target; --server-container may ride along with
# --image to prove the live overlay too):
#   --path FILE            hash a host file (repeatable). Needs no Docker, so
#                          this mode is fully offline-testable.
#   --image REF            enumerate server-utils candidates INSIDE the image
#                          plus Node resolution. Needs Docker (operator host).
#   --container NAME       same, but against a RUNNING stage container via
#                          docker exec (rehearsal post-boot proof).
#
# EXPECTATIONS (all optional; every unmet expectation is FAIL, exit 1):
#   --expect-sha256 HEX    a collected file must carry exactly this hash
#                          (repeatable; every value must match at least one).
#   --require-marker STR   a collected file must contain this string
#                          (default: EPIPE). --no-marker-check disables.
#   --expect-plugin-package NAME:HEX
#                          npm package NAME must node-resolve inside the image
#                          / container and its package.json must sha256 to HEX
#                          (repeatable). Proves the target ships the inventoried
#                          plugin builds; bundled path-null
#                          plugins are proven here, never from inventory alone.
#   --resolve-pkg NAME     collect resolve+hash evidence without gating on it
#                          (operator capture: fills the rehearsal manifest).
#   --expect-file ABS:HEX  absolute path ABS must exist in EVERY image/container
#                          target and sha256 to exactly HEX (repeatable). Pins a
#                          compiled/load identity to its path, so the operator
#                          can re-pin the certificate to a new image's files
#                          (e.g. the PR #29 redaction port in server/dist).
#   --forbid-file ABS:HEX  no image/container target may carry HEX at ABS
#                          (repeatable): a known-stale build baked back in.
#   --forbid-mount ABS     no container target may have a mount whose
#                          destination is ABS or an ancestor directory of ABS
#                          (repeatable): a host overlay shadowing that file.
#                          Images carry no mounts; the gate is reported n/a there.
#   --forbid-916-redaction the upgrade packaging policy: the whole-
#                          file 916 redaction override must be gone, i.e.
#                          --forbid-mount on LEGACY_REDACTION_DEST plus
#                          --forbid-file of its live overlay hash. Rollback to
#                          916 needs that mount, so callers pass this on
#                          upgrade only.
#
# Exit: 0 proven | 1 a gate failed (evidence printed, nothing touched)
#       2 refused (bad args, missing tool, unreadable input)
# ===========================================================================
set -uo pipefail
umask 077

ME="${BASH_SOURCE[0]##*/}"
DOCKER="${DOCKER:-docker}"
MARKER="EPIPE"; MARKER_OFF=0
IMAGE=""; CONTAINER=""; SERVER_CONTAINER=""
PATHS=(); EXPECTS=(); EXPECT_PKGS=(); RESOLVE_PKGS=()
EXPECT_FILES=(); FORBID_FILES=(); FORBID_MOUNTS=()

# The 916 operator override (2026-09-20, Quadlet) bind-mounted a whole patched
# redaction.js read-only over this path. The 1001 candidate carries the
# reviewed port in its own build, so on upgrade neither the mount nor that
# file may survive. Hash: the liveOverlaySHA256 recorded in the redaction
# operator handoff manifest (the captured live-916-redaction.js).
LEGACY_REDACTION_DEST="/app/server/dist/redaction.js"
LEGACY_REDACTION_SHA256="c177c806a5ad6d75128b907876d5ece06a184a0d80853064b3597a3243e479cd"

usage() {
  cat <<'USAGE'
usage: effective-build-check.sh (--path FILE | --image REF | --container NAME) [options]

  --path FILE            host file to hash (repeatable; no Docker needed)
  --image REF            candidate image to inspect (Docker, operator host)
  --container NAME       running stage container to exec into (Docker)
  --server-container N   also prove the live overlay on container N (with --image)
  --expect-sha256 HEX    a collected file must carry this hash (repeatable)
  --require-marker STR   a collected file must contain this (default: EPIPE)
  --no-marker-check      report the marker without requiring it
  --expect-plugin-package NAME:HEX  npm package NAME must resolve inside the
                         image/container and its package.json must sha256 to
                         HEX (repeatable; NAME is [A-Za-z0-9_.@/-]+, no "..")
  --resolve-pkg NAME     collect resolve+hash evidence without gating on it
                         (repeatable; operator capture for the manifest)
  --expect-file ABS:HEX  ABS must sha256 to HEX in every image/container target
  --forbid-file ABS:HEX  no image/container target may carry HEX at ABS
  --forbid-mount ABS     no container mount may cover ABS (exact or ancestor)
  --forbid-916-redaction the 916 whole-file redaction override must be gone
                         (upgrade only; rollback to 916 needs it)
USAGE
}

while (($#)); do
  case "$1" in
    --path) PATHS+=("${2:?}"); shift 2 ;;
    --image) IMAGE="${2:?}"; shift 2 ;;
    --container) CONTAINER="${2:?}"; shift 2 ;;
    --server-container) SERVER_CONTAINER="${2:?}"; shift 2 ;;
    --expect-sha256) EXPECTS+=("${2:?}"); shift 2 ;;
    --require-marker) MARKER="${2:?}"; shift 2 ;;
    --no-marker-check) MARKER_OFF=1; shift ;;
    --expect-plugin-package) EXPECT_PKGS+=("${2:?}"); shift 2 ;;
    --resolve-pkg) RESOLVE_PKGS+=("${2:?}"); shift 2 ;;
    --expect-file) EXPECT_FILES+=("${2:?}"); shift 2 ;;
    --forbid-file) FORBID_FILES+=("${2:?}"); shift 2 ;;
    --forbid-mount) FORBID_MOUNTS+=("${2:?}"); shift 2 ;;
    --forbid-916-redaction)
      FORBID_MOUNTS+=("$LEGACY_REDACTION_DEST")
      FORBID_FILES+=("$LEGACY_REDACTION_DEST:$LEGACY_REDACTION_SHA256"); shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'REFUSED: %s: unknown flag: %s\n' "$ME" "$1" >&2; exit 2 ;;
  esac
done

# --- refusals (before anything is collected) ---------------------------------
n_targets=0
((${#PATHS[@]})) && n_targets=$((n_targets + 1))
[[ -n "$IMAGE" ]] && n_targets=$((n_targets + 1))
[[ -n "$CONTAINER" ]] && n_targets=$((n_targets + 1))
((n_targets >= 1)) || { printf 'REFUSED: %s: a target is required: --path, --image or --container\n' "$ME" >&2; exit 2; }
[[ -n "$IMAGE" || -z "$SERVER_CONTAINER" ]] || { printf 'REFUSED: %s: --server-container needs --image\n' "$ME" >&2; exit 2; }
[[ "$MARKER" =~ ^[A-Za-z0-9_.~-]+$ ]] || { printf 'REFUSED: %s: --require-marker must be a plain token: %s\n' "$ME" "$MARKER" >&2; exit 2; }
for e in ${EXPECTS[@]+"${EXPECTS[@]}"}; do
  [[ "$e" =~ ^[0-9a-f]{64}$ ]] || { printf 'REFUSED: %s: --expect-sha256 must be 64 lowercase hex\n' "$ME" >&2; exit 2; }
done
for p in ${PATHS[@]+"${PATHS[@]}"}; do
  [[ -f "$p" && ! -L "$p" && -r "$p" ]] || { printf 'REFUSED: %s: --path is not a readable regular file: %s\n' "$ME" "$p" >&2; exit 2; }
done
# Package names are interpolated into a node -e script, so the charset is
# allowlisted (no quotes, backslashes, $ or whitespace) and ".." is refused:
# a name that could escape the JS string or walk the filesystem never runs.
for pp in ${EXPECT_PKGS[@]+"${EXPECT_PKGS[@]}"}; do
  [[ "$pp" =~ ^[A-Za-z0-9_.@/-]+:[0-9a-f]{64}$ && "$pp" != *..* ]] \
    || { printf 'REFUSED: %s: --expect-plugin-package must be NAME:64-hex-sha256 (NAME [A-Za-z0-9_.@/-]+, no ..): %s\n' "$ME" "$pp" >&2; exit 2; }
done
for rp in ${RESOLVE_PKGS[@]+"${RESOLVE_PKGS[@]}"}; do
  [[ "$rp" =~ ^[A-Za-z0-9_.@/-]+$ && "$rp" != *..* ]] \
    || { printf 'REFUSED: %s: --resolve-pkg must be an npm package name (no ..): %s\n' "$ME" "$rp" >&2; exit 2; }
done
if (( ${#EXPECT_PKGS[@]} + ${#RESOLVE_PKGS[@]} > 0 )) && [[ -z "$IMAGE$CONTAINER$SERVER_CONTAINER" ]]; then
  printf 'REFUSED: %s: --expect-plugin-package/--resolve-pkg need --image or --container (no runtime to resolve in --path mode)\n' "$ME" >&2; exit 2
fi
# Pinned/forbidden paths are interpolated into the remote sh probe, so they
# get the same allowlist as package names, must be absolute and clean (no
# "..", "//" or trailing "/"): a path that could escape the script never runs.
abs_ok() { [[ "$1" =~ ^/[A-Za-z0-9_.@/-]+$ && "$1" != *..* && "$1" != *//* && "$1" != */ ]]; }
for xf in ${EXPECT_FILES[@]+"${EXPECT_FILES[@]}"} ${FORBID_FILES[@]+"${FORBID_FILES[@]}"}; do
  [[ "$xf" =~ ^[^:]+:[0-9a-f]{64}$ ]] && abs_ok "${xf%:*}" \
    || { printf 'REFUSED: %s: --expect-file/--forbid-file must be ABS:64-hex-sha256 (ABS absolute, [A-Za-z0-9_.@/-], no .., // or trailing /): %s\n' "$ME" "$xf" >&2; exit 2; }
done
for fm in ${FORBID_MOUNTS[@]+"${FORBID_MOUNTS[@]}"}; do
  abs_ok "$fm" || { printf 'REFUSED: %s: --forbid-mount must be an absolute clean path ([A-Za-z0-9_.@/-], no .., // or trailing /): %s\n' "$ME" "$fm" >&2; exit 2; }
done
if (( ${#EXPECT_FILES[@]} + ${#FORBID_FILES[@]} + ${#FORBID_MOUNTS[@]} > 0 )) && [[ -z "$IMAGE$CONTAINER$SERVER_CONTAINER" ]]; then
  printf 'REFUSED: %s: --expect-file/--forbid-file/--forbid-mount/--forbid-916-redaction need --image or --container (they judge the runtime, not host files)\n' "$ME" >&2; exit 2
fi
if ((${#FORBID_MOUNTS[@]})) && [[ -n "$CONTAINER$SERVER_CONTAINER" ]]; then
  command -v jq >/dev/null || { printf 'REFUSED: %s: jq is required to judge --forbid-mount against a container mount table\n' "$ME" >&2; exit 2; }
fi
# Union of pinned/forbidden paths, de-duplicated, probed in every runtime target.
XPATHS=""
for xf in ${EXPECT_FILES[@]+"${EXPECT_FILES[@]}"} ${FORBID_FILES[@]+"${FORBID_FILES[@]}"}; do
  p="${xf%:*}"; [[ " $XPATHS " == *" $p "* ]] || XPATHS+="${XPATHS:+ }$p"
done
# Union of package names to resolve, de-duplicated (plain-string loop: no
# mapfile, whose exit status would mask a substitution failure).
PKG_UNIQ=""
for pp in ${EXPECT_PKGS[@]+"${EXPECT_PKGS[@]}"}; do
  n="${pp%%:*}"; [[ "$PKG_UNIQ" == *"|$n|"* ]] || PKG_UNIQ+="|$n|"
done
for rp in ${RESOLVE_PKGS[@]+"${RESOLVE_PKGS[@]}"}; do
  [[ "$PKG_UNIQ" == *"|$rp|"* ]] || PKG_UNIQ+="|$rp|"
done
JS_NAMES=""
n=""
OLDIFS="$IFS"; IFS='|'
for n in $PKG_UNIQ; do
  [[ -n "$n" ]] || continue
  JS_NAMES+="${JS_NAMES:+,}\"$n\""
done
IFS="$OLDIFS"
if [[ -n "$IMAGE" || -n "$CONTAINER" || -n "$SERVER_CONTAINER" ]]; then
  command -v "$DOCKER" >/dev/null || { printf 'REFUSED: %s: docker runtime is missing\n' "$ME" >&2; exit 2; }
fi

# --- collected evidence -------------------------------------------------------
# HASHES holds "<sha256>  <label>"; MARK_HITS holds labels containing $MARKER.
HASHES=""; MARK_HITS=""
have() { # LABEL HEX -- record one collected file hash
  HASHES+="${2}  ${1}"$'\n'
}
hit() { MARK_HITS+="${1}"$'\n'; }

mount_for() { # PATH -- longest /proc/mounts mount point prefixing PATH
  local p="$1" best="-" dev mp rest
  while read -r dev mp rest; do
    mp="${mp//\\040/ }"
    if [[ "$p" == "$mp" || "$p" == "$mp"/* ]]; then
      (( ${#mp} > ${#best} )) && best="$mp"
    fi
  done < /proc/mounts 2>/dev/null
  printf '%s' "$best"
}

# 1. host files (no Docker): hash + marker + covering mount.
for p in ${PATHS[@]+"${PATHS[@]}"}; do
  h="$(sha256sum -- "$p" | cut -d' ' -f1)"
  have "host:$p" "$h"
  printf 'file|host:%s|%s\n' "$p" "$h"
  if grep -qF -- "$MARKER" "$p" 2>/dev/null; then hit "host:$p"; printf 'marker|host:%s|present\n' "$p"; else printf 'marker|host:%s|absent\n' "$p"; fi
  printf 'mount|host:%s|%s\n' "$p" "$(mount_for "$p")"
done

# Candidate absolute paths probed inside images/containers (fixed list: no
# spaces, safe to interpolate into the remote sh below).
CANDS=(
  /app/packages/adapter-utils/src/server-utils.ts
  /app/packages/adapter-utils/dist/server-utils.js
  /app/node_modules/@paperclipai/adapter-utils/dist/server-utils.js
  /app/node_modules/@paperclipai/adapter-utils/src/server-utils.ts
)
REMOTE='for f in __CANDS__; do if [ -f "$f" ]; then echo "FILE:$f"; sha256sum "$f"; if grep -qF "__MARKER__" "$f" 2>/dev/null; then echo "MARKER:$f:present"; else echo "MARKER:$f:absent"; fi; fi; done; echo PROBEDONE'
REMOTE="${REMOTE//__CANDS__/${CANDS[*]}}"
REMOTE="${REMOTE//__MARKER__/$MARKER}"

collect_remote() { # LABEL -- COMMAND... ; parses FILE:/sha/MARKER: lines
  local label="$1"; shift
  local out f h m cur=""
  out="$("$@" 2>/dev/null)" || { printf 'FAIL: cannot probe %s\n' "$label"; return 1; }
  grep -q PROBEDONE <<<"$out" || { printf 'FAIL: probe of %s returned no sentinel\n' "$label"; return 1; }
  while IFS= read -r line; do
    case "$line" in
      FILE:*) f="${line#FILE:}"; printf 'file|%s:%s|found\n' "$label" "$f"; cur="$f" ;;
      MARKER:*:present) hit "$label:${line#MARKER:}"; m="${line#MARKER:}"; m="${m%:present}"; printf 'marker|%s:%s|present\n' "$label" "$m" ;;
      MARKER:*:absent) m="${line#MARKER:}"; m="${m%:absent}"; printf 'marker|%s:%s|absent\n' "$label" "$m" ;;
      PROBEDONE) : ;;
      *) if [[ "$line" =~ ^[0-9a-f]{64}[[:space:]] ]]; then h="${line%% *}"; have "$label:$cur" "$h"; printf 'file|%s:%s|%s\n' "$label" "$cur" "$h"; fi ;;
    esac
  done <<<"$out"
  return 0
}

# Pinned-file probe: a separate remote script so these files never count as
# marker evidence for the server-utils build. One line per path; the sentinel
# turns a truncated answer into a FAIL. XH holds "label|path|hex" where hex is
# a sha256, MISSING or UNREADABLE; XTARGETS lists every label that answered.
XREMOTE='for f in __XPATHS__; do if [ -f "$f" ]; then h=$(sha256sum "$f" 2>/dev/null) && echo "XHASH:${h%% *}:$f" || echo "XUNREADABLE:$f"; else echo "XMISSING:$f"; fi; done; echo XPROBEDONE'
XREMOTE="${XREMOTE//__XPATHS__/$XPATHS}"
XH=""; XTARGETS=""
collect_pinned() { # LABEL -- COMMAND... ; parses XHASH:/XMISSING:/XUNREADABLE: lines
  local label="$1"; shift
  local out line rest f h
  out="$("$@" 2>/dev/null)" || { printf 'FAIL: cannot probe pinned files in %s\n' "$label"; return 1; }
  grep -qx XPROBEDONE <<<"$out" || { printf 'FAIL: pinned-file probe of %s returned no sentinel\n' "$label"; return 1; }
  XTARGETS+="${label}"$'\n'
  while IFS= read -r line; do
    case "$line" in
      XHASH:*) rest="${line#XHASH:}"; h="${rest%%:*}"; f="${rest#*:}"
        [[ "$h" =~ ^[0-9a-f]{64}$ ]] || h="UNREADABLE" ;;
      XMISSING:*) f="${line#XMISSING:}"; h="MISSING" ;;
      XUNREADABLE:*) f="${line#XUNREADABLE:}"; h="UNREADABLE" ;;
      *) continue ;;
    esac
    XH+="${label}|${f}|${h}"$'\n'
    printf 'pinned|%s:%s|%s\n' "$label" "$f" "$h"
  done <<<"$out"
  return 0
}
xget() { awk -F'|' -v t="$1" -v p="$2" '$1 == t && $2 == p { print $3; exit }' <<<"$XH"; }

# Mount gate: Docker destinations are judged as they are recorded (no symlink
# resolution); the forbid-file content check above reads THROUGH any mount, so
# an overlay at an unexpected destination still fails on its hash.
MOUNT_FAILS=""; MOUNT_CTRS=""
covers() { # DEST ABS -- true if a mount at DEST shadows ABS (same path or ancestor dir)
  local d="$1" a="$2"
  [[ "$d" == "/" ]] && return 0
  d="${d%/}"
  [[ "$a" == "$d" || "$a" == "$d"/* ]]
}

# Node package resolver: resolves each requested package's package.json inside
# the runtime and sha256-hashes it there (paths and hashes only, never file
# contents). PKG_HASHES accumulates one "NAME|HEX" line per resolved package;
# the gated expectations below match against it. The sentinel makes a
# truncated or empty runtime answer a loud FAIL, never a vacuous pass.
PKG_HASHES=""
# NODEJS_BEGIN -- verbatim-executed by test-offline section 7 (extracted by
# marker, eval'd with JS_NAMES preset, run under real node). Keep this a
# single self-contained assignment: no bash expansions inside the JS string.
NODEJS="const fs=require('fs');const{createHash}=require('crypto');for(const s of [$JS_NAMES]){try{const p=require.resolve(s+'/package.json');const h=createHash('sha256').update(fs.readFileSync(p)).digest('hex');console.log('PKG:'+s+'='+p);console.log('PKGHASH:'+s+'|'+h);}catch(e){console.log('PKG:'+s+'=UNRESOLVABLE');}}console.log('PKGDONE');"
# NODEJS_END
resolve_pkgs() { # PREFIX LABEL -- CMD... ; runs node, prints resolve| lines
  local prefix="$1" label="$2"; shift 2
  local out line name hash
  out="$("$@" -e "$NODEJS" 2>/dev/null)" || { printf 'FAIL: node package resolution unavailable in %s\n' "$label"; return 1; }
  grep -q PKGDONE <<<"$out" || { printf 'FAIL: package resolution in %s returned no sentinel\n' "$label"; return 1; }
  while IFS= read -r line; do
    case "$line" in
      PKG:*) printf '%s%s\n' "$prefix" "$line" ;;
      PKGHASH:*)
        printf '%s%s\n' "$prefix" "$line"
        name="${line#PKGHASH:}"; hash="${name##*|}"; name="${name%%|*}"
        PKG_HASHES+="${name}|${hash}"$'\n' ;;
    esac
  done <<<"$out"
  return 0
}

# 2. image contents (throwaway --rm inspectors only; never the live server).
if [[ -n "$IMAGE" ]]; then
  iid="$("$DOCKER" image inspect -f '{{.Id}}' "$IMAGE" 2>/dev/null)" \
    || { printf 'REFUSED: %s: image not present locally (this script never pulls): %s\n' "$ME" "$IMAGE" >&2; exit 2; }
  printf 'image|ref|%s\n' "$IMAGE"
  printf 'image|id|%s\n' "$iid"
  "$DOCKER" image inspect -f '{{json .RepoDigests}}' "$IMAGE" 2>/dev/null | sed 's/^/image|digests|/'
  # shellcheck disable=SC2086
  collect_remote "image:$iid" "$DOCKER" run --rm --pull never --network none \
    --read-only --cap-drop ALL --security-opt no-new-privileges \
    --entrypoint sh "$IMAGE" -c "$REMOTE" || exit 1
  if [[ -n "$XPATHS" ]]; then
    collect_pinned "image:$iid" "$DOCKER" run --rm --pull never --network none \
      --read-only --cap-drop ALL --security-opt no-new-privileges \
      --entrypoint sh "$IMAGE" -c "$XREMOTE" || exit 1
  fi
  if nout="$("$DOCKER" run --rm --pull never --network none --read-only \
      --cap-drop ALL --security-opt no-new-privileges --entrypoint node "$IMAGE" \
      -e 'for(const s of ["@paperclipai/adapter-utils","@paperclipai/adapter-utils/server-utils"]){try{console.log("RESOLVE:"+s+"="+require.resolve(s))}catch(e){console.log("RESOLVE:"+s+"=UNRESOLVABLE")}}' 2>/dev/null)"; then
    printf '%s\n' "$nout" | sed 's/^/resolve|image|/'
  else
    printf 'FAIL: node resolution unavailable inside image %s\n' "$iid"
    exit 1
  fi
  if [[ -n "$JS_NAMES" ]]; then
    resolve_pkgs "resolve|image|" "image $iid" "$DOCKER" run --rm --pull never \
      --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
      --entrypoint node "$IMAGE" || exit 1
  fi
fi

# 3. running containers: same file proof plus the mount/overlay table.
for c in "$CONTAINER" "$SERVER_CONTAINER"; do
  [[ -n "$c" ]] || continue
  cimg="$("$DOCKER" inspect -f '{{.Image}}' "$c" 2>/dev/null)" \
    || { printf 'FAIL: container not found: %s\n' "$c"; exit 1; }
  printf 'container|%s|image|%s\n' "$c" "$cimg"
  # shellcheck disable=SC2086
  collect_remote "container:$c" "$DOCKER" exec "$c" sh -c "$REMOTE" || exit 1
  if [[ -n "$XPATHS" ]]; then
    collect_pinned "container:$c" "$DOCKER" exec "$c" sh -c "$XREMOTE" || exit 1
  fi
  mj="$("$DOCKER" inspect -f '{{json .Mounts}}' "$c" 2>/dev/null)"; mrc=$?
  [[ -n "$mj" ]] && printf '%s\n' "$mj" | sed "s/^/mounts|$c|/"
  if ((${#FORBID_MOUNTS[@]})); then
    # Fail closed: an unreadable, empty or malformed table is not "no mounts".
    [[ "$mrc" -eq 0 && -n "$mj" ]] || { printf 'FAIL: cannot read the mount table of %s\n' "$c"; exit 1; }
    dests="$(jq -r 'if . == null then empty elif type == "array" then .[] | (.Destination // error("mount without Destination")) else error("Mounts is not an array") end' <<<"$mj" 2>/dev/null)" \
      || { printf 'FAIL: unparseable mount table of %s\n' "$c"; exit 1; }
    MOUNT_CTRS+="${MOUNT_CTRS:+ }$c"
    while IFS= read -r d; do
      [[ -n "$d" ]] || continue
      for fm in "${FORBID_MOUNTS[@]}"; do
        covers "$d" "$fm" && MOUNT_FAILS+="FAIL: container $c mount $d covers forbidden path $fm (host overlay shadows the image build)"$'\n'
      done
    done <<<"$dests"
  fi
  if [[ -n "$JS_NAMES" ]]; then
    resolve_pkgs "resolve|container:$c|" "container $c" "$DOCKER" exec "$c" node || exit 1
  fi
done

# --- expectations --------------------------------------------------------------
rc=1
if [[ -z "$HASHES" ]]; then
  printf 'FAIL: no server-utils candidate file found anywhere probed\n'
  exit 1
fi
rc=0
if ((MARKER_OFF == 0)); then
  if [[ -n "$MARK_HITS" ]]; then
    printf 'ok: marker %s present in:\n%s\n' "$MARKER" "$MARK_HITS"
  else
    printf 'FAIL: marker %s absent from every collected file (stale/unpatched build?)\n' "$MARKER"
    rc=1
  fi
fi
for e in ${EXPECTS[@]+"${EXPECTS[@]}"}; do
  if grep -q "^${e} " <<<"$HASHES"; then
    printf 'ok: expected hash %s matched\n' "$e"
  else
    printf 'FAIL: expected hash %s matched no collected file\n' "$e"
    rc=1
  fi
done
for pp in ${EXPECT_PKGS[@]+"${EXPECT_PKGS[@]}"}; do
  name="${pp%%:*}"; want="${pp##*:}"
  got="$(awk -F'|' -v n="$name" '$1 == n { print $2; exit }' <<<"$PKG_HASHES")"
  if [[ -z "$got" ]]; then
    printf 'FAIL: inventoried package %s did not resolve inside the target (UNRESOLVABLE or never probed)\n' "$name"
    rc=1
  elif [[ "$got" == "$want" ]]; then
    printf 'ok: inventoried package %s resolves with expected package.json hash\n' "$name"
  else
    printf 'FAIL: inventoried package %s package.json hash %s != expected %s (image does not ship the inventoried build)\n' "$name" "$got" "$want"
    rc=1
  fi
done
# Pinned files hold in EVERY runtime target; a target that never reported the
# path is a FAIL, never a skip.
for xf in ${EXPECT_FILES[@]+"${EXPECT_FILES[@]}"}; do
  p="${xf%:*}"; want="${xf##*:}"
  while IFS= read -r t; do
    [[ -n "$t" ]] || continue
    got="$(xget "$t" "$p")"
    if [[ "$got" == "$want" ]]; then
      printf 'ok: pinned file %s in %s has expected sha256\n' "$p" "$t"
    elif [[ -z "$got" ]]; then
      printf 'FAIL: pinned file %s was not reported by %s\n' "$p" "$t"; rc=1
    else
      printf 'FAIL: pinned file %s in %s is %s, expected %s\n' "$p" "$t" "$got" "$want"; rc=1
    fi
  done <<<"$XTARGETS"
done
for xf in ${FORBID_FILES[@]+"${FORBID_FILES[@]}"}; do
  p="${xf%:*}"; bad="${xf##*:}"
  while IFS= read -r t; do
    [[ -n "$t" ]] || continue
    got="$(xget "$t" "$p")"
    if [[ -z "$got" || "$got" == "UNREADABLE" ]]; then
      printf 'FAIL: forbidden-file check of %s could not read it in %s (%s)\n' "$p" "$t" "${got:-not reported}"; rc=1
    elif [[ "$got" == "$bad" ]]; then
      printf 'FAIL: %s still carries forbidden build %s at %s\n' "$t" "$bad" "$p"; rc=1
    else
      printf 'ok: %s in %s is not the forbidden build (%s)\n' "$p" "$t" "$got"
    fi
  done <<<"$XTARGETS"
done
if ((${#FORBID_MOUNTS[@]})); then
  if [[ -z "$MOUNT_CTRS" ]]; then
    printf 'n/a: forbid-mount %s (no container target; images carry no mounts)\n' "${FORBID_MOUNTS[*]}"
  elif [[ -n "$MOUNT_FAILS" ]]; then
    printf '%s' "$MOUNT_FAILS"; rc=1
  else
    printf 'ok: no mount covers %s in %s\n' "${FORBID_MOUNTS[*]}" "$MOUNT_CTRS"
  fi
fi
((rc == 0)) && printf 'EFFECTIVE_BUILD PROVEN\n' || printf 'EFFECTIVE_BUILD UNPROVEN\n'
exit "$rc"
