#!/usr/bin/env bash
# ===========================================================================
# paperclip-upgrade/test-offline.sh — offline checks for the upgrade
# harness that need no Docker, no live host and no production database.
#
# What it runs:
#   1. bash -n over every harness script (a script that cannot parse is not
#      a reviewable artifact).
#   1c. runtime-path defaults (data dir, compose file, container data mount,
#      cargo pool dir, fork source dir, handoff dir) are neutral and driven
#      by environment overrides; no deployment-specific path is hard-coded.
#   2. validate_sql.py against the isolated agent-testdb proof database:
#      neutraliser negative control + 20/20 gates, inventory, all 7 drain
#      queries with positive and negative controls.
#   3. with --extra-migrations: the 0280-0284 upgrade proof — migration_gate
#      positive + withheld-row negative control, image-only rollback gate
#      (bare FAIL / --known-ahead PASS / foreign-row FAIL), and drain-query
#      identity (7/7 identical) on the upgraded schema.
#   4. the refusal probes below (every mutating path refuses before touching
#      Docker, the DB or the host).
#   5. the drain.sh restart <-> pre-restart-check.sh flag contract (the exact
#      invocation drain.sh restart issues must be accepted by precheck).
#   6. the rehearsal package manifest (digest + required migrations pinned).
#   7. effective-build-check.sh: synthetic EPIPE fixture PROVEN, stale and
#      wrong-hash fixtures UNPROVEN, refusal probes (no target, bad hash,
#      missing file, package pin in --path mode, path-walking pin), the
#      embedded node resolver executed VERBATIM under real node, and the live
#      fork server-utils source when present beside the run.
#   7b. pinned compiled files + the legacy 916 redaction refusal against an
#      EMULATED runtime (the checker's own remote sh runs over a fake /app):
#      --expect-file match/mismatch/MISSING, forbidden content, dropped
#      sentinel, marker separation, mount tables (exact/ancestor/root FAIL,
#      sibling prefix and unrelated PROVEN, malformed/empty/unreadable FAIL),
#      refusal probes, drain ebc_args and compose_no_legacy_overlay executed
#      verbatim, and the handoff's captured 916 file refused when present.
#   8. check-plugin-inventory.py on a synthetic fixture (no handoff needed):
#      positive PROVEN, wrong-count / populated-secretId / stray-UUID FAIL;
#      plus, when the approved operator handoff exists beside this run, a
#      live validation (a real pass, never a vacuous pass: the script exits
#      non-zero on any gate failure).
#   9. umask_gate() extracted VERBATIM from drain.sh and run against a fake
#      docker that answers ONLY the exact PID-1-status exec: 0077 passes,
#      0022 (the value a naive `docker exec ... umask` would report) FAILS,
#      exec failure FAILS; plus the verify_held wiring probe (an unwired
#      gate would make the unit proof vacuous).
#
# Needs: agent-testdb reachable, the runtime migrations dir, and (for step 3)
# the fork migrations dir with 0280-0284. Takes no credential: refuses when
# PGPASSWORD/DATABASE_URL/PGSERVICE is set. Creates and drops databases named
# rehearse_sqlproof_*, nothing else.
#
# No Docker here: sections 4-5 run the scripts' argument/refusal paths with a
# fake `docker` shim (exists on PATH so `command -v` passes, fails if ever
# invoked) scoped to this run. Every probe below refuses BEFORE any docker
# invocation, so the shim never executes; a probe that reached docker would
# fail loudly instead of passing vacuously. Sections 7-8 use --path mode and
# synthetic fixtures only (no Docker, no handoff required); the live fork
# source and the approved operator handoff are exercised opportunistically
# when present beside the run (a real pass, never assumed).
#
# Exit: 0 all offline checks pass | 1 a check failed | 2 refused
# ===========================================================================
set -uo pipefail

ME="${BASH_SOURCE[0]##*/}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS="${PAPERCLIP_UPGRADE_MIGRATIONS_DIR:-/app/packages/db/src/migrations}"
FORK_DIR="${PAPERCLIP_UPGRADE_FORK_DIR:-$HOME/paperclip-fork}"
EXTRA="${PAPERCLIP_UPGRADE_EXTRA_MIGRATIONS_DIR:-$FORK_DIR/packages/db/src/migrations}"
FAIL=0
LOGD="$(mktemp -d)"
trap '((FAIL == 0)) && rm -rf "$LOGD"' EXIT

say() { printf '%s\n' "$*"; }
pass() { say "ok: $*"; }
oops() { say "FAIL: $*"; FAIL=1; }
refuse() { printf 'REFUSED: %s: %s\n' "$ME" "$*" >&2; exit 2; }

[[ -n "${PGPASSWORD:-}" || -n "${DATABASE_URL:-}" || -n "${PGSERVICE:-}" ]] \
  && refuse "PGPASSWORD/DATABASE_URL/PGSERVICE is set: this proof takes no credential; unset it"
[[ -d "$MIGRATIONS" ]] || refuse "migrations dir missing: $MIGRATIONS"
command -v python3 >/dev/null || refuse "python3 is missing"
command -v jq >/dev/null || refuse "jq is missing (needed for the package-manifest check)"

# --- 1. every harness script parses ------------------------------------------
for f in rehearse-upgrade.sh drain.sh pre-restart-check.sh post-restart-reharden.sh \
         resolve-drain-stranded.sh effective-build-check.sh migration_gate.py \
         check-plugin-inventory.py validate_sql.py test-offline.sh; do
  [[ -f "$HERE/$f" ]] || { oops "missing harness file: $f"; continue; }
  case "$f" in
    *.sh) bash -n "$HERE/$f" 2>"$LOGD/parse.err" && pass "parses: $f" \
            || { oops "does not parse: $f ($(head -c 200 "$LOGD/parse.err"))"; } ;;
    *.py) python3 -m py_compile "$HERE/$f" 2>"$LOGD/parse.err" && pass "compiles: $f" \
            || { oops "does not compile: $f ($(head -c 200 "$LOGD/parse.err"))"; } ;;
  esac
done

# --- 1b. stage-DB init auth is pinned (static) ---------------------------------
# Stock postgres:16 refuses to initialize with only POSTGRES_USER/DB set, so
# every stage-database launch in rehearse-upgrade.sh must carry either
# POSTGRES_HOST_AUTH_METHOD=trust or a POSTGRES_PASSWORD. The app-container
# launch passes POSTGRES_* through to the app (not to initdb) and is excluded
# by counting only "$DB_IMAGE" launches. Regression pin.
AUTHN="$(grep -c 'POSTGRES_HOST_AUTH_METHOD=trust\|POSTGRES_PASSWORD' "$HERE/rehearse-upgrade.sh" || true)"
DBLAUNCH="$(grep -c '"$DB_IMAGE"' "$HERE/rehearse-upgrade.sh" || true)"
if ((DBLAUNCH >= 2)) && ((AUTHN >= DBLAUNCH)); then
  pass "stage-DB init auth pinned ($AUTHN auth envs for $DBLAUNCH db launches)"
