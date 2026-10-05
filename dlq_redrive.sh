#!/usr/bin/env bash
# ===========================================================================
# dlq_redrive.sh — standalone DLQ redrive CLI working against a local fixture
# file. No broker, no database, no network, no credential.
# ---------------------------------------------------------------------------
# THE GAP THIS EXISTS FOR. A durable outbox / consumer /
# DLQ, but every operation against it needs the broker. There is no way to
# inspect, redrive or purge dead entries offline — against a captured fixture,
# in CI, or on a box that cannot reach the broker. This tool is that way: the
# whole DLQ is a JSONL file, one entry per line, and every verb below works on
# that file alone.
#
# FIXTURE FORMAT (one JSON object per line; blank lines ignored):
#   {"id":"m1","topic":"billing.invoiced","payload":{...},"error":"timeout",
#    "failed_at":"2026-09-20T04:00:00Z","attempts":5,"status":"dead"}
# `status` is one of dead | redriven | purged. Every other key is carried
# through untouched; `list` renders id, status, attempts, topic, failed_at,
# error and ignores the rest.
#
# THREE RULES THIS FILE ENCODES, EACH BECAUSE THE OBVIOUS VERSION IS WRONG.
#
# 1. EVERY MUTATION CARRIES A REASON, FROM A REGISTRY IN THIS FILE.
#    `org_request_queue.sh` requires a reason on every decision — approvals
#    included — because the record has to answer "why", not only "who". A DLQ
#    redrive that takes a free-text `--note` gets `--note "retry"` on every
#    invocation and the audit trail says nothing. So the reason is REQUIRED and
#    must be a member of the registry below, namespaced by action: a redrive
#    reason claims the entry deserves another attempt, a purge reason claims it
#    never will. `duplicate` as a redrive reason is refused, not reinterpreted.
#
# 2. PURGED IS TERMINAL.
#    A purged entry was deliberately deleted by an operator. Letting `redrive`
#    resurrect it turns purge into a suggestion. `redrive` on a purged id is
#    refused with cause `already_purged`; only `dead` entries redrive, and only
#    `dead` entries purge in bulk. A redriven entry purges only by explicit
#    `--id`: bulk purge never sweeps up entries another operator already
#    decided to retry.
#
# 3. A CHECK THAT MEASURED NOTHING MUST NOT EXIT GREEN.
#    Missing or unreadable fixture, or missing jq, is exit 5 (UNMEASURED) —
#    never 0. An existing fixture that legitimately holds zero entries lists
#    quietly at exit 0: the measurement succeeded, the set is empty. But
#    `--all` matching zero entries is exit 3 (`no_match`): a typo'd `--topic`
#    that silently does nothing is the same failure shape as the dormant
#    roster `queue_liveness.sh` was built to catch.
#
# EXIT CODES — distinct so a caller can tell the four apart.
#   0  ok
#   2  refused (bad usage, unknown reason, malformed fixture, duplicate id)
#   3  not eligible (id unknown, wrong state, --all matched nothing)
#   5  UNMEASURED: could not read the fixture or jq is absent. NOT green.
#
# MACHINE CONTRACT. Stdout is TSV and stable; tests pin it, stderr is human
# prose and may drift (CONTRIBUTING.md: assert on status, not on message text).
#   list              id \t status \t attempts \t topic \t failed_at \t error
#   redrive / purge   <new-status> \t id \t reason        (one line per entry)
#   any refusal       refused \t <cause> \t <detail>
# Mutations rewrite the fixture atomically (temp file + mv under flock) and
# append one JSON record per entry to <fixture>.journal.jsonl — the audit
# trail, not stdout.
# ===========================================================================
set -uo pipefail

ME="$(basename "${BASH_SOURCE[0]}")"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

EXIT_OK=0; EXIT_REFUSED=2; EXIT_NOT_ELIGIBLE=3; EXIT_UNMEASURED=5

FIXTURE="${DLQ_FIXTURE:-./dlq.jsonl}"
ACTOR="${DLQ_ACTOR:-operator}"

# --- reason registry ---------------------------------------------------------
# Namespaced by action. There is deliberately no --reason-text flag: see rule 1.
REDRIVE_REASONS="transient_upstream consumer_bugfix_deployed payload_corrected redeliver_anyway"
PURGE_REASONS="poison_unrecoverable duplicate expired_stale test_fixture"

