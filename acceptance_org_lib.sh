#!/usr/bin/env bash
# Shared fixture machinery for the TOG-199 acceptance suites.
#
# Both acceptance suites need the same three things: a snapshot of the REAL org
# in the TSV the queue reads, a stub provisioner whose ceiling is EXTRACTED from
# the real org_provisioner.sh, and scratch paths for the queue's append-only
# logs. They differ only in HOW they reach the queue:
#
#   acceptance_rehearsal.sh   calls org_request_queue.sh directly, so it proves
#                             the authorization core against the real org.
#   acceptance_transport.sh   goes through the real mcp/org-request-mcp.mjs over
#                             real HTTP, so it also proves identity.
#
# Sourced, never executed. Nothing here mutates the real org: `create` writes to
# a scratch TSV copy, and the only network call is a GET of the agent roster.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v jq >/dev/null || { echo "ERROR: jq required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "ERROR: python3 required" >&2; exit 1; }
: "${PAPERCLIP_API_KEY:?Set PAPERCLIP_API_KEY}"
: "${PAPERCLIP_API_URL:?Set PAPERCLIP_API_URL}"
COMPANY_ID="${COMPANY_ID:-${PAPERCLIP_COMPANY_ID:?Set COMPANY_ID or PAPERCLIP_COMPANY_ID}}"

API="${PAPERCLIP_API_URL%/}"; API="${API%/api}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

export COMPANY_ID
export ORG_SNAPSHOT="$TMP/org.tsv"
export QUEUE="$TMP/queue.jsonl"
export GRANT_LOG="$TMP/grant-log.jsonl"
export DISABLED_TEMPLATES="$TMP/disabled"
export PROV="$TMP/stub_provisioner.sh"
export CREATE_ARGV="$TMP/create.argv"
Q="$HERE/org_request_queue.sh"

PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
inf() { printf '  \033[36mNOTE\033[0m  %s\n' "$1"; }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

must_refuse() { local d="$1"; shift; local o; o="$("$@" </dev/null 2>&1)"; local rc=$?
  if [[ $rc -ne 0 ]] && grep -q REFUSED <<<"$o"; then ok "$d"
  else bad "$d (rc=$rc)"; sed 's/^/        /' <<<"$o" | head -3; fi; }
must_allow()  { local d="$1"; shift; local o; o="$("$@" </dev/null 2>&1)"; local rc=$?
  if [[ $rc -eq 0 ]]; then ok "$d"; else bad "$d (rc=$rc)"; sed 's/^/        /' <<<"$o" | head -4; fi; }
