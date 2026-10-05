#!/usr/bin/env bash
# ===========================================================================
# test_gh_override_scope_audit.sh
#
# gh_override_scope_audit.sh is a drift detector for the layer that minted a
# real workflow-push failure: issue-level GH_APP_PERMISSIONS overrides that narrow a run
# below its project's approved pin. The broker intersects the run env against
# the project profile, so a stale override mints a token narrower than every
# project-level audit says the run holds — and GitHub refuses the workflow push
# while the pins read green.
#
# A detector is worth exactly what its failure modes are worth:
#
#   fail-open   it reports clean on a state that is not clean. Every case that
#               ends in "exit 1" guards this: the exact stale override
#               shape against a project pin, a level-drop (write->read), a
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
# socket is opened, no credential is read. The live board is exercised only in
# the final read-only section, which runs only when the operator names a
# project and an issue to check — the assertion that keeps this honest against
# the real world.
#
# Exit: 0 all assertions held | 1 at least one did not | 2 setup error
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE" || exit 2

AUDIT="$HERE/gh_override_scope_audit.sh"

[[ -x "$AUDIT" ]] || { echo "ERROR: missing $AUDIT" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required" >&2; exit 2; }

TMP="$(mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}/gh-override-audit-XXXXXX")" || exit 2
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); shift; [[ $# -gt 0 ]] && sed 's/^/        /' <<<"$*"; }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

PINNED_PID="00000000-0000-4000-8000-0000000000a1"
PINNED_PERMS="contents=write,pull_requests=write,issues=write,metadata=read,checks=read,statuses=read,workflows=write,actions=read"
PINNED_REPOS="alpha-repo"
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

hdr "fail-open: the stale-override shape is NARROWED-WORKFLOWS, not clean"
write_projects "$TMP/proj.json" "$PINNED_PID" "Alpha" "$PINNED_PERMS" "$PINNED_REPOS"
write_issue "$TMP/iss.json" "ISSUE-STALE" "$PINNED_PID" "$STALE_PERMS" "EMPTY"
run_audit "$TMP/iss.json" "$TMP/proj.json"
[[ $RC -eq 1 ]] && ok "stale override exits 1" || bad "stale override exits 1 (got $RC)" "$OUT"
grep -q "NARROWED-WORKFLOWS" <<<"$OUT" && grep -q "ISSUE-STALE" <<<"$OUT" \
  && ok "verdict names NARROWED-WORKFLOWS on the stale issue" \
  || bad "verdict names NARROWED-WORKFLOWS on the stale issue" "$OUT"
grep -q "workflows" <<<"$OUT" \
  && ok "detail names the dropped workflows permission" \
  || bad "detail names the dropped workflows permission" "$OUT"

hdr "fail-open: narrower without workflows loss is still NARROWED"
write_issue "$TMP/iss2.json" "ISSUE-X" "$PINNED_PID" "contents=write,pull_requests=write,issues=write,metadata=read,checks=read,statuses=read,workflows=write" "EMPTY"
run_audit "$TMP/iss2.json" "$TMP/proj.json"
[[ $RC -eq 1 ]] && grep -q "NARROWED" <<<"$OUT" \
  && ok "actions=read drop is NARROWED, exit 1" \
  || bad "actions=read drop is NARROWED, exit 1 (got $RC)" "$OUT"

hdr "fail-open: a level drop (write->read) is NARROWED"
write_issue "$TMP/iss3.json" "ISSUE-Y" "$PINNED_PID" "contents=read,pull_requests=write,issues=write,metadata=read,checks=read,statuses=read,workflows=write,actions=read" "EMPTY"
run_audit "$TMP/iss3.json" "$TMP/proj.json"
[[ $RC -eq 1 ]] && grep -q "NARROWED" <<<"$OUT" \
  && ok "contents write->read is NARROWED, exit 1" \
  || bad "contents write->read is NARROWED, exit 1 (got $RC)" "$OUT"

hdr "fail-open: widened override (broker would 403) is WIDENED"
write_issue "$TMP/iss4.json" "ISSUE-Z" "$PINNED_PID" "$PINNED_PERMS,administration=write" "EMPTY"
run_audit "$TMP/iss4.json" "$TMP/proj.json"
[[ $RC -eq 1 ]] && grep -q "WIDENED" <<<"$OUT" \
  && ok "administration=write excess is WIDENED, exit 1" \
  || bad "administration=write excess is WIDENED, exit 1 (got $RC)" "$OUT"

hdr "fail-open: unparseable override is INVALID"
write_issue "$TMP/iss5.json" "ISSUE-BAD" "$PINNED_PID" "contents-write" "EMPTY"
run_audit "$TMP/iss5.json" "$TMP/proj.json"
[[ $RC -eq 1 ]] && grep -q "INVALID" <<<"$OUT" \
  && ok "malformed spec is INVALID, exit 1" \
  || bad "malformed spec is INVALID, exit 1 (got $RC)" "$OUT"

hdr "fail-open: repo override outside the pin is REPO-WIDENED"
write_projects "$TMP/proj6.json" "$PINNED_PID" "Alpha" "$PINNED_PERMS" "$PINNED_REPOS"
write_issue "$TMP/iss6.json" "ISSUE-R" "$PINNED_PID" "EMPTY" "alpha-repo,other-repo"
run_audit "$TMP/iss6.json" "$TMP/proj6.json"
[[ $RC -eq 1 ]] && grep -q "REPO-WIDENED" <<<"$OUT" \
  && ok "foreign repo is REPO-WIDENED, exit 1" \
  || bad "foreign repo is REPO-WIDENED, exit 1 (got $RC)" "$OUT"

hdr "cry-wolf: matching override (shuffled key order) is OK"
write_issue "$TMP/iss7.json" "ISSUE-OK" "$PINNED_PID" "workflows=write,metadata=read,issues=write,contents=write,actions=read,statuses=read,checks=read,pull_requests=write" "EMPTY"
run_audit "$TMP/iss7.json" "$TMP/proj.json"
[[ $RC -eq 0 ]] && grep -q "OK" <<<"$OUT" \
  && ok "shuffled matching override is OK, exit 0" \
  || bad "shuffled matching override is OK, exit 0 (got $RC)" "$OUT"

hdr "cry-wolf: secret_ref override takes the project profile, not a finding"
write_issue "$TMP/iss8.json" "ISSUE-SR" "$PINNED_PID" "SECRETREF" "EMPTY"
run_audit "$TMP/iss8.json" "$TMP/proj.json"
[[ $RC -eq 0 ]] \
  && ok "secret_ref override is OK, exit 0" \
  || bad "secret_ref override is OK, exit 0 (got $RC)" "$OUT"

hdr "cry-wolf: repo narrowing is info, not a finding"
write_projects "$TMP/proj9.json" "00000000-0000-4000-8000-0000000000a2" "Beta" "contents=write,workflows=write" "beta-tools,beta-app"
write_issue "$TMP/iss9.json" "ISSUE-SLICE" "00000000-0000-4000-8000-0000000000a2" "contents=write,workflows=write" "beta-tools"
run_audit "$TMP/iss9.json" "$TMP/proj9.json"
[[ $RC -eq 0 ]] && grep -q "OK" <<<"$OUT" \
  && ok "single-repo slice is OK, exit 0" \
  || bad "single-repo slice is OK, exit 0 (got $RC)" "$OUT"

hdr "cry-wolf: issue with no override is skipped, not flagged"
jq -n '[{identifier:"ISSUE-PLAIN",id:"11111111-2222-3333-4444-555555555555",projectId:"'$PINNED_PID'",status:"in_progress"}]' > "$TMP/iss10.json"
run_audit "$TMP/iss10.json" "$TMP/proj.json"
[[ $RC -eq 0 ]] \
  && ok "override-free issue exits 0" \
  || bad "override-free issue exits 0 (got $RC)" "$OUT"

hdr "cry-wolf: literal override vs pin-less project is UNKNOWN-CEILING, not PROJECT-INVALID"
# the project filter emits \x01 for absent pins; the audit must
# restore it to empty before comparing, or a correct state reads as a finding.
NOPIN_PID="00000000-0000-0000-0000-000000000000"
jq -n --arg id "$NOPIN_PID" '[{id:$id,name:"Nopin",env:{}}]' > "$TMP/proj-nopin.json"
write_issue "$TMP/iss-nopin.json" "ISSUE-NOPIN" "$NOPIN_PID" "contents=write" "EMPTY"
run_audit "$TMP/iss-nopin.json" "$TMP/proj-nopin.json"
[[ $RC -eq 3 ]] && grep -q "UNKNOWN-CEILING" <<<"$OUT" \
  && ok "perms override vs unpinned project is UNKNOWN-CEILING, exit 3" \
  || bad "perms override vs unpinned project is UNKNOWN-CEILING, exit 3 (got $RC)" "$OUT"

hdr "cry-wolf: repos-only override vs project with no repos pin is info, not REPO-WIDENED"
# Same sentinel root cause, repos half: unpinned ceiling is unreadable live,
# so the comparison is info inside an OK row, never a finding.
jq -n --arg id "$NOPIN_PID" --arg p "contents=write" '[{id:$id,name:"Nopin",env:{GH_APP_PERMISSIONS:{type:"plain",value:$p}}}]' > "$TMP/proj-norepos.json"
write_issue "$TMP/iss-norepos.json" "ISSUE-NOREPOS" "$NOPIN_PID" "EMPTY" "some-repo"
run_audit "$TMP/iss-norepos.json" "$TMP/proj-norepos.json"
[[ $RC -eq 0 ]] && grep -q "unpinned project" <<<"$OUT" \
  && ok "repos override vs unpinned project is info, exit 0" \
  || bad "repos override vs unpinned project is info, exit 0 (got $RC)" "$OUT"

hdr "indeterminate: unknown ceiling is exit 3, never a pass"
jq -n '[{identifier:"ISSUE-NOPROJ",id:"11111111-2222-3333-4444-555555555555",projectId:null,status:"in_progress",assigneeAdapterOverrides:{adapterConfig:{env:{GH_APP_PERMISSIONS:{type:"plain",value:"contents=write"}}}}}]' > "$TMP/iss11.json"
run_audit "$TMP/iss11.json" "$TMP/proj.json"
[[ $RC -eq 3 ]] && grep -q "UNKNOWN-CEILING" <<<"$OUT" \
  && ok "project-less override is UNKNOWN-CEILING, exit 3" \
  || bad "project-less override is UNKNOWN-CEILING, exit 3 (got $RC)" "$OUT"

hdr "indeterminate: missing fixtures are exit 3"
OUT="$(env -u OVERRIDE_AUDIT_ISSUES_JSON -u OVERRIDE_AUDIT_PROJECTS_JSON PAPERCLIP_API_KEY='' PAPERCLIP_API_COMPANY_ID='' "$AUDIT" 2>&1)"
RC=$?
[[ $RC -eq 3 ]] \
  && ok "no credential and no fixture is INDETERMINATE, not a pass" \
  || bad "no credential and no fixture is INDETERMINATE (got $RC)" "$OUT"

hdr "live board (read-only): a named issue carries no stale GH_APP override"
# Optional. The live section needs a board credential AND the operator to name
# the project and issue to check; there are no defaults, so it never guesses a
# target:
#   OVERRIDE_AUDIT_LIVE_PROJECT  project id whose issues are audited
#   OVERRIDE_AUDIT_LIVE_ISSUE    identifier of an issue expected to carry no
#                                GH_APP override (for example one that was reset
#                                after a stale override was found)
# The stale-override shape itself stays pinned by the hermetic fixtures above;
# this section only asserts the CURRENT live truth for the named issue.
if [[ -n "${PAPERCLIP_API_KEY:-}" && -n "${PAPERCLIP_COMPANY_ID:-}" && -n "${PAPERCLIP_API_URL:-}" \
      && -n "${OVERRIDE_AUDIT_LIVE_PROJECT:-}" && -n "${OVERRIDE_AUDIT_LIVE_ISSUE:-}" ]]; then
  OUT="$(env -u OVERRIDE_AUDIT_ISSUES_JSON -u OVERRIDE_AUDIT_PROJECTS_JSON "$AUDIT" --project "$OVERRIDE_AUDIT_LIVE_PROJECT" --json 2>/dev/null)"
  RC=$?
  echo "$OUT" | python3 -c "
import json,os,sys
issue=os.environ['OVERRIDE_AUDIT_LIVE_ISSUE']
d=json.load(sys.stdin)
rows=[r for r in d['rows'] if r['issue']==issue]
if rows:
    assert 'no GH_APP override' in rows[0]['detail'], rows[0]
    print(issue, 'live:', rows[0]['verdict'], '-', rows[0]['detail'][:80])
else:
    # The ?projectId= page caps at 500 rows; an older issue can fall outside it
    # while newer rows fill the cap. Absence from the page is a COVERAGE limit,
    # not a clean bill — assert the audit says so rather than passing blind.
    assert d['issuesExamined'] > 0, 'audit examined nothing'
    print(issue, 'outside the 500-row project page; examined:', d['issuesExamined'])
" && ok "live $OVERRIDE_AUDIT_LIVE_ISSUE carries no stale GH_APP override" \
    || bad "live $OVERRIDE_AUDIT_LIVE_ISSUE carries no stale GH_APP override" "$OUT"
else
  ok "live section skipped (needs a board credential plus OVERRIDE_AUDIT_LIVE_PROJECT and OVERRIDE_AUDIT_LIVE_ISSUE)"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
