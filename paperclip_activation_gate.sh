#!/usr/bin/env bash
# ===========================================================================
# paperclip_activation_gate.sh — may the TOG-657 host validation run YET?
#
# WHY THIS EXISTS. TOG-657 executes the one procedure in this company that is
# not revertible by a git revert: it stops the live Paperclip service, restores
# a database, and recreates the server container from a Quadlet carrier. Its
# own body gates it on five preconditions — fresh CISO and DevOps static
# acceptance, an exact approved image digest, reviewed backup/rollback
# commands, a maintenance window, and explicit board activation authorization.
#
# Those five lived only as prose in an issue body. Four separate runs have now
# re-derived them by hand from comments, and each re-derivation is a chance to
# read one of them as satisfied when it is not. Anything with a number in it
# belongs in a script, so the same input gives the same output forever.
#
#   ./paperclip_activation_gate.sh check --commit <sha>
#       -> exit 0   every gate passes; activation is permitted
#       -> exit 2   REFUSED, naming WHICH gate refused and what would clear it
#
# ===========================================================================
# THE AUTHORIZATION IS READ, NEVER DECLARED
# ===========================================================================
# There is no `--authorized` flag, no `--window-open` flag, and no way to
# assert from the command line that the board said yes. A gate whose green
# light is supplied by the party who wants to proceed is not a gate; it is a
# form. Authorization is read from an authorization RECORD that must name the
# exact commit and the exact image digest being activated. A record for a
# different commit does not authorize this one — which is the whole point,
# because the carrier is what changes between commits.
#
# Same principle as capability_gate.sh, and the same reason.
#
# ===========================================================================
# THE THREE TOG-654 REJECTIONS ARE ENCODED AS REGRESSION GATES
# ===========================================================================
# TOG-654 rejected the first carrier for three defects. All three were fixed in
# the TOG-655 successor and verified by hand. Hand-verification does not
# survive the next edit, so each is a gate here:
#
#   readonly_fail_open  a later `ReadOnly=/app` overrides `ReadOnly=true` and
#                       Quadlet renders `--read-only=false`. The unit generates
#                       exit 0 and the immutability it exists to provide is
#                       simply absent.
#   pod_key_unsupported `Pod=` is not supported on this host's Podman 4.9.3 and
#                       exits 1 at generation with no `paperclip.pod`.
#   tmp_undersized      4 GiB against a measured 16,402,301,140 bytes of
#                       concurrent /tmp use. Fails under load, not at install.
#
# ===========================================================================
# THE NETWORK GATE IS THE ONE THAT WOULD HAVE CAUSED AN OUTAGE
# ===========================================================================
# Measured from inside the live server container on 2026-08-30: it holds TWO
# podman networks. `paperclip-db` resolves on 10.89.0.0/24 and `omniroute` —
# the model gateway every agent run depends on, `ANTHROPIC_BASE_URL=
# http://omniroute:20129` — resolves on 10.89.1.0/24.
#
# Quadlet renders exactly one `--network=` per `Network=` key, and the carrier
# declares one. Recreating from it as written DROPS THE OMNIROUTE LEG, and
# loopback `/api/health` stays green while it happens: the server answers, the
# database answers, and every agent silently loses inference. That is the same
# failure class as the rejected `Pod=` key — generates exit 0, fails at
# runtime — except this one fails green.
#
# So the gate compares the carrier's legs against host evidence and refuses on
# a mismatch. It also refuses when a declared network has no unit to resolve
# to: `Network=paperclip.network` requires a pre-existing `paperclip.network`,
# and no `.network` unit ships in the deploy directory. Podman's reserved names
# (none/host/bridge/pasta/slirp4netns, and the container:/ns: forms) need no
# unit and are exempt.
#
# THAT COMPARISON WAS ACROSS TWO NAMESPACES, AND IT MADE THE GATE UNSATISFIABLE
# ---------------------------------------------------------------------------
# A carrier key and a podman network name are not the same string. Quadlet:
# "if the name of the network ends with .network, a Podman network called
# systemd-$name is used" — so `Network=paperclip.network` renders as
# `--network=systemd-paperclip`, exactly as the board's own generator recorded
# in `generated/board-quadlet-render.json`. Comparing the raw key against
# podman's report meant:
#
#   carrier declares            gate verdict          what would really happen
#   paperclip.network  (correct) network_leg_mismatched  correct, and REFUSED
#   systemd-paperclip            network_legs PASS       no unit -> fails to
#                                + network_unit_absent   START
#
# No carrier string could satisfy both sub-checks: the gate refused the fix and
# the refusal text recommended the broken form. Worse, `systemd-paperclip`
# renders the right leg but is a LITERAL reference — Quadlet only emits a
# dependency on `<stem>-network.service` for a `.network` key — so that carrier
# silently loses its startup ordering and races network creation at boot.
# `network_leg_unmanaged` refuses it.
#
# Every declared key is therefore translated to the name it RENDERS to before
# any comparison, and dedup is judged on the rendered name too, since two
# distinct keys can collapse to one leg.
#
# ===========================================================================
# SEAMS — this suite runs offline, with no podman, no host, no credentials
# ===========================================================================
#   HOST_EVIDENCE   JSON captured read-only from the host, read instead of
#                   shelling to podman. The two arrays come from two DIFFERENT
#                   namespaces and must not be conflated:
#                     .networks[]      what `podman inspect` reports —
#                                      Quadlet's generated `systemd-<stem>`
#                     .networkUnits[]  what `systemctl list-unit-files` reports
#                                      — `<stem>.network`, which is also the
#                                      form the carrier declares
#                   Shape:
#                     { "networks": ["systemd-paperclip", "systemd-omniroute"],
#                       "networkUnits": ["paperclip.network",
#                                        "omniroute.network"] }
#                   Capture both with:
#                     podman inspect paperclip \
#                       --format '{{json .NetworkSettings.Networks}}'
#                     systemctl --user list-unit-files '*-network.service'
#   ACTIVATION_NOW  unix seconds, read instead of `date -u +%s`, so the
#                   maintenance-window gate is deterministic under test.
# ===========================================================================
set -uo pipefail

