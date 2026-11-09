#!/usr/bin/env bash
# BASH_ENV observer for explicitly clean synthetic children only. No command is
# wrapped/replaced. DEBUG sees the next shell boundary, NOT necessarily the
# preceding mkdir's status (an if without else can replace failure with zero).
# Actual command results/argv require the filtered syscall trace.
if [[ "$0" == "${REQUEST_RECORD_DIAGNOSTIC_SCRIPT:-}" && -z "${provenance_ready:-}" ]]; then
  provenance_ready=1
  provenance_pending_pid=""
  provenance_pending_command=""
  provenance_observe() {
    local previous="$1" command_text="$2" name resolved=""
    if [[ "$provenance_pending_pid" == "$BASHPID" ]]; then
      printf 'next-boundary time=%s shell_pid=%s bash_pid=%s next_boundary_status=%s command=%q\n' \
        "$EPOCHREALTIME" "$$" "$BASHPID" "$previous" "$provenance_pending_command" >&8
      "$REQUEST_RECORD_OBSERVER_PYTHON" -I "$REQUEST_RECORD_OBSERVER_METADATA" \
        "$BASHPID" after-boundary "$provenance_pending_command" "$previous" '' \
        "${QUEUE_LOCK:-}" "${REQRECORD_STATUS_LOCK:-}" >&8 2>&8
      provenance_pending_pid=""
    fi
    case "$command_text" in
      mkdir\ *|rm\ *|rmdir\ *) name="${command_text%% *}" ;;
      *) return 0 ;;
    esac
    printf 'begin time=%s shell_pid=%s bash_pid=%s command=%q PATH=%q\n' \
      "$EPOCHREALTIME" "$$" "$BASHPID" "$command_text" "$PATH" >&8
    { type -a "$name"; command -V "$name"; declare -f "$name"; \
      hash -t "$name"; alias "$name"; } >&8 2>&8
    resolved="$(command -v "$name")"
    "$REQUEST_RECORD_OBSERVER_PYTHON" -I "$REQUEST_RECORD_OBSERVER_METADATA" \
      "$BASHPID" before "$command_text" "$previous" "$resolved" \
      "${QUEUE_LOCK:-}" "${REQRECORD_STATUS_LOCK:-}" >&8 2>&8
    provenance_pending_pid="$BASHPID"
    provenance_pending_command="$command_text"
    return 0
  }
  printf 'start time=%s shell_pid=%s bash_pid=%s argv=' "$EPOCHREALTIME" "$$" "$BASHPID" >&8
  printf '%q ' "$0" "$@" >&8
  printf '\n' >&8
  "$REQUEST_RECORD_OBSERVER_PYTHON" -I "$REQUEST_RECORD_OBSERVER_METADATA" \
    "$BASHPID" start '' 0 '' "${QUEUE_LOCK:-}" "${REQRECORD_STATUS_LOCK:-}" >&8 2>&8
  set -T
  trap 'provenance_observe "$?" "$BASH_COMMAND"' DEBUG
fi

# These controls run AFTER the real submissions, on separate disposable paths.
# A verified native binary is a comparison, never a replacement product command.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -uo pipefail
  control_root="$1"
  QUEUE="$control_root/control.jsonl"
  resolved_path="$control_root/resolved.lock"
  QUEUE_LOCK="$resolved_path"
  REQRECORD_STATUS_LOCK="$control_root/contended.lock"
  mkdir "$resolved_path"; first=$?
  mkdir "$resolved_path"; second=$?
  printf 'resolved_first_rc=%s\nresolved_second_rc=%s\n' "$first" "$second"
  control_rc=0
  [[ "$first" -eq 0 && "$second" -ne 0 && -d "$resolved_path" ]] || control_rc=1
  if [[ -x /usr/bin/mkdir ]]; then
    "$REQUEST_RECORD_OBSERVER_PYTHON" -I "$REQUEST_RECORD_OBSERVER_METADATA" \
      "$BASHPID" native-control '' 0 /usr/bin/mkdir "$QUEUE_LOCK" "$REQRECORD_STATUS_LOCK" >&8 2>&8
    /usr/bin/mkdir "$control_root/native.lock"; native_first=$?
    /usr/bin/mkdir "$control_root/native.lock"; native_second=$?
    printf 'native_first_rc=%s\nnative_second_rc=%s\n' "$native_first" "$native_second"
    [[ "$native_first" -eq 0 && "$native_second" -ne 0 ]] || control_rc=1
  else
    printf 'native_control=unavailable\n'
    control_rc=1
  fi
  # Neither contender removes the lock. Wait for both before inspecting it, so
  # the winner necessarily holds it until the loser's one-shot attempt ends.
  mkdir "$control_root/contended.lock" >"$control_root/one.out" 2>&1 & one=$!
  mkdir "$control_root/contended.lock" >"$control_root/two.out" 2>&1 & two=$!
  wait "$one"; one_rc=$?
  wait "$two"; two_rc=$?
  printf 'contention_one_rc=%s\ncontention_two_rc=%s\n' "$one_rc" "$two_rc"
  if [[ -d "$control_root/contended.lock" ]] && \
      { [[ "$one_rc" -eq 0 && "$two_rc" -ne 0 ]] || [[ "$one_rc" -ne 0 && "$two_rc" -eq 0 ]]; }; then
    :
  else
    control_rc=1
  fi
  exit "$control_rc"
fi
