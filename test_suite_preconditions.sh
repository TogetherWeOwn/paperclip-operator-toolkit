#!/usr/bin/env bash
# Regression suite for the two guards added in TOG-402, and for the failure
# mode they exist to stop.
#
# THE BUG. test_request_queue.sh and test_privilege_ceilings.sh both asserted
# refusals with a helper that accepted ANY refusal:
#
#   must_refuse() { ... if [[ $rc -ne 0 ]] && grep -q REFUSED <<<"$o"; then ok
#
# Run either one where the database is unreachable and resolve_agent returns
# empty, so the tool dies at org_request_queue.sh:860 ("requester not found")
# BEFORE the ceiling check at :870 that the case names. The refusal is real and
# the gate under test never ran. Measured in an agent container, COMPANY_ID set,
# no podman: test_request_queue.sh reported 15 passed / 16 failed, and
# test_privilege_ceilings.sh 2 / 34. A partially-green run is worse than a red
# one, and the operator's pre-release run is the last gate before a
# provisioning change lands.
#
# WHY THIS SUITE HAS TO EXIST. The fix is two guards, and the first one hides
# the second: once pcsql_preflight makes those suites exit 3 on an unreachable
# backend, refuses_because never executes anywhere CI can see it. An unexercised
# guard is the very thing TOG-402 is about. So this suite drives both, needs no
# database, and CI can run it.
#
# THE SEAM. A stub `psql` on PATH with PAPERCLIP_SQL_BACKEND=psql. Three modes:
#   reachable  answers SELECT 1 with 1, and other queries with canned rows
#   empty      answers SELECT 1 with 1, and every other query with NOTHING
#              — a reachable but wrong/empty database, which is the case
#                pcsql_preflight cannot catch and refuses_because must
#   mute       answers nothing at all, including SELECT 1
#   dead       exits non-zero
# 'empty' is the important one: it is the only way to run the real suites far
# enough to execute their real refusal assertions.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# --- the stub backend -------------------------------------------------------
mkdir -p "$TMP/bin"
cat > "$TMP/bin/psql" <<'STUB'
#!/usr/bin/env bash
sql="$(cat)"
case "${STUB_MODE:-reachable}" in
  dead) echo "could not connect to server" >&2; exit 2 ;;
  mute) exit 0 ;;
esac
if grep -qi 'SELECT 1;' <<<"$sql"; then echo 1; exit 0; fi
[[ "${STUB_MODE:-reachable}" == "empty" ]] && exit 0
echo "stub-row"
exit 0
STUB
chmod +x "$TMP/bin/psql"

# org_provisioner.sh resolves a paperclipai CLI at :90 and exits 1 if it finds
# none — before any gate. Without this stub the provisioner suite dies in its
# preamble and its refusal assertions never execute, so section 6 below would
# prove nothing. PAPERCLIP_CLI (:91) is the tool's own documented seam. The stub
# never gets called: every case in section 6 is refused long before a write.
cat > "$TMP/bin/paperclipai" <<'CLI'
#!/usr/bin/env bash
echo "STUB CLI INVOKED: $*" >&2
exit 9
CLI
chmod +x "$TMP/bin/paperclipai"
export PAPERCLIP_CLI="$TMP/bin/paperclipai"

# libpq vars so the psql backend does not refuse for a missing DATABASE_URL.
export PGHOST=stub PGDATABASE=stub PAPERCLIP_SQL_BACKEND=psql
export COMPANY_ID="${COMPANY_ID:-00000000-0000-0000-0000-000000000000}"

# shellcheck source=lib/pcsql.sh
. "$HERE/lib/pcsql.sh" || { echo "ERROR: missing $HERE/lib/pcsql.sh" >&2; exit 1; }

WITH_STUB="$TMP/bin:$PATH"
# A PATH with no psql on it. coreutils still needed, so keep the system dirs
# and simply do not add the stub — the real container has neither psql nor
# podman, which is what makes this assertion meaningful here.
NO_BACKEND_PATH="$PATH"

hdr "1. pcsql_preflight refuses every way a backend can be unusable"
( PATH="$NO_BACKEND_PATH"; pcsql_preflight ) >/dev/null 2>&1
[[ $? -ne 0 ]] && ok "refuses when the backend binary is not on PATH" \
               || bad "accepted a PATH with no psql on it"

