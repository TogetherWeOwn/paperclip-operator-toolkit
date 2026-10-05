#!/usr/bin/env bash
# ===========================================================================
# test_gh_override_scope_audit.sh — override-narrowing audit suite.
#
# gh_override_scope_audit.sh is a drift detector for issue-level
# GH_APP_PERMISSIONS overrides that narrow a run
# below its project's approved pin. The broker intersects the run env against
# the project profile, so a stale override mints a token narrower than every
# project-level audit says the run holds — and GitHub refuses the workflow push
# while the pins read green.
#
# A detector is worth exactly what its failure modes are worth:
#
#   fail-open   it reports clean on a state that is not clean. Every case that
#               ends in "exit 1" guards this: the exact stale-override fixture
#               against the example pin, a level-drop (write->read), a
#               widened override the broker would 403, an unparseable override
#               the broker would ScopeError, and a repo override outside the pin.
#
#   cry-wolf    it reports drift on a correct state and gets muted. Key order
#               is not drift; a matching override is OK; a non-literal
#               (secret_ref) override takes the project profile and is OK; repo
#               NARROWING is legitimate single-repo slicing and is info, not a
#               finding.
#
# And worse than either: a run that establishes NOTHING and exits 0. An
# unreadable board/fixture, zero projects, and zero issue rows are all
# INDETERMINATE (exit 3).
#
# Entirely offline: every case builds its own issue and project fixtures. No
# socket is opened, no credential is read.
#
# Exit: 0 all assertions held | 1 at least one did not | 2 setup error
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE" || exit 2

AUDIT="$HERE/gh_override_scope_audit.sh"