ME="$(basename "${BASH_SOURCE[0]}")"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

EXIT_OK=0; EXIT_REFUSED=2; EXIT_USAGE=3

# The measured figure the /tmp sizing must clear, from TOG-654 host capture.
TMP_MEASURED_BYTES=16402301140
# Minimum headroom over the measured figure. 24 GiB against 16,402,301,140 is
# +57.1%; this floor is set below that so the gate states a requirement rather
# than merely restating today's value.
TMP_MIN_HEADROOM_PCT=25

CARRIER_REL="deploy/paperclip-immutable/paperclip.container"
RUNCARRIER_REL="deploy/paperclip-immutable/agent-run.container.in"
RENDER_REL="deploy/paperclip-immutable/generated/board-quadlet-render.json"
RUNBOOK_REL="docs/paperclip-immutable-application-tree.md"

# Podman network names that resolve without a .network unit.
is_reserved_network() {
  case "$1" in
    none|host|bridge|pasta|slirp4netns) return 0 ;;
    container:*|ns:*) return 0 ;;
    *) return 1 ;;
  esac
}

# A carrier `Network=` key and a `podman inspect` network name are two DIFFERENT
# namespaces, and comparing them directly is why this gate could not be
# satisfied by any carrier at all.
#
# Quadlet: "If the name of the network ends with .network, a Podman network
# called systemd-$name is used." So `Network=paperclip.network` RENDERS as
# `--network=systemd-paperclip` — which is exactly what the board's own
# generator produced in board-quadlet-render.json:
#     "--network=systemd-paperclip"
# from a carrier whose only key is `Network=paperclip.network`.
#
# Comparing the raw key against podman's name refused the CORRECT carrier
# (network_leg_mismatched), while rewriting the carrier to name podman's
# networks directly passed leg parity and then failed to START, because
# `systemd-paperclip` is a generated name with no unit behind it. Both
# directions were wrong, so the gate translated to podman's namespace before
# comparing. A `.network` suffix maps to systemd-<stem>; any other value is a
# pre-existing podman network and is already in podman's namespace.
carrier_key_to_podman_network() {
  case "$1" in
    *.network) printf 'systemd-%s\n' "${1%.network}" ;;
    *)         printf '%s\n' "$1" ;;
  esac
}

