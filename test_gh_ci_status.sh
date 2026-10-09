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
# AND THE ONE THAT DOES NOT READ AS GREEN (TOG-381). A job blocked at the
# account level reports `status: completed, conclusion: failure` — every field
# the reader inspects is identical to a job that ran and failed. It read as an
# ordinary red build for 21 minutes on 2026-08-25 while four commits merged.
# `non-started` is a fourth verdict on its own exit code (5), because "fix your
# code" and "there is no CI right now, so nothing here is enforced" are
# different instructions to a human.
#
# WHY A STUB AND NOT THE REAL API. The interesting cases are permission denials
# and empty result sets on specific refs. Reproducing those against real GitHub
# would need several differently-scoped live tokens and a repo with a commit
# that predates its own CI — i.e. a credential and a network in CI, to test
# logic that is entirely local. The stub serves each case off a distinct ref
# name instead, so every branch is reachable and nothing leaves 127.0.0.1.
#
# WHY THE TOG-381 CASES ARE REPLAYED, NOT WRITTEN. A hand-authored non-start
# body is a body that matches whatever the reader happens to look for — it
# proves the reader agrees with the test author, not with GitHub. So the
# TOG-381 cases are served from responses RECORDED off the live Checks API for
# the actual commits involved; see test/fixtures/gh_ci_status/RECORDED.md for
# the provenance and the re-record command. Where a case needs a combination
# that never occurred on this repo (a fast red that is genuine, a denied
# annotations call), it is COMPOSED from recorded bodies by an explicit,
# single-field transform below, never typed out.
#
# Offline by construction, like test_gh_app_token.sh. Requires node, curl, jq.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/gh_ci_status.sh"
FIXTURES="$HERE/test/fixtures/gh_ci_status"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# assert <status> <label> [diagnostic]
#
# ONE label per assertion, printed identically whether it passes or fails. This
# is not cosmetic. The ci.yml mutation gate names the test each mutation must
# redden and looks for that string PASSING in the unmutated baseline and FAILING
# in the mutant — so an assertion that announces itself one way when green and
# another way when red cannot be pinned by any mutation, and quietly reverts to
# the "the suite went red somewhere" attribution that TOG-339 exists to forbid.
# Half the assertions here were written that way; the gate caught it. Put the
# detail in the diagnostic argument, never in the label.
assert() {
  local status="$1" label="$2" diag="${3:-}"
  if [[ "$status" -eq 0 ]]; then
    ok "$label"
  else
    bad "$label"
    [[ -n "$diag" ]] && printf '        %s\n' "$diag"
  fi
  return 0
}

for c in node curl jq; do
  command -v "$c" >/dev/null 2>&1 || { echo "test_gh_ci_status: $c is required" >&2; exit 2; }
done
[[ -x "$TOOL" ]] || { echo "test_gh_ci_status: $TOOL is not executable" >&2; exit 2; }

# A missing fixture set is a hard error, never a skip. A skipped test is a
# deleted test that still prints a zero exit — see TOG-339.
[[ -d "$FIXTURES" ]] || { echo "test_gh_ci_status: recorded fixtures missing at $FIXTURES" >&2; exit 2; }
for f in check-runs-24f0d30-green.json check-runs-4f2bea9-nonstart.json \
         check-runs-4fd26c0-realred.json check-runs-ae85924-nonstart-14s.json \
         annotations-97652743390-nonstart.json annotations-97325826859-realred.json \
         annotations-97653688773-green-warning.json; do
  [[ -s "$FIXTURES/$f" ]] || { echo "test_gh_ci_status: recorded fixture $f is missing or empty" >&2; exit 2; }
done

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
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const FIXTURES = process.argv[2]
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FIXTURES, n), 'utf8'))

