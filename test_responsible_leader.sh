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

must_allow()  { local d="$1"; shift; local o; o="$("$@" 2>&1)"; local rc=$?
  if [[ $rc -eq 0 ]]; then ok "$d"; else bad "$d (rc=$rc)"; sed 's/^/        /' <<<"$o" | head -4; fi; }
# A refusal from the WRONG gate is a failure. This requires the REFUSED marker
# as well as the named message: without both, a typo, missing fixture, or
# neighbouring fail-closed gate can satisfy a case it does not test.
refuses_because() { local d="$1" pat="$2"; shift 2; local o; o="$("$@" 2>&1)"; local rc=$?
  if [[ $rc -ne 0 ]] && grep -q REFUSED <<<"$o" && grep -qi -- "$pat" <<<"$o"; then ok "$d"
  else bad "$d (rc=$rc, wanted a refusal matching /$pat/)"; sed 's/^/        /' <<<"$o" | head -5; fi; }
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
    # Same rule as the ceiling: EXTRACTED, never copied. The risk classifier
    # added in TOG-388 reads this catalog to decide whether an ask is risky, so
    # a stub carrying its own copy would keep classifying against yesterday's
    # permission keys — and would go on reporting "not risky" after somebody
    # added a credential-touching grant to a template.
    sed -n "/^TEMPLATES_JSON='{/,/^}'\$/p" "$HERE/org_provisioner.sh"
    cat <<'STUB'
[[ -n "${CEILING_JSON:-}" ]]   || { echo "stub: failed to extract CEILING_JSON" >&2; exit 90; }
[[ -n "${TEMPLATES_JSON:-}" ]] || { echo "stub: failed to extract TEMPLATES_JSON" >&2; exit 90; }
case "${1:-}" in
  ceiling)
    # Deliberately not piped through `column`: the real provisioner runs on a
    # VPS that has util-linux, a CI runner may not, and ceiling_for only ever
    # splits on whitespace anyway.
    jq -r 'to_entries[] | "\(.key)\t\(.value|join(", "))"' <<<"$CEILING_JSON"
    ;;
  template-keys)
    jq -r 'to_entries[] | "\(.key)\t\(.value|map(.permissionKey)|join(","))"' <<<"$TEMPLATES_JSON"
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
refuses_because "T0 cannot decide it — an ancestor, but not the RESPONSIBLE one" \
  "not the responsible leader" "$Q" review --reviewer T0 --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"
refuses_because "S0 cannot decide it — a peer chief in another subtree" \
  "not the responsible leader" "$Q" review --reviewer S0 --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"
refuses_because "O2 Chief of Staff cannot decide it" \
  "not the responsible leader" "$Q" review --reviewer O2 --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"
refuses_because "the requester cannot decide its own request" \
  "not the responsible leader" "$Q" review --reviewer MGR --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"
must_allow "DIR — the responsible leader — approves" \
  "$Q" review --reviewer DIR --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"
eq "execution ran as the ORIGINAL REQUESTER, not the reviewer" \
   "$(grep -c -- '--caller MGR' "$CREATE_ARGV")" "1"
eq "  ...and the reviewer could not redirect placement" \
   "$(grep -c -- '--caller DIR' "$CREATE_ARGV")" "0"
refuses_because "an approved request cannot be re-decided" \
  "decisions are final" "$Q" review --reviewer DIR --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"

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
refuses_because "O1 cannot approve its own request despite standing authority" \
  "requester cannot review its own request" "$Q" review --reviewer O1 --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"
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
refuses_because "the steward inside T0's subtree cannot approve T0's request" \
  "captive approver is not a reviewer" "$Q" review --reviewer A0 --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"
eq "  ...and the refusal is logged with its reason" \
   "$(jq -r 'select(.reason=="reviewer_is_descendant_of_requester")|.reason' "$GRANT_LOG" | tail -1)" \
   "reviewer_is_descendant_of_requester"
reset

hdr "8. Deny is a conversation, not a dead end"
must_allow "MGR submits a request that will be denied" \
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ Denied Engineer" \
              --rationale "backlog is 40 issues deep"