c_red()  { if [ -t 1 ]; then printf '\033[31m%s\033[0m\n' "$*"; else printf '%s\n' "$*"; fi; }
c_grn()  { if [ -t 1 ]; then printf '\033[32m%s\033[0m\n' "$*"; else printf '%s\n' "$*"; fi; }

REFUSALS=0
# refuse <gate-id> <what is wrong> <what would clear it>
refuse() {
  REFUSALS=$((REFUSALS+1))
  c_red "REFUSED [$1]"
  printf '    what is wrong: %s\n' "$2"
  printf '    what clears it: %s\n' "$3"
}
pass() { c_grn "  PASS  [$1] $2"; }

usage() {
  cat <<EOF
$ME — the TOG-657 host-validation activation gate.

  $ME check --commit <sha> [--auth <record.json>] [--repo <dir>]

  Exits 0 only when every precondition in the TOG-657 body is satisfied.
  Exits $EXIT_REFUSED naming which gate refused. There is no flag that
  asserts authorization; it is read from the record.

Seams: HOST_EVIDENCE=<json>  ACTIVATION_NOW=<unix-seconds>
EOF
}

# --- gate: the image digest is real -------------------------------------
# The carrier ships a deliberate placeholder. An operator who forgets to fill
# it gets a unit that generates exit 0 and pulls nothing resolvable.
gate_digest() {
  local carrier="$1" line digest
  line="$(grep -m1 '^Image=' "$carrier" 2>/dev/null)" || true
  if [ -z "$line" ]; then
    refuse image_digest_missing "no Image= key in $CARRIER_REL" \
      "add Image=<name>@sha256:<64 hex>"
    return
  fi
  digest="${line##*@sha256:}"
  if [ "$digest" = "$line" ]; then
    refuse image_not_digest_pinned "Image= is not pinned by @sha256: digest — a tag is mutable" \
      "pin the approved immutable digest: Image=<name>@sha256:<64 hex>"
    return
  fi
  if [[ "$digest" == *REPLACE_WITH_APPROVED_IMAGE_DIGEST* ]]; then
    refuse image_digest_placeholder \
      "Image= still carries the REPLACE_WITH_APPROVED_IMAGE_DIGEST placeholder" \
      "the board must supply the exact approved digest; only then is this carrier installable"
    return
  fi
  if ! [[ "$digest" =~ ^[0-9a-f]{64}$ ]]; then
    refuse image_digest_malformed "Image= digest is not 64 lowercase hex: '$digest'" \
      "supply a full sha256 digest"
    return
  fi
  pass image_digest "pinned to @sha256:${digest:0:12}…"
  printf '%s' "$digest" > "$TMP/digest"
}

# --- gate: ReadOnly does not fail open (TOG-654 rejection 1) --------------
gate_readonly() {
  local f="$1" name="$2" whole path
  whole="$(grep -c '^ReadOnly=true[[:space:]]*$' "$f")"
  path="$(grep -c '^ReadOnly=/' "$f")"
  if [ "$path" -ne 0 ]; then
    refuse readonly_fail_open \
      "$name declares a path-valued ReadOnly= ($path); a later one overrides ReadOnly=true and Quadlet renders --read-only=false" \
      "keep exactly one whole-root ReadOnly=true and no ReadOnly=/… line"
    return
  fi
  if [ "$whole" -ne 1 ]; then
    refuse readonly_not_whole_root \
      "$name has $whole whole-root ReadOnly=true keys, expected exactly 1" \
      "declare ReadOnly=true exactly once"
    return
  fi
  pass readonly "$name: exactly one whole-root ReadOnly=true, no path-valued override"
}

# --- gate: no Pod= key (TOG-654 rejection 2) ------------------------------
gate_pod() {
  local f="$1" name="$2" n
  n="$(grep -c '^Pod=' "$f")"
  if [ "$n" -ne 0 ]; then
    refuse pod_key_unsupported \
      "$name declares Pod=; unsupported on this host's Podman 4.9.3, generation exits 1" \
      "use Network= instead, as the TOG-655 successor does"
    return
  fi
  pass pod_key "$name: no Pod= key"
}