reason_description() {
  case "$1" in
    transient_upstream)       printf 'the downstream that timed out is healthy again; retry is expected to succeed';;
    consumer_bugfix_deployed) printf 'the consumer bug that poisoned this entry is fixed and deployed';;
    payload_corrected)        printf 'the payload was corrected out of band since the failure';;
    redeliver_anyway)         printf 'operator override: retry despite none of the above holding';;
    poison_unrecoverable)     printf 'the entry can never succeed and would only poison the consumer again';;
    duplicate)                printf 'a duplicate of an entry that was already processed';;
    expired_stale)            printf 'too old for redelivery to mean anything';;
    test_fixture)             printf 'test data, not real traffic';;
    *)                        printf 'unknown reason';;
  esac
}

# --- output ------------------------------------------------------------------
human() { printf '%s: %s\n' "$ME" "$*" >&2; }

# refuse <exit> <cause> <detail>: machine line on stdout, prose on stderr.
refuse() {
  local exit="$1" cause="$2" detail="${3:-}"
  printf 'refused\t%s\t%s\n' "$cause" "$detail"
  human "$cause${detail:+ — $detail}"
  exit "$exit"
}

need_jq() {
  command -v jq >/dev/null 2>&1 || {
    printf 'refused\tjq_missing\tjq is required\n'
    human "jq is required but not on PATH"
    exit "$EXIT_UNMEASURED"
  }
}

need_fixture() {
  [[ -r "$FIXTURE" && -f "$FIXTURE" ]] || \
    refuse "$EXIT_UNMEASURED" "fixture_unreadable" "$FIXTURE"
}

usage() {
  cat <<'EOF'
dlq_redrive.sh — list, redrive and purge DLQ entries in a local JSONL fixture

  list    [--fixture F] [--status S] [--topic T]
  redrive (--id ID | --all [--topic T] [--before TS]) --reason CODE [--fixture F]
  purge   (--id ID | --all [--topic T] [--before TS]) --reason CODE [--fixture F]
  reasons

Redrive reasons: transient_upstream, consumer_bugfix_deployed, payload_corrected, redeliver_anyway
Purge reasons:   poison_unrecoverable, duplicate, expired_stale, test_fixture

Environment:
  DLQ_FIXTURE   fixture file (default ./dlq.jsonl)
  DLQ_ACTOR     name recorded in the journal (default "operator")

Exits: 0 ok · 2 refused · 3 not eligible · 5 unmeasured (never green)
EOF
}

# --- fixture loading ---------------------------------------------------------
# load_entries <outfile>: validates the whole fixture and writes compact-JSON
# lines to <outfile>. Runs in the CALLER's shell (never inside <(...)): a
# refusal must exit this process, and a process substitution would swallow it
# into a subshell and let the caller read on past a malformed fixture at
# exit 0 — a check that measured nothing reading green.
load_entries() {
  local outfile="$1"
  : > "$outfile"
  local lineno=0 line entry id status
  declare -A seen=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    entry="$(jq -c -e '.' <<<"$line" 2>/dev/null)" || \
      refuse "$EXIT_REFUSED" "malformed_fixture" "$FIXTURE line $lineno is not JSON"
    id="$(jq -r '.id // ""' <<<"$entry")"
    status="$(jq -r '.status // ""' <<<"$entry")"
    [[ -n "$id" && -n "$status" ]] || \
      refuse "$EXIT_REFUSED" "malformed_fixture" "$FIXTURE line $lineno is missing id/status"
    case "$status" in
      dead|redriven|purged) ;;
      *) refuse "$EXIT_REFUSED" "malformed_fixture" \
           "$FIXTURE line $lineno has unknown status '$status'";;
    esac
    [[ -z "${seen[$id]:-}" ]] || \
      refuse "$EXIT_REFUSED" "duplicate_id" "id '$id' appears more than once"
    seen[$id]="$lineno"
    printf '%s\n' "$entry" >> "$outfile"
  done < "$FIXTURE"
}

entry_field() { jq -r "$2 // \"\"" <<<"$1"; }

