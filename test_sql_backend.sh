#!/usr/bin/env bash
# ===========================================================================
# Offline regression suite for lib/pcsql.sh — the SQL backend indirection.
#
# WHY THIS CAN RUN IN CI WHEN THE SUITES IT UNBLOCKS CANNOT.
# The thing under test is a DISPATCHER: given a backend selection, which
# command does it build, and what is on that command's argv? Answering that
# needs no database — it needs a `podman`, a `docker` and a `psql` that record
# how they were called. So this suite puts fakes for all three on PATH and
# asserts the exact argv and stdin each backend produces.
#
# Faking rather than omitting is the point. A test that skips the psql path
# when psql is absent passes on every runner in the world while the psql path
# is broken. These fakes are always present, so both paths are always executed.
#
# What is deliberately NOT claimed: this proves the command is CONSTRUCTED
# correctly, not that a real PostgreSQL accepts it. That needs a real database
# and is the remaining half of the CI-database work.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

# The fakes. Each writes its own argv, one argument per line (so an argument
# containing a space cannot be mistaken for two), plus its stdin, and exits 0.
# The container fakes additionally record the environment they were handed,
# because the whole reason the container path passes values as `-e PGV_*` is
# to keep them off the command line.
cat >"$WORK/bin/podman" <<'FAKE'
#!/usr/bin/env bash
{ printf '%s\n' "$@"; } > "$REC/podman.argv"
env | grep -E '^(PGV_|POSTGRES_)' | sort > "$REC/podman.env"
cat > "$REC/podman.stdin"
FAKE
cat >"$WORK/bin/docker" <<'FAKE'
#!/usr/bin/env bash
{ printf '%s\n' "$@"; } > "$REC/docker.argv"
env | grep -E '^(PGV_|POSTGRES_)' | sort > "$REC/docker.env"
cat > "$REC/docker.stdin"
FAKE
cat >"$WORK/bin/psql" <<'FAKE'
#!/usr/bin/env bash
{ printf '%s\n' "$@"; } > "$REC/psql.argv"
env | grep -E '^PG' | sort > "$REC/psql.env"
cat > "$REC/psql.stdin"
FAKE
# skills.sh resolves a paperclipai CLI at startup and exits 1 if it finds none,
# before it ever queries. Without this stub section 11 could not drive it at
# all and would report "reached no backend" for a reason that has nothing to do
# with the backend. PAPERCLIP_CLI is that tool's own documented seam. The stub
# is never expected to run: section 11 only drives read-only subcommands.
cat >"$WORK/bin/paperclipai" <<'FAKE'
#!/usr/bin/env bash
echo "STUB CLI INVOKED: $*" >&2
exit 9
FAKE
chmod +x "$WORK/bin/podman" "$WORK/bin/docker" "$WORK/bin/psql" "$WORK/bin/paperclipai"
export PATH="$WORK/bin:$PATH"

# Each case gets a clean recording directory, and every invocation runs in a
# SUBSHELL with a fresh environment so one case's exports cannot leak into the
# next — libpq variables are sticky and that is exactly the kind of cross-talk
# that makes a dispatcher suite lie.
run_case() {
  REC="$WORK/rec"; rm -rf "$REC"; mkdir -p "$REC"; export REC
}
argv_of()  { tr '\n' ' ' < "$REC/$1.argv"; }
called()   { [[ -f "$REC/$1.argv" ]]; }

. "$HERE/lib/pcsql.sh" || { echo "cannot source lib/pcsql.sh" >&2; exit 1; }

hdr "1. The default backend is podman, and its command is the historical one"
run_case
( unset PAPERCLIP_SQL_BACKEND DATABASE_URL CONTAINER_ENGINE
  PGV_COMPANY_ID=CID PGV_AGENT_ID=AID pcsql_run -Atq <<<"SELECT 1;" )
if called podman; then ok "no PAPERCLIP_SQL_BACKEND selects podman"; else bad "podman was not invoked by default"; fi
called psql && bad "psql was invoked when the backend should have been podman" \
             || ok "psql was NOT invoked on the default path"
