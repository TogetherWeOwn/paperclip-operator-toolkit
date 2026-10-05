#!/usr/bin/env bash
# Transport acceptance — the whole provisioning-request run driven through the REAL transport.
#
# WHAT THIS ADDS OVER acceptance_rehearsal.sh
# -------------------------------------------
# The rehearsal calls org_request_queue.sh directly, so `--requester` is
# whatever the suite says it is. That proves the authorization core but it
# cannot prove the one property the epic actually turns on: that a requester is
# WHO THE GATEWAY SAYS THEY ARE and never who the model claims to be.
#
# This suite starts the real `mcp/org-request-mcp.mjs`, unmodified, on a real
# TCP socket, and drives it with real HTTP requests carrying real headers. The
# whole loop — submit, deny with a reason, answer, resubmit, approve, provision
# — goes over the wire. Identity is only ever an HTTP header, exactly as it will
# be in production.
#
# WHAT IT STILL DOES NOT PROVE, and nothing in a container can
# ------------------------------------------------------------
# Three layers sit above this one on the production host and none of them are exercised:
#
#   1. Caddy — TLS, the bearer, and the remote_ip source restriction.
#   2. The Paperclip tool gateway — that it STAMPS x-paperclip-agent-id from
#      tool_gateway_sessions, which is what makes the header trustworthy. Here
#      the suite sets the header itself, so this suite proves the server's
#      half of the contract (it refuses to act without one, and never lets an
#      argument override it) and not the gateway's half (that the value is
#      authentic). The `headerPolicy.metadata.forward` field that decides
#      whether the gateway sends it at all is a registration-time setting and
#      cannot be observed from here.
#   3. `requireLiveRun` — corroborating (agent, run, company) against
#      heartbeat_runs needs a container exec into paperclip-db (docker or
#      podman, per the transport's containerEngine). It is disabled here,
#      which the server's own config comment sanctions for exactly this case.
#      Section 1 asserts it is ON by default, so an operator who copies this
#      suite's config cannot quietly ship with it off.
#
# So: everything below the gateway is proven end to end. The gateway boundary
# itself needs the host install runbook (not part of this repository), whose
# final step runs a live acceptance script where these same assertions get made
# against the live path.
#
# Usage:  PAPERCLIP_API_KEY=... PAPERCLIP_API_URL=... COMPANY_ID=... ./acceptance_transport.sh
set -uo pipefail

# Snapshot export, stub provisioner, scratch paths and assertion helpers.
# shellcheck source=acceptance_org_lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/acceptance_org_lib.sh"

command -v curl >/dev/null || { echo "ERROR: curl required" >&2; exit 1; }
command -v node >/dev/null || { echo "ERROR: node 18+ required" >&2; exit 1; }
SERVER="$HERE/mcp/org-request-mcp.mjs"
[[ -f "$SERVER" ]] || { echo "ERROR: $SERVER not found" >&2; exit 1; }
Q="$HERE/org_request_queue.sh"

# --- the transport under test -----------------------------------------------
# A throwaway bearer, generated per run. The config stores only its digest, so
# even the scratch config is not a credential — the same property the real
# config file is required to have.
BEARER="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
BEARER_SHA="$(printf '%s' "$BEARER" | sha256sum | cut -d' ' -f1)"
PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
CONFIG="$TMP/config.json"
AUDIT="$TMP/transport.jsonl"
URL="http://127.0.0.1:$PORT/mcp"

# queueEnv is the server's own documented passthrough to the queue's test
# seams. Note what is NOT here: COMPANY_ID, PATH, HOME and PAPERCLIP_DB_CTR are
# supplied by the server and normalizeConfig refuses a config that sets them.
# Section 1 proves that refusal rather than taking the comment's word for it.
jq -n --arg cid "$COMPANY_ID" --arg sha "$BEARER_SHA" --arg q "$Q" \
      --argjson port "$PORT" --arg audit "$AUDIT" \
      --arg snap "$ORG_SNAPSHOT" --arg queue "$QUEUE" --arg grant "$GRANT_LOG" \
      --arg dis "$DISABLED_TEMPLATES" --arg prov "$PROV" --arg argv "$CREATE_ARGV" '{
  companyId: $cid, bearerSha256: $sha, queueScript: $q, port: $port,
  requireLiveRun: false, auditLog: $audit,
  queueEnv: { ORG_SNAPSHOT: $snap, QUEUE: $queue, GRANT_LOG: $grant,
              DISABLED_TEMPLATES: $dis, PROV: $prov, CREATE_ARGV: $argv }
}' > "$CONFIG"
chmod 600 "$CONFIG"   # the server refuses any mode with group or other bits

