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
#   5. lane           the response did not come from a pay-as-you-go lane.
#                     This is checked before the cache replay so a PAYG route
#                     spends only one completion unless --allow-payg records
#                     the decision.
#   6. cache write    one unique, cacheable prefix reports a POSITIVE
#                     cache_creation_input_tokens count. Merely injecting the
#                     two field names with zero values does not clear this.
#   7. cache read     one identical follow-up reports a POSITIVE
#                     cache_read_input_tokens count. TOG-164's switch-cost rule
#                     is computed from those two fields; an endpoint that drops
#                     or fabricates them breaks cost accounting silently,
#                     because every ordinary request still succeeds.
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
# during TOG-358. This tool never retries any request. A route that clears auth,
# envelope, lane and cache creation receives one separate, identical replay to
# prove a cache read; auth failures stop after the first attempt. If you wrap it
# in a retry loop you will lock the host out of the service you are trying to
# migrate to. `test_agent_endpoint_preflight.sh` asserts the request count on
# every load-bearing path, so it cannot regress unnoticed.
#
# ⚠️ THIS SPENDS QUOTA. The envelope/lane check and the cache-accounting replay
# need two real completions on a route that clears the first response. Both use
# `max_tokens: 16`. OmniRoute's combo quality validator rejects `max_tokens: 1`
# with a synthetic 502 before the selected upstream runs; using 1 would turn a
# healthy subscription route into a false bad-envelope verdict. Do not put this
# in a poll loop.
#
# USAGE
#   ./agent_endpoint_preflight.sh <base-url>
#   ./agent_endpoint_preflight.sh http://host.containers.internal:3456
#   ./agent_endpoint_preflight.sh --model claude-opus-5 http://…:20129
#   ./agent_endpoint_preflight.sh --allow-payg --quiet http://…:20129
#
# EXIT CODES — gate on these, not on stdout. 0 is the only value that clears
# the flip; every other value means a human decides.
#   0  ok            reachable, authorized, Anthropic envelope, positive cache
#                    creation and replay evidence, subscription lane (or
#                    --allow-payg)
#   1  payg          works, but this completion was billed per token
#   2  no-cache      works, but cache write/read accounting is absent or zero
#                    across the explicit two-request replay (TOG-164)
#   3  bad-envelope  200, but not an Anthropic message envelope
#   4  unauthorized  401/403. The request was NOT retried.
#   5  unreachable   no TCP connection — flipping to this URL is an outage
#   6  timeout       TCP connected, no HTTP response within --timeout, and the
#                    control model did not answer either — the endpoint hangs
#   7  usage         bad arguments, missing key, or a missing dependency
#   8  model-unavailable
#                    --model hung, but the control model answered 200 on the
#                    same endpoint with the same key. The endpoint is UP and
#                    these two models are not served alike. That is ALL it
#                    means — see the note below on what it does not mean.
#                    TOG-361.
#
# THE CONTROL PROBE (TOG-361) — why a timeout gets a second request
#
# Measured on teamclaude 2026-08-25, from an agent container: `claude-haiku-4-5-
# 20251001` returned a valid envelope in 0.48s while `claude-opus-5`,
# `claude-sonnet-5`, `claude-sonnet-4-5-20250929`, `claude-opus-4-5-20251101`
# and `claude-fable-5` all hung indefinitely. A bogus model name got a fast 404
# carrying an upstream request id, so the proxy, the auth and the upstream round
# trip were all healthy the entire time. The endpoint was up. One model class
# answered and the rest did not.
#
# ⚠️ THE ORIGINAL READING OF THAT — "this model's lane is dead" — WAS WRONG, and
# the correction is the whole point of the client-identity note further down.
# Those probes were bare. Carrying the Claude Code client identity, the same
# `claude-sonnet-5` on the same endpoint answers in 1.29s. The split by model
# was real; the cause was the request, not the lane. It is left described here
# because the SHAPE of the observation is still exactly what this control probe
# is for, and because a gate that reports it must not repeat the inference.
#
# This tool's default `--model claude-sonnet-5` is in that hanging set, so
# before this change it reported `timeout` — a verdict about the endpoint that
# was really a verdict about one model. At a cutover gate those are opposite
# answers: "teamclaude is down, flip now" versus "teamclaude serves only Haiku,
# so it is not a rollback target". So on timeout, and ONLY on timeout, the tool
# sends one more request with `--control-model` to separate the two.
#
# Both of those answers were wrong about teamclaude, which is the strongest
# argument for the probe: it costs one request and it converts a confident
# wrong verdict into a narrow true one.
#
# The default `--model` is deliberately NOT a model that is known to work.
# The question this gate answers is "can a claude_local agent get a completion
# here", and pointing it at Haiku would return 0 for an endpoint on which no
# agent can run.
#
# ⚠️ A TIMED-OUT REQUEST LEAKS CAPACITY ON TEAMCLAUDE. Also measured: healthy
# haiku latency tracked the number of requests previously abandoned — 0.48s
# cold, then 8.9s, then 17.9s — recovering only after ~75s of quiet. Requests
# are still held server-side after curl gives up. Every timeout here degrades
# the live model endpoint for real agent runs. This is a second, independent
# reason not to poll: check 4's quota note is not the only cost.
#
# THE CLIENT IDENTITY (TOG-358) — why this sends a system prompt
#
# The fronts this gate checks sit on **Claude Max subscription** accounts, and
# the subscription lane is reached only by requests that look like the Claude
# Code CLI. So every request here carries what a `claude_local` agent carries:
#
#   user-agent: claude-cli/…      x-app: cli      the Claude Code system prompt
#
# Measured from an agent container, 2026-08-25, against teamclaude:
#
#   request                                            result
#   -------------------------------------------------  --------------------
#   claude-sonnet-5, bare                              hang, no response
#   claude-sonnet-5, bare + stream:true                hang, 0 bytes in 25s
#   claude-sonnet-5, + full client identity  (n=5)     HTTP 200, 1.29–1.58s
#   claude-sonnet-5, + identity, MINUS system prompt   hang, no response
#   claude-sonnet-5, + identity, MINUS user-agent      hang, no response
#   claude-sonnet-5, system prompt ONLY      (n=1)     HTTP 200 in 5.22s
#
# Each probe ran after ~95s of quiet and every leave-one-out was bracketed by a
# passing full-identity control, so the hangs are attributable. Cache fields
# intact throughout.
#
# The last two rows are the interesting pair, and they are why this sends the
# WHOLE identity rather than a minimal set. Dropping the user-agent while
# keeping `x-app: cli` hangs; dropping BOTH — leaving curl's own user-agent and
# just the system prompt — answers. A partial identity is worse than none: the
# front appears to reject a request that claims to be the CLI without looking
# like it. (n=1 each, and not load-bearing for this design — the tool sends what
# a claude_local agent sends, which is all of it.) **Matching the production
# client is the requirement; a minimal set that happens to work today is just a
# new way to drift from what agents do.**
#
# WHY THIS IS THE WHOLE POINT OF THE TOOL, not a detail. Before this, the
# probe sent a bare {model, max_tokens, messages}. The gate's job is to answer
# "can a claude_local agent get a completion here", and it asked a question no
# agent asks — so neither its pass nor its fail was about agents. The fail is
# the safe direction and it still cost real work: teamclaude was read as a dead
# model lane, and TOG-358 step 5 was called off on that reading. **The pass is
# the dangerous direction.** A front that answers a bare curl and refuses the
# subscription lane clears this gate, `paperclip.env` gets flipped, and every
# agent on the box breaks on the next container start — the exact outage this
# file exists to prevent, delivered by a green check.
#
# `--no-client-identity` reproduces the old bare request. It is a diagnostic
# for demonstrating the confound, never a way to clear a cutover.
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
# Cheap, and the one model measured working on teamclaude while the rest hung.
# Only ever sent on the timeout path. Set it empty to suppress the control probe.
CONTROL_MODEL="claude-haiku-4-5-20251001"
TIMEOUT=45
ALLOW_PAYG=0
QUIET=0