called docker && bad "docker was invoked when the backend should have been podman" \
              || ok "docker was NOT invoked on the default path"
grep -qx -- '-i' "$REC/podman.argv" && grep -qx 'paperclip-db' "$REC/podman.argv" \
  && ok "podman exec -i into paperclip-db" \
  || bad "podman argv is not the historical form: $(argv_of podman)"
grep -qx 'SELECT 1;' "$REC/podman.stdin" && ok "SQL reaches the backend on stdin" \
  || bad "SQL did not reach podman stdin"

hdr "2. The podman path keeps query values OFF the host command line"
# This is the repo's standing rule (/proc/*/cmdline is world-readable). The
# values must arrive as inherited environment and be expanded inside the
# container, never as `podman exec ... -v company_id=<uuid>`.
grep -qx 'CID' "$REC/podman.argv" && bad "the company id is on the podman argv" \
  || ok "company id is absent from the podman argv"
grep -q '^PGV_COMPANY_ID=CID$' "$REC/podman.env" && ok "company id arrives as inherited PGV_COMPANY_ID" \
  || bad "PGV_COMPANY_ID did not reach podman's environment"
grep -q '^PGV_AGENT_ID=AID$' "$REC/podman.env" && ok "agent id arrives as inherited PGV_AGENT_ID" \
  || bad "PGV_AGENT_ID did not reach podman's environment"

hdr "3. Backend selection is explicit and is never sniffed from the environment"
# An operator with DATABASE_URL exported for some unrelated reason must still
# hit the podman backend. The provisioner creates and deletes real agents;
# quietly retargeting it at whatever DATABASE_URL happens to point to is the
# worst failure available here. This is the assertion that stops "just default
# to psql when the URL is set" from looking like a harmless convenience.
run_case
( unset PAPERCLIP_SQL_BACKEND CONTAINER_ENGINE
  DATABASE_URL='postgres://u:p@h/d' pcsql_run -Atq <<<"SELECT 1;" )
called psql && bad "DATABASE_URL alone silently switched the backend to psql" \
             || ok "DATABASE_URL alone does NOT switch the backend"
called podman && ok "still podman when only DATABASE_URL is set" \
              || bad "neither backend ran"

hdr "4. PAPERCLIP_DB_CTR still redirects the podman path"
run_case
( unset PAPERCLIP_SQL_BACKEND CONTAINER_ENGINE
  PAPERCLIP_DB_CTR=other-db pcsql_run -Atq <<<"SELECT 1;" )
grep -qx 'other-db' "$REC/podman.argv" && ok "container name honoured" \
  || bad "PAPERCLIP_DB_CTR ignored: $(argv_of podman)"

hdr "4b. PAPERCLIP_SQL_BACKEND=docker builds the same command via docker"
# A host without podman: the queue and the gate must reach the
# database through `docker exec` with the identical argv shape, stdin and
# no-secret-on-argv properties, or every submit/review fails `missing podman`.
run_case
( PAPERCLIP_SQL_BACKEND=docker PGV_COMPANY_ID=CID PGV_AGENT_ID=AID pcsql_run -Atq <<<"SELECT 1;" )
if called docker; then ok "docker backend invokes docker"; else bad "docker was not invoked for PAPERCLIP_SQL_BACKEND=docker"; fi
called podman && bad "podman was invoked on the docker backend" || ok "podman was NOT invoked on the docker backend"
called psql && bad "psql was invoked on the docker backend" || ok "psql was NOT invoked on the docker backend"
grep -qx -- '-i' "$REC/docker.argv" && grep -qx 'paperclip-db' "$REC/docker.argv" \
  && ok "docker exec -i into paperclip-db" \
  || bad "docker argv is not the historical form: $(argv_of docker)"
grep -qx 'SELECT 1;' "$REC/docker.stdin" && ok "SQL reaches docker on stdin" \
  || bad "SQL did not reach docker stdin"
grep -qx 'CID' "$REC/docker.argv" && bad "the company id is on the docker argv" \
  || ok "company id is absent from the docker argv"
