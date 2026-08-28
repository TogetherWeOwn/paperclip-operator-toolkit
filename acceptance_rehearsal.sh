#!/usr/bin/env bash
# TOG-199 acceptance rehearsal — the epic's acceptance run, driven against a
# snapshot of the REAL org taken live from the Paperclip API.
#
# WHAT THIS IS, AND WHAT IT IS NOT
# --------------------------------
# TOG-199 asks for a real request through the real path. That run needs two
# things this container does not have:
#
#   1. TOG-196, the host-side MCP server. Without it no agent can reach the
#      queue at all, and identity is not authenticated — the requester and
#      reviewer are whatever `--requester` / `--reviewer` say.
#   2. Host access to Postgres. org_request_queue.sh reads live org state
#      through `podman exec paperclip-db`; there is no podman in an agent
#      container, and org_provisioner.sh refuses to start without it.
#
# So this is a REHEARSAL, not the proof. It closes the gap that is closeable:
# test_responsible_leader.sh runs against a hand-built fixture org, and a
# fixture can only contain the cases its author thought of. This runs the same
# authorization core against the org as it actually is on the day it runs —
# real reporting lines, real permission profiles, real statuses, real missing
# metadata — so that when TOG-196 lands, the live run is a formality rather
# than a discovery.
#
# Two seams do the work, both already load-bearing for CI:
#   ORG_SNAPSHOT  the live org, exported from the API to the TSV the queue reads
#   PROV          a stub provisioner whose ceiling is EXTRACTED from the real
#                 org_provisioner.sh, and whose `create` appends to the snapshot
#
# Nothing here mutates the real org. `create` writes to a scratch TSV copy; the
# only network call is a GET of the agent roster.
#
# Usage:  PAPERCLIP_API_KEY=... PAPERCLIP_API_URL=... COMPANY_ID=... ./acceptance_rehearsal.sh
set -uo pipefail

# Snapshot export, stub provisioner, scratch paths and assertion helpers are
# shared with acceptance_transport.sh. See acceptance_org_lib.sh.
# shellcheck source=acceptance_org_lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/acceptance_org_lib.sh"

# ===========================================================================
hdr "0. Live org snapshot"
build_stub
N="$(fetch_org)"
ok "exported $N live agents to the snapshot format"
inf "status census: $(cut -f4 "$ORG_SNAPSHOT" | sort | uniq -c | tr '\n' ' ' | tr -s ' ')"
NOROLE="$(awk -F'\t' '$2==""' "$ORG_SNAPSHOT" | wc -l)"
NOPROF="$(awk -F'\t' '$3==""' "$ORG_SNAPSHOT" | wc -l)"
inf "$NOROLE of $N agents have no orgRoleId; $NOPROF have no permissionProfile"
save_org