// --- recorded, verbatim -------------------------------------------------------
const realGreen    = fx('check-runs-24f0d30-green.json')            // 4x success, 317/51/15/12s
const realNonstart = fx('check-runs-4f2bea9-nonstart.json')         // 4x failure, 3/3/2/2s, never ran
const real14s      = fx('check-runs-ae85924-nonstart-14s.json')     // 4x failure, 14/2/2/1s, never ran
const realRed      = fx('check-runs-4fd26c0-realred.json')          // 2x failure 39/41s + 4x success

const annNonstart  = fx('annotations-97652743390-nonstart.json')    // "The job was not started because..."
const annRealRed   = fx('annotations-97325826859-realred.json')     // "Process completed with exit code 1."
const annWarnOnly  = fx('annotations-97653688773-green-warning.json') // Node 20 deprecation, level=warning

// --- composed, one visible transform each -------------------------------------
// These combinations did not occur on this repo, so they cannot be replayed.
// Each is built by SELECTING recorded runs and overriding exactly one field.
const shortFailure = realNonstart.check_runs[0]            // real 2s failure, real timestamps
const withId = (run, id) => Object.assign({}, run, { id })
const one = (run) => ({ total_count: 1, check_runs: [run] })

// The billing text at `warning` level instead of `failure`. If the reader stops
// checking the level, a green build's warning becomes licence to say "not run".
const annNonstartAsWarning = annNonstart.map(a => Object.assign({}, a, { annotation_level: 'warning' }))

// A real red build's failing run, to pair with non-starts on one commit.
const realRedFailure = realRed.check_runs.find(r => r.conclusion === 'failure')

const completed = (name, conclusion) => ({ name, status: 'completed', conclusion })
const running   = (name) => ({ name, status: 'in_progress', conclusion: null })

