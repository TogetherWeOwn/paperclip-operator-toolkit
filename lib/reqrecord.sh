# shellcheck shell=bash
# ===========================================================================
# reqrecord — the append-only decision record, as a library.
# ---------------------------------------------------------------------------
# `org_request_queue.sh` grew a set of invariants that protect the RECORD of a
# decision rather than the decision itself: an id names one submission, a
# request carries one terminal decision, an id is allocated under a lock, a
# pending request past its expiry is expired everywhere it is read. Those
# invariants are not specific to org provisioning. Any request/decide flow
# built on an append-only JSONL file needs exactly them, and a second flow that
# re-derives them will re-derive at least one of them wrong.
#
# TOG-387 needed a second flow (capability requests), so the invariants moved
# here instead of being copied. This file is sourced by `capability_gate.sh`.
#
# TOG-403 added a second thing worth sharing, one level up from the record's
# integrity: what a decision must CONTAIN to be a valid record at all. The
# owner's safer-alternative-first model (TOG-388) is not specific to org
# provisioning either — it is more load-bearing on the capability side, where
# the asks are riskier — so its argument shapes and its refusal wording live
# here too.
#
# TOG-438 completed the extraction: both `org_request_queue.sh` and
# `capability_gate.sh` source this file. The former byte-identity suite was
# deleted because, with one implementation, it would compare zero copied
# functions and report a clean run that measured nothing. Flow-specific
# parameters remain explicit in each caller and are tested where they diverge.
#
# WHAT IS SHARED AND WHAT IS DELIBERATELY NOT
# -------------------------------------------
# Shared — the record's integrity:
#     die  log_event  append_queue  queue_lock  queue_unlock
#     reqrecord_status_lock  reqrecord_status_unlock  append_status_queue
#     expired  submission_count  request_submission
# ...and the decision's required content (TOG-403):
#     saferalt_reset  saferalt_parse_arg  saferalt_assert_direction
#     saferalt_assert_grant_record  saferalt_decision_json
#
# NOT shared, on purpose — these are parameterised here because the two flows
# genuinely differ, so byte-identity would be a lie:
#     REQRECORD_STATUS_EVENTS / _TERMINAL_EVENTS
#           the capability flow has a fourth status-bearing event
#           (`request.countersigned`, the second key of a two-key custody
#           approval) that the provisioning flow has no concept of.
#     reqrecord_next_id
#           the provisioning flow allocates `REQ-NNN`, the capability flow
#           `CAP-NNN`, and mixing the two id spaces in one namespace is how a
#           reviewer ends up deciding a request it did not read.
#     SAFERALT_NO_ALT_CONSEQUENCE
#           what a recorded "no safer alternative" finding BECOMES. The
#           provisioning flow opens an audit item that `ack-risk` drains; the
#           capability flow has no such command. Sharing one sentence would
#           make it false in one of the two files.
#     WHICH ASKS ARE RISKY
#           not here at all, and deliberately. The provisioning flow derives it
#           from a template's permission keys, the capability flow from the
#           registry's class and rollback. Both derive it — neither lets the
#           decider declare it — but they read different facts, and a shared
#           classifier would have to be given both, which is a seam through
#           which one flow's risk rules reach the other's.
#
# CALLER CONTRACT
#     QUEUE       path to the append-only JSONL record  (required)
#     GRANT_LOG   path to the refusal/audit log         (required)
#     REQ_ID_PREFIX             id prefix for reqrecord_next_id  (default REQ)
#     REQRECORD_STATUS_EVENTS   JSON object; the events that CARRY a status
#     REQRECORD_TERMINAL_EVENTS JSON object; the events that END a request
#     SAFERALT_NO_ALT_CONSEQUENCE  one line; see saferalt_assert_direction
#
# Both event sets are ALLOWLISTS and must stay allowlists. See the long comment
# on STATUS_EVENTS in org_request_queue.sh: as a denylist ("not a comment and
# not an acknowledgement") every new event type is silently opted in to being
# read as a decision, and a row that lands last without a real status gives the
# request a null state that drops it from every filtered listing. That is not
# hypothetical — adding notification events in TOG-254 did exactly that.
# ===========================================================================

