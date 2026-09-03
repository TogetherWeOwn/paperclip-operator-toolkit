#!/usr/bin/env bash
set -uo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
ACTION=$HERE/omniroute/rehearsal/operator-action.sh
PREPARE=$HERE/omniroute/rehearsal/prepare-db-preimage.sh
VERIFY=$HERE/omniroute/rehearsal/verify-package.sh
PREFLIGHT=$HERE/rehearsal_endpoint_preflight.sh
AUTHORIZED_PREFLIGHT=$HERE/rehearsal_authorized_preflight.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; [[ -z ${2:-} ]] || printf '       %s\n' "$2"; }
section() { printf '\n== %s\n' "$1"; }

section '1. static syntax and secret boundary'
for script in "$ACTION" "$PREPARE" "$VERIFY" "$PREFLIGHT" "$AUTHORIZED_PREFLIGHT"; do
  if bash -n "$script"; then ok "bash syntax: ${script##*/}"; else bad "bash syntax: ${script##*/}"; fi
done
if grep -RInE --exclude='test_omniroute_rehearsal.sh' '(OMNIROUTE_(API|MGMT)_KEY|Authorization:|Bearer |DATABASE_URL|postgres(ql)?://|sk_[A-Za-z0-9])' "$HERE/omniroute/rehearsal" >/dev/null; then
  bad 'package contains a credential, connection string, or authorization marker'
else
  ok 'package contains no credential, connection string, or authorization marker'
fi
if git -C "$HERE" check-ignore -q --no-index omniroute/rehearsal/private-db/storage.sqlite \
  && git -C "$HERE" check-ignore -q --no-index omniroute/rehearsal/private-db/db-preimage.json \
  && git -C "$HERE" check-ignore -q --no-index omniroute/rehearsal/private-db/storage-encryption-key; then
  ok 'default private DB capture directory is explicitly ignored without touching operational data'
else
  bad 'default private DB capture directory is stageable'
fi
if grep -RIn -- '--publish\|-p 20129\|:20129' "$ACTION" >/dev/null; then
  bad 'operator action contains a port-publication path for 20129'
else
  ok 'operator action has no port publication path'
fi
if grep -RInE -- '--alias[ =]+omniroute([^-.A-Za-z0-9]|$)' "$ACTION" >/dev/null; then
  bad 'operator action can alias rehearsal to live omniroute'
else
  ok 'operator action never aliases rehearsal to live omniroute'
fi

section '2. offline package hash gate'
# Avoid the network in CI: replace curl with a fixture-producing shim whose bytes
# are still checked by verify-package.sh.
mkdir -p "$TMP/verify-bin"
cat > "$TMP/verify-bin/curl" <<'SH'
#!/usr/bin/env bash
cat "$OMNIROUTE_TEST_ARTIFACT"
SH
cat > "$TMP/verify-bin/podman" <<'SH'
#!/usr/bin/env bash
set -eu
cmd=$1; shift
case $cmd in
  build) exit 0 ;;
  image)
    [[ $1 == inspect ]]; shift
    format=''; target=''
    while (($#)); do
      case $1 in -f) format=$2; shift 2 ;; *) target=$1; shift ;; esac
    done
    case $format in
      *source-image-digest*) printf 'sha256:2bf79cf167478bf283c633ffef2e1e26ba746882e7267fab9320c09df56e8b57\n' ;;
      *rehearsal.version*) printf '3.8.49\n' ;;
      *translator-sha256*) jq -r '.build.translatorSha256' "$OMNIROUTE_TEST_PACKAGE" ;;
      *'.Id'*) printf 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' ;;
      *) exit 91 ;;
    esac ;;
  *) exit 90 ;;
esac
SH
chmod +x "$TMP/verify-bin/curl" "$TMP/verify-bin/podman"
mkdir -p "$TMP/pkg/package" "$TMP/verify-home/package"
chmod 0700 "$TMP/verify-home" "$TMP/verify-home/package"
printf '{"name":"omniroute","version":"3.8.49"}\n' > "$TMP/pkg/package/package.json"
tar -czf "$TMP/omniroute.tgz" -C "$TMP/pkg" package
artifact_sha=$(sha256sum "$TMP/omniroute.tgz" | cut -d' ' -f1)
cp "$HERE/omniroute/rehearsal/package.json" "$TMP/verify-home/package/package.json"
jq --arg sha "$artifact_sha" '.npmArtifact.sha256=$sha' "$TMP/verify-home/package/package.json" > "$TMP/verify-home/package/package.tmp" && mv "$TMP/verify-home/package/package.tmp" "$TMP/verify-home/package/package.json"
cp "$HERE/omniroute/rehearsal/Containerfile" "$HERE/omniroute/rehearsal/responseTranslator.ts" "$HERE/omniroute/rehearsal/runtime.env" "$TMP/verify-home/package/"
cp "$VERIFY" "$TMP/verify-home/package/verify-package.sh"
out=$(PATH="$TMP/verify-bin:$PATH" HOME="$TMP/verify-home" OMNIROUTE_TEST_ARTIFACT="$TMP/omniroute.tgz" OMNIROUTE_TEST_PACKAGE="$TMP/verify-home/package/package.json" "$TMP/verify-home/package/verify-package.sh" --build 2>&1); rc=$?
(( rc == 0 )) && [[ $(cat "$TMP/verify-home/package/private-image-id") == sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ]] \
  && ok 'verified package hashes, artifact version, build labels, and immutable image receipt' || bad "package verification failed ($rc)" "$out"
printf 'drift\n' >> "$TMP/verify-home/package/runtime.env"
out=$(PATH="$TMP/verify-bin:$PATH" HOME="$TMP/verify-home" OMNIROUTE_TEST_ARTIFACT="$TMP/omniroute.tgz" OMNIROUTE_TEST_PACKAGE="$TMP/verify-home/package/package.json" "$TMP/verify-home/package/verify-package.sh" 2>&1); rc=$?
(( rc != 0 )) && grep -q 'runtime-config SHA-256 mismatch' <<<"$out" \
  && ok 'runtime config drift is refused' || bad 'runtime config drift was not refused' "$out"
# Reproduce the documented clean-lane property with a local clone: umask 077 must
# make every checkout ancestor private, while an ordinary 0755 lane is refused
# before any package hash can be trusted.
git init -q "$TMP/private-source"
cp -a "$HERE/omniroute" "$TMP/private-source/"
git -C "$TMP/private-source" add omniroute/rehearsal
git -C "$TMP/private-source" -c user.name=test -c user.email=test@example.invalid commit -qm fixture
(
  umask 077
  git clone -q "$TMP/private-source" "$TMP/clean-clone"
)
clean_private=true
for path in "$TMP/clean-clone" "$TMP/clean-clone/omniroute" "$TMP/clean-clone/omniroute/rehearsal"; do
  mode=$(stat -c '%a' "$path")
  (( (8#$mode & 077) == 0 )) || clean_private=false
done
[[ $clean_private == true ]] \
  && ok 'documented umask-077 clean clone creates private checkout ancestry' || bad 'clean clone ancestry was not private'
chmod 0755 "$TMP/clean-clone"
out=$(HOME="$TMP" "$TMP/clean-clone/omniroute/rehearsal/verify-package.sh" 2>&1); rc=$?
(( rc != 0 )) && grep -q 'package ancestry must be private' <<<"$out" \
  && ok 'verify-package refuses a 0755 clean-clone ancestor before hash verification' || bad 'public clone ancestry was not refused' "$out"

section '3. fake Podman success, replay, and undo'
FAKE=$TMP/fake
mkdir -p "$FAKE/bin" "$FAKE/state" "$FAKE/home/private-db" "$FAKE/home/state" "$FAKE/home/clone/omniroute"
cp -a "$HERE/omniroute/rehearsal" "$FAKE/home/clone/omniroute/rehearsal"
ACTION_RUNTIME=$FAKE/home/clone/omniroute/rehearsal/operator-action.sh
chmod 0700 "$FAKE/home" "$FAKE/home/clone" "$FAKE/home/clone/omniroute" "$FAKE/home/clone/omniroute/rehearsal" "$FAKE/home/private-db" "$FAKE/home/state"
for command in jq sha256sum curl getent date timeout install mktemp stat python3 cp rm mv awk head tail tr chmod mkdir; do
  target=$(command -v "$command")
  [[ -z $target ]] || cp -L "$target" "$FAKE/bin/$command"
done
cat > "$FAKE/bin/id" <<'SH'
#!/usr/bin/env bash
case ${1:-} in -un) printf '%s\n' "${OMNIROUTE_EXPECTED_USER:-ubuntu}" ;; -u) /usr/bin/id -u ;; *) /usr/bin/id "$@" ;; esac
SH
# Fixture clock. The package carries a real expiresAt and operator-action.sh
# hard-fails once it lapses -- correct on a host, but it made every run after
# 2026-09-03T00:00:00Z red on an unmodified main (TOG-849/TOG-884: 45 passed,
# 24 failed, all "package expired at"). Pinning "now" to a fixture instant
# makes the suite depend on the package, not on the wall clock. Only bare
# "now" reads are pinned: an explicit -d/--date still parses for real, so the
# expiry arithmetic is exercised end to end rather than stubbed out. Section 3b
# drives this clock past the boundary to prove the refusal still fires.
cat > "$FAKE/bin/date" <<'SH'
#!/usr/bin/env bash
if [[ -n ${FAKE_CLOCK_EPOCH:-} ]]; then
  for arg in "$@"; do
    case $arg in -d|--date|-d*|--date=*) exec /usr/bin/date "$@" ;; esac
  done
  exec /usr/bin/date -d "@$FAKE_CLOCK_EPOCH" "$@"
