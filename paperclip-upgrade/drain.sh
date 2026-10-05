#!/usr/bin/env bash
# ===========================================================================
# paperclip-upgrade/drain.sh -- zero-loss admission drain, drained restart,
# verification, undrain and rollback for the Paperclip upgrade on the
# Docker Compose host. Operator-run on the host. Agents run it
# only against the hermetic fakes in test_paperclip_upgrade.sh.
#
# WHAT CLOSES ADMISSION. The server's own task drain
# (POST /api/instance/task-drain): one in-memory switch that makes
# heartbeat.ts suppress scheduling for EVERY company and every producer that
# goes through enqueueWakeup (timers, assignments, comments, on-demand,
# routines, retries, recovery, plugins, native). Suppressed wakes are written
# as status 'skipped' and are re-delivered by `rewake`. The old
# wakeOnDemand=false flag flip is NOT used: it only stopped one producer and
# it cancelled due retries. Nothing here edits agent config.
#
# WHAT PROVES IT. Flags are not proof; measured state is. `wait` requires K
# consecutive polls with: the same server container (the drain is in memory,
# a restart silently re-opens admission), the same drain startedAt, the API's
# in-process activeRuns = pendingWakes = 0, every inflight.sql hard gate 0
# (running runs incl. preparing, live controller leases, claimed wakes,
# leased native finalizations, running plugin jobs) and no admission leak
# (leak.sql: runs/wakes created after startedAt that are not the drain
# working). drain-marker.sql ties the API we drained to the database we read.
#
# WHAT IT NEVER DOES. No FORCE escape (exporting FORCE is itself a refusal).
# No cancel, no kill, no hard timeout: `wait` gives up with admission still
# CLOSED and nothing cancelled. No production DDL: every query runs with
# default_transaction_read_only=on, except `rollback --restore-db`, which
# creates a NEW database and swaps names (the current one is kept, renamed,
# never dropped). No secret is printed: the API key travels in a curl -K file
# (must be 0600), response bodies go to 0600 files in the state dir, the
# resolved compose config is piped through jq and never stored.
#
# ORDER (each step refuses unless the previous one left its marker):
#   drain -> wait -> backup -> restart -> verify -> undrain (-> rewake)
#   abort     before restart: lift the drain (CAS), restore the waker, rewake
#   rollback  image-only (fresh drained state dir is fine) or --restore-db
#             (same state dir as the restart, refused once work resumed)
#
# Exit status: 0 ok | 1 a gate failed (state preserved, nothing cancelled)
#              2 refused (bad args, wrong order, unsafe environment)
#              3 partial / deferred (read the last lines; rerun is safe)
# ===========================================================================
set -uo pipefail
umask 077

ME="${BASH_SOURCE[0]##*/}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPERS_DIR="${PAPERCLIP_UPGRADE_HELPERS_DIR:-$HERE}"

API_BASE="${PAPERCLIP_UPGRADE_API_BASE:-http://127.0.0.1:3100}"
API_AUTH_FILE="${PAPERCLIP_UPGRADE_API_AUTH_FILE:-$HOME/.config/paperclip-upgrade/board.curl}"
DB_CONTAINER="${PAPERCLIP_UPGRADE_DB_CONTAINER:-paperclip-db}"
SERVER_CONTAINER="${PAPERCLIP_UPGRADE_SERVER_CONTAINER:-paperclip}"
COMPOSE_FILE="${PAPERCLIP_UPGRADE_COMPOSE_FILE:-${PAPERCLIP_HOME:-$HOME/.paperclip}/compose.yaml}"
SERVER_SERVICE="${PAPERCLIP_UPGRADE_SERVER_SERVICE:-server}"
HEALTH_URL="${PAPERCLIP_UPGRADE_HEALTH_URL:-$API_BASE/api/health}"
WAKER_OFF="${PAPERCLIP_UPGRADE_WAKER_OFF:-$HOME/.local/state/paperclip-idle-waker/DISABLED}"
FOCUS_ACTIVE="${PAPERCLIP_UPGRADE_FOCUS_ACTIVE:-$HOME/.local/state/paperclip-focus/ACTIVE}"
PRESERVE_ROOT="${PAPERCLIP_UPGRADE_PRESERVE_ROOT:-$HOME/.local/state/paperclip-upgrade/preserved}"
MIG_DIR="${PAPERCLIP_UPGRADE_MIGRATIONS_DIR:-/app/packages/db/src/migrations}"
PRECHECK="${PAPERCLIP_UPGRADE_PRECHECK:-$HELPERS_DIR/pre-restart-check.sh}"
REHARDEN="${PAPERCLIP_UPGRADE_REHARDEN:-$HELPERS_DIR/post-restart-reharden.sh}"
EBC="${PAPERCLIP_UPGRADE_EFFECTIVE_BUILD_CHECK:-$HELPERS_DIR/effective-build-check.sh}"
INVCHECK="${PAPERCLIP_UPGRADE_PLUGIN_INVENTORY_CHECK:-$HELPERS_DIR/check-plugin-inventory.py}"
DOCKER="${DOCKER:-docker}"

HARD_GATES="native_finalizations_leased plugin_job_runs_running runs_controller_lease_live runs_running wakes_claimed"
# The 916 whole-file redaction override (Quadlet bind mount). Upgrade packaging
# must not carry it over the 1001 build: restart/undrain refuse a
# compose service that mounts over it, verify refuses a running server that
# still has it (effective-build-check.sh --forbid-916-redaction).
LEGACY_REDACTION_DEST="/app/server/dist/redaction.js"
UUID_RE='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
TS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'

CMD=""; STATE_DIR=""; LIVE=0; IMAGE=""; EXPECT_IMAGE_ID=""; EXPECT_COMMIT=""
POLL_SECS=15; STABLE_POLLS=4; MAX_WAIT_SECS=14400; HEALTH_TIMEOUT_SECS=1200
REWAKE_BATCH=25; REWAKE_DELAY_SECS=2; REWAKE_FILTER=""; FOCUS_EXPIRED=0
ACK_CONFIG=0; ACK_PLUGIN=0; ACK_ORPHANS=0; ACK_LEAK=0; ACK_FENCE=0; ACK_INVENTORY=0
MAX_BACKUP_AGE_MINS=120; RESTORE_DB=0
REQUIRE=(); REQUIRE_SET=0
BUILD_MARKER=""; BUILD_MARKER_OFF=0; BUILD_SHA=(); PLUGIN_PKGS=(); EXPECT_FILES=()
PLUGIN_INVENTORY=""
LOG=""; TMPD=""; PARTIAL=0

usage() {
  cat <<'USAGE'
usage: drain.sh SUBCOMMAND --state-dir DIR [--live] [options]

  status    drain + inflight report (read-only; --live and a state dir optional)
  drain     record baselines, disable the idle waker (CAS), start the task drain
  wait      poll until quiescent on K consecutive polls (never kills anything)
  backup    pg_dump -Fc of the drained database, TOC-checked and checksummed
  restart   recreate the server on --image under a scheduling hold
  verify    health, image, migrations, plugins, config, inventory, reharden
  undrain   recreate without the hold, restore the waker (CAS), then rewake
  rewake    re-deliver suppressed wakes still owed (idempotent, batched)
  abort     before restart only: lift the drain (CAS), restore waker, rewake
  rollback  image-only to --image, or --restore-db into a new database

options:
  --image REF --expect-image-id sha256:<64 hex>   restart/rollback target
  --expect-commit SHA          health .commit must start with it (restart)
  --require TAG                migration prefix that must be applied after
                               restart (repeatable; default 0280-0283)
  --expect-build-marker S      effective-build marker required inside the
                               RUNNING server container at verify time
                               (default: EPIPE, the server-utils guard; proves
                               the live host is not shadowed by a stale
                               overlay of packages/adapter-utils/server-utils)
  --no-build-marker-check      collect build evidence without requiring it
  --expect-build-sha256 H      a collected live file must carry this hash
                               (repeatable; every value must match one)
  --expect-plugin-package P:H  inventoried package P must resolve in the
                               live server with package.json sha H
                               (repeatable; path-null bundled plugins are
                               proven here, never from inventory alone)
  --expect-file ABS:H          upgrade only: file ABS inside the target image and
                               the RUNNING server must sha256 to H (repeatable;
                               pins a compiled/load identity, e.g. the #29
                               server/dist/redaction.js). Upgrade also always
                               refuses the legacy 916 redaction overlay.
  --plugin-inventory FILE      approved operator inventory.json: validated
                               with check-plugin-inventory.py at verify time
                               (inventory only, NOT a compatibility PASS)
  --poll-secs N --stable-polls K --max-wait-secs N --health-timeout-secs N
  --rewake-batch N --rewake-delay-secs N
  --rewake-filter FILE         card ids (one UUID per line) allowed by the
                               focus gate; other owed wakes are deferred
  --focus-gate-expired         operator attests the focus/burn gate expired
  --max-backup-age-mins N      restart refuses an older backup (default 120)
  --ack-leak N --ack-orphans N --ack-config-drift N --ack-plugin-drift N
  --ack-inventory N --ack-fence N
                               accept EXACTLY N findings of that kind (any
                               other non-zero count still fails)
  --restore-db                 rollback: restore the backup into a new DB
USAGE
}

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
_log_line() { [[ -n "$LOG" ]] && printf '[%s] %s\n' "$(now)" "$*" >> "$LOG"; return 0; }
log() { printf '%s\n' "$*"; _log_line "$*"; }
refuse() { printf 'REFUSED: %s: %s\n' "$ME" "$*" >&2; _log_line "REFUSED: $*"; exit 2; }
fail() { printf 'ERROR: %s: %s\n' "$ME" "$*" >&2; _log_line "ERROR: $*"; exit 1; }
partial() { printf 'PARTIAL: %s: %s\n' "$ME" "$*" >&2; _log_line "PARTIAL: $*"; exit 3; }
warn() { printf 'WARNING: %s: %s\n' "$ME" "$*" >&2; _log_line "WARNING: $*"; PARTIAL=1; }

int_opt() { [[ "$2" =~ ^[0-9]+$ ]] || refuse "$1 must be a non-negative integer"; printf '%s' "$2"; }

