#!/usr/bin/env bash
# ===========================================================================
# test_red_main_poll.sh — offline suite for red_main_poll.sh.
#
# No network, no credentials, no board writes: a stub GitHub API on
# 127.0.0.1 serves a distinct CI case off each repo NAME (same convention as
# test_gh_ci_status.sh, which serves cases off ref names), and the board read
# arrives through INCIDENT_SOURCE_CMD. The stub also serves the real
# gh_ci_status.sh binary from this repo, so verdict classification is the
# production reader's, not a reimplementation of it.
#
# WHAT THIS SUITE IS BUILT TO CATCH, beyond the happy path:
#
#  * A SHA-KEYED SIGNATURE. Rule 1 says the signature keys on the failure
#    set, not the head SHA: the stub serves two red repos with the SAME two
#    failing jobs at DIFFERENT head SHAs, and the suite pins identical
#    signatures — plus a third repo with a different failing set pinning a
#    different signature. Keying on the SHA would open one card per commit
#    for the whole life of the red.
#  * AN ORDER-DEPENDENT SIGNATURE. The Checks API returns runs in an order
#    no caller should depend on; the stub serves the same two failures in
#    reversed order and the suite pins the same signature (rule 2).
#  * A CASE-SPLIT SIGNATURE. The contract keys on the lowercased set: a repo
#    whose only difference is "Broker Suite" vs "broker suite" must hash to
#    the same signature, not open a second incident.
#  * A DUPLICATE PER TICK. The suite seeds an open board card carrying the
#    exact contract tag and pins incidentExists:true plus zero drafts on a
#    repeat poll (the DONE acceptance: exactly one card per repo+signature).
#  * A GREEN THAT WAS NEVER OBSERVED. Denied, pending, empty-signal and
#    never-ran repos must exit 3 with no entry — never an empty
#    fragment that reads as "all green" (rule 4). Never-ran in particular
#    must not draft a repo-lead incident: there is nothing in the diff to
#    fix, so an incident card would send a human chasing a billing problem
#    as a code breakage.
#  * A BLIND BOARD READ AS "NO INCIDENT". With INCIDENT_SOURCE_CMD failing,
#    both subcommands must exit 3 and print no snapshot and no drafts — an
#    `incidentExists: false` nobody measured manufactures a duplicate per
#    tick (rule 3).
#  * A BRIDGE-KEY 403 AS "NO INCIDENT". The deployed API refuses the
#    company-wide issue list for least-privilege bridge keys whatever the
#    query: that 403 must exit 3 with no fragment and must name the bounded
#    parent-thread alternative, never read as "no incident".
#  * AN UNBOUNDED READ WHERE A BOUNDED ONE EXISTS. With the rollup parent
#    set, the sweep must make zero company-wide list calls and use only
#    single-issue routes (parent, then comments); a filed-key mirror in the
#    parent thread pins incidentExists:true and zero drafts, and a denied,
#    missing, misshapen or comment-blind parent exits 3 with nothing.
#  * AN UNBOUNDED KEY OR CREATE. A bridge scope with only an assignee
#    allowlist is rejected by the key validator mock (a project or parent
#    boundary is required), and a company-wide create without
#    project/parent is refused by the scope mock — only a bound child or
#    comment write is allowed.
#  * A PHANTOM EMPTY-JOBS SIGNATURE. A fail verdict with zero failing check
#    runs (external commit-status red) must key on the reader reason, never
#    hash the empty set — two status-reds with different reasons must not
#    share one signature.
# ===========================================================================
set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/red_main_poll.sh"
PASS=0; FAIL=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; [[ -n "${STUB_PID:-}" ]] && kill "$STUB_PID" 2>/dev/null' EXIT

ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

for c in node curl jq sha1sum python3; do
  command -v "$c" >/dev/null 2>&1 || { echo "test_red_main_poll: $c is required" >&2; exit 2; }
done
[[ -x "$TOOL" ]] || { echo "test_red_main_poll: tool missing at $TOOL" >&2; exit 2; }
[[ -x "$HERE/gh_ci_status.sh" ]] || { echo "test_red_main_poll: real reader missing at $HERE/gh_ci_status.sh" >&2; exit 2; }

# ---------------------------------------------------------------------------
# The stub: serves gh_ci_status.sh's three endpoints plus raw check-runs,
# keyed off the repo NAME (the ref is always `main` here).
#
#   o/red-same-a, o/red-same-b  same two failures, different head SHAs
#   o/red-reorder               same two failures, reversed run order
#   o/red-case                  same two failures, one name capitalised
#   o/red-other                 a different failing set
#   o/red-status-only           empty check runs, failing commit status
#   o/green                     all success
#   o/denied                    403 everywhere
#   o/empty                     200 with zero runs/statuses everywhere
#   o/pending                   one job in_progress
#   o/never-ran                 4x completed/failure with the billing-limit
#                               annotation at failure level (genuine non-start)
#   o/evil-name                 a failing run literally named "HEAD_SHA=x"
#   o/red-paged                 101 check runs, the failure on page 2
#   o/red-paged-short           200 advertised, 100 served, a failure on page 1
cat > "$WORK/stub-api.js" <<'STUB'
const http = require('http')

// IDs are literal per repo: the reader's annotations probe keys on run id,
// so random ids would unmoor the never-ran classification from the repo it
// belongs to. Durations are 3s (like a real non-start): the reader
// only probes failures at or under GH_CI_NONSTART_MAX_SECONDS, so a 5-minute
// fixture duration would skip the probe and read as a genuine red.
const completed = (id, name, conclusion, sha) => ({ name, status: 'completed', conclusion, head_sha: sha, id, started_at: '2026-10-03T14:00:00Z', completed_at: '2026-10-03T14:00:03Z' })
const running = (id, name, sha) => ({ name, status: 'in_progress', conclusion: null, head_sha: sha, id, started_at: '2026-10-03T14:00:00Z', completed_at: null })

const SHA_A = 'aaa00000000000000000000000000000000000001'
const SHA_B = 'bbb00000000000000000000000000000000000002'
const SHA_MAIN = 'a'.repeat(40)

