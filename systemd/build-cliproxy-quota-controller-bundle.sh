#!/usr/bin/env bash
set -Eeuo pipefail

refuse() {
  printf 'REFUSED: %s\n' "$1" >&2
  exit 2
}

SOURCE_REF=""
OUTPUT=""
TRUSTED_LINE="origin/main"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-ref) SOURCE_REF="${2:-}"; shift 2;;
    --output) OUTPUT="${2:-}"; shift 2;;
    --trusted-line) TRUSTED_LINE="${2:-}"; shift 2;;
    *) refuse "unknown argument: $1";;
  esac
done

[[ "$SOURCE_REF" =~ ^[0-9a-f]{40}$ ]] || refuse "--source-ref must be a 40-hex commit"
[[ -n "$OUTPUT" ]] || refuse "--output is required"
[[ "$(git --no-replace-objects cat-file -t "$SOURCE_REF" 2>/dev/null)" == commit ]] \
  || refuse "--source-ref must name an available commit object"
git --no-replace-objects rev-parse -q --verify "$TRUSTED_LINE^{commit}" >/dev/null 2>&1 \
  || refuse "--trusted-line $TRUSTED_LINE does not resolve; fetch it first"
git --no-replace-objects merge-base --is-ancestor "$SOURCE_REF" "$TRUSTED_LINE" \
  || refuse "$SOURCE_REF is not an ancestor of $TRUSTED_LINE"

WORK_DIR=$(mktemp -d)
OUTPUT=$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$OUTPUT")
trap 'rm -rf "$WORK_DIR"' EXIT
files=(
  cliproxy_quota_contract.py
  cliproxy_quota_controller.py
  systemd/install-cliproxy-quota-controller.sh
  systemd/run-cliproxy-quota-controller.sh
  systemd/paperclip-cliproxy-quota-controller.service
  systemd/paperclip-cliproxy-quota-controller.timer
  systemd/cliproxy-quota-controller.env.example
)
for source in "${files[@]}"; do
  git --no-replace-objects cat-file -e "$SOURCE_REF:$source" \
    || refuse "reviewed commit is missing $source"
done
git --no-replace-objects archive --format=tar "$SOURCE_REF" "${files[@]}" | tar -x -C "$WORK_DIR"
printf '%s\n' "$SOURCE_REF" > "$WORK_DIR/REVISION"
(
  cd "$WORK_DIR"
  sha256sum "${files[@]}" REVISION > SHA256SUMS
  tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
    -cf "$OUTPUT" "${files[@]}" REVISION SHA256SUMS
)
printf 'BUILT %s from %s\n' "$OUTPUT" "$SOURCE_REF"
