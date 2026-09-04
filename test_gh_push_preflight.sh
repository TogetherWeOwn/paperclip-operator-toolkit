#!/usr/bin/env bash
# Regression suite for gh_push_preflight.sh — the TOG-918 start-of-work gate.
#
# WHAT THIS PROTECTS. Four ways this preflight can be wrong, worst first:
#
#   1. It reports PASS when the broker would refuse. That is the only truly
#      dangerous failure, because the whole point of the tool is to be believed
#      at start-of-work: a false PASS sends an agent to do the entire job and
#      hit exit 128 at push time -- which is exactly the TOG-291 stranding this
#      exists to prevent, now with a green light in front of it. Asserted with a
#      project-less fixture, with a project whose GH_APP_REPOS is absent, and
#      with a `done` issue whose scope IS derivable (lifecycle refusal).
#
#   2. It reports PASS because it could not measure. An unreadable board, a
#      missing oracle, or an unresolvable issue must be exit 2, never exit 0.
#      A preflight that turns an outage into a green light is failure mode 1
#      wearing a different hat. Asserted for all three.
#
#   3. It leaks $PAPERCLIP_API_KEY into argv. /proc/<pid>/cmdline is
#      world-readable and every agent on this host shares uid `node`
#      (TOG-191/TOG-200), so a bearer on a command line is readable fleet-wide.
#      Asserted against the kernel's own record.
#
#   4. It mints something. The tool's safety claim to the CISO (TOG-918: no new
#      path may mint broader than one repo) rests on it never minting at all.
#      Asserted by giving it no GitHub credential and failing the run if it
#      reaches for the network or the PEM.
#
# THE TRAP IN TESTING (3). Removing the Authorization header entirely would
# pass "no key in argv" perfectly -- and would then read an empty board and
# report whatever an unauthenticated response says. So the no-leak assertion is
# PAIRED with a positive assertion that the bearer really did reach curl by the
# config file. A suite that only checks for absence passes against the bug.
#
# THE TRAP IN TESTING (1). The oracle is the broker's own resolveScope, so a
# test that stubs the oracle would assert nothing about real behaviour. These
# tests run the REAL scope.js -- the deployed copy when present, else the
# in-repo one -- and only the control-plane reads are faked.
#
# Offline by construction: board reads go through a stub curl that never opens
# a socket, and the one test that must see real argv reads /proc. No network,
# no GitHub credential.
#
# Requires bash, jq, node, and /proc.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${GH_PUSH_PREFLIGHT_SH:-$HERE/gh_push_preflight.sh}"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }

[[ -x "$TOOL" ]] || { echo "FATAL: $TOOL is not executable"; exit 2; }
for dep in jq node; do
  command -v "$dep" >/dev/null 2>&1 || { echo "FATAL: missing $dep"; exit 2; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FIXTURES="$WORK/fixtures"; mkdir -p "$FIXTURES"
BIN="$WORK/bin"; mkdir -p "$BIN"

SENTINEL_KEY="tog918-not-a-real-bearer-$$"

# --- fixtures ---------------------------------------------------------------

cat > "$FIXTURES/issue-with-project.json" <<'EOF'
{"id":"11111111-1111-1111-1111-111111111111","status":"in_progress",
 "projectId":"aaaaaaaa-0000-0000-0000-000000000001","assigneeAgentId":"agent-1"}
EOF

cat > "$FIXTURES/issue-no-project.json" <<'EOF'
{"id":"22222222-2222-2222-2222-222222222222","status":"in_progress",
 "projectId":null,"assigneeAgentId":"agent-1"}
EOF

cat > "$FIXTURES/issue-no-project-todo.json" <<'EOF'
{"id":"44444444-4444-4444-4444-444444444444","status":"todo",
 "projectId":null,"assigneeAgentId":"agent-1"}
EOF

# A project that exists but pins no GH_APP_REPOS and has no workspace repoUrl.
# This is the second half of the defect class: "has a project" is NOT the same
# as "has a derivable scope", and a preflight that only checked projectId would
# report a false PASS here.
cat > "$FIXTURES/issue-project-no-repos.json" <<'EOF'
{"id":"33333333-3333-3333-3333-333333333333","status":"in_progress",
 "projectId":"aaaaaaaa-0000-0000-0000-000000000002","assigneeAgentId":"agent-1"}
EOF

cat > "$FIXTURES/projects.json" <<'EOF'
[
 {"id":"aaaaaaaa-0000-0000-0000-000000000001","name":"Scoped Project",
  "env":{"GH_APP_REPOS":{"type":"plain","value":"paperclip-ops-tooling"}},
  "primaryWorkspace":{"repoUrl":"https://github.com/TogetherWeOwn/paperclip-ops-tooling.git"}},
 {"id":"aaaaaaaa-0000-0000-0000-000000000002","name":"Unscoped Project",
  "env":{},"primaryWorkspace":null},
 {"id":"aaaaaaaa-0000-0000-0000-000000000003","name":"Multi Repo",
  "env":{"GH_APP_REPOS":{"type":"plain","value":"two-web,two-bot"}},
  "primaryWorkspace":null}
]
EOF

cat > "$FIXTURES/issue-multi.json" <<'EOF'
{"id":"55555555-5555-5555-5555-555555555555","status":"in_progress",
 "projectId":"aaaaaaaa-0000-0000-0000-000000000003","assigneeAgentId":"agent-1"}
EOF

# THE FALSE GREEN THIS SUITE EXISTS TO CATCH (found in review of the first
# cut, before merge): a `done` issue whose scope IS derivable. The scope term
# passes; only the lifecycle term refuses. The first cut printed a PASS banner
# with an "ALSO" footnote and exited 0 -- a green light over a mint the broker
# provably refuses (a comment-woken run on a done issue cannot push).
cat > "$FIXTURES/issue-with-project-done.json" <<'EOF'
{"id":"66666666-6666-6666-6666-666666666666","status":"done",
 "projectId":"aaaaaaaa-0000-0000-0000-000000000001","assigneeAgentId":"agent-1"}
EOF

# --- stub curl --------------------------------------------------------------
# Serves fixtures by URL. Records every invocation's argv and the config file
# it was handed, so the credential-hygiene assertions have something to read.
# Never opens a socket.

cat > "$BIN/curl" <<STUB
#!/usr/bin/env bash
# Record OUR OWN argv from the kernel, not from "\$@": the assertion is about
# what a /proc reader on this host would actually see.
tr '\0' ' ' < /proc/\$\$/cmdline >> "$WORK/curl-argv.log"
printf '\n' >> "$WORK/curl-argv.log"

cfg=""
prev=""
for a in "\$@"; do
  if [[ "\$prev" == "--config" ]]; then cfg="\$a"; fi
  prev="\$a"
done
if [[ -n "\$cfg" && -r "\$cfg" ]]; then
  cat "\$cfg" >> "$WORK/curl-config.log"
  # Record the mode of the config file: a bearer written world-readable is the
  # same disclosure as a bearer in argv, one indirection away.
  stat -c '%a' "\$cfg" >> "$WORK/curl-config-mode.log"
fi

url="\$(sed -n 's/^url = "\(.*\)"\$/\1/p' "\$cfg" 2>/dev/null | head -1)"

case "\$url" in
  *"/api/issues/"*)
    id="\${url##*/api/issues/}"
    f="$WORK/route-issue"
    if [[ -r "\$f" ]]; then cat "\$(cat "\$f")"; exit 0; fi
    echo '{"error":"Issue not found"}'; exit 0 ;;
  *"/projects")
    if [[ -r "$WORK/route-projects-fail" ]]; then exit 7; fi
    cat "$FIXTURES/projects.json"; exit 0 ;;
esac
echo '{"error":"unexpected url"}'; exit 0
STUB
chmod 755 "$BIN/curl"

run_preflight() {
  # $1 = issue fixture path, rest = extra args
  local fixture="$1"; shift
  echo "$fixture" > "$WORK/route-issue"
  : > "$WORK/curl-argv.log"; : > "$WORK/curl-config.log"; : > "$WORK/curl-config-mode.log"
  env -i \
    PATH="$BIN:/usr/local/bin:/usr/bin:/bin" \
    HOME="$WORK" \
    PAPERCLIP_API_URL="https://control-plane.invalid/api" \
    PAPERCLIP_API_KEY="$SENTINEL_KEY" \
    PAPERCLIP_COMPANY_ID="cccccccc-0000-0000-0000-000000000001" \
    PAPERCLIP_TASK_ID="11111111-1111-1111-1111-111111111111" \
    PAPERCLIP_RUN_SCRATCH_DIR="$WORK/scratch" \
    GH_BROKER_DEPLOYED_DIR="${GH_BROKER_DEPLOYED_DIR:-/opt/paperclip-plugin-packages/gh-token-broker}" \
    GH_BROKER_OWNERSHIP_JS="${GH_BROKER_OWNERSHIP_JS:-$HERE/plugins/gh-token-broker/dist/ownership.js}" \
    "$TOOL" "$@" > "$WORK/out.txt" 2> "$WORK/err.txt"
  echo $?
}