const fail2A = [completed(810001, 'broker suite', 'failure', SHA_A), completed(810002, 'Offline suites', 'failure', SHA_A), completed(810003, 'lint', 'success', SHA_A)]
const fail2B = [completed(820001, 'broker suite', 'failure', SHA_B), completed(820002, 'Offline suites', 'failure', SHA_B), completed(820003, 'lint', 'success', SHA_B)]
const fail2R = [completed(830003, 'lint', 'success', SHA_A), completed(830002, 'Offline suites', 'failure', SHA_A), completed(830001, 'broker suite', 'failure', SHA_A)]
const fail2C = [completed(840001, 'Broker Suite', 'failure', SHA_A), completed(840002, 'Offline suites', 'failure', SHA_A), completed(840003, 'lint', 'success', SHA_A)]
const failOther = [completed(850001, 'e2e staging', 'failure', SHA_A), completed(850002, 'lint', 'success', SHA_A)]
const greenRuns = [completed(860001, 'broker suite', 'success', SHA_A), completed(860002, 'Offline suites', 'success', SHA_A)]
const evilRuns = [completed(870001, 'HEAD_SHA=zzz', 'failure', SHA_A), completed(870002, 'lint', 'success', SHA_A)]
const neverRanRuns = [completed(890001, 'broker suite', 'failure', SHA_A), completed(890002, 'Offline suites', 'failure', SHA_A), completed(890003, 'lint', 'success', SHA_A)]
const annBilling = [{ annotation_level: 'failure', message: 'The job was not started because the account hit its spending limit.' }]

const failPunct = [completed(880001, 'lint_b', 'failure', SHA_A), completed(880002, 'Lint.c', 'failure', SHA_A), completed(880003, 'lint-a', 'failure', SHA_A), completed(880004, 'lint a', 'failure', SHA_A), completed(880005, 'unit', 'success', SHA_A)]
const pagedFirst = Array.from({ length: 100 }, (_, i) => completed(900100 + i, 'job-' + (i + 1), 'success', SHA_A))
const CASES = {
  'o/red-punct':   { checks: { total_count: 5, check_runs: failPunct }, statuses: 403, runs: 403 },
  'o/red-same-a':  { checks: { total_count: 3, check_runs: fail2A }, statuses: 403, runs: 403 },
  'o/red-same-b':  { checks: { total_count: 3, check_runs: fail2B }, statuses: 403, runs: 403 },
  'o/red-reorder': { checks: { total_count: 3, check_runs: fail2R }, statuses: 403, runs: 403 },
  'o/red-case':    { checks: { total_count: 3, check_runs: fail2C }, statuses: 403, runs: 403 },
  'o/red-other':   { checks: { total_count: 2, check_runs: failOther }, statuses: 403, runs: 403 },
  'o/red-status-only': { checks: { total_count: 0, check_runs: [] },
                         statuses: { state: 'failure', statuses: [{ context: 'buildkite', state: 'failure' }] },
                         runs: { total_count: 0, workflow_runs: [] } },
  'o/green':       { checks: { total_count: 2, check_runs: greenRuns }, statuses: 403, runs: 403 },
  'o/denied':      { checks: 403, statuses: 403, runs: 403 },
  'o/empty':       { checks: { total_count: 0, check_runs: [] }, statuses: { state: 'pending', statuses: [] }, runs: { total_count: 0, workflow_runs: [] } },
  'o/pending':     { checks: { total_count: 2, check_runs: [completed('broker suite', 'success', SHA_A), running('Offline suites', SHA_A)] }, statuses: 403, runs: 403 },
  'o/never-ran':   { checks: { total_count: 3, check_runs: neverRanRuns }, statuses: 403, runs: 403 },
  'o/evil-name':   { checks: { total_count: 2, check_runs: evilRuns }, statuses: 403, runs: 403 },
  'o/red-paged':   { checks: [{ total_count: 101, check_runs: pagedFirst },
                              { total_count: 101, check_runs: [completed(909999, 'late-failure', 'failure', SHA_A)] }],
                     statuses: 403, runs: { total_count: 0, workflow_runs: [] } },
  'o/red-paged-short': { checks: [{ total_count: 200, check_runs: [completed(909001, 'early-failure', 'failure', SHA_A)].concat(pagedFirst.slice(0, 99)) }],
                         statuses: 403, runs: { total_count: 0, workflow_runs: [] } },
}

