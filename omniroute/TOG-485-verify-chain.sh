#!/usr/bin/env bash
#
# TOG-485 — verify the Claude Code -> OmniRoute -> CLIProxy -> Codex chain.
#
# Run this BEFORE pointing any agent's ANTHROPIC_BASE_URL at OmniRoute, and
# again after any CLIProxy or OmniRoute restart.
#
#   ./TOG-485-verify-chain.sh                    # default model cliproxy/gpt-5.6-sol
#   MODEL=cliproxy/gpt-5.4 ./TOG-485-verify-chain.sh
#   ./TOG-485-verify-chain.sh --model cliproxy/gpt-5.6-sol
#
# Requires OMNIROUTE_API_KEY in the environment (an INFERENCE key — scopes
# self:usage + self:account-quota. NOT a management key; management and
# inference are different token classes and a management probe returning 403
# says nothing about inference).
#
# ---------------------------------------------------------------------------
# WHY EVERY RESPONSE GOES TO A FRESH mktemp PATH
# ---------------------------------------------------------------------------
# The first version of this script wrote each gate's response to a FIXED path
# (/tmp/.g3, /tmp/.g5, /tmp/.g6). Inside a container those files outlive the run
# and are shared between runners. Its first run here reported:
#
#     FAIL G3 — GET /v1/models -> 000 {"error":{"code":"AUTH_002",...}}
#
# `000` means curl got NO RESPONSE AT ALL. A body cannot come from a request
# that never completed — that AUTH_002 was a STALE FILE from an earlier run, and
# G4/G5/G6 all cascaded off it. All four "failures" were artifacts of the
# storage, not of the chain. Re-probed with per-run paths, everything passed.
#
# So: one mktemp -d per run, trapped clean on exit, and a `000` is reported as
# "empty response" with the body deliberately NOT printed — because when the
# code is 000 there is, by definition, no body to print.
#
# ---------------------------------------------------------------------------
# ADDRESSING RULES (measured — do not "simplify" these)
# ---------------------------------------------------------------------------
#   - CLIProxy is a podman container on the omniroute network. Address it as
#     `cliproxy`, NEVER by IP: it moved 10.89.1.55 -> 10.89.1.56 across a single
#     restart while the name held.
#   - OmniRoute is `omniroute`. Its loopback/host-gateway addresses are not the
#     right vantage point from inside a container.
#   - Never echo the key. Length only, if anything. It is written to a private
#     0600 header file and curl receives only that file's path; /proc exposes
#     every process's argv on this host.

set -uo pipefail

# Strip credential exports before argument parsing: even `--help` starts sed,
# and every child environment is readable through /proc on this host.
OMNIROUTE_KEY="${OMNIROUTE_API_KEY:-}"
export -n OMNIROUTE_KEY 2>/dev/null || true
unset OMNIROUTE_API_KEY

MODEL="${MODEL:-cliproxy/gpt-5.6-sol}"
OMNIROUTE_BASE="${OMNIROUTE_BASE:-http://omniroute:20129}"
CLIPROXY_BASE="${CLIPROXY_BASE:-http://cliproxy:8317}"
MAX_TIME="${MAX_TIME:-90}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="${2:?--model needs a value}"; shift 2 ;;
    --base)  OMNIROUTE_BASE="${2:?--base needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) echo "usage: $0 [--model ID] [--base URL]" >&2; exit 2 ;;
  esac
done

command -v jq >/dev/null || { echo "FATAL: jq is required" >&2; exit 1; }

# -- per-run scratch. THE central fix. ---------------------------------------
RUNDIR="$(umask 077; mktemp -d "${TMPDIR:-/tmp}/tog485-verify.XXXXXXXX")" || {
  echo "FATAL: could not create a private scratch dir" >&2; exit 1; }
trap 'rm -rf "$RUNDIR"' EXIT
echo "scratch: $RUNDIR (fresh this run, removed on exit)"

