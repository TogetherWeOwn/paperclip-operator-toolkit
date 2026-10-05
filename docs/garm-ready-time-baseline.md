# GARM runner startup ready-time baseline

## What this baselines

Runner startup latency only: time from GARM VM create to runner ready,
per instance, derived from operator-supplied `(created_at, ready_at)`
timestamp pairs.

Explicitly out of scope (separate instruments, separate cards):

- Provider operation latency (create/delete API time):.
- Pool health and capacity:.
- Reaper TTL and destroy pile-up handling:.
- Queue wait, job duration, runner registration lag as isolated metrics.

A breach of these thresholds means "VMs are slow to become ready", never
"the pool is empty". Do not page pool capacity off this instrument.

## Baseline table

The checked-in `garm_ready_time_baseline.json` is a provisional seed
(`provisional: true`, zero samples). No direct VM create-to-ready timing
exists in the repo yet: the GARM fleet has not migrated, so there is
nothing to measure directly. The numbers below are seeds set deliberately
above the physical floor, backed by the indirect evidence in the second
table. Recalibrate after the first 30 live startup samples.

| Metric | Seed | Status |
| ------ | ---- | ------ |
| startup p50 alert | 10 min (600000 ms) | seed, recalibrate after 30 live samples |
| startup p95 alert | 20 min (1200000 ms) | seed, recalibrate after 30 live samples |
| per-VM ready timeout (proposed) | **10 min (600000 ms)** | proposal, same recalibration gate |

Rationale: startup spans LXD create, image boot, cloud-init and runner
registration, so minutes-scale even healthy. A median past 10 minutes
means the typical path — not the tail — is sick. A 5% tail past 20
minutes spends a full CI budget on provisioning alone.

### Indirect evidence behind the seeds

| Source | Timing | What it bounds |
| ------ | ------ | -------------- |
| GARM canary run 2 (PR #483, 2026-10-02) | queue waits 111s / 117s / 163s across three jobs on three fresh VMs | healthy path is low-minutes; 10 min p50 is ~5x that median |
| `garm-canary.yml` per-job ceiling | 15 min `timeout-minutes` on probe/service-db/fresh-vm | a 10 min ready deadline leaves headroom inside the job budget |
| Reaper provisioning-stuck bound | 30 min for `pending_create`/`creating`/`installing` | 10 min alert fires well before the stuck rule; 20 min p95 stays below it |
| Provider-create seed | p50 10 min / p95 20 min for create | startup contains the provider create path; seeds mirror it |
| Wave-0 min-idle 0→1→0 | one VM created and reclaimed, no timing recorded | proves the path exists, contributes no number |

No other timestamped startup evidence was found in the repo. The checked-in
fixtures (`github-runner/garm/fixture-*.json`) are synthetic receipts with
no `created_at`/`ready_at` pair to derive a duration from. The `gh`
workflow-runs API is 403 for this principal, so no live canary run timing
could be pulled. The seeds are honest about this: `provisional: true`
until live samples land.

## Proposed ready-timeout value

**600000 ms (10 minutes) per VM, create to ready.** Placement:

- It is the alert tier, not the hard bound. VMs past 10 min page
  attention; the 30 min reaper provisioning-stuck rule stays the outer
  hard bound that declares a provisioning attempt stuck.
- A per-VM `ready_timeout_ms` field is stored in the baseline thresholds
  so the value is reviewed and versioned with the baseline, not scattered
  across runbooks.
- Tightening the 30 min stuck rule (or wiring this timeout into any pool
  automation) needs the same 30 live samples, in a reviewed PR. This card
  proposes the number; it does not install enforcement.

## Sample source

Live samples arrive by operator hand, never by script discovery:

1. The operator exports timestamp pairs from GARM API read metadata
   (instance `created_at` vs. first ready/runner-idle observation) or
   GARM server logs.
2. The operator writes them as a samples document:

   ```json
   {"schema": "garm-ready-time-samples.v1",
    "samples": [{"instance": "garm-two-abc123",
                 "created_at": "2026-10-10T14:01:00Z",
                 "ready_at": "2026-10-10T14:04:20Z"}]}
   ```

3. The operator records them:

   ```sh
   python3 -B garm_ready_time_baseline.py record \
     --samples /path/to/samples.json \
     --baseline garm_ready_time_baseline.json \
     --source "garm-api-read-metadata export 2026-10-10" \
     --recorded-by "operator name"
   ```

4. Fresh exports are evaluated without touching the baseline:

   ```sh
   python3 -B garm_ready_time_baseline.py check \
     --samples /path/to/fresh.json \
     --baseline garm_ready_time_baseline.json
   ```

The recorder never contacts GARM, GitHub, or any host. It reads the two
files on argv and writes only the baseline path on `record`/`init`.

## Refresh cadence

- Recompute (record) after every >= 30 new samples, or weekly,
  whichever comes first.
- The baseline stays `provisional: true` — and `check` answers UNKNOWN
  (exit 3), never ok or breach — until startup holds >= 10 samples.
- Recalibrate the seed thresholds and the proposed ready timeout after
  the first 30 live startup samples; seeds set above the physical floor
  must move to observed p50/p95 plus headroom, in a reviewed PR.
- The sample store is a bounded window (2000 most recent), not an
  unbounded log.

## Files

- `garm_ready_time_baseline.py` — recorder/checker, stdlib only.
- `test_garm_ready_time_baseline.py` — 33 offline hostile tests.
- `garm_ready_time_baseline.json` — the baseline (provisional seed).
