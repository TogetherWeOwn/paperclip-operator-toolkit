# Scheduled company-scope contract — TOG-4170

## Measured result (2026-09-23)

SDK locked at `@paperclipai/plugin-sdk@2026.824.1`; Node 24.21.0, npm 11.19.0
in this sandbox (operator must repeat on the deployment Node version).

- Original merged payload `1ae5cccf792d06c20ba937ec6ee63a709cd9389b`:
  actual stock scheduler/worker-manager/authorization gate reproduces
  `Plugin "stock-contract-insight" is not allowed to perform "config.get": company context is required`
  with zero configured companies, and with A configured while company B is
  enumerated first. Both reject before config storage, secrets, network or state.
- Revised payload after TOG-4193: all 82 existing unit tests retained; 13 scope
  cases (95 total), all nine original rebuilt-worker checks, nine additional
  stock-runtime integration scenario groups pass. The earlier review head had
  10 scope cases (92 total), not 10 separate `it` blocks.
- Count arithmetic: `worker.spec.ts` 62 + `config.spec.ts` 14 +
  `manifest.spec.ts` 6 = 82 across three files. `company-scope.spec.ts` now has
  nine plain `it` blocks plus two `it.each` blocks with two rows each:
  9 + 2 + 2 = 13 cases; 82 + 13 = **95 across four files**. Previously it had
  eight plain blocks plus one two-row `it.each`: 8 + 2 = 10; 82 + 10 = 92.
- Fresh isolated copy, `NODE_ENV=development npm ci --ignore-scripts --no-audit --no-fund`,
  `npm run verify` and both harnesses pass. All four dist files reproduce exactly.
- Revision tests kill four independently applied mutants: removing the tool
  post-config check; removing the API post-config check; throwing on missing
  identity; changing the refusal metric name. Each fails executable assertions;
  the clean source is restored after each mutant run.
- This demonstrates a sufficient cause matching the operator error, not the
  identity/order of companies in the historical host run (not queried).

## Authoritative source trace

These are the installed stock sources, read but never patched. No upstream PR,
stock authorization change, manually injected job company or omitted invocation
ID is involved. The runtime tree has no `.git`, so hashes, not an invented
upstream revision, identify this contract. Official spec: `/app/doc/plugins/PLUGIN_SPEC.md`
§13.4–13.6 (`configChanged` includes company ID, job does not) and §25.4.4
(company config and secret bindings). The stock implementation is authoritative
where the spec omits startup replay/proactive authorization details.

| Source | Relevant lines | SHA-256 of tested file |
|---|---|---|
| `server/src/services/plugin-job-scheduler.ts` | 369–382: real scheduled `runJob` with no company ID | `9eb9ce0bf7f915abb5ae4d7d35b83d7a95eaca18243ddbbefabdd84a1f3042c8` |
| `server/src/services/plugin-worker-manager.ts` | 1115–1139, 2631–2692, 3305–3308: host scope derivation, explicit proactive scope, strict invocation match | `220cef73e1fb72a389993367cb13f9b8b51060c48592fce6d3f9888e7534343a` |
| `packages/plugins/sdk/src/host-client-factory.ts` | 571–668, 708–711, 778–780: required company, config/secret gates, company state gate | `a48078a8ae9e6f1dec789087634aec3a39f49dccf0ba9a7a5bb9ce93eea63af8` |

Other inspected paths:

- `/app/server/src/services/plugin-loader.ts:2264–2367`: initialize config is
  `{}`; configured companies seed proactive scope before process start; each
  stored row is replayed through `configChanged` with its company ID.
- `/app/server/src/routes/plugins.ts:2381–2398`: config saves refresh authorized
  company scopes before notifying the worker.
- `/app/packages/plugins/sdk/src/worker-rpc-host.ts:1802–1849`: SDK default
  single-tenant guard allows identical configurations for different companies.
  The plugin intentionally receives multi-company deliveries then refuses all
  polling when more than one distinct ID arrives, including identical configs.
- `plugins/model-selection/src/worker.ts:213–232` in this repository: prior
  bounded config-delivery pattern. Insight does not copy its multi-company
  polling or persist an instance-wide discovery list.

## Executable proof and boundary

From the plugin directory, in an environment containing an installed stock
Paperclip source tree (the stock harness fails, not skips, if it is absent):

```sh
NODE_ENV=development npm ci --ignore-scripts --no-audit --no-fund
npm run verify
node deploy/worker_host_harness.mjs
PAPERCLIP_ROOT=/app node --import /app/server/node_modules/tsx/dist/loader.mjs \
  deploy/stock_contract_harness.mjs
```

The integration harness imports the **actual** scheduler, worker process manager
and SDK gate from `PAPERCLIP_ROOT`. It runs a real plugin child and calls the
actual scheduler's `tick()`, asserting `trigger: schedule`, no top-level company
ID, one recorded run and a schedule-pointer advance. It does not substitute
manual `triggerJob`, a fabricated scoped invocation or an unconditional SDK
context mock. Real loader startup delivery is mirrored from the cited source;
the loader itself is not run. Storage and HTTP are in-memory fixture adapters,
not a live DB or lane. No actual secret is read; the secret fixture asserts exact
company, ref and `configPath`, but does not prove live secret-binding DB grants.

Nine scenario groups cover unconfigured/disabled/no-secret operation; six GETs
for the sole configured company with scoped config, secret and state calls;
runtime enable/replay/disable; observable two-company refusal, including A,A
replays after refusing B; null-identity delivery before/after a valid binding;
foreign invocation refusal plus direct stock gate negative tests for
config/secret/state; revoked scope; and a failing secret service. Unit tests
separately assert **positive log controls** plus absence of arbitrary error
markers, and config/secret-read races with a second company delivery. Tool and
API config-await race tests require a refusal before any state adapter call.

Refusals emit `cliproxy_insight.company_scope_refused`, value 1, with only the
bounded reason `multiple_companies` or `missing_company_id`. A missing identity
is not assumed impossible: delivery returns without throwing and latches polling
and reads inert until corrected/restarted. The multiple-company latch still
throws on conflicting/replayed delivery and does not silently forget identities.

To reproduce the old failure independently, extract the original immutable
commit to a separate directory, run its locked install, then run this new
harness with `INSIGHT_PACKAGE_ROOT=/absolute/path/to/old/plugins/cliproxy-insight`
and `--baseline`. It asserts the exact rejection with zero and one configured
company and zero side effects. Run without that override for the repaired worker.

The original wire harness remains useful for SDK serialization/request bounds,
but its permissive authorization is **not** evidence of company-scope safety.
Regular plugin unit CI does not run the stock harness without a Paperclip tree;
its result is a separate required review/deployment preflight, not claimed as CI.

## Host acceptance still outstanding

The existing plugin remains disabled. Installation/upgrade, two real cron firings,
live secret-binding validity, fresh-lane state, rollback execution and the
seven-day metric are not verified here. Through the same TOG-3152 host card,
query `plugin_job_runs` joined to `plugin_jobs` and `plugins` for the plugin key
`togetherweown.cliproxy-insight`, starting at the actual deployment instant.
After seven days, company-scope mismatch failures must be zero. Also require
expected firings and fresh telemetry: no failed runs on a disabled/inert plugin
is not successful acceptance.
