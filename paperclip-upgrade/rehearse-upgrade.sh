#!/usr/bin/env bash
# ===========================================================================
# paperclip-upgrade/rehearse-upgrade.sh — Docker upgrade rehearsal for the
# Paperclip server.
#
# WHAT IT DOES. Rehearses a Paperclip image upgrade against a COPY of the
# production database on an egress-less internal Docker network, then proves
# the dump restores, the target migrations apply, and the app boots healthy
# on the candidate image. Effective-build proof runs twice: pre-boot against
# the image and post-boot against the running stage container
# (overlay-inclusive), so a stale overlay shadowing the patched server-utils
# fails the rehearsal instead of passing on source presence. Nothing here
# touches the production containers, volumes or network.
#
# PORT NOTES (from the earlier Podman implementation of this rehearsal):
#   - Docker-compatible CLI throughout; no podman, no Quadlet unit paths,
#     no $HOME/.config/containers references.
#   - No fixed stage names. Every artifact carries a unique run id AND a
#     label; collision with an existing name REFUSES (exit 2) instead of
#     `rm -f`-ing whatever was there (the destructive behaviour this port
#     removes).
#   - No production env file is ever read. DB credentials come from explicit
#     flags; the stage database name must look like a rehearsal database
#     (fail-closed non-production identity check).
#   - The stage network is created `--internal` and VERIFIED internal via
#     inspect; a non-internal network aborts the run.
#   - Stage containers always carry memory/cpu/pids resource bounds.
#   - Cleanup removes only artifacts carrying this run's label. Default is
#     to tear the stage down on success and leave it (stopped-safe) on
#     failure for inspection, with the exact teardown command printed;
#     --cleanup-always removes even on failure.
#   - The health wait loop has a deadline and exits non-zero on exhaustion:
#     a timed-out boot is never a pass by fallthrough.
#
# WHAT IT NEVER DOES. No production database contact (the only input is a
# dump FILE produced by the read-only inventory backup); no host docker
# socket mount; no --privileged; no port publication; no credential, env
# file content, or dump content printed to stdout or the evidence bundle
# (counts and hashes only).
#
# Keeper (SQLite) data is OUT OF SCOPE for this script: a live SQLite WAL
# must never be copied unsafely. Keeper backup/restore is handled separately.
#
# Usage:
#   rehearse-upgrade.sh --image IMAGE_REF --dump DUMP_FILE [options]
#
# Exit status:
#   0  rehearsal passed (restore + migrations + health + inventory)
#   1  rehearsal ran and FAILED a gate (evidence left in the state dir)
#   2  refused -- bad args, missing tool, precondition or identity check
# ===========================================================================
set -uo pipefail
umask 077

ME="${BASH_SOURCE[0]##*/}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

IMAGE=""; DUMP=""; PACKAGE_FILE=""
DB_IMAGE="${PAPERCLIP_REHEARSAL_DB_IMAGE:-postgres:16}"
DB_USER="${PAPERCLIP_REHEARSAL_DB_USER:-stage_rehearse}"
DB_NAME=""; RUN_ID=""
STATE_PARENT="${PAPERCLIP_REHEARSAL_STATE_DIR:-$HOME/.paperclip-upgrade-rehearsal}"
NEUTRALISE_SQL="$HERE/neutralise-stage.sql"
TIMEOUT_SECS=900
MEM_LIMIT="2g"; CPU_LIMIT="2.0"; PIDS_LIMIT=512
KEEP_STAGE=0; CLEANUP_ALWAYS=0; ROLLBACK_PROOF=0
EXPECT_IMAGE_SHA=""
EXPECT_BUILD_MARKER=""; MARKER_SET=0; BUILD_MARKER_OFF=0
EXPECT_BUILD_SHA=(); EXPECT_PLUGIN_PKGS=(); EXPECT_FILES=()
EBC="${PAPERCLIP_UPGRADE_EFFECTIVE_BUILD_CHECK:-$HERE/effective-build-check.sh}"
DOCKER="${DOCKER:-docker}"
REQUIRED_MIGRATIONS=(); REQUIRE_SET=0
REQUIRE_ROWS=()