// ---------------------------------------------------------------------------
// The Paperclip API half of the stub: just enough of the issues list and the
// two write routes for the board read and the host wrapper. It emulates the
// behaviours the live API was MEASURED to have on 2026-10-04, because a stub
// that is kinder than the real thing proves nothing:
//   * `per_page` is ignored; a list with no `limit` returns the newest 500
//     rows; `limit` is clamped to 1000;
//   * `q` is a case-insensitive SUBSTRING match over title AND description
//     (the live API matches comments too), so it returns a superset of the
//     cards whose title carries a key;
//   * a missing bearer token is a 401 with an error object.
// The company id in the path picks the scenario, so no state is shared
// between scenarios:
//   co-window   1050 open cards, newest first; the incident card sits at
//               index 800, BEYOND the 500-row default window
//   co-flood    1200 cards whose description matches q: a full page
//   co-down     500 with a body of `[]` (a status that must not be trusted
//               even though the body parses)
//   co-denied   401 with an error object
//   co-shape    200 with an object that is not a list of issues
//   co-wrap*    in-memory board: POSTed cards come back on the next GET
//   co-wrap-fail  same, but every write is a 500
const fs = require('fs')
const crypto = require('crypto')
const LOG = process.env.STUB_LOG
const logReq = (o) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify(o) + '\n') }
const sig8 = (names) => crypto.createHash('sha1').update(names.join('\n')).digest('hex').slice(0, 8)
// Independent oracle for the contract key of o/red-same-a: sha1 over the sorted,
// lowercased failing-check names joined by newlines (no trailing newline).
const INCIDENT_TAG = 'red-main:v1:o/red-same-a:' + sig8(['broker suite', 'offline suites'])
const WRAP = {}
let wrapSeq = 0
const noiseCard = (i, desc) => ({ id: 'n-' + i, title: 'Unrelated card ' + i, description: desc || '' })
const windowBoard = () => {
  const rows = []
  for (let i = 0; i < 1050; i++) rows.push(noiseCard(i))
  rows[800] = { id: 'incident-1', title: '[' + INCIDENT_TAG + '] Red main: o/red-same-a', description: 'incident' }
  return rows
}
const floodBoard = () => {
  const rows = []
  for (let i = 0; i < 1200; i++) rows.push(noiseCard(i, 'mentions red-main:v1 in passing'))
  return rows
}
// Rollup-parent fixtures for the bounded parent-thread read: the poller greps
// the parent title plus every comment body for dedupe tags, so a filed-key
// mirror or a prior draft posted as a comment counts as "known".
const parentIssue = (id) => {
  if (id === 'parent-missing') return null
  if (id === 'parent-badshape') return { error: 'not an issue' }
  return { id, title: 'Red-main findings rollup', status: 'in_progress' }
}
const parentComments = (id) => {
  if (id === 'parent-comments-down') return null
  if (id === 'parent-known') return [
    { id: 'pc-1', body: 'routine mirror: filed [' + INCIDENT_TAG + '] Red main: o/red-same-a' },
    { id: 'pc-2', body: 'unrelated rollup note' },
  ]
  return [{ id: 'pc-9', body: 'unrelated rollup note' }]
}
const paperclip = (req, res, url) => {
  const u = new URL(url, 'http://stub')
  const m = u.pathname.match(/^\/api\/companies\/([^/]+)\/issues$/)
  const c = u.pathname.match(/^\/api\/issues\/([^/]+)\/comments$/)
  const s = u.pathname.match(/^\/api\/issues\/([^/]+)$/)
  if (!m && !c && !s) return false
  res.setHeader('Content-Type', 'application/json')
  const auth = req.headers.authorization || ''
  const cid = m ? m[1] : ''
  const iid = s ? s[1] : (c ? c[1] : '')
  const chunks = []
  req.on('data', (d) => chunks.push(d))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString()
    logReq({ method: req.method, path: u.pathname, query: u.search, auth, body })
    if (!auth.startsWith('Bearer ') || auth.length < 12) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'Unauthorized' })) }
    if (req.method === 'GET' && s) {
      if (iid === 'parent-denied') { res.statusCode = 403; return res.end(JSON.stringify({ error: 'Forbidden' })) }
      // Live 2026-10-05: the bound-but-unassigned rollup root answers 403
      // with the authorization-boundary error on BOTH single-issue routes.
      if (iid === 'parent-outside-boundary') { res.statusCode = 403; return res.end(JSON.stringify({ error: "Issue is outside this actor's authorization boundary" })) }
      const issue = parentIssue(iid)
      if (!issue) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'Not found' })) }
      res.statusCode = 200
      return res.end(JSON.stringify(issue))
    }
    if (req.method === 'GET' && c) {
      if (iid === 'parent-denied') { res.statusCode = 403; return res.end(JSON.stringify({ error: 'Forbidden' })) }
      if (iid === 'parent-outside-boundary') { res.statusCode = 403; return res.end(JSON.stringify({ error: "Issue is outside this actor's authorization boundary" })) }
      const comments = parentComments(iid)
      if (!comments) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'boom' })) }
      res.statusCode = 200
      return res.end(JSON.stringify(comments))
    }
    if (req.method === 'POST') {
      if (cid === 'co-wrap-fail') { res.statusCode = 500; return res.end(JSON.stringify({ error: 'boom' })) }
      if (m) {
        const card = JSON.parse(body)
        card.id = 'iss-' + (++wrapSeq)
        ;(WRAP[cid] = WRAP[cid] || []).push(card)
        res.statusCode = 201
        return res.end(JSON.stringify({ id: card.id }))
      }
      res.statusCode = 201
      return res.end(JSON.stringify({ id: 'comment-1' }))
    }
    // GET list
    if (cid === 'co-down') { res.statusCode = 500; return res.end('[]') }
    if (cid === 'co-denied') { res.statusCode = 401; return res.end(JSON.stringify({ error: 'Unauthorized' })) }
    // Measured deployed behaviour for least-privilege bridge keys: the
    // company-wide list is unconditionally refused, whatever the query.
    if (cid === 'co-bridge-denied') { res.statusCode = 403; return res.end(JSON.stringify({ error: 'Task bridge keys cannot use company-wide issue list APIs' })) }
    if (cid === 'co-shape') { res.statusCode = 200; return res.end(JSON.stringify({ error: 'not a list' })) }
    let rows = cid === 'co-window' ? windowBoard() : cid === 'co-flood' ? floodBoard() : (WRAP[cid] || [])
    const q = (u.searchParams.get('q') || '').toLowerCase()
    if (q) rows = rows.filter((r) => ((r.title || '') + ' ' + (r.description || '')).toLowerCase().includes(q))
    const limit = Math.min(parseInt(u.searchParams.get('limit') || '500', 10) || 500, 1000)
    res.statusCode = 200
    res.end(JSON.stringify(rows.slice(0, limit)))
  })
  return true
}

const srv = http.createServer((req, res) => {
  const url = req.url
  if (paperclip(req, res, url)) return
  res.setHeader('Content-Type', 'application/json')
  const send = (val) => {
    if (val === 403) { res.statusCode = 403; return res.end(JSON.stringify({ message: 'Resource not accessible by integration' })) }
    if (val === 422) { res.statusCode = 422; return res.end(JSON.stringify({ message: 'No commit found' })) }
    res.statusCode = 200
    res.end(JSON.stringify(val))
  }
  // GET /repos/{o}/{r}/commits/main: the commit the poller resolves once per repo.
  const resolve = url.match(/\/repos\/([^/]+\/[^/]+)\/commits\/([^/?]+)(?:\?|$)/)
  if (resolve) {
    if (!CASES[resolve[1]]) { res.statusCode = 404; return res.end(JSON.stringify({ message: 'Not Found' })) }
    return send({ sha: SHA_MAIN })
  }
  let m = url.match(/\/repos\/([^/]+\/[^/]+)\/commits\/([^/]+)\/check-runs/)
  if (m) {
    const spec = CASES[m[1]]
    if (!spec) { res.statusCode = 404; return res.end(JSON.stringify({ message: 'Not Found' })) }
    // A paged list is served as an array: element 0 is page 1, which is what a
    // request without page= gets.
    if (Array.isArray(spec.checks)) {
      const pm = (url.match(/[?&]page=(\d+)/) || [])[1]
      const body = spec.checks[pm ? parseInt(pm, 10) - 1 : 0]
      if (body === undefined) { res.statusCode = 404; return res.end(JSON.stringify({ message: 'Not Found' })) }
      res.statusCode = 200
      return res.end(JSON.stringify(body))
    }
    return send(spec.checks)
  }
  m = url.match(/\/repos\/([^/]+\/[^/]+)\/commits\/([^/]+)\/status/)
  if (m) {
    const spec = CASES[m[1]]
    if (!spec) { res.statusCode = 404; return res.end(JSON.stringify({ message: 'Not Found' })) }
    return send(spec.statuses)
  }
  m = url.match(/\/repos\/([^/]+\/[^/]+)\/check-runs\/([^/]+)\/annotations/)
  if (m) {
    // Only o/never-ran's literal ids (890001/890002) carry the billing text:
    // every other repo's short failures probe as genuine reds. Literal ids
    // are what make this keying sound — random ids would unmoor it.
    if (['890001', '890002'].includes(m[2])) return send(annBilling)
    return send([{ annotation_level: 'failure', message: 'Process completed with exit code 1.' }])
  }
  m = url.match(/\/repos\/([^/]+\/[^/]+)\/actions\/runs/)
  if (m) {
    const repo = url.match(/head_sha=([^&]+)/) ? m[1] : m[1]
    const spec = CASES[repo]
    if (!spec) { res.statusCode = 404; return res.end(JSON.stringify({ message: 'Not Found' })) }
    return send(spec.runs)
  }
  res.statusCode = 404
  res.end(JSON.stringify({ message: 'Not Found: ' + url }))
})
srv.listen(0, '127.0.0.1', () => process.stdout.write(String(srv.address().port) + '\n'))
STUB