SERVER_PID=""
stop_server() { [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null; }
# The lib already traps EXIT to remove $TMP; add the server to it rather than
# replacing it, or a failing run leaves a listening socket behind.
trap 'stop_server; rm -rf "$TMP"' EXIT

# --- HTTP helpers -----------------------------------------------------------
# The response body goes to a FILE and the status code to stdout. Writing
# `-w '%{http_code}'` into the same stream as the body corrupts the JSON parse,
# and the resulting failure looks like a server bug rather than a harness bug.
RESP="$TMP/resp.json"
RUN_UUID="$(cat /proc/sys/kernel/random/uuid)"

# rpc <status-var-unused> <agent-id|-> <json-body> [extra curl args...]
rpc() {
  local agent="$1" body="$2"; shift 2
  local -a hdrs=(-H "Content-Type: application/json" -H "Authorization: Bearer $BEARER")
  if [[ "$agent" != "-" ]]; then
    hdrs+=(-H "x-paperclip-agent-id: $agent"
           -H "x-paperclip-company-id: $COMPANY_ID"
           -H "x-paperclip-run-id: $RUN_UUID"
           -H "x-paperclip-correlation-id: transport-acceptance")
  fi
  curl -s -o "$RESP" -w '%{http_code}' -X POST "${hdrs[@]}" "$@" -d "$body" "$URL"
}

# call <agent-id> <tool> <json-args> -> prints the tool's text.
#
# The outcome goes to FILES, not to shell variables. Every caller here reads
# call's text with `$(...)`, which runs it in a subshell — an assignment to a
# variable inside would be discarded, and the reader would see an empty status
# forever. That failure mode is silent and it reads as "the server returned
# nothing", so it is worth the two files.
CALL_CODE_F="$TMP/call.code"; CALL_ERR_F="$TMP/call.err"
call() {
  local agent="$1" tool="$2" args="$3"
  local body; body="$(jq -nc --arg t "$tool" --argjson a "$args" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$t,arguments:$a}}')"
  rpc "$agent" "$body" > "$CALL_CODE_F"
  jq -r '.result.isError // false' "$RESP" 2>/dev/null > "$CALL_ERR_F"
  jq -r '.result.content[0].text // ""' "$RESP" 2>/dev/null
}
call_code() { cat "$CALL_CODE_F" 2>/dev/null; }
call_err()  { cat "$CALL_ERR_F" 2>/dev/null; }

# The queue is append-only, so "nothing was appended" is a line count that did
# not move. This is the only honest way to assert a refusal had NO EFFECT.
queue_lines() { [[ -f "$QUEUE" ]] && wc -l < "$QUEUE" || echo 0; }

ok_call()  { local d="$1"; shift; local o; o="$(call "$@")"
  if [[ "$(call_code)" == 200 && "$(call_err)" != "true" ]]; then ok "$d"
  else bad "$d (http=$(call_code) isError=$(call_err))"; sed 's/^/        /' <<<"$o" | head -3; fi; }
refused_call() { local d="$1"; shift; local o; o="$(call "$@")"
  if [[ "$(call_err)" == "true" ]]; then ok "$d"
  else bad "$d (http=$(call_code) isError=$(call_err))"; sed 's/^/        /' <<<"$o" | head -3; fi; }

# ===========================================================================
hdr "0. Boot the real transport"
build_stub
N="$(fetch_org)"
ok "exported $N live agents to the snapshot format"
save_org

node "$SERVER" "$CONFIG" >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -s -o /dev/null --max-time 1 "$URL" && break
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$SERVER_PID" 2>/dev/null; then ok "org-request-mcp is listening on 127.0.0.1:$PORT"
else bad "the server exited during startup"; sed 's/^/        /' "$TMP/server.log" | head -20; fi

# ---------------------------------------------------------------------------
hdr "1. The config controls, before any request"
# These are startup refusals, so each one is a separate short-lived process.
cfg_refuses() { # cfg_refuses <description> <jq args...> <filter>
  local d="$1"; shift
  jq "$@" "$CONFIG" > "$TMP/bad.json"; chmod 600 "$TMP/bad.json"
  if node "$SERVER" "$TMP/bad.json" >"$TMP/bad.log" 2>&1
    then bad "$d (the server started)"
    else ok "$d"; fi
}
cfg_refuses "a config that sets COMPANY_ID in queueEnv is refused at load" \
  '.queueEnv.COMPANY_ID = "11111111-1111-4111-8111-111111111111"'
cfg_refuses "a config that sets PATH in queueEnv is refused at load" \
  '.queueEnv.PATH = "/tmp/evil"'
cfg_refuses "a config pointed at the provisioner instead of the queue is refused" \
  --arg p "$HERE/org_provisioner.sh" '.queueScript = $p'
# requireLiveRun defaults ON: this suite turns it off explicitly, and an
# operator who copies this file must not inherit that silently. Asked of the
# real normalizeConfig rather than asserted from the comment above it.
cat > "$TMP/default-live.mjs" <<'PROBE'
const [server, companyId, sha, queueScript] = process.argv.slice(2);
const { normalizeConfig } = await import(server);
console.log(normalizeConfig({ companyId, bearerSha256: sha, queueScript }).requireLiveRun);
PROBE
DEFAULT_LIVE="$(node "$TMP/default-live.mjs" "$SERVER" "$COMPANY_ID" "$BEARER_SHA" "$Q" 2>&1 | tail -1)"
eq "requireLiveRun is ON unless a config says otherwise" "$DEFAULT_LIVE" "true"
cp "$CONFIG" "$TMP/loose.json"; chmod 640 "$TMP/loose.json"
if node "$SERVER" "$TMP/loose.json" >/dev/null 2>&1; then bad "a group-readable config was accepted"
else ok "a group-readable config is refused (it holds a credential verifier)"; fi

# ---------------------------------------------------------------------------
hdr "2. Identity is the transport's job, and it fails closed"
# Built by hand rather than through rpc(): rpc() already sets Authorization, and
# a second -H appends rather than replaces, so the server would see the GOOD
# bearer first and the test would pass without ever presenting a wrong one.
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
        -H 'Authorization: Bearer wrong-bearer' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$URL")"
eq "a wrong bearer is 401 at the transport" "$CODE" "401"
if grep -qi 'www-authenticate' <<<"$(curl -s -D - -o /dev/null -X POST -H 'Authorization: Bearer wrong' \
     -H 'Content-Type: application/json' -d '{}' "$URL")"; then
  bad "the 401 carries WWW-Authenticate (sends the gateway off to discover OAuth)"
else ok "the 401 carries no WWW-Authenticate header"; fi
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "$URL")"
eq "no bearer at all is 401" "$CODE" "401"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $BEARER" "$URL")"
eq "GET is 405 — there is no streaming leg to open" "$CODE" "405"

