#!/usr/bin/env bash
# Offline regression suite for responsible-leader derivation and the review
# authority it grants. NO DATABASE, NO CREDENTIALS, NO NETWORK — this is what
# CI runs, and it is the only automated coverage the authorization change has.
#
# test_request_queue.sh is the live counterpart. It is better evidence and it
# cannot run in CI: it needs COMPANY_ID and a real Postgres via `podman exec`,
# and it creates and deletes real agents as its method. So the security-critical
# logic added for TOG-194 gets a suite that runs anywhere, built on two seams:
#
#   ORG_SNAPSHOT  a TSV org fixture read instead of the live database
#   PROV          a stub provisioner
#
# The stub's delegation ceiling is EXTRACTED FROM org_provisioner.sh, never
# copied. A stub that carried its own copy of the ceiling would keep passing
# after the real ceiling changed, which is the specific way a fixture suite goes
# quietly wrong.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v jq >/dev/null || { echo "ERROR: jq required" >&2; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export COMPANY_ID="offline-fixture-not-a-real-company"
export QUEUE="$TMP/queue.jsonl"
export GRANT_LOG="$TMP/grant-log.jsonl"
export DISABLED_TEMPLATES="$TMP/disabled"
export ORG_SNAPSHOT="$TMP/org.tsv"
export PROV="$TMP/stub_provisioner.sh"
CREATE_ARGV="$TMP/create.argv"
Q="$HERE/org_request_queue.sh"

PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

must_refuse() { local d="$1"; shift; local o; o="$("$@" 2>&1)"; local rc=$?
  if [[ $rc -ne 0 ]] && grep -q REFUSED <<<"$o"; then ok "$d"
  else bad "$d (rc=$rc)"; sed 's/^/        /' <<<"$o" | head -3; fi; }
must_allow()  { local d="$1"; shift; local o; o="$("$@" 2>&1)"; local rc=$?
  if [[ $rc -eq 0 ]]; then ok "$d"; else bad "$d (rc=$rc)"; sed 's/^/        /' <<<"$o" | head -4; fi; }
eq() { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (got '$2', wanted '$3')"; }
# For commands whose exit STATUS is the contract (findings=1) rather than
# refusal (=2), so the two cannot be conflated.
rc_of() { "$@" >/dev/null 2>&1; echo $?; }

# --- the stub provisioner ---------------------------------------------------
# `ceiling` re-emits the REAL CEILING_JSON. `create` records its argv and
# appends the new agent to the fixture, so an approval is observable end to end.
build_stub() {
  {
    echo '#!/usr/bin/env bash'
    echo 'set -uo pipefail'
    sed -n "/^CEILING_JSON='{/,/^}'\$/p" "$HERE/org_provisioner.sh"
    cat <<'STUB'
[[ -n "${CEILING_JSON:-}" ]] || { echo "stub: failed to extract CEILING_JSON" >&2; exit 90; }
case "${1:-}" in
  ceiling)
    # Deliberately not piped through `column`: the real provisioner runs on a
    # VPS that has util-linux, a CI runner may not, and ceiling_for only ever
    # splits on whitespace anyway.
    jq -r 'to_entries[] | "\(.key)\t\(.value|join(", "))"' <<<"$CEILING_JSON"
    ;;
  create)
    shift; printf '%s\n' "$*" >> "$CREATE_ARGV"
    caller=""; template=""; title=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --caller) caller="$2"; shift 2;;
        --template) template="$2"; shift 2;;
        --title) title="$2"; shift 2;;
        *) shift;;
      esac
    done
    n="$(wc -l < "$ORG_SNAPSHOT")"
    new="u-new-$n"; uuid="$(printf '00000000-0000-4000-8000-%012d' "$n")"
    parent="$(awk -F'\t' -v k="$caller" '($1==k||$2==k){print $1; exit}' "$ORG_SNAPSHOT")"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$uuid" "$new" "$template" "idle" "$parent" "$title" >> "$ORG_SNAPSHOT"
    echo "PROVISIONED $template -> $uuid"
    ;;
  *) echo "stub: unsupported subcommand '${1:-}'" >&2; exit 91;;