else
  oops "stage-DB init auth missing: $AUTHN auth envs for $DBLAUNCH db launches (stock postgres would never initialize)"
fi

# --- 1c. runtime-path defaults are neutral and env-driven (static) -------------
# No harness file may carry a deployment-specific absolute default. Each
# default below is evaluated EXACTLY as written in its script, in an empty
# environment with a throwaway HOME, so an edit that reintroduces a hard-coded
# path, or drops an override, fails here instead of passing vacuously.
NEUTRAL_HOME=/home/neutral
eval_default() { # FILE VAR... [-- ENV=VAL...]: run the named assignments in order, print the last one
  local file="$1"; shift
  local -a vars=() envs=()
  while (($#)); do
    if [[ "$1" == "--" ]]; then shift; envs=("$@"); break; fi
    vars+=("$1"); shift
  done
  local lines="" v
  for v in "${vars[@]}"; do
    lines+="$(grep -m1 "^$v=" "$HERE/$file")"$'\n'
  done
  env -i HOME="$NEUTRAL_HOME" ${envs[@]+"${envs[@]}"} bash -c "$lines"'printf %s "${'"${vars[${#vars[@]}-1]}"'}"'
}
chk_default() { # LABEL EXPECTED FILE VAR... [-- ENV=VAL...]
  local label="$1" want="$2" file="$3" got
  shift 3
  got="$(eval_default "$file" "$@")"
  if [[ "$got" == "$want" ]]; then
    pass "default: $label = $want"
  else
    oops "default: $label: expected '$want', got '$got'"
  fi
}
chk_default "drain.sh COMPOSE_FILE" "$NEUTRAL_HOME/.paperclip/compose.yaml" drain.sh COMPOSE_FILE
chk_default "drain.sh COMPOSE_FILE with PAPERCLIP_HOME" /srv/pc/compose.yaml drain.sh COMPOSE_FILE -- PAPERCLIP_HOME=/srv/pc
chk_default "drain.sh COMPOSE_FILE explicit override" /x/c.yaml drain.sh COMPOSE_FILE -- PAPERCLIP_UPGRADE_COMPOSE_FILE=/x/c.yaml
chk_default "pre-restart-check.sh DATA_DIR" "$NEUTRAL_HOME/.paperclip/data" pre-restart-check.sh DATA_DIR
chk_default "pre-restart-check.sh DATA_DIR with PAPERCLIP_HOME" /srv/pc/data pre-restart-check.sh DATA_DIR -- PAPERCLIP_HOME=/srv/pc
chk_default "pre-restart-check.sh DATA_DIR explicit override" /x/d pre-restart-check.sh DATA_DIR -- PAPERCLIP_DATA=/x/d
chk_default "post-restart-reharden.sh DATA_DIR" "$NEUTRAL_HOME/.paperclip/data" post-restart-reharden.sh DATA_DIR
chk_default "post-restart-reharden.sh DATA_DIR with PAPERCLIP_HOME" /srv/pc/data post-restart-reharden.sh DATA_DIR -- PAPERCLIP_HOME=/srv/pc
chk_default "post-restart-reharden.sh DATA_DIR explicit override" /x/d post-restart-reharden.sh DATA_DIR -- PAPERCLIP_DATA=/x/d
chk_default "post-restart-reharden.sh CONTAINER_DATA" /paperclip post-restart-reharden.sh CONTAINER_DATA
chk_default "post-restart-reharden.sh CONTAINER_DATA override" /data post-restart-reharden.sh CONTAINER_DATA -- PAPERCLIP_CONTAINER_DATA=/data
chk_default "post-restart-reharden.sh POOL_REL" .cache/cargo-pool-bounded post-restart-reharden.sh POOL_REL
chk_default "post-restart-reharden.sh POOL_REL override" .cache/p post-restart-reharden.sh POOL_REL -- PAPERCLIP_UPGRADE_CARGO_POOL_REL=.cache/p
chk_default "test-offline.sh EXTRA migrations dir" "$NEUTRAL_HOME/paperclip-fork/packages/db/src/migrations" test-offline.sh FORK_DIR EXTRA
chk_default "test-offline.sh EXTRA migrations dir with fork override" /srv/fork/packages/db/src/migrations test-offline.sh FORK_DIR EXTRA -- PAPERCLIP_UPGRADE_FORK_DIR=/srv/fork
chk_default "test-offline.sh LIVE_SU" "$NEUTRAL_HOME/paperclip-fork/packages/adapter-utils/src/server-utils.ts" test-offline.sh FORK_DIR LIVE_SU
chk_default "test-offline.sh LIVE_SU explicit override" /x/su.ts test-offline.sh FORK_DIR LIVE_SU -- PAPERCLIP_UPGRADE_SERVER_UTILS_SRC=/x/su.ts
chk_default "test-offline.sh RHAND" "$NEUTRAL_HOME/handoff/redaction" test-offline.sh RHAND
chk_default "test-offline.sh RHAND with HANDOFF_DIR" /srv/h/redaction test-offline.sh RHAND -- HANDOFF_DIR=/srv/h
chk_default "test-offline.sh RHAND explicit override" /x/r test-offline.sh RHAND -- PAPERCLIP_UPGRADE_REDACTION_HANDOFF=/x/r
chk_default "test-offline.sh HANDOFF" "$NEUTRAL_HOME/handoff/plugin-inventory/inventory.json" test-offline.sh HANDOFF
chk_default "test-offline.sh HANDOFF with HANDOFF_DIR" /srv/h/plugin-inventory/inventory.json test-offline.sh HANDOFF -- HANDOFF_DIR=/srv/h
chk_default "test-offline.sh HANDOFF explicit override" /x/i.json test-offline.sh HANDOFF -- PAPERCLIP_UPGRADE_PLUGIN_INVENTORY=/x/i.json
# The retired literals must not reappear anywhere in the harness (patterns are
# assembled from fragments so this file does not contain them itself).
RETIRED_RE='/paper''clip/|secure''-drop|operator''-handoff|/home/ubu''ntu|stacks/paper''clip'
if hits="$(cd "$HERE" && grep -nE -e "$RETIRED_RE" -- *.sh *.py *.sql *.json 2>/dev/null)"; then
  oops "retired deployment-specific paths still present in the harness:"
  printf '%s\n' "$hits" | head -5 | sed 's/^/    /'
else
  pass "no deployment-specific absolute paths in the harness"
fi

# --- 2. neutraliser + drain-query proofs on the base schema -------------------
if python3 "$HERE/validate_sql.py" --migrations "$MIGRATIONS" >"$LOGD/base.log" 2>&1; then
  grep -q '^VALIDATE_SQL PASSED' "$LOGD/base.log" \
    && pass "validate_sql base schema: PASSED ($(grep -c '^ok:' "$LOGD/base.log") checks)" \
    || oops "validate_sql base schema exited 0 without the PASSED line"
else
  oops "validate_sql base schema failed:"
  tail -5 "$LOGD/base.log" | sed 's/^/    /'
fi

# --- 3. upgrade proof on 0280-0284 --------------------------------------------
if [[ -d "$EXTRA" ]]; then
  if python3 "$HERE/validate_sql.py" --migrations "$MIGRATIONS" --extra-migrations "$EXTRA" \
      --require 0280 --require 0281 --require 0282 --require 0283 \
      >"$LOGD/extra.log" 2>&1; then
    grep -q '^VALIDATE_SQL PASSED' "$LOGD/extra.log" \
      && pass "validate_sql 0280-0284 upgrade: PASSED ($(grep -c '^ok:' "$LOGD/extra.log") checks)" \
      || oops "validate_sql upgrade exited 0 without the PASSED line"
  else
    oops "validate_sql 0280-0284 upgrade failed:"
    tail -5 "$LOGD/extra.log" | sed 's/^/    /'
  fi
else
  say "skip: extra migrations dir missing ($EXTRA); upgrade proof not run"
fi

# --- 4. refusal probes (no live Docker/DB/state; fake docker on PATH) ---------
SHIMD="$(mktemp -d)"
cat >"$SHIMD/docker" <<'SHIM'
#!/usr/bin/env bash
echo "FATAL: test shim docker invoked: $*" >&2; exit 99
SHIM
chmod +x "$SHIMD/docker"
export PATH="$SHIMD:$PATH"
FAKEDUMP="$LOGD/fake.pgc"
: > "$FAKEDUMP"

probe() { # DESC NEEDLE... -- CMD...
  local desc="$1" needle="$2"; shift 2
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  if ((rc == 2)) && grep -qF -- "$needle" <<<"$out"; then
    pass "refuses: $desc"
  else
    oops "refusal probe '$desc': rc=$rc, want rc=2 containing '$needle' (got: $(head -c 160 <<<"$out"))"
  fi
}

probe "rehearse without --image" "--image is required" \
  bash "$HERE/rehearse-upgrade.sh" --dump "$FAKEDUMP" --db-name stage_rehearse_x
probe "rehearse with the exact production db name" "production/system name" \
  bash "$HERE/rehearse-upgrade.sh" --image some-image --dump "$FAKEDUMP" --db-name paperclip
probe "rehearse with a non-rehearsal db name" "must contain 'stage' or 'rehearse'" \
  bash "$HERE/rehearse-upgrade.sh" --image some-image --dump "$FAKEDUMP" --db-name mydb
probe "rehearse refuses the production user" "production user" \
  bash "$HERE/rehearse-upgrade.sh" --image some-image --dump "$FAKEDUMP" --db-name stage_rehearse_x --db-user paperclip
# drain.sh checks tool availability and the auth file before the --live gate,
# so with the shim docker it refuses on the missing board auth file first.
# That IS the correct fail-closed order (no host mutation without the key),
# and the --live gate itself is proven by the FORCE probe below, which sits
# before the auth check in drain.sh and fires first.
probe "drain refuses without the board auth file" "API auth file missing" \
  env DOCKER="$SHIMD/docker" PAPERCLIP_UPGRADE_API_AUTH_FILE="$LOGD/no-such.curl" \
    bash "$HERE/drain.sh" status --state-dir /nonexistent --live
probe "precheck without --backup-dir" "--backup-dir is required" \
  bash "$HERE/pre-restart-check.sh" --state-dir /nonexistent
probe "resolve without --live" "--live (operator only)" \
  env DOCKER="$SHIMD/docker" bash "$HERE/resolve-drain-stranded.sh" --since '2026-09-28 06:48' --apply
probe "resolve with a non-UUID --company" "--company must be a UUID" \
  env DOCKER="$SHIMD/docker" bash "$HERE/resolve-drain-stranded.sh" --since '2026-09-28 06:48' --company 'not-a-uuid'
probe "rollback with FORCE in the environment" "FORCE escape is removed" \
  env FORCE=1 DOCKER="$SHIMD/docker" bash "$HERE/drain.sh" rollback --state-dir /nonexistent --live --image x --expect-image-id sha256:0000000000000000000000000000000000000000000000000000000000000000
probe "drain with a non-token build marker" "must be a plain token" \
  env DOCKER="$SHIMD/docker" bash "$HERE/drain.sh" verify --state-dir /nonexistent --live --expect-build-marker 'has space'
probe "drain with a malformed build hash" "must be 64 lowercase hex" \
  env DOCKER="$SHIMD/docker" bash "$HERE/drain.sh" verify --state-dir /nonexistent --live --expect-build-sha256 xyz
probe "drain with a malformed plugin package pin" "must be NAME:64-hex-sha256" \
  env DOCKER="$SHIMD/docker" bash "$HERE/drain.sh" verify --state-dir /nonexistent --live --expect-plugin-package 'bad name!:0000000000000000000000000000000000000000000000000000000000000000'
probe "drain with a path-walking plugin package pin" "must be NAME:64-hex-sha256" \
  env DOCKER="$SHIMD/docker" bash "$HERE/drain.sh" verify --state-dir /nonexistent --live --expect-plugin-package '../../etc:0000000000000000000000000000000000000000000000000000000000000000'
probe "drain with a missing plugin inventory" "is not a regular file" \
  env DOCKER="$SHIMD/docker" bash "$HERE/drain.sh" verify --state-dir /nonexistent --live --plugin-inventory "$LOGD/no-such.json"
probe "rehearse with a non-token build marker" "must be a plain token" \
  bash "$HERE/rehearse-upgrade.sh" --image some-image --dump "$FAKEDUMP" --db-name stage_rehearse_x --expect-build-marker 'bad!'
probe "rehearse with a malformed plugin package pin" "must be NAME:64-hex-sha256" \
  bash "$HERE/rehearse-upgrade.sh" --image some-image --dump "$FAKEDUMP" --db-name stage_rehearse_x --expect-plugin-package 'a:xyz'

# --- 5. the drain.sh restart <-> pre-restart-check.sh flag contract ------------
# Run the exact flag shape drain.sh restart passes (state dir + backup dir +
# age + acks + requires) against a scratch dir with the shim docker: arg
# parsing must ACCEPT the flags (rc=1 gate failure on the missing live env,
# never rc=2 refusal). A contract break here is a restart that can never
# start. The shim exits 99 if ever invoked, so a vacuous pass is impossible:
# precheck's dbq calls would surface as exit 99, failing this probe loudly.
contract_state="$(mktemp -d)"
contract_backup="$contract_state/backup"
mkdir -p "$contract_backup"
: > "$contract_state/drained_at"
if env DOCKER="$SHIMD/docker" bash "$HERE/pre-restart-check.sh" \
    --state-dir "$contract_state" --backup-dir "$contract_backup" \
    --max-backup-age-mins 120 --ack-orphans 0 \
    --require 0280 --require 0281 --require 0282 --require 0283 \
    >"$LOGD/contract.log" 2>&1; then
  oops "contract probe unexpectedly PASSED without a live env (expected gate FAIL, not success)"
else
  rc=$?
  if ((rc == 1)) && grep -qF -- 'FAIL:' "$LOGD/contract.log"; then
    pass "restart/precheck flag contract: flags accepted, gates ran (FAIL on missing live env, not refusal)"
  elif ((rc == 99)); then
    oops "contract probe hit the docker shim (a gate invoked docker before refusing)"
  else
    cp "$LOGD/contract.log" ./test-offline.contract.FAILED.log
    oops "restart/precheck flag contract broken: rc=$rc (saved as ./test-offline.contract.FAILED.log)"
  fi
fi
rm -rf "$contract_state" "$SHIMD"


# --- 6. rehearsal package manifest + new-tool wiring -----------------------------
# The package manifest pins the digest and migrations the operator rehearses.
# The two wake-driven tools ride the same manifest: the rehearsal is only
# meaningful when the BOOTED artifact contains the patched build (section 7)
# and the expected plugin set (section 8).
if jq -e '.expectedImageSha256 and (.requiredMigrations | length >= 4)' \
    "$HERE/rehearsal-package.example.json" >/dev/null 2>&1; then
  pass "rehearsal-package.example.json: digest + required migrations pinned"
else
  oops "rehearsal-package.example.json missing digest or required migrations"
fi

# --- 7. effective-build provenance in --path mode (no Docker) ------------------
# Synthetic EPIPE fixture (self-contained: no fork source needed): one file
# with the marker, one without. Positive PROVEN, absent-marker UNPROVEN,
# wrong-hash UNPROVEN, then the refusal probes. A vacuous pass is impossible:
# every success path requires the PROVEN line on stdout AND exit 0.
FIXD="$(mktemp -d)"
printf '// synthetic patched build\nstdin.on("error", (e) => { if (e.code === "EPIPE") return; });\n' > "$FIXD/patched.ts"
printf '// synthetic stale build\nstdin.on("error", (e) => { throw e; });\n' > "$FIXD/stale.ts"
FIXH="$(sha256sum -- "$FIXD/patched.ts" | cut -d' ' -f1)"
if bash "$HERE/effective-build-check.sh" --path "$FIXD/patched.ts" \
    --require-marker EPIPE --expect-sha256 "$FIXH" >"$LOGD/ebc-pos.log" 2>&1 \
    && grep -q '^EFFECTIVE_BUILD PROVEN' "$LOGD/ebc-pos.log"; then
  pass "effective-build: patched fixture PROVEN (hash + marker)"
else
  oops "effective-build: patched fixture did not PROVE"
fi
if bash "$HERE/effective-build-check.sh" --path "$FIXD/stale.ts" \
    --require-marker EPIPE >"$LOGD/ebc-neg.log" 2>&1; then
  oops "effective-build: stale fixture without the marker PROVED (must not)"
else
  (( $? == 1 )) && grep -q 'absent from every collected file' "$LOGD/ebc-neg.log" \
    && pass "effective-build: stale fixture UNPROVEN (marker absent)" \
    || oops "effective-build: stale fixture failed wrongly (want exit 1, marker-absent)"
fi
if bash "$HERE/effective-build-check.sh" --path "$FIXD/patched.ts" \
    --expect-sha256 0000000000000000000000000000000000000000000000000000000000000000 \
    >"$LOGD/ebc-hash.log" 2>&1; then
  oops "effective-build: wrong expected hash PROVED (must not)"
else
  (( $? == 1 )) && grep -q 'matched no collected file' "$LOGD/ebc-hash.log" \
    && pass "effective-build: wrong-hash UNPROVEN (exit 1)" \
    || oops "effective-build: wrong-hash probe failed wrongly"
fi
probe "effective-build without a target" "a target is required" \
  bash "$HERE/effective-build-check.sh" --require-marker EPIPE
probe "effective-build with a malformed hash" "must be 64 lowercase hex" \
  bash "$HERE/effective-build-check.sh" --path "$FIXD/patched.ts" --expect-sha256 xyz
probe "effective-build with a missing file" "is not a readable regular file" \
  bash "$HERE/effective-build-check.sh" --path "$FIXD/no-such.ts"
probe "effective-build package pin in --path mode" "need --image or --container" \
  bash "$HERE/effective-build-check.sh" --path "$FIXD/patched.ts" --expect-plugin-package 'x:0000000000000000000000000000000000000000000000000000000000000000'
probe "effective-build with a path-walking package pin" "no .." \
  env DOCKER="$SHIMD/docker" bash "$HERE/effective-build-check.sh" --image some-image --expect-plugin-package '../../etc:0000000000000000000000000000000000000000000000000000000000000000'
# The embedded node resolver, VERBATIM: the NODEJS= line is extracted from the
# script itself (no copy-paste drift) and eval'd under real node against a
# synthetic tree. Proves the exact shipped string resolves, hashes, reports
# UNRESOLVABLE and terminates with the sentinel. Skip only when node itself
# is missing (the script refuses there too: it needs node on the operator
# host for --image/--container resolution).
NODEJSD="$(mktemp -d)"
mkdir -p "$NODEJSD/node_modules/synth-pkg"
printf '{"name":"synth-pkg","version":"0.0.1"}\n' > "$NODEJSD/node_modules/synth-pkg/package.json"
SYNTHH="$(sha256sum -- "$NODEJSD/node_modules/synth-pkg/package.json" | cut -d' ' -f1)"
if command -v node >/dev/null; then
  if ( cd "$NODEJSD" && JS_NAMES='"synth-pkg","no-such-pkg"' \
        && eval "$(grep '^NODEJS=' "$HERE/effective-build-check.sh")" \
        && node -e "$NODEJS" >"$LOGD/nodejs-verbatim.log" 2>&1 ) \
      && grep -q "^PKGHASH:synth-pkg|$SYNTHH" "$LOGD/nodejs-verbatim.log" \
      && grep -q '^PKG:no-such-pkg=UNRESOLVABLE' "$LOGD/nodejs-verbatim.log" \
      && grep -q '^PKGDONE' "$LOGD/nodejs-verbatim.log"; then
    pass "effective-build: embedded node resolver executes verbatim (resolve+hash+UNRESOLVABLE+sentinel)"
  else
    oops "effective-build: embedded node resolver did not execute verbatim (see $LOGD/nodejs-verbatim.log)"
  fi
else
  say "skip: node missing; verbatim resolver execution not run"
fi
rm -rf "$NODEJSD"
# Live fork source when present beside the run (real pass, never assumed):
# the EPIPE guard must be present in the exact source the candidate
# build compiles.
LIVE_SU="${PAPERCLIP_UPGRADE_SERVER_UTILS_SRC:-$FORK_DIR/packages/adapter-utils/src/server-utils.ts}"
if [[ -f "$LIVE_SU" ]]; then
  LIVEH="$(sha256sum -- "$LIVE_SU" | cut -d' ' -f1)"
  if bash "$HERE/effective-build-check.sh" --path "$LIVE_SU" \
      --require-marker EPIPE --expect-sha256 "$LIVEH" >"$LOGD/ebc-live.log" 2>&1 \
      && grep -q '^EFFECTIVE_BUILD PROVEN' "$LOGD/ebc-live.log"; then
    pass "effective-build: fork server-utils source PROVEN ($LIVEH)"
  else
    oops "effective-build: fork server-utils source did not PROVE (see $LOGD/ebc-live.log)"
  fi
else
  say "skip: fork server-utils source missing; synthetic-fixture proof only"
fi
rm -rf "$FIXD"

# --- 7b. pinned files + legacy 916 redaction refusal (emulated runtime) ---------
# An EMULATING docker stub (not the fail-loud shim): it answers only the calls
# effective-build-check.sh makes, and runs the checker's OWN remote sh scripts
# against a fake root ($EMU_ROOT/app stands in for the image's /app), so the
# shipped probe strings execute verbatim. Any other docker call exits 98.
# Mount tables (EMU_MOUNTS) and compose config (EMU_COMPOSE) are fed as JSON.
# Every success requires exit 0 plus the PROVEN line; every failure requires
# the exact exit code plus the specific FAIL text, so no case passes vacuously.
EMUD="$(mktemp -d)"
cat >"$EMUD/docker" <<'EMU'
#!/usr/bin/env bash
root="${EMU_ROOT:?}"
run_sh() { # SCRIPT -- /app -> $root/app, run, map paths back
  local s="${1//\/app\//$root/app/}" out
  out="$(sh -c "$s")" || return 1
  out="${out//"$root"/}"
  [[ -n "${EMU_DROP_SENTINEL:-}" ]] && out="$(grep -vx XPROBEDONE <<<"$out")"
  [[ -n "${EMU_DROP_XLINES:-}" ]] && out="$(grep -vE '^X(HASH|MISSING|UNREADABLE):' <<<"$out")"
  printf '%s\n' "$out"
}
case "$1" in
  image)
    case "$4" in
      '{{.Id}}') echo "sha256:$(printf '%064d' 7)" ;;
      '{{json .RepoDigests}}') echo '[]' ;;
      *) exit 98 ;;
    esac ;;
  inspect)
    case "$3" in
      '{{.Image}}') echo "sha256:$(printf '%064d' 7)" ;;
      '{{json .Mounts}}') [[ -n "${EMU_MOUNTS_FAIL:-}" ]] && exit 1; printf '%s\n' "${EMU_MOUNTS-[]}" ;;
      *) exit 98 ;;
    esac ;;
  run)
    shift; ep=""
    while (($#)); do
      case "$1" in
        --entrypoint) ep="$2"; shift 2; break ;;
        *) shift ;;
      esac
    done
    shift # the image ref
    case "$ep:$1" in
      sh:-c) run_sh "$2" ;;
      node:-e) echo 'RESOLVE:@paperclipai/adapter-utils=UNRESOLVABLE' ;;
      *) exit 98 ;;
    esac ;;
  exec)
    [[ "$3:$4" == "sh:-c" ]] || exit 98
    run_sh "$5" ;;
  compose)
    [[ -n "${EMU_COMPOSE_FAIL:-}" ]] && exit 1
    printf '%s' "${EMU_COMPOSE-}" ;;
  *) exit 98 ;;
