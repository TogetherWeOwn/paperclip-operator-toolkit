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
  cp "$HERE/lib/"{pcsql.sh,provisioning_policy.sh,reqrecord.sh,durable_queue.py,notify_exec.py} "$d/lib/"
  cp "$HERE/test/fixtures/orgdb/"* "$d/test/fixtures/orgdb/"
  chmod +x "$d"/*.sh "$d/test/fixtures/orgdb/"*
}
run_suite() { # dir suite
  local d="$1" suite="$2"
  "$FIXTURE" >/dev/null || return $?
  rm -f "$d/grants.jsonl" "$d/queue.jsonl" "$d/disabled" || return $?
  (cd "$d" && COMPANY_ID=00000000-0000-4000-8000-000000000480 \
    PAPERCLIP_SQL_BACKEND=psql PAPERCLIP_API_URL=http://stub.invalid \
    PAPERCLIP_CLI="$d/test/fixtures/orgdb/paperclipai" \
    PAPERCLIP_STUB_LOG="$d/calls.jsonl" GRANT_LOG="$d/grants.jsonl" \
    QUEUE="$d/queue.jsonl" DISABLED_TEMPLATES="$d/disabled" "./$suite")
}
mutant() { # label suite target anchor replacement named-failure [stage-hook] [mutant-hook]
  local label="$1" suite="$2" target="$3" anchor="$4" repl="$5" want="$6"
  local stage_hook="${7:-true}" mutant_hook="${8:-true}"
  local d baseline mutation_rc; d="$(mktemp -d)"; stage "$d"
  "$stage_hook" "$d" || { echo "$label: stage hook failed" >&2; rm -rf "$d"; return 2; }
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
  mutation_rc=$?
  if [[ $mutation_rc -ne 0 ]]; then rm -rf "$d"; return "$mutation_rc"; fi
  "$mutant_hook" "$d" || { echo "$label: mutant hook failed" >&2; rm -rf "$d"; return 2; }
  bash -n "$d/$target" || { echo "$label: mutant does not parse" >&2; rm -rf "$d"; return 2; }
  if run_suite "$d" "$suite" >"$d/out" 2>&1; then
    echo "$label: mutant left $suite green" >&2; rm -rf "$d"; return 1
  fi
  if ! grep -F 'FAIL' "$d/out" | grep -qF "$want"; then
    echo "$label: red, but not on named assertion '$want'" >&2; cat "$d/out"; rm -rf "$d"; return 1
  fi
  echo "ok: $label -> $want"; rm -rf "$d"
}

mutate_caller_placement() { # staged mutant dir
  local d="$1"
  node - "$d/org_provisioner.sh" <<'NODE'
const fs=require('fs'), p=process.argv[2]; let s=fs.readFileSync(p,'utf8');
for (const [a,r] of [
  ['local caller_ref="" template="" title="" capabilities=""', 'local caller_ref="" caller_parent="" template="" title="" capabilities=""'],
  ['--arg name "$title" --arg title "$title" --arg parent "$caller_id"', '--arg name "$title" --arg title "$title" --arg parent "${caller_parent:-$caller_id}"']
]) {
  if (!s.includes(a)) { console.error(`caller-placement hook anchor missing: ${a}`); process.exit(2) }
  s=s.replace(a,r)
}
fs.writeFileSync(p,s)
NODE
  [[ $? -eq 0 ]] || return $?
  node - "$d/test_privilege_ceilings.sh" <<'NODE'
const fs=require('fs'), p=process.argv[2]; let s=fs.readFileSync(p,'utf8');
const a='create --caller T0 --template C1_DIRECTOR_BUILDER --title "TEST Director AI Engineering"';
const r='create --caller T0 --template C1_DIRECTOR_BUILDER --title "TEST Director AI Engineering" --reports-to 00000000-0000-4000-8000-000000000003';
if (!s.includes(a)) { console.error('caller-placement invocation anchor missing'); process.exit(2) }
fs.writeFileSync(p,s.replace(a,r))
NODE
}

# Seeds a company-wide grant that the provisioner never asks for, standing in
# for a server-applied default. apply_exact_grants must DELETE it; the mutant
# disables that DELETE, so the row survives and test_request_queue.sh's
# company-wide-scope check is what catches it.
#
# THE PROBE KEY MUST BE ONE THE PROVISIONER DOES NOT INSERT. It used
# to be `tasks:assign`, which worked only while the provisioner left that key
# alone. Now that the assignment baseline unions `tasks:assign` in,
# principal_permission_grants_unique_idx -- (company_id, principal_type,
# principal_id, permission_key), which does NOT include scope -- makes the
# surviving seed row collide with the provisioner's own INSERT. That aborts the
# whole apply_exact_grants transaction, so the agent ends up with the seeded row
# and NOTHING else: the mutant still goes red, but on the template key-set
# assertion instead of the scope assertion this mutant exists to pin, and the
# gate fails with "red, but not on named assertion".
# `tools:use` is in no template this suite provisions (only E2_TOOLING_ADMIN
# carries it, which the suite never requests), so it survives the mutant
# without colliding and the named assertion fires again.
seed_server_default_grant() { # stage-dir
  local d="$1"
  mv "$d/test/fixtures/orgdb/paperclipai" "$d/test/fixtures/orgdb/paperclipai.real"
  cat > "$d/test/fixtures/orgdb/paperclipai" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$("$HERE/paperclipai.real" "$@")"; rc=$?
printf '%s\n' "$out"
[[ $rc -eq 0 ]] || exit "$rc"
if [[ "${1:-}" == agent && "${2:-}" == create ]]; then
  company=""
  for ((i=1; i<=$#; i++)); do
    if [[ "${!i}" == --company-id ]]; then j=$((i+1)); company="${!j}"; break; fi
  done
  id="$(jq -er .id <<<"$out")" || exit 2
  psql -Atq -v ON_ERROR_STOP=1 -v company="$company" -v agent="$id" <<'SQL' >/dev/null
INSERT INTO principal_permission_grants
  (company_id, principal_type, principal_id, permission_key, scope)
VALUES (:'company'::uuid, 'agent', :'agent', 'tools:use', NULL)
ON CONFLICT DO NOTHING;
SQL
fi
STUB
  chmod +x "$d/test/fixtures/orgdb/paperclipai"
}

rc=0
mutant ceiling-bypass test_privilege_ceilings.sh lib/provisioning_policy.sh \
  'if ! jq -e --arg c "$caller_template" --arg r "$template"' \
  'if false && ! jq -e --arg c "$caller_template" --arg r "$template"' \
  'T0 (tech chief) cannot create another President/COO' || rc=1
mutant caller-placement test_privilege_ceilings.sh org_provisioner.sh \
  $'--reports-to|--parent)\n        # Invariant 3: placement is the service\'s decision, never the caller\'s.\n        die "reportsTo cannot be supplied by the caller; the service sets it to the caller\'s own subtree.";;' \
  $'--reports-to|--parent)\n        caller_parent="$2"; shift 2;;' \
  'DIRECTOR create payload accepted caller-controlled placement' true mutate_caller_placement || rc=1
mutant dormant-payload test_privilege_ceilings.sh org_provisioner.sh \
  'runtimeConfig:({heartbeat:{enabled:false, wakeOnDemand:false}}' \
  'runtimeConfig:({heartbeat:{enabled:true, wakeOnDemand:true}}' \
  'DIRECTOR not dormant' || rc=1
# The baseline these two pin is company_default + tasks:assign, not the
# old born-protected posture. Mutating the mode back to "protected" is exactly
# the regression that once 403'd three board cases, so it is the right mutant to require.
mutant baseline-mode-create-payload test_privilege_ceilings.sh org_provisioner.sh \
  'authorizationPolicy:{assignmentPolicy:{mode:$mode}}' \
  'authorizationPolicy:{assignmentPolicy:{mode:"protected"}}' \
  'DIRECTOR agent.create payload was not born on the assignment baseline' || rc=1
mutant baseline-assign-create-payload test_privilege_ceilings.sh org_provisioner.sh \
  'canAssignTasks:$can_assign,' \
  'canAssignTasks:false,' \
  'DIRECTOR agent.create payload was not born on the assignment baseline' || rc=1
# The ACTOR-side half, and the one a mode-only check cannot see: strip the
# baseline key from the applied grant set and the agent still looks correctly
# unprotected while being unable to hand any card back up its own chain.
mutant baseline-assign-grant test_privilege_ceilings.sh org_provisioner.sh \
  '+ (if $want_assign then [{permissionKey:"tasks:assign", scope:null}] else [] end)' \
  '+ []' \
  'DIRECTOR is missing the company-wide tasks:assign grant' || rc=1
mutant exact-grant-replacement test_request_queue.sh org_provisioner.sh \
  $'DELETE FROM principal_permission_grants\nWHERE company_id = :\'company_id\'::uuid\n  AND principal_type = \'agent\'\n  AND principal_id = :\'agent_id\';' \
  $'DELETE FROM principal_permission_grants\nWHERE false;' \
  'company-wide organizational grant survived' seed_server_default_grant || rc=1
mutant self-scope-foreign test_privilege_ceilings.sh org_provisioner.sh \
  'scope: (if .self then {subtreeRootAgentId:$id} else null end)' \
  'scope: (if .self then {subtreeRootAgentId:"00000000-0000-4000-8000-000000000006"} else null end)' \
  'DIRECTOR SELF scope mismatch' || rc=1
mutant self-scope-null test_request_queue.sh org_provisioner.sh \
  'scope: (if .self then {subtreeRootAgentId:$id} else null end)' \
  'scope: null' \
  'director has 3 SELF permission(s) with NULL or foreign scope' || rc=1
mutant descendant-deactivate test_privilege_ceilings.sh org_provisioner.sh \
  'is_descendant_of "$caller_id" "$target_id" \' \
  'true \' \
  'Manager cannot deactivate its own Director' || rc=1
mutant kill-switch test_privilege_ceilings.sh org_provisioner.sh \
  $'cmd_create() {\n  assert_enabled' \
  $'cmd_create() {\n  true' \
  'all provisioning refused while kill switch engaged' || rc=1
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