esac
STUB
  } > "$PROV"
  chmod +x "$PROV"
  export CREATE_ARGV ORG_SNAPSHOT
}

# --- org fixtures -----------------------------------------------------------
# columns: id, orgRoleId, template, status, reportsTo, title
snapshot() { cat > "$ORG_SNAPSHOT"; }

base_org() {
  snapshot <<'ORG'
u-o1	O1	P1_PRESIDENT_COO	idle		President & COO
u-a0	A0	P4_PROVISIONING_STEWARD	idle	u-o1	Provisioning Steward
u-o3	O3	P3_AUDIT_RISK	idle		Chief Audit & Agent Risk
u-o2	O2	P2_OWNER_COS	idle		Chief of Staff to Owner
u-t0	T0	B2_TECH_CHIEF	running	u-o1	CTO & Chief AI Officer
u-s0	S0	B3_SECURITY_CHIEF	idle	u-o1	CISO
u-dir	DIR	C1_DIRECTOR_BUILDER	idle	u-t0	Director of Engineering
u-mgr	MGR	D1_MANAGER	idle	u-dir	Engineering Manager
u-eng	ENG	E0_SPECIALIST	idle	u-mgr	Web Engineer
ORG
}

reset() { rm -f "$QUEUE" "$GRANT_LOG" "$DISABLED_TEMPLATES" "$CREATE_ARGV"; base_org; }

# `who` emits: mode \t leaderRole \t leaderTemplate \t skipsJson
who() { "$Q" who --requester "$1" --template "$2" 2>/dev/null; }
who_f() { cut -f"$1" <<<"$(who "$2" "$3")"; }
last_sub() { jq -r 'select(.event=="request.submitted")|.requestId' "$QUEUE" | tail -1; }

build_stub
reset

hdr "0. The seams themselves"
must_allow "stub provisioner reports a ceiling" "$PROV" ceiling
eq "extracted ceiling matches org_provisioner.sh for B2_TECH_CHIEF" \
   "$("$PROV" ceiling | awk '$1=="B2_TECH_CHIEF"{$1="";print}' | tr -s ' ' | sed 's/^ //')" \
   "C1_DIRECTOR_BUILDER, C2_PLATFORM_DIRECTOR, D1_MANAGER, D2_ORCHESTRATION_MANAGER, E0_SPECIALIST, E1_REVIEWER_COACH, E2_TOOLING_ADMIN, E3_PIPELINE_BUILDER"

hdr "1. Derivation resolves to the direct manager in the ordinary case"
eq "MGR requesting a specialist -> DIR"        "$(who_f 2 MGR E0_SPECIALIST)"      "DIR"
eq "DIR requesting a manager -> T0"            "$(who_f 2 DIR D1_MANAGER)"         "T0"
eq "T0 requesting a director -> O1"            "$(who_f 2 T0 C1_DIRECTOR_BUILDER)" "O1"
eq "mode is 'leader' for an ordinary request"  "$(who_f 1 MGR E0_SPECIALIST)"      "leader"

hdr "2. A leader may only approve what it could create itself"
# DIR cannot create a C2_PLATFORM_DIRECTOR; T0 can. The walk must pass over DIR.
eq "MGR requesting a platform director skips DIR and lands on T0" \
   "$(who_f 2 MGR C2_PLATFORM_DIRECTOR)" "T0"
eq "  ...and records why DIR was skipped" \
   "$(who_f 4 MGR C2_PLATFORM_DIRECTOR | jq -r '.[0].reason')" "ceiling_insufficient"

hdr "3. Dormancy is NOT a skip reason — the leader is woken, never bypassed"
# This is the design's most likely future regression. If someone 'helpfully'
# adds idle/paused to the skip list, this goes red.
for st in idle paused dormant running; do
  base_org; sed -i "s/^u-dir\tDIR\tC1_DIRECTOR_BUILDER\tidle/u-dir\tDIR\tC1_DIRECTOR_BUILDER\t$st/" "$ORG_SNAPSHOT"
  eq "a '$st' leader still decides" "$(who_f 2 MGR E0_SPECIALIST)" "DIR"
