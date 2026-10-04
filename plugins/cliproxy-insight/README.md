# CLIProxy Insight

Turns CLIProxy's in-memory-only per-upstream usage/cooldown telemetry into
durable Paperclip history. Read-only, forever.

Built against dispatch (`wakeEnabled`) and model-selection
(`mode: "advise"`) rollout conventions.

| | |
|---|---|
| Version | **0.3.1** — bounded single-company scheduled polling; retains per-lane cooldown state |
| Code | manifest, config schema, secret-ref guard, worker (poll job, one agent tool, one API route) |
| Tests | 95 vitest cases (all 82 existing + 13 scope cases; `it.each` rows count separately). No live DB, credentials or lane requests. Process-level and stock-runtime harnesses are maintained privately with the operator material. |
| Manifest | validated against the **host's own** `pluginManifestV1Schema` — PASS, `pluginId: "togetherweown.cliproxy-insight"`. `validateManifestCapabilities` could not be run standalone here — it lives in the host server's plugin capability validator and resolves internal `@paperclipai/shared` source paths that only exist inside the live server process. Every declared feature was hand-checked against the capabilities list instead, and that check caught one real gap (`activity.log.write`) |
| Polling | **off** by default; installing is not enabling |

---

## What changed in 0.3.1

The stock scheduler sends `runJob` without a company scope. The host permits
explicit company calls only for this plugin's configured companies, not every
company returned by `companies.list()`. The old enumeration could therefore
throw `config.get: company context is required` before even checking whether
polling was disabled.

The worker now learns company identity only from host `configChanged` delivery
(startup replay and config saves), never from bootstrap config or enumeration.
Zero companies is inert. Exactly one company gets a fresh scoped config read
per firing. Receiving a second distinct company latches all polling off until
an operator fixes the duplicate configuration and restarts the worker. Even
identical duplicate configs are refused. `multiCompanyConfig: true` opts into
receiving all deliveries so the plugin can enforce this stricter rule itself;
it does **not** authorize multi-company polling. No company-discovery list or
secret value is persisted; job payloads cannot select the company.

A delivery with no company identity also latches the worker inert, but returns
without throwing. Refusals emit `cliproxy_insight.company_scope_refused` with
bounded reasons `missing_company_id` or `multiple_companies`. Neither latch can
be cleared by another config save. Tool and API reads re-check the binding after
the scoped config await, before reading stored state.

Capabilities: remove `companies.read`; add none. No migrations, no new state
shape, no secret grant changes. The six lane defaults and no-retry bounds stay
unchanged. A process-level wire harness is not authorization evidence on its own;
a stock contract harness that runs the actual installed scheduler, worker manager
and SDK authorization gate is the stronger check. Both, together with the
contract-and-limits note and the upgrade/rollback packet, are maintained privately
with the operator material. Local tests do not establish a successful live canary
or the seven-day acceptance metric.

## What changed in 0.3.0, and why it matters

v0.2.0 polled two aggregate files that the 2026-09-05 sanitizer design
specified: `request-rates.json` and `model-usage-v1.json`. It was never
installed, and while it sat unreleased the lane was rebuilt around the
**per-lane collector contract** — one document per lane
(`claude.json`, `codex.json`, `kimi.json`, `opencode-go.json`, `zai.json`,
`antigravity.json`), each an `{schemaVersion, observedAt, staleAfterSeconds,
records[]}` envelope. Those are the files `model-selection`'s pacer polls in
production. v0.2.0 would have written two `poll_errors` per firing and stored
nothing.

So 0.3.0 re-points at the per-lane documents and makes the aggregates opt-in
(`legacyAggregateFiles`, default off). Nothing on the host changes: same
namespace, same bearer, same read-only static JSON. Only which filenames the
plugin asks for.

