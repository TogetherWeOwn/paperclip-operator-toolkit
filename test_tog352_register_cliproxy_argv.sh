#!/usr/bin/env bash
# Regression suite for TOG-352-register-cliproxy.sh credential transport.
# Offline: curl and jq are wrapped, while the real jq handles response parsing.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${TOG352_REGISTER_SH:-$HERE/omniroute/TOG-352-register-cliproxy.sh}"
PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }

[[ -r /proc/$$/cmdline ]] || { echo "test_tog352_register_cliproxy_argv: needs Linux /proc" >&2; exit 2; }
[[ -x "$TOOL" ]] || { echo "test_tog352_register_cliproxy_argv: $TOOL is not executable" >&2; exit 2; }
command -v jq >/dev/null || { echo "test_tog352_register_cliproxy_argv: jq is required" >&2; exit 2; }
REAL_JQ="$(command -v jq)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
CMDLOG="$TMP/cmdline.log"
ENVLOG="$TMP/environ.log"
CFGLOG="$TMP/config.log"
BODYLOG="$TMP/body.log"
MGMT_CANARY="omni-mgmt-canary-4c2f"
CP_CANARY="cliproxy-canary-76ad"
CP_ENV="$TMP/cliproxy.env"
printf 'export CLIPROXY_API_KEY=%q\n' "$CP_CANARY" > "$CP_ENV"
chmod 0600 "$CP_ENV"

cat > "$TMP/bin/curl" <<'STUB'
#!/usr/bin/env bash
{ tr '\0' '\n' < "/proc/$$/cmdline"; printf -- '--END-ARGV--\n'; } >> "$STUB_CMDLOG"
{ tr '\0' '\n' < "/proc/$$/environ"; printf -- '--END-ENV--\n'; } >> "$STUB_ENVLOG"
printf 'FIRST\t%s\n' "${1:-}" >> "$STUB_CFGLOG"

cfg=""; url=""; data_arg=""; prev=""
for a in "$@"; do
  case "$prev" in
    --config|-K) cfg="$a" ;;
    --data-binary) data_arg="$a" ;;
  esac
  case "$a" in http://*|https://*) url="$a" ;; esac
  prev="$a"
done

key=""
if [[ -n "$cfg" ]]; then
  printf 'CONFIG\t%s\n' "$cfg" >> "$STUB_CFGLOG"
  cfg_text="$(cat "$cfg")"
  key="$(sed -n 's/^header = "Authorization: Bearer \(.*\)"$/\1/p' <<<"$cfg_text")"
  printf 'KEY\t%s\n' "$key" >> "$STUB_CFGLOG"
fi
[[ "$data_arg" == @- ]] && body="$(cat)" || body=""
printf 'DATA\t%s\n' "$data_arg" >> "$STUB_CFGLOG"
printf 'BODY\t%s\n' "$body" >> "$STUB_BODYLOG"

case "$url" in
  http://cliproxy.test/v1/models)
    printf '{"data":[{"id":"claude-opus-5"},{"id":"claude-sonnet-5"},{"id":"claude-fable-5"},{"id":"gemini-3-flash"},{"id":"gpt-5.4"}]}'
    ;;
  http://omniroute.test/api/provider-nodes)
    if [[ "$data_arg" == @- ]]; then
      printf '{"id":"node-created"}'
    else
      printf '{"nodes":[]}'
    fi
    printf '\n200'
    ;;
  http://omniroute.test/api/providers)
    if [[ "$data_arg" == @- ]]; then
      printf '{"id":"conn-created"}'
    else
      printf '{"connections":[]}'
    fi
    printf '\n200'
    ;;
  http://omniroute.test/api/providers/conn-created/sync-models)
    printf '{"syncedModels":5}'
    printf '\n200'
    ;;
  http://omniroute.test/api/combos)
    if [[ "$data_arg" == @- ]]; then
      printf '{"id":"combo-created"}'
    else
      printf '{"combos":[]}'
    fi
    printf '\n200'
    ;;
  *)
    printf '{"error":"unexpected URL","url":"%s"}' "$url"
    printf '\n500'
    ;;
esac
STUB
chmod +x "$TMP/bin/curl"