# A refusal must be a DELIBERATE VERDICT, not a crash.
#
# Learned the hard way while mutation-testing this suite: a mutant that reduced
# the check to `projectId !== null` then dereferenced a null repositories list
# and died with a TypeError. Node exits 1 on an uncaught throw, so a bare
# `rc == 1` assertion scored that crash as a correct refusal and the mutant
# survived the assertion that exists specifically to kill it.
#
# So exit 1 alone is not evidence. A real refusal also prints the FAIL banner
# and must not print a stack trace.
refused_deliberately() {
  local rc="$1" what="$2"
  if [[ "$rc" != "1" ]]; then
    bad "$what should exit 1, got $rc"; return
  fi
  if grep -qE "^\s+at |TypeError|ReferenceError|is not a function" "$WORK/out.txt" "$WORK/err.txt"; then
    bad "$what exited 1 by CRASHING, not by refusing: $(grep -m1 -E 'TypeError|ReferenceError' "$WORK/out.txt" "$WORK/err.txt" | head -c 120)"
    return
  fi
  if ! grep -q "FAIL —" "$WORK/out.txt"; then
    bad "$what exited 1 without printing a refusal verdict"; return
  fi
  ok "$what -> exit 1 (a deliberate refusal, not a crash)"
}

echo "gh_push_preflight.sh — TOG-918 regression suite"
echo

# --- 1. the core verdicts ---------------------------------------------------

rc=$(run_preflight "$FIXTURES/issue-with-project.json")
if [[ "$rc" == "0" ]]; then ok "project with GH_APP_REPOS -> exit 0 (PASS)"
else bad "project with GH_APP_REPOS should exit 0, got $rc: $(head -3 "$WORK/err.txt" "$WORK/out.txt" | tr '\n' ' ')"; fi
if grep -q "paperclip-ops-tooling" "$WORK/out.txt"; then ok "PASS output names the derived repo"
else bad "PASS output does not name the derived repo"; fi

rc=$(run_preflight "$FIXTURES/issue-no-project.json")
refused_deliberately "$rc" "project-less issue (the TOG-291 case)"

# The actionable-message requirement from the TOG-918 acceptance criterion.
if grep -q "no project" "$WORK/out.txt" && grep -q "Fix: attach this issue to a project" "$WORK/out.txt"; then
  ok "refusal names the cause AND the fix"
else bad "refusal does not carry the broker's cause+fix text"; fi
if grep -qi "every repo in the installation" "$WORK/out.txt"; then
  ok "refusal states why minting anyway would be unsafe"
else bad "refusal omits the blast-radius rationale"; fi

# Failure mode 1, second half: having a project is not having a scope.
rc=$(run_preflight "$FIXTURES/issue-project-no-repos.json")
refused_deliberately "$rc" "project WITHOUT GH_APP_REPOS (not a false PASS)"
if grep -q "has no env\|no usable GH_APP_REPOS" "$WORK/out.txt"; then
  ok "refusal distinguishes 'no project' from 'project without GH_APP_REPOS'"
else bad "refusal does not distinguish the two project cases"; fi

# --- 2. lifecycle refuses, and is not a footnote -----------------------------

rc=$(run_preflight "$FIXTURES/issue-no-project-todo.json")
refused_deliberately "$rc" "project-less + todo"
if grep -q "status is \"todo\"" "$WORK/out.txt"; then
  ok "lifecycle refusal is reported separately from the scope refusal"
else bad "lifecycle refusal not reported"; fi

# Scope PASSES, lifecycle alone refuses. The first cut exited 0 here and
# printed a PASS banner with an "ALSO" note -- failure mode 1 in the exact
# case it exists to prevent (comment-woken run on a done issue).
rc=$(run_preflight "$FIXTURES/issue-with-project-done.json")
refused_deliberately "$rc" "done issue WITH a derivable scope (lifecycle refusal decides the exit code)"
if grep -q "Fix: " "$WORK/out.txt" && grep -q "route the work to a live card" "$WORK/out.txt"; then
  ok "lifecycle refusal names the fix"