# Build authentication once, after the key-presence gate below, then pass only
# this pathname to curl. Expanding `-H "x-api-key: ${OMNIROUTE_API_KEY}"` puts
# the live key in /proc/<curl>/cmdline for the whole request.
CURL_AUTH=""
CURL_AUTH_FD=""
write_curl_auth() {
  CURL_AUTH="$RUNDIR/curl-auth.conf"
  # `umask` is a shell builtin, so this group starts no child while the local
  # key still exists. Redirection creates the file at its final private mode.
  umask 077
  {
    printf 'header = "x-api-key: %s"\n' "$OMNIROUTE_KEY"
    printf 'header = "anthropic-version: 2023-06-01"\n'
  } > "$CURL_AUTH" \
    || { echo "FATAL: could not write curl authentication config" >&2; exit 1; }
  chmod 0600 "$CURL_AUTH"
  # Keep the inode open but unlink its pathname before the first request. Curl
  # reopens this inherited fd for every call; SIGKILL/container death can no
  # longer strand a named credential file for a later runner to discover.
  exec {CURL_AUTH_FD}<"$CURL_AUTH" \
    || { echo "FATAL: could not open curl authentication config" >&2; exit 1; }
  rm -f "$CURL_AUTH" \
    || { echo "FATAL: could not unlink curl authentication config" >&2; exit 1; }
  CURL_AUTH="/dev/fd/$CURL_AUTH_FD"
  OMNIROUTE_KEY=""
}

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS $*"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL $*"; }
note() { echo "     $*"; }

# req <name> <method> <url> [data] [authenticated]
# Writes the body to $RUNDIR/<name>.body and echoes the HTTP code.
# A code of 000 means no response completed; the body file will be empty and
# MUST NOT be treated as a response. Request data goes on stdin rather than argv
# because the payload may grow to include values that should not be process-wide.
req() {
  local name="$1" method="$2" url="$3" data="${4:-}" authenticated="${5:-0}"
  local body="$RUNDIR/$name.body" code rc=0
  local args=(-sS -X "$method" --max-time "$MAX_TIME" -o "$body" -w '%{http_code}')
  [[ "$authenticated" == 1 ]] && args+=(--config "$CURL_AUTH")
  [[ -n "$data" ]] && args+=(-H "Content-Type: application/json" --data-binary @-)
  if [[ -n "$data" ]]; then
    # -q MUST be curl's first argument: it suppresses ~/.curlrc before that file
    # can add a trace, header dump, or second URL that exposes/forwards our key.
    code="$(printf '%s' "$data" | curl -q "${args[@]}" "$url" 2>"$RUNDIR/$name.err")" || rc=$?
  else
    code="$(curl -q "${args[@]}" "$url" 2>"$RUNDIR/$name.err")" || rc=$?
  fi
  printf '%s\n' "$rc" > "$RUNDIR/$name.curl-exit"
  printf '%s' "$code"
}

body_of() { cat "$RUNDIR/$1.body" 2>/dev/null; }
curl_exit_of() { cat "$RUNDIR/$1.curl-exit" 2>/dev/null || printf 'unknown'; }
transport_failed() { [[ "$(curl_exit_of "$1")" != 0 ]]; }

# Report a transport failure honestly instead of printing a complete-looking
# partial body. curl can receive HTTP 200 and parseable JSON, then exit 28 because
# the response never terminates. In that case the status and body prove nothing.
explain_transport() {
  local name="$1" code="$2" rc
  rc="$(curl_exit_of "$name")"
  if [[ "$code" == "000" || -z "$code" ]]; then
    note "code 000 = NO RESPONSE COMPLETED (connect failure, DNS failure, or timeout after ${MAX_TIME}s)."
  else
    note "curl exited $rc after receiving HTTP $code. The transfer did not complete, so its body is partial and MUST NOT be used as a response."
  fi
  note "curl said: $(head -c 200 "$RUNDIR/$name.err" 2>/dev/null)"
  note "Do NOT read the body file as this request's reply — that is exactly the false-green this gate exists to prevent."
}

echo "model under test : $MODEL"
echo "omniroute        : $OMNIROUTE_BASE"
echo "cliproxy         : $CLIPROXY_BASE"
echo

# =============================================================== G1: CLIProxy =
echo "== G1  CLIProxy liveness =="
code="$(req g1 GET "$CLIPROXY_BASE/healthz")"
if transport_failed g1; then
  bad "G1 — $CLIPROXY_BASE/healthz transport failed"; explain_transport g1 "$code"