esac
EMU
chmod +x "$EMUD/docker"
EMU="$EMUD/docker"
mkroot() { # DIR SERVER_UTILS_TEXT REDACTION_TEXT
  mkdir -p "$1/app/packages/adapter-utils/src" "$1/app/server/dist"
  printf '%s\n' "$2" > "$1/app/packages/adapter-utils/src/server-utils.ts"
  printf '%s\n' "$3" > "$1/app/server/dist/redaction.js"
}
RD=/app/server/dist/redaction.js
mkroot "$EMUD/good" 'stdin.on("error", (e) => { if (e.code === "EPIPE") return; });' '// synthetic 1001 compiled redaction'
mkroot "$EMUD/split" 'stdin.on("error", (e) => { throw e; });' '// EPIPE appears only in the redaction file'
RH="$(sha256sum -- "$EMUD/good/app/server/dist/redaction.js" | cut -d' ' -f1)"
SH="$(sha256sum -- "$EMUD/split/app/server/dist/redaction.js" | cut -d' ' -f1)"
Z64=0000000000000000000000000000000000000000000000000000000000000000
emu() { # DESC WANT_RC NEEDLE ROOT -- checker args... (env EMU_* passed through)
  local desc="$1" want="$2" needle="$3" root="$4"; shift 4
  local out rc
  out="$(env EMU_ROOT="$EMUD/$root" DOCKER="$EMU" bash "$HERE/effective-build-check.sh" "$@" 2>&1)"; rc=$?
  if ((rc == want)) && grep -qF -- "$needle" <<<"$out" \
      && { ((want != 0)) || grep -qx 'EFFECTIVE_BUILD PROVEN' <<<"$out"; }; then
    pass "pinned/916: $desc"
  else
    oops "pinned/916 '$desc': rc=$rc want $want with '$needle' (got: $(tr '\n' ' ' <<<"$out" | head -c 240))"
  fi
}
emu "image: pinned file matches, 916 refused, PROVEN" 0 "ok: pinned file $RD in image:" good \
  --image cand --require-marker EPIPE --expect-file "$RD:$RH" --forbid-916-redaction