grep -q '^PGV_COMPANY_ID=CID$' "$REC/docker.env" && ok "company id arrives as inherited PGV_COMPANY_ID on docker" \
  || bad "PGV_COMPANY_ID did not reach docker's environment"
run_case
( PAPERCLIP_SQL_BACKEND=docker PAPERCLIP_DB_CTR=other-db pcsql_run -Atq <<<"SELECT 1;" )
grep -qx 'other-db' "$REC/docker.argv" && ok "container name honoured on docker" \
  || bad "PAPERCLIP_DB_CTR ignored on docker: $(argv_of docker)"

hdr "4c. CONTAINER_ENGINE overrides the binary without reselecting the backend"
# The issue's formula: CONTAINER_ENGINE=${CONTAINER_ENGINE:-$(command -v docker
# || command -v podman)}. An operator sets it once for the host; the backend
# selection stays explicit and the psql path ignores it entirely.
run_case
( unset PAPERCLIP_SQL_BACKEND; CONTAINER_ENGINE=docker pcsql_run -Atq <<<"SELECT 1;" )
if called docker; then ok "CONTAINER_ENGINE=docker redirects the default backend to docker"; else bad "CONTAINER_ENGINE=docker did not redirect: podman ran"; fi
called podman && bad "podman ran despite CONTAINER_ENGINE=docker" || ok "podman was NOT invoked under CONTAINER_ENGINE=docker"
run_case
( PAPERCLIP_SQL_BACKEND=docker; CONTAINER_ENGINE=podman pcsql_run -Atq <<<"SELECT 1;" )
if called podman; then ok "CONTAINER_ENGINE=podman redirects the docker backend to podman"; else bad "CONTAINER_ENGINE=podman did not redirect"; fi
called docker && bad "docker ran despite CONTAINER_ENGINE=podman" || ok "docker was NOT invoked under CONTAINER_ENGINE=podman"
run_case
( PAPERCLIP_SQL_BACKEND=psql DATABASE_URL='postgres://u:p@h/d' CONTAINER_ENGINE=does-not-exist pcsql_run -Atq <<<"SELECT 1;" )
if called psql; then ok "psql backend ignores CONTAINER_ENGINE"; else bad "psql backend was disturbed by CONTAINER_ENGINE"; fi
called docker && bad "docker ran on the psql backend" || ok "docker was NOT invoked on the psql backend"
called podman && bad "podman ran on the psql backend" || ok "podman was NOT invoked on the psql backend"

hdr "5. PAPERCLIP_SQL_BACKEND=psql calls a plain psql, not podman"
run_case
( PAPERCLIP_SQL_BACKEND=psql DATABASE_URL='postgres://u:p@h:5433/d' \
  PGV_COMPANY_ID=CID pcsql_run -Atq <<<"SELECT 2;" )
called psql   && ok "psql was invoked" || bad "psql was not invoked"
called podman && bad "podman was invoked on the psql backend" || ok "podman was NOT invoked"
grep -qx 'SELECT 2;' "$REC/psql.stdin" && ok "SQL reaches psql on stdin" || bad "SQL did not reach psql stdin"
grep -qx -- '-f' "$REC/psql.argv" && ok "psql reads the script from stdin (-f -)" \
  || bad "psql argv lacks -f -: $(argv_of psql)"
grep -qx -- '-Atq' "$REC/psql.argv" && ok "caller flags are forwarded" \
  || bad "caller flags dropped: $(argv_of psql)"

hdr "6. THE PASSWORD NEVER REACHES argv"
# The one property that makes a psql backend acceptable in this repo at all. A
# connection URI carries a password; handing the URI to psql would publish it
# through /proc/*/cmdline on a host every company shares.
grep -qx 'p' "$REC/psql.argv" && bad "the password is on the psql argv" \
  || ok "password absent from psql argv"
grep -q 'postgres://' "$REC/psql.argv" && bad "the whole DATABASE_URL is on the psql argv" \
  || ok "DATABASE_URL absent from psql argv"