cat > "$TMP/bin/jq" <<'STUBJQ'
#!/usr/bin/env bash
{ tr '\0' '\n' < "/proc/$$/environ"; printf -- '--END-JQ-ENV--\n'; } >> "$STUB_ENVLOG"
exec "$REAL_JQ" "$@"
STUBJQ
chmod +x "$TMP/bin/jq"

: > "$CMDLOG"; : > "$ENVLOG"; : > "$CFGLOG"; : > "$BODYLOG"
OUT="$(env -i \
  PATH="$TMP/bin:$PATH" \
  HOME="$TMP/home" \
  CP_ENV="$CP_ENV" \
  OMNIROUTE_BASE=http://omniroute.test \
  CP_BASE_FOR_OPERATOR=http://cliproxy.test/v1 \
  CP_BASE_FOR_OMNIROUTE=http://cliproxy.service/v1 \
  OMNIROUTE_MGMT_TOKEN="$MGMT_CANARY" \
  MGMT_KEY=preexported-management \
  CP_KEY=preexported-cliproxy \
  CLIPROXY_API_KEY=preexported-source \
  REAL_JQ="$REAL_JQ" \
  STUB_CMDLOG="$CMDLOG" STUB_ENVLOG="$ENVLOG" STUB_CFGLOG="$CFGLOG" STUB_BODYLOG="$BODYLOG" \
  bash "$TOOL" --apply 2>"$TMP/stderr")"
RC=$?

[[ "$RC" -eq 0 ]] && ok "registration dry-run completes against the stubs" \
                  || bad "registration dry-run exited $RC: $(head -c 200 "$TMP/stderr")"
grep -q 'created connection: conn-created' <<<"$OUT" \
  && ok "suite exercises the credential-bearing apply path" \
  || bad "registration script did not reach connection creation"

if grep -qF "$MGMT_CANARY" "$CMDLOG" || grep -qF "$CP_CANARY" "$CMDLOG"; then
  bad "a management or CLIProxy credential appeared in curl argv"
else
  ok "management and CLIProxy credentials never appear in curl argv"
fi
if grep -qF "$MGMT_CANARY" "$ENVLOG" || grep -qF "$CP_CANARY" "$ENVLOG" \
   || grep -qF 'preexported-management' "$ENVLOG" || grep -qF 'preexported-cliproxy' "$ENVLOG" \
   || grep -qF 'preexported-source' "$ENVLOG"; then
  bad "a credential appeared in a child environment"
else
  ok "management and CLIProxy credentials never appear in child environments"
fi

CALLS="$(grep -c '^--END-ARGV--$' "$CMDLOG")"
[[ "$CALLS" -eq 12 ]] && ok "all twelve expected curl calls ran" \
                        || bad "expected twelve curl calls, got $CALLS"
FIRST_Q="$(grep -cx $'FIRST\t-q' "$CFGLOG")"
[[ "$FIRST_Q" -eq 12 ]] && ok "every curl call disables inherited curlrc first" \
                            || bad "expected twelve first-argument -q records, got $FIRST_Q"
MGMT_KEYS="$(grep -cx $'KEY\t'"$MGMT_CANARY" "$CFGLOG")"
CP_KEYS="$(grep -cx $'KEY\t'"$CP_CANARY" "$CFGLOG")"
[[ "$MGMT_KEYS" -eq 11 && "$CP_KEYS" -eq 1 ]] \
  && ok "all private calls receive the intended credential through config" \
  || bad "expected management=11 CLIProxy=1 config keys, got management=$MGMT_KEYS CLIProxy=$CP_KEYS"
DATA_CALLS="$(grep -cx $'DATA\t@-' "$CFGLOG")"
[[ "$DATA_CALLS" -eq 8 ]] && ok "all eight management request bodies use stdin transport" \
                               || bad "expected eight stdin bodies, got $DATA_CALLS"
if grep -qF "$CP_CANARY" "$CMDLOG"; then
  bad "the connection bearer appeared in curl argv"
elif grep -qF "$CP_CANARY" "$BODYLOG"; then
  ok "the connection bearer reaches only the request body"
else
  bad "the connection bearer never reached the connection payload"
fi

printf '\n\033[1mtest_tog352_register_cliproxy_argv\033[0m  passed %d, failed %d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
