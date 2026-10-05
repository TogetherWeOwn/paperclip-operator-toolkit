#!/usr/bin/env bash
# ===========================================================================
# runner_disk_triage.sh — read-only runner-disk triage.
#
# Read-only enumeration step called by the disk-pressure runbook
# (alert + authoritative runbook live with the operator; this tool performs
# no alerting and no cleanup). Suspect list comes from the on-call note:
# parked legacy worktree dependency caches
# (node_modules / vendor), the container writable layer, and the LXD pool.
#
# SAFETY MODEL — read-only by construction:
#   * The only host commands this script ever invokes are: df, du, find
#     (listing only), cat (fixture/info files only), sort, cut, sed (stream
#     filter, no in-place edit), and the read-only `lxc storage list` /
#     `zfs list` probes when those binaries exist. It creates no temp files
#     and modifies nothing.
#   * Any write-intent argument (--apply, --clean, --delete, --prune, --fix
#     and kin, see refuse_arg()) exits 2 without enumerating anything.
#     Cleanup execution stays operator-owned.
#   * Output carries sizes, counts and paths only. It never prints
#     environment values, file contents (beyond an operator-supplied info
#     fixture), or credentials.
#
# OVERRIDES (for the offline suite; all optional):
#   TRIAGE_WORKTREE_ROOT  dir whose children are scanned for node_modules /
#                         vendor caches (default: auto-detected worktrees dir)
#   TRIAGE_DOCKER_ROOT    container storage root to size (default:
#                         /var/lib/docker when readable)
#   TRIAGE_PODMAN_ROOT    second container storage root to size (default:
#                         ~/.local/share/containers/storage when readable)
#   TRIAGE_DF_FILE        fixture file whose content replaces `df -h`
#   TRIAGE_DFI_FILE       fixture file whose content replaces `df -i`
#   TRIAGE_LXD_INFO_FILE  fixture file whose content replaces live
#                         `lxc storage` / `zfs` probing
#
# Exit codes: 0 enumerated (missing suspects report as missing, not failure);
#             2 usage or write-intent refusal.
# ===========================================================================

set -uo pipefail

FORMAT="text"

usage() {
  cat <<'EOF'
Usage: runner_disk_triage.sh [--format text|json] [--json] [-h|--help]

Read-only runner-disk triage for the operator disk-pressure runbook.
Prints df + inode usage and per-suspect sizing. Never deletes anything:
any write-intent flag is refused with exit 2.
EOF
}

# ---- write-intent refusal (checked before anything else touches the host) --
refuse_arg() {
  case "$1" in
    --apply|--clean*|--delete*|--del*|--prune*|--fix|--rm*|--remove*|\
    --kill*|--reclaim*|--purge*|--wipe*|--exec*|--command*|--run*|\
    clean|delete|prune|fix|apply|purge|wipe|reclaim)
      printf 'REFUSE: %s would mutate the runner; this tool is read-only (cleanup is operator-owned)\n' "$1" >&2
      return 0
      ;;
    *) return 1 ;;
  esac
}

for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --json) FORMAT="json" ;;
    --format) : ;; # value consumed by the loop below
    --format=*) FORMAT="${arg#--format=}";;
    *) : ;;
  esac
done
# Two-arg --format <value> (kept separate so unknown flags still enumerate).
_prev=""
for arg in "$@"; do
  if [[ "$_prev" == "--format" ]]; then FORMAT="$arg"; fi
  _prev="$arg"
done
case "$FORMAT" in
  text|json) : ;;
  *) printf 'usage: unknown --format %s (want text|json)\n' "$FORMAT" >&2; exit 2 ;;
esac
# MUTATION-ANCHOR-START: refusal gate (the offline suite deletes this block to
# prove the gate is load-bearing: the mutant must accept --apply).
for arg in "$@"; do
  case "$arg" in
    -h|--help|--json|--format|--format=*) : ;;
    --*) refuse_arg "$arg" && exit 2 ;;
  esac
  # Bare-word write intents (no dashes) are also refused.
  case "$arg" in
    clean|delete|prune|fix|apply|purge|wipe|reclaim) refuse_arg "$arg" && exit 2 ;;
  esac
done
# MUTATION-ANCHOR-END

# ---- roots -----------------------------------------------------------------
if [[ -n "${TRIAGE_WORKTREE_ROOT:-}" ]]; then
  WORKTREE_ROOT="$TRIAGE_WORKTREE_ROOT"
else
  WORKTREE_ROOT="${HOME:-/root}/worktrees"
