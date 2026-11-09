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
integrity alone is not an independent installed-file integrity audit. The held
Insight lock has no registry integrity fields for SDK/shared/Zod: its report
records `integrity: null` and `lockIntegrityFieldsComplete: false`. This is an
explicit adverse baseline, not provenance acceptance or a candidate-install
allowlist. Model-selection's lock must retain its SHA-512 fields. Neither lock
is edited by the fixture. Host Zod, CommonJS resolution and `NODE_PATH` cannot
stand in for these edges.

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
  AbortSignal, so this case alone cannot test signal dropping in the SDK.

A separate tiny `signal-worker.mjs` imports the exact SDK entry resolved from
that built consumer. It supplies a real AbortSignal with a small POST body and
checks three cases: normal, pre-aborted and aborted immediately after dispatch.
The inert host must receive exactly method/headers/body without a signal, and
all three calls must return its response, including the two locally aborted
signals. This measures the held SDK serializer, not the production plugin's
choice to omit a signal, stock HTTP cancellation, network access or stock
capability authorization. No external request occurs. A green result records
signal loss; it does not fix it or establish host cancellation.

Company fixtures are distinct valid GUIDs. These are **plugin/wire negative
controls**, not proof of stock scheduler, worker-manager or authorization gates.
The fixture supplies the `runJob` call itself and cannot prove scheduler or
capability-denial behavior. Reports explicitly set `stockHostQualified` and
`migrationQualified` to false.

## Isolated candidate lock preparation — no installation

The separate `sdk-candidate.yml` Actions workflow prepares an **unapproved lock
artifact** for SDK/shared 2026.831.0 and Zod 4.6.7. It does not change either
plugin's production manifest, lock or build/install steps. `candidate/package.json`
is a private, script-free qualification root, not a release-selected migration.

- Node 24.22.2 supplies npm 11.19.1; a different npm version fails closed, with no
  toolchain upgrade. The fixture requires effective native `min-release-age=3`,
  `ignore-scripts=true`, `engine-strict=true`, optional omission and no age
  exemptions. Configuration/version checks are **not native enforcement probes**.
- Before resolution, `prepare-candidate.mjs` reads exact registry records and
  SHA-512-verifies tarballs. Each download uses a fresh runner-temp directory.
  Only `package/package.json` is read to stdout, without extraction or import.
  It compares relevant registry/tarball metadata, inventories all scripts and
  refuses install/prepare/pack hooks, unexpected dependencies and nonoptional
  peers. Metadata timestamps are an additional check, not a replacement for npm's
  age policy. Registry responses, archive reads and job duration are bounded.
- Native `npm install --package-lock-only --ignore-scripts` resolves a lock;
  **no candidate node_modules may exist before or after it**. The verifier requires
  precisely the three expected package records, no nested/extra copies, matching
  registry SHA-512 and tarball URL, matching engines/dependencies and no install
  scripts. No candidate code or counter/worker fixture runs in this job.
- The SHA-named artifact contains the root manifest, generated lock and metadata
  inventory. It requires review before a separate clean install. The later lane
  must first demonstrate native age/script enforcement with harmless controls,
  check Node22 engine refusal, clean-install the accepted lock and exercise the
  candidate against real consumer artifacts. A green **preparation** job is not a
  clean-install, build, compatibility or containment pass.

## Gates still open

- Minimal v4-native SDK/shared 2026.831.0 with Zod 4.6.7 is qualification-only,
  not release-selected. Both packages require Node >=24.11.0 and are **not a
  Node22 drop-in**. Review the prepared candidate lock/inventory and run native
  enforcement probes before any clean candidate installation. Existing plugin
  install and build steps are unchanged.
- The observed installed-versus-registry metadata differences for 2026.1106.0
  are unresolved. That pair must not be installed before its native age gate;
  a matching version label is not artifact equivalence.
- Locate and exercise the privately maintained stock-service harness with the
  actual supported scheduler/worker-manager/authorization implementation and
  inert adapters. Prove same-company success and denied-capability, missing
  identity and cross-company zero unauthorized effects there. This wire harness
  cannot substitute for it.
- Exercise actual host config-save/Ajv and manifest-load paths, and obtain Actions
  results for the separate AbortSignal serializer probe. HTTP byte caps, a post-readline
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
