#!/usr/bin/env bash
# ===========================================================================
# approval_timeout_probe.sh — the tool-approval deadline is displayed, not kept
# ---------------------------------------------------------------------------
# WHAT THE ORIGINAL FINDING SAID, AND WHERE IT WAS WRONG.
# An earlier report claimed that `tool_action_requests.expires_at`
# "is never set", on the evidence that the single `insert(toolActionRequests)`
# does not write it. The insert really does not write it — and the conclusion
# still does not follow, because the value arrives one statement later in an
# UPDATE:
#
#   dist/services/tool-gateway.js:1272   .set({ ..., expiresAt, ... })
#   src/services/tool-gateway.ts:1720    (same, one hour out — :1136 / :1575)
#
# So a row IS born NULL and IS then stamped with a deadline of now + 1 h on the
# ordinary approval path. The same value is published to the approver, into the
# interaction card payload, at dist:1259 / src:1710.
#
# THE REAL DEFECT IS NARROWER AND WORSE THAN THE ONE THAT WAS FILED.
# The deadline is written, shown to a human, and then nothing is holding a
# clock against it:
#
#   1. Both enforcement sites are lazy AND requester-triggered. Expiry runs
#      only when the SAME agent re-invokes the SAME tool with the SAME
#      canonicalArgumentsHash on the SAME issue (dist:3646, dist:4706). The
#      party that is WAITING on the approval cannot cause it.
#   2. Nothing sweeps the table on a timer. Of the four bundle modules that
#      touch `toolActionRequests`, zero register a `setInterval`.
#   3. The neighbouring sweeper proves this is a pattern, not an oversight:
#      `cleanupExpiredSessions` is fully written at dist:5377 and called from
#      nowhere but its own test. Written is not scheduled.
#
# A deadline that is rendered on the approver's card and never enforced is a
# worse failure than no deadline at all: the approver is told the request will
# lapse at T, so a request still sitting there at T+3d reads as impossible
# rather than as stuck. The original version of the finding would have sent the
# fix to the wrong place — adding a write that is already there — and left the
# missing clock in place.
#
# ---------------------------------------------------------------------------
# WHAT THIS IS NOT. It is not a timeout, and it expires nothing. An earlier
# decision deliberately declined to build a local imitation of one, because a
# version living in this repo would have put a green checkbox over an unchanged
# failure mode. That reasoning holds. This file WRITES NOTHING. It is a conformance
# probe over a defect we do not own, plus an alarm on its consequence.
#
# WHY BOTHER, EVEN WHEN THE TABLE HAS ZERO ROWS INSTANCE-WIDE. That is the
# argument for it, not against it. If the path has never executed on an
# instance, the absence of complaints is not evidence that it works — the
# FIRST real approval request is the one that strands, and nothing else
# watches this table.
# `queue_liveness.sh` watches agent reachability and the provisioner
# queue; it never reads `tool_action_requests`.
#
# WHY IT ALARMS ON BEING FIXED. Exit 3 fires when the deployed bundle stops
# matching the findings above. That is an assumption alarm, not a regression
# alarm. Everything we do around tool approvals assumes the deadline is
# decorative and a human or an alarm must close the loop. The day Paperclip
# ships the missing clock, that assumption inverts silently — this is a vendor
# bundle that changes under us with no changelog we ever see.
#
# ---------------------------------------------------------------------------
# WE CANNOT FIX IT AND THIS FILE DOES NOT PRETEND TO.
# What remains to be built is a sweeper that moves timed-out `pending` rows to
# `expired` without the requester returning, and that reconciles the invocation
# `approvalState` and `idempotencyKey` the way the lazy path already does.
# Measured, we have no path to ship it: `/app/server` is not a git checkout, and
# `/app` is a podman overlay recreated from the image on restart — the restart
# that would deploy an edit is the same event that erases it.
#
# ---------------------------------------------------------------------------
# WHY THE BUNDLE SCAN IS NODE AND NOT GREP.
# Whitespace: the two enforcement guards are formatted differently (one
# same-line, one wrapped), so a line-oriented match must choose between missing
# one and matching too much. And grep has been observed on this box returning
# rc=1 with no output for a string demonstrably present. `node` is not an added
# dependency in the only place this command means anything — the bundle it reads
# IS a node program, so where there is a dist there is a node. Where there is
# not, this exits 5, never 0.
#
# A NOTE ON THE FIRST VERSION OF A3, BECAUSE THE MISTAKE IS INSTRUCTIVE.
# It asked "does a module contain both the table and a timer", and went red on
# the real bundle: `tool-gateway.js` has four `setTimeout`s, all of them abort
# controllers and retry sleeps. A proxy that is merely correlated with the thing
# you care about produces a red that everyone learns to wave through. This asks
# for `setInterval` — a REPEATING clock — which is the only shape a sweeper can
# take.
#
# ---------------------------------------------------------------------------
# EXIT CODES — the interface. Gate on these, never on printed text.
#   0  measured; defect present exactly as documented and nothing is stranded
#   2  refused (bad usage, unreadable input)
#   3  DRIFT: the deployed bundle no longer matches the documented findings
#   4  STRANDED: pending rows exist that no party will ever expire
#   5  UNKNOWN: could not measure. NOT green.
#
# Precedence when more than one applies: 5 beats 4 beats 3. Being blind
# outranks live harm, and live harm outranks a changed model — because a
# partial measurement must never be reported as the whole one.
# ===========================================================================
set -uo pipefail