REQ_ID_PREFIX="${REQ_ID_PREFIX:-REQ}"
# These are the DEFAULTS — org_request_queue.sh's literals, so a caller that
# sets neither gets that flow's behaviour unchanged. capability_gate.sh extends
# both; see its header for the fourth event and why it exists.
REQRECORD_STATUS_EVENTS="${REQRECORD_STATUS_EVENTS:-$(printf '%s' '{"request.submitted":true,"request.reviewed":true,"request.expired":true}')}"
REQRECORD_TERMINAL_EVENTS="${REQRECORD_TERMINAL_EVENTS:-$(printf '%s' '{"request.reviewed":true,"request.expired":true}')}"
# Space-separated. Statuses from which a request can still age out.
REQRECORD_OPEN_STATUSES="${REQRECORD_OPEN_STATUSES:-pending}"
# The tail of the denial-floor refusal. Default is org_request_queue.sh's
# literal, same convention as the event sets above; capability_gate.sh replaces
# it because it has no `risk-record` and must not promise one.
SAFERALT_NO_ALT_CONSEQUENCE="${SAFERALT_NO_ALT_CONSEQUENCE:-$(printf '%s' 'The second is always recorded on the thread and sent to the requester, and on a
  RISKY ask it becomes an OPEN audit item (risk-record) until an auditor closes it.')}"

# --- shared definitions -----------------------------------------------------
die() { echo "REFUSED: $*" >&2; exit 2; }

log_event() { printf '%s\n' "$1" >> "$GRANT_LOG"; chmod 0600 "$GRANT_LOG" 2>/dev/null || true; }

REQRECORD_DURABLE_WRITER="${REQRECORD_DURABLE_WRITER:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/durable_queue.py}"