fi
exec /usr/bin/date "$@"
SH
# 2026-09-01T12:00:00Z -- inside the shipped package's validity window.
export FAKE_CLOCK_EPOCH=1788264000
cat > "$FAKE/bin/sqlite3" <<'SH'
#!/usr/bin/env bash
printf 'ok\n'
SH
cat > "$FAKE/bin/podman" <<'SH'
#!/usr/bin/env bash
set -eu
state=$FAKE_PODMAN_STATE
cmd=${1:-}; shift || true
label() { jq -r --arg key "$1" '.labels[$key] // ""' "$state/rehearsal.json"; }
case "$cmd" in
  network)
    sub=$1; shift
    case "$sub" in
      exists) [[ $1 == agent-net ]] ;;
      inspect)
        if [[ $* == *Internal* ]]; then
          printf 'false\n'
        else
          jq -cn --slurpfile rehearsal "$state/rehearsal.json" '
            {live:{Name:"omniroute"}}
            + (if $rehearsal[0].attached then {($rehearsal[0].id):{Name:"omniroute-rehearse"}} else {} end)
            + (if $rehearsal[0].duplicateAlias then {stale:{Name:"stale-rehearsal"}} else {} end)
          '
        fi ;;
      connect)
        target=${!#}
        jq --arg target "$target" 'if (.id // "") != $target then error("wrong connect target") else .attached=true end' "$state/rehearsal.json" > "$state/t" && mv "$state/t" "$state/rehearsal.json" ;;
      disconnect)
        target=${!#}
        jq --arg target "$target" 'if (.id // "") != $target then error("wrong disconnect target") else .attached=false end' "$state/rehearsal.json" > "$state/t" && mv "$state/t" "$state/rehearsal.json" ;;
    esac ;;
  container)
    [[ $1 == exists ]]
    target=${2:-}
    jq -e --arg target "$target" '.exists==true and (($target=="omniroute-rehearse") or (.id // "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")==$target)' "$state/rehearsal.json" >/dev/null ;;
  image)
    sub=$1; shift
    format=''; target=''
    while (($#)); do
      case "$1" in -f) format=$2; shift 2 ;; *) target=$1; shift ;; esac
    done
    case "$format" in
      *'.Id'*) printf '%s\n' "${FAKE_TAG_IMAGE_ID:-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}" ;;
      *rehearsal.package*) printf 'omniroute-3.8.49-tog554-r1\n' ;;
      *source-image-digest*) printf 'sha256:2bf79cf167478bf283c633ffef2e1e26ba746882e7267fab9320c09df56e8b57\n' ;;
      *translator-sha256*) printf '%s\n' "$FAKE_TRANSLATOR_SHA256" ;;
    esac ;;
  inspect)
    format=''; target=''
    while (($#)); do
      case "$1" in -f) format=$2; shift 2 ;; *) target=$1; shift ;; esac
    done
    if [[ ${FAKE_REBIND_NAME_BEFORE_MARKER:-0} == 1 && $target == omniroute-rehearse && $format == *'{{.Id}}'* && -e $state/rebind-armed ]]; then
      rm -f "$state/rebind-armed"
      jq --arg id "${FAKE_REPLACEMENT_ID:-2222222222222222222222222222222222222222222222222222222222222222}" '.id=$id' "$state/rehearsal.json" > "$state/t" && mv "$state/t" "$state/rehearsal.json"
    fi
    if [[ $target == omniroute ]]; then
      printf 'running|2026-08-20T00:00:00Z|sha256:live|{"agent-net":{}}|{}\n'
    elif [[ $target == live ]]; then
      case "$format" in
        *NetworkSettings.Networks*) printf '{"agent-net":{"Aliases":["omniroute"],"IPAddress":"10.89.1.2"}}\n' ;;
        *'{{.Id}}'*) printf 'live\n' ;;
        *) printf 'unknown-live-format\n' ;;
      esac
    elif [[ $target == probe ]]; then
      if [[ $format == *State.Running* ]]; then printf 'true\n'; else printf '{"agent-net":{"Aliases":["probe"]}}\n'; fi
    elif [[ $target == stale ]]; then
      case "$format" in
        *NetworkSettings.Networks*) printf '{"agent-net":{"Aliases":["omniroute-rehearse"],"IPAddress":"10.89.1.77"}}\n' ;;
        *'{{.Id}}'*) printf 'stale\n' ;;
        *) printf 'unknown-stale-format\n' ;;
      esac
    else
      case "$format" in
        *State.Running*) jq -r '.running' "$state/rehearsal.json" ;;
        *State.Status*) jq -r 'if .running then "running" else "created" end' "$state/rehearsal.json" ;;
        *'{{.Id}}'*) jq -r '.id // "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"' "$state/rehearsal.json" ;;
        *'{{.Image}}'*)
          count_file=$state/image-inspect-count
          count=0
          [[ ! -f $count_file ]] || count=$(cat "$count_file")
          count=$((count + 1))
          printf '%s\n' "$count" > "$count_file"
          if [[ ${FAKE_MUTATE_IMAGE_ON_INSPECT_COUNT:-0} == "$count" ]]; then
            jq '.image="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' "$state/rehearsal.json" > "$state/t" && mv "$state/t" "$state/rehearsal.json"
          fi
          jq -r '.image // "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' "$state/rehearsal.json" ;;
        *HostConfig.PortBindings*) jq -c '.ports' "$state/rehearsal.json" ;;
        *NetworkSettings.Networks*) jq -c 'if .otherNetwork then {"other-net":{"Aliases":["omniroute-rehearse"]}} elif .attached then {"agent-net":{"Aliases":["omniroute-rehearse"],"IPAddress":"10.89.1.99"}} else {} end' "$state/rehearsal.json" ;;
        *rehearsal.version*) label 'io.togetherweown.omniroute.rehearsal.version' ;;
        *rehearsal.package*) label 'io.togetherweown.omniroute.rehearsal.package' ;;
        *source-image-digest*) label 'io.togetherweown.omniroute.rehearsal.source-image-digest' ;;
        *translator-sha256*) label 'io.togetherweown.omniroute.rehearsal.translator-sha256' ;;
        *config-sha256*) label 'io.togetherweown.omniroute.rehearsal.config-sha256' ;;
        *db-manifest-sha256*) label 'io.togetherweown.omniroute.rehearsal.db-manifest-sha256' ;;
        *db-sha256*) label 'io.togetherweown.omniroute.rehearsal.db-sha256' ;;
        *storage-encryption-key-sha256*) label 'io.togetherweown.omniroute.rehearsal.storage-encryption-key-sha256' ;;
        *) printf 'unknown-format\n' ;;
      esac
    fi ;;
  create)
    created_id=${FAKE_CREATE_RETURN_ID:-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef}
    named_id=${FAKE_CREATE_NAMED_ID:-$created_id}
    cp "$state/expected.json" "$state/rehearsal.json"
    jq --arg id "$named_id" '.id=$id' "$state/rehearsal.json" > "$state/t" && mv "$state/t" "$state/rehearsal.json"
    printf '%s\n' "$created_id" ;;
  build)
    exit 0 ;;
  start)
    target=${1:-}
    jq --arg target "$target" 'if (.id // "") != $target then error("wrong start target") else .running=true end' "$state/rehearsal.json" > "$state/t" && mv "$state/t" "$state/rehearsal.json" ;;
  stop)
    target=${1:-}
    jq --arg target "$target" 'if (.id // "") != $target then error("wrong stop target") else .running=false end' "$state/rehearsal.json" > "$state/t" && mv "$state/t" "$state/rehearsal.json" ;;
  rm)
    target=${!#}
    current_id=$(jq -r '.id // ""' "$state/rehearsal.json")
    [[ $target == "$current_id" ]] || exit 87
    [[ ${FAKE_RM_FAIL:-0} != 1 ]] || exit 29
    [[ ${FAKE_RM_FALSE_SUCCESS:-0} != 1 ]] || exit 0
    jq '.exists=false | .running=false | .attached=false' "$state/rehearsal.json" > "$state/t" && mv "$state/t" "$state/rehearsal.json" ;;
  exec)
    target=${1:-}; shift || true
    if [[ $target == probe ]]; then
      if [[ ${FAKE_PROBE_FAIL:-0} == 1 ]]; then exit 17; fi
      printf '%b' "${FAKE_PROBE_ADDRESSES:-10.89.1.99 omniroute-rehearse\\n}"
      printf '__TOG554_DNS_END__\n%s' "${FAKE_HTTP_STATUS:-401}"
      [[ ${FAKE_REBIND_NAME_BEFORE_MARKER:-0} != 1 ]] || : > "$state/rebind-armed"
    elif jq -e --arg target "$target" '.id==$target' "$state/rehearsal.json" >/dev/null 2>&1; then
      jq -e '.running==true' "$state/rehearsal.json" >/dev/null || exit 125
      if [[ $* == *createHash* ]]; then
        label 'io.togetherweown.omniroute.rehearsal.storage-encryption-key-sha256'
      elif [[ $* == *sha256sum* ]]; then
        label 'io.togetherweown.omniroute.rehearsal.db-sha256'
      elif printf '%s' "$*" | grep -q provider_connections; then
        printf '%s %s' "${FAKE_ENCRYPTED_COUNT:-1}" "${FAKE_DECRYPTABLE_COUNT:-${FAKE_ENCRYPTED_COUNT:-1}}"
      else
        printf 'ok'
      fi
    else
      printf 'unexpected exec target: %s\n' "$target" >&2; exit 91
    fi
    ;;
  *) printf 'unexpected podman command: %s\n' "$cmd" >&2; exit 90 ;;
