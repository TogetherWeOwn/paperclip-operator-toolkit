#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=host-ops/install-lib.sh
source "$ROOT/host-ops/install-lib.sh"

failures=0
ok() { printf '  ok: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; failures=$((failures + 1)); }
refuse() { printf 'REFUSED: %s\n' "$1" >&2; exit 2; }

FIXTURE=""
getent() {
  case "$1:$2" in
    group:paperclip-host-reader) [[ "$FIXTURE" != absent ]] && printf '%s\n' "${READER_GROUP:-paperclip-host-reader:x:991:}" ;;
    group:paperclip-host-requests) [[ "$FIXTURE" != absent ]] && printf '%s\n' "${REQUESTS_GROUP:-paperclip-host-requests:x:992:paperclip-host-reader}" ;;
    passwd:paperclip-host-reader) [[ "$FIXTURE" != absent ]] && printf '%s\n' "${READER_PASSWD:-paperclip-host-reader:x:991:991::/var/lib/paperclip-host-ops:/usr/sbin/nologin}" ;;
    *) return 2 ;;
  esac
}
id() {
  if [[ "$1" == -nG ]]; then
    printf '%s\n' "${READER_GROUPS:-paperclip-host-reader paperclip-host-requests}"
  elif [[ "$1" == paperclip-host-reader ]]; then
    [[ "$FIXTURE" != absent ]]
  else
    return 2
  fi
}
passwd() {
  [[ "$1" == -S && "$2" == paperclip-host-reader ]] || return 2
  printf 'paperclip-host-reader %s 2026-08-28 0 99999 7 -1\n' "${PASSWORD_STATE:-L}"
}

reset_fixture() {
  FIXTURE=valid
  unset READER_GROUP REQUESTS_GROUP READER_PASSWD READER_GROUPS PASSWORD_STATE
}

expect_refusal() {
  local label="$1" expected="$2"
  shift 2
  local output rc
  set +e
  output=$("$@" 2>&1)
  rc=$?
  set -e
  if [[ $rc -eq 2 && "$output" == *"$expected"* ]]; then
    ok "$label"
  else
    fail "$label (rc=$rc output=$output)"
  fi
}

generate_signing_fixture() {
  local bits="$1" fixture_dir="$2"
  mkdir -p "$fixture_dir/work"
  openssl genpkey -algorithm RSA -pkeyopt "rsa_keygen_bits:$bits" -out "$fixture_dir/private.pem" >/dev/null 2>&1
  openssl pkey -in "$fixture_dir/private.pem" -pubout -out "$fixture_dir/public.pem" >/dev/null 2>&1
  sha256sum "$fixture_dir/public.pem" | cut -d' ' -f1
}

KEY_FIXTURES=$(mktemp -d)
trap 'rm -rf "$KEY_FIXTURES"' EXIT
for weak_bits in 512 1024; do
  weak_dir="$KEY_FIXTURES/rsa-$weak_bits"
  weak_pin=$(generate_signing_fixture "$weak_bits" "$weak_dir")
  expect_refusal "${weak_bits}-bit signing key is refused" "must be at least 2048 bits" \
    validate_response_signing_key "$weak_dir/private.pem" "$weak_dir/public.pem" "$weak_pin" "$weak_dir/work"
done
valid_dir="$KEY_FIXTURES/rsa-2048"
valid_pin=$(generate_signing_fixture 2048 "$valid_dir")
if validate_response_signing_key "$valid_dir/private.pem" "$valid_dir/public.pem" "$valid_pin" "$valid_dir/work"; then
  ok "2048-bit matching signing key with independent pin passes"
else
  fail "2048-bit matching signing key with independent pin passes"
fi

reset_fixture
[[ $(classify_service_identity) == valid ]] && ok "valid identity passes" || fail "valid identity passes"

FIXTURE=absent
[[ $(classify_service_identity) == absent ]] && ok "fully absent identity is classifiable" || fail "fully absent identity is classifiable"