append_queue_unlocked() {
  [[ -x "$REQRECORD_DURABLE_WRITER" ]] \
    || { echo "REFUSED: durable queue writer unavailable: $REQRECORD_DURABLE_WRITER" >&2; return 1; }
  printf '%s\n' "$1" | "$REQRECORD_DURABLE_WRITER" append "$QUEUE"
}
append_queue_batch_unlocked() {
  [[ $# -gt 0 ]] || { echo "REFUSED: empty durable queue batch" >&2; return 1; }
  [[ -x "$REQRECORD_DURABLE_WRITER" ]] \
    || { echo "REFUSED: durable queue writer unavailable: $REQRECORD_DURABLE_WRITER" >&2; return 1; }
  printf '%s\n' "$@" | "$REQRECORD_DURABLE_WRITER" append-batch "$QUEUE"
}
append_queue() {
  local rc
  reqrecord_status_lock
  append_queue_unlocked "$1"; rc=$?
  reqrecord_status_unlock
  return "$rc"
}

queue_lock() {
  local i pid
  for (( i=0; i<LOCK_WAIT_TRIES; i++ )); do
    if mkdir "$QUEUE_LOCK" 2>/dev/null; then
      printf '%s\n' "$$" > "$QUEUE_LOCK/pid" 2>/dev/null || true
      return 0
    fi
    pid="$(cat "$QUEUE_LOCK/pid" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      rm -rf "$QUEUE_LOCK" 2>/dev/null || true   # holder died mid-write
      continue
    fi
    sleep 0.05 2>/dev/null || sleep 1
  done
  die "could not acquire the queue lock ($QUEUE_LOCK) — another writer is stuck."
}
queue_unlock() { rm -rf "$QUEUE_LOCK" 2>/dev/null || true; }

# Serialise status-bearing writes against an untrusted courier's fingerprint
# window without holding QUEUE_LOCK during external I/O. The caller supplies a
# wait budget in 50ms tries; notification delivery derives it from the enforced
# transport timeout so an honest writer waits longer than the courier can run.
REQRECORD_STATUS_LOCK="${REQRECORD_STATUS_LOCK:-${QUEUE}.status.lock}"
REQRECORD_STATUS_LOCK_TRIES="${REQRECORD_STATUS_LOCK_TRIES:-${LOCK_WAIT_TRIES:-100}}"

reqrecord_status_lock() {
  local tries="${1:-$REQRECORD_STATUS_LOCK_TRIES}" i pid
  [[ "$tries" =~ ^[1-9][0-9]*$ ]] || die "status lock wait must be a positive integer (got '$tries')."
  for (( i=0; i<tries; i++ )); do
    if mkdir "$REQRECORD_STATUS_LOCK" 2>/dev/null; then
      printf '%s\n' "$$" > "$REQRECORD_STATUS_LOCK/pid" 2>/dev/null || true
      return 0
    fi
    pid="$(cat "$REQRECORD_STATUS_LOCK/pid" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      rm -rf "$REQRECORD_STATUS_LOCK" 2>/dev/null || true
      continue
    fi
    sleep 0.05 2>/dev/null || sleep 1
  done
  die "could not acquire the status lock ($REQRECORD_STATUS_LOCK)."
}
reqrecord_status_unlock() { rm -rf "$REQRECORD_STATUS_LOCK" 2>/dev/null || true; }

append_status_queue() {
  local rc
  reqrecord_status_lock
  append_queue_unlocked "$1"; rc=$?
  reqrecord_status_unlock
  return "$rc"
}

expired() {
  local exp="$1"
  [[ -n "$exp" && "$exp" != "null" ]] || return 1
  [[ "$(now_iso)" > "$exp" ]]
}

submission_count() {
  [[ -f "$QUEUE" ]] || { echo 0; return 0; }
  jq -r --arg id "$1" 'select(.requestId==$id and .event=="request.submitted")|.requestId' "$QUEUE" | wc -l
}
request_submission() {
  [[ -f "$QUEUE" ]] || return 1
  jq -c --arg id "$1" 'select(.requestId==$id and .event=="request.submitted")' "$QUEUE" | tail -1
}

# --- the safer-alternative contract (TOG-388, factored out in TOG-403) ------
# The owner's decision model, as ARGUMENT SHAPES: a denial must leave the
# requester somewhere to go, and an approval of a risky ask must show which
# safer routes were weighed and why each failed. It lives here because it is
# the SAME model in both flows — seating an agent and handing over a credential
# — and two copies of a decision model do not stay one model. The divergence is
# invisible from either side: both files still refuse things, just no longer
# the same things.
#
# STATE IN GLOBALS, NOT RETURN VALUES. These are built one argv word at a time
# inside the caller's own parsing loop, and a function that returned them by
# echo could not also `die` on a malformed pair — `die` inside `$(...)` exits
# only the subshell, so the parse would carry on past its own refusal. Call
# saferalt_reset once at the top of every decision command.
#
# CALLER CONTRACT
#   SAFERALT_NO_ALT_CONSEQUENCE  one line appended to the denial-floor refusal,
#                                naming what a recorded --no-safer-alternative
#                                finding BECOMES in this flow. The two flows
#                                genuinely differ: org_request_queue.sh turns a
#                                risky one into an open audit item that
#                                `ack-risk` drains; capability_gate.sh has no
#                                such command and says so instead. One sentence
#                                covering both would be false in one of them,
#                                which is the exact failure this file exists to
#                                prevent.
saferalt_reset() {
  SAFERALT_ALTS='[]'; SAFERALT_CONSIDERED='[]'; SAFERALT_NO_ALT=""; SAFERALT_SHIFT=0
}

# Consume one flag of the contract from the caller's argv. Sets SAFERALT_SHIFT
# to how many words it took, or 0 if $1 is none of ours — so the caller's `*)`
# arm offers this first and only then falls through to "unknown argument".
saferalt_parse_arg() {
  SAFERALT_SHIFT=0
  case "${1:-}" in
    # A safer route that still FULLY unblocks the requester's work. Repeatable.
    --alternative)
      [[ -n "${2:-}" ]] || die "--alternative needs a value."
      SAFERALT_ALTS="$(jq -c --arg a "$2" '. + [$a]' <<<"$SAFERALT_ALTS")"
      SAFERALT_SHIFT=2;;
    # The explicit finding that there is no safer route. An escape hatch that
    # is RECORDED and surfaced, not one that is free.
    --no-safer-alternative)
      [[ -n "${2:-}" ]] || die "--no-safer-alternative needs the finding itself, not a bare flag."
      SAFERALT_NO_ALT="$2"
      SAFERALT_SHIFT=2;;
    # An alternative that was weighed and did not work, with the reason it did
    # not. The two flags are a PAIR and are parsed as one unit: --because must
    # immediately follow its --considered. Parsing them as two independent
    # repeatable lists lets a mismatched count pair alternative 1 with reason 2
    # and produce a record that is fully populated and entirely wrong, which is
    # worse than a missing one because it reads as diligence.
    --considered)
      [[ -n "${2:-}" ]] || die "--considered needs a value."
      [[ "${3:-}" == "--because" ]] \
        || die "--considered \"$2\" must be followed immediately by --because \"<why it failed>\"; an alternative with no failure reason is a list, not an analysis."
      [[ -n "${4:-}" ]] || die "--because needs a value."
      SAFERALT_CONSIDERED="$(jq -c --arg a "$2" --arg w "$4" '. + [{alternative:$a,whyItFailed:$w}]' <<<"$SAFERALT_CONSIDERED")"
      SAFERALT_SHIFT=4;;
    --because) die "--because must follow a --considered; it cannot stand alone.";;
  esac
}

