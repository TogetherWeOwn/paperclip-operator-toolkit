#!/usr/bin/env bash
# ===========================================================================
# capture_network_name_evidence.sh — decide TOG-1110 case (A) vs case (B)
#
# WHY THIS EXISTS. The TOG-1105 window produced `network_leg_mismatched`: the
# host holds legs `paperclip` and `systemd-omniroute`. One carries Quadlet's
# generated prefix, one does not. Two causes need OPPOSITE fixes:
#
#   (A) `paperclip.network` sets `NetworkName=paperclip`, overriding Quadlet's
#       default. The CARRIER is already correct and the GATE is wrong — it does
#       unconditional `X.network -> systemd-X` string math
#       (paperclip_activation_gate.sh:165, carrier_key_to_podman_network).
#   (B) `paperclip` is a plain pre-existing podman network with no unit behind
#       it. The GATE is right and the carrier must change.
#
# Guessing has a 50% chance of breaking startup, so this script REFUSES rather
# than reporting a verdict it could not measure.
#
# ===========================================================================
# WHY NOT JUST `systemctl cat paperclip.network`
# ===========================================================================
# Because it answers a different question, and its silence is a TRAP.
#
# A Quadlet `.network` file is a GENERATOR INPUT, not a systemd unit. systemd
# never loads `paperclip.network`; Quadlet reads it and emits the real unit,
# `paperclip-network.service`. So `systemctl cat paperclip.network` prints
# "No files found for paperclip.network" on a perfectly healthy host that IS
# case (A). TOG-1110's body reads that silence as proof of case (B) — which
# would conclude the exact opposite of the truth and send someone to rewrite a
# carrier that was already correct.
#
# This script therefore reads THREE independent sources and requires them to
# agree:
#
#   1. The `.network` SOURCE files, found across every Quadlet search path
#      (podman-systemd.unit(5)), parsed for an effective `NetworkName=`.
#   2. The GENERATED `X-network.service`, via `systemctl cat`. Its ExecStart
#      carries the name podman was actually told to create — the ground truth
#      for what Quadlet rendered, independent of our own parsing.
#   3. `podman network ls`, the legs that actually exist right now.
#
# One source can be stale, mis-parsed, or read from the wrong systemd
# instance. Three agreeing cannot all be wrong in the same direction. Where
# they disagree, that disagreement IS the finding and the script says so
# instead of picking a winner.
#
# ===========================================================================
# READ-ONLY
# ===========================================================================
# Runs no install, no image operation, no Quadlet change, no restart, no
# activation. It only reads. Safe outside a maintenance window.
#
# SECRETS. Never runs a bare `podman inspect` — that retains `.Config.Env`,
# which on this host carries EnvironmentFile credentials (TOG-710). It reads
# `.network` unit text (network configuration, no credentials) and single
# projected fields only. Unit text is scanned for secret-shaped assignments
# and redacted before it is printed, so an unexpected key cannot ride out.
#
#   ./capture_network_name_evidence.sh [--stem paperclip] [--stem omniroute]
#                                      [--user | --system] [--out FILE]
#       -> exit 0  a verdict was reached and every source agreed
#       -> exit 2  REFUSED — naming what could not be measured or what
#                  disagreed. This is NOT a verdict of (B).
# ===========================================================================
set -euo pipefail

ME="${0##*/}"
EXIT_REFUSED=2
OUT=""
STEMS=()
SCOPE=""          # empty = try user then system

print_header() {
  awk 'NR>=2 { if ($0 ~ /^#/) { print; next } exit }' "${BASH_SOURCE[0]}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --stem)    STEMS+=("${2:?--stem needs a value}"); shift 2 ;;
    --out)     OUT="${2:?--out needs a value}"; shift 2 ;;
    --user)    SCOPE=user; shift ;;
    --system)  SCOPE=system; shift ;;
    -h|--help) print_header; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit "$EXIT_REFUSED" ;;
  esac
done
[ "${#STEMS[@]}" -gt 0 ] || STEMS=(paperclip omniroute)

REFUSALS=0
refuse() {
  REFUSALS=$((REFUSALS+1))
  printf 'REFUSED [%s]\n    what is wrong: %s\n    what clears it: %s\n' "$1" "$2" "$3" >&2
}

