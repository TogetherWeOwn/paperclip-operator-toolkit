# SDK consumer qualification — partial

This directory establishes a **held-pin baseline**, not a security fix, SDK
migration, installation approval or stock-host qualification. No production
manifest, dependency pin, lockfile, installed package, host or grant is changed.

## Evidence generated in Actions

The two plugin suite jobs build the real workers on Node 24, then execute this
fixture on Node 24 and Node 22 against that same artifact and installation:

```sh
node --experimental-import-meta-resolve ../../verification/sdk-qualification/wire.mjs .
```

Run from the plugin directory after its existing clean install and build. Full
suites and qualification run in GitHub Actions, not on the operator host. Each
JSON report records the actual Node version. The Node 22 pass exercises the
advertised baseline runtime; it does not qualify a future Node24-only SDK.

`consumer.mjs` uses Node's native **ESM import resolution** with each built
worker as the first parent, followed by SDK → shared and both SDK/shared → Zod
edges. It records consumer-relative paths, versions, package engines and lock
integrities, requires resolution inside that consumer's install, and compares
all relevant lock copies with the narrow held allowlist:

| Consumer | Held version |
| --- | --- |
| Insight and model-selection SDK | 2026.824.1 |
| Their shared package copies | 2026.824.1 |
| Their Zod copies | 3.25.76 |

This is intentionally not a generic override allowlist. Unexpected versions fail
rather than silently changing the experiment. The installed identities are
compared with the lock used by the clean Actions install; printing a lock
integrity alone is not an independent installed-file integrity audit. Host Zod,
CommonJS resolution and `NODE_PATH` cannot stand in for these edges.

The actual shared validator parses each built API-version1 manifest separately
from worker initialization. The default model-selection artifact must omit
`run.model.resolve`; the held shared schema must reject its opt-in declaration.
No type cast or direct callback invocation counts as a stock RPC dispatcher.

`zod-collection-counter.mjs` exercises sync and async arrays with at most three
elements. The Zod3 baseline deliberately asserts **three element visits on an
oversized array**, two visits on valid at-limit input, three on an unbounded
array, and zero refinements on a structurally invalid element. A green baseline
therefore **records the affected primitive**, not containment. The same small
probe accepts an explicit zero-visit expectation for a separately reviewed
patched candidate; no such candidate is installed by these jobs.

## Real worker wire evidence, not stock authorization

`worker-bridge.mjs` launches the actual built entrypoint in a separate Node
process with an empty environment and pipe-only JSON-RPC. Inert, explicitly
allowlisted replies replace external services. There is no network, database,
live credential or scheduler invocation. A dead-process control must fail;
unknown services, early exits, malformed wire output and RPC deadlines fail the
fixture. Children are terminated and reaped in `finally` blocks.

Both workers must initialize through their real `definePlugin`/`runWorker`
entrypoint and refuse unknown jobs and unsupported run-resolve calls. For
Insight, additional cases require:

- A same-company positive job that reads config, resolves a synthetic reference,
  sends one inert HTTP RPC and reaches `poll_ok`, plus successful tool/API calls.
- Missing identity, cross-company tool/API access and an identical second-company
  config replay: polling/service access must stay inert (scope metrics allowed).
- A deferred host HTTP reply: the plugin must stop awaiting within its budget,
  report timeout without `poll_ok`, and still answer a health request. The
  fixture then settles the deferred reply and reaps the child. It does **not**
  assert cancellation of host work. The current plugin does not send an
  AbortSignal, so this case makes no claim to test signal dropping in the SDK.

Company fixtures are distinct valid GUIDs. These are **plugin/wire negative
controls**, not proof of stock scheduler, worker-manager or authorization gates.
The fixture supplies the `runJob` call itself and cannot prove scheduler or
capability-denial behavior. Reports explicitly set `stockHostQualified` and
`migrationQualified` to false.

## Gates still open

- Minimal v4-native SDK/shared 2026.831.0 with Zod 4.6.7 is qualification-only,
  not release-selected. Both packages require Node >=24.11.0 and are **not a
  Node22 drop-in**. Before candidate installation, retain native three-day
  release-age and script controls, review the isolated candidate lock and
  install-hook inventory, and compare all held copies. Existing install and
  build steps are unchanged by this fixture.
- The observed installed-versus-registry metadata differences for 2026.1106.0
  are unresolved. That pair must not be installed before its native age gate;
  a matching version label is not artifact equivalence.
- Locate and exercise the privately maintained stock-service harness with the
  actual supported scheduler/worker-manager/authorization implementation and
  inert adapters. Prove same-company success and denied-capability, missing
  identity and cross-company zero unauthorized effects there. This wire harness
  cannot substitute for it.
- Exercise actual host config-save/Ajv and manifest-load paths, and separately
  characterize AbortSignal serialization. HTTP byte caps, a post-readline
  character guard, pre-JSON allocation, collection/key/depth bounds and
  pre-Zod traversal are different boundaries. No complete containment is claimed.
- Zod4 early size rejection leaves unbounded schemas unchanged. Source migration
  requires a supported caller/engine contract, bounded compatibility verdict,
  explicit allowed pins, exact-head Actions/Devin, Security then QA. Operational
  adoption remains separately gated.

Dispatch SDK/shared **2026.817.0 stays unchanged**. Its checked-in worker imports
SDK at runtime despite its dev-only lock classification; that observation is
retained, not treated as a waiver or automatic migration instruction.

REA angle: exercise shipped ESM exports, shared validators and actual built
worker transport rather than a replacement resolver, an in-memory SDK harness,
or an installed runtime patch.
