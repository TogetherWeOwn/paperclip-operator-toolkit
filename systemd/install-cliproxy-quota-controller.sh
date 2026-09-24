#!/usr/bin/env bash
set -Eeuo pipefail

refuse() {
  printf 'REFUSED: %s\n' "$1" >&2
  exit 2
}

SOURCE_REF=""
BUNDLE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-ref) SOURCE_REF="${2:-}"; shift 2;;
    --bundle) BUNDLE="${2:-}"; shift 2;;
    *) refuse "unknown argument: $1";;
  esac
done

[[ $EUID -eq 0 ]] || refuse "installer must run as root"
[[ "$SOURCE_REF" =~ ^[0-9a-f]{40}$ ]] || refuse "--source-ref must be a 40-hex commit"
[[ -n "$BUNDLE" && -f "$BUNDLE" ]] || refuse "--bundle must name the reviewed release tar"
for executable in /usr/bin/install /usr/bin/sha256sum /usr/bin/mktemp /usr/bin/tar /usr/bin/python3 /usr/bin/systemd-creds /usr/bin/grep; do
  [[ -x "$executable" ]] || refuse "required executable missing: $executable"
done

WORK_DIR=$(/usr/bin/mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT
/usr/bin/tar --extract --file "$BUNDLE" --directory "$WORK_DIR" --no-same-owner --no-same-permissions
[[ "$(<"$WORK_DIR/REVISION")" == "$SOURCE_REF" ]] || refuse "bundle revision does not match --source-ref"
(cd "$WORK_DIR" && /usr/bin/sha256sum --check --strict SHA256SUMS)
for source in cliproxy_quota_contract.py cliproxy_quota_controller.py systemd/run-cliproxy-quota-controller.sh systemd/paperclip-cliproxy-quota-controller.service systemd/paperclip-cliproxy-quota-controller.timer systemd/cliproxy-quota-controller.env.example; do
  [[ -f "$WORK_DIR/$source" ]] || refuse "reviewed bundle is missing $source"
done

RELEASE_DIR="/usr/local/libexec/paperclip-cliproxy-quota-controller/$SOURCE_REF"
[[ ! -e "$RELEASE_DIR" ]] || refuse "release directory already exists: $RELEASE_DIR"
/usr/bin/install -d -o root -g root -m 0755 "$RELEASE_DIR" /etc/paperclip /var/lib/paperclip/cliproxy-quota-controller /var/log/paperclip
/usr/bin/install -d -o root -g root -m 0700 /etc/credstore.encrypted
/usr/bin/install -o root -g root -m 0444 "$WORK_DIR/cliproxy_quota_contract.py" "$RELEASE_DIR/"
/usr/bin/install -o root -g root -m 0444 "$WORK_DIR/cliproxy_quota_controller.py" "$RELEASE_DIR/"
/usr/bin/install -o root -g root -m 0555 "$WORK_DIR/systemd/run-cliproxy-quota-controller.sh" "$RELEASE_DIR/"
/usr/bin/install -o root -g root -m 0444 "$WORK_DIR/REVISION" "$WORK_DIR/SHA256SUMS" "$RELEASE_DIR/"
/usr/bin/python3 -m py_compile "$RELEASE_DIR/cliproxy_quota_contract.py" "$RELEASE_DIR/cliproxy_quota_controller.py"
rm -rf "$RELEASE_DIR/__pycache__"

/usr/bin/python3 - "$WORK_DIR/systemd/paperclip-cliproxy-quota-controller.service" "$SOURCE_REF" > "$WORK_DIR/rendered.service" <<'PY'
import pathlib, sys
source = pathlib.Path(sys.argv[1]).read_text()
rendered = source.replace("@SOURCE_REF@", sys.argv[2])
if "@SOURCE_REF@" in rendered:
    raise SystemExit("unrendered source-ref placeholder")
print(rendered, end="")
PY
/usr/bin/install -o root -g root -m 0644 "$WORK_DIR/rendered.service" /etc/systemd/system/paperclip-cliproxy-quota-controller.service
/usr/bin/install -o root -g root -m 0644 "$WORK_DIR/systemd/paperclip-cliproxy-quota-controller.timer" /etc/systemd/system/paperclip-cliproxy-quota-controller.timer
if [[ ! -e /etc/paperclip/cliproxy-quota-controller.env ]]; then
  /usr/bin/install -o root -g root -m 0600 "$WORK_DIR/systemd/cliproxy-quota-controller.env.example" /etc/paperclip/cliproxy-quota-controller.env
  printf 'CREATED nonsecret /etc/paperclip/cliproxy-quota-controller.env\n'
else
  if /usr/bin/grep -Eq '^[[:space:]]*CLIPROXY_MANAGEMENT_KEY=' /etc/paperclip/cliproxy-quota-controller.env; then
    refuse "existing env file contains forbidden CLIPROXY_MANAGEMENT_KEY plaintext"
  fi
  printf 'PRESERVED existing /etc/paperclip/cliproxy-quota-controller.env\n'
fi
/usr/bin/python3 - /etc/paperclip/cliproxy-quota-controller.env <<'PY'
import os, stat, sys
path = sys.argv[1]
mode = stat.S_IMODE(os.stat(path).st_mode)
if mode != 0o600:
    raise SystemExit(f"REFUSED: {path} mode is {mode:o}, expected 600")
PY
printf 'INSTALLED paperclip-cliproxy-quota-controller from %s\n' "$SOURCE_REF"
printf 'next: provision /etc/credstore.encrypted/cliproxy-management-key with systemd-creds, verify the nonsecret env file, daemon-reload, then enable --now the timer\n'
printf 'undo: systemctl disable --now paperclip-cliproxy-quota-controller.timer; run the controller rollback mode with --now; remove the units and this release after retaining evidence\n'