ME="$(basename "${BASH_SOURCE[0]}")"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

EXIT_OK=0; EXIT_REFUSED=2; EXIT_DRIFT=3; EXIT_STRANDED=4; EXIT_UNKNOWN=5

# Where the RUNNING server's compiled bundle lives. Overridable so the suite can
# point at a synthetic tree, and so an operator can probe a staged build.
DIST_DEFAULT="${PAPERCLIP_SERVER_DIST:-/app/server/dist}"

EXPLAIN=0

c_red() { printf '\033[31m%s\033[0m\n' "$*"; }
c_grn() { printf '\033[32m%s\033[0m\n' "$*"; }
c_yel() { printf '\033[33m%s\033[0m\n' "$*"; }
die()   { c_red "$ME: REFUSED: $*" >&2; exit $EXIT_REFUSED; }
note()  { [ "$EXPLAIN" -eq 1 ] && printf '      %s\n' "$*"; return 0; }

# A count that is empty, or is not made only of digits, is NOT a number.
# `[[ "" -eq 0 ]]` is TRUE in bash: an unset count would sail through every
# comparison below as a zero and report "clean" for a measurement that never
# happened. Everything numeric goes through here first.
is_count() { case "${1-}" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

# --- the bundle scan --------------------------------------------------------
# Emits KEY=VALUE lines on stdout and EV<TAB>text evidence lines. Silent about
# anything it could not read: the caller decides that absence is UNKNOWN.
BUNDLE_SCANNER='
const fs = require("fs"), path = require("path");
const root = process.argv[1];
const out = [], ev = [];
const files = [];
(function walk(d) {
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); }
    else if (e.isFile() && p.endsWith(".js")) files.push(p);
  }
})(root);

const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const lineOf = (text, idx) => text.slice(0, idx).split("\n").length;
const rel = (p) => path.relative(root, p);
const countAll = (hay, needle) => {
  let n = 0, i = 0;
  for (;;) { const j = hay.indexOf(needle, i); if (j < 0) break; n++; i = j + needle.length; }
  return n;
};
// The statement that begins at `from` and ends at the first `stop` after it.
// Bounded, so a missing terminator reads a fixed window rather than the file.
const stmt = (text, from, stop) => {
  const end = text.indexOf(stop, from);
  return text.slice(from, end < 0 ? from + 2000 : end);
};

let scanned = 0, targetFiles = 0;
let insertSites = 0, insertWithExpiry = 0;
let updateSites = 0, updateWithExpiry = 0;
let enforceSites = 0, enforceGuarded = 0;
let clockFiles = 0;
let cleanupDefs = 0, cleanupRefs = 0;

const INSERT  = "insert(toolActionRequests)";
const UPDATE  = "update(toolActionRequests)";
const GETTIME = "actionRequest.expiresAt.getTime()";
const CLEANUP = "cleanupExpiredSessions";

