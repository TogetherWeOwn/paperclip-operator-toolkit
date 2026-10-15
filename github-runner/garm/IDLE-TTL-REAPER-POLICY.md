# GARM idle-VM reaper TTL policy (source-only spec)

This note defines the
idle-age thresholds per pool, the reap ordering, the canary/static
protections, and the dry-run report format. Propose-only: no provider
calls and no VM deletion ship in this slice.

Enforced structurally by `idle-ttl-contracts.json` (machine-readable stub
of the proposed constants) and `validate_idle_ttl.py` (offline checker),
covered by `../test_isolated_idle_ttl.py`, which CI discovers with the
existing `test_isolated_*.py` pattern. No CI workflow change was needed.

Implementation: `audit_stale_instances.sh` in this directory performs the
read-only audit; `TTL-REAPER-POLICY.md` §4 owns the only authorized path
from a proposal to a delete (Operator card to the CEO, human operator,
two-sided verification). This spec sets the thresholds and ordering that
audit output is read against; it does not add a delete path.

## 1. Max idle age per pool

Defaults inherit the audit tool (`GARM_INSTANCE_TTL_MIN=240`,
`GARM_ORPHAN_MULT=2`, `GARM_PROV_STUCK_MIN=30`,
`GARM_DRAIN_STUCK_MIN=60`). Per-pool behavior:

| Pool class | Roles / labels | TTL | Orphan | Mode |
|---|---|---|---|---|
| Ephemeral default | `isolated-private`, `privileged-private` | 240m | 480m | propose |
| Canary | `canary` | 240m | 480m | observe-only (§3) |
| Static | `two-selfhosted`, `two-isolated` | none | none | out-of-scope (§3) |

Rationale: 240m covers the longest eligible job (`suites`
`timeout-minutes: 210` in this repo's `ci.yml`) with 30m margin; the drain
grace floor is 210m (`drain-contracts.json`) and bounds drain, not TTL.
480m (2x TTL) is the
orphan line: past it a candidate needs operator eyes as a breach, never
silent reaping. Prov-stuck 30m sits above the 20m upstream bootstrap
timeout so slow starts are not misread as stuck; drain-stuck 60m sits
inside the 210m grace so a stuck drain surfaces while the operator window
is still open.

Warm-spare exemption (unchanged from `TTL-REAPER-POLICY.md`): the newest
`min_idle_runners` idle instances per pool are never candidates, whatever
their age. Size caps: `actual > max_runners` is an audit breach; queued
depth never raises a cap.

## 2. Reap ordering (oldest-idle first)

A dry-run report lists reaping candidates in this proposal order:

1. `idle-excess` — running+idle beyond `min_idle`, oldest first.
2. `stale` — stopped/unknown states past TTL, oldest first.
3. `busy` — running with a live-looking runner past TTL, oldest first;
   the operator correlates the live GitHub job before any action.

Within each bucket, ordering is oldest-first by `created_at`. Breach items
(orphan, stuck provisioning/drain, unknown-age, over-max) head the
report as action-required, but that position is triage priority, never a
delete order: every delete still goes through the `TTL-REAPER-POLICY.md`
§4 Operator-card flow. Static instances are never ordered because
they are out of scope (§3). Canary instances are never ordered because
operators exclude canary pool UUIDs from `GARM_POOLS` (§3) — the audit
itself has no pool-role filter, so exclusion is an operator duty the
contract's `never_candidate` pins for a future enforcing revision.

## 3. Canary and static protection

- **Canary pools are observe-only.** Operators exclude canary pool UUIDs
  from `GARM_POOLS`, so canary instances never enter a report as reaping
  candidates: the canary pool is the measurement instrument for
  first-pickup (`docs/garm-first-pickup-canary.md`), and reaping it
  destroys the baseline the migration gates read. This exclusion is
  policy-level — the current audit has no pool-role filter and treats any
  UUID passed via `GARM_POOLS` as a normal pool; the contract's
  `never_candidate` pins the intended enforcement for a future audit
  revision. If a canary pool is ever audited deliberately, stuck
  provisioning or unknown-age there still breaches (the operator needs
  eyes on a broken instrument), but the proposal carries no canary
  delete.
- **Static runners are out of scope.** Host-bound `two-selfhosted` /
  `two-isolated` runners are not GARM pools; the audit reads only GARM
  `pool show`, so static names never enter the report. No reaper output
  may name a static runner as a candidate, and no Operator card written
  from this policy may scope a static host.

## 4. Dry-run report format

A dry run is the audit against fixture `--pool-json` files or live
`pool show` reads. The tool has no `--apply`, no `--delete`, and no host
command by construction (pinned by `test_garm_reaper_audit.sh` §2), so
every run is a dry run. JSON (`--json`) carries exactly:

- top level: `tool`, `now`, `ttlMin`, `orphanMin`, `verdict`
  (`OK` | `PROPOSE` | `BREACH`), `candidates`, `pools`, `errors`,
  `breachReasons`.
- each candidate: `pool` (8-char short id), `name`, `status`,
  `runnerStatus`, `ageMin`, `bucket`, `createdAt`.
- human output opens with `audit_stale_instances — <now> — TTL …`
  (propose-only banner), one row per instance, a `verdict=…` line, and
  the `PROPOSAL (hand to an Operator card to the CEO …)` block.

## 5. Verification

```sh
python3 -B github-runner/garm/validate_idle_ttl.py github-runner/garm/idle-ttl-contracts.json
python3 -B -m unittest discover -s github-runner -p 'test_isolated_idle_ttl.py' -v
# Existing private offline CI uses this broader discovery command, unchanged:
python3 -B -m unittest discover -s github-runner -p 'test_isolated_*.py'
```

The suite pins the TTL table, the canary/static protections, the exact
reap order, the exact report shape, the stuck thresholds, the timeout
disposition, and one rejection per gate (plus load-bearing mutants
proving the canary and order gates measure). A passing file still
returns `admission_authorized:false`, `host_verified:false`,
`installed:false`: validation is structural agreement with this
proposal, never authorization to reap, delete, or execute.

Follow-up execution lives on a separate operator card:
pool UUIDs, instance names, job correlation, CEO-approved window, and
two-sided verification per `TTL-REAPER-POLICY.md` §4–§5.

Source-only rollback: before merge revise the same landing branch/PR;
after merge revert the exact source-only squash commit through normal
review/CI. Nothing is installed, so there is no host runtime state to
revert.