The second change was prompted by a Z.ai cooldown that nobody could see and that
cost seven agent runs: **a cooldown is lane state, not a percentage.** Each record is read for a cooldown instant and, when
one is active, the lane account is reported as cooling on both read surfaces
and a transition event is appended to its rolling log. Three details are
load-bearing, and each is a defect observed elsewhere in this system:

- **Flat keys first, then nested.** An earlier producer revision published the
  cooldown *only* as a nested `cooldown: {until}` object, which a flat-key
  reader never sees — producer correct, validator green, pacer still
  dispatching into a cooled-down credential. This reads all six flat aliases
  **and** the nested object.
- **`health: "cooldown"` does not count.** The Router maps it to `degraded` →
  posture `avoid`, which still selects the lane. Only `exhausted` and
  `unavailable` are treated as refusing work.
- **Cooldown is evaluated at read time, not frozen at poll time.** A stored
  instant that has since passed stops being reported without waiting for a
  poll; an instant in the past is not a cooldown.

An unparseable instant is reported as `cooldown_unparseable_until`, never
silently dropped — a cooldown you cannot parse is not a lane you may dispatch
to. `laneFiles` is config, not a constant, because adding a lane on the host
must not require a plugin release; an unlisted name is simply not served by the
lane's Caddy allowlist (`devin.json` 404s today) and costs one 404 per firing.

## What changed in 0.2.0, and why it matters

v0.1.0 was written before the upstream surface could be observed from this
environment, so three things were guesses. The operator measured all three on
2026-09-05, and **all three were wrong**. Each was a silent 100%-failure
defect, not a degradation:

| | v0.1.0 guessed | Measured | Failure mode |
|---|---|---|---|
| Auth | `Authorization: Bearer <key>` | `x-api-key: <key>` | Every poll 401s against a healthy lane |
| Path | one invented `/usage-summary` aggregate | two named static files | Every poll 404s |
| Providers | hardcoded six-name allowlist used as a **filter** | payload-driven; lane serves `codex`/`codex-spark` | Real providers discarded while the poll reports success |

Plus a wrong default origin (`cliproxy.example.net` → the lane at
`router.example.net/telemetry/cliproxy`).

The auth finding is not inferred: `router/src/capacity/read.ts:24` reads
`headers: input.apiKey ? { "x-api-key": input.apiKey } : {}`. The provider
filter is the subtlest of the three — it would have produced a green
`poll_ok` metric forever while `codex` and `codex-spark` were never recorded
and `openai`/`antigravity`/`xai` read as permanently absent.

`providers` is gone from the config schema entirely. The provider set now
comes from the payload, and `SEED_PROVIDER_ORDER` affects display order only —
it never decides what gets stored.

## The owner-reserved gate is dissolved, not merely satisfied

The original design held that placing the CLIProxy management key as a Paperclip
secret was an owner-reserved decision, because that key can read
`/v0/management/auth-files` and returns provider credentials in clear.

The lane design removes the need for that decision. A host-side collector
holds the management key (in an operator-held env file, never in Caddy's
environment) and publishes sanitized static JSON. The only credential
Paperclip holds is `cliproxy-usage-lane-key`, a lane bearer that can read an
allowlisted set of static files and reach nothing else — `/v0/management/*` is not routable
through the lane at all. **The management key is not placed, not contained,
and not projected: it never enters Paperclip.**

`onValidateConfig` refuses a `baseUrl` containing `/v0/management` by name,
so the removed surface cannot be re-introduced by configuration.

---

## What it does

For exactly one configured company, every 5 minutes (the collector republishes every 2), one GET per
configured lane document against the sanitized lane:

1. resolve `laneApiKeySecretRef` at call time — never cached, never logged,
   never written to `plugin.state`
2. `GET ${baseUrl}/<lane>.json` with `x-api-key`, for each of `laneFiles` —
   per-lane records carrying health, weight, governing window, per-window
   utilization and, when present, the cooldown instant
