#!/usr/bin/env bash
# Regression suite for gh_ci_status.sh — the fail-closed CI status reader.
#
# THE BUG THIS EXISTS FOR (TOG-247). The natural way to ask "did CI pass" is
# `check-runs` plus "every run concluded success", and that predicate is TRUE
# for an empty list. So both of the ways an agent can be blind to CI —
#
#     denied     403, the token has no checks:read
#     vacuous    200 with zero runs, because CI has not started or is absent
#
# — come out as green. The tool under test must return `unknown` for both, on
# its own exit code, and the assertions below are mostly about that: nine of
# them exist purely to prove that a not-observed CI never reports as passing.
#
# WHY A STUB AND NOT THE REAL API. The interesting cases are permission denials
# and empty result sets on specific refs. Reproducing those against real GitHub
# would need several differently-scoped live tokens and a repo with a commit
# that predates its own CI — i.e. a credential and a network in CI, to test
# logic that is entirely local. The stub serves each case off a distinct ref
# name instead, so every branch is reachable and nothing leaves 127.0.0.1.
#
# Offline by construction, like test_gh_app_token.sh. Requires node, curl, jq.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/gh_ci_status.sh"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

for c in node curl jq; do
  command -v "$c" >/dev/null 2>&1 || { echo "test_gh_ci_status: $c is required" >&2; exit 2; }
done
[[ -x "$TOOL" ]] || { echo "test_gh_ci_status: $TOOL is not executable" >&2; exit 2; }

