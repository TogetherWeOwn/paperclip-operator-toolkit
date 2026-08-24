#!/usr/bin/env bash
# ===========================================================================
# notify_paperclip_issue.sh — reference REQUEST_NOTIFY_CMD transport (TOG-254)
# ===========================================================================
# Turns a request-queue notification into something a Paperclip agent actually
# receives. Reads one notification JSON object on stdin; exits 0 on delivery.
#
#   export REQUEST_NOTIFY_CMD="$PWD/notify_paperclip_issue.sh"
#
# WHY AN ISSUE COMMENT, AND NOT SOMETHING BETTER
# ----------------------------------------------
# There is no agent-addressed notification route on this instance. Measured
# from an agent principal on 2026-08-24:
#
#   GET /api/notifications            404
#   GET /api/agents/me/notifications  404
#   GET /api/agents/me/wake           404
#
# What does work — and is how this instance's agents already talk to each other
# — is an issue comment plus the wake it generates. So the notification is
# posted as a comment on an issue that the recipient is assigned to. The
# request record carries the issue via `--notify-issue` at submit time; without
# one there is nothing to address, and the queue records the notification
# `pull_only` instead, which is not a failure.
#
# WHAT THIS SCRIPT MAY NOT DO
# ---------------------------
# It may not decide anything. It receives an already-final decision and moves
# bytes. It must not read, write or influence the queue — the queue records the
# delivery outcome itself, from the exit status below. A transport that could
# write decisions would be a way to influence authorization, which is exactly
# what the notifier is forbidden to become.
set -uo pipefail

PAYLOAD="$(cat)"
[[ -n "$PAYLOAD" ]] || { echo "no payload on stdin" >&2; exit 64; }

command -v jq >/dev/null || { echo "jq required" >&2; exit 69; }

: "${PAPERCLIP_API_URL:?PAPERCLIP_API_URL not set}"
: "${PAPERCLIP_API_KEY:?PAPERCLIP_API_KEY not set}"

BASE="${PAPERCLIP_API_URL%/}"; BASE="${BASE%/api}"

RID="$(jq -r '.requestId'       <<<"$PAYLOAD")"
STATUS="$(jq -r '.status'       <<<"$PAYLOAD")"
ROLE="$(jq -r '.recipientRole'  <<<"$PAYLOAD")"
AGENT="$(jq -r '.recipientAgentId // ""' <<<"$PAYLOAD")"
BODY="$(jq -r '.body'           <<<"$PAYLOAD")"

# The issue to comment on. Supplied per-request via the queue record, or as a
# single fallback inbox issue for deployments that route everything to one
# thread. No issue means no address; say so plainly rather than inventing one.
ISSUE="$(jq -r '.notifyIssue // ""' <<<"$PAYLOAD")"
ISSUE="${ISSUE:-${REQUEST_NOTIFY_ISSUE:-}}"
[[ -n "$ISSUE" ]] || {
  echo "no notifyIssue on the request and REQUEST_NOTIFY_ISSUE unset — nothing to address" >&2
  exit 65
}

MSG="$(printf '**Provisioning request %s: %s**\n\nAddressed to %s (agent \`%s\`).\n\n```\n%s\n```\n' \
        "$RID" "$STATUS" "$ROLE" "${AGENT:-unknown}" "$BODY")"

RESP="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  --max-time "${REQUEST_NOTIFY_HTTP_TIMEOUT:-8}" \
  -d "$(jq -cn --arg b "$MSG" '{body:$b}')" \
  "$BASE/api/issues/$ISSUE/comments" 2>&1)" || {
    echo "curl failed: $RESP" >&2; exit 70; }

case "$RESP" in
  2*) echo "posted comment on $ISSUE (HTTP $RESP)"; exit 0;;
  *)  echo "delivery refused: HTTP $RESP on $BASE/api/issues/$ISSUE/comments" >&2; exit 71;;
esac