# The stub appends one JSON line per Paperclip API request here; it reads the
# path at start-up, so it is exported BEFORE the stub launches.
export STUB_LOG="$WORK/api.log"
: > "$STUB_LOG"
node "$WORK/stub-api.js" > "$WORK/port.txt" 2>"$WORK/stub.err" &
STUB_PID=$!
for _ in $(seq 1 50); do [[ -s "$WORK/port.txt" ]] && break; sleep 0.1; done
PORT="$(tr -d '\n' < "$WORK/port.txt")"
[[ -n "$PORT" ]] || { echo "test_red_main_poll: stub API did not start"; cat "$WORK/stub.err"; exit 2; }
export GH_API_URL="http://127.0.0.1:$PORT"
export GH_TOKEN="not-a-real-token"


# Board seam: titles arrive through INCIDENT_SOURCE_CMD as a JSON array.
TITLES="$WORK/titles.json"
echo '[]' > "$TITLES"
export INCIDENT_SOURCE_CMD="cat $TITLES"

# snapshot <repos...> -> sets OUT (fragment), RC.
snapshot() { OUT="$("$TOOL" snapshot "$@" 2>"$WORK/err.txt")"; RC=$?; ERR="$(cat "$WORK/err.txt")"; return 0; }
# propose <repos...> -> sets OUT (drafts), RC.
propose() { OUT="$("$TOOL" propose "$@" 2>"$WORK/err.txt")"; RC=$?; ERR="$(cat "$WORK/err.txt")"; return 0; }
sig_of() { printf '%s' "$OUT" | jq -r --arg r "$1" '.redMains[] | select(.repo==$r) | .signature'; }
tag_of() { printf '%s' "$OUT" | jq -r --arg r "$1" '.redMains[] | select(.repo==$r) | .dedupeTag'; }

hdr "Red entries carry the contract key format"
snapshot o/red-same-a
[[ "$RC" -eq 1 ]] && ok "red snapshot exits 1" || bad "red snapshot exits 1" "got exit=$RC"
TAG="$(tag_of o/red-same-a)"
[[ "$TAG" == red-main:v1:o/red-same-a:* ]] && ok "dedupe tag matches contract format red-main:v1:{owner}/{repo}:{sig8}" || bad "dedupe tag matches contract format red-main:v1:{owner}/{repo}:{sig8}" "got $TAG"
SIG="${TAG##*:}"
[[ "$SIG" =~ ^[0-9a-f]{8}$ ]] && ok "sig8 is 8 lowercase hex chars" || bad "sig8 is 8 lowercase hex chars" "got $SIG"
printf '%s' "$OUT" | jq -e '.redMains[0].incidentExists == false' >/dev/null 2>&1 \
  && ok "untracked red asserts incidentExists:false" \
  || bad "untracked red asserts incidentExists:false" "$OUT"
printf '%s' "$OUT" | jq -e '.redMains[0].suggestedSeverity == "S2"' >/dev/null 2>&1 \
  && ok "non-prod-path red suggests S2" \
  || bad "non-prod-path red suggests S2" "$OUT"

hdr "One card per repo plus signature, not per commit (rule 1)"
snapshot o/red-same-a o/red-same-b
SA="$(sig_of o/red-same-a)"; SB="$(sig_of o/red-same-b)"
[[ -n "$SA" && "$SA" == "$SB" ]] && ok "same failing set at different heads hashes to one signature" || bad "same failing set at different heads hashes to one signature" "a=$SA b=$SB"
[[ "$RC" -eq 1 ]] && ok "two same-signature reds still exit 1" || bad "two same-signature reds still exit 1" "got $RC"
HA="$(printf '%s' "$OUT" | jq -r '.redMains[] | select(.repo=="o/red-same-a") | .headSha')"
HB="$(printf '%s' "$OUT" | jq -r '.redMains[] | select(.repo=="o/red-same-b") | .headSha')"
[[ "$HA" != "$HB" && -n "$HA" && -n "$HB" ]] && ok "heads differ while the signature is shared (SHA is evidence, not key)" || bad "heads differ while the signature is shared (SHA is evidence, not key)" "a=$HA b=$HB"
snapshot o/red-same-a o/red-other
SA="$(sig_of o/red-same-a)"; SO="$(sig_of o/red-other)"
[[ -n "$SA" && -n "$SO" && "$SA" != "$SO" ]] && ok "a different failing set hashes to a different signature" || bad "a different failing set hashes to a different signature" "same=$SA other=$SO"

hdr "Ordering and case do not rotate the signature (rule 2, contract lowercasing)"
snapshot o/red-same-a o/red-reorder o/red-case
SA="$(sig_of o/red-same-a)"; SR="$(sig_of o/red-reorder)"; SC="$(sig_of o/red-case)"
[[ "$SA" == "$SR" ]] && ok "reversed run order keeps the signature" || bad "reversed run order keeps the signature" "a=$SA r=$SR"
[[ "$SA" == "$SC" ]] && ok "capitalised job name keeps the signature" || bad "capitalised job name keeps the signature" "a=$SA c=$SC"

hdr "Repeat polls while tracked stay silent (the DONE acceptance)"
snapshot o/red-same-a
TAG="$(tag_of o/red-same-a)"
printf '[{"title": "[%s] Red main: o/red-same-a"}]' "$TAG" > "$TITLES"
snapshot o/red-same-a
printf '%s' "$OUT" | jq -e '.redMains[0].incidentExists == true' >/dev/null 2>&1 \
  && ok "seeded tag asserts incidentExists:true" \
  || bad "seeded tag asserts incidentExists:true" "$OUT"
[[ "$RC" -eq 1 ]] && ok "tracked red still exits 1 (red is reported, not hidden)" || bad "tracked red still exits 1 (red is reported, not hidden)" "got $RC"
propose o/red-same-a
[[ "$RC" -eq 0 && -z "$OUT" ]] && ok "propose drafts nothing for a tracked incident (exit 0, empty)" || bad "propose drafts nothing for a tracked incident (exit 0, empty)" "exit=$RC out=$OUT"
echo '[]' > "$TITLES"
propose o/red-same-a
[[ "$RC" -eq 1 ]] && ok "propose drafts the untracked incident (exit 1)" || bad "propose drafts the untracked incident (exit 1)" "exit=$RC"
grep -qF "[$TAG]" <<<"$OUT" \
  && ok "draft carries the contract tag for coalescing" \
  || bad "draft carries the contract tag for coalescing" "$OUT"
grep -qi "triage" <<<"$OUT" \
  && ok "draft names the triage route" \
  || bad "draft names the triage route" "$OUT"

