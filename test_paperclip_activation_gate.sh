#!/usr/bin/env bash
# ===========================================================================
# Offline regression suite for paperclip_activation_gate.sh (TOG-657).
# NO PODMAN, NO HOST, NO DATABASE, NO CREDENTIALS, NO NETWORK.
#
# EVERY REFUSAL IS ASSERTED BY THE GATE THAT FIRED, NOT BY EXIT STATUS.
# ---------------------------------------------------------------------------
# This gate is fail-closed on nearly every input, so an assertion of the form
# "rc != 0" passes for almost any fixture — including one that never reaches
# the gate under test. `refuses_because` takes the gate id and FAILS if a
# different gate refused. Section 9 then does the reverse: it deletes each
# gate in a staging copy and asserts the test naming it goes RED, so a control
# that quietly stops doing anything cannot keep a green suite.
#
# SEAMS
#   HOST_EVIDENCE   JSON read instead of shelling to podman
#   ACTIVATION_NOW  unix seconds read instead of `date -u +%s`
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v jq >/dev/null || { echo "ERROR: jq required" >&2; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
G="$HERE/paperclip_activation_gate.sh"

PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

GOOD_COMMIT="208cdff3a28cbda8173e29185a4639f0d6a51ed4"
GOOD_DIGEST="23090eb60885f130d460562c401e7b65789e42400c71708ecfcb6be5d6cfa936"

# refuses_because <desc> <gate-id> <cmd...>
refuses_because() {
  local d="$1" why="$2"; shift 2
  local o; o="$("$@" 2>&1)"; local rc=$?
  if [[ $rc -eq 0 ]]; then bad "$d — was ALLOWED (rc=0)"; return; fi
  if ! grep -q REFUSED <<<"$o"; then bad "$d — non-zero but not a refusal (rc=$rc)"; sed 's/^/        /' <<<"$o" | head -3; return; fi
  if grep -qF -- "[$why]" <<<"$o"; then ok "$d"
  else bad "$d — refused by the WRONG gate; wanted [$why]"; grep REFUSED <<<"$o" | sed 's/^/        /' | head -4; fi
}
allows() { local d="$1"; shift; local o; o="$("$@" 2>&1)"; local rc=$?
  if [[ $rc -eq 0 ]]; then ok "$d"; else bad "$d (rc=$rc)"; grep -A2 REFUSED <<<"$o" | sed 's/^/        /' | head -6; fi; }
says() { local d="$1" want="$2"; shift 2
  local o; o="$("$@" 2>&1)"
  if grep -qF -- "$want" <<<"$o"; then ok "$d"
  else bad "$d — output lacked '$want'"; sed 's/^/        /' <<<"$o" | head -4; fi; }

# --- fixture builders ----------------------------------------------------
# A repo laid out like the real one, with every gate passing by default. Each
# test then breaks exactly one thing, so a refusal is attributable.
mkrepo() {
  local r="$1"; shift
  mkdir -p "$r/deploy/paperclip-immutable/generated" "$r/docs"
  cat > "$r/deploy/paperclip-immutable/paperclip.container" <<EOF
[Container]
Image=paperclip-local@sha256:$GOOD_DIGEST
ContainerName=paperclip
Network=paperclip.network
Network=omniroute.network
ReadOnly=true
ReadOnlyTmpfs=false
Tmpfs=/tmp:rw,nosuid,nodev,noexec,size=24g,mode=1777
EOF
  cat > "$r/deploy/paperclip-immutable/agent-run.container.in" <<EOF
[Container]
Image=@AGENT_IMAGE_DIGEST@
Network=none
ReadOnly=true
EOF
  cat > "$r/docs/paperclip-immutable-application-tree.md" <<'EOF'
# runbook
set -euo pipefail
pg_dump --serializable-deferrable ...
systemctl --user stop paperclip
podman inspect paperclip | jq 'del(.[].Config.Env, .[].Config.Annotations)' > a.json
tar -czf backup.tgz .
podman inspect paperclip --format '{{.State.Status}}'
systemctl --user start paperclip
podman rm -f paperclip
pg_dump -Fc
tar -tzf backup.tgz
systemctl --user daemon-reload
podman image inspect x
EOF
  # Real units, not `touch`ed placeholders. An empty file satisfies `[ -f ]`
  # while Quadlet generates nothing from it, so a fixture built with `touch`
  # would pin the very fail-open the gate is supposed to refuse.
  mkunit "$r/deploy/paperclip-immutable/paperclip.network" systemd-paperclip
  mkunit "$r/deploy/paperclip-immutable/omniroute.network" systemd-omniroute
}

# A `.network` unit that actually declares a [Network] section.
mkunit() {  # <path> <networkname>
  printf '[Unit]\nDescription=%s leg\n\n[Network]\nNetworkName=%s\n' "$2" "$2" > "$1"
}

# Host evidence is captured from TWO different namespaces, and conflating them
# is the bug this fixture now pins. `.networks[]` is what `podman inspect`
# reports — Quadlet's generated `systemd-<stem>` names. `.networkUnits[]` is
# what `systemctl list-unit-files` reports — the `<stem>.network` unit names,
# which is also what the carrier declares.
mkevidence() {  # <file> <unit-stem...>   e.g. mkevidence f paperclip omniroute
  local f="$1"; shift
  local nets units
  nets="$(printf 'systemd-%s\n' "$@" | jq -R . | jq -s .)"
  units="$(printf '%s.network\n' "$@" | jq -R . | jq -s .)"
  jq -n --argjson n "$nets" --argjson u "$units" \
    '{networks:$n, networkUnits:$u}' > "$f"
}

mkauth() {  # <file> <commit> <digest> <from> <to> [ciso] [devops]
  jq -n --arg c "$2" --arg d "$3" --arg f "$4" --arg t "$5" \
        --arg ci "${6:-$2}" --arg de "${7:-$2}" \
    '{commit:$c, imageDigest:$d, window:{from:$f,to:$t},
      staticAcceptance:{ciso:$ci, devops:$de}}' > "$1"
}