esac
SH
chmod +x "$FAKE/bin/id" "$FAKE/bin/sqlite3" "$FAKE/bin/podman" "$FAKE/bin/date"
cp "$HERE/omniroute/rehearsal/package.json" "$HERE/omniroute/rehearsal/runtime.env" "$HERE/omniroute/rehearsal/responseTranslator.ts" "$HERE/omniroute/rehearsal/Containerfile" "$FAKE/home/"
printf 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' > "$FAKE/home/clone/omniroute/rehearsal/private-image-id"
chmod 0600 "$FAKE/home/clone/omniroute/rehearsal/private-image-id"
printf 'fake-private-db\n' > "$FAKE/home/private-db/storage.sqlite"
printf 'fake-storage-encryption-key' > "$FAKE/home/private-db/storage-encryption-key"
chmod 0600 "$FAKE/home/private-db/storage-encryption-key"
db_sha=$(sha256sum "$FAKE/home/private-db/storage.sqlite" | cut -d' ' -f1)
key_sha=$(sha256sum "$FAKE/home/private-db/storage-encryption-key" | cut -d' ' -f1)
cat > "$FAKE/home/private-db/db-preimage.json" <<EOF
{"schemaVersion":1,"packageId":"omniroute-3.8.49-tog554-r1","version":"3.8.49","databaseSha256":"$db_sha","storageEncryptionKeyFile":"storage-encryption-key","storageEncryptionKeySha256":"$key_sha","sqliteIntegrityCheck":"ok","sidecarsIncluded":false,"containsRawData":false}
EOF
manifest_sha=$(sha256sum "$FAKE/home/private-db/db-preimage.json" | cut -d' ' -f1)
config_sha=$(sha256sum "$FAKE/home/runtime.env" | cut -d' ' -f1)
translator_sha=$(jq -r '.build.translatorSha256' "$FAKE/home/package.json")
cat > "$FAKE/state/expected.json" <<EOF
{"id":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","image":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","exists":true,"running":false,"attached":false,"otherNetwork":false,"duplicateAlias":false,"ports":{},"labels":{"io.togetherweown.omniroute.rehearsal.version":"3.8.49","io.togetherweown.omniroute.rehearsal.package":"omniroute-3.8.49-tog554-r1","io.togetherweown.omniroute.rehearsal.source-image-digest":"sha256:2bf79cf167478bf283c633ffef2e1e26ba746882e7267fab9320c09df56e8b57","io.togetherweown.omniroute.rehearsal.translator-sha256":"$translator_sha","io.togetherweown.omniroute.rehearsal.config-sha256":"$config_sha","io.togetherweown.omniroute.rehearsal.db-manifest-sha256":"$manifest_sha","io.togetherweown.omniroute.rehearsal.db-sha256":"$db_sha","io.togetherweown.omniroute.rehearsal.storage-encryption-key-sha256":"$key_sha"}}
EOF
printf '{"exists":false,"running":false,"attached":false,"ports":{},"labels":{}}\n' > "$FAKE/state/rehearsal.json"
printf 'tog554-success-action-0001\n' > "$FAKE/home/action"
chmod 0600 "$FAKE/home/action"
run_action() {
  [[ ${FAKE_PRESERVE_IMAGE_INSPECT_COUNT:-0} == 1 ]] || rm -f "$FAKE/state/image-inspect-count"
  env PATH="$FAKE/bin:/usr/bin:/bin" HOME="$FAKE/home" FAKE_PODMAN_STATE="$FAKE/state" \
    FAKE_TRANSLATOR_SHA256="$translator_sha" FAKE_MUTATE_IMAGE_ON_INSPECT_COUNT="${FAKE_MUTATE_IMAGE_ON_INSPECT_COUNT:-0}" \
    OMNIROUTE_EXPECTED_USER=ubuntu OMNIROUTE_REHEARSAL_PACKAGE="$FAKE/home/package.json" \
    OMNIROUTE_REHEARSAL_DB_DIR="$FAKE/home/private-db" OMNIROUTE_AGENT_NETWORK=agent-net \
    OMNIROUTE_PROBE_CONTAINER=probe OMNIROUTE_ACTION_ID_FILE="$FAKE/home/action" \
    OMNIROUTE_REHEARSAL_STATE_DIR="$FAKE/home/state" \
    "$ACTION_RUNTIME" "$@"
}
complete_marker() {
  local type=$1 container_id=$2 image_id=$3
  jq -cn --arg type "$type" --arg containerId "$container_id" --arg imageId "$image_id" \
    --arg packageId omniroute-3.8.49-tog554-r1 --arg version 3.8.49 \
    --arg sourceImageDigest sha256:2bf79cf167478bf283c633ffef2e1e26ba746882e7267fab9320c09df56e8b57 \
    --arg translatorSha256 "$translator_sha" --arg configSha256 "$config_sha" \
    --arg network agent-net --arg alias omniroute-rehearse \
    --arg dbManifestSha256 "$manifest_sha" --arg dbSha256 "$db_sha" \
    --arg storageEncryptionKeySha256 "$key_sha" \
    --argjson wasRunning false \
    '{type:$type,containerId:$containerId,imageId:$imageId,wasRunning:$wasRunning,packageId:$packageId,version:$version,sourceImageDigest:$sourceImageDigest,translatorSha256:$translatorSha256,configSha256:$configSha256,network:$network,alias:$alias,dbManifestSha256:$dbManifestSha256,dbSha256:$dbSha256,storageEncryptionKeySha256:$storageEncryptionKeySha256}'
}
write_complete_marker() {
  complete_marker "$@" > "$marker"
  chmod 0600 "$marker"
}
out=$(run_action --apply 2>&1); rc=$?
(( rc == 0 )) && grep -q 'SUCCESS: rehearsal package verified and reachable' <<<"$out" \
  && ok 'create success path reaches DNS/TCP/anonymous HTTP postconditions' || bad "create success path failed ($rc)" "$out"
[[ $(jq -r '.exists and .running and .attached' "$FAKE/state/rehearsal.json") == true ]] \
  && ok 'success path leaves only the disposable rehearsal attached' || bad 'success path state is wrong'
evidence_row=$FAKE/home/state/evidence/evidence.jsonl
[[ $(wc -l < "$evidence_row") == 1 ]] \
  && jq -e --arg keySha "$key_sha" 'select(.result=="success" and .tcp==true and .anonymousHttpStatus=="401" and .alias=="omniroute-rehearse" and .storageEncryptionKeySha256==$keySha and (.containerId|test("^[0-9a-f]{12,64}$")))' "$evidence_row" >/dev/null \
  && jq -e --slurpfile package "$HERE/omniroute/rehearsal/package.json" '([keys[]] | sort) == ($package[0].evidence.sanitizedFields | sort)' "$evidence_row" >/dev/null \
  && ok 'success writes exactly the declared sanitized evidence fields' || bad 'success evidence row is missing, undeclared, or malformed'
out=$(run_action --apply 2>&1); rc=$?
(( rc != 0 )) && grep -q 'replay refused' <<<"$out" \
  && ok 'used action id is refused before replay' || bad 'action replay was not refused' "$out"
printf 'tog554-undo-action-000002\n' > "$FAKE/home/action"
out=$(run_action --undo 2>&1); rc=$?
undo_exists=$(python3 - "$FAKE/state/rehearsal.json" <<'PY'
import json, sys
print(str(json.load(open(sys.argv[1]))["exists"]).lower())
PY
)
(( rc == 0 )) && [[ $undo_exists == false ]] \
  && ok 'undo removes the exact disposable rehearsal' || bad "undo path failed ($rc, exists=$undo_exists)" "$out"
# A fully valid, already-attached rehearsal is an intentional no-op. It must
# still verify reachability and write success evidence, but it creates no marker
# because there is no mutation for --undo to reverse.
cp "$FAKE/state/expected.json" "$FAKE/state/rehearsal.json"
jq '.running=true | .attached=true' "$FAKE/state/rehearsal.json" > "$FAKE/state/t" && mv "$FAKE/state/t" "$FAKE/state/rehearsal.json"
printf 'tog554-noop-action-00001\n' > "$FAKE/home/action"
out=$(run_action --apply 2>&1); rc=$?
(( rc == 0 )) && grep -q 'SUCCESS: rehearsal package verified and reachable' <<<"$out" \
  && [[ ! -e "$FAKE/home/state/markers/omniroute-3.8.49-tog554-r1.agent-net.json" ]] \
  && ok 'already-attached valid rehearsal succeeds as a marker-free no-op' || bad "no-op path failed ($rc)" "$out"
printf 'tog554-empty-decrypt-proof\n' > "$FAKE/home/action"
out=$(FAKE_ENCRYPTED_COUNT=0 run_action --apply 2>&1); rc=$?
(( rc != 0 )) && grep -q 'encrypted-credential postconditions' <<<"$out" \
  && ok 'zero encrypted credentials cannot satisfy the decrypt proof' || bad 'empty decrypt proof was accepted' "$out"

# The immutable ID returned by podman create is the only ownership proof. If the
# fixed name resolves to a replacement before verification, rollback must not
# remove that replacement.
printf '{"exists":false,"running":false,"attached":false,"ports":{},"labels":{}}\n' > "$FAKE/state/rehearsal.json"
printf 'tog554-create-identity-race\n' > "$FAKE/home/action"
created_id=1111111111111111111111111111111111111111111111111111111111111111
replacement_id=2222222222222222222222222222222222222222222222222222222222222222
out=$(FAKE_CREATE_RETURN_ID="$created_id" FAKE_CREATE_NAMED_ID="$replacement_id" run_action --apply 2>&1); rc=$?
(( rc != 0 )) && [[ $(jq -r '.id' "$FAKE/state/rehearsal.json") == "$replacement_id" ]] \
  && [[ $(jq -r '.exists' "$FAKE/state/rehearsal.json") == true ]] \
  && grep -q 'name is not bound to the returned container id' <<<"$out" \
  && ok 'create rollback refuses a replacement under the shared container name' || bad 'create rollback acted on a replacement container' "$out"

section '4. attach-only and automatic rollback'
# A valid existing artifact on no network may be attached. The marker then makes
# undo disconnect that network rather than deleting the pre-existing container.
cp "$FAKE/state/expected.json" "$FAKE/state/rehearsal.json"
printf 'tog554-attach-action-0001\n' > "$FAKE/home/action"
out=$(run_action --apply 2>&1); rc=$?
(( rc == 0 )) && [[ $(jq -r '.attached' "$FAKE/state/rehearsal.json") == true ]] \
  && jq -e '.type=="attach" and .wasRunning==false and (.containerId|length)>0 and (.imageId|startswith("sha256:"))' "$FAKE/home/state/markers/omniroute-3.8.49-tog554-r1.agent-net.json" >/dev/null \
  && ok 'valid existing stopped rehearsal is attached and records exact prior identity/state' || bad "attach-only path failed ($rc)" "$out"
