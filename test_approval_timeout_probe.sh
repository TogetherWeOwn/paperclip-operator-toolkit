#!/usr/bin/env bash
# ===========================================================================
# Offline regression suite for approval_timeout_probe.sh.
#
# WHY IT RUNS ANYWHERE. The probe reads two things it does not own: a compiled
# Paperclip server bundle and a PostgreSQL. Both are faked here — a synthetic
# .js tree built to the same shape as the real one, and a `psql` on PATH that
# answers with a canned row. Nothing in this file needs the platform.
#
# FAKING RATHER THAN SKIPPING. A suite that skips the database half when psql
# is absent passes on every runner in the world while that half is broken. The
# fakes are always present, so both halves always execute.
#
# THE BASELINE ASSERTION IS NOT DECORATION. Every mutation below is only
# meaningful if the UNMUTATED fixture passes: a probe that returned DRIFT for
# everything would satisfy all eight mutation cases and be worthless. Case 1
# is the one that gives the other seven their meaning.
#
# THE MOST IMPORTANT CASES ARE THE ONES THAT MUST *NOT* GO RED.
# `setTimeout` (case 9) is the mistake the probe's first draft actually made:
# A3 asked whether a module paired the table with any timer, and the real
# bundle has four `setTimeout`s that are abort controllers and retry sleeps.
# That red meant nothing, and a red that means nothing is one people learn to
# wave through. And case 13 — an empty count from a query that returned no row
# — is the failure mode where bash scores "" as 0 and a measurement that never
# happened reports "clean".
#
# WHAT IS DELIBERATELY NOT CLAIMED: this proves the probe reads a bundle and a
# result set correctly. That the real Paperclip bundle has the shape asserted
# in case 15 is proved by running the probe against it, not by this file.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="$HERE/approval_timeout_probe.sh"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[ -f "$PROBE" ] || { echo "missing $PROBE" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

# --- the fake bundle --------------------------------------------------------
# Built to the same shape as dist/services/tool-gateway.js and
# dist/services/tool-access-policy.js, including BOTH guard formattings: the
# real bundle wraps one enforcement site across lines and keeps the other on
# one, which is exactly why the probe collapses whitespace before matching.
make_fixture() {
  local dir="$1"; rm -rf "$dir"; mkdir -p "$dir/services"
  cat >"$dir/services/tool-access-policy.js" <<'JS'
async function recordInvocation(ctx, invocation) {
    let actionRequest;
    [actionRequest] = await db.insert(toolActionRequests).values({
        companyId: ctx.companyId,
        invocationId: invocation.id,
        status: "pending",
        canonicalArgumentsHash: invocation.argumentsHash,
    }).returning();
    return { ok: true, invocation, actionRequest };
}
JS
  cat >"$dir/services/tool-gateway.js" <<'JS'
const MAX_SESSION_TTL_MS = 60 * 60 * 1000;
async function requestApproval(input) {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await db
        .update(toolActionRequests)
        .set({
        interactionId: interaction.id,
        signedArguments,
        expiresAt,
        updatedAt: new Date(),
    })
        .where(eq(toolActionRequests.id, actionRequest.id));
}
async function requestApprovalTestOrigin(input) {
    await db
        .update(toolActionRequests)
        .set({
        signedArguments,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        updatedAt: new Date(),
    })
        .where(eq(toolActionRequests.id, recorded.actionRequest.id));
}
async function matchingAgentActionRequest(match) {
    if (match.actionRequest.status === "pending"
        && match.actionRequest.expiresAt
        && match.actionRequest.expiresAt.getTime() <= Date.now()) {
        await db.update(toolActionRequests).set({ status: "expired" }).where(eq(toolActionRequests.id, match.actionRequest.id));
    }
}
async function replayApprovedAction(actionRequest) {
    if (actionRequest.expiresAt && actionRequest.expiresAt.getTime() <= Date.now()) {
        await db.update(toolActionRequests).set({ status: "expired" }).where(eq(toolActionRequests.id, actionRequest.id));
    }
}
const gateway = {
    async cleanupExpiredSessions(input = {}) {
        const now = input.now ?? new Date();
        return { deletedCount: 0 };
    },
};
JS
}

