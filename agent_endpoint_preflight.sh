#!/usr/bin/env bash
set -uo pipefail

# ===========================================================================
# Preflight for the agent model endpoint  (TOG-358)
#
# WHAT THIS GATES. `~/.config/containers/systemd/paperclip.env` carries
#
#     ANTHROPIC_BASE_URL=http://host.containers.internal:3456   # teamclaude
#     ANTHROPIC_API_KEY=tc-…
#
# and every `claude_local` agent run in every company on this box reads it.
# TOG-358 retires teamclaude and repoints that variable at OmniRoute. That
# edit is one line, takes effect on the next container start, and has no
# staged rollout: if the new value is wrong, every agent run fails at once.
# This tool is the check to run BEFORE the edit, and the one to re-run after.
#
# It must be run FROM INSIDE AN AGENT CONTAINER, because the thing it is
# checking is what an agent container can reach. Running it on the VPS proves
# nothing about the agents — see the measurement below, which is the entire
# reason this file exists.
#
# THE MEASUREMENT THAT MOTIVATED IT (2026-08-24, from a live agent container,
# 3/3 reproducible):
#
#   target                                   result
#   ---------------------------------------  ------------------------------
#   host.containers.internal:3456  (teamclaude)  TCP up in ~1ms, HTTP 401
#   host.containers.internal:8317  (CLIProxy)    curl exit 7, connect 0.000000s
#   host.containers.internal:20129 (OmniRoute)   curl exit 7, connect 0.000000s
#
# An immediate refusal with a zero connect time is a TCP reset from the host,
# not a timeout and not a DNS failure: the host is reachable and nothing is
# listening for the container on those two ports. TOG-358's step-2 and step-4
# targets were both probed from the VPS itself, on 127.0.0.1, where they
# answer fine. **Loopback on the host is not the agents' network.** Flipping
# `paperclip.env` to :20129 in that state is a company-wide outage on the next
# container start, and the symptom — every agent failing to reach its model —
# looks nothing like "we changed a URL".
#
# WHERE OMNIROUTE ACTUALLY IS (TOG-362, 2026-08-25). The table above reads as
# "a port needs opening on the host". It does not. OmniRoute is not a host
# service at all — it is a SIBLING CONTAINER on the same podman network, and
# podman's DNS already resolves it:
#
#     http://omniroute:20129        ->  10.89.1.3, answers today
#     http://host.containers.internal:20129  ->  refused, and always will be
#
# `host.containers.internal` is the host's public address; OmniRoute publishes
# on the host's loopback. Neither is where it lives for us. So the value for
# step 4 is `http://omniroute:20129`, nothing needs to be bound or firewalled,
# and binding :20129 (or :8317, whose /v0/management/* routes hand out live API
# keys in plaintext) to this box's public address would add exposure to buy
# reachability we already have. See docs/omniroute-agent-reachability.md.
#
# So: whoever changes that URL must be able to prove it answers from here, and
# this is the proof. Exit 0 is the only value that clears the flip.
#
# WHAT IT CHECKS, in order, each gating the next
#
#   1. reachable      TCP connects and something speaks HTTP.
#   2. responsive     a request completes within --timeout. Distinct from (1)
#                     on purpose: a connected-but-hanging endpoint was observed
#                     on teamclaude while writing this, and it is neither "down"
#                     nor "up". Collapsing it into either one is how a hang gets
#                     rolled out as a success.
#   3. authorized     not 401/403. NEVER RETRIED — see the ban note below.
#   4. envelope       200 is an Anthropic *message* envelope, not an OpenAI
#                     chat-completion, not a router error page rendered as 200.
#   5. cache          `usage` carries cache_creation_input_tokens and
#                     cache_read_input_tokens. TOG-164's switch-cost rule is
#                     computed from those two fields; an endpoint that drops
#                     them breaks cost accounting silently, because every
#                     request still succeeds.
#   6. lane           the response did not come from a pay-as-you-go lane.
#                     TOG-358 measured OmniRoute answering `claude-sonnet-5`
#                     with `model: anthropic/claude-sonnet-5` and an id of
#                     `gen-…` — an OpenRouter PAYG completion, real money, while
#                     the Max subscriptions sat unreachable behind teamclaude.
#                     That is the owner's call to make, so it is reported as its
#                     own exit code rather than folded into a pass or a failure.
#                     `--allow-payg` records that the call has been made.
#
# ⚠️ ONE ATTEMPT ON AUTH FAILURE, EVER. CLIProxy IP-bans the caller after
# repeated management-auth failures — 30 minutes, confirmed by tripping it
# during TOG-358. This tool sends exactly one request and never retries, on any
# status. If you wrap it in a retry loop you will lock the host out of the
# service you are trying to migrate to. `test_agent_endpoint_preflight.sh`
# asserts the single-attempt property against a counting stub, so it cannot
# regress unnoticed.
#
# ⚠️ THIS SPENDS QUOTA. Check 4 needs a real completion, so the tool sends one
# request with `max_tokens: 1` and a two-character prompt. That is the smallest
# thing that still proves the envelope. Do not put it in a poll loop.
#
# USAGE
#   ./agent_endpoint_preflight.sh <base-url>
#   ./agent_endpoint_preflight.sh http://host.containers.internal:3456
#   ./agent_endpoint_preflight.sh --model claude-opus-5 http://…:20129
#   ./agent_endpoint_preflight.sh --allow-payg --quiet http://…:20129
#
# EXIT CODES — gate on these, not on stdout. 0 is the only value that clears
# the flip; every other value means a human decides.
#   0  ok            reachable, authorized, Anthropic envelope, cache
#                    accounting present, subscription lane (or --allow-payg)
#   1  payg          works, but this completion was billed per token
#   2  no-cache      works, but `usage` lacks the cache fields (TOG-164)
#   3  bad-envelope  200, but not an Anthropic message envelope
#   4  unauthorized  401/403. The request was NOT retried.
#   5  unreachable   no TCP connection — flipping to this URL is an outage
#   6  timeout       TCP connected, no HTTP response within --timeout
#   7  usage         bad arguments, missing key, or a missing dependency
#
# ENVIRONMENT
#   PREFLIGHT_API_KEY  the key to present. Falls back to ANTHROPIC_API_KEY so
#                      that running this inside an agent container with no
#                      arguments checks the endpoint that container is actually
#                      using. Never placed on argv — argv is world-readable
#                      through /proc on this box (TOG-200), and this key is a
#                      live credential for the owner's subscriptions.
# ===========================================================================

