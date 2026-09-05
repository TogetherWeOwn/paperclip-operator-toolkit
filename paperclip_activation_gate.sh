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
# AND THAT TRANSLATION WAS ITSELF A GUESS (TOG-1110)
# ---------------------------------------------------------------------------
# `systemd-<stem>` is Quadlet's DEFAULT, not a rule: `NetworkName=` in the
# `.network` unit overrides it. The host runs BOTH shapes at once —
# `paperclip.network` sets `NetworkName=paperclip` and podman reports the leg
# as `paperclip`, while `omniroute.network` sets nothing and reports
# `systemd-omniroute`. So the fix above reproduced the same trap one level
# down: it refused the CORRECT carrier as network_leg_mismatched, and its
# remedy steered the operator to a bare `Network=paperclip` — which renders
# the right leg, clears parity, and loses the unit ordering. Note that form
# does not begin with `systemd-`, so the prefix-matching unmanaged check waved
# it through on this very host; that check now keys off the missing `.network`
# suffix, which is what actually determines the ordering.
#
# The name is now READ (HOST_EVIDENCE .networkNames, else the shipped unit,
# else the default) and its provenance recorded. A mismatch judged against a
# GUESSED name refuses as network_name_unresolved — it is equally consistent
# with an unread override, and convicting the carrier on it is what cost the
# 2026-09-05 15:02Z host window.
#
# ===========================================================================
# SEAMS — this suite runs offline, with no podman, no host, no credentials
# ===========================================================================
#   HOST_EVIDENCE   JSON captured read-only from the host, read instead of
#                   shelling to podman. The two arrays come from two DIFFERENT
#                   namespaces and must not be conflated:
#                     .networks[]      what `podman inspect` reports — the
#                                      network's REAL name, which is
#                                      `systemd-<stem>` only by default
#                     .networkUnits[]  what `systemctl list-unit-files` reports
#                                      — `<stem>.network`, which is also the
#                                      form the carrier declares
#                     .networkNames    the JOIN between them: unit -> the
#                                      podman name it renders to, read from the
#                                      unit's `NetworkName=`. OPTIONAL, and a
#                                      unit whose name could not be read is
#                                      OMITTED, never defaulted.
#                   Shape (this host, measured 2026-09-05 — note the two legs
#                   do NOT share a naming convention):
#                     { "networks": ["paperclip", "systemd-omniroute"],
#                       "networkUnits": ["paperclip.network",
#                                        "omniroute.network"],
#                       "networkNames": {
#                         "paperclip.network": "paperclip",
#                         "omniroute.network": "systemd-omniroute" } }
#                   Capture all three with ./capture_host_evidence.sh, or by
#                   hand:
#                     podman inspect paperclip \
#                       --format '{{json .NetworkSettings.Networks}}'
#                     systemctl --user list-unit-files '*-network.service'
#                     grep NetworkName= ~/.config/containers/systemd/*.network
#                   Without .networkNames the gate falls back to Quadlet's
#                   `systemd-<stem>` DEFAULT, and refuses a mismatch as
#                   network_name_unresolved rather than blaming the carrier —
#                   because an unread `NetworkName=` override produces exactly
#                   the same mismatch as a genuinely wrong carrier.
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
#
# TOG-1110 — `systemd-<stem>` is a DEFAULT, not a rule. Quadlet:
#   NetworkName= — "the (optional) name of the Podman network. If this is not
#   specified, the default value is the same name as the unit, but with a
#   `systemd-` prefix."
# So the mapping above is only correct for a unit that does NOT set
# `NetworkName=`. Measured on this host (operator window 2026-09-05 15:42Z):
# `paperclip.network` carries `NetworkName=paperclip` and podman reports the
# leg as `paperclip`, while `omniroute.network` sets nothing and podman
# reports `systemd-omniroute`. Both shapes run side by side, so the
# unconditional prefix refused the CORRECT carrier as network_leg_mismatched —
# and that refusal's own remedy text steers the operator to a bare
# `Network=paperclip`, which loses Requires=/After= and races network creation
# at cold boot. Resolve the name; never assume it.
declare -A NETNAME_VALUE=()   # carrier key -> the podman name it renders to
declare -A NETNAME_SRC=()     # carrier key -> measured | shipped | default