done
reset

hdr "4. Skip rules that DO apply, and the escalation floor"
base_org; sed -i "s/^u-dir\tDIR\tC1_DIRECTOR_BUILDER\tidle/u-dir\tDIR\tC1_DIRECTOR_BUILDER\tterminated/" "$ORG_SNAPSHOT"
eq "a terminated leader is skipped"            "$(who_f 2 MGR E0_SPECIALIST)" "T0"
eq "  ...with the reason recorded"             "$(who_f 4 MGR E0_SPECIALIST | jq -r '.[0].reason')" "terminated"
reset
eq "a root requester (O1) escalates"           "$(who_f 1 O1 E1_REVIEWER_COACH)" "escalate"
eq "audit (O3, root by design) escalates"      "$(who_f 1 O3 E4_AUDIT_ANALYST)"  "escalate"
# Zero-ceiling templates, so the walk never finds a qualifying ancestor and
# actually goes round. A cycle where the first hop qualifies is not a cycle
# the resolver ever has to survive.
snapshot <<'ORG'
u-a	A	D2_ORCHESTRATION_MANAGER	idle	u-b	Cycle A
u-b	B	D2_ORCHESTRATION_MANAGER	idle	u-a	Cycle B
ORG
eq "a malformed (cyclic) chain fails closed"   "$(who_f 1 A E0_SPECIALIST)" "cycle"
reset

hdr "5. Review authority follows derivation"
must_allow "MGR submits a specialist request" \
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ Backend Engineer"
REQ="$(last_sub)"
must_refuse "T0 cannot decide it — an ancestor, but not the RESPONSIBLE one" \
  "$Q" review --reviewer T0 --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"
must_refuse "S0 cannot decide it — a peer chief in another subtree" \
  "$Q" review --reviewer S0 --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"
must_refuse "O2 Chief of Staff cannot decide it" \
  "$Q" review --reviewer O2 --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"
must_refuse "the requester cannot decide its own request" \
  "$Q" review --reviewer MGR --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"
must_allow "DIR — the responsible leader — approves" \
  "$Q" review --reviewer DIR --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"
eq "execution ran as the ORIGINAL REQUESTER, not the reviewer" \
   "$(grep -c -- '--caller MGR' "$CREATE_ARGV")" "1"
eq "  ...and the reviewer could not redirect placement" \
   "$(grep -c -- '--caller DIR' "$CREATE_ARGV")" "0"
must_refuse "an approved request cannot be re-decided" \
  "$Q" review --reviewer DIR --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"

hdr "6. Standing authority is a floor and a break-glass, and the bypass is recorded"
reset
must_allow "MGR submits again" \
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ Second Engineer"
REQ="$(last_sub)"
must_allow "A0 steward may still decide it (break-glass)" \
  "$Q" review --reviewer A0 --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"
eq "the bypass is recorded as an override naming the leader" \
   "$(jq -r --arg r "$REQ" 'select(.requestId==$r and .status=="approved")|.override.bypassedLeader' "$QUEUE")" "DIR"
reset
must_allow "O1 submits a request of its own (escalate mode)" \
  "$Q" submit --requester O1 --template E1_REVIEWER_COACH --title "TESTQ Exec Coach"
REQ="$(last_sub)"
must_refuse "O1 cannot approve its own request despite standing authority" \
  "$Q" review --reviewer O1 --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"
must_allow "A0 can, as the escalation floor" \
  "$Q" review --reviewer A0 --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"
eq "a floor decision is NOT flagged as an override" \
   "$(jq -r --arg r "$REQ" 'select(.requestId==$r and .status=="approved")|.override' "$QUEUE")" "null"