# ---------------------------------------------------------------------------
hdr "1. Derivation terminates cleanly for every live agent"
# The fixture suite proves the rules. This proves the resolver follows those
# rules for every requestable pair in the real org. A non-empty skip list is not
# itself a failure: the accepted algorithm MUST skip a terminated or
# under-ceiling ancestor. The invariant is that the ordered skip prefix and the
# selected leader exactly match an independent walk of today's snapshot and
# today's extracted ceiling catalog.
CYCLES=0; SKIPS=0; DERIVED=0; ESCALATED=0; EXAMINED=0; DERIVATION_ERRORS=0
mapfile -t ROWS < "$ORG_SNAPSHOT"
for r in "${ROWS[@]}"; do
  id="$(fld 1 "$r")"; prof="$(fld 3 "$r")"
  [[ -n "$prof" ]] || continue
  ceil="$("$PROV" ceiling | awk -F'\t' -v t="$prof" '$1==t{print $2}')"
  extra=""; [[ "$prof" == "P3_AUDIT_RISK" ]] && extra="E4_AUDIT_ANALYST"
  tpls="$(tr ',' '\n' <<<"$ceil,$extra" | sed 's/^ *//;s/ *$//' | grep -v '^$' | sort -u)"
  for t in $tpls; do
    EXAMINED=$((EXAMINED+1))
    if ! out="$("$Q" who --requester "$id" --template "$t" </dev/null 2>&1)"; then
      DERIVATION_ERRORS=$((DERIVATION_ERRORS+1))
      bad "who failed deriving $t for $(fld 6 "$r")"
      sed 's/^/        /' <<<"$out" | head -3
      continue
    fi

    requester_row="$(awk -F'\t' -v k="$id" '$1==k{print; exit}' "$ORG_SNAPSHOT")"
    parent="$(fld 5 "$requester_row")"; expected_mode="escalate"; expected_role=""; expected_tpl=""
    expected_skips='[]'; seen=" $id "; depth=0
    while [[ -n "$parent" && $depth -lt 16 ]]; do
      if [[ "$seen" == *" $parent "* ]]; then expected_mode="cycle"; break; fi
      seen+="$parent "
      ancestor="$(awk -F'\t' -v k="$parent" '$1==k{print; exit}' "$ORG_SNAPSHOT")"
      if [[ -z "$ancestor" ]]; then
        expected_skips="$(jq -c --arg a "$parent" '. + [{agent:$a,reason:"missing"}]' <<<"$expected_skips")"
        break
      fi
      a_role="$(fld 2 "$ancestor")"; a_tpl="$(fld 3 "$ancestor")"; a_status="$(fld 4 "$ancestor")"
      a_label="${a_role:-$parent}"
      if [[ "$a_status" == "terminated" ]]; then
        expected_skips="$(jq -c --arg a "$a_label" '. + [{agent:$a,reason:"terminated"}]' <<<"$expected_skips")"
      elif "$PROV" ceiling | awk -F'\t' -v p="$a_tpl" -v want="$t" '
             $1==p { n=split($2,a,/, */); for(i=1;i<=n;i++) if(a[i]==want) found=1 }
             END { exit !found }'; then
        expected_mode="leader"; expected_role="$a_label"; expected_tpl="$a_tpl"
        break
      else
        expected_skips="$(jq -c --arg a "$a_label" '. + [{agent:$a,reason:"ceiling_insufficient"}]' <<<"$expected_skips")"
      fi
      parent="$(fld 5 "$ancestor")"; depth=$((depth+1))
    done

    mode="$(fld 1 "$out")"; got_role="$(fld 2 "$out")"; got_tpl="$(fld 3 "$out")"; got_skips="$(fld 4 "$out")"
    case "$mode" in
      cycle)    CYCLES=$((CYCLES+1));;
      leader)   DERIVED=$((DERIVED+1));;
      escalate) ESCALATED=$((ESCALATED+1));;
      *)        DERIVATION_ERRORS=$((DERIVATION_ERRORS+1)); bad "unknown derivation mode '$mode' for $(fld 6 "$r")/$t";;
    esac
    [[ "$got_skips" == "[]" ]] || { SKIPS=$((SKIPS+1)); inf "validating skips for $(fld 6 "$r")/$t: $got_skips"; }
    [[ "$mode" == "$expected_mode" && "$got_role" == "$expected_role" \
       && "$got_tpl" == "$expected_tpl" && "$got_skips" == "$expected_skips" ]] \
      || { DERIVATION_ERRORS=$((DERIVATION_ERRORS+1));
           bad "derivation mismatch for $(fld 6 "$r")/$t: got $mode/$got_role/$got_tpl/$got_skips; expected $expected_mode/$expected_role/$expected_tpl/$expected_skips"; }
  done
done
eq "no reporting cycle anywhere in the live org" "$CYCLES" 0
eq "every requestable pair matched the independent chain walk" "$DERIVATION_ERRORS" 0
eq "every examined pair produced exactly one terminal mode" "$((DERIVED+ESCALATED+CYCLES))" "$EXAMINED"
ok "$DERIVED requestable pairs derived a responsible leader"
ok "$ESCALATED requestable pairs exhausted their chain and escalated to the standing floor"
ok "$SKIPS requestable pairs carried an objectively valid non-empty skip prefix"