printf 'tog554-attach-undo-0002\n' > "$FAKE/home/action"
out=$(run_action --undo 2>&1); rc=$?
(( rc == 0 )) && [[ $(jq -r '.exists and (.attached|not) and (.running|not)' "$FAKE/state/rehearsal.json") == true ]] \
  && ok 'attach-only undo restores the existing rehearsal to stopped and disconnected' || bad "attach-only undo failed ($rc)" "$out"
# Inject a post-attachment probe failure. Rollback must disconnect the newly
# added network and append a failed evidence row.
printf 'tog554-rollback-action-003\n' > "$FAKE/home/action"
out=$(FAKE_PROBE_FAIL=1 run_action --apply 2>&1); rc=$?
(( rc == 17 )) && [[ $(jq -r '(.attached|not) and (.running|not)' "$FAKE/state/rehearsal.json") == true ]] \
  && grep -q 'ROLLBACK: stopped-and-disconnected-added-network' <<<"$out" \
  && ok 'command failure restores stopped and disconnected prior state' || bad "rollback path failed ($rc)" "$out"
# Explicit postcondition refusals use fail(), not a naturally failing command.
# They must take the same rollback/evidence path rather than exiting around ERR.
printf 'tog554-http-refusal-0004\n' > "$FAKE/home/action"
out=$(FAKE_HTTP_STATUS=500 run_action --apply 2>&1); rc=$?
failed_row=$(python3 - "$FAKE/home/state/evidence/evidence.jsonl" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).read_text().splitlines()[-1])
PY
)
(( rc != 0 )) && [[ $(jq -r '(.attached|not) and (.running|not)' "$FAKE/state/rehearsal.json") == true ]] \
  && grep -q 'ROLLBACK: stopped-and-disconnected-added-network' <<<"$out" \
  && jq -e 'select(.result=="failed" and .rollback=="stopped-and-disconnected-added-network")' <<<"$failed_row" >/dev/null \
  && ok 'explicit HTTP refusal restores prior state and records failed evidence' || bad "explicit-refusal rollback failed ($rc)" "$out"

# A failed cleanup must not destroy the only recovery information or claim removal.
printf 'tog554-cleanup-failure-005\n' > "$FAKE/home/action"
printf '{"type":"create","dataDir":"%s","containerId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","imageId":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","dbManifestSha256":"%s","dbSha256":"%s"}\n' "$FAKE/home/state/data.recovery" "$manifest_sha" "$db_sha" > "$FAKE/home/state/markers/omniroute-3.8.49-tog554-r1.agent-net.json"
mkdir -p "$FAKE/home/state/data.recovery"
cp "$FAKE/state/expected.json" "$FAKE/state/rehearsal.json"
jq '.running=true | .attached=true' "$FAKE/state/rehearsal.json" > "$FAKE/state/t" && mv "$FAKE/state/t" "$FAKE/state/rehearsal.json"
out=$(FAKE_RM_FAIL=1 run_action --undo 2>&1); rc=$?
(( rc != 0 )) && [[ -e "$FAKE/home/state/markers/omniroute-3.8.49-tog554-r1.agent-net.json" ]] \
  && [[ -d "$FAKE/home/state/data.recovery" ]] \
  && ok 'cleanup failure preserves marker and private recovery data' || bad "cleanup failure lost recovery state ($rc)" "$out"
# A removal command that lies with exit 0 is still a failed undo. The marker
# and data must remain because postcondition verification, not rc, is authority.
printf 'tog554-false-success-005b\n' > "$FAKE/home/action"
out=$(FAKE_RM_FALSE_SUCCESS=1 run_action --undo 2>&1); rc=$?
(( rc != 0 )) && [[ -e "$FAKE/home/state/markers/omniroute-3.8.49-tog554-r1.agent-net.json" ]] \
  && [[ -d "$FAKE/home/state/data.recovery" ]] \
  && ok 'false-success container removal preserves recovery state' || bad 'false-success removal was accepted' "$out"

# Failed no-op verification may never delete or rewrite a marker from an earlier action.
marker=$FAKE/home/state/markers/omniroute-3.8.49-tog554-r1.agent-net.json
printf '{"type":"create","dataDir":"%s","containerId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","imageId":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","dbManifestSha256":"%s","dbSha256":"%s"}\n' "$FAKE/home/state/data.original" "$manifest_sha" "$db_sha" > "$marker"
marker_before=$(sha256sum "$marker" | cut -d' ' -f1)
cp "$FAKE/state/expected.json" "$FAKE/state/rehearsal.json"
jq '.running=true | .attached=true' "$FAKE/state/rehearsal.json" > "$FAKE/state/t" && mv "$FAKE/state/t" "$FAKE/state/rehearsal.json"
printf 'tog554-marker-owner-0006\n' > "$FAKE/home/action"
out=$(FAKE_HTTP_STATUS=500 run_action --apply 2>&1); rc=$?
marker_after=$(sha256sum "$marker" | cut -d' ' -f1)
(( rc != 0 )) && [[ $marker_after == "$marker_before" ]] \
  && ok 'failed no-op preserves the existing authoritative marker byte-identically' || bad 'failed no-op changed the existing marker' "$out"

# O_NOFOLLOW must prevent rollback evidence from appending through a symlink.
evidence=$FAKE/home/state/evidence/evidence.jsonl
rm -f "$evidence"
printf 'victim\n' > "$FAKE/home/victim"
chmod 0644 "$FAKE/home/victim"
ln -s "$FAKE/home/victim" "$evidence"
cp "$FAKE/state/expected.json" "$FAKE/state/rehearsal.json"
printf 'tog554-evidence-link-007\n' > "$FAKE/home/action"
out=$(FAKE_PROBE_FAIL=1 run_action --apply 2>&1); rc=$?
[[ $(cat "$FAKE/home/victim") == victim && $(stat -c '%a' "$FAKE/home/victim") == 644 ]] \
  && ok 'descriptor-based evidence append refuses symlink without changing victim' || bad 'evidence symlink changed victim' "$out"
rm -f "$evidence"

# Marker identity must remain bound to the container that passed postconditions.
# Substitute the mutable name after the probe succeeds but before publication;
# apply must refuse, preserve the replacement, and publish no marker for it.
cp "$FAKE/state/expected.json" "$FAKE/state/rehearsal.json"
printf 'tog554-marker-identity-race\n' > "$FAKE/home/action"
rm -f "$marker" "$FAKE/state/rebind-armed"
replacement_id=2222222222222222222222222222222222222222222222222222222222222222
out=$(FAKE_REBIND_NAME_BEFORE_MARKER=1 FAKE_REPLACEMENT_ID="$replacement_id" run_action --apply 2>&1); rc=$?
(( rc != 0 )) && [[ $(jq -r '.id' "$FAKE/state/rehearsal.json") == "$replacement_id" ]] \
  && [[ $(jq -r '.exists' "$FAKE/state/rehearsal.json") == true ]] && [[ ! -e $marker ]] \
  && grep -q 'name was rebound before marker publication' <<<"$out" \
  && ok 'marker publication refuses a replacement under the mutable name' || bad 'marker publication authenticated a replacement container' "$out"

# Marker publication must be exclusive. GNU mv -n reports success when it skips,
# so exercise the hard-link boundary directly by creating a marker just before
# publication and prove the older marker survives byte-identically.
cp "$FAKE/state/expected.json" "$FAKE/state/rehearsal.json"
printf 'tog554-marker-race-00008\n' > "$FAKE/home/action"
rm -f "$marker"
mkdir -p "$FAKE/bin-marker-race"
cp "$FAKE/bin/python3" "$FAKE/bin-marker-race/python3-real"
cat > "$FAKE/bin-marker-race/python3" <<'SH'
#!/usr/bin/env bash
if [[ ${1:-} == - && ${2:-} == *'.marker.'* && ${3:-} == *.json ]]; then
  printf '{"type":"older-action"}\n' > "$3"
fi
exec "$(dirname "$0")/python3-real" "$@"
SH
chmod +x "$FAKE/bin-marker-race/python3"
out=$(env PATH="$FAKE/bin-marker-race:$FAKE/bin:/usr/bin:/bin" HOME="$FAKE/home" FAKE_PODMAN_STATE="$FAKE/state" \
  FAKE_TRANSLATOR_SHA256="$translator_sha" OMNIROUTE_EXPECTED_USER=ubuntu OMNIROUTE_REHEARSAL_PACKAGE="$FAKE/home/package.json" \
  OMNIROUTE_REHEARSAL_DB_DIR="$FAKE/home/private-db" OMNIROUTE_AGENT_NETWORK=agent-net \
  OMNIROUTE_PROBE_CONTAINER=probe OMNIROUTE_ACTION_ID_FILE="$FAKE/home/action" \
  OMNIROUTE_REHEARSAL_STATE_DIR="$FAKE/home/state" "$ACTION_RUNTIME" --apply 2>&1); rc=$?
(( rc != 0 )) && [[ $(jq -r '.type' "$marker") == older-action ]] \
  && ok 'concurrent marker publication is refused without replacing the older marker' || bad 'marker publication race was not refused safely' "$out"

# Undo tests use the complete publication schema so only the intended immutable
# identity gate can answer them. First prove the unmutated marker reaches and
# completes the attach undo branch.
recorded_id=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
recorded_image=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
cp "$FAKE/state/expected.json" "$FAKE/state/rehearsal.json"
jq '.running=true | .attached=true' "$FAKE/state/rehearsal.json" > "$FAKE/state/t" && mv "$FAKE/state/t" "$FAKE/state/rehearsal.json"
write_complete_marker attach "$recorded_id" "$recorded_image"
printf 'tog554-complete-undo-base\n' > "$FAKE/home/action"
out=$(run_action --undo 2>&1); rc=$?
(( rc == 0 )) && [[ $(jq -r '.exists and (.attached|not) and (.running|not)' "$FAKE/state/rehearsal.json") == true ]] && [[ ! -e $marker ]] \
  && ok 'complete unmutated marker reaches and completes attach undo' || bad 'complete undo baseline did not reach the intended branch' "$out"

