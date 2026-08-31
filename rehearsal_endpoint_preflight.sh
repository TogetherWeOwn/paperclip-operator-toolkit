#!/usr/bin/env bash
set -uo pipefail

# One-shot TOG-554 cache rehearsal gate. This wrapper exists so the operator and
# Director of Engineering do not have to improvise the endpoint, retry policy,
# or model. The underlying gate already keeps credentials in a 0600 header file
# and never retries an authorization failure.

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
BASE=${OMNIROUTE_REHEARSAL_BASE_URL:-http://omniroute-rehearse:20128}
MODEL=${OMNIROUTE_REHEARSAL_MODEL:-claude-sonnet-5}
TIMEOUT=${OMNIROUTE_REHEARSAL_PREFLIGHT_TIMEOUT:-45}
AUTHORIZATION_FILE=${OMNIROUTE_REHEARSAL_AUTHORIZATION_FILE:-}
GETENT_BIN=${OMNIROUTE_REHEARSAL_GETENT_BIN:-getent}
PREFLIGHT_TOOL=${OMNIROUTE_REHEARSAL_PREFLIGHT_TOOL:-$HERE/agent_endpoint_preflight.sh}

[[ $BASE == http://omniroute-rehearse:20128 ]] || {
  printf 'rehearsal_endpoint_preflight: endpoint is fixed at http://omniroute-rehearse:20128\n' >&2
  exit 7
}
[[ $MODEL == claude-sonnet-5 ]] || {
  printf 'rehearsal_endpoint_preflight: model is fixed at claude-sonnet-5\n' >&2
  exit 7
}
[[ $TIMEOUT =~ ^[1-9][0-9]*$ ]] || {
  printf 'rehearsal_endpoint_preflight: timeout must be a positive integer\n' >&2
  exit 7
}
[[ -n $AUTHORIZATION_FILE && -f $AUTHORIZATION_FILE && ! -L $AUTHORIZATION_FILE ]] || {
  printf 'rehearsal_endpoint_preflight: OMNIROUTE_REHEARSAL_AUTHORIZATION_FILE must name the sanitized host evidence row\n' >&2
  exit 7
}
[[ $(stat -c '%u' "$AUTHORIZATION_FILE") == "$(id -u)" ]] || {
  printf 'rehearsal_endpoint_preflight: authorization evidence must be owned by the current user\n' >&2
  exit 7
}
authorization_mode=$(stat -c '%a' "$AUTHORIZATION_FILE")
(( (8#$authorization_mode & 077) == 0 )) || {
  printf 'rehearsal_endpoint_preflight: authorization evidence must be private\n' >&2
  exit 7
}
expected_dns_sha=$(jq -er '
  select(
    .mode == "apply"
    and .result == "success"
    and .alias == "omniroute-rehearse"
    and (.containerId | test("^[0-9a-f]{12,64}$"))
  )
  | .dnsAddressSha256
  | select(test("^[0-9a-f]{64}$"))
' "$AUTHORIZATION_FILE" 2>/dev/null) || {
  printf 'rehearsal_endpoint_preflight: authorization evidence is missing a successful immutable address proof\n' >&2
  exit 7
}
resolved_addresses=$("$GETENT_BIN" hosts omniroute-rehearse | python3 -c '
import ipaddress, sys
addresses = set()
for line in sys.stdin:
    fields = line.split()
    if not fields:
        continue
    try:
        addresses.add(ipaddress.ip_address(fields[0]))
    except ValueError:
        continue
for address in sorted(addresses, key=lambda value: (value.version, int(value))):
    print(address.compressed)
') || {
  printf 'rehearsal_endpoint_preflight: could not resolve the authorized rehearsal alias\n' >&2
  exit 7
}
[[ -n $resolved_addresses ]] || {
  printf 'rehearsal_endpoint_preflight: authorized rehearsal alias resolved to no addresses\n' >&2
  exit 7
}
actual_dns_sha=$(printf '%s\n' "$resolved_addresses" | sha256sum | cut -d' ' -f1)
[[ $actual_dns_sha == "$expected_dns_sha" ]] || {
  printf 'rehearsal_endpoint_preflight: alias address set changed after host authorization; refusing before credential use\n' >&2
  exit 7
}

exec "$PREFLIGHT_TOOL" \
  --model "$MODEL" \
  --control-model '' \
  --timeout "$TIMEOUT" \
  "$BASE"
