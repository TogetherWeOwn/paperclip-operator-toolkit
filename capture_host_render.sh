#!/usr/bin/env bash
# ===========================================================================
# capture_host_render.sh — re-run the Quadlet generator against the CURRENT
#                          carriers and write a fresh board-quadlet-render.json
#
# WHY THIS EXISTS. `generated/board-quadlet-render.json` is the only
# HOST-PRODUCED artifact on the TOG-657 activation path. It records what the
# installed Podman 4.9.3 / systemd 255 generator actually emitted for one exact
# set of carrier bytes. It was captured at 060dc669, when the carrier declared
# ONE leg:
#
#     render requiredTokens:  --network=systemd-paperclip      <- one leg
#     carrier now declares:   Network=paperclip.network
#                             Network=omniroute.network        <- two legs
#
# TOG-714 added the OmniRoute leg, so the render no longer describes the
# carrier. `test_paperclip_immutable_runtime.sh` binds carrier bytes to that
# render and is RED, correctly: we hold a positive host measurement that the
# ONE-leg carrier generates, and NO measurement that the two-leg carrier
# generates at all. That is `network_unit_absent` from a stronger direction —
# not "a unit appears to be missing" but "the generator has never been run
# against the carrier we intend to install".
#
# Only the host can answer it, and host time is human-gated (TOG-715: every
# agent has CapEff 0000000000000000, no podman, no systemctl). So the procedure
# is a script rather than commands typed out of an issue comment: it is run
# once, by a human, in a scarce window, and the same input must give the same
# output forever.
#
#   ./capture_host_render.sh [--out PATH] [--fixture-image REF]
#       -> exit 0   render written; read the VERDICT it prints
#       -> exit 2   REFUSED to write a render, naming what failed
#
# ===========================================================================
# WHAT IT DOES NOT DO
# ===========================================================================
# It installs nothing and starts nothing. The generator runs `-user -dryrun`
# against a DISPOSABLE mode-0700 QUADLET_UNIT_DIRS holding copies, exactly as
# the existing artifact records (`"installed": false`). No unit is written to
# any real unit directory, no service is created, enabled, started or
# restarted, no image is pulled or built, nothing is deployed or restored.
# It is read-only with respect to the host in the same sense the network
# capture is, and is safe outside a maintenance window.
#
# ===========================================================================
# IT MEASURES; IT DOES NOT JUDGE
# ===========================================================================
# If the generator emits ONE leg instead of two, this script writes that down
# and says so loudly. It does NOT refuse, and it does NOT adjust the output to
# what we hoped for. A one-leg render of a two-leg carrier is a REAL and
# decisive finding — it is precisely the fail-green TOG-657 exists to catch,
# and the operator must be able to carry it back. The judging belongs to
# `test_paperclip_immutable_runtime.sh`, which asserts both legs by identity.
#
# Capture measures. The gate judges. Never move the verdict into the capture.
#
# ===========================================================================
# THE ONE-LINE FIX THAT MUST NOT BE MADE
# ===========================================================================
# The tempting way to make the red suite green is to edit
# GENERATOR_EVIDENCE_SHA256 in test_paperclip_immutable_runtime.sh to match the
# current carrier. That binds the evidence to bytes NO GENERATOR EVER SAW —
# the same fail-open class as `touch`ing a zero-byte .network unit to clear
# `network_units` (TOG-714, `network_unit_empty`).
#
# The distinction is the provenance of the render, not the act of repinning:
#
#   FORBIDDEN  repin the suite at the OLD render so the hashes line up
#   CORRECT    run THIS script on the host, check in the render it produced,
#              then repin the suite at that NEW render
#
# Both end with an edited constant. Only one has a generator behind it.
#
# ===========================================================================
# SECRETS
# ===========================================================================
# The rendered ExecStart contains `--env-file %h/.config/containers/systemd/
# paperclip.env` — the PATH of the credential file, which is what Quadlet
# emits and what the existing artifact already records. This script never
# reads that file and never expands it. It also refuses to write a render in
# which an env-file's CONTENTS leaked into the ExecStart, which is what would
# happen if someone "improved" the dry-run into a real generation.
# ===========================================================================
set -euo pipefail