# tools/list is deliberately anonymous: it is the gateway's catalog refresh and
# health check, and it carries credentials but no session.
CODE="$(rpc "-" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
eq "tools/list answers anonymously (the gateway health check)" "$CODE" "200"
TOOLS="$(jq -r '.result.tools[].name' "$RESP" | sort | tr '\n' ' ')"
# Pinned literally, so a new tool on a DEPLOYED server is a deliberate edit
# here and never a silent addition. Three front org_request_queue.sh and three
# front capability_gate.sh; this line once said "exactly two" after the surface
# grew, having been left behind by later additions, which is how an assertion
# becomes a comment. There is still no provisioner tool and there never may be.
eq "exactly the six sanctioned tools, and no provisioner tool" "$TOOLS" \
   "countersign_capability_request read_my_requests review_capability_request review_provisioning_request submit_capability_request submit_provisioning_request "
# Five of the six are writes. A transport of writes alone makes the
# decision record write-only to the agent it is about, because an agent
# principal has no shell on this host — see section 4b, which reads a real
# denial back over the wire.
READS="$(jq -r '[.result.tools[].name | select(startswith("read_"))] | length' "$RESP")"
eq "the surface includes a READ, or a requester can never reach a decision" "$READS" "1"
# The schema is the contract the model reads. If identity appears here as an
# input, every check below the transport is decorative.
IDENT_PROPS="$(jq -r '[.result.tools[].inputSchema.properties | keys[]] | map(select(
    . == "requester" or . == "reviewer" or . == "agent_id" or . == "caller" or . == "on_behalf_of"
    or . == "for" or . == "custodian" or . == "decider"))
    | length' "$RESP")"