emu "image: forbid-mount reports n/a (images carry no mounts)" 0 "n/a: forbid-mount $RD" good \
  --image cand --require-marker EPIPE --forbid-916-redaction
emu "image: pinned hash mismatch FAILS" 1 "is $RH, expected $Z64" good \
  --image cand --require-marker EPIPE --expect-file "$RD:$Z64"
emu "image: pinned file MISSING FAILS" 1 "is MISSING, expected $RH" good \
  --image cand --require-marker EPIPE --expect-file "/app/server/dist/no-such.js:$RH"
emu "image: forbidden file content FAILS" 1 "still carries forbidden build $RH at $RD" good \
  --image cand --require-marker EPIPE --forbid-file "$RD:$RH"
EMU_DROP_SENTINEL=1 emu "image: dropped pinned-probe sentinel FAILS" 1 "pinned-file probe of image:" good \
  --image cand --require-marker EPIPE --expect-file "$RD:$RH"
EMU_DROP_XLINES=1 emu "image: pinned path never reported FAILS" 1 "pinned file $RD was not reported by image:" good \
  --image cand --require-marker EPIPE --expect-file "$RD:$RH"
EMU_DROP_XLINES=1 emu "image: forbidden path never reported FAILS" 1 "could not read it in image:" good \
  --image cand --require-marker EPIPE --forbid-916-redaction
