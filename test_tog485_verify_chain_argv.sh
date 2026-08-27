#!/usr/bin/env bash
# Regression suite for TOG-485-verify-chain.sh: the OmniRoute inference key
# must reach curl through a private config file, never through argv.
#
# Offline: a stub curl reads /proc/$$/cmdline, records the config mode/header,
# and serves the six responses the verifier expects. The positive control sends
# the same canary on argv first, so a green absence assertion proves something.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${TOG485_VERIFY_SH:-$HERE/omniroute/TOG-485-verify-chain.sh}"
PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }

[[ -r /proc/$$/cmdline ]] || { echo "test_tog485_verify_chain_argv: needs Linux /proc" >&2; exit 2; }
[[ -x "$TOOL" ]] || { echo "test_tog485_verify_chain_argv: $TOOL is not executable" >&2; exit 2; }
command -v jq >/dev/null || { echo "test_tog485_verify_chain_argv: jq is required" >&2; exit 2; }
command -v node >/dev/null || { echo "test_tog485_verify_chain_argv: node is required" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/tooltmp"
CMDLOG="$TMP/cmdline.log"
ENVLOG="$TMP/environ.log"
CFGLOG="$TMP/config.log"
CANARY="omni-argv-canary-7e91d2"
STUB_TEXT="CHAINOK"

cat > "$TMP/bin/curl" <<'STUB'
#!/usr/bin/env bash
{ tr '\0' '\n' < "/proc/$$/cmdline"; printf -- '--END-ARGV--\n'; } >> "$STUB_CMDLOG"
{ tr '\0' '\n' < "/proc/$$/environ"; printf -- '--END-ENV--\n'; } >> "$STUB_ENVLOG"

cfg=""; out=""; url=""; data_arg=""; prev=""
printf 'FIRST\t%s\n' "${1:-}" >> "$STUB_CFGLOG"
for a in "$@"; do
  case "$prev" in
    --config|-K) cfg="$a" ;;
    -o) out="$a" ;;
    --data-binary) data_arg="$a" ;;
  esac
  case "$a" in http://*|https://*) url="$a" ;; esac
  prev="$a"
done