// A full first page of successes: the old single-page reader saw exactly this
// and reported pass, with the failure sitting unread on page 2.
const pageOf100 = Array.from({ length: 100 }, (_, i) => completed('job-' + (i + 1), 'success'))

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

  // ---- TOG-381: replayed off the live API --------------------------------
  'sha-real-nonstart':     { checks: realNonstart, statuses: 403, runs: 403 },
  'sha-real-nonstart-14s': { checks: real14s,      statuses: 403, runs: 403 },
  'sha-real-green':        { checks: realGreen,    statuses: 403, runs: 403 },
  'sha-real-red':          { checks: realRed,      statuses: 403, runs: 403 },

  // The outage seen from an installation that DOES hold actions:read. The
  // workflow run is the same jobs from another endpoint, so counting its red as
  // independent evidence would make the classification dead wherever the
  // permission is granted.
  'sha-nonstart-actions':  { checks: realNonstart, statuses: 403,
                             runs: { total_count: 1, workflow_runs: [completed('CI', 'failure')] } },

  // ---- TOG-381: composed -------------------------------------------------
  // A genuine red AND non-starts on one commit. There is code to fix, so this
  // stays `fail` — but the non-starts must still be named.
  'sha-mixed': { checks: { total_count: realNonstart.check_runs.length + 1,
                           check_runs: realNonstart.check_runs.concat([realRedFailure]) },
                 statuses: 403, runs: 403 },

  // A fast failure that is GENUINE: a real 2s duration carrying a real
  // "Process completed with exit code 1." This is the case that dies if anyone
  // classifies on duration instead of on the annotation.
  'sha-fast-real-fail': { checks: one(withId(shortFailure, 900001)), statuses: 403, runs: 403 },

  // The annotations call itself is denied. Unclassifiable, so still a red.
  'sha-ann-denied':     { checks: one(withId(shortFailure, 900002)), statuses: 403, runs: 403 },

  // A failure whose only annotation is the deprecation WARNING that green runs
  // also carry. "Has annotations" is not the signal.
  'sha-ann-warnonly':   { checks: one(withId(shortFailure, 900003)), statuses: 403, runs: 403 },

  // The billing text, but at annotation_level `warning`.
  'sha-ann-warnlevel':  { checks: one(withId(shortFailure, 900004)), statuses: 403, runs: 403 },

  // A real non-start, used to prove the duration prefilter is live and is
  // exercised against GH_CI_NONSTART_MAX_SECONDS from the environment.
  'sha-prefilter':      { checks: one(withId(shortFailure, 900005)), statuses: 403, runs: 403 },

  // The check-run id is interpolated into the path of an AUTHENTICATED request
  // and it comes from the response body, not from us. This id is a traversal
  // that curl normalises down to /check-runs/900005/annotations — a DIFFERENT
  // run, whose annotations do carry the billing text. Interpolate it unchecked
  // and the response body gets to choose which annotations are consulted, and
  // therefore to manufacture a `non-started` verdict on a genuine red.
  'sha-bad-id': { checks: one(withId(shortFailure, '../../../../check-runs/900005')),
                  statuses: 403, runs: 403 },

  // An external commit status that is red while the Actions jobs never ran.
  // Buildkite is not affected by a GitHub billing block, so that red is real.
  'sha-nonstart-extred': { checks: realNonstart,
                           statuses: { state: 'failure', statuses: [{ context: 'buildkite', state: 'failure' }] },
                           runs: 403 },

  // ---- pagination: a failure past page 1 must not read as pass -------------
  // Page 1 is a full 100-success page whose total_count advertises one more
  // row; the failure sits on page 2. The old single-page reader saw only
  // page 1 and reported pass with 101 signals observed. Served as arrays so
  // the stub answers `?page=1` and `?page=2` separately (see the handler).
  'sha-paged-fail': { checks: [{ total_count: 101, check_runs: pageOf100 },
                               { total_count: 101, check_runs: [completed('late-failure', 'failure')] }],
                      statuses: 403,
                      runs: { total_count: 0, workflow_runs: [] } },

  // Both pages green: the paginating reader must still reach pass.
  'sha-paged-green': { checks: [{ total_count: 101, check_runs: pageOf100 },
                                { total_count: 101, check_runs: [completed('last-job', 'success')] }],
                       statuses: 403,
                       runs: { total_count: 0, workflow_runs: [] } },

  // total_count advertises rows the stub never serves: a short read the
  // reader cannot complete. Served as a one-element array so page 2 is a
  // 404 — the unread rows may hold a red, so this is unknown, never pass.
  'sha-paged-short': { checks: [{ total_count: 200, check_runs: pageOf100 }],
                       statuses: 403,
                       runs: { total_count: 0, workflow_runs: [] } },

  // A truncated read holding a non-start, beside a red workflow run. The unread
  // pages may hold a real red, and the workflow red is the same outage seen from
  // another endpoint, so neither `non-started` nor `fail` is licensed: unknown.
  'sha-paged-short-nonstart': { checks: [{ total_count: 200, check_runs: [realNonstart.check_runs[0]].concat(pageOf100.slice(0, 99)) }],
                                statuses: 403,
                                runs: { total_count: 1, workflow_runs: [completed('CI', 'failure')] } },

  // The same truncation with no non-start: an observed workflow red is still a
  // red, so it stays `fail` rather than softening to unknown.
  'sha-paged-short-red-run': { checks: [{ total_count: 200, check_runs: pageOf100 }],
                               statuses: 403,
                               runs: { total_count: 1, workflow_runs: [completed('CI', 'failure')] } },
  // A workflow startup failure beside green check runs, read by branch name.
  // GitHub answers zero workflow runs for a branch name in head_sha, so the
  // reader has to resolve the ref to a commit before it asks for runs.
  'sha-branch-startup': { checks: { total_count: 2, check_runs: [completed('Offline suites', 'success'), completed('broker suite', 'success')] },
                          statuses: 403,
                          runs: { total_count: 1, workflow_runs: [completed('CI', 'startup_failure')] } },

  // A check-runs body that is not JSON. Its total is unknown, so the read
  // cannot be shown complete, and the green status must not carry it to pass.
  'sha-garbage-checks': { checks: 'RAW:<html>captive portal</html>',
                          statuses: { state: 'success', statuses: [{ context: 'buildkite', state: 'success' }] },
                          runs: 403 },

  // A commit-status body that is not JSON, beside green check runs.
  'sha-garbage-status': { checks: { total_count: 1, check_runs: [completed('Offline suites', 'success')] },
                          statuses: 'RAW:not json',
                          runs: 403 },

  // A server error on check runs is a read that did not happen, not a pass.
  'sha-5xx-checks': { checks: 503,
                      statuses: { state: 'success', statuses: [{ context: 'buildkite', state: 'success' }] },
                      runs: 403 },
}