emu "marker in redaction.js never satisfies the server-utils marker" 1 "absent from every collected file" split \
  --image cand --require-marker EPIPE --expect-file "$RD:$SH"
EMU_MOUNTS='[{"Type":"volume","Destination":"/paperclip"}]' \
  emu "container: unrelated mount PROVEN" 0 "ok: no mount covers $RD in stage" good \
  --container stage --require-marker EPIPE --expect-file "$RD:$RH" --forbid-916-redaction
EMU_MOUNTS='[{"Type":"bind","Destination":"/app/server/dist-old"}]' \
  emu "container: sibling-prefix mount is not a false positive" 0 "ok: no mount covers" good \
  --container stage --require-marker EPIPE --forbid-916-redaction
for md in "$RD" /app/server/dist /app/server/dist/ /app /; do
  EMU_MOUNTS="[{\"Type\":\"bind\",\"Destination\":\"$md\"}]" \
    emu "container: mount $md over the redaction path FAILS" 1 "mount $md covers forbidden path $RD" good \
    --container stage --require-marker EPIPE --forbid-916-redaction
done
EMU_MOUNTS='{"Destination":"/x"}' emu "container: non-array mount table FAILS" 1 "unparseable mount table of stage" good \
  --container stage --require-marker EPIPE --forbid-916-redaction