hdr "7. A captive approver inside your own subtree is not a reviewer"
# The steward moved under the CTO. Derivation could never produce this; the
# break-glass path could, and it must not become a way to approve your own work.
snapshot <<'ORG'
u-o1	O1	P1_PRESIDENT_COO	idle		President & COO
u-t0	T0	B2_TECH_CHIEF	running	u-o1	CTO & Chief AI Officer
u-a0	A0	P4_PROVISIONING_STEWARD	idle	u-t0	Captive Steward
ORG
rm -f "$QUEUE"
must_allow "T0 submits a director request" \
  "$Q" submit --requester T0 --template C1_DIRECTOR_BUILDER --title "TESTQ Captive Test"
REQ="$(last_sub)"
must_refuse "the steward inside T0's subtree cannot approve T0's request" \
  "$Q" review --reviewer A0 --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"
eq "  ...and the refusal is logged with its reason" \
   "$(jq -r 'select(.reason=="reviewer_is_descendant_of_requester")|.reason' "$GRANT_LOG" | tail -1)" \
   "reviewer_is_descendant_of_requester"
reset

hdr "8. Deny is a conversation, not a dead end"
must_allow "MGR submits a request that will be denied" \
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ Denied Engineer" \
              --rationale "backlog is 40 issues deep"
REQ1="$(last_sub)"
must_refuse "a denial without a reason is refused — the requester must know what to answer" \
  "$Q" review --reviewer DIR --request "$REQ1" --reject
must_allow "DIR denies with a reason" \
  "$Q" review --reviewer DIR --request "$REQ1" --reject --reason "show the queue depth per week first"
eq "the reason is in the record"  \
   "$(jq -r --arg r "$REQ1" 'select(.requestId==$r and .status=="rejected")|.reason' "$QUEUE")" \
   "show the queue depth per week first"
must_allow "the requester answers on the record" \
  "$Q" comment --request "$REQ1" --author MGR --body "queue depth: 18/22/40 over three weeks"
must_allow "the leader may ask for more without denying again" \
  "$Q" comment --request "$REQ1" --author DIR --body "that is enough, resubmit"
must_refuse "an unrelated agent cannot comment on the exchange" \
  "$Q" comment --request "$REQ1" --author S0 --body "me too"
must_refuse "a different requester cannot supersede someone else's denial" \
  "$Q" submit --requester DIR --template E0_SPECIALIST --title "TESTQ Hijack" --supersedes "$REQ1"
must_allow "the original requester amends and resubmits" \
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ Engineer, with numbers" \
              --rationale "queue depth 18/22/40" --supersedes "$REQ1"
REQ2="$(last_sub)"
must_refuse "a PENDING request cannot be superseded — no forking a live request" \
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ Fork" --supersedes "$REQ2"
out="$("$Q" thread --request "$REQ2" 2>&1)"
grep -q "show the queue depth per week first" <<<"$out" \
  && ok "thread shows the earlier denial, not just the latest request" \
  || { bad "thread lost the denial"; sed 's/^/        /' <<<"$out"; }
grep -q "queue depth: 18/22/40 over three weeks" <<<"$out" \
  && ok "thread shows the requester's answer" || bad "thread lost the comment"
grep -q "supersedes $REQ1" <<<"$out" \
  && ok "thread links the amendment to what it replaced" || bad "thread lost the supersedes link"
must_allow "the amended request is decided on its merits" \
  "$Q" review --reviewer DIR --request "$REQ2" --approve --reason "numbers supplied"

hdr "9. Resubmission is capped — five denials are not a disagreement resubmission fixes"
# MAX_SUPERSEDE_CHAIN counts RESUBMISSIONS, not requests: the original submission
# is not an amendment of anything. docs/responsible-leader.md is explicit —
# "resubmitted five times ... the cap refuses the sixth" — so amendments 1..5 are
# allowed and the 6th is refused. The original and the amendments are counted
# separately below because conflating them is precisely the off-by-one that let
# this cap allow four (TOG-253 defect 2).
reset
"$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ nag original" >/dev/null 2>&1
prev="$(last_sub)"
[[ -n "$prev" ]] && ok "the original request is submitted" || bad "the original submit failed"
"$Q" review --reviewer DIR --request "$prev" --reject --reason "no" >/dev/null 2>&1
capped=""
for i in 1 2 3 4 5 6; do
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ nag $i" \
       --supersedes "$prev" >/dev/null 2>&1
  rc=$?
  if [[ $i -le 5 ]]; then
    [[ $rc -eq 0 ]] || { bad "amendment $i of 5 should be allowed"; break; }
    prev="$(last_sub)"
    "$Q" review --reviewer DIR --request "$prev" --reject --reason "still no" >/dev/null 2>&1
  else
    [[ $rc -ne 0 ]] && capped=yes
  fi