if [[ -n "$cfg" ]]; then
  printf 'CONFIG\t%s\n' "$cfg" >> "$STUB_CFGLOG"
  printf 'MODE\t%s\n' "$(stat -Lc '%a' "$cfg")" >> "$STUB_CFGLOG"
  case "$cfg" in
    /dev/fd/[0-9]*) printf 'TARGET\t%s\n' "$(readlink "/proc/$$/fd/${cfg#/dev/fd/}")" >> "$STUB_CFGLOG" ;;
  esac
  sed -n 's/^header = "x-api-key: \(.*\)"$/KEY\t\1/p' "$cfg" >> "$STUB_CFGLOG"
  grep -qx 'header = "anthropic-version: 2023-06-01"' "$cfg" \
    && printf 'VERSION\t2023-06-01\n' >> "$STUB_CFGLOG"
fi
printf 'DATA\t%s\n' "$data_arg" >> "$STUB_CFGLOG"
[[ "$data_arg" == @- ]] && body="$(cat)" || body=""
mkdir -p "$(dirname "$out")"

case "$url" in
  */healthz)
    if [[ -n "${STUB_PARTIAL_HEALTH:-}" ]]; then
      printf '{"status":"ok"}' > "$out"
      printf '200'
      exit 28
    fi
    printf '{"status":"ok"}' > "$out"
    ;;
  */v1/models)
    printf '{"data":[{"id":"cliproxy/gpt-5.6-sol"}]}' > "$out"
    ;;
  */v1/messages)
    if [[ -n "${STUB_G4_BAD_STOP_SEQUENCE:-}" ]] && ! jq -e '.tools != null' >/dev/null 2>&1 <<<"$body"; then
      printf '{"id":"msg_text","type":"message","role":"assistant","model":"cliproxy/gpt-5.6-sol","content":[{"type":"text","text":"CHAINOK"}],"stop_reason":"end_turn","stop_sequence":42,"usage":{"input_tokens":9,"output_tokens":1}}' > "$out"
    elif [[ -n "${STUB_G4_CONTENT_OBJECT:-}" ]] && ! jq -e '.tools != null' >/dev/null 2>&1 <<<"$body"; then
      printf '{"id":"msg_text","type":"message","role":"assistant","model":"cliproxy/gpt-5.6-sol","content":{"only":{"type":"text","text":"CHAINOK"}},"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":9,"output_tokens":1}}' > "$out"
    elif [[ -n "${STUB_G4_BAD_USAGE:-}" ]] && ! jq -e '.tools != null' >/dev/null 2>&1 <<<"$body"; then
      printf '{"id":"msg_text","type":"message","role":"assistant","model":"cliproxy/gpt-5.6-sol","content":[{"type":"text","text":"CHAINOK"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":"unknown","output_tokens":1}}' > "$out"
    elif [[ -n "${STUB_G4_TOOL_USE:-}" ]] && ! jq -e '.tools != null' >/dev/null 2>&1 <<<"$body"; then
      printf '{"id":"msg_text","type":"message","role":"assistant","model":"cliproxy/gpt-5.6-sol","content":[{"type":"text","text":"CHAINOK"},{"type":"tool_use","id":"toolu_g4","name":"unexpected","input":{}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":9,"output_tokens":1}}' > "$out"
    elif jq -e '.tools != null' >/dev/null 2>&1 <<<"$body"; then
      if [[ -n "${STUB_BAD_TOOL_INPUT:-}" ]]; then
        printf '{"id":"msg_tool","type":"message","role":"assistant","model":"cliproxy/gpt-5.6-sol","content":[{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":8}}' > "$out"
      elif [[ -n "${STUB_NUMERIC_TOOL_ID:-}" ]]; then
        printf '{"id":"msg_tool","type":"message","role":"assistant","model":"cliproxy/gpt-5.6-sol","content":[{"type":"tool_use","id":42,"name":"get_weather","input":{"city":"Paris"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":8}}' > "$out"
      elif [[ -n "${STUB_EXTRA_TOOL_USE:-}" ]]; then
        printf '{"id":"msg_tool","type":"message","role":"assistant","model":"cliproxy/gpt-5.6-sol","content":[{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{"city":"Paris"}},{"type":"tool_use","id":{},"name":"broken","input":{}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":8}}' > "$out"
      elif [[ -n "${STUB_WRONG_TOOL_MODEL:-}" ]]; then
        printf '{"id":"msg_tool","type":"message","role":"assistant","model":"wrong-model","content":[{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{"city":"Paris"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":8}}' > "$out"
      elif [[ -n "${STUB_G5_CONTENT_OBJECT:-}" ]]; then
        printf '{"id":"msg_tool","type":"message","role":"assistant","model":"cliproxy/gpt-5.6-sol","content":{"only":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{"city":"Paris"}}},"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":8}}' > "$out"
      elif [[ -n "${STUB_G5_BAD_STOP_SEQUENCE:-}" ]]; then
        printf '{"id":"msg_tool","type":"message","role":"assistant","model":"cliproxy/gpt-5.6-sol","content":[{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{"city":"Paris"}}],"stop_reason":"tool_use","stop_sequence":42,"usage":{"input_tokens":10,"output_tokens":8}}' > "$out"
      else
        printf '{"id":"msg_tool","type":"message","role":"assistant","model":"cliproxy/gpt-5.6-sol","content":[{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{"city":"Paris"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":8}}' > "$out"
      fi
    else
      printf '{"id":"msg_text","type":"message","role":"assistant","model":"cliproxy/gpt-5.6-sol","content":[{"type":"text","text":"%s"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":9,"output_tokens":1}}' "${STUB_TEXT-CHAINOK}" > "$out"
    fi
    ;;
  *) printf '{"error":"unexpected URL"}' > "$out" ;;
esac
printf '200'
STUB
chmod +x "$TMP/bin/curl"

cat > "$TMP/bin/sed" <<'STUBSED'
#!/usr/bin/env bash
{ tr '\0' '\n' < "/proc/$$/environ"; printf -- '--END-SED-ENV--\n'; } >> "$STUB_ENVLOG"
exec /usr/bin/sed "$@"
STUBSED
chmod +x "$TMP/bin/sed"