usage() {
  cat <<'USAGE'
usage: rehearse-upgrade.sh --image IMAGE_REF --dump DUMP_FILE [options]

  --image REF            candidate server image (digest-pinned recommended)
  --dump FILE            pg_custom-format dump file (regular file, readable)
  --package FILE         rehearsal package manifest (expected image digest,
                         required migrations; see rehearsal-package.example.json)
  --db-image IMG         postgres image for the stage database
  --db-user NAME         stage database user (default: stage_rehearse)
  --db-name NAME         stage database name (required; must look non-production)
  --run-id ID            unique run suffix [A-Za-z0-9._:-]{8,64} (default: generated)
  --require-migration N  drizzle migration id required after boot (repeatable)
  --require-row LBL:SQL  assert query returns >= 1 row after boot (repeatable)
  --neutralise-sql FILE  SQL applied to the stage copy before boot
  --timeout-secs N       app boot wait deadline (default 900)
  --memory LIM --cpus N  resource bounds for stage containers
  --keep-stage           leave the stage running for inspection (default: tear down)
  --cleanup-always       remove own artifacts even on failure
  --rollback-proof       restore the dump a second time and diff inventory counts
  --expect-image-sha256 D  require the booted container image to equal this digest
  --expect-build-marker S  effective-build marker required inside the IMAGE
                           and the booted container (default EPIPE; the
                           EPIPE guard proves the tested artifact really
                           is the patched build, not a stale overlay shadow)
  --no-build-marker-check  collect effective-build evidence without requiring
                           the marker (reported, not gated)
  --expect-build-sha256 H  a collected server-utils file must carry this hash
                           (repeatable; every value must match at least one)
  --expect-plugin-package P:H  inventoried package P must resolve inside the
                           image with npm-package sha H (repeatable; proves
                           the target image ships the expected plugin builds)
  --expect-file ABS:H      file ABS must sha256 to H inside the image and the
                           booted container (repeatable; package key
                           expectedFiles; pins a compiled identity such as
                           the #29 /app/server/dist/redaction.js)

The legacy 916 whole-file redaction override is always refused: no mount may
cover /app/server/dist/redaction.js and no such file may carry its hash.
USAGE
}

fail()  { printf 'ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }
refuse() { printf 'REFUSED: %s\n' "$*" >&2; exit 2; }

while (($#)); do
  case "$1" in
    --image) IMAGE="${2:?}"; shift 2 ;;
    --dump) DUMP="${2:?}"; shift 2 ;;
    --package) PACKAGE_FILE="${2:?}"; shift 2 ;;
    --db-image) DB_IMAGE="${2:?}"; shift 2 ;;
    --db-user) DB_USER="${2:?}"; shift 2 ;;
    --db-name) DB_NAME="${2:?}"; shift 2 ;;
    --run-id) RUN_ID="${2:?}"; shift 2 ;;
    --require-migration) REQUIRED_MIGRATIONS+=("${2:?}"); REQUIRE_SET=1; shift 2 ;;
    --require-row) REQUIRE_ROWS+=("${2:?}"); shift 2 ;;
    --neutralise-sql) NEUTRALISE_SQL="${2:?}"; shift 2 ;;
    --timeout-secs) TIMEOUT_SECS="${2:?}"; shift 2 ;;
    --memory) MEM_LIMIT="${2:?}"; shift 2 ;;
    --cpus) CPU_LIMIT="${2:?}"; shift 2 ;;
    --keep-stage) KEEP_STAGE=1; shift ;;
    --cleanup-always) CLEANUP_ALWAYS=1; shift ;;
    --rollback-proof) ROLLBACK_PROOF=1; shift ;;
    --expect-image-sha256) EXPECT_IMAGE_SHA="${2:?}"; shift 2 ;;
    --expect-build-marker) EXPECT_BUILD_MARKER="${2:?}"; MARKER_SET=1; shift 2 ;;
    --no-build-marker-check) BUILD_MARKER_OFF=1; shift ;;
    --expect-build-sha256) EXPECT_BUILD_SHA+=("${2:?}"); shift 2 ;;
    --expect-plugin-package) EXPECT_PLUGIN_PKGS+=("${2:?}"); shift 2 ;;
    --expect-file) EXPECT_FILES+=("${2:?}"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) refuse "unknown flag: $1" ;;
  esac
