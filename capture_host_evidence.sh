#!/usr/bin/env bash
# ===========================================================================
# capture_host_evidence.sh — produce HOST_EVIDENCE for the TOG-657 gate
#
# WHY THIS EXISTS. The two commands that build HOST_EVIDENCE lived only as a
# comment in paperclip_activation_gate.sh, and the first hand-run of them was
# asked for in the WRONG NAMESPACE — by the very gate that exists to catch
# namespace errors. A human at a terminal, holding a request typed from an
# issue comment, is exactly where that mistake gets made a second time.
#
# The two arrays come from two DIFFERENT namespaces and must never be
# conflated:
#
#   .networks[]      what `podman inspect` reports — Quadlet's GENERATED
#                    name, `systemd-<stem>`
#   .networkUnits[]  what `systemctl list-unit-files` reports — `<stem>.network`,
#                    which is also the form the CARRIER declares
#
# Quadlet: "if the name of the network ends with .network, a Podman network
# called systemd-$name is used." So `Network=paperclip.network` renders as
# `--network=systemd-paperclip`. Feeding podman's names into .networkUnits[]
# (or the reverse) reproduces the unsatisfiable gate fixed at d58d9899.
#
#   ./capture_host_evidence.sh [--container paperclip] [--out evidence.json]
#                              [--image paperclip-local] [--user | --system]
#       -> exit 0   evidence written, both arrays non-empty and well-formed
#       -> exit 2   REFUSED to write evidence, naming what failed
#
#   --user (default) / --system  which systemd instance .networkUnits[] is read
#   from. Rootless Quadlet keeps units in --user; a root-owned deployment keeps
#   them in --system, where a --user query reports nothing at all. The instance
#   actually used is recorded as .systemdInstance, so evidence is
#   self-describing rather than needing prose alongside it.
#
# IT ALSO CAPTURES THE IMAGE DIGEST, AND WHY THAT IS NOT OPTIONAL.
# The carrier ships `Image=paperclip-local@sha256:REPLACE_WITH_APPROVED_IMAGE_
# DIGEST`. `paperclip-local` is a HOST-LOCAL image: it is in no registry, so no
# agent can resolve its digest — there is no podman binary, no podman socket and
# no readable image store in any agent container (measured, TOG-715/TOG-716).
# The digest is therefore host-gated exactly like the network units are.
#
# Capturing only the networks would spend the one human host window closing one
# red and leave `image_digest_placeholder` still refusing. The board cannot
# approve a digest nobody has read. So this script reads the CANDIDATE digest in
# the same window.
#
# READING A DIGEST IS NOT APPROVING IT. `.image` is an observation for the board
# to approve or reject; the gate keeps reading the digest from the CARRIER, and
# there is deliberately no path by which this file supplies one.
#
# This script is READ-ONLY with respect to the host. It runs no install, no
# image operation, no Quadlet change, no restart, and no restore. It only
# reads. It is safe to run outside a maintenance window.
#
# ===========================================================================
# IT REFUSES RATHER THAN WRITE EVIDENCE IT COULD NOT MEASURE
# ===========================================================================
# A redaction/capture pipeline under `set -eu` without pipefail fails OPEN:
# jq exits 0 on empty stdin, so a failed capture writes a 0-byte file and
# every downstream absence check passes. That is the TOG-710 failure, and the
# activation gate refuses a runbook that risks it. This script is held to the
# standard it produces evidence for: pipefail is set, every capture is checked
# for emptiness BEFORE it is written, and the output file is only created once
# both arrays are known good. A capture that measured nothing must not read
# green.
#
# SECRETS. `podman inspect` on the whole object retains .Config.Env, which on
# this host carries EnvironmentFile credentials. This script never captures
# the whole object — it selects ONLY .NetworkSettings.Networks, by name, so
# no credential can reach the evidence file. Do not "improve" it into a bare
# whole-object inspect.
# ===========================================================================
set -euo pipefail