# `--help` printed `sed -n '2,80p'`, a hard-coded window that already stopped
# three lines short of the header -- cutting mid-sentence, in the paragraph that
# tells the operator this never reads or expands the credential file. Print the
# comment block and stop at the first line of code, so the range cannot drift.
print_header() {
  awk 'NR>=2 { if ($0 ~ /^#/) { print; next } exit }' "${BASH_SOURCE[0]}"
}

HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
CARRIER="$HERE/deploy/paperclip-immutable/paperclip.container"
RUN_CARRIER="$HERE/deploy/paperclip-immutable/agent-run.container.in"
OUT="$HERE/deploy/paperclip-immutable/generated/board-quadlet-render.json"
GENERATOR=/usr/lib/systemd/system-generators/podman-system-generator

# The image is SUBSTITUTED, for two independent reasons, and the substitution
# is recorded in the artifact so nobody mistakes it for an approval:
#   1. the carrier ships a placeholder that is not a resolvable digest, so the
#      generator has nothing real to render;
#   2. the render must be reproducible from checked-in bytes, and the approved
#      digest is not decided yet (that is the OTHER half of this host window).
# Substituting affects the image reference only. It cannot move a --network=,
# --read-only, --cap-drop or bind token, which is all the suite asserts.
FIXTURE_IMAGE='ghcr.io/paperclipai/paperclip@sha256:23090eb60885f130d460562c401e7b65789e42400c71708ecfcb6be5d6cfa936'
RUN_ID=run-a
RUN_UID=61111
RUN_GID=61112
RUN_ROOT=/run/paperclip-runs/run-a
WORKSPACE=/run/paperclip-runs/run-a/workspace

while [ $# -gt 0 ]; do
  case "$1" in
    --out)           OUT="${2:?--out needs a value}"; shift 2 ;;
    --fixture-image) FIXTURE_IMAGE="${2:?--fixture-image needs a value}"; shift 2 ;;
    --generator)     GENERATOR="${2:?--generator needs a value}"; shift 2 ;;
    -h|--help)       print_header; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

refuse() {
  printf 'REFUSED [%s]\n    what is wrong: %s\n    what clears it: %s\n' "$1" "$2" "$3" >&2
  exit 2
}

for bin in podman jq git; do
  command -v "$bin" >/dev/null 2>&1 || \
    refuse missing_"$bin" \
      "no '$bin' on PATH — this must run ON THE HOST, not inside a container" \
      "run it in a host shell; every Paperclip agent container lacks podman and systemctl (TOG-715)"
done

[ -x "$GENERATOR" ] || \
  refuse generator_absent \
    "the Quadlet generator is not executable at $GENERATOR" \
    "locate it with: ls /usr/lib/systemd/system-generators/podman-system-generator   then pass --generator <path>"

for f in "$CARRIER" "$RUN_CARRIER"; do
  [ -f "$f" ] || refuse carrier_missing "$f does not exist" "run this from a full checkout of the repo"
done

# --- stage disposable copies; nothing is written to a real unit directory ----
STAGE="$(mktemp -d)"
chmod 0700 "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

render_one() {
  # $1 = staged unit filename, $2 = output prefix. Renders ONE carrier alone so
  # the two ExecStart values cannot be mixed up by ordering.
  local unit_dir="$STAGE/units-$2"
  mkdir -p "$unit_dir"
  chmod 0700 "$unit_dir"
  cp "$STAGE/$1" "$unit_dir/$1"
  local rc=0
  QUADLET_UNIT_DIRS="$unit_dir" "$GENERATOR" -user -dryrun \
    >"$STAGE/$2.out" 2>"$STAGE/$2.err" || rc=$?
  printf '%s' "$rc"
}