# The two directions are not interchangeable, and each wrong combination gets
# its OWN refusal. --alternative is a way forward and belongs on a denial;
# --considered/--because is a rejected route and belongs on an approval. A
# generic "bad flags" message would leave the reviewer guessing which half of
# the model it had backwards, which is the half it is least able to guess.
#
# Callers run this BEFORE reading the request, for the same reason the --reason
# check runs there: a refusal that depends on who is asking, or on which
# request was named, is a refusal a reviewer can shop around.
saferalt_assert_direction() {
  local n_alt n_cons
  n_alt="$(jq -r 'length' <<<"$SAFERALT_ALTS")"
  n_cons="$(jq -r 'length' <<<"$SAFERALT_CONSIDERED")"
  if [[ "$1" == "rejected" ]]; then
    [[ $n_cons -eq 0 ]] \
      || die "--considered/--because records an alternative that FAILED, which belongs on an approval; on a denial the alternative is the way forward, so use --alternative."
    [[ -z "$SAFERALT_NO_ALT" || $n_alt -eq 0 ]] \
      || die "a denial cannot both offer an alternative and find that none exists; drop one."
    [[ $n_alt -gt 0 || -n "$SAFERALT_NO_ALT" ]] || die \
"a denial must leave the requester somewhere to go. Supply either:
    --alternative \"<a safer route that still fully unblocks the work>\"   (repeatable)
  or, if you have looked and there genuinely is none:
    --no-safer-alternative \"<what you considered and why nothing works>\"
  $SAFERALT_NO_ALT_CONSEQUENCE"
  else
    [[ $n_alt -eq 0 ]] \
      || die "--alternative offers the requester a way forward instead of granting the ask; on an approval the ask IS granted, so record the routes you rejected with --considered/--because."
    [[ -z "$SAFERALT_NO_ALT" ]] \
      || die "--no-safer-alternative is a denial finding. On an approval, 'nothing safer worked' is exactly what --considered/--because has to show, one alternative at a time."
  fi
}

