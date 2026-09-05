#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CARRIER="$ROOT/deploy/paperclip-immutable/paperclip.container"
RUN_CARRIER="$ROOT/deploy/paperclip-immutable/agent-run.container.in"
GENERATOR_EVIDENCE="$ROOT/deploy/paperclip-immutable/generated/board-quadlet-render.json"
GENERATOR_EVIDENCE_SHA256=5a90ad01ac38fa4191b5e69e95456f7a6fdba9ef6a970240d5a0778eac0bdba1
GENERATOR_EVIDENCE_CANDIDATE=1fc7579403e84913eec7e4f7761b79db83670c06
GENERATOR_EVIDENCE_TREE=aea5a3b896afecd47cbdf8090d1980e5d98967a7
GENERATOR_EVIDENCE_PARENT=a34e24e1cc514b7a2683de4658240bc820f5d362

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
  'Network=omniroute.network' \
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
# Both legs, each exactly once and each in the UNIT namespace. `Network=systemd-X`
# reaches the right leg but is a literal reference with no Requires=/After=, so it
# races network creation at boot and passes every manual test.
assert_count "$CARRIER" 1 '^Network=paperclip\.network$'
assert_count "$CARRIER" 1 '^Network=omniroute\.network$'
assert_count "$CARRIER" 0 '^Network=systemd-'
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

# The checked-in evidence is a sanitized capture of disposable revised-carrier dry-runs
# from the installed Podman 4.9.3/systemd 255 generator. Fail closed unless the exact
# carrier bytes and evidence bytes remain bound to that capture.
[ -f "$GENERATOR_EVIDENCE" ] || fail 'sanitized generated ExecStart evidence is missing'
[ "$(sha256sum "$GENERATOR_EVIDENCE" | cut -d' ' -f1)" = "$GENERATOR_EVIDENCE_SHA256" ] || fail 'generated ExecStart evidence hash drifted'
mapfile -t generated_values < <(python3 - \
  "$GENERATOR_EVIDENCE" "$CARRIER" "$RUN_CARRIER" \
  "$GENERATOR_EVIDENCE_CANDIDATE" "$GENERATOR_EVIDENCE_TREE" "$GENERATOR_EVIDENCE_PARENT" <<'PY'
import hashlib
import json
import re
import sys
from pathlib import Path

evidence_path, server_path, run_path = map(Path, sys.argv[1:4])
expected_commit, expected_tree, expected_parent = sys.argv[4:]
evidence = json.loads(evidence_path.read_text())

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

IMAGE_LINE = re.compile(rb"(?m)^Image=.*$")

def normalized_digest(path):
    # Collapse every `Image=` line to one constant, mirroring exactly what
    # capture_host_render.sh does before handing the unit to the generator.
    return hashlib.sha256(
        IMAGE_LINE.sub(b"Image=<SUBSTITUTED>", path.read_bytes())
    ).hexdigest()

candidate = evidence["candidate"]
if candidate["commit"] != expected_commit:
    raise SystemExit("generated evidence candidate commit drifted")
if candidate["tree"] != expected_tree:
    raise SystemExit("generated evidence candidate tree drifted")
if candidate["parent"] != expected_parent:
    raise SystemExit("generated evidence candidate parent drifted")
actual = {"server": digest(server_path), "run": digest(run_path)}
expected = {
    "server": candidate["serverCarrierSha256"],
    "run": candidate["runCarrierSha256"],
}
norm_actual = {"server": normalized_digest(server_path), "run": normalized_digest(run_path)}
norm_expected = {
    "server": candidate.get("serverCarrierNormalizedSha256"),
    "run": candidate.get("runCarrierNormalizedSha256"),
}

for key in ("server", "run"):
    # The raw bytes moving is tolerated ONLY when the sole difference is the
    # `Image=` line, which capture_host_render.sh substitutes away before the
    # generator ever sees the unit — so it cannot have changed what was
    # rendered. Sharing a normalized hash proves the files are identical
    # everywhere else, because normalization rewrites only `^Image=` lines.
    #
    # This exists so that pinning the board-approved digest (step 3 of the
    # activation sequence) does not re-stale a fresh render and cost a SECOND
    # scarce human host window. Any edit outside that one line moves the
    # normalized hash too and is STALE, as it must be.
    #
    # Computed as a flag rather than `continue`d on: an early continue here
    # would also skip the exitCode check below, silently accepting a render
    # whose generator failed.
    #
    # ONE expression, deliberately. An earlier two-clause version read
    #     norm_expected[key] is not None and norm_expected[key] == norm_actual[key]
    # and deleting the equality clause left `is not None` — which is TRUE for
    # every fresh render, so the relaxation would have swallowed ANY carrier
    # edit. A guard whose parts fail open when separated should not have parts.
    # No None check is needed: norm_actual is always a 64-hex digest, so a
    # missing (None) norm_expected simply compares unequal and stays STALE.
    image_line_only = norm_expected[key] == norm_actual[key]
    if expected[key] != actual[key] and not image_line_only:
        # The render is a HOST-produced artifact: it records what the installed
        # Quadlet generator actually emitted for one exact set of carrier bytes.
        # A carrier edit therefore invalidates it, and the ONLY way to restore
        # the binding is to re-run the generator on the host. Editing the pinned
        # hash to match the new carrier would reattach the name to bytes no
        # generator ever saw — the same fail-open class as `touch`ing a .network
        # unit to clear network_units. Say which side moved, and say that.
        raise SystemExit(
            f"{key} carrier hash does not match generated evidence: "
            f"carrier is {actual[key]}, render was captured from "
            f"{expected[key]}. The carrier changed after the render; the "
            f"render is STALE. Re-run the generator on the host and check in "
            f"a fresh board-quadlet-render.json. Do NOT edit the pinned hash "
            f"to match — that binds the evidence to bytes never generated."
        )
    if evidence[key]["exitCode"] != 0:
        raise SystemExit(f"{key} generator evidence is not successful")
print(evidence["server"]["execStart"])
print(evidence["run"]["execStart"])
PY
)
# The python above exits non-zero with the real cause on stderr, but under
# `mapfile < <(...)` that status is lost and only the line COUNT survives. A
# count is a symptom; reporting it as the failure is how a stale host render
# got read as "the suite is green" on TOG-714. Point the reader at stderr.
[ "${#generated_values[@]}" -eq 2 ] || fail 'generated evidence did not yield two ExecStart values — see the SystemExit reason printed above for the actual cause (commonly: the carrier was edited, so the host render is stale)'
server_exec=${generated_values[0]}
run_exec=${generated_values[1]}
for exec_start in "$server_exec" "$run_exec"; do
  [ "$(grep -oE -- '(^|[[:space:]])--read-only([=[:space:]]|$)' <<<"$exec_start" | wc -l)" -eq 1 ] || fail 'generated ExecStart lacks exactly one whole-root --read-only'
  ! grep -q -- '--read-only=false' <<<"$exec_start" || fail 'generated ExecStart contains fail-open --read-only=false'