sed "s|^Image=.*|Image=$FIXTURE_IMAGE|" "$CARRIER" > "$STAGE/paperclip.container"
sed -e "s|@AGENT_IMAGE_DIGEST@|$FIXTURE_IMAGE|g" \
    -e "s|@RUN_ID@|$RUN_ID|g" \
    -e "s|@RUN_UID@|$RUN_UID|g" \
    -e "s|@RUN_GID@|$RUN_GID|g" \
    -e "s|@RUN_ROOT@|$RUN_ROOT|g" \
    -e "s|@WORKSPACE@|$WORKSPACE|g" \
    "$RUN_CARRIER" > "$STAGE/paperclip-run-$RUN_ID.container"

# An unsubstituted @...@ would render a literal placeholder and silently
# produce a render describing a unit no launcher will ever emit.
if grep -q '@[A-Z_]\{2,\}@' "$STAGE/paperclip-run-$RUN_ID.container"; then
  refuse unsubstituted_placeholder \
    "the run carrier still holds an @PLACEHOLDER@ after substitution — the render would describe a unit no launcher emits" \
    "a new @...@ key was added to agent-run.container.in; add its substitution to this script"
fi

server_rc="$(render_one paperclip.container server)"
run_rc="$(render_one "paperclip-run-$RUN_ID.container" run)"

extract_exec() {
  sed -n 's/^ExecStart=//p' "$STAGE/$1.out" | head -1
}
server_exec="$(extract_exec server)"
run_exec="$(extract_exec run)"

# A non-zero generator or an absent ExecStart is a STOP, never permission to
# continue — and never a reason to write a render with an empty field. An
# empty-string ExecStart satisfies every substring check downstream.
if [ "$server_rc" != 0 ] || [ -z "$server_exec" ]; then
  printf -- '--- generator stderr (server) ---\n' >&2
  cat "$STAGE/server.err" >&2 || true
  refuse server_generation_failed \
    "the generator exited $server_rc / produced no ExecStart for the server carrier. This is DECISIVE: the carrier we intend to install does not generate" \
    "read the stderr above. Do not edit the render or the suite's pinned hash to work around it — the carrier is what is wrong"
fi
if [ "$run_rc" != 0 ] || [ -z "$run_exec" ]; then
  printf -- '--- generator stderr (run) ---\n' >&2
  cat "$STAGE/run.err" >&2 || true
  refuse run_generation_failed \
    "the generator exited $run_rc / produced no ExecStart for the per-run carrier" \
    "read the stderr above; the run carrier template is what is wrong"
fi

# Guard the secret boundary: -dryrun emits the --env-file PATH, never its
# contents. If a KEY=VALUE pair from the env file reached the ExecStart, this
# is not a dry run and the render must not be retained.
# Match the credential-shaped variable NAME with a non-empty value, not the
# value's text: the secret word lives in `OMNIROUTE_KEY=sk-live-...`, on the
# left of the `=`. An earlier version scanned the right-hand side and matched
# nothing, so the guard silently never fired — and the mutation control that
# deletes it still read green, because "not refused" is identical whether the
# guard is absent or merely inert. The carrier's own Environment= keys (HOST,
# PAPERCLIP_HOME, TMPDIR, ...) contain none of these words, so a legitimate
# dry-run does not trip this.
if grep -Eq -- '--env[[:space:]=]+[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z_]*=[^[:space:]]' <<<"$server_exec"; then
  refuse credential_bearing_render \
    "the rendered ExecStart carries an expanded credential — the EnvironmentFile was read, so this was not a -dryrun" \
    "re-run with -user -dryrun against a disposable QUADLET_UNIT_DIRS; never retain this output"
fi

