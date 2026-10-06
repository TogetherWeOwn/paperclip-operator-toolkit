#!/usr/bin/env bash
# ===========================================================================
# post_rollup_comment.sh — comment-only finding writer for a rollup parent card.
#
# Sourced, not executed, by host-cron wrappers that run unattended under
# systemd --user with NO agent-run context. Auth comes from a durable AGENT
# API key supplied via EnvironmentFile as PAPERCLIP_AGENT_API_KEY. It posts
# exactly one comment per call on the pre-created rollup parent
# (PAPERCLIP_ROLLUP_PARENT_ID) and creates nothing, so there is no board
# search and no company-wide call for a least-privilege bridge key to be
# refused: the only routes touched are GET /api/issues/{parent} and
# POST /api/issues/{parent}/comments.
#
# AT-LEAST-ONCE, CALLER DEDUPES: every call that returns 0 posted one comment.
# Two identical calls post two comments. Duplicate suppression across
# retry/restart is the CALLER's digest/cadence state (recorded only after
# this helper succeeds), never this helper's: it keeps no state and never
# skips. A missed post is always an error, never silence.
#
# DELIVERY IS NEVER ASSUMED: any transport failure, non-2xx status, missing
# or closed parent, or unrecognised body returns non-zero having posted
# nothing claimable. Under a wrapper's `set -Eeuo pipefail` that aborts the
# tick, so an undelivered finding shows up as a failed unit rather than a
# clean tick. A silent 403 is the one outcome this must never have.
#
# NON-DISCLOSURE: neither the key nor the comment body is passed on curl's
# argv (/proc/<pid>/cmdline is world-readable). The Authorization header goes
# through a `--config <(...)` pipe (bash `printf` is a builtin, so the key
# never becomes a forked process's argv either) and the request body goes
# through `--data-binary @-` on stdin.
# ===========================================================================
set -Eeuo pipefail

: "${PAPERCLIP_API_URL:?PAPERCLIP_API_URL must be set (EnvironmentFile)}"
: "${PAPERCLIP_AGENT_API_KEY:?PAPERCLIP_AGENT_API_KEY must be set (EnvironmentFile)}"

# The rollup parent is resolved at CALL time, not source time. Host-cron
# wrappers source this file before exporting the writer's alias (live
# 2026-10-05: the private wrapper sources at its line 55 but exports
# PAPERCLIP_ROLLUP_PARENT_ID at its line 81; the installed env carries only
# RED_MAIN_ROLLUP_PARENT_ID). A source-time `: "${PAPERCLIP_ROLLUP_PARENT_ID:?}"`
# turns that order into exit 1 before any transport, with zero comments
# attempted. Either name is accepted; both must name the same bound rollup
# card. Neither set is a usage error (exit 2), not a failed delivery.
resolve_rollup_parent() {
  local pid="${PAPERCLIP_ROLLUP_PARENT_ID:-${RED_MAIN_ROLLUP_PARENT_ID:-}}"
  [[ -n "$pid" ]] || {
    echo "post_rollup_comment: no rollup parent (set PAPERCLIP_ROLLUP_PARENT_ID or RED_MAIN_ROLLUP_PARENT_ID to the bound rollup card)" >&2
    return 2
  }
  printf '%s' "$pid"
}

# Statuses that count as "the rollup thread is open for proposals". Anything
# else (done, cancelled, or a status this helper does not recognise) refuses
# the post: commenting onto a closed record hides the finding, and an unknown
# status is not an open one.
_ROLLUP_OPEN_STATUSES="backlog,todo,in_progress,in_review,blocked"

_prc_api() {
  # method path [json-body]
  # Prints the response body on stdout. Returns 0 ONLY on a 2xx; a transport
  # failure or any >=400 status returns non-zero with a one-line reason on
  # stderr. `curl -sS` alone exits 0 on a 403 or a 500, so without this the
  # helper would announce a posted comment against an API that recorded
  # nothing -- which would also make the install packet's least-privilege
  # trial unfalsifiable. The status is read from -w, never from the body.
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method" -H "Content-Type: application/json" -w $'\n%{http_code}')
  [[ -n "$body" ]] && args+=(--data-binary @-)
  local raw rc=0
  raw="$(printf '%s' "$body" | curl "${args[@]}" \
    --config <(printf 'header = "Authorization: Bearer %s"\n' "$PAPERCLIP_AGENT_API_KEY") \
    "${PAPERCLIP_API_URL%/}${path}")" || rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "post_rollup_comment: transport failure on ${method} ${path%%\?*} (curl exit ${rc})" >&2
    return 1
  fi
  local code="${raw##*$'\n'}"
  local body_text="${raw%$'\n'*}"
  printf '%s' "$body_text"
  if [[ ! "$code" =~ ^2[0-9][0-9]$ ]]; then
    # Surface the server's refusal reason (sanitized): the 2026-10-05 host
    # retest discarded the POST body and left the 403 unexplained. Only the
    # RESPONSE's error/code fields are echoed (at most 300 chars) -- never
    # the request path's query string, the key, or the comment body.
    local detail=""
    detail="$(jq -r '[.error // empty, ((.details.code // .code // empty) | select(. != "") | "(code \(.))")] | join(" ")' <<<"$body_text" 2>/dev/null | cut -c1-300)" || detail=""
    if [[ -n "$detail" ]]; then
      echo "post_rollup_comment: API rejected ${method} ${path%%\?*} with HTTP ${code}: ${detail}" >&2
    else
      echo "post_rollup_comment: API rejected ${method} ${path%%\?*} with HTTP ${code}" >&2
    fi
    return 1
  fi
}