# Positive controls: prove both kernel-visible detectors catch the canary.
: > "$CMDLOG"; : > "$ENVLOG"; : > "$CFGLOG"
STUB_CMDLOG="$CMDLOG" STUB_ENVLOG="$ENVLOG" STUB_CFGLOG="$CFGLOG" \
  OMNIROUTE_API_KEY="$CANARY" "$TMP/bin/curl" \
  -o "$TMP/control.body" -H "x-api-key: $CANARY" http://stub/healthz >/dev/null
if grep -qF "$CANARY" "$CMDLOG"; then
  ok "an argv-borne OmniRoute key IS detected"
else
  bad "detector is blind: an argv-borne key was not visible in /proc/<curl>/cmdline"
fi
if grep -qF "OMNIROUTE_API_KEY=$CANARY" "$ENVLOG"; then
  ok "an environment-borne OmniRoute key IS detected"
else
  bad "detector is blind: an environment-borne key was not visible in /proc/<curl>/environ"
fi

# Help is credential-free but still starts sed. It must strip both possible
# exports before that first child process.
: > "$ENVLOG"
env -i PATH="$TMP/bin:$PATH" OMNIROUTE_API_KEY="$CANARY" OMNIROUTE_KEY="preexported-alias" \
  STUB_ENVLOG="$ENVLOG" bash "$TOOL" --help >/dev/null 2>&1
HELP_RC=$?
[[ "$HELP_RC" -eq 0 ]] && ok "--help exits 0" || bad "--help exited $HELP_RC"
if grep -qF "$CANARY" "$ENVLOG"; then
  bad "--help leaked an OmniRoute credential into sed's environment"
else
  ok "--help strips credentials before starting sed"
fi

: > "$CMDLOG"; : > "$ENVLOG"; : > "$CFGLOG"
OUT="$(env -i \
  PATH="$TMP/bin:$PATH" \
  TMPDIR="$TMP/tooltmp" \
  MODEL=cliproxy/gpt-5.6-sol \
  OMNIROUTE_BASE=http://omniroute.test \
  CLIPROXY_BASE=http://cliproxy.test \
  MAX_TIME=2 \
  OMNIROUTE_API_KEY="$CANARY" \
  OMNIROUTE_KEY="preexported-alias" \
  STUB_CMDLOG="$CMDLOG" \
  STUB_ENVLOG="$ENVLOG" \
  STUB_CFGLOG="$CFGLOG" \
  STUB_TEXT="$STUB_TEXT" \
  bash "$TOOL" 2>"$TMP/stderr")"
RC=$?

[[ "$RC" -eq 0 ]] && ok "verifier completes against the authenticated stub" \
                  || bad "verifier exited $RC: $(head -c 200 "$TMP/stderr")"
grep -q 'Chain is green for cliproxy/gpt-5.6-sol.' <<<"$OUT" \
  && ok "verifier reports the chain green" || bad "verifier did not reach its success verdict"

if grep -qF "$CANARY" "$CMDLOG"; then
  bad "OMNIROUTE_API_KEY appeared in /proc/<curl>/cmdline"
else
  ok "OMNIROUTE_API_KEY never appears in curl argv"
fi
if grep -qF "$CANARY" "$ENVLOG"; then
  bad "the OmniRoute credential appeared under some name in /proc/<curl>/environ"
else
  ok "the OmniRoute credential never appears in curl environments"
fi

CALLS="$(grep -c '^--END-ARGV--$' "$CMDLOG")"
[[ "$CALLS" -eq 5 ]] && ok "all five expected curl calls ran" \
                       || bad "expected five curl calls, recorded $CALLS"
FIRST_Q="$(grep -cx $'FIRST\t-q' "$CFGLOG")"
[[ "$FIRST_Q" -eq 5 ]] && ok "every curl call disables inherited curlrc first" \
                           || bad "expected five curl calls with first argument -q, got $FIRST_Q"