done

# --- pre-flight refusals (nothing created yet) ------------------------------
command -v "$DOCKER" >/dev/null || refuse "docker runtime is missing: $DOCKER"
command -v jq >/dev/null || refuse "required command is missing: jq"
command -v sha256sum >/dev/null || refuse "required command is missing: sha256sum"
[[ -n "$IMAGE" ]] || refuse "--image is required"
[[ -n "$DUMP" ]] || refuse "--dump is required"
[[ -f "$DUMP" && ! -L "$DUMP" && -r "$DUMP" ]] || refuse "--dump must name a readable regular file: $DUMP"
[[ -f "$NEUTRALISE_SQL" && ! -L "$NEUTRALISE_SQL" ]] || refuse "neutralise SQL is not a regular file: $NEUTRALISE_SQL"
[[ "$TIMEOUT_SECS" =~ ^[0-9]+$ && "$TIMEOUT_SECS" -ge 60 ]] || refuse "--timeout-secs must be an integer >= 60"

[[ -f "$EBC" && ! -L "$EBC" ]] || refuse "effective-build checker missing beside $0: $EBC"

# The package manifest fills in what the CLI did not pin (CLI wins on every
# scalar; repeatables merge: CLI values first, then the file's). Validate the
# merged result below, never each source separately, so a bad manifest value
# cannot slip past a CLI-only validation.
if [[ -n "$PACKAGE_FILE" ]]; then
  [[ -f "$PACKAGE_FILE" && ! -L "$PACKAGE_FILE" ]] || refuse "--package must name a regular file: $PACKAGE_FILE"
  jq -e 'type == "object"' "$PACKAGE_FILE" >/dev/null 2>&1 \
    || refuse "--package is not a JSON object: $PACKAGE_FILE"
  if [[ -z "$EXPECT_IMAGE_SHA" ]]; then
    EXPECT_IMAGE_SHA="$(jq -r '.expectedImageSha256 // empty' "$PACKAGE_FILE")"
  fi
  if ((REQUIRE_SET == 0)); then
    while IFS= read -r m; do
      [[ -n "$m" ]] && REQUIRED_MIGRATIONS+=("$m")
    done < <(jq -r '.requiredMigrations[]? // empty' "$PACKAGE_FILE")
  fi
  while IFS= read -r pp; do
    [[ -n "$pp" ]] && EXPECT_PLUGIN_PKGS+=("$pp")
  done < <(jq -r '.expectedPluginPackages[]? // empty' "$PACKAGE_FILE")
  while IFS= read -r pp; do
    [[ -n "$pp" ]] && EXPECT_FILES+=("$pp")
  done < <(jq -r '.expectedFiles[]? // empty' "$PACKAGE_FILE")
  if ((MARKER_SET == 0 && BUILD_MARKER_OFF == 0)); then
    pm="$(jq -r '.expectedBuildMarker // empty' "$PACKAGE_FILE")"
    [[ -n "$pm" ]] && EXPECT_BUILD_MARKER="$pm"
  fi
  while IFS= read -r h; do
    [[ -n "$h" ]] && EXPECT_BUILD_SHA+=("$h")
  done < <(jq -r '.expectedBuildSha256[]? // empty' "$PACKAGE_FILE")