grep -q '^PGPASSWORD=p$' "$REC/psql.env" && ok "password arrives as inherited PGPASSWORD" \
  || bad "PGPASSWORD did not reach psql: $(sed 's/^/          /' "$REC/psql.env")"
for want in 'PGUSER=u' 'PGHOST=h' 'PGPORT=5433' 'PGDATABASE=d'; do
  grep -qx "$want" "$REC/psql.env" && ok "DATABASE_URL decomposed: $want" \
    || bad "expected $want in psql environment"
done

hdr "7. URL decoding, and the cases that must be refused"
run_case
( PAPERCLIP_SQL_BACKEND=psql DATABASE_URL='postgres://u%40corp:p%3Aw%40rd@h/d' \
  pcsql_run -Atq <<<"SELECT 3;" )
grep -qx 'PGPASSWORD=p:w@rd' "$REC/psql.env" && ok "percent-encoded password decoded" \
  || bad "password decode wrong: $(grep '^PGPASSWORD' "$REC/psql.env")"
grep -qx 'PGUSER=u@corp' "$REC/psql.env" && ok "percent-encoded user decoded" \
  || bad "user decode wrong: $(grep '^PGUSER' "$REC/psql.env")"
grep -qx 'PGHOST=h' "$REC/psql.env" && ok "an encoded @ in the password does not truncate the host" \
  || bad "host parsed as: $(grep '^PGHOST' "$REC/psql.env")"

# Default is refusal — the repo's first rule for anything credential-adjacent.
refuses() {
  local desc="$1"; shift
  run_case
  local out; out="$( "$@" 2>&1 )"; local rc=$?
  if [[ $rc -ne 0 ]] && grep -q REFUSED <<<"$out" && ! called psql && ! called podman && ! called docker; then
    ok "$desc"
  else
    bad "$desc (rc=$rc, psql called=$(called psql && echo yes || echo no))"
  fi
}
sqlrun() { pcsql_run -Atq <<<"SELECT 1;"; }
refuses "an unknown backend name is refused, and nothing runs" \
  env PAPERCLIP_SQL_BACKEND=mysql bash -c ". '$HERE/lib/pcsql.sh'; pcsql_run -Atq <<<'SELECT 1;'"
refuses "a non-postgres URL scheme is refused" \
  env PAPERCLIP_SQL_BACKEND=psql DATABASE_URL='mysql://u:p@h/d' \
  bash -c ". '$HERE/lib/pcsql.sh'; pcsql_run -Atq <<<'SELECT 1;'"
refuses "a backslash in DATABASE_URL is refused rather than mis-decoded" \
  env PAPERCLIP_SQL_BACKEND=psql 'DATABASE_URL=postgres://u:p\n@h/d' \
  bash -c ". '$HERE/lib/pcsql.sh'; pcsql_run -Atq <<<'SELECT 1;'"
refuses "an unsupported URL parameter is refused, not silently dropped" \
  env PAPERCLIP_SQL_BACKEND=psql DATABASE_URL='postgres://u:p@h/d?target_session_attrs=rw' \
  bash -c ". '$HERE/lib/pcsql.sh'; pcsql_run -Atq <<<'SELECT 1;'"
refuses "psql backend with no connection information at all is refused" \
  env -u DATABASE_URL -u PGHOST -u PGDATABASE PAPERCLIP_SQL_BACKEND=psql \
  bash -c ". '$HERE/lib/pcsql.sh'; pcsql_run -Atq <<<'SELECT 1;'"

hdr "8. sslmode is carried across, because dropping it downgrades the connection"
run_case
( PAPERCLIP_SQL_BACKEND=psql DATABASE_URL='postgres://u:p@h/d?sslmode=require' \
  pcsql_run -Atq <<<"SELECT 4;" )
grep -qx 'PGSSLMODE=require' "$REC/psql.env" && ok "?sslmode=require becomes PGSSLMODE" \
  || bad "sslmode was lost: $(sed 's/^/          /' "$REC/psql.env")"

