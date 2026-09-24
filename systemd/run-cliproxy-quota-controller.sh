#!/usr/bin/env bash
set -Eeuo pipefail

[[ -n "${CREDENTIALS_DIRECTORY:-}" ]] || {
  printf 'REFUSED: systemd credential directory is unavailable\n' >&2
  exit 2
}
CREDENTIAL_PATH="${CREDENTIALS_DIRECTORY}/cliproxy-management-key"
[[ -r "$CREDENTIAL_PATH" ]] || {
  printf 'REFUSED: systemd management credential is unavailable\n' >&2
  exit 2
}
exec 3<"$CREDENTIAL_PATH"
export CLIPROXY_MANAGEMENT_KEY_FD=3
ARGS=(
  "${CLIPROXY_QUOTA_MODE}"
  --management-url "${CLIPROXY_MANAGEMENT_URL}"
  --decision-log "${CLIPROXY_QUOTA_DECISION_LOG}"
  --rollback-state "${CLIPROXY_QUOTA_ROLLBACK_STATE}"
)
if [[ "${CLIPROXY_QUOTA_MODE}" != rollback ]]; then
  ARGS+=(--telemetry "${CLIPROXY_QUOTA_TELEMETRY}")
fi
exec /usr/bin/python3 \
  "/usr/local/libexec/paperclip-cliproxy-quota-controller/${CLIPROXY_QUOTA_SOURCE_REF}/cliproxy_quota_controller.py" \
  "${ARGS[@]}"