AUTHED="$(grep -c '^KEY' "$CFGLOG")"
MATCHING_KEYS="$(grep -cx $'KEY\t'"$CANARY" "$CFGLOG")"
[[ "$AUTHED" -eq 4 && "$MATCHING_KEYS" -eq 4 ]] \
  && ok "all four OmniRoute calls received the real key by config" \
  || bad "expected four canary key records, got keys=$AUTHED matching=$MATCHING_KEYS"
VERSIONS="$(grep -cx $'VERSION\t2023-06-01' "$CFGLOG")"
[[ "$VERSIONS" -eq 4 ]] && ok "all four OmniRoute calls received anthropic-version by config" \
                           || bad "expected four anthropic-version records, got $VERSIONS"
DATA_CALLS="$(grep -cx $'DATA\t@-' "$CFGLOG")"
[[ "$DATA_CALLS" -eq 3 ]] && ok "all three message bodies use --data-binary @-" \
                             || bad "expected three stdin body transports, got $DATA_CALLS"
if grep '^MODE' "$CFGLOG" | grep -qv $'MODE\t600'; then
  bad "an authentication config was not mode 0600"
else
  ok "every authentication config observation was mode 0600"
fi
CONFIG_FDS="$(grep -c $'^CONFIG\t/dev/fd/[0-9][0-9]*$' "$CFGLOG")"
[[ "$CONFIG_FDS" -eq 4 ]] && ok "all authenticated calls use an unlinked config fd" \
                              || bad "expected four /dev/fd authentication configs, got $CONFIG_FDS"
DELETED_TARGETS="$(grep -c $'^TARGET\t/.*/curl-auth.conf (deleted)$' "$CFGLOG")"
[[ "$DELETED_TARGETS" -eq 4 ]] \
  && ok "the auth inode is already unlinked while every authenticated curl is running" \
  || bad "expected four live fd targets marked (deleted), got $DELETED_TARGETS"

# Mutation gate: the assertion above must fail if the pre-request unlink is
# removed. This keeps the test from being satisfied only by the EXIT cleanup.
MUTANT="$TMP/verifier-no-unlink.sh"
node - "$TOOL" "$MUTANT" <<'NODE'
const fs = require('fs')
const [src, dst] = process.argv.slice(2)
const before = `  rm -f "$CURL_AUTH" \\\n    || { echo "FATAL: could not unlink curl authentication config" >&2; exit 1; }\n`
const text = fs.readFileSync(src, 'utf8')
const count = text.split(before).length - 1
if (count !== 1) {
  console.error(`mutation anchor count=${count}, wanted 1`)
  process.exit(2)
}
fs.writeFileSync(dst, text.replace(before, ''))
fs.chmodSync(dst, 0o755)
NODE
MUTATE_RC=$?
if [[ "$MUTATE_RC" -ne 0 ]]; then
  bad "could not build the no-unlink mutation"
else
  : > "$CMDLOG"; : > "$ENVLOG"; : > "$CFGLOG"
  env -i PATH="$TMP/bin:$PATH" TMPDIR="$TMP/tooltmp" MODEL=cliproxy/gpt-5.6-sol \
    OMNIROUTE_BASE=http://omniroute.test CLIPROXY_BASE=http://cliproxy.test MAX_TIME=2 \
    OMNIROUTE_API_KEY="$CANARY" OMNIROUTE_KEY="preexported-alias" \
    STUB_CMDLOG="$CMDLOG" STUB_ENVLOG="$ENVLOG" STUB_CFGLOG="$CFGLOG" STUB_TEXT="$STUB_TEXT" \
    bash "$MUTANT" >/dev/null 2>"$TMP/mutant.stderr"
  MUTANT_RC=$?
  MUTANT_DELETED="$(grep -c $'^TARGET\t/.*/curl-auth.conf (deleted)$' "$CFGLOG")"
  [[ "$MUTANT_RC" -eq 0 && "$MUTANT_DELETED" -eq 0 ]] \
    && ok "removing the unlink makes the live-inode assertion go red" \
    || bad "no-unlink mutation did not isolate the lifecycle defect (rc=$MUTANT_RC deleted=$MUTANT_DELETED)"
fi