done
[[ -n "$capped" ]] && ok "the sixth amendment is refused; escalate instead of resubmitting" \
                   || bad "the supersede chain is uncapped"
grep -q supersede_chain_exhausted "$GRANT_LOG" \
  && ok "  ...and the exhausted chain is logged, so the forced escalation is visible" \
  || bad "  ...but nothing was logged, so no one learns the cap fired"

# The cap must count amendments of ONE DENIAL, not the length of one path.
# Fanning six amendments off the same denial keeps every one of them at path
# depth 1, which is how an uncapped re-argument used to slip through.
reset
"$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ fan root" >/dev/null 2>&1
ROOT="$(last_sub)"
"$Q" review --reviewer DIR --request "$ROOT" --reject --reason "no" >/dev/null 2>&1
fan_allowed=0
for i in 1 2 3 4 5 6 7 8; do
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ fan $i" \
       --supersedes "$ROOT" >/dev/null 2>&1 && fan_allowed=$((fan_allowed+1))
done
eq "fanning amendments off one denial is capped at 5, not unbounded" "$fan_allowed" "5"

hdr "10. Expiry closes a request; it never re-targets it to a softer approver"
reset
REQUEST_TTL_DAYS=-1 "$Q" submit --requester MGR --template E0_SPECIALIST \
  --title "TESTQ Stale" >/dev/null 2>&1 && ok "a request can be submitted with an expiry in the past" \
  || bad "submit failed"
REQ="$(last_sub)"
must_refuse "the responsible leader cannot decide an expired request" \
  "$Q" review --reviewer DIR --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"
# Filter to STATUS-BEARING events, not merely to the request id. The queue also
# carries comments, acknowledgements and (since TOG-254) notifications for a
# request; `tail -1` over all of them reads whichever row happens to be last.
# That is the same latent bug the queue itself fixed by replacing its denylist
# with the STATUS_EVENTS allowlist — asserting state by shape rather than by
# event name makes a test flip on unrelated changes.
eq "  ...it is marked expired, not escalated" \
   "$(jq -r --arg r "$REQ" 'select(.requestId==$r and (
        .event=="request.submitted" or .event=="request.reviewed" or .event=="request.expired"
      ))|.status' "$QUEUE" | tail -1)" "expired"
must_refuse "standing authority cannot decide it either — expiry is not an escalation" \
  "$Q" review --reviewer A0 --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"
must_allow "it is answered by resubmitting, which returns to the SAME leader" \
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ Fresh" --supersedes "$REQ"
eq "  ...and that leader is still DIR" "$(who_f 2 MGR E0_SPECIALIST)" "DIR"

hdr "11. Nothing above widened the submit-time ceiling"
reset
must_refuse "MGR still cannot request a director" \
  "$Q" submit --requester MGR --template C1_DIRECTOR_BUILDER --title "TESTQ Over Ceiling"
must_refuse "T0 still cannot request a President/COO" \
  "$Q" submit --requester T0 --template P1_PRESIDENT_COO --title "TESTQ Shadow President"
must_refuse "O2 still cannot request anything" \
  "$Q" submit --requester O2 --template E0_SPECIALIST --title "TESTQ CoS Helper"
must_refuse "reportsTo still cannot be supplied through the queue" \
  "$Q" submit --requester T0 --template E0_SPECIALIST --title "TESTQ Escapee" --reports-to O2
must_refuse "a chief still cannot disable a template" \
  "$Q" disable-template C1_DIRECTOR_BUILDER --reviewer T0
must_allow "the steward still can" \
  "$Q" disable-template C1_DIRECTOR_BUILDER --reviewer A0