# `--help` used to print `sed -n '2,49p'`, a hard-coded window onto the header.
# Documenting --system pushed the header down six lines and silently truncated
# the help mid-sentence -- it stopped printing the READ-ONLY paragraph, which is
# the one line an operator checks before running this in a host window. Print
# the contiguous comment block after the shebang and stop at the first line of
# code, so the range can never drift out of sync with the header again. Same fix
# dropchannel_scan.sh:1387 already carries, for the identical failure.
print_header() {
  awk 'NR>=2 { if ($0 ~ /^#/) { print; next } exit }' "${BASH_SOURCE[0]}"
}

CONTAINER=paperclip
OUT=host-evidence.json
# Kept as a separate constant so the recovery below can tell "the caller named
# this image" from "nobody named one and this is just the default".
IMAGE_DEFAULT=paperclip-local
IMAGE="$IMAGE_DEFAULT"
# Which systemd instance .networkUnits[] is read from. `--user` is correct for
# a rootless Quadlet deployment (the carrier's WantedBy=default.target says
# rootless), but a root-owned deployment keeps its units in the system
# instance, where a --user query reports nothing. Recorded in the evidence as
# .systemdInstance so a capture is self-describing: "no units" from the wrong
# instance and "no units" from a genuinely absent unit are the same bytes
# otherwise, and the gate would refuse a CORRECT carrier on the difference.
SYSTEMD_SCOPE=--user

while [ $# -gt 0 ]; do
  case "$1" in
    --container) CONTAINER="${2:?--container needs a value}"; shift 2 ;;
    --image)     IMAGE="${2:?--image needs a value}"; shift 2 ;;
    --out)       OUT="${2:?--out needs a value}"; shift 2 ;;
    --user)      SYSTEMD_SCOPE=--user; shift ;;
    --system)    SYSTEMD_SCOPE=--system; shift ;;
    -h|--help)   print_header; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

refuse() {
  printf 'REFUSED [%s]\n    what is wrong: %s\n    what clears it: %s\n' "$1" "$2" "$3" >&2
  exit 2
}

for bin in podman systemctl jq; do
  command -v "$bin" >/dev/null 2>&1 || \
    refuse missing_"$bin" \
      "no '$bin' on PATH — this must run ON THE HOST, not inside a container" \
      "run it in a host shell; every Paperclip agent container lacks podman, systemctl and a podman socket"
done

# --- .networks[] — podman's namespace, the GENERATED systemd-<stem> names ---
# Select the network names only. Never capture the whole object: it carries
# .Config.Env, and EnvironmentFile secrets would land in retained evidence.
networks_raw="$(podman inspect "$CONTAINER" --format '{{json .NetworkSettings.Networks}}' 2>/dev/null)" || \
  refuse inspect_failed \
    "podman inspect '$CONTAINER' failed — the container may be named differently or not running" \
    "list candidates with: podman ps --format '{{.Names}}'   then re-run with --container <name>"

[ -n "${networks_raw:-}" ] && [ "$networks_raw" != "null" ] || \
  refuse inspect_empty \
    "podman inspect returned empty/null NetworkSettings.Networks for '$CONTAINER'" \
    "confirm the container is running: podman ps --filter name=$CONTAINER"

networks_json="$(printf '%s' "$networks_raw" | jq -c '[keys[]] | sort')" || \
  refuse inspect_unparseable "podman's NetworkSettings.Networks was not parseable JSON" "capture it by hand and inspect it"

n_networks="$(printf '%s' "$networks_json" | jq -r 'length')"
[ "${n_networks:-0}" -gt 0 ] || \
  refuse no_network_legs \
    "'$CONTAINER' reports zero network legs — evidence naming no legs would let a carrier that drops every leg pass parity" \
    "confirm the running service really is attached: podman inspect $CONTAINER --format '{{json .NetworkSettings.Networks}}'"

