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

## Isolated candidate lane — not a plugin migration

The separate `sdk-candidate.yml` Actions workflow uses SDK/shared 2026.831.0 and
Zod 4.6.7 in a private, script-free qualification root. Neither plugin's production
manifest, lock or held build/install steps change. Separate steps in each plugin
suite also prepare a candidate install and stage only the already-built artifacts
against it; the production consumer's node_modules tree remains untouched. Preparation passed in [run
42601371360](https://github.com/TogetherWeOwn/paperclip-operator-toolkit/actions/runs/42601371360)
at head `70af260adf83e3251714798167f804409fc5056d`. The checked-in candidate lock
is byte-identical to its reviewed artifact, SHA-256
`98a19aece777ef6f5e9ee00f006927da3c3be77cb22934ee9d3077927bd5722b`.
The old artifact's name used GitHub's synthetic merge SHA, not the PR head; the run
API identifies the head above. New artifacts explicitly use the PR head SHA.

The **new clean-install/probe steps are prepared, not yet passing evidence**:

- Node 24.22.2 supplies npm 11.19.1; a different npm version fails closed, with no
  toolchain upgrade. Effective native policy is `min-release-age=3`,
  `ignore-scripts=true`, `engine-strict=true`, optional omission, no exemptions.
- Before installing anything, `prepare-candidate.mjs` reads registry records and
  SHA-512-verifies tarballs as inert data. Downloads have fresh runner-temp
  directories. Only `package/package.json` is read to stdout, without extraction
  or import. Relevant metadata must match, with no install/prepare/pack hooks,
  unexpected dependencies or mandatory peers. Responses and archive reads are
  bounded. The accepted lock must contain precisely the three reviewed packages,
  matching URLs/integrities, engines and dependency closure; no node_modules may
  exist at this preflight boundary. Existing locks do not retrospectively prove
  publication age; the independent metadata age check remains required.
- `native-policy.mjs` supplies a loopback-only first-party registry with a tiny
  ten-day-old and one-hour-old synthetic release. Native npm must install the old
  release, select it over a fresh latest release and refuse an exact fresh pin
  without fetching its tarball. Root/dependency marker hooks must not run under
  the candidate's policy. A named command must still run. A separate synthetic
  root enables only these authored marker hooks as a differential positive
  control; the real candidate's settings never change and has no exceptions.
  This is a native-manager test, not a replacement installer or registry policy.
- Under Node22, the same retained npm11 CLI must refuse `npm ci` with EBADENGINE,
  without materializing node_modules or changing the lock. This is a negative
  engine control, not a claim that all supported consumers have moved to Node24.
- Only after all preceding controls pass does Node24 run native `npm ci
  --ignore-scripts` in the isolated candidate root. `candidate-contract.mjs`
  follows synthetic-consumer → SDK → shared/Zod ESM edges inside that install,
  imports published JavaScript exports and runs the tiny sync/async counters
  with a zero-visit bounded-overflow expectation. Unbounded arrays must still
  traverse three elements. No downloaded build command or hook is required/run.
- The source/lock must remain unchanged. The artifact records inventory, native
  controls and synthetic candidate report, explicitly retaining
  `stockHostQualified: false` and `migrationQualified: false`. A synthetic import
  or counter pass is not either real plugin's compatibility, a stock scheduler,
  authorization/config result, complete containment or release approval.

### Built-plugin candidate lane — prepared, not yet passing

At head `efb3f7d642521b225a18b427cbba9574fd01ab5e`, [the native policy
job](https://github.com/TogetherWeOwn/paperclip-operator-toolkit/actions/runs/42604290875/job/129116153603)
failed before candidate installation: the authored marker helper used
`process.argv[1]` (its own script path) instead of `process.argv[2]` (the marker
filename). The fix also asserts that the helper stays unchanged. This was a
fixture defect, not demonstrated native-policy failure. No candidate-install or
probe pass is inherited from that run.

Both plugin jobs now retain their held Node24/Node22 wire controls, then separately
require native Node22 candidate refusal, Node24 artifact/lock preflight and native
age/script enforcement before an isolated `npm ci --ignore-scripts`. The reviewed
candidate root has no install/build hooks or script exemptions. The existing
held installs/builds and their provenance limits are not silently strengthened by
this separate lane.

`built-candidate.mjs` stages byte-identical `dist/worker.js`, `dist/manifest.js`
and `package.json` under the candidate root, records their SHA-256 hashes, and
never copies source-consumer node_modules. `wire.mjs` then starts that real built
worker, resolving its external SDK through its own staged location. Every ESM
edge must land in the isolated candidate's reviewed three-package closure, never
the held plugin's install or host. The actual shared manifest validator, tiny
Zod4 counters, real worker handshakes, Insight job/tool/API controls and separate
signal probe run against that candidate. A failed assertion, missing artifact,
dead worker or timeout fails the job; no success report is written before wire
completion. Each job uploads its own candidate provenance and results.

This is a **runtime experiment on the held build**, not source compilation or
typechecking against the candidate SDK. Copied manifests intentionally retain
their held source pin and Node22 engine declaration as evidence, not as a false
candidate support claim. Reports retain `migrationQualified: false` and
`stockHostQualified: false`. It remains insufficient for stock authorization,
config-route/scheduler qualification, source migration or operational adoption.

## Gates still open

- Minimal v4-native SDK/shared 2026.831.0 with Zod 4.6.7 is qualification-only,
  not release-selected. Both packages require Node >=24.11.0 and are **not a
  Node22 drop-in**. The lock review permits only the isolated Actions candidate
  lane after its native probes pass, not a source-pin change. Existing plugin
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