R="$TMP/repo"; mkrepo "$R"
EV="$TMP/ev.json"; mkevidence "$EV" paperclip omniroute
AUTH="$TMP/auth.json"; mkauth "$AUTH" "$GOOD_COMMIT" "$GOOD_DIGEST" \
  "2026-09-01T02:00:00Z" "2026-09-01T06:00:00Z"
# Inside the window.
NOW=$(date -u -d "2026-09-01T03:00:00Z" +%s)

run() { HOST_EVIDENCE="$EV" ACTIVATION_NOW="$NOW" "$G" check --repo "$R" "$@"; }

hdr "1. The happy path — every precondition satisfied"
allows "a fully authorized, fully repaired carrier passes" \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"

hdr "2. The image digest is real, not a placeholder"
cp "$R/deploy/paperclip-immutable/paperclip.container" "$TMP/carrier.bak"
sed -i "s/$GOOD_DIGEST/REPLACE_WITH_APPROVED_IMAGE_DIGEST/" "$R/deploy/paperclip-immutable/paperclip.container"
refuses_because "the shipped placeholder digest is refused" image_digest_placeholder \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
says "the refusal says the board must supply the digest" "the board must supply the exact approved digest" \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
sed -i "s|Image=.*|Image=paperclip-local:latest|" "$R/deploy/paperclip-immutable/paperclip.container"
refuses_because "a mutable tag is refused" image_not_digest_pinned \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
sed -i "s|Image=.*|Image=paperclip-local@sha256:abc123|" "$R/deploy/paperclip-immutable/paperclip.container"
refuses_because "a short/malformed digest is refused" image_digest_malformed \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
cp "$TMP/carrier.bak" "$R/deploy/paperclip-immutable/paperclip.container"

hdr "2b. A well-formed digest that is not the RUNNING one is an image CHANGE"
# The 2026-09-05 host window read a candidate digest (the sole local
# `paperclip-local`, a TOG-516 v2 rebuild) that is NOT what the service runs
# (a ghcr image from that morning's operator upgrade). Before this gate,
# pinning the candidate scored `PASS [image_digest]` and said nothing — a
# format check cannot tell a placeholder fill from a version roll.
#
# The fixtures above carry no `.image` at all, which is why the whole suite
# stayed green when this gate was added. So build evidence that HAS one.
EVIMG="$TMP/ev-image.json"
RUNNING_DIGEST="f58ff8e28757eaaf1f58b7ae608e56f2a473fd0688aaab2dbade8c392fad0758"
CANDIDATE_DIGEST="80e113a4fd811d0e0ed4e4df63a97d1d584d282ce254bdb7209f3437f8b26f9f"
mkevidence "$EVIMG" paperclip omniroute
jq --arg r "$RUNNING_DIGEST" --arg c "$CANDIDATE_DIGEST" \
   '.image = {name:"localhost/paperclip-local:t", candidate:$c, running:$r, matchesRunning:false}' \
   "$EVIMG" > "$EVIMG.t" && mv "$EVIMG.t" "$EVIMG"
runimg() { HOST_EVIDENCE="$EVIMG" ACTIVATION_NOW="$NOW" "$G" check --repo "$R" "$@"; }

cp "$R/deploy/paperclip-immutable/paperclip.container" "$TMP/carrier2.bak"
sed -i "s|^Image=.*|Image=paperclip-local@sha256:$CANDIDATE_DIGEST|" "$R/deploy/paperclip-immutable/paperclip.container"
refuses_because "pinning the host CANDIDATE digest is refused as an image change" \
  image_changes_running_service runimg --commit "$GOOD_COMMIT" --auth "$AUTH"
says "the refusal names the running digest the operator would be replacing" \
  "${RUNNING_DIGEST:0:12}" runimg --commit "$GOOD_COMMIT" --auth "$AUTH"
says "the refusal identifies the pin as the host-local candidate" \
  "the host-local CANDIDATE image" runimg --commit "$GOOD_COMMIT" --auth "$AUTH"

# A third digest matching neither must refuse too — otherwise the gate is only
# a candidate-detector, and any other typo'd or stale digest sails through.
sed -i "s|^Image=.*|Image=paperclip-local@sha256:$(printf 'b%.0s' {1..64})|" "$R/deploy/paperclip-immutable/paperclip.container"
refuses_because "a digest matching neither running nor candidate is refused" \
  image_changes_running_service runimg --commit "$GOOD_COMMIT" --auth "$AUTH"

# Pinning what is ALREADY running is the no-op case and must pass, or the gate
# would make the carrier permanently unsatisfiable.
sed -i "s|^Image=.*|Image=paperclip-local@sha256:$RUNNING_DIGEST|" "$R/deploy/paperclip-immutable/paperclip.container"
AUTHRUN="$TMP/auth-running.json"
mkauth "$AUTHRUN" "$GOOD_COMMIT" "$RUNNING_DIGEST" \
  "2026-09-01T02:00:00Z" "2026-09-01T06:00:00Z"
allows "pinning the digest the service already runs passes" \
  runimg --commit "$GOOD_COMMIT" --auth "$AUTHRUN"
says "and it says so positively, not by silence" \
  "[image_matches_running]" runimg --commit "$GOOD_COMMIT" --auth "$AUTHRUN"

# Evidence without an .image section must not start refusing: the older
# capture format predates the candidate/running split, and a gate that
# refuses on missing evidence would block on data the operator cannot supply
# without another host window.
allows "evidence with no .image section still passes (degrades, does not refuse)" \
  run --commit "$GOOD_COMMIT" --auth "$AUTHRUN"