else bad "lifecycle refusal does not name the fix"; fi
if grep -q "  PASS —" "$WORK/out.txt"; then
  bad "done issue printed a PASS banner over a refused mint"
else ok "done issue prints no PASS banner"; fi

# --- 3. multi-repo scope is surfaced, not silently accepted -----------------

rc=$(run_preflight "$FIXTURES/issue-multi.json")
if [[ "$rc" == "0" ]]; then ok "multi-repo project still passes (a legitimate pin)"
else bad "multi-repo project should exit 0, got $rc"; fi
if grep -q "scope spans 2 repos" "$WORK/out.txt"; then
  ok "multi-repo scope is surfaced as a NOTE (real blast radius is visible)"
else bad "multi-repo scope not surfaced"; fi

# --- 4. cannot-measure is never a pass --------------------------------------

rc=$(run_preflight "$FIXTURES/does-not-exist-issue.json")
if [[ "$rc" == "2" ]]; then ok "unresolvable issue -> exit 2 (not a false PASS)"
else bad "unresolvable issue should exit 2, got $rc"; fi

: > "$WORK/route-projects-fail"
rc=$(run_preflight "$FIXTURES/issue-with-project.json")
if [[ "$rc" == "2" ]]; then ok "unreadable project list -> exit 2 (not a false PASS)"
else bad "unreadable project list should exit 2, got $rc"; fi
rm -f "$WORK/route-projects-fail"

rc=$(env -i PATH="$BIN:/usr/local/bin:/usr/bin:/bin" HOME="$WORK" \
      PAPERCLIP_API_URL="https://x.invalid" PAPERCLIP_API_KEY="$SENTINEL_KEY" \
      PAPERCLIP_COMPANY_ID="c" "$TOOL" >/dev/null 2>&1; echo $?)
if [[ "$rc" == "2" ]]; then ok "no issue id -> exit 2"
else bad "missing issue id should exit 2, got $rc"; fi