for (const f of files) {
  const text = read(f);
  if (text === null) continue;
  scanned++;

  const hasTarget = text.includes("toolActionRequests");
  if (hasTarget) targetFiles++;

  // A1a — creation. Read the values object itself, from the insert call to the
  // .returning() that closes it, rather than asking whether the word appears
  // somewhere in a five-thousand-line file.
  let i = 0;
  for (;;) {
    const j = text.indexOf(INSERT, i); if (j < 0) break;
    insertSites++;
    const withExpiry = stmt(text, j, ".returning()").includes("expiresAt");
    if (withExpiry) insertWithExpiry++;
    ev.push(`A1 ${rel(f)}:${lineOf(text, j)} insert values-block ${withExpiry ? "SETS" : "omits"} expiresAt`);
    i = j + INSERT.length;
  }

  // A1b — the deadline that IS written, one statement later. This is the half
  // the original finding missed by looking only at the insert.
  i = 0;
  for (;;) {
    const j = text.indexOf(UPDATE, i); if (j < 0) break;
    updateSites++;
    const withExpiry = stmt(text, j, ".where(").includes("expiresAt");
    if (withExpiry) { updateWithExpiry++;
      ev.push(`A1 ${rel(f)}:${lineOf(text, j)} update set-block SETS expiresAt`); }
    i = j + UPDATE.length;
  }

  // A2 — every enforcement site, and how many are null-guarded. Whitespace is
  // collapsed first so the wrapped guard and the same-line guard read alike.
  const flat = text.replace(/\s+/g, " ");
  const sites = countAll(flat, GETTIME);
  if (sites > 0) {
    enforceSites += sites;
    enforceGuarded += countAll(flat, "actionRequest.expiresAt && match." + GETTIME)
                    + countAll(flat, "actionRequest.expiresAt && " + GETTIME);
    let k = 0;
    for (;;) { const j = text.indexOf("actionRequest.expiresAt", k); if (j < 0) break;
      if (text.slice(j, j + GETTIME.length + 8).includes(".getTime()"))
        ev.push(`A2 ${rel(f)}:${lineOf(text, j)} lazy enforcement site`);
      k = j + 1; }
  }

  // A3 — a sweeper needs a REPEATING clock. setTimeout is not one: the bundle
  // uses it for abort controllers and retry sleeps, and counting it produced a
  // red that meant nothing. setInterval is the only shape a sweep can take.
  if (hasTarget) {
    const intervals = countAll(text, "setInterval(");
    if (intervals > 0) { clockFiles++;
      ev.push(`A3 ${rel(f)} touches toolActionRequests AND registers ${intervals} setInterval`); }
    else ev.push(`A3 ${rel(f)} touches toolActionRequests, no setInterval`);
  }

  // A4 — the neighbouring sweeper that was written and never scheduled.
  const refs = countAll(text, CLEANUP);
  if (refs > 0) {
    cleanupRefs += refs;
    const defs = countAll(text, "async " + CLEANUP + "(") + countAll(text, CLEANUP + ": async");
    cleanupDefs += defs;
    ev.push(`A4 ${rel(f)} ${CLEANUP}: ${defs} definition(s), ${refs} total reference(s)`);
  }
}

out.push(["SCANNED_FILES", scanned], ["TARGET_FILES", targetFiles],
         ["INSERT_SITES", insertSites], ["INSERT_SITES_WITH_EXPIRY", insertWithExpiry],
         ["UPDATE_SITES", updateSites], ["UPDATE_SITES_WITH_EXPIRY", updateWithExpiry],
         ["ENFORCE_SITES", enforceSites], ["ENFORCE_SITES_GUARDED", enforceGuarded],
         ["CLOCK_FILES", clockFiles],
         ["CLEANUP_DEFS", cleanupDefs], ["CLEANUP_REFS", cleanupRefs]);
for (const [k, v] of out) process.stdout.write(`${k}=${v}\n`);
for (const line of ev) process.stdout.write(`EV\t${line}\n`);
'

SCAN_KEYS="SCANNED_FILES TARGET_FILES INSERT_SITES INSERT_SITES_WITH_EXPIRY \
UPDATE_SITES UPDATE_SITES_WITH_EXPIRY ENFORCE_SITES ENFORCE_SITES_GUARDED \
CLOCK_FILES CLEANUP_DEFS CLEANUP_REFS"