done
# Assert BOTH legs by identity, from the host-produced render. Checking only
# systemd-paperclip fails open in exactly the case this issue exists to prevent:
# a fresh render of the two-leg carrier whose OmniRoute leg did not generate
# still passed, so loopback /api/health would be GREEN with no model gateway.
# Compare the leg SET, not a count -- two identical Network= keys render two
# identical tokens and would satisfy any count-based check.
mapfile -t server_legs < <(grep -oE -- '--network=[^[:space:]]+' <<<"$server_exec" | sed 's/^--network=//' | sort -u)
for required_leg in systemd-paperclip systemd-omniroute; do
  printf '%s\n' "${server_legs[@]}" | grep -Fqx "$required_leg" \
    || fail "server ExecStart lacks generated leg --network=$required_leg (generated legs: ${server_legs[*]:-none}). A carrier leg that does not appear here did not generate on the host; recreating drops it while loopback /api/health stays GREEN."
done
[ "${#server_legs[@]}" -eq 2 ] || fail "server ExecStart generated ${#server_legs[@]} distinct legs, expected exactly 2 (got: ${server_legs[*]:-none})"
grep -Fq -- '--tmpfs /tmp:rw,nosuid,nodev,noexec,size=24g,mode=1777' <<<"$server_exec" || fail 'server ExecStart lacks generated measured /tmp sizing'
grep -Eq -- '(^|[[:space:]])--network=none([[:space:]]|$)' <<<"$run_exec" || fail 'run ExecStart is not network-isolated'
grep -Eq -- '(^|[[:space:]])--user 61111:61112([[:space:]]|$)' <<<"$run_exec" || fail 'run ExecStart lacks distinct run identity'
grep -Fq -- '-v /run/paperclip-runs/run-a:/run/paperclip-run:rw,Z' <<<"$run_exec" || fail 'run ExecStart lacks generated run-root bind'
grep -Fq -- '-v /run/paperclip-runs/run-a/workspace:/workspace:rw,Z' <<<"$run_exec" || fail 'run ExecStart lacks generated workspace bind'

# TOG-1141. Everything below this line measures kernel behaviour inside an
# unprivileged user namespace: a read-only bind mount, then a uid/gid map. If
# userns is unavailable, `unshare` exits 1 with "write failed
# /proc/self/uid_map: Operation not permitted" -- which is byte-for-byte
# indistinguishable, from outside this script, from the carrier/render binding
# genuinely being broken. It was read that way for the whole of this window.
#
# So refuse instead, exit 3: a comparison that did not happen must not read as
# an answer (TOG-357). Checked here, after the pure-bytes assertions above, so
# a host without userns still gets the carrier verdict it CAN give.
if ! unshare -Urnm true 2>/dev/null; then
  printf 'REFUSE: unprivileged user namespaces are unavailable here (unshare -Urnm failed).\n' >&2
  printf '        This suite measures a read-only bind mount and a uid/gid map; without\n' >&2
  printf '        userns it can measure NEITHER, so it reports no verdict on the carrier.\n' >&2
  printf '        This is NOT a carrier/render binding failure -- do not read it as one.\n' >&2
  printf '        kernel.apparmor_restrict_unprivileged_userns=%s user.max_user_namespaces=%s\n' \
    "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo unset)" \
    "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo unset)" >&2
  printf '        On GitHub-hosted ubuntu-24.04, AppArmor restricts unprivileged userns;\n' >&2
  printf '        the CI step re-enables it with sysctl before invoking this suite.\n' >&2
  exit 3
fi

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

printf 'PASS: carrier hashes bind to sanitized Podman 4.9.3/systemd 255 generated ExecStart evidence with exactly one whole-root read-only setting\n'
printf 'PASS: every negative mutation preserved the complete path/type/mode/uid/gid/link/content manifest\n'
printf 'PASS: launcher ownership handoff enabled distinct-UID workspace/cache/store/dependency/tmp writes\n'
