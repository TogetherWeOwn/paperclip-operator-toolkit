#!/usr/bin/env bash
# ===========================================================================
# test_capture_host_render.sh — suite for capture_host_render.sh
#
# WHY THIS EXISTS. capture_host_render.sh is an OPERATOR script: run once, by a
# human, in a scarce host window, on the one path where a mistake costs a
# second human window. Operator scripts need tests most of all — the last
# zero-test host-window script in this repo hid three defects, one of which
# wrote FABRICATED evidence and exited 0.
#
# HOW IT TESTS. There is no podman, no systemd and no Quadlet generator here,
# so podman/systemctl and the GENERATOR are STUBBED. `--generator` is a real
# argument on the script, so the seam is the script's own, not a test-only
# hook. Every refusal is asserted BY NAME, never by exit status: the script is
# fail-closed on most inputs, so rc=2 passes for fixtures that never reach the
# check under test.
#
# THE CASE THAT MATTERS MOST is the ONE-LEG render (section 4). The script must
# write it down and exit 0 while shouting, because a one-leg render of a
# two-leg carrier is a real, decisive finding the operator has to carry back.
# A capture that refused there would look identical to a broken generator, and
# an operator would "fix" the carrier to make it stop.
#
# Section 8 is the control on the controls: it deletes each guard from a
# staging copy and asserts the bad input is then ACCEPTED. A check that has
# stopped doing anything cannot keep a green suite.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/capture_host_render.sh"
PASS=0; FAIL=0

ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }
section() { printf '\n%s\n' "$1"; }

# --- the stub host --------------------------------------------------------
# Defaults to a HEALTHY host whose generator emits BOTH legs. Each test
# perturbs exactly one knob.
make_host() {
  local d="$1"; shift
  local legs='--network=systemd-paperclip --network=systemd-omniroute'
  local gen_rc=0 server_exec='' run_exec='' extra_server=''

  while [ $# -gt 0 ]; do
    case "$1" in
      --legs)         legs="$2"; shift 2 ;;
      --gen-rc)       gen_rc="$2"; shift 2 ;;
      --server-exec)  server_exec="$2"; shift 2 ;;
      --extra-server) extra_server="$2"; shift 2 ;;
      *) echo "make_host: bad arg $1" >&2; return 1 ;;
    esac
  done

  mkdir -p "$d/bin"

  # A carrier-faithful ExecStart. The stub generator reads the STAGED unit to
  # decide which carrier it is rendering, so the script's own staging (image
  # substitution, placeholder expansion, one-carrier-at-a-time isolation) is
  # exercised rather than bypassed.
  [ -n "$server_exec" ] || server_exec="/usr/bin/podman run --name=paperclip --replace --rm $legs --read-only --read-only-tmpfs=false --tmpfs /tmp:rw,nosuid,nodev,noexec,size=24g,mode=1777 --tmpfs /run:rw,nosuid,nodev,noexec,size=64m,mode=0755 --security-opt=no-new-privileges --cap-drop=all -v %h/.local/share/paperclip:/paperclip:Z --env-file %h/.config/containers/systemd/paperclip.env$extra_server IMAGE"
  run_exec="/usr/bin/podman run --name=paperclip-run-run-a --replace --rm --network=none --read-only --read-only-tmpfs=false --user 61111:61112 -v /run/paperclip-runs/run-a:/run/paperclip-run:rw,Z -v /run/paperclip-runs/run-a/workspace:/workspace:rw,Z --cap-drop=all --security-opt=no-new-privileges IMAGE"

  cat >"$d/bin/generator" <<EOF
#!/usr/bin/env bash
# Stub Quadlet generator. Reads QUADLET_UNIT_DIRS to tell the carriers apart.
rc=$gen_rc
if [ "\$rc" -ne 0 ]; then echo "stub generator failure" >&2; exit "\$rc"; fi
if ls "\$QUADLET_UNIT_DIRS"/paperclip-run-*.container >/dev/null 2>&1; then
  printf 'ExecStart=%s\n' '$run_exec'
else
  printf 'ExecStart=%s\n' '$server_exec'