# Only when no safer alternative exists may a risky ask be granted — and never
# without recording which were considered and why each failed. That record is
# the artifact the owner audits, so its absence is the thing that has to be
# impossible. The ask label and the denial remedy are the CALLER's because the
# command line differs per flow; the model does not, so the wording is here.
saferalt_assert_grant_record() {
  [[ "$(jq -r 'length' <<<"$SAFERALT_CONSIDERED")" -gt 0 ]] || die \
"$1 is a RISKY ask, so granting it needs the safer alternatives on the record.
  Supply at least one pair:
    --considered \"<a safer route you weighed>\" --because \"<why it did not fully unblock the work>\"
  If a safer route DOES fully unblock it, this is a denial that offers it, not an approval:
    $2"
}

# The record fields, as ONE SHAPE in both flows. Field names are what an
# auditor's query binds to, and org_access_review.sh already reads
# `alternativesConsidered` and `noSaferAlternative` by name. Two flows that
# spelled them differently would each look correct read on its own, and the
# cross-flow report would silently cover only one of them. Emitted as an object
# the caller merges into its decision row with `+`, so the row keeps whatever
# flow-specific fields it already had.
saferalt_decision_json() {
  jq -cn --argjson a "$SAFERALT_ALTS" --argjson c "$SAFERALT_CONSIDERED" --arg n "$SAFERALT_NO_ALT" \
    '{alternatives:$a,alternativesConsidered:$c,
      noSaferAlternative:(if $n=="" then null else $n end)}'
}
# --- parameterised: the same invariants, over a caller-supplied event set ---

QUEUE_LOCK="${QUEUE_LOCK:-${QUEUE}.lock}"
LOCK_WAIT_TRIES="${LOCK_WAIT_TRIES:-100}"

now_iso()   { date -u +%Y-%m-%dT%H:%M:%SZ; }
plus_days() { date -u -d "+$1 days" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
              || date -u -v "+$1d" +%Y-%m-%dT%H:%M:%SZ; }

# Current state of a request = its most recent status-bearing record, with
# expiry DERIVED rather than waited for. Materialising expiry only as a side
# effect of an attempted review made an unread request permanently 'pending',
# which then refused the documented remedy and left the requester with no move
# at all. Every read path agrees here without anyone having tried something.
reqrecord_state() {
  [[ -f "$QUEUE" ]] || return 1
  local rec exp
  rec="$(jq -c --arg id "$1" --argjson ev "$REQRECORD_STATUS_EVENTS" \
         'select(.requestId==$id and ($ev[.event] // false) and has("status"))' "$QUEUE" | tail -1)"
  [[ -n "$rec" ]] || return 1
  # Which statuses are still OPEN, and therefore still able to age out. The
  # provisioning flow has one (`pending`); a two-key flow has a second, because
  # a request that one key approved and the other never touched is exactly as
  # undecided as one nobody read — and if it did not expire it would sit
  # half-approved forever. That is the TOG-390 failure mode reached by a
  # different road, so it is closed here rather than left to be noticed.
  if [[ " $REQRECORD_OPEN_STATUSES " == *" $(jq -r '.status' <<<"$rec") "* ]]; then
    exp="$(request_submission "$1" | jq -r '.expiresAt // ""')"
    expired "$exp" && rec="$(jq -c '.status="expired" | .derivedExpiry=true' <<<"$rec")"
  fi
  printf '%s\n' "$rec"
}

# Status-row fingerprint used around untrusted courier execution. It covers
# every request, not only the request whose notification is being delivered: a
# courier handling REQ-001 is no more entitled to decide REQ-002. Rows are
# compared directly rather than through an optional checksum binary; missing
# measurement must not read as agreement.
reqrecord_status_fingerprint() {
  [[ -f "$QUEUE" ]] || { echo "-"; return 0; }
  jq -c --argjson ev "$REQRECORD_STATUS_EVENTS" \
    'select($ev[.event] // false)' "$QUEUE"
}

