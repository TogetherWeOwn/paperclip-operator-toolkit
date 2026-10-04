# Run-scoped model decision (`onResolveRunModel`)

TOG-11793, from TOG-11780 §4.3 and §6. The router decides each issue run's model
at the run's start, from memory, instead of pinning the issue and racing the run.

## What it is

The fork host (TOG-11792) calls `onResolveRunModel` inside `executeRun`, before
the adapter config merge, with a deadline (1500 ms by default). The plugin answers:

| Answer | Meaning |
|---|---|
| `decide` | Run on `model` (and `effort`, `env`). Carries `decisionId`, `tier`, `source`, `fallback`, `reason`. |
| `keep` | The agent default or the existing override is correct. Flag off, advisory install, override present, no roster, or the engine holds at the floor. |
| `defer` | No decision yet. The host parks the run for a bounded retry and never falls back to the default. |

## Hot caches only

Nothing on the decision path fetches remote data or starts a classification.

| Input | Source | Freshness |
|---|---|---|
| Config, volume profiles, lane ledger, scores, card ledger, availability, lane evidence, live lane weights | company snapshot (`HotCache`) | warmed by `refreshRunResolveSnapshot` every minute; refreshed in the background once older than `runResolve.snapshotTtlMs` (45 s); **served stale** if a refresh fails |
| Issue labels, priority, title | per-issue cache | 15 s TTL, invalidated by `issue.created` / `issue.updated` |
| Agent name, adapter config | per-agent cache | 60 s TTL |
| Previous decision (`tier`, `fallback`) | decision cache by `decisionId` | miss → one primary-key read of `heartbeat_runs.context_snapshot.modelDecision`; a failed read degrades to "the model the previous run reported, tier unknown" |
| Previous run's context peak | peak cache | filled by a background read after a decision; never awaited |
| Classification | the event path's own in-flight call | waited on for at most `runResolve.classifierWaitMs` (cap 1000 ms); never started here |

A cold snapshot that cannot load inside the host deadline (minus 150 ms) answers
`defer`. A defer carries `runResolve.deferRetryMs` (5 s).

## Tier

The `tier:*` label if present (`tierSource: label`); else a classification that
finished while the hook waited (`classifier`); else `resolveTier`'s deterministic
answer, the assignee's floor tier then the configured default (`heuristic`).

## Sticky rule

Keep the previous run's model unless:

1. it is **unserviceable**: the engine's own sticky probe declines it (lane hard
   stop, availability, lane evidence, context window, adapter, tier floor);
2. it was a **fallback** and the primary pick is serviceable again (`primary-recovered`);
3. the **tier changed**, in either direction (`tier-changed`).

Every move is written to the issue's activity feed with its reason, and carried in
`decision.reason`. A kept model keeps the `fallback` status it was decided with, so a
later run can still see it is on a fallback. With no prior routed decision there is
nothing to be sticky to: that is a `first-decision`, not a switch.

## Env

A decision returns plain strings for keys declared in the manifest's
`modelRouting.envKeys`: `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, the four pin-lane model
keys and the two ancillary model keys (`RUN_RESOLVE_ENV_KEYS`). It never returns an
agent env key, and skips a declared key the agent binds to a secret (the host would
refuse the whole decision for it). `effort` is carried only for the adapter whose
effort key is `effort` (`claude_local`).

## Turning it on

Two switches, both needed, and a build made for the fork host:

1. **Build** with `MODEL_SELECTION_RUN_RESOLVE=1 npm run build`. This declares the
   `run.model.resolve` capability and `modelRouting` in the manifest. The default
   artifact omits them: a host without the hook rejects an unknown capability at
   install, so the default build installs everywhere. The capability has one holder
   per company.
2. **Config** `runResolve.enabled: true` and `selection.mode: "enforce"`. The
   enforce gate is TOG-12431's; `runResolve` alone retires nothing.
3. **Host** `experimental.requireRunModelDecision` (default off). Off, the host
   records the answer and runs on the default: use that to measure fidelity before
   requiring it.

Once both config switches are on, these stop writing pins: the creation and
assignment pin (`pinAtDecisionTime`), `labelOnlyPass`, `balancePass`, `repinPass` and
the `agent.run.failed` re-pin. Classification and tier labels continue.
`repairPinEnvAfterConfigFailure` stays: it repairs pins that already exist.

## Rollback

`runResolve.enabled: false` (config save invalidates the snapshot at once). The
handler answers `keep`, and every legacy pin path runs again on its next firing.
Nothing the handler wrote is persisted on an issue.

## Known limits

- **Existing pins win.** The host skips the hook for any issue that already carries
  an override model; it cannot tell a legacy plugin pin from an operator pin. Pins
  written before the flag stay in force until cleared. This card does not clear them.
- **Effort for other adapters.** The host's `decide` carries one `effort` key. The
  `codex_local` and `opencode_local` effort keys cannot be expressed, so those keep
  the effort they inherit. The decision trace says so.
- **Lane weights.** With pins retired, live lane load comes from running routed
  runs (`ACTIVE_ROUTED_RUN_MODELS_SQL`) plus any legacy pins.
- **Latency.** `tests/run-resolve-worker.spec.ts` benchmarks the plugin side with
  in-memory host calls: it excludes the host to worker round trip (budget 20 ms) and
  cold starts. The production number is the host's `latencyMs` on
  `contextSnapshot.modelDecision`.
