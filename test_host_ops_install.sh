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
sed "s|@@PAPERCLIP_IMAGE_REF@@|$render_ref|" "$ROOT/host-ops/host-ops-broker.sudoers" > "$render_dir/sudoers"
python3 - "$ROOT/host-ops/config.example.json" "$render_dir/config.json" "$render_ref" <<'PY'
import json, sys
from pathlib import Path
config = json.loads(Path(sys.argv[1]).read_text().replace("@@PAPERCLIP_IMAGE_REF@@", sys.argv[3]))
Path(sys.argv[2]).write_text(json.dumps(config))
PY
granted=$(grep -oP 'podman image inspect \K\S+' "$render_dir/sudoers")
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

if (( failures != 0 )); then
  printf '%s host-ops installer contract tests failed\n' "$failures" >&2
  exit 1
fi
printf 'host-ops installer contract tests passed\n'