# --- .networkUnits[] — the unit namespace, the <stem>.network form ----------
# `systemctl list-unit-files '*-network.service'` lists the SERVICE units
# Quadlet generates from .network files: `paperclip-network.service` comes
# from `paperclip.network`. Map back to the unit name the CARRIER declares.
# --no-legend/--plain keep the table stable across systemd versions.
#
# `2>/dev/null || true` here would swallow a FAILED query into the same empty
# string a genuinely-empty instance produces — and `systemctl --user` fails
# outright with no session bus, which is the normal state of a root shell on
# this host. The operator would then be told "no units found, try --system"
# when the real fault is that the query never ran, and on --system they would
# be told to re-run the flag they just used. Capture status and empty
# separately, and keep stderr OUT of units_raw: a diagnostic merged into the
# parsed stream is indistinguishable from a unit row, and the awk below would
# lift a word out of an error message and record it as a unit name.
units_rc=0
units_err="${TMPDIR:-/tmp}/che-stderr.$$"
units_raw="$(systemctl "$SYSTEMD_SCOPE" list-unit-files '*-network.service' --no-legend --plain 2>"$units_err")" || units_rc=$?
units_msg="$(head -c 400 "$units_err" 2>/dev/null)"; rm -f "$units_err"
if [ "$units_rc" -ne 0 ]; then
  refuse unit_query_failed \
    "systemctl $SYSTEMD_SCOPE list-unit-files exited $units_rc: ${units_msg:-${units_raw:-(no output)}}. The query FAILED — this is not evidence that no unit exists, and recording it as absence would refuse a CORRECT carrier" \
    "if this is a root shell, 'systemctl --user' has no session bus: re-run with --system. If --system also fails, the fault is the query, not the units — report that on TOG-716 rather than creating units to clear it"
fi

# A row that is not a unit name must never become one. systemctl can exit 0
# having printed a diagnostic, and the mapping below is a blind sed — it turns
# the line "Failed to list unit files: ..." into the unit `Failed`, writes it
# to .networkUnits[], and exits 0. Fabricated evidence is worse than no
# evidence: the gate reads it as a real installed unit.
while IFS= read -r line; do
  [ -n "$line" ] || continue
  case "${line%% *}" in
    *-network.service) ;;
    *) refuse unit_row_unrecognised \
         "systemctl exited 0 but printed a row that is not a *-network.service unit: '${line}'. Recording it would fabricate a unit name the host does not have" \
         "run 'systemctl $SYSTEMD_SCOPE list-unit-files \"*-network.service\" --no-legend --plain' by hand and check what it emitted" ;;
  esac
done <<EOF
$units_raw
EOF

units_json="$(printf '%s\n' "$units_raw" \
  | awk 'NF {print $1}' \
  | sed 's/-network\.service$/.network/' \
  | jq -R . | jq -sc 'map(select(length>0)) | sort')"

n_units="$(printf '%s' "$units_json" | jq -r 'length')"
if [ "${n_units:-0}" -eq 0 ]; then
  # An empty .networkUnits[] is NOT proof that no unit exists — it is equally
  # consistent with querying the wrong systemd instance. `--user` is correct
  # for a rootless Quadlet deployment; a root deployment needs --system, and
  # silently recording "no units" would make the gate refuse a correct carrier
  # as network_unit_absent. Refuse instead of writing an absence we cannot
  # distinguish from a mis-query.
  if [ "$SYSTEMD_SCOPE" = --user ]; then
    next="the deployment may be root-owned. Re-run this script with --system: $0 --system --out $OUT   (the instance used is recorded in the evidence as .systemdInstance)"
  else
    next="both instances have now been asked. Confirm by hand with: systemctl --system list-unit-files '*-network.service'   and systemctl --user list-unit-files '*-network.service'. If both are genuinely empty, the units are absent and that is the real TOG-657 red — report it on TOG-716 rather than creating units to clear it"
  fi
  refuse no_network_units \
    "systemctl $SYSTEMD_SCOPE reported no *-network.service units. This is indistinguishable from querying the wrong systemd instance, and recording it as absence would make the gate refuse a CORRECT carrier" \
    "$next"