cp "$TMP/carrier2.bak" "$R/deploy/paperclip-immutable/paperclip.container"

hdr "3. TOG-654 rejection 1 — ReadOnly must not fail open"
cp "$R/deploy/paperclip-immutable/paperclip.container" "$TMP/c2.bak"
echo 'ReadOnly=/app' >> "$R/deploy/paperclip-immutable/paperclip.container"
refuses_because "a path-valued ReadOnly= override is refused" readonly_fail_open \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
says "the refusal explains the --read-only=false render" "renders --read-only=false" \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
cp "$TMP/c2.bak" "$R/deploy/paperclip-immutable/paperclip.container"
sed -i '/^ReadOnly=true$/d' "$R/deploy/paperclip-immutable/paperclip.container"
refuses_because "a carrier with no whole-root ReadOnly=true is refused" readonly_not_whole_root \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
cp "$TMP/c2.bak" "$R/deploy/paperclip-immutable/paperclip.container"
# The RUN carrier is gated too, not just the server one.
echo 'ReadOnly=/app' >> "$R/deploy/paperclip-immutable/agent-run.container.in"
refuses_because "the agent-run carrier is gated on ReadOnly too" readonly_fail_open \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
sed -i '/^ReadOnly=\/app$/d' "$R/deploy/paperclip-immutable/agent-run.container.in"

hdr "4. TOG-654 rejection 2 — the Pod= key is unsupported here"
echo 'Pod=paperclip.pod' >> "$R/deploy/paperclip-immutable/paperclip.container"
refuses_because "a Pod= key is refused" pod_key_unsupported \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
sed -i '/^Pod=/d' "$R/deploy/paperclip-immutable/paperclip.container"

hdr "5. TOG-654 rejection 3 — /tmp sizing against the measured figure"
sed -i 's/size=24g/size=4g/' "$R/deploy/paperclip-immutable/paperclip.container"
refuses_because "4 GiB against 16.4 GB measured is refused" tmp_undersized \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
says "the refusal cites the measured figure" "16402301140" \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
sed -i 's/size=4g/size=20g/' "$R/deploy/paperclip-immutable/paperclip.container"
allows "20 GiB clears the +25% floor" run --commit "$GOOD_COMMIT" --auth "$AUTH"
sed -i 's/size=20g/size=24g/' "$R/deploy/paperclip-immutable/paperclip.container"

hdr "6. The network gate — the one that fails GREEN"
cp "$R/deploy/paperclip-immutable/paperclip.container" "$TMP/c3.bak"
sed -i '/^Network=omniroute.network$/d' "$R/deploy/paperclip-immutable/paperclip.container"
refuses_because "a carrier declaring 1 leg against a 2-leg host is refused" network_leg_dropped \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
says "the refusal names the green-health failure mode" "loopback /api/health stays GREEN" \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
says "the refusal says a carrier change needs fresh CISO review" "needs fresh CISO gate-1 review" \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
cp "$TMP/c3.bak" "$R/deploy/paperclip-immutable/paperclip.container"

# Counting keys is not the same as counting LEGS. Two identical Network= keys
# render one real leg, so a carrier that repeats a name reaches leg parity on
# arithmetic while still dropping the OmniRoute leg at recreation — the exact
# outage the gate exists to stop, wearing a passing score.
sed -i 's/^Network=omniroute.network$/Network=paperclip.network/' "$R/deploy/paperclip-immutable/paperclip.container"
refuses_because "a carrier repeating one network name does not reach leg parity" network_leg_duplicated \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
says "the duplicate refusal names the leg that is actually dropped" "render to only 1 real leg" \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
says "the duplicate refusal names the RENDERED name that collides" "'systemd-paperclip' is named twice" \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
cp "$TMP/c3.bak" "$R/deploy/paperclip-immutable/paperclip.container"

# Parity must be judged on identity, not arithmetic: a carrier whose legs are
# individually well-formed but name a network the host does not hold is still
# not the running topology.
sed -i 's/^Network=omniroute.network$/Network=elsewhere.network/' "$R/deploy/paperclip-immutable/paperclip.container"
mkevidence "$TMP/ev3.json" paperclip omniroute
touch "$R/deploy/paperclip-immutable/elsewhere.network"
refuses_because "a carrier naming a network the host does not hold is refused" network_leg_mismatched \
  env HOST_EVIDENCE="$TMP/ev3.json" ACTIVATION_NOW="$NOW" "$G" check --repo "$R" --commit "$GOOD_COMMIT" --auth "$AUTH"
rm -f "$R/deploy/paperclip-immutable/elsewhere.network"
cp "$TMP/c3.bak" "$R/deploy/paperclip-immutable/paperclip.container"

# A network with no unit generates cleanly and fails to START. The legs must
# MATCH here, or the identity check above fires first and this gate is never
# reached — so both legs render correctly, and the omniroute.network UNIT is
# the thing missing. Note the two namespaces stay separate: podman reports
# `systemd-omniroute`, the unit that must exist is `omniroute.network`.
rm -f "$R/deploy/paperclip-immutable/omniroute.network"
jq -n '{networks:["systemd-paperclip","systemd-omniroute"],
        networkUnits:["paperclip.network"]}' > "$TMP/ev2.json"
refuses_because "a declared network with no unit is refused" network_unit_absent \
  env HOST_EVIDENCE="$TMP/ev2.json" ACTIVATION_NOW="$NOW" "$G" check --repo "$R" --commit "$GOOD_COMMIT" --auth "$AUTH"