# Byte-level surgery on the fixture, one fact at a time.
mutate() { # mutate <dir> <file> <from> <to>
  local f="$1/services/$2"
  node -e '
    const fs = require("fs");
    const [f, from, to] = process.argv.slice(1);
    const t = fs.readFileSync(f, "utf8");
    if (!t.includes(from)) { console.error("fixture mutation found no target: " + from); process.exit(9); }
    fs.writeFileSync(f, t.replace(from, to));
  ' "$f" "$3" "$4" || { echo "MUTATION FAILED (fixture drifted)" >&2; return 9; }
}

run_bundle() { "$PROBE" bundle "$1" >"$WORK/out" 2>&1; echo $?; }

expect_bundle() { # expect_bundle <label> <dir> <code>
  local got; got="$(run_bundle "$2")"
  if [ "$got" = "$3" ]; then ok "$1 (exit $got)"
  else bad "$1 — expected exit $3, got $got"; sed 's/^/        /' "$WORK/out"; fi
}

# --- the fake database ------------------------------------------------------
# `pcsql_run` invokes `psql ... -f -`, so the fake reads SQL on stdin and
# dispatches: the preflight's `SELECT 1;` gets a 1, anything else gets the
# canned row in $FAKE_ROW. An empty $FAKE_ROW means "the query returned
# nothing", which is case 13.
cat >"$WORK/bin/psql" <<'FAKE'
#!/usr/bin/env bash
sql="$(cat)"
case "$sql" in
  *"SELECT 1;"*) printf '1\n' ;;
  *) [ -n "${FAKE_ROW:-}" ] && printf '%s\n' "$FAKE_ROW" ;;
esac
exit 0
FAKE
chmod +x "$WORK/bin/psql"

# Every rows case runs in a subshell with DATABASE_URL unset, so a real one in
# the ambient environment cannot reach a real database from a suite that
# believes it is talking to a fake.
run_rows() { # run_rows <FAKE_ROW> [extra PATH dir]
  (
    unset DATABASE_URL
    export PATH="${2:-$WORK/bin}:/usr/bin:/bin"
    export PAPERCLIP_SQL_BACKEND=psql PGHOST=fake PGDATABASE=fake
    export PAPERCLIP_COMPANY_ID=""
    export FAKE_ROW="$1"
    "$PROBE" rows >"$WORK/out" 2>&1
  )
  echo $?
}

expect_rows() { # expect_rows <label> <row> <code>
  local got; got="$(run_rows "$2")"
  if [ "$got" = "$3" ]; then ok "$1 (exit $got)"
  else bad "$1 — expected exit $3, got $got"; sed 's/^/        /' "$WORK/out"; fi
}

# ===========================================================================
hdr "the baseline — without this, every mutation below is meaningless"

FIX="$WORK/fixture"
make_fixture "$FIX"
expect_bundle "1  unmutated fixture reads as the documented defect" "$FIX" 0

hdr "each finding can actually fail (A1–A4)"

make_fixture "$FIX"
mutate "$FIX" tool-gateway.js '        expiresAt,
' '' && mutate "$FIX" tool-gateway.js '        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
' ''
expect_bundle "2  A1 no update site stamps a deadline    -> DRIFT" "$FIX" 3

make_fixture "$FIX"
mutate "$FIX" tool-access-policy.js 'status: "pending",' 'status: "pending", expiresAt: new Date(),'
expect_bundle "3  A1 the insert now stamps it at creation -> DRIFT" "$FIX" 3

make_fixture "$FIX"
mutate "$FIX" tool-gateway.js 'if (actionRequest.expiresAt && actionRequest.expiresAt.getTime() <= Date.now())' \
                              'if (actionRequest.expiresAt.getTime() <= Date.now())'
expect_bundle "4  A2 an enforcement site loses its guard  -> DRIFT" "$FIX" 3

