# shellcheck shell=bash
# ===========================================================================
# pcsql — the one place this repo decides HOW to reach PostgreSQL.
# ---------------------------------------------------------------------------
# Sourced, never executed. Every tool here used to open-code
#
#     podman exec -i ... paperclip-db sh -c 'exec psql -U "$POSTGRES_USER" ...'
#
# which hard-wires the tools to one host with one container name. That is fine
# for the operator and fatal for CI: there is no way to point a suite at a
# throwaway database, so the two suites that assert the privilege-ceiling
# invariants cannot run anywhere except production.
#
# This adds a second backend and changes nothing else. The DEFAULT IS STILL
# PODMAN and the podman command it builds is byte-for-byte the one each tool
# built before, so an operator's existing invocation is unaffected — they need
# not know this file exists.
#
# BACKEND SELECTION IS EXPLICIT, NEVER SNIFFED.
#   PAPERCLIP_SQL_BACKEND=podman   (default) container exec into $PAPERCLIP_DB_CTR
#   PAPERCLIP_SQL_BACKEND=docker              same, via `docker exec` (for hosts without podman)
#   PAPERCLIP_SQL_BACKEND=psql               a plain psql on $PATH
#   anything else                            refused
#
# CONTAINER_ENGINE names the binary the container backends invoke, so a host
# whose daemon answers to the other name needs no per-tool edit:
#   CONTAINER_ENGINE=${CONTAINER_ENGINE:-$(command -v docker || command -v podman)}
# An explicit PAPERCLIP_SQL_BACKEND still selects the path; CONTAINER_ENGINE
# only chooses which binary runs it, defaulting to the backend's own name.
# A host without podman runs with PAPERCLIP_SQL_BACKEND=docker (or CONTAINER_ENGINE=docker).
#
# It would be friendlier to auto-select `psql` when DATABASE_URL happens to be
# set. It would also mean that an operator who has DATABASE_URL exported for
# some unrelated reason silently runs the provisioner against the wrong
# database, and the provisioner CREATES AND DELETES AGENTS. Guessing is not
# available here; the caller says which, or gets the historical default.
#
# NO CREDENTIAL ON argv, ON EITHER BACKEND.
# `/proc/*/cmdline` is world-readable and every company on the host shares
# it, so the repo's standing rule is that secrets move by inherited
# environment only. The container path already honoured that (values ride in as
# `-e PGV_*` and are expanded by the shell INSIDE the container). The psql path
# has to earn it: a connection URI carries a password, so DATABASE_URL is
# decomposed here into libpq's own environment variables and the URI itself is
# never handed to psql. The query variables (:company_id and friends) DO appear
# on the psql argv — they are UUIDs and role ids, not secrets — and the
# password never does.
# ===========================================================================

# --- argument-free helpers --------------------------------------------------

pcsql_backend() {
  local b="${PAPERCLIP_SQL_BACKEND:-podman}"
  case "$b" in
    podman|docker|psql) printf '%s' "$b" ;;
    *) echo "REFUSED: PAPERCLIP_SQL_BACKEND='$b' is not one of: podman, docker, psql" >&2; return 2 ;;
  esac
}

# The binary the selected backend will actually invoke. An explicit
# CONTAINER_ENGINE overrides the backend's own name, so a Docker-only host
# runs with CONTAINER_ENGINE=docker and no tool needs to know which host it
# is on. Unset means the backend's own name — still explicit, never sniffed.
pcsql_engine() {
  local b; b="$(pcsql_backend)" || return 2
  case "$b" in
    podman|docker) printf '%s' "${CONTAINER_ENGINE:-$b}" ;;
    psql) printf '%s' "psql" ;;
  esac
}

# The binary the selected backend needs, so callers can dependency-check the
# backend they will actually use instead of demanding podman unconditionally.
pcsql_required_bin() { pcsql_engine; }

# Percent-decoding for URI userinfo. `printf %b` is the cheap way to turn %XX
# into a byte, which means a literal backslash in the input would be read as an
# escape — so refuse one rather than mis-decode a password. Backslash is not a
# legal URI character, so nothing valid is being rejected.
pcsql__urldecode() {
  case "$1" in
    *\\*) echo "REFUSED: backslash in DATABASE_URL" >&2; return 2 ;;
  esac
  local s="$1"
  printf '%b' "${s//%/\\x}"
}