eq() { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (got '$2', wanted '$3')"; }

# The queue reads fields with cut(1), which does not collapse empty columns.
# Anything in THIS script that parses the snapshot must do the same: tab is IFS
# whitespace, so a bash `IFS=$'\t' read` silently merges consecutive tabs, and
# most of this org has an empty orgRoleId column. Parsing the snapshot with
# `read` shifts every later field left and the whole sweep reads as passing
# while never exercising the engineering chain at all.
fld() { cut -f"$1" <<<"$2"; }

# --- the stub provisioner ---------------------------------------------------
# `ceiling` re-emits the REAL CEILING_JSON, extracted rather than copied, so
# this suite cannot keep passing after the real ceiling changes.
build_stub() {
  {
    echo '#!/usr/bin/env bash'
    echo 'set -uo pipefail'
    sed -n "/^CEILING_JSON='{/,/^}'\$/p" "$HERE/org_provisioner.sh"
    # EXTRACTED, never copied — same rule as the ceiling above. The risk
    # classifier added in TOG-388 reads this catalog to decide whether an ask is
    # risky, and a stub holding its own copy would keep answering against
    # yesterday's permission keys.
    sed -n "/^TEMPLATES_JSON='{/,/^}'\$/p" "$HERE/org_provisioner.sh"
    cat <<'STUB'
[[ -n "${CEILING_JSON:-}" ]]   || { echo "stub: failed to extract CEILING_JSON" >&2; exit 90; }
[[ -n "${TEMPLATES_JSON:-}" ]] || { echo "stub: failed to extract TEMPLATES_JSON" >&2; exit 90; }
case "${1:-}" in
  ceiling) jq -r 'to_entries[] | "\(.key)\t\(.value|join(", "))"' <<<"$CEILING_JSON" ;;
  template-keys) jq -r 'to_entries[] | "\(.key)\t\(.value|map(.permissionKey)|join(","))"' <<<"$TEMPLATES_JSON" ;;
  create)
    shift; printf '%s\n' "$*" >> "${CREATE_ARGV:?}"
    caller=""; template=""; title=""
    while [[ $# -gt 0 ]]; do case "$1" in
      --caller)   caller="$2";   shift 2;;
      --template) template="$2"; shift 2;;
      --title)    title="$2";    shift 2;;
      *) shift;; esac; done
    n="$(wc -l < "$ORG_SNAPSHOT")"
    uuid="$(printf '00000000-0000-4000-8000-%012d' "$n")"
    parent="$(awk -F'\t' -v k="$caller" '($1==k||$2==k){print $1; exit}' "$ORG_SNAPSHOT")"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$uuid" "sim-$n" "$template" "idle" "$parent" "$title" >> "$ORG_SNAPSHOT"
    echo "PROVISIONED $template -> $uuid" ;;
  *) echo "stub: unsupported subcommand '${1:-}'" >&2; exit 91;;
esac
STUB
  } > "$PROV"
  chmod +x "$PROV"
  [[ -n "$("$PROV" ceiling)" ]] || { echo "ERROR: ceiling extraction produced nothing" >&2; exit 1; }
}

# --- export the live org into the snapshot format ---------------------------
# id \t orgRoleId \t permissionProfile \t status \t reportsTo \t title
fetch_org() {
  curl -sf -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
       "$API/api/companies/$COMPANY_ID/agents" -o "$TMP/agents.json" \
    || { echo "ERROR: could not fetch the agent roster" >&2; exit 1; }
  python3 - "$TMP/agents.json" "$ORG_SNAPSHOT" <<'PY'
import json, sys
items = json.load(open(sys.argv[1]))
with open(sys.argv[2], 'w') as fh:
    for a in items:
        m = a.get('metadata') or {}
        fh.write('\t'.join([
            a['id'], m.get('orgRoleId', '') or '',
            m.get('permissionProfile', '') or '',
            a.get('status', '') or '', a.get('reportsTo') or '',
            (a.get('title', '') or '').replace('\t', ' '),
        ]) + '\n')
print(len(items))
PY
}

# Find one agent by permission profile; prefer a named orgRoleId. Emits the row.
by_profile() { awk -F'\t' -v p="$1" '$3==p{print; exit}' "$ORG_SNAPSHOT"; }
save_org()    { cp "$ORG_SNAPSHOT" "$TMP/org.bak"; }
restore_org() { cp "$TMP/org.bak" "$ORG_SNAPSHOT"; }
# Rewrite one agent's row in place: set_field <id> <fieldno> <value>
set_field() {
  awk -F'\t' -v OFS='\t' -v k="$1" -v n="$2" -v v="$3" \
      '$1==k{$n=v} {print}' "$ORG_SNAPSHOT" > "$TMP/x" && mv "$TMP/x" "$ORG_SNAPSHOT"
}
# Latest request id in the queue. The queue is append-only and the current
# state of a request is its most recent status-bearing record, so read it the
# same way org_request_queue.sh does rather than taking the last line.
last_req() { jq -r 'select(.event=="request.submitted")|.requestId' "$QUEUE" | tail -1; }
req_state() { jq -c --arg i "$1" 'select(.requestId==$i and has("status"))' "$QUEUE" | tail -1; }
req_field() { req_state "$1" | jq -r "$2"; }