# --- gate: /tmp is sized over the measured figure (TOG-654 rejection 3) ---
gate_tmp_size() {
  local f="$1" spec bytes want
  spec="$(grep -m1 '^Tmpfs=/tmp:' "$f" | grep -o 'size=[0-9]*[gGmM]' | head -1)" || true
  if [ -z "$spec" ]; then
    refuse tmp_unsized "$CARRIER_REL has no size= on its /tmp tmpfs" \
      "size /tmp above the measured $TMP_MEASURED_BYTES bytes"
    return
  fi
  local num unit
  num="$(printf '%s' "$spec" | tr -dc '0-9')"
  unit="$(printf '%s' "$spec" | tr -dc 'gGmM')"
  case "$unit" in
    g|G) bytes=$(( num * 1024 * 1024 * 1024 )) ;;
    m|M) bytes=$(( num * 1024 * 1024 )) ;;
    *)   refuse tmp_unit_unknown "unrecognised size unit in '$spec'" "use g or m"; return ;;
  esac
  want=$(( TMP_MEASURED_BYTES + TMP_MEASURED_BYTES * TMP_MIN_HEADROOM_PCT / 100 ))
  if [ "$bytes" -lt "$want" ]; then
    refuse tmp_undersized \
      "/tmp is $bytes bytes; measured concurrent use is $TMP_MEASURED_BYTES and the floor is +${TMP_MIN_HEADROOM_PCT}% = $want" \
      "raise the /tmp tmpfs size= above $want bytes"
    return
  fi
  local pct=$(( (bytes - TMP_MEASURED_BYTES) * 100 / TMP_MEASURED_BYTES ))
  pass tmp_size "/tmp $bytes bytes, +${pct}% over measured"
}