# An old complete marker cannot act on a replacement container even if all
# reproducible package labels are identical.
cp "$FAKE/state/expected.json" "$FAKE/state/rehearsal.json"
jq '.running=true | .attached=true' "$FAKE/state/rehearsal.json" > "$FAKE/state/t" && mv "$FAKE/state/t" "$FAKE/state/rehearsal.json"
write_complete_marker attach replacement-id "$recorded_image"
printf 'tog554-replacement-undo09\n' > "$FAKE/home/action"
out=$(run_action --undo 2>&1); rc=$?
(( rc != 0 )) && grep -q 'recorded rehearsal container or immutable image changed' <<<"$out" \
  && [[ $(jq -r '.running and .attached' "$FAKE/state/rehearsal.json") == true ]] && [[ -f $marker ]] \
  && ok 'undo refuses a replacement container at the immutable-identity gate' || bad 'undo replacement test was answered by the wrong gate' "$out"
rm -f "$marker"

# Mutate the immutable image immediately before disconnect and before stop. The
# complete marker must pass initial validation, then refuse at the named gate.
for mutation in disconnect:3 stop:4; do
  name=${mutation%%:*}; count=${mutation##*:}
  cp "$FAKE/state/expected.json" "$FAKE/state/rehearsal.json"
  jq '.running=true | .attached=true' "$FAKE/state/rehearsal.json" > "$FAKE/state/t" && mv "$FAKE/state/t" "$FAKE/state/rehearsal.json"
  write_complete_marker attach "$recorded_id" "$recorded_image"
  printf 'tog554-image-%s-undo\n' "$name" > "$FAKE/home/action"
  rm -f "$FAKE/state/image-inspect-count"
  out=$(FAKE_PRESERVE_IMAGE_INSPECT_COUNT=1 FAKE_MUTATE_IMAGE_ON_INSPECT_COUNT="$count" run_action --undo 2>&1); rc=$?
  (( rc != 0 )) && grep -q "image changed before $name" <<<"$out" && [[ -f $marker ]] \
    && [[ $(jq -r '.exists' "$FAKE/state/rehearsal.json") == true ]] \
    && ok "undo revalidates immutable image immediately before $name" || bad "undo $name image mutation reached the wrong gate" "$out"
  rm -f "$marker"
done

# A disposable rehearsal must also revalidate its immutable image immediately
# before remove, after the marker has moved into the recovery stage.
cp "$FAKE/state/expected.json" "$FAKE/state/rehearsal.json"
jq '.running=true | .attached=true' "$FAKE/state/rehearsal.json" > "$FAKE/state/t" && mv "$FAKE/state/t" "$FAKE/state/rehearsal.json"
mkdir -p "$FAKE/home/state/data.remove-mutation"
complete_marker create "$recorded_id" "$recorded_image" \
  | jq --arg dataDir "$FAKE/home/state/data.remove-mutation" '. + {dataDir:$dataDir}' > "$marker"
chmod 0600 "$marker"
printf 'tog554-image-remove-undo\n' > "$FAKE/home/action"
rm -f "$FAKE/state/image-inspect-count"
out=$(FAKE_PRESERVE_IMAGE_INSPECT_COUNT=1 FAKE_MUTATE_IMAGE_ON_INSPECT_COUNT=3 run_action --undo 2>&1); rc=$?
(( rc != 0 )) && grep -q 'image changed before removal' <<<"$out" \
  && [[ $(jq -r '.undoStage' "$marker") == container-removing ]] \
  && [[ $(jq -r '.exists' "$FAKE/state/rehearsal.json") == true ]] \
  && ok 'undo revalidates immutable image immediately before remove' || bad 'undo remove image mutation reached the wrong gate' "$out"
rm -rf "$FAKE/home/state/data.remove-mutation" "$marker"

# Destructive undo must prove the evidence destination is writable before it
# disconnects or removes anything.
cp "$FAKE/state/expected.json" "$FAKE/state/rehearsal.json"
jq '.running=true | .attached=true' "$FAKE/state/rehearsal.json" > "$FAKE/state/t" && mv "$FAKE/state/t" "$FAKE/state/rehearsal.json"
printf '{"type":"attach","containerId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","imageId":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","wasRunning":true,"dbManifestSha256":"%s","dbSha256":"%s"}\n' "$manifest_sha" "$db_sha" > "$marker"
printf 'tog554-undo-evidence-0010\n' > "$FAKE/home/action"
printf 'victim\n' > "$FAKE/home/undo-victim"
rm -f "$evidence"
ln -s "$FAKE/home/undo-victim" "$evidence"
out=$(run_action --undo 2>&1); rc=$?
(( rc != 0 )) && [[ $(jq -r '.running and .attached' "$FAKE/state/rehearsal.json") == true ]] \
  && [[ -f $marker ]] && [[ $(cat "$FAKE/home/undo-victim") == victim ]] \
  && ok 'unsafe undo evidence path is refused before runtime mutation' || bad 'unsafe undo evidence path allowed destructive mutation' "$out"
rm -f "$evidence" "$marker"

# Replay consumption uses exclusive directory creation; a pre-existing ledger
# directory is refused exactly like a sequentially used id.
printf 'tog554-ledger-exclusive-11\n' > "$FAKE/home/action"
action_sha=$(printf '%s' 'tog554-ledger-exclusive-11' | sha256sum | cut -d' ' -f1)
mkdir -p "$FAKE/home/state/replay-ledger/$action_sha"
out=$(run_action --apply 2>&1); rc=$?
(( rc != 0 )) && grep -q 'replay refused' <<<"$out" \
  && ok 'exclusive replay-ledger creation refuses an already claimed action id' || bad 'claimed action id was not refused' "$out"

# Each DB capture chooses an unpredictable container-side /tmp destination so
# concurrent preparations cannot remove or copy one another's snapshot.
grep -q 'SNAPSHOT_DB=/tmp/tog554-preimage.$(python3 -c' "$PREPARE" \
  && ! grep -q 'OMNIROUTE_TRANSIENT_SNAPSHOT' "$PREPARE" \
  && ok 'DB preparation uses a per-run random transient snapshot path' || bad 'DB preparation still shares a fixed transient snapshot path'

# Canonical ancestry checks are load-bearing: a symlinked package path and a
# group-writable state ancestor must be refused before any Podman mutation.
ln -s "$FAKE/home/clone/omniroute/rehearsal" "$FAKE/home/rehearsal-link"
printf 'tog554-symlink-lane-0012\n' > "$FAKE/home/action"
out=$(env PATH="$FAKE/bin:/usr/bin:/bin" HOME="$FAKE/home" FAKE_PODMAN_STATE="$FAKE/state" \
  FAKE_TRANSLATOR_SHA256="$translator_sha" OMNIROUTE_EXPECTED_USER=ubuntu OMNIROUTE_REHEARSAL_PACKAGE="$FAKE/home/package.json" \
  OMNIROUTE_REHEARSAL_DB_DIR="$FAKE/home/private-db" OMNIROUTE_AGENT_NETWORK=agent-net \
  OMNIROUTE_PROBE_CONTAINER=probe OMNIROUTE_ACTION_ID_FILE="$FAKE/home/action" \
  OMNIROUTE_REHEARSAL_STATE_DIR="$FAKE/home/state" "$FAKE/home/rehearsal-link/operator-action.sh" --apply 2>&1); rc=$?
(( rc != 0 )) && grep -q 'non-canonical path components' <<<"$out" \
  && ok 'symlinked package ancestry is refused' || bad 'symlinked package ancestry was accepted' "$out"
chmod 0770 "$FAKE/home/state"
printf 'tog554-writable-state-013\n' > "$FAKE/home/action"
out=$(run_action --apply 2>&1); rc=$?
(( rc != 0 )) && grep -q 'must be private' <<<"$out" \
  && ok 'group-writable state ancestry is refused' || bad 'writable state ancestry was accepted' "$out"
chmod 0700 "$FAKE/home/state"

section '5. refusal matrix'
refuse_case() {
  local name=$1 mutation=$2 expected=$3
  cp "$FAKE/state/expected.json" "$FAKE/state/rehearsal.json"
  eval "$mutation"
  printf 'tog554-refusal-%s-0000\n' "$name" > "$FAKE/home/action"
  out=$(run_action --apply 2>&1); rc=$?
  if (( rc != 0 )) && grep -q "$expected" <<<"$out"; then ok "refuses $name"; else bad "did not refuse $name" "$out"; fi
}
refuse_case version "jq '.labels[\"io.togetherweown.omniroute.rehearsal.version\"]=\"3.8.50\"' '$FAKE/state/rehearsal.json' > '$FAKE/state/t' && mv '$FAKE/state/t' '$FAKE/state/rehearsal.json'" 'does not match'
refuse_case digest "jq '.labels[\"io.togetherweown.omniroute.rehearsal.source-image-digest\"]=\"sha256:wrong\"' '$FAKE/state/rehearsal.json' > '$FAKE/state/t' && mv '$FAKE/state/t' '$FAKE/state/rehearsal.json'" 'does not match'
refuse_case config "jq '.labels[\"io.togetherweown.omniroute.rehearsal.config-sha256\"]=\"wrong\"' '$FAKE/state/rehearsal.json' > '$FAKE/state/t' && mv '$FAKE/state/t' '$FAKE/state/rehearsal.json'" 'does not match'
refuse_case db "jq '.labels[\"io.togetherweown.omniroute.rehearsal.db-sha256\"]=\"wrong\"' '$FAKE/state/rehearsal.json' > '$FAKE/state/t' && mv '$FAKE/state/t' '$FAKE/state/rehearsal.json'" 'does not match'
refuse_case port "jq '.ports={\"20128/tcp\":[{\"HostPort\":\"20129\"}]}' '$FAKE/state/rehearsal.json' > '$FAKE/state/t' && mv '$FAKE/state/t' '$FAKE/state/rehearsal.json'" 'does not match'
refuse_case other-network "jq '.otherNetwork=true' '$FAKE/state/rehearsal.json' > '$FAKE/state/t' && mv '$FAKE/state/t' '$FAKE/state/rehearsal.json'" 'does not match'
refuse_case duplicate-alias "jq '.duplicateAlias=true' '$FAKE/state/rehearsal.json' > '$FAKE/state/t' && mv '$FAKE/state/t' '$FAKE/state/rehearsal.json'" 'alias is already owned'
cp "$FAKE/state/expected.json" "$FAKE/state/rehearsal.json"
printf 'tog554-address-mismatch-01\n' > "$FAKE/home/action"
out=$(FAKE_PROBE_ADDRESSES=$'10.89.1.99 omniroute-rehearse\n10.89.1.77 omniroute-rehearse\n' run_action --apply 2>&1); rc=$?
(( rc != 0 )) && grep -q 'DNS address set does not exactly match' <<<"$out" \
  && [[ $(jq -r '(.attached|not) and (.running|not)' "$FAKE/state/rehearsal.json") == true ]] \
  && ok 'extra DNS address is refused and rolled back before authorization' || bad 'extra DNS address was accepted' "$out"
# Missing or wrong network and live alias are hard preconditions, not best-effort warnings.
cp "$FAKE/state/expected.json" "$FAKE/state/rehearsal.json"
printf 'tog554-missing-network-001\n' > "$FAKE/home/action"
out=$(env PATH="$FAKE/bin:/usr/bin:/bin" HOME="$FAKE/home" FAKE_PODMAN_STATE="$FAKE/state" \
  OMNIROUTE_EXPECTED_USER=ubuntu OMNIROUTE_REHEARSAL_PACKAGE="$FAKE/home/package.json" \
  OMNIROUTE_REHEARSAL_DB_DIR="$FAKE/home/private-db" OMNIROUTE_AGENT_NETWORK=missing \
  OMNIROUTE_PROBE_CONTAINER=probe OMNIROUTE_ACTION_ID_FILE="$FAKE/home/action" \
  OMNIROUTE_REHEARSAL_STATE_DIR="$FAKE/home/state" "$ACTION_RUNTIME" --apply 2>&1); rc=$?
(( rc != 0 )) && grep -q 'target network is missing' <<<"$out" && ok 'refuses missing network' || bad 'missing network was not refused' "$out"
mkdir -p "$FAKE/bin-wrong-network"
cat > "$FAKE/bin-wrong-network/jq" <<'SH'
#!/usr/bin/env bash
if [[ $* == *'to_entries | any(.value.Name == "omniroute")'* ]]; then
  printf 'false\n'
  exit 0
fi
exec /usr/bin/jq "$@"
SH
chmod +x "$FAKE/bin-wrong-network/jq"
printf 'tog554-wrong-network-0001\n' > "$FAKE/home/action"
out=$(env PATH="$FAKE/bin-wrong-network:$FAKE/bin:/usr/bin:/bin" HOME="$FAKE/home" FAKE_PODMAN_STATE="$FAKE/state" \
  OMNIROUTE_EXPECTED_USER=ubuntu OMNIROUTE_REHEARSAL_PACKAGE="$FAKE/home/package.json" \
  OMNIROUTE_REHEARSAL_DB_DIR="$FAKE/home/private-db" OMNIROUTE_AGENT_NETWORK=agent-net \
  OMNIROUTE_PROBE_CONTAINER=probe OMNIROUTE_ACTION_ID_FILE="$FAKE/home/action" \
  OMNIROUTE_REHEARSAL_STATE_DIR="$FAKE/home/state" "$ACTION_RUNTIME" --apply 2>&1); rc=$?
(( rc != 0 )) && grep -q 'does not contain live omniroute' <<<"$out" && ok 'refuses a network without live omniroute' || bad 'wrong network was not refused' "$out"
cp "$FAKE/state/expected.json" "$FAKE/state/rehearsal.json"
jq '.attached=true' "$FAKE/state/rehearsal.json" > "$FAKE/state/t" && mv "$FAKE/state/t" "$FAKE/state/rehearsal.json"
# Fake Podman emits only the approved alias. Pin the source itself against the
# forbidden alias branch so this assertion cannot be satisfied by a neighbour.
grep -q 'index("omniroute") == null' "$ACTION" && ok 'source refuses live omniroute alias across all networks' || bad 'live alias refusal is missing'

# TOG-849/TOG-884. The expiry check had no test of its own, so when the shipped
# package lapsed at 2026-09-03T00:00:00Z the only signal was 24 unrelated-looking
# failures across the whole suite. These three cases pin the boundary directly by
# moving the fixture clock, not by editing the package: expired refuses, valid
# proceeds, and a garbage expiresAt is refused rather than silently treated as
# valid. Failure here now says "expiry" instead of rotting every other case.
package_expiry_at=$(jq -er '.expiresAt' "$FAKE/home/package.json")
expiry_epoch=$(date -u -d "$package_expiry_at" +%s)

cp "$FAKE/state/expected.json" "$FAKE/state/rehearsal.json"
printf 'tog849-expired-0001\n' > "$FAKE/home/action"
out=$(FAKE_CLOCK_EPOCH=$expiry_epoch run_action --apply 2>&1); rc=$?
(( rc != 0 )) && grep -q "package expired at $package_expiry_at" <<<"$out" \
  && ok 'refuses to act on a package whose expiresAt has lapsed' || bad 'lapsed package was not refused' "$out"

cp "$FAKE/state/expected.json" "$FAKE/state/rehearsal.json"
printf 'tog849-valid-edge-0001\n' > "$FAKE/home/action"
out=$(FAKE_CLOCK_EPOCH=$(( expiry_epoch - 1 )) run_action --apply 2>&1); rc=$?
(( rc == 0 )) && ! grep -q 'package expired at' <<<"$out" \
  && ok 'acts on the package one second before expiresAt' || bad 'valid package was refused as expired' "$out"

cp "$FAKE/state/expected.json" "$FAKE/state/rehearsal.json"
jq '.expiresAt="not-a-timestamp"' "$FAKE/home/package.json" > "$FAKE/home/package.expiry-mutation.json"
printf 'tog849-bad-expiry-0001\n' > "$FAKE/home/action"
out=$(env PATH="$FAKE/bin:/usr/bin:/bin" HOME="$FAKE/home" FAKE_PODMAN_STATE="$FAKE/state" \
  FAKE_CLOCK_EPOCH="$FAKE_CLOCK_EPOCH" FAKE_TRANSLATOR_SHA256="$translator_sha" \
  OMNIROUTE_EXPECTED_USER=ubuntu OMNIROUTE_REHEARSAL_PACKAGE="$FAKE/home/package.expiry-mutation.json" \
  OMNIROUTE_REHEARSAL_DB_DIR="$FAKE/home/private-db" OMNIROUTE_AGENT_NETWORK=agent-net \
  OMNIROUTE_PROBE_CONTAINER=probe OMNIROUTE_ACTION_ID_FILE="$FAKE/home/action" \
  OMNIROUTE_REHEARSAL_STATE_DIR="$FAKE/home/state" "$ACTION_RUNTIME" --apply 2>&1); rc=$?
(( rc != 0 )) && grep -q 'package expiry is invalid' <<<"$out" \
  && ok 'refuses an unparseable expiresAt instead of treating it as valid' || bad 'invalid expiry was not refused' "$out"

# The suite must never go green by pinning a clock past the shipped window. If
# the package lapses again, this is the case that names it -- once, in one line.
if (( $(date -u +%s) < expiry_epoch )); then
  ok "shipped package is still within its validity window (expires $package_expiry_at)"
else
  bad "shipped rehearsal package expired at $package_expiry_at -- re-issue it or park the lane (TOG-849)"
fi

section '6. generated canonical runbook'
rendered_file="$TMP/operator-runbook.md"
$HERE/operator_runbook.sh render > "$rendered_file" 2>&1; rc=$?
(( rc == 0 )) && cmp -s "$rendered_file" "$HERE/docs/OPERATOR-RUNBOOK.md" \
  && ok 'canonical operator runbook matches its generator source' || bad 'canonical operator runbook is stale' "$(diff -u "$HERE/docs/OPERATOR-RUNBOOK.md" "$rendered_file" | head -80)"
grep -q 'omniroute/rehearsal/operator-action.sh --apply' "$HERE/operator_runbook_classification.json" \
  && grep -q 'umask 077\\ngit clone' "$HERE/operator_runbook_classification.json" \
  && ok 'runbook source carries the fixed action and exact private clean-clone lane' || bad 'runbook source lacks the fixed TOG-554 clean lane'
tog521_commands=$(jq -er '.items["TOG-521"].commands' "$HERE/operator_runbook_classification.json")
[[ $tog521_commands == *'./rehearsal_authorized_preflight.sh'* ]] \
  && [[ $tog521_commands != *'jq -sc'* ]] \
  && [[ $tog521_commands != *$'\n./rehearsal_endpoint_preflight.sh\n'* ]] \
  && grep -q 'trap cleanup EXIT' "$AUTHORIZED_PREFLIGHT" \
  && grep -q 'podman exec -u node "$AGENT_CONTAINER" sh -ceu' "$AUTHORIZED_PREFLIGHT" \
  && grep -q 'export OMNIROUTE_REHEARSAL_AUTHORIZATION_FILE="$authorization_file"' "$AUTHORIZED_PREFLIGHT" \
  && ok 'canonical runbook delegates the exact container-local lifecycle to one reviewed helper' || bad 'canonical preflight command still improvises the authorization lifecycle'

# TOG-521. The runbook is executed verbatim by a human on the VPS, so an
# unresolved <placeholder> is not a formatting nit -- it is the operator
# guessing. Measured 2026-08-31: `git checkout --detach <reviewed-commit-for-TOG-554>`
# invited the TOG-554 merge 5ddf2785, where step 5's rehearsal_authorized_preflight.sh
# does not exist and the lane dies exit 127 AFTER the attach has already happened.
checkout_line=$(grep -m1 '^git checkout --detach ' <<<"$tog521_commands" || true)
[[ $checkout_line =~ ^git\ checkout\ --detach\ [0-9a-f]{40}$ ]] \
  && ok 'runbook pins a full 40-hex reviewed commit, not a placeholder' \
  || bad 'runbook checkout is unpinned or still a placeholder' "$checkout_line"

# The pinned commit must be one that actually carries every executable the lane
# invokes. "Exists in this reviewed tree" is the honest assertion: the suite
# runs from a checkout, and a shallow CI clone cannot resolve an arbitrary
# older object to check it there.
for lane_script in omniroute/rehearsal/verify-package.sh \
  omniroute/rehearsal/prepare-db-preimage.sh omniroute/rehearsal/operator-action.sh \
  rehearsal_authorized_preflight.sh rehearsal_endpoint_preflight.sh \
  agent_endpoint_preflight.sh; do
  [[ -f $HERE/$lane_script ]] || bad "runbook lane invokes a missing script: $lane_script"
done
ok 'every script the TOG-521 lane invokes exists in the reviewed tree'

# The step-0 hash block must equal the real files. This is the part that keeps
# working after today: edit operator-action.sh without repinning and CI goes red
# here, instead of the operator discovering it mid-apply on the VPS.
pinned_sums=$(sed -n '/^sha256sum --check --strict <<.SUMS.$/,/^SUMS$/p' <<<"$tog521_commands" \
  | sed '1d;$d')
[[ -n ${pinned_sums//[[:space:]]/} ]] \
  && ok 'runbook carries a step-0 hash block for the lane executables' \
  || bad 'runbook step-0 hash block is missing entirely'
sums_drift=0
sums_counted=0
while read -r pinned_hash pinned_path; do
  [[ -n $pinned_hash ]] || continue
  sums_counted=$(( sums_counted + 1 ))
  actual_hash=$(sha256sum "$HERE/$pinned_path" 2>/dev/null | cut -d' ' -f1)
  [[ $actual_hash == "$pinned_hash" ]] || {
    sums_drift=1
    printf '    drift: %s pinned=%s actual=%s\n' "$pinned_path" "$pinned_hash" "${actual_hash:-<unreadable>}" >&2
  }
done <<<"$pinned_sums"
(( sums_counted == 6 )) \
  && ok 'step-0 pins all six lane executables' \
  || bad "step-0 pins $sums_counted executables, expected 6"
(( sums_drift == 0 )) \
  && ok 'every step-0 pinned hash matches the reviewed file on disk' \
  || bad 'a step-0 pinned hash has drifted from the file the operator will execute'

section '7. canonical authorization namespace lifecycle'
LIFECYCLE=$TMP/lifecycle
mkdir -p "$LIFECYCLE/bin" "$LIFECYCLE/home/state/evidence" "$LIFECYCLE/container"
chmod 0700 "$LIFECYCLE/home" "$LIFECYCLE/home/state"
lifecycle_address_sha=$(printf '10.89.1.99\n' | sha256sum | cut -d' ' -f1)
printf '{"mode":"apply","result":"success","alias":"omniroute-rehearse","containerId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","dnsAddressSha256":"%s"}\n' "$lifecycle_address_sha" > "$LIFECYCLE/home/state/evidence/evidence.jsonl"
chmod 0600 "$LIFECYCLE/home/state/evidence/evidence.jsonl"
# The host namespace must be inert across EVERY run below: the authorization is
# streamed straight into the agent container, so nothing under the operator's
# writable HOME may be created, deleted, or have its type/mode/content changed.
# Snapshot path+type+mode+content-hash of the pristine fixture here, before any
# lifecycle has run -- a snapshot taken later would already contain a file an
# earlier run leaked, and would compare it against itself.
host_namespace_snapshot() {
  find "$LIFECYCLE/home" \( -type f -o -type d -o -type l \) -printf '%y %m %p\n' 2>/dev/null \
    | LC_ALL=C sort \
    | while read -r entry_type entry_mode entry_path; do
        case $entry_type in
          f) printf '%s %s %s %s\n' "$entry_type" "$entry_mode" "$entry_path" "$(sha256sum < "$entry_path" | cut -d' ' -f1)" ;;
          l) printf '%s %s %s -> %s\n' "$entry_type" "$entry_mode" "$entry_path" "$(readlink "$entry_path")" ;;
          *) printf '%s %s %s\n' "$entry_type" "$entry_mode" "$entry_path" ;;
        esac
      done
}
HOST_SNAPSHOT_BEFORE=$LIFECYCLE/host-namespace-before
HOST_SNAPSHOT_AFTER=$LIFECYCLE/host-namespace-after
host_namespace_snapshot > "$HOST_SNAPSHOT_BEFORE"
cat > "$LIFECYCLE/bin/podman" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ ${1:-} == exec ]] || exit 90
shift
interactive=0
[[ ${1:-} == -i ]] && { interactive=1; shift; }
[[ ${1:-} == -u && ${2:-} == node ]] || exit 91
shift 2
container=$1; shift
[[ $container == reviewed-agent ]] || exit 92
map_path() {
  case $1 in
    /tmp/omniroute-rehearsal-auth-tog554*) printf '%s/auth%s' "$FAKE_CONTAINER_ROOT" "${1#/tmp/omniroute-rehearsal-auth-tog554}" ;;
    *) printf '%s' "$1" ;;
  esac
}
if (( interactive == 1 )); then
  [[ ${1:-} == python3 && ${2:-} == -c ]] || exit 93
  python_source=$3
  destination=$(map_path "$4")
  mode=$5
  stream_count=0
  [[ ! -f $FAKE_CONTAINER_STREAM_COUNT ]] || stream_count=$(cat "$FAKE_CONTAINER_STREAM_COUNT")
  stream_count=$((stream_count + 1))
  printf '%s\n' "$stream_count" > "$FAKE_CONTAINER_STREAM_COUNT"
  if [[ ${FAKE_CONTAINER_STREAM_FAIL_ON:-0} == "$stream_count" ]]; then
    python3 -c '