[[ -x "$AUDIT" ]] || { echo "ERROR: missing $AUDIT" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required" >&2; exit 2; }

TMP="$(mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}/override-audit-XXXXXX")" || exit 2
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); shift; [[ $# -gt 0 ]] && sed 's/^/        /' <<<"$*"; }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

EXAMPLE_PID="00000000-0000-4000-8000-0000000000a1"
EXAMPLE_PERMS="contents=write,pull_requests=write,issues=write,metadata=read,checks=read,statuses=read,workflows=write,actions=read"
EXAMPLE_REPOS="example-repo"
STALE_PERMS="contents=write,pull_requests=write,issues=write,metadata=read"

write_projects() {  # <file> <pid> <name> <perms> <repos>
  jq -n --arg id "$2" --arg name "$3" --arg p "$4" --arg r "$5" \
    '[{id:$id,name:$name,env:{GH_APP_PERMISSIONS:{type:"plain",value:$p},GH_APP_REPOS:{type:"plain",value:$r}}}]' > "$1"
}

write_issue() {  # <file> <identifier> <pid> <perms-or-EMPTY> <repos-or-EMPTY>
  # OMIT (not null) the env key when EMPTY: the audit reads a missing key as
  # "no override", and `null` must mean the same. Emitting explicit nulls once
  # masked a field-misalignment bug in the audit by shifting columns, so the
  # fixture mirrors the live shape — absent keys are absent.
  local file="$1" ident="$2" pid="$3" perms="$4" repos="$5"
  local penv renv
  if [[ "$perms" == "EMPTY" ]]; then penv='null';
  elif [[ "$perms" == "SECRETREF" ]]; then penv='{"type":"secret_ref","secretId":"00000000-0000-0000-0000-000000000000","version":"latest"}';
  else penv=$(jq -n --arg v "$perms" '{type:"plain",value:$v}'); fi
  if [[ "$repos" == "EMPTY" ]]; then renv='null'; else renv=$(jq -n --arg v "$repos" '{type:"plain",value:$v}'); fi
  jq -n --arg i "$ident" --arg p "$pid" --argjson pe "$penv" --argjson re "$renv" \
    '[{identifier:$i,id:"11111111-2222-3333-4444-555555555555",projectId:$p,status:"in_progress",assigneeAdapterOverrides:{adapterConfig:{env:(if $pe == null and $re == null then {} elif $pe == null then {GH_APP_REPOS:$re} elif $re == null then {GH_APP_PERMISSIONS:$pe} else {GH_APP_PERMISSIONS:$pe,GH_APP_REPOS:$re} end)}}}]' > "$file"
}

run_audit() {  # <issues> <projects> [extra args...] -> stdout; RC in $RC
  OUT="$(OVERRIDE_AUDIT_ISSUES_JSON="$1" OVERRIDE_AUDIT_PROJECTS_JSON="$2" "$AUDIT" "${@:3}")"
  RC=$?
}

hdr "fail-open: the TASK-6385 shape is NARROWED-WORKFLOWS, not clean"
write_projects "$TMP/proj.json" "$EXAMPLE_PID" "Example" "$EXAMPLE_PERMS" "$EXAMPLE_REPOS"
write_issue "$TMP/iss.json" "TASK-6385" "$EXAMPLE_PID" "$STALE_PERMS" "EMPTY"
run_audit "$TMP/iss.json" "$TMP/proj.json"
[[ $RC -eq 1 ]] && ok "stale override exits 1" || bad "stale override exits 1 (got $RC)" "$OUT"
echo "$OUT" | grep -q "NARROWED-WORKFLOWS" && echo "$OUT" | grep -q "TASK-6385" \
  && ok "verdict names NARROWED-WORKFLOWS on TASK-6385" \
  || bad "verdict names NARROWED-WORKFLOWS on TASK-6385" "$OUT"
echo "$OUT" | grep -q "workflows" \
  && ok "detail names the dropped workflows permission" \
  || bad "detail names the dropped workflows permission" "$OUT"

hdr "fail-open: narrower without workflows loss is still NARROWED"
write_issue "$TMP/iss2.json" "TASK-X" "$EXAMPLE_PID" "contents=write,pull_requests=write,issues=write,metadata=read,checks=read,statuses=read,workflows=write" "EMPTY"
run_audit "$TMP/iss2.json" "$TMP/proj.json"
[[ $RC -eq 1 ]] && echo "$OUT" | grep -q "NARROWED" \
  && ok "actions=read drop is NARROWED, exit 1" \
  || bad "actions=read drop is NARROWED, exit 1 (got $RC)" "$OUT"

hdr "fail-open: a level drop (write->read) is NARROWED"
write_issue "$TMP/iss3.json" "TASK-Y" "$EXAMPLE_PID" "contents=read,pull_requests=write,issues=write,metadata=read,checks=read,statuses=read,workflows=write,actions=read" "EMPTY"
run_audit "$TMP/iss3.json" "$TMP/proj.json"
[[ $RC -eq 1 ]] && echo "$OUT" | grep -q "NARROWED" \
  && ok "contents write->read is NARROWED, exit 1" \
  || bad "contents write->read is NARROWED, exit 1 (got $RC)" "$OUT"

hdr "fail-open: widened override (broker would 403) is WIDENED"
write_issue "$TMP/iss4.json" "TASK-Z" "$EXAMPLE_PID" "$EXAMPLE_PERMS,administration=write" "EMPTY"
run_audit "$TMP/iss4.json" "$TMP/proj.json"
[[ $RC -eq 1 ]] && echo "$OUT" | grep -q "WIDENED" \
  && ok "administration=write excess is WIDENED, exit 1" \
  || bad "administration=write excess is WIDENED, exit 1 (got $RC)" "$OUT"

hdr "fail-open: unparseable override is INVALID"
write_issue "$TMP/iss5.json" "TASK-BAD" "$EXAMPLE_PID" "contents-write" "EMPTY"
run_audit "$TMP/iss5.json" "$TMP/proj.json"
[[ $RC -eq 1 ]] && echo "$OUT" | grep -q "INVALID" \
  && ok "malformed spec is INVALID, exit 1" \
  || bad "malformed spec is INVALID, exit 1 (got $RC)" "$OUT"

hdr "fail-open: repo override outside the pin is REPO-WIDENED"
write_projects "$TMP/proj6.json" "$EXAMPLE_PID" "Example" "$EXAMPLE_PERMS" "$EXAMPLE_REPOS"
write_issue "$TMP/iss6.json" "TASK-R" "$EXAMPLE_PID" "EMPTY" "example-repo,other-repo"
run_audit "$TMP/iss6.json" "$TMP/proj6.json"
[[ $RC -eq 1 ]] && echo "$OUT" | grep -q "REPO-WIDENED" \
  && ok "foreign repo is REPO-WIDENED, exit 1" \
  || bad "foreign repo is REPO-WIDENED, exit 1 (got $RC)" "$OUT"

hdr "cry-wolf: matching override (shuffled key order) is OK"
write_issue "$TMP/iss7.json" "TASK-OK" "$EXAMPLE_PID" "workflows=write,metadata=read,issues=write,contents=write,actions=read,statuses=read,checks=read,pull_requests=write" "EMPTY"
run_audit "$TMP/iss7.json" "$TMP/proj.json"
[[ $RC -eq 0 ]] && echo "$OUT" | grep -q "OK" \
  && ok "shuffled matching override is OK, exit 0" \
  || bad "shuffled matching override is OK, exit 0 (got $RC)" "$OUT"

hdr "cry-wolf: secret_ref override takes the project profile, not a finding"
write_issue "$TMP/iss8.json" "TASK-SR" "$EXAMPLE_PID" "SECRETREF" "EMPTY"
run_audit "$TMP/iss8.json" "$TMP/proj.json"
[[ $RC -eq 0 ]] \
  && ok "secret_ref override is OK, exit 0" \
  || bad "secret_ref override is OK, exit 0 (got $RC)" "$OUT"

hdr "cry-wolf: repo narrowing is info, not a finding"
write_projects "$TMP/proj9.json" "00000000-0000-4000-8000-0000000000a2" "Ops Tooling" "contents=write,workflows=write" "paperclip-ops-tooling,paperclip"
write_issue "$TMP/iss9.json" "TASK-SLICE" "00000000-0000-4000-8000-0000000000a2" "contents=write,workflows=write" "paperclip-ops-tooling"
run_audit "$TMP/iss9.json" "$TMP/proj9.json"
[[ $RC -eq 0 ]] && echo "$OUT" | grep -q "OK" \
  && ok "single-repo slice is OK, exit 0" \
  || bad "single-repo slice is OK, exit 0 (got $RC)" "$OUT"

hdr "cry-wolf: issue with no override is skipped, not flagged"
jq -n '[{identifier:"TASK-PLAIN",id:"11111111-2222-3333-4444-555555555555",projectId:"'$EXAMPLE_PID'",status:"in_progress"}]' > "$TMP/iss10.json"
run_audit "$TMP/iss10.json" "$TMP/proj.json"
[[ $RC -eq 0 ]] \
  && ok "override-free issue exits 0" \
  || bad "override-free issue exits 0 (got $RC)" "$OUT"

hdr "cry-wolf: literal override vs pin-less project is UNKNOWN-CEILING, not PROJECT-INVALID"
# The project filter emits \x01 for absent pins; the audit must
# restore it to empty before comparing, or a correct state reads as a finding.
NOPIN_PID="00000000-0000-0000-0000-000000000000"
jq -n --arg id "$NOPIN_PID" '[{id:$id,name:"Nopin",env:{}}]' > "$TMP/proj-nopin.json"
write_issue "$TMP/iss-nopin.json" "TASK-NOPIN" "$NOPIN_PID" "contents=write" "EMPTY"
run_audit "$TMP/iss-nopin.json" "$TMP/proj-nopin.json"
[[ $RC -eq 3 ]] && echo "$OUT" | grep -q "UNKNOWN-CEILING" \
  && ok "perms override vs unpinned project is UNKNOWN-CEILING, exit 3" \
  || bad "perms override vs unpinned project is UNKNOWN-CEILING, exit 3 (got $RC)" "$OUT"

hdr "cry-wolf: repos-only override vs project with no repos pin is info, not REPO-WIDENED"
# Same sentinel root cause, repos half: unpinned ceiling is unreadable live,
# so the comparison is info inside an OK row, never a finding.
jq -n --arg id "$NOPIN_PID" --arg p "contents=write" '[{id:$id,name:"Nopin",env:{GH_APP_PERMISSIONS:{type:"plain",value:$p}}}]' > "$TMP/proj-norepos.json"
write_issue "$TMP/iss-norepos.json" "TASK-NOREPOS" "$NOPIN_PID" "EMPTY" "some-repo"
run_audit "$TMP/iss-norepos.json" "$TMP/proj-norepos.json"
[[ $RC -eq 0 ]] && echo "$OUT" | grep -q "unpinned project" \
  && ok "repos override vs unpinned project is info, exit 0" \
  || bad "repos override vs unpinned project is info, exit 0 (got $RC)" "$OUT"

hdr "indeterminate: unknown ceiling is exit 3, never a pass"
jq -n '[{identifier:"TASK-NOPROJ",id:"11111111-2222-3333-4444-555555555555",projectId:null,status:"in_progress",assigneeAdapterOverrides:{adapterConfig:{env:{GH_APP_PERMISSIONS:{type:"plain",value:"contents=write"}}}}}]' > "$TMP/iss11.json"
run_audit "$TMP/iss11.json" "$TMP/proj.json"
[[ $RC -eq 3 ]] && echo "$OUT" | grep -q "UNKNOWN-CEILING" \
  && ok "project-less override is UNKNOWN-CEILING, exit 3" \
  || bad "project-less override is UNKNOWN-CEILING, exit 3 (got $RC)" "$OUT"

hdr "indeterminate: missing fixtures are exit 3"
OUT="$(env -u OVERRIDE_AUDIT_ISSUES_JSON -u OVERRIDE_AUDIT_PROJECTS_JSON PAPERCLIP_API_KEY='' PAPERCLIP_API_COMPANY_ID='' "$AUDIT" 2>&1)"
RC=$?
[[ $RC -eq 3 ]] \
  && ok "no credential and no fixture is INDETERMINATE, not a pass" \
  || bad "no credential and no fixture is INDETERMINATE (got $RC)" "$OUT"

# Live-board section intentionally absent: asserting live card state
# requires production access, which public CI never has. The stale
# shape stays pinned by the hermetic TASK-6385 fixture above.

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