MODEL="claude-sonnet-5"
TIMEOUT=45
ALLOW_PAYG=0
QUIET=0

die() { echo "agent_endpoint_preflight: $*" >&2; exit 7; }
say() { [[ "$QUIET" -eq 1 ]] || printf '%s\n' "$*"; }

# --help prints the header block verbatim. The end is FOUND, not hardcoded: this
# was `sed -n '4,105p'` until TOG-362 added a section and silently truncated the
# help mid exit-code table. A line number that has to be updated by hand every
# time the comment above grows is a line number that will be wrong.
show_help() {
  awk 'NR<4 { next }
       NR>4 && /^# ={10,}/ { exit }
       { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)      [[ $# -ge 2 ]] || die "--model needs a value"; MODEL="$2"; shift 2;;
    --timeout)    [[ $# -ge 2 ]] || die "--timeout needs a value"; TIMEOUT="$2"; shift 2;;
    --allow-payg) ALLOW_PAYG=1; shift;;
    --quiet|-q)   QUIET=1; shift;;
    -h|--help)    show_help; exit 0;;
    -*)           die "unknown flag $1";;
    *)            break;;
  esac
done

[[ $# -eq 1 ]] || die "usage: agent_endpoint_preflight.sh [--model M] [--timeout S] [--allow-payg] [--quiet] <base-url>"
BASE="${1%/}"
[[ "$BASE" == http://* || "$BASE" == https://* ]] || die "expected an http(s) base URL, got \"$BASE\""
[[ "$TIMEOUT" =~ ^[0-9]+$ && "$TIMEOUT" -gt 0 ]] || die "--timeout must be a positive integer, got \"$TIMEOUT\""

KEY="${PREFLIGHT_API_KEY:-${ANTHROPIC_API_KEY:-}}"
[[ -n "$KEY" ]] || die "no key: set PREFLIGHT_API_KEY (or ANTHROPIC_API_KEY). Refusing to probe anonymously — an anonymous 401 is indistinguishable from a wrong key, and this tool must not report a reachable endpoint as unauthorized because it was asked to guess."

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v jq   >/dev/null 2>&1 || die "jq is required"

# The key goes in a 0600 header file, never on a command line (TOG-200).
HDRS="$(mktemp)"; chmod 600 "$HDRS"
BODY="$(mktemp)"
trap 'rm -f "$HDRS" "$BODY" 2>/dev/null' EXIT
{
  printf 'x-api-key: %s\n' "$KEY"
  printf 'authorization: Bearer %s\n' "$KEY"
  printf 'anthropic-version: 2023-06-01\n'
  printf 'content-type: application/json\n'
} > "$HDRS"

# Both `x-api-key` and `authorization` are sent because the three candidate
# fronts disagree: teamclaude and CLIProxy take `x-api-key` (the Anthropic
# convention), OmniRoute takes a Bearer token. Sending one and getting a 401
# would say "unauthorized" about an endpoint that is merely differently
# configured, which is the wrong answer to give at a cutover gate.

REQ='{"model":"'"$MODEL"'","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'

# ---------------------------------------------------------------------------
# Exactly one request. No retries, on any outcome. See the ban note above.
# ---------------------------------------------------------------------------
CURL_EXIT=0
WRITE="$(curl -sS -o "$BODY" \
      --max-time "$TIMEOUT" --connect-timeout 10 \
      -H "@$HDRS" -d "$REQ" \
      -w '%{http_code} %{time_connect}' \
      "$BASE/v1/messages" 2>/dev/null)" || CURL_EXIT=$?

CODE="$(printf '%s' "$WRITE" | awk '{print $1}')"
CONNECT="$(printf '%s' "$WRITE" | awk '{print $2}')"
[[ -n "$CODE" ]] || CODE=000

verdict() { # verdict <name> <exit> <reason>
  say "endpoint : $BASE"
  say "model    : $MODEL"
  say "verdict  : $1"
  say "reason   : $3"
  exit "$2"
}

# --- 1 & 2: reachable, then responsive --------------------------------------
# curl's exit code carries the distinction the HTTP status cannot. 7 is a
# refused connection, 6 is DNS, 28 is a timeout — and 28 splits further on
# whether the TCP handshake completed, which is what separates "the host is
# down" from "the service accepted me and then hung".
if [[ "$CURL_EXIT" -ne 0 ]]; then
  case "$CURL_EXIT" in
    6)
      verdict "unreachable" 5 "DNS: the host in \"$BASE\" does not resolve from here"
      ;;
    7)
      verdict "unreachable" 5 "connection refused with a zero connect time: the host answered with a TCP reset, so nothing is listening on this port FOR THIS CONTAINER. It may well be listening on the host's loopback. Flipping paperclip.env here is an outage."
      ;;
    28)
      if [[ "$CONNECT" == 0.000000 || -z "$CONNECT" ]]; then
        verdict "unreachable" 5 "timed out before the TCP handshake completed after ${TIMEOUT}s — filtered, or the host is not answering at all"
      fi
      verdict "timeout" 6 "TCP connected in ${CONNECT}s, then no HTTP response within ${TIMEOUT}s. The port is open and the service is not answering; this is neither up nor down, and it must not be read as either."
      ;;
    35|60)
      verdict "unreachable" 5 "TLS failed (curl $CURL_EXIT) — the endpoint is there but the handshake did not complete"
      ;;
    *)
      verdict "unreachable" 5 "curl exited $CURL_EXIT with no HTTP response"
      ;;
  esac
