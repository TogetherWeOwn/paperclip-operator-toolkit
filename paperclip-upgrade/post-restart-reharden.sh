#!/usr/bin/env bash
# ===========================================================================
# paperclip-upgrade/post-restart-reharden.sh — re-apply agent-immutability
# ownership after a Paperclip container restart.
#
# PORT NOTES (from the live host post-restart-reharden.sh):
#   - Same hardening set: $DATA/.local, $DATA/.gitconfig,
#     $DATA/plugin-packages-root (recursive real-root), plus the bounded
#     bounded Cargo pool root + policy.json NON-recursive (slot dirs
#     stay agent-writable or every Cargo admission fails).
#   - Verification probes run as the agent uid via `docker exec -u 1000`:
#     every hardened path must DENY writes, plus a throwaway-create probe
#     that is removed on success. Any writable path exits 1.
#   - Refuses (exit 2) on missing DATA dir or missing passwordless sudo
#     instead of half-hardening and reporting success.
#
# Exit status: 0 hardened and verified | 1 a probe failed | 2 refused
# ===========================================================================
set -uo pipefail

ME="${BASH_SOURCE[0]##*/}"
DATA_DIR="${PAPERCLIP_DATA:-${PAPERCLIP_HOME:-$HOME/.paperclip}/data}"
# Where the data dir is mounted INSIDE the server container (the agent-uid
# probes below run there), and the bounded Cargo pool dir relative to the data
# dir (set it to the deployment's pool mount; the default is a neutral name).
CONTAINER_DATA="${PAPERCLIP_CONTAINER_DATA:-/paperclip}"
POOL_REL="${PAPERCLIP_UPGRADE_CARGO_POOL_REL:-.cache/cargo-pool-bounded}"
SERVER_CONTAINER="${PAPERCLIP_UPGRADE_SERVER_CONTAINER:-paperclip}"
AGENT_UID="${PAPERCLIP_UPGRADE_AGENT_UID:-1000}"
DOCKER="${DOCKER:-docker}"

[[ -d "$DATA_DIR" ]] || { printf 'REFUSED: %s: data dir missing: %s\n' "$ME" "$DATA_DIR" >&2; exit 2; }
command -v "$DOCKER" >/dev/null || { printf 'REFUSED: %s: docker runtime is missing\n' "$ME" >&2; exit 2; }
sudo -n true 2>/dev/null || { printf 'REFUSED: %s: passwordless sudo is required for chown/chmod\n' "$ME" >&2; exit 2; }

targets=(
  "$DATA_DIR/.local"
  "$DATA_DIR/.gitconfig"
  "$DATA_DIR/plugin-packages-root"
)

for t in "${targets[@]}"; do
  if [[ ! -e "$t" ]]; then
    echo "skip (missing): $t"
    continue
  fi
  sudo -n chown -R --no-dereference 0:0 "$t"
  sudo -n chmod -R go-w "$t"
  echo "hardened: $t"
done

# Bounded Cargo pool: root + policy.json NON-recursive only.
POOL="$DATA_DIR/$POOL_REL"
if sudo -n mountpoint -q "$POOL" 2>/dev/null; then
  sudo -n chown --no-dereference 0:0 "$POOL" "$POOL/policy.json"
  sudo -n chmod 0755 "$POOL"
  sudo -n chmod 0644 "$POOL/policy.json"
  echo "hardened (non-recursive): $POOL + policy.json"
else
  echo "skip (pool not mounted): $POOL"
fi

# Verify as the agent uid. Only test -w plus a throwaway create; never touch
# real files.
rc=0
probe() {
  local path="$1"
  if "$DOCKER" exec -u "$AGENT_UID" "$SERVER_CONTAINER" sh -c "test -w '$path'" 2>/dev/null; then
    echo "FAIL: agent uid can write $path"
    return 1
  fi
  echo "ok (denied): $path"
}
for p in "$CONTAINER_DATA/.local" "$CONTAINER_DATA/.local/bin" "$CONTAINER_DATA/.gitconfig" "$CONTAINER_DATA/plugin-packages-root" /opt/paperclip-plugin-packages "$CONTAINER_DATA/$POOL_REL" "$CONTAINER_DATA/$POOL_REL/policy.json"; do
  probe "$p" || rc=1
done
if "$DOCKER" exec -u "$AGENT_UID" "$SERVER_CONTAINER" sh -c "echo x > '$CONTAINER_DATA/.local/bin/.operator-probe' 2>/dev/null"; then
  echo "FAIL: agent uid created a file in $CONTAINER_DATA/.local/bin"
  "$DOCKER" exec "$SERVER_CONTAINER" rm -f "$CONTAINER_DATA/.local/bin/.operator-probe"
  rc=1
else
  echo "ok (denied): create in $CONTAINER_DATA/.local/bin"
fi
exit "$rc"