fi

# --- .image — the host-local candidate digest, READ not approved -------------
# Single-field projections only, never the whole object: `podman image inspect`
# and `podman inspect` both retain .Config.Env, and this host's environment
# carries nine live credentials (TOG-710). A digest is not a secret; the object
# it comes from is.
#
# Two digests are read, and they answer different questions:
#   .image.candidate  what `paperclip-local` resolves to NOW — the digest the
#                     board would be approving into the carrier.
#   .image.running    what the RUNNING container was started from. If the local
#                     tag has been rebuilt since the service started, these
#                     differ, and pinning the candidate silently changes the
#                     running image. The board must see both to approve either.
# A refusal here DISCARDS the networks and units already measured above, because
# refuse() exits and the evidence file is only written further down. On
# 2026-09-05 that cost a whole human host window: the networks and the units
# were both present and readable, but the default `paperclip-local` existed
# under another name (`localhost/paperclip-local:tog-516v2-51ee6c01b`), so the
# run refused having already measured everything else it needed. Re-running with
# `--image` would have produced complete evidence in that same window.
#
# So when the DEFAULT name misses, resolve it here rather than sending a human
# away to run `podman images` and come back for a second window. This only
# performs the suggestion the old refusal already printed; it reads no new kind
# of object and approves nothing. It is deliberately narrow: it fires only when
# $IMAGE was left at the default (an explicit --image that misses is a typo the
# caller must see), and only when exactly ONE repository matches, because two
# candidates is a real ambiguity a human must resolve rather than have guessed.
# The recovery keys off the EXIT STATUS, never off an empty digest. `podman
# image inspect` exiting 0 with an empty value means the image EXISTS and its
# digest is unreadable — a different fault, which must keep reaching the
# `image_digest_unresolvable` refusal below. Treating "empty" as "absent" would
# send a present-but-unresolvable image down the rename path and report it under
# the wrong name.
if image_digest="$(podman image inspect "$IMAGE" --format '{{.Digest}}' 2>/dev/null)"; then
  image_inspect_rc=0
else
  image_inspect_rc=1
  image_digest=""
fi
if [ "$image_inspect_rc" -ne 0 ] && [ "$IMAGE" = "$IMAGE_DEFAULT" ]; then
  mapfile -t image_candidates < <(
    podman images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
      | grep -E '(^|/)'"$(printf '%s' "$IMAGE_DEFAULT" | sed 's/[].[*^$\\/]/\\&/g')"':' \
      | sort -u
  )
  if [ "${#image_candidates[@]}" -eq 1 ]; then
    printf 'NOTE: no image named %s; resolved the sole local match %s\n' \
      "$IMAGE_DEFAULT" "${image_candidates[0]}" >&2
    IMAGE="${image_candidates[0]}"
    if image_digest="$(podman image inspect "$IMAGE" --format '{{.Digest}}' 2>/dev/null)"; then
      image_inspect_rc=0
    else
      image_inspect_rc=1
      image_digest=""
    fi
  elif [ "${#image_candidates[@]}" -gt 1 ]; then
    refuse image_ambiguous \
      "no image named '$IMAGE_DEFAULT', and ${#image_candidates[@]} local images could be it: ${image_candidates[*]}. Guessing would pin a digest the board never chose" \
      "re-run IN THIS WINDOW naming one: --image <name>   (nothing else needs redoing)"
  fi
fi
[ "$image_inspect_rc" -eq 0 ] || \
  refuse image_inspect_failed \
    "podman image inspect '$IMAGE' failed — the local image may be named differently or absent" \
    "list candidates with: podman images --format '{{.Repository}}:{{.Tag}}'   then re-run IN THIS WINDOW with --image <name>; every capture step above already succeeded, so only this one is missing"