fi

# --- 3: authorized ----------------------------------------------------------
# Not retried. Deliberately. A retry loop here is what triggers CLIProxy's
# 30-minute IP ban.
case "$CODE" in
  401|403)
    verdict "unauthorized" 4 "HTTP $CODE. The key was rejected. NOT retried — repeated auth failures IP-ban the caller from CLIProxy for 30 minutes. Fix the key, then run this once more."
    ;;
  000)
    verdict "unreachable" 5 "no HTTP status was returned"
    ;;
esac

if [[ "$CODE" != 200 ]]; then
  # 404 is worth naming: it is what a front that does not implement the
  # Anthropic surface at all returns, and it is the likeliest wrong answer
  # when a base URL is right about the host and wrong about the path prefix.
  ERR="$(jq -r '.error.message // .error.type // .message // empty' "$BODY" 2>/dev/null | head -c 200)"
  verdict "bad-envelope" 3 "HTTP $CODE from $BASE/v1/messages${ERR:+ — $ERR}. This front does not serve the Anthropic messages API at this path."
fi

# --- 4: is it actually an Anthropic message envelope? -----------------------
# A 200 proves only that something answered. An OpenAI-shaped body, or a proxy
# error page served as 200, both satisfy "the request succeeded" and neither
# can drive a claude_local agent.
if ! jq -e . "$BODY" >/dev/null 2>&1; then
  verdict "bad-envelope" 3 "HTTP 200 but the body is not JSON (first bytes: $(head -c 60 "$BODY" | tr -d '\n'))"