while (($#)); do
  case "$1" in
    --state-dir) STATE_DIR="${2:?}"; shift 2 ;;
    --live) LIVE=1; shift ;;
    --image) IMAGE="${2:?}"; shift 2 ;;
    --expect-image-id) EXPECT_IMAGE_ID="${2:?}"; shift 2 ;;
    --expect-commit) EXPECT_COMMIT="${2:?}"; shift 2 ;;
    --require) REQUIRE+=("${2:?}"); REQUIRE_SET=1; shift 2 ;;
    --expect-build-marker) BUILD_MARKER="${2:?}"; shift 2 ;;
    --no-build-marker-check) BUILD_MARKER_OFF=1; shift ;;
    --expect-build-sha256) BUILD_SHA+=("${2:?}"); shift 2 ;;
    --expect-plugin-package) PLUGIN_PKGS+=("${2:?}"); shift 2 ;;
    --expect-file) EXPECT_FILES+=("${2:?}"); shift 2 ;;
    --plugin-inventory) PLUGIN_INVENTORY="${2:?}"; shift 2 ;;
    --poll-secs) POLL_SECS="$(int_opt "$1" "${2:-}")" || exit 2; shift 2 ;;
    --stable-polls) STABLE_POLLS="$(int_opt "$1" "${2:-}")" || exit 2; shift 2 ;;
    --max-wait-secs) MAX_WAIT_SECS="$(int_opt "$1" "${2:-}")" || exit 2; shift 2 ;;
    --health-timeout-secs) HEALTH_TIMEOUT_SECS="$(int_opt "$1" "${2:-}")" || exit 2; shift 2 ;;
    --rewake-batch) REWAKE_BATCH="$(int_opt "$1" "${2:-}")" || exit 2; shift 2 ;;
    --rewake-delay-secs) REWAKE_DELAY_SECS="$(int_opt "$1" "${2:-}")" || exit 2; shift 2 ;;
    --rewake-filter) REWAKE_FILTER="${2:?}"; shift 2 ;;
    --focus-gate-expired) FOCUS_EXPIRED=1; shift ;;
    --max-backup-age-mins) MAX_BACKUP_AGE_MINS="$(int_opt "$1" "${2:-}")" || exit 2; shift 2 ;;
    --ack-leak) ACK_LEAK="$(int_opt "$1" "${2:-}")" || exit 2; shift 2 ;;
    --ack-orphans) ACK_ORPHANS="$(int_opt "$1" "${2:-}")" || exit 2; shift 2 ;;
    --ack-config-drift) ACK_CONFIG="$(int_opt "$1" "${2:-}")" || exit 2; shift 2 ;;
    --ack-plugin-drift) ACK_PLUGIN="$(int_opt "$1" "${2:-}")" || exit 2; shift 2 ;;
    --ack-inventory) ACK_INVENTORY="$(int_opt "$1" "${2:-}")" || exit 2; shift 2 ;;
    --ack-fence) ACK_FENCE="$(int_opt "$1" "${2:-}")" || exit 2; shift 2 ;;
    --restore-db) RESTORE_DB=1; shift ;;
    -h|--help) usage; exit 0 ;;
    status|drain|wait|backup|restart|verify|undrain|rewake|abort|rollback)
      [[ -z "$CMD" ]] || refuse "two subcommands given: $CMD and $1"
      CMD="$1"; shift ;;
    *) refuse "unknown flag or subcommand: $1" ;;
  esac
done
[[ -n "$CMD" ]] || { usage >&2; refuse "a subcommand is required"; }
((REQUIRE_SET)) || REQUIRE=(0280 0281 0282 0283)
for t in "${REQUIRE[@]}"; do [[ "$t" =~ ^[0-9]{4}$ ]] || refuse "--require must be a 4-digit migration prefix: $t"; done
[[ -z "$BUILD_MARKER" ]] || [[ "$BUILD_MARKER" =~ ^[A-Za-z0-9_.~-]+$ ]] \
  || refuse "--expect-build-marker must be a plain token"
for h in ${BUILD_SHA[@]+"${BUILD_SHA[@]}"}; do
  [[ "$h" =~ ^[0-9a-f]{64}$ ]] || refuse "--expect-build-sha256 must be 64 lowercase hex"
done
for pp in ${PLUGIN_PKGS[@]+"${PLUGIN_PKGS[@]}"}; do
  [[ "$pp" =~ ^[A-Za-z0-9_.@/-]+:[0-9a-f]{64}$ && "$pp" != *..* ]] \
    || refuse "--expect-plugin-package must be NAME:64-hex-sha256 (NAME [A-Za-z0-9_.@/-]+, no ..)"
