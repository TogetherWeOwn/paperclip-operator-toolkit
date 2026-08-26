#!/usr/bin/env bash
# blocked_audit.sh - apply an explicit blocked-issue audit table, idempotently.
#
# WHY THIS IS A SCRIPT AND NOT A HEARTBEAT'S JUDGEMENT
#   The platform caps a run at 20 cross-issue writes, so a large audited disposition
#   can span runs. A model re-improvising the dispositions each run would re-derive
#   them differently; this script executes a caller-supplied snapshot and never
#   invents or refreshes verdicts itself.
#
# WHY THERE IS NO DEFAULT TABLE
#   Issue status, blocker links, interactions and assignees all move independently.
#   A checked-in operational snapshot becomes a delayed write against stale evidence.
#   The caller must deliberately name the audited table for every invocation. Each row
#   carries the source status and assignee observed by the audit; if either field is
#   neither its source nor its intended target, the script refuses the row rather than
#   overwriting a newer disposition.
#
# IDEMPOTENCE AND RECOVERY
#   A complete target is skipped. A partially applied target is resumed: assignment may
#   already equal the target while status still equals the source, or vice versa. This
#   matters because leaving `blocked` requires assign-then-status and the second PATCH
#   can fail after the first succeeds.
#
# FAIL-CLOSED VALIDATION
#   Every selected row and every live precondition is validated before the first PATCH.
#   A malformed or stale trailing row therefore cannot leave an earlier row applied.
#
# Usage:
#   ./blocked_audit.sh --table audit.json --status
#   ./blocked_audit.sh --table audit.json --apply [--max N] # default 16 writes
set -uo pipefail

TABLE="${TABLE:-}"
MODE="--status"
MAX_WRITES=16

while [ $# -gt 0 ]; do
  case "$1" in
    --status) MODE="--status" ;;
    --apply)  MODE="--apply" ;;
    --table)  shift; TABLE="${1:?--table needs a path}" ;;
    --max)    shift; MAX_WRITES="${1:?--max needs a number}" ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

for v in PAPERCLIP_API_KEY PAPERCLIP_API_URL PAPERCLIP_COMPANY_ID; do
  if [ -z "${!v:-}" ]; then echo "FATAL: $v is not set" >&2; exit 2; fi
done
[ -n "$TABLE" ] || { echo "FATAL: --table PATH (or TABLE) is required" >&2; exit 2; }
[ -f "$TABLE" ] || { echo "FATAL: table not found: $TABLE" >&2; exit 2; }
[[ "$MAX_WRITES" =~ ^[0-9]+$ ]] || { echo "FATAL: --max must be a non-negative integer" >&2; exit 2; }
jq -e 'type == "object" and (.dispositions | type == "array") and all(.dispositions[]; type == "object" and ((has("done")|not) or (.done|type=="boolean")))' "$TABLE" >/dev/null 2>&1 \
  || { echo "FATAL: table must contain disposition objects with boolean done fields" >&2; exit 2; }

BASE="${PAPERCLIP_API_URL%/}"; BASE="${BASE%/api}"
JSON=(-H "Content-Type: application/json")
RUNHDR=()
[ -n "${PAPERCLIP_RUN_ID:-}" ] && RUNHDR=(-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID")

BOARD="$(mktemp)"; AGENTS="$(mktemp)"; CURL_CONFIG="$(mktemp)"; PLAN="$(mktemp)"
trap 'rm -f "$BOARD" "$AGENTS" "$CURL_CONFIG" "$PLAN"' EXIT
chmod 600 "$CURL_CONFIG"
printf 'header = "Authorization: Bearer %s"\n' "$PAPERCLIP_API_KEY" > "$CURL_CONFIG"
code=$(curl -s --config "$CURL_CONFIG" "$BASE/api/companies/$PAPERCLIP_COMPANY_ID/issues" -o "$BOARD" -w '%{http_code}')
if [ "$code" != "200" ]; then echo "FATAL: issue list HTTP $code" >&2; exit 3; fi
code=$(curl -s --config "$CURL_CONFIG" "$BASE/api/companies/$PAPERCLIP_COMPANY_ID/agents" -o "$AGENTS" -w '%{http_code}')
if [ "$code" != "200" ]; then echo "FATAL: agent list HTTP $code" >&2; exit 3; fi

# Resolve an 8-char agent-id prefix to its full uuid against the COMPANY-scoped agent
# list. Deliberately never by name: two companies share one database here and agent
# names collide across them, so a name lookup can return the wrong company's agent.
resolve_agent() {
  local pfx="$1" hits
  hits=$(jq -r --arg p "$pfx" \
    '(if type=="array" then . else .agents end)|map(select(.id|startswith($p)))|.[].id' "$AGENTS")
  if [ "$(printf '%s\n' "$hits" | grep -c .)" != "1" ]; then echo ""; return 1; fi
  printf '%s' "$hits"
}

target_status() {
  case "$1" in
    KEEP_BLOCKED) echo "blocked" ;;
    BACKLOG)      echo "backlog" ;;
    UNBLOCK|RESOLVED) echo "todo" ;;
    *)            echo "" ;;
  esac
}