make_fixture "$FIX"
mutate "$FIX" tool-gateway.js 'const MAX_SESSION_TTL_MS' 'setInterval(() => sweep(), 60000);
const MAX_SESSION_TTL_MS'
expect_bundle "5  A3 a sweep clock appears               -> DRIFT" "$FIX" 3

make_fixture "$FIX"
mutate "$FIX" tool-gateway.js 'const gateway = {' 'setInterval(() => gateway.cleanupExpiredSessions(), 60000);
const gateway = {'
expect_bundle "6  A4+A3 the dead sweeper gains a caller  -> DRIFT" "$FIX" 3

make_fixture "$FIX"
mutate "$FIX" tool-gateway.js '    async cleanupExpiredSessions(input = {}) {
        const now = input.now ?? new Date();
        return { deletedCount: 0 };
    },
' ''
expect_bundle "7  A4 the dead sweeper is deleted          -> DRIFT" "$FIX" 3

hdr "a finding that flips the RIGHT way is still drift, not a pass"

make_fixture "$FIX"
mutate "$FIX" tool-gateway.js 'const expiresAt = new Date(Date.now() + 60 * 60 * 1000);' \
                              'const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);'
expect_bundle "8  a longer TTL is not drift (value is not the defect)" "$FIX" 0

hdr "the reds that must not fire"

make_fixture "$FIX"
mutate "$FIX" tool-gateway.js 'const MAX_SESSION_TTL_MS' 'const t = setTimeout(() => controller.abort(), ms);
const u = setTimeout(() => retry(), 25);
const MAX_SESSION_TTL_MS'
expect_bundle "9  setTimeout is an abort, not a sweep -> still OK" "$FIX" 0

hdr "could-not-measure is never green"

mkdir -p "$WORK/empty"
expect_bundle "10 an empty tree            -> UNKNOWN" "$WORK/empty" 5

mkdir -p "$WORK/unrelated/services"
printf 'const x = 1;\n' >"$WORK/unrelated/services/other.js"
expect_bundle "11 a tree with no such table -> UNKNOWN" "$WORK/unrelated" 5

make_fixture "$FIX"
mutate "$FIX" tool-access-policy.js 'db.insert(toolActionRequests).values' 'db.insert(somethingElse).values'
expect_bundle "12 the insert anchor is gone -> UNKNOWN, not 'fixed'" "$FIX" 5

hdr "the database half"

expect_rows "13 a query that returned no row -> UNKNOWN, not clean" "" 5
expect_rows "14 zero rows                    -> OK"          "$(printf '0\t0\t0\t0\t0')"      0
expect_rows "15 rows, none stranded          -> OK"          "$(printf '4\t1\t0\t0\t120')"    0
expect_rows "16 a deadline that passed       -> STRANDED"    "$(printf '3\t2\t0\t2\t400000')" 4
expect_rows "17 a row never stamped          -> STRANDED"    "$(printf '1\t1\t1\t0\t99')"     4
expect_rows "18 a non-numeric count          -> UNKNOWN"     "$(printf 'x\t0\t0\t0\t0')"      5

mkdir -p "$WORK/nobin"
got="$(run_rows "$(printf '0\t0\t0\t0\t0')" "$WORK/nobin")"
if [ "$got" = "5" ]; then ok "19 no psql on PATH -> UNKNOWN (exit 5)"
else bad "19 no psql on PATH — expected exit 5, got $got"; sed 's/^/        /' "$WORK/out"; fi

hdr "usage"

"$PROBE" --help >/dev/null 2>&1
[ $? -eq 0 ] && ok "20 --help exits 0" || bad "20 --help exits 0"
"$PROBE" --nonsense >/dev/null 2>&1
[ $? -eq 2 ] && ok "21 an unknown option is REFUSED (exit 2)" || bad "21 an unknown option is REFUSED (exit 2)"
"$PROBE" nonsense >/dev/null 2>&1
[ $? -eq 2 ] && ok "22 an unknown command is REFUSED (exit 2)" || bad "22 an unknown command is REFUSED (exit 2)"

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