if find "$TMP/tooltmp" -type f -name 'curl-auth.conf' -print -quit | grep -q .; then
  bad "a named curl authentication config remained after the verifier run"
else
  ok "the key has no named config file after the verifier run"
fi

SCRATCH="$(sed -n 's/^scratch: \(.*\) (fresh this run, removed on exit)$/\1/p' <<<"$OUT" | head -1)"
if [[ -n "$SCRATCH" && ! -e "$SCRATCH" ]]; then
  ok "the key-bearing scratch directory is removed on normal exit"
else
  bad "the key-bearing scratch directory remains after exit: ${SCRATCH:-path not reported}"
fi

# A 200 header with an incomplete body is still a transport failure. The stub
# simulates curl returning status text 200 and exit 28; the verifier must go red.
: > "$CMDLOG"; : > "$ENVLOG"; : > "$CFGLOG"
PARTIAL_OUT="$(env -i \
  PATH="$TMP/bin:$PATH" TMPDIR="$TMP/tooltmp" MODEL=cliproxy/gpt-5.6-sol \
  OMNIROUTE_BASE=http://omniroute.test CLIPROXY_BASE=http://cliproxy.test \
  MAX_TIME=2 OMNIROUTE_API_KEY="$CANARY" OMNIROUTE_KEY="preexported-alias" STUB_PARTIAL_HEALTH=1 \
  STUB_CMDLOG="$CMDLOG" STUB_ENVLOG="$ENVLOG" STUB_CFGLOG="$CFGLOG" \
  bash "$TOOL" 2>"$TMP/partial.stderr")"
PARTIAL_RC=$?
[[ "$PARTIAL_RC" -ne 0 ]] && ok "HTTP 200 plus curl exit 28 does not pass" \
                            || bad "incomplete HTTP 200 response falsely passed"
grep -q 'curl exited 28 after receiving HTTP 200' <<<"$PARTIAL_OUT" \
  && ok "the verifier reports the incomplete transfer, not its partial body" \
  || bad "the verifier did not preserve curl's transfer failure"
PARTIAL_SCRATCH="$(sed -n 's/^scratch: \(.*\) (fresh this run, removed on exit)$/\1/p' <<<"$PARTIAL_OUT" | head -1)"
[[ -n "$PARTIAL_SCRATCH" && ! -e "$PARTIAL_SCRATCH" ]] \
  && ok "scratch cleanup also runs on a failed verification" \
  || bad "failed verification left scratch behind: ${PARTIAL_SCRATCH:-path not reported}"

# G4 asks for an exact application-level response. An empty or wrong text block
# must not be counted as a working ordinary Messages completion.
: > "$CMDLOG"; : > "$ENVLOG"; : > "$CFGLOG"
BAD_TEXT_OUT="$(env -i \
  PATH="$TMP/bin:$PATH" TMPDIR="$TMP/tooltmp" MODEL=cliproxy/gpt-5.6-sol \
  OMNIROUTE_BASE=http://omniroute.test CLIPROXY_BASE=http://cliproxy.test \
  MAX_TIME=2 OMNIROUTE_API_KEY="$CANARY" OMNIROUTE_KEY="preexported-alias" STUB_TEXT="" \
  STUB_CMDLOG="$CMDLOG" STUB_ENVLOG="$ENVLOG" STUB_CFGLOG="$CFGLOG" \
  bash "$TOOL" 2>"$TMP/bad-text.stderr")"
BAD_TEXT_RC=$?
[[ "$BAD_TEXT_RC" -ne 0 ]] && ok "an empty G4 text response does not pass" \
                             || bad "empty G4 text falsely passed"
grep -q 'want exactly CHAINOK' <<<"$BAD_TEXT_OUT" \
  && ok "the verifier reports the wrong G4 content" \
  || bad "the verifier did not identify the wrong G4 content"