# EXISTENCE IS NOT A UNIT. `touch omniroute.network` satisfies a file-existence
# check and clears network_units, while Quadlet generates nothing from a file
# with no [Network] section — the service fails to START exactly as if the unit
# were absent. Measured on this gate before the fix: an empty shipped file
# turned network_unit_absent into PASS [network_units]. The one-line "fix" for
# a red gate is `touch`, which is precisely why this has to refuse.
: > "$R/deploy/paperclip-immutable/omniroute.network"
refuses_because "an EMPTY shipped .network file does not count as a unit" network_unit_empty \
  env HOST_EVIDENCE="$TMP/ev2.json" ACTIVATION_NOW="$NOW" "$G" check --repo "$R" --commit "$GOOD_COMMIT" --auth "$AUTH"
says "the empty-unit refusal names the green-reading failure" "while a file-existence check reads GREEN" \
  env HOST_EVIDENCE="$TMP/ev2.json" ACTIVATION_NOW="$NOW" "$G" check --repo "$R" --commit "$GOOD_COMMIT" --auth "$AUTH"
# A unit with a real [Network] section does count.
mkunit "$R/deploy/paperclip-immutable/omniroute.network" systemd-omniroute
says "a shipped unit WITH a [Network] section resolves" "PASS  [network_units]" \
  env HOST_EVIDENCE="$TMP/ev2.json" ACTIVATION_NOW="$NOW" "$G" check --repo "$R" --commit "$GOOD_COMMIT" --auth "$AUTH"
cp "$TMP/c3.bak" "$R/deploy/paperclip-immutable/paperclip.container"

# ---------------------------------------------------------------------------
# A carrier Network= key and a podman network name are DIFFERENT NAMESPACES.
# Quadlet turns `Network=paperclip.network` into `--network=systemd-paperclip`
# — confirmed by the board's own generator output in board-quadlet-render.json.
# Comparing the raw key against podman's report made this gate unsatisfiable:
# the CORRECT carrier was refused as network_leg_mismatched, and the only
# carrier that passed leg parity named `systemd-*` directly, which has no unit
# and fails to START. The gate authorized nothing and blocked the fix.
# ---------------------------------------------------------------------------
allows "the CORRECT carrier — legs declared as .network units — passes" \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
says "leg parity is reported against rendered names" "renders 2 distinct leg(s)" \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"

# Naming podman's generated name directly must NOT pass: it satisfies parity
# but has no unit behind it, so the service generates cleanly and fails to
# start. This is the trap the old refusal text actively recommended.
cp "$R/deploy/paperclip-immutable/paperclip.container" "$TMP/c4.bak"
sed -i 's/^Network=paperclip.network$/Network=systemd-paperclip/; s/^Network=omniroute.network$/Network=systemd-omniroute/' \
  "$R/deploy/paperclip-immutable/paperclip.container"
refuses_because "declaring podman's generated systemd-* name is refused" network_leg_unmanaged \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
cp "$TMP/c4.bak" "$R/deploy/paperclip-immutable/paperclip.container"

# Two DIFFERENT keys can render to the SAME leg. Raw-name dedup misses this
# collapse exactly as counting keys missed a repeated name.
sed -i 's/^Network=omniroute.network$/Network=systemd-paperclip/' "$R/deploy/paperclip-immutable/paperclip.container"
refuses_because "two different keys that render to one leg are refused" network_leg_duplicated \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
cp "$TMP/c4.bak" "$R/deploy/paperclip-immutable/paperclip.container"

# `Network=none` on the run carrier is reserved and needs no unit — the gate
# must not demand one, or it would cry wolf on a correct carrier.
says "reserved network names need no unit" "PASS  [network_units]" \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"

# Absent host evidence must REFUSE, not silently skip the leg comparison.
refuses_because "missing host evidence refuses rather than skipping" host_evidence_missing \
  env ACTIVATION_NOW="$NOW" "$G" check --repo "$R" --commit "$GOOD_COMMIT" --auth "$AUTH"

# ---------------------------------------------------------------------------
# 6b. TOG-1110 — `systemd-<stem>` is a DEFAULT, and NetworkName= overrides it.
#
# Every fixture above builds units with `NetworkName=systemd-<stem>` — the
# default spelled out explicitly — so the whole suite could pass while the gate
# assumed the prefix unconditionally. THIS HOST RUNS BOTH SHAPES AT ONCE:
# `paperclip.network` sets `NetworkName=paperclip` (podman reports `paperclip`)
# and `omniroute.network` sets none (podman reports `systemd-omniroute`).
# Measured in the operator window of 2026-09-05 15:42Z on TOG-1110.
#
# The prefix-assuming gate refused this CORRECT carrier as
# network_leg_mismatched, and its remedy text steered the operator to a bare
# `Network=paperclip`, which renders the right leg with no Requires=/After=
# and races network creation at cold boot. So the fixture below is not a
# hypothetical: it is the shape the one human host window actually found.
# ---------------------------------------------------------------------------
hdr "6b. NetworkName= overrides Quadlet's systemd- prefix (TOG-1110)"
HR="$TMP/hostrepo"; mkrepo "$HR"
# The real host's mixed shape: one leg overrides, one leg defaults.
printf '[Unit]\nDescription=Paperclip internal network\n\n[Network]\nNetworkName=paperclip\n' \
  > "$HR/deploy/paperclip-immutable/paperclip.network"
printf '[Network]\n' > "$HR/deploy/paperclip-immutable/omniroute.network"
EVHOST="$TMP/ev-host.json"
jq -n '{networks:["paperclip","systemd-omniroute"],
        networkUnits:["paperclip.network","omniroute.network"]}' > "$EVHOST"
hrun() { HOST_EVIDENCE="$EVHOST" ACTIVATION_NOW="$NOW" "$G" check --repo "$HR" "$@"; }