# DATABASE_URL -> exported PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE.
# Deliberately does NOT hand the URI to psql: that would put the password on
# the command line. Anything the caller has already exported wins, so
# PGPASSWORD from a secret store is not clobbered by a URL that omits one.
pcsql__env_from_url() {
  local url="$1" rest userinfo hostport user pass host port db query kv

  case "$url" in
    postgres://*|postgresql://*) : ;;
    *) echo "REFUSED: DATABASE_URL must start with postgres:// or postgresql://" >&2; return 2 ;;
  esac

  rest="${url#*://}"
  rest="${rest%%\#*}"           # drop fragment
  query=""
  case "$rest" in *\?*) query="${rest#*\?}"; rest="${rest%%\?*}" ;; esac

  # Query parameters are NOT dropped silently. `?sslmode=require` is the whole
  # difference between an encrypted connection and a plaintext one; quietly
  # discarding it would downgrade the connection while the URL still says it is
  # secure. Translate what libpq has an environment variable for, refuse the
  # rest — the caller can always export the PG* variable directly.
  local IFS='&'
  for kv in $query; do
    [[ -n "$kv" ]] || continue
    case "$kv" in
      sslmode=*)     export PGSSLMODE="${PGSSLMODE:-${kv#*=}}" ;;
      sslrootcert=*) export PGSSLROOTCERT="${PGSSLROOTCERT:-${kv#*=}}" ;;
      connect_timeout=*) export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-${kv#*=}}" ;;
      application_name=*) export PGAPPNAME="${PGAPPNAME:-${kv#*=}}" ;;
      *) echo "REFUSED: unsupported DATABASE_URL parameter '${kv%%=*}'; export the libpq PG* variable instead" >&2; return 2 ;;
    esac
  done
  unset IFS

  # userinfo@hostport/db  — split from the RIGHT of the LAST '@' so a password
  # containing an encoded '@' does not truncate the host.
  case "$rest" in
    */*) db="${rest#*/}"; hostport="${rest%%/*}" ;;
    *)   db="";           hostport="$rest" ;;
  esac
  case "$hostport" in
    *@*) userinfo="${hostport%@*}"; hostport="${hostport##*@}" ;;
    *)   userinfo="" ;;
  esac
  case "$userinfo" in
    *:*) user="${userinfo%%:*}"; pass="${userinfo#*:}" ;;
    *)   user="$userinfo";       pass="" ;;
  esac
  case "$hostport" in
    *:*) host="${hostport%:*}"; port="${hostport##*:}" ;;
    *)   host="$hostport";      port="" ;;
  esac

  [[ -n "$user" ]] && { user="$(pcsql__urldecode "$user")" || return 2; export PGUSER="${PGUSER:-$user}"; }
  [[ -n "$pass" ]] && { pass="$(pcsql__urldecode "$pass")" || return 2; export PGPASSWORD="${PGPASSWORD:-$pass}"; }
  [[ -n "$host" ]] && { host="$(pcsql__urldecode "$host")" || return 2; export PGHOST="${PGHOST:-$host}"; }
  [[ -n "$port" ]] && export PGPORT="${PGPORT:-$port}"
  [[ -n "$db"   ]] && { db="$(pcsql__urldecode "$db")"     || return 2; export PGDATABASE="${PGDATABASE:-$db}"; }
  return 0
}

# --- the call --------------------------------------------------------------

# pcsql_run [psql flags...]  <<< "SQL"
#
# SQL arrives on stdin. Query variables arrive as PGV_* in the environment and
# are bound to psql variables here, in one place, for every caller:
#
#   :company_id, :cid  <- PGV_COMPANY_ID      (two names; callers differ)
#   :agent_id          <- PGV_AGENT_ID
#   :text              <- PGV_TEXT
#   :grants            <- PGV_GRANTS  (default '[]')
#   :a, :b             <- PGV_A, PGV_B
#
# Every variable is bound on every call. psql does not object to a defined
# variable a query never mentions, and binding them unconditionally means a
# caller cannot get a silent empty string by forgetting to plumb one through.
pcsql_run() {
  local backend engine; backend="$(pcsql_backend)" || return 2

  if [[ "$backend" == "podman" || "$backend" == "docker" ]]; then
    engine="${CONTAINER_ENGINE:-$backend}"
    PGV_COMPANY_ID="${PGV_COMPANY_ID:-}" PGV_AGENT_ID="${PGV_AGENT_ID:-}" \
    PGV_TEXT="${PGV_TEXT:-}" PGV_GRANTS="${PGV_GRANTS:-[]}" \
    PGV_A="${PGV_A:-}" PGV_B="${PGV_B:-}" \
    "$engine" exec -i \
      -e PGV_COMPANY_ID -e PGV_AGENT_ID -e PGV_TEXT -e PGV_GRANTS -e PGV_A -e PGV_B \
      "${PAPERCLIP_DB_CTR:-paperclip-db}" sh -c '
        exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
          -v company_id="${PGV_COMPANY_ID:-}" -v cid="${PGV_COMPANY_ID:-}" \
          -v agent_id="${PGV_AGENT_ID:-}" -v text="${PGV_TEXT:-}" \
          -v grants="${PGV_GRANTS:-[]}" -v a="${PGV_A:-}" -v b="${PGV_B:-}" \
          "$@" -f -
      ' _ "$@"
    return $?
  fi

  # psql backend.
  if [[ -n "${DATABASE_URL:-}" ]]; then
    pcsql__env_from_url "$DATABASE_URL" || return 2
  elif [[ -z "${PGHOST:-}${PGDATABASE:-}" ]]; then
    echo "REFUSED: PAPERCLIP_SQL_BACKEND=psql needs DATABASE_URL or libpq PG* variables" >&2
    return 2
  fi

  psql \
    -v company_id="${PGV_COMPANY_ID:-}" -v cid="${PGV_COMPANY_ID:-}" \
    -v agent_id="${PGV_AGENT_ID:-}" -v text="${PGV_TEXT:-}" \
    -v grants="${PGV_GRANTS:-[]}" -v a="${PGV_A:-}" -v b="${PGV_B:-}" \
    "$@" -f -
}

# --- reachability -----------------------------------------------------------

# pcsql_preflight — can the SELECTED backend actually answer a query?
#
# For a REGRESSION SUITE this is a precondition, not a nicety. Without it a
# suite that cannot reach its subject still runs, and every assertion whose
# expected outcome is a refusal goes green for the wrong reason: the tool dies
# on "requester not found" long before the ceiling check the assertion names.
# (Measured: 15 of 31 such green ticks in test_request_queue.sh against no
# database at all.) A suite that cannot reach its subject must say so.
#
# `command -v` on the engine is NOT sufficient, and that is the trap worth
# naming: a host with an engine installed but no paperclip-db container, or a
# psql pointed at a dead host, passes a binary check and then fails in the
# middle of the suite — the same partially-green run, arrived at differently.
# So this does a real round-trip and requires the answer back.
#
# Returns 0 reachable · 2 not reachable (diagnosis on stderr).
pcsql_preflight() {
  local backend bin out
  backend="$(pcsql_backend)" || return 2
  bin="$(pcsql_required_bin)" || return 2

  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "REFUSED: PAPERCLIP_SQL_BACKEND=$backend needs '$bin' on PATH, and it is not there." >&2
    return 2
  fi

  if ! out="$(pcsql_run -Atq -v ON_ERROR_STOP=1 <<<'SELECT 1;' 2>&1)"; then
    echo "REFUSED: the '$backend' backend is on PATH but did not answer 'SELECT 1':" >&2
    sed 's/^/  /' <<<"$out" >&2
    return 2
  fi

  # Trailing noise (a podman warning on stderr, say) is tolerated; a missing
  # answer is not. An empty reply here is precisely the failure mode that makes
  # `[[ "$count" -eq 0 ]]` read as a pass, because bash scores "" as 0.
  if ! grep -qx '1' <<<"$out"; then
    echo "REFUSED: the '$backend' backend answered 'SELECT 1' with no usable row:" >&2
    sed 's/^/  /' <<<"$out" >&2
    return 2
  fi
  return 0
}

# Sourcing helper: `. "$HERE/lib/pcsql.sh"` fails loudly rather than leaving a
# tool with an undefined pcsql_run to trip over several hundred lines later.
pcsql_loaded() { return 0; }