cmd_bundle() {
  local dir="${1:-$DIST_DEFAULT}"
  printf '== bundle: %s ==\n' "$dir"

  [ -d "$dir" ] || {
    c_yel "UNKNOWN: not a directory: $dir"
    echo "  The compiled server bundle is only present where the server runs."
    echo "  Point at one with PAPERCLIP_SERVER_DIST or pass it as an argument."
    return $EXIT_UNKNOWN
  }
  command -v node >/dev/null 2>&1 || {
    c_yel "UNKNOWN: node is not on PATH; cannot scan the bundle"
    return $EXIT_UNKNOWN
  }

  local raw
  raw="$(node -e "$BUNDLE_SCANNER" "$dir" 2>/dev/null)" || {
    c_yel "UNKNOWN: bundle scan failed to run"
    return $EXIT_UNKNOWN
  }

  local SCANNED_FILES= TARGET_FILES= INSERT_SITES= INSERT_SITES_WITH_EXPIRY=
  local UPDATE_SITES= UPDATE_SITES_WITH_EXPIRY= ENFORCE_SITES= ENFORCE_SITES_GUARDED=
  local CLOCK_FILES= CLEANUP_DEFS= CLEANUP_REFS=
  local k v line
  while IFS= read -r line; do
    case "$line" in
      EV$'\t'*) note "${line#EV$'\t'}" ;;
      *=*) k="${line%%=*}"; v="${line#*=}"
           case " $SCAN_KEYS " in *" $k "*) printf -v "$k" '%s' "$v" ;; esac ;;
    esac
  done <<< "$raw"

  # Every number the verdict rests on must actually be a number.
  for k in $SCAN_KEYS; do
    is_count "${!k}" || { c_yel "UNKNOWN: scanner did not report $k"; return $EXIT_UNKNOWN; }
  done

  # Zero findings out of zero files examined is "never ran", not "clean".
  if [ "$SCANNED_FILES" -eq 0 ] || [ "$TARGET_FILES" -eq 0 ]; then
    c_yel "UNKNOWN: scanned $SCANNED_FILES .js file(s), $TARGET_FILES mentioning toolActionRequests"
    echo "  Nothing to measure. This is not a pass — it means the tree is not a"
    echo "  Paperclip server bundle, or it could not be read."
    return $EXIT_UNKNOWN
  fi
  # The anchors must EXIST before their shape can be judged. An insert or an
  # enforcement site that cannot be found is an unreadable bundle, not a fix.
  if [ "$INSERT_SITES" -eq 0 ] || [ "$UPDATE_SITES" -eq 0 ] || [ "$ENFORCE_SITES" -eq 0 ]; then
    c_yel "UNKNOWN: anchors missing (insert=$INSERT_SITES, update=$UPDATE_SITES, enforcement=$ENFORCE_SITES)"
    echo "  The bundle has been restructured beyond what this probe can read."
    echo "  Re-audit by hand before trusting any verdict about the timeout."
    return $EXIT_UNKNOWN
  fi

  local drift=0
  # A1 — the deadline is written (by UPDATE, not by INSERT) and thus displayed.
  if [ "$UPDATE_SITES_WITH_EXPIRY" -gt 0 ] && [ "$INSERT_SITES_WITH_EXPIRY" -eq 0 ]; then
    echo "  A1 deadline-written : PRESENT  (born NULL at $INSERT_SITES insert site(s); stamped by $UPDATE_SITES_WITH_EXPIRY of $UPDATE_SITES update site(s))"
  elif [ "$UPDATE_SITES_WITH_EXPIRY" -eq 0 ]; then
    c_yel "  A1 deadline-written : DRIFT    (no update site writes expiresAt any more — rows may now stay NULL for good)"
    drift=1
  else
    c_yel "  A1 deadline-written : DRIFT    ($INSERT_SITES_WITH_EXPIRY insert site(s) now stamp expiresAt at creation)"
    drift=1
  fi
  # A2 — enforcement is lazy and null-guarded, so it is a no-op on a NULL and
  # never runs at all unless the requester comes back.
  if [ "$ENFORCE_SITES_GUARDED" -eq "$ENFORCE_SITES" ]; then
    echo "  A2 lazy-enforcement : PRESENT  ($ENFORCE_SITES/$ENFORCE_SITES site(s) guarded and requester-triggered)"
  else
    c_yel "  A2 lazy-enforcement : DRIFT    ($ENFORCE_SITES_GUARDED of $ENFORCE_SITES site(s) guarded)"
    drift=1
  fi
  # A3 — the missing half: nothing holds a clock against the deadline.
  if [ "$CLOCK_FILES" -eq 0 ]; then
    echo "  A3 no-clock         : PRESENT  (0 of $TARGET_FILES module(s) touching the table register a setInterval)"
  else
    c_yel "  A3 no-clock         : DRIFT    ($CLOCK_FILES module(s) touching the table now register a setInterval)"
    drift=1
  fi
  # A4 — corroboration: a finished sweeper next door that nothing ever calls.
  if [ "$CLEANUP_DEFS" -gt 0 ] && [ "$CLEANUP_REFS" -eq "$CLEANUP_DEFS" ]; then
    echo "  A4 dead-neighbour   : PRESENT  (cleanupExpiredSessions: $CLEANUP_DEFS definition(s), 0 caller(s))"
  elif [ "$CLEANUP_DEFS" -eq 0 ]; then
    c_yel "  A4 dead-neighbour   : DRIFT    (cleanupExpiredSessions is gone from the bundle)"
    drift=1
  else
    c_yel "  A4 dead-neighbour   : DRIFT    (cleanupExpiredSessions now has $((CLEANUP_REFS - CLEANUP_DEFS)) caller(s))"
    drift=1
  fi

  if [ "$drift" -eq 1 ]; then
    c_yel "DRIFT: the deployed bundle no longer matches the documented findings."
    echo "  Re-audit before relying on either answer. Our controls assume the"
    echo "  approval deadline is DISPLAYED and never ENFORCED; if that has"
    echo "  changed, the assumption underneath them has inverted."
    return $EXIT_DRIFT
  fi
  c_grn "OK: the deadline is written and shown, and nothing enforces it — as documented."
  return $EXIT_OK
}