reset_fixture; READER_GROUP='paperclip-host-reader:x:1000:'
expect_refusal "reader group must be system" "must be a system group" classify_service_identity
reset_fixture; READER_GROUP='paperclip-host-reader:x:991:someone'
expect_refusal "reader group has no explicit members" "unintended explicit members" classify_service_identity
reset_fixture; REQUESTS_GROUP='paperclip-host-requests:x:992:'
expect_refusal "requests group membership is exact" "must contain only paperclip-host-reader" classify_service_identity
reset_fixture; READER_PASSWD='paperclip-host-reader:x:1000:991::/var/lib/paperclip-host-ops:/usr/sbin/nologin'
expect_refusal "reader uid must be system" "must be a system account" classify_service_identity
reset_fixture; READER_PASSWD='paperclip-host-reader:x:991:992::/var/lib/paperclip-host-ops:/usr/sbin/nologin'
expect_refusal "primary gid is exact" "primary group is incompatible" classify_service_identity
reset_fixture; READER_PASSWD='paperclip-host-reader:x:991:991::/wrong:/usr/sbin/nologin'
expect_refusal "home is exact" "home is incompatible" classify_service_identity
reset_fixture; READER_PASSWD='paperclip-host-reader:x:991:991::/var/lib/paperclip-host-ops:/bin/bash'
expect_refusal "shell is exact" "shell is incompatible" classify_service_identity
reset_fixture; PASSWORD_STATE=P
expect_refusal "password is locked" "credentials must be locked" classify_service_identity
reset_fixture; READER_GROUPS='paperclip-host-reader'
expect_refusal "supplemental group count is exact" "unintended supplemental groups" classify_service_identity
reset_fixture; READER_GROUPS='paperclip-host-reader other'
expect_refusal "supplemental group names are exact" "group membership is incompatible" classify_service_identity
reset_fixture; FIXTURE=partial
getent() {
  case "$1:$2" in
    group:paperclip-host-reader) printf 'paperclip-host-reader:x:991:\n' ;;
    *) return 2 ;;
  esac
}
id() { return 1; }
expect_refusal "partial identity refuses before creation" "partially configured" classify_service_identity

# TOG-757: --paperclip-image-ref argument contract and rendering.
# The installer refuses a reference that could terminate or widen the exact-argv
# sudoers grant, and renders the accepted one identically into the sudoers file
# and config.json. Argument validation is exercised through the real script so
# the regex under test is the shipped one.
# Run the shipped script with the EUID guard stubbed out, so the refusal under
# test is the image-reference check and not "must run as root". Invoking the
# real install.sh unmodified would refuse at the EUID line first and pass no
# matter what the image-reference contract said.
image_ref_arg_refusal() {
  local label="$1" candidate="$2" output rc harness
  harness=$(mktemp)
  # Stop before any host mutation: the required-command loop is the first step
  # after argument validation, so failing it bounds the run to arg parsing.
  sed -e 's/^\[\[ \$EUID -eq 0 \]\].*$/:/' \
      -e 's|^for command in git install|for command in __tog757_absent__ git install|' \
      "$ROOT/host-ops/install.sh" > "$harness"
  set +e
  output=$(bash "$harness" --source-ref "$(printf 'a%.0s' {1..40})" \
    --public-key-out /tmp/none.pem --expected-public-key-sha256 "$(printf 'b%.0s' {1..64})" \
    --paperclip-image-ref "$candidate" 2>&1)
  rc=$?
  set -e
  rm -f "$harness"
  if [[ $rc -eq 2 && "$output" == *"must be a plain image reference"* ]]; then
    ok "$label"
  else
    fail "$label (rc=$rc output=$output)"
  fi
}

# Positive control: the same harness must get PAST argument validation on a good
# reference, proving the refusals above are caused by the reference and not by
# the harness itself.
image_ref_arg_accepted() {
  local label="$1" candidate="$2" output rc harness
  harness=$(mktemp)
  sed -e 's/^\[\[ \$EUID -eq 0 \]\].*$/:/' \
      -e 's|^for command in git install|for command in __tog757_absent__ git install|' \
      "$ROOT/host-ops/install.sh" > "$harness"
  set +e
  output=$(bash "$harness" --source-ref "$(printf 'a%.0s' {1..40})" \
    --public-key-out /tmp/none.pem --expected-public-key-sha256 "$(printf 'b%.0s' {1..64})" \
    --paperclip-image-ref "$candidate" 2>&1)
  rc=$?
  set -e
  rm -f "$harness"
  if [[ "$output" == *"required command missing: __tog757_absent__"* ]]; then
    ok "$label"
  else
    fail "$label (rc=$rc output=$output)"
  fi
}

image_ref_regex_accepts() {
  local candidate="$1"
  [[ "$candidate" =~ ^[a-z0-9][a-z0-9._/-]{0,159}(:[A-Za-z0-9._-]{1,127}|@sha256:[0-9a-f]{64})?$ ]]
}

for good in \
  "localhost/paperclip-local:tog-516v2-51ee6c01b" \
  "ghcr.io/paperclipai/paperclip@sha256:$(printf 'f%.0s' {1..64})" \
  "paperclip-local"; do
  if image_ref_regex_accepts "$good"; then ok "image ref accepted: $good"; else fail "image ref should be accepted: $good"; fi