REQ1="$(last_sub)"
# EXACTLY ONE input is omitted, and the refusal is pinned to its own message.
# Since TOG-388 a bare `--reject` is missing two required things — the reason
# and the alternative — so a plain must_refuse here would go green off whichever
# gate happens to run first, and would stay green if the reason gate were
# deleted outright. The alternative is supplied so the ONLY thing missing is the
# reason, and the message is matched so the neighbouring gate cannot answer for
# this one.
refuses_because "a denial without a reason is refused — the requester must know what to answer" \
  "must carry --reason" \
  "$Q" review --reviewer DIR --request "$REQ1" --reject --alternative "raise the per-agent concurrency cap first"
must_allow "DIR denies with a reason and a safer alternative" \
  "$Q" review --reviewer DIR --request "$REQ1" --reject --reason "show the queue depth per week first" \
              --alternative "raise MGR's concurrency cap for two weeks and re-measure"
eq "the reason is in the record"  \
   "$(jq -r --arg r "$REQ1" 'select(.requestId==$r and .status=="rejected")|.reason' "$QUEUE")" \
   "show the queue depth per week first"
eq "  ...and so is the alternative that was offered" \
   "$(jq -r --arg r "$REQ1" 'select(.requestId==$r and .status=="rejected")|.alternatives[0]' "$QUEUE")" \
   "raise MGR's concurrency cap for two weeks and re-measure"
must_allow "the requester answers on the record" \
  "$Q" comment --request "$REQ1" --author MGR --body "queue depth: 18/22/40 over three weeks"
must_allow "the leader may ask for more without denying again" \
  "$Q" comment --request "$REQ1" --author DIR --body "that is enough, resubmit"
refuses_because "an unrelated agent cannot comment on the exchange" \
  "neither the requester nor the responsible leader" "$Q" comment --request "$REQ1" --author S0 --body "me too"
refuses_because "a different requester cannot supersede someone else's denial" \
  "only the original requester may supersede" "$Q" submit --requester DIR --template E0_SPECIALIST --title "TESTQ Hijack" --supersedes "$REQ1"
must_allow "the original requester amends and resubmits" \
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ Engineer, with numbers" \
              --rationale "queue depth 18/22/40" --supersedes "$REQ1"
REQ2="$(last_sub)"
refuses_because "a PENDING request cannot be superseded — no forking a live request" \
  "only a rejected or expired request can be superseded" "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ Fork" --supersedes "$REQ2"
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
"$Q" review --reviewer DIR --request "$prev" --reject --reason "no" --no-safer-alternative "fixture denial; alternatives are exercised in their own section" >/dev/null 2>&1
capped=""
for i in 1 2 3 4 5 6; do
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ nag $i" \
       --supersedes "$prev" >/dev/null 2>&1
  rc=$?
  if [[ $i -le 5 ]]; then
    [[ $rc -eq 0 ]] || { bad "amendment $i of 5 should be allowed"; break; }
    prev="$(last_sub)"
    "$Q" review --reviewer DIR --request "$prev" --reject --reason "still no" --no-safer-alternative "fixture denial; alternatives are exercised in their own section" >/dev/null 2>&1
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
"$Q" review --reviewer DIR --request "$ROOT" --reject --reason "no" --no-safer-alternative "fixture denial; alternatives are exercised in their own section" >/dev/null 2>&1
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
refuses_because "the responsible leader cannot decide an expired request" \
  "expired at" "$Q" review --reviewer DIR --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"
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
refuses_because "standing authority cannot decide it either — expiry is not an escalation" \
  "expired at" "$Q" review --reviewer A0 --request "$REQ" --approve --reason "reason supplied so this case asserts authority, not arity"
must_allow "it is answered by resubmitting, which returns to the SAME leader" \
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ Fresh" --supersedes "$REQ"
eq "  ...and that leader is still DIR" "$(who_f 2 MGR E0_SPECIALIST)" "DIR"

hdr "11. Nothing above widened the submit-time ceiling"
reset
refuses_because "MGR still cannot request a director" \
  "above the request ceiling" "$Q" submit --requester MGR --template C1_DIRECTOR_BUILDER --title "TESTQ Over Ceiling"
refuses_because "T0 still cannot request a President/COO" \
  "above the request ceiling" "$Q" submit --requester T0 --template P1_PRESIDENT_COO --title "TESTQ Shadow President"
refuses_because "O2 still cannot request anything" \
  "above the request ceiling" "$Q" submit --requester O2 --template E0_SPECIALIST --title "TESTQ CoS Helper"