# TOG-255. The ceiling check used to interpolate the caller-supplied --template
# into a `grep -E` pattern, so a metacharacter turned "is this template inside my
# ceiling?" into "does my ceiling match this pattern?". Every case below is a
# template MGR may NOT request; each one was ALLOWED before the fix.
#
# These are not spelled with must_refuse alone. must_refuse only asserts that
# SOME refusal happened, and a bad fix that rejected every exotic string would
# satisfy it for the wrong reason — so the exact-match cases below prove the
# legitimate template still gets through, and the reason is asserted too.
reset
must_refuse "a wildcard template does not match the whole ceiling" \
  "$Q" submit --requester MGR --template '.*' --title "TESTQ Regex Wildcard"
must_refuse "  ...nor does an alternation smuggling a director past a specialist" \
  "$Q" submit --requester MGR --template 'C1_DIRECTOR_BUILDER|E0_SPECIALIST' --title "TESTQ Regex Alternation"
must_refuse "  ...nor a single-character wildcard standing in for the last letter" \
  "$Q" submit --requester MGR --template 'E0_SPECIALIS.' --title "TESTQ Regex Dot"
must_refuse "  ...nor a character class" \
  "$Q" submit --requester MGR --template 'E0_SPECIALIS[T]' --title "TESTQ Regex Class"
eq "all four refusals are on the ceiling, not on some incidental parse error" \
   "$(jq -r 'select(.event=="request.refused")|.reason' "$GRANT_LOG" | sort | uniq -c | tr -s ' ' | sed 's/^ //')" \
   "4 template_above_request_ceiling"
must_allow "and the exact template MGR really may request still submits" \
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ Exact Still Works"

# The same helper steers derive_leader, so the bypass also chose the approver:
# under a pattern every ancestor "could create it", making the nearest manager
# the responsible leader for a template nobody is entitled to.
eq "a pattern cannot make the nearest ancestor look qualified" \
   "$(who_f 1 MGR '.*')" "escalate"
eq "  ...and it names no leader" "$(who_f 2 MGR '.*')" ""

hdr "12. An override is SURFACED, and only an independent auditor retires it"
# Section 6 proves the bypass is WRITTEN. Recording it into a file nobody reads
# is the same as not recording it, so this section proves somebody is SHOWN it,
# and that the showing drains rather than accumulating into background noise.
reset
"$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ Surfaced" >/dev/null 2>&1
REQ="$(last_sub)"
banner_err="$("$Q" review --reviewer A0 --request "$REQ" --approve --reason "break-glass banner check" 2>&1 >"$TMP/banner.out")"
banner="$(cat "$TMP/banner.out")"
# STDOUT specifically: an agent reviewer reaches this over mcp_remote, and a
# tool wrapper returns stdout while discarding stderr. A notice delivered only
# on stderr would be invisible to exactly the reviewer this epic added.
grep -q 'STANDING-AUTHORITY OVERRIDE' <<<"$banner" \
  && ok "the reviewer is told on STDOUT, where a tool transport will carry it" \
  || { bad "the bypass was silent to the agent that took it"; sed 's/^/        /' <<<"$banner"; }
grep -q "ack-override --request $REQ" <<<"$banner" \
  && ok "  ...and told exactly what clears it" || bad "banner gives no way to clear it"
grep -q 'STANDING-AUTHORITY OVERRIDE' <<<"$banner_err" \
  && ok "  ...and an operator watching stderr sees it too" || bad "no stderr notice"

out="$("$Q" overrides 2>&1)"
{ grep -q "$REQ" <<<"$out" && grep -q "DIR" <<<"$out"; } \
  && ok "'overrides' lists it by request, naming the bypassed leader" \
  || { bad "'overrides' did not surface the bypass"; sed 's/^/        /' <<<"$out"; }
eq "  ...and exits non-zero, so a cron or CI gate goes red" "$(rc_of "$Q" overrides)" "1"

out="$("$Q" list --status approved 2>&1)"
grep -q "UNREVIEWED" <<<"$out" \
  && ok "the default listing carries an OVERRIDE column, not just the thread" \
  || { bad "list hides the override"; sed 's/^/        /' <<<"$out"; }