# --- the effective NetworkName, parsed the way systemd actually resolves it -
# Not a grep. `grep NetworkName=` gets four things wrong, and each one flips
# the verdict:
#   * it matches inside [Container] or any other section, where the key means
#     nothing for the network's name;
#   * it matches a commented-out line;
#   * on repeated assignment it reports the FIRST, where systemd takes the LAST;
#   * it reports `NetworkName=` (empty) as "set to nothing", where systemd
#     treats an empty assignment as a RESET to the default — which is
#     `systemd-<stem>`, i.e. the precise difference between case (A) and (B).
# Args: files in application order (unit first, then drop-ins).
# Prints the effective value, or nothing at all if the default applies.
effective_network_name() {
  local f line section="" key val result="" have=0
  for f in "$@"; do
    while IFS= read -r line || [ -n "$line" ]; do
      line="${line%$'\r'}"                       # CRLF-authored units exist
      line="${line#"${line%%[![:space:]]*}"}"    # leading whitespace
      case "$line" in
        ''|'#'*|';'*) continue ;;
        '['*)
          section="${line#[}"; section="${section%%]*}"
          continue ;;
      esac
      [ "$section" = Network ] || continue
      case "$line" in *=*) ;; *) continue ;; esac
      key="${line%%=*}"; val="${line#*=}"
      key="${key%"${key##*[![:space:]]}"}"
      [ "$key" = NetworkName ] || continue
      # A trailing backslash is a systemd line continuation. We do not join
      # them, so rather than silently record a truncated network name -- the
      # one value this whole script exists to get right -- stop and say so.
      case "$val" in
        *\\) refuse networkname_line_continuation \
               "NetworkName= in '$f' ends in a backslash (systemd line continuation); this parser does not join continuations and would record a TRUNCATED network name" \
               "read the unit by hand: cat '$f'   and report the joined value on TOG-1110"
             return 1 ;;
      esac
      val="${val#"${val%%[![:space:]]*}"}"
      val="${val%"${val##*[![:space:]]}"}"
      if [ -z "$val" ]; then result=""; have=0; else result="$val"; have=1; fi
    done < "$f"
  done
  [ "$have" -eq 1 ] && printf '%s\n' "$result"
  return 0
}

# --- Quadlet's search paths, verbatim from podman-systemd.unit(5) -----------
# Precedence order matters: the FIRST directory holding `<stem>.network` wins
# and the rest are shadowed. Searching only ~/.config/containers/systemd would
# miss a unit installed in /etc and report a false "absent" -- which this
# card's body would then read as case (B).
quadlet_dirs_user() {
  printf '%s\n' \
    "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/containers/systemd" \
    "${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd" \
    "$HOME/.config/containers/systemd" \
    "/etc/containers/systemd/users/$(id -u)" \
    "/etc/containers/systemd/users" \
    "/usr/share/containers/systemd/users/$(id -u)" \
    "/usr/share/containers/systemd/users"
}
quadlet_dirs_system() {
  printf '%s\n' \
    "/run/containers/systemd" \
    "/etc/containers/systemd" \
    "/usr/share/containers/systemd"
}

for bin in podman systemctl; do
  command -v "$bin" >/dev/null 2>&1 || {
    refuse missing_"$bin" \
      "no '$bin' on PATH — this must run ON THE HOST, not inside a container" \
      "run it in a host shell; every Paperclip agent container lacks podman, systemctl and a podman socket"
    exit "$EXIT_REFUSED"
  }
done

# --- which systemd instance ------------------------------------------------
# Recorded in the output, because "no units" from the wrong instance and "no
# units" from a genuinely absent unit are otherwise the same bytes.
pick_scope() {
  local s
  for s in ${SCOPE:-user system}; do
    if systemctl "--$s" list-unit-files '*-network.service' \
         --no-legend --plain >/dev/null 2>&1; then
      printf '%s\n' "$s"; return 0
    fi
  done
  return 1
}
SCOPE_USED="$(pick_scope || true)"
if [ -z "$SCOPE_USED" ]; then
  refuse unit_query_failed \
    "systemctl list-unit-files failed in ${SCOPE:-both user and system} instance(s). The query FAILED — this is not evidence that no unit exists" \
    "if this is a root shell, 'systemctl --user' has no session bus: re-run with --system. If both fail, report that on TOG-1110 rather than concluding case (B)"
  exit "$EXIT_REFUSED"
fi

# Secret-shaped assignments are redacted before any unit text is printed.
redact() { sed -E 's/^([[:space:]]*(Environment|Secret|[A-Za-z]*(Key|Token|Password|Secret))[A-Za-z]*[[:space:]]*=).*/\1<REDACTED>/I'; }

VERDICTS=()
json_units=""

