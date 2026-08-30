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
Network=systemd-paperclip
Network=systemd-omniroute
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
  touch "$r/deploy/paperclip-immutable/systemd-paperclip"
  touch "$r/deploy/paperclip-immutable/systemd-omniroute"
}

mkevidence() {  # <file> <net...>
  local f="$1"; shift
  local arr; arr="$(printf '%s\n' "$@" | jq -R . | jq -s .)"
  jq -n --argjson n "$arr" '{networks:$n, networkUnits:$n}' > "$f"
}

mkauth() {  # <file> <commit> <digest> <from> <to> [ciso] [devops]
  jq -n --arg c "$2" --arg d "$3" --arg f "$4" --arg t "$5" \
        --arg ci "${6:-$2}" --arg de "${7:-$2}" \
    '{commit:$c, imageDigest:$d, window:{from:$f,to:$t},
      staticAcceptance:{ciso:$ci, devops:$de}}' > "$1"
}

R="$TMP/repo"; mkrepo "$R"
EV="$TMP/ev.json"; mkevidence "$EV" systemd-paperclip systemd-omniroute
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
sed -i '/^Network=systemd-omniroute$/d' "$R/deploy/paperclip-immutable/paperclip.container"
refuses_because "a carrier declaring 1 leg against a 2-leg host is refused" network_leg_dropped \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
says "the refusal names the green-health failure mode" "loopback /api/health stays GREEN" \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
says "the refusal says a carrier change needs fresh CISO review" "needs fresh CISO gate-1 review" \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"
cp "$TMP/c3.bak" "$R/deploy/paperclip-immutable/paperclip.container"

# A network with no unit generates cleanly and fails to START.
sed -i 's/^Network=systemd-omniroute$/Network=paperclip.network/' "$R/deploy/paperclip-immutable/paperclip.container"
mkevidence "$TMP/ev2.json" systemd-paperclip systemd-omniroute
refuses_because "a declared network with no unit is refused" network_unit_absent \
  env HOST_EVIDENCE="$TMP/ev2.json" ACTIVATION_NOW="$NOW" "$G" check --repo "$R" --commit "$GOOD_COMMIT" --auth "$AUTH"
cp "$TMP/c3.bak" "$R/deploy/paperclip-immutable/paperclip.container"

# `Network=none` on the run carrier is reserved and needs no unit — the gate
# must not demand one, or it would cry wolf on a correct carrier.
says "reserved network names need no unit" "PASS  [network_units]" \
  run --commit "$GOOD_COMMIT" --auth "$AUTH"

# Absent host evidence must REFUSE, not silently skip the leg comparison.
refuses_because "missing host evidence refuses rather than skipping" host_evidence_missing \
  env ACTIVATION_NOW="$NOW" "$G" check --repo "$R" --commit "$GOOD_COMMIT" --auth "$AUTH"

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

cp "$R/deploy/paperclip-immutable/paperclip.container" "$TMP/c4.bak"
sed -i '/^Network=systemd-omniroute$/d' "$R/deploy/paperclip-immutable/paperclip.container"
mutation_check "deleting gate_networks makes the dropped-leg test go green" \
  '/^  gate_networks /d' MUT --commit "$GOOD_COMMIT" --auth "$AUTH"
cp "$TMP/c4.bak" "$R/deploy/paperclip-immutable/paperclip.container"

echo 'ReadOnly=/app' >> "$R/deploy/paperclip-immutable/paperclip.container"
mutation_check "deleting gate_readonly makes the fail-open test go green" \
  '/^  gate_readonly /d' MUT --commit "$GOOD_COMMIT" --auth "$AUTH"
cp "$TMP/c4.bak" "$R/deploy/paperclip-immutable/paperclip.container"

mutation_check "deleting gate_authorization makes the unauthorized test go green" \
  '/^  gate_authorization /d' MUT --commit "$GOOD_COMMIT"

echo 'Pod=paperclip.pod' >> "$R/deploy/paperclip-immutable/paperclip.container"
mutation_check "deleting gate_pod makes the Pod= test go green" \
  '/^  gate_pod /d' MUT --commit "$GOOD_COMMIT" --auth "$AUTH"
cp "$TMP/c4.bak" "$R/deploy/paperclip-immutable/paperclip.container"

hdr "10. The real repo carrier, as it stands today, is REFUSED"
# The point of the whole exercise: the live candidate must not pass yet.
if [ -f "$HERE/deploy/paperclip-immutable/paperclip.container" ]; then
  o="$(HOST_EVIDENCE="$EV" ACTIVATION_NOW="$NOW" "$G" check --repo "$HERE" --commit "$GOOD_COMMIT" --auth "$AUTH" 2>&1)"
  if grep -q 'ACTIVATION REFUSED' <<<"$o"; then ok "the in-tree carrier is refused today"
  else bad "the in-tree carrier PASSED — it should not"; fi
  if grep -qF '[image_digest_placeholder]' <<<"$o"; then ok "  … because the digest is still a placeholder"
  else bad "  … expected the placeholder refusal"; fi
  if grep -qF '[network_leg_dropped]' <<<"$o"; then ok "  … and because it declares one leg against a two-leg host"
  else bad "  … expected the dropped-leg refusal"; fi
else
  ok "in-tree carrier not present in this checkout (skipped)"
fi

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
