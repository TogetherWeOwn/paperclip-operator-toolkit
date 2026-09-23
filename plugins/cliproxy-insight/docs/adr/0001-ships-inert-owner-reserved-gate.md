# ADR-0001 (plugin): Ship fully inert; the secret decision is owner-reserved

- **Status:** accepted
- **Date:** 2026-09-02
- **Card:** TOG-811
- **Precedent:** dispatch (`wakeEnabled: false`), model-selection (`mode: "advise"`)

## Context

The CLIProxy management API key that this plugin needs to read usage/cooldown
telemetry can also expose provider account credentials — it is not a scoped,
read-only token by nature. TOG-811 names placing it as a Paperclip secret as an
**owner-reserved decision**, explicitly not something this agent, or even the
President & COO acting alone, can just do. It also requires a CISO-reviewed
containment plan to exist first.

That leaves a build with two genuinely blocked steps sitting in front of
almost the entire deliverable — the manifest, the config schema, the poll job,
the persistence model, the agent tool, and the API route are all buildable and
testable today, independent of whether the key is ever placed.

## Decision

Ship the whole capability set, fully inert:

- `config.pollingEnabled` defaults to `false`.
- `config.managementApiKeySecretRef` defaults to `null`.
- While either is unset, the scheduled job writes a heartbeat metric
  (`cliproxy_insight.poll_skipped_disabled` / `poll_skipped_no_secret`) and
  makes zero outbound requests.

This is the same shape dispatch used for `wakeEnabled` and model-selection used
for `mode: "advise"`: install and review the entire thing before the
gated/reserved decision is made, so that enabling it later is a two-field
config change, not new engineering.

## Consequences

- The plugin can be published to `paperclip-ops-tooling/plugins/cliproxy-insight`
  with a pinned digest table and reviewed end to end before anyone is asked to
  approve exposing a credential-adjacent key.
- `onValidateConfig` still enforces internal consistency even in the inert
  state — `pollingEnabled: true` with no secret ref is rejected outright at
  config-write time, not silently tolerated.
- The two blocking steps (CISO containment-plan review; owner-reserved secret
  placement, raised via the President & COO) are named explicitly in the
  README's "The gate" section with owners, rather than left as an implicit
  precondition nobody wrote down.