eq "no tool advertises an identity argument" "$IDENT_PROPS" "0"
# Counted against the tool count rather than a literal, because a literal that
# rots reads as a pass: `2` stayed green as tools were added by
# measuring two of five schemas and ignoring the rest.
N_TOOLS="$(jq -r '.result.tools | length' "$RESP")"
CLOSED="$(jq -r '[.result.tools[].inputSchema.additionalProperties] | map(select(. == false)) | length' "$RESP")"
eq "EVERY schema is additionalProperties:false" "$CLOSED" "$N_TOOLS"
# The read tool's guarantee is that there is nothing to fill in. Asserted
# against the deployed catalogue, not the source.
READ_PROPS="$(jq -r '[.result.tools[] | select(.name=="read_my_requests") | .inputSchema.properties | keys[]] | length' "$RESP")"
eq "the read tool advertises NO argument at all, so none can name a principal" "$READ_PROPS" "0"

SUBMIT_RPC='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"submit_provisioning_request","arguments":{"template":"E0_SPECIALIST","title":"anonymous"}}}'
BEFORE="$(queue_lines)"
CODE="$(rpc "-" "$SUBMIT_RPC")"
eq "a tools/call with NO identity headers at all is 403, not 200" "$CODE" "403"
eq "the anonymous call appended nothing to the queue" "$(queue_lines)" "$BEFORE"

# ISOLATE THE AGENT HEADER. The assertion above sends no identity headers at
# all, so its 403 is equally explained by the COMPANY check — it passes even if
# a missing agent id silently defaults to some principal, which is the precise
# regression that would void the epic. Verified by mutation: defaulting agentId
# when the header is absent leaves the test above green and reddens only this
# one. Send everything EXCEPT the agent id.
BEFORE="$(queue_lines)"
CODE="$(curl -s -o "$RESP" -w '%{http_code}' -X POST \
  -H "Content-Type: application/json" -H "Authorization: Bearer $BEARER" \
  -H "x-paperclip-company-id: $COMPANY_ID" -H "x-paperclip-run-id: $RUN_UUID" \
  -d "$SUBMIT_RPC" "$URL")"
eq "an otherwise-complete call missing ONLY the agent header is 403" "$CODE" "403"
eq "that call appended nothing either" "$(queue_lines)" "$BEFORE"
CODE="$(rpc "not-a-uuid" '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"submit_provisioning_request","arguments":{"template":"E0_SPECIALIST","title":"x"}}}')"
eq "a malformed agent header is 403" "$CODE" "403"

# ---------------------------------------------------------------------------
hdr "3. The acceptance pair, from the live org"
RQ="$(by_profile D1_MANAGER)"; RQ_ID="$(fld 1 "$RQ")"
[[ -n "$RQ_ID" ]] && ok "a real D1_MANAGER requester: $(fld 6 "$RQ")" || bad "no D1_MANAGER in the live org"
WHO="$("$Q" who --requester "$RQ_ID" --template E0_SPECIALIST </dev/null 2>&1)"
eq "a leader is derived from the reporting chain" "$(fld 1 "$WHO")" leader
LD_KEY="$(fld 2 "$WHO")"
LD_ROW="$(awk -F'\t' -v k="$LD_KEY" '($1==k||$2==k){print; exit}' "$ORG_SNAPSHOT")"
LD_ID="$(fld 1 "$LD_ROW")"     # the transport knows agents by UUID, never by role key
inf "derived leader: $(fld 6 "$LD_ROW") [$(fld 3 "$LD_ROW")]"
LD_PROF="$(fld 3 "$LD_ROW")"
[[ "$LD_PROF" != "P4_PROVISIONING_STEWARD" && "$LD_PROF" != "P1_PRESIDENT_COO" ]] \
  && ok "the leader is outside the standing authority set" \
  || bad "the derived leader IS standing authority; this pair cannot prove the change"

