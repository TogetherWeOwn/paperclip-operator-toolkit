#!/usr/bin/env bash
set -euo pipefail

# One-shot host-to-agent handoff for the TOG-554 rehearsal authorization.
# The sanitized authorization is created and removed on the host, while its
# consumption and primary cleanup happen inside the reviewed agent container.

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
EVIDENCE_LOG=${OMNIROUTE_REHEARSAL_EVIDENCE_LOG:-$HOME/.omniroute-rehearsal-state/evidence/evidence.jsonl}
AGENT_CONTAINER=${OMNIROUTE_PROBE_CONTAINER:?set the reviewed running agent container}
AGENT_DIR=${OMNIROUTE_REHEARSAL_AGENT_AUTHORIZATION_DIR:-/tmp/omniroute-rehearsal-auth-tog554}
AUTHORIZATION_AGENT=$AGENT_DIR/evidence.json
WRAPPER_AGENT=$AGENT_DIR/rehearsal_endpoint_preflight.sh
TOOL_AGENT=$AGENT_DIR/agent_endpoint_preflight.sh
agent_cleanup_needed=0

fail() {
  printf 'rehearsal_authorized_preflight: %s\n' "$*" >&2
  exit 7
}

cleanup_agent() {
  (( agent_cleanup_needed == 1 )) || return 0
  podman exec -u node "$AGENT_CONTAINER" sh -ceu '
    authorization_dir=$1
    rm -f -- "$authorization_dir/evidence.json" \
      "$authorization_dir/rehearsal_endpoint_preflight.sh" \
      "$authorization_dir/agent_endpoint_preflight.sh"
    rmdir -- "$authorization_dir" 2>/dev/null || true
    test ! -e "$authorization_dir"
    test ! -L "$authorization_dir"
  ' sh "$AGENT_DIR"
  agent_cleanup_needed=0
}

cleanup() {
  original_rc=$?
  trap - EXIT HUP INT TERM
  set +e

  cleanup_rc=0
  cleanup_agent || cleanup_rc=$?
  (( original_rc != 0 || cleanup_rc == 0 )) || original_rc=$cleanup_rc
  exit "$original_rc"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

command -v git >/dev/null 2>&1 || fail 'git is required'
command -v jq >/dev/null 2>&1 || fail 'jq is required'
command -v podman >/dev/null 2>&1 || fail 'podman is required'
command -v python3 >/dev/null 2>&1 || fail 'python3 is required'

repo_root=$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null) || fail 'run from the reviewed git checkout'
[[ $repo_root == "$HERE" ]] || fail 'script must remain at the reviewed checkout root'
for path in rehearsal_authorized_preflight.sh rehearsal_endpoint_preflight.sh agent_endpoint_preflight.sh; do
  [[ $(git -C "$HERE" hash-object "$HERE/$path") == "$(git -C "$HERE" rev-parse "HEAD:$path")" ]] \
    || fail "$path differs from the reviewed commit"
done

[[ -f $EVIDENCE_LOG && ! -L $EVIDENCE_LOG ]] || fail 'sanitized evidence log is missing or unsafe'
[[ $(stat -c %u "$EVIDENCE_LOG") == "$(id -u)" ]] || fail 'sanitized evidence log owner is unsafe'
[[ $(stat -c %a "$EVIDENCE_LOG") == 600 ]] || fail 'sanitized evidence log mode is unsafe'

podman exec -u node "$AGENT_CONTAINER" sh -ceu '
  test ! -e "$1"
  test ! -L "$1"
  umask 077
  install -d -m 0700 "$1"
' sh "$AGENT_DIR"
agent_cleanup_needed=1

stream_to_agent() {
  destination_file=$1
  destination_mode=$2
  podman exec -i -u node "$AGENT_CONTAINER" python3 -c '
import os, stat, sys
path = sys.argv[1]
mode = int(sys.argv[2], 8)
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
try:
    while True:
        chunk = sys.stdin.buffer.read(65536)
        if not chunk:
            break
        os.write(fd, chunk)
    os.fsync(fd)
finally:
    os.close(fd)
st = os.stat(path, follow_symlinks=False)
if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != mode:
    raise SystemExit("agent-container handoff destination ownership or mode is unsafe")
' "$destination_file" "$destination_mode"
}

jq -sc '
  [.[] | select(
    .mode == "apply"
    and .result == "success"
    and .alias == "omniroute-rehearse"
    and (.containerId | test("^[0-9a-f]{12,64}$"))
    and (.dnsAddressSha256 | test("^[0-9a-f]{64}$"))
  )]
  | if length == 0 then error("no successful rehearsal authorization row") else last end
' "$EVIDENCE_LOG" | stream_to_agent "$AUTHORIZATION_AGENT" 0600
git -C "$HERE" show HEAD:rehearsal_endpoint_preflight.sh | stream_to_agent "$WRAPPER_AGENT" 0700
git -C "$HERE" show HEAD:agent_endpoint_preflight.sh | stream_to_agent "$TOOL_AGENT" 0700

wrapper_sha=$(git -C "$HERE" show HEAD:rehearsal_endpoint_preflight.sh | sha256sum | cut -d' ' -f1)
tool_sha=$(git -C "$HERE" show HEAD:agent_endpoint_preflight.sh | sha256sum | cut -d' ' -f1)
podman exec -u node "$AGENT_CONTAINER" sh -ceu '
  authorization_dir=$1
  authorization_file=$2
  authorization_wrapper=$3
  authorization_tool=$4
  expected_wrapper_sha=$5
  expected_tool_sha=$6

  cleanup() {
    original_rc=$?
    trap - EXIT HUP INT TERM
    set +e
    rm -f -- "$authorization_file" "$authorization_wrapper" "$authorization_tool"
    cleanup_rc=$?
    rmdir -- "$authorization_dir" 2>/dev/null
    rmdir_rc=$?
    if [ "$cleanup_rc" -eq 0 ] && [ "$rmdir_rc" -ne 0 ]; then cleanup_rc=$rmdir_rc; fi
    if [ "$original_rc" -eq 0 ] && [ "$cleanup_rc" -ne 0 ]; then original_rc=$cleanup_rc; fi
    exit "$original_rc"
  }
  trap cleanup EXIT
  trap "exit 129" HUP
  trap "exit 130" INT
  trap "exit 143" TERM

  test -f "$authorization_file"
  test ! -L "$authorization_file"
  test "$(stat -c %u "$authorization_file")" = "$(id -u)"
  test "$(stat -c %a "$authorization_file")" = 600
  test "$(sha256sum "$authorization_wrapper" | cut -d" " -f1)" = "$expected_wrapper_sha"
  test "$(sha256sum "$authorization_tool" | cut -d" " -f1)" = "$expected_tool_sha"
  export OMNIROUTE_REHEARSAL_AUTHORIZATION_FILE="$authorization_file"
  "$authorization_wrapper"
' sh "$AGENT_DIR" "$AUTHORIZATION_AGENT" "$WRAPPER_AGENT" "$TOOL_AGENT" "$wrapper_sha" "$tool_sha"

cleanup_agent