# The oracle itself going missing must not degrade to a guess.
rc=$(GH_BROKER_DEPLOYED_DIR="$WORK/nowhere" \
     GH_PUSH_PREFLIGHT_SH="$TOOL" bash -c '
       fixture="$1"; work="$2"; bin="$3"; tool="$4"; key="$5"; repo="$6"
       echo "$fixture" > "$work/route-issue"
       tmp="$work/fakerepo"; mkdir -p "$tmp"
       env -i PATH="$bin:/usr/local/bin:/usr/bin:/bin" HOME="$work" \
         PAPERCLIP_API_URL="https://x.invalid/api" PAPERCLIP_API_KEY="$key" \
         PAPERCLIP_COMPANY_ID="c" PAPERCLIP_TASK_ID="i" \
         PAPERCLIP_RUN_SCRATCH_DIR="$work/scratch" \
         GH_BROKER_DEPLOYED_DIR="$work/nowhere" \
         "$tool" >/dev/null 2>&1
       echo $?' _ "$FIXTURES/issue-with-project.json" "$WORK" "$BIN" "$TOOL" "$SENTINEL_KEY" "$HERE")
# With only the deployed copy missing the in-repo copy still answers, so this
# must still be a real verdict rather than an error -- the fallback is the point.
if [[ "$rc" == "0" || "$rc" == "1" ]]; then
  ok "missing DEPLOYED oracle falls back to the in-repo copy (still a real verdict)"
else bad "missing deployed oracle should fall back, got $rc"; fi

# The lifecycle term now DECIDES the exit code, so an ownership module that
# cannot be loaded is an unmeasured deciding term -- exit 2, never a pass on
# the scope term alone.
rc=$(GH_BROKER_OWNERSHIP_JS="$WORK/no-such-ownership.js" \
     run_preflight "$FIXTURES/issue-with-project.json")
if [[ "$rc" == "2" ]]; then ok "unreadable ownership module -> exit 2 (unmeasured lifecycle is never a pass)"
else bad "unreadable ownership module should exit 2, got $rc"; fi

# --- 5. credential hygiene (TOG-200) ----------------------------------------

run_preflight "$FIXTURES/issue-with-project.json" >/dev/null

if [[ -s "$WORK/curl-argv.log" ]]; then ok "stub curl was actually invoked (assertions below are live)"
else bad "stub curl was never invoked — the hygiene assertions would be vacuous"; fi

if grep -q -- "$SENTINEL_KEY" "$WORK/curl-argv.log"; then
  bad "BEARER LEAKED INTO ARGV — readable via /proc by every agent on this host"
else ok "no bearer in curl argv (kernel's own record)"; fi

# PAIRED positive: absence above must not be because auth never happened.
if grep -q "Authorization: Bearer $SENTINEL_KEY" "$WORK/curl-config.log"; then
  ok "bearer DID reach curl via the config file (absence in argv is not silence)"
else bad "bearer never reached curl — the no-leak assertion above is vacuous"; fi

if [[ -s "$WORK/curl-config-mode.log" ]] && ! grep -qv '^600$' "$WORK/curl-config-mode.log"; then
  ok "every curl config file was mode 0600"
else bad "a curl config file holding the bearer was not 0600: $(sort -u "$WORK/curl-config-mode.log" | tr '\n' ' ')"; fi

# --- 6. it mints nothing ----------------------------------------------------
# The run above had no GH_APP_* in its environment at all (env -i), so a code
# path that tried to mint could not have succeeded quietly. Assert the tool
# never even claimed to.

rc=$(run_preflight "$FIXTURES/issue-with-project.json" --json)
if [[ "$rc" == "0" ]] && jq -e '.mintedAnything == false' "$WORK/out.txt" >/dev/null 2>&1; then
  ok "--json reports mintedAnything: false"
else bad "--json did not report mintedAnything: false"; fi

if jq -e '.repositories | length == 1' "$WORK/out.txt" >/dev/null 2>&1; then
  ok "--json verdict carries a single-repo scope (CISO constraint)"
else bad "--json verdict did not carry a single-repo scope"; fi

if jq -e '.pass == true' "$WORK/out.txt" >/dev/null 2>&1; then
  ok "--json reports pass: true for a scoped, mintable issue"
else bad "--json did not report pass: true"; fi

# The done case in JSON: scope derivable, verdict still a refusal.
rc=$(run_preflight "$FIXTURES/issue-with-project-done.json" --json)
if [[ "$rc" == "1" ]] && jq -e '.pass == false and .canDeriveScope == true' "$WORK/out.txt" >/dev/null 2>&1; then
  ok "--json done case: pass: false with canDeriveScope: true"
else bad "--json done case wrong (rc=$rc): $(head -c 200 "$WORK/out.txt")"; fi

# No GitHub host may ever be contacted: the stub curl only knows control-plane
# URLs, and a GitHub call would have shown up in its argv log.
if grep -qi "github.com" "$WORK/curl-argv.log"; then
  bad "the preflight contacted github.com — it must never reach for a token"
else ok "no GitHub endpoint was contacted"; fi

# --- 7. the tool is registered ----------------------------------------------
# An unregistered suite is indistinguishable from no suite.
#
# The assertion requires an EXECUTABLE step -- a `run:` line that actually
# invokes this file -- not merely the string appearing somewhere in the
# workflow. Every suite in this repo is also named in ci.yml's header manifest,
# so a bare `grep -q` for the filename passes on the comment alone and reports
# "registered" for a suite CI never runs. That is the precise false green this
# section exists to prevent, and the first draft of this very check had it.
if command grep -Eq '^[[:space:]]*run:[[:space:]]*\./test_gh_push_preflight\.sh[[:space:]]*$' \
     "$HERE/.github/workflows/ci.yml" 2>/dev/null; then
  ok "test_gh_push_preflight.sh is registered as a runnable CI step"
else bad "test_gh_push_preflight.sh has no 'run:' step in .github/workflows/ci.yml"; fi

# The header manifest is documentation, asserted separately so that satisfying
# one never stands in for the other.
if command grep -q '^#[[:space:]]*test_gh_push_preflight\.sh' \
     "$HERE/.github/workflows/ci.yml" 2>/dev/null; then
  ok "test_gh_push_preflight.sh is described in the ci.yml header manifest"
else bad "test_gh_push_preflight.sh is missing from the ci.yml header manifest"; fi

# The tool the suite guards must itself be executable, or CI's step runs a file
# the runner cannot invoke. (Memory: a pinned repro must be chmod 755.)
for f in gh_push_preflight.sh test_gh_push_preflight.sh; do
  if [[ -x "$HERE/$f" ]]; then ok "$f is executable"
  else bad "$f is not executable — CI's ./$f would fail"; fi
done

echo
echo "  $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