# ---------------------------------------------------------------------------
hdr "4. THE RUN, entirely over HTTP"
ok_call "subordinate submits and makes its case" "$RQ_ID" submit_provisioning_request \
  '{"template":"E0_SPECIALIST","title":"Transport specialist","rationale":"Initial case, deliberately thin."}'
R1="$(last_req)"
eq "the request is pending" "$(req_field "$R1" .status)" pending
# The point of the whole epic: the row's requester is the HEADER, not an argument.
eq "the recorded requester is the authenticated caller" "$(req_field "$R1" .requester)" "$RQ_ID"

ok_call "the derived leader DENIES it with a reason" "$LD_ID" review_provisioning_request \
  "$(jq -nc --arg r "$R1" '{request_id:$r,decision:"reject",
      reason:"Headcount case not made: name the workload and the duration.",
      alternatives:["Route the release-queue work through the existing E0 specialist until the workload is named."]}')"
eq "the denial is recorded" "$(req_field "$R1" .status)" rejected
DR="$(req_field "$R1" '.reason // ""')"
[[ -n "$DR" && "$DR" != null ]] && ok "the denial carries a reason the requester can act on" \
  || bad "the denial carries no reason"
eq "the denial was NOT a break-glass override" "$(req_field "$R1" '.override')" null
eq "the denial is attributed to the authenticated reviewer" "$(req_field "$R1" '.reviewer')" "$LD_ID"

ok_call "the requester resubmits, superseding the denial" "$RQ_ID" submit_provisioning_request \
  "$(jq -nc --arg s "$R1" '{template:"E0_SPECIALIST",title:"Transport specialist",rationale:"Workload: the web platform release queue. Duration: through Q4.",supersedes:$s}')"
R2="$(last_req)"
[[ "$R2" != "$R1" ]] && ok "the resubmission is a new request ($R2)" || bad "supersedes did not create a new request"

ok_call "the derived leader approves the amended request" "$LD_ID" review_provisioning_request \
  "$(jq -nc --arg r "$R2" '{request_id:$r,decision:"approve",reason:"Case made."}')"
eq "the approval is recorded" "$(req_field "$R2" .status)" approved
eq "APPROVED BY THE CHAIN-DERIVED LEADER (override is null)" "$(req_field "$R2" '.override')" null

CALLER="$(grep -o -- '--caller [^ ]*' "$CREATE_ARGV" | tail -1 | awk '{print $2}')"
eq "the provisioner ran as the ORIGINAL requester" "$CALLER" "$RQ_ID"
TH="$("$Q" thread --request "$R2" </dev/null 2>&1)"
grep -q "$R1" <<<"$TH" && ok "the thread follows the supersedes link back to the denial" \
  || bad "the thread does not follow the supersedes link back"
grep -qF "$(fld 6 "$RQ") [$RQ_ID]" <<<"$TH" \
  && ok "the HTTP audit trail names the authenticated requester alongside its stable id" \
  || bad "the HTTP audit trail left the requester as a raw UUID"
grep -qF "$(fld 6 "$LD_ROW") [$LD_ID]" <<<"$TH" \
  && ok "the HTTP audit trail names the authenticated reviewer alongside its stable id" \
  || bad "the HTTP audit trail left the reviewer as a raw UUID"
[[ -n "${TRANSPORT_SHOW_THREAD:-}" ]] && { printf '\n'; sed 's/^/      /' <<<"$TH"; printf '\n'; }

# ---------------------------------------------------------------------------
hdr "4b. The requester READS the decision back — over the same wire"
# ---------------------------------------------------------------------------
# Everything above this line is a write. Until this section existed the run
# ended here, and the requester — which has no shell on this host, the whole premise of the
# epic — had no way to learn any of it. review_provisioning_request's schema
# says the reason is "readable by the requester, who may answer it"; this
# section is the assertion that makes that sentence true instead of aspirational.
INBOX="$(call "$RQ_ID" read_my_requests '{}')"
if [[ "$(call_err)" == "true" ]]; then
  bad "the requester cannot read its own decisions (http=$(call_code))"
  sed 's/^/        /' <<<"$INBOX" | head -3