out="$( PATH="$WITH_STUB" STUB_MODE=dead pcsql_preflight 2>&1 )"; rc=$?
if [[ $rc -ne 0 ]] && grep -q 'did not answer' <<<"$out"; then
  ok "refuses when the backend is present but errors"
else bad "accepted an erroring backend (rc=$rc)"; sed 's/^/        /' <<<"$out" | head -3; fi

# The one a `command -v psql` check would wave through, and the reason
# preflight does a round-trip instead of a binary check.
out="$( PATH="$WITH_STUB" STUB_MODE=mute pcsql_preflight 2>&1 )"; rc=$?
if [[ $rc -ne 0 ]] && grep -q 'no usable row' <<<"$out"; then
  ok "refuses when the backend is present, exits 0, and returns NO ROW"
else bad "accepted a silent backend (rc=$rc)"; sed 's/^/        /' <<<"$out" | head -3; fi

hdr "2. Positive control — preflight is not simply always refusing"
# Without this, every assertion above passes against a preflight that is
# hard-wired to fail, which is the same vacuous-green class as the bug itself.
out="$( PATH="$WITH_STUB" STUB_MODE=reachable pcsql_preflight 2>&1 )"; rc=$?
[[ $rc -eq 0 ]] && ok "ACCEPTS a backend that answers SELECT 1 with 1" \
                || { bad "refused a working backend (rc=$rc)"; sed 's/^/        /' <<<"$out" | head -3; }

hdr "3. Guard 1 — a suite that cannot reach its subject exits 3 and asserts nothing"
for s in test_request_queue.sh test_privilege_ceilings.sh org_access_review.sh; do
  out="$( PATH="$NO_BACKEND_PATH" PAPERCLIP_SQL_BACKEND=podman COMPANY_ID="$COMPANY_ID" "$HERE/$s" 2>&1 )"; rc=$?
  if [[ $rc -eq 3 ]]; then ok "$s exits 3 with no backend"
  else bad "$s exited $rc, wanted 3"; fi
  if [[ "$s" == "org_access_review.sh" ]]; then
    grep -q 'cannot reach the company database' <<<"$out" \
      && ok "$s exits through the database preflight gate" \
      || bad "$s exited 3 through a neighbouring gate, not database preflight"
  fi
  if grep -q 'PASS' <<<"$out"; then
    bad "$s printed a PASS despite not being able to run"
  else ok "$s printed no PASS line at all"; fi
done

hdr "4. Guard 2 — refuses_because FAILS a refusal from the wrong gate"
# The suites' own preflight is satisfied here (SELECT 1 answers), so they run
# their real assertions against an EMPTY database. Every ceiling case must now
# be reported as refused-by-the-wrong-gate rather than passed.
qout="$( PATH="$WITH_STUB" STUB_MODE=empty COMPANY_ID="$COMPANY_ID" \
         QUEUE="$TMP/q.jsonl" DISABLED_TEMPLATES="$TMP/dis" GRANT_LOG="$TMP/grant.jsonl" \
         "$HERE/test_request_queue.sh" 2>&1 )"; qrc=$?
qclean="$(sed 's/\x1b\[[0-9;]*m//g' <<<"$qout")"

if grep -q 'refused by the WRONG gate' <<<"$qclean"; then
  ok "test_request_queue.sh names the wrong-gate refusals instead of passing them"
else bad "no wrong-gate diagnosis appeared"; sed 's/^/        /' <<<"$qclean" | head -6; fi

# The three section-1 ceiling cases must not be green against an empty database.
for d in "T0 cannot request a President/COO" \
         "T0 cannot request a peer chief (lateral)" \
         "O2 Chief of Staff cannot request anything"; do
  if grep -qF "PASS  $d" <<<"$qclean"; then
    bad "'$d' still passes against an empty database"
  else ok "'$d' no longer passes against an empty database"; fi
done

# The argv gate refuses before any query, so it SHOULD still pass. This is the
# adjacency control: without it, the three assertions above are also satisfied
# by a suite that fails everything unconditionally.
if grep -qF "PASS  requester cannot supply reportsTo through the queue" <<<"$qclean"; then
  ok "the pre-database argv gate still passes — the suite is not failing everything"
else bad "the argv gate case did not pass; suite may be failing unconditionally"; fi

hdr "5. The absence claim no longer scores itself"
# `[[ "" -eq 0 ]]` is TRUE in bash, so the teardown count used to report a
# clean company it had never been able to look at.
if grep -qF "PASS  no TESTQ-provisioned agents remain active" <<<"$qclean"; then
  bad "teardown absence claim still passes against an empty database"
