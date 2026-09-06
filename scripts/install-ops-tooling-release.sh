#!/usr/bin/env bash
set -Eeuo pipefail

readonly MANIFEST_PATH=ops-tooling-runtime-manifest.txt
readonly DEFAULT_INSTALL_BASE=/opt/paperclip-ops-tooling
readonly -a REQUIRED_MARKERS=(
  tool_drift.sh
  capability_gate.sh
  org_request_queue.sh
  quota_brake.sh
)

usage() {
  cat <<'USAGE'
Usage:
  sudo ./scripts/install-ops-tooling-release.sh --source-ref <40-hex-commit>

Exports the fixed runtime manifest from the explicitly reviewed commit into
/opt/paperclip-ops-tooling/releases/<commit>/ and atomically publishes current.
It never fetches or resolves a branch at runtime.
USAGE
}

refuse() {
  printf 'REFUSED: %s\n' "$1" >&2
  exit 2
}

SOURCE_REF=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-ref) SOURCE_REF="${2:-}"; shift 2;;
    --help|-h) usage; exit 0;;
    *) refuse "unknown argument: $1";;
  esac
done

[[ "$SOURCE_REF" =~ ^[0-9a-f]{40}$ ]] || refuse "--source-ref must be a 40-hex commit"

TEST_MODE="${OPS_TOOLING_INSTALL_TEST_MODE:-0}"
case "$TEST_MODE" in
  0)
    [[ $EUID -eq 0 ]] || refuse "installer must run as root"
    [[ -z "${OPS_TOOLING_INSTALL_BASE:-}" ]] || refuse "OPS_TOOLING_INSTALL_BASE is test-only"
    INSTALL_BASE="$DEFAULT_INSTALL_BASE"
    EXPECT_UID=0
    EXPECT_GID=0
    ;;
  1)
    INSTALL_BASE="${OPS_TOOLING_INSTALL_BASE:?set OPS_TOOLING_INSTALL_BASE in test mode}"
    EXPECT_UID="${OPS_TOOLING_INSTALL_EXPECT_UID:-$(id -u)}"
    EXPECT_GID="${OPS_TOOLING_INSTALL_EXPECT_GID:-$(id -g)}"
    ;;
  *) refuse "OPS_TOOLING_INSTALL_TEST_MODE must be 0 or 1";;