// A ref resolves to a 40-hex commit id, as a real SHA does. The stub's id is the
// SHA-1 of the case name, and REFS maps it back to the case.
const shaOf = (name) => crypto.createHash('sha1').update(name).digest('hex')
const REFS = new Map(Object.keys(CASES).map((n) => [shaOf(n), n]))

// check-run id -> annotations body, or a bare status code. Ids present in the
// recorded check-runs bodies resolve to their recorded annotation file.
const ANNOTATIONS = {
  900001: annRealRed,
  900002: 403,
  900003: annWarnOnly,
  900004: annNonstartAsWarning,
  900005: annNonstart,
}
const annotationFor = (id) => {
  if (Object.prototype.hasOwnProperty.call(ANNOTATIONS, id)) return ANNOTATIONS[id]
  const hit = fs.readdirSync(FIXTURES).find(f => f.startsWith('annotations-' + id + '-'))
  return hit ? fx(hit) : 404
}

const srv = http.createServer((req, res) => {
  const url = req.url
  res.setHeader('Content-Type', 'application/json')

  // GET /repos/{o}/{r}/commits/{ref}: the resolution the reader makes first.
  // A ref the case table marks missing answers 422, as GitHub does for an
  // unknown commit; any other known ref resolves to its 40-hex id.
  const resolve = url.match(/\/repos\/[^/]+\/[^/]+\/commits\/([^/?]+)(?:\?|$)/)
  if (resolve) {
    const name = REFS.get(resolve[1]) || resolve[1]
    const spec = CASES[name]
    if (!spec) { res.statusCode = 404; return res.end(JSON.stringify({ message: 'Not Found' })) }
    if (spec.checks === 422) { res.statusCode = 422; return res.end(JSON.stringify({ message: 'No commit found' })) }
    res.statusCode = 200
    return res.end(JSON.stringify({ sha: shaOf(name) }))
  }

  let ref = null, source = null, annId = null
  let m = url.match(/\/commits\/([^/]+)\/check-runs/)
  if (m) { ref = m[1]; source = 'checks' }
  m = url.match(/\/commits\/([^/]+)\/status/)
  if (m) { ref = m[1]; source = 'statuses' }
  m = url.match(/\/actions\/runs\?head_sha=([^&]+)/)
  if (m) { ref = m[1]; source = 'runs' }
  m = url.match(/\/check-runs\/([^/]+)\/annotations/)
  if (m) { annId = m[1]; source = 'annotations' }

  const send = (val) => {
    if (val === 403) { res.statusCode = 403; return res.end(JSON.stringify({ message: 'Resource not accessible by integration' })) }
    if (val === 422) { res.statusCode = 422; return res.end(JSON.stringify({ message: `No commit found for SHA: ${ref}` })) }
    if (val === 404 || val === undefined || val === null) { res.statusCode = 404; return res.end(JSON.stringify({ message: 'Not Found' })) }
    if (typeof val === 'number') { res.statusCode = val; return res.end(JSON.stringify({ message: 'upstream error' })) }
    if (typeof val === 'string' && val.startsWith('RAW:')) { res.statusCode = 200; return res.end(val.slice(4)) }
    res.statusCode = 200
    res.end(JSON.stringify(val))
  }

  // Paged list bodies are served as arrays: element 0 is page 1, element 1 is
  // page 2. A reader that never sends `page=` gets element 0 — which is what
  // made the pre-fix reader report pass on sha-paged-fail.
  const sendPaged = (val) => {
    if (!Array.isArray(val)) return send(val)
    const pm = (url.match(/[?&]page=(\d+)/) || [])[1]
    const page = pm ? parseInt(pm, 10) : 1
    const body = val[page - 1]
    if (body === undefined) { res.statusCode = 404; return res.end(JSON.stringify({ message: 'Not Found' })) }
    res.statusCode = 200
    res.end(JSON.stringify(body))
  }

  // GitHub answers no workflow runs for a branch name in head_sha: only a commit id matches.
  if (source === 'runs' && !/^[0-9a-f]{40}$/.test(ref)) return send({ total_count: 0, workflow_runs: [] })
  if (ref !== null) ref = REFS.get(ref) || ref

  if (source === 'annotations') return send(annotationFor(annId))

  const spec = CASES[ref]
  if (!spec || !source) { res.statusCode = 404; return res.end(JSON.stringify({ message: 'Not Found' })) }
  if (source === 'checks' || source === 'runs') return sendPaged(spec[source])
  send(spec[source])
})
srv.listen(0, '127.0.0.1', () => process.stdout.write(String(srv.address().port) + '\n'))
STUB

