# GARM orphan/stale VM reaper — TTL + propose-only policy

Ephemeral GARM
registration/cleanup with size caps). Source-only: the audit tool is
`audit_stale_instances.sh` in this directory; the monitoring push wrapper
stays with the private host configuration; the offline suite is
`test_garm_reaper_audit.sh` at the repo root.

**Standing rule: no agent deletes a host VM, ever.** The audit lists and
proposes. Deletion is a human-operator act inside a CEO-approved window
(see §4). An agent run that executes a delete, stop, or destroy against a
GARM/LXD surface violates this policy even when the target looks orphaned.

## 1. TTL table (defaults; per-pool overrides via env)

| Knob | Env | Default | Meaning |
|---|---|---|---|
| Instance TTL | `GARM_INSTANCE_TTL_MIN` | 240m | A `busy`, `idle-excess`, or `stale` instance older than this is a reaping **candidate** (proposal, no page) |
| Orphan multiplier | `GARM_ORPHAN_MULT` | 2 | Past `TTL × mult` (default 480m) a candidate becomes an **orphan**: Gatus breach, operator eyes required |
| Provision stuck | `GARM_PROV_STUCK_MIN` | 30m | `pending_create`/`creating`/`installing` older than this is **stuck**: breach |
| Drain stuck | `GARM_DRAIN_STUCK_MIN` | 60m | `pending_delete`/`deleting` or `error`/`failed` older than this is **stuck**: breach |
| Unknown age | — | always | `created_at` absent or unparseable is a **breach**, never a pass |

Warm-spare exemption: the newest `min_idle_runners` idle instances in each
pool are never candidates, whatever their age. Only the `idle − min_idle`
oldest idle instances (the excess) age into candidacy. Rationale: the warm
pool is a capacity commitment, not a leak; reaping it would destroy the
commitment `push-garm-pool.sh` monitors. A **disabled** pool keeps no warm
reservation in spirit, but the audit applies the same rule uniformly — its
instances age into candidates on the same clock, and disablement is noted,
not treated as a breach by itself.

Size caps: live `max_runners` is enforced as an audit breach (`actual >
max` fails). Queued depth never raises a cap — no count-to-VM mapping, no
cap increase from queue length.

## 2. Intervals

- Audit cron (operator-installed): every 15 minutes,
  `GARM_POOLS="<uuid> ..." <private host wrapper path>`
- Gatus `platform_garm-reaper` heartbeat: 30 minutes. A missed heartbeat is
  UNKNOWN, never healthy.
- Policy review: TTL values are revisited when pool roles change (new image
  role, new min_idle, new provider) — a TTL edit is a reviewed PR to this
  file plus the audit defaults, not an env-file tweak on the host.

## 3. What the Gatus check means

- `success=true`, verdict `OK`: nothing actionable.
- `success=true`, verdict `PROPOSE`: candidates exist past TTL but nothing
  meets a breach rule. The proposal rides the cron log; no page.
- `success=false`: orphan, stuck provisioning/drain, unknown-age instance,
  over-max pool, or an unreadable pool response. The error text names
  `pool/instance bucket age` triples (truncated to 500 chars by the shared
  push helper). Transport/parse failure also pushes `false`: an audit that
  cannot read is a finding, not a clean bill. Missing env/CLI refuses with
  exit 2 and zero pushes — then the heartbeat miss pages instead.

## 4. Propose-only delete flow (the only authorized path to a delete)

1. **Audit proposes.** The cron log (or a manual `--pool-json` run) carries
   the candidate list: pool, instance name, bucket, age, status pair.
2. **Operator card to the CEO.** An agent files one `Operator:` card
   assigned to the **CEO** (never the owner), containing exactly: pool UUID,
   instance name(s), bucket + age, the audit verdict line, and the
   job-correlation evidence (which GitHub job the instance served, or that
   none maps to it). No delete happens on card creation.
3. **CEO approves a window.** Approval names the instances and the window.
   Silence/expiry is never approval.
4. **Operator deletes, by hand, in the window.** The operator types the
   reviewed instance-delete command on the host. Agent-supplied command
   strings are evidence, not runbooks: the operator verifies syntax against
   installed `--help`/docs first.
5. **Two-sided verification.** The operator confirms absence on BOTH sides
   with timestamps: the VM is gone from the provider AND the runner
   registration is gone from GARM/GitHub. Registration absence alone is NOT
   VM-destruction evidence (lifecycle contract, `README.md` §"Lifecycle").
   External runner-log retention references are recorded.
6. **Cooldown.** Deleted names stay out of new proposals for one full TTL
   window; a re-firing proposal for the same name is a stuck-cleanup signal,
   not a duplicate delete.

What this flow never contains: agent-executed deletes, automatic deletes on
a breach, cap changes, job kills to free capacity, or wiping a VM whose job
is still running. A timeout is a HOLD, never permission to kill.

## 5. Operator-card template (paste into the CEO card)

```text
Operator: GARM reaper delete request (this policy, section 4)
Pool: <full pool UUID> (short <8 chars>)
Instances: <name> <bucket> <age>m, <name> <bucket> <age>m
Evidence: <audit verdict line + log ref>; job correlation: <run/job URL or "no live job maps">
Scope: delete ONLY the named instances; no cap change, no job kill
Rollback: provider keeps the instance list export taken before the window; re-creation is normal GARM provisioning, not a restore
```

## 6. Limits of the audit (what it does not prove)

- Instance ages come from GARM-reported `created_at`; a lying or skewed
  clock ages wrong, never deletes wrong — the worst case is a wrong proposal.
- `runner_status` strings vary by GARM version; `busy` is defined by
  exclusion (`running` and neither `idle` nor `failed`), same as
  `push-garm-pool.sh`. An unrecognized future state lands in `stale` and
  ages on the TTL clock rather than passing silently.
- The audit never inspects job liveness itself; a long legitimate job past
  TTL is a candidate the operator clears by correlating the job, not a
  false positive in the tool.