refuses_because "reportsTo still cannot be supplied through the queue" \
  "reportsTo is never caller-supplied" "$Q" submit --requester T0 --template E0_SPECIALIST --title "TESTQ Escapee" --reports-to O2
refuses_because "a chief still cannot disable a template" \
  "does not hold org.disable_template" "$Q" disable-template C1_DIRECTOR_BUILDER --reviewer T0
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
refuses_because "a wildcard template does not match the whole ceiling" \
  "above the request ceiling" "$Q" submit --requester MGR --template '.*' --title "TESTQ Regex Wildcard"
refuses_because "  ...nor does an alternation smuggling a director past a specialist" \
  "above the request ceiling" "$Q" submit --requester MGR --template 'C1_DIRECTOR_BUILDER|E0_SPECIALIST' --title "TESTQ Regex Alternation"
refuses_because "  ...nor a single-character wildcard standing in for the last letter" \
  "above the request ceiling" "$Q" submit --requester MGR --template 'E0_SPECIALIS.' --title "TESTQ Regex Dot"
refuses_because "  ...nor a character class" \
  "above the request ceiling" "$Q" submit --requester MGR --template 'E0_SPECIALIS[T]' --title "TESTQ Regex Class"
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

refuses_because "the steward that took it cannot clear it — standing authority is not audit authority" \
  "does not hold override-acknowledgement authority" "$Q" ack-override --request "$REQ" --auditor A0 --note "fine by me"
refuses_because "an agent without audit authority cannot clear it" \
  "does not hold override-acknowledgement authority" "$Q" ack-override --request "$REQ" --auditor DIR --note "looks ok"
refuses_because "an acknowledgement without a note is refused" \
  "acknowledgement must carry a note" "$Q" ack-override --request "$REQ" --auditor O3
must_allow "O3, the independent audit function, clears it with a note" \
  "$Q" ack-override --request "$REQ" --auditor O3 --note "DIR was dormant 6d; bypass justified"
refuses_because "and it cannot be cleared twice" \
  "already acknowledged" "$Q" ack-override --request "$REQ" --auditor O3 --note "again"

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

refuses_because "a request carrying no override cannot be acknowledged" \
  "carries no standing-authority override" "$Q" ack-override --request "${REQ}-nope" --auditor O3 --note "phantom"

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
refuses_because "O1 cannot clear its OWN override, though it does hold acknowledgement authority" \
  "took this override; it cannot also clear it" "$Q" ack-override --request "$REQ" --auditor O1 --note "I stand by it"
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
hdr "13. Approval-time re-validation, offline"
# TOG-197 names four properties that must survive the authority change. Sections
# 5-12 cover two of them (no self-approval, execution as the original requester).
# The other two — the two-time ceiling check and template disablement at approval
# time — were covered ONLY by test_request_queue.sh, which needs Postgres and
# podman and so never runs in CI. Deleting either check from org_request_queue.sh
# left this suite green, which means nothing automated was holding them. These
# cases close that: the org fixture is mutated BETWEEN submit and review, which
# is exactly the window the defence exists for.
provisioned_count() { [[ -f "$CREATE_ARGV" ]] && wc -l < "$CREATE_ARGV" | tr -d ' ' || echo 0; }

# --- template disabled after submit -----------------------------------------
reset
must_allow "MGR submits, and the template is disabled while it is pending" \
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ Frozen"
REQ="$(last_sub)"
must_allow "A0 disables E0_SPECIALIST" "$Q" disable-template E0_SPECIALIST --reviewer A0
refuses_because "the responsible leader cannot approve a disabled template" \
  "currently disabled" "$Q" review --reviewer DIR --request "$REQ" --approve --reason "reason supplied so this case asserts re-validation, not arity"
refuses_because "  ...and standing authority cannot approve it either" \
  "currently disabled" "$Q" review --reviewer A0 --request "$REQ" --approve --reason "reason supplied so this case asserts re-validation, not arity"
eq "  ...the refusal is logged as template_disabled" \
   "$(jq -r 'select(.reason=="template_disabled")|.reason' "$GRANT_LOG" | tail -1)" "template_disabled"
eq "  ...and nothing was provisioned" "$(provisioned_count)" "0"
must_allow "a disabled template does not trap the request — it can still be denied" \
  "$Q" review --reviewer DIR --request "$REQ" --reject --reason "template frozen; withdraw" \
              --alternative "the steward re-enables E0_SPECIALIST, or resubmit against E1_REVIEWER_COACH which is not frozen"