fi
exit 0
EOF
  cat >"$d/bin/podman" <<'EOF'
#!/usr/bin/env bash
[ "$1" = version ] && { printf '4.9.3\n'; exit 0; }
exit 0
EOF
  cat >"$d/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
printf 'systemd 255 (255.4-1ubuntu8.17)\n'
EOF
  chmod +x "$d/bin/generator" "$d/bin/podman" "$d/bin/systemctl"
}

# A checkout fixture: a real git repo holding the REAL carriers, so the script
# renders the bytes we actually ship rather than a simplified stand-in.
make_repo() {
  local d="$1"
  mkdir -p "$d/repo/deploy/paperclip-immutable/generated"
  cp "$HERE/deploy/paperclip-immutable/paperclip.container" \
     "$HERE/deploy/paperclip-immutable/agent-run.container.in" \
     "$d/repo/deploy/paperclip-immutable/"
  git -C "$d/repo" init -q 2>/dev/null
  git -C "$d/repo" config user.email t@t.local
  git -C "$d/repo" config user.name t
  git -C "$d/repo" add -A >/dev/null 2>&1
  git -C "$d/repo" commit -qm base >/dev/null 2>&1
  git -C "$d/repo" commit -qm second --allow-empty >/dev/null 2>&1
}

# Run the script (or a staged copy) against a stub host + fixture repo.
run_render() {
  local d="$1" script="${2:-$SCRIPT}"
  cp "$script" "$d/repo/capture_host_render.sh"
  chmod +x "$d/repo/capture_host_render.sh"
  ( cd "$d/repo" && PATH="$d/bin:$PATH" \
      bash "$d/repo/capture_host_render.sh" --generator "$d/bin/generator" ) >"$d/out" 2>&1
  printf '%s' $?
}

new_case() {
  local d; d="$(mktemp -d)"
  make_repo "$d"
  printf '%s' "$d"
}

RENDER=deploy/paperclip-immutable/generated/board-quadlet-render.json

# =========================================================================
section '1. the healthy two-leg host'
# =========================================================================
d="$(new_case)"; make_host "$d"
rc="$(run_render "$d")"
[ "$rc" = 0 ] && ok 'exits 0 on a two-leg render' || bad 'exits 0 on a two-leg render' "rc=$rc: $(cat "$d/out")"
[ -s "$d/repo/$RENDER" ] && ok 'writes a non-empty render' || bad 'writes a non-empty render'
if jq -e '.server.execStart != "" and .run.execStart != ""' "$d/repo/$RENDER" >/dev/null 2>&1; then
  ok 'render carries both ExecStart values'
else bad 'render carries both ExecStart values' "$(cat "$d/out")"; fi
grep -q 'BOTH legs generated' "$d/out" && ok 'verdict says both legs generated' || bad 'verdict says both legs generated' "$(cat "$d/out")"

# The render must describe the carrier BYTES IN THE REPO, or the suite it feeds
# is bound to something that was never on disk.
want="$(sha256sum "$d/repo/deploy/paperclip-immutable/paperclip.container" | cut -d' ' -f1)"
got="$(jq -r '.candidate.serverCarrierSha256' "$d/repo/$RENDER" 2>/dev/null)"
[ "$want" = "$got" ] && ok 'candidate.serverCarrierSha256 is the real carrier hash' \
  || bad 'candidate.serverCarrierSha256 is the real carrier hash' "want=$want got=$got"
gotc="$(jq -r '.candidate.commit' "$d/repo/$RENDER" 2>/dev/null)"
[ "$gotc" = "$(git -C "$d/repo" rev-parse HEAD)" ] && ok 'candidate.commit is HEAD' || bad 'candidate.commit is HEAD'
[ "$(jq -r '.candidate.parent' "$d/repo/$RENDER")" = "$(git -C "$d/repo" rev-parse HEAD^)" ] \
  && ok 'candidate.parent is recorded' || bad 'candidate.parent is recorded'
[ "$(jq -r '.host.installed' "$d/repo/$RENDER")" = false ] && ok 'host.installed is false' || bad 'host.installed is false'
[ "$(jq -r '.authorization.activation' "$d/repo/$RENDER")" = false ] && ok 'authorizes no activation' || bad 'authorizes no activation'
rm -rf "$d"