TMP="$(mktemp -d)"
STUB_PID=""
cleanup() { [[ -n "$STUB_PID" ]] && kill "$STUB_PID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

# --- stub GitHub API ----------------------------------------------------------
# Behaviour is selected by the ref in the URL, so one server covers every case.
# Deliberately PERMISSIVE where it matters: `sha-empty` returns a clean 200 with
# an empty list rather than an error, because that is precisely the response a
# regressed tool would call green.
cat > "$TMP/stub-api.js" <<'STUB'
const http = require('http')

const completed = (name, conclusion) => ({ name, status: 'completed', conclusion })
const running   = (name) => ({ name, status: 'in_progress', conclusion: null })

// ref -> { checks, statuses, runs }; each is a status code or a body.
const CASES = {
  // Every source denied: the broker's current default profile.
  'sha-denied':   { checks: 403, statuses: 403, runs: 403 },
  // Readable but empty: a commit predating CI, or one pushed a second ago.
  'sha-empty':    { checks: { total_count: 0, check_runs: [] },
                    statuses: { state: 'pending', statuses: [] },
                    runs: { total_count: 0, workflow_runs: [] } },
  'sha-green':    { checks: { total_count: 2, check_runs: [completed('Offline suites', 'success'), completed('broker suite', 'success')] },
                    statuses: 403,
                    runs: { total_count: 1, workflow_runs: [completed('CI', 'success')] } },
  'sha-red':      { checks: { total_count: 2, check_runs: [completed('Offline suites', 'success'), completed('broker suite', 'failure')] },
                    statuses: 403,
                    runs: { total_count: 1, workflow_runs: [completed('CI', 'failure')] } },
  'sha-running':  { checks: { total_count: 2, check_runs: [completed('Offline suites', 'success'), running('broker suite')] },
                    statuses: 403,
                    runs: { total_count: 1, workflow_runs: [running('CI')] } },
  // Neutral and skipped are successes, not failures. A skipped job is the
  // normal result of a path filter and must not read as red.
  'sha-skipped':  { checks: { total_count: 2, check_runs: [completed('Offline suites', 'skipped'), completed('broker suite', 'neutral')] },
                    statuses: 403, runs: 403 },
  // checks:read denied, actions:read granted, and the workflow died before it
  // could create any check run. Only source 3 can see this.
  'sha-startup':  { checks: 403, statuses: 403,
                    runs: { total_count: 1, workflow_runs: [completed('CI', 'startup_failure')] } },
  // checks:read denied, actions:read granted, nothing there. Still unknown.
  'sha-partial':  { checks: 403, statuses: 403, runs: { total_count: 0, workflow_runs: [] } },
  // External CI that posts commit statuses instead of check runs.
  'sha-extstatus':{ checks: { total_count: 0, check_runs: [] },
                    statuses: { state: 'failure', statuses: [{ context: 'buildkite', state: 'failure' }] },
                    runs: { total_count: 0, workflow_runs: [] } },
  'sha-extgreen': { checks: { total_count: 0, check_runs: [] },
                    statuses: { state: 'success', statuses: [{ context: 'buildkite', state: 'success' }] },
                    runs: 403 },
  'sha-missing':  { checks: 422, statuses: 422, runs: 422 },
}

const srv = http.createServer((req, res) => {
  const url = req.url
  let ref = null, source = null
  let m = url.match(/\/commits\/([^/]+)\/check-runs/)
  if (m) { ref = m[1]; source = 'checks' }
  m = url.match(/\/commits\/([^/]+)\/status/)
  if (m) { ref = m[1]; source = 'statuses' }
  m = url.match(/\/actions\/runs\?head_sha=([^&]+)/)
  if (m) { ref = m[1]; source = 'runs' }

  res.setHeader('Content-Type', 'application/json')
  const spec = CASES[ref]
  if (!spec || !source) { res.statusCode = 404; return res.end(JSON.stringify({ message: 'Not Found' })) }

  const val = spec[source]
  if (val === 403) { res.statusCode = 403; return res.end(JSON.stringify({ message: 'Resource not accessible by integration' })) }
  if (val === 422) { res.statusCode = 422; return res.end(JSON.stringify({ message: `No commit found for SHA: ${ref}` })) }
  if (val === 404) { res.statusCode = 404; return res.end(JSON.stringify({ message: 'Not Found' })) }
  res.statusCode = 200
  res.end(JSON.stringify(val))
})
srv.listen(0, '127.0.0.1', () => process.stdout.write(String(srv.address().port) + '\n'))
STUB

node "$TMP/stub-api.js" > "$TMP/port.txt" 2>"$TMP/stub.err" &
STUB_PID=$!
for _ in $(seq 1 50); do [[ -s "$TMP/port.txt" ]] && break; sleep 0.1; done
PORT="$(tr -d '\n' < "$TMP/port.txt")"
[[ -n "$PORT" ]] || { echo "test_gh_ci_status: stub API did not start"; cat "$TMP/stub.err"; exit 2; }
export GH_API_URL="http://127.0.0.1:$PORT"
export GH_TOKEN="not-a-real-token"

# Run the tool against a ref; captures stdout, stderr and exit code.
run() {
  OUT="$("$TOOL" --quiet "TogetherWeOwn/paperclip-ops-tooling" "$1" 2>"$TMP/err.txt")"
  RC=$?
  ERR="$(cat "$TMP/err.txt")"
  return 0
}
verdict() { printf '%s' "$OUT" | jq -r '.verdict' 2>/dev/null; }

# expect <ref> <verdict> <exit> <label>
expect() {
  run "$1"
  local v; v="$(verdict)"
  if [[ "$v" == "$2" && "$RC" -eq "$3" ]]; then
    ok "$4"
  else
    bad "$4 (got verdict=$v exit=$RC, wanted verdict=$2 exit=$3)"
    printf '        %s\n' "$OUT"
  fi
}

hdr "The two false greens — the reason this tool exists"

# THE headline assertion. A token with none of checks/actions/statuses read gets
# 403 from every source. The naive gate parses `.check_runs[]` out of the error
# body, gets nothing, and concludes green. This must be `unknown`.
expect sha-denied  unknown 3 "every source denied -> unknown, not pass"

# The second false green, and the one that SURVIVES granting the permission:
# a readable source that legitimately has nothing in it. "All zero runs
# succeeded" is vacuously true and must not be reported as success.
expect sha-empty   unknown 3 "readable but zero signals -> unknown, not pass"

# Belt and braces on the above: assert the exit code is not merely non-zero but
# specifically 3, and that it is never 0. A caller that gates on `if tool; then
# merge` is the whole failure mode.
run sha-denied
[[ "$RC" -ne 0 ]] && ok "denied never exits 0" || bad "denied exited 0 — a shell gate would merge on it"
run sha-empty
[[ "$RC" -ne 0 ]] && ok "empty never exits 0" || bad "empty exited 0 — a shell gate would merge on it"

# Partial denial is the subtle one: one source readable, and it saw nothing.
# There IS evidence here — just no evidence of CI — so it stays unknown.
expect sha-partial unknown 3 "one readable source with zero results -> unknown"

hdr "Observed verdicts"

expect sha-green   pass    0 "all runs concluded success -> pass"
expect sha-red     fail    1 "a failed run -> fail"
expect sha-running pending 2 "an unconcluded run -> pending, not pass"
expect sha-skipped pass    0 "skipped and neutral count as success, not failure"
expect sha-missing unknown 3 "a ref that does not exist -> unknown, not pass"

hdr "Sources the check-runs endpoint alone cannot see"

# A workflow that dies before creating check runs is invisible to source 1.
# Without source 3 this case is indistinguishable from sha-empty, and it is a
# genuine red build.
expect sha-startup fail 1 "startup_failure visible only via workflow runs -> fail"

# External CI posts commit statuses, not check runs. A repo using it has zero
# check runs forever, so a checks-only gate reads it as green permanently.
expect sha-extstatus fail 1 "failing external commit status -> fail"
expect sha-extgreen  pass 0 "passing external commit status -> pass"

hdr "Reporting"

run sha-denied
if printf '%s' "$OUT" | jq -e '.sources.checkRuns == "denied" and .sources.workflowRuns == "denied"' >/dev/null 2>&1; then
  ok "a denial is reported as denied per source, not as an empty result"
else
  bad "denial is not distinguishable from emptiness in the output"
fi
run sha-empty
if printf '%s' "$OUT" | jq -e '.sources.checkRuns == "read" and .signalsObserved == 0' >/dev/null 2>&1; then
  ok "an empty read is reported as read-with-zero-signals"
else
  bad "an empty read is not distinguishable from a denial in the output"
fi
run sha-denied
if printf '%s' "$OUT" | jq -r '.reason' | grep -q 'checks:read'; then
  ok "the denial reason names the permissions that would fix it"
else
  bad "the denial reason does not say which permissions are missing"
fi

hdr "Refusals"

OUT="$(GH_TOKEN= "$TOOL" --quiet "TogetherWeOwn/x" main 2>&1)"; RC=$?
[[ "$RC" -eq 4 ]] && ok "no token -> usage error, not a probe" || bad "missing token did not exit 4 (got $RC)"
OUT="$("$TOOL" --quiet "not-a-slug" main 2>&1)"; RC=$?
[[ "$RC" -eq 4 ]] && ok "malformed owner/repo refused" || bad "malformed slug did not exit 4 (got $RC)"
OUT="$("$TOOL" --quiet "../../etc" main 2>&1)"; RC=$?
[[ "$RC" -eq 4 ]] && ok "traversal in the coordinate refused" || bad "traversal not refused (got $RC)"

# The token must never reach argv, where any same-uid process can read it out of
# /proc — the TOG-200 class of bug. Asserted by inspecting the source rather
# than racing a live process, which is flaky and proves less.
if grep -qE 'curl[^|]*(Authorization|\$GH_TOKEN|\$\{GH_TOKEN)' "$TOOL"; then
  bad "the token appears in a curl command line"
else
  ok "the token is passed via a header file, never in argv"
fi

hdr "Result"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
