#!/usr/bin/env bash
# Regression suite for gh_scope_residue.sh — the TOG-226 standing gate.
#
# WHAT THIS PROTECTS. Three ways this check can be wrong, in descending order
# of how badly it hurts:
#
#   1. It reports CLEAN when residue exists. That is the only truly dangerous
#      failure: a clean sweep is the gate for unbinding an agent's PEM, and a
#      false clean unbinds an agent that then cannot mint at all. The
#      motivating case is real — TOG-289 names no repository anywhere in its
#      text and had already pushed `tog-289-gh-event-capture` to
#      paperclip-ops-tooling. Text scanning alone scores it clean. So the
#      branch detector has its own test, built from exactly that shape.
#
#   2. It reports residue that is not residue. Counting every git-ish word
#      makes the gap look ~6x worse than it is and sends the reader hunting
#      for a broker fix that cannot exist, because no token in this
#      installation reaches the Paperclip control plane or an upstream vendor.
#      Asserted here with control-plane and vendor issue bodies.
#
#   3. It leaks a credential into argv. $PAPERCLIP_API_KEY is a live board
#      token and /proc/<pid>/cmdline is world-readable on a shared host
#      (TOG-200). Asserted against the kernel's own record.
#
# THE TRAP IN TESTING (3). Removing the Authorization header entirely would
# pass "no key in argv" perfectly. So every no-leak assertion is PAIRED with a
# positive assertion that the credential did reach curl by the config file. A
# suite that only checks for absence passes against the bug where the script
# authenticates with nothing and reads an empty board — which then reports
# CLEAN, which is failure mode 1.
#
# The stub curl reads /proc/$$/cmdline, not /proc/self/cmdline: inside the
# stub, `< /proc/self/...` is opened by a forked child about to exec, so self
# would resolve to that child's argv and the assertion would pass for the
# wrong reason.
#
# Offline by construction: the board reads are redirected to fixture files,
# the GitHub read is redirected to a fixture, and the one test that must see
# real argv uses a stub curl that never opens a socket. No network, no
# credential, no node. The tool runs under a scrubbed environment so an
# operator's live PAPERCLIP_API_KEY cannot leak in and reach the wire.
#
# Requires bash, jq, and /proc.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${GH_SCOPE_RESIDUE_SH:-$HERE/gh_scope_residue.sh}"
PASS=0; FAIL=0

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[[ -x "$TOOL" ]] || { echo "ERROR: $TOOL is not executable" >&2; exit 1; }
command -v jq >/dev/null || { echo "ERROR: jq is required" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/test_scope_residue.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# --- fixtures --------------------------------------------------------------
cat > "$WORK/projects.json" <<'EOF'
[
  {"id":"proj-ops","name":"Ops Tooling",
   "env":{"GH_APP_REPOS":{"type":"plain","value":"paperclip-ops-tooling"}}},
  {"id":"proj-comm","name":"Community Platform",
   "env":{"GH_APP_REPOS":{"type":"plain","value":"two-web,two-bot,two-design"}}},
  {"id":"proj-router","name":"Model Router Plugin",
   "env":{"GH_APP_REPOS":{"type":"plain","value":"paperclip-model-router"}}}
]
EOF

# Every row below is modelled on a real board row as of 2026-08-24.
cat > "$WORK/issues.json" <<'EOF'
[
  {"issueNumber":290,"status":"backlog","projectId":null,
   "title":"omniroute_combo_cli.sh selftest is not hermetic",
   "description":"Fixtures hardcode a two/ combo name. Lives in paperclip-ops-tooling."},

  {"issueNumber":289,"status":"blocked","projectId":null,
   "title":"Self-hosted GitHub webhook capture",
   "description":"The App subscribes to zero events and has no webhook registered. Engineering time only."},

  {"issueNumber":175,"status":"backlog","projectId":null,
   "title":"GET /api/agents/me/secrets reports projection intent, never outcome",
   "description":"Fix in server/src/services/secrets.ts — the control plane, not a repo we hold."},

  {"issueNumber":233,"status":"backlog","projectId":null,
   "title":"OmniRoute: patch detectMalformedNonStream",
   "description":"omniroute@3.8.49, open-sse/utils/diagnostics.ts at :176, called from handlers/chatCore.ts."},

  {"issueNumber":104,"status":"in_review","projectId":null,
   "title":"Hire an Infrastructure Engineer",
   "description":"No git work of any kind."},

  {"issueNumber":200,"status":"in_review","projectId":"proj-ops",
   "title":"gh_token.sh passes live credentials on the curl command line",
   "description":"paperclip-ops-tooling. Already attached, so not residue."},

  {"issueNumber":193,"status":"done","projectId":null,
   "title":"Regression-test the gh-app-token.js minting bug",
   "description":"paperclip-ops-tooling, but this issue is closed."}
]
EOF

cat > "$WORK/branches.json" <<'EOF'
{
  "paperclip-ops-tooling": ["main","tog-289-gh-event-capture","tog-200-no-creds-on-argv","dependabot/x"],
  "two-web": ["main"],
  "two-bot": ["main"],
  "two-design": ["main"],
  "paperclip-model-router": ["main"]
}
EOF

run_board() {
  env -i PATH="$PATH" HOME="$WORK" TMPDIR="$WORK" \
      SCOPE_RESIDUE_PROJECTS_JSON="$WORK/projects.json" \
      SCOPE_RESIDUE_ISSUES_JSON="$WORK/issues.json" \
      "$@"
}

# =========================================================================
hdr "Detector 1 — text names a repo in the mintable set"

out="$(run_board bash "$TOOL" --json)"; rc=$?
issues="$(printf '%s' "$out" | jq -c '[.residue[].issue] | sort')"

[[ "$rc" -eq 1 ]] \
  && ok "exit 1 when residue exists" \
  || bad "expected exit 1 with residue, got $rc"

[[ "$(printf '%s' "$out" | jq -r '[.residue[] | select(.issue==290)] | length')" == 1 ]] \
  && ok "TOG-290 flagged — names paperclip-ops-tooling" \
  || bad "TOG-290 not flagged"

[[ "$(printf '%s' "$out" | jq -r '.residue[] | select(.issue==290) | .projectId')" == proj-ops ]] \
  && ok "TOG-290 routed to the project that pins the repo" \
  || bad "TOG-290 routed to the wrong project"

hdr "Detector 1 — the over-count trap (failure mode 2)"

for n in 175 233; do
  [[ "$(printf '%s' "$out" | jq -r "[.residue[] | select(.issue==$n)] | length")" == 0 ]] \
    && ok "TOG-$n not residue — code is outside the installation" \
    || bad "TOG-$n wrongly counted as residue"
done

[[ "$(printf '%s' "$out" | jq -r '[.residue[] | select(.issue==104)] | length')" == 0 ]] \
  && ok "TOG-104 not residue — no git work" \
  || bad "TOG-104 wrongly counted as residue"

[[ "$(printf '%s' "$out" | jq -r '[.residue[] | select(.issue==200)] | length')" == 0 ]] \
  && ok "TOG-200 not residue — already attached to a project" \
  || bad "TOG-200 wrongly counted as residue"

[[ "$(printf '%s' "$out" | jq -r '[.residue[] | select(.issue==193)] | length')" == 0 ]] \
  && ok "TOG-193 not residue — closed issues cannot mint" \
  || bad "TOG-193 wrongly counted as residue"

# =========================================================================
hdr "Detector 2 — a pushed branch, where the text says nothing (failure mode 1)"

[[ "$(printf '%s' "$out" | jq -r '[.residue[] | select(.issue==289)] | length')" == 0 ]] \
  && ok "text scan alone MISSES TOG-289 — this is why --branches exists" \
  || bad "fixture is wrong: TOG-289 must be invisible to the text detector"

bout="$(run_board SCOPE_RESIDUE_BRANCHES_JSON="$WORK/branches.json" bash "$TOOL" --branches --json)"; brc=$?

[[ "$(printf '%s' "$bout" | jq -r '[.residue[] | select(.issue==289)] | length')" == 1 ]] \
  && ok "--branches catches TOG-289 via tog-289-gh-event-capture" \
  || bad "--branches failed to catch TOG-289"

[[ "$(printf '%s' "$bout" | jq -r '.residue[] | select(.issue==289) | .repo')" == paperclip-ops-tooling ]] \
  && ok "TOG-289 attributed to the repo the branch is in" \
  || bad "TOG-289 attributed to the wrong repo"

[[ "$(printf '%s' "$bout" | jq -r '[.residue[] | select(.issue==200)] | length')" == 0 ]] \
  && ok "tog-200-* branch ignored — TOG-200 already has a project" \
  || bad "TOG-200 flagged despite having a project"

[[ "$(printf '%s' "$bout" | jq -r '.branchesChecked')" == true ]] \
  && ok "branch detector reports that it ran" \
  || bad "branchesChecked not set"

[[ "$brc" -eq 1 ]] && ok "exit 1 with branch residue" || bad "expected exit 1, got $brc"

# A non-tog branch must not crash the capture or invent an issue.
[[ "$(printf '%s' "$bout" | jq -r '[.residue[] | select(.issue==null)] | length')" == 0 ]] \
  && ok "unrelated branches (main, dependabot/x) produce no phantom rows" \
  || bad "a non-tog branch produced a residue row"

# =========================================================================
hdr "Clean board — the gate that permits an unbind"

jq '[ .[] | if .projectId == null then .projectId = "proj-ops" else . end ]' \
  "$WORK/issues.json" > "$WORK/issues_clean.json"

run_clean() {
  env -i PATH="$PATH" HOME="$WORK" TMPDIR="$WORK" \
      SCOPE_RESIDUE_PROJECTS_JSON="$WORK/projects.json" \
      SCOPE_RESIDUE_ISSUES_JSON="$WORK/issues_clean.json" \
      SCOPE_RESIDUE_BRANCHES_JSON="$WORK/branches.json" \
      "$@"
}

# Only a FULL sweep — every in-scope repo's branches checked — is a pass.
cout="$(run_clean bash "$TOOL" --branches --json)"; crc=$?

[[ "$crc" -eq 0 ]] && ok "exit 0 on a clean board at full coverage" || bad "expected exit 0, got $crc"
[[ "$(printf '%s' "$cout" | jq -r '.count')" == 0 ]] \
  && ok "count 0 on a clean board" || bad "count non-zero on a clean board"
[[ "$(printf '%s' "$cout" | jq -r '.coverage')" == full ]] \
  && ok "coverage reported full when every repo was checked" \
  || bad "coverage not full"

hdr "A partial sweep is not a gate pass (failure mode 1, again)"

# Text alone cannot see a TOG-289, so a clean text-only run must not exit 0 —
# CI treating it as a pass is how an agent gets its PEM unbound on no evidence.
tout="$(run_clean bash "$TOOL" --json)"; trc=$?
[[ "$trc" -eq 3 ]] \
  && ok "text-only clean board exits 3 (inconclusive), not 0" \
  || bad "expected exit 3 for a text-only sweep, got $trc"
[[ "$(printf '%s' "$tout" | jq -r '.coverage')" == partial ]] \
  && ok "text-only sweep reports partial coverage" || bad "text-only sweep claimed full coverage"

# An agent scoped to one repo can only sweep that repo. Measured: this run's
# token is scoped to paperclip-ops-tooling and 403s on kofra.
pout="$(run_clean bash "$TOOL" --repos paperclip-ops-tooling --json)"; prc=$?
[[ "$prc" -eq 3 ]] \
  && ok "--repos subset exits 3 even with no residue" \
  || bad "expected exit 3 for a subset sweep, got $prc"
[[ "$(printf '%s' "$pout" | jq -r '.reposChecked')" == 1 && "$(printf '%s' "$pout" | jq -r '.reposTotal')" == 5 ]] \
  && ok "subset sweep reports 1 of 5 repos checked" \
  || bad "coverage counts wrong: $(printf '%s' "$pout" | jq -c '{reposChecked,reposTotal}')"

# Residue still outranks coverage: finding something is conclusive.
rout="$(run_board SCOPE_RESIDUE_BRANCHES_JSON="$WORK/branches.json" \
  bash "$TOOL" --repos paperclip-ops-tooling --json)"; rrc=$?
[[ "$rrc" -eq 1 ]] \
  && ok "a subset sweep that FINDS residue still exits 1" \
  || bad "expected exit 1 when a partial sweep finds residue, got $rrc"

run_clean bash "$TOOL" --repos not-a-repo --json >/dev/null 2>&1
[[ $? -eq 2 ]] \
  && ok "exit 2 when --repos names a repo no project pins" \
  || bad "an unknown --repos value was accepted"

hdr "A production-sized board (the ARG_MAX failure-open)"

# THIS IS THE ONE THAT ESCAPED. The first live run against the real board —
# 300 issues carrying full descriptions — died with
#
#     jq: Argument list too long
#
# and then printed "no scope residue" and exited 0. Passing the board through
# --argjson puts every byte of it in jq's argv, and ARG_MAX is around 2 MB.
# The small fixtures above are nowhere near it, so the whole suite passed
# while the tool failed OPEN on the only path that matters: a false clean is
# what tells an operator it is safe to unbind an agent's PEM.
#
# The board is now passed by --slurpfile, and every jq is wrapped so that a
# non-zero exit or empty output is fatal instead of reading as a clean board.
# This fixture reproduces the original size: ~400 issues x ~8 KB of text is
# comfortably past ARG_MAX, and one of them is real residue that must be found.
python3 - "$WORK/issues_big.json" <<'PY' 2>/dev/null || jq -n '[]' > "$WORK/issues_big.json"
import json, sys
pad = "lorem ipsum dolor sit amet " * 300          # ~8 KB per issue
rows = [{"issueNumber": 1000 + i, "status": "backlog", "projectId": None,
         "title": f"filler issue {i}",
         "description": f"no repository named here. {pad}"} for i in range(400)]
rows.append({"issueNumber": 290, "status": "backlog", "projectId": None,
             "title": "omniroute_combo_cli.sh selftest is not hermetic",
             "description": "lives in paperclip-ops-tooling. " + pad})
json.dump(rows, open(sys.argv[1], "w"))
PY

if [[ "$(jq 'length' "$WORK/issues_big.json")" -gt 1 ]]; then
  bytes="$(wc -c < "$WORK/issues_big.json")"
  bout2="$(env -i PATH="$PATH" HOME="$WORK" TMPDIR="$WORK" \
    SCOPE_RESIDUE_PROJECTS_JSON="$WORK/projects.json" \
    SCOPE_RESIDUE_ISSUES_JSON="$WORK/issues_big.json" \
    bash "$TOOL" --json 2>"$WORK/big.err")"; brc2=$?

  [[ "$bytes" -gt 2097152 ]] \
    && ok "fixture is past ARG_MAX ($bytes bytes)" \
    || bad "fixture is only $bytes bytes — too small to reproduce the bug"

  [[ "$brc2" -eq 1 ]] \
    && ok "exit 1 on a production-sized board with residue (did not fail open)" \
    || bad "expected exit 1 at scale, got $brc2 — $(head -1 "$WORK/big.err")"

  [[ "$(printf '%s' "$bout2" | jq -r '[.residue[] | select(.issue==290)] | length' 2>/dev/null)" == 1 ]] \
    && ok "TOG-290 still found among 401 issues" \
    || bad "residue lost at scale"

  grep -qi 'argument list too long' "$WORK/big.err" \
    && bad "still passing the board through argv" \
    || ok "no ARG_MAX error at production size"
else
  bad "could not build the large fixture (python3 missing?)"
fi

hdr "Refuses to certify a board it cannot scope"

echo '[{"id":"p","name":"No Repos","env":{}}]' > "$WORK/projects_empty.json"
env -i PATH="$PATH" HOME="$WORK" TMPDIR="$WORK" \
  SCOPE_RESIDUE_PROJECTS_JSON="$WORK/projects_empty.json" \
  SCOPE_RESIDUE_ISSUES_JSON="$WORK/issues.json" \
  bash "$TOOL" --json >/dev/null 2>&1
[[ $? -eq 2 ]] \
  && ok "exit 2 when no project pins GH_APP_REPOS (not a false clean)" \
  || bad "reported a clean sweep with nothing mintable"

# =========================================================================
hdr "Credentials never reach argv (TOG-200)"

# A stub curl that records the kernel's view of its own argv and answers with
# a board, so the script runs to completion instead of dying on empty input.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
tr '\0' '\n' < "/proc/$$/cmdline" >> "$ARGV_LOG"
cfg=""
for ((i=1; i<=$#; i++)); do
  if [[ "${!i}" == "--config" ]]; then j=$((i+1)); cfg="${!j}"; fi
done
[[ -n "$cfg" && -r "$cfg" ]] && cat "$cfg" >> "$CFG_LOG"
if [[ -n "$cfg" ]] && grep -q '/projects' "$cfg"; then cat "$PROJECTS_SRC"
else cat "$ISSUES_SRC"; fi
STUB
chmod +x "$WORK/bin/curl"

CANARY='pk_live_CANARY_board_key_2f9a1c'
: > "$WORK/argv.log"; : > "$WORK/cfg.log"

env -i PATH="$WORK/bin:$PATH" HOME="$WORK" TMPDIR="$WORK" \
    ARGV_LOG="$WORK/argv.log" CFG_LOG="$WORK/cfg.log" \
    PROJECTS_SRC="$WORK/projects.json" ISSUES_SRC="$WORK/issues.json" \
    PAPERCLIP_API_URL="https://example.invalid/api" \
    PAPERCLIP_API_KEY="$CANARY" \
    PAPERCLIP_COMPANY_ID="company-uuid" \
    bash "$TOOL" --json >/dev/null 2>&1

# Negative: the key is not in what a neighbour could read from /proc.
grep -q -- "$CANARY" "$WORK/argv.log" \
  && bad "PAPERCLIP_API_KEY LEAKED into curl argv" \
  || ok "PAPERCLIP_API_KEY absent from curl argv"

# Positive, and it is the load-bearing half: prove the key actually reached
# curl by the config file. Without this, a script that sends no credential at
# all — and so reads an empty board and reports CLEAN — passes the test above.
grep -q "Authorization: Bearer $CANARY" "$WORK/cfg.log" \
  && ok "PAPERCLIP_API_KEY did reach curl, via the 0600 config file" \
  || bad "credential never reached curl — the no-leak result is meaningless"

grep -q -- "--config" "$WORK/argv.log" \
  && ok "only the config path appears in argv" \
  || bad "curl was not invoked with --config"

# The GitHub token travels the same path.
: > "$WORK/argv.log"; : > "$WORK/cfg.log"
GH_CANARY='ghs_CANARY_installation_token_7b3'
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
tr '\0' '\n' < "/proc/$$/cmdline" >> "$ARGV_LOG"
cfg=""
for ((i=1; i<=$#; i++)); do
  if [[ "${!i}" == "--config" ]]; then j=$((i+1)); cfg="${!j}"; fi
done
[[ -n "$cfg" && -r "$cfg" ]] && cat "$cfg" >> "$CFG_LOG"
if [[ -n "$cfg" ]] && grep -q 'api.github.com' "$cfg"; then echo '[]'
elif [[ -n "$cfg" ]] && grep -q '/projects' "$cfg"; then cat "$PROJECTS_SRC"
else cat "$ISSUES_SRC"; fi
STUB
chmod +x "$WORK/bin/curl"

env -i PATH="$WORK/bin:$PATH" HOME="$WORK" TMPDIR="$WORK" \
    ARGV_LOG="$WORK/argv.log" CFG_LOG="$WORK/cfg.log" \
    PROJECTS_SRC="$WORK/projects.json" ISSUES_SRC="$WORK/issues.json" \
    PAPERCLIP_API_URL="https://example.invalid/api" \
    PAPERCLIP_API_KEY="$CANARY" \
    PAPERCLIP_COMPANY_ID="company-uuid" \
    GH_TOKEN="$GH_CANARY" GH_APP_ORG="TogetherWeOwn" \
    bash "$TOOL" --branches --json >/dev/null 2>&1

grep -q -- "$GH_CANARY" "$WORK/argv.log" \
  && bad "GH_TOKEN LEAKED into curl argv" \
  || ok "GH_TOKEN absent from curl argv"

grep -q "Authorization: Bearer $GH_CANARY" "$WORK/cfg.log" \
  && ok "GH_TOKEN did reach curl, via the 0600 config file" \
  || bad "GH_TOKEN never reached curl — the no-leak result is meaningless"

hdr "Mints nothing"

# The whole point of this check is that it is safe to run in a loop and in CI.
# If it ever learns to mint, it stops being safe and this assertion is the
# tripwire. Comments are stripped first: the header names both minting tools
# in prose, to say that it does not call them.
grep -vE '^[[:space:]]*#' "$TOOL" \
  | grep -qE 'gh_token\.sh|gh-app-token\.js|access_tokens' \
  && bad "the script references a minting path" \
  || ok "no minting path referenced anywhere in the script"

hdr "Fails closed when GitHub cannot be read"

cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
cfg=""
for ((i=1; i<=$#; i++)); do
  if [[ "${!i}" == "--config" ]]; then j=$((i+1)); cfg="${!j}"; fi
done
if [[ -n "$cfg" ]] && grep -q 'api.github.com' "$cfg"; then
  echo '{"message":"Bad credentials"}'; exit 0
elif [[ -n "$cfg" ]] && grep -q '/projects' "$cfg"; then cat "$PROJECTS_SRC"
else cat "$ISSUES_SRC"; fi
STUB
chmod +x "$WORK/bin/curl"

env -i PATH="$WORK/bin:$PATH" HOME="$WORK" TMPDIR="$WORK" \
    PROJECTS_SRC="$WORK/projects.json" ISSUES_SRC="$WORK/issues.json" \
    PAPERCLIP_API_URL="https://example.invalid/api" \
    PAPERCLIP_API_KEY="$CANARY" PAPERCLIP_COMPANY_ID="c" \
    GH_TOKEN="$GH_CANARY" \
    bash "$TOOL" --branches --json >/dev/null 2>&1
[[ $? -eq 2 ]] \
  && ok "exit 2 when a repo's branches cannot be listed (not a false clean)" \
  || bad "an unreadable repo did not fail closed"

hdr "Leaves no config file behind"

shopt -s nullglob
leftovers=("$WORK"/gh_scope_residue.*/curlcfg.*)
[[ ${#leftovers[@]} -eq 0 ]] \
  && ok "no curl config files survive the run" \
  || bad "${#leftovers[@]} config file(s) left on disk"

printf '\n\033[1mtotal\033[0m  %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
