#!/usr/bin/env bash
set -uo pipefail

# ===========================================================================
# Drain the logs of FAILED jobs into one compact bundle
#
# THE PROBLEM THIS EXISTS FOR. When a CI run goes red, triage means opening
# every failed job, paging through thousands of log lines, and finding the one
# that names the cause. Reviewers do not do that in minutes; they re-run, or
# theyskim the checks list and guess. This tool drains each failed job's log
# into a single artifact directory, trims every log to its tail, and prints a
# one-line summary per failing job that names the job, the step that failed,
# and the first error-shaped line — so a red run triages from the summary.
#
# WHERE IT RUNS. As the `failure-log-drain` job in ci.yml, gated on
# `if: failure()` with `needs:` on every suite job, so it runs exactly once
# per red run, after all suites have finished, and never on green runs or on
# superseded (cancelled) runs. It uploads its output dir with
# actions/upload-artifact. It never fails the build for its own findings —
# the run is already red; this only describes it. It REFUSES (exit 3) when it
# cannot observe the job list, because a drain that measured nothing must
# never print "no failures found": an empty drain must not read as success.
#
# Reads: GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GH_TOKEN
#        (needs actions:read; the workflow already grants it, read-only).
# Requires curl and jq. The token travels in a header FILE, never in argv —
# /proc/*/cmdline is world-readable and the host may be shared.
# On redirect the log endpoint answers 302 to pre-signed storage; curl -L is
# the documented way to follow it.
# ===========================================================================

ME="$(basename "${BASH_SOURCE[0]}")"

# Compactness caps. A drain that ships whole 20k-line logs is not a drain.
LOG_TAIL_LINES=400
SUMMARY_LINE_CHARS=300

usage() {
  cat <<'USAGE'
  ./ci_failure_drain.sh drain [--jobs-json FILE --logs-dir DIR] [--out-dir DIR]
  ./ci_failure_drain.sh help

Drains the logs of failed jobs in the current run into OUT_DIR:
  failure-summary.md   one line per failing job (job, step, cause)
  <job-name>.log       last LOG_TAIL_LINES lines of that job's log

Without flags the job list and logs come from the Actions API (CI use).
With --jobs-json/--logs-dir they come from files (hermetic tests).

EXIT CODES
  0  drained (whether or not failures were found)
  2  usage error
  3  REFUSED — the job list or a failed job's log could not be observed.
USAGE
}

die()    { printf '%s: %s\n' "$ME" "$1" >&2; exit "${2:-2}"; }
refuse() { printf '%s: REFUSED: %s\n' "$ME" "$1" >&2; exit 3; }

[[ $# -ge 1 ]] || { usage >&2; exit 2; }
CMD="$1"; shift
case "$CMD" in
  help|--help|-h) usage; exit 0 ;;
  drain) ;;
  *) usage >&2; exit 2 ;;
esac

