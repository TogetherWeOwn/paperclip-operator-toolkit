# Nightly escape/rework quality guardrail

`ops/kpi/escape_ledger.py` remains the read-only collector. Its schema 5 adds one
shared cohort summary and PR creation timestamps. `ops/kpi/dora_scoreboard.py`
validates that snapshot and writes an offline, stdlib-only owner-inbox spool.
It makes **no model, GitHub, database or production requests**. Collection still
uses the existing read-only GitHub and optional review/incident sources.

This is a descriptive **proxy**, not a merge gate, deployment DORA, a confirmed
production-defect rate, or proof of non-inferiority. Deployment-job DORA remains
in `release_lag.py`; no second deployment collector is introduced.

## The one quality number

For a ledger observation window `[start, end)` in UTC:

- `n`: unique `(repo, PR number)` merges in the window with at least seven full
  days observed (`mergedAt + 7 days <= end`). Later merges are `immature_n`.
- `escape_n`: mature merges implicated by an existing linked incident, revert or
  hotfix proxy strictly after the merge, no later than seven days afterwards,
  and strictly before `end`.
- `rework_n`: the same calculation restricted to revert/hotfix proxies. This is
  a **subset**, not an additional numerator. It measures merged corrective work,
  not pre-merge review iterations or agent time spent rewriting code.
- `escape_rework_rate = affected_n / n`, where `affected_n = escape_n`. One
  affected merge counts once even if several fixes, reverts and incident notes
  implicate it. A fix implicating two mature merges affects two merges.

`escape_rate`, `rework_rate` and `escape_rework_rate` are fractions in JSON;
text renders percentages and numerator/denominator with `n`. Each affected row
retains repo, number, exact head, merge commit, event IDs and kinds. Follow the
event IDs into `escapes.jsonl` for original source/line/evidence pointers.
Repo/PR identity is never inferred from a bare foreign PR number. Older or
out-of-scope introducers do not enter the numerator or denominator.

Missing/partial repository coverage, inconsistent analyzed counts, unlinked fix
or incident mentions, and unresolved revert targets suppress the rates. Observed
counts remain available with `coverage_status=partial` and stable reason codes.
Day-granular incident notes that overlap a merge or seven-day boundary also
suppress the rate rather than guessing the hour. A whole incident day strictly
inside the attribution interval can count. Zero `n` is **N/A**, never 0%.

The original daily/weekly occurrence-date `escapes_per_100_merges` is preserved
for compatibility. It counts events, can exceed 100, and is **not** this cohort
metric. Do not mix these rates or add rework to escape.

If a degraded merge identity or timestamp prevents summary validation, the
collector still publishes the current legacy observations with `status=partial`
and `quality=null`. Aggregate rates are suppressed, a sanitized diagnostic is
recorded, and completed historical snapshots are preserved. The scoreboard
independently validates these rows and publishes `UNAVAILABLE` rather than
reusing a healthy spool or treating the absent summary as a zero rate.

## Measured spans, not inferred queue times

The summary's `stage_waits` contains p50/p90 seconds (linear interpolation), `n`
and `missing_n`, over **all observation-window merges**, not only mature ones:

- `pr_open_to_merge`: GitHub `createdAt` to `mergedAt`; total PR elapsed time,
  including active work and waits.
- `review_complete_to_merge`: latest recorded exact-head pre-merge review's
  completion to merge. It does not imply the review passed or was the only gate.

Absent timestamps, a wrong reviewed head, a post-merge review or a review before
PR creation are missing samples, not zero seconds. These are not CI queue,
reviewer queue, or time-in-stage measurements; no such timestamps are currently
collected here. The two spans overlap and must not be summed. Optional review
provenance remains unknown when unconfigured. No credential scope is broadened.

## Run offline

Use private state outside the checkout; do not commit operational observations.
For example, with `STATE` set to the existing private ledger state directory:

```sh
python3 -I ops/kpi/dora_scoreboard.py --ledger "$STATE/escapes.jsonl" --dry-run
python3 -I ops/kpi/dora_scoreboard.py --ledger "$STATE/escapes.jsonl" --output-dir "$STATE"
python3 -I ops/kpi/dora_scoreboard.py --help
```