import os, sys
path = sys.argv[1]
mode = int(sys.argv[2], 8)
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
try:
    prefix = sys.stdin.buffer.read(16)
    if prefix:
        os.write(fd, prefix)
    os.fsync(fd)
finally:
    os.close(fd)
raise SystemExit(88)
' "$destination" "$mode"
  fi
  python3 -c "$python_source" "$destination" "$mode"
  chmod "$mode" "$destination"
  exit
fi
[[ ${1:-} == sh && ${2:-} == -ceu ]] || exit 94
script=$3
shift 3
[[ ${1:-} == sh ]] || exit 95
shift
mapped=()
for arg in "$@"; do mapped+=("$(map_path "$arg")"); done
if [[ $script == *'"$authorization_wrapper"'* ]]; then
  wrapper=${mapped[2]}
  cat > "$wrapper" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
[[ -f $OMNIROUTE_REHEARSAL_AUTHORIZATION_FILE ]]
[[ ! -L $OMNIROUTE_REHEARSAL_AUTHORIZATION_FILE ]]
[[ $(stat -c %a "$OMNIROUTE_REHEARSAL_AUTHORIZATION_FILE") == 600 ]]
printf '1\n' >> "$WRAPPER_COUNT_FILE"
[[ $WRAPPER_SLEEP != 1 ]] || sleep 1
if [[ $WRAPPER_RC == 0 ]]; then exit 0; else exit "$WRAPPER_RC"; fi
WRAPPER
  sed -i \
    -e "s|\$WRAPPER_COUNT_FILE|$(printf %q "$FAKE_CONTAINER_WRAPPER_COUNT")|" \
    -e "s|\$WRAPPER_SLEEP|$(printf %q "${FAKE_CONTAINER_WRAPPER_SLEEP:-0}")|" \
    -e "s|\$WRAPPER_RC|$(printf %q "${FAKE_CONTAINER_WRAPPER_RC:-0}")|g" \
    "$wrapper"
  chmod 0700 "$wrapper"
  expected_wrapper_sha=$(sha256sum "$wrapper" | cut -d' ' -f1)
  mapped[4]=$expected_wrapper_sha