mapfile -t server_legs < <(grep -oE -- '--network=[^[:space:]]+' <<<"$server_exec" | sed 's/^--network=//' | sort -u)
n_legs="${#server_legs[@]}"

commit="$(git -C "$HERE" rev-parse HEAD)"
tree="$(git -C "$HERE" rev-parse HEAD^{tree})"
parent="$(git -C "$HERE" rev-parse HEAD^ 2>/dev/null || printf '')"
server_sha="$(sha256sum "$CARRIER" | cut -d' ' -f1)"
run_sha="$(sha256sum "$RUN_CARRIER" | cut -d' ' -f1)"

# The NORMALIZED hash: every `Image=` line collapsed to one constant. It exists
# to stop this scarce window being spent twice.
#
# Step 3 of the activation sequence pins the approved digest into the carrier.
# That changes the carrier bytes, so the raw hash above stops matching and the
# binding suite calls this render STALE — demanding a SECOND host window for a
# render that could not possibly have come out differently.
#
# It could not, and that is provable rather than hoped: this script SUBSTITUTES
# `Image=` before handing the unit to the generator, so the carrier's image line
# never reaches it and cannot move a --network=, --read-only, --cap-drop or bind
# token. And if two carriers share a normalized hash they are byte-identical
# everywhere except lines matching `^Image=`, because normalization rewrites
# only those.
#
# So the suite may accept a raw mismatch ONLY when the normalized hash still
# matches — an edit confined to the one line proven not to reach the generator.
# Any other edit moves the normalized hash too and is STALE, as it must be.
# This narrows the binding by exactly one provably-inert line. It does not
# loosen it, and it is not a way to make a red suite green.
normalize_carrier() { sed 's|^Image=.*|Image=<SUBSTITUTED>|' "$1"; }
server_norm_sha="$(normalize_carrier "$CARRIER" | sha256sum | cut -d' ' -f1)"
run_norm_sha="$(normalize_carrier "$RUN_CARRIER" | sha256sum | cut -d' ' -f1)"

podman_version="$(podman version --format '{{.Client.Version}}' 2>/dev/null || printf 'unknown')"
systemd_version="$(systemctl --version 2>/dev/null | head -1 | sed 's/^systemd //' || printf 'unknown')"

# requiredTokens is written from what was ACTUALLY rendered, not from a wish
# list. Every generated leg is required: that is the whole point — a leg that
# generated once must never silently stop generating.
required_json="$(printf '%s\n' "${server_legs[@]}" \
  | sed 's|^|--network=|' \
  | jq -R . | jq -sc '. + [
      "--read-only", "--read-only-tmpfs=false",
      "--tmpfs /tmp:rw,nosuid,nodev,noexec,size=24g,mode=1777",
      "--tmpfs /run:rw,nosuid,nodev,noexec,size=64m,mode=0755",
      "--security-opt=no-new-privileges", "--cap-drop=all",
      "-v %h/.local/share/paperclip:/paperclip:Z"]')"

mkdir -p "$(dirname "$OUT")"
tmp="$OUT.partial.$$"
jq -n \
  --arg commit "$commit" --arg tree "$tree" --arg parent "$parent" \
  --arg serverSha "$server_sha" --arg runSha "$run_sha" \
  --arg serverNormSha "$server_norm_sha" --arg runNormSha "$run_norm_sha" \
  --arg podman "$podman_version" --arg systemd "$systemd_version" \
  --arg generator "$GENERATOR" \
  --arg serverExec "$server_exec" --arg runExec "$run_exec" \
  --argjson serverRc "$server_rc" --argjson runRc "$run_rc" \
  --argjson required "$required_json" \
  --arg image "$FIXTURE_IMAGE" --arg runId "$RUN_ID" \
  --argjson runUid "$RUN_UID" --argjson runGid "$RUN_GID" \
  --arg runRoot "$RUN_ROOT" --arg workspace "$WORKSPACE" \