allows "the carrier is CORRECT when one leg sets NetworkName= and one does not" \
  hrun --commit "$GOOD_COMMIT" --auth "$AUTH"
says "the overriding leg is matched on its real name, not systemd-paperclip" \
  "PASS  [network_legs]" hrun --commit "$GOOD_COMMIT" --auth "$AUTH"

# The trap this closes. Rewriting to the bare podman name is what the OLD
# refusal text recommended; it clears leg parity and loses the unit ordering.
# Note it does NOT begin with `systemd-`, so a gate matching that prefix waves
# it through on this host — the defect being fixed, not a hypothetical one.
cp "$HR/deploy/paperclip-immutable/paperclip.container" "$TMP/h.bak"
sed -i 's/^Network=paperclip.network$/Network=paperclip/' \
  "$HR/deploy/paperclip-immutable/paperclip.container"
refuses_because "the boot-racing bare 'Network=paperclip' is still refused" network_leg_unmanaged \
  hrun --commit "$GOOD_COMMIT" --auth "$AUTH"
cp "$TMP/h.bak" "$HR/deploy/paperclip-immutable/paperclip.container"

# A name the gate had to GUESS is not evidence against the carrier. With no
# unit readable in either place, a mismatch is equally consistent with an
# unread NetworkName= override — so it must not convict the carrier.
rm -f "$HR/deploy/paperclip-immutable/paperclip.network"
refuses_because "an unreadable unit refuses as unresolved, not as a carrier defect" \
  network_name_unresolved hrun --commit "$GOOD_COMMIT" --auth "$AUTH"
says "the unresolved refusal forbids editing the carrier on this evidence" \
  "Do NOT edit the carrier's Network= keys" hrun --commit "$GOOD_COMMIT" --auth "$AUTH"

# The host's own reading wins over the shipped unit: HOST_EVIDENCE .networkNames
# is what the operator measured, and a stale in-repo unit must not override it.
printf '[Unit]\n\n[Network]\nNetworkName=stale-wrong-name\n' \
  > "$HR/deploy/paperclip-immutable/paperclip.network"
EVNAMED="$TMP/ev-named.json"
jq -n '{networks:["paperclip","systemd-omniroute"],
        networkUnits:["paperclip.network","omniroute.network"],
        networkNames:{"paperclip.network":"paperclip"}}' > "$EVNAMED"
allows "the host's measured NetworkName beats a stale shipped unit" \
  env HOST_EVIDENCE="$EVNAMED" ACTIVATION_NOW="$NOW" "$G" check --repo "$HR" \
    --commit "$GOOD_COMMIT" --auth "$AUTH"

# systemd takes the LAST assignment, and an EMPTY one RESETS to the default.
# A grep-based reader gets both wrong, and each one flips the verdict.
printf '[Unit]\n\n[Network]\nNetworkName=decoy\nNetworkName=paperclip\n' \
  > "$HR/deploy/paperclip-immutable/paperclip.network"
allows "a repeated NetworkName= resolves to the LAST assignment" \
  hrun --commit "$GOOD_COMMIT" --auth "$AUTH"
# --- the three NON-override shapes, judged against DEFAULT-named evidence ---
# These must be asserted against a host that reports the DEFAULT name, not
# against the override host. Asserting `network_leg_mismatched` on the override
# host would pass for a gate that never reads NetworkName= at all — the same
# refusal, for the opposite reason. Measured: all three scored PASS against the
# unfixed prefix-assuming gate, i.e. they proved nothing about the parser.
#
# Against DEFAULT evidence they discriminate the other way: a correct parser
# finds no effective override and resolves to `systemd-paperclip` (PASS), while
# a naive `grep NetworkName=` reads the commented-out / wrong-section / reset
# line as a live override, renders `paperclip`, and refuses. Section 9b mutates
# the parser to exactly that grep and proves these go RED.
EVDEF="$TMP/ev-default.json"
jq -n '{networks:["systemd-paperclip","systemd-omniroute"],
        networkUnits:["paperclip.network","omniroute.network"]}' > "$EVDEF"
drun() { HOST_EVIDENCE="$EVDEF" ACTIVATION_NOW="$NOW" "$G" check --repo "$HR" "$@"; }

# systemd treats an empty assignment as a RESET to the default, not as "named
# nothing" and not as "keep the earlier value".
printf '[Unit]\n\n[Network]\nNetworkName=paperclip\nNetworkName=\n' \
  > "$HR/deploy/paperclip-immutable/paperclip.network"
allows "an EMPTY NetworkName= resets to the default, it does not keep the override" \
  drun --commit "$GOOD_COMMIT" --auth "$AUTH"
printf '[Unit]\n\n[Network]\n#NetworkName=paperclip\n' \
  > "$HR/deploy/paperclip-immutable/paperclip.network"
allows "a commented-out NetworkName= is not an override" \
  drun --commit "$GOOD_COMMIT" --auth "$AUTH"
printf '[Unit]\nNetworkName=paperclip\n\n[Network]\n' \
  > "$HR/deploy/paperclip-immutable/paperclip.network"
allows "NetworkName= outside [Network] does not name the network" \
  drun --commit "$GOOD_COMMIT" --auth "$AUTH"
printf '[Unit]\nDescription=Paperclip internal network\n\n[Network]\nNetworkName=paperclip\n' \
  > "$HR/deploy/paperclip-immutable/paperclip.network"