# --- requester demoted after submit ------------------------------------------
reset
must_allow "MGR submits, then is demoted before the decision" \
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ Demoted"
REQ="$(last_sub)"
sed -i 's/^u-mgr\tMGR\tD1_MANAGER/u-mgr\tMGR\tE0_SPECIALIST/' "$ORG_SNAPSHOT"
refuses_because "a demoted requester's pending request is refused at approval" \
  "ceiling changed" "$Q" review --reviewer DIR --request "$REQ" --approve --reason "reason supplied so this case asserts re-validation, not arity"
eq "  ...logged as ceiling_changed_since_submit" \
   "$(jq -r 'select(.reason=="ceiling_changed_since_submit")|.reason' "$GRANT_LOG" | tail -1)" \
   "ceiling_changed_since_submit"
eq "  ...and nothing was provisioned" "$(provisioned_count)" "0"

# --- requester terminated after submit ---------------------------------------
reset
must_allow "MGR submits, then is terminated before the decision" \
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ Terminated"
REQ="$(last_sub)"
sed -i 's/^\(u-mgr\tMGR\tD1_MANAGER\t\)idle/\1terminated/' "$ORG_SNAPSHOT"
refuses_because "a terminated requester's pending request is refused at approval" \
  "is terminated" "$Q" review --reviewer DIR --request "$REQ" --approve --reason "reason supplied so this case asserts re-validation, not arity"
eq "  ...and nothing was provisioned" "$(provisioned_count)" "0"

# --- requester removed, and requester re-created under the same role id ------
# Both are reviewed by A0: with the submitting agent id gone, no leader is
# derivable, so the standing floor is the only reviewer that can reach the
# re-validation at all. The point is that reaching it does not help.
reset
must_allow "MGR submits, then is deleted outright" \
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ Vanished"
REQ="$(last_sub)"
grep -v '^u-mgr	' "$ORG_SNAPSHOT" > "$ORG_SNAPSHOT.tmp" && mv "$ORG_SNAPSHOT.tmp" "$ORG_SNAPSHOT"
refuses_because "a vanished requester's request is not executable by anyone" \
  "no longer exists" "$Q" review --reviewer A0 --request "$REQ" --approve --reason "reason supplied so this case asserts re-validation, not arity"
eq "  ...and nothing was provisioned" "$(provisioned_count)" "0"

reset
must_allow "MGR submits, then MGR is re-created as a different agent" \
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ Impostor"
REQ="$(last_sub)"
sed -i 's/^u-mgr\tMGR\t/u-mgr2\tMGR\t/' "$ORG_SNAPSHOT"
refuses_because "authority does not transfer to a new agent holding the same role id" \
  "identity changed" "$Q" review --reviewer A0 --request "$REQ" --approve --reason "reason supplied so this case asserts re-validation, not arity"
eq "  ...and nothing was provisioned" "$(provisioned_count)" "0"

hdr "14. Safer-alternative-first review (TOG-388)"
# The owner instruction quoted in the `Gated Autonomy` goal: a risky ask must be
# met with safer alternatives that still FULLY unblock the work, and may be
# granted only when none exists — never without recording what was tried.
#
# Every refusal below is pinned to its OWN message. These gates sit next to two
# others that catch overlapping inputs (the --reason gate, and the finality
# gate), and an exit-code-only assertion would go green off either.
reset

# --- risk classification is derived from the catalog, not from the reviewer ---
# Read through the queue's own `who`-free path: submit and try to decide. A
# direct unit call is not available from outside, so risk is observed the only
# way a caller can observe it — by what the queue refuses.
must_allow "MGR submits a routine (non-risky) specialist request" \
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ Routine"
ROUTINE="$(last_sub)"
must_allow "a routine ask is approved without any alternatives record" \
  "$Q" review --reviewer DIR --request "$ROUTINE" --approve --reason "backlog is real and the template grants nothing"
eq "  ...and the record says plainly that it was not risky" \
   "$(jq -r --arg r "$ROUTINE" 'select(.requestId==$r and .status=="approved")|.risk.risky' "$QUEUE")" "false"