# --- list --------------------------------------------------------------------
# need_arg <flag> <remaining...>: flags taking a value must HAVE one. Without
# this, a trailing bare `--reason` dies on `set -u` with an uncontracted
# exit 1 instead of the refused exit 2 the contract promises.
need_arg() {
  [[ $# -ge 2 && -n "${2:-}" ]] || \
    refuse "$EXIT_REFUSED" "bad_usage" "flag '$1' needs a value"
}

cmd_list() {
  local status_filter="" topic_filter=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --fixture) need_arg "$@"; FIXTURE="$2"; shift 2;;
      --status)  need_arg "$@"; status_filter="$2"; shift 2;;
      --topic)   need_arg "$@"; topic_filter="$2"; shift 2;;
      -h|--help) usage; exit "$EXIT_OK";;
      *) refuse "$EXIT_REFUSED" "bad_usage" "list: unknown flag '$1'";;
    esac
  done
  need_jq; need_fixture
  if [[ -n "$status_filter" ]]; then
    case "$status_filter" in
      dead|redriven|purged) ;;
      *) refuse "$EXIT_REFUSED" "invalid_status" \
           "status filter '$status_filter' is not dead|redriven|purged";;
    esac
  fi
  local entries_file; entries_file="$(mktemp)"
  trap 'rm -f "$entries_file"' RETURN
  load_entries "$entries_file"
  local entry id status attempts topic failed_at error
  while IFS= read -r entry; do
    id="$(entry_field "$entry" '.id')"
    status="$(entry_field "$entry" '.status')"
    [[ -z "$status_filter" || "$status" == "$status_filter" ]] || continue
    topic="$(entry_field "$entry" '.topic')"
    [[ -z "$topic_filter" || "$topic" == "$topic_filter" ]] || continue
    attempts="$(entry_field "$entry" '.attempts')"
    failed_at="$(entry_field "$entry" '.failed_at')"
    error="$(entry_field "$entry" '.error')"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$id" "$status" "$attempts" "$topic" "$failed_at" "$error"
  done < "$entries_file"
  trap - RETURN
  rm -f "$entries_file"
}