: > "$CMDLOG"; : > "$ENVLOG"; : > "$CFGLOG"
G4_TOOL_OUT="$(env -i \
  PATH="$TMP/bin:$PATH" TMPDIR="$TMP/tooltmp" MODEL=cliproxy/gpt-5.6-sol \
  OMNIROUTE_BASE=http://omniroute.test CLIPROXY_BASE=http://cliproxy.test \
  MAX_TIME=2 OMNIROUTE_API_KEY="$CANARY" OMNIROUTE_KEY="preexported-alias" STUB_G4_TOOL_USE=1 \
  STUB_CMDLOG="$CMDLOG" STUB_ENVLOG="$ENVLOG" STUB_CFGLOG="$CFGLOG" \
  bash "$TOOL" 2>"$TMP/g4-tool.stderr")"
G4_TOOL_RC=$?
[[ "$G4_TOOL_RC" -ne 0 ]] && ok "G4 text plus an unexpected tool_use does not pass" \
                            || bad "G4 tool invocation falsely passed as ordinary text"
grep -q 'unexpected tool_use' <<<"$G4_TOOL_OUT" \
  && ok "the verifier reports the unexpected G4 tool block" \
  || bad "the verifier did not identify the unexpected G4 tool block"

: > "$CMDLOG"; : > "$ENVLOG"; : > "$CFGLOG"
BAD_USAGE_OUT="$(env -i \
  PATH="$TMP/bin:$PATH" TMPDIR="$TMP/tooltmp" MODEL=cliproxy/gpt-5.6-sol \
  OMNIROUTE_BASE=http://omniroute.test CLIPROXY_BASE=http://cliproxy.test \
  MAX_TIME=2 OMNIROUTE_API_KEY="$CANARY" OMNIROUTE_KEY="preexported-alias" STUB_G4_BAD_USAGE=1 \
  STUB_CMDLOG="$CMDLOG" STUB_ENVLOG="$ENVLOG" STUB_CFGLOG="$CFGLOG" \
  bash "$TOOL" 2>"$TMP/g4-usage.stderr")"
BAD_USAGE_RC=$?
[[ "$BAD_USAGE_RC" -ne 0 ]] && ok "malformed G4 input_tokens does not pass" \
                              || bad "malformed usage.input_tokens falsely passed"
grep -q 'not a non-negative integer' <<<"$BAD_USAGE_OUT" \
  && ok "the verifier reports malformed G4 token usage" \
  || bad "the verifier did not identify malformed G4 token usage"

: > "$CMDLOG"; : > "$ENVLOG"; : > "$CFGLOG"
G4_OBJECT_OUT="$(env -i \
  PATH="$TMP/bin:$PATH" TMPDIR="$TMP/tooltmp" MODEL=cliproxy/gpt-5.6-sol \
  OMNIROUTE_BASE=http://omniroute.test CLIPROXY_BASE=http://cliproxy.test \
  MAX_TIME=2 OMNIROUTE_API_KEY="$CANARY" OMNIROUTE_KEY="preexported-alias" STUB_G4_CONTENT_OBJECT=1 \
  STUB_CMDLOG="$CMDLOG" STUB_ENVLOG="$ENVLOG" STUB_CFGLOG="$CFGLOG" \
  bash "$TOOL" 2>"$TMP/g4-object.stderr")"
G4_OBJECT_RC=$?
[[ "$G4_OBJECT_RC" -ne 0 ]] && ok "object-valued G4 content does not pass" \
                               || bad "non-array G4 content falsely passed"
grep -q "content type='object'" <<<"$G4_OBJECT_OUT" \
  && ok "the verifier reports the malformed G4 content type" \
  || bad "the verifier did not identify malformed G4 content type"

: > "$CMDLOG"; : > "$ENVLOG"; : > "$CFGLOG"
G4_STOP_OUT="$(env -i \
  PATH="$TMP/bin:$PATH" TMPDIR="$TMP/tooltmp" MODEL=cliproxy/gpt-5.6-sol \
  OMNIROUTE_BASE=http://omniroute.test CLIPROXY_BASE=http://cliproxy.test \
  MAX_TIME=2 OMNIROUTE_API_KEY="$CANARY" OMNIROUTE_KEY="preexported-alias" STUB_G4_BAD_STOP_SEQUENCE=1 \
  STUB_CMDLOG="$CMDLOG" STUB_ENVLOG="$ENVLOG" STUB_CFGLOG="$CFGLOG" \
  bash "$TOOL" 2>"$TMP/g4-stop.stderr")"