node "$TMP/stub-api.js" "$FIXTURES" > "$TMP/port.txt" 2>"$TMP/stub.err" &
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

hdr "The recorded fixtures are what they claim to be"

# If a fixture is ever "tidied up", the assertions below silently stop meaning
# anything — a non-start fixture edited into successes makes every TOG-381 test
# pass for the wrong reason. Pin the shapes, not just the file's existence.
jq -e '[.check_runs[] | select(.status=="completed" and .conclusion=="failure")] | length == 4' \
   "$FIXTURES/check-runs-4f2bea9-nonstart.json" >/dev/null 2>&1
assert $? "the non-start fixture really is 4x completed/failure — indistinguishable from a red build by conclusion" \
  "check-runs-4f2bea9-nonstart.json is no longer 4 completed/failure runs"

jq -e '[.check_runs[] | ((.completed_at|fromdateiso8601)-(.started_at|fromdateiso8601))] | max <= 5' \
   "$FIXTURES/check-runs-4f2bea9-nonstart.json" >/dev/null 2>&1
assert $? "the non-start fixture's durations are the recorded 2-3s" \
  "the recorded durations have changed; the prefilter cases below no longer mean what they say"

jq -e 'any(.[]; .annotation_level=="failure" and (.message | test("job was not started"; "i")))' \
   "$FIXTURES/annotations-97652743390-nonstart.json" >/dev/null 2>&1
assert $? "the non-start annotation fixture carries the billing text at failure level" \
  "annotations-97652743390-nonstart.json no longer carries the billing text"

# The green build carries annotations too. This is why "has annotations" cannot
# be the signal, and it is a recorded fact, not an argument.
jq -e 'any(.[]; .annotation_level=="warning") and (any(.[]; .annotation_level=="failure") | not)' \
   "$FIXTURES/annotations-97653688773-green-warning.json" >/dev/null 2>&1
assert $? "a SUCCESSFUL run's recorded annotations are warning-level only" \
  "annotations-97653688773-green-warning.json is not warning-level only"

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
[[ "$RC" -ne 0 ]]; assert $? "denied never exits 0" "a shell gate would merge on it"
run sha-empty
[[ "$RC" -ne 0 ]]; assert $? "empty never exits 0" "a shell gate would merge on it"

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

hdr "Pagination — a failure past page 1 must not read as pass"

# THE regression case for this change: 100 successes on page 1, the failure
# on page 2. The single-page reader reported pass (exit 0); the fix reads
# both pages and reports fail (exit 1).
expect sha-paged-fail fail 1 "a failure on page 2 of 101 check runs -> fail, not pass"