# --- a denial must leave the requester somewhere to go -----------------------
reset
must_allow "MGR submits a request that will be denied" \
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ Denied"
D="$(last_sub)"
refuses_because "a denial with a reason but NO alternative is refused" \
  "must leave the requester somewhere to go" \
  "$Q" review --reviewer DIR --request "$D" --reason "no" --reject
refuses_because "a denial cannot both offer an alternative and find that none exists" \
  "cannot both offer an alternative and find that none exists" \
  "$Q" review --reviewer DIR --request "$D" --reject --reason "no" \
              --alternative "do it another way" --no-safer-alternative "there is no other way"
refuses_because "--no-safer-alternative cannot be an empty gesture" \
  "needs the finding itself" \
  "$Q" review --reviewer DIR --request "$D" --reject --reason "no" --no-safer-alternative ""
refuses_because "the approval-side flags are refused on a denial" \
  "belongs on an approval" \
  "$Q" review --reviewer DIR --request "$D" --reject --reason "no" \
              --considered "a smaller ask" --because "it would not help"
must_allow "a denial carrying two alternatives is accepted" \
  "$Q" review --reviewer DIR --request "$D" --reject --reason "the backlog is scheduling, not headcount" \
              --alternative "raise MGR's concurrency cap for two weeks" \
              --alternative "move the three blocked issues to the platform queue"
eq "  ...and both survive in the record, in order" \
   "$(jq -r --arg r "$D" 'select(.requestId==$r and .status=="rejected")|.alternatives|join(" | ")' "$QUEUE")" \
   "raise MGR's concurrency cap for two weeks | move the three blocked issues to the platform queue"
out="$("$Q" inbox --for MGR 2>&1)"
grep -q "raise MGR's concurrency cap for two weeks" <<<"$out" \
  && ok "  ...and they REACH THE REQUESTER, not just the log" \
  || { bad "the alternatives never reached the requester's inbox"; sed 's/^/        /' <<<"$out" | head -8; }

# --- granting a risky ask requires the record --------------------------------
# T0 [B2_TECH_CHIEF] may request E2_TOOLING_ADMIN (tools:admin) and its leader
# is O1. This is the case the owner instruction is actually about.
reset
must_allow "T0 asks for a tooling admin — tools:admin, a risky ask" \
  "$Q" submit --requester T0 --template E2_TOOLING_ADMIN --title "TESTQ Tooling Admin"
RISKY="$(last_sub)"
refuses_because "granting it with a reason but no alternatives record is refused" \
  "is a RISKY ask" \
  "$Q" review --reviewer O1 --request "$RISKY" --approve --reason "they say they need it"
refuses_because "  ...and the refusal is not something standing authority can shrug off" \
  "is a RISKY ask" \
  "$Q" review --reviewer A0 --request "$RISKY" --approve --reason "they say they need it"
eq "  ...the refusal is logged as risky_grant_without_alternatives_record" \
   "$(jq -r 'select(.reason=="risky_grant_without_alternatives_record")|.reason' "$GRANT_LOG" | tail -1)" \
   "risky_grant_without_alternatives_record"
eq "  ...and nothing was provisioned" "$(provisioned_count)" "0"
refuses_because "--considered without --because is refused; a list is not an analysis" \
  "must be followed immediately by --because" \
  "$Q" review --reviewer O1 --request "$RISKY" --approve --reason "needed" --considered "broker it instead"
refuses_because "--because cannot stand alone" \
  "must follow a --considered" \
  "$Q" review --reviewer O1 --request "$RISKY" --approve --reason "needed" --because "it did not work"
must_allow "with the record, the risky ask is granted" \
  "$Q" review --reviewer O1 --request "$RISKY" --approve --reason "measured: three outages, no narrower grant covers connection CREATE" \
              --considered "broker each edit through the steward" --because "the steward cannot create a connection on another agent's behalf" \
              --considered "E3_PIPELINE_BUILDER instead" --because "pipelines:write does not reach tool connections at all"
eq "  ...the risk factors are pinned to the decision" \
   "$(jq -r --arg r "$RISKY" 'select(.requestId==$r and .status=="approved")|.risk.factors|join(",")' "$QUEUE")" \
   "tools:admin,tools:manage_connections,tools:manage_runtime"
eq "  ...and each alternative is paired with the reason it failed" \
   "$(jq -r --arg r "$RISKY" 'select(.requestId==$r and .status=="approved")|.alternativesConsidered[1].whyItFailed' "$QUEUE")" \
   "pipelines:write does not reach tool connections at all"