# --- reasons -----------------------------------------------------------------
cmd_reasons() {
  [[ $# -eq 0 ]] || refuse "$EXIT_REFUSED" "bad_usage" "reasons takes no flags"
  local r
  for r in $REDRIVE_REASONS; do printf 'redrive\t%s\t%s\n' "$r" "$(reason_description "$r")"; done
  for r in $PURGE_REASONS;   do printf 'purge\t%s\t%s\n'   "$r" "$(reason_description "$r")"; done
}

# --- mutations ---------------------------------------------------------------
# check_reason <action> <reason>: registry membership, namespaced by action.
check_reason() {
  local action="$1" reason="$2" allowed r
  [[ -n "$reason" ]] || refuse "$EXIT_REFUSED" "reason_required" \
    "$action requires --reason (see '$ME reasons')"
  if [[ "$action" == "redrive" ]]; then allowed="$REDRIVE_REASONS"; else allowed="$PURGE_REASONS"; fi
  for r in $allowed; do [[ "$r" == "$reason" ]] && return 0; done
  for r in $REDRIVE_REASONS $PURGE_REASONS; do
    [[ "$r" == "$reason" ]] && refuse "$EXIT_REFUSED" "reason_not_for_action" \
      "'$reason' is a reason for the other action, not for $action"
  done
  refuse "$EXIT_REFUSED" "unknown_reason" \
    "'$reason' is not a registered $action reason (see '$ME reasons')"
}

# mutate <action> <reason> <selector...> — shared redrive/purge engine.
# Selector: either "--id ID" or "--all [--topic T] [--before TS]".
mutate() {
  local action="$1"; shift
  local reason="" sel_id="" sel_all=0 topic_filter="" before=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --reason)  need_arg "$@"; reason="$2"; shift 2;;
      --id)      need_arg "$@"; sel_id="$2"; shift 2;;
      --all)     sel_all=1; shift;;
      --topic)   need_arg "$@"; topic_filter="$2"; shift 2;;
      --before)  need_arg "$@"; before="$2"; shift 2;;
      --fixture) need_arg "$@"; FIXTURE="$2"; shift 2;;
      *) refuse "$EXIT_REFUSED" "bad_usage" "$action: unknown flag '$1'";;
    esac
  done
  need_jq; need_fixture
  check_reason "$action" "$reason"
  if [[ -n "$sel_id" && "$sel_all" == "1" ]]; then
    refuse "$EXIT_REFUSED" "bad_usage" "$action: --id and --all are mutually exclusive"
  fi
  if [[ -z "$sel_id" && "$sel_all" == "0" ]]; then
    refuse "$EXIT_REFUSED" "bad_usage" "$action: give --id ID or --all"
  fi
  if [[ -n "$sel_id" && (-n "$topic_filter" || -n "$before") ]]; then
    refuse "$EXIT_REFUSED" "bad_usage" "$action: --topic/--before only filter --all"
  fi

  local new_status reason_key
  if [[ "$action" == "redrive" ]]; then new_status="redriven"; reason_key="redrive_reason";
  else new_status="purged"; reason_key="purge_reason"; fi
  local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  local lock="$FIXTURE.lock" tmp journal entries_file
  journal="$FIXTURE.journal.jsonl"
  tmp="$(mktemp "$(dirname "$FIXTURE")/.dlq_mutate.XXXXXX")"
  entries_file="$(mktemp "$(dirname "$FIXTURE")/.dlq_entries.XXXXXX")"

  exec 9>"$lock"
  flock 9

  # load_entries validates BEFORE any byte of the fixture is rewritten; a
  # malformed line refuses at exit 2 with the fixture untouched. It runs in
  # this shell (see its header), so the refusal lands here, not in a subshell.
  # Every refusal path below must remove both temps: `exit` does NOT fire a
  # RETURN trap, and a stale .dlq_mutate file next to the fixture would be
  # mistaken for a crashed write. An EXIT trap covers the load_entries refusal
  # path (which exits without calling cleanup explicitly); explicit cleanup
  # calls below cover the rest, and the trap is released on success.
  cleanup() { rm -f "$tmp" "$entries_file"; }
  trap cleanup EXIT
  load_entries "$entries_file"

  local entry id status topic failed_at matched=0
  local -a matched_ids=()
  while IFS= read -r entry; do
    id="$(entry_field "$entry" '.id')"
    status="$(entry_field "$entry" '.status')"
    local take=0
    if [[ -n "$sel_id" ]]; then
      [[ "$id" == "$sel_id" ]] && take=1
    else
      # Bulk: only dead entries are swept; redriven ones need an explicit --id.
      # Non-matching entries are CARRIED THROUGH below, never dropped: every
      # line read is appended to the rewrite, taken or not.
      if [[ "$status" == "dead" ]]; then
        take=1
        topic="$(entry_field "$entry" '.topic')"
        [[ -z "$topic_filter" || "$topic" == "$topic_filter" ]] || take=0
        if [[ "$take" == "1" && -n "$before" ]]; then
          failed_at="$(entry_field "$entry" '.failed_at')"
          [[ -n "$failed_at" && "$failed_at" < "$before" ]] || take=0
        fi
      fi
    fi
    if [[ "$take" == "1" ]]; then
      if [[ -n "$sel_id" ]]; then
        # Single-id eligibility, pinned per state (rule 2: purged is terminal).
        if [[ "$action" == "redrive" ]]; then
          case "$status" in
            dead) ;;
            redriven) cleanup; refuse "$EXIT_NOT_ELIGIBLE" "already_redriven" "id '$id' is already redriven";;
            purged)   cleanup; refuse "$EXIT_NOT_ELIGIBLE" "already_purged" "id '$id' is purged; purged is terminal";;
          esac
        else
          case "$status" in
            dead|redriven) ;;
            purged) cleanup; refuse "$EXIT_NOT_ELIGIBLE" "already_purged" "id '$id' is already purged";;
          esac
        fi
      fi
      entry="$(jq -c --arg st "$new_status" --arg rk "$reason_key" --arg rs "$reason" \
        --arg ts "$ts" --arg actor "$ACTOR" \
        '.status=$st | .[$rk]=$rs | .decided_at=$ts | .decided_by=$actor' <<<"$entry")"
      matched_ids+=("$id")
      matched=$((matched + 1))
    fi
    printf '%s\n' "$entry" >> "$tmp"
  done < "$entries_file"
  rm -f "$entries_file"

  if [[ -n "$sel_id" && "$matched" == "0" ]]; then
    cleanup
    refuse "$EXIT_NOT_ELIGIBLE" "not_found" "id '$sel_id' is not in $FIXTURE"
  fi
  if [[ "$matched" == "0" ]]; then
    cleanup
    refuse "$EXIT_NOT_ELIGIBLE" "no_match" "no dead entries matched the filter"
  fi

  mv "$tmp" "$FIXTURE"
  trap - EXIT
  local mid
  for mid in "${matched_ids[@]}"; do
    jq -c -n --arg ts "$ts" --arg actor "$ACTOR" --arg act "$action" \
      --arg id "$mid" --arg rs "$reason" \
      '{ts:$ts,actor:$actor,action:$act,id:$id,reason:$rs}' >> "$journal"
    printf '%s\t%s\t%s\n' "$new_status" "$mid" "$reason"
  done
  human "$action: $matched entr$( [[ "$matched" == "1" ]] && printf 'y' || printf 'ies' ) ($reason)"
  exec 9>&-
}

case "${1:-}" in
  list)    shift; cmd_list "$@";;
  redrive) shift; mutate redrive "$@";;
  purge)   shift; mutate purge "$@";;
  reasons) shift; cmd_reasons "$@";;
  -h|--help|help|'') usage; exit "$EXIT_OK";;
  *) printf 'refused\tbad_usage\tunknown subcommand\n'
     human "unknown subcommand '$1'"
     usage >&2
     exit "$EXIT_REFUSED";;
esac