# The control: both pages green is still a pass.
expect sha-paged-green pass 0 "101 successes across two pages -> pass"

# A short read the reader cannot complete: total_count advertises rows that
# never arrive. The unread rows may hold a red, so this is unknown (exit 3) —
# never pass, never pending, never non-started.
expect sha-paged-short unknown 3 "a truncated check-runs read -> unknown, not pass"

# A non-start beside a truncated read: the workflow red does not license
# non-started, and the unread pages may hold a real red. Unknown.
expect sha-paged-short-nonstart unknown 3 "a truncated read beside a non-start and a workflow red -> unknown, not non-started"
expect sha-paged-short-red-run fail 1 "a workflow red beside a truncated read with no non-start -> fail"

# A ref is resolved to its commit before the runs query. Read by branch name,
# the runs endpoint answers nothing, and the startup failure would read as green.
expect sha-branch-startup fail 1 "a workflow startup failure beside green check runs, read by branch name -> fail, not pass"

# A body that is not a list of check runs or statuses is an unread source, not
# an empty one, and a server error is a read that did not happen.
expect sha-garbage-checks unknown 3 "a check-runs body that is not JSON -> unknown, not pass"
expect sha-garbage-status unknown 3 "a commit-status body that is not JSON -> unknown, not pass"
expect sha-5xx-checks unknown 3 "a server error on check runs -> unknown, not pass"

run sha-paged-fail
printf '%s' "$OUT" | jq -e '.signalsObserved == 101 and .checkRunsRead == 101 and .checkRunsTruncated == false' >/dev/null 2>&1
assert $? "the paged failure reports the rows actually read, not the first page" \
  "signalsObserved is not 101 read rows — the count still comes from a single page"

run sha-paged-short
printf '%s' "$OUT" | jq -e '.truncated == true and .checkRunsTruncated == true' >/dev/null 2>&1
assert $? "a truncated read is flagged structurally, not only in prose" \
  "a caller would have to regex the reason string to learn the read was short"

hdr "TOG-381 — a job that never ran is not a red build"

# THE headline assertion for TOG-381, replayed from the real outage. Every field
# the pre-TOG-381 reader inspected says `completed/failure`; it called this a red
# build for 21 minutes and four commits merged on that reading.
expect sha-real-nonstart non-started 5 "a recorded account-block outage -> non-started, not fail"

# The recorded outage also produced a 14-SECOND non-start. Anyone who replaces
# the annotation check with a "under 5 seconds" rule reddens exactly here.
expect sha-real-nonstart-14s non-started 5 "a 14s non-start is still non-started — duration alone cannot separate these"

# And the two controls, both recorded off the same repo.
expect sha-real-green pass 0 "the recorded post-recovery green build -> pass"
expect sha-real-red   fail 1 "a recorded genuine red build -> fail, never non-started"

# THE anti-overreach assertion. A short duration is a prefilter, not a verdict.
# This run is 2 real seconds and carries a real "Process completed with exit
# code 1." — the `bash -n` scan in our own ci.yml fails this fast.
expect sha-fast-real-fail fail 1 "a fast failure with a real error annotation stays fail — duration is not the classifier"

# The classification added a second authenticated call whose path contains a
# value taken from the previous response. A check-run id that is a traversal
# normalises onto a different run's annotations — one that does carry the
# billing text — so an unchecked interpolation lets the response body pick which
# annotations are consulted and turn a genuine red into "not your fault".
expect sha-bad-id fail 1 "a check-run id that is not a number is never put in a request path"

# Everything that could go wrong while classifying leaves the run a red.
expect sha-ann-denied    fail 1 "annotations denied -> unclassifiable, stays fail"
expect sha-ann-warnonly  fail 1 "a failure whose only annotation is a deprecation warning stays fail"
expect sha-ann-warnlevel fail 1 "the billing text at warning level does not license non-started"