hdr "9. Every query variable is bound on both backends"
# A caller that forgets to plumb one through gets an empty string, never an
# undefined-variable error deep inside a query — and the two backends must
# agree on the list, or a suite passes on one and fails on the other.
VARS="company_id cid agent_id text grants a b"
run_case
( PAPERCLIP_SQL_BACKEND=psql DATABASE_URL='postgres://u:p@h/d' pcsql_run -Atq <<<"SELECT 1;" )
for v in $VARS; do
  # Anchored at the start only: `grants` is bound to its documented default of
  # `[]` rather than to the empty string, and pinning the value here would just
  # restate the implementation.
  grep -q -- "^$v=" "$REC/psql.argv" && ok "psql backend binds :$v" || bad "psql backend does not bind :$v"
done
# The container backends build their -v list inside the container, so assert on
# the text of the command each hands to `sh -c` instead.
run_case
( unset PAPERCLIP_SQL_BACKEND CONTAINER_ENGINE; pcsql_run -Atq <<<"SELECT 1;" )
missing=""
for v in $VARS; do
  grep -q -- "-v $v=" "$REC/podman.argv" || missing="$missing $v"
done
[[ -z "$missing" ]] && ok "podman backend binds every variable too" \
                    || bad "podman backend is missing:$missing"
run_case
( PAPERCLIP_SQL_BACKEND=docker; pcsql_run -Atq <<<"SELECT 1;" )
missing=""
for v in $VARS; do
  grep -q -- "-v $v=" "$REC/docker.argv" || missing="$missing $v"
done
[[ -z "$missing" ]] && ok "docker backend binds every variable too" \
                    || bad "docker backend is missing:$missing"

hdr "10. The tools actually source the helper"
# Cheap, but it is the assertion that catches someone reintroducing a
# hardcoded `podman exec` in one tool while the others move on. gh_access.sh
# and skills.sh joined this list later; they were the last two holdouts.
CONVERTED="org_provisioner.sh org_request_queue.sh org_access_review.sh
           test_privilege_ceilings.sh test_request_queue.sh
           gh_access.sh skills.sh"
for f in $CONVERTED; do
  if grep -q 'lib/pcsql.sh' "$HERE/$f"; then ok "$f sources lib/pcsql.sh"
  else bad "$f does not source lib/pcsql.sh"; fi
  # Narrower than the old blanket "no podman exec anywhere in this file",
  # because gh_access.sh legitimately probes the SERVER container and that is
  # not a database call. The repo-wide allowlist sweep immediately below is
  # what keeps this from being a loosening: no file here is allowlisted for a
  # database-container site, so any of them reintroducing one still fails, and
  # the sweep additionally covers files nobody remembered to add to this list.
  if grep -qE 'PAPERCLIP_DB_CTR|paperclip-db' <<<"$(grep -E '^[^#]*(podman|docker) exec' "$HERE/$f")"; then
    bad "$f still open-codes a container exec into the database container"
  else
    ok "$f has no open-coded container exec into the database container"
  fi
done

