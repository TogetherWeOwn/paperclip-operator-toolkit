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
#
# THE PAYLOAD IS NOT TRUSTED INPUT (TOG-198 review, 2026-08-24)
# -------------------------------------------------------------
# Two of its fields are written by the REQUESTER — the least-privileged party
# in the flow — and both used to reach somewhere they should not:
#
#   .notifyIssue  went into the URL path unvalidated. curl resolves dot
#                 segments client-side, so `../../agents/me/secrets?x=` turned
#                 an issue comment into an authenticated POST to
#                 /api/agents/me/secrets — the `/api/issues/` prefix was gone
#                 from url_effective entirely. A requester chose the route an
#                 operator-credentialed POST took. Now charset-validated here,
#                 and refused at submit time by org_request_queue.sh so it
#                 cannot be recorded in the first place.
#
#   .body         was wrapped in a fixed ``` fence, so text containing ```
#                 closed it and rendered arbitrary markdown into the comment.
#                 A rejected request could render a fabricated "REQ-001:
#                 approved / Addressed to A0" block — and these comments WAKE
#                 agents, so the forgery is read by a machine, not just a
#                 human. The fence is now longer than any backtick run inside.
#
# Validate here even though the queue also validates: this script is a
# reference REQUEST_NOTIFY_CMD and will be copied for other transports, and a
# payload can reach it from a queue file restored from backup or hand-edited.
#
# RESIDUAL RISK, ACCEPTED AND DELIBERATE
# --------------------------------------
# A requester may still name any WELL-FORMED issue id it knows, including one
# it is not assigned to, and its own decision notice is posted there. Verifying
# that the recipient is assigned to the issue needs an API read this offline
# tool deliberately does not make. The disclosure is bounded to the requester's
# OWN request record, which it already holds. Worth revisiting if the notifier
# ever carries anything the requester did not itself submit.
set -uo pipefail

PAYLOAD="$(cat)"
[[ -n "$PAYLOAD" ]] || { echo "no payload on stdin" >&2; exit 64; }

command -v jq >/dev/null || { echo "jq required" >&2; exit 69; }

: "${PAPERCLIP_API_URL:?PAPERCLIP_API_URL not set}"
: "${PAPERCLIP_API_KEY:?PAPERCLIP_API_KEY not set}"

BASE="${PAPERCLIP_API_URL%/}"; BASE="${BASE%/api}"

RID="$(jq -r '.requestId'       <<<"$PAYLOAD")"
STATUS="$(jq -r '.decision // .status // empty' <<<"$PAYLOAD")"
ROLE="$(jq -r '.recipientRole'  <<<"$PAYLOAD")"
AUDIENCE="$(jq -r '.audience // "requester"' <<<"$PAYLOAD")"
AGENT="$(jq -r '.recipientAgentId // ""' <<<"$PAYLOAD")"
BODY="$(jq -r '.body'           <<<"$PAYLOAD")"

# The issue to comment on. Requester decisions may use the deployment's fallback
# inbox. Leader rows may not: their address is operator-isolated upstream, and
# null deliberately means pull_only rather than "send it to the requester's
# fallback thread and claim the leader was told".
ISSUE="$(jq -r '.notifyIssue // ""' <<<"$PAYLOAD")"
if [[ -z "$ISSUE" && "$AUDIENCE" == "requester" ]]; then
  ISSUE="${REQUEST_NOTIFY_ISSUE:-}"
fi
[[ -n "$ISSUE" ]] || {
  echo "no notifyIssue on the request and REQUEST_NOTIFY_ISSUE unset — nothing to address" >&2
  exit 65
}

# An allowlist, not a denylist of traversal spellings: `..`, `%2e%2e`, `;`, a
# bare `/` and an absolute `//host` are all the same bug, and a denylist is one
# encoding away from missing the next one. A UUID and an identifier like
# TOG-198 both pass; nothing that can change the route does. No `.`, so `..`
# is unrepresentable rather than filtered.
if [[ ! "$ISSUE" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]]; then
  echo "refusing to address '$ISSUE': not a well-formed issue id" >&2
  echo "  a notification may not choose the route an authenticated POST takes" >&2
  exit 65
fi

# A fence longer than the longest backtick run in the body, so the body cannot
# close it. Markdown requires the closing fence be at least as long as the
# opening one, so measuring is enough — escaping the content is not needed.
longest_tick_run() {
  local n=0 max=0 i c
  for (( i=0; i<${#1}; i++ )); do
    c="${1:i:1}"
    if [[ "$c" == '`' ]]; then n=$((n+1)); (( n > max )) && max=$n; else n=0; fi
  done
  printf '%s' "$max"
}
FENCE_LEN=$(( $(longest_tick_run "$BODY") + 1 )); (( FENCE_LEN < 3 )) && FENCE_LEN=3
FENCE="$(printf '%*s' "$FENCE_LEN" '' | tr ' ' '`')"

MSG="$(printf '**Provisioning request %s: %s**\n\nAddressed to %s (agent %s).\n\n%s\n%s\n%s\n' \
        "$RID" "$STATUS" "$ROLE" "${AGENT:-unknown}" "$FENCE" "$BODY" "$FENCE")"

# The credential goes in a 0600 config file, never in argv: /proc/<pid>/cmdline
# is world-readable and this box is shared. Same pattern, and same reasoning, as
# curl_authed() in gh_token.sh — see the TOG-200 note there. Only the PATH is
# in argv.
CFG_DIR="$(umask 077; mktemp -d "${TMPDIR:-/tmp}/notify_pc.XXXXXXXX")" \
  || { echo "could not create a private temp directory" >&2; exit 69; }
trap 'rm -rf "$CFG_DIR"' EXIT
trap 'rm -rf "$CFG_DIR"; exit 130' INT
trap 'rm -rf "$CFG_DIR"; exit 143' TERM

CFG="$(umask 077; mktemp "$CFG_DIR/curlcfg.XXXXXXXX")" \
  || { echo "could not create a curl config file" >&2; exit 69; }
chmod 0600 "$CFG"
{
  printf 'url = "%s"\n' "$BASE/api/issues/$ISSUE/comments"
  printf 'request = "POST"\n'
  printf 'header = "Authorization: Bearer %s"\n' "$PAPERCLIP_API_KEY"
  printf 'header = "Content-Type: application/json"\n'
  printf 'max-time = "%s"\n' "${REQUEST_NOTIFY_HTTP_TIMEOUT:-8}"
  # jq -Rn renders the body as a JSON string, whose escaping is a subset of what
  # curl's config parser accepts for a double-quoted value.
  printf 'data-binary = %s\n' "$(jq -Rn --arg b "$(jq -cn --arg b "$MSG" '{body:$b}')" '$b')"
  printf 'silent\nshow-error\n'
} > "$CFG"

RESP="$(curl --config "$CFG" -o /dev/null -w '%{http_code}' 2>&1)" || {
    echo "curl failed: $RESP" >&2; exit 70; }

case "$RESP" in
  2*) echo "posted comment on $ISSUE (HTTP $RESP)"; exit 0;;
  *)  echo "delivery refused: HTTP $RESP on $BASE/api/issues/$ISSUE/comments" >&2; exit 71;;
esac