# A genuine red alongside non-starts. There is code to fix, so the exit code is
# 1 — but suppressing the non-starts entirely would hide that the suite which
# went red was only partly running.
expect sha-mixed fail 1 "a real failure alongside non-starts -> fail, not non-started"
run sha-mixed
printf '%s' "$OUT" | jq -e '(.nonStarted | length) == 4' >/dev/null 2>&1
assert $? "the mixed case still names the non-started jobs in the output" \
  "the suite that went red was only partly running, and the output no longer says so"

# On an installation holding actions:read, source 3 reds for exactly the reason
# source 1 did. Treating that as independent evidence of a genuine failure would
# make this whole classification dead wherever the permission is granted.
expect sha-nonstart-actions non-started 5 "a workflow-run red mirroring the same non-started jobs -> still non-started"

# Buildkite does not stop when GitHub's billing does. A red there is real.
expect sha-nonstart-extred fail 1 "an external CI red alongside non-starts -> fail; external CI is unaffected by a GitHub block"

hdr "TOG-381 — the duration prefilter is live, and generous"

# The prefilter must actually gate the extra API call, and must be tunable. With
# the window closed to 1s, the recorded 2s non-start is not probed and falls
# back to a plain red — which is what "too tight" costs, and why the default is
# 60 rather than 5.
OUT="$(GH_CI_NONSTART_MAX_SECONDS=1 "$TOOL" --quiet "TogetherWeOwn/paperclip-ops-tooling" sha-prefilter 2>/dev/null)"; RC=$?
[[ "$(printf '%s' "$OUT" | jq -r '.verdict')" == "fail" && "$RC" -eq 1 ]]
assert $? "a prefilter window below the run's duration skips the probe (the cost of a tight threshold)" \
  "GH_CI_NONSTART_MAX_SECONDS=1 did not skip the probe — the prefilter is not wired to the environment"

expect sha-prefilter non-started 5 "the same run under the default 60s window is classified"

OUT="$(GH_CI_NONSTART_MAX_SECONDS=0 "$TOOL" --quiet "TogetherWeOwn/paperclip-ops-tooling" sha-prefilter 2>/dev/null)"; RC=$?
[[ "$(printf '%s' "$OUT" | jq -r '.verdict')" == "non-started" && "$RC" -eq 5 ]]
assert $? "a window of 0 probes everything rather than disabling the feature" \
  "GH_CI_NONSTART_MAX_SECONDS=0 disabled the classification instead of probing everything"

OUT="$(GH_CI_NONSTART_MAX_SECONDS=banana "$TOOL" --quiet "TogetherWeOwn/paperclip-ops-tooling" sha-prefilter 2>/dev/null)"; RC=$?
[[ "$RC" -eq 5 ]]
assert $? "a garbage window falls back to the default instead of erroring or disabling" \
  "a non-numeric GH_CI_NONSTART_MAX_SECONDS did not fall back to the default (got $RC)"

hdr "TOG-381 — reporting, so a caller need not parse the reason"

run sha-real-nonstart
printf '%s' "$OUT" | jq -e '(.nonStarted | length) == 4 and .nonStartedProbe == "clean"' >/dev/null 2>&1
assert $? "non-started jobs are listed structurally, not only in prose" \
  "a caller would have to regex the reason string to act on this"

run sha-real-nonstart
printf '%s' "$OUT" | jq -r '.reason' | grep -qi 'not a red build'
assert $? "the reason says in words that this is not a red build" \
  "the prose does not distinguish itself from an ordinary failure"

run sha-ann-denied
printf '%s' "$OUT" | jq -e '.nonStartedProbe | startswith("incomplete")' >/dev/null 2>&1
assert $? "a probe that could not complete says so" \
  "a denied annotations call is reported as a clean probe — the caller is told the question was asked and answered no"

