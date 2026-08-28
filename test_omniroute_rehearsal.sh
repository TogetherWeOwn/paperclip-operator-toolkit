#!/usr/bin/env bash
set -uo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
ACTION=$HERE/omniroute/rehearsal/operator-action.sh
PREPARE=$HERE/omniroute/rehearsal/prepare-db-preimage.sh
VERIFY=$HERE/omniroute/rehearsal/verify-package.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; [[ -z ${2:-} ]] || printf '       %s\n' "$2"; }
section() { printf '\n== %s\n' "$1"; }

section '1. static syntax and secret boundary'
for script in "$ACTION" "$PREPARE" "$VERIFY"; do
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
        if [[ $* == *Internal* ]]; then printf 'false\n'; else printf '{"live":{"Name":"omniroute"}}\n'; fi ;;
      connect)
        jq '.attached=true' "$state/rehearsal.json" > "$state/t" && mv "$state/t" "$state/rehearsal.json" ;;
      disconnect)
        jq '.attached=false' "$state/rehearsal.json" > "$state/t" && mv "$state/t" "$state/rehearsal.json" ;;
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
    if [[ $target == omniroute ]]; then
      printf 'running|2026-08-20T00:00:00Z|sha256:live|{"agent-net":{}}|{}\n'
    elif [[ $target == probe ]]; then
      if [[ $format == *State.Running* ]]; then printf 'true\n'; else printf '{"agent-net":{"Aliases":["probe"]}}\n'; fi
    else
      case "$format" in
        *State.Running*) jq -r '.running' "$state/rehearsal.json" ;;
        *State.Status*) jq -r 'if .running then "running" else "created" end' "$state/rehearsal.json" ;;
        *'{{.Id}}'*) jq -r '.id // "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"' "$state/rehearsal.json" ;;
        *'{{.Image}}'*) printf 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' ;;
        *HostConfig.PortBindings*) jq -c '.ports' "$state/rehearsal.json" ;;
        *NetworkSettings.Networks*) jq -c 'if .otherNetwork then {"other-net":{"Aliases":["omniroute-rehearse"]}} elif .attached then {"agent-net":{"Aliases":["omniroute-rehearse"]}} else {} end' "$state/rehearsal.json" ;;
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
    jq '.running=true' "$state/rehearsal.json" > "$state/t" && mv "$state/t" "$state/rehearsal.json" ;;
  stop)
    jq '.running=false' "$state/rehearsal.json" > "$state/t" && mv "$state/t" "$state/rehearsal.json" ;;
  rm)
    [[ ${FAKE_RM_FAIL:-0} != 1 ]] || exit 29
    [[ ${FAKE_RM_FALSE_SUCCESS:-0} != 1 ]] || exit 0
    jq '.exists=false | .running=false | .attached=false' "$state/rehearsal.json" > "$state/t" && mv "$state/t" "$state/rehearsal.json" ;;
  exec)
    target=${1:-}; shift || true
    if [[ $target == probe ]]; then
      if [[ ${FAKE_PROBE_FAIL:-0} == 1 ]]; then exit 17; fi
      printf '10.89.1.99 omniroute-rehearse\n%s' "${FAKE_HTTP_STATUS:-401}"
    elif [[ $target == omniroute-rehearse ]]; then
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
chmod +x "$FAKE/bin/id" "$FAKE/bin/sqlite3" "$FAKE/bin/podman"
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
{"exists":true,"running":false,"attached":false,"otherNetwork":false,"ports":{},"labels":{"io.togetherweown.omniroute.rehearsal.version":"3.8.49","io.togetherweown.omniroute.rehearsal.package":"omniroute-3.8.49-tog554-r1","io.togetherweown.omniroute.rehearsal.source-image-digest":"sha256:2bf79cf167478bf283c633ffef2e1e26ba746882e7267fab9320c09df56e8b57","io.togetherweown.omniroute.rehearsal.translator-sha256":"$translator_sha","io.togetherweown.omniroute.rehearsal.config-sha256":"$config_sha","io.togetherweown.omniroute.rehearsal.db-manifest-sha256":"$manifest_sha","io.togetherweown.omniroute.rehearsal.db-sha256":"$db_sha","io.togetherweown.omniroute.rehearsal.storage-encryption-key-sha256":"$key_sha"}}
EOF
printf '{"exists":false,"running":false,"attached":false,"ports":{},"labels":{}}\n' > "$FAKE/state/rehearsal.json"
printf 'tog554-success-action-0001\n' > "$FAKE/home/action"
chmod 0600 "$FAKE/home/action"
run_action() {
  env PATH="$FAKE/bin:/usr/bin:/bin" HOME="$FAKE/home" FAKE_PODMAN_STATE="$FAKE/state" \
    FAKE_TRANSLATOR_SHA256="$translator_sha" OMNIROUTE_EXPECTED_USER=ubuntu OMNIROUTE_REHEARSAL_PACKAGE="$FAKE/home/package.json" \
    OMNIROUTE_REHEARSAL_DB_DIR="$FAKE/home/private-db" OMNIROUTE_AGENT_NETWORK=agent-net \
    OMNIROUTE_PROBE_CONTAINER=probe OMNIROUTE_ACTION_ID_FILE="$FAKE/home/action" \
    OMNIROUTE_REHEARSAL_STATE_DIR="$FAKE/home/state" \
    "$ACTION_RUNTIME" "$@"
}
out=$(run_action --apply 2>&1); rc=$?
(( rc == 0 )) && grep -q 'SUCCESS: rehearsal package verified and reachable' <<<"$out" \
  && ok 'create success path reaches DNS/TCP/anonymous HTTP postconditions' || bad "create success path failed ($rc)" "$out"