# --- the record is an OPEN audit item until an independent auditor reads it ---
eq "a granted risky ask is an open item on risk-record" "$(rc_of "$Q" risk-record)" "1"
eq "  ...naming the grant and its risk factors" \
   "$("$Q" risk-record --json | jq -r '"\(.requestId) \(.kind) \(.riskFactors|join(","))"')" \
   "$RISKY grant tools:admin,tools:manage_connections,tools:manage_runtime"
refuses_because "the reviewer cannot clear its own risk record" \
  "cannot also clear its risk record" \
  "$Q" ack-risk --request "$RISKY" --auditor O1 --note "looks fine to me"
refuses_because "an acknowledgement without a note is refused" \
  "not a review finding" \
  "$Q" ack-risk --request "$RISKY" --auditor O3 --note ""
refuses_because "a chief without audit authority cannot clear it" \
  "does not hold override-acknowledgement authority" \
  "$Q" ack-risk --request "$RISKY" --auditor T0 --note "fine"
must_allow "O3, the independent audit function, closes it with a finding" \
  "$Q" ack-risk --request "$RISKY" --auditor O3 --note "both alternatives verified against the connection API; the grant is minimal"
eq "  ...so the open list drains and the report can return to green" "$(rc_of "$Q" risk-record)" "0"
eq "  ...but the item is still there under --all" \
   "$("$Q" risk-record --all --json | jq -r '.requestId')" "$RISKY"
refuses_because "and it cannot be cleared twice" \
  "already acknowledged" "$Q" ack-risk --request "$RISKY" --auditor O1 --note "again"
out="$("$Q" thread --request "$RISKY" 2>&1)"
grep -q "RISK-ACK   by O3" <<<"$out" \
  && ok "the acknowledgement joins the request's own thread" || bad "thread lost the risk acknowledgement"
refuses_because "a routine approval has no risk record to acknowledge" \
  "carries no risky grant" \
  "$Q" ack-risk --request "$RISKY-nope" --auditor O3 --note "x"

# --- risk-record and overrides stay SEPARATE alarms ---------------------------
# A request can carry both. Folding them into one list would silently change the
# meaning of the exit status org_access_review.sh check 10 already gates on.
reset
must_allow "T0 asks for a pipeline builder" \
  "$Q" submit --requester T0 --template E3_PIPELINE_BUILDER --title "TESTQ Pipelines"
BOTH="$(last_sub)"
must_allow "A0 grants it under break-glass, with the alternatives record" \
  "$Q" review --reviewer A0 --request "$BOTH" --approve --reason "CI is down and O1 is dormant" \
              --considered "wait for O1" --because "CI has been red for six hours"
eq "it is an open OVERRIDE"    "$("$Q" overrides   --json | jq -r '.requestId')" "$BOTH"
eq "and an open RISK RECORD"   "$("$Q" risk-record --json | jq -r '.requestId')" "$BOTH"
must_allow "clearing the override does not clear the risk record" \
  "$Q" ack-override --request "$BOTH" --auditor O3 --note "dormant leader confirmed"
eq "  ...overrides drains"     "$(rc_of "$Q" overrides)"   "0"
eq "  ...risk-record does NOT" "$(rc_of "$Q" risk-record)" "1"

# --- the classifier fails CLOSED, in both of its two distinct ways ------------
# This is the anti-rot property. A permission key on neither RISK_KEYS nor
# NONRISK_KEYS is somebody extending the catalog without deciding whether the
# new grant is risky, and the honest answer to an undecided question is to stop
# — NOT to default to "not risky", which is how a denylist quietly retires a
# control. Same lesson the queue already learned in STATUS_EVENTS.
reset
must_allow "MGR submits against a template that is about to grow a new key" \
  "$Q" submit --requester MGR --template E0_SPECIALIST --title "TESTQ Unclassified"
UNC="$(last_sub)"
ORIG_STUB="$(cat "$PROV")"
sed -i 's/"E0_SPECIALIST": \[\]/"E0_SPECIALIST": [{"permissionKey":"secrets:read","self":false}]/' "$PROV"
refuses_because "an UNCLASSIFIED permission key stops the decision, it does not pass it" \
  "on neither RISK_KEYS nor NONRISK_KEYS" \
  "$Q" review --reviewer DIR --request "$UNC" --approve --reason "would have sailed through under a denylist"