# --- gate: network legs, and every declared network resolves --------------
# The gate that would have caused an outage. See the header.
gate_networks() {
  local f="$1" declared host_n
  mapfile -t declared < <(grep '^Network=' "$f" | sed 's/^Network=//')
  if [ "${#declared[@]}" -eq 0 ]; then
    refuse network_undeclared "$CARRIER_REL declares no Network= key" \
      "declare one Network= per leg the running service holds"
    return
  fi

  if [ -z "${HOST_EVIDENCE:-}" ] || [ ! -f "${HOST_EVIDENCE:-}" ]; then
    refuse host_evidence_missing \
      "no host evidence to compare the carrier's ${#declared[@]} declared network leg(s) against" \
      "capture HOST_EVIDENCE read-only: podman inspect paperclip --format '{{json .NetworkSettings.Networks}}' plus the installed .network units"
    return
  fi

  # Leg parity, judged on IDENTITY rather than on how many keys are present.
  # Podman renders one --network= per key and de-duplicates by name, so a
  # carrier that repeats a name reaches an equal COUNT while still rendering
  # fewer real legs. Counting keys would score that carrier as correct and
  # authorize the very recreation that drops the OmniRoute leg.
  mapfile -t hostnets < <(jq -r '.networks[]?' "$HOST_EVIDENCE" 2>/dev/null)
  host_n="${#hostnets[@]}"
  if [ "$host_n" -eq 0 ]; then
    refuse host_evidence_unreadable "HOST_EVIDENCE has no .networks[] array" \
      "capture it in the documented shape"
    return
  fi

  # Translate every declared key into the podman name it RENDERS to before
  # comparing against podman's own report. Dedup must also be judged on the
  # rendered name: `Network=paperclip.network` and `Network=systemd-paperclip`
  # are two distinct keys that render to ONE leg, so comparing raw keys would
  # miss that collapse exactly as counting keys missed a repeated name.
  local -a rendered=()
  local n u seen found
  for n in "${declared[@]}"; do
    rendered+=("$(carrier_key_to_podman_network "$n")")
  done

  local -a uniq=() dupes=()
  for n in "${rendered[@]}"; do
    seen=0
    for u in ${uniq[@]+"${uniq[@]}"}; do [ "$u" = "$n" ] && seen=1 && break; done
    if [ "$seen" -eq 1 ]; then dupes+=("$n"); else uniq+=("$n"); fi
  done
  if [ "${#dupes[@]}" -gt 0 ]; then
    refuse network_leg_duplicated \
      "$CARRIER_REL declares ${#declared[@]} Network= key(s) (${declared[*]}) that render to only ${#uniq[@]} real leg(s) against a $host_n-leg host — '${dupes[0]}' is named twice. Reaching leg parity on arithmetic while still dropping a leg" \
      "give each leg its own distinct Network= name, one per network the running service holds"
    return
  fi

  # Each declared leg must render to a network the running service actually
  # holds. Equal counts of different names is not the running topology.
  local -a missing_legs=() extra_legs=()
  for n in "${hostnets[@]}"; do
    found=0
    for u in "${rendered[@]}"; do [ "$u" = "$n" ] && found=1 && break; done
    [ "$found" -eq 0 ] && missing_legs+=("$n")
  done
  local i=0
  for n in "${rendered[@]}"; do
    if is_reserved_network "${declared[$i]}"; then i=$((i+1)); continue; fi
    found=0
    for u in "${hostnets[@]}"; do [ "$u" = "$n" ] && found=1 && break; done
    # Report the carrier's own key alongside what it renders to, so the
    # refusal names the line the operator has to edit.
    [ "$found" -eq 0 ] && extra_legs+=("${declared[$i]} (renders ${n})")
    i=$((i+1))
  done

  if [ "${#missing_legs[@]}" -gt 0 ] && [ "${#uniq[@]}" -lt "$host_n" ]; then
    refuse network_leg_dropped \
      "carrier renders ${#uniq[@]} network leg(s); the running service holds $host_n (${hostnets[*]}). Recreating drops ${#missing_legs[@]} (${missing_legs[*]}) — loopback /api/health stays GREEN while every agent loses its model gateway" \
      "add the missing Network= key(s) to $CARRIER_REL. A leg podman reports as 'systemd-X' is declared as 'X.network'. That is a carrier change and needs fresh CISO gate-1 review"
    return
  fi
  if [ "${#missing_legs[@]}" -gt 0 ] || [ "${#extra_legs[@]}" -gt 0 ]; then
    refuse network_leg_mismatched \
      "carrier legs do not match the running service. Host holds (${hostnets[*]}); carrier renders (${rendered[*]}) from keys (${declared[*]}). Not on the carrier: ${missing_legs[*]:-none}. Not on the host: ${extra_legs[*]:-none}" \
      "declare exactly the networks the running service holds, in $CARRIER_REL. A leg podman reports as 'systemd-X' is declared as 'X.network', not as 'systemd-X'"
    return
  fi
  pass network_legs "carrier renders $host_n distinct leg(s), matching the running service by name"

  # Naming podman's GENERATED name directly reaches the right leg and silently
  # drops the startup ordering. Quadlet only emits a dependency on
  # `<stem>-network.service` when the key ends in `.network`; a bare name is a
  # literal reference with no Requires=/After=. The container then races the
  # network's creation at boot — it works whenever the network happens to
  # already exist, which is every manual test and not necessarily a cold boot.
  # This is the form the old refusal text actively recommended.
  local -a unmanaged=()
  for n in "${declared[@]}"; do
    is_reserved_network "$n" && continue
    case "$n" in
      systemd-*) unmanaged+=("$n") ;;
    esac
  done
  if [ "${#unmanaged[@]}" -gt 0 ]; then
    refuse network_leg_unmanaged \
      "$CARRIER_REL names podman's generated network(s) directly (${unmanaged[*]}). Quadlet emits a dependency on <stem>-network.service ONLY for a key ending in .network, so this renders the right leg with no Requires=/After= and races network creation at boot" \
      "declare ${unmanaged[0]} as ${unmanaged[0]#systemd-}.network so Quadlet orders the unit, rather than naming the generated network"
    return
  fi

  # A `.network` key is Quadlet-managed and needs a unit to resolve to, or the
  # service generates cleanly and fails to start. A key WITHOUT that suffix
  # names a pre-existing podman network and correctly has no unit — demanding
  # one there is what made this gate unsatisfiable, since the only way to
  # satisfy leg parity under the old raw comparison was to write podman's
  # generated `systemd-*` name, which by construction has no unit behind it.
  # Its existence is already proven by the parity check above.
  mapfile -t units < <(jq -r '.networkUnits[]?' "$HOST_EVIDENCE" 2>/dev/null)
  local missing=0 n u found
  for n in "${declared[@]}"; do
    is_reserved_network "$n" && continue
    case "$n" in *.network) ;; *) continue ;; esac
    found=0
    for u in "${units[@]}"; do [ "$u" = "$n" ] && found=1 && break; done
    # A unit may also ship in the deploy directory.
    [ -f "$REPO/deploy/paperclip-immutable/$n" ] && found=1
    if [ "$found" -eq 0 ]; then
      refuse network_unit_absent \
        "Network=$n has no .network unit — none installed on the host and none shipped in deploy/paperclip-immutable/. The service generates cleanly and fails to START" \
        "ship or install a $n unit before activation"
      missing=1
    fi
  done
  [ "$missing" -eq 0 ] && pass network_units "every declared network resolves to a unit"
}