else
  ok "the requester reads its own inbox with no argument to supply"
  grep -q "$R1" <<<"$INBOX" && ok "  ...and the DENIAL is in it" || bad "  ...but the denial is not in it"
  grep -q "Headcount case not made" <<<"$INBOX" \
    && ok "  ...carrying the reviewer's reason, verbatim, over the transport" \
    || bad "  ...without the reason, so the deny-with-reason is still write-only here"
  grep -q "$R2" <<<"$INBOX" && ok "  ...and the APPROVAL of the amended request" \
    || bad "  ...but the approval is missing"
fi

# The other half, and the one worth an adversarial check: it is MY inbox. The
# reviewer reading its own must not see the requester's decisions, or a
# per-principal read is a company-wide one wearing a per-principal name.
LD_INBOX="$(call "$LD_ID" read_my_requests '{}')"
if grep -q "Headcount case not made" <<<"$LD_INBOX"; then
  bad "the REVIEWER's inbox carries the requester's denial — the read is not scoped to the caller"
else
  ok "the reviewer's own inbox does not carry the requester's decisions"
fi

# A read must not be able to move a decision. Constraint 2 of the
# requester-notification design, measured the only honest way on an append-only file: the decision
# rows either side of the reads above are byte-identical.
DEC_BEFORE="$(jq -c 'select(.event=="request.submitted" or .event=="request.reviewed")' "$QUEUE" | md5sum)"
call "$RQ_ID" read_my_requests '{}' >/dev/null
call "$RQ_ID" read_my_requests '{}' >/dev/null
DEC_AFTER="$(jq -c 'select(.event=="request.submitted" or .event=="request.reviewed")' "$QUEUE" | md5sum)"
eq "reading changes no decision row — reading is not acking, and not a control" "$DEC_AFTER" "$DEC_BEFORE"

# And there is no way to ask for somebody else's. The schema declares nothing,
# so both the identity-named key and the innocuous one are refused, not dropped.
BEFORE="$(queue_lines)"
refused_call "naming another agent in the read is refused, not honoured" \
  "$RQ_ID" read_my_requests "$(jq -nc --arg v "$LD_ID" '{requester:$v}')"
refused_call "  ...and so is an argument that merely looks harmless" \
  "$RQ_ID" read_my_requests '{"for":"anyone"}'
eq "  ...and neither refusal appended anything" "$(queue_lines)" "$BEFORE"

# ---------------------------------------------------------------------------
hdr "5. Forging a requester, over the wire"
# The listed names are refused loudly and by name. The epic's definition of done
# is that this refusal appends NOTHING, so assert the line count, not just the
# error — a refusal that still wrote a row would pass an error-only assertion.
BEFORE="$(queue_lines)"
OUT="$(call "$RQ_ID" submit_provisioning_request \
  "$(jq -nc --arg v "$LD_ID" '{template:"E0_SPECIALIST",title:"forged",requester:$v}')")"
[[ "$(call_err)" == "true" ]] && ok "a 'requester' argument is refused" || bad "a 'requester' argument was accepted"
grep -q identity_argument_refused <<<"$OUT" \
  && ok "the refusal names the identity rule, not a generic schema error" \
  || { bad "the refusal does not name the identity rule"; sed 's/^/        /' <<<"$OUT" | head -2; }
eq "the forged submit appended nothing" "$(queue_lines)" "$BEFORE"

# The CISO's case: an UNLISTED identity-ish name behaves differently
# by design, and the difference is the thing worth pinning. Whatever the
# disposition, the invariant is the same — the forged value must never become
# the requester. Assert the OUTCOME, not the error, because an assertion that
# only checks for a refusal passes for the wrong reason.
BEFORE="$(queue_lines)"
OUT="$(call "$RQ_ID" submit_provisioning_request \
  "$(jq -nc --arg v "$LD_ID" '{template:"E0_SPECIALIST",title:"unlisted-forge",submitter:$v}')")"
if [[ "$(call_err)" == "true" ]]; then
  inf "an unlisted identity name ('submitter') is REFUSED as an unknown argument"
  grep -q unknown_argument <<<"$OUT" \
    && ok "the unlisted name is refused by the schema control, not silently dropped" \
    || { bad "refused, but not by the schema control"; sed 's/^/        /' <<<"$OUT" | head -2; }
  eq "the unlisted forge appended nothing" "$(queue_lines)" "$BEFORE"