writes=0; applied=0; skipped=0; pending=0; failed=0; examined=0
declare -A seen_keys=()

# Pass 1 validates the complete table and builds an immutable execution plan.
while IFS= read -r encoded; do
  [ -n "$encoded" ] || continue
  examined=$((examined+1))
  audit_row=$(printf '%s' "$encoded" | base64 -d) || {
    failed=$((failed+1)); echo "FAIL     row $examined: malformed audit row"; continue
  }

  key=$(printf '%s' "$audit_row" | jq -r 'if (.key|type)=="string" then .key else "" end')
  verdict=$(printf '%s' "$audit_row" | jq -r 'if (.verdict|type)=="string" then .verdict else "" end')
  apfx=$(printf '%s' "$audit_row" | jq -r 'if (.assignee|type)=="string" then .assignee else "" end')
  source_status=$(printf '%s' "$audit_row" | jq -r 'if (.source|type)=="object" and (.source.status|type)=="string" then .source.status else "" end')
  source_has_asg=$(printf '%s' "$audit_row" | jq -r '(.source|type)=="object" and (.source|has("assigneeAgentId")) and ((.source.assigneeAgentId==null) or ((.source.assigneeAgentId|type)=="string"))')
  source_has_user=$(printf '%s' "$audit_row" | jq -r '(.source|type)=="object" and (.source|has("assigneeUserId")) and ((.source.assigneeUserId==null) or ((.source.assigneeUserId|type)=="string"))')
  source_asg=$(printf '%s' "$audit_row" | jq -r '.source.assigneeAgentId // ""')
  source_user=$(printf '%s' "$audit_row" | jq -r '.source.assigneeUserId // ""')

  if [ -z "$key" ]; then
    failed=$((failed+1)); echo "FAIL     row $examined: key is required"; continue
  fi
  if [ -n "${seen_keys[$key]:-}" ]; then
    failed=$((failed+1)); echo "FAIL     $key: duplicate disposition"; continue
  fi
  seen_keys[$key]=1
  if [[ ! "$apfx" =~ ^[0-9a-f]{8}$ ]]; then
    failed=$((failed+1)); echo "FAIL     $key: assignee must be an 8-character lowercase hex prefix"; continue
  fi
  if [ -z "$source_status" ] || [ "$source_has_asg" != "true" ] || [ "$source_has_user" != "true" ]; then
    failed=$((failed+1)); echo "FAIL     $key: audited source status, assigneeAgentId, and assigneeUserId are required"; continue
  fi
  want_status="$(target_status "$verdict")"
  if [ -z "$want_status" ]; then
    failed=$((failed+1)); echo "FAIL     $key: unknown verdict '$verdict'"; continue
  fi
  if ! want_asg="$(resolve_agent "$apfx")"; then
    failed=$((failed+1)); echo "FAIL     $key: agent prefix '$apfx' did not resolve to exactly one agent"; continue
  fi

  row=$(jq -c --arg k "$key" \
    '(if type=="array" then . else .issues end)|map(select(.identifier==$k))|.[0] // empty' "$BOARD")
  if [ -z "$row" ]; then
    failed=$((failed+1)); echo "MISSING  $key (not on board)"; continue
  fi

  id=$(printf '%s' "$row" | jq -r '.id')
  cur_status=$(printf '%s' "$row" | jq -r '.status')
  cur_asg=$(printf '%s' "$row" | jq -r '.assigneeAgentId // ""')
  cur_user=$(printf '%s' "$row" | jq -r '.assigneeUserId // ""')

  # Valid live states are the exact audited source, the exact target, or the one
  # intermediate this script can create: target assignee + source status after
  # assignment succeeds but the status PATCH fails. Accepting arbitrary mixtures
  # would mistake a newer external disposition for our own partial progress.
  source_match=0; target_match=0; partial_match=0
  [ "$cur_status" = "$source_status" ] && [ "$cur_asg" = "$source_asg" ] && [ "$cur_user" = "$source_user" ] && source_match=1
  [ "$cur_status" = "$want_status" ] && [ "$cur_asg" = "$want_asg" ] && [ -z "$cur_user" ] && target_match=1
  if [ "$source_status" != "$want_status" ] && [ "$source_asg" != "$want_asg" ] && \
     [ "$cur_status" = "$source_status" ] && [ "$cur_asg" = "$want_asg" ] && [ -z "$cur_user" ]; then
    partial_match=1
  fi
  if [ "$source_match" = 0 ] && [ "$target_match" = 0 ] && [ "$partial_match" = 0 ]; then
    failed=$((failed+1)); echo "STALE    $key: source moved status:$source_status->$cur_status agent:${source_asg:0:8}->${cur_asg:0:8} user:${source_user:0:8}->${cur_user:0:8}"; continue
  fi

  need_assign=0; need_status=0
  [ "$cur_asg" != "$want_asg" ] && need_assign=1
  [ "$cur_status" != "$want_status" ] && need_status=1
  jq -nc --arg key "$key" --arg verdict "$verdict" --arg id "$id" \
    --arg apfx "$apfx" --arg want_asg "$want_asg" --arg want_status "$want_status" \
    --arg cur_asg "$cur_asg" --arg cur_status "$cur_status" \
    --argjson need_assign "$need_assign" --argjson need_status "$need_status" \
    '{key:$key,verdict:$verdict,id:$id,apfx:$apfx,want_asg:$want_asg,want_status:$want_status,cur_asg:$cur_asg,cur_status:$cur_status,need_assign:$need_assign,need_status:$need_status}' \
    >> "$PLAN"