# --- gate: the backup/rollback runbook is present and fail-closed ---------
gate_runbook() {
  local d="$1" n
  if [ ! -f "$d" ]; then
    refuse runbook_absent "$RUNBOOK_REL not found" "restore the host backup/rollback procedure"
    return
  fi
  n="$(grep -cE 'pg_dump|systemctl|podman |tar -' "$d")"
  if [ "$n" -lt 10 ]; then
    refuse runbook_commands_missing \
      "$RUNBOOK_REL holds only $n backup/rollback commands; the successor rewrite once dropped the procedure to 0" \
      "restore the six-step host procedure with a database-consistent dump and a restore drill"
    return
  fi
  pass runbook_commands "$n backup/rollback commands present"

  # A redaction pipeline under `set -eu` without pipefail fails OPEN: jq exits
  # 0 on empty stdin, so a failed capture writes a 0-byte evidence file and the
  # procedure continues. Measured on this runbook; see TOG-710.
  if ! grep -q 'pipefail' "$d"; then
    refuse runbook_fail_open \
      "$RUNBOOK_REL sets no pipefail; a failed capture piped through jq exits 0 and leaves a 0-byte evidence file that every absence check passes" \
      "add 'set -o pipefail' to the runbook preamble"
    return
  fi
  pass runbook_fail_closed "pipefail set; capture failures halt instead of writing empty evidence"

  # Secrets must not reach retained evidence.
  local bare
  bare="$(grep -cE 'podman inspect[^|]*>[^|]*$' "$d")" || true
  if [ "${bare:-0}" -gt 0 ]; then
    refuse runbook_credential_leak \
      "$bare whole-object 'podman inspect' redirect(s) retain .Config.Env — EnvironmentFile secrets land in evidence" \
      "pipe through jq 'del(.[].Config.Env, .[].Config.Annotations)' at capture"
    return
  fi
  pass runbook_redaction "no unredacted whole-object podman inspect capture"
}