3. persist one snapshot per lane document keyed by the **producer's**
   `observedAt`, plus a lane index (plugin state has no scan, so the observed
   lane set is itself state, and it is **unioned** across polls — a lane
   missing from one publish is not evidence it stopped existing)
4. append to a rolling per-account cooldown log **on transition into cooldown
   only** — a new instant or a new reason is a new event, a repeat observation
   is not. Otherwise one exhausted account appends every firing and evicts
   every other account's history from the capped log
5. write `lanes_observed` and `lane_accounts_cooling` — the latter
   unconditionally, including zero, because a gauge that only appears when
   something is wrong cannot be alerted on
6. on any non-200 / timeout / malformed body: record a **bounded reason code**
   (`http_NNN`, `timeout`, `network`, `malformed_json`) and stop. **Never
   retry within a firing** — the next scheduled firing is the retry
7. a document carrying an unimplemented `schemaVersion` is **rejected, not
   stored** (`model-usage-telemetry-v1` §3.1: a consumer MUST reject a version
   it does not implement rather than best-effort parse it)

Optionally, with `legacyAggregateFiles`, the v0.2.0 aggregates
(`request-rates.json`, `model-usage-v1.json`) are polled too.

Every file is independent: one failing never discards another's data, and one
unserved lane is not a failed poll. Scoped config/secret failures are caught and
recorded with bounded reason codes, never raw error text. `get_provider_usage` and
`GET /usage-summary` read back what was persisted — lanes, per-account
cooldown, and the legacy provider records when present — flagged stale against
`staleAfterSeconds` (the payload's own value wins when present). Neither ever
calls the lane.

The upstream error string is deliberately **not** propagated into state,
activity, or metrics: those are all persisted, and upstream messages routinely
embed URLs and connection IDs.

## What it deliberately is not

- **Not a write path.** No capability in this plugin could mutate CLIProxy
  config or trigger a provider account action.
- **Not a management-API client.** It never reads `/v0/management/*`, and a
  `baseUrl` pointing there is a config error.
- **Not a retry loop.** Rapid probing against CLIProxy triggered a ~30-minute
  IP ban twice during recon. Every failure path returns immediately.
- **Not a schema assertion.** The per-provider counter fields are read
  alias-tolerantly (`success`/`successes`/`successCount`/…), and whatever else
  the lane publishes is kept verbatim under `raw`. A missing counter is stored
  as `null`, never as `0` — zero traffic and an unreadable counter are
  different facts.

---

## Rollout

0.3.1 replaces an installed 0.3.0 as an immutable package swap. The operator
runbook and the upgrade/rollback packet are maintained privately. Require
independent exact-head review, green CI and non-author merge before operator
authorization. Keep an installed 0.3.0 disabled until that replacement is
authorized.

Reuse the existing telemetry secret reference and reviewed scoped binding;
create no secret or grant. Configure exactly **one** company. Multi-company
rollout is unsupported and deliberately stops polling. No management credentials,
Caddy changes or collector installation are part of this repair. The historical
lane design above does not authorize new host work.

---

## Verification

```
npm run verify                        # typecheck + tests + build
npm test                              # 95 cases across 4 files; includes it.each rows
npm run build                         # esbuild → dist/manifest.js, dist/worker.js
```

`tests/worker.spec.ts` boots the plugin through the SDK's in-memory harness
and drives the scheduled job, the agent tool, and the API route end to end.

### Why there is a second harness

A process-level harness, maintained privately with the operator material rather
than in this tree, spawns `dist/worker.js` as a **real child process** and
speaks the real newline-delimited JSON-RPC protocol to it, so every `ctx.*` call
arrives as a wire message. It needs no credential, no network and no host.

It exists because the vitest harness and the plugin share an assumption: the
in-memory `ctx.http.fetch` forwards `init` to the global `fetch`, so an
`AbortSignal` works there. The **real** SDK worker bridge serializes only
`method`, `headers` and `body` — `signal` has no wire representation and is
dropped. v0.2.0 therefore shipped a `requestTimeoutMs` that bounded nothing: a
lane that accepted the connection and never answered would hang the poll
forever, and every subsequent firing with it. 64/64 tests were green.

Measured, then fixed: the poll now returns in ~1.3 s against a 1 s budget,
where it previously ran past 6 s with no bound at all. The timeout is a
`Promise.race`, and the honest caveat is in the code — the host request is not
cancelled, merely no longer awaited.

Both suites are mutation-tested. Against the process harness, five mutants each
went red for their own named check (reverting to `signal`; `Bearer` instead of
`x-api-key`; accepting any HTTP status; writing `poll_ok` unconditionally; reading the
cooldown instant as absent, which takes `1f. an active lane cooldown is logged
and counted` to `cooling=0`), and
a **dead worker aborts with exit 70** rather than scoring a clean run — the
first version of this harness exited 0 having run zero assertions when the
worker died, which is the failure mode it is meant to catch. `metricsNamed()`
likewise refuses an absence-assertion when the metric field name is wrong; an
earlier revision filtered on `metricKey` (the real field is `name`), so "0
matches" read as a pass for a filter that could never match anything.

Because a green suite nobody watched go red is not evidence, the load-bearing
assertions were mutation-tested. Ten mutants, ten caught: reverting the auth
header to `Bearer`; re-introducing the hardcoded provider allowlist;
accepting any `schemaVersion`; logging cooldowns per firing instead of per
transition; clobbering the provider index instead of unioning it; retrying
within a firing; leaking upstream error text into a reason code; reporting a
missing counter as `0`; dropping the staleness flag; renaming a lane file.

The 0.3.0 lane assertions were mutation-tested the same way. Seven mutants,
seven caught: reading only the flat cooldown keys and dropping the nested
object; treating `health: "cooldown"` as unserviceable; ignoring the expiry
comparison so a past instant still reads as cooling; logging every observation
instead of every transition; freezing the cooldown at poll time instead of
evaluating it at read time; accepting any `schemaVersion`; clobbering the lane
index instead of unioning it. The last two of those were written **because**
the first pass of the mutation run had nothing to catch them with — the union
mutant survived until a test was added for a lane that 404s for one firing.

Two of the 0.2.0 mutants initially **survived** and the tests were strengthened in
response — the filename mutant survived because every URL assertion built its
expectation from `LANE_PATHS`, so a rename moved both sides of the comparison.
The filenames are a contract with the operator's collector and are now pinned
as literals.

### What has NOT been verified

- Version 0.3.1 has not been verified on a live host. Its predecessor, 0.3.0,
  failed scheduled company scope against the stock scheduler; see "What changed
  in 0.3.1".
- `validateManifestCapabilities` could not be run standalone — see the status
  table.
- **No successful live scheduled poll is verified.** The repaired scheduled
  path is exercised only by a stock-runtime harness (maintained privately) using
  fixture service adapters, not the live lane or database. Host activation, canary, rollback and seven-day
  acceptance remain outstanding. `poll_ok` with `null` counters is the signal
  that a field alias is missing.
- **No lane has been observed cooling through this plugin.** The cooldown
  fixtures set `exhausted_until` by hand on a real record shape; they are not a
  capture of a live cooldown, because catching one requires being polling while
  it happens. `codex.json` was observed carrying two `health: "exhausted"`
  records, so that arm is from life.

The lane payload itself is **no longer** unverified, and the note that used to
sit here — that a 401 gates every path so the namespace cannot be read — was
wrong twice over. The lane's current shape puts the key in the same
matcher as the path and does not claim the namespace, so a request without the
bearer falls through to the site's ordinary 404 page. A keyless 404 is the
designed response, not evidence the route is gone; reading it as deletion cost
one wrong conclusion and one unnecessary operator escalation. **With** the
bearer, `claude.json` and `codex.json` returned 200 on 2026-09-17, and the
fixtures in the lane test block are copied from those bodies, not invented.