# --- the live consequence ---------------------------------------------------
cmd_rows() {
  printf '== rows: tool_action_requests ==\n'

  # shellcheck source=lib/pcsql.sh
  . "$HERE/lib/pcsql.sh" 2>/dev/null || {
    c_yel "UNKNOWN: cannot source $HERE/lib/pcsql.sh"; return $EXIT_UNKNOWN; }

  local backend
  backend="$(pcsql_backend)" || return $EXIT_REFUSED

  # Reachability first. Without it, an operator who cannot reach the database
  # still gets a verdict, and every count comes back empty — which bash scores
  # as zero, i.e. "clean". Being unable to look must not resemble having looked
  # and found nothing.
  #
  # Captured, not piped: `pcsql_preflight | sed` would report sed's status on a
  # shell without pipefail, and this refusal is the one that must never be lost.
  local pf_out pf_rc
  pf_out="$(pcsql_preflight 2>&1)"; pf_rc=$?
  if [ "$pf_rc" -ne 0 ]; then
    [ -n "$pf_out" ] && sed 's/^/  /' <<<"$pf_out"
    c_yel "UNKNOWN: the '$backend' backend could not answer. Nothing was measured."
    return $EXIT_UNKNOWN
  fi

  # Scoped to one company when we know which, instance-wide otherwise. The scope
  # is printed either way, so a narrow reading is never mistaken for a broad one.
  local company="${PAPERCLIP_COMPANY_ID:-}"
  local scope; [ -n "$company" ] && scope="company $company" || scope="instance-wide"
  printf '   scope: %s\n' "$scope"

  # :company_id is bound by pcsql_run from PGV_COMPANY_ID on both backends, and
  # an empty one means "do not filter" rather than "match nothing".
  local raw
  raw="$(PGV_COMPANY_ID="$company" pcsql_run -Atq -v ON_ERROR_STOP=1 -F$'\t' <<'SQL'
select
  count(*),
  count(*) filter (where status = 'pending'),
  count(*) filter (where status = 'pending' and expires_at is null),
  count(*) filter (where status = 'pending' and expires_at is not null and expires_at <= now()),
  coalesce(max(extract(epoch from (now() - created_at))::bigint) filter (where status = 'pending'), 0)
from tool_action_requests
where (:'company_id' = '' or company_id = nullif(:'company_id', '')::uuid);
SQL
  )" || { c_yel "UNKNOWN: the query did not run"; return $EXIT_UNKNOWN; }

  # A leading empty field is dropped by `IFS=$'\t' read`, shifting every column
  # one to the left, so the row is split by position instead.
  local row total pending null_exp past_due oldest
  row="$(head -n1 <<<"$raw")"
  total="$(cut -f1 <<<"$row")"; pending="$(cut -f2 <<<"$row")"
  null_exp="$(cut -f3 <<<"$row")"; past_due="$(cut -f4 <<<"$row")"
  oldest="$(cut -f5 <<<"$row")"

  local k
  for k in total pending null_exp past_due oldest; do
    is_count "${!k}" || {
      c_yel "UNKNOWN: the query returned no usable count for '$k'"
      echo "  A missing count is not a zero. Nothing was measured."
      return $EXIT_UNKNOWN
    }
  done

  printf '   rows: %s total, %s pending (%s never stamped, %s past their deadline)\n' \
    "$total" "$pending" "$null_exp" "$past_due"

  if [ "$past_due" -gt 0 ] || [ "$null_exp" -gt 0 ]; then
    c_red "STRANDED: $((null_exp + past_due)) pending request(s) that no party will expire."
    printf '  oldest pending: %s seconds (%s days)\n' "$oldest" "$((oldest / 86400))"
    echo "  A past-due row is the whole defect made visible: its deadline passed and"
    echo "  it is still pending, because nothing holds a clock. It ends only if the"
    echo "  SAME agent re-invokes the SAME tool with the SAME arguments on the SAME"
    echo "  issue. A never-stamped row never had a deadline at all. Close by hand:"
    echo "  resolve the linked interaction, which settles the row with it."
    return $EXIT_STRANDED
  fi

  if [ "$total" -eq 0 ]; then
    c_grn "OK: 0 rows. The approval gate has never fired in this scope."
    echo "  Read that as untested, not as healthy: no row has ever exercised this"
    echo "  path, so the first real approval request is the one that strands."
  else
    c_grn "OK: $total row(s), none pending past a deadline nobody keeps."
  fi
  return $EXIT_OK
}

