#!/usr/bin/env bash
# ===========================================================================
# Offline regression suite for capability_gate.sh (TOG-387).
# NO DATABASE, NO CREDENTIALS, NO NETWORK — this is what CI runs, and it is
# the only automated coverage the capability gate has.
#
# EVERY REFUSAL IS ASSERTED BY ITS REASON, NOT BY ITS EXIT STATUS.
# ---------------------------------------------------------------------------
# `must_refuse`-style helpers that check only "rc != 0 and the word REFUSED
# appears" have gone green for the wrong reason on this repo more than once:
# a fail-closed default catches the same input, the assertion passes, and the
# leaf it claims to cover is never reached. The whole class is avoided here —
# `refuses_because` takes the substring that identifies WHICH gate fired and
# fails if a different one did. Section 10 then does the reverse: it deletes
# each gate in a staging copy and asserts the test that names it goes RED,
# so a control that stops doing anything cannot keep a green suite.
#
# SEAMS
#   ORG_SNAPSHOT  a TSV org fixture read instead of the live database
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v jq >/dev/null || { echo "ERROR: jq required" >&2; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export COMPANY_ID="offline-fixture-not-a-real-company"
export ORG_SNAPSHOT="$TMP/org.tsv"
export QUEUE="$TMP/queue.jsonl"
export GRANT_LOG="$TMP/grant-log.jsonl"
G="$HERE/capability_gate.sh"

PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# refuses_because <desc> <reason-substring> <cmd...>
# Refusal AND the named gate. A refusal from a different gate is a FAILURE,
# not a pass — that is the entire point of this helper.
refuses_because() {
  local d="$1" why="$2"; shift 2
  local o; o="$("$@" 2>&1)"; local rc=$?
  if [[ $rc -eq 0 ]]; then bad "$d — was ALLOWED (rc=0)"; return; fi
  if ! grep -q REFUSED <<<"$o"; then bad "$d — non-zero but not a refusal (rc=$rc)"; sed 's/^/        /' <<<"$o" | head -3; return; fi
  if grep -qF -- "$why" <<<"$o"; then ok "$d"
  else bad "$d — refused by the WRONG gate; wanted '$why'"; sed 's/^/        /' <<<"$o" | head -4; fi
}
allows() { local d="$1"; shift; local o; o="$("$@" 2>&1)"; local rc=$?
  if [[ $rc -eq 0 ]]; then ok "$d"; else bad "$d (rc=$rc)"; sed 's/^/        /' <<<"$o" | head -4; fi; }
eq() { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (got '$2', wanted '$3')"; }
says() { local d="$1" want="$2"; shift 2
  local o; o="$("$@" 2>&1)"
  if grep -qF -- "$want" <<<"$o"; then ok "$d"
  else bad "$d — output did not contain '$want'"; sed 's/^/        /' <<<"$o" | head -4; fi; }

# The safer-alternatives record a risky approval carries (TOG-403). Every test
# outside section 11 is about a DIFFERENT gate — authority, state, expiry,
# classification — so each approval carries a well-formed record and lets the
# gate under test be the one that fires. Without it, all of them would refuse
# at the record gate and pass for the wrong reason, which is the failure mode
# this suite's header exists to rule out.
#
# Appended to the missing---reason cases too, on purpose: a fail-closed test
# must omit EXACTLY ONE input, or the refusal is over-determined and the test
# stays green after the control it names has gone.
REC=(--considered "broker a per-run token instead of handing over the key itself"
     --because   "the broker only mints while the run is in_progress, and this work runs before that")

base_org() {
  cat > "$ORG_SNAPSHOT" <<'ORG'
u-o1	O1	P1_PRESIDENT_COO	idle		President & COO
u-a0	A0	P4_PROVISIONING_STEWARD	idle	u-o1	Provisioning Steward
u-t0	T0	B2_TECH_CHIEF	idle	u-o1	CTO & Chief AI Officer
u-s0	S0	B3_SECURITY_CHIEF	idle	u-o1	CISO
u-f0	F0	B4_FINANCE_CHIEF	idle	u-o1	CFO
u-m0	M0	B1_FUNCTION_CHIEF	idle	u-o1	CMO
u-eng	ENG	E0_SPECIALIST	idle	u-t0	Web Engineer
ORG
}
reset() { rm -f "$QUEUE" "$GRANT_LOG"; rm -rf "$QUEUE.lock"; base_org; }

FACTS="Measured on this board: TOG-113 and TOG-110 are both blocked on a missing push credential, and the App installation already covers the repository."
WHY="A broker-minted installation token unblocks both without creating a standing credential, because the scope is projected from the project and revocation is central."

mode() { cut -f1 <<<"$("$G" classify --capability "$1" --action "$2" ${3:+--requester "$3"} 2>/dev/null)"; }
decider() { cut -f2 <<<"$("$G" classify --capability "$1" --action "$2" ${3:+--requester "$3"} 2>/dev/null)"; }
rules_of() { cut -f4 <<<"$("$G" classify --capability "$1" --action "$2" ${3:+--requester "$3"} 2>/dev/null)"; }
has_rule() { jq -e --arg r "$2" 'any(.[]; .rule==$r)' <<<"$1" >/dev/null 2>&1; }
status_of() { jq -r --arg id "$1" 'select(.requestId==$id and has("status"))|.status' "$QUEUE" | tail -1; }
last_id() { jq -r 'select(.event=="request.submitted")|.requestId' "$QUEUE" | tail -1; }

reset

# ---------------------------------------------------------------------------
hdr "0. The seams themselves"
allows "the gate runs with no database, on the ORG_SNAPSHOT seam" "$G" registry
allows "the fixture org resolves" "$G" who --capability github.repo.read --action read --requester ENG
eq "the registry is non-empty" "$(jq 'length > 0' <<<"$("$G" registry --json)")" "true"
eq "every registry entry carries a domain, class, rollback and note" \
   "$(jq '[to_entries[]|select(.value.domain and .value.class and .value.rollback and .value.note)]|length' <<<"$("$G" registry --json)")" \
   "$(jq 'length' <<<"$("$G" registry --json)")"

# ---------------------------------------------------------------------------
hdr "1. The owner's four rules — each fires on its own"
# Each case is chosen so exactly ONE of the four is the reason, wherever the
# registry allows it, so a rule cannot be credited for another rule's catch.
eq   "real money: spend is owner-reserved" "$(mode company.spend spend ENG)" "owner"
ok_r() { has_rule "$(rules_of "$2" "$3" "$4")" "$1" && ok "$5" || bad "$5 (rules: $(rules_of "$2" "$3" "$4"))"; }
ok_r real_money company.spend spend ENG "  ...and the rule named is real_money"
eq   "credential destruction: rotating a credential is owner-reserved" "$(mode github.token rotate ENG)" "owner"
ok_r credential_destruction github.token rotate ENG "  ...and the rule named is credential_destruction"
eq   "external publication is owner-reserved" "$(mode external.publish publish ENG)" "owner"
ok_r external_publication external.publish publish ENG "  ...and the rule named is external_publication"
eq   "no rollback is owner-reserved" "$(mode vps.root.command use ENG)" "owner"
ok_r no_rollback vps.root.command use ENG "  ...and the rule named is no_rollback"

# The rotate rule must be about a CREDENTIAL, not about the verb alone —
# otherwise it would be indistinguishable from a blanket "rotate is scary".
eq "deleting a NON-credential is not caught by the credential rule" \
   "$(has_rule "$(rules_of github.repo.read delete ENG)" credential_destruction && echo yes || echo no)" "no"

# ---------------------------------------------------------------------------
hdr "2. The classification is DERIVED, never declared"
refuses_because "a requester cannot declare its own ask low-risk" \
  "derived from the registry" \
  "$G" submit --requester ENG --capability github.token --action rotate --risk low --facts "$FACTS" --reasoning "$WHY"
refuses_because "...nor assert it is reversible" \
  "derived from the registry" \
  "$G" submit --requester ENG --capability vps.root.command --action use --reversible yes --facts "$FACTS" --reasoning "$WHY"
refuses_because "...nor mark its own ask not-owner-reserved" \
  "derived from the registry" \
  "$G" submit --requester ENG --capability company.spend --action spend --owner-reserved no --facts "$FACTS" --reasoning "$WHY"
refuses_because "a requester cannot choose who decides" \
  "never chosen by the requester" \
  "$G" submit --requester ENG --capability github.repo.push --action grant --reviewer ENG --facts "$FACTS" --reasoning "$WHY"

# Fail-closed by default: an unregistered capability goes to the owner rather
# than being waved through as "not in the dangerous list".
eq "an UNREGISTERED capability is owner-reserved, not allowed" "$(mode totally.unknown.thing use ENG)" "owner"
ok_r unregistered_capability totally.unknown.thing use ENG "  ...and the rule names it as unregistered"
# ...but an unknown ACTION is refused rather than classified: a verb the
# classifier has never seen cannot be assessed, and 'routine' is the one
# wrong answer.
eq "an unknown ACTION is invalid, not silently owner-reserved" "$(mode github.repo.push frobnicate ENG)" "invalid"
refuses_because "submitting an unknown action is refused outright" \
  "is not a known action" \
  "$G" submit --requester ENG --capability github.repo.push --action frobnicate --facts "$FACTS" --reasoning "$WHY"

# ---------------------------------------------------------------------------
hdr "3. Facts and reasoning are required, and each is required SEPARATELY"
# Exactly one input is omitted per case. Omitting both makes the refusal
# over-determined and the assertion survives the control being deleted.
refuses_because "no facts (reasoning present) is refused for the facts" \
  "--facts is required" \
  "$G" submit --requester ENG --capability github.repo.push --action grant --reasoning "$WHY"
refuses_because "no reasoning (facts present) is refused for the reasoning" \
  "--reasoning is required" \
  "$G" submit --requester ENG --capability github.repo.push --action grant --facts "$FACTS"
refuses_because "a token gesture in --facts is refused for the floor" \
  "the floor is" \
  "$G" submit --requester ENG --capability github.repo.push --action grant --facts "n/a" --reasoning "$WHY"
refuses_because "a token gesture in --reasoning is refused for the floor" \
  "the floor is" \
  "$G" submit --requester ENG --capability github.repo.push --action grant --facts "$FACTS" --reasoning "-"
allows "facts + reasoning together are accepted" \
  "$G" submit --requester ENG --capability github.repo.push --action grant --facts "$FACTS" --reasoning "$WHY"
FIRST="$(last_id)"
eq "the record carries the facts verbatim" \
   "$(jq -r --arg id "$FIRST" 'select(.requestId==$id and .event=="request.submitted")|.facts' "$QUEUE")" "$FACTS"
eq "the record carries the reasoning verbatim" \
   "$(jq -r --arg id "$FIRST" 'select(.requestId==$id and .event=="request.submitted")|.reasoning' "$QUEUE")" "$WHY"

# ---------------------------------------------------------------------------
hdr "4. Who decides — derived from the capability's domain"
eq "a tool capability is decided by its domain owner alone" "$(mode github.repo.push grant ENG)" "domain"
eq "  ...and that is T0" "$(decider github.repo.push grant ENG)" "T0"
eq "a finance capability is NOT decided by the tech chief" "$(decider company.spend read ENG)" "F0"

# SEPARATION OF DUTIES, and it is the ESCALATION that provides it, not a
# late identity comparison. If the requester owns the domain the decider
# becomes the requester's nearest live ancestor; there is no path on which
# decider == requester, which is why the identity check in cmd_review is a
# backstop rather than the control. Assert the control.
eq "the domain owner asking for its own domain escalates one level up" \
   "$(decider github.repo.push grant T0)" "O1"
eq "  ...and it is still a one-key decision, not a free pass" "$(mode github.repo.push grant T0)" "domain"
# The root has nobody above it, so the second pair of eyes can only be the
# owner's. It does NOT fall through to self-approval.
cat > "$ORG_SNAPSHOT" <<'ORG'
u-o1	O1	P1_PRESIDENT_COO	idle		President & COO
u-s0	S0	B3_SECURITY_CHIEF	idle	u-o1	CISO
ORG
eq "a ROOT requester that owns the domain becomes owner-reserved, never self-approved" \
   "$(mode paperclip.agent.create use O1)" "owner"
base_org

# A terminated domain owner escalates rather than deadlocking...
sed -i 's/^u-t0\tT0\tB2_TECH_CHIEF\tidle/u-t0\tT0\tB2_TECH_CHIEF\tterminated/' "$ORG_SNAPSHOT"
eq "a terminated domain owner escalates to the nearest live ancestor" \
   "$(decider github.repo.push grant ENG)" "O1"
base_org
# ...but a chain with nobody live at all stops for the owner rather than
# silently picking somebody.
cat > "$ORG_SNAPSHOT" <<'ORG'
u-o1	O1	P1_PRESIDENT_COO	terminated		President & COO
u-t0	T0	B2_TECH_CHIEF	terminated	u-o1	CTO
u-eng	ENG	E0_SPECIALIST	idle	u-t0	Web Engineer
u-s0	S0	B3_SECURITY_CHIEF	idle	u-o1	CISO
ORG
eq "an entirely terminated chain is owner-reserved, not assigned to a corpse" \
   "$(mode github.repo.push grant ENG)" "owner"
ok_r no_live_decider github.repo.push grant ENG "  ...and the rule names the missing decider"
base_org

# ---------------------------------------------------------------------------
hdr "5. Two keys means two principals"
eq "a credential capability needs custody" "$(mode github.token grant ENG)" "custody"
eq "  ...held by whichever agent carries B3_SECURITY_CHIEF" \
   "$(cut -f3 <<<"$("$G" classify --capability github.token --action grant --requester ENG)")" "S0"
# Custody follows the TEMPLATE, not the role id: re-seating the CISO under a
# different orgRoleId must not silently vacate custody.
sed -i 's/^u-s0\tS0\tB3_SECURITY_CHIEF/u-s0\tSEC9\tB3_SECURITY_CHIEF/' "$ORG_SNAPSHOT"
eq "custody follows the template when the role id changes" \
   "$(cut -f3 <<<"$("$G" classify --capability github.token --action grant --requester ENG)")" "SEC9"
base_org
# The collapse cases. Neither may quietly become a one-key approval.
eq "the custodian asking for a credential is owner-reserved" "$(mode github.token grant S0)" "owner"
ok_r custody_conflict github.token grant S0 "  ...named as a custody conflict, not as some other rule"
eq "a credential whose domain owner IS the custodian is owner-reserved" \
   "$(mode github.app.privatekey grant ENG)" "owner"
# No live custodian at all: fail closed.
cat > "$ORG_SNAPSHOT" <<'ORG'
u-o1	O1	P1_PRESIDENT_COO	idle		President & COO
u-t0	T0	B2_TECH_CHIEF	idle	u-o1	CTO
u-eng	ENG	E0_SPECIALIST	idle	u-t0	Web Engineer
ORG
eq "no live custodian makes a credential ask owner-reserved" "$(mode github.token grant ENG)" "owner"
ok_r custody_conflict github.token grant ENG "  ...named as a custody conflict"
base_org

hdr "5b. The two keys, end to end"
reset
allows "ENG submits a credential request" \
  "$G" submit --requester ENG --capability github.token --action grant --facts "$FACTS" --reasoning "$WHY"
R="$(last_id)"
eq "it lands pending, not approved" "$(status_of "$R")" "pending"
refuses_because "the custodian cannot countersign before the domain owner decides" \
  "it does not decide first" \
  "$G" countersign --custodian S0 --request "$R" --approve --reason "fine by me and I am the CISO" "${REC[@]}"
refuses_because "an agent that is not the domain owner cannot decide" \
  "is not the domain owner" \
  "$G" review --reviewer M0 --request "$R" --approve --reason "looks fine to me" "${REC[@]}"
# THE AUTHZ TEST THAT MATTERS: the President & COO would pass any
# standing-authority check, and there is deliberately no such check here.
refuses_because "the President & COO has no override — there is no break-glass path" \
  "no override path here" \
  "$G" review --reviewer O1 --request "$R" --approve --reason "president overrides" "${REC[@]}"
refuses_because "an approval without a reason is refused for the reason" \
  "must carry --reason" \
  "$G" review --reviewer T0 --request "$R" --approve "${REC[@]}"
allows "the domain owner turns key 1" \
  "$G" review --reviewer T0 --request "$R" --approve --reason "installation token, scope projected from the project" "${REC[@]}"
eq "  ...and it is awaiting custody, NOT approved" "$(status_of "$R")" "awaiting_custody"
refuses_because "the domain owner cannot also turn key 2" \
  "does not hold custody" \
  "$G" countersign --custodian T0 --request "$R" --approve --reason "and I countersign myself" "${REC[@]}"
refuses_because "a bystander cannot countersign" \
  "does not hold custody" \
  "$G" countersign --custodian M0 --request "$R" --approve --reason "I will sign it" "${REC[@]}"
refuses_because "a countersignature without a reason is refused for the reason" \
  "must carry --reason" \
  "$G" countersign --custodian S0 --request "$R" --approve "${REC[@]}"
allows "the custodian turns key 2" \
  "$G" countersign --custodian S0 --request "$R" --approve --reason "custody accepted, broker-minted per run only" "${REC[@]}"
eq "  ...and only now is it approved" "$(status_of "$R")" "approved"
eq "the record names BOTH keys" \
   "$(jq -r --arg id "$R" 'select(.requestId==$id and .event=="request.countersigned")|"\(.domainOwner)+\(.custodian)"' "$QUEUE")" "T0+S0"
says "an approval is rendered as not-yet-effected, so it is not read as a grant" \
  "NOT YET EFFECTED" "$G" thread --request "$R"
refuses_because "the decision is final" "decisions are final" \
  "$G" review --reviewer T0 --request "$R" --reject --reason "changed my mind about this one" \
  --alternative "file a fresh request against the narrower capability"

hdr "5c. A denial at either key ends it, and says which key"
reset
allows "submit" "$G" submit --requester ENG --capability github.token --action grant --facts "$FACTS" --reasoning "$WHY"
R="$(last_id)"
allows "domain owner approves" "$G" review --reviewer T0 --request "$R" --approve --reason "the route is right, custody is not mine to grant" "${REC[@]}"
allows "custodian refuses" "$G" countersign --custodian S0 --request "$R" --reject --reason "not until the token stops being written to the workspace" \
  --alternative "mint it through the broker per run, so it never lands on disk"
eq "  ...the request is rejected" "$(status_of "$R")" "rejected"
eq "  ...and the record says which key refused" \
   "$(jq -r --arg id "$R" 'select(.requestId==$id and .event=="request.countersigned")|.key' "$QUEUE")" "custody"
eq "  ...while still carrying the domain owner's approval" \
   "$(jq -r --arg id "$R" 'select(.requestId==$id and .event=="request.reviewed")|.reviewer' "$QUEUE")" "T0"

# ---------------------------------------------------------------------------
hdr "6. Owner-reserved: no agent may decide, including every privileged one"
reset
allows "an owner-reserved ask is still RECORDED, not thrown away" \
  "$G" submit --requester ENG --capability vps.root.command --action use --facts "$FACTS" --reasoning "$WHY"
R="$(last_id)"
eq "  ...with status owner_reserved" "$(status_of "$R")" "owner_reserved"
for who in ENG T0 S0 A0 O1; do
  refuses_because "$who cannot decide an owner-reserved request" "OWNER-RESERVED" \
    "$G" review --reviewer "$who" --request "$R" --approve --reason "I am senior and I say yes" "${REC[@]}"
done
refuses_because "nor can it be countersigned into existence" \
  "OWNER-RESERVED and has no domain-owner key yet" \
  "$G" countersign --custodian S0 --request "$R" --approve --reason "signing it anyway" "${REC[@]}"
says "owner-queue shows it, with the rule and the requester's own words" \
  "no_rollback" "$G" owner-queue
says "  ...including the facts" "$FACTS" "$G" owner-queue
"$G" owner-queue >/dev/null 2>&1; eq "owner-queue exits 1 while anything is waiting" "$?" "1"
reset
"$G" owner-queue >/dev/null 2>&1; eq "owner-queue exits 0 on an empty queue" "$?" "0"

# ---------------------------------------------------------------------------
hdr "7. Authority is re-derived at DECISION time, never trusted from submit"
reset
allows "submit while the org is healthy" \
  "$G" submit --requester ENG --capability github.repo.push --action grant --facts "$FACTS" --reasoning "$WHY"
R="$(last_id)"
eq "  ...decider recorded at submit is T0" \
   "$(jq -r --arg id "$R" 'select(.requestId==$id and .event=="request.submitted")|.derivedDecider' "$QUEUE")" "T0"
# Now move the org underneath it. The recorded decider must NOT be honoured.
sed -i 's/^u-t0\tT0\tB2_TECH_CHIEF\tidle/u-t0\tT0\tB2_TECH_CHIEF\tterminated/' "$ORG_SNAPSHOT"
refuses_because "the decider recorded at submit cannot decide once terminated" \
  "is terminated" \
  "$G" review --reviewer T0 --request "$R" --approve --reason "I was the decider when this was filed" "${REC[@]}"
allows "the re-derived decider can" \
  "$G" review --reviewer O1 --request "$R" --approve --reason "T0 is gone; this is mine now and the ask is sound" "${REC[@]}"
base_org

reset
allows "submit a two-key credential request" \
  "$G" submit --requester ENG --capability github.token --action grant --facts "$FACTS" --reasoning "$WHY"
R="$(last_id)"
allows "domain owner turns key 1" "$G" review --reviewer T0 --request "$R" --approve --reason "route is right, custody to follow" "${REC[@]}"
# Custody vanishes between the two keys. A one-key approval must not result.
sed -i 's/^u-s0\tS0\tB3_SECURITY_CHIEF\tidle/u-s0\tS0\tB3_SECURITY_CHIEF\tterminated/' "$ORG_SNAPSHOT"
refuses_because "custody vanishing between the keys stops the approval" \
  "no longer classifies as a two-key custody request" \
  "$G" countersign --custodian S0 --request "$R" --approve --reason "still me" "${REC[@]}"
eq "  ...and the request is still awaiting custody, not approved" "$(status_of "$R")" "awaiting_custody"
base_org

reset
allows "submit a decidable request" \
  "$G" submit --requester ENG --capability github.repo.push --action grant --facts "$FACTS" --reasoning "$WHY"
R="$(last_id)"
# Re-classification into owner-reserved must STOP the approval, not be logged
# and stepped over.
cat > "$ORG_SNAPSHOT" <<'ORG'
u-o1	O1	P1_PRESIDENT_COO	terminated		President & COO
u-t0	T0	B2_TECH_CHIEF	terminated	u-o1	CTO
u-eng	ENG	E0_SPECIALIST	idle	u-t0	Web Engineer
u-s0	S0	B3_SECURITY_CHIEF	idle	u-o1	CISO
ORG
refuses_because "a request that re-classifies as owner-reserved cannot be approved" \
  "re-classified as OWNER-RESERVED" \
  "$G" review --reviewer S0 --request "$R" --approve --reason "I am live and senior" "${REC[@]}"
base_org

# ---------------------------------------------------------------------------
hdr "8. The record itself"
reset
allows "submit" "$G" submit --requester ENG --capability github.repo.push --action grant --facts "$FACTS" --reasoning "$WHY"
R="$(last_id)"
eq "ids are namespaced to this flow, not shared with the provisioning queue" "${R%%-*}" "CAP"
# A duplicated submission row makes the id ambiguous, and an ambiguous id is
# refused rather than resolved: nothing in the record says which of the two a
# reviewer read.
jq -c --arg id "$R" 'select(.requestId==$id and .event=="request.submitted")' "$QUEUE" >> "$QUEUE"
refuses_because "an id naming two submissions is refused, not resolved by tail -1" \
  "distinct submissions" \
  "$G" review --reviewer T0 --request "$R" --approve --reason "deciding the one I read" "${REC[@]}"
refuses_because "  ...and thread refuses to render it as authoritative" \
  "distinct submissions" "$G" thread --request "$R"
says "  ...and the refusal is logged, so a corrupt record is visible not merely inert" \
  "ambiguous_request_id" "$G" log
reset
allows "submit" "$G" submit --requester ENG --capability github.repo.push --action grant --facts "$FACTS" --reasoning "$WHY"
R="$(last_id)"
allows "approve" "$G" review --reviewer T0 --request "$R" --approve --reason "sound ask, scope is right" "${REC[@]}"
# A forged second terminal row must not win by being later.
jq -c --arg id "$R" 'select(.requestId==$id and .event=="request.countersigned")|.reason="FORGED"' "$QUEUE" >> "$QUEUE"
refuses_because "a second terminal decision is refused, not taken as the latest word" \
  "terminal decisions" "$G" thread --request "$R"

hdr "9. An open request ages out — including a half-approved one"
reset
allows "submit" "$G" submit --requester ENG --capability github.token --action grant --facts "$FACTS" --reasoning "$WHY"
R="$(last_id)"
allows "key 1" "$G" review --reviewer T0 --request "$R" --approve --reason "route is right, custody to follow" "${REC[@]}"
eq "  ...it is awaiting custody" "$(status_of "$R")" "awaiting_custody"
# Age the submission out. `awaiting_custody` is an OPEN status: a request one
# key approved and the other never touched is as undecided as an unread one,
# and if it did not expire it would sit half-approved forever.
tmpq="$TMP/aged.jsonl"
jq -c '(select(.event=="request.submitted")|.expiresAt) = "2000-01-01T00:00:00Z"' "$QUEUE" > "$tmpq" && mv "$tmpq" "$QUEUE"
refuses_because "a half-approved request past its expiry cannot be countersigned" \
  "expired" \
  "$G" countersign --custodian S0 --request "$R" --approve --reason "late but here" "${REC[@]}"
eq "  ...and it reads as expired everywhere, with no review attempt needed" "$(status_of "$R")" "expired"

# ---------------------------------------------------------------------------
hdr "11. Safer alternative first, on the domain owner's key (TOG-403)"
# The contract itself, not the gates that happen to sit near it. Enforced by
# the SHARED implementation in lib/reqrecord.sh, so these assertions and
# test_responsible_leader.sh's are asserting one implementation from two sides;
# test_reqrecord_shared.sh is what keeps that true.
reset
allows "ENG asks for read-only clone access — tool, full rollback: a ROUTINE ask" \
  "$G" submit --requester ENG --capability github.repo.read --action read --facts "$FACTS" --reasoning "$WHY"
ROUTINE="$(last_id)"
refuses_because "a routine denial STILL must leave the requester somewhere to go" \
  "must leave the requester somewhere to go" \
  "$G" review --reviewer T0 --request "$ROUTINE" --reject --reason "no"
refuses_because "a denial cannot both offer an alternative and find that none exists" \
  "cannot both offer an alternative and find that none exists" \
  "$G" review --reviewer T0 --request "$ROUTINE" --reject --reason "no" \
    --alternative "read it from the mirror" --no-safer-alternative "there is no mirror"
refuses_because "--no-safer-alternative cannot be an empty gesture" \
  "needs the finding itself" \
  "$G" review --reviewer T0 --request "$ROUTINE" --reject --reason "no" --no-safer-alternative ""
refuses_because "the approval-side flags are refused on a denial" \
  "belongs on an approval" \
  "$G" review --reviewer T0 --request "$ROUTINE" --reject --reason "no" \
    --considered "a smaller ask" --because "it would not help"
refuses_because "the denial-side flag is refused on an approval" \
  "way forward instead of granting the ask" \
  "$G" review --reviewer T0 --request "$ROUTINE" --approve --reason "yes" --alternative "do it another way"
refuses_because "--no-safer-alternative is refused on an approval" \
  "is a denial finding" \
  "$G" review --reviewer T0 --request "$ROUTINE" --approve --reason "yes" --no-safer-alternative "nothing else works"
refuses_because "--considered without --because is refused; a list is not an analysis" \
  "must be followed immediately by --because" \
  "$G" review --reviewer T0 --request "$ROUTINE" --approve --reason "yes" --considered "a narrower scope"
refuses_because "--because cannot stand alone" \
  "must follow a --considered" \
  "$G" review --reviewer T0 --request "$ROUTINE" --approve --reason "yes" --because "it did not work"
allows "a ROUTINE ask is approved with no alternatives record at all" \
  "$G" review --reviewer T0 --request "$ROUTINE" --approve --reason "read-only, and the App install already covers the repo"
eq "  ...and the record says plainly that it was not risky" \
   "$(jq -r --arg id "$ROUTINE" 'select(.requestId==$id and .status=="approved")|.risk.risky' "$QUEUE")" "false"

reset
allows "ENG asks for push — tool, PARTIAL rollback: a RISKY ask, one key" \
  "$G" submit --requester ENG --capability github.repo.push --action grant --facts "$FACTS" --reasoning "$WHY"
RISKY="$(last_id)"
eq "  ...and the risk is derived from the registry's rollback, not declared" \
   "$(cut -f1 <<<"$("$G" classify --capability github.repo.push --action grant --requester ENG)")" "domain"
refuses_because "granting it with a reason but no alternatives record is refused" \
  "is a RISKY ask" \
  "$G" review --reviewer T0 --request "$RISKY" --approve --reason "they say they need it"
eq "  ...and the refusal is logged as risky_grant_without_alternatives_record" \
   "$(jq -r 'select(.reason=="risky_grant_without_alternatives_record")|.reason' "$GRANT_LOG" | tail -1)" \
   "risky_grant_without_alternatives_record"
eq "  ...naming the factor that made it risky, not a reviewer's opinion" \
   "$(jq -r 'select(.reason=="risky_grant_without_alternatives_record")|.riskFactors|join(",")' "$GRANT_LOG" | tail -1)" \
   "rollback_partial"
allows "with the record, the risky ask is granted" \
  "$G" review --reviewer T0 --request "$RISKY" --approve --reason "measured: two issues blocked, no narrower grant covers a push" \
    --considered "review-only access and a maintainer merges" --because "no maintainer is live on this repo outside the App identity" \
    --considered "a fork and a pull request" --because "the CI that must pass is not enabled on forks"
eq "  ...and each alternative is paired with the reason it failed" \
   "$(jq -r --arg id "$RISKY" 'select(.requestId==$id and .status=="approved")|.alternativesConsidered[1].whyItFailed' "$QUEUE")" \
   "the CI that must pass is not enabled on forks"
says "  ...and the pairing is rendered on the thread, where the requester reads it" \
  "failed because: no maintainer is live on this repo outside the App identity" \
  "$G" thread --request "$RISKY"

reset
allows "another risky ask, this time to be denied" \
  "$G" submit --requester ENG --capability github.repo.push --action grant --facts "$FACTS" --reasoning "$WHY"
DENY="$(last_id)"
allows "a denial carrying two alternatives is accepted" \
  "$G" review --reviewer T0 --request "$DENY" --reject --reason "the blocker is review latency, not access" \
    --alternative "land it through the existing App identity, which already has push" \
    --alternative "move the two issues to the queue that has a live maintainer"
eq "  ...and both survive in the record, in order" \
   "$(jq -r --arg id "$DENY" 'select(.requestId==$id and .status=="rejected")|.alternatives|join(" | ")' "$QUEUE")" \
   "land it through the existing App identity, which already has push | move the two issues to the queue that has a live maintainer"
says "  ...and they REACH THE REQUESTER on the thread, not just the log" \
  "land it through the existing App identity" "$G" thread --request "$DENY"

reset
allows "and a denial may instead record that nothing safer exists" \
  "$G" submit --requester ENG --capability github.repo.push --action grant --facts "$FACTS" --reasoning "$WHY"
NOALT="$(last_id)"
# One run, two assertions on its output. The finding is surfaced at DECISION
# time, to the reviewer's face — a finding that is recorded and never shown is
# a finding nobody reads — and the same output has to hand the requester its
# next move, because a decision is final and this gate has no --supersedes.
o="$("$G" review --reviewer T0 --request "$NOALT" --reject --reason "the ask is sound but the timing is not" \
       --no-safer-alternative "read-only, fork-and-PR and a brokered merge were all checked; none can push the release tag this needs" 2>&1)"
grep -qF "NO SAFER ALTERNATIVE FOUND" <<<"$o" \
  && ok "  ...and that finding is said to the reviewer's face, not merely filed" \
  || { bad "  ...the no-safer-alternative finding was never surfaced"; sed 's/^/        /' <<<"$o" | head -6; }
grep -qF "comment --request $NOALT --author ENG" <<<"$o" \
  && ok "  ...and the denial hands the requester \`comment\`, this gate having no --supersedes" \
  || { bad "  ...the denial named no way to answer it"; sed 's/^/        /' <<<"$o" | head -6; }
eq "  ...the denial landed" "$(status_of "$NOALT")" "rejected"
says "  ...and the requester reads the finding itself on the thread" \
  "NO SAFER ALTERNATIVE: read-only, fork-and-PR and a brokered merge were all checked" \
  "$G" thread --request "$NOALT"
eq "  ...stored under the field name org_access_review.sh already reads" \
   "$(jq -r --arg id "$NOALT" 'select(.requestId==$id and .status=="rejected")|.noSaferAlternative != null' "$QUEUE")" "true"

# ---------------------------------------------------------------------------
hdr "12. The countersignature is ALWAYS a risky grant, and its denial is the one that matters"
# The case TOG-388 had no reason to think about. `countersign` only ever runs
# on a `custody` request and `custody` is only ever reached by
# `class: credential`, so there is no routine branch — the record is
# unconditional and is asserted before the request is even read.
reset
allows "ENG asks for a token — credential class, so two keys" \
  "$G" submit --requester ENG --capability github.token --action grant --facts "$FACTS" --reasoning "$WHY"
CS="$(last_id)"
refuses_because "a countersignature without the record is refused BEFORE the request is read" \
  "always hands over a credential" \
  "$G" countersign --custodian S0 --request "$CS" --approve --reason "fine by me"
allows "key 1: the domain owner approves, and must show its own analysis" \
  "$G" review --reviewer T0 --request "$CS" --approve --reason "the route is right; custody is not mine to grant" \
    --considered "have the broker mint per run" --because "the broker refuses outside in_progress and this runs before that"
eq "  ...key 1's record is on the row, not only key 2's" \
   "$(jq -r --arg id "$CS" 'select(.requestId==$id and .status=="awaiting_custody")|.alternativesConsidered[0].alternative' "$QUEUE")" \
   "have the broker mint per run"
refuses_because "  ...and key 2 still cannot be turned without its own" \
  "always hands over a credential" \
  "$G" countersign --custodian S0 --request "$CS" --approve --reason "the domain owner already looked at it"
allows "key 2, with the custodian's own analysis, completes it" \
  "$G" countersign --custodian S0 --request "$CS" --approve --reason "scoped to one repo, revocable centrally" \
    --considered "a standing PAT held by the requester" --because "it survives the run and nothing revokes it on failure"
eq "  ...and BOTH keys' analyses are on the record, separately" \
   "$(jq -r --arg id "$CS" 'select(.requestId==$id and .key=="custody")|.alternativesConsidered[0].alternative' "$QUEUE")" \
   "a standing PAT held by the requester"

# THE HEADLINE. A custodian's refusal is usually "not in this form" rather than
# "no", so a custody denial with no alternative is the worst case in the tool.
reset
allows "a second token ask, to be refused by custody" \
  "$G" submit --requester ENG --capability github.token --action grant --facts "$FACTS" --reasoning "$WHY"
CD="$(last_id)"
allows "key 1 approves" \
  "$G" review --reviewer T0 --request "$CD" --approve --reason "the work is real" \
    --considered "wait for the maintainer" --because "no maintainer is live on this repo"
refuses_because "THE CUSTODY DENIAL: 'no' with no narrower form is refused" \
  "must leave the requester somewhere to go" \
  "$G" countersign --custodian S0 --request "$CD" --reject --reason "not like that"
refuses_because "  ...and the approval-side flags do not satisfy it either" \
  "belongs on an approval" \
  "$G" countersign --custodian S0 --request "$CD" --reject --reason "not like that" \
    --considered "a narrower scope" --because "it would still be standing"
allows "  ...but 'not in THIS form, in THAT one' is accepted" \
  "$G" countersign --custodian S0 --request "$CD" --reject --reason "not while the token lands on disk in the workspace" \
    --alternative "mint it through the broker per run, so it is never written to the workspace" \
    --alternative "scope it to the single repo and a 10-minute TTL, and I will countersign today"
eq "  ...the request is rejected by the custody key" \
   "$(jq -r --arg id "$CD" 'select(.requestId==$id and .event=="request.countersigned")|.key' "$QUEUE")" "custody"
eq "  ...and the narrower form is on the record, in order" \
   "$(jq -r --arg id "$CD" 'select(.requestId==$id and .key=="custody")|.alternatives|join(" | ")' "$QUEUE")" \
   "mint it through the broker per run, so it is never written to the workspace | scope it to the single repo and a 10-minute TTL, and I will countersign today"
says "  ...and the requester reads it on the thread, which is the whole point" \
  "scope it to the single repo and a 10-minute TTL" "$G" thread --request "$CD"

# ---------------------------------------------------------------------------
hdr "13. comment — a decider asks for a fact without deciding (TOG-403)"
# TOG-387 left this open. The alternatives model does not remove the need for
# it, it creates one: a decider one fact short must now produce a way forward
# anyway, and the alternative it invents from an incomplete picture reads as
# diligence and sends the requester somewhere wrong. And unlike
# org_request_queue.sh there is no --supersedes here, so a denied requester's
# only other move is a fresh id carrying none of the exchange.
reset
allows "a token ask is filed" \
  "$G" submit --requester ENG --capability github.token --action grant --facts "$FACTS" --reasoning "$WHY"
C="$(last_id)"
allows "the domain owner asks for a fact instead of guessing at an alternative" \
  "$G" comment --request "$C" --author T0 --body "which repo, and does the work outlive the run?"
eq "  ...and the request is STILL pending — a comment is not a decision" "$(status_of "$C")" "pending"
allows "the requester answers on the same record" \
  "$G" comment --request "$C" --author ENG --body "ops-tooling only, and it does not outlive the run"
allows "the custodian, the second key, is a party too" \
  "$G" comment --request "$C" --author S0 --body "then the broker covers it; show me the run id"
refuses_because "a bystander cannot write into the record of a decision" \
  "not a party" \
  "$G" comment --request "$C" --author M0 --body "I think this is fine"
refuses_because "  ...and neither can standing authority, which review already refuses" \
  "not a party" \
  "$G" comment --request "$C" --author O1 --body "president says yes"
refuses_because "an unknown author is refused" "author not found" \
  "$G" comment --request "$C" --author NOBODY --body "hello"
refuses_because "a comment needs a body" "usage: comment" \
  "$G" comment --request "$C" --author ENG --body ""
refuses_because "a comment on a request that does not exist is refused" "no such request" \
  "$G" comment --request CAP-999 --author ENG --body "hello"
says "the exchange is rendered on the thread, in order" \
  "COMMENT    ENG: ops-tooling only" "$G" thread --request "$C"
eq "  ...and the comment did NOT become the request's status" "$(status_of "$C")" "pending"
allows "having asked, the domain owner can now decide on facts" \
  "$G" review --reviewer T0 --request "$C" --approve --reason "scoped to one repo and does not outlive the run" \
    --considered "a standing credential" --because "it would outlive the run the requester just confirmed is the whole scope"
allows "and comment still works after a decision — it is how a denial is answered" \
  "$G" comment --request "$C" --author ENG --body "understood; the broker route worked"

# ---------------------------------------------------------------------------
hdr "10. Adjacency — each assertion is pinned to its OWN gate"
# The failure mode this closes: a refusal produced by a neighbouring
# fail-closed default keeps an exit-code-only assertion green after the gate
# it names has been deleted. Here each gate is removed in a STAGING COPY and
# the suite is re-run over that copy; the named test must go RED.
#
# THE BASELINE FIRST. "The mutated copy failed" is unattributable unless the
# UNMUTATED copy in the same staging directory passes — four gates on this
# repo were vacuous for exactly that reason.
STAGE="$TMP/stage"; mkdir -p "$STAGE/lib"
cp "$G" "$STAGE/capability_gate.sh"; cp "$HERE/lib/reqrecord.sh" "$HERE/lib/pcsql.sh" "$STAGE/lib/"
chmod +x "$STAGE/capability_gate.sh"

# Run ONE named assertion against a staged gate. Emits pass/fail of that
# assertion, so the caller can require green unmutated and red mutated.
probe() { # probe <staged-gate> <reason-substring> <args...>
  local sg="$1" why="$2"; shift 2
  local sq="$TMP/probe.jsonl" sl="$TMP/probe.log"
  rm -f "$sq" "$sl"; rm -rf "$sq.lock"
  QUEUE="$sq" GRANT_LOG="$sl" "$sg" submit --requester ENG --capability github.token \
    --action grant --facts "$FACTS" --reasoning "$WHY" >/dev/null 2>&1
  local o; o="$(QUEUE="$sq" GRANT_LOG="$sl" "$sg" "$@" 2>&1)"; local rc=$?
  [[ $rc -ne 0 ]] && grep -qF -- "$why" <<<"$o"
}

mutate() { # mutate <name> <sed-expr>
  cp "$G" "$STAGE/capability_gate.sh"
  sed -i "$2" "$STAGE/capability_gate.sh"
  chmod +x "$STAGE/capability_gate.sh"
}

SG="$STAGE/capability_gate.sh"
cp "$G" "$SG"; chmod +x "$SG"
probe "$SG" "is not the domain owner" review --reviewer M0 --request CAP-001 --approve --reason "looks fine to me here" "${REC[@]}" \
  && ok "BASELINE: the unmutated staged copy still refuses a non-owner" \
  || bad "BASELINE: the unmutated staged copy does NOT refuse — every mutation below is unattributable"
probe "$SG" "it does not decide first" countersign --custodian S0 --request CAP-001 --approve --reason "signing this one early" "${REC[@]}" \
  && ok "BASELINE: the unmutated staged copy still refuses an early countersignature" \
  || bad "BASELINE: staged copy does not refuse an early countersignature"

# Mutation 1: delete the domain-owner check entirely.
mutate not_the_domain_owner '/^  if \[\[ "\$rv_id" != "\$d_id" \]\]; then$/,/^  fi$/d'
if bash -n "$SG" 2>/dev/null; then
  probe "$SG" "is not the domain owner" review --reviewer M0 --request CAP-001 --approve --reason "looks fine to me here" "${REC[@]}" \
    && bad "MUTATION: removing the domain-owner check did NOT turn the test red" \
    || ok "MUTATION: removing the domain-owner check turns its test red"
else bad "MUTATION: the domain-owner mutation did not produce a parseable script"; fi

# Mutation 2: make the owner-reserved refusal a no-op.
mutate owner_reserved 's/^  \[\[ "\$cur" != "owner_reserved" \]\] || {$/  false \&\& {/'
if bash -n "$SG" 2>/dev/null; then
  rm -f "$TMP/orq.jsonl"; rm -rf "$TMP/orq.jsonl.lock"
  QUEUE="$TMP/orq.jsonl" GRANT_LOG="$TMP/orq.log" "$SG" submit --requester ENG \
    --capability vps.root.command --action use --facts "$FACTS" --reasoning "$WHY" >/dev/null 2>&1
  o="$(QUEUE="$TMP/orq.jsonl" GRANT_LOG="$TMP/orq.log" "$SG" review --reviewer S0 --request CAP-001 --approve --reason "senior enough" "${REC[@]}" 2>&1)"
  grep -qF "OWNER-RESERVED" <<<"$o" \
    && bad "MUTATION: neutering the owner-reserved refusal did NOT turn its test red" \
    || ok "MUTATION: neutering the owner-reserved refusal turns its test red"
else bad "MUTATION: the owner-reserved mutation did not produce a parseable script"; fi

# Mutation 3: let the requester declare its own risk class.
mutate requester_declared_risk 's/^      --risk|--reversible|--routine|--severity|--owner-reserved|--no-owner-review)$/      --unused-never-matches)/'
if bash -n "$SG" 2>/dev/null; then
  o="$(QUEUE="$TMP/m3.jsonl" GRANT_LOG="$TMP/m3.log" "$SG" submit --requester ENG --capability github.token \
       --action rotate --risk low --facts "$FACTS" --reasoning "$WHY" 2>&1)"
  grep -qF "derived from the registry" <<<"$o" \
    && bad "MUTATION: removing the --risk rejection did NOT turn its test red" \
    || ok "MUTATION: removing the --risk rejection turns its test red"
else bad "MUTATION: the --risk mutation did not produce a parseable script"; fi

# --- the TOG-403 gates, and the SHARED library they actually live in --------
# mutate() edits the gate; these edit the LIBRARY, which is the point. If the
# safer-alternative contract had been copied into capability_gate.sh instead of
# factored, neutering lib/reqrecord.sh would leave this tool fully armed and
# the "it is shared" claim would be decoration. These mutations are the
# evidence that it is not.
mutate_lib() { # mutate_lib <name> <sed-expr>
  cp "$G" "$STAGE/capability_gate.sh"; chmod +x "$STAGE/capability_gate.sh"
  cp "$HERE/lib/reqrecord.sh" "$STAGE/lib/reqrecord.sh"
  sed -i "$2" "$STAGE/lib/reqrecord.sh"
}

# Mutation 4: neuter the SHARED grant-record assertion in the library.
mutate_lib saferalt_grant 's/^saferalt_assert_grant_record() {$/saferalt_assert_grant_record() { return 0/'
if bash -n "$STAGE/lib/reqrecord.sh" 2>/dev/null; then
  probe "$SG" "is a RISKY ask" review --reviewer T0 --request CAP-001 --approve --reason "they say they need it" \
    && bad "MUTATION: neutering the shared grant record did NOT turn review's test red" \
    || ok "MUTATION: neutering the SHARED grant record turns review's test red"
  probe "$SG" "always hands over a credential" countersign --custodian S0 --request CAP-001 --approve --reason "fine by me" \
    && bad "MUTATION: neutering the shared grant record did NOT turn countersign's test red" \
    || ok "MUTATION: ...and countersign's too — one deletion, both flows, which is what 'shared' means"
else bad "MUTATION: the shared-grant-record mutation did not produce a parseable library"; fi

# Mutation 5: neuter the SHARED denial floor.
mutate_lib saferalt_direction 's/^saferalt_assert_direction() {$/saferalt_assert_direction() { return 0/'
if bash -n "$STAGE/lib/reqrecord.sh" 2>/dev/null; then
  probe "$SG" "must leave the requester somewhere to go" review --reviewer T0 --request CAP-001 --reject --reason "no" \
    && bad "MUTATION: neutering the shared denial floor did NOT turn its test red" \
    || ok "MUTATION: neutering the SHARED denial floor turns the denial test red"
else bad "MUTATION: the denial-floor mutation did not produce a parseable library"; fi
cp "$HERE/lib/reqrecord.sh" "$STAGE/lib/reqrecord.sh"   # restore before gate mutations

# Mutation 6: let the risk class fall back to routine instead of being derived.
# ADJACENCY: this must turn review's risky test red and leave countersign's
# GREEN, because a countersignature is risky by construction and never consults
# the classifier. A mutation that reddened both would mean the two refusals are
# really one gate wearing two names.
mutate risk_always_routine 's/^capability_risk_factors() {$/capability_risk_factors() { printf ""; return 1/'
if bash -n "$SG" 2>/dev/null; then
  probe "$SG" "is a RISKY ask" review --reviewer T0 --request CAP-001 --approve --reason "they say they need it" \
    && bad "MUTATION: forcing the risk class to routine did NOT turn review's test red" \
    || ok "MUTATION: forcing the risk class to routine turns review's risky test red"
  probe "$SG" "always hands over a credential" countersign --custodian S0 --request CAP-001 --approve --reason "fine by me" \
    && ok "ADJACENCY: ...and leaves countersign's green — it is risky by construction, not by classification" \
    || bad "ADJACENCY: countersign's record gate went red too; it is reading the classifier it must not need"
else bad "MUTATION: the risk-class mutation did not produce a parseable script"; fi

# Mutation 7: open `comment` to anyone.
mutate comment_party 's/^  \[\[ "\$ok" == "yes" \]\] || {$/  true || {/'
if bash -n "$SG" 2>/dev/null; then
  probe "$SG" "not a party" comment --request CAP-001 --author M0 --body "I think this is fine" \
    && bad "MUTATION: opening comment to non-parties did NOT turn its test red" \
    || ok "MUTATION: opening comment to non-parties turns its test red"
else bad "MUTATION: the comment-party mutation did not produce a parseable script"; fi

cp "$G" "$SG"   # leave the staging copy clean
cp "$HERE/lib/reqrecord.sh" "$STAGE/lib/reqrecord.sh"

printf '\n\033[1mRESULT: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