reqrecord_assert_undisputed() {
  [[ -f "$QUEUE" ]] || return 0
  local n
  n="$(jq -r --arg id "$1" 'select(.requestId==$id and .event=="request.disputed")|.requestId'        "$QUEUE" 2>/dev/null | wc -l | tr -d ' ')"
  [[ "$n" -eq 0 ]] || {
    log_event "$(jq -cn --arg id "$1"       '{event:"review.refused",reason:"record_disputed_during_notify",requestId:$id}')"
    die "request $1 had decision rows written while the notifier was running; refusing to act on a disputed record."
  }
}

# THE INVARIANT. A reviewer decides an ID; if that ID names two submissions then
# whatever it decided is not what executes — request_submission() resolves the
# ambiguity with `tail -1`, which is an arbitrary answer, not a correct one.
# Refusing outright is the only safe answer: nothing in the record says which of
# the two the reviewer read. Deliberately separate from queue_lock — the lock
# stops duplicates being CREATED, this stops a duplicate that exists anyway
# (restored backup, rotated file, defeated lock) being ACTED ON.
#
# Callers invoke it from a function body, never a command substitution, because
# `die` inside `$(...)` exits only the subshell.
reqrecord_assert_unambiguous() {
  local n; n="$(submission_count "$1")"
  [[ "$n" -le 1 ]] || {
    log_event "$(jq -cn --arg id "$1" --argjson n "$n" \
      '{event:"review.refused",reason:"ambiguous_request_id",requestId:$id,submissions:$n}')"
    die "request id $1 names $n distinct submissions; refusing to act on an ambiguous record."
  }
  reqrecord_assert_one_decision "$1"
  reqrecord_assert_undisputed "$1"
}

# The other half. A request has at most ONE terminal decision, so two terminal
# rows for one id means the record has been tampered with or merged badly.
# reqrecord_state() resolves by `tail -1`, so without this a later forged row
# wins by being later. Detective, not preventive: a process running as the same
# user cannot be sandboxed by the script that invokes it. It converts a silent
# forge into a loud refusal.
reqrecord_decision_count() {
  [[ -f "$QUEUE" ]] || { echo 0; return 0; }
  jq -r --arg id "$1" --argjson ev "$REQRECORD_TERMINAL_EVENTS" \
    'select(.requestId==$id and ($ev[.event] // false))|.requestId' \
    "$QUEUE" 2>/dev/null | wc -l | tr -d ' '
}
reqrecord_assert_one_decision() {
  local n; n="$(reqrecord_decision_count "$1")"
  [[ "$n" -le 1 ]] || {
    log_event "$(jq -cn --arg id "$1" --argjson n "$n" \
      '{event:"review.refused",reason:"ambiguous_decision",requestId:$id,decisions:$n}')"
    die "request id $1 carries $n terminal decisions; refusing to act on an ambiguous record."
  }
}

# CALL ONLY WITH THE QUEUE LOCK HELD. This counts rows and returns the next
# number; the count is stale the moment the lock is released.
reqrecord_next_id() {
  local n=1
  [[ -f "$QUEUE" ]] && n=$(( $(jq -r 'select(.event=="request.submitted")|.requestId' "$QUEUE" 2>/dev/null | wc -l) + 1 ))
  printf '%s-%03d' "$REQ_ID_PREFIX" "$n"
}

# `column` is util-linux and is NOT present everywhere this runs — a container
# without it does not error, it prints NOTHING, so the whole listing silently
# disappears. Fall back to the raw TSV, which is ugly and complete.
tabulate() { if command -v column >/dev/null; then column -t -s$'\t'; else cat; fi; }

reqrecord_loaded() { return 0; }