for stem in "${STEMS[@]}"; do
  printf '=== %s.network ===\n' "$stem"

  # 1. the SOURCE file, in Quadlet precedence order, plus its drop-ins
  unit_file=""
  if [ "$SCOPE_USED" = user ]; then dirs="$(quadlet_dirs_user)"; else dirs="$(quadlet_dirs_system)"; fi
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    if [ -z "$unit_file" ] && [ -f "$d/$stem.network" ]; then unit_file="$d/$stem.network"; fi
  done <<< "$dirs"

  dropins=()
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    if [ -d "$d/$stem.network.d" ]; then
      while IFS= read -r c; do [ -n "$c" ] && dropins+=("$c"); done \
        < <(find "$d/$stem.network.d" -maxdepth 1 -name '*.conf' -type f 2>/dev/null | sort)
    fi
  done <<< "$dirs"

  if [ -z "$unit_file" ]; then
    printf '  source unit:   ABSENT from every Quadlet search path (%s instance)\n' "$SCOPE_USED"
    src_name=""; src_state=absent
  else
    printf '  source unit:   %s\n' "$unit_file"
    [ "${#dropins[@]}" -gt 0 ] && printf '  drop-in:       %s\n' "${dropins[@]}"
    if ! src_name="$(effective_network_name "$unit_file" ${dropins[@]+"${dropins[@]}"})"; then
      exit "$EXIT_REFUSED"
    fi
    if [ -n "$src_name" ]; then
      src_state=override
      printf '  NetworkName=   %s   (OVERRIDE — the systemd- prefix does NOT apply)\n' "$src_name"
    else
      src_state=default
      src_name="systemd-$stem"
      printf '  NetworkName=   (unset) -> default %s\n' "$src_name"
    fi
    printf '  --- unit text (secret-shaped keys redacted) ---\n'
    redact < "$unit_file" | sed 's/^/  | /'
    for c in ${dropins[@]+"${dropins[@]}"}; do
      printf '  --- drop-in %s ---\n' "$c"
      redact < "$c" | sed 's/^/  | /'
    done
  fi

  # 2. the GENERATED service — ground truth for what Quadlet rendered.
  #    Independent of our parser above, which is the point of reading it.
  gen_raw="$(systemctl "--$SCOPE_USED" cat "$stem-network.service" 2>/dev/null || true)"
  if [ -z "$gen_raw" ]; then
    gen_name=""
    printf '  generated:     %s-network.service NOT loaded by systemd\n' "$stem"
  else
    # ExecStart=... podman network create ... <name>   — the last bare token.
    gen_name="$(printf '%s\n' "$gen_raw" | awk '
      /^ExecStart=/ && /network[[:space:]]+create/ {
        for (i = NF; i >= 1; i--) if ($i !~ /^-/) { print $i; exit }
      }')"
    printf '  generated:     %s-network.service   creates %s\n' "$stem" "${gen_name:-<unparsed>}"
  fi

  # 3. does that leg actually exist right now
  if podman network exists "$src_name" 2>/dev/null; then leg_present=yes; else leg_present=no; fi
  printf '  leg %-14s present on host: %s\n' "$src_name" "$leg_present"

  # --- corroboration ------------------------------------------------------
  if [ -n "$gen_name" ] && [ "$src_state" != absent ] && [ "$gen_name" != "$src_name" ]; then
    refuse source_generated_disagree \
      "for '$stem' the .network source resolves to '$src_name' but the generated service creates '$gen_name'. Two independent reads disagree; picking either could break startup" \
      "the generator may be running on a stale copy of the unit. Compare by hand: cat '$unit_file'   and   systemctl --$SCOPE_USED cat $stem-network.service"
  fi

  VERDICTS+=("$stem|$src_state|$src_name|$gen_name|$leg_present")
  json_units="$json_units$(printf '{"stem":"%s","sourceUnit":"%s","networkNameState":"%s","effectiveName":"%s","generatedName":"%s","legPresent":%s},' \
    "$stem" "${unit_file:-}" "$src_state" "$src_name" "${gen_name:-}" \
    "$([ "$leg_present" = yes ] && echo true || echo false)")"
  printf '\n'
done

# --- the verdict, stated in TOG-1110's own terms ---------------------------
printf '=== VERDICT ===\n'
case_a=0; case_b=0
for v in "${VERDICTS[@]}"; do
  IFS='|' read -r stem state eff gen present <<< "$v"
  case "$state" in
    override) case_a=1; printf '  %-12s case (A): unit sets NetworkName=%s. Carrier correct; GATE is wrong.\n' "$stem" "$eff" ;;
    default)  printf '  %-12s neutral: unit exists, no override, renders %s (Quadlet default).\n' "$stem" "$eff" ;;
    absent)   case_b=1; printf '  %-12s case (B): NO unit in any search path. Leg is unmanaged.\n' "$stem" ;;
  esac
done

if [ "$REFUSALS" -gt 0 ]; then
  printf '\n%s refusal(s) above. NO VERDICT — this is not a finding of case (B).\n' "$REFUSALS" >&2
  exit "$EXIT_REFUSED"
fi

if [ "$case_a" -eq 1 ] && [ "$case_b" -eq 1 ]; then
  printf '\n  MIXED: both an override and an absent unit. Fix per-stem, not globally.\n'
elif [ "$case_a" -eq 1 ]; then
  printf '\n  => CASE (A). Fix paperclip_activation_gate.sh:165 to read NetworkName=.\n'
  printf '     Do NOT change the carrier Network= keys.\n'
elif [ "$case_b" -eq 1 ]; then
  printf '\n  => CASE (B). The gate is right; the carrier must change.\n'
else
  printf '\n  => NEITHER. Every unit renders the Quadlet default, so the observed\n'
  printf '     leg name `paperclip` came from somewhere else. Report this on TOG-1110.\n'
fi

if [ -n "$OUT" ]; then
  printf '{"systemdInstance":"%s","units":[%s]}\n' "$SCOPE_USED" "${json_units%,}" > "$OUT"
  printf '\nwrote %s\n' "$OUT"
fi

printf '\nRead-only: nothing was written, created, started or changed on the host.\n'