run sha-real-red
printf '%s' "$OUT" | jq -e '(.nonStarted | length) == 0' >/dev/null 2>&1
assert $? "a genuine red reports an empty nonStarted list" \
  "a genuine red reported non-started jobs"
# 5 must be reachable ONLY through this classification. If any other case starts
# exiting 5, the caller's "escalate to billing" branch fires on the wrong input.
LEAK=""
for r in sha-denied sha-empty sha-green sha-red sha-running sha-skipped sha-missing \
         sha-startup sha-extstatus sha-extgreen sha-partial sha-real-green sha-real-red \
         sha-fast-real-fail sha-ann-denied sha-ann-warnonly sha-ann-warnlevel sha-mixed sha-bad-id \
         sha-paged-fail sha-paged-green sha-paged-short sha-paged-short-nonstart sha-paged-short-red-run \
         sha-branch-startup sha-garbage-checks sha-garbage-status sha-5xx-checks; do
  run "$r"
  [[ "$RC" -eq 5 ]] && { LEAK="$r"; break; }
done
[[ -z "$LEAK" ]]
assert $? "exit 5 is reachable only via the non-started classification" \
  "exit 5 leaked out of $LEAK, which is not a non-start — a caller's escalate-to-billing branch would fire on it"

hdr "Reporting"

run sha-denied
printf '%s' "$OUT" | jq -e '.sources.checkRuns == "denied" and .sources.workflowRuns == "denied"' >/dev/null 2>&1
assert $? "a denial is reported as denied per source, not as an empty result" \
  "denial is not distinguishable from emptiness in the output"

run sha-empty
printf '%s' "$OUT" | jq -e '.sources.checkRuns == "read" and .signalsObserved == 0' >/dev/null 2>&1
assert $? "an empty read is reported as read-with-zero-signals" \
  "an empty read is not distinguishable from a denial in the output"

run sha-denied
printf '%s' "$OUT" | jq -r '.reason' | grep -q 'checks:read'
assert $? "the denial reason names the permissions that would fix it" \
  "the denial reason does not say which permissions are missing"

hdr "Refusals"

OUT="$(GH_TOKEN= "$TOOL" --quiet "TogetherWeOwn/x" main 2>&1)"; RC=$?
[[ "$RC" -eq 4 ]]; assert $? "no token -> usage error, not a probe" "got exit $RC"
OUT="$("$TOOL" --quiet "not-a-slug" main 2>&1)"; RC=$?
[[ "$RC" -eq 4 ]]; assert $? "malformed owner/repo refused" "got exit $RC"
OUT="$("$TOOL" --quiet "../../etc" main 2>&1)"; RC=$?
[[ "$RC" -eq 4 ]]; assert $? "traversal in the coordinate refused" "got exit $RC"

# The token must never reach argv, where any same-uid process can read it out of
# /proc — the TOG-200 class of bug. Asserted by inspecting the source rather
# than racing a live process, which is flaky and proves less. TOG-381 added a
# second authenticated call (the annotations probe), which is why this is
# asserted over every curl in the file rather than the one that used to be here.
! grep -qE 'curl[^|]*(Authorization|\$GH_TOKEN|\$\{GH_TOKEN)' "$TOOL"
assert $? "the token is passed via a header file, never in argv" \
  "the token appears in a curl command line"

# --help slices the banner by LINE NUMBER, so inserting a paragraph above it
# silently starts printing the wrong text. Assert on the content it must reach.
HELP="$("$TOOL" --help 2>&1)"
grep -q 'EXIT CODES' <<< "$HELP" && grep -q '5  non-started' <<< "$HELP" && grep -q 'GH_TOKEN' <<< "$HELP"
assert $? "--help still lands on the exit-code table, including 5" \
  "the sed line range has drifted off the banner"

hdr "Result"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[[ "$PASS" -gt 0 ]] || { printf '  a suite that ran no assertions is not a green suite\n'; exit 1; }
[[ "$FAIL" -eq 0 ]] || exit 1
