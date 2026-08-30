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

CONTAINER=paperclip
OUT=host-evidence.json
IMAGE=paperclip-local
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
    -h|--help)   sed -n '2,49p' "$0"; exit 0 ;;
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
units_raw="$(systemctl "$SYSTEMD_SCOPE" list-unit-files '*-network.service' --no-legend --plain 2>/dev/null || true)"

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
image_digest="$(podman image inspect "$IMAGE" --format '{{.Digest}}' 2>/dev/null)" || \
  refuse image_inspect_failed \
    "podman image inspect '$IMAGE' failed — the local image may be named differently or absent" \
    "list candidates with: podman images --format '{{.Repository}}:{{.Tag}}'   then re-run with --image <name>"

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

tmp="${OUT}.partial.$$"
trap 'rm -f "$tmp"' EXIT
jq -n --argjson networks "$networks_json" --argjson networkUnits "$units_json" \
      --arg image "$IMAGE" --arg candidate "$image_digest" --arg running "$running_digest" \
      --arg systemdInstance "${SYSTEMD_SCOPE#--}" \
  '{networks: $networks, networkUnits: $networkUnits,
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