fi
sh -ceu "$script" sh "${mapped[@]}"
SH
chmod +x "$LIFECYCLE/bin/podman"
run_lifecycle() {
  local wrapper_rc=$1 signal_mode=${2:-none} stream_fail_on=${3:-0}
  rm -rf "$LIFECYCLE/container" "$LIFECYCLE/wrapper-count" "$LIFECYCLE/stream-count"
  mkdir -p "$LIFECYCLE/container"
  : > "$LIFECYCLE/wrapper-count"
  : > "$LIFECYCLE/stream-count"
  if [[ $signal_mode == term ]]; then
    FAKE_CONTAINER_WRAPPER_RC="$wrapper_rc" FAKE_CONTAINER_WRAPPER_SLEEP=1 FAKE_CONTAINER_STREAM_FAIL_ON="$stream_fail_on" \
      FAKE_CONTAINER_ROOT="$LIFECYCLE/container" FAKE_CONTAINER_WRAPPER_COUNT="$LIFECYCLE/wrapper-count" FAKE_CONTAINER_STREAM_COUNT="$LIFECYCLE/stream-count" \
      PATH="$LIFECYCLE/bin:/usr/bin:/bin" HOME="$LIFECYCLE/home" \
      OMNIROUTE_PROBE_CONTAINER=reviewed-agent OMNIROUTE_REHEARSAL_EVIDENCE_LOG="$LIFECYCLE/home/state/evidence/evidence.jsonl" \
        "$AUTHORIZED_PREFLIGHT" > "$LIFECYCLE/out" 2>&1 &
    lifecycle_pid=$!
    while [[ ! -s $LIFECYCLE/wrapper-count ]]; do kill -0 "$lifecycle_pid" 2>/dev/null || break; done
    kill -TERM "$lifecycle_pid" 2>/dev/null || true
    wait "$lifecycle_pid"; return $?
  fi
  FAKE_CONTAINER_WRAPPER_RC="$wrapper_rc" FAKE_CONTAINER_WRAPPER_SLEEP=0 FAKE_CONTAINER_STREAM_FAIL_ON="$stream_fail_on" \
    FAKE_CONTAINER_ROOT="$LIFECYCLE/container" FAKE_CONTAINER_WRAPPER_COUNT="$LIFECYCLE/wrapper-count" FAKE_CONTAINER_STREAM_COUNT="$LIFECYCLE/stream-count" \
    PATH="$LIFECYCLE/bin:/usr/bin:/bin" HOME="$LIFECYCLE/home" \
    OMNIROUTE_PROBE_CONTAINER=reviewed-agent OMNIROUTE_REHEARSAL_EVIDENCE_LOG="$LIFECYCLE/home/state/evidence/evidence.jsonl" \
    "$AUTHORIZED_PREFLIGHT" > "$LIFECYCLE/out" 2>&1
}
set +e
run_lifecycle 0; rc=$?
set -e
(( rc == 0 )) && [[ $(wc -l < "$LIFECYCLE/wrapper-count") == 1 ]] \
  && [[ ! -e $LIFECYCLE/container/auth/evidence.json && ! -L $LIFECYCLE/container/auth/evidence.json ]] \
  && [[ ! -e $LIFECYCLE/container/auth && ! -L $LIFECYCLE/container/auth ]] \
  && [[ ! -e $LIFECYCLE/home/state/authorization/omniroute-rehearsal-preflight.json \
    && ! -L $LIFECYCLE/home/state/authorization/omniroute-rehearsal-preflight.json ]] \
  && ok 'canonical lifecycle invokes the container-local wrapper once and cleans both namespaces on exit 0' || bad "canonical lifecycle success path leaked or crossed namespaces rc=$rc count=$(wc -l < "$LIFECYCLE/wrapper-count")" "$(cat "$LIFECYCLE/out"; find "$LIFECYCLE/container" -maxdepth 2 -printf '%m %p\n' 2>/dev/null)"