# =========================================================================
section '2. requiredTokens are written from what GENERATED, not from a wish list'
# =========================================================================
d="$(new_case)"; make_host "$d"
run_render "$d" >/dev/null
toks="$(jq -r '.server.requiredTokens[]' "$d/repo/$RENDER" 2>/dev/null | sort)"
if printf '%s\n' "$toks" | grep -Fqx -- '--network=systemd-paperclip' \
   && printf '%s\n' "$toks" | grep -Fqx -- '--network=systemd-omniroute'; then
  ok 'both generated legs land in requiredTokens'
else bad 'both generated legs land in requiredTokens' "$toks"; fi
rm -rf "$d"

# A leg that did NOT generate must NOT appear in requiredTokens. If it did, the
# render would assert a leg the host never produced — the same fabricated
# evidence a hand-edited render would be.
d="$(new_case)"; make_host "$d" --legs '--network=systemd-paperclip'
run_render "$d" >/dev/null
if jq -r '.server.requiredTokens[]' "$d/repo/$RENDER" 2>/dev/null | grep -Fqx -- '--network=systemd-omniroute'; then
  bad 'an ungenerated leg is kept out of requiredTokens' 'omniroute was asserted but never generated'
else ok 'an ungenerated leg is kept out of requiredTokens'; fi
rm -rf "$d"

# =========================================================================
section '3. the staging the render depends on'
# =========================================================================
d="$(new_case)"; make_host "$d"
run_render "$d" >/dev/null
# The two carriers must render SEPARATELY: if both were staged together the
# server ExecStart could pick up the run unit's --network=none and a one-leg
# server would read as correct.
sx="$(jq -r '.server.execStart' "$d/repo/$RENDER" 2>/dev/null)"
rx="$(jq -r '.run.execStart' "$d/repo/$RENDER" 2>/dev/null)"
case "$sx" in *paperclip-run-*) bad 'server and run carriers render in isolation' "server exec is the run unit" ;;
  *) case "$rx" in *"--network=none"*) ok 'server and run carriers render in isolation' ;;
       *) bad 'server and run carriers render in isolation' "run exec: $rx" ;; esac ;; esac
[ "$(jq -r '.fixtureSubstitution.image' "$d/repo/$RENDER")" != '' ] \
  && ok 'the image substitution is recorded, not hidden' || bad 'the image substitution is recorded, not hidden'
rm -rf "$d"

# An unsubstituted @...@ must REFUSE: the render would otherwise describe a
# unit no launcher will ever emit.
d="$(new_case)"; make_host "$d"
printf 'Environment=NEW=@UNSUBSTITUTED_KEY@\n' >> "$d/repo/deploy/paperclip-immutable/agent-run.container.in"
rc="$(run_render "$d")"
grep -q 'REFUSED \[unsubstituted_placeholder\]' "$d/out" && ok 'refuses an unsubstituted @PLACEHOLDER@ by name' \
  || bad 'refuses an unsubstituted @PLACEHOLDER@ by name' "rc=$rc: $(cat "$d/out")"
rm -rf "$d"

# =========================================================================
section '4. a ONE-LEG render is recorded and shouted, NOT refused'
# =========================================================================
# The decisive case. The generator emitting one leg for a two-leg carrier is a
# real finding: it must reach the operator as a written artifact plus a loud
# verdict, not as a refusal indistinguishable from a broken generator.
d="$(new_case)"; make_host "$d" --legs '--network=systemd-paperclip'
rc="$(run_render "$d")"
[ "$rc" = 0 ] && ok 'a one-leg render still exits 0' || bad 'a one-leg render still exits 0' "rc=$rc: $(cat "$d/out")"
[ -s "$d/repo/$RENDER" ] && ok 'a one-leg render is still WRITTEN' || bad 'a one-leg render is still WRITTEN'
grep -q 'ONLY 1 leg(s) GENERATED' "$d/out" && ok 'the one-leg verdict is shouted' || bad 'the one-leg verdict is shouted' "$(cat "$d/out")"
grep -q 'Do not adjust it toward two legs' "$d/out" && ok 'it tells the operator not to adjust the finding' \
  || bad 'it tells the operator not to adjust the finding'
