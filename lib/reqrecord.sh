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
# ---------------------------------------------------------------------------
# WHY org_request_queue.sh DOES NOT SOURCE THIS YET
# ---------------------------------------------------------------------------
# It should, and that is the intended end state. It does not today because
# TOG-388 (safer-alternative-first review) and TOG-390 (reviewer liveness) are
# both open against that file, and rewriting its record layer underneath two
# live changes trades a duplication problem for a merge-conflict problem.
#
# The duplication is therefore GATED, not tolerated: `test_reqrecord_shared.sh`
# extracts the eight functions below from BOTH files and fails if they are not
# byte-identical. Drift becomes a red build on the next push rather than a
# divergence somebody finds later by reading two files side by side. When
# TOG-388 and TOG-390 have landed, point the queue at this file and delete its
# copies; the suite will then compare one definition against itself, which is
# the signal to retire that half of it.
#
# WHAT IS SHARED AND WHAT IS DELIBERATELY NOT
# -------------------------------------------
# Shared (byte-identical, gated):
#     die  log_event  append_queue  queue_lock  queue_unlock
#     expired  submission_count  request_submission
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
#
# CALLER CONTRACT
#     QUEUE       path to the append-only JSONL record  (required)
#     GRANT_LOG   path to the refusal/audit log         (required)
#     REQ_ID_PREFIX             id prefix for reqrecord_next_id  (default REQ)
#     REQRECORD_STATUS_EVENTS   JSON object; the events that CARRY a status
#     REQRECORD_TERMINAL_EVENTS JSON object; the events that END a request
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

# --- the eight shared definitions ------------------------------------------
# Everything between the BEGIN/END markers is compared byte-for-byte against
# org_request_queue.sh by test_reqrecord_shared.sh. Do not reformat one side.
# >>> REQRECORD SHARED BEGIN
die() { echo "REFUSED: $*" >&2; exit 2; }

log_event()    { printf '%s\n' "$1" >> "$GRANT_LOG"; chmod 0600 "$GRANT_LOG" 2>/dev/null || true; }
append_queue() { printf '%s\n' "$1" >> "$QUEUE"; chmod 0600 "$QUEUE" 2>/dev/null || true; }

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
# <<< REQRECORD SHARED END

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