[[ $(jq -r '.exists and .running and .attached' "$FAKE/state/rehearsal.json") == true ]] \
  && ok 'success path leaves only the disposable rehearsal attached' || bad 'success path state is wrong'
[[ $(wc -l < "$FAKE/home/state/evidence/evidence.jsonl") == 1 ]] \
  && jq -e 'select(.result=="success" and .tcp==true and .anonymousHttpStatus=="401" and .alias=="omniroute-rehearse")' "$FAKE/home/state/evidence/evidence.jsonl" >/dev/null \
  && ok 'success writes one sanitized append-only evidence row' || bad 'success evidence row is missing or malformed'
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

# An old marker cannot act on a replacement container even if all reproducible
# package labels are identical.
cp "$FAKE/state/expected.json" "$FAKE/state/rehearsal.json"
jq '.running=true | .attached=true' "$FAKE/state/rehearsal.json" > "$FAKE/state/t" && mv "$FAKE/state/t" "$FAKE/state/rehearsal.json"
printf '{"type":"attach","containerId":"replacement-id","imageId":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","wasRunning":true,"dbManifestSha256":"%s","dbSha256":"%s"}\n' "$manifest_sha" "$db_sha" > "$marker"
printf 'tog554-replacement-undo09\n' > "$FAKE/home/action"
out=$(run_action --undo 2>&1); rc=$?
(( rc != 0 )) && [[ $(jq -r '.attached' "$FAKE/state/rehearsal.json") == true ]] && [[ -f $marker ]] \
  && ok 'undo refuses a replacement container with matching package labels' || bad 'undo acted on a replacement container' "$out"
rm -f "$marker"

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
cp "$FAKE/bin/podman" "$FAKE/bin-wrong-network/podman"
python3 - "$FAKE/bin-wrong-network/podman" <<'PY'
from pathlib import Path
import sys

p = Path(sys.argv[1])
s = p.read_text()
s = s.replace(
    "printf '{\"live\":{\"Name\":\"omniroute\"}}\\n'",
    "printf '{}\\n'",
)
p.write_text(s)
PY
chmod +x "$FAKE/bin-wrong-network/podman"
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

section '6. generated canonical runbook'
rendered_file="$TMP/operator-runbook.md"
$HERE/operator_runbook.sh render > "$rendered_file" 2>&1; rc=$?
(( rc == 0 )) && cmp -s "$rendered_file" "$HERE/docs/OPERATOR-RUNBOOK.md" \
  && ok 'canonical operator runbook matches its generator source' || bad 'canonical operator runbook is stale' "$(diff -u "$HERE/docs/OPERATOR-RUNBOOK.md" "$rendered_file" | head -80)"
grep -q 'omniroute/rehearsal/operator-action.sh --apply' "$HERE/operator_runbook_classification.json" \
  && ok 'runbook source carries the fixed TOG-554 action' || bad 'runbook source lacks the fixed TOG-554 action'

printf '\n== totals\n  passed: %d\n  failed: %d\n' "$PASS" "$FAIL"
(( FAIL == 0 )) || exit 1