refuses_because "  ...and it stops a denial too, not only a grant" \
  "on neither RISK_KEYS nor NONRISK_KEYS" \
  "$Q" review --reviewer DIR --request "$UNC" --reject --reason "no" --alternative "something safer"
eq "  ...logged as unclassified_permission_key naming the key" \
   "$(jq -r 'select(.reason=="unclassified_permission_key")|.keys' "$GRANT_LOG" | tail -1)" "secrets:read"
printf '%s\n' "$ORIG_STUB" > "$PROV"; chmod +x "$PROV"
must_allow "  ...and the same decision succeeds once the key is gone again" \
  "$Q" review --reviewer DIR --request "$UNC" --approve --reason "catalog restored"

# An UNREADABLE catalog is the other failure, and it must not read as "no keys,
# so not risky" — which is exactly what would happen if the queue asked the
# provisioner's human `templates` view, since that is piped through `column` and
# `column` is absent in the paperclip container.
reset
must_allow "T0 submits a risky ask" \
  "$Q" submit --requester T0 --template E2_TOOLING_ADMIN --title "TESTQ Catalog Gone"
GONE="$(last_sub)"
ORIG_STUB="$(cat "$PROV")"
printf '#!/usr/bin/env bash\ncase "${1:-}" in ceiling) exec %q ceiling;; *) exit 91;; esac\n' "$TMP/real_stub.sh" > "$TMP/blind.sh"
printf '%s\n' "$ORIG_STUB" > "$TMP/real_stub.sh"; chmod +x "$TMP/real_stub.sh" "$TMP/blind.sh"
cp "$TMP/blind.sh" "$PROV"
refuses_because "a catalog that cannot be read refuses the decision" \
  "refusing to decide an ask whose risk is unknown" \
  "$Q" review --reviewer O1 --request "$GONE" --approve --reason "risk unknown must not mean risk absent"
eq "  ...logged as risk_unclassifiable" \
   "$(jq -r 'select(.reason=="risk_unclassifiable")|.reason' "$GRANT_LOG" | tail -1)" "risk_unclassifiable"
eq "  ...and nothing was provisioned" "$(provisioned_count)" "0"
printf '%s\n' "$ORIG_STUB" > "$PROV"; chmod +x "$PROV"

# --- and the whole acceptance path, in one place -----------------------------
# TOG-388's acceptance: a denial that carries alternatives, a revision, and a
# subsequent approval, all visible in the audit log.
reset
must_allow "1. T0 asks for tools:admin" \
  "$Q" submit --requester T0 --template E2_TOOLING_ADMIN --title "TESTQ Admin" \
              --rationale "three tool outages this week"
A1="$(last_sub)"
must_allow "2. O1 denies it and offers a narrower route" \
  "$Q" review --reviewer O1 --request "$A1" --reject --reason "tools:admin is the whole substrate; the outages are pipeline drift" \
              --alternative "E3_PIPELINE_BUILDER covers the drift you measured without tools:admin"
must_allow "3. T0 answers the alternative on the record" \
  "$Q" comment --request "$A1" --author T0 --body "checked: E3 covers two of the three outages"
must_allow "4. T0 revises against the same thread" \
  "$Q" submit --requester T0 --template E3_PIPELINE_BUILDER --title "TESTQ Pipelines" \
              --rationale "narrowed per $A1" --supersedes "$A1"
A2="$(last_sub)"
must_allow "5. and it is approved, with what was ruled out on the record" \
  "$Q" review --reviewer O1 --request "$A2" --approve --reason "narrowed to the measured cause and revertible" \
              --considered "broker each edit through the steward" --because "two of three edits need a connection CREATE"
out="$("$Q" thread --request "$A2" 2>&1)"
for want in "safer alternatives offered" "E3_PIPELINE_BUILDER covers the drift" \
            "checked: E3 covers two of the three outages" "supersedes $A1" \
            "alternatives considered and why each failed" "two of three edits need a connection CREATE"; do
  grep -qF -- "$want" <<<"$out" && ok "audit log carries: $want" \
    || { bad "audit log is missing: $want"; sed 's/^/        /' <<<"$out" | head -20; }
done

printf '\n\033[1mRESULT: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
