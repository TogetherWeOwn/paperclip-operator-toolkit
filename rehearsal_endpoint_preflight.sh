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

exec "$HERE/agent_endpoint_preflight.sh" \
  --model "$MODEL" \
  --control-model '' \
  --timeout "$TIMEOUT" \
  "$BASE"