EMU_MOUNTS='[{"Source":"/x"}]' emu "container: mount without Destination FAILS" 1 "unparseable mount table of stage" good \
  --container stage --require-marker EPIPE --forbid-916-redaction
EMU_MOUNTS='' emu "container: empty mount table FAILS" 1 "cannot read the mount table of stage" good \
  --container stage --require-marker EPIPE --forbid-916-redaction
EMU_MOUNTS_FAIL=1 emu "container: unreadable mount table FAILS" 1 "cannot read the mount table of stage" good \
  --container stage --require-marker EPIPE --forbid-916-redaction
probe "forbid-916 in --path mode" "need --image or --container" \
  bash "$HERE/effective-build-check.sh" --path "$EMUD/good/app/server/dist/redaction.js" --no-marker-check --forbid-916-redaction
for bad in "app/server/dist/redaction.js:$RH" "/app/../etc/passwd:$RH" "/app/server/dist/:$RH" \
           "/app//x.js:$RH" '/app/x;id:'"$RH" "$RD:XYZ" "$RD"; do
  probe "expect-file '$bad'" "must be ABS:64-hex-sha256" \
    env DOCKER="$EMU" EMU_ROOT="$EMUD/good" bash "$HERE/effective-build-check.sh" --image cand --expect-file "$bad"
done
probe "forbid-mount relative" "--forbid-mount must be an absolute clean path" \
  env DOCKER="$EMU" EMU_ROOT="$EMUD/good" bash "$HERE/effective-build-check.sh" --container stage --forbid-mount app/x
probe "drain verify --expect-file relative" "--expect-file must be ABS:64-hex-sha256" \
  env DOCKER="$EMU" bash "$HERE/drain.sh" verify --state-dir /nonexistent --live --expect-file "app/x.js:$RH"
probe "rehearse --expect-file with .." "--expect-file/expectedFiles must be ABS" \
  env DOCKER="$EMU" bash "$HERE/rehearse-upgrade.sh" --image some-image --dump "$FAKEDUMP" \
    --db-name stage_rehearse_x --expect-file "/app/../x:$RH"
jq -n --arg h "$RH" '{expectedFiles: ["server/dist/redaction.js:" + $h]}' > "$EMUD/pkg.json"
probe "rehearse package expectedFiles relative" "--expect-file/expectedFiles must be ABS" \
  env DOCKER="$EMU" bash "$HERE/rehearse-upgrade.sh" --image some-image --dump "$FAKEDUMP" \
    --db-name stage_rehearse_x --package "$EMUD/pkg.json"
# Wiring: the 916 refusal is unconditional in the rehearsal bundle and in
# drain's upgrade-mode bundle, and absent from drain's rollback bundle.
grep -q '^EBC_ARGS+=(--forbid-916-redaction)$' "$HERE/rehearse-upgrade.sh" \
  && pass "rehearse: --forbid-916-redaction is unconditional in EBC_ARGS" \
  || oops "rehearse: --forbid-916-redaction not wired unconditionally"
if ( eval "$(awk '/^ebc_args\(\) \{/,/^}$/' "$HERE/drain.sh")"
     STATE_DIR="$EMUD/st"; mkdir -p "$STATE_DIR"
     st() { printf '%s/%s' "$STATE_DIR" "$1"; }; have() { [[ -s "$STATE_DIR/$1" ]]; }
     get() { cat "$STATE_DIR/$1"; }; log() { :; }
     # cmd_restart's pin block, verbatim, writes eb-file from --expect-file.
     eval "pin_block() { $(awk '/^  : > "\$\(st eb-sha.tmp\)"/,/^  mv -f -- "\$\(st eb-file.tmp\)" "\$\(st eb-file\)"$/' "$HERE/drain.sh"); }"
     BUILD_SHA=(); PLUGIN_PKGS=(); EXPECT_FILES=("$RD:$RH"); pin_block
     printf 'EPIPE\n' > "$(st eb-marker)"
     ebc_args upgrade; up=" ${EBC_ARGS[*]} "
     ebc_args rollback; rb=" ${EBC_ARGS[*]} "
     [[ "$up" == *" --forbid-916-redaction "* && "$up" == *" --expect-file $RD:$RH "* \
        && "$rb" != *916* && "$rb" != *--expect-file* ]] ); then
  pass "drain restart pin + ebc_args (verbatim): upgrade pins eb-file + forbids 916; rollback carries neither"
else
  oops "drain ebc_args (verbatim): upgrade/rollback policy split is wrong"