# and the artifact must be HONEST about it
[ "$(jq -r '[.server.requiredTokens[]|select(startswith("--network="))]|length' "$d/repo/$RENDER" 2>/dev/null)" = 1 ] \
  && ok 'the written render honestly holds one leg' || bad 'the written render honestly holds one leg'
rm -rf "$d"

# Zero legs is equally a finding, not a refusal.
d="$(new_case)"; make_host "$d" --legs ''
rc="$(run_render "$d")"
[ "$rc" = 0 ] && grep -q 'ONLY 0 leg(s) GENERATED' "$d/out" \
  && ok 'a zero-leg render is recorded and shouted' || bad 'a zero-leg render is recorded and shouted' "rc=$rc: $(cat "$d/out")"
rm -rf "$d"

# =========================================================================
section '5. a failed generator is a STOP, and writes no render'
# =========================================================================
d="$(new_case)"; make_host "$d" --gen-rc 1
rc="$(run_render "$d")"
grep -q 'REFUSED \[server_generation_failed\]' "$d/out" && ok 'a non-zero generator refuses by name' \
  || bad 'a non-zero generator refuses by name' "rc=$rc: $(cat "$d/out")"
[ ! -f "$d/repo/$RENDER" ] && ok 'no render is written when generation fails' \
  || bad 'no render is written when generation fails' 'a render survives a failed generator'
grep -q 'stub generator failure' "$d/out" && ok 'the generator stderr reaches the operator' || bad 'the generator stderr reaches the operator'
rm -rf "$d"

# An ExecStart-less but exit-0 generator is the fail-open case: an empty string
# satisfies every substring check downstream.
d="$(new_case)"; make_host "$d" --server-exec ''
cat >"$d/bin/generator" <<'EOF'
#!/usr/bin/env bash
if ls "$QUADLET_UNIT_DIRS"/paperclip-run-*.container >/dev/null 2>&1; then
  printf 'ExecStart=/usr/bin/podman run --network=none IMAGE\n'
else
  printf '# no ExecStart at all\n'
fi
exit 0
EOF
chmod +x "$d/bin/generator"
rc="$(run_render "$d")"
grep -q 'REFUSED \[server_generation_failed\]' "$d/out" && ok 'exit 0 with no ExecStart still refuses' \
  || bad 'exit 0 with no ExecStart still refuses' "rc=$rc: $(cat "$d/out")"
[ ! -f "$d/repo/$RENDER" ] && ok 'no render is written for an empty ExecStart' || bad 'no render is written for an empty ExecStart'
rm -rf "$d"

# =========================================================================
section '6. the secret boundary'
# =========================================================================
# -dryrun emits the --env-file PATH. If KEY=VALUE pairs appear, the env file
# was READ and the output must not be retained.
d="$(new_case)"; make_host "$d" --extra-server ' --env OMNIROUTE_KEY=sk-live-abc123'
rc="$(run_render "$d")"
grep -q 'REFUSED \[credential_bearing_render\]' "$d/out" && ok 'refuses a render carrying an expanded credential' \
  || bad 'refuses a render carrying an expanded credential' "rc=$rc: $(cat "$d/out")"
[ ! -f "$d/repo/$RENDER" ] && ok 'no credential-bearing render is written' || bad 'no credential-bearing render is written'
rm -rf "$d"

# The env-file PATH is normal Quadlet output and must NOT trip the guard —
# a check that refuses the healthy case gets deleted by the next operator.
d="$(new_case)"; make_host "$d"
rc="$(run_render "$d")"
[ "$rc" = 0 ] && ok 'the bare --env-file PATH does not trip the secret guard' \
  || bad 'the bare --env-file PATH does not trip the secret guard' "rc=$rc: $(cat "$d/out")"
jq -e '.server.execStart | test("env-file")' "$d/repo/$RENDER" >/dev/null 2>&1 \
  && ok 'the env-file path is retained, as Quadlet emits it' || bad 'the env-file path is retained'
rm -rf "$d"