elif [[ "$code" == "200" ]]; then
  ok "G1 — CLIProxy healthz 200 $(body_of g1 | head -c 80)"
else
  bad "G1 — CLIProxy healthz -> $code"; note "$(body_of g1 | head -c 200)"
fi

# ========================================================= G2: OmniRoute auth =
echo
echo "== G2  OmniRoute inference reachable and authenticated =="
if [[ -z "$OMNIROUTE_KEY" ]]; then
  bad "G2 — OMNIROUTE_API_KEY is not set in the environment"
  note "This is an INFERENCE key (self:usage + self:account-quota), not a management key."
  note "In Paperclip it is bound per-agent as adapterConfig.env.OMNIROUTE_API_KEY (a secret_ref)."
  note "Remaining gates need it; they will be reported as SKIPPED, not as passes."
  SKIP_REST=1
else
  SKIP_REST=0
  write_curl_auth
  code="$(req g2 GET "$OMNIROUTE_BASE/v1/models" "" 1)"
  if transport_failed g2; then
    bad "G2 — $OMNIROUTE_BASE/v1/models transport failed"; explain_transport g2 "$code"; SKIP_REST=1
  elif [[ "$code" == "200" ]]; then
    ok "G2 — /v1/models 200 ($(body_of g2 | jq -r '(.data//[])|length' 2>/dev/null) ids)"
  else
    # Useful oracle, measured: OmniRoute distinguishes these two.
    #   no key at all -> "Authentication required"
    #   key present but wrong -> "Invalid API key"
    msg="$(body_of g2 | jq -r '.error.message // empty' 2>/dev/null)"
    bad "G2 — /v1/models -> $code : ${msg:-$(body_of g2 | head -c 200)}"
    case "$msg" in
      *"Authentication required"*) note "The key never reached OmniRoute — the header was not sent." ;;
      *"Invalid API key"*)         note "A key WAS sent and OmniRoute rejected it. Wrong key, wrong class, or revoked." ;;
    esac
    SKIP_REST=1
  fi
fi

skip() { echo "SKIP $* (blocked by an earlier gate — NOT a pass)"; }

# ========================================================== G3: catalogue has =
echo
echo "== G3  Catalogue exposes the model under test =="
if [[ "$SKIP_REST" == "1" ]]; then
  skip "G3"
else
  if body_of g2 | jq -e --arg m "$MODEL" '[(.data//[])[].id] | index($m)' >/dev/null 2>&1; then
    ok "G3 — '$MODEL' present in the OmniRoute catalogue"
  else
    bad "G3 — '$MODEL' is NOT in the catalogue"
    note "closest ids: $(body_of g2 | jq -r '[(.data//[])[].id]|.[]' 2>/dev/null | grep -iE "${MODEL%%-*}|sol" | head -5 | tr '\n' ' ')"
  fi
fi

# ====================================================== G4: Anthropic envelope =
echo
echo "== G4  POST /v1/messages returns a well-formed Anthropic envelope =="
if [[ "$SKIP_REST" == "1" ]]; then
  skip "G4"