esac
[[ "$INSTALL_BASE" == /* && "$INSTALL_BASE" != / ]] || refuse "install base must be an absolute non-root path"
[[ "$EXPECT_UID" =~ ^[0-9]+$ && "$EXPECT_GID" =~ ^[0-9]+$ ]] || refuse "expected uid/gid must be decimal integers"

for command in git install python3 mktemp tar bash sha256sum mv ln chown id; do
  command -v "$command" >/dev/null || refuse "required command missing: $command"
done

source_type=$(git --no-replace-objects cat-file -t "$SOURCE_REF" 2>/dev/null) || refuse "--source-ref does not name an available object"
[[ "$source_type" == commit ]] || refuse "--source-ref must name a commit object directly"
manifest_type=$(git --no-replace-objects cat-file -t "$SOURCE_REF:$MANIFEST_PATH" 2>/dev/null) || refuse "reviewed commit is missing $MANIFEST_PATH"
[[ "$manifest_type" == blob ]] || refuse "$MANIFEST_PATH is not a blob"

WORK_DIR=$(mktemp -d)
TARGET_STAGE=""
POINTER_TMP=""
cleanup() {
  [[ -z "$POINTER_TMP" ]] || rm -f -- "$POINTER_TMP"
  [[ -z "$TARGET_STAGE" ]] || rm -rf -- "$TARGET_STAGE"
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

MANIFEST_COPY="$WORK_DIR/$MANIFEST_PATH"
git --no-replace-objects cat-file blob "$SOURCE_REF:$MANIFEST_PATH" > "$MANIFEST_COPY"

manifest_rows_text=$(python3 - "$MANIFEST_COPY" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
rows = []
seen = set()
for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    match = re.fullmatch(r"(0444|0555) ([A-Za-z0-9._/-]+)", line)
    if not match:
        raise SystemExit(f"invalid manifest row {number}: {raw!r}")
    mode, member = match.groups()
    parts = pathlib.PurePosixPath(member).parts
    if member.startswith("/") or not parts or any(part in {"", ".", ".."} for part in parts):
        raise SystemExit(f"unsafe manifest path at row {number}: {member!r}")
    if member in seen:
        raise SystemExit(f"duplicate manifest path at row {number}: {member!r}")
    seen.add(member)
    rows.append((mode, member))
if not rows:
    raise SystemExit("runtime manifest is empty")
if [member for _, member in rows] != sorted(member for _, member in rows):
    raise SystemExit("runtime manifest paths must be sorted")
for mode, member in rows:
    print(f"{mode}\t{member}")
PY
) || refuse "reviewed runtime manifest is invalid"
mapfile -t manifest_rows <<< "$manifest_rows_text"

manifest_paths=()
declare -A manifest_modes=()
for row in "${manifest_rows[@]}"; do
  IFS=$'\t' read -r mode member <<< "$row"
  manifest_paths+=("$member")
  manifest_modes["$member"]="$mode"
done
for marker in "${REQUIRED_MARKERS[@]}"; do
  [[ "${manifest_modes[$marker]:-}" == 0555 ]] || refuse "runtime manifest must install marker $marker as 0555"
done
for member in "${manifest_paths[@]}"; do
  member_type=$(git --no-replace-objects cat-file -t "$SOURCE_REF:$member" 2>/dev/null) || refuse "reviewed commit is missing manifest member $member"
  [[ "$member_type" == blob ]] || refuse "manifest member $member is not a blob"
done

SOURCE_ROOT="$WORK_DIR/source"
install -d -m 0700 "$SOURCE_ROOT"
git --no-replace-objects archive --format=tar "$SOURCE_REF" "$MANIFEST_PATH" "${manifest_paths[@]}" | tar -x -C "$SOURCE_ROOT" --no-same-owner --no-same-permissions

verify_source_tree() {
  python3 - "$SOURCE_ROOT" "$MANIFEST_COPY" "${manifest_paths[@]}" <<'PY'
import os
import pathlib
import stat
import sys

root = pathlib.Path(sys.argv[1]).resolve()
manifest = pathlib.Path(sys.argv[2]).read_bytes()
exported_manifest = root / "ops-tooling-runtime-manifest.txt"
if exported_manifest.is_symlink() or not exported_manifest.is_file() or exported_manifest.read_bytes() != manifest:
    raise SystemExit("exported runtime manifest is not the reviewed regular file")
for raw in sys.argv[3:]:
    path = root / raw
    try:
        info = path.lstat()
    except FileNotFoundError:
        raise SystemExit(f"manifest member is absent: {raw}")
    if not stat.S_ISREG(info.st_mode):
        raise SystemExit(f"manifest member is not regular: {raw}")
    resolved = path.resolve(strict=True)
    try:
        resolved.relative_to(root)
    except ValueError:
        raise SystemExit(f"manifest member escapes release root: {raw}")
    parent = path.parent
    while parent != root:
        parent_info = parent.lstat()
        if not stat.S_ISDIR(parent_info.st_mode) or stat.S_ISLNK(parent_info.st_mode):
            raise SystemExit(f"manifest parent is not a real directory: {raw}")
        parent = parent.parent
PY
}
verify_source_tree || refuse "exported runtime manifest failed regular-file/path containment validation"

for member in "${manifest_paths[@]}"; do
  case "$member" in
    *.sh) bash -n "$SOURCE_ROOT/$member" || refuse "shell syntax preflight failed: $member";;
    *.py)
      python3 - "$SOURCE_ROOT/$member" <<'PY' || refuse "Python syntax preflight failed: $member"
import pathlib
import sys
compile(pathlib.Path(sys.argv[1]).read_bytes(), sys.argv[1], "exec")
PY
      ;;
  esac
done

PREFLIGHT="$WORK_DIR/preflight"
install -d -m 0700 "$PREFLIGHT"
preflight_env=(
  env -i
  "PATH=$PREFLIGHT/bin:$PATH"
  "HOME=$PREFLIGHT/home"
  "TMPDIR=$PREFLIGHT"
  "COMPANY_ID=00000000-0000-0000-0000-000000000000"
  "ORG_SNAPSHOT=$PREFLIGHT/empty-roster.tsv"
  "QUEUE=$PREFLIGHT/provisioner-queue.jsonl"
  "GRANT_LOG=$PREFLIGHT/provisioner-grant.jsonl"
  "CAPABILITY_QUEUE=$PREFLIGHT/capability-queue.jsonl"
  "CAPABILITY_LOG=$PREFLIGHT/capability-grant.jsonl"
  "QUOTA_PACING_FILE=$PREFLIGHT/quota-pacing.jsonl"
  "PAPERCLIP_SQL_BACKEND=psql"
  "DATABASE_URL=postgresql://invalid@127.0.0.1:1/invalid"
  "PAPERCLIP_CLI=$PREFLIGHT/bin/paperclipai"
)
install -d -m 0700 "$PREFLIGHT/home" "$PREFLIGHT/bin"
: > "$PREFLIGHT/empty-roster.tsv"
cat > "$PREFLIGHT/bin/psql" <<'SH'
#!/usr/bin/env bash
exit 70
SH
cat > "$PREFLIGHT/bin/paperclipai" <<'SH'
#!/usr/bin/env bash
exit 70
SH
chmod 0700 "$PREFLIGHT/bin/psql" "$PREFLIGHT/bin/paperclipai"
"${preflight_env[@]}" bash "$SOURCE_ROOT/tool_drift.sh" --help >/dev/null || refuse "runtime preflight failed: tool_drift.sh"
"${preflight_env[@]}" bash "$SOURCE_ROOT/capability_gate.sh" >/dev/null || refuse "runtime preflight failed: capability_gate.sh"
"${preflight_env[@]}" bash "$SOURCE_ROOT/org_request_queue.sh" >/dev/null || refuse "runtime preflight failed: org_request_queue.sh"
"${preflight_env[@]}" bash "$SOURCE_ROOT/quota_brake.sh" --help >/dev/null || refuse "runtime preflight failed: quota_brake.sh"
"${preflight_env[@]}" bash "$SOURCE_ROOT/org_provisioner.sh" template-keys >/dev/null || refuse "runtime preflight failed: org_provisioner.sh"
python3 "$SOURCE_ROOT/pacing_verdict.py" --help >/dev/null || refuse "runtime preflight failed: pacing_verdict.py"
printf '{}\n' | "$SOURCE_ROOT/lib/durable_queue.py" append "$PREFLIGHT/durable-queue.jsonl" || refuse "runtime preflight failed: lib/durable_queue.py"
[[ "$(cat "$PREFLIGHT/durable-queue.jsonl")" == '{}' ]] || refuse "runtime preflight produced no durable queue row"

RELEASES_DIR="$INSTALL_BASE/releases"
RELEASE_DIR="$RELEASES_DIR/$SOURCE_REF"
TARGET_STAGE="$RELEASES_DIR/.stage.$SOURCE_REF.$$"

if [[ -e "$INSTALL_BASE/current" && ! -L "$INSTALL_BASE/current" ]]; then
  refuse "current exists and is not a symlink"
fi

ensure_directory() {
  local path="$1"
  if [[ -e "$path" || -L "$path" ]]; then
    [[ -d "$path" && ! -L "$path" ]] || refuse "required ancestor is not a real directory: $path"
    python3 - "$path" "$EXPECT_UID" "$EXPECT_GID" <<'PY' || refuse "required ancestor has mutable ownership/mode: $path"
import pathlib
import stat
import sys
path = pathlib.Path(sys.argv[1])
info = path.lstat()
if info.st_uid != int(sys.argv[2]) or info.st_gid != int(sys.argv[3]) or stat.S_IMODE(info.st_mode) != 0o755:
    raise SystemExit(1)
PY
  else
    install -d -o "$EXPECT_UID" -g "$EXPECT_GID" -m 0755 "$path"
  fi
}

ancestor=$(dirname "$INSTALL_BASE")
while [[ "$ancestor" != / && ! -e "$ancestor" && ! -L "$ancestor" ]]; do
  ancestor=$(dirname "$ancestor")
done
[[ -d "$ancestor" && ! -L "$ancestor" ]] || refuse "nearest existing install ancestor is not a real directory: $ancestor"
for directory in "$(dirname "$INSTALL_BASE")" "$INSTALL_BASE" "$RELEASES_DIR"; do
  ensure_directory "$directory"
done
[[ ! -e "$TARGET_STAGE" ]] || refuse "staging path already exists: $TARGET_STAGE"
install -d -o "$EXPECT_UID" -g "$EXPECT_GID" -m 0755 "$TARGET_STAGE"

for member in "${manifest_paths[@]}"; do
  destination="$TARGET_STAGE/$member"
  install -d -o "$EXPECT_UID" -g "$EXPECT_GID" -m 0755 "$(dirname "$destination")"
  install -o "$EXPECT_UID" -g "$EXPECT_GID" -m "${manifest_modes[$member]}" "$SOURCE_ROOT/$member" "$destination"
done
install -o "$EXPECT_UID" -g "$EXPECT_GID" -m 0444 "$MANIFEST_COPY" "$TARGET_STAGE/.release-manifest"
printf '%s\n' "$SOURCE_REF" > "$WORK_DIR/REVISION"
install -o "$EXPECT_UID" -g "$EXPECT_GID" -m 0444 "$WORK_DIR/REVISION" "$TARGET_STAGE/REVISION"
(
  cd "$TARGET_STAGE"
  sha256sum "${manifest_paths[@]}" .release-manifest REVISION > "$WORK_DIR/SHA256SUMS"
)
install -o "$EXPECT_UID" -g "$EXPECT_GID" -m 0444 "$WORK_DIR/SHA256SUMS" "$TARGET_STAGE/SHA256SUMS"

verify_release() {
  local root="$1"
  python3 - "$root" "$EXPECT_UID" "$EXPECT_GID" "${manifest_rows[@]}" <<'PY'
import hashlib
import os
import pathlib
import stat
import sys

root = pathlib.Path(sys.argv[1])
uid = int(sys.argv[2])
gid = int(sys.argv[3])
rows = [row.split("\t", 1) for row in sys.argv[4:]]
expected = {path: int(mode, 8) for mode, path in rows}
expected.update({".release-manifest": 0o444, "REVISION": 0o444, "SHA256SUMS": 0o444})
if root.is_symlink() or not root.is_dir():
    raise SystemExit("release root is not a real directory")
for directory, names, files in os.walk(root, followlinks=False):
    path = pathlib.Path(directory)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise SystemExit(f"release directory is not real: {path}")
    if info.st_uid != uid or info.st_gid != gid or stat.S_IMODE(info.st_mode) != 0o755:
        raise SystemExit(f"release directory has mutable ownership/mode: {path}")
    for name in names:
        child = path / name
        if child.is_symlink():
            raise SystemExit(f"release contains a symlink: {child}")
actual = set()
for path in root.rglob("*"):
    if path.is_dir():
        continue
    relative = path.relative_to(root).as_posix()
    actual.add(relative)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise SystemExit(f"release member is not regular: {relative}")
    if relative not in expected:
        raise SystemExit(f"release contains unexpected file: {relative}")
    if info.st_uid != uid or info.st_gid != gid or stat.S_IMODE(info.st_mode) != expected[relative]:
        raise SystemExit(f"release member has mutable ownership/mode: {relative}")
if actual != set(expected):
    raise SystemExit(f"release file set differs: missing={sorted(set(expected)-actual)} extra={sorted(actual-set(expected))}")
checks = {}
for line in (root / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
    digest, relative = line.split("  ", 1)
    checks[relative] = digest
if set(checks) != set(expected) - {"SHA256SUMS"}:
    raise SystemExit("SHA256SUMS does not cover the exact release byte set")
for relative, digest in checks.items():
    if hashlib.sha256((root / relative).read_bytes()).hexdigest() != digest:
        raise SystemExit(f"release checksum mismatch: {relative}")
PY
}
verify_release "$TARGET_STAGE" || refuse "staged release failed ownership, mode, file-set, or checksum verification"

if [[ -e "$RELEASE_DIR" || -L "$RELEASE_DIR" ]]; then
  verify_release "$RELEASE_DIR" || refuse "existing release path is not the immutable reviewed release"
  python3 - "$TARGET_STAGE" "$RELEASE_DIR" <<'PY' || refuse "different byte set already exists at release path"
import pathlib
import sys
left = pathlib.Path(sys.argv[1])
right = pathlib.Path(sys.argv[2])
left_files = {p.relative_to(left).as_posix(): p.read_bytes() for p in left.rglob("*") if p.is_file()}
right_files = {p.relative_to(right).as_posix(): p.read_bytes() for p in right.rglob("*") if p.is_file()}
if left_files != right_files:
    raise SystemExit(1)
PY
  rm -rf -- "$TARGET_STAGE"
  TARGET_STAGE=""
else
  mv -T -- "$TARGET_STAGE" "$RELEASE_DIR"
  TARGET_STAGE=""
fi
verify_release "$RELEASE_DIR" || refuse "published release failed final verification"

POINTER_TMP="$INSTALL_BASE/.current.$SOURCE_REF.$$"
ln -s "releases/$SOURCE_REF" "$POINTER_TMP"
chown -h "$EXPECT_UID:$EXPECT_GID" "$POINTER_TMP"
mv -Tf -- "$POINTER_TMP" "$INSTALL_BASE/current"
POINTER_TMP=""

resolved=$(python3 - "$INSTALL_BASE/current" "$EXPECT_UID" "$EXPECT_GID" <<'PY'
import pathlib
import sys
path = pathlib.Path(sys.argv[1])
info = path.lstat()
if not path.is_symlink() or info.st_uid != int(sys.argv[2]) or info.st_gid != int(sys.argv[3]):
    raise SystemExit("current is not the owned release symlink")
print(path.resolve(strict=True))
PY
) || refuse "published current pointer is not an owned resolving symlink"
[[ "$resolved" == "$RELEASE_DIR" ]] || refuse "published current pointer resolved outside the release path"

printf 'INSTALLED ops-tooling release %s\n' "$SOURCE_REF"
printf 'current: %s -> releases/%s\n' "$INSTALL_BASE/current" "$SOURCE_REF"
printf 'legacy top-level files under %s were not modified\n' "$INSTALL_BASE"