G4_STOP_RC=$?
[[ "$G4_STOP_RC" -ne 0 ]] && ok "numeric G4 stop_sequence does not pass" \
                             || bad "malformed G4 stop_sequence falsely passed"
grep -q 'stop_sequence is missing or not string/null' <<<"$G4_STOP_OUT" \
  && ok "the verifier reports malformed G4 stop_sequence" \
  || bad "the verifier did not identify malformed G4 stop_sequence"

# A tool_use block is not executable merely because it has an id and name. The
# declared schema requires a non-empty string city, and the verifier must test it.
: > "$CMDLOG"; : > "$ENVLOG"; : > "$CFGLOG"
BAD_TOOL_OUT="$(env -i \
  PATH="$TMP/bin:$PATH" TMPDIR="$TMP/tooltmp" MODEL=cliproxy/gpt-5.6-sol \
  OMNIROUTE_BASE=http://omniroute.test CLIPROXY_BASE=http://cliproxy.test \
  MAX_TIME=2 OMNIROUTE_API_KEY="$CANARY" OMNIROUTE_KEY="preexported-alias" STUB_BAD_TOOL_INPUT=1 \
  STUB_CMDLOG="$CMDLOG" STUB_ENVLOG="$ENVLOG" STUB_CFGLOG="$CFGLOG" \
  bash "$TOOL" 2>"$TMP/bad-tool.stderr")"
BAD_TOOL_RC=$?
[[ "$BAD_TOOL_RC" -ne 0 ]] && ok "a tool_use with missing required input does not pass" \
                             || bad "schema-invalid tool input falsely passed"
grep -q 'tool_use block malformed' <<<"$BAD_TOOL_OUT" \
  && ok "the verifier reports the malformed tool input" \
  || bad "the verifier did not identify the malformed tool input"

: > "$CMDLOG"; : > "$ENVLOG"; : > "$CFGLOG"
NUMERIC_ID_OUT="$(env -i \
  PATH="$TMP/bin:$PATH" TMPDIR="$TMP/tooltmp" MODEL=cliproxy/gpt-5.6-sol \
  OMNIROUTE_BASE=http://omniroute.test CLIPROXY_BASE=http://cliproxy.test \
  MAX_TIME=2 OMNIROUTE_API_KEY="$CANARY" OMNIROUTE_KEY="preexported-alias" STUB_NUMERIC_TOOL_ID=1 \
  STUB_CMDLOG="$CMDLOG" STUB_ENVLOG="$ENVLOG" STUB_CFGLOG="$CFGLOG" \
  bash "$TOOL" 2>"$TMP/numeric-id.stderr")"
NUMERIC_ID_RC=$?
[[ "$NUMERIC_ID_RC" -ne 0 ]] && ok "a numeric tool_use id does not pass" \
                              || bad "non-string tool_use id falsely passed"
grep -q 'tool_use block malformed' <<<"$NUMERIC_ID_OUT" \
  && ok "the verifier reports the malformed tool id" \
  || bad "the verifier did not identify the malformed tool id"

: > "$CMDLOG"; : > "$ENVLOG"; : > "$CFGLOG"
EXTRA_TOOL_OUT="$(env -i \
  PATH="$TMP/bin:$PATH" TMPDIR="$TMP/tooltmp" MODEL=cliproxy/gpt-5.6-sol \
  OMNIROUTE_BASE=http://omniroute.test CLIPROXY_BASE=http://cliproxy.test \
  MAX_TIME=2 OMNIROUTE_API_KEY="$CANARY" OMNIROUTE_KEY="preexported-alias" STUB_EXTRA_TOOL_USE=1 \
  STUB_CMDLOG="$CMDLOG" STUB_ENVLOG="$ENVLOG" STUB_CFGLOG="$CFGLOG" \
  bash "$TOOL" 2>"$TMP/extra-tool.stderr")"
EXTRA_TOOL_RC=$?
[[ "$EXTRA_TOOL_RC" -ne 0 ]] && ok "an additional malformed tool_use does not pass" \
                               || bad "extra malformed tool_use was ignored"