cmd_probe() {
  local worst=$EXIT_OK rc
  cmd_bundle "${1:-}"; rc=$?
  [ "$rc" -gt "$worst" ] && worst=$rc
  echo
  cmd_rows; rc=$?
  [ "$rc" -gt "$worst" ] && worst=$rc
  echo
  case "$worst" in
    "$EXIT_OK")       c_grn "VERDICT: known state. Deadline displayed, never enforced; nothing stranded." ;;
    "$EXIT_DRIFT")    c_yel "VERDICT: DRIFT. The documented findings no longer describe the deployed server." ;;
    "$EXIT_STRANDED") c_red "VERDICT: STRANDED. Live approval requests nobody will ever close." ;;
    "$EXIT_UNKNOWN")  c_yel "VERDICT: UNKNOWN. At least one half could not be measured. Not green." ;;
  esac
  return $worst
}

usage() {
  cat <<EOF
$ME — is the tool-approval deadline enforced? (it is displayed, not enforced)

  $ME probe  [DIST]     both halves below                 (default)
  $ME bundle [DIST]     read the deployed server bundle
  $ME rows              read tool_action_requests for stranded requests
  $ME --help

  --explain             print the file:line each assertion was read from

DIST defaults to \$PAPERCLIP_SERVER_DIST, else /app/server/dist.
Database backend follows lib/pcsql.sh (\$PAPERCLIP_SQL_BACKEND: podman|docker|psql).

exit 0 known state · 2 refused · 3 drift · 4 stranded · 5 could not measure
EOF
}

main() {
  local args=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --explain) EXPLAIN=1 ;;
      -h|--help) usage; exit $EXIT_OK ;;
      -*) die "unknown option: $1" ;;
      *) args+=("$1") ;;
    esac
    shift
  done
  set -- ${args[@]+"${args[@]}"}
  case "${1:-probe}" in
    probe)  shift 2>/dev/null || true; cmd_probe "${1:-}" ;;
    bundle) shift 2>/dev/null || true; cmd_bundle "${1:-}" ;;
    rows)   cmd_rows ;;
    *) die "unknown command: $1 (try --help)" ;;
  esac
}

main "$@"