done

for bad in \
  "paperclip-local --format {{json .}}, /bin/sh" \
  "paperclip local" \
  "paperclip-local, ALL=(ALL) NOPASSWD: ALL" \
  "-leading-dash" \
  ""; do
  if image_ref_regex_accepts "$bad"; then fail "image ref should be refused: $bad"; else ok "image ref refused: ${bad:-<empty>}"; fi
done

image_ref_arg_refusal "installer refuses an injecting image ref" "paperclip-local, ALL=(ALL) NOPASSWD: ALL"
image_ref_arg_refusal "installer refuses an image ref with whitespace" "paperclip local"
image_ref_arg_refusal "installer refuses an empty image ref" ""
image_ref_arg_accepted "installer accepts the running host's image ref" "localhost/paperclip-local:tog-516v2-51ee6c01b"

# The rendered sudoers grant and the rendered config must name the same image.
render_dir=$(mktemp -d)
trap 'rm -rf "$render_dir"' EXIT
render_ref="localhost/paperclip-local:tog-516v2-51ee6c01b"
# Render through the SHIPPED function, not a local sed. The previous version of
# this test re-implemented the substitution, so it passed on a grant the
# installer could never actually produce.
render_sudoers_image_ref "$ROOT/host-ops/host-ops-broker.sudoers" "$render_dir/sudoers" "$render_ref"
python3 - "$ROOT/host-ops/config.example.json" "$render_dir/config.json" "$render_ref" <<'PY'
import json, sys
from pathlib import Path
config = json.loads(Path(sys.argv[1]).read_text().replace("@@PAPERCLIP_IMAGE_REF@@", sys.argv[3]))
Path(sys.argv[2]).write_text(json.dumps(config))
PY
# The grant's bytes carry the sudoers colon escape; unescape before comparing,
# exactly as broker.py's sudoers_granted_image_ref does.
granted=$(grep -oP 'podman image inspect \K\S+' "$render_dir/sudoers" | sed 's/\\:/:/g')
configured=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["paperclipImageRef"])' "$render_dir/config.json")
if [[ "$granted" == "$render_ref" && "$configured" == "$render_ref" ]]; then
  ok "sudoers grant and config render the same image reference"
else
  fail "render mismatch (sudoers=$granted config=$configured)"
fi
if grep -Fq '@@PAPERCLIP_IMAGE_REF@@' "$render_dir/sudoers" || grep -Fq '@@PAPERCLIP_IMAGE_REF@@' "$render_dir/config.json"; then
  fail "placeholder survived rendering"
else
  ok "no placeholder survives rendering"
fi

# TOG-1126: the protected grant must stay at sudo's required root-only mode,
# while an exact-byte mirror is readable by the service group. The root-prefixed
# cmp binds the two before the unprivileged acceptance-check and daemon run.
service_source=$(<"$ROOT/host-ops/host-ops-broker.service")
install_source=$(<"$ROOT/host-ops/install.sh")
protected_sudoers=/etc/sudoers.d/paperclip-host-ops-broker
sudoers_mirror=/etc/paperclip-host-ops/sudoers.rendered
if grep -Fqx "ExecStartPre=+/usr/bin/cmp --silent $protected_sudoers $sudoers_mirror" <<<"$service_source"; then
  ok "root-only preflight binds readable sudoers mirror to protected grant"
else
  fail "unit does not bind the sudoers mirror to the protected grant"
fi
if grep -Fqx "ExecStartPre=/usr/local/libexec/paperclip-host-ops/broker.py acceptance-check --config /etc/paperclip-host-ops/config.json" <<<"$service_source" &&
   grep -Fqx "ExecStart=/usr/local/libexec/paperclip-host-ops/broker.py run --config /etc/paperclip-host-ops/config.json" <<<"$service_source"; then
  ok "acceptance-check and daemon remain unprivileged"
else
  fail "acceptance-check or daemon gained root execution"
fi
podman_writable_paths=$(grep -F "ReadWritePaths=" <<<"$service_source" | grep -F "/run/user/1000" || true)
expected_hardening=(
  "NoNewPrivileges=no"
  "PrivateTmp=yes"
  "PrivateDevices=yes"
  "ProtectSystem=strict"
  "ProtectHome=read-only"
  "ProtectKernelTunables=yes"
  "ProtectKernelModules=yes"
  "ProtectKernelLogs=yes"
  "ProtectControlGroups=yes"
  "LockPersonality=yes"
  "MemoryDenyWriteExecute=yes"
  "MemoryMax=256M"
  "TasksMax=32"
  "RestrictSUIDSGID=yes"
  "RestrictRealtime=yes"
  "SystemCallArchitectures=native"
  "UMask=0027"
)
hardening_complete=true
for directive in "${expected_hardening[@]}"; do
  grep -Fqx "$directive" <<<"$service_source" || hardening_complete=false