hdr "10b. Every surviving container exec in the repo root is named and justified"
# An ALLOWLIST, not a denylist. A per-file check only ever inspects the files
# someone remembered to list, so a NEW tool that open-codes the transport is
# invisible to it. This sweeps every shell script in the repo root for both
# `podman exec` and `docker exec` and requires each surviving site to be named
# here with its reason — otherwise the docker half of the backend work
# reintroduces exactly the open-coded call this gate was built to catch. lib/ is
# deliberately out of scope: lib/pcsql.sh is the one sanctioned container exec
# in the repo.
podman_site_allowed() { # <file> <line>
  case "$1" in
    # This suite quotes the string in its own fakes, assertions and messages.
    test_sql_backend.sh) return 0 ;;
    gh_access.sh)
      # The SERVER container, not the database: a `test -x` probe for the
      # credential-helper binary. lib/pcsql.sh is not the seam for that, and
      # accepting it under a database-backend gate would let the assertion
      # above be satisfied by something it does not test.
      [[ "$2" == *PAPERCLIP_SERVER_CTR* ]] && return 0 ;;
    rehearsal_authorized_preflight.sh)
      # The AGENT container, not the database: this is the reviewed helper that
      # streams a rehearsal authorization into the agent and reads back its
      # container-local state. Same reasoning as gh_access.sh above — keyed on
      # the line, not the file, so a database-container site in this script is
      # still a failure.
      [[ "$2" == *AGENT_CONTAINER* ]] && return 0 ;;
    test_omniroute_rehearsal.sh)
      # A quoted grep PATTERN, not an invocation: the suite asserts that the
      # helper above still delegates to that exact container-local command. The
      # sweep cannot tell a pattern from a call, so it is named here rather than
      # reworded — rewording it would decouple the assertion from the text it
      # pins. Keyed on the line for the same reason as the two entries above.
      [[ "$2" == *AGENT_CONTAINER* ]] && return 0 ;;
    host_db_backup.sh)
      # pg_dump and the pg_stat_activity courtesy check both need a
      # raw `podman exec` into the database container. lib/pcsql.sh's
      # pcsql_run only knows how to pipe one psql script with bound
      # :variables through stdin — it cannot stream a pg_dump pipeline, and
      # the whole point of this file is to be the same "podman exec pg_dump |
      # gzip" an operator already ran by hand, kept working even if the
      # in-server scheduler's in-flight guard never clears. Unlike the
      # CONVERTED tools above, there is no query-shaped alternative backend
      # for this file to reach for, so it is allowed here by file rather than
      # by line — every podman exec in it is this same dump-or-probe call
      # against $CONTAINER, not a query pcsql_run could have carried instead.
      return 0 ;;
  esac
  return 1
}
unlisted=0; swept=0
for p in "$HERE"/*.sh; do
  f="$(basename "$p")"
  while IFS= read -r line; do
    swept=$((swept+1))
    podman_site_allowed "$f" "$line" \
      || { unlisted=$((unlisted+1)); printf '        %s: %s\n' "$f" "$(sed 's/^[[:space:]]*//' <<<"${line:0:88}")"; }
  done < <(grep -hE '^[^#]*(podman|docker) exec' "$p")
done
# Three outcomes, not two. A sweep that matched nothing at all has not proved
# the repo is clean, it has proved the sweep is broken — and this file alone
# guarantees at least one site, so zero is impossible unless the walk failed.
if [[ "$swept" -eq 0 ]]; then
  bad "the sweep matched no container exec anywhere, not even in this file — it did not run"
elif [[ "$unlisted" -eq 0 ]]; then
  ok "all $swept container exec site(s) in the repo root are on the allowlist"
else
  bad "$unlisted of $swept container exec site(s) are not on the allowlist"
fi

hdr "11. The converted tools reach the backend the caller SELECTED"
# Section 10 proves the text changed. It does not prove the tool reaches the
# backend at all: a tool can source the helper and still never call it, and a
# tool that kept a private psql path would pass every grep above. So drive each
# one for real and see which fake it actually talked to.
#
# The fakes answer nothing, so each tool then fails for its own reasons further
# down. That is irrelevant and deliberately NOT asserted here — the subject of
# this section is which binary the tool selected, nothing else.
drives_selected_backend() {
  local desc="$1" tool="$2"; shift 2
  run_case
  ( export PAPERCLIP_SQL_BACKEND=psql DATABASE_URL='postgres://u:p@h/d'
    export COMPANY_ID=00000000-0000-0000-0000-000000000000
    export PAPERCLIP_CLI="$WORK/bin/paperclipai"
    "$HERE/$tool" "$@" ) >/dev/null 2>&1
  if called podman; then
    bad "$desc — went to podman despite PAPERCLIP_SQL_BACKEND=psql"
  elif called psql; then
    ok "$desc"
  else
    bad "$desc — reached NO backend; the tool never queried, so this proves nothing"
  fi
}
drives_selected_backend "gh_access.sh show queries through lib/pcsql.sh" gh_access.sh show T0
drives_selected_backend "skills.sh show queries through lib/pcsql.sh"    skills.sh    show T0

printf '\n\033[1mRESULT: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