# Parse a `.network` unit the way systemd resolves it, NOT with a grep.
# `grep NetworkName=` gets four things wrong, and each one flips the verdict:
#   * it matches inside [Container] or any other section, where the key does
#     not name the network;
#   * it matches a commented-out line;
#   * on repeated assignment it reports the FIRST, where systemd takes the LAST;
#   * it reports `NetworkName=` (empty) as "set to nothing", where systemd
#     treats an empty assignment as a RESET to the default — precisely the
#     difference this gate now turns on.
# Prints the effective value, or nothing at all when the default applies.
unit_effective_network_name() {  # <file>
  local line section="" key val result="" have=0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"                       # CRLF-authored units exist
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
    # A trailing backslash is a systemd line continuation. This parser does not
    # join them, and a truncated network name is the one value it exists to get
    # right — so decline to answer rather than answer wrongly.
    case "$val" in *\\) return 1 ;; esac
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    if [ -z "$val" ]; then result=""; have=0; else result="$val"; have=1; fi
  done < "$1"
  [ "$have" -eq 1 ] && printf '%s\n' "$result"
  return 0
}

# Resolve every declared key to the podman name it renders to, recording WHERE
# each answer came from. Precedence: what the host actually reported for the
# unit (measured) > the unit shipped in this repo (shipped) > Quadlet's default
# (default). A `default` answer is a guess, and the caller must not convict the
# carrier on one.
resolve_network_names() {  # <declared keys...>
  local k stem shipped v
  for k in "$@"; do
    [ -n "${NETNAME_VALUE[$k]+x}" ] && continue
    case "$k" in
      *.network) ;;
      *) NETNAME_VALUE[$k]="$k"; NETNAME_SRC[$k]=measured; continue ;;
    esac
    stem="${k%.network}"
    # 1. The host's own reading of the installed unit.
    v="$(jq -r --arg k "$k" '.networkNames[$k]? // empty' "$HOST_EVIDENCE" 2>/dev/null)"
    if [ -n "$v" ]; then
      NETNAME_VALUE[$k]="$v"; NETNAME_SRC[$k]=measured; continue
    fi
    # 2. The unit shipped in this repo, parsed as systemd would.
    shipped="$REPO/$(dirname "$CARRIER_REL")/$k"
    if [ -f "$shipped" ] && v="$(unit_effective_network_name "$shipped")"; then
      if [ -n "$v" ]; then
        NETNAME_VALUE[$k]="$v"; NETNAME_SRC[$k]=shipped; continue
      fi
      # Parsed cleanly and set nothing: the default genuinely applies.
      NETNAME_VALUE[$k]="systemd-$stem"; NETNAME_SRC[$k]=shipped; continue
    fi
    # 3. Nothing to read. Quadlet's default is the best guess available — but
    #    it is a guess, and it is recorded as one.
    NETNAME_VALUE[$k]="systemd-$stem"; NETNAME_SRC[$k]=default
  done
}

carrier_key_to_podman_network() {
  if [ -n "${NETNAME_VALUE[$1]+x}" ]; then printf '%s\n' "${NETNAME_VALUE[$1]}"; return; fi
  case "$1" in
    *.network) printf 'systemd-%s\n' "${1%.network}" ;;
    *)         printf '%s\n' "$1" ;;
  esac
}

# Every `.network` unit this run can see, from either namespace: the units the
# host reported installed, plus the units shipped in the carrier's own
# directory. A unit in either place is one Quadlet will order the service
# against, which is the only property the unmanaged-leg check turns on.
known_network_units() {
  local u f
  jq -r '.networkUnits[]?' "${HOST_EVIDENCE:-/dev/null}" 2>/dev/null
  for f in "$REPO/$(dirname "$CARRIER_REL")"/*.network; do
    [ -f "$f" ] || continue
    printf '%s\n' "${f##*/}"
  done
}