image_digest="${image_digest#sha256:}"
if ! [[ "$image_digest" =~ ^[0-9a-f]{64}$ ]]; then
  # An unresolvable digest must REFUSE, not record an empty string. The gate's
  # digest check reads the carrier, but a human filling the carrier from an
  # empty field here would produce `Image=paperclip-local@sha256:` — which is
  # a malformed pin that no gate in the window would be re-run to catch.
  refuse image_digest_unresolvable \
    "'$IMAGE' produced no 64-hex digest (got '${image_digest:-<empty>}')" \
    "confirm the image exists: podman image inspect $IMAGE --format '{{.Digest}}'"
fi

running_digest="$(podman inspect "$CONTAINER" --format '{{.ImageDigest}}' 2>/dev/null || true)"
running_digest="${running_digest#sha256:}"
[[ "$running_digest" =~ ^[0-9a-f]{64}$ ]] || running_digest=""

# --- .networkNames — which podman network each UNIT actually renders to -----
# TOG-1110. The two arrays above are captured from different namespaces, and
# the gate has to join them. `<stem>.network -> systemd-<stem>` is Quadlet's
# DEFAULT, not a rule: `NetworkName=` in the unit overrides it, and THIS HOST
# runs both shapes at once (`paperclip.network` sets `NetworkName=paperclip`;
# `omniroute.network` sets none and renders `systemd-omniroute`). Capturing
# only the two arrays left the gate to guess the join, and its guess refused
# the CORRECT carrier while recommending a boot-racing rewrite.
#
# Read it from the .network file Quadlet actually consumes, searching the
# documented paths in precedence order (podman-systemd.unit(5)) — the FIRST
# hit wins and the rest are shadowed. Parsed, not grepped: a grep matches
# commented-out lines and other sections, takes the FIRST assignment where
# systemd takes the LAST, and reads an empty `NetworkName=` as a name rather
# than as a RESET to the default. Each of those flips the verdict.
#
# A unit whose name cannot be read is OMITTED rather than defaulted. An absent
# key makes the gate say "unresolved"; a guessed one makes it convict the
# carrier. Omission is the honest answer.
if [ "$SYSTEMD_SCOPE" = --system ]; then
  net_dirs=(/etc/containers/systemd /run/containers/systemd
            /usr/share/containers/systemd)
else
  net_dirs=("${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd"
            "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/containers/systemd"
            "$HOME/.local/share/containers/systemd"
            /etc/containers/systemd/users)
fi

# Print the effective NetworkName= for a unit file, or nothing if unset.
effective_network_name() {  # <file>
  local line section="" key val result="" have=0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in
      ''|'#'*|';'*) continue ;;
      '['*) section="${line#[}"; section="${section%%]*}"; continue ;;
    esac
    [ "$section" = Network ] || continue
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    [ "$key" = NetworkName ] || continue
    case "$val" in *\\) return 1 ;; esac   # unjoined line continuation
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    if [ -z "$val" ]; then result=""; have=0; else result="$val"; have=1; fi
  done < "$1"
  [ "$have" -eq 1 ] && printf '%s\n' "$result"
  return 0
}

names_json='{}'
while IFS= read -r unit; do
  [ -n "$unit" ] || continue
  found=""
  for d in "${net_dirs[@]}"; do
    [ -f "$d/$unit" ] && { found="$d/$unit"; break; }
  done
  [ -n "$found" ] || continue
  if eff="$(effective_network_name "$found")"; then
    [ -n "$eff" ] || eff="systemd-${unit%.network}"   # parsed, genuinely default
    names_json="$(printf '%s' "$names_json" \
      | jq -c --arg k "$unit" --arg v "$eff" \
          '.[$k] = $v' 2>/dev/null || printf '%s' "$names_json")"
  fi
done < <(printf '%s' "$units_json" | jq -r '.[]?')

