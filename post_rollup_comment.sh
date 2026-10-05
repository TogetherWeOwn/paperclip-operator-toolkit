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
: "${PAPERCLIP_ROLLUP_PARENT_ID:?PAPERCLIP_ROLLUP_PARENT_ID must be set (EnvironmentFile) -- the rollup card this bridge key is bound to}"

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
  printf '%s' "${raw%$'\n'*}"
  if [[ ! "$code" =~ ^2[0-9][0-9]$ ]]; then
    # Path only, never the query string or the response body: the second can
    # echo request content back into the journal.
    echo "post_rollup_comment: API rejected ${method} ${path%%\?*} with HTTP ${code}" >&2
    return 1
  fi
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

  # 1. The rollup thread must exist and be open. An unreadable or closed
  # parent is NOT "posted nowhere, carry on": the finding is NOT recorded.
  local parent_raw parent_status
  parent_raw="$(_prc_api GET "/api/issues/${PAPERCLIP_ROLLUP_PARENT_ID}")" || return 1
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
  local comment payload reply comment_id
  comment="$(printf '%s %s\n\n' "$tag" "$title"; cat "$body_file")"
  payload="$(jq -n --arg b "$comment" '{body: $b}')"
  reply="$(_prc_api POST "/api/issues/${PAPERCLIP_ROLLUP_PARENT_ID}/comments" "$payload")" || {
    echo "post_rollup_comment: FAILED to post (tag ${tag}) -- finding NOT recorded" >&2
    return 1
  }
  comment_id="$(jq -r '.id // "unidentified"' <<<"$reply" 2>/dev/null)"
  echo "post_rollup_comment: posted comment ${comment_id} on ${PAPERCLIP_ROLLUP_PARENT_ID} (tag ${tag})" >&2
}
