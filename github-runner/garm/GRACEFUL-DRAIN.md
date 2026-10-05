# GARM ephemeral VM graceful job-drain and shutdown-timeout spec

Source-only slice of the GARM-only owned CI fleet work. This note specifies
graceful job-drain on scale-down: the drain signal, the grace period/timeout,
what happens to a running job at timeout, and how the reaper distinguishes
drained vs orphaned VMs. Propose-only; no live LXD/GARM mutation.

Enforced structurally by `drain-contracts.json` (machine-readable stub of the
proposed constants) and `validate_drain.py` (offline checker), covered by
`../test_isolated_garm_drain.py`, which CI discovers with the existing
`test_isolated_*.py` pattern. No CI workflow change was needed.

## 0. Vocabulary (upstream, not invented here)

Instance statuses are `garm-provider-common` `InstanceStatus` values
(`running`, `stopped`, `error`, `pending_delete`, `pending_force_delete`,
`deleting`, `deleted`, `pending_create`, `creating`, `unknown`).
Legal transitions are the `InstanceStatusTransitions` map in GARM `v0.2.1`
`params/params.go` — the same pinned baseline as the rehearsal contracts
(`role-contracts.json`: GARM `0.2.1`, provider `0.1.3`, LXD `5.21`):

- graceful path: `running -> pending_delete -> deleting -> deleted`.
- force path: `running -> pending_force_delete`, `pending_delete ->
  pending_force_delete`, `pending_force_delete -> deleting`, plus `error ->
  deleting` (failed-provision cleanup, the existing `garm-cli runner delete
  --force-remove-runner` shape).
- `deleting` may only land on `deleted` or `error`; `deleted` is terminal.

The validator pins exactly these two edge sets and rejects anything else, so
a future edit that "adds a shortcut" (e.g. `running -> deleting`, `running
-> deleted`, `deleting -> pending_delete`) fails closed.

Upstream pool semantics this spec rests on (`doc/pools-and-scaling.md`):
pools must be empty before deletion (disable, then wait-for-runners or delete
runners, then delete); only idle runners can be deleted — a runner executing
a job waits or its GitHub job is cancelled; `--min-idle-runners=0` is
on-demand; `--runner-bootstrap-timeout` defaults to 20 minutes (startup
bound only, never the drain grace).

## 1. Drain signal

Scale-down starts with exactly one reviewed operator action, recorded with
an action ref, after which the pool admits no new work:

- allowed: `pool_disabled`, `max_runners_lowered`, `min_idle_lowered`.
- forbidden as a drain signal: `job_cancel`, `label_change_as_drain`,
  `queue_depth_auto`, `vm_delete_without_signal`.
- required alongside the signal: `reviewed_operator_action`,
  `recorded_action_ref`, `no_new_admissions_after_signal`.

Rationale: disabling or lowering the caps is the idle-safe lever the
static-fleet migration already uses (stop new assignments, let active work
finish). Cancelling a job, re-labelling, or deleting a VM without a recorded
signal aborts or orphans work and is never a drain.

## 2. Grace period and timeout

- `drain_grace_min: 150` — proposed floor, covering the longest eligible job:
  `Offline suites` carries `timeout-minutes: 150` in this repo's `ci.yml`.
  The floor moves if the longest eligible timeout moves.
- `poll_interval_min: 5` — matches the existing pool monitor's 5-minute
  cadence.
- `runner_bootstrap_timeout_min: 20` — upstream pool default; bounds startup,
  never the drain. Naming it here stops the "20-minute" value from being
  misread as a drain grace later.

## 3. What happens to a running job at timeout

Nothing automatic. At grace expiry a still-running job continues to natural
completion; new admissions have already been stopped at the signal, so the
fleet only shrinks, never grows, past the deadline. `force_delete` at or
after timeout is a separate reviewed operator action with its own action
ref — never an automatic escalation, never inferred from queue depth. This
is the same "a timeout is a HOLD, never permission to stop/kill jobs"
rule the operator runbook in `README.md` already states.

## 4. How the reaper distinguishes drained vs orphaned VMs

A VM counts as **drained** only when all of these hold:

1. the drain signal (with action ref) was recorded before its first
   `pending_delete`;
2. every observed transition is on the graceful path (§0);
3. its job completed naturally before deleting (never cancelled for the drain);
4. artifacts are complete (job/artifact completion, not registration absence);
5. `vm_absent` and `registration_absent` are observed together and correlated
   to the same run/runner/VM — registration absence alone is not VM
   reclamation (operator runbook in `README.md`, steps 4-5).

A VM counts as **orphaned** when any of these hold:

- provider `error` or runner `failed`;
- a `stopped` or `unknown` terminal state;
- `pending_force_delete` (or any force edge) inside the grace window, or any
  force edge without a second reviewed action ref;
- `deleting`/`deleted` while its GitHub job is still `in_progress`;
- `vm_absent` XOR `registration_absent` (half-cleanup).

Monitor interaction, recorded not changed: while a drain is in flight the
pool monitor reads draining VMs as `stale`/`del_pending` (its existing
buckets already do). An eligible-demand breach during a recorded drain window
is the expected consequence of stopped admissions, not a new page; the window
record is the action ref above. No monitor change ships in this slice.

## 5. Verification

```sh
python3 -B github-runner/garm/validate_drain.py github-runner/garm/drain-contracts.json
python3 -B -m unittest discover -s github-runner -p 'test_isolated_garm_drain.py' -v
# Offline CI uses this broader discovery command, unchanged:
python3 -B -m unittest discover -s github-runner -p 'test_isolated_*.py'
```

The suite pins the grace floor, the poll/bootstrap values, the exact signal
sets, the exact graceful/force edge sets against the upstream legal map, the
exact reaper rule lists, and one rejection per gate (lowered grace, zero
poll, bootstrap-mistaken-for-grace, missing action ref, force-inside-grace,
illegal transition, half-cleanup). A passing file still returns
`admission_authorized:false`, `host_verified:false`, `installed:false`:
validation is structural agreement with this proposal, never authorization
to scale, drain, or delete.

Source-only rollback: before merge revise the same landing branch/PR; after
merge revert the exact source-only squash commit through normal review/CI.
Nothing is installed, so there is no host runtime state to revert.