tmp="${OUT}.partial.$$"
trap 'rm -f "$tmp"' EXIT
jq -n --argjson networks "$networks_json" --argjson networkUnits "$units_json" \
      --argjson networkNames "$names_json" \
      --arg image "$IMAGE" --arg candidate "$image_digest" --arg running "$running_digest" \
      --arg systemdInstance "${SYSTEMD_SCOPE#--}" \
  '{networks: $networks, networkUnits: $networkUnits,
    networkNames: $networkNames,
    systemdInstance: $systemdInstance,
    image: {name: $image, candidate: $candidate,
            running: (if $running == "" then null else $running end),
            matchesRunning: ($running != "" and $running == $candidate)}}' > "$tmp"

# Prove the artifact before adopting it: a 0-byte or malformed file is the
# exact thing the gate's fail-open check exists to prevent.
[ -s "$tmp" ] || refuse empty_evidence "evidence file came out empty" "re-run; do not hand-edit"
jq -e '.networks and .networkUnits' "$tmp" >/dev/null || \
  refuse malformed_evidence "evidence file lacks .networks/.networkUnits" "re-run; do not hand-edit"
jq -e '.image.candidate | test("^[0-9a-f]{64}$")' "$tmp" >/dev/null || \
  refuse malformed_image_evidence "evidence file lacks a 64-hex .image.candidate" "re-run; do not hand-edit"

# A whole-object inspect would have retained .Config.Env. Prove no environment
# reached the artifact rather than asserting it — this is the check that would
# fire if someone "improved" the captures above into bare inspects.
jq -e 'any(..; type == "object" and (has("Env") or has("Config"))) | not' "$tmp" >/dev/null || \
  refuse credential_bearing_evidence \
    "evidence carries a Config/Env object — a whole-object inspect leaked EnvironmentFile secrets" \
    "capture single fields only; never a bare podman inspect"

mv "$tmp" "$OUT"
trap - EXIT

printf 'wrote %s\n' "$OUT"
printf '  .networks[]      %s leg(s)   %s\n' "$n_networks" "$(jq -rc '.networks' "$OUT")"
printf '  .networkUnits[]  %s unit(s)  %s\n' "$n_units" "$(jq -rc '.networkUnits' "$OUT")"
printf '  .networkNames    %s resolved  %s\n' \
  "$(jq -r '.networkNames | length' "$OUT")" "$(jq -rc '.networkNames' "$OUT")"
# Name every unit whose effective name could NOT be read. The gate refuses
# these as unresolved rather than convicting the carrier, so an operator who
# sees this line knows the window did not finish the join.
unread="$(jq -r '[.networkUnits[] | select(. as $u | ($ARGS.named.n | has($u) | not))] | join(" ")' \
            --argjson n "$(jq -c '.networkNames' "$OUT")" "$OUT" 2>/dev/null)"
[ -n "${unread:-}" ] && printf '                   UNRESOLVED (no readable unit): %s\n' "$unread"
printf '  .image           %s @sha256:%s\n' "$IMAGE" "$image_digest"
if [ -z "$running_digest" ]; then
  printf '                   running digest UNREADABLE — the board approves the candidate blind to drift\n'
elif [ "$running_digest" != "$image_digest" ]; then
  printf '                   ** DRIFT: running container is on sha256:%s\n' "$running_digest"
  printf '                   the local tag was rebuilt since the service started; pinning the\n'
  printf '                   candidate CHANGES the running image. Say so in the approval ask.\n'
else
  printf '                   matches the running container\n'
fi
printf '\nNo secret is captured: only names and digests are read, never .Config.Env.\n'
printf 'The digest is READ, not approved. The board approves it; the gate reads it\n'
printf 'from the carrier. Nothing here fills the carrier placeholder.\n'
printf 'Feed it to the gate with:\n  HOST_EVIDENCE=%s ./paperclip_activation_gate.sh check --repo . --commit <sha>\n' "$OUT"