'{
  schemaVersion: 1,
  authority: "board-host-read-only-disposable-render",
  candidate: {
    commit: $commit, tree: $tree, parent: $parent,
    serverCarrierPath: "deploy/paperclip-immutable/paperclip.container",
    serverCarrierSha256: $serverSha,
    runCarrierPath: "deploy/paperclip-immutable/agent-run.container.in",
    runCarrierSha256: $runSha,
    imageLineNormalization: "s|^Image=.*|Image=<SUBSTITUTED>|",
    serverCarrierNormalizedSha256: $serverNormSha,
    runCarrierNormalizedSha256: $runNormSha
  },
  host: {
    podmanVersion: $podman, systemdVersion: $systemd, generator: $generator,
    invocation: ["-user", "-dryrun"],
    unitSource: "mode-0700 disposable QUADLET_UNIT_DIRS only",
    installed: false
  },
  fixtureSubstitution: {
    image: $image, runId: $runId, runUid: $runUid, runGid: $runGid,
    runRoot: $runRoot, workspace: $workspace
  },
  server: {
    exitCode: $serverRc, execStart: $serverExec,
    requiredTokens: $required,
    forbiddenTokens: ["--read-only=false", "--pod"]
  },
  run: {
    exitCode: $runRc, execStart: $runExec,
    requiredTokens: [
      "--network=none", "--read-only", "--read-only-tmpfs=false",
      "--user 61111:61112",
      "-v /run/paperclip-runs/run-a:/run/paperclip-run:rw,Z",
      "-v /run/paperclip-runs/run-a/workspace:/workspace:rw,Z",
      "--security-opt=no-new-privileges", "--cap-drop=all"
    ],
    forbiddenTokens: ["--read-only=false", ":/paperclip:", ":/app:"]
  },
  authorization: {
    hostMutation: false, installation: false, imageOperation: false,
    restart: false, activation: false, liveDrill: false
  }
}' > "$tmp"

[ -s "$tmp" ] || refuse empty_render "the render came out empty" "re-run; do not hand-edit"
jq -e '.server.execStart != "" and .run.execStart != ""' "$tmp" >/dev/null || \
  refuse malformed_render "the render lacks an ExecStart" "re-run; do not hand-edit"

mv "$tmp" "$OUT"

printf 'wrote %s\n' "$OUT"
printf '  candidate commit  %s\n' "$commit"
printf '  server carrier    sha256:%s\n' "$server_sha"
printf '  podman %s / systemd %s, -user -dryrun, installed: false\n\n' "$podman_version" "$systemd_version"

printf 'VERDICT — generated server legs: %s\n' "${server_legs[*]:-none}"
if [ "$n_legs" -eq 2 ] \
   && printf '%s\n' "${server_legs[@]}" | grep -Fqx systemd-paperclip \
   && printf '%s\n' "${server_legs[@]}" | grep -Fqx systemd-omniroute; then
  printf '  BOTH legs generated. The two-leg carrier is confirmed by the host\n'
  printf '  generator for the first time.\n'
else
  printf '  ** ONLY %s leg(s) GENERATED. This is the fail-green TOG-657 exists to\n' "$n_legs"
  printf '  ** catch: recreating from this carrier would drop a leg while loopback\n'
  printf '  ** /api/health stays GREEN. The render below is the honest measurement\n'
  printf '  ** and must be carried back AS IS. Do not adjust it toward two legs.\n'
fi

printf '\nNext: check this file in, then repin test_paperclip_immutable_runtime.sh\n'
printf 'at THIS render (GENERATOR_EVIDENCE_SHA256 / _CANDIDATE / _TREE / _PARENT).\n'
printf 'Repinning is correct ONLY because a generator produced these bytes just now.\n'
printf 'Repinning at the OLD render to make the hashes line up is the forbidden move.\n'
printf 'Nothing here installs, starts, pulls, restarts, deploys or authorizes anything.\n'