eq "check 10 of the access review gets machine-readable input" \
   "$("$Q" overrides --json | jq -r '.bypassedLeader')" "DIR"

must_refuse "the steward that took it cannot clear it — standing authority is not audit authority" \
  "$Q" ack-override --request "$REQ" --auditor A0 --note "fine by me"
must_refuse "an agent without audit authority cannot clear it" \
  "$Q" ack-override --request "$REQ" --auditor DIR --note "looks ok"
must_refuse "an acknowledgement without a note is refused" \
  "$Q" ack-override --request "$REQ" --auditor O3
must_allow "O3, the independent audit function, clears it with a note" \
  "$Q" ack-override --request "$REQ" --auditor O3 --note "DIR was dormant 6d; bypass justified"
must_refuse "and it cannot be cleared twice" \
  "$Q" ack-override --request "$REQ" --auditor O3 --note "again"

eq "the open list drains, so the report can return to green" "$(rc_of "$Q" overrides)" "0"
eq "  ...but the override is still there under --all" \
   "$("$Q" overrides --all --json | jq -r '.ack.auditor')" "O3"
out="$("$Q" thread --request "$REQ" 2>&1)"
grep -q "OVERRIDE-ACK  by O3" <<<"$out" \
  && ok "the acknowledgement joins the request's own thread" \
  || { bad "thread lost the acknowledgement"; sed 's/^/        /' <<<"$out"; }

# Regression guard. An acknowledgement is not a decision. If it is ever allowed
# to become a request's LAST event, the request loses its status and vanishes
# from every filtered listing — the audited request would become the one you
# cannot see, which is exactly backwards.
out="$("$Q" list --status approved 2>&1)"
grep -q "$REQ" <<<"$out" \
  && ok "an acknowledged request is still listed as approved" \
  || { bad "acknowledging dropped the request from the listing"; sed 's/^/        /' <<<"$out"; }
grep -q "acked" <<<"$out" && ok "  ...and shows as acked rather than open" || bad "no acked marker"

must_refuse "a request carrying no override cannot be acknowledged" \
  "$Q" ack-override --request "${REQ}-nope" --auditor O3 --note "phantom"

# The not-your-own-override rule has to be exercised by an agent that would
# OTHERWISE be allowed to clear it, or the test passes on the wrong check. A0
# holds standing authority but not acknowledgement authority, so refusing A0
# above proves nothing about this rule — it is refused either way. O1 holds
# BOTH, and is the only agent that can take an override and then be tempted to
# retire it. This is the case the CI mutation step aims at.
reset
"$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ Surfaced 2" >/dev/null 2>&1
REQ="$(last_sub)"
must_allow "O1 takes a break-glass decision of its own" \
  "$Q" review --reviewer O1 --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"
eq "  ...recorded as an override over DIR" \
   "$(jq -r --arg r "$REQ" 'select(.requestId==$r and .status=="approved")|.override.bypassedLeader' "$QUEUE")" "DIR"
must_refuse "O1 cannot clear its OWN override, though it does hold acknowledgement authority" \
  "$Q" ack-override --request "$REQ" --auditor O1 --note "I stand by it"
eq "  ...and the refused self-acknowledgement is itself logged" \
   "$(jq -r 'select(.reason=="self_acknowledgement")|.reason' "$GRANT_LOG" | tail -1)" "self_acknowledgement"
must_allow "O3 clears it instead" \
  "$Q" ack-override --request "$REQ" --auditor O3 --note "reviewed independently"

# Availability: P1 is in the acknowledgement set so a dormant P3 cannot wedge
# the review forever — for overrides P1 did not take.
reset
"$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ Surfaced 3" >/dev/null 2>&1
REQ="$(last_sub)"
must_allow "a break-glass decision taken by A0" \
  "$Q" review --reviewer A0 --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"
must_allow "O1 may clear an override A0 took" \
  "$Q" ack-override --request "$REQ" --auditor O1 --note "P3 dormant; reviewed by P1"

printf '\n\033[1mRESULT: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