`--now` freezes a timezone-qualified as-of instant for offline replay.
`--max-age-hours` defaults to 36 (bounded 1..168); both snapshot generation and
observation end must be fresh. Future observations, generation before observation
end, unknown schema versions, wrong record counts, duplicate/conflicting
identities, mismatched recomputed summaries and malformed JSON fail closed.
Limits: 64 MiB and 250,000 JSONL records. The collector and joiner use the **same**
`quality_summary` implementation; a stored summary is never blindly trusted.

Stdout is one JSON object. Exit codes:

- `0`: complete observation, including measured zero or no mature denominator.
- `2`: partial/unavailable observation or output failure. An error has stable
  `code`, `retryable` and `next_action`; raw source text and exception messages
  are never echoed.
- `75`: another scoreboard writer holds the lock; do not overwrite its result.

`--dry-run` writes nothing. Otherwise all new files are private (0600), protected
by a non-blocking lock and atomic individual renames:

- `quality-scoreboard.json`: schema 1; authoritative result, including the
  `owner_line`, `published_at`, source expiry, collector run ID/tool SHA-256,
  source snapshot SHA-256, repository scope, full summary and evidence identities.
- `owner-inbox-line.txt`: one convenience line for the **existing inbox adapter**.
  A file is not proof of inbox delivery. Consumers must read/validate the JSON's
  status and expiry and use its `owner_line`; do not blindly concatenate an old
  text file. Publication means a verified inbox receipt, not a successful write.

The current owner line contains the quality/rework percentages with n,
immature count, coverage, both measured spans with n/missing, source ID/digest,
expiry and a warning that non-inferiority is not established.
If input becomes missing, stale or malformed, an `UNAVAILABLE` result replaces
the previous current spool. It must not leave the previous healthy number as
current. Historical collector snapshots are not altered. JSON is authoritative
if a crash occurs between the two output-file renames.

## Nightly integration and rollback

The existing `escape-ledger.timer` fires at 05:23 UTC. Its service's collector
runs as before; `ExecStopPost` invokes the offline scoreboard on **both success
and failure**, without accepting failed collector exit statuses. Both programs
share systemd's `INVOCATION_ID`. An old snapshot from another invocation cannot
masquerade as the just-failed run, even if it is less than 36 hours old. Failures
remain failed service executions; no review/security check is weakened.

Installing/reloading the unit and connecting the existing inbox adapter are
host operations for the authorized executor, **after exact-head CI and review**.
This repository does not implement or assume an inbox transport. Record the
installed commit/unit hashes, timer next firing, service result, JSON source
identity and inbox receipt before claiming nightly publication. Until then,
offline fixture output is only fixture evidence.

Rollback: revert the PR and restore the previous delivered unit, or stop/disable
the existing timer. Treat the spool as unavailable after rollback; do not reuse
schema 5 observations with older tooling. No data deletion, gate changes,
production tests, model calls or spend are needed.

## Shadow/wave citation contract

Every shadow report using the guardrail cites the same private scoreboard
snapshot SHA-256, collector run/tool SHA-256, UTC window, repository scope,
numerator/n, immature count and coverage/reasons. Attach the source as a private
work product, never to a public PR. Do not compare rates with different scopes,
missing sources, or immature post-enable cohorts. A 72-hour check cannot prove a
seven-day escape outcome for newly enabled merges. Record that limitation and
wait for mature observations; this script never auto-approves a wave or changes
an existing security/shadow/enable gate.

Cost per informative decision and pre-merge review rework require their own
recorded cost/review-iteration denominators; this ledger does not invent them.

## Offline verification

```sh
python3 -I -m unittest discover -s ops/kpi -p 'test_*.py' -v
```

CI uses that exact isolated invocation. Suites cover real local-git linkage,
legacy output, overlap/maturity/boundaries, partial/linkage gaps, measured-span
missingness, the collector-to-joiner schema, source freshness/invocation binding,
zero n, malformed/truncated input, write failure/concurrency, private output,
and hostile ambient imports. No test calls production, a model, a live database,
or the GitHub API.
