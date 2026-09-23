# ADR-0003 (plugin): Never retry within a firing on 401/403/429

- **Status:** accepted
- **Date:** 2026-09-02
- **Card:** TOG-811 design Q4

## Context

While researching CLIProxy's reachability for this design, rapid
unauthenticated probing against it from this session triggered a real,
observed IP ban with a live countdown of roughly 30 minutes. CLIProxy itself
therefore treats repeated failed/unauthorized requests from one source as
abuse and responds by banning the source, not just the request.

A poller that reacts to a 401/403/429 by retrying — even a handful of times,
even with backoff, within the same scheduled firing — is exactly the access
pattern that produced that ban. And a plugin that manages to get itself banned
takes every other CLIProxy consumer on that IP down with it, for the ban
window, which is a materially worse outcome than one missed poll.

## Decision

On HTTP 401, 403, or 429 from CLIProxy, the worker:

- writes `cliproxy_insight.poll_errors` with `reason: "http_<status>"`,
- writes an activity log entry ending "Not retrying within this firing.",
- returns immediately — no retry, no backoff loop, nothing further for that
  company this firing.

The next scheduled firing (`*/10 * * * *`) is the retry. There is no
in-process retry path for these three statuses anywhere in the worker.

Network errors and other non-200 statuses are logged the same way (metric +
activity, no retry) for the same underlying reason: a poller with a tight
retry loop of any kind, on any failure class, converts a transient failure
into sustained abusive traffic.

## Consequences

- Worst case, a real outage or a genuine auth problem shows up as a gap in the
  polled history no larger than one 10-minute interval, rather than as a
  self-inflicted ban that also blocks legitimate CLIProxy traffic from other
  agents on the same source.
- Covered by `tests/worker.spec.ts`, parameterized over all three status codes:
  asserts `fetch` is called exactly once per firing regardless of the response
  status, and that the reason tag/activity message reflect a refusal rather
  than a network failure.
- This is a permanent property of the worker, not a rollout-stage safeguard —
  it does not go away once polling is enabled in production.