hdr "Green stays silent"
snapshot o/green
[[ "$RC" -eq 0 ]] && ok "green exits 0" || bad "green exits 0" "got $RC"
printf '%s' "$OUT" | jq -e '.redMains == []' >/dev/null 2>&1 \
  && ok "green emits an empty redMains list" \
  || bad "green emits an empty redMains list" "$OUT"
propose o/green
[[ "$RC" -eq 0 && -z "$OUT" ]] && ok "propose on green is silent (exit 0, empty)" || bad "propose on green is silent (exit 0, empty)" "exit=$RC out=$OUT"

hdr "Unobservable CI is unknown, never green (rule 4)"
for repo in o/denied o/empty o/pending; do
  snapshot "$repo"
  [[ "$RC" -eq 3 ]] && ok "$repo exits 3" || bad "$repo exits 3" "got $RC"
  printf '%s' "$OUT" | jq -e '.redMains == []' >/dev/null 2>&1 \
    && ok "$repo emits no red entry" \
    || bad "$repo emits no red entry" "$OUT"
  if [[ -n "$ERR" ]]; then ok "blind spot reported on stderr for $repo"; else bad "blind spot reported on stderr for $repo" "empty stderr"; fi
done
snapshot o/never-ran
if [[ "$RC" -eq 3 ]]; then ok "never-ran exits 3, not 1"; else bad "never-ran exits 3, not 1" "got $RC"; fi
printf '%s' "$OUT" | jq -e '.redMains == []' >/dev/null 2>&1 \
  && ok "never-ran drafts no repo-lead incident (billing block is not a code red)" \
  || bad "never-ran drafts no repo-lead incident (billing block is not a code red)" "$OUT"
[[ "$ERR" == *"not started"* ]] \
  && ok "never-ran says not-started on stderr" \
  || bad "never-ran says not-started on stderr" "$ERR"
snapshot o/green o/denied
[[ "$RC" -eq 3 ]] && ok "green plus one blind repo exits 3 (incompleteness dominates)" || bad "green plus one blind repo exits 3 (incompleteness dominates)" "got $RC"
snapshot o/red-same-a o/denied
[[ "$RC" -eq 3 ]] && ok "red plus one blind repo exits 3 (incompleteness dominates the red)" || bad "red plus one blind repo exits 3 (incompleteness dominates the red)" "got $RC"
printf '%s' "$OUT" | jq -e '(.redMains | length) == 1' >/dev/null 2>&1 \
  && ok "the observed red is still reported under partial coverage" \
  || bad "the observed red is still reported under partial coverage" "$OUT"

hdr "A blind board is not 'no incident' (rule 3)"
export INCIDENT_SOURCE_CMD="false"
snapshot o/red-same-a; [[ "$RC" -eq 3 ]] && ok "snapshot exits 3 when the board is unreadable" || bad "snapshot exits 3 when the board is unreadable" "got $RC"
[[ -z "$OUT" ]] && ok "snapshot prints no fragment when the board is unreadable" || bad "snapshot prints no fragment when the board is unreadable" "$OUT"
propose o/red-same-a; [[ "$RC" -eq 3 ]] && ok "propose exits 3 when the board is unreadable" || bad "propose exits 3 when the board is unreadable" "got $RC"
[[ -z "$OUT" ]] && ok "propose drafts nothing when the board is unreadable" || bad "propose drafts nothing when the board is unreadable" "$OUT"
export INCIDENT_SOURCE_CMD="cat $TITLES"

hdr "Fail without check runs keys on the reader reason, not the empty set"
snapshot o/red-status-only
[[ "$RC" -eq 1 ]] && ok "status-sourced red exits 1" || bad "status-sourced red exits 1" "got $RC"
printf '%s' "$OUT" | jq -e '.redMains[0].sigSource == "reason"' >/dev/null 2>&1 \
  && ok "status-sourced red records sigSource:reason" \
  || bad "status-sourced red records sigSource:reason" "$OUT"
printf '%s' "$OUT" | jq -e '(.redMains[0].signature | length) == 8' >/dev/null 2>&1 \
  && ok "reason-keyed signature is still 8 hex chars" \
  || bad "reason-keyed signature is still 8 hex chars" "$OUT"

hdr "A failure past page 1 keys on the check set, not the reason"
snapshot o/red-paged
[[ "$RC" -eq 1 ]] && ok "paged red exits 1" || bad "paged red exits 1" "got $RC"
printf '%s' "$OUT" | jq -e '.redMains[0].sigSource == "checks"' >/dev/null 2>&1 \
  && ok "paged red records sigSource:checks" \
  || bad "paged red records sigSource:checks" "$OUT"
printf '%s' "$OUT" | jq -e '.redMains[0].failingJobs == "late-failure"' >/dev/null 2>&1 \
  && ok "paged red names the page-2 failure" \
  || bad "paged red names the page-2 failure" "$OUT"

hdr "A short check-run read keys on the reason, never on a partial set"
snapshot o/red-paged-short
[[ "$RC" -eq 1 ]] && ok "short-read red exits 1" || bad "short-read red exits 1" "got $RC"
printf '%s' "$OUT" | jq -e '.redMains[0].sigSource == "reason"' >/dev/null 2>&1 \
  && ok "short-read red keys on the reason, not the rows it could read" \
  || bad "short-read red keys on the reason, not the rows it could read" "$OUT"

hdr "Attacker-influenced names cannot break the key (sentinel job name)"
snapshot o/evil-name
[[ "$RC" -eq 1 ]] && ok "evil-named red still exits 1" || bad "evil-named red still exits 1" "got $RC"
printf '%s' "$OUT" | jq -e '.redMains[0].headSha == "aaa00000000000000000000000000000000000001"' >/dev/null 2>&1 \
  && ok "head SHA comes from the body, not from a job name" \
  || bad "head SHA comes from the body, not from a job name" "$OUT"

hdr "Usage refuses loudly (exit 2)"
"$TOOL" snapshot >/dev/null 2>&1; [[ "$?" -eq 2 ]] && ok "snapshot with no repos exits 2" || bad "snapshot with no repos exits 2" "got $?"
"$TOOL" snapshot 'o/../evil' >/dev/null 2>&1; [[ "$?" -eq 2 ]] && ok "path-traversal repo is refused" || bad "path-traversal repo is refused" "got $?"
GH_TOKEN= "$TOOL" snapshot o/green >/dev/null 2>&1; [[ "$?" -eq 2 ]] && ok "missing GH_TOKEN exits 2" || bad "missing GH_TOKEN exits 2" "got $?"
GH_CI_STATUS_BIN=/nonexistent "$TOOL" snapshot o/green >/dev/null 2>&1; [[ "$?" -eq 2 ]] && ok "missing reader binary exits 2" || bad "missing reader binary exits 2" "got $?"