done
for xf in ${EXPECT_FILES[@]+"${EXPECT_FILES[@]}"}; do
  [[ "$xf" =~ ^/[A-Za-z0-9_.@/-]+:[0-9a-f]{64}$ && "$xf" != *..* && "$xf" != *//* && "${xf%:*}" != */ ]] \
    || refuse "--expect-file must be ABS:64-hex-sha256 (ABS absolute, [A-Za-z0-9_.@/-], no .., // or trailing /)"
done
[[ -z "$PLUGIN_INVENTORY" ]] || [[ -f "$PLUGIN_INVENTORY" && ! -L "$PLUGIN_INVENTORY" ]] \
  || refuse "--plugin-inventory is not a regular file: $PLUGIN_INVENTORY"
((STABLE_POLLS >= 1)) || refuse "--stable-polls must be >= 1"
((REWAKE_BATCH >= 1)) || refuse "--rewake-batch must be >= 1"

# The FORCE escape is removed for the approved upgrade path: exporting it is a
# refusal, so no caller can smuggle the old reboot-under-running-work back in.
[[ -z "${FORCE:-}" ]] || refuse "FORCE is set in the environment; the FORCE escape is removed for the approved upgrade path"

for bin in "$DOCKER" curl jq python3 sha256sum flock tar comm awk; do
  command -v "$bin" >/dev/null 2>&1 || refuse "required tool is missing: $bin"
done
[[ "$CMD" == status || "$LIVE" == 1 ]] || refuse "$CMD changes the live host; pass --live to confirm"

# --- state dir ----------------------------------------------------------------
st() { printf '%s/%s' "$STATE_DIR" "$1"; }
have() { [[ -s "$STATE_DIR/$1" ]]; }
get() { head -n1 -- "$STATE_DIR/$1"; }
mark() { # NAME VALUE -- atomic: a crash leaves the old marker or the new one
  printf '%s\n' "$2" > "$STATE_DIR/.$1.tmp" && mv -f -- "$STATE_DIR/.$1.tmp" "$STATE_DIR/$1" \
    || fail "cannot write state marker $1"
}
need() { local m; for m in "$@"; do have "$m" || refuse "$CMD needs '$m' in $STATE_DIR (run the earlier step first)"; done; }
none() { local m; for m in "$@"; do have "$m" && refuse "$CMD refused: '$m' is already recorded in $STATE_DIR ($(get "$m"))"; done; return 0; }

open_state() { # NEW=1: must not exist yet (fresh maintenance state, never reused)
  [[ -n "$STATE_DIR" ]] || refuse "--state-dir is required"
  [[ "$STATE_DIR" == /* ]] || refuse "--state-dir must be an absolute path"
  if [[ "$1" == 1 ]]; then
    [[ ! -e "$STATE_DIR" && ! -L "$STATE_DIR" ]] || refuse "state dir already exists: $STATE_DIR (a drain never reuses state; resolve it or pick a new dir)"
    mkdir -m 0700 -- "$STATE_DIR" || refuse "cannot create state dir $STATE_DIR"
  else
    [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" ]] || refuse "state dir missing: $STATE_DIR"
  fi
  [[ -O "$STATE_DIR" ]] || refuse "state dir is not owned by $(id -un): $STATE_DIR"
  local mode; mode="$(stat -c %a -- "$STATE_DIR")"
  (( (8#$mode & 8#077) == 0 )) || refuse "state dir must be 0700 (is $mode): $STATE_DIR"
  exec 9>>"$STATE_DIR/.lock" || refuse "cannot open state lock"
  flock -n 9 || refuse "another drain.sh holds $STATE_DIR"
  LOG="$STATE_DIR/drain.log"
  TMPD="$STATE_DIR/.tmp"
  mkdir -p -m 0700 -- "$TMPD" || fail "cannot create $TMPD"
}

check_auth_file() {
  [[ -f "$API_AUTH_FILE" && ! -L "$API_AUTH_FILE" ]] || refuse "API auth file missing (curl -K config with the board key header): $API_AUTH_FILE"
  [[ -O "$API_AUTH_FILE" ]] || refuse "API auth file is not owned by $(id -un)"
  local mode; mode="$(stat -c %a -- "$API_AUTH_FILE")"
  (( (8#$mode & 8#077) == 0 )) || refuse "API auth file must not be group/other readable (is $mode)"
}

# --- database (read-only unless MODE=rw) ---------------------------------------
# SQL arrives on stdin. Inline queries start with '-- q:<name>'; file queries
# carry their 'paperclip-upgrade/<file>.sql' header. Times are the DB clock.
psql_q() { # MODE DB [psql -v args...]; DB "" = the container's POSTGRES_DB
  local mode="$1" db="$2"; shift 2
  local -a envs=(-e "PCU_DB=$db")
  [[ "$mode" == ro ]] && envs+=(-e "PGOPTIONS=-c default_transaction_read_only=on")
  "$DOCKER" exec -i "${envs[@]}" "$DB_CONTAINER" sh -c \
    'exec psql -U "$POSTGRES_USER" -d "${PCU_DB:-$POSTGRES_DB}" -X -At -v ON_ERROR_STOP=1 "$@" -f -' sh "$@"
}
qf() { local f="$1"; shift; psql_q ro "" "$@" < "$HELPERS_DIR/$f"; }
dbnow() {
  local t
  t="$(psql_q ro "" <<'SQL'
-- q:now
SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
SQL
)" || fail "database clock unreadable"
  [[ "$t" =~ $TS_RE ]] || fail "database clock returned an unexpected value"
  printf '%s' "$t"
}
ledger_to() { # OUT [DB]
  psql_q ro "${2:-}" > "$1.tmp" <<'SQL' && [[ -s "$1.tmp" ]] && mv -f -- "$1.tmp" "$1"
-- q:ledger
SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id;
SQL
}
kv_file() { # OUT FILE.sql [psql args] -- every line must be name|integer
  local out="$1" f="$2"; shift 2
  qf "$f" "$@" > "$out.tmp" || { rm -f -- "$out.tmp"; return 1; }
  grep -Evq '^[a-z_]+\|-?[0-9]+$' "$out.tmp" && { rm -f -- "$out.tmp"; return 1; }
  [[ -s "$out.tmp" ]] || return 1
  mv -f -- "$out.tmp" "$out"
}
kv() { awk -F'|' -v k="$2" '$1 == k { print $2; found = 1 } END { if (!found) exit 1 }' "$1"; }

# inflight_check: 0 quiescent, 1 something executing; exits on a malformed read.
inflight_check() {
  local out="$TMPD/inflight" names total
  kv_file "$out" inflight.sql || fail "inflight query failed or returned malformed rows; treating as NOT drained"
  names="$(grep -v '^info_' "$out" | cut -d'|' -f1 | sort | tr '\n' ' ' | sed 's/ $//')"
  [[ "$names" == "$HARD_GATES" ]] || fail "inflight hard-gate set changed ($names); refusing to judge quiescence"
  total="$(grep -v '^info_' "$out" | awk -F'|' '{ s += $2 } END { print s + 0 }')"
  INFLIGHT_SUMMARY="$(tr '\n' ' ' < "$out")"
  ((total == 0))
}

# --- API (board key from a curl -K file; bodies to 0600 files, never printed)
api() { # METHOD PATH OUT [JSON]
  local -a a=(-sS -K "$API_AUTH_FILE" -m 60 -o "$3" -w '%{http_code}' -X "$1" -H 'Accept: application/json')
  (($# >= 4)) && a+=(-H 'Content-Type: application/json' --data-binary "$4")
  curl "${a[@]}" "$API_BASE$2" 2>/dev/null || true
}
drain_get() { # sets D_DRAINING D_STARTED D_EXPIRES D_RUNS D_WAKES; 1 on error
  local f="$TMPD/task-drain.json" code line
  code="$(api GET /api/instance/task-drain "$f")"
  [[ "$code" == 200 ]] || { D_ERR="GET task-drain HTTP $code"; return 1; }
  line="$(jq -r '[(.draining|tostring), (.startedAt // "-"), (.expiresAt // "-"), (.activeRuns|tostring), (.pendingWakes|tostring)] | join(" ")' "$f" 2>/dev/null)" \
    || { D_ERR="GET task-drain returned non-JSON"; return 1; }
  read -r D_DRAINING D_STARTED D_EXPIRES D_RUNS D_WAKES <<<"$line"
  [[ "$D_DRAINING" =~ ^(true|false)$ && "$D_RUNS" =~ ^[0-9]+$ && "$D_WAKES" =~ ^[0-9]+$ ]] \
    || { D_ERR="GET task-drain returned an unexpected shape"; return 1; }
}
health() { # sets H_STATUS H_COMMIT; H_STATUS=down when unreachable
  local f="$TMPD/health.json" code
  H_STATUS=down; H_COMMIT=-
  code="$(curl -sS -m 10 -o "$f" -w '%{http_code}' "$HEALTH_URL" 2>/dev/null)" || true
  jq -e 'type == "object"' "$f" >/dev/null 2>&1 || return 0
  H_STATUS="$(jq -r '.status // "unknown"' "$f")"; H_COMMIT="$(jq -r '.commit // "-"' "$f")"
  [[ "$code" == 200 ]] || { [[ "$H_STATUS" == ok ]] && H_STATUS="http-$code"; }
  return 0
}

# --- containers, images, compose -----------------------------------------------
ident() { # sets C_ID C_STARTED C_RESTARTS C_IMAGE C_STATE; 1 if no container
  local line
  line="$("$DOCKER" inspect -f '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.Image}} {{.State.Status}}' "$SERVER_CONTAINER" 2>/dev/null)" || return 1
  read -r C_ID C_STARTED C_RESTARTS C_IMAGE C_STATE <<<"$line"
  [[ -n "${C_STATE:-}" && "$C_RESTARTS" =~ ^[0-9]+$ ]]
}
ident_key() { printf '%s %s %s' "$C_ID" "$C_STARTED" "$C_RESTARTS"; }
same_server() { # the in-memory drain dies with the process: same container, same start
  ident || fail "server container $SERVER_CONTAINER not found"
  [[ "$(ident_key)" == "$(get server-ident)" ]] \
    || fail "drain LOST: the server container restarted or was replaced since the drain; admission is OPEN again. Run 'abort' (or 'status'), then start over with a new state dir"
}
image_id() { "$DOCKER" image inspect -f '{{.Id}}' "$1" 2>/dev/null; }
has_hold() { # the restart hold env is present on the running server
  local env_out
  env_out="$("$DOCKER" inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$SERVER_CONTAINER" 2>/dev/null)"
  grep -qx 'PAPERCLIP_RESTORE_IN_PROGRESS=true' <<<"$env_out"
}
compose_check() { # WANT_IMAGE [extra compose file]; the resolved config is never stored
  local want="$1" extra="${2:-}" line name img cname project
  local -a cf=(-f "$COMPOSE_FILE"); [[ -n "$extra" ]] && cf+=(-f "$extra")
  line="$("$DOCKER" compose "${cf[@]}" config --format json 2>/dev/null \
    | jq -r --arg s "$SERVER_SERVICE" '[(.name // "-"), (.services[$s].image // "-"), (.services[$s].container_name // "-")] | join(" ")')" \
    || fail "docker compose config failed for $COMPOSE_FILE"
  read -r name img cname <<<"$line"
  project="$("$DOCKER" inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$SERVER_CONTAINER" 2>/dev/null)" || project=""
  [[ "$img" == "$want" ]] || fail "compose service '$SERVER_SERVICE' resolves to image '$img', expected '$want' (edit $COMPOSE_FILE first)"
  [[ "$cname" == "$SERVER_CONTAINER" ]] || fail "compose container_name '$cname' is not $SERVER_CONTAINER"
  [[ -n "$project" && "$name" == "$project" ]] || fail "compose project '$name' does not match the running container's project '$project'"
}
compose_no_legacy_overlay() { # [extra compose file] -- upgrade/undrain only
  # Refuses before the server is touched when the compose service still
  # bind-mounts anything over the 916 redaction override path (the file
  # itself or an ancestor directory). `compose config` normalises short
  # volume syntax to long form, so every entry has a target; an entry
  # without one, an unreadable config or a missing service is a refusal,
  # never a pass. Rollback to 916 needs the mount, so it never calls this.
  local -a cf=(-f "$COMPOSE_FILE"); [[ -n "${1:-}" ]] && cf+=(-f "$1")
  local cfg targets t d
  cfg="$("$DOCKER" compose "${cf[@]}" config --format json 2>/dev/null)" && [[ -n "$cfg" ]] \
    || fail "cannot read the volumes of compose service '$SERVER_SERVICE' from $COMPOSE_FILE (compose config failed)"
  targets="$(jq -r --arg s "$SERVER_SERVICE" '.services[$s] as $svc | if $svc == null then error("service missing") else ($svc.volumes // [])[] | (.target // error("volume without target")) end' <<<"$cfg" 2>/dev/null)" \
    || fail "cannot read the volumes of compose service '$SERVER_SERVICE' from $COMPOSE_FILE"
  while IFS= read -r t; do
    [[ -n "$t" ]] || continue
    d="${t%/}"; [[ -n "$d" ]] || d="/"
    if [[ "$d" == "/" || "$LEGACY_REDACTION_DEST" == "$d" || "$LEGACY_REDACTION_DEST" == "$d"/* ]]; then
      fail "compose service '$SERVER_SERVICE' still mounts $t over $LEGACY_REDACTION_DEST (the 916 redaction override must not ride the upgrade; remove it from $COMPOSE_FILE first)"
    fi
  done <<<"$targets"
  log "ok: compose service '$SERVER_SERVICE' mounts nothing over $LEGACY_REDACTION_DEST"
}
compose_up() { # [extra compose file] -- recreate ONLY the server, never build or pull
  local -a cf=(-f "$COMPOSE_FILE"); [[ -n "${1:-}" ]] && cf+=(-f "$1")
  "$DOCKER" compose "${cf[@]}" up -d --no-deps --no-build --pull never --force-recreate "$SERVER_SERVICE" >> "$LOG" 2>&1
}
image_mig_hashes() { # IMAGE_ID OUT -- the target image's own migration files
  "$DOCKER" run --rm --pull never --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --entrypoint sh "$1" \
    -c 'cd "$1" && sha256sum -- *.sql' sh "$MIG_DIR" > "$2.tmp" 2>>"$LOG" \
    && [[ -s "$2.tmp" ]] && mv -f -- "$2.tmp" "$2"
}
write_hold() {
  cat > "$(st hold.override.yaml)" <<YAML || fail "cannot write the hold override"
# drain.sh restart hold: scheduling stays suppressed (heartbeat.ts
# database_restore_in_progress) until 'verify' passes and 'undrain' recreates
# the server from $COMPOSE_FILE alone.
services:
  $SERVER_SERVICE:
    environment:
      PAPERCLIP_RESTORE_IN_PROGRESS: "true"
      PAPERCLIP_MIGRATION_AUTO_APPLY: "true"
YAML
}
wait_healthy() { # OLD_CONTAINER_ID -- never falls through to success
  local old="$1" deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECS )) first_id="" first_rc="" first_start=""
  while :; do
    if ident; then
      [[ "$C_ID" != "$old" ]] || fail "the server container was not recreated (same id)"
      if [[ -z "$first_id" ]]; then first_id="$C_ID"; first_rc="$C_RESTARTS"; first_start="$C_STARTED"; fi
      [[ "$C_ID" == "$first_id" ]] || fail "the server container was replaced again while booting"
      ((C_RESTARTS == first_rc)) && [[ "$C_STARTED" == "$first_start" ]] \
        || fail "restart loop: the new server restarted while booting (RestartCount $first_rc -> $C_RESTARTS)"
      case "$C_STATE" in exited|dead) fail "the new server container is $C_STATE";; esac
      health
      [[ "$C_STATE" == running && "$H_STATUS" == ok ]] && return 0
    fi
    (( $(date +%s) < deadline )) || fail "health timeout after ${HEALTH_TIMEOUT_SECS}s (last status: ${H_STATUS:-none}); NOT treated as success"
    sleep "$POLL_SECS"
  done
}

# --- idle waker (CAS: we only remove the file we created, unchanged) ----------
sha_of() { sha256sum < "$1" | cut -d' ' -f1; }
waker_close() {
  if [[ -e "$WAKER_OFF" || -L "$WAKER_OFF" ]]; then
    mark waker.cas "preexisting $(sha_of "$WAKER_OFF")"
    log "idle waker: already disabled ($WAKER_OFF pre-exists); left untouched and never removed by this run"
  else
    mkdir -p -- "$(dirname -- "$WAKER_OFF")" || fail "cannot create $(dirname -- "$WAKER_OFF")"
    ( set -C; printf 'paperclip-upgrade drain %s %s\n' "$STATE_DIR" "$(get drain_requested_at)" > "$WAKER_OFF" ) \
      || fail "cannot create $WAKER_OFF (someone created it concurrently?)"
    mark waker.cas "ours $(sha_of "$WAKER_OFF")"
    log "idle waker: disabled ($WAKER_OFF)"
  fi
}
waker_restore() {
  have waker.cas || { log "idle waker: no record (drain never touched it)"; return 0; }
  local kind sha; read -r kind sha < "$(st waker.cas)"
  case "$kind" in
    preexisting) log "idle waker: was disabled before the drain; left disabled" ;;
    ours)
      if [[ ! -e "$WAKER_OFF" ]]; then log "idle waker: file already removed by someone else"
      elif [[ "$(sha_of "$WAKER_OFF")" == "$sha" ]]; then rm -f -- "$WAKER_OFF" && log "idle waker: re-enabled"
      else warn "idle waker file changed since the drain; NOT removed ($WAKER_OFF)"; fi ;;
    *) warn "unreadable waker.cas; idle waker left as is" ;;
  esac
}

# --- snapshots and comparisons ------------------------------------------------
plugins_to() { # OUT -- pluginKey|status|version, then tools|<count or n/a>
  local f="$TMPD/plugins.json" code
  code="$(api GET /api/plugins "$f")"
  [[ "$code" == 200 ]] || return 1
  jq -r 'if type == "array" then .[] | [.pluginKey, .status, (.version // "")] | join("|") else error("not a list") end' "$f" > "$1.tmp" 2>/dev/null || return 1
  sort -o "$1.tmp" "$1.tmp"
  code="$(api GET /api/plugins/tools "$f")"
  case "$code" in
    200) printf 'tools|%s\n' "$(jq -r 'if type == "array" then length else error("x") end' "$f" 2>/dev/null)" >> "$1.tmp" ;;
    501) printf 'tools|n/a\n' >> "$1.tmp" ;;
    *) return 1 ;;
  esac
  grep -q '^tools|\(n/a\|[0-9][0-9]*\)$' "$1.tmp" && mv -f -- "$1.tmp" "$1"
}
plugin_drift() { # prints the drift count; details to the log
  local f="$TMPD/plugins-now.json" hf="$TMPD/plugin-health.json" code n=0 key status id ok base_tools now_tools
  code="$(api GET /api/plugins "$f")"
  [[ "$code" == 200 ]] || { _log_line "plugins: GET /api/plugins HTTP $code"; echo 999; return; }
  while IFS='|' read -r key status _; do
    [[ "$key" == tools || "$status" != ready ]] && continue
    id="$(jq -r --arg k "$key" '.[] | select(.pluginKey == $k) | .id' "$f" 2>/dev/null | head -n1)"
    if [[ -z "$id" ]]; then _log_line "plugins: $key was ready, now missing"; n=$((n + 1)); continue; fi
    code="$(api GET "/api/plugins/$id/health" "$hf")"
    ok="$(jq -r '.healthy // false' "$hf" 2>/dev/null)"
    [[ "$code" == 200 && "$ok" == true ]] || { _log_line "plugins: $key was ready, now unhealthy (HTTP $code)"; n=$((n + 1)); }
  done < "$(st plugins-baseline)"
  base_tools="$(kv "$(st plugins-baseline)" tools)"
  code="$(api GET /api/plugins/tools "$f")"
  case "$code" in 200) now_tools="$(jq -r 'length' "$f" 2>/dev/null)" ;; 501) now_tools=n/a ;; *) now_tools=error ;; esac
  if [[ "$base_tools" =~ ^[0-9]+$ ]]; then
    [[ "$now_tools" =~ ^[0-9]+$ ]] && ((now_tools >= base_tools)) \
      || { _log_line "plugins: tool count $base_tools -> $now_tools"; n=$((n + 1)); }
  fi
  echo "$n"
}
inventory_violations() { # BASE NOW -- decreases, missing metrics, role/guard changes
  awk -F'|' 'NR == FNR { b[$1] = $2; next } { n[$1] = $2 }
    END {
      v = 0
      for (k in b) {
        if (k == "heartbeat_runs" || k == "agent_wakeup_requests") continue
        if (!(k in n)) { print "inventory: " k " missing"; v++; continue }
        if (k ~ /^(roles_|ops_guard_|event_triggers|current_user_is_superuser)/) {
          if (n[k] != b[k]) { print "inventory: " k " changed " b[k] " -> " n[k]; v++ }
          continue
        }
        if (n[k] + 0 < b[k] + 0) { print "inventory: " k " decreased " b[k] " -> " n[k]; v++ }
      }
      print "violations|" v
    }' "$1" "$2"
}
inventory_in_range() { # PRE POST RESTORED -- restored dump lies between the two reads
  awk -F'|' 'FILENAME == ARGV[1] { a[$1] = $2; next } FILENAME == ARGV[2] { b[$1] = $2; next } { r[$1] = $2 }
    END {
      v = 0
      for (k in b) {
        lo = a[k] + 0; hi = b[k] + 0; if (lo > hi) { t = lo; lo = hi; hi = t }
        if (!(k in r) || !(k in a)) { print "restore: " k " missing"; v++; continue }
        if (r[k] + 0 < lo || r[k] + 0 > hi) { print "restore: " k " = " r[k] " outside [" lo ", " hi "]"; v++ }
      }
      print "violations|" v
    }' "$1" "$2" "$3"
}
ack_ok() { (($1 == 0 || $1 == $2)); }

# --- migration gate -------------------------------------------------------------
mig_gate() { # MODE(upgrade|rollback) IMAGE_ID [DB] -- ledger vs the image's own files
  local mode="$1" iid="$2" db="${3:-}" h="$TMPD/hashes-$1" l="$TMPD/ledger-$1"
  local -a args
  image_mig_hashes "$iid" "$h" || { log "FAIL: cannot read migration files from image $iid"; return 1; }
  ledger_to "$l" "$db" || { log "FAIL: cannot read the migration ledger"; return 1; }
  args=(--sql-hashes "$h" --ledger "$l" --max-unknown 0)
  if [[ "$mode" == upgrade ]]; then
    for t in "${REQUIRE[@]}"; do args+=(--require "$t"); done
  else
    have hashes-ahead || { log "FAIL: no record of the upgraded image's migrations (hashes-ahead)"; return 1; }
    args+=(--known-ahead "$(st hashes-ahead)")
  fi
  python3 "$HELPERS_DIR/migration_gate.py" "${args[@]}" | tee -a "$LOG"
  return "${PIPESTATUS[0]}"
}

# --- full verification of a held server -----------------------------------------
ebc_args() { # MODE(upgrade|rollback) -- sets EBC_ARGS (no target flag)
  # Reads the EXPECTATIONS PINNED BY cmd_restart (eb-marker/eb-sha/eb-pkg/eb-file),
  # not the current CLI flags: a re-invoked verify with different flags
  # must judge against the policy the restart proved, not a drifted one.
  # The pinned hashes describe the UPGRADE candidate. On rollback the old
  # build cannot carry them, so rollback collects evidence only (files
  # present, overlay sane) without applying upgrade-pinned expectations.
  EBC_ARGS=()
  local marker=""; [[ -f "$(st eb-marker)" ]] && marker="$(get eb-marker)"
  if [[ "$1" == upgrade && "$marker" != off && -n "$marker" ]]; then
    EBC_ARGS+=(--require-marker "$marker")
  else
    EBC_ARGS+=(--no-marker-check)
  fi
  if [[ "$1" == upgrade ]]; then
    local h pp
    [[ -f "$(st eb-sha)" ]] && while IFS= read -r h; do
      [[ -n "$h" ]] && EBC_ARGS+=(--expect-sha256 "$h")
    done < "$(st eb-sha)"
    [[ -f "$(st eb-pkg)" ]] && while IFS= read -r pp; do
      [[ -n "$pp" ]] && EBC_ARGS+=(--expect-plugin-package "$pp")
    done < "$(st eb-pkg)"
    [[ -f "$(st eb-file)" ]] && while IFS= read -r pp; do
      [[ -n "$pp" ]] && EBC_ARGS+=(--expect-file "$pp")
    done < "$(st eb-file)"
    # Policy, not a flag: the upgraded server never runs the 916 override.
    EBC_ARGS+=(--forbid-916-redaction)
  fi
}

effbuild_gate() { # MODE -- effective-build proof on the RUNNING server container
  # The overlay check: a host bind-mount shadowing
  # packages/adapter-utils/server-utils.ts would pass every image-level proof
  # while the LIVE server runs stale code. This gate hashes the files inside
  # the RUNNING container (overlay-inclusive) and requires the EPIPE guard on
  # upgrade; on rollback the old build lacks the guard, so evidence is
  # collected without requiring the marker.
  local mode="$1"
  [[ -f "$EBC" && ! -L "$EBC" ]] || { log "FAIL: effective-build checker missing: $EBC"; return 1; }
  ebc_args "$mode"
  bash "$EBC" --container "$SERVER_CONTAINER" "${EBC_ARGS[@]}" > "$TMPD/effective-build-$mode.log" 2>&1
  local rc=$?
  cat "$TMPD/effective-build-$mode.log" >> "$LOG"
  if ((rc == 0)) && grep -q '^EFFECTIVE_BUILD PROVEN' "$TMPD/effective-build-$mode.log"; then
    log "ok: effective build PROVEN on the running server (see effective-build-$mode.log)"
    return 0
  fi
  log "FAIL: effective build UNPROVEN on the running server (rc=$rc; stale overlay?)"
  return 1
}

plugin_inventory_gate() { # approved handoff file + live drift, if configured
  # Inventory only, NOT a compatibility PASS: validates the handoff itself
  # (shape, count, selector, retired-disabled, no secret material) and diffs
  # the live plugin set against it. Reads the HANDOFF PINNED BY cmd_restart
  # (inventory-handoff.json), not --plugin-inventory: a re-invoked verify
  # judges against the policy the restart pinned. Unconfigured: skipped (the
  # drain-time plugin baseline in plugin_drift still guards).
  local handoff=""
  [[ -f "$(st inventory-handoff.json)" && ! -L "$(st inventory-handoff.json)" ]] && handoff="$(st inventory-handoff.json)"
  [[ -n "$handoff" ]] || { log "plugin inventory: no pinned handoff (--plugin-inventory at restart); skipped"; return 0; }
  [[ -f "$INVCHECK" && ! -L "$INVCHECK" ]] || { log "FAIL: plugin inventory checker missing: $INVCHECK"; return 1; }
  local pf="$TMPD/plugins-inv.json" tf="$TMPD/tools-inv.json" code
  local -a args=(--inventory "$handoff" --live-plugins "$pf")
  code="$(api GET /api/plugins "$pf")"
  [[ "$code" == 200 ]] || { log "FAIL: plugin inventory: GET /api/plugins HTTP $code"; return 1; }
  code="$(api GET /api/plugins/tools "$tf")"
  case "$code" in
    200) args+=(--live-tools "$tf") ;;
    501) log "plugin inventory: tools API 501 (not present); versions checked, tool count skipped" ;;
    *) log "FAIL: plugin inventory: GET /api/plugins/tools HTTP $code"; return 1 ;;
  esac
  python3 "$INVCHECK" "${args[@]}" | tee -a "$LOG"
  ((${PIPESTATUS[0]} == 0)) || { log "FAIL: plugin inventory gate failed"; return 1; }
  return 0
}

umask_gate() { # PID 1 umask on the RUNNING server container must be 0077
  # a Podman to Docker cutover can silently drop the container umask 0077
  # (it did, on 2026-09-26). This gate reads PID 1's Umask from
  # /proc/1/status inside the RUNNING container (overlay-inclusive, both
  # upgrade and rollback verify). A plain `docker exec ... umask` is NOT a
  # substitute: an exec'd shell is not a child of PID 1 and reports 0022
  # regardless. Any other value, an empty read, or an exec failure fails
  # verify so the server stays under the hold.
  local line
  line="$("$DOCKER" exec -u node "$SERVER_CONTAINER" grep '^Umask:' /proc/1/status 2>/dev/null)" \
    || { log "FAIL: container umask unreadable (docker exec of PID 1 status failed)"; return 1; }
  # NOTE: $'...' quoting — inside [[ == "..." ]] a \t stays a literal
  # backslash-t, while /proc/1/status separates the value with a real TAB.
  [[ "$line" == $'Umask:\t0077' ]] \
    && { log "ok: container PID 1 umask 0077"; return 0; }
  log "FAIL: container PID 1 umask is '${line#$'Umask:\t'}' (want 0077; stale entrypoint?)"
  return 1
}

verify_held() { # MODE(upgrade|rollback) IMAGE_REF IMAGE_ID [DB]
  local mode="$1" ref="$2" iid="$3" rc=0 n
  health; [[ "$H_STATUS" == ok ]] || { log "FAIL: health is '$H_STATUS'"; rc=1; }
  if [[ "$mode" == upgrade && -n "$EXPECT_COMMIT" ]]; then
    [[ "$H_COMMIT" == "$EXPECT_COMMIT"* ]] && log "ok: commit $H_COMMIT" || { log "FAIL: health commit '$H_COMMIT' does not start with $EXPECT_COMMIT"; rc=1; }
  fi
  ident || fail "server container not found"
  [[ "$C_IMAGE" == "$iid" ]] && log "ok: running image $iid ($ref)" || { log "FAIL: running image $C_IMAGE, expected $iid"; rc=1; }
  umask_gate || rc=1
  has_hold && log "ok: scheduling hold present" || { log "FAIL: the server is not under the scheduling hold"; rc=1; }
  mig_gate "$mode" "$iid" || rc=1
  effbuild_gate "$mode" || rc=1

  n="$(plugin_drift)"
  ack_ok "$n" "$ACK_PLUGIN" && log "ok: plugin drift $n (ack $ACK_PLUGIN)" || { log "FAIL: plugin drift $n (ack $ACK_PLUGIN); see $LOG"; rc=1; }
  plugin_inventory_gate || rc=1

  if qf config.sql > "$TMPD/config-verify" && [[ -s "$TMPD/config-verify" ]]; then
    n="$(comm -23 <(sort "$(st config-backup)") <(sort "$TMPD/config-verify") | wc -l)"
    ack_ok "$n" "$ACK_CONFIG" && log "ok: config drift $n (ack $ACK_CONFIG)" || { log "FAIL: config drift $n line(s) changed or disappeared (ack $ACK_CONFIG)"; rc=1; }
  else log "FAIL: config fingerprint unreadable"; rc=1; fi

  if kv_file "$TMPD/inventory-verify" inventory.sql; then
    inventory_violations "$(st inventory-backup)" "$TMPD/inventory-verify" > "$TMPD/inventory-diff"
    grep -v '^violations|' "$TMPD/inventory-diff" >> "$LOG"
    n="$(kv "$TMPD/inventory-diff" violations)"
    ack_ok "$n" "$ACK_INVENTORY" && log "ok: inventory violations $n (ack $ACK_INVENTORY)" || { log "FAIL: inventory violations $n (ack $ACK_INVENTORY); see $LOG"; rc=1; }
  else log "FAIL: inventory unreadable"; rc=1; fi

  if "$REHARDEN" >> "$LOG" 2>&1; then log "ok: reharden"; else log "FAIL: reharden (see $LOG)"; rc=1; fi
  if inflight_check; then log "ok: nothing executing"; else log "FAIL: work is executing under the hold: $INFLIGHT_SUMMARY"; rc=1; fi
  return "$rc"
}

drain_still_on() { # same server, same drain, API agrees
  same_server
  drain_get || fail "$D_ERR"
  [[ "$D_DRAINING" == true && "$D_STARTED" == "$(get drain-started)" ]] \
    || fail "drain LOST: the server reports draining=$D_DRAINING startedAt=$D_STARTED (ours $(get drain-started))"
}

# ===========================================================================
cmd_status() {
  local tmp
  if [[ -n "$STATE_DIR" && -d "$STATE_DIR" ]]; then
    open_state 0
    local m; for m in drain_requested_at drained_at backup_at restart_started_at restarted_at verified_at undrained_at rolledback_at; do
      have "$m" && log "state: $m $(get "$m")"
    done
  else
    tmp="$(mktemp -d)"; TMPD="$tmp"; trap 'rm -rf -- "$tmp"' EXIT
  fi
  check_auth_file
  if drain_get; then log "task drain: draining=$D_DRAINING startedAt=$D_STARTED expiresAt=$D_EXPIRES activeRuns=$D_RUNS pendingWakes=$D_WAKES"
  else log "task drain: unreadable ($D_ERR)"; fi
  if inflight_check; then log "inflight: quiescent -- $INFLIGHT_SUMMARY"; else log "inflight: EXECUTING -- $INFLIGHT_SUMMARY"; fi
}

cmd_drain() {
  check_auth_file
  open_state 1
  log "drain: state $STATE_DIR"
  ident || refuse "server container $SERVER_CONTAINER not found"
  [[ "$C_STATE" == running ]] || refuse "server container is $C_STATE"
  health; [[ "$H_STATUS" == ok ]] || refuse "server health is '$H_STATUS'"
  drain_get || refuse "$D_ERR"
  [[ "$D_DRAINING" == false ]] || refuse "a task drain is already active (startedAt $D_STARTED); never stack drains"

  mark server-ident "$(ident_key)"
  mark server-image "$C_IMAGE"
  "$DOCKER" exec "$DB_CONTAINER" sh -c 'printf %s "$POSTGRES_DB"' > "$TMPD/dbname" 2>/dev/null || refuse "cannot read POSTGRES_DB"
  grep -Eqx '[a-z_][a-z0-9_]*' "$TMPD/dbname" || refuse "POSTGRES_DB is not a plain identifier"
  mark dbname "$(cat "$TMPD/dbname")"
  sha256sum < "$COMPOSE_FILE" | cut -d' ' -f1 > "$(st compose.sha256)" || refuse "cannot read $COMPOSE_FILE"
  kv_file "$(st inventory-predrain)" inventory.sql || refuse "inventory query failed"
  ledger_to "$(st ledger-predrain)" || refuse "cannot read the migration ledger"
  qf config.sql > "$(st config-predrain)" && [[ -s "$(st config-predrain)" ]] || refuse "config fingerprint failed"
  plugins_to "$(st plugins-baseline)" || refuse "cannot record the plugin baseline (GET /api/plugins)"
  if [[ -e "$FOCUS_ACTIVE" ]]; then mark focus "active $(sha_of "$FOCUS_ACTIVE")"; else mark focus "inactive"; fi

  mark drain_requested_at "$(dbnow)"
  waker_close

  local f="$TMPD/drain-post.json" code
  code="$(api POST /api/instance/task-drain "$f" '{}')"
  [[ "$code" =~ ^2[0-9][0-9]$ ]] || fail "POST task-drain HTTP $code: admission NOT closed; run 'abort' to restore the idle waker"
  drain_get || fail "$D_ERR; run 'status' then 'abort'"
  [[ "$D_DRAINING" == true && "$D_EXPIRES" == - && "$D_STARTED" =~ $TS_RE ]] \
    || fail "the drain did not take (draining=$D_DRAINING expiresAt=$D_EXPIRES); run 'abort'"
  [[ "$(jq -r '.startedAt // "-"' "$f" 2>/dev/null)" == "$D_STARTED" ]] \
    || fail "another drain raced ours (POST and GET startedAt differ); run 'abort'"
  mark drain-started "$D_STARTED"

  local marker
  marker="$(qf drain-marker.sql -v sa="$D_STARTED" -v req="$(get drain_requested_at)")" || fail "drain-marker query failed; run 'abort'"
  [[ "$marker" =~ ^([0-9]+)\|([0-9]+)$ && "${BASH_REMATCH[1]}" == "${BASH_REMATCH[2]}" && "${BASH_REMATCH[1]}" -gt 0 ]] \
    || fail "drain marker $marker: the API we drained is not writing to the database we read ($DB_CONTAINER); run 'abort'"
  ident; [[ "$(ident_key)" == "$(get server-ident)" ]] || fail "drain LOST: the server restarted during the drain; run 'abort'"
  log "drain: admission closed for all ${BASH_REMATCH[2]} companies at $D_STARTED (no expiry). Next: wait"
}

cmd_wait() {
  check_auth_file
  open_state 0
  need drain-started server-ident
  none drained_at undrained_at
  local start clean=0 polls=0 leak sa; start="$(date +%s)"; sa="$(get drain-started)"
  while :; do
    polls=$((polls + 1))
    drain_still_on
    local ok=1
    ((D_RUNS == 0 && D_WAKES == 0)) || ok=0
    inflight_check || ok=0
    kv_file "$TMPD/leak" leak.sql -v sa="$sa" || fail "leak query failed; NOT drained (admission stays CLOSED)"
    leak=$(( $(kv "$TMPD/leak" leak_runs) + $(kv "$TMPD/leak" leak_wakes) ))
    if ! ack_ok "$leak" "$ACK_LEAK"; then
      fail "admission LEAK: $leak run/wake row(s) admitted after $sa ($(tr '\n' ' ' < "$TMPD/leak")). Admission stays CLOSED, nothing cancelled. Investigate, then rerun wait with --ack-leak $leak"
    fi
    if ((ok)); then clean=$((clean + 1)); else clean=0; fi
    _log_line "poll $polls: api runs=$D_RUNS wakes=$D_WAKES clean=$clean/$STABLE_POLLS leak=$leak $INFLIGHT_SUMMARY"
    if ((clean >= STABLE_POLLS)); then
      mark drained_at "$(dbnow)"
      log "wait: DRAINED after $polls poll(s) at $(get drained_at). Next: backup"
      return 0
    fi
    if (( $(date +%s) - start >= MAX_WAIT_SECS )); then
      fail "NOT DRAINED after ${MAX_WAIT_SECS}s: $INFLIGHT_SUMMARY api runs=$D_RUNS wakes=$D_WAKES. Admission stays CLOSED, nothing was cancelled. Rerun wait, or abort"
    fi
    sleep "$POLL_SECS"
  done
}

cmd_backup() {
  check_auth_file
  open_state 0
  need drained_at
  none restart_started_at undrained_at
  [[ -s "$(st backup/SHA256SUMS)" ]] && refuse "a verified backup already exists in $(st backup)"
  drain_still_on
  inflight_check || fail "work is executing again: $INFLIGHT_SUMMARY"
  local size avail
  size="$(psql_q ro "" <<'SQL'
-- q:dbsize
SELECT pg_database_size(current_database());
SQL
)" || fail "cannot read the database size"
  [[ "$size" =~ ^[0-9]+$ ]] || fail "unexpected database size"
  mkdir -p -m 0700 -- "$(st backup)" || fail "cannot create the backup dir"
  avail="$(df -PB1 --output=avail -- "$(st backup)" | tail -n1 | tr -dc 0-9)"
  (( avail >= size + 1073741824 )) || fail "not enough disk for the backup: $avail bytes free, need $size + 1GiB"

  kv_file "$(st inventory-backup-pre)" inventory.sql || fail "inventory (pre) failed"
  mark backup_at "$(dbnow)"
  local dump; dump="$(st backup/paperclip.dump)"
  rm -f -- "$dump.partial"
  "$DOCKER" exec -e "PGOPTIONS=-c default_transaction_read_only=on" "$DB_CONTAINER" sh -c \
    'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$dump.partial" 2>>"$LOG" \
    || fail "pg_dump failed (see $LOG); no backup recorded"
  [[ -s "$dump.partial" ]] || fail "pg_dump produced an empty file"
  "$DOCKER" exec -i "$DB_CONTAINER" pg_restore -l < "$dump.partial" > "$TMPD/toc" 2>>"$LOG" || fail "pg_restore -l cannot read the dump"
  local want; for want in 'TABLE DATA public issues ' 'TABLE DATA public agents ' 'TABLE DATA drizzle __drizzle_migrations '; do
    grep -qF -- "$want" "$TMPD/toc" || fail "dump TOC lacks '$want'; backup NOT usable"
  done
  mv -f -- "$dump.partial" "$dump"
  kv_file "$(st inventory-backup)" inventory.sql || fail "inventory (post) failed"
  ledger_to "$(st ledger-backup)" || fail "cannot read the migration ledger"
  qf config.sql > "$(st config-backup)" && [[ -s "$(st config-backup)" ]] || fail "config fingerprint failed"
  (cd "$(st backup)" && sha256sum paperclip.dump > SHA256SUMS.tmp && mv -f SHA256SUMS.tmp SHA256SUMS) || fail "cannot checksum the dump"
  log "backup: $(st backup/paperclip.dump) ($(stat -c %s -- "$dump") bytes), TOC checked, SHA256SUMS written. Next: restart"
}

preserve_tmp() { # the recreate discards the container's /tmp: keep a copy, minus secrets
  local dest="$PRESERVE_ROOT/tmp-$1" rc
  mkdir -p -m 0700 -- "$PRESERVE_ROOT" && mkdir -m 0700 -- "$dest" || fail "cannot create $dest"
  "$DOCKER" cp "$SERVER_CONTAINER:/tmp" - 2>>"$LOG" | tar -C "$dest" -xf - --strip-components=1 \
    --no-same-owner --exclude='*token*' --exclude='*secret*' --exclude='*credential*' \
    --exclude='*.pem' --exclude='*.key' --exclude='*.curl' --exclude='.env' --exclude='*.env' \
    --exclude='*/.git/config' --exclude='*-wal' --exclude='*-shm' --exclude='*-journal' --exclude='*.sock' 2>>"$LOG"
  rc=("${PIPESTATUS[@]}")
  ((rc[0] == 0 && rc[1] == 0)) || fail "copying the server's /tmp failed (docker cp ${rc[0]}, tar ${rc[1]}); restart NOT started"
  (cd "$dest" && find . -type f -print0 | sort -z | xargs -0 -r sha256sum) > "$dest.SHA256SUMS" || fail "cannot checksum $dest"
  chmod -R go-rwx -- "$dest" 2>/dev/null
  mark preserved "$dest ($(wc -l < "$dest.SHA256SUMS") files)"
  log "restart: preserved the server /tmp to $dest ($(wc -l < "$dest.SHA256SUMS") files; secrets, sockets and SQLite WAL excluded)"
}

cmd_restart() {
  check_auth_file
  open_state 0
  need drained_at backup_at
  none restart_started_at undrained_at
  [[ -n "$IMAGE" ]] || refuse "--image is required"
  [[ "$EXPECT_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || refuse "--expect-image-id sha256:<64 hex> is required"
  (cd "$(st backup)" && sha256sum -c --quiet SHA256SUMS) >/dev/null 2>&1 || fail "the backup does not verify against SHA256SUMS"
  drain_still_on
  inflight_check || fail "work is executing: $INFLIGHT_SUMMARY"
  [[ "$(image_id "$IMAGE")" == "$EXPECT_IMAGE_ID" ]] || fail "image $IMAGE is not $EXPECT_IMAGE_ID locally (pull/load it first; this script never pulls)"
  compose_check "$IMAGE"
  compose_no_legacy_overlay
  local -a pre=(--state-dir "$STATE_DIR" --backup-dir "$(st backup)" --max-backup-age-mins "$MAX_BACKUP_AGE_MINS" --ack-orphans "$ACK_ORPHANS")
  for t in "${REQUIRE[@]}"; do pre+=(--require "$t"); done
  "$PRECHECK" "${pre[@]}" 2>&1 | tee -a "$LOG"
  ((PIPESTATUS[0] == 0)) || fail "pre-restart-check failed; restart NOT started"
  mark hashes-ahead-src "$EXPECT_IMAGE_ID"
  image_mig_hashes "$EXPECT_IMAGE_ID" "$(st hashes-ahead)" || fail "cannot read the target image's migrations"

  # Pin the effective-build expectations to the state dir (verify reads these
  # back, so the flags passed to a later `verify` cannot drift from what the
  # restart proved) and prove the EXACT target image BEFORE the server is
  # touched. A candidate that is not the patched build fails here with the
  # old server still running, not after it has been replaced.
  if ((BUILD_MARKER_OFF)); then mark eb-marker "off"; else mark eb-marker "${BUILD_MARKER:-EPIPE}"; fi
  : > "$(st eb-sha.tmp)"; : > "$(st eb-pkg.tmp)"; : > "$(st eb-file.tmp)"
  local eh epp
  for eh in ${BUILD_SHA[@]+"${BUILD_SHA[@]}"}; do printf '%s\n' "$eh" >> "$(st eb-sha.tmp)"; done
  for epp in ${PLUGIN_PKGS[@]+"${PLUGIN_PKGS[@]}"}; do printf '%s\n' "$epp" >> "$(st eb-pkg.tmp)"; done
  for epp in ${EXPECT_FILES[@]+"${EXPECT_FILES[@]}"}; do printf '%s\n' "$epp" >> "$(st eb-file.tmp)"; done
  mv -f -- "$(st eb-sha.tmp)" "$(st eb-sha)"; mv -f -- "$(st eb-pkg.tmp)" "$(st eb-pkg)"
  mv -f -- "$(st eb-file.tmp)" "$(st eb-file)"
  if [[ -n "$PLUGIN_INVENTORY" ]]; then
    cp -- "$PLUGIN_INVENTORY" "$(st inventory-handoff.json)" || fail "cannot pin the plugin inventory to the state dir"
    mark eb-inventory "handoff"
  else
    mark eb-inventory "none"
  fi
  [[ -f "$EBC" && ! -L "$EBC" ]] || fail "effective-build checker missing: $EBC"
  ebc_args upgrade
  bash "$EBC" --image "$EXPECT_IMAGE_ID" "${EBC_ARGS[@]}" > "$(st effective-build-image.log)" 2>&1
  local ebrc=$?
  cat "$(st effective-build-image.log)" >> "$LOG"
  ((ebrc == 0)) && grep -q '^EFFECTIVE_BUILD PROVEN' "$(st effective-build-image.log)" \
    || fail "pre-boot effective-build proof FAILED for $EXPECT_IMAGE_ID (see effective-build-image.log); restart NOT started"
  log "pre-boot effective-build: PROVEN on $EXPECT_IMAGE_ID (see effective-build-image.log)"

  local ts old; ts="$(date -u +%Y%m%dT%H%M%SZ)"; old="$C_ID"
  preserve_tmp "$ts"
  write_hold
  compose_check "$IMAGE" "$(st hold.override.yaml)"
  compose_no_legacy_overlay "$(st hold.override.yaml)"
  mark restart_started_at "$(dbnow)"
  log "restart: recreating $SERVER_SERVICE on $IMAGE under the scheduling hold (migrations auto-apply on boot)"
  compose_up "$(st hold.override.yaml)" || fail "docker compose up failed (see $LOG); the server may be down. Next: rollback"
  wait_healthy "$old"
  [[ "$C_IMAGE" == "$EXPECT_IMAGE_ID" ]] || fail "the new server runs $C_IMAGE, not $EXPECT_IMAGE_ID. Next: rollback"
  has_hold || fail "the new server came up WITHOUT the scheduling hold. Next: rollback"
  mark restarted_at "$(dbnow)"
  mark restart-image "$IMAGE $EXPECT_IMAGE_ID"
  log "restart: healthy on $EXPECT_IMAGE_ID under the hold. Next: verify"
}

cmd_verify() {
  check_auth_file
  open_state 0
  need restarted_at restart-image
  none verified_at undrained_at
  local ref iid; read -r ref iid < "$(st restart-image)"
  if verify_held upgrade "$ref" "$iid"; then
    mark verified_image "$ref $iid"
    mark verified_at "$(dbnow)"
    log "verify: PASSED on $iid. Next: undrain"
  else
    fail "verify FAILED; the server stays under the hold (no work admitted). Fix and rerun verify, or rollback"
  fi
}

do_rewake() {
  need drain_requested_at undrained_at
  local list="$TMPD/rewake.list" ledger; ledger="$(st rewake.ledger)"
  qf rewake.sql -v since="$(get drain_requested_at)" -v until="$(get undrained_at)" > "$list" \
    || { warn "rewake query failed; rerun 'rewake'"; return; }
  if grep -Evq "^(wake\|$UUID_RE\|$UUID_RE\|$UUID_RE\|($UUID_RE|-)|(unattributable|ineligible)\|[0-9]+)$" "$list"; then
    warn "rewake list has malformed rows; nothing re-woken"; return
  fi
  log "rewake: owed $(grep -c '^wake|' "$list"), unattributable $(kv "$list" unattributable), ineligible $(kv "$list" ineligible) (blocked/reassigned/paused cards are never unparked)"
  local gated=0
  if [[ -e "$FOCUS_ACTIVE" && "$FOCUS_EXPIRED" != 1 ]]; then
    if [[ -z "$REWAKE_FILTER" ]]; then
      grep '^wake|' "$list" > "$(st rewake.deferred.txt)"
      warn "focus gate active ($FOCUS_ACTIVE): $(wc -l < "$(st rewake.deferred.txt)") owed wake(s) deferred to rewake.deferred.txt. Rerun 'rewake' with --rewake-filter FILE or --focus-gate-expired"
      return
    fi
    gated=1
  fi
  local -A allow=()
  if [[ -n "$REWAKE_FILTER" ]]; then
    [[ -f "$REWAKE_FILTER" ]] || refuse "--rewake-filter file missing: $REWAKE_FILTER"
    local id; while read -r id _; do
      [[ -z "$id" || "$id" == \#* ]] && continue
      [[ "${id,,}" =~ ^$UUID_RE$ ]] || refuse "--rewake-filter has a non-UUID line"
      allow["${id,,}"]=1
    done < "$REWAKE_FILTER"
    gated=1
  fi
  touch "$ledger"
  : > "$(st rewake.deferred.txt.tmp)"
  local tag wid agent issue cid sent=0 skipped=0 failed=0 deferred=0 code body f="$TMPD/wake.json"
  while IFS='|' read -r tag wid agent issue cid; do
    [[ "$tag" == wake ]] || continue
    if grep -q "^$wid 2[0-9][0-9]$" "$ledger"; then skipped=$((skipped + 1)); continue; fi
    if ((gated)) && [[ -z "${allow[$issue]:-}" ]]; then
      printf '%s\n' "wake|$wid|$agent|$issue|$cid" >> "$(st rewake.deferred.txt.tmp)"; deferred=$((deferred + 1)); continue
    fi
    body="$(jq -nc --arg i "$issue" --arg w "$wid" --arg c "$cid" '{
      source: "automation", triggerDetail: "system", reason: "upgrade_drain_rewake",
      idempotencyKey: ("paperclip-upgrade-rewake:" + $w),
      payload: ({issueId: $i, taskId: $i, rewakeOf: $w} + (if $c == "-" then {} else {commentId: $c} end))}')"
    code="$(api POST "/api/agents/$agent/wakeup" "$f" "$body")"
    case "$code" in
      2??) printf '%s %s\n' "$wid" "$code" >> "$ledger"; sent=$((sent + 1)) ;;
      4??) printf '%s %s\n' "$wid" "$code" >> "$ledger"; failed=$((failed + 1)); _log_line "rewake: $wid -> HTTP $code" ;;
      *) mv -f -- "$(st rewake.deferred.txt.tmp)" "$(st rewake.deferred.txt)"
         warn "rewake stopped on HTTP $code after $sent sent; rerun 'rewake' (already-sent wakes are skipped)"; return ;;
    esac
    if (( (sent + failed) % REWAKE_BATCH == 0 )); then sleep "$REWAKE_DELAY_SECS"; fi
  done < "$list"
  mv -f -- "$(st rewake.deferred.txt.tmp)" "$(st rewake.deferred.txt)"
  log "rewake: sent $sent, already sent $skipped, refused $failed, deferred by the focus filter $deferred"
  ((failed == 0 && deferred == 0)) || warn "rewake incomplete: $failed refused (see $LOG), $deferred deferred (rewake.deferred.txt)"
}

cmd_undrain() {
  check_auth_file
  open_state 0
  need verified_at verified_image
  none undrained_at
  local ref iid; read -r ref iid < "$(st verified_image)"
  [[ "$(image_id "$ref")" == "$iid" ]] || fail "$ref no longer resolves to the verified image $iid"
  ident || fail "server container not found"
  [[ "$C_IMAGE" == "$iid" ]] || fail "the running server ($C_IMAGE) is not the verified image $iid"
  has_hold || fail "the server is no longer under the hold; something recreated it after verify. Rerun verify from a new state dir"
  compose_check "$ref"
  have rolledback_at || compose_no_legacy_overlay
  inflight_check || fail "work is executing under the hold: $INFLIGHT_SUMMARY"
  local old="$C_ID"
  log "undrain: recreating $SERVER_SERVICE from $COMPOSE_FILE alone (admission opens)"
  compose_up || fail "docker compose up failed (see $LOG)"
  wait_healthy "$old"
  [[ "$C_IMAGE" == "$iid" ]] || fail "the server came up on $C_IMAGE, not $iid"
  has_hold && fail "the scheduling hold is still present after undrain"
  drain_get || fail "$D_ERR"
  [[ "$D_DRAINING" == false ]] || fail "the server still reports a task drain"
  waker_restore
  mark undrained_at "$(dbnow)"
  log "undrain: admission open at $(get undrained_at)"
  do_rewake
  ((PARTIAL == 0)) || partial "undrained, with warnings above"
  log "undrain: done"
}

cmd_rewake() {
  check_auth_file
  open_state 0
  do_rewake
  ((PARTIAL == 0)) || exit 3
}

cmd_abort() {
  check_auth_file
  open_state 0
  need drain_requested_at
  none restart_started_at undrained_at
  ident || fail "server container not found"
  if [[ "$(ident_key)" != "$(get server-ident 2>/dev/null)" ]]; then
    warn "the server restarted since the drain; its in-memory drain is already gone (nothing to lift)"
  else
    drain_get || fail "$D_ERR"
    if [[ "$D_DRAINING" == true ]] && have drain-started && [[ "$D_STARTED" == "$(get drain-started)" ]]; then
      local f="$TMPD/drain-delete.json" code
      code="$(api DELETE /api/instance/task-drain "$f")"
      [[ "$code" =~ ^2[0-9][0-9]$ ]] || fail "DELETE task-drain HTTP $code; admission is still CLOSED"
      drain_get || fail "$D_ERR"
      [[ "$D_DRAINING" == false ]] || fail "the drain is still active after DELETE"
      log "abort: task drain lifted"
    elif [[ "$D_DRAINING" == true ]]; then
      warn "a DIFFERENT drain is active (startedAt $D_STARTED); left in place"
    else
      log "abort: no drain active"
    fi
  fi
  waker_restore
  mark undrained_at "$(dbnow)"
  do_rewake
  ((PARTIAL == 0)) || partial "aborted, with warnings above"
  log "abort: done"
}

restore_db() { # the rollback restore: new database, verified, then a name swap
  local db pre newdb predb ts
  db="$(get dbname)"; ts="$(date -u +%Y%m%d%H%M%S)"
  newdb="paperclip_restore_$ts"; predb="paperclip_pre_rollback_$ts"
  [[ "$db" =~ ^[a-z_][a-z0-9_]*$ ]] || fail "recorded database name is not a plain identifier"
  (cd "$(st backup)" && sha256sum -c --quiet SHA256SUMS) >/dev/null 2>&1 || fail "the backup does not verify against SHA256SUMS"
  kv_file "$TMPD/fence" fence.sql -v since="$(get backup_at)" || fail "fence query failed"
  local fence; fence="$(awk -F'|' '{ s += $2 } END { print s + 0 }' "$TMPD/fence")"
  tr '\n' ' ' < "$TMPD/fence" | _log_line "fence: $(cat)"
  ack_ok "$fence" "$ACK_FENCE" || fail "write fence: $fence row(s) written since the backup ($(tr '\n' ' ' < "$TMPD/fence")). Restoring would destroy them; refused (exact --ack-fence only after review)"
  psql_q ro "" > "$TMPD/dbprops-old" <<'SQL' || fail "cannot read database properties"
-- q:dbprops
SELECT d.datlocprovider || '|' || pg_encoding_to_char(d.encoding) || '|' || d.datcollate || '|' || d.datctype || '|'
       || pg_get_userbyid(d.datdba) || '|' || coalesce(d.datacl::text, '-') || '|'
       || (SELECT count(*) FROM pg_db_role_setting s WHERE s.setdatabase = d.oid)
  FROM pg_database d WHERE d.datname = current_database();
SQL
  IFS='|' read -r prov _ _ _ _ _ nset < "$TMPD/dbprops-old"
  [[ "$prov" == c ]] || fail "database uses locale provider '$prov'; restore-db only reproduces libc locales. Restore by hand"
  [[ "$nset" == 0 ]] || fail "database has $nset ALTER DATABASE ... SET entries; restore-db cannot reproduce them exactly. Restore by hand"
  local size avail
  size="$(psql_q ro "" <<<'-- q:dbsize
SELECT pg_database_size(current_database());')" || fail "cannot read the database size"
  avail="$("$DOCKER" exec "$DB_CONTAINER" sh -c 'df -PB1 "$PGDATA" | tail -n1' 2>/dev/null | awk '{ print $4 }')"
  [[ "$size" =~ ^[0-9]+$ && "$avail" =~ ^[0-9]+$ ]] && (( avail >= size * 2 + 1073741824 )) \
    || fail "not enough database disk for a side-by-side restore ($avail free, database $size)"

  log "rollback: stopping $SERVER_SERVICE for the database restore"
  "$DOCKER" compose -f "$COMPOSE_FILE" stop "$SERVER_SERVICE" >> "$LOG" 2>&1 || fail "cannot stop the server"
  mark server_stopped_at "$(now)"
  local others
  others="$(psql_q ro postgres -v db="$db" <<'SQL'
-- q:sessions
SELECT count(*) FROM pg_stat_activity WHERE datname = :'db' AND pid <> pg_backend_pid();
SQL
)" || partial "server stopped; cannot count database sessions. Database untouched"
  [[ "$others" == 0 ]] || partial "server stopped but $others other session(s) still use $db; database untouched. Close them, then rerun rollback --restore-db"

  psql_q rw postgres -v old="$db" -v new="$newdb" >> "$LOG" 2>&1 <<'SQL' || fail "CREATE DATABASE failed; the current database is untouched (server stopped)"
-- q:restore_create
SELECT format('CREATE DATABASE %I TEMPLATE template0 ENCODING %L LC_COLLATE %L LC_CTYPE %L OWNER %I',
              :'new', pg_encoding_to_char(encoding), datcollate, datctype, pg_get_userbyid(datdba))
  FROM pg_database WHERE datname = :'old' AND datlocprovider = 'c' \gexec
SQL
  psql_q rw postgres -v old="$db" -v new="$newdb" >> "$LOG" 2>&1 <<'SQL' || fail "copying database grants failed; $newdb left in place, current database untouched"
-- q:restore_acl
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'new')
  FROM pg_database WHERE datname = :'old' AND datacl IS NOT NULL \gexec
SELECT format('GRANT %s ON DATABASE %I TO %s%s', a.privilege_type, :'new',
              CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END,
              CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
  FROM pg_database d, aclexplode(d.datacl) a
 WHERE d.datname = :'old' AND a.grantee <> d.datdba \gexec
SQL
  psql_q ro "$newdb" > "$TMPD/dbprops-new" < <(sed -n '/^-- q:dbprops/,$p' <<'SQL'
-- q:dbprops
SELECT d.datlocprovider || '|' || pg_encoding_to_char(d.encoding) || '|' || d.datcollate || '|' || d.datctype || '|'
       || pg_get_userbyid(d.datdba) || '|' || coalesce(d.datacl::text, '-') || '|'
       || (SELECT count(*) FROM pg_db_role_setting s WHERE s.setdatabase = d.oid)
  FROM pg_database d WHERE d.datname = current_database();
SQL
) || fail "cannot read $newdb properties"
  cmp -s "$TMPD/dbprops-old" "$TMPD/dbprops-new" || fail "$newdb properties differ from $db (owner/ACL/locale); not swapped. Server stopped, current database untouched"

  "$DOCKER" exec -i -e "PCU_DB=$newdb" "$DB_CONTAINER" sh -c \
    'exec pg_restore -U "$POSTGRES_USER" -d "$PCU_DB" --exit-on-error --single-transaction' \
    < "$(st backup/paperclip.dump)" >> "$LOG" 2>&1 || fail "pg_restore into $newdb failed; not swapped. Server stopped, current database untouched"
  qf_db() { psql_q ro "$newdb" < "$HELPERS_DIR/inventory.sql"; }
  qf_db > "$TMPD/inventory-restored" || fail "cannot inventory $newdb"
  inventory_in_range "$(st inventory-backup-pre)" "$(st inventory-backup)" "$TMPD/inventory-restored" > "$TMPD/restore-diff"
  grep -v '^violations|' "$TMPD/restore-diff" >> "$LOG"
  [[ "$(kv "$TMPD/restore-diff" violations)" == 0 ]] || fail "$newdb does not match the backup inventory (see $LOG); not swapped. Server stopped"
  ledger_to "$TMPD/ledger-restored" "$newdb" || fail "cannot read the $newdb ledger"
  cmp -s <(sort "$(st ledger-backup)") <(sort "$TMPD/ledger-restored") || fail "$newdb ledger differs from ledger-backup; not swapped"

  psql_q rw postgres -v old="$db" -v new="$newdb" -v pre="$predb" >> "$LOG" 2>&1 <<'SQL' || fail "database swap failed (one transaction: nothing renamed). Server stopped"
-- q:restore_swap
BEGIN;
SELECT 1 / (CASE WHEN count(*) = 0 THEN 1 ELSE 0 END) FROM pg_stat_activity WHERE datname IN (:'old', :'new');
ALTER DATABASE :"old" RENAME TO :"pre";
ALTER DATABASE :"new" RENAME TO :"old";
COMMIT;
SQL
  mark restored_db "$db from $(st backup/paperclip.dump); previous database kept as $predb"
  log "rollback: restored $db from the backup; the previous database is kept as $predb (never dropped)"
}

cmd_rollback() {
  check_auth_file
  open_state 0
  need drained_at backup_at
  none undrained_at rolledback_at
  [[ -n "$IMAGE" ]] || refuse "--image (the image to roll back to) is required"
  [[ "$EXPECT_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || refuse "--expect-image-id sha256:<64 hex> is required"
  [[ "$(image_id "$IMAGE")" == "$EXPECT_IMAGE_ID" ]] || fail "image $IMAGE is not $EXPECT_IMAGE_ID locally"
  ident || fail "server container not found"
  if have restart_started_at; then
    # The upgrade restart ran from this dir: the server must still be held (or down).
    [[ "$C_STATE" != running ]] || has_hold || refuse "the server runs WITHOUT the hold: work may have resumed since the restart; a rollback here could lose new writes. Start from a fresh drained state dir (image-only)"
  else
    ((RESTORE_DB == 0)) || refuse "--restore-db needs the restart to have run from this state dir (otherwise the backup may predate admitted work)"
    drain_still_on
    inflight_check || fail "work is executing: $INFLIGHT_SUMMARY"
    image_mig_hashes "$C_IMAGE" "$(st hashes-ahead)" || fail "cannot read the running image's migrations"
    mark hashes-ahead-src "$C_IMAGE"
  fi
  have hashes-ahead || fail "no record of the upgraded image's migrations"
  compose_check "$IMAGE"
  write_hold
  compose_check "$IMAGE" "$(st hold.override.yaml)"

  if ((RESTORE_DB)); then
    restore_db
  else
    # Image-only: every older-image migration must already be applied (no DDL
    # on boot) and every newer ledger row must be the upgraded image's own.
    ledger_to "$TMPD/ledger-now" || fail "cannot read the migration ledger"
    local h="$TMPD/hashes-old"
    image_mig_hashes "$EXPECT_IMAGE_ID" "$h" || fail "cannot read $IMAGE migrations"
    python3 "$HELPERS_DIR/migration_gate.py" --sql-hashes "$h" --ledger "$TMPD/ledger-now" \
      --known-ahead "$(st hashes-ahead)" --max-unknown 0 | tee -a "$LOG"
    ((PIPESTATUS[0] == 0)) || fail "pre-boot migration gate failed for $IMAGE; NOT rolled back"
  fi

  mark rollback_started_at "$(dbnow)"
  ident || true
  local old="${C_ID:-none}"
  compose_up "$(st hold.override.yaml)" || fail "docker compose up failed (see $LOG)"
  wait_healthy "$old"
  [[ "$C_IMAGE" == "$EXPECT_IMAGE_ID" ]] || fail "rolled-back server runs $C_IMAGE, not $EXPECT_IMAGE_ID"
  has_hold || fail "rolled-back server is not under the hold"
  if ((RESTORE_DB)); then
    ledger_to "$TMPD/ledger-after" || fail "cannot read the ledger after boot"
    cmp -s <(sort "$(st ledger-backup)") <(sort "$TMPD/ledger-after") || fail "ledger after boot differs from ledger-backup"
  fi
  if verify_held rollback "$IMAGE" "$EXPECT_IMAGE_ID"; then
    mark verified_image "$IMAGE $EXPECT_IMAGE_ID"
    mark verified_at "$(dbnow)"
    mark rolledback_at "$(get verified_at)"
    log "rollback: verified on $EXPECT_IMAGE_ID under the hold. Next: undrain"
  else
    fail "rollback verify FAILED; the server stays under the hold"
  fi
}

case "$CMD" in
  status) cmd_status ;;
  drain) cmd_drain ;;
  wait) cmd_wait ;;
  backup) cmd_backup ;;
  restart) cmd_restart ;;
  verify) cmd_verify ;;
  undrain) cmd_undrain ;;
  rewake) cmd_rewake ;;
  abort) cmd_abort ;;
  rollback) cmd_rollback ;;
esac
exit 0