grep -q 'tool_use blocks=2' <<<"$EXTRA_TOOL_OUT" \
  && ok "the verifier reports extra tool blocks" \
  || bad "the verifier did not identify extra tool blocks"

: > "$CMDLOG"; : > "$ENVLOG"; : > "$CFGLOG"
WRONG_TOOL_OUT="$(env -i \
  PATH="$TMP/bin:$PATH" TMPDIR="$TMP/tooltmp" MODEL=cliproxy/gpt-5.6-sol \
  OMNIROUTE_BASE=http://omniroute.test CLIPROXY_BASE=http://cliproxy.test \
  MAX_TIME=2 OMNIROUTE_API_KEY="$CANARY" OMNIROUTE_KEY="preexported-alias" STUB_WRONG_TOOL_MODEL=1 \
  STUB_CMDLOG="$CMDLOG" STUB_ENVLOG="$ENVLOG" STUB_CFGLOG="$CFGLOG" \
  bash "$TOOL" 2>"$TMP/wrong-tool.stderr")"
WRONG_TOOL_RC=$?
[[ "$WRONG_TOOL_RC" -ne 0 ]] && ok "a tool call from the wrong model does not pass" \
                               || bad "wrong-model tool response falsely passed"
grep -q "model='wrong-model'" <<<"$WRONG_TOOL_OUT" \
  && ok "the verifier reports the G5 route mismatch" \
  || bad "the verifier did not identify the G5 route mismatch"

: > "$CMDLOG"; : > "$ENVLOG"; : > "$CFGLOG"
G5_OBJECT_OUT="$(env -i \
  PATH="$TMP/bin:$PATH" TMPDIR="$TMP/tooltmp" MODEL=cliproxy/gpt-5.6-sol \
  OMNIROUTE_BASE=http://omniroute.test CLIPROXY_BASE=http://cliproxy.test \
  MAX_TIME=2 OMNIROUTE_API_KEY="$CANARY" OMNIROUTE_KEY="preexported-alias" STUB_G5_CONTENT_OBJECT=1 \
  STUB_CMDLOG="$CMDLOG" STUB_ENVLOG="$ENVLOG" STUB_CFGLOG="$CFGLOG" \
  bash "$TOOL" 2>"$TMP/g5-object.stderr")"
G5_OBJECT_RC=$?
[[ "$G5_OBJECT_RC" -ne 0 ]] && ok "object-valued G5 content does not pass" \
                               || bad "non-array G5 content falsely passed"
grep -q "content='object'" <<<"$G5_OBJECT_OUT" \
  && ok "the verifier reports the malformed G5 content type" \
  || bad "the verifier did not identify malformed G5 content type"

: > "$CMDLOG"; : > "$ENVLOG"; : > "$CFGLOG"
G5_STOP_OUT="$(env -i \
  PATH="$TMP/bin:$PATH" TMPDIR="$TMP/tooltmp" MODEL=cliproxy/gpt-5.6-sol \
  OMNIROUTE_BASE=http://omniroute.test CLIPROXY_BASE=http://cliproxy.test \
  MAX_TIME=2 OMNIROUTE_API_KEY="$CANARY" OMNIROUTE_KEY="preexported-alias" STUB_G5_BAD_STOP_SEQUENCE=1 \
  STUB_CMDLOG="$CMDLOG" STUB_ENVLOG="$ENVLOG" STUB_CFGLOG="$CFGLOG" \
  bash "$TOOL" 2>"$TMP/g5-stop.stderr")"
G5_STOP_RC=$?
[[ "$G5_STOP_RC" -ne 0 ]] && ok "numeric G5 stop_sequence does not pass" \
                             || bad "malformed G5 stop_sequence falsely passed"
grep -q "stop_sequence_ok='no'" <<<"$G5_STOP_OUT" \
  && ok "the verifier reports malformed G5 stop_sequence" \
  || bad "the verifier did not identify malformed G5 stop_sequence"

printf '\n\033[1mtest_tog485_verify_chain_argv\033[0m  passed %d, failed %d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