# ---------------------------------------------------------------------------
hdr "2. The acceptance pair: a real subordinate and its real derived leader"
# The run TOG-199 describes needs a requester whose derived leader is NEITHER
# A0 nor O1, or the proof only re-demonstrates the old closed set.
RQ="$(by_profile D1_MANAGER)"; RQ_ID="$(fld 1 "$RQ")"; RQ_TITLE="$(fld 6 "$RQ")"
[[ -n "$RQ_ID" ]] || { bad "no D1_MANAGER in the live org"; }
WHO="$("$Q" who --requester "$RQ_ID" --template E0_SPECIALIST </dev/null 2>&1)"
eq "a leader is derived, not an escalation" "$(fld 1 "$WHO")" leader
LD_KEY="$(fld 2 "$WHO")"
LD_ROW="$(awk -F'\t' -v k="$LD_KEY" '($1==k||$2==k){print; exit}' "$ORG_SNAPSHOT")"
inf "requester: $RQ_TITLE ($RQ_ID)"
inf "derived leader: $(fld 6 "$LD_ROW") [$(fld 3 "$LD_ROW"), status=$(fld 4 "$LD_ROW")]"
LD_PROF="$(fld 3 "$LD_ROW")"
[[ "$LD_PROF" != "P4_PROVISIONING_STEWARD" && "$LD_PROF" != "P1_PRESIDENT_COO" ]] \
  && ok "the leader is outside the standing authority set — approval proves the new path" \
  || bad "the derived leader IS standing authority; this pair cannot prove the change"

# ---------------------------------------------------------------------------
hdr "3. THE RUN — request, denial with a reason, answer, resubmission, approval"
must_allow "subordinate submits and makes its case" \
  "$Q" submit --requester "$RQ_ID" --template E0_SPECIALIST \
       --title "Rehearsal specialist" --rationale "Initial case, deliberately thin."
R1="$(last_req)"
eq "the request is pending" "$(req_field "$R1" .status)" pending

must_allow "the derived leader DENIES it with a reason AND a safer alternative" \
  "$Q" review --reviewer "$LD_KEY" --request "$R1" --reject \
       --reason "Headcount case not made: name the workload and the duration." \
       --alternative "Route the two blocked issues to the existing platform queue for a fortnight and resubmit with the measured depth."
eq "the denial is recorded" "$(req_field "$R1" .status)" rejected
DR="$(req_field "$R1" '.reason // ""')"
[[ -n "$DR" && "$DR" != null ]] && ok "the denial carries a reason the requester can act on" \
  || bad "the denial carries no reason"
# TOG-388: a reason says why the answer was no; an alternative says what to do
# next. The rehearsal has to show the second, because that is the half that
# stops the work stalling and going to the owner.
DA="$(req_field "$R1" '(.alternatives // []) | length')"
[[ "${DA:-0}" -ge 1 ]] && ok "  ...and at least one safer alternative that still unblocks the work" \
  || bad "the denial carries no alternative (got '$DA')"
eq "the denial was NOT a break-glass override" "$(req_field "$R1" '.override')" null

must_allow "the requester answers the denial in the record" \
  "$Q" comment --request "$R1" --author "$RQ_ID" \
       --body "Workload: the web platform release queue. Duration: through Q4."
must_refuse "an uninvolved third party cannot join the thread" \
  "$Q" comment --request "$R1" --author O2 --body "adding my thoughts"

must_allow "the requester resubmits, superseding the denial" \
  "$Q" submit --requester "$RQ_ID" --template E0_SPECIALIST \
       --title "Rehearsal specialist" --rationale "Workload and duration now stated." \
       --supersedes "$R1"
R2="$(last_req)"
must_refuse "a different agent cannot chain onto that denial" \
  "$Q" submit --requester M0 --template E0_SPECIALIST --title "hijack" --supersedes "$R1"

must_allow "the derived leader approves the amended request" \
  "$Q" review --reviewer "$LD_KEY" --request "$R2" --approve --reason "Case made."
eq "the approval is recorded" "$(req_field "$R2" .status)" approved
eq "APPROVED BY THE CHAIN-DERIVED LEADER (override is null)" "$(req_field "$R2" '.override')" null

CALLER="$(grep -o -- '--caller [^ ]*' "$CREATE_ARGV" | tail -1 | awk '{print $2}')"
eq "the provisioner ran as the ORIGINAL requester" "$CALLER" "$RQ_ID"

TH="$("$Q" thread --request "$R2" </dev/null 2>&1)"
grep -q "$R1" <<<"$TH" && ok "the thread shows the superseded denial, not just the verdict" \
  || bad "the thread does not follow the supersedes link back"
grep -qF "$RQ_TITLE [$RQ_ID]" <<<"$TH" \
  && ok "the audit trail names the requester alongside its stable id" \
  || bad "the audit trail left the requester as a raw UUID"