# The Claude Code client identity (TOG-358). Sent by default because the
# question this gate answers is "can a claude_local agent get a completion
# here", and an agent sends these. See the header note.
CLIENT_IDENTITY=1
CLIENT_UA="claude-cli/2.0.1 (external, cli)"
CLIENT_SYSTEM="You are Claude Code, Anthropic's official CLI for Claude."

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
    --control-model) [[ $# -ge 2 ]] || die "--control-model needs a value"; CONTROL_MODEL="$2"; shift 2;;
    --timeout)    [[ $# -ge 2 ]] || die "--timeout needs a value"; TIMEOUT="$2"; shift 2;;
    --allow-payg) ALLOW_PAYG=1; shift;;
    # Diagnostic only. Strips the Claude Code client identity, reproducing the
    # bare request this tool used to send. Its purpose is to DEMONSTRATE the
    # confound — run with and without against the same endpoint and the
    # difference is the subscription lane. Never use it to clear a cutover:
    # it asks a question no agent asks. See the header note.
    --no-client-identity) CLIENT_IDENTITY=0; shift;;
    --quiet|-q)   QUIET=1; shift;;
    -h|--help)    show_help; exit 0;;
    -*)           die "unknown flag $1";;
    *)            break;;
  esac
done

[[ $# -eq 1 ]] || die "usage: agent_endpoint_preflight.sh [--model M] [--control-model M] [--timeout S] [--allow-payg] [--quiet] <base-url>"
BASE="${1%/}"
[[ "$BASE" == http://* || "$BASE" == https://* ]] || die "expected an http(s) base URL, got \"$BASE\""
[[ "$TIMEOUT" =~ ^[0-9]+$ && "$TIMEOUT" -gt 0 ]] || die "--timeout must be a positive integer, got \"$TIMEOUT\""

# The control probe is a classification, not a completion, so it is capped
# well below --timeout: the working lane answered in under a second when this
# was measured, and a slow control must not double the wall clock of a gate.
CONTROL_TIMEOUT=$(( TIMEOUT < 20 ? TIMEOUT : 20 ))

# The target request has just hung for the full --timeout, and on teamclaude a
# hung request goes on holding capacity after curl gives up (header note). The
# control probe therefore runs at the single worst moment for it: measured
# live, a control that answers in 0.48s cold timed out entirely when sent
# straight after a 25s hang. Settling first buys it a fair attempt. Scaled off
# --timeout so a fast run stays fast and the stub suite pays nothing.
SETTLE=$(( TIMEOUT / 4 )); (( SETTLE > 15 )) && SETTLE=15

KEY="${PREFLIGHT_API_KEY:-${ANTHROPIC_API_KEY:-}}"
[[ -n "$KEY" ]] || die "no key: set PREFLIGHT_API_KEY (or ANTHROPIC_API_KEY). Refusing to probe anonymously — an anonymous 401 is indistinguishable from a wrong key, and this tool must not report a reachable endpoint as unauthorized because it was asked to guess."

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v jq   >/dev/null 2>&1 || die "jq is required"

# The key goes in a 0600 header file, never on a command line (TOG-200).
HDRS="$(mktemp)"; chmod 600 "$HDRS"
BODY="$(mktemp)"
CACHE_BODY="$(mktemp)"
CBODY="$(mktemp)"
trap 'rm -f "$HDRS" "$BODY" "$CACHE_BODY" "$CBODY" 2>/dev/null' EXIT
{
  printf 'x-api-key: %s\n' "$KEY"
  printf 'authorization: Bearer %s\n' "$KEY"
  printf 'anthropic-version: 2023-06-01\n'
  printf 'content-type: application/json\n'
  if [[ "$CLIENT_IDENTITY" -eq 1 ]]; then
    printf 'user-agent: %s\n' "$CLIENT_UA"
    printf 'x-app: cli\n'
  fi
} > "$HDRS"

# Both `x-api-key` and `authorization` are sent because the three candidate
# fronts disagree: teamclaude and CLIProxy take `x-api-key` (the Anthropic
# convention), OmniRoute takes a Bearer token. Sending one and getting a 401
# would say "unauthorized" about an endpoint that is merely differently
# configured, which is the wrong answer to give at a cutover gate.

# Both requests are built here, from one function and one nonce, so the target
# and control differ only by model. If they carried different identities or
# cache prefixes the control would answer a different question from the one it
# is used to settle.
CACHE_SEED="preflight-cache-${PREFLIGHT_CACHE_NONCE:-$(date +%s%N)-$$}"
request_body() { # request_body <model>
  # A cache hit needs a cacheable prefix. The production Claude Code system
  # prompt is much larger than this marker; repeating a deterministic phrase
  # keeps the probe small while clearing every Claude model's minimum.
  # The unique suffix prevents a stale entry from a previous run from making the
  # FIRST request look like a read. It is generated without secrets and never
  # leaves the request body.
  local cache_prefix i
  cache_prefix=""
  # Numbered words resist tokenizer compression: 1024 repetitions of one word
  # can still fall below a model's cache minimum. This is ~18 KiB on the wire.
  for ((i=0; i<1024; i++)); do
    printf -v cache_prefix '%s cache-prefix-%04d' "$cache_prefix" "$i"
  done
  if [[ "$CLIENT_IDENTITY" -eq 1 ]]; then
    printf '{"model":"%s","max_tokens":16,"system":[{"type":"text","text":"%s %s %s","cache_control":{"type":"ephemeral"}}],"messages":[{"role":"user","content":"hi"}]}' \
      "$1" "$CLIENT_SYSTEM" "$CACHE_SEED" "$cache_prefix"
  else
    # Keep the diagnostic truly bare: no Claude Code system prompt. The cacheable
    # prefix lives in the user content instead.
    printf '{"model":"%s","max_tokens":16,"messages":[{"role":"user","content":[{"type":"text","text":"%s %s","cache_control":{"type":"ephemeral"}},{"type":"text","text":"hi"}]}]}' \
      "$1" "$CACHE_SEED" "$cache_prefix"
  fi
}

REQ="$(request_body "$MODEL")"

# ---------------------------------------------------------------------------
# First request. No retries, on any outcome. A second request is reachable only
# after this one proves auth, envelope, lane and a positive cache creation.
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

# One control request, one cheap model, reached only from the timeout branch
# below and never from the auth branch — the IP-ban rule is about repeating a REJECTED
# credential, and this is a different model on a request that was never
# answered at all. HTTP 200 alone is not enough: a reverse proxy can render its
# own error object with status 200, so the control earns "endpoint is UP" only
# from a real Anthropic Messages envelope.
control_probe() {
  local w rc=0 shape
  (( SETTLE > 0 )) && sleep "$SETTLE"
  w="$(curl -sS -o "$CBODY" \
        --max-time "$CONTROL_TIMEOUT" --connect-timeout 10 \
        -H "@$HDRS" \
        -d "$(request_body "$CONTROL_MODEL")" \
        -w '%{http_code}' \
        "$BASE/v1/messages" 2>/dev/null)" || rc=$?
  [[ -n "$w" ]] || w=000
  # A status and body are not a completed response when curl itself failed.
  # A proxy can send 200 + a valid-looking JSON prefix and then leave the
  # transfer open until --max-time fires. Classifying that partial transfer as
  # endpoint health would turn a double timeout into a false exit 8.
  [[ "$rc" -eq 0 ]] || { printf '000'; return; }
  if [[ "$w" == 200 ]]; then
    shape="$(jq -r '
      if (.type == "message"
          and (.id | type) == "string" and (.id | length) > 0
          and .role == "assistant"
          and (.model | type) == "string" and (.model | length) > 0
          and (.content | type) == "array"
          and has("stop_reason")
          and (.stop_reason == null or (.stop_reason | type) == "string")
          and has("stop_sequence")
          and (.stop_sequence == null or (.stop_sequence | type) == "string")
          and (.usage | type) == "object"
          and (.usage.input_tokens | type) == "number"
          and (.usage.output_tokens | type) == "number"
          and (.usage | has("cache_creation_input_tokens"))
          and (.usage.cache_creation_input_tokens == null or (.usage.cache_creation_input_tokens | type) == "number")
          and (.usage | has("cache_read_input_tokens"))
          and (.usage.cache_read_input_tokens == null or (.usage.cache_read_input_tokens | type) == "number"))
      then "anthropic" else "invalid" end' "$CBODY" 2>/dev/null)"
    [[ "$shape" == anthropic ]] || w=200-invalid-envelope
  fi
  printf '%s' "$w"
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
      # The target model hung. That says nothing yet about WHOSE fault it is:
      # a dead endpoint and a dead model lane produce the identical silence.
      # One control request separates them. See the TOG-361 note in the header.
      if [[ -z "$CONTROL_MODEL" || "$CONTROL_MODEL" == "$MODEL" ]]; then
        verdict "timeout" 6 "TCP connected in ${CONNECT}s, then no HTTP response within ${TIMEOUT}s. The port is open and the service is not answering; this is neither up nor down, and it must not be read as either. No control probe was run (--control-model is empty or equal to --model), so this CANNOT distinguish a dead endpoint from a dead lane for \"$MODEL\" — rerun with a --control-model to tell them apart."
      fi
      CCODE="$(control_probe)"
      if [[ "$CCODE" == 200 ]]; then
        CID_NOTE="Both requests carried the Claude Code client identity, so that confound is ruled out."
        [[ "$CLIENT_IDENTITY" -eq 1 ]] || CID_NOTE="⚠️ This run used --no-client-identity, so BOTH requests were bare. That alone reproduces a hang on teamclaude for every model except the control (TOG-358) — rule it out by re-running WITHOUT that flag before believing anything about \"$MODEL\"."
        verdict "model-unavailable" 8 "\"$MODEL\" got no HTTP response within ${TIMEOUT}s, but the control model \"$CONTROL_MODEL\" answered HTTP 200 on this same endpoint with this same key. What that proves is narrow: the endpoint is UP, and these two models are not being served alike. It does NOT establish that \"$MODEL\" is unavailable upstream — a front that serves the two from different lanes produces exactly this. ${CID_NOTE} Do NOT read this as an outage, and do NOT read it as a pass: an agent configured for \"$MODEL\" hangs forever here. See TOG-361 and TOG-378."
      fi
      # Deliberately NOT "the whole endpoint is hanging". A control failure has
      # two causes and this tool cannot separate them: the endpoint really is
      # hanging, or the target request that just timed out is still holding the
      # capacity the control needed (TOG-361's measured leak). Claiming the
      # first would be the same overreach this control probe exists to fix —
      # observed live on teamclaude, where the control model answers in 0.48s
      # from cold and timed out here purely because the target ran first.
      CONTROL_RESULT="HTTP ${CCODE}"
      [[ "$CCODE" == 200-invalid-envelope ]] && CONTROL_RESULT="HTTP 200 with a non-Anthropic response envelope"
      verdict "timeout" 6 "TCP connected in ${CONNECT}s, then no HTTP response within ${TIMEOUT}s. The control model \"$CONTROL_MODEL\" also failed (${CONTROL_RESULT}) after a ${SETTLE}s settle, so this run cannot say whether the endpoint is hanging outright or the timed-out \"$MODEL\" request is still holding the capacity the control needed. INCONCLUSIVE, not proof of an outage: re-run after ~75s of quiet with --model \"$CONTROL_MODEL\" to settle it. Either way this is neither up nor down and must not be read as either."
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

SHAPE="$(jq -r '
  if (.type == "message"
      and (.id | type) == "string" and (.id | length) > 0
      and .role == "assistant"
      and (.model | type) == "string" and (.model | length) > 0
      and (.content | type) == "array"
      and has("stop_reason")
      and (.stop_reason == null or (.stop_reason | type) == "string")
      and has("stop_sequence")
      and (.stop_sequence == null or (.stop_sequence | type) == "string")
      and (.usage | type) == "object"
      and (.usage.input_tokens | type) == "number"
      and (.usage.output_tokens | type) == "number"
      and (.usage | has("cache_creation_input_tokens"))
      and (.usage.cache_creation_input_tokens == null or (.usage.cache_creation_input_tokens | type) == "number")
      and (.usage | has("cache_read_input_tokens"))
      and (.usage.cache_read_input_tokens == null or (.usage.cache_read_input_tokens | type) == "number"))
  then "anthropic"
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
    verdict "bad-envelope" 3 "HTTP 200 but the body is not a complete Anthropic message envelope (id/type/role/model/content/stop fields/usage token fields are required)"
    ;;
esac

RESP_MODEL="$(jq -r '.model // ""' "$BODY")"
RESP_ID="$(jq -r '.id // ""' "$BODY")"

# --- 5: subscription lane, or pay-as-you-go? --------------------------------
# Two independent tells, because either can be absent. OpenRouter returns ids
# of the form `gen-…` where Anthropic returns `msg_…`, and it namespaces the
# model as `vendor/model` where a subscription front echoes the bare name.
# This comes before the replay on purpose: without --allow-payg a billable lane
# stops after the first request rather than spending a second completion to test its
# cache implementation.
PAYG_WHY=""
[[ "$RESP_ID" == gen-* ]]      && PAYG_WHY="response id \"$RESP_ID\" is OpenRouter-shaped (Anthropic ids start msg_)"
[[ "$RESP_MODEL" == */* ]]     && PAYG_WHY="${PAYG_WHY:+$PAYG_WHY; }model came back namespaced as \"$RESP_MODEL\", which is a router lane rather than a subscription"

say "served   : model=${RESP_MODEL:-?} id=${RESP_ID:0:12}${RESP_ID:+…}"

if [[ -n "$PAYG_WHY" && "$ALLOW_PAYG" -eq 0 ]]; then
  verdict "payg" 1 "this completion was billed per token, not drawn from a subscription — $PAYG_WHY. TOG-358 flagged this as the owner's call: routing agents here spends money per request while the Max subscriptions go unused. Pass --allow-payg once that decision is recorded."
fi

# --- 6 & 7: cache creation, then an actual cache read (TOG-164) --------------
# A single cold request with both keys set to zero proves only that the front can
# spell the field names. It does not prove that cache accounting survives the
# route. The first response must report a positive cache write, and the exact
# same request must then report a positive read. No phase retries.
CACHE_CREATE="$(jq -r '.usage.cache_creation_input_tokens // empty' "$BODY")"
CACHE_READ="$(jq -r '.usage.cache_read_input_tokens // empty' "$BODY")"
if [[ ! "$CACHE_CREATE" =~ ^[0-9]+$ || "$CACHE_CREATE" -le 0 ]]; then
  verdict "no-cache" 2 "the cacheable first request did not report a positive cache_creation_input_tokens count (creation=${CACHE_CREATE:-missing}, read=${CACHE_READ:-missing}; usage=$(jq -c '.usage' "$BODY" | head -c 200)). Presence or zero-valued placeholders are not proof that TOG-164 can account for cache writes. No replay was sent."
fi

CACHE_CURL_EXIT=0
CACHE_WRITE="$(curl -sS -o "$CACHE_BODY" \
      --max-time "$TIMEOUT" --connect-timeout 10 \
      -H "@$HDRS" -d "$REQ" \
      -w '%{http_code} %{time_connect}' \
      "$BASE/v1/messages" 2>/dev/null)" || CACHE_CURL_EXIT=$?
CACHE_CODE="$(printf '%s' "$CACHE_WRITE" | awk '{print $1}')"
[[ -n "$CACHE_CODE" ]] || CACHE_CODE=000
if [[ "$CACHE_CURL_EXIT" -ne 0 || "$CACHE_CODE" != 200 ]]; then
  verdict "no-cache" 2 "the identical cache replay did not return HTTP 200 (curl=${CACHE_CURL_EXIT}, HTTP ${CACHE_CODE}). The first request created a cache entry, but the route did not produce a readable follow-up, so TOG-164's cache-read accounting is unproven. No replay retry was sent."
fi
if ! jq -e '
  (.type == "message")
  and (.id | type) == "string" and (.id | length) > 0
  and .role == "assistant"
  and (.model | type) == "string" and (.model | length) > 0
  and (.content | type) == "array"
  and has("stop_reason")
  and (.stop_reason == null or (.stop_reason | type) == "string")
  and has("stop_sequence")
  and (.stop_sequence == null or (.stop_sequence | type) == "string")
  and (.usage | type) == "object"
  and (.usage.input_tokens | type) == "number"
  and (.usage.output_tokens | type) == "number"
  and (.usage | has("cache_creation_input_tokens"))
  and (.usage.cache_creation_input_tokens == null or (.usage.cache_creation_input_tokens | type) == "number")
  and (.usage | has("cache_read_input_tokens"))
  and (.usage.cache_read_input_tokens == null or (.usage.cache_read_input_tokens | type) == "number")
' "$CACHE_BODY" >/dev/null 2>&1; then
  verdict "no-cache" 2 "the identical cache replay returned HTTP 200 without a complete Anthropic message envelope. The first request created a cache entry, but the follow-up cannot prove cache-read accounting."
fi
CACHE_RESP_MODEL="$(jq -r '.model // ""' "$CACHE_BODY")"
CACHE_RESP_ID="$(jq -r '.id // ""' "$CACHE_BODY")"
CACHE_PAYG_WHY=""
[[ "$CACHE_RESP_ID" == gen-* ]]  && CACHE_PAYG_WHY="replay response id \"$CACHE_RESP_ID\" is OpenRouter-shaped"
[[ "$CACHE_RESP_MODEL" == */* ]] && CACHE_PAYG_WHY="${CACHE_PAYG_WHY:+$CACHE_PAYG_WHY; }replay model came back namespaced as \"$CACHE_RESP_MODEL\""
if [[ -n "$CACHE_PAYG_WHY" && "$ALLOW_PAYG" -eq 0 ]]; then
  verdict "payg" 1 "the identical cache replay switched to a pay-per-token lane — $CACHE_PAYG_WHY. A subscription first response does not authorize a billable replay."
fi
[[ -n "$CACHE_PAYG_WHY" ]] && PAYG_WHY="${PAYG_WHY:+$PAYG_WHY; }$CACHE_PAYG_WHY"
CACHE_REPLAY_CREATE="$(jq -r '.usage.cache_creation_input_tokens // empty' "$CACHE_BODY")"
CACHE_REPLAY_READ="$(jq -r '.usage.cache_read_input_tokens // empty' "$CACHE_BODY")"
if [[ ! "$CACHE_REPLAY_READ" =~ ^[0-9]+$ || "$CACHE_REPLAY_READ" -le 0 ]]; then
  verdict "no-cache" 2 "the identical follow-up did not report a positive cache_read_input_tokens count (creation=${CACHE_REPLAY_CREATE:-missing}, read=${CACHE_REPLAY_READ:-missing}; usage=$(jq -c '.usage' "$CACHE_BODY" | head -c 200)). The route accepted cache_control and produced completions, but TOG-164's cache-read accounting is still unproven."
fi
say "cache    : creation=$CACHE_CREATE replay_read=$CACHE_REPLAY_READ"

if [[ -n "$PAYG_WHY" ]]; then
  verdict "ok" 0 "reachable, authorized, Anthropic envelope, positive cache creation and replay evidence. PAYG lane accepted via --allow-payg ($PAYG_WHY)."
fi

verdict "ok" 0 "reachable, authorized, Anthropic envelope with positive cache creation and replay evidence, served from a subscription lane"