done
if [[ "$hardening_complete" == true ]] &&
   ! grep -Eq '^[[:space:]]*RestrictNamespaces[[:space:]]*=' <<<"$service_source" &&
   ! grep -Eq '^[[:space:]]*(ReadWriteDirectories|BindPaths)[[:space:]]*=' <<<"$service_source" &&
   grep -Fq "RestrictNamespaces is intentionally omitted" <<<"$service_source" &&
   [[ "$podman_writable_paths" == "ReadWritePaths=/run/user/1000 /home/ubuntu/.local/share/containers" ]] &&
   [[ $(grep -Fo "/run/user/1000" <<<"$service_source" | wc -l) -eq 1 ]] &&
   [[ $(grep -Fo "/home/ubuntu/.local/share/containers" <<<"$service_source" | wc -l) -eq 1 ]]; then
  ok "rootless podman namespace, runtime and storage needs are compatible with the strict sandbox"
else
  fail "unit cannot run rootless podman image inspect inside its strict sandbox"
fi
if grep -Fq 'install -o root -g root -m 0440 "$SUDOERS_TMP" /etc/sudoers.d/paperclip-host-ops-broker' <<<"$install_source" &&
   grep -Fq 'install -o root -g paperclip-host-reader -m 0640 "$SUDOERS_TMP" /etc/paperclip-host-ops/sudoers.rendered' <<<"$install_source"; then
  ok "installer preserves protected grant mode and publishes readable mirror"
else
  fail "installer grant or mirror ownership contract drifted"
fi

# TOG-757/TOG-1126: the rendered grant must PARSE. Requested by the operator
# after PR #247 aborted on this host at `sudoers:10:114: syntax error` on the
# `@sha256:` token: sudoers reads a bare colon as the run-as separator. Both
# accepted forms carry a colon, so before the escape landed the ONLY reference
# that rendered a parseable grant was a bare repository name -- the hardcoded
# value this argument was added to replace. Rendering is not enough; only visudo
# on the RENDERED file catches this, which is why CI stayed green while the
# installer could not install.
render_parses() {
  local label="$1" candidate="$2" out rc target
  target="$render_dir/parse-check.sudoers"
  render_sudoers_image_ref "$ROOT/host-ops/host-ops-broker.sudoers" "$target" "$candidate"
  chmod 0440 "$target"
  set +e
  out=$("$VISUDO" -cf "$target" 2>&1)
  rc=$?
  set -e
  chmod 0640 "$target"
  if [[ $rc -eq 0 ]]; then
    ok "$label"
  else
    fail "$label (rc=$rc $out)"
  fi
  # The grant sudo authorizes must still be the operator's exact reference:
  # a parse fixed by mangling the argument would attest the wrong image.
  local authorized
  authorized=$(grep -oP 'podman image inspect \K\S+' "$target" | sed 's/\\:/:/g')
  if [[ "$authorized" == "$candidate" ]]; then
    ok "$label grants the exact reference"
  else
    fail "$label granted $authorized, not $candidate"
  fi
}

VISUDO=$(command -v visudo || true)
if [[ -z "$VISUDO" && -x /usr/sbin/visudo ]]; then VISUDO=/usr/sbin/visudo; fi
if [[ -n "$VISUDO" ]]; then
  render_parses "rendered grant parses for a registry digest" \
    "ghcr.io/paperclipai/paperclip@sha256:$(printf 'f%.0s' {1..64})"
  render_parses "rendered grant parses for a tag" "localhost/paperclip-local:tog-516v2-51ee6c01b"
  render_parses "rendered grant parses for a bare repository name" "paperclip-local"

  # Negative control: the unescaped render is what actually failed on the host.
  # Without this, a future change that dropped the escape would leave the three
  # assertions above passing only because visudo was absent.
  sed "s|@@PAPERCLIP_IMAGE_REF@@|ghcr.io/paperclipai/paperclip@sha256:$(printf 'f%.0s' {1..64})|" \
    "$ROOT/host-ops/host-ops-broker.sudoers" > "$render_dir/unescaped.sudoers"
  chmod 0440 "$render_dir/unescaped.sudoers"
  set +e
  "$VISUDO" -cf "$render_dir/unescaped.sudoers" >/dev/null 2>&1
  unescaped_rc=$?
  set -e
  chmod 0640 "$render_dir/unescaped.sudoers"
  if [[ $unescaped_rc -ne 0 ]]; then
    ok "control: an unescaped digest render is rejected by visudo"
  else
    fail "control: an unescaped digest render parsed, so the escape assertions prove nothing"
  fi
