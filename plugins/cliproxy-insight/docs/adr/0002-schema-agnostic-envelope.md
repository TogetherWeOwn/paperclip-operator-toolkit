# ADR-0002 (plugin): Persist a schema-agnostic envelope, not a typed cooldown record

- **Status:** accepted
- **Date:** 2026-09-02

## Context

The originating design describes a plugin, `opencode-go-pool`, that already reads
persisted cooldown records from CLIProxy — implying a known record shape this
plugin could simply adopt. An exhaustive filesystem sweep of the plugin host
found no trace of that plugin, of `save-cooldown-status` in any spelling, or of
any CLIProxy management-API documentation at all. Separately, an earlier
measurement found CLIProxy unreachable from any container (loopback-bind only),
so this plugin cannot probe the real API itself to derive the shape
empirically.

Net: the real `/v0/management/*` response shape is unknown, and unverifiable
from this environment. Prior CLIProxy-adjacent work (documented in that same
measurement) has already been burned twice by acting on unverified assumptions
about this exact API surface (base URL, `apiType`).

## Decision

Persist a wrapping envelope rather than a typed schema:

```ts
interface ProviderSnapshot {
  polledAt: string;
  provider: string;
  status: number;
  raw: unknown;       // whatever the endpoint returned for this provider, verbatim
  schemaVersion: 1;
}
```

`raw` is stored opaquely. The only structural assumption the worker makes is a
heuristic, `looksLikeCooldown()`, checking for the presence of
`cooldownUntil` / `cooldown_until` / `exhausted` / `exhaustedAt` — read
defensively (any of several plausible field names, never required), used only
to decide whether an event is *also* appended to the rolling cooldown-events
log, never to reject or reshape the snapshot itself.

## Consequences

- The plugin builds, tests, and ships completely independent of ever having
  seen a real CLIProxy response. Nothing in the persisted history needs to be
  migrated once the real shape is confirmed — it is already sitting in `raw`.
- `get_provider_usage` and the `/usage-summary` API route both return `raw`
  as-is; a caller that wants typed fields has to know the actual shape, which
  is honest about what this plugin currently knows.
- This is deliberately a placeholder, not a permanent design: the originating
  design's operator-recon step (design Q1) is the point where the real shape gets
  confirmed, and typed field extraction is a natural fast-follow once it has.
  Until then, `schemaVersion: 1` exists specifically so a later, stricter
  parser can distinguish envelopes written before and after that fast-follow.