hdr "7. The runbook must exist and be fail-CLOSED"
cp "$R/docs/paperclip-immutable-application-tree.md" "$TMP/rb.bak"
: > "$R/docs/paperclip-immutable-application-tree.md"
refuses_because "a runbook stripped of its commands is refused" runbook_commands_missing \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
cp "$TMP/rb.bak" "$R/docs/paperclip-immutable-application-tree.md"
sed -i 's/set -euo pipefail/set -eu/' "$R/docs/paperclip-immutable-application-tree.md"
refuses_because "a runbook without pipefail is refused as fail-open" runbook_fail_open \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
says "the refusal names the 0-byte evidence failure" "0-byte evidence file" \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
cp "$TMP/rb.bak" "$R/docs/paperclip-immutable-application-tree.md"
# An unredacted whole-object capture retains EnvironmentFile secrets.
echo "podman inspect paperclip > raw.json" >> "$R/docs/paperclip-immutable-application-tree.md"
refuses_because "an unredacted podman inspect capture is refused" runbook_credential_leak \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
cp "$TMP/rb.bak" "$R/docs/paperclip-immutable-application-tree.md"

hdr "8. Authorization is READ, never declared"
refuses_because "no authorization record at all is refused" activation_unauthorized \
  env HOST_EVIDENCE="$EV" ACTIVATION_NOW="$NOW" "$G" check --repo "$R" --commit "$GOOD_COMMIT"
says "the refusal restates that nothing is authorized" "authorizes no install" \
  env HOST_EVIDENCE="$EV" ACTIVATION_NOW="$NOW" "$G" check --repo "$R" --commit "$GOOD_COMMIT"

# THE CENTRAL PROPERTY: authorization for one commit does not carry to another.
mkauth "$TMP/other.json" "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" "$GOOD_DIGEST" \
  "2026-09-01T02:00:00Z" "2026-09-01T06:00:00Z"
refuses_because "authorization naming a DIFFERENT commit does not authorize this one" activation_commit_mismatch \
  run --commit "$GOOD_COMMIT" --auth "$TMP/other.json"

# Same commit, different image is a different deployment.
mkauth "$TMP/dg.json" "$GOOD_COMMIT" "1111111111111111111111111111111111111111111111111111111111111111" \
  "2026-09-01T02:00:00Z" "2026-09-01T06:00:00Z"
refuses_because "authorization for a different digest is refused" activation_digest_mismatch \
  run --commit "$GOOD_COMMIT" --auth "$TMP/dg.json"

# Static acceptance of an EARLIER commit is not acceptance of this one.
mkauth "$TMP/stale.json" "$GOOD_COMMIT" "$GOOD_DIGEST" \
  "2026-09-01T02:00:00Z" "2026-09-01T06:00:00Z" "060dc669" "$GOOD_COMMIT"
refuses_because "stale CISO acceptance is refused" static_acceptance_stale \
  run --commit "$GOOD_COMMIT" --auth "$TMP/stale.json"
mkauth "$TMP/stale2.json" "$GOOD_COMMIT" "$GOOD_DIGEST" \
  "2026-09-01T02:00:00Z" "2026-09-01T06:00:00Z" "$GOOD_COMMIT" "060dc669"
refuses_because "stale DevOps acceptance is refused" static_acceptance_stale \
  run --commit "$GOOD_COMMIT" --auth "$TMP/stale2.json"

# The maintenance window binds in both directions.
BEFORE=$(date -u -d "2026-09-01T01:00:00Z" +%s)
refuses_because "before the window is refused" outside_maintenance_window \
  env HOST_EVIDENCE="$EV" ACTIVATION_NOW="$BEFORE" "$G" check --repo "$R" --commit "$GOOD_COMMIT" --auth "$AUTH"
AFTER=$(date -u -d "2026-09-01T07:00:00Z" +%s)
refuses_because "after the window is refused" outside_maintenance_window \
  env HOST_EVIDENCE="$EV" ACTIVATION_NOW="$AFTER" "$G" check --repo "$R" --commit "$GOOD_COMMIT" --auth "$AUTH"
jq 'del(.window)' "$AUTH" > "$TMP/nowin.json"
refuses_because "an authorization with no window is refused" window_undeclared \
  run --commit "$GOOD_COMMIT" --auth "$TMP/nowin.json"

hdr "9. Mutation coverage — delete a gate, its test must go RED"
# A control that stops doing anything must not keep a green suite. Each entry
# deletes the gate's invocation in a staging copy and asserts the fixture that
# gate refuses is then ALLOWED (i.e. the refusal came from that gate alone).
mutation_check() {  # <desc> <sed-expr to disable the gate> <fixture-setup> <cmd...>
  local d="$1" expr="$2"; shift 2
  local mut="$TMP/mut"; rm -rf "$mut"; mkdir -p "$mut"
  cp "$G" "$mut/gate.sh"; chmod +x "$mut/gate.sh"
  sed -i "$expr" "$mut/gate.sh"
  if ! bash -n "$mut/gate.sh" 2>/dev/null; then bad "$d — mutant does not parse"; return; fi
  local o; o="$("$@" 2>&1)"; local rc=$?
  # With the gate removed the offending fixture must no longer be caught.
  if [[ $rc -eq 0 ]]; then ok "$d"
  else
    # Still refused — acceptable only if a DIFFERENT gate caught it, which
    # would mean this test never proved the deleted gate did anything.
    bad "$d — fixture still refused with the gate deleted; the test does not isolate it"
    grep REFUSED <<<"$o" | sed 's/^/        /' | head -3
  fi
}
MUT() { HOST_EVIDENCE="$EV" ACTIVATION_NOW="$NOW" "$TMP/mut/gate.sh" check --repo "$R" "$@"; }

sed -i 's/size=24g/size=4g/' "$R/deploy/paperclip-immutable/paperclip.container"
mutation_check "deleting gate_tmp_size makes the undersized-/tmp test go green" \
  '/^  gate_tmp_size /d' MUT --commit "$GOOD_COMMIT" --auth "$AUTH"
sed -i 's/size=4g/size=24g/' "$R/deploy/paperclip-immutable/paperclip.container"