fi
DOCKER_ROOT="${TRIAGE_DOCKER_ROOT:-/var/lib/docker}"
PODMAN_ROOT="${TRIAGE_PODMAN_ROOT:-${HOME:-/root}/.local/share/containers/storage}"

# ---- df / inode overview ----------------------------------------------------
if [[ -n "${TRIAGE_DF_FILE:-}" ]]; then
  DF_OUT="$(cat -- "${TRIAGE_DF_FILE}")"
else
  DF_OUT="$(df -h 2>/dev/null || printf 'df unavailable\n')"
fi
if [[ -n "${TRIAGE_DFI_FILE:-}" ]]; then
  DFI_OUT="$(cat -- "${TRIAGE_DFI_FILE}")"
else
  DFI_OUT="$(df -i 2>/dev/null || printf 'df -i unavailable\n')"
fi

# ---- per-suspect sizing (KB, deterministic) --------------------------------
# Prints lines: <kb>\t<path>. Never follows into unreadable trees loudly.
kb_of() {
  if [[ -d "$1" ]]; then
    du -sk -- "$1" 2>/dev/null | cut -f1
  else
    printf 'MISSING'
  fi
}

SUSPECT_LINES=""
if [[ -d "$WORKTREE_ROOT" ]]; then
  while IFS= read -r child; do
    [[ -n "$child" ]] || continue
    for cache in node_modules vendor; do
      cdir="$child/$cache"
      if [[ -d "$cdir" ]]; then
        kb="$(kb_of "$cdir")"
        SUSPECT_LINES+="${kb}	${cdir}"$'\n'
      fi
    done
  done < <(find -- "$WORKTREE_ROOT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
else
  SUSPECT_LINES="MISSING	${WORKTREE_ROOT} (worktree root absent)"$'\n'
fi

DOCKER_KB="$(kb_of "$DOCKER_ROOT")"
PODMAN_KB="$(kb_of "$PODMAN_ROOT")"

# ---- LXD pool (read-only info only) -----------------------------------------
if [[ -n "${TRIAGE_LXD_INFO_FILE:-}" ]]; then
  LXD_OUT="$(cat -- "${TRIAGE_LXD_INFO_FILE}")"
elif command -v lxc >/dev/null 2>&1; then
  LXD_OUT="$(lxc storage list 2>/dev/null || printf 'lxc storage list unavailable\n')"
elif command -v zfs >/dev/null 2>&1; then
  LXD_OUT="$(zfs list 2>/dev/null || printf 'zfs list unavailable\n')"
else
  LXD_OUT="UNAVAILABLE: neither lxc nor zfs present on this host"
fi

# ---- render -----------------------------------------------------------------
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e ':a' -e 'N' -e '$!ba' -e 's/\n/\\n/g' -e 's/\t/\\t/g'
}

if [[ "$FORMAT" == "json" ]]; then
  suspects_json=""
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    kb="${line%%	*}"; p="${line#*	}"
    [[ -n "$suspects_json" ]] && suspects_json+=","
    suspects_json+="{\"kb\":\"$(json_escape "$kb")\",\"path\":\"$(json_escape "$p")\"}"
  done <<<"$SUSPECT_LINES"
  printf '{"tool":"runner_disk_triage","runbook_owner":"operator-runbook","read_only":true,"df":"%s","df_inode":"%s","suspects":[%s],"docker_root_kb":"%s","podman_root_kb":"%s","lxd":"%s"}\n' \
    "$(json_escape "$DF_OUT")" "$(json_escape "$DFI_OUT")" "$suspects_json" \
    "$(json_escape "$DOCKER_KB")" "$(json_escape "$PODMAN_KB")" "$(json_escape "$LXD_OUT")"
  exit 0
fi

printf '== runner-disk triage (read-only; operator-owned runbook) ==\n'
printf '\n-- disk overview (df -h) --\n%s\n' "$DF_OUT"
printf '\n-- inode overview (df -i) --\n%s\n' "$DFI_OUT"
printf '\n-- worktree dependency caches under %s --\n' "$WORKTREE_ROOT"
printf '%s' "$SUSPECT_LINES"
printf '\n-- container writable layer --\n'
printf 'docker root %s : %s KB\n' "$DOCKER_ROOT" "$DOCKER_KB"
printf 'podman root %s : %s KB\n' "$PODMAN_ROOT" "$PODMAN_KB"
printf '\n-- LXD pool --\n%s\n' "$LXD_OUT"
printf '\nNOTE: read-only triage only. Cleanup is operator-executed.\n'