fi
# Call sites (structural: the commands need a live host to run end to end).
# Per function body, the order of the overlay check vs compose_up: restart
# checks the plain and the held compose before recreating; undrain checks
# unless the state is a rollback; rollback (back to 916) never checks.
callseq() { # FUNC -- "C" per overlay check, "G" per rollback-gated check, "U" per compose_up, in order
  awk -v f="$1" '$0 ~ "^"f"\\(\\) \\{" {on=1; next} on && /^}$/ {exit}
    on && /have rolledback_at \|\| compose_no_legacy_overlay/ {printf "G"; next}
    on && /^[[:space:]]*compose_no_legacy_overlay/ {printf "C"}
    on && /^[[:space:]]*compose_up/ {printf "U"}' "$HERE/drain.sh"
}
[[ "$(callseq cmd_restart)" == CCU && "$(callseq cmd_undrain)" == GU && "$(callseq cmd_rollback)" == U ]] \
  && grep -q '^  compose_no_legacy_overlay "$(st hold.override.yaml)"$' "$HERE/drain.sh" \
  && pass "drain call sites: restart CCU (plain + held), undrain GU (skipped after rollback), rollback U" \
  || oops "drain call sites wrong: restart '$(callseq cmd_restart)' undrain '$(callseq cmd_undrain)' rollback '$(callseq cmd_rollback)'"
# drain's compose_no_legacy_overlay, executed VERBATIM (extracted from
# drain.sh) against an emulated `docker compose config --format json`.
co() { # DESC WANT_RC NEEDLE COMPOSE_JSON
  local out rc
  out="$( eval "$(grep '^LEGACY_REDACTION_DEST=' "$HERE/drain.sh")"
          eval "$(awk '/^compose_no_legacy_overlay\(\) \{/,/^}$/' "$HERE/drain.sh")"
          fail() { printf 'ERROR: %s\n' "$*"; exit 1; }; log() { printf '%s\n' "$*"; }
          DOCKER="$EMU" COMPOSE_FILE=/nonexistent/compose.yaml SERVER_SERVICE=server EMU_ROOT=/nonexistent EMU_COMPOSE="$4"
          export EMU_ROOT EMU_COMPOSE
          compose_no_legacy_overlay 2>&1 )"; rc=$?
  if ((rc == $2)) && grep -qF -- "$3" <<<"$out"; then pass "drain compose overlay: $1"
  else oops "drain compose overlay '$1': rc=$rc want $2 with '$3' (got: $(tr '\n' ' ' <<<"$out" | head -c 200))"; fi
}
co "unrelated bind mount passes" 0 "mounts nothing over /app/server/dist/redaction.js" \
  '{"services":{"server":{"volumes":[{"type":"bind","source":"/srv/data","target":"/paperclip"}]}}}'
co "no volumes passes" 0 "mounts nothing over" '{"services":{"server":{"image":"x"}}}'
co "sibling-prefix target passes" 0 "mounts nothing over" \
  '{"services":{"server":{"volumes":[{"type":"bind","source":"/a","target":"/app/server/dist-old"}]}}}'
for tg in "$RD" /app/server/dist /app/server/ /; do
  co "target $tg refuses" 1 "still mounts $tg over $RD" \
    "{\"services\":{\"server\":{\"volumes\":[{\"type\":\"bind\",\"source\":\"/h/redaction.js\",\"target\":\"$tg\",\"read_only\":true}]}}}"
done
co "missing service refuses" 1 "cannot read the volumes" '{"services":{"other":{}}}'
co "volume without target refuses" 1 "cannot read the volumes" '{"services":{"server":{"volumes":[{"type":"bind","source":"/a"}]}}}'
co "unparseable config refuses" 1 "cannot read the volumes" 'not json'
EMU_COMPOSE_FAIL=1 co "compose config failure refuses" 1 "compose config failed" '{}'
co "empty compose config refuses" 1 "compose config failed" ''
# Constants agree across scripts, and with the operator handoff when present
# (a real pass, never assumed): the checker's 916 hash is the captured live
# overlay, and that exact file in the fake root is refused.
CKD="$(sed -n 's/^LEGACY_REDACTION_DEST="\(.*\)"$/\1/p' "$HERE/effective-build-check.sh")"
CKH="$(sed -n 's/^LEGACY_REDACTION_SHA256="\(.*\)"$/\1/p' "$HERE/effective-build-check.sh")"
DRD="$(sed -n 's/^LEGACY_REDACTION_DEST="\(.*\)"$/\1/p' "$HERE/drain.sh")"
[[ "$CKD" == "$RD" && "$DRD" == "$RD" && "$CKH" =~ ^[0-9a-f]{64}$ ]] \
  && pass "legacy redaction path agrees across checker and drain ($RD)" \
  || oops "legacy redaction constants disagree (checker '$CKD', drain '$DRD', hash '$CKH')"
RHAND="${PAPERCLIP_UPGRADE_REDACTION_HANDOFF:-${HANDOFF_DIR:-$HOME/handoff}/redaction}"
if [[ -f "$RHAND/manifest.json" && -f "$RHAND/live-916-redaction.js" ]]; then
  [[ "$(jq -r .liveOverlaySHA256 "$RHAND/manifest.json")" == "$CKH" \
     && "$(sha256sum -- "$RHAND/live-916-redaction.js" | cut -d' ' -f1)" == "$CKH" ]] \
    && pass "legacy redaction hash equals the handoff liveOverlaySHA256 and the captured file" \
    || oops "legacy redaction hash does not match the operator handoff"
  mkroot "$EMUD/legacy" 'stdin.on("error", (e) => { if (e.code === "EPIPE") return; });' ''
  cp -- "$RHAND/live-916-redaction.js" "$EMUD/legacy/app/server/dist/redaction.js"
  emu "the captured 916 override in the image is refused" 1 "still carries forbidden build $CKH at $RD" legacy \
    --image cand --require-marker EPIPE --forbid-916-redaction
else
  say "skip: redaction handoff missing; synthetic 916 refusal proof only"
fi
rm -rf "$EMUD"

# --- 8. plugin-inventory checker on a synthetic fixture (no handoff) ------------
# Minimal 2-plugin fixture exercising every gate: correct shape PROVES;
# each mutation below must FAIL. The approved operator handoff is validated
# opportunistically afterwards (a real pass, never assumed).
make_inv() { # OUT [MODE] -- MODE one of: good wrongcount secretid strayuuid
  local out="$1" mode="${2:-good}"
  python3 - "$out" "$mode" <<'PY'
import json, sys
out, mode = sys.argv[1], sys.argv[2]
def plug(key, status, path, sbc, vid):
    return {"id": vid, "pluginKey": key, "packageName": "pkg-" + key,
            "path": path, "version": "0.1.0", "apiVersion": 1, "status": status,
            "manifest": {"id": key}, "configSha256": "0" * 64,
            "secretBindingCount": sbc, "safeModes": [],
            "fileHashes": {"dist/worker.js": "1" * 64},
            "sdkDependency": None, "sdkPeer": "*"}
inv = {"plugins": [
    plug("alpha", "ready", "/pkgs/alpha", 1,
         "11111111-1111-1111-1111-111111111111"),
    plug("togetherweown.model-selection", "ready",
         "/pkgs/model-selection-0.4.0-main175996fb7", 2,
         "22222222-2222-2222-2222-222222222222"),
    plug("omniroute-broker", "disabled", "/pkgs/omni", 0,
         "33333333-3333-3333-3333-333333333333")]}
if mode == "wrongcount":
    inv["plugins"] = inv["plugins"][:2]
elif mode == "secretid":
    inv["plugins"][0]["manifest"] = {"id": "alpha", "secretId": "44444444-4444-4444-4444-444444444444"}
elif mode == "strayuuid":
    inv["plugins"][0]["manifest"] = {"id": "alpha", "someRef": "55555555-5555-5555-5555-555555555555"}
json.dump(inv, open(out, "w"))
PY
}
INVD="$(mktemp -d)"
make_inv "$INVD/good.json" good
INV_BASE=(--expect-count 3 --expect-selector 175996fb7)
if python3 "$HERE/check-plugin-inventory.py" --inventory "$INVD/good.json" \
    "${INV_BASE[@]}" >"$LOGD/inv-pos.log" 2>&1 \
    && grep -q '^PLUGIN_INVENTORY PROVEN' "$LOGD/inv-pos.log"; then
  pass "plugin-inventory: synthetic fixture PROVEN (3 plugins, selector, retired-disabled)"