else
  payload="$(jq -nc --arg m "$MODEL" \
    '{model:$m, max_tokens:64, messages:[{role:"user",content:"Reply with exactly: CHAINOK"}]}')"
  code="$(req g4 POST "$OMNIROUTE_BASE/v1/messages" "$payload" 1)"
  if transport_failed g4; then
    bad "G4 — incomplete response from /v1/messages"; explain_transport g4 "$code"
    note "TOG-153 recorded a 60s hang hazard on a different path. --max-time ${MAX_TIME}s bounds it here."
  elif [[ "$code" != "200" ]]; then
    bad "G4 — /v1/messages -> $code"; note "$(body_of g4 | head -c 300)"
  else
    # Assert on the CONTENT, not on the 200. A 200 with the wrong echoed model
    # means the request silently landed on another provider.
    id="$(body_of g4 | jq -r 'if (.id|type)=="string" then .id else "" end')"
    t="$(body_of g4 | jq -r '.type // empty')"
    r="$(body_of g4 | jq -r '.role // empty')"
    em="$(body_of g4 | jq -r '.model // empty')"
    inp="$(body_of g4 | jq -r '.usage.input_tokens // empty')"
    outp="$(body_of g4 | jq -r '.usage.output_tokens // empty')"
    inp_ok="$(body_of g4 | jq -r 'if (.usage.input_tokens|type)=="number" and .usage.input_tokens>=0 and (.usage.input_tokens|floor)==.usage.input_tokens then "yes" else "no" end')"
    outp_ok="$(body_of g4 | jq -r 'if (.usage.output_tokens|type)=="number" and .usage.output_tokens>=0 and (.usage.output_tokens|floor)==.usage.output_tokens then "yes" else "no" end')"
    content_type="$(body_of g4 | jq -r '.content | type')"
    stop="$(body_of g4 | jq -r '.stop_reason // empty')"
    stop_sequence_ok="$(body_of g4 | jq -r 'if has("stop_sequence") and (.stop_sequence == null or (.stop_sequence|type)=="string") then "yes" else "no" end')"
    blocks_ok="$(body_of g4 | jq -r 'if (.content|type)=="array" and all(.content[]; .type=="text" and (.text|type)=="string") then "yes" else "no" end')"
    tool_count="$(body_of g4 | jq '[.content[]?|select(.type|endswith("tool_use"))]|length' 2>/dev/null)"
    txt="$(body_of g4 | jq -r '[.content[]?|select(.type=="text").text]|join("")' 2>/dev/null)"
    problems=()
    [[ -n "$id"             ]] || problems+=("id missing or non-string")
    [[ "$t"  == "message"   ]] || problems+=("type='$t' (want message)")
    [[ "$r"  == "assistant" ]] || problems+=("role='$r' (want assistant)")
    [[ "$em" == "$MODEL"    ]] || problems+=("echoed model='$em' but requested '$MODEL' — request landed elsewhere")
    [[ "$content_type" == "array" ]] || problems+=("content type='$content_type' (want array)")
    [[ "$blocks_ok" == yes   ]] || problems+=("content contains a non-text or malformed block")
    [[ "$inp_ok" == yes      ]] || problems+=("usage.input_tokens='$inp' is not a non-negative integer")
    [[ "$outp_ok" == yes     ]] || problems+=("usage.output_tokens='$outp' is not a non-negative integer")
    [[ "$stop_sequence_ok" == yes ]] || problems+=("stop_sequence is missing or not string/null")
    [[ "$stop" == "end_turn" ]] || problems+=("stop_reason='$stop' (want end_turn)")
    [[ "$tool_count" -eq 0  ]] || problems+=("unexpected tool_use blocks=$tool_count")
    [[ "$txt" == "CHAINOK"  ]] || problems+=("text=$(printf '%q' "$txt") (want exactly CHAINOK)")
    if [[ ${#problems[@]} -eq 0 ]]; then
      ok "G4 — type=message role=assistant model=$em usage.input_tokens=$inp text=$(printf '%q' "${txt:0:40}")"
    else
      bad "G4 — 200 but the envelope is wrong: ${problems[*]}"
    fi
  fi
fi

# ============================================================ G5: tool calling =
echo
echo "== G5  Tool calling produces a real tool_use block =="
if [[ "$SKIP_REST" == "1" ]]; then
  skip "G5"
else
  payload="$(jq -nc --arg m "$MODEL" '{
    model:$m, max_tokens:256,
    tools:[{name:"get_weather",
            description:"Get the current weather in a given city",
            input_schema:{type:"object",properties:{city:{type:"string"}},required:["city"]}}],
    tool_choice:{type:"any"},
    messages:[{role:"user",content:"What is the weather in Paris?"}]}')"
  code="$(req g5 POST "$OMNIROUTE_BASE/v1/messages" "$payload" 1)"
  if transport_failed g5; then
    bad "G5 — incomplete response"; explain_transport g5 "$code"
  elif [[ "$code" != "200" ]]; then
    bad "G5 — /v1/messages (tools) -> $code"; note "$(body_of g5 | head -c 300)"
  else
    gid="$(body_of g5 | jq -r 'if (.id|type)=="string" then .id else "" end')"
    gt="$(body_of g5 | jq -r '.type // empty')"
    gr="$(body_of g5 | jq -r '.role // empty')"
    gm="$(body_of g5 | jq -r '.model // empty')"
    content_type="$(body_of g5 | jq -r '.content | type')"
    blocks_ok="$(body_of g5 | jq -r 'if (.content|type)=="array" and all(.content[]; .type=="tool_use") then "yes" else "no" end')"
    stop="$(body_of g5 | jq -r '.stop_reason // empty')"
    stop_sequence_ok="$(body_of g5 | jq -r 'if has("stop_sequence") and (.stop_sequence == null or (.stop_sequence|type)=="string") then "yes" else "no" end')"
    usage_ok="$(body_of g5 | jq -r 'if (.usage|type)=="object" and (.usage.input_tokens|type)=="number" and .usage.input_tokens>=0 and (.usage.input_tokens|floor)==.usage.input_tokens and (.usage.output_tokens|type)=="number" and .usage.output_tokens>=0 and (.usage.output_tokens|floor)==.usage.output_tokens then "yes" else "no" end')"
    tool_count="$(body_of g5 | jq '[.content[]?|select(.type=="tool_use")]|length')"
    tu="$(body_of g5 | jq -c '[.content[]?|select(.type=="tool_use")]|.[0] // empty')"
    if [[ -n "$gid" && "$gt" == "message" && "$gr" == "assistant" && "$gm" == "$MODEL" && "$content_type" == "array" && "$blocks_ok" == yes && "$stop" == "tool_use" && "$stop_sequence_ok" == yes && "$usage_ok" == yes && "$tool_count" -eq 1 && -n "$tu" ]]; then
      tid="$(jq -r 'if (.id|type)=="string" then .id else "" end' <<<"$tu")"
      tname="$(jq -r '.name // empty' <<<"$tu")"
      tin="$(jq -c '.input // {}' <<<"$tu")"
      id_ok="$(jq -r 'if (.id|type)=="string" and (.id|length)>0 then "yes" else "no" end' <<<"$tu")"
      input_ok="$(jq -r 'if (.input|type)=="object" and (.input.city|type)=="string" and (.input.city|length)>0 then "yes" else "no" end' <<<"$tu")"
      if [[ "$id_ok" == yes && "$tname" == "get_weather" && "$input_ok" == yes ]]; then
        ok "G5 — stop_reason=tool_use name=$tname id=$tid input=$tin"
      else
        bad "G5 — tool_use block malformed: id='$tid' name='$tname' input=$tin"
        note "A tool_use without a correlatable id and schema-valid input cannot be executed — agentic loops break."
      fi
    else
      bad "G5 — envelope/type/route mismatch: id='$gid' type='$gt' role='$gr' model='$gm' content='$content_type' blocks_ok='$blocks_ok' stop_reason='$stop' stop_sequence_ok='$stop_sequence_ok' usage_ok='$usage_ok', tool_use blocks=$tool_count"
      note "Claude Code cannot drive this model agentically without one well-formed tool_use. Do NOT switch any agent onto it."
    fi
  fi
fi

# ================================================================ G6: no hang =
echo
echo "== G6  No hang; timing bounded =="
if [[ "$SKIP_REST" == "1" ]]; then
  skip "G6"
else
  start="$SECONDS"
  payload="$(jq -nc --arg m "$MODEL" '{model:$m,max_tokens:16,messages:[{role:"user",content:"ping"}]}')"
  code="$(req g6 POST "$OMNIROUTE_BASE/v1/messages" "$payload" 1)"
  elapsed=$((SECONDS-start))
  if transport_failed g6; then
    bad "G6 — incomplete response after ${elapsed}s"; explain_transport g6 "$code"
  elif [[ "$code" == "200" ]]; then
    ok "G6 — completed in ${elapsed}s (bound ${MAX_TIME}s)"
  else
    bad "G6 — -> $code after ${elapsed}s"; note "$(body_of g6 | head -c 200)"
  fi
fi

echo
echo "=============================================="
echo "  PASS=$PASS  FAIL=$FAIL   model=$MODEL"
echo "=============================================="
[[ "$FAIL" -eq 0 ]] || exit 1
echo "Chain is green for $MODEL."