fi

SHAPE="$(jq -r 'if (.type=="message" and .role=="assistant" and (.content|type)=="array" and (.usage|type)=="object") then "anthropic"
                elif (.object=="chat.completion" or (.choices|type)=="array") then "openai"
                elif (.error|type)=="object" then "error"
                else "unknown" end' "$BODY" 2>/dev/null)"

case "$SHAPE" in
  anthropic) ;;
  openai)
    verdict "bad-envelope" 3 "HTTP 200 with an OpenAI chat-completion body. This front is translating to the wrong dialect on /v1/messages; a claude_local agent cannot read it."
    ;;
  error)
    verdict "bad-envelope" 3 "HTTP 200 carrying an error object: $(jq -r '.error.message // .error.type // "unspecified"' "$BODY" | head -c 200)"
    ;;
  *)
    verdict "bad-envelope" 3 "HTTP 200 but the body is not an Anthropic message envelope (missing one of type=message, role=assistant, content[], usage{})"
    ;;
esac

RESP_MODEL="$(jq -r '.model // ""' "$BODY")"
RESP_ID="$(jq -r '.id // ""' "$BODY")"

# --- 5: cache accounting (TOG-164) ------------------------------------------
# Presence, not value. A cold request legitimately reports 0 for both; a front
# that omits the keys reports nothing, and `// 0` in a downstream consumer
# turns that silence into a confident zero.
HAS_CACHE="$(jq -r 'if (.usage | has("cache_creation_input_tokens")) and (.usage | has("cache_read_input_tokens")) then "yes" else "no" end' "$BODY")"
if [[ "$HAS_CACHE" != "yes" ]]; then
  verdict "no-cache" 2 "usage lacks cache_creation_input_tokens / cache_read_input_tokens (got: $(jq -c '.usage' "$BODY" | head -c 200)). Requests would succeed and TOG-164's switch-cost rule would silently compute from a missing field."
fi

# --- 6: subscription lane, or pay-as-you-go? --------------------------------
# Two independent tells, because either can be absent. OpenRouter returns ids
# of the form `gen-…` where Anthropic returns `msg_…`, and it namespaces the
# model as `vendor/model` where a subscription front echoes the bare name.
PAYG_WHY=""
[[ "$RESP_ID" == gen-* ]]      && PAYG_WHY="response id \"$RESP_ID\" is OpenRouter-shaped (Anthropic ids start msg_)"
[[ "$RESP_MODEL" == */* ]]     && PAYG_WHY="${PAYG_WHY:+$PAYG_WHY; }model came back namespaced as \"$RESP_MODEL\", which is a router lane rather than a subscription"

say "served   : model=${RESP_MODEL:-?} id=${RESP_ID:0:12}${RESP_ID:+…}"

if [[ -n "$PAYG_WHY" && "$ALLOW_PAYG" -eq 0 ]]; then
  verdict "payg" 1 "this completion was billed per token, not drawn from a subscription — $PAYG_WHY. TOG-358 flagged this as the owner's call: routing agents here spends money per request while the Max subscriptions go unused. Pass --allow-payg once that decision is recorded."
fi

if [[ -n "$PAYG_WHY" ]]; then
  verdict "ok" 0 "reachable, authorized, Anthropic envelope, cache accounting present. PAYG lane accepted via --allow-payg ($PAYG_WHY)."
fi

verdict "ok" 0 "reachable, authorized, Anthropic envelope with cache accounting, served from a subscription lane"