cp "$R/deploy/paperclip-immutable/paperclip.container" "$TMP/c9.bak"
sed -i '/^Network=omniroute.network$/d' "$R/deploy/paperclip-immutable/paperclip.container"
mutation_check "deleting gate_networks makes the dropped-leg test go green" \
  '/^  gate_networks /d' MUT --commit "$GOOD_COMMIT" --auth "$AUTH"
cp "$TMP/c9.bak" "$R/deploy/paperclip-immutable/paperclip.container"

# The duplicate-name carrier is the one that previously scored a full PASS.
# Deleting the gate must make it green again, or the new refusal is decoration.
sed -i 's/^Network=omniroute.network$/Network=paperclip.network/' "$R/deploy/paperclip-immutable/paperclip.container"
mutation_check "deleting gate_networks makes the duplicate-leg test go green" \
  '/^  gate_networks /d' MUT --commit "$GOOD_COMMIT" --auth "$AUTH"
cp "$TMP/c9.bak" "$R/deploy/paperclip-immutable/paperclip.container"

# The unmanaged-leg refusal must be load-bearing too: the systemd-* carrier
# renders the correct legs, so with the gate deleted nothing else catches it.
sed -i 's/^Network=paperclip.network$/Network=systemd-paperclip/; s/^Network=omniroute.network$/Network=systemd-omniroute/' \
  "$R/deploy/paperclip-immutable/paperclip.container"
mutation_check "deleting gate_networks makes the unmanaged systemd-* test go green" \
  '/^  gate_networks /d' MUT --commit "$GOOD_COMMIT" --auth "$AUTH"
cp "$TMP/c9.bak" "$R/deploy/paperclip-immutable/paperclip.container"

# The running-image cross-check must be load-bearing too. Deleting only the
# `refuse image_changes_running_service` call has to make the candidate-pinned
# carrier green — if some other gate catches it, section 2b proves nothing
# about THIS check. Note the mutant runs against $EVIMG (evidence WITH an
# .image), and the auth record must name the candidate digest, or
# activation_digest_mismatch would refuse instead and mask the deletion.
MUTIMG() { HOST_EVIDENCE="$EVIMG" ACTIVATION_NOW="$NOW" "$TMP/mut/gate.sh" check --repo "$R" "$@"; }
AUTHCAND="$TMP/auth-candidate.json"
mkauth "$AUTHCAND" "$GOOD_COMMIT" "$CANDIDATE_DIGEST" \
  "2026-09-01T02:00:00Z" "2026-09-01T06:00:00Z"
sed -i "s|^Image=.*|Image=paperclip-local@sha256:$CANDIDATE_DIGEST|" \
  "$R/deploy/paperclip-immutable/paperclip.container"
mutation_check "deleting the running-image cross-check makes the candidate pin go green" \
  '/refuse image_changes_running_service/,+2d' MUTIMG --commit "$GOOD_COMMIT" --auth "$AUTHCAND"
cp "$TMP/c9.bak" "$R/deploy/paperclip-immutable/paperclip.container"

echo 'ReadOnly=/app' >> "$R/deploy/paperclip-immutable/paperclip.container"
mutation_check "deleting gate_readonly makes the fail-open test go green" \
  '/^  gate_readonly /d' MUT --commit "$GOOD_COMMIT" --auth "$AUTH"
cp "$TMP/c9.bak" "$R/deploy/paperclip-immutable/paperclip.container"

mutation_check "deleting gate_authorization makes the unauthorized test go green" \
  '/^  gate_authorization /d' MUT --commit "$GOOD_COMMIT"

echo 'Pod=paperclip.pod' >> "$R/deploy/paperclip-immutable/paperclip.container"
mutation_check "deleting gate_pod makes the Pod= test go green" \
  '/^  gate_pod /d' MUT --commit "$GOOD_COMMIT" --auth "$AUTH"
cp "$TMP/c9.bak" "$R/deploy/paperclip-immutable/paperclip.container"

# The empty-unit refusal needs evidence in which the unit is NOT installed on
# the host, so the shipped file is what the gate falls back to. MUT2 supplies
# it; without this the deleted gate would still be caught by network_unit_absent
# and the mutation would prove nothing.
MUT2() { HOST_EVIDENCE="$TMP/ev2.json" ACTIVATION_NOW="$NOW" "$TMP/mut/gate.sh" check --repo "$R" "$@"; }
: > "$R/deploy/paperclip-immutable/omniroute.network"
mutation_check "deleting the [Network]-section check makes the empty-unit test go green" \
  '/if grep -qE .*Network.* "\$shipped"; then/s/.*/      if true; then/' \
  MUT2 --commit "$GOOD_COMMIT" --auth "$AUTH"
mkunit "$R/deploy/paperclip-immutable/omniroute.network" systemd-omniroute