# =========================================================================
section '7. it must run on a HOST, and it must not half-write'
# =========================================================================
d="$(new_case)"
mkdir -p "$d/bin"   # empty: no podman
cp "$SCRIPT" "$d/repo/capture_host_render.sh"; chmod +x "$d/repo/capture_host_render.sh"
( cd "$d/repo" && PATH="$d/bin:/usr/bin:/bin" bash ./capture_host_render.sh --generator /nonexistent ) >"$d/out" 2>&1
if grep -qE 'REFUSED \[(missing_podman|generator_absent)\]' "$d/out"; then
  ok 'refuses by name when podman/generator are absent (i.e. inside a container)'
else bad 'refuses by name when podman/generator are absent' "$(cat "$d/out")"; fi
rm -rf "$d"

d="$(new_case)"; make_host "$d"
run_render "$d" >/dev/null
ls "$d/repo/deploy/paperclip-immutable/generated/"*.partial.* >/dev/null 2>&1 \
  && bad 'no .partial file is left behind' 'a partial render survived' || ok 'no .partial file is left behind'
rm -rf "$d"

# =========================================================================
section '8. control on the controls — delete each guard, the bad input passes'
# =========================================================================
# A guard that has stopped doing anything must not be able to keep this suite
# green. Each case deletes ONE guard from a staging copy and asserts the input
# it exists to catch is then ACCEPTED.
#
# CRITICAL: assert the BASELINE refuses before deleting the guard. "Not refused
# with the guard deleted" is identical whether the guard is absent or merely
# INERT, so without the baseline half this control scores a guard that never
# fires as a pass. That is exactly what happened here: the first credential
# guard scanned the wrong side of `KEY=value`, matched nothing, and this
# section reported ok while the real check in section 6 was red.
mutate() {
  local label="$1" pattern="$2"; shift 2
  local d; d="$(new_case)"; make_host "$d" "$@"

  # Half one: the UNMUTATED script must refuse this fixture. If it does not,
  # the guard is inert and the deletion half proves nothing.
  run_render "$d" >/dev/null
  if ! grep -q 'REFUSED' "$d/out"; then
    bad "$label" "baseline did NOT refuse — the guard is inert, so deleting it proves nothing"
    rm -rf "$d"; return
  fi

  local staged="$d/staged.sh"
  grep -v "$pattern" "$SCRIPT" > "$staged"
  if [ "$(wc -l <"$staged")" -eq "$(wc -l <"$SCRIPT")" ]; then
    bad "$label" "the mutation pattern '$pattern' matched nothing — this control tests nothing"
    rm -rf "$d"; return
  fi

  # Half two: with the guard gone, the same fixture must sail through.
  local rc; rc="$(run_render "$d" "$staged")"
  if grep -q 'REFUSED' "$d/out"; then
    bad "$label" "still refused with the guard deleted: $(head -2 "$d/out")"
  else
    ok "$label"
  fi
  rm -rf "$d"
}
mutate 'deleting the credential guard lets an expanded credential through' \
       'refuse credential_bearing_render' --extra-server ' --env OMNIROUTE_KEY=sk-live-abc123'
mutate 'deleting the generation-failure guard lets a failed generator through' \
       'refuse server_generation_failed' --gen-rc 1

# The placeholder guard needs its own fixture (a mutated carrier), so it is run
# apart from mutate()'s knobs.
d="$(new_case)"; make_host "$d"
printf 'Environment=NEW=@UNSUBSTITUTED_KEY@\n' >> "$d/repo/deploy/paperclip-immutable/agent-run.container.in"
run_render "$d" >/dev/null
grep -q 'REFUSED \[unsubstituted_placeholder\]' "$d/out" \
  || bad 'placeholder-guard baseline refuses' 'baseline did NOT refuse — the guard is inert'
grep -v 'refuse unsubstituted_placeholder' "$SCRIPT" > "$d/staged.sh"
run_render "$d" "$d/staged.sh" >/dev/null
grep -q 'REFUSED \[unsubstituted_placeholder\]' "$d/out" \
  && bad 'deleting the placeholder guard lets @PLACEHOLDER@ through' 'still refused' \
  || ok 'deleting the placeholder guard lets @PLACEHOLDER@ through'