else
  oops "plugin-inventory: synthetic fixture did not PROVE"
fi
for mode in wrongcount secretid strayuuid; do
  make_inv "$INVD/$mode.json" "$mode"
  if python3 "$HERE/check-plugin-inventory.py" --inventory "$INVD/$mode.json" \
      "${INV_BASE[@]}" >"$LOGD/inv-$mode.log" 2>&1; then
    oops "plugin-inventory: $mode fixture PROVED (must FAIL)"
  else
    pass "plugin-inventory: $mode fixture FAILS as required"
  fi
done
# Approved operator handoff when present (informational-but-real: exit code
# decides; never a vacuous pass).
HANDOFF="${PAPERCLIP_UPGRADE_PLUGIN_INVENTORY:-${HANDOFF_DIR:-$HOME/handoff}/plugin-inventory/inventory.json}"
if [[ -f "$HANDOFF" ]]; then
  if python3 "$HERE/check-plugin-inventory.py" --inventory "$HANDOFF" \
      >"$LOGD/inv-handoff.log" 2>&1 \
      && grep -q '^PLUGIN_INVENTORY PROVEN' "$LOGD/inv-handoff.log"; then
    pass "plugin-inventory: approved operator handoff PROVEN ($(grep -c '^ok:' "$LOGD/inv-handoff.log") gates)"
  else
    oops "plugin-inventory: approved operator handoff did not PROVE (see $LOGD/inv-handoff.log)"
  fi
else
  say "skip: approved operator handoff missing; synthetic-fixture proof only"
fi
rm -rf "$INVD"

# --- 9. umask_gate() against a canned docker (verbatim, no Docker) -------------
# The gate function is extracted from drain.sh itself (no copy-paste drift)
# and run in a stub shell that provides only `log` and the `DOCKER`/`LOG`
# env the gate needs. The fake docker answers ONLY the exact PID-1-status
# exec (`-u node <container> grep ^Umask: /proc/1/status`); any other
# invocation exits 99 so a gate that probed the wrong thing (for example a
# naive `docker exec ... umask` call) fails loudly instead of passing.
# A vacuous pass is impossible: success requires the ok line AND exit 0.
UMASKD="$(mktemp -d)"
sed -n '/^umask_gate() {/,/^}/p' "$HERE/drain.sh" > "$UMASKD/gate.sh"
[[ -s "$UMASKD/gate.sh" ]] \
  || { oops "umask_gate: could not extract the gate verbatim from drain.sh"; }
if [[ -s "$UMASKD/gate.sh" ]]; then
  umask_case() { # CASE UMASK_VALUE WANT_RC WANT_NEEDLE
    local case="$1" val="$2" want_rc="$3" needle="$4"
    local shim="$UMASKD/shim-$case" rc=0
    printf 'Umask:\t%s\n' "$val" > "$shim.answer"
    cat >"$shim" <<SHIM
#!/usr/bin/env bash
# fake docker: answer only the exact PID-1 Umask exec, else exit 99
if [[ "\$1 \$2 \$3 \$4 \$5 \$6 \$7" == "exec -u node mock-server grep ^Umask: /proc/1/status" ]]; then
  cat "$shim.answer"; exit 0
fi
echo "FATAL: umask shim invoked outside the PID-1 probe: \$*" >&2; exit 99
SHIM
    chmod +x "$shim"
    if ( DOCKER="$shim" SERVER_CONTAINER="mock-server" LOG="/dev/null"
         log() { printf '%s\n' "$*"; }
         . "$UMASKD/gate.sh"
         umask_gate >"$LOGD/umask-$case.log" 2>&1 ); then rc=0; else rc=$?; fi
    if ((rc == want_rc)) && grep -qF -- "$needle" "$LOGD/umask-$case.log"; then
      pass "umask_gate: $case (rc=$rc)"
    else
      oops "umask_gate: $case: rc=$rc, want rc=$want_rc containing '$needle' (got: $(head -c 160 "$LOGD/umask-$case.log"))"
    fi
  }
  umask_case good 0077 0 "ok: container PID 1 umask 0077"
  umask_case stale 0022 1 "FAIL: container PID 1 umask is '0022'"
  # exec failure: shim answers nothing useful (exits 99) -> gate must FAIL
  cat >"$UMASKD/shim-execfail" <<'SHIM'
#!/usr/bin/env bash
echo "FATAL: docker unavailable" >&2; exit 99
SHIM
  chmod +x "$UMASKD/shim-execfail"
  if ( DOCKER="$UMASKD/shim-execfail" SERVER_CONTAINER="mock-server" LOG="/dev/null"
       log() { printf '%s\n' "$*"; }
       . "$UMASKD/gate.sh"
       umask_gate >"$LOGD/umask-execfail.log" 2>&1 ); then rc=0; else rc=$?; fi
  if ((rc == 1)) && grep -qF -- "FAIL: container umask unreadable" "$LOGD/umask-execfail.log"; then
    pass "umask_gate: exec failure FAILS closed (rc=1)"
  else
    oops "umask_gate: exec failure: rc=$rc (want 1 with the unreadable line)"
  fi
  # wiring: the gate must be called from verify_held, else the unit proof is
  # vacuous (a passing but never-invoked gate).
  if grep -q '^[[:space:]]*umask_gate || rc=1' "$HERE/drain.sh"; then
    pass "umask_gate: wired into verify_held (umask_gate || rc=1)"
  else
    oops "umask_gate: not wired into verify_held (no 'umask_gate || rc=1' line)"
  fi
fi
rm -rf "$UMASKD"

say "TEST-OFFLINE $( ((FAIL == 0)) && echo PASSED || echo FAILED )"
exit "$FAIL"