# run_gate_hint <response-body> -> names the run-context fix when the refusal
# is the deployed cross-issue-influence gate. Agent comment/update routes
# require a valid heartbeat run (X-Paperclip-Run-Id); a durable bridge key
# fired runless from systemd has none, so GETs on the bound thread answer
# 200 while the POST answers 403. That split is the gate, not the boundary:
# the thread is readable and correctly assigned. A runless timer key reads
# but cannot post; the post belongs to a runful routine (CEO hourly routine
# with its run JWT), or to a CEO/CISO decision widening runless writes.
run_gate_hint() {
  local body_text="$1"
  [[ "$body_text" == *"cross_issue_influence_run_context"* || "$body_text" == *"valid heartbeat run"* ]] || return 1
  echo "post_rollup_comment: comment writes require a heartbeat run context -- a runless timer key reads but cannot post (have the CEO routine post with its run JWT, or route a runless-write decision via CEO/CISO; see docs/red-main-task-bridge-contract.md)" >&2
  return 0
}

# post_rollup_comment TAG TITLE BODY_FILE
# TAG: short stable bracketed token starting the comment's first line, e.g.
#   "[red-main-poll]" (same convention as the shared post_finding helper).
#   The first line is always "TAG TITLE", so later thread reads find
#   proposals and filed-key mirrors by substring.
post_rollup_comment() {
  local tag="$1" title="$2" body_file="$3"
  [[ -n "${tag:-}" && -n "${title:-}" && -n "${body_file:-}" ]] \
    || { echo "post_rollup_comment: usage: post_rollup_comment TAG TITLE BODY_FILE" >&2; return 2; }
  [[ -f "$body_file" ]] \
    || { echo "post_rollup_comment: body file not found: ${body_file}" >&2; return 2; }
  [[ -s "$body_file" ]] \
    || { echo "post_rollup_comment: body file is empty; refusing to post an empty proposal (tag ${tag})" >&2; return 2; }

  # The parent binding resolves here (see resolve_rollup_parent): wrappers
  # may source this file before the alias exists in their environment.
  local rollup_parent
  rollup_parent="$(resolve_rollup_parent)" || return 2

  # 1. The rollup thread must exist and be open. An unreadable or closed
  # parent is NOT "posted nowhere, carry on": the finding is NOT recorded.
  # A 403 here is a boundary refusal, not an empty thread: live 2026-10-05
  # proved a bound-but-unassigned rollup root answers 403 on this route, so
  # the thread must be assigned to the key's triage owner (or be an assigned
  # descendant of the bound parent).
  local parent_raw parent_status
  parent_raw="$(_prc_api GET "/api/issues/${rollup_parent}")" || {
    echo "post_rollup_comment: rollup thread unreadable -- assign it to the key's triage owner, or repoint the rollup parent at an assigned descendant of the bound parent (see docs/red-main-task-bridge-contract.md)" >&2
    return 1
  }
  parent_status="$(jq -r '.status // ""' <<<"$parent_raw" 2>/dev/null)" || {
    echo "post_rollup_comment: rollup parent body is not an issue; NOT posting blind" >&2
    return 1
  }
  [[ -n "$parent_status" ]] || {
    echo "post_rollup_comment: rollup parent body is not an issue; NOT posting blind" >&2
    return 1
  }
  if [[ ",${_ROLLUP_OPEN_STATUSES}," != *",${parent_status},"* ]]; then
    echo "post_rollup_comment: rollup parent is '${parent_status}', not open; NOT posting onto a closed record" >&2
    return 1
  fi

  # 2. Post the proposal as one comment. The tag rides in the first line
  # because comments have no title field to carry it.
  # NOTE: the deployed API requires a heartbeat run context for agent
  # comment writes. A durable bridge key fired runless from systemd has no
  # run, so this POST answers 403 (cross_issue_influence_run_context_required)
  # even when both GETs above answer 200. That split is the run gate, not
  # the boundary: fail closed, name it, and leave the write to a runful
  # routine -- see docs/red-main-task-bridge-contract.md.
  local comment payload reply comment_id
  comment="$(printf '%s %s\n\n' "$tag" "$title"; cat "$body_file")"
  payload="$(jq -n --arg b "$comment" '{body: $b}')"
  reply="$(_prc_api POST "/api/issues/${rollup_parent}/comments" "$payload")" || {
    # _prc_api already logged the HTTP status plus the server's sanitized
    # error/code. $reply still holds the refusal body here (it was printed
    # before the non-zero return), so when the refusal is the deployed
    # run-context gate, name the fix explicitly: GETs succeed runless,
    # only writes need the run.
    run_gate_hint "${reply:-}" || true
    echo "post_rollup_comment: FAILED to post (tag ${tag}) -- finding NOT recorded" >&2
    return 1
  }
  comment_id="$(jq -r '.id // "unidentified"' <<<"$reply" 2>/dev/null)"
  echo "post_rollup_comment: posted comment ${comment_id} on ${rollup_parent} (tag ${tag})" >&2
}
