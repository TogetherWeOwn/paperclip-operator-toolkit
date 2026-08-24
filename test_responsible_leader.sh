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
  "$Q" review --reviewer T0 --request "$REQ" --approve
must_refuse "S0 cannot decide it — a peer chief in another subtree" \
  "$Q" review --reviewer S0 --request "$REQ" --approve
must_refuse "O2 Chief of Staff cannot decide it" \
  "$Q" review --reviewer O2 --request "$REQ" --approve
must_refuse "the requester cannot decide its own request" \
  "$Q" review --reviewer MGR --request "$REQ" --approve
must_allow "DIR — the responsible leader — approves" \
  "$Q" review --reviewer DIR --request "$REQ" --approve
eq "execution ran as the ORIGINAL REQUESTER, not the reviewer" \
   "$(grep -c -- '--caller MGR' "$CREATE_ARGV")" "1"
eq "  ...and the reviewer could not redirect placement" \
   "$(grep -c -- '--caller DIR' "$CREATE_ARGV")" "0"
must_refuse "an approved request cannot be re-decided" \
  "$Q" review --reviewer DIR --request "$REQ" --approve

hdr "6. Standing authority is a floor and a break-glass, and the bypass is recorded"
reset
must_allow "MGR submits again" \
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ Second Engineer"
REQ="$(last_sub)"
must_allow "A0 steward may still decide it (break-glass)" \
  "$Q" review --reviewer A0 --request "$REQ" --approve
eq "the bypass is recorded as an override naming the leader" \
   "$(jq -r --arg r "$REQ" 'select(.requestId==$r and .status=="approved")|.override.bypassedLeader' "$QUEUE")" "DIR"
reset
must_allow "O1 submits a request of its own (escalate mode)" \
  "$Q" submit --requester O1 --template E1_REVIEWER_COACH --title "TESTQ Exec Coach"
REQ="$(last_sub)"
must_refuse "O1 cannot approve its own request despite standing authority" \
  "$Q" review --reviewer O1 --request "$REQ" --approve
must_allow "A0 can, as the escalation floor" \
  "$Q" review --reviewer A0 --request "$REQ" --approve
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
  "$Q" review --reviewer A0 --request "$REQ" --approve
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
reset
prev=""
for i in 1 2 3 4 5 6; do
  if [[ -z "$prev" ]]; then
    "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ nag $i" >/dev/null 2>&1
  else
    "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ nag $i" --supersedes "$prev" >/dev/null 2>&1
  fi
  rc=$?
  cur="$(last_sub)"
  if [[ $i -le 5 ]]; then
    [[ $rc -eq 0 ]] || { bad "resubmission $i should be allowed"; break; }
    "$Q" review --reviewer DIR --request "$cur" --reject --reason "still no" >/dev/null 2>&1
    prev="$cur"
  else
    [[ $rc -ne 0 ]] && ok "the sixth attempt is refused; escalate instead of resubmitting" \
                    || bad "the supersede chain is uncapped"
  fi
done

hdr "10. Expiry closes a request; it never re-targets it to a softer approver"
reset
REQUEST_TTL_DAYS=-1 "$Q" submit --requester MGR --template E0_SPECIALIST \
  --title "TESTQ Stale" >/dev/null 2>&1 && ok "a request can be submitted with an expiry in the past" \
  || bad "submit failed"
REQ="$(last_sub)"
must_refuse "the responsible leader cannot decide an expired request" \
  "$Q" review --reviewer DIR --request "$REQ" --approve
eq "  ...it is marked expired, not escalated" \
   "$(jq -r --arg r "$REQ" 'select(.requestId==$r)|.status' "$QUEUE" | tail -1)" "expired"
must_refuse "standing authority cannot decide it either — expiry is not an escalation" \
  "$Q" review --reviewer A0 --request "$REQ" --approve
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

printf '\n\033[1mRESULT: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