# --- gate: board activation authorization, read from the record ----------
gate_authorization() {
  local commit="$1" rec="${2:-}"
  if [ -z "$rec" ]; then
    refuse activation_unauthorized \
      "no board activation authorization record supplied. TOG-657 authorizes no install, image operation, Quadlet change, restart, deployment, restore, or live denial attempt without one" \
      "the board records authorization naming this exact commit and digest; pass it with --auth"
    return
  fi
  if [ ! -f "$rec" ]; then
    refuse activation_record_absent "authorization record '$rec' not found" "supply the recorded authorization"
    return
  fi
  local a_commit a_digest a_from a_to
  a_commit="$(jq -r '.commit // empty' "$rec" 2>/dev/null)"
  a_digest="$(jq -r '.imageDigest // empty' "$rec" 2>/dev/null)"
  a_from="$(jq -r '.window.from // empty' "$rec" 2>/dev/null)"
  a_to="$(jq -r '.window.to // empty' "$rec" 2>/dev/null)"

  if [ -z "$a_commit" ]; then
    refuse activation_record_malformed "authorization record names no .commit" \
      "an authorization that names no commit authorizes no particular carrier"
    return
  fi
  if [ "$a_commit" != "$commit" ]; then
    refuse activation_commit_mismatch \
      "authorization is for commit $a_commit; the carrier under check is $commit. The carrier is exactly what changes between commits" \
      "obtain authorization naming $commit, or check the commit that was authorized"
    return
  fi
  # The digest is the other half: same commit, different image is a different
  # deployment.
  if [ -f "$TMP/digest" ]; then
    local actual; actual="$(cat "$TMP/digest")"
    if [ -n "$a_digest" ] && [ "$a_digest" != "$actual" ] && [ "$a_digest" != "sha256:$actual" ]; then
      refuse activation_digest_mismatch \
        "authorization names image digest $a_digest; the carrier pins $actual" \
        "authorize the digest actually being installed"
      return
    fi
  fi

  # Maintenance window.
  local now="${ACTIVATION_NOW:-$(date -u +%s)}"
  if [ -n "$a_from" ] && [ -n "$a_to" ]; then
    local f t
    f="$(date -u -d "$a_from" +%s 2>/dev/null)" || f=""
    t="$(date -u -d "$a_to" +%s 2>/dev/null)" || t=""
    if [ -z "$f" ] || [ -z "$t" ]; then
      refuse window_unparseable "maintenance window '$a_from'..'$a_to' is not parseable" \
        "use an ISO-8601 UTC instant"
      return
    fi
    if [ "$now" -lt "$f" ] || [ "$now" -gt "$t" ]; then
      refuse outside_maintenance_window \
        "now ($(date -u -d "@$now" +%Y-%m-%dT%H:%M:%SZ)) is outside the authorized window $a_from .. $a_to" \
        "run inside the window, or obtain a new one"
      return
    fi
    pass maintenance_window "inside $a_from .. $a_to"
  else
    refuse window_undeclared "authorization record declares no .window.from/.window.to" \
      "an activation without a maintenance window has no agreed blast radius"
    return
  fi

  # Both static acceptances.
  local ciso devops
  ciso="$(jq -r '.staticAcceptance.ciso // empty' "$rec" 2>/dev/null)"
  devops="$(jq -r '.staticAcceptance.devops // empty' "$rec" 2>/dev/null)"
  if [ "$ciso" != "$commit" ] || [ "$devops" != "$commit" ]; then
    refuse static_acceptance_stale \
      "static acceptance must name this exact commit; got ciso='$ciso' devops='$devops' for $commit" \
      "both CISO and DevOps re-accept the carrier at $commit. Acceptance of an earlier commit is not acceptance of this one"
    return
  fi
  pass static_acceptance "CISO and DevOps both accepted $commit"
  pass activation_authorized "board authorization binds commit and digest"
}

cmd_check() {
  local commit="" auth="" repo="$HERE"
  while [ $# -gt 0 ]; do
    case "$1" in
      --commit) commit="${2:-}"; shift 2 ;;
      --auth)   auth="${2:-}"; shift 2 ;;
      --repo)   repo="${2:-}"; shift 2 ;;
      *) usage >&2; exit $EXIT_USAGE ;;
    esac
  done
  [ -n "$commit" ] || { echo "$ME: --commit is required" >&2; exit $EXIT_USAGE; }
  REPO="$repo"

  local carrier="$repo/$CARRIER_REL" runcarrier="$repo/$RUNCARRIER_REL" runbook="$repo/$RUNBOOK_REL"
  for f in "$carrier" "$runcarrier"; do
    [ -f "$f" ] || { echo "$ME: missing $f" >&2; exit $EXIT_USAGE; }
  done

  printf 'TOG-657 activation gate — carrier %s\n\n' "$commit"

  gate_digest    "$carrier"
  gate_readonly  "$carrier"    "$CARRIER_REL"
  gate_readonly  "$runcarrier" "$RUNCARRIER_REL"
  gate_pod       "$carrier"    "$CARRIER_REL"
  gate_pod       "$runcarrier" "$RUNCARRIER_REL"
  gate_tmp_size  "$carrier"
  gate_networks  "$carrier"
  gate_runbook   "$runbook"
  gate_authorization "$commit" "$auth"

  echo
  if [ "$REFUSALS" -ne 0 ]; then
    c_red "ACTIVATION REFUSED — $REFUSALS gate(s) refused."
    echo "This gate authorizes no install, image operation, Quadlet change, restart,"
    echo "deployment, restore, or live denial attempt."
    exit $EXIT_REFUSED
  fi
  c_grn "ALL GATES PASS — the TOG-657 host validation is authorized to proceed."
  exit $EXIT_OK
}

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
REPO="$HERE"

case "${1:-}" in
  check) shift; cmd_check "$@" ;;
  -h|--help|"") usage; [ -n "${1:-}" ] && exit $EXIT_OK || exit $EXIT_USAGE ;;
  *) usage >&2; exit $EXIT_USAGE ;;
esac
