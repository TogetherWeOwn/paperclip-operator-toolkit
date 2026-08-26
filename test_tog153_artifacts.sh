#!/usr/bin/env bash
# Offline regression suite for the TOG-153 operator artifacts (TOG-519).
#
# No OmniRoute or teamclaude request leaves this process. curl is replaced with
# a fixture server, the registration script runs in dry-run mode only, and the
# verifier has no OMNIROUTE_API_KEY so section C cannot send inference.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTER="${TOG153_REGISTER_SH:-$HERE/omniroute/TOG-153-register-teamclaude.sh}"
VERIFY="${TOG153_VERIFY_SH:-$HERE/omniroute/TOG-153-verify.sh}"
PASS=0; FAIL=0

ok()  { printf '  PASS  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  FAIL  %s\n' "$1"; [[ -n "${2:-}" ]] && printf '        %s\n' "$2"; FAIL=$((FAIL+1)); }

for dep in jq bash; do
  command -v "$dep" >/dev/null 2>&1 || { echo "test_tog153_artifacts: $dep required" >&2; exit 2; }
done
[[ -r "$REGISTER" && -r "$VERIFY" ]] \
  || { echo "test_tog153_artifacts: TOG-153 scripts not readable" >&2; exit 2; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
printf 'TEAMCLAUDE_API_KEY=fake-teamclaude-key\n' > "$TMP/teamclaude.env"
chmod 600 "$TMP/teamclaude.env"

cat > "$TMP/bin/curl" <<'STUB'
#!/usr/bin/env bash
url=""; want_write=0; want_time=0; output_body=1; bearer=0
prev=""
for arg in "$@"; do
  case "$prev" in
    -o|--output) [[ "$arg" == "/dev/null" ]] && output_body=0 ;;
  esac
  case "$arg" in
    http://*|https://*) url="$arg" ;;
    *%\{http_code\}*) want_write=1 ;;
    *%\{time_total\}*) want_time=1 ;;
    *"authorization: Bearer"*) bearer=1 ;;
  esac
  prev="$arg"
done

case "$url" in
  */v1/models)
    body='{"data":[{"id":"claude-opus-5"},{"id":"claude-sonnet-5"},{"id":"claude-haiku-4-5-20251001"},{"id":"claude-fable-5"}]}'
    ;;
  */api/provider-nodes)
    body='[{"id":"node-1","prefix":"teamclaude","type":"anthropic-compatible","baseUrl":"http://host.containers.internal:3456/v1"}]'
    ;;
  */api/providers)
    body='[{"id":"conn-1","provider":"anthropic-compatible-teamclaude"}]'
    ;;
  */api/combos)
    body='[{"id":"c1","name":"claude-opus"},{"id":"c2","name":"claude-sonnet"},{"id":"c3","name":"claude-haiku"},{"id":"c4","name":"claude-fable"},{"id":"c5","name":"claude-catchall"}]'
    ;;
  */api/model-combo-mappings)
    body="{\"items\":[{\"pattern\":\"claude-opus*\",\"comboName\":\"claude-opus\"},{\"pattern\":\"claude-*\",\"comboName\":\"${MAPPING_TARGET:-claude-catchall}\"}],\"total\":2}"
    ;;
  *)
    printf 'fixture has no response for %s\n' "$url" >&2
    exit 2
    ;;
esac

if [[ $output_body -eq 1 ]]; then
  printf '%s\n' "$body"
fi
if [[ $want_write -eq 1 ]]; then
  case "$url" in
    */v1/models)
      if [[ $bearer -eq 1 ]]; then code=401; else code=200; fi
      if [[ $want_time -eq 1 ]]; then printf '%s 0.01\n' "$code"; else printf '%s\n' "$code"; fi
      ;;
    *) printf '200\n' ;;
  esac
fi
STUB
chmod +x "$TMP/bin/curl"

run_register() {
  env -i PATH="$TMP/bin:$PATH" HOME="$TMP" TC_ENV="$TMP/teamclaude.env" \
    OMNIROUTE_MGMT_TOKEN=fake-management-token TC_CATCHALL=1 \
    TEAMCLAUDE_BASE_URL=http://fixture.invalid \
    bash "$REGISTER" "$@" 2>&1
}

printf '\n== registration artifact\n'
out="$(run_register --aply)"; rc=$?
if [[ $rc -eq 2 ]]; then ok "unknown argv refuses with exit 2"; else bad "unknown argv refuses with exit 2" "exit $rc: $out"; fi

out="$(run_register)"; rc=$?
if [[ $rc -eq 0 ]]; then ok "stubbed dry run exits 0"; else bad "stubbed dry run exits 0" "exit $rc: $out"; fi
if grep -Fq 'combo claude-catchall -> claude-sonnet-5' <<<"$out"; then
  ok "TC_CATCHALL builds a dedicated claude-catchall combo"
else
  bad "TC_CATCHALL builds a dedicated claude-catchall combo" "$out"
fi
if grep -Eq 'mapping claude-\* -> claude-catchall (\(priority 1\)|: already present, skipping)' <<<"$out"; then
  ok "the catch-all mapping targets the dedicated combo"
else
  bad "the catch-all mapping targets the dedicated combo" "$out"
fi
if grep -Fq 'mapping claude-opus* -> claude-opus : already present, skipping' <<<"$out"; then
  ok "the registration read accepts the .items mapping envelope"
else
  bad "the registration read accepts the .items mapping envelope" "$out"
fi

run_verify() {
  env -i PATH="$TMP/bin:$PATH" HOME="$TMP" TC_ENV="$TMP/teamclaude.env" \
    OMNIROUTE_MGMT_TOKEN=fake-management-token MAPPING_TARGET="$1" \
    bash "$VERIFY" 2>&1
}

printf '\n== verifier B4\n'
out="$(run_verify claude-catchall)"; rc=$?
if [[ $rc -eq 0 ]] && grep -Fq "catch-all maps to its own combo 'claude-catchall'" <<<"$out"; then
  ok "B4 accepts .items when claude-* targets claude-catchall"
else
  bad "B4 accepts .items when claude-* targets claude-catchall" "exit $rc: $out"
fi

out="$(run_verify claude-sonnet)"; rc=$?
if [[ $rc -eq 1 ]] && grep -Fq "not 'claude-catchall'" <<<"$out"; then
  ok "B4 fails when claude-* points at claude-sonnet"
else
  bad "B4 fails when claude-* points at claude-sonnet" "exit $rc: $out"
fi

printf '\nTOG-153 artifacts: %d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 )) || exit 1