done < <(jq -r '.dispositions[] | select(.done != true) | @base64' "$TABLE")

if [ "$examined" = 0 ]; then
  echo "ERROR: no issue was examined - the table contains no active dispositions" >&2
  exit 5
fi
if [ "$failed" -gt 0 ]; then
  echo
  echo "applied=0 skipped=0 pending=0 failed=$failed writes=0"
  exit 1
fi

# Pass 2 executes only the fully validated plan.
while IFS= read -r plan_row; do
  key=$(printf '%s' "$plan_row" | jq -r '.key')
  verdict=$(printf '%s' "$plan_row" | jq -r '.verdict')
  id=$(printf '%s' "$plan_row" | jq -r '.id')
  apfx=$(printf '%s' "$plan_row" | jq -r '.apfx')
  want_asg=$(printf '%s' "$plan_row" | jq -r '.want_asg')
  want_status=$(printf '%s' "$plan_row" | jq -r '.want_status')
  cur_asg=$(printf '%s' "$plan_row" | jq -r '.cur_asg')
  cur_status=$(printf '%s' "$plan_row" | jq -r '.cur_status')
  need_assign=$(printf '%s' "$plan_row" | jq -r '.need_assign')
  need_status=$(printf '%s' "$plan_row" | jq -r '.need_status')

  if [ "$need_assign" = 0 ] && [ "$need_status" = 0 ]; then
    skipped=$((skipped+1)); echo "OK       $key  ($verdict, $cur_status, ${cur_asg:0:8})"; continue
  fi

  pending=$((pending+1))
  if [ "$MODE" = "--status" ]; then
    echo "PENDING  $key  $verdict  status:$cur_status->$want_status  assignee:${cur_asg:0:8}->$apfx"
    continue
  fi

  if [ $((writes + need_assign + need_status)) -gt "$MAX_WRITES" ]; then
    echo "STOP     write budget reached ($writes/$MAX_WRITES); $key and the rest remain pending"
    break
  fi

  if [ "$need_assign" = 1 ]; then
    out=$(curl -s --config "$CURL_CONFIG" -X PATCH "${JSON[@]}" "${RUNHDR[@]}" \
      -d "{\"assigneeAgentId\":\"$want_asg\"}" "$BASE/api/issues/$id" -w '\n%{http_code}')
    writes=$((writes+1))
    hc="${out##*$'\n'}"
    if [ "$hc" != "200" ]; then
      failed=$((failed+1)); echo "FAIL     $key assign HTTP $hc: $(printf '%s' "${out%$'\n'*}" | head -c 200)"; continue
    fi
  fi

  if [ "$need_status" = 1 ]; then
    out=$(curl -s --config "$CURL_CONFIG" -X PATCH "${JSON[@]}" "${RUNHDR[@]}" \
      -d "{\"status\":\"$want_status\"}" "$BASE/api/issues/$id" -w '\n%{http_code}')
    writes=$((writes+1))
    hc="${out##*$'\n'}"
    if [ "$hc" != "200" ]; then
      failed=$((failed+1)); echo "FAIL     $key status HTTP $hc: $(printf '%s' "${out%$'\n'*}" | head -c 200)"; continue
    fi
  fi

  applied=$((applied+1)); echo "APPLIED  $key  $verdict  -> $want_status / $apfx"
done < "$PLAN"

echo
echo "applied=$applied skipped=$skipped pending=$pending failed=$failed writes=$writes"
[ "$failed" -gt 0 ] && exit 1
exit 0
