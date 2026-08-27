#!/usr/bin/env bash
# Named policy mutants for the two Postgres-backed suites. CI supplies the
# Postgres environment used by reset.sh. Every mutant gets an unmutated baseline
# in the exact same staged directory before the source is changed.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="$HERE/test/fixtures/orgdb/reset.sh"
: "${PGHOST:?CI Postgres environment required}"

stage() {
  local d="$1"
  cp "$HERE"/{org_provisioner.sh,org_request_queue.sh,test_privilege_ceilings.sh,test_request_queue.sh} "$d/"
  mkdir -p "$d/lib" "$d/test/fixtures/orgdb"
  cp "$HERE/lib/"{pcsql.sh,provisioning_policy.sh,reqrecord.sh} "$d/lib/"
  cp "$HERE/test/fixtures/orgdb/"* "$d/test/fixtures/orgdb/"
  chmod +x "$d"/*.sh "$d/test/fixtures/orgdb/"*
}
run_suite() { # dir suite
  local d="$1" suite="$2"
  "$FIXTURE" >/dev/null
  rm -f "$d/grants.jsonl" "$d/queue.jsonl" "$d/disabled"
  (cd "$d" && COMPANY_ID=00000000-0000-4000-8000-000000000480 \
    PAPERCLIP_SQL_BACKEND=psql PAPERCLIP_API_URL=http://stub.invalid \
    PAPERCLIP_CLI="$d/test/fixtures/orgdb/paperclipai" \
    PAPERCLIP_STUB_LOG="$d/calls.jsonl" GRANT_LOG="$d/grants.jsonl" \
    QUEUE="$d/queue.jsonl" DISABLED_TEMPLATES="$d/disabled" "./$suite")
}
mutant() { # label suite target anchor replacement named-failure
  local label="$1" suite="$2" target="$3" anchor="$4" repl="$5" want="$6"
  local d baseline; d="$(mktemp -d)"; stage "$d"
  baseline="$(mktemp)"
  if ! run_suite "$d" "$suite" >"$baseline" 2>&1; then
    echo "BASELINE FAILED for $label" >&2; cat "$baseline"; rm -f "$baseline"; rm -rf "$d"; return 2
  fi
  rm -f "$baseline"
  node - "$d/$target" "$anchor" "$repl" <<'NODE'
const fs=require('fs'), [p,a,r]=process.argv.slice(2); let s=fs.readFileSync(p,'utf8');
if(!s.includes(a)){console.error('mutation anchor missing');process.exit(2)}
fs.writeFileSync(p,s.replace(a,r));
NODE
  bash -n "$d/$target" || { echo "$label: mutant does not parse" >&2; rm -rf "$d"; return 2; }
  if run_suite "$d" "$suite" >"$d/out" 2>&1; then
    echo "$label: mutant left $suite green" >&2; rm -rf "$d"; return 1
  fi
  if ! grep -F 'FAIL' "$d/out" | grep -qF "$want"; then
    echo "$label: red, but not on named assertion '$want'" >&2; cat "$d/out"; rm -rf "$d"; return 1
  fi
  echo "ok: $label -> $want"; rm -rf "$d"
}

rc=0
mutant ceiling-bypass test_privilege_ceilings.sh lib/provisioning_policy.sh \
  'if ! jq -e --arg c "$caller_template" --arg r "$template"' \
  'if false && ! jq -e --arg c "$caller_template" --arg r "$template"' \
  'T0 (tech chief) cannot create another President/COO' || rc=1
mutant caller-placement test_privilege_ceilings.sh org_provisioner.sh \
  'die "reportsTo cannot be supplied by the caller; the service sets it to the caller' \
  'die "mutant accepts caller-controlled placement instead of refusing: ' \
  'caller cannot supply its own reportsTo' || rc=1
mutant dormant-payload test_privilege_ceilings.sh org_provisioner.sh \
  'runtimeConfig:{heartbeat:{enabled:false, wakeOnDemand:false}}' \
  'runtimeConfig:{heartbeat:{enabled:true, wakeOnDemand:true}}' \
  'DIRECTOR not dormant' || rc=1
mutant protected-payload test_privilege_ceilings.sh org_provisioner.sh \
  '"authorizationPolicy":{"assignmentPolicy":{"mode":"protected"}}}' \
  '"authorizationPolicy":{"assignmentPolicy":{"mode":"open"}}}' \
  'DIRECTOR not protected' || rc=1
mutant self-scope test_privilege_ceilings.sh org_provisioner.sh \
  'scope: (if .self then {subtreeRootAgentId:$id} else null end)' \
  'scope: (if .self then {subtreeRootAgentId:"00000000-0000-4000-8000-000000000006"} else null end)' \
  'DIRECTOR has a scope pointing somewhere else' || rc=1
mutant descendant-deactivate test_privilege_ceilings.sh org_provisioner.sh \
  'is_descendant_of "$caller_id" "$target_id" \' \
  'true \' \
  'Manager cannot deactivate its own Director' || rc=1
mutant request-ceiling test_request_queue.sh org_request_queue.sh \
  'may_request "$tpl" "$template"' \
  'true "$tpl" "$template"' \
  'T0 cannot request a President/COO' || rc=1
mutant self-approval test_request_queue.sh org_request_queue.sh \
  '[[ "$rv_id" != "$rq_id_at_submit" ]]' \
  '[[ true ]]' \
  'O1 cannot approve its OWN request' || rc=1
mutant template-disable test_request_queue.sh org_request_queue.sh \
  'template_disabled "$template" \' \
  'false \' \
  'pending director request is now refused at approval time' || rc=1
mutant stale-authority test_request_queue.sh org_request_queue.sh \
  '[[ "$now_status" != "terminated" ]] \' \
  '[[ true ]] \' \
  'the pending request is refused — stale requester' || rc=1
exit "$rc"