else
  fail "visudo is unavailable, so the rendered sudoers grant was never parse-checked"
fi

# TOG-1165: --public-key-out must not collide with the installer's own PUBLIC_KEY.
#
# `install "$PUBLIC_KEY" "$PUBLIC_KEY_OUT"` is the last step before daemon-reload.
# GNU install exits 1 on "are the same file", and under `set -Eeuo pipefail` that
# aborted the script with sudoers, the unit, tmpfiles and config.json already on
# the host but the unit never reloaded -- a DIRTY failure. TOG-1126 step 2 carried
# exactly that path and nearly spent a host window on it.
#
# The keys path is READ OUT OF THE SHIPPED SCRIPT, never re-typed here. A test
# that hardcoded /var/lib/paperclip-host-ops/keys/... would keep passing against
# its own stale literal after the constant moved, which is precisely how the
# original gap survived: both existing arms pass /tmp/none.pem, so nothing ever
# joined the flag to the constant.
INSTALLER_PUBLIC_KEY=$(sed -n 's/^PUBLIC_KEY=\(.*\)$/\1/p' "$ROOT/host-ops/install.sh")
if [[ -n "$INSTALLER_PUBLIC_KEY" ]]; then
  ok "installer's PUBLIC_KEY constant is readable ($INSTALLER_PUBLIC_KEY)"
else
  fail "could not read PUBLIC_KEY from install.sh, so the collision arms below prove nothing"
fi

# Bound the run before any host mutation, exactly as the TOG-757 arms do: stub the
# EUID guard so the refusal under test is the collision and not "must run as
# root", and break the required-command loop so a run that gets PAST the guard
# stops at the first step after it. The guard is deliberately placed above that
# loop -- it uses only bash builtins -- so both arms are reachable here.
public_key_out_arm() {
  local label="$1" candidate="$2" expect="$3" harness output rc
  harness=$(mktemp)
  sed -e 's/^\[\[ \$EUID -eq 0 \]\].*$/:/' \
      -e 's|^for command in git install|for command in __tog1165_absent__ git install|' \
      "$ROOT/host-ops/install.sh" > "$harness"
  set +e
  output=$(bash "$harness" --source-ref "$(printf 'a%.0s' {1..40})" \
    --public-key-out "$candidate" --expected-public-key-sha256 "$(printf 'b%.0s' {1..64})" \
    --paperclip-image-ref paperclip-local 2>&1)
  rc=$?
  set -e
  rm -f "$harness"
  if [[ $rc -eq 2 && "$output" == *"$expect"* ]]; then
    ok "$label"
  else
    fail "$label (rc=$rc output=$output)"
  fi
}

# Arm A: the exact constant is refused.
public_key_out_arm "--public-key-out equal to the installer's own public key is refused" \
  "$INSTALLER_PUBLIC_KEY" "must not name the installer's own public key"

# Arm A': the same file spelled differently is refused too. A string comparison
# would pass this one, so these arms are what force normalised-path comparison.
# The `..` alias bounces off the key's OWN parent directory name rather than a
# literal "keys", so the arm keeps testing the alias -- not a stale path -- when
# the constant moves.
INSTALLER_KEY_DIR=$(dirname "$INSTALLER_PUBLIC_KEY")
public_key_out_arm "--public-key-out aliased via .. is refused" \
  "$INSTALLER_KEY_DIR/../$(basename "$INSTALLER_KEY_DIR")/$(basename "$INSTALLER_PUBLIC_KEY")" \
  "must not name the installer's own public key"
public_key_out_arm "--public-key-out aliased via a trailing /. is refused" \
  "$(dirname "$INSTALLER_PUBLIC_KEY")/./$(basename "$INSTALLER_PUBLIC_KEY")" \
  "must not name the installer's own public key"

# Arm B / positive control: a DISTINCT destination must get PAST the collision
# guard. Without this the refusals above would pass even if the guard refused
# unconditionally -- the failure mode that would break every real install.
public_key_out_arm "a distinct --public-key-out passes the collision guard" \
  /etc/paperclip-host-ops/response-signing.pub.pem \
  "required command missing: __tog1165_absent__"

if (( failures != 0 )); then
  printf '%s host-ops installer contract tests failed\n' "$failures" >&2
  exit 1
fi
printf 'host-ops installer contract tests passed\n'