JOBS_JSON=""
LOGS_DIR=""
OUT_DIR="failure-drain"
API="${GITHUB_API_URL:-https://api.github.com}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --jobs-json) [[ $# -ge 2 ]] || die "--jobs-json needs a path"; JOBS_JSON="$2"; shift 2 ;;
    --logs-dir)  [[ $# -ge 2 ]] || die "--logs-dir needs a path";  LOGS_DIR="$2";  shift 2 ;;
    --out-dir)   [[ $# -ge 2 ]] || die "--out-dir needs a path";   OUT_DIR="$2";   shift 2 ;;
    *) die "unexpected argument: $1" ;;
  esac
done
# The two fixture flags travel together: half a fixture is a lie.
if [[ -n "$JOBS_JSON$LOGS_DIR" && ( -z "$JOBS_JSON" || -z "$LOGS_DIR" ) ]]; then
  die "--jobs-json and --logs-dir must be given together"
fi

for c in jq curl; do
  command -v "$c" >/dev/null 2>&1 || die "$c is required"
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT_DIR"

# --- obtain the job list ------------------------------------------------------
if [[ -n "$JOBS_JSON" ]]; then
  [[ -s "$JOBS_JSON" ]] || refuse "jobs json is missing or empty: $JOBS_JSON"
  cp "$JOBS_JSON" "$TMP/jobs.json"
else
  : "${GITHUB_REPOSITORY:?}" 2>/dev/null || refuse "GITHUB_REPOSITORY is unset; not running in Actions"
  [[ -n "${GITHUB_RUN_ID:-}" ]] || refuse "GITHUB_RUN_ID is unset"
  [[ -n "${GH_TOKEN:-}" ]]      || refuse "GH_TOKEN is unset; actions:read is required to list jobs"

  ATTEMPT="${GITHUB_RUN_ATTEMPT:-1}"
  HDR="$TMP/hdr"; umask 077
  printf 'Authorization: Bearer %s\n' "$GH_TOKEN" > "$HDR"
  printf 'Accept: application/vnd.github+json\n' >> "$HDR"

  URL="$API/repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/$ATTEMPT/jobs?per_page=100"
  CODE="$(curl -sS -o "$TMP/jobs.json" -w '%{http_code}' -H @"$HDR" "$URL" 2>"$TMP/curl.err")"
  [[ "$CODE" == "200" ]] || refuse "listing jobs returned HTTP $CODE (actions:read missing?)"
fi

jq -e '.jobs | type == "array" and length > 0' "$TMP/jobs.json" >/dev/null 2>&1 \
  || refuse "the jobs response carries no job list; nothing was measured"

# --- classify -----------------------------------------------------------------
RUN_ID="${GITHUB_RUN_ID:-fixture}"
FAILED_IDS="$(jq -r '[.jobs[] | select(.conclusion=="failure") | .id] | .[]' "$TMP/jobs.json")"
N_FAILED="$(jq '[.jobs[] | select(.conclusion=="failure")] | length' "$TMP/jobs.json")"

emit() { printf '%s\n' "$1"; [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] && printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"; return 0; }

# One line per failing job: name the job, the step that failed, and the cause.
# Error-shaped means it names something that broke, not just the last line of
# a log (which is usually teardown noise).
cause_of() {
  local log="$1"
  local line
  line="$(grep -a -m1 -i -E '::error|failed|error:|traceback|assertion' "$log" 2>/dev/null || true)"
  [[ -n "$line" ]] || line="$(grep -a . "$log" 2>/dev/null | tail -n 1 || true)"
  # Strip the Actions timestamp prefix; it doubles every line's width.
  line="$(sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z //' <<< "$line")"
  printf '%.300s' "$line"
}

safe_name() {
  # The hyphen sits last so tr reads it as a literal, not a range
  # endpoint — a reversed range would silently mangle every job name.
  # printf, not a herestring: `<<<` appends a newline that tr would turn
  # into a trailing underscore on every filename.
  printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-80
}

{
  printf '# CI failure drain — run %s\n\n' "$RUN_ID"
} > "$OUT_DIR/failure-summary.md"

if [[ "$N_FAILED" -eq 0 ]]; then
  printf 'No failed jobs in this run.\n' >> "$OUT_DIR/failure-summary.md"
  emit "### ✅ Failure drain: no failed jobs in run ${RUN_ID}"
  exit 0
fi

SUMMARY_NAMES=()
for jid in $FAILED_IDS; do
  JNAME="$(jq -r --argjson id "$jid" '.jobs[] | select(.id==$id) | .name // "job"' "$TMP/jobs.json")"
  STEP="$(jq -r --argjson id "$jid" '[.jobs[] | select(.id==$id) | .steps[]? | select(.conclusion=="failure")] | first | .name // ""' "$TMP/jobs.json")"
  FNAME="$(safe_name "$JNAME").log"

  if [[ -n "$LOGS_DIR" ]]; then
    [[ -s "$LOGS_DIR/$jid.log" ]] || refuse "no fixture log for failed job $jid ($JNAME)"
    SRC="$LOGS_DIR/$jid.log"
  else
    umask 077
    HDR="$TMP/hdr"; [[ -f "$HDR" ]] || { printf 'Authorization: Bearer %s\n' "$GH_TOKEN" > "$HDR"; }
    LOGURL="$API/repos/$GITHUB_REPOSITORY/actions/jobs/$jid/logs"
    CODE="$(curl -sS -L -o "$TMP/$jid.log" -w '%{http_code}' -H @"$HDR" -H 'Accept: application/vnd.github+json' "$LOGURL" 2>"$TMP/curl-$jid.err")"
    # The log endpoint answers 302 to pre-signed storage; -L follows it to 200.
    [[ "$CODE" == "200" ]] || refuse "downloading the log for failed job $jid ($JNAME) returned HTTP $CODE"
    SRC="$TMP/$jid.log"
  fi

  tail -n "$LOG_TAIL_LINES" "$SRC" > "$OUT_DIR/$FNAME"
  CAUSE="$(cause_of "$OUT_DIR/$FNAME")"
  [[ -n "$STEP" ]] && STEP_TXT=" at step \"$STEP\"" || STEP_TXT=""
  printf -- '- ❌ %s%s: %s\n  Log: %s (last %s lines)\n' "$JNAME" "$STEP_TXT" "$CAUSE" "$FNAME" "$LOG_TAIL_LINES" >> "$OUT_DIR/failure-summary.md"
  LABEL="$JNAME$STEP_TXT"
  SUMMARY_NAMES+=("$LABEL")
  printf 'drain: %s — %s\n' "$LABEL" "$CAUSE"
done

# The annotation is the triage surface: it names the failing jobs on the run
# summary itself, so nobody opens the artifact to learn which job broke.
ANNOT="$(printf '%s; ' "${SUMMARY_NAMES[@]}")"
ANNOT="${ANNOT//'%'/'%25'}"
ANNOT="${ANNOT//$'\r'/'%0D'}"
ANNOT="${ANNOT//$'\n'/'%0A'}"
printf '::error title=Failure drain: %s job(s) failed::%s See the failure-drain artifact for trimmed logs.\n' \
  "$N_FAILED" "$ANNOT"

emit "### ❌ Failure drain: ${N_FAILED} job(s) failed in run ${RUN_ID}"
emit ""
while IFS= read -r line; do emit "$line"; done < "$OUT_DIR/failure-summary.md"

exit 0