fi
((REQUIRE_SET)) || ((${#REQUIRED_MIGRATIONS[@]})) || REQUIRED_MIGRATIONS=(0280 0281 0282 0283)
for t in "${REQUIRED_MIGRATIONS[@]}"; do
  [[ "$t" =~ ^[0-9]{4}$ ]] || refuse "--require/requiredMigrations must be 4-digit prefixes: $t"
done
[[ -z "$EXPECT_BUILD_MARKER" ]] && EXPECT_BUILD_MARKER="EPIPE"
[[ "$EXPECT_BUILD_MARKER" =~ ^[A-Za-z0-9_.~-]+$ ]] || refuse "--expect-build-marker must be a plain token"
for h in ${EXPECT_BUILD_SHA[@]+"${EXPECT_BUILD_SHA[@]}"}; do
  [[ "$h" =~ ^[0-9a-f]{64}$ ]] || refuse "--expect-build-sha256 must be 64 lowercase hex"
done
for pp in ${EXPECT_PLUGIN_PKGS[@]+"${EXPECT_PLUGIN_PKGS[@]}"}; do
  # NAME:HEX64 -- NAME is an npm package path fragment (no "..": it must not
  # walk out of node_modules); HEX64 the expected sha256 of its package.json
  # inside the image. The charset below rejects quotes, backslashes, $ and
  # whitespace so a crafted value cannot smuggle shell or option text into
  # the proof.
  [[ "$pp" =~ ^[A-Za-z0-9_.@/-]+:[0-9a-f]{64}$ && "$pp" != *..* ]] \
    || refuse "--expect-plugin-package must be NAME:64-hex-sha256 (NAME [A-Za-z0-9_.@/-]+, no ..): $pp"
done
for xf in ${EXPECT_FILES[@]+"${EXPECT_FILES[@]}"}; do
  [[ "$xf" =~ ^/[A-Za-z0-9_.@/-]+:[0-9a-f]{64}$ && "$xf" != *..* && "$xf" != *//* && "${xf%:*}" != */ ]] \
    || refuse "--expect-file/expectedFiles must be ABS:64-hex-sha256 (ABS absolute, [A-Za-z0-9_.@/-], no .., // or trailing /): $xf"
done

# Non-production identity, fail-closed. The stage database must LOOK like a
# rehearsal database; exact production names are refused outright. The dump
# itself is a file (produced by the read-only inventory backup), so no live
# production host is ever contacted — but a rehearsal that boots a database
# NAMED like production invites exactly the confusion this gate removes.
[[ -n "$DB_NAME" ]] || refuse "--db-name is required"
case "$DB_NAME" in
  paperclip|postgres|template0|template1) refuse "stage database name is a production/system name: $DB_NAME" ;;
esac
[[ "$DB_NAME" =~ [Ss]tage|[Rr]ehears ]] || refuse "stage database name must contain 'stage' or 'rehearse': $DB_NAME"
[[ "$DB_USER" == "paperclip" ]] && refuse "stage database user is the production user"
[[ "$DB_USER" =~ ^[a-z_][a-z0-9_]*$ ]] || refuse "stage database user is not a safe identifier: $DB_USER"

# Effective-build argument bundle for both proofs below (image pre-boot,
# container post-boot). Always non-empty: either the marker is required or
# collection is explicitly marker-free.
EBC_ARGS=()
if ((BUILD_MARKER_OFF)); then EBC_ARGS+=(--no-marker-check)
else EBC_ARGS+=(--require-marker "$EXPECT_BUILD_MARKER"); fi
for h in ${EXPECT_BUILD_SHA[@]+"${EXPECT_BUILD_SHA[@]}"}; do EBC_ARGS+=(--expect-sha256 "$h"); done
for pp in ${EXPECT_PLUGIN_PKGS[@]+"${EXPECT_PLUGIN_PKGS[@]}"}; do EBC_ARGS+=(--expect-plugin-package "$pp"); done
for xf in ${EXPECT_FILES[@]+"${EXPECT_FILES[@]}"}; do EBC_ARGS+=(--expect-file "$xf"); done
# The rehearsal proves the UPGRADE artifact, which must not run the 916
# redaction override: refused in the image and the booted stage.
EBC_ARGS+=(--forbid-916-redaction)

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
fi
[[ "$RUN_ID" =~ ^[A-Za-z0-9._:-]{8,64}$ ]] || refuse "--run-id must be 8-64 safe characters"

LABEL="io.togetherweown.paperclip-upgrade.run=$RUN_ID"
APP="pc-stage-$RUN_ID-app"; STAGEDB="pc-stage-$RUN_ID-db"; STAGEDB2="pc-stage-$RUN_ID-db2"
NET="pc-stage-$RUN_ID"; VOL="pc-stage-$RUN_ID-pgdata"; VOL2="pc-stage-$RUN_ID-pgdata2"

STATE_DIR="$STATE_PARENT/$RUN_ID"
mkdir -p "$STATE_DIR" || refuse "cannot create state dir: $STATE_DIR"
chmod 0700 "$STATE_DIR"
LOG="$STATE_DIR/rehearse.log"
exec > >(tee -a "$LOG") 2>&1

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }

"$DOCKER" info >/dev/null 2>&1 || refuse "docker daemon is unreachable"

# Collision refusal: every name we would claim must be absent. We never
# remove a pre-existing container, network or volume.
for kind_name in "container:$APP" "container:$STAGEDB" "network:$NET" "volume:$VOL"; do
  kind="${kind_name%%:*}"; name="${kind_name#*:}"
  if "$DOCKER" "$kind" inspect "$name" >/dev/null 2>&1; then
    refuse "collision: $kind $name already exists (not ours; refusing to remove it)"
  fi
done


# Own-artifact teardown: only artifacts carrying this run's label.
teardown_own() {
  for c in "$APP" "$STAGEDB" "$STAGEDB2"; do
    if "$DOCKER" container inspect "$c" >/dev/null 2>&1; then
      lbl="$("$DOCKER" container inspect "$c" --format "{{index .Config.Labels \"$LABEL\"}}" 2>/dev/null || true)"
      # The label key embeds the run id, so presence of any value proves
      # ownership; absence (or inspect failure) means hands off.
      if [[ -n "$lbl" ]]; then
        "$DOCKER" rm -f "$c" >/dev/null 2>&1 || true
        log "removed own container $c"
      else
        log "NOT removing container $c (not ours)"
      fi
    fi
  done
  for v in "$VOL" "$VOL2"; do
    if "$DOCKER" volume inspect "$v" >/dev/null 2>&1; then
      "$DOCKER" volume rm "$v" >/dev/null 2>&1 || true
      log "removed own volume $v"
    fi
  done
  if "$DOCKER" network inspect "$NET" >/dev/null 2>&1; then
    "$DOCKER" network rm "$NET" >/dev/null 2>&1 || true
    log "removed own network $NET"
  fi
}
teardown_cmd() {
  cat <<EOF
$DOCKER rm -f $APP $STAGEDB $STAGEDB2 >/dev/null 2>&1; $DOCKER volume rm $VOL $VOL2 >/dev/null 2>&1; $DOCKER network rm $NET >/dev/null 2>&1
EOF
}
finish_fail() {
  log "REHEARSAL FAILED: $1"
  if [[ "$KEEP_STAGE" == "1" ]]; then
    log "stage left running for inspection; tear down with:"
    teardown_cmd
  elif [[ "$CLEANUP_ALWAYS" == "1" ]]; then
    teardown_own
  else
    log "stage left in place (default on failure); tear down with:"
    teardown_cmd
  fi
  exit 1
}

psq() { # $1 = db container, $2 = SQL; prints raw tuples only, never credentials
  "$DOCKER" exec "$1" psql -U "$DB_USER" -d "$DB_NAME" -At -v ON_ERROR_STOP=1 -c "$2" 2>>"$STATE_DIR/psql.err"
}

# --- pre-boot effective-build proof (image only; no stage exists yet) ---------
# A candidate that is not the patched build, or that does not ship the
# inventoried plugin builds, fails here -- before any database is staged.
# Source presence in the fork is not evidence; the IMAGE's own files are.
log "effective-build proof (pre-boot): $IMAGE"
if bash "$EBC" --image "$IMAGE" "${EBC_ARGS[@]}" >"$STATE_DIR/effective-build-image.log" 2>&1; then
  grep -q '^EFFECTIVE_BUILD PROVEN' "$STATE_DIR/effective-build-image.log" \
    || fail "pre-boot effective-build proof exited 0 without PROVEN (see effective-build-image.log)"
  log "pre-boot effective-build: PROVEN (see effective-build-image.log)"
else
  fail "pre-boot effective-build proof FAILED (see effective-build-image.log): the candidate is not the patched build or lacks the inventoried plugin builds"
fi

# --- build the stage ---------------------------------------------------------
log "network (internal, no egress)"
"$DOCKER" network create --internal --label "$LABEL" "$NET" >/dev/null \
  || fail "cannot create stage network"
if [[ "$("$DOCKER" network inspect "$NET" --format '{{.Internal}}' 2>/dev/null)" != "true" ]]; then
  teardown_own
  fail "stage network is not internal; aborted"
fi

log "stage database"
"$DOCKER" run -d --name "$STAGEDB" --label "$LABEL" --network "$NET" \
  --memory "$MEM_LIMIT" --cpus "$CPU_LIMIT" --pids-limit "$PIDS_LIMIT" \
  -e "POSTGRES_USER=$DB_USER" -e "POSTGRES_DB=$DB_NAME" \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$VOL:/var/lib/postgresql/data" -v "$DUMP:/dump.pgc:ro" \
  "$DB_IMAGE" >/dev/null || { teardown_own; fail "cannot start stage database"; }

ready=0
for ((i = 0; i < 60; i++)); do
  if "$DOCKER" exec "$STAGEDB" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[[ "$ready" == "1" ]] || { teardown_own; fail "stage database never became ready"; }

log "restore (pg_custom dump, no owner, no privileges)"
if ! "$DOCKER" exec "$STAGEDB" pg_restore -U "$DB_USER" -d "$DB_NAME" \
    --no-owner --no-privileges -j 2 /dump.pgc 2>&1 \
    | grep -v 'already exists' | tail -3; then
  teardown_own; fail "pg_restore failed"
fi

inventory() { # $1 = db container, $2 = output file; counts only, never row data
  local c="$1" out="$2"
  {
    echo "{"
    echo "  \"drizzle_rows\": \"$(psq "$c" 'select count(*) from drizzle.__drizzle_migrations' || echo UNKNOWN)\","
    echo "  \"public_tables\": \"$(psq "$c" "select count(*) from information_schema.tables where table_schema='public'" || echo UNKNOWN)\","
    echo "  \"public_indexes\": \"$(psq "$c" "select count(*) from pg_indexes where schemaname='public'" || echo UNKNOWN)\","
    echo "  \"issues\": \"$(psq "$c" 'select count(*) from issues' || echo UNKNOWN)\","
    echo "  \"agents\": \"$(psq "$c" 'select count(*) from agents' || echo UNKNOWN)\","
    echo "  \"company_skills\": \"$(psq "$c" 'select count(*) from company_skills' || echo UNKNOWN)\","
    echo "  \"plugins\": \"$(psq "$c" "select string_agg(plugin_key||':'||status, ', ' order by plugin_key) from plugins" || echo UNKNOWN)\","
    echo "  \"plugin_config\": \"$(psq "$c" 'select count(*) from plugin_config' || echo UNKNOWN)\","
    echo "  \"secret_bindings\": \"$(psq "$c" 'select count(*) from company_secret_bindings' || echo UNKNOWN)\","
    echo "  \"agent_api_keys\": \"$(psq "$c" 'select count(*) from agent_api_keys' || echo UNKNOWN)\","
    echo "  \"app_role_present\": \"$(psq "$c" "select count(*) from pg_roles where rolname='paperclip_app'" || echo UNKNOWN)\""
    echo "}"
  } > "$out"
}

inventory "$STAGEDB" "$STATE_DIR/inventory-before.json"
log "inventory before: $(tr -d '\n ' < "$STATE_DIR/inventory-before.json" | head -c 400)"

log "neutralise the copy (no timers, no wakes, no live runs)"
if ! "$DOCKER" exec -i "$STAGEDB" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q < "$NEUTRALISE_SQL" >>"$STATE_DIR/neutralise.log" 2>&1; then
  teardown_own; fail "neutralise SQL failed (see neutralise.log)"
fi

if [[ "$ROLLBACK_PROOF" == "1" ]]; then
  log "rollback proof: second restore into an independent stage database"
  "$DOCKER" run -d --name "$STAGEDB2" --label "$LABEL" --network "$NET" \
    --memory "$MEM_LIMIT" --cpus "$CPU_LIMIT" --pids-limit "$PIDS_LIMIT" \
    -e "POSTGRES_USER=$DB_USER" -e "POSTGRES_DB=$DB_NAME" \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    -v "$VOL2:/var/lib/postgresql/data" -v "$DUMP:/dump.pgc:ro" \
    "$DB_IMAGE" >/dev/null || { teardown_own; fail "cannot start rollback-proof database"; }
  ready=0
  for ((i = 0; i < 60; i++)); do
    if "$DOCKER" exec "$STAGEDB2" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then ready=1; break; fi
    sleep 2
  done
  [[ "$ready" == "1" ]] || { teardown_own; fail "rollback-proof database never became ready"; }
  "$DOCKER" exec "$STAGEDB2" pg_restore -U "$DB_USER" -d "$DB_NAME" \
    --no-owner --no-privileges -j 2 /dump.pgc >/dev/null 2>&1 \
    || { teardown_own; fail "rollback-proof restore failed"; }
  inventory "$STAGEDB2" "$STATE_DIR/inventory-rollback.json"
  if ! python3 - "$STATE_DIR/inventory-before.json" "$STATE_DIR/inventory-rollback.json" <<'PY'; then
import json, sys
a = json.load(open(sys.argv[1])); b = json.load(open(sys.argv[2]))
bad = [k for k in a if a[k] != b.get(k)]
print("rollback diff keys:", bad if bad else "none")
sys.exit(1 if bad else 0)
PY
    teardown_own; fail "rollback-proof restore diverges from the first restore"
  fi
  log "rollback proof: second restore matches the first"
fi

# --- boot the candidate ------------------------------------------------------
log "start app on $IMAGE"
"$DOCKER" run -d --name "$APP" --label "$LABEL" --network "$NET" \
  --memory "$MEM_LIMIT" --cpus "$CPU_LIMIT" --pids-limit "$PIDS_LIMIT" \
  -e "POSTGRES_USER=$DB_USER" -e "POSTGRES_DB=$DB_NAME" -e "POSTGRES_HOST=$STAGEDB" \
  -e HEARTBEAT_SCHEDULER_ENABLED=false -e PAPERCLIP_MIGRATION_AUTO_APPLY=true \
  -e PAPERCLIP_ANNOUNCEMENTS_ENABLED=false \
  "$IMAGE" >/dev/null || { teardown_own; fail "cannot start stage app"; }

# The health loop below is deadline-bounded and EXITS NON-ZERO on exhaustion.
# A boot that never reports healthy is a failed rehearsal, never a pass by
# fallthrough: every path out of the loop sets healthy=1 or calls finish_fail.
deadline=$((SECONDS + TIMEOUT_SECS)); healthy=0; health_body=""
while ((SECONDS < deadline)); do
  if "$DOCKER" exec "$APP" node -e 'fetch("http://127.0.0.1:3100/api/health").then(r=>r.text()).then(t=>{console.log(t);process.exit(0)}).catch(()=>process.exit(1))' >"$STATE_DIR/health.json" 2>/dev/null; then
    health_body="$(cat "$STATE_DIR/health.json")"
    if grep -q '"status":"ok"' "$STATE_DIR/health.json"; then healthy=1; break; fi
  fi
  state="$("$DOCKER" container inspect "$APP" --format '{{.State.Status}}' 2>/dev/null || echo missing)"
  restarts="$("$DOCKER" container inspect "$APP" --format '{{.RestartCount}}' 2>/dev/null || echo ?)"
  if [[ "$state" != "running" ]]; then
    "$DOCKER" logs "$APP" 2>&1 | tail -30 > "$STATE_DIR/app-death.log" || true
    finish_fail "stage app left state 'running' (state=$state restarts=$restarts; see app-death.log)"
  fi
  sleep 5
done
[[ "$healthy" == "1" ]] || {
  "$DOCKER" logs "$APP" 2>&1 | tail -30 > "$STATE_DIR/app-timeout.log" || true
  finish_fail "app never reported healthy within ${TIMEOUT_SECS}s (see app-timeout.log)"
}
log "health: $(head -c 300 "$STATE_DIR/health.json")"

if [[ -n "$EXPECT_IMAGE_SHA" ]]; then
  booted="$("$DOCKER" container inspect "$APP" --format '{{.Image}}' 2>/dev/null || echo unknown)"
  [[ "$booted" == "$EXPECT_IMAGE_SHA" ]] || finish_fail "booted image $booted != expected $EXPECT_IMAGE_SHA"
  log "image digest matches expected $EXPECT_IMAGE_SHA"
fi

# Post-boot effective-build proof (container, OVERLAY-INCLUSIVE): the same
# bundle, now against the RUNNING stage container, so a stale overlay that
# shadows the patched file fails the rehearsal even when the image proved.
log "effective-build proof (post-boot, overlay-inclusive): $APP"
if bash "$EBC" --container "$APP" "${EBC_ARGS[@]}" >"$STATE_DIR/effective-build-container.log" 2>&1; then
  grep -q '^EFFECTIVE_BUILD PROVEN' "$STATE_DIR/effective-build-container.log" \
    || finish_fail "post-boot effective-build proof exited 0 without PROVEN (see effective-build-container.log)"
  log "post-boot effective-build: PROVEN (see effective-build-container.log)"
else
  finish_fail "post-boot effective-build proof FAILED (see effective-build-container.log): the booted container does not serve the patched build (stale overlay?)"
fi

# --- post-boot gates ----------------------------------------------------------
log "migrations / schema after"
inventory "$STAGEDB" "$STATE_DIR/inventory-after.json"
for m in "${REQUIRED_MIGRATIONS[@]}"; do
  found="$(psq "$STAGEDB" "select count(*) from drizzle.__drizzle_migrations where id='$m' or hash like '%$m%' or version='$m'" || echo UNKNOWN)"
  [[ "$found" =~ ^[0-9]+$ && "$found" -ge 1 ]] || finish_fail "required migration $m not present after boot (got: $found)"
  log "migration present: $m"
done
for rr in ${REQUIRE_ROWS[@]+"${REQUIRE_ROWS[@]}"}; do
  lbl="${rr%%:*}"; sql="${rr#*:}"
  [[ -n "$lbl" && -n "$sql" && "$sql" != "$rr" ]] || finish_fail "malformed --require-row (want LBL:SQL): $lbl"
  n="$(psq "$STAGEDB" "select count(*) from ($sql) q" || echo UNKNOWN)"
  [[ "$n" =~ ^[0-9]+$ && "$n" -ge 1 ]] || finish_fail "required rows missing: $lbl (got: $n)"
  log "required rows present: $lbl ($n)"
done

log "app log: migration + plugin + error lines"
"$DOCKER" logs "$APP" 2>&1 \
  | grep -iE 'migrat|plugin-loader|plugin.*(error|fail)|level":50|Error:|listening|ready' \
  | grep -v '^chown' | head -40 | tee "$STATE_DIR/app-migration-lines.log" || true
if "$DOCKER" logs "$APP" 2>&1 | grep -iE 'level":50|Error:|FATAL' | grep -viE 'already exists' | head -5 > "$STATE_DIR/app-error-lines.log"; then
  if [[ -s "$STATE_DIR/app-error-lines.log" ]]; then
    finish_fail "app log contains error lines (see app-error-lines.log)"
  fi
fi

sha256sum "$STATE_DIR"/inventory-*.json "$STATE_DIR/health.json" \
  "$STATE_DIR"/effective-build-*.log > "$STATE_DIR/SHA256SUMS"
log "evidence: $STATE_DIR (checksums in SHA256SUMS)"
log "REHEARSAL PASSED"
if [[ "$KEEP_STAGE" == "1" ]]; then
  log "stage left running for inspection; tear down with:"
  teardown_cmd
else
  teardown_own
fi
exit 0