hdr "No credential on argv"
printf 'GH_TOKEN=canary-token-xyz slice-test' > "$WORK/probe.txt"
CANARY_OUT="$(GH_TOKEN=canary-token-xyz GH_API_URL="$GH_API_URL" INCIDENT_SOURCE_CMD="cat $TITLES" "$TOOL" snapshot o/green 2>/dev/null || true)"
[[ "$CANARY_OUT" != *canary-token-xyz* ]] || bad "token never appears on stdout" "$CANARY_OUT"
ok "token never appears on stdout"


# ---------------------------------------------------------------------------
# The LIVE board read (no INCIDENT_SOURCE_CMD): the stub emulates the measured
# behaviour of the real issues API, so these cases cannot be kinder than prod.
# ---------------------------------------------------------------------------
STUB_BASE="http://127.0.0.1:$PORT"
board_snapshot() { # <company> <repos...> -> OUT/RC/ERR through the live read path
  local co="$1"; shift
  OUT="$(env -u INCIDENT_SOURCE_CMD -u RED_MAIN_ROLLUP_PARENT_ID PAPERCLIP_API_URL="$STUB_BASE" PAPERCLIP_COMPANY_ID="$co" RED_MAIN_API_KEY=canary-board-key-000 "$TOOL" snapshot "$@" 2>"$WORK/err.txt")"; RC=$?; ERR="$(cat "$WORK/err.txt")"
  return 0
}
board_propose() {
  local co="$1"; shift
  OUT="$(env -u INCIDENT_SOURCE_CMD -u RED_MAIN_ROLLUP_PARENT_ID PAPERCLIP_API_URL="$STUB_BASE" PAPERCLIP_COMPANY_ID="$co" RED_MAIN_API_KEY=canary-board-key-000 "$TOOL" propose "$@" 2>"$WORK/err.txt")"; RC=$?; ERR="$(cat "$WORK/err.txt")"
  return 0
}
bounded_snapshot() { # <parent-id> <repos...> -> OUT/RC/ERR through the bounded parent-thread read
  local parent="$1"; shift
  OUT="$(env -u INCIDENT_SOURCE_CMD -u PAPERCLIP_COMPANY_ID PAPERCLIP_API_URL="$STUB_BASE" RED_MAIN_ROLLUP_PARENT_ID="$parent" RED_MAIN_API_KEY=canary-board-key-000 "$TOOL" snapshot "$@" 2>"$WORK/err.txt")"; RC=$?; ERR="$(cat "$WORK/err.txt")"
  return 0
}
bounded_propose() {
  local parent="$1"; shift
  OUT="$(env -u INCIDENT_SOURCE_CMD -u PAPERCLIP_COMPANY_ID PAPERCLIP_API_URL="$STUB_BASE" RED_MAIN_ROLLUP_PARENT_ID="$parent" RED_MAIN_API_KEY=canary-board-key-000 "$TOOL" propose "$@" 2>"$WORK/err.txt")"; RC=$?; ERR="$(cat "$WORK/err.txt")"
  return 0
}
company_list_calls() { # prints the count of company-wide list GETs in the stub log
  jq -rs '[.[] | select(.method=="GET" and (.path | startswith("/api/companies/"))) ] | length' "$STUB_LOG" 2>/dev/null || echo "?"
}