else
  inf "an unlisted identity name ('submitter') is silently DROPPED and the request proceeds"
  RX="$(last_req)"
  eq "the row's requester is the authenticated caller, not 'submitter'" \
     "$(req_field "$RX" .requester)" "$RQ_ID"
fi

# ---------------------------------------------------------------------------
hdr "6. The ways it will actually break"
ok_call "a fresh request to attack" "$RQ_ID" submit_provisioning_request \
  '{"template":"E0_SPECIALIST","title":"Attack subject"}'
R3="$(last_req)"
refused_call "the requester cannot approve its own request, even over the transport" \
  "$RQ_ID" review_provisioning_request \
  "$(jq -nc --arg r "$R3" '{request_id:$r,decision:"approve",reason:"self"}')"
eq "the self-approval left the request pending" "$(req_field "$R3" .status)" pending

# TOCTOU: the authority that was valid at submit is re-read at approval.
set_field "$RQ_ID" 4 terminated
refused_call "approval is refused after the requester is terminated" \
  "$LD_ID" review_provisioning_request \
  "$(jq -nc --arg r "$R3" '{request_id:$r,decision:"approve",reason:"stale authority"}')"
eq "the TOCTOU refusal left the request pending" "$(req_field "$R3" .status)" pending
restore_org

# Dormancy. Per the counterparty's liveness measurement this is the COMMON case
# on this instance, not an edge: 19 of 27 agents have never run. A dormant
# leader must remain the leader — a transport that skipped to someone reachable
# would be routing by convenience.
set_field "$LD_ID" 4 idle
WHO2="$("$Q" who --requester "$RQ_ID" --template E0_SPECIALIST </dev/null 2>&1)"
eq "an IDLE leader is still the leader — dormancy is not a skip" "$(fld 1 "$WHO2")" leader
ok_call "a dormant leader can still decide when woken" "$LD_ID" review_provisioning_request \
  "$(jq -nc --arg r "$R3" '{request_id:$r,decision:"approve",reason:"Approved after wake."}')"
eq "the dormant leader's approval is recorded" "$(req_field "$R3" .status)" approved
eq "and it is still not an override" "$(req_field "$R3" '.override')" null
restore_org

# ---------------------------------------------------------------------------
hdr "7. The audit trail"
[[ -s "$AUDIT" ]] && ok "the transport wrote an audit log" || bad "the transport audit log is empty"
eq "every audited call names the agent that made it" \
   "$(jq -r 'select(.event=="tool.call") | select(.agentId == null) | .event' "$AUDIT" | wc -l)" "0"
eq "the refused anonymous call was audited as a refusal" \
   "$(jq -r 'select(.event=="request.refused" and .code=="identity_header_missing") | .code' "$AUDIT" | head -1)" \
   "identity_header_missing"
# The bearer must not be anywhere except Caddy's environment and the secret
# store. A grep is crude, but this is the file most likely to be pasted into a
# ticket, and the rationale text is the other thing that must not be duplicated.
if grep -q "$BEARER" "$AUDIT" "$TMP/server.log" 2>/dev/null; then
  bad "the bearer appears in the audit log or stderr"
else ok "the bearer appears in neither the audit log nor the server's stderr"; fi
if grep -q "release queue" "$AUDIT" 2>/dev/null; then
  bad "the transport log duplicates argument VALUES; the queue's log is authoritative"
else ok "the transport log records argument keys only, never values"; fi
[[ -s "$GRANT_LOG" ]] && ok "the grant log is non-empty after the run" || bad "the grant log is empty"
# The queue's own log is the authoritative record, and the epic's claim is that
# EVERY step appears in it. Name the two parties and the approved request, so
# deleting any one of the three reddens this.
for want in "$RQ_ID" "$LD_ID" "$R2"; do
  grep -q "$want" "$GRANT_LOG" "$QUEUE" \
    && ok "the audit trail names $want" \
    || bad "the audit trail does not name $want"
done

# ===========================================================================
printf '\n\033[1mRESULT: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
