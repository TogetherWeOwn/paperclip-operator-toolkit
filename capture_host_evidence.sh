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
#       -> exit 0   evidence written, both arrays non-empty and well-formed
#       -> exit 2   REFUSED to write evidence, naming what failed
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

while [ $# -gt 0 ]; do
  case "$1" in
    --container) CONTAINER="${2:?--container needs a value}"; shift 2 ;;
    --out)       OUT="${2:?--out needs a value}"; shift 2 ;;
    -h|--help)   sed -n '2,32p' "$0"; exit 0 ;;
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
units_raw="$(systemctl --user list-unit-files '*-network.service' --no-legend --plain 2>/dev/null || true)"

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
  refuse no_network_units \
    "systemctl --user reported no *-network.service units. This is indistinguishable from querying the wrong systemd instance, and recording it as absence would make the gate refuse a CORRECT carrier" \
    "if this deployment is rootless, confirm with: systemctl --user list-unit-files '*-network.service'. If it is root-owned, re-capture with --system and record which instance was used"
fi

tmp="${OUT}.partial.$$"
trap 'rm -f "$tmp"' EXIT
jq -n --argjson networks "$networks_json" --argjson networkUnits "$units_json" \
  '{networks: $networks, networkUnits: $networkUnits}' > "$tmp"

# Prove the artifact before adopting it: a 0-byte or malformed file is the
# exact thing the gate's fail-open check exists to prevent.
[ -s "$tmp" ] || refuse empty_evidence "evidence file came out empty" "re-run; do not hand-edit"
jq -e '.networks and .networkUnits' "$tmp" >/dev/null || \
  refuse malformed_evidence "evidence file lacks .networks/.networkUnits" "re-run; do not hand-edit"

mv "$tmp" "$OUT"
trap - EXIT

printf 'wrote %s\n' "$OUT"
printf '  .networks[]      %s leg(s)   %s\n' "$n_networks" "$(jq -rc '.networks' "$OUT")"
printf '  .networkUnits[]  %s unit(s)  %s\n' "$n_units" "$(jq -rc '.networkUnits' "$OUT")"
printf '\nNo secret is captured: only network NAMES are read, never .Config.Env.\n'
printf 'Feed it to the gate with:\n  HOST_EVIDENCE=%s ./paperclip_activation_gate.sh check --repo . --commit <sha>\n' "$OUT"
