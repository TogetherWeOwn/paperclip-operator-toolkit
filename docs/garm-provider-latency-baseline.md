# GARM provider operation-latency baseline

## What this baselines

Provider operation latency only: how long the GARM provider takes to
execute an instance **create** or **delete**, in milliseconds.

Explicitly out of scope (separate instruments, separate cards):

- Pool health and capacity:.
- Reaper TTL and destroy pile-up handling:.
- Queue wait, job duration, runner registration lag.

A breach of these thresholds means "the provider is slow", never "the
pool is empty". Do not page pool capacity off this instrument.

## Sample source

No live provider sample stands behind the checked-in baseline yet: the
GARM fleet has not migrated, so there is nothing to measure. The
checked-in `garm_provider_latency_baseline.json` is a provisional seed
(`provisional: true`, zero samples) carrying proposed alert thresholds.

Live samples arrive by operator hand, never by script discovery:

1. The operator exports timings from GARM API read metadata (instance
   request timestamps vs. terminal-state timestamps) or GARM server logs.
2. The operator writes them as a samples document:

   ```json
   {"schema": "garm-provider-latency-samples.v1",
    "samples": [{"operation": "create", "duration_ms": 187000},
                {"operation": "delete", "duration_ms": 9000}]}
   ```

3. The operator records them:

   ```sh
   python3 -B garm_provider_latency_baseline.py record \
     --samples /path/to/samples.json \
     --baseline garm_provider_latency_baseline.json \
     --source "garm-api-read-metadata export 2026-10-10" \
     --recorded-by "operator name"
   ```

4. Fresh exports are evaluated without touching the baseline:

   ```sh
   python3 -B garm_provider_latency_baseline.py check \
     --samples /path/to/fresh.json \
     --baseline garm_provider_latency_baseline.json
   ```

The recorder never contacts GARM, GitHub, or any host. It reads the two
files on argv and writes only the baseline path on `record`/`init`.

## Proposed alert thresholds

| Operation | p50 alert | p95 alert | Status |
| --------- | --------- | --------- | ------ |
| create    | 10 min    | 20 min    | seed, recalibrate after 30 live samples |
| delete    | 2 min     | 5 min     | seed, recalibrate after 30 live samples |

Rationale (also stored per-threshold in the baseline file):

- **create** spans provider API, image boot, cloud-init and runner
  registration: minutes-scale even healthy. A median past 10 minutes
  means the typical path — not the tail — is sick. A 5% tail past 20
  minutes spends a full CI budget on provisioning alone.
- **delete** is an API call plus VM destroy with no boot phase:
  seconds-to-low-minutes healthy. A median past 2 minutes is provider
  distress. A tail past 5 minutes predicts destroy pile-up, which the
  reaper then has to absorb.

Percentiles use nearest-rank (`ceil(p/100 * n)` on ascending data).
Breach is per-operation OR across p50/p95 on fresh samples.

## Refresh cadence

- Recompute (record) after every >= 30 new samples per operation, or
  weekly, whichever comes first.
- The baseline stays `provisional: true` — and `check` answers UNKNOWN
  (exit 3), never ok or breach — until both operations hold >= 10
  samples.
- Recalibrate the seed thresholds after the first 30 live samples per
  operation; seeds set above the physical floor must move to observed
  p50/p95 plus headroom, in a reviewed PR.
- The sample store is a bounded window (2000 most recent per operation),
  not an unbounded log.

## Files

- `garm_provider_latency_baseline.py` — recorder/checker, stdlib only.
- `test_garm_provider_latency_baseline.py` — 34 offline hostile tests.
- `garm_provider_latency_baseline.json` — the baseline (provisional seed).