# --- 9b. TOG-1110 — the NetworkName parser's PRECISION is load-bearing -----
# `mutation_check` asserts a fixture goes GREEN with a gate deleted. These arms
# assert the reverse: a fixture that must stay green goes RED when the careful
# parser is swapped for the naive `grep NetworkName=`. Deleting the resolver
# would not do here — the default path would still reach the right answer for
# the default-named host. The mutant has to be the plausible WRONG parser,
# which is the one a reader would actually write.
mutate_parser_to_grep() {  # -> $TMP/mut/gate.sh with a naive grep parser
  local mut="$TMP/mut"; rm -rf "$mut"; mkdir -p "$mut"
  cp "$G" "$mut/gate.sh"; chmod +x "$mut/gate.sh"
  # Replace the parser body with the four-ways-wrong grep it exists to avoid.
  python3 - "$mut/gate.sh" <<'PY'
import re,sys
p=sys.argv[1]; s=open(p).read()
start=s.index('unit_effective_network_name() {')
end=s.index('\n}\n',start)+3
s=s[:start]+'unit_effective_network_name() {\n  grep -m1 "NetworkName=" "$1" 2>/dev/null | sed "s/.*NetworkName=//"\n  return 0\n}\n'+s[end:]
open(p,'w').write(s)
PY
  bash -n "$mut/gate.sh" 2>/dev/null || { bad "parser mutant does not parse"; return 1; }
}
# grep_mut_red <desc> <cmd...> — the fixture must go RED under the grep parser.
grep_mut_red() {
  local d="$1"; shift
  local o; o="$("$@" 2>&1)"; local rc=$?
  if [[ $rc -ne 0 ]]; then ok "$d"
  else bad "$d — still green under the naive-grep parser; the test does not pin precision"; fi
}
if command -v python3 >/dev/null && mutate_parser_to_grep; then
  MUTD() { HOST_EVIDENCE="$TMP/ev-default.json" ACTIVATION_NOW="$NOW" \
             "$TMP/mut/gate.sh" check --repo "$HR" "$@"; }
  printf '[Unit]\n\n[Network]\n#NetworkName=paperclip\n' \
    > "$HR/deploy/paperclip-immutable/paperclip.network"
  grep_mut_red "a naive grep parser reads a COMMENTED-OUT override and goes red" \
    MUTD --commit "$GOOD_COMMIT" --auth "$AUTH"
  printf '[Unit]\nNetworkName=paperclip\n\n[Network]\n' \
    > "$HR/deploy/paperclip-immutable/paperclip.network"
  grep_mut_red "a naive grep parser reads NetworkName= from the WRONG SECTION and goes red" \
    MUTD --commit "$GOOD_COMMIT" --auth "$AUTH"
  printf '[Unit]\n\n[Network]\nNetworkName=paperclip\nNetworkName=\n' \
    > "$HR/deploy/paperclip-immutable/paperclip.network"
  grep_mut_red "a naive grep parser takes the FIRST assignment, not the last, and goes red" \
    MUTD --commit "$GOOD_COMMIT" --auth "$AUTH"
  printf '[Unit]\nDescription=Paperclip internal network\n\n[Network]\nNetworkName=paperclip\n' \
    > "$HR/deploy/paperclip-immutable/paperclip.network"
else
  echo "  SKIP  parser mutation arms (python3 unavailable)"
fi

hdr "10. The real repo carrier, as it stands today, is REFUSED"
# The point of the whole exercise: the live candidate must not pass yet.
if [ -f "$HERE/deploy/paperclip-immutable/paperclip.container" ]; then
  o="$(HOST_EVIDENCE="$EV" ACTIVATION_NOW="$NOW" "$G" check --repo "$HERE" --commit "$GOOD_COMMIT" --auth "$AUTH" 2>&1)"
  if grep -q 'ACTIVATION REFUSED' <<<"$o"; then ok "the in-tree carrier is refused today"
  else bad "the in-tree carrier PASSED — it should not"; fi
  if grep -qF '[image_digest_placeholder]' <<<"$o"; then ok "  … because the digest is still a placeholder"
  else bad "  … expected the placeholder refusal"; fi
  # TOG-714 declared the second leg, so the carrier must no longer be refused
  # for DROPPING one.
  #
  # ASSERT THE LEGS BY IDENTITY, NOT BY THE ABSENCE OF A REFUSAL STRING. The
  # first cut of this section was two negative greps ("no [network_leg_dropped]"
  # + "no other network refusal"). Measured: deleting EVERY Network= key from
  # the carrier — strictly worse than the one-leg carrier this issue exists to
  # fix — still scored 51 passed, 0 failed, printing "both legs are declared".
  # A zero-leg carrier refuses as [network_undeclared], which is in neither
  # grep, so both assertions passed on absence. Same class as the count-based
  # parity bug in 45bd90d9: the check answered a question nobody asked.
  #
  # So: read the legs the carrier actually declares, render them into podman's
  # namespace, and compare that SET against the host evidence the suite feeds
  # the gate. Nothing here can pass on a missing key.
  declared_legs="$(sed -n 's/^Network=//p' "$HERE/deploy/paperclip-immutable/paperclip.container" \
    | sed 's/^\(.*\)\.network$/systemd-\1/' | sort -u)"
  host_legs="$(jq -r '.networks[]' "$EV" | sort -u)"
  if [ "$declared_legs" = "$host_legs" ]; then
    ok "  … and the carrier declares exactly the host's legs: $(tr '\n' ' ' <<<"$host_legs")"
  else
    bad "  … carrier legs != host legs. carrier renders [$(tr '\n' ' ' <<<"$declared_legs")]; host holds [$(tr '\n' ' ' <<<"$host_legs")]"
  fi
  # And the OmniRoute leg specifically — the one whose loss leaves /api/health
  # GREEN while every agent loses inference — named in the UNIT namespace.
  if grep -qxF 'Network=omniroute.network' "$HERE/deploy/paperclip-immutable/paperclip.container"
  then ok "  … including Network=omniroute.network, in the unit namespace (TOG-714)"
  else bad "  … the OmniRoute leg is not declared as omniroute.network"; fi
  # Only now is the absence of a network refusal meaningful: the positive
  # assertions above have already proven the keys are present and correct.
  if grep -qE '\[network_(leg_(dropped|mismatched|duplicated|unmanaged)|unit_absent|undeclared)\]' <<<"$o"
  then bad "  … unexpected network refusal on the two-leg carrier"; grep -E 'REFUSED \[network' <<<"$o" | sed 's/^/        /'
  else ok "  … and no network gate refuses it"; fi
else
  ok "in-tree carrier not present in this checkout (skipped)"
fi

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