grep -qF "$(fld 6 "$LD_ROW") [$(fld 1 "$LD_ROW")]" <<<"$TH" \
  && ok "the audit trail names the responsible leader alongside its stable id" \
  || bad "the audit trail left the responsible leader as a raw UUID"
# The rendered exchange is the epic's headline evidence, so make it capturable.
[[ -n "${REHEARSAL_SHOW_THREAD:-}" ]] && { printf '\n'; sed 's/^/      /' <<<"$TH"; printf '\n'; }

# ---------------------------------------------------------------------------
hdr "4. The ways it will actually break"

# 4a. Self-approval.
must_allow "a fresh request to attack" \
  "$Q" submit --requester "$RQ_ID" --template E0_SPECIALIST --title "Self-approval probe"
R3="$(last_req)"
must_refuse "the requester cannot approve its own request" \
  "$Q" review --reviewer "$RQ_ID" --request "$R3" --approve --reason "me"

# 4b. A dormant reviewer. Most of this org is idle; that must not be a skip,
#     and it must not silently widen authority.
restore_org
LD_ID="$(fld 1 "$LD_ROW")"
set_field "$LD_ID" 4 idle
WHO_IDLE="$("$Q" who --requester "$RQ_ID" --template E0_SPECIALIST </dev/null 2>&1)"
eq "an IDLE leader is still the leader — dormancy is not a skip" "$(fld 2 "$WHO_IDLE")" "$LD_KEY"
set_field "$LD_ID" 4 paused
WHO_PAUSED="$("$Q" who --requester "$RQ_ID" --template E0_SPECIALIST </dev/null 2>&1)"
eq "a PAUSED leader is still the leader" "$(fld 2 "$WHO_PAUSED")" "$LD_KEY"
must_allow "the request still routes to the dormant leader" \
  "$Q" submit --requester "$RQ_ID" --template E0_SPECIALIST --title "Dormant-leader probe"
R4="$(last_req)"
must_allow "A0 break-glass can decide over a dormant leader" \
  "$Q" review --reviewer A0 --request "$R4" --approve --reason "leader dormant; break glass"
OV4="$(req_field "$R4" '.override')"
[[ "$OV4" != "null" && -n "$OV4" ]] && ok "the bypass is RECORDED as an override: $OV4" \
  || bad "break-glass left no override on the record — the bypass is invisible"
restore_org

# 4c. TOCTOU: authority changed between submit and approval.
must_allow "a request submitted while the requester is in good standing" \
  "$Q" submit --requester "$RQ_ID" --template E0_SPECIALIST --title "TOCTOU probe"
R5="$(last_req)"
set_field "$RQ_ID" 4 terminated
must_refuse "approval is refused after the requester is terminated" \
  "$Q" review --reviewer "$LD_KEY" --request "$R5" --approve --reason "stale"
restore_org

must_allow "a second request in good standing" \
  "$Q" submit --requester "$RQ_ID" --template E0_SPECIALIST --title "TOCTOU demote probe"
R6="$(last_req)"
set_field "$RQ_ID" 3 E0_SPECIALIST   # demoted below the request ceiling
must_refuse "approval is refused after the requester is demoted" \
  "$Q" review --reviewer "$LD_KEY" --request "$R6" --approve --reason "stale"
restore_org

# 4d. Rows the fixture never had: agents with no permission profile at all.
UNPROF="$(awk -F'\t' '$3==""{print $1; exit}' "$ORG_SNAPSHOT")"
if [[ -n "$UNPROF" ]]; then
  must_refuse "an agent with no permissionProfile cannot request anything" \
    "$Q" submit --requester "$UNPROF" --template E0_SPECIALIST --title "unprofiled probe"
else
  inf "every live agent has a permissionProfile; nothing to probe"
fi

# ---------------------------------------------------------------------------
hdr "5. The audit trail is legible"
# The rendered request thread is the authoritative audit exchange. The grant log
# holds refusal/control diagnostics, and its event schemas are broader than this
# request-flow fix; merely finding a UUID there says nothing about whether the
# rendered decision trail is readable.
[[ -s "$GRANT_LOG" ]] && ok "the grant log recorded the run" || bad "the grant log is empty"
inf "stable UUIDs are retained for attribution; the request thread renders titles beside them ($NOROLE of $N agents have no orgRoleId)"

printf '\n\033[1mRESULT: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]] || exit 1