else ok "teardown absence claim does not pass against an empty database"; fi
if grep -q 'cannot confirm teardown' <<<"$qclean"; then
  ok "teardown says it could not confirm, rather than reporting zero"
else bad "teardown did not report an unanswered query"; sed 's/^/        /' <<<"$qclean" | tail -4; fi

[[ $qrc -ne 0 ]] && ok "the run against an empty database exits non-zero overall" \
                 || bad "the run against an empty database exited 0"

hdr "6. The same, for test_privilege_ceilings.sh"
pout="$( PATH="$WITH_STUB" STUB_MODE=empty COMPANY_ID="$COMPANY_ID" \
         GRANT_LOG="$TMP/grant2.jsonl" "$HERE/test_privilege_ceilings.sh" 2>&1 )"; prc=$?
pclean="$(sed 's/\x1b\[[0-9;]*m//g' <<<"$pout")"

if grep -q 'refused by the WRONG gate' <<<"$pclean"; then
  ok "test_privilege_ceilings.sh names the wrong-gate refusals"
else bad "no wrong-gate diagnosis appeared"; sed 's/^/        /' <<<"$pclean" | head -6; fi

if grep -qF "PASS  specialist has ZERO organizational-governance grants" <<<"$pclean"; then
  bad "the ZERO-grants claim still passes against an empty database"
else ok "the ZERO-grants claim does not pass against an empty database"; fi

# Was an unconditional `ok` before; it counted a PASS in an environment with no
# database at all.
if grep -qF "PASS  kill switch released" <<<"$pclean"; then
  bad "the old unconditional 'kill switch released' PASS is still there"
else ok "'kill switch released' is now an assertion, not a bare ok"; fi

[[ $prc -ne 0 ]] && ok "the run against an empty database exits non-zero overall" \
                 || bad "the run against an empty database exited 0"

hdr "7. The two backend-dependent suites no longer define the any-refusal helper"
# Line-anchored so the quoted `must_refuse()` in these files' own headers does
# not match. Scoped to the two suites TOG-402 names, deliberately:
#
#   test_gh_token_dispatch.sh  keeps must_refuse() and is CORRECT to. It needs
#     no backend, builds a complete fake credential environment, and proves that
#     environment live with positive controls in its section 1 — so a refusal
#     there cannot come from an absent dependency. It is entirely refusals and
#     still honest. Verified: 91 passed / 0 failed in a container with neither
#     podman nor psql.
#   test_responsible_leader.sh used to keep must_refuse(), but TOG-439 converted
#     every refusal to the same reason-pinned shape after the residual weakness
#     was measured. It remains offline on an ORG_SNAPSHOT fixture it writes
#     itself, interleaved with positive controls.
#   acceptance_org_lib.sh is fixture machinery for the acceptance suites, which
#     run against a stubbed provisioner and a real org snapshot.
for s in test_request_queue.sh test_privilege_ceilings.sh; do
  if grep -qE '^\s*must_refuse\(\)' "$HERE/$s"; then
    bad "$s still defines the any-refusal must_refuse()"
  else ok "$s defines no any-refusal must_refuse()"; fi
  if grep -qE '^\s*refuses_because\(\)' "$HERE/$s"; then
    ok "$s defines the reason-pinned refuses_because()"
  else bad "$s has no refuses_because()"; fi
done
# The offline responsible-leader suite has now closed the residual gap too.
if grep -qE '^\s*must_refuse\(\)' "$HERE/test_responsible_leader.sh"; then
  bad "test_responsible_leader.sh still defines the any-refusal must_refuse()"
elif grep -qE '^\s*refuses_because\(\)' "$HERE/test_responsible_leader.sh"; then
  ok "test_responsible_leader.sh defines only reason-pinned refusals"
else bad "test_responsible_leader.sh has no refusal helper; the check measured nothing"; fi
# Adjacency control: the definition pattern must still detect a known legitimate
# must_refuse() in test_gh_token_dispatch.sh, or absence claims above are vacuous.
if grep -qE '^\s*must_refuse\(\)' "$HERE/test_gh_token_dispatch.sh"; then
  ok "control — the pattern still detects the intentional credential-dispatch helper"
else bad "the must_refuse() pattern matches no known control; assertions above are vacuous"; fi

printf '\n\033[1mRESULT: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
