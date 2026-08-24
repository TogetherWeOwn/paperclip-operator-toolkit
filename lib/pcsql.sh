# shellcheck shell=bash
# ===========================================================================
# pcsql — the one place this repo decides HOW to reach PostgreSQL.
# ---------------------------------------------------------------------------
# Sourced, never executed. Every tool here used to open-code
#
#     podman exec -i ... paperclip-db sh -c 'exec psql -U "$POSTGRES_USER" ...'
#
# which hard-wires the tools to one VPS with one container name. That is fine
# for the operator and fatal for CI: there is no way to point a suite at a
# throwaway database, so the two suites that assert the privilege-ceiling
# invariants cannot run anywhere except production. (TOG-202.)
#
# This adds a second backend and changes nothing else. The DEFAULT IS STILL
# PODMAN and the podman command it builds is byte-for-byte the one each tool
# built before, so an operator's existing invocation is unaffected — they need
# not know this file exists.
#
# BACKEND SELECTION IS EXPLICIT, NEVER SNIFFED.
#   PAPERCLIP_SQL_BACKEND=podman   (default) `podman exec` into $PAPERCLIP_DB_CTR
#   PAPERCLIP_SQL_BACKEND=psql               a plain psql on $PATH
#   anything else                            refused
#
# It would be friendlier to auto-select `psql` when DATABASE_URL happens to be
# set. It would also mean that an operator who has DATABASE_URL exported for
# some unrelated reason silently runs the provisioner against the wrong
# database, and the provisioner CREATES AND DELETES AGENTS. Guessing is not
# available here; the caller says which, or gets the historical default.
#
# NO CREDENTIAL ON argv, ON EITHER BACKEND.
# `/proc/*/cmdline` is world-readable and every company on the VPS shares the
# host, so the repo's standing rule is that secrets move by inherited
# environment only. The podman path already honoured that (values ride in as
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
    podman|psql) printf '%s' "$b" ;;
    *) echo "REFUSED: PAPERCLIP_SQL_BACKEND='$b' is not one of: podman, psql" >&2; return 2 ;;
  esac
}

# The binary the selected backend needs, so callers can dependency-check the
# backend they will actually use instead of demanding podman unconditionally.
pcsql_required_bin() { pcsql_backend; }

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
  local backend; backend="$(pcsql_backend)" || return 2

  if [[ "$backend" == "podman" ]]; then
    PGV_COMPANY_ID="${PGV_COMPANY_ID:-}" PGV_AGENT_ID="${PGV_AGENT_ID:-}" \
    PGV_TEXT="${PGV_TEXT:-}" PGV_GRANTS="${PGV_GRANTS:-[]}" \
    PGV_A="${PGV_A:-}" PGV_B="${PGV_B:-}" \
    podman exec -i \
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

# Sourcing helper: `. "$HERE/lib/pcsql.sh"` fails loudly rather than leaving a
# tool with an undefined pcsql_run to trip over several hundred lines later.
pcsql_loaded() { return 0; }