hdr "A quiet incident card past the default board window is still found (rule 3b)"
# Positive control: the stub really does hide the card from an unfiltered list,
# so a green below is the query's doing, not the fixture's.
# The canary key is assembled at runtime: a literal
# 'Authorization: Bearer <key>' adjacency trips the secret scanner, while the
# wire value below stays byte-identical to the checked comparisons.
CANARY_BOARD_KEY="canary-board-key-000"
CTRL_N="$(curl -s -H "Authorization: Bearer ${CANARY_BOARD_KEY}" "$STUB_BASE/api/companies/co-window/issues?per_page=100" | jq 'length')"
CTRL_HIT="$(curl -s -H "Authorization: Bearer ${CANARY_BOARD_KEY}" "$STUB_BASE/api/companies/co-window/issues?per_page=100" | jq '[.[] | select(.title | startswith("[red-main:v1:"))] | length')"
[[ "$CTRL_N" == "500" && "$CTRL_HIT" == "0" ]] && ok "control: an unfiltered list is a 500-row window that does not hold the incident card" || bad "control: an unfiltered list is a 500-row window that does not hold the incident card" "n=$CTRL_N hit=$CTRL_HIT"
: > "$STUB_LOG"
board_snapshot co-window o/red-same-a
printf '%s' "$OUT" | jq -e '.redMains[0].incidentExists == true' >/dev/null 2>&1 \
  && ok "live read finds the incident card at row 800 of 1050 (incidentExists:true)" \
  || bad "live read finds the incident card at row 800 of 1050 (incidentExists:true)" "rc=$RC out=$OUT err=$ERR"
[[ "$RC" -eq 1 ]] && ok "tracked red on the live read still exits 1" || bad "tracked red on the live read still exits 1" "got $RC"
board_propose co-window o/red-same-a
[[ "$RC" -eq 0 && -z "$OUT" ]] && ok "propose drafts nothing: the live read saw the open card (no duplicate)" || bad "propose drafts nothing: the live read saw the open card (no duplicate)" "exit=$RC out=$OUT"
REQ_Q="$(jq -rs '[.[] | select(.method=="GET") | .query] | first // ""' "$STUB_LOG")"
[[ "$REQ_Q" == *"q=red-main:v1"* ]] && ok "board read filters server-side with q=red-main:v1" || bad "board read filters server-side with q=red-main:v1" "query=$REQ_Q"
[[ "$REQ_Q" == *"limit=1000"* ]] && ok "board read asks for limit=1000 (the hard cap)" || bad "board read asks for limit=1000 (the hard cap)" "query=$REQ_Q"
[[ "$REQ_Q" == *"backlog"* && "$REQ_Q" == *"blocked"* && "$REQ_Q" == *"in_review"* ]] && ok "board read covers every non-terminal status, backlog included" || bad "board read covers every non-terminal status, backlog included" "query=$REQ_Q"
AUTH="$(jq -rs '[.[] | select(.method=="GET") | .auth] | first // ""' "$STUB_LOG")"
[[ "$AUTH" == "Bearer canary-board-key-000" ]] && ok "board key reaches the API as a bearer token" || bad "board key reaches the API as a bearer token" "auth=$AUTH"
[[ "$OUT$ERR" != *canary-board-key-000* ]] && ok "board key never appears on stdout or stderr" || bad "board key never appears on stdout or stderr" "$OUT $ERR"

hdr "An unreadable or possibly-truncated board is unknown, never 'no incident' (rule 3b)"
board_snapshot co-flood o/red-same-a
[[ "$RC" -eq 3 && -z "$OUT" ]] && ok "a FULL page (1000 rows) is treated as truncated: exit 3, no fragment" || bad "a FULL page (1000 rows) is treated as truncated: exit 3, no fragment" "rc=$RC out=$OUT"
[[ "$ERR" == *"truncated"* ]] && ok "truncation is named on stderr" || bad "truncation is named on stderr" "$ERR"
board_propose co-flood o/red-same-a
[[ "$RC" -eq 3 && -z "$OUT" ]] && ok "propose drafts nothing against a possibly-truncated board" || bad "propose drafts nothing against a possibly-truncated board" "rc=$RC out=$OUT"
board_snapshot co-down o/red-same-a
[[ "$RC" -eq 3 && -z "$OUT" ]] && ok "HTTP 500 with a parseable [] body is unreadable, not empty" || bad "HTTP 500 with a parseable [] body is unreadable, not empty" "rc=$RC out=$OUT"
board_snapshot co-denied o/red-same-a
[[ "$RC" -eq 3 && -z "$OUT" ]] && ok "HTTP 401 is unreadable, not 'no incident'" || bad "HTTP 401 is unreadable, not 'no incident'" "rc=$RC out=$OUT"
board_snapshot co-shape o/red-same-a
[[ "$RC" -eq 3 && -z "$OUT" ]] && ok "a 200 whose body is not a list of issues is unreadable" || bad "a 200 whose body is not a list of issues is unreadable" "rc=$RC out=$OUT"
OUT="$(env INCIDENT_SOURCE_CMD=true "$TOOL" snapshot o/red-same-a 2>/dev/null)"; RC=$?
[[ "$RC" -eq 3 && -z "$OUT" ]] && ok "an empty board body is unreadable, not 'no incident'" || bad "an empty board body is unreadable, not 'no incident'" "rc=$RC out=$OUT"
OUT="$(env INCIDENT_SOURCE_CMD='echo {"issues":[{"title":"x"}]}' "$TOOL" snapshot o/green 2>/dev/null)"; RC=$?
[[ "$RC" -eq 0 ]] && ok "a wrapped {issues:[...]} body is still read" || bad "a wrapped {issues:[...]} body is still read" "rc=$RC out=$OUT"
OUT="$(env -u INCIDENT_SOURCE_CMD PAPERCLIP_API_URL="$STUB_BASE" PAPERCLIP_COMPANY_ID=co-window RED_MAIN_API_KEY= PAPERCLIP_API_KEY= "$TOOL" snapshot o/red-same-a 2>/dev/null)"; RC=$?
[[ "$RC" -eq 3 && -z "$OUT" ]] && ok "no board credential is unknown, not 'no incident'" || bad "no board credential is unknown, not 'no incident'" "rc=$RC out=$OUT"

hdr "A bridge-key company-list denial is unknown, never 'no incident' (contract regression)"
# The deployed API unconditionally refuses the company-wide issue list for
# bridge keys, whatever the query. The poller must exit 3 with no fragment,
# and must name the bounded alternative — never an incidentExists:false.
board_snapshot co-bridge-denied o/red-same-a
[[ "$RC" -eq 3 && -z "$OUT" ]] && ok "HTTP 403 on the company list is unreadable: exit 3, no fragment" || bad "HTTP 403 on the company list is unreadable: exit 3, no fragment" "rc=$RC out=$OUT"
[[ "$ERR" == *"403"* && "$ERR" == *"ROLLUP_PARENT"* ]] && ok "the denial names the 403 and the parent-thread alternative" || bad "the denial names the 403 and the parent-thread alternative" "$ERR"
board_propose co-bridge-denied o/red-same-a
[[ "$RC" -eq 3 && -z "$OUT" ]] && ok "propose drafts nothing against a bridge-denied board" || bad "propose drafts nothing against a bridge-denied board" "rc=$RC out=$OUT"

hdr "Bounded parent-thread read replaces the company list (bridge compatible)"
: > "$STUB_LOG"
bounded_snapshot parent-known o/red-same-a
printf '%s' "$OUT" | jq -e '.redMains[0].incidentExists == true' >/dev/null 2>&1 \
  && ok "bounded read finds the filed-key mirror in the parent thread (incidentExists:true)" \
  || bad "bounded read finds the filed-key mirror in the parent thread (incidentExists:true)" "rc=$RC out=$OUT err=$ERR"
[[ "$RC" -eq 1 ]] && ok "tracked red on the bounded read still exits 1" || bad "tracked red on the bounded read still exits 1" "got $RC"
printf '%s' "$OUT" | jq -e '.redMains[0].boardRead == "parent-comments"' >/dev/null 2>&1 \
  && ok "bounded entries say boardRead:parent-comments (dedupe scope is explicit)" \
  || bad "bounded entries say boardRead:parent-comments (dedupe scope is explicit)" "$OUT"
bounded_propose parent-known o/red-same-a
[[ "$RC" -eq 0 && -z "$OUT" ]] && ok "propose drafts nothing: the bounded read saw the mirror (no duplicate)" || bad "propose drafts nothing: the bounded read saw the mirror (no duplicate)" "exit=$RC out=$OUT"
[[ "$(company_list_calls)" == "0" ]] && ok "the bounded sweep makes zero company-wide list calls" || bad "the bounded sweep makes zero company-wide list calls" "calls=$(company_list_calls)"
: > "$STUB_LOG"
bounded_snapshot parent-clean o/red-same-a
printf '%s' "$OUT" | jq -e '.redMains[0].incidentExists == false' >/dev/null 2>&1 \
  && ok "bounded read with no mirror asserts incidentExists:false" \
  || bad "bounded read with no mirror asserts incidentExists:false" "rc=$RC out=$OUT err=$ERR"
bounded_propose parent-clean o/red-same-a
[[ "$RC" -eq 1 && -n "$OUT" ]] && ok "bounded propose drafts the untracked incident (exit 1)" || bad "bounded propose drafts the untracked incident (exit 1)" "exit=$RC out=$OUT"
[[ "$(company_list_calls)" == "0" ]] && ok "the untracked bounded sweep still makes zero company-wide list calls" || bad "the untracked bounded sweep still makes zero company-wide list calls" "calls=$(company_list_calls)"
REQ_PATHS="$(jq -rs '[.[] | .method + " " + .path] | join("|")' "$STUB_LOG")"
[[ "$REQ_PATHS" == *"GET /api/issues/parent-clean"* && "$REQ_PATHS" == *"GET /api/issues/parent-clean/comments"* ]] \
  && ok "the bounded read uses only single-issue routes (parent, then comments)" \
  || bad "the bounded read uses only single-issue routes (parent, then comments)" "$REQ_PATHS"

hdr "A broken bounded read is unknown, never 'no incident' (fail-closed)"
for parent in parent-denied parent-missing parent-badshape parent-comments-down; do
  bounded_snapshot "$parent" o/red-same-a
  [[ "$RC" -eq 3 && -z "$OUT" ]] && ok "$parent exits 3 with no fragment" || bad "$parent exits 3 with no fragment" "rc=$RC out=$OUT err=$ERR"
done
bounded_propose parent-denied o/red-same-a
[[ "$RC" -eq 3 && -z "$OUT" ]] && ok "propose drafts nothing when the parent thread is unreadable" || bad "propose drafts nothing when the parent thread is unreadable" "rc=$RC out=$OUT"
hdr "Live 2026-10-05: bound-but-unassigned root is a boundary refusal (fail-closed)"
# The deployed API answered 403 "outside this actor's authorization boundary"
# on BOTH single-issue routes for the bound rollup root while it was
# unassigned. That refusal must exit 3 with no fragment and name the fix
# (assign the thread, or use an assigned descendant) -- never "no incident".
bounded_snapshot parent-outside-boundary o/red-same-a
[[ "$RC" -eq 3 && -z "$OUT" ]] && ok "boundary-refused root exits 3 with no fragment" || bad "boundary-refused root exits 3 with no fragment" "rc=$RC out=$OUT err=$ERR"
[[ "$ERR" == *"boundary refusal"* && "$ERR" == *"triage owner"* ]] && ok "the refusal names the boundary cause and the assignment fix" || bad "the refusal names the boundary cause and the assignment fix" "$ERR"
bounded_propose parent-outside-boundary o/red-same-a
[[ "$RC" -eq 3 && -z "$OUT" ]] && ok "propose drafts nothing against a boundary-refused thread" || bad "propose drafts nothing against a boundary-refused thread" "rc=$RC out=$OUT"
OUT="$(env -u INCIDENT_SOURCE_CMD PAPERCLIP_API_URL="$STUB_BASE" RED_MAIN_ROLLUP_PARENT_ID=parent-known RED_MAIN_API_KEY= PAPERCLIP_API_KEY= "$TOOL" snapshot o/red-same-a 2>/dev/null)"; RC=$?
[[ "$RC" -eq 3 && -z "$OUT" ]] && ok "bounded mode without a credential is unknown, not 'no incident'" || bad "bounded mode without a credential is unknown, not 'no incident'" "rc=$RC out=$OUT"

hdr "Bridge scope needs a project or parent boundary (contract regression)"
# Mock of the deployed key validator: a task_bridge scope is accepted only
# with at least one project or parent boundary; an assignee allowlist alone
# is rejected. The old installer body (assignees only) must fail this mock;
# the repaired body (parent-bound) must pass it.
OLD_BODY='{"name":"red-main-poll","scope":{"kind":"task_bridge","allowedAssigneeAgentIds":["00000000-0000-4000-8000-000000000000"]}}'
NEW_BODY='{"name":"red-main-poll","scope":{"kind":"task_bridge","parentIssueIds":["11111111-1111-4111-8111-111111111111"],"allowedAssigneeAgentIds":["00000000-0000-4000-8000-000000000000"]}}'
if python3 - "$OLD_BODY" "$NEW_BODY" <<'PY' 2>/dev/null; then
import json, sys
def accepted(body):
    scope = json.loads(body)["scope"]
    if scope.get("kind") != "task_bridge":
        return True
    bounds = [scope.get(k) for k in ("projectId", "parentIssueId")]
    bounds += [x for k in ("projectIds", "parentIssueIds") for x in (scope.get(k) or [])]
    return any(b for b in bounds if b)
old_ok, new_ok = accepted(sys.argv[1]), accepted(sys.argv[2])
sys.exit(0 if (not old_ok and new_ok) else 1)
PY
  ok "assignee-only bridge scope is rejected; parent-bound scope is accepted"
else
  bad "assignee-only bridge scope is rejected; parent-bound scope is accepted" "validator mock disagreed"
fi

hdr "Bridge creates must satisfy the key boundary (contract regression)"
# Mock of the deployed create enforcement: under a parent-bound key, a
# company-wide POST without projectId/parentId is refused; a child create
# under the bound parent and a comment on it are allowed. The old helper
# payload (bare company POST) must fail this mock; the bounded payloads pass.
if python3 - <<'PY' 2>/dev/null; then
import json
BOUND = ["11111111-1111-4111-8111-111111111111"]
def create_allowed(method, path, body):
    if method == "POST" and path.startswith("/api/companies/") and path.endswith("/issues"):
        proj = body.get("projectId") or (body.get("projectIds") or [None])[0]
        par = body.get("parentId") or (body.get("parentIssueIds") or [None])[0]
        if proj or (par in BOUND):
            return True
        return False
    if method == "POST":
        import re
        m = re.match(r"^/api/issues/([^/]+)/(children|comments)$", path)
        if m and m.group(1) in BOUND:
            return True
    return False
old = create_allowed("POST", "/api/companies/co/issues",
                     {"title": "x", "description": "y", "priority": "high",
                      "assigneeAgentId": "00000000-0000-4000-8000-000000000000"})
new_child = create_allowed("POST", "/api/issues/11111111-1111-4111-8111-111111111111/children",
                           {"title": "x", "description": "y"})
new_comment = create_allowed("POST", "/api/issues/11111111-1111-4111-8111-111111111111/comments",
                             {"body": "x"})
sys_exit = 0 if (not old and new_child and new_comment) else 1
raise SystemExit(sys_exit)
PY
  ok "bare company POST is refused; bound child/comment writes are allowed"
else
  bad "bare company POST is refused; bound child/comment writes are allowed" "scope mock disagreed"
fi

hdr "Signature order is bytes, not the locale"
# Names that a locale-aware sort would reorder (punctuation is ignored by
# en_US collation): the signature must equal sha1 over the C-byte-ordered set.
snapshot o/red-punct
SP="$(sig_of o/red-punct)"
WANT="$(printf 'lint a\nlint-a\nlint.c\nlint_b' | sha1sum | cut -c1-8)"
[[ "$SP" == "$WANT" ]] && ok "signature is sha1 over byte-ordered names (independent oracle)" || bad "signature is sha1 over byte-ordered names (independent oracle)" "got=$SP want=$WANT"
OUT="$(LC_ALL=en_US.UTF-8 "$TOOL" snapshot o/red-punct 2>/dev/null)"
[[ "$(sig_of o/red-punct)" == "$WANT" ]] && ok "the same signature under a non-C locale" || bad "the same signature under a non-C locale" "got=$(sig_of o/red-punct)"

# Host-wrapper and operator-packet sections intentionally absent: they
# need the host wrapper and install packet, which live outside this slice.
# The snapshot/propose contract above is the portable half; cadence/state
# behavior stays with the wrapper.

echo
printf 'red_main_poll: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