rm -rf "$d"

# =========================================================================
section '9. a refusal must disown the STALE render it did not overwrite'
# =========================================================================
# `generated/board-quadlet-render.json` is CHECKED IN, so a fresh clone already
# carries one, rendered from an older carrier. A refusal writes no render, and
# the ask document tells the operator to post back "the new board-quadlet-
# render.json". By name, path and shape the leftover is indistinguishable from
# a fresh capture, so the failure mode is posting a render of a carrier nobody
# is installing as host confirmation of the one we are — in the single host
# window this issue exists to buy. The refusal must name it.
STALE_SHA=5439475be3739cbf7bb3b7842c22de007d46e8b3916ac7fb3d8383b0167ddb2c

d="$(new_case)"; make_host "$d"
printf '{"candidate":{"serverCarrierSha256":"%s"}}\n' "$STALE_SHA" > "$d/repo/$RENDER"
stale_before="$(sha256sum "$d/repo/$RENDER" | cut -d' ' -f1)"
( cd "$d/repo" && cp "$SCRIPT" ./capture_host_render.sh && PATH="$d/bin:$PATH" \
    bash ./capture_host_render.sh --generator /nonexistent ) >"$d/out" 2>&1
rc=$?

[ "$rc" -eq 2 ] && ok 'a refusal still exits 2' || bad 'a refusal still exits 2' "rc=$rc"
[ "$(sha256sum "$d/repo/$RENDER" | cut -d' ' -f1)" = "$stale_before" ] \
  && ok 'the refusal leaves the pre-existing render untouched' \
  || bad 'the refusal leaves the pre-existing render untouched' 'the file changed'
grep -q 'NO fresh render was written' "$d/out" \
  && ok 'the refusal states no fresh render was written' \
  || bad 'the refusal states no fresh render was written' "$(cat "$d/out")"
grep -q 'STALE' "$d/out" \
  && ok 'the refusal names the leftover STALE against this carrier' \
  || bad 'the refusal names the leftover STALE against this carrier' "$(cat "$d/out")"
grep -q 'Do NOT post it' "$d/out" \
  && ok 'the refusal tells the operator not to post it' \
  || bad 'the refusal tells the operator not to post it' "$(cat "$d/out")"

# A leftover that MATCHES the shipped carrier must not be cried stale, or the
# warning becomes noise the operator learns to skip past.
sha_now="$(sha256sum "$d/repo/deploy/paperclip-immutable/paperclip.container" | cut -d' ' -f1)"
printf '{"candidate":{"serverCarrierSha256":"%s"}}\n' "$sha_now" > "$d/repo/$RENDER"
( cd "$d/repo" && PATH="$d/bin:$PATH" \
    bash ./capture_host_render.sh --generator /nonexistent ) >"$d/out" 2>&1
grep -q 'STALE' "$d/out" \
  && bad 'a CURRENT leftover is not falsely called stale' 'called stale anyway' \
  || ok 'a CURRENT leftover is not falsely called stale'

# MUTATION: delete the disowning call. Baseline already warned above, so this
# half is meaningful; assert the mutation actually applied before scoring it.
printf '{"candidate":{"serverCarrierSha256":"%s"}}\n' "$STALE_SHA" > "$d/repo/$RENDER"
grep -v '^  warn_stale_out$' "$SCRIPT" > "$d/staged.sh"
if cmp -s "$SCRIPT" "$d/staged.sh"; then
  bad 'MUTATION: the stale-render disowning is load-bearing' \
      'the mutation matched nothing — this control tests nothing'
else
  ( cd "$d/repo" && cp "$d/staged.sh" ./capture_host_render.sh && PATH="$d/bin:$PATH" \
      bash ./capture_host_render.sh --generator /nonexistent ) >"$d/out" 2>&1
  grep -q 'NO fresh render was written' "$d/out" \
    && bad 'MUTATION: the stale-render disowning is load-bearing' 'still warned without the call' \
    || ok 'MUTATION: the stale-render disowning is load-bearing'
fi
rm -rf "$d"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