# The discriminator for a bare (non-`.network`) key: is there a unit that
# RENDERS TO this name? Prints that unit, or nothing.
#
# A bare key is only a hazard when the leg is Quadlet-managed — then the same
# leg is reachable as `<stem>.network`, and spelling it bare drops the
# Requires=/After= while still rendering the right network. Where NO unit
# renders to the name, the key names a genuine pre-existing podman network,
# which correctly has no unit and cannot be respelled into one. Refusing that
# is the over-refusal that keying on the missing `.network` suffix produced,
# and it contradicts this gate's own surviving premise below.
unit_rendering_to() {  # <podman network name>
  local want="$1" u
  local -a cand=()
  mapfile -t cand < <(known_network_units | sort -u)
  [ "${#cand[@]}" -eq 0 ] && return 1
  resolve_network_names ${cand[@]+"${cand[@]}"}
  for u in "${cand[@]}"; do
    if [ "${NETNAME_VALUE[$u]:-}" = "$want" ]; then printf '%s\n' "$u"; return 0; fi
  done
  return 1
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

  # A well-formed digest is not a safe one. The 2026-09-05 host window read a
  # candidate (the sole local `paperclip-local`, a TOG-516 v2 rebuild) that is
  # NOT the digest the service is running (a ghcr image from the 09-05 05:33Z
  # operator upgrade). Pinning the candidate is therefore an image CHANGE
  # wearing the clothes of a placeholder fill: format-valid, board-approvable,
  # and it silently rolls the running server onto a different build. Measured
  # before this check existed: pinning `80e113a4…` scored
  # `PASS [image_digest]` and said nothing about the running `f58ff8e2…`.
  #
  # The evidence carries both halves precisely so the gate can tell them
  # apart, so read them. This does NOT decide which digest is right — that is
  # the board's call — it refuses to let the difference pass unnamed.
  [ -n "${HOST_EVIDENCE:-}" ] && [ -f "$HOST_EVIDENCE" ] || return 0
  local running candidate
  running="$(jq -r '.image.running // empty' "$HOST_EVIDENCE" 2>/dev/null)"
  candidate="$(jq -r '.image.candidate // empty' "$HOST_EVIDENCE" 2>/dev/null)"
  [ -n "$running" ] || return 0
  running="${running#sha256:}"
  candidate="${candidate#sha256:}"
  if [ "$digest" = "$running" ]; then
    pass image_matches_running "pinned digest is the digest the service is already running"
    return 0
  fi
  local origin="a digest on neither the running service nor the local candidate"
  [ -n "$candidate" ] && [ "$digest" = "$candidate" ] && \
    origin="the host-local CANDIDATE image, which is not what the service is running"
  refuse image_changes_running_service \
    "carrier pins @sha256:${digest:0:12}… ($origin); the running service is on @sha256:${running:0:12}…. Installing this carrier REPLACES the running image, which is a version change, not a placeholder fill" \
    "either pin the running digest ${running:0:12}… to make this carrier a no-op on the image, or obtain board authorization that names ${digest:0:12}… as an intended image change and says so explicitly"
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
  local n u c seen found
  resolve_network_names "${declared[@]}"
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
      "add the missing Network= key(s) to $CARRIER_REL, declared as 'X.network' (the unit), never as the podman name itself. That is a carrier change and needs fresh CISO gate-1 review"
    return
  fi
  # A mismatch is only attributable to the CARRIER when every name it was
  # judged against was actually read. Where the name came from Quadlet's
  # default because no unit could be read, a mismatch is equally consistent
  # with an unread `NetworkName=` override — which is exactly the shape this
  # host runs. Convicting the carrier there is how the correct carrier got
  # refused, and how the refusal text came to recommend the boot-racing form.
  if [ "${#missing_legs[@]}" -gt 0 ] || [ "${#extra_legs[@]}" -gt 0 ]; then
    local -a guessed=()
    for n in "${declared[@]}"; do
      [ "${NETNAME_SRC[$n]:-default}" = default ] && guessed+=("$n")
    done
    if [ "${#guessed[@]}" -gt 0 ]; then
      refuse network_name_unresolved \
        "carrier legs do not match the running service, but ${#guessed[@]} key(s) (${guessed[*]}) were compared using Quadlet's DEFAULT systemd-<stem> name because no unit was readable. NetworkName= overrides that default, so this is not evidence the carrier is wrong" \
        "capture the effective NetworkName= for ${guessed[0]} into HOST_EVIDENCE .networkNames (./capture_host_evidence.sh), or ship the .network unit in $(dirname "$CARRIER_REL"). Do NOT edit the carrier's Network= keys on this refusal"
      return
    fi
    refuse network_leg_mismatched \
      "carrier legs do not match the running service. Host holds (${hostnets[*]}); carrier renders (${rendered[*]}) from keys (${declared[*]}). Not on the carrier: ${missing_legs[*]:-none}. Not on the host: ${extra_legs[*]:-none}" \
      "declare exactly the networks the running service holds, in $CARRIER_REL. Declare a leg as 'X.network' — never as the podman name itself. Which podman name that renders to is read from the unit's NetworkName=, defaulting to 'systemd-X' only when the unit sets none"
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
  #
  # TOG-1110 — the hazard is the MISSING `.network` suffix, not the `systemd-`
  # prefix, and matching on the prefix only caught the subset of bare names
  # that happen to start with it. On this host `paperclip.network` sets
  # `NetworkName=paperclip`, so the boot-racing carrier is spelled
  # `Network=paperclip`: it renders the correct leg, clears parity, and carries
  # no Requires=/After= — while never matching `systemd-*`. The prefix test
  # would wave through the precise form this gate exists to stop, on the very
  # host it guards.
  #
  # TOG-1115 — but keying on the bare suffix ALONE over-refuses in the other
  # direction. A leg the host holds as a pre-existing podman network correctly
  # has no unit, cannot be respelled as `X.network`, and is not a boot race:
  # nothing is being ordered against, because nothing generates it. Refusing it
  # contradicts the premise the unit check below still runs on.
  #
  # The property that actually separates the two is whether a unit RENDERS TO
  # this name. If one does, the same leg is reachable as that unit and the bare
  # spelling is the ordering-dropping form. If none does, the key names an
  # unmanaged network and is correct as written.
  #
  # TOG-1115 (fail-open) — "no unit renders to this name" is only a finding
  # when every candidate name was actually READ. An installed-but-unreadable
  # unit resolves to Quadlet's `systemd-<stem>` default, which by construction
  # never equals a bare key that overrides it — so a guess makes the hazard
  # look absent and ACQUITS the boot race. That is the same reasoning as
  # `network_name_unresolved` above, inverted: a guessed name must not convict
  # the carrier, and it must not exonerate it either. This is the live host
  # shape — the repo ships no `.network` units, so the discriminator rests
  # entirely on `.networkNames` having been captured.
  #
  # Resolve the candidates HERE, in the parent shell. `unit_rendering_to` runs
  # in `$( )`, so its NETNAME_SRC writes die with the subshell and a guard
  # reading them there would silently see an empty map and never fire.
  local -a cand=()
  mapfile -t cand < <(known_network_units | sort -u)
  resolve_network_names ${cand[@]+"${cand[@]}"}
  local -a unmanaged=() unmanaged_units=() unresolved=()
  for n in "${declared[@]}"; do
    is_reserved_network "$n" && continue
    case "$n" in *.network) continue ;; esac
    if u="$(unit_rendering_to "$n")"; then
      unmanaged+=("$n"); unmanaged_units+=("$u")
      continue
    fi
    # Nothing rendered to it. Believe that only if nothing was guessed.
    for c in ${cand[@]+"${cand[@]}"}; do
      if [ "${NETNAME_SRC[$c]:-default}" = default ]; then unresolved+=("$c"); fi
    done
  done
  if [ "${#unmanaged[@]}" -eq 0 ] && [ "${#unresolved[@]}" -gt 0 ]; then
    local -a uu=(); mapfile -t uu < <(printf '%s\n' "${unresolved[@]}" | sort -u)
    refuse network_name_unresolved \
      "$CARRIER_REL names podman network(s) directly and no unit appears to render them — but ${#uu[@]} installed unit(s) (${uu[*]}) could not be read, so they were resolved to Quadlet's DEFAULT systemd-<stem> name. NetworkName= overrides that default, so one of them may in fact render this leg, which would make the bare key a boot race this gate cannot see" \
      "capture the effective NetworkName= for ${uu[0]} into HOST_EVIDENCE .networkNames (./capture_host_evidence.sh), or ship the .network unit in $(dirname "$CARRIER_REL"). Do NOT edit the carrier's Network= keys on this refusal"
    return
  fi
  if [ "${#unmanaged[@]}" -gt 0 ]; then
    refuse network_leg_unmanaged \
      "$CARRIER_REL names podman network(s) directly (${unmanaged[*]}) rather than the Quadlet unit that renders them (${unmanaged_units[*]}). Quadlet emits a dependency on <stem>-network.service ONLY for a key ending in .network, so this renders the right leg with no Requires=/After= and races network creation at boot" \
      "declare ${unmanaged[0]} as ${unmanaged_units[0]} — the unit that renders that exact name — so Quadlet orders the service against it, rather than naming the network podman ends up with"
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
    # A unit may also ship in the deploy directory — but EXISTENCE IS NOT A
    # UNIT. `touch omniroute.network` satisfies `[ -f ]` and clears this gate,
    # while Quadlet generates nothing from a file with no [Network] section and
    # the service fails to start exactly as if the file were absent. That is
    # the failure mode this gate exists to stop, wearing a passing score. So
    # the shipped file only counts if it actually declares a [Network] section.
    local shipped="$REPO/deploy/paperclip-immutable/$n"
    if [ "$found" -eq 0 ] && [ -f "$shipped" ]; then
      if grep -qE '^\[Network\][[:space:]]*$' "$shipped"; then
        found=1
      else
        refuse network_unit_empty \
          "deploy/paperclip-immutable/$n exists but declares no [Network] section ($(wc -c <"$shipped") bytes). Quadlet generates nothing from it; the service fails to START exactly as if the unit were absent, while a file-existence check reads GREEN" \
          "give $n a real [Network] section, or install the unit on the host and capture it in HOST_EVIDENCE .networkUnits[]"
        missing=1
        continue
      fi
    fi
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
