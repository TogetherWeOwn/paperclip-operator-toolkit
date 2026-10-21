# Release-lag and deployment-health reporting

`release_lag.py check` measures production drift. The scheduled workflow syncs
one issue per measured drifting app and posts a Monday trailing-28-day digest.
Disable `.github/workflows/release-lag.yml` to roll back; existing issues stay open.

## Evidence contract

A workflow's `head_sha` is **not** the deployed commit when it promotes an older
target. A successful workflow can also skip deployment entirely.

For each configured app:

1. Read complete, bounded production history and the actual deployment job.
   Staging pages newest-first successes and stops once the lag boundary is
   decided, so high-volume staging histories cannot exhaust the fetch bound.
   A contained push or scheduled run ends the walk; pinned dispatches are
   verified as candidates but never end it, because rollback drills
   intentionally re-verify old targets out of ancestry order.
2. Exclude skipped, cancelled and neutral jobs from deployment attempts.
   Non-deployment run outcomes without a matching job keep their run-level
   outcome instead of failing the whole app.
3. In successful deployment jobs, resolve the **first** pinned target checkout:
   its `ref: <full SHA>` must match the executed `git log -1 --format=%H` result.
   Later tooling checkouts are not deployment targets.
4. Use that same job's `completed_at` as **verified deployment completion**, not
   the workflow update time or the exact instant traffic switched.
5. Require the latest resolved target to match the public serving-identity SHA,
   fetched with an explicit `release-lag/1.0` User-Agent both apps accept.
6. Resolve staging proof using the app-specific contract below, then walk
   newest to oldest to find the **oldest** verified green ahead of production;
   the lag clock starts there, not at the newest candidate.

| App | Production job | Staging evidence |
| --- | --- | --- |
| two-web-next | `deploy-production` | Exact `e2e-staging deploy <full SHA>` title; successful journeys, quality job and both Lighthouse steps |
| two-bot-next | `wrangler … + readyz gate` | First target checkout in `wrangler deploy + intended rollout gate`, including pinned dispatches |

The checkout resolver follows the configured workflows' target-first ordering.
The walk boundary assumes non-dispatch staging completions arrive in ancestry
order; pinned dispatches are exempt because rollback drills intentionally
break that order. A changed job/checkout contract, expired logs, unexpected
response, unavailable public endpoint or inconsistent evidence is **unknown**,
never a fallback to workflow head. Raw job logs are neither printed nor
persisted by the detector.

The configured public health URLs expose only the serving revision fields used
by this monitor. No credential is supplied to these URLs. HTTP errors remain
unknown, including a public endpoint that rejects the monitor's HTTP client.

## Verdicts and delivery

- **lagging:** the oldest undeployed staging-green descendant of production
  has waited more than 24 hours. Production ahead of staging is not lag.
  Reported lag hours are exact when the walk reaches a contained candidate
  and a lower bound when it stops at the first old-enough one.
- **stale-prod:** no successful actual production deployment in seven days.
  Green no-op workflow runs do not refresh this clock.
- **ok:** newest equality with no older waiting candidate found, a candidate
  already contained in production, or a newer candidate still within the
  threshold.
- **unknown:** missing or unreadable evidence. Existing alert issues stay open.

Exit `0`: all apps measured ok. Exit `1`: measured drift. Exit `2`: any unknown
or discovery failure, even if other apps were measured. Measured drift still
syncs an alert when another app is unknown. Only measured `ok` closes an alert.
Changed alerts update the stored issue body so subsequent unchanged runs are silent.

Discovery adds public, non-archived org repositories advertising an enabled
`deploy-production` workflow (file stem, filename or display-name matching).
Explicit config always wins and survives discovery outages. New apps inherit
inventory coverage in **both** reports. They need a job/target/serving-identity
contract in `apps.json` before they can be measured; until then they appear as
unknown rather than a false healthy row. `exclude` removes deliberate exceptions.

Inventory lists paginate up to 20 pages of 100. Time-filtered production
histories paginate up to 10 pages of 100; reaching a bound refuses the
measurement rather than reporting partial numbers. Staging uses the same
10-page bound but pages server-filtered successes newest-first and stops at
the lag boundary — a contained non-dispatch run, proven lag, or an unreadable
compare — so it normally reads one page. Commands have 120-second timeouts
and the job has a 20-minute timeout. No credential fallback or retries are
performed.

## DORA interpretation

The digest reports **deployment-job proxies**, not independently observed
service incidents:

- Frequency: actual successful deployment jobs per week in the trailing window.
- Lead: resolved target PR's merge time to deployment-job completion, only when
  GitHub positively associates that SHA with the PR's merge commit. The digest
  shows sample coverage; missing evidence is `n/a`, not workflow-head commit age.
- Failure rate: `failure`, `timed_out` and `startup_failure` deployment attempts
  divided by successful plus failed attempts. Guard-only failures and no-ops
  are not attempted deployments.
- Restore: median failed attempt to next successful verified deployment.
  This does not measure an automatic in-job rollback or a separate service outage.

The digest reuses the check's exact inventory/history snapshot. It is posted
on Monday or manual dispatch even when lag fires or issue sync fails; unknown
apps remain visible. The workflow remains red for incomplete measurement.

## Verification

```sh
python3 -m unittest -v test_release_lag.py test_release_lag_regressions.py
python3 -m unittest -v test_config_deploy_check.py
actionlint .github/workflows/release-lag.yml
```

The original fixture acceptance suite is unchanged. Additional implementer-owned
regressions cover promotion targets/no-ops, ancestry, the oldest-waiting lag
clock, lazy staging paging with early stop past contained dispatches, the
serving-identity User-Agent, non-deployment job outcomes, unknown alert
preservation, pagination, discovery, non-change DORA conclusions, issue state
dedupe, and digest creation. Isolated oldest-success and removed-equal-SHA-guard
mutants must both turn the regressions red, as must ignoring the waiting
boundary, stopping the walk at a contained dispatch, deriving the verdict
from the newest candidate alone, letting newest equality override a found
waiting candidate, dropping the serving-identity compare, reverting to the
default HTTP client, raising on unmatched non-deployment runs, or dropping
the staging success filter.