set +e
run_lifecycle 23; rc=$?
set -e
(( rc == 23 )) && [[ $(wc -l < "$LIFECYCLE/wrapper-count") == 1 ]] \
  && [[ ! -e $LIFECYCLE/container/auth/evidence.json && ! -L $LIFECYCLE/container/auth/evidence.json ]] \
  && [[ ! -e $LIFECYCLE/container/auth && ! -L $LIFECYCLE/container/auth ]] \
  && [[ ! -e $LIFECYCLE/home/state/authorization/omniroute-rehearsal-preflight.json \
    && ! -L $LIFECYCLE/home/state/authorization/omniroute-rehearsal-preflight.json ]] \
  && ok 'canonical lifecycle preserves wrapper failure and cleans both namespaces' || bad 'canonical lifecycle failure path leaked or hid the wrapper status' "$(cat "$LIFECYCLE/out")"
set +e
run_lifecycle 0 none 2; rc=$?
set -e
(( rc == 88 )) && [[ $(wc -l < "$LIFECYCLE/wrapper-count") == 0 ]] \
  && [[ ! -e $LIFECYCLE/container/auth/rehearsal_endpoint_preflight.sh \
    && ! -L $LIFECYCLE/container/auth/rehearsal_endpoint_preflight.sh ]] \
  && [[ ! -e $LIFECYCLE/container/auth/evidence.json && ! -L $LIFECYCLE/container/auth/evidence.json ]] \
  && [[ ! -e $LIFECYCLE/container/auth/agent_endpoint_preflight.sh \
    && ! -L $LIFECYCLE/container/auth/agent_endpoint_preflight.sh ]] \
  && [[ ! -e $LIFECYCLE/container/auth && ! -L $LIFECYCLE/container/auth ]] \
  && [[ ! -e $LIFECYCLE/home/state/authorization/omniroute-rehearsal-preflight.json \
    && ! -L $LIFECYCLE/home/state/authorization/omniroute-rehearsal-preflight.json ]] \
  && ok 'canonical lifecycle removes a prefix stream and both namespaces before EOF' || bad 'canonical lifecycle partial-stream path leaked authorization' "$(cat "$LIFECYCLE/out"; find "$LIFECYCLE/container" -maxdepth 2 -printf '%m %y %p -> %l\n' 2>/dev/null)"
[[ ! -e $LIFECYCLE/home/state/authorization/omniroute-rehearsal-preflight.json \
  && ! -L $LIFECYCLE/home/state/authorization/omniroute-rehearsal-preflight.json ]] \
  && ok 'canonical lifecycle never creates an ephemeral host authorization pathname' || bad 'canonical lifecycle created a mutable host authorization pathname'
# Compare the pristine pre-run snapshot against the namespace as it stands after
# every lifecycle above has run. Any create, delete, chmod, rewrite or symlink
# swap anywhere under the operator's writable HOME shows up as a diff.
set +e
run_lifecycle 0; rc=$?
set -e
host_namespace_snapshot > "$HOST_SNAPSHOT_AFTER"
(( rc == 0 )) && [[ -s $HOST_SNAPSHOT_BEFORE ]] \
  && diff -u "$HOST_SNAPSHOT_BEFORE" "$HOST_SNAPSHOT_AFTER" > "$LIFECYCLE/host-namespace-diff" 2>&1 \
  && [[ $(wc -l < "$LIFECYCLE/wrapper-count") == 1 ]] \
  && [[ ! -e $LIFECYCLE/container/auth && ! -L $LIFECYCLE/container/auth ]] \
  && ok 'canonical lifecycle leaves the writable host namespace byte-identical' || bad 'canonical lifecycle mutated the writable host namespace' "$(cat "$LIFECYCLE/out"; cat "$LIFECYCLE/host-namespace-diff" 2>/dev/null)"
set +e
run_lifecycle 0 term; rc=$?
set -e
(( rc == 143 )) && [[ $(wc -l < "$LIFECYCLE/wrapper-count") == 1 ]] \
  && [[ ! -e $LIFECYCLE/container/auth/evidence.json && ! -L $LIFECYCLE/container/auth/evidence.json ]] \
  && [[ ! -e $LIFECYCLE/container/auth && ! -L $LIFECYCLE/container/auth ]] \
  && [[ ! -e $LIFECYCLE/home/state/authorization/omniroute-rehearsal-preflight.json \
    && ! -L $LIFECYCLE/home/state/authorization/omniroute-rehearsal-preflight.json ]] \
  && ok 'canonical lifecycle cleans both namespaces on termination' || bad 'canonical lifecycle signal path leaked authorization' "$(cat "$LIFECYCLE/out")"

section '8. credentialed preflight authorization seam'
PREFLIGHT_FIXTURE=$TMP/preflight
mkdir -p "$PREFLIGHT_FIXTURE/bin"
cat > "$PREFLIGHT_FIXTURE/bin/getent" <<'SH'
#!/usr/bin/env bash
printf '%b' "${FAKE_PREFLIGHT_ADDRESSES:-10.89.1.99 omniroute-rehearse\\n}"
SH
cat > "$PREFLIGHT_FIXTURE/preflight-tool" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$FAKE_PREFLIGHT_CALLED"
SH
chmod +x "$PREFLIGHT_FIXTURE/bin/getent" "$PREFLIGHT_FIXTURE/preflight-tool"
preflight_evidence=$PREFLIGHT_FIXTURE/evidence.json
preflight_called=$PREFLIGHT_FIXTURE/called
printf '{"mode":"apply","result":"success","alias":"omniroute-rehearse","containerId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","dnsAddressSha256":"%s"}\n' "$(printf '10.89.1.99\n' | sha256sum | cut -d' ' -f1)" > "$preflight_evidence"
chmod 0600 "$preflight_evidence"
set +e
out=$(OMNIROUTE_REHEARSAL_AUTHORIZATION_FILE="$PREFLIGHT_FIXTURE/missing" \
  OMNIROUTE_REHEARSAL_GETENT_BIN="$PREFLIGHT_FIXTURE/bin/getent" \
  OMNIROUTE_REHEARSAL_PREFLIGHT_TOOL="$PREFLIGHT_FIXTURE/preflight-tool" \
  FAKE_PREFLIGHT_CALLED="$preflight_called" "$PREFLIGHT" 2>&1); rc=$?
set -e
(( rc != 0 )) && [[ ! -e $preflight_called ]] \
  && ok 'preflight refuses missing host authorization before credentialed tool' || bad 'preflight reached credentialed tool without authorization' "$out"
set +e
out=$(FAKE_PREFLIGHT_ADDRESSES=$'10.89.1.77 omniroute-rehearse\n' \
  OMNIROUTE_REHEARSAL_AUTHORIZATION_FILE="$preflight_evidence" \
  OMNIROUTE_REHEARSAL_GETENT_BIN="$PREFLIGHT_FIXTURE/bin/getent" \
  OMNIROUTE_REHEARSAL_PREFLIGHT_TOOL="$PREFLIGHT_FIXTURE/preflight-tool" \
  FAKE_PREFLIGHT_CALLED="$preflight_called" "$PREFLIGHT" 2>&1); rc=$?
set -e
(( rc != 0 )) && grep -q 'address set changed' <<<"$out" && [[ ! -e $preflight_called ]] \
  && ok 'preflight refuses stale alias addresses before credentialed tool' || bad 'preflight accepted stale alias addresses' "$out"
out=$(OMNIROUTE_REHEARSAL_AUTHORIZATION_FILE="$preflight_evidence" \
  OMNIROUTE_REHEARSAL_GETENT_BIN="$PREFLIGHT_FIXTURE/bin/getent" \
  OMNIROUTE_REHEARSAL_PREFLIGHT_TOOL="$PREFLIGHT_FIXTURE/preflight-tool" \
  FAKE_PREFLIGHT_CALLED="$preflight_called" "$PREFLIGHT" 2>&1); rc=$?
(( rc == 0 )) && grep -q -- '--model claude-sonnet-5' "$preflight_called" \
  && ok 'matching immutable address proof reaches the credentialed gate exactly once' || bad 'matching preflight authorization did not reach the gate' "$out"

printf '\n== totals\n  passed: %d\n  failed: %d\n' "$PASS" "$FAIL"
(( FAIL == 0 )) || exit 1
