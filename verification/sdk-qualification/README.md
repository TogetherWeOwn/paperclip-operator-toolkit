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

`shared-contract.mjs` adds sync/async public-schema controls at each resolved
consumer. Both config-envelope exports must accept two distinct valid GUID company
IDs and reject missing/malformed IDs, arrays and null configs. A tiny nested value
is deliberately accepted: the permissive envelope does not establish key, depth or
collection bounds or validate the plugin's JSON Schema. Built manifests must pass
while wrong API versions and malformed capabilities fail. Reports distinguish these
30 Insight / 32 model-selection cases from host-loader/Ajv routes and authorization.
These additional cases are prepared source pending new-head Actions results.

`zod-collection-counter.mjs` exercises sync and async arrays with at most three
elements. The Zod3 baseline deliberately asserts **three element visits on an
oversized array**, two visits on valid at-limit input, three on an unbounded
array, and zero refinements on a structurally invalid element. A green baseline
therefore **records the affected primitive**, not containment. The same small
probe accepts an explicit zero-visit expectation for the separately reviewed
candidate installed only in the isolated lane described below.

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

The synthetic lane passed at head `103e3ad1c55b6bf20193fac306a4f11c58d34113`
in [job 129125687981](https://github.com/TogetherWeOwn/paperclip-operator-toolkit/actions/runs/42607082044/job/129125687981).
That exact-head evidence covers these steps, not later source changes:

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

### Built-plugin candidate lane — passing runtime subset at a pinned head

At head `103e3ad1c55b6bf20193fac306a4f11c58d34113`, the
[Insight job](https://github.com/TogetherWeOwn/paperclip-operator-toolkit/actions/runs/42607082204/job/129126363623)
and [model-selection job](https://github.com/TogetherWeOwn/paperclip-operator-toolkit/actions/runs/42607082204/job/129133149281)
passed their held Node24/Node22 controls and isolated candidate runtime steps.
This includes tiny bounded/unbounded counters, real worker/wire controls and the
separate signal-loss probe. It does not qualify later source changes or establish
source compilation, stock authorization/scheduling/config routes or migration.
Full CI had not completed at inspection. The shared-contract cases added afterward
remain pending Actions.

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

### Candidate production-source typecheck and rebuild — pinned passing subset

`source-candidate.mjs` adds a separate experiment after the existing candidate
runtime controls. It copies regular files from `src`, the package manifest,
TypeScript config and first-party build script byte-for-byte to a fresh consumer
under the isolated candidate. It never copies or symlinks held node_modules or
rewrites source pins/engines. This is not the earlier held-build experiment.

The existing held development install supplies TypeScript, Node declarations and
esbuild, without a new tool install or a stronger provenance claim for those tools.
The TypeScript API preserves production compiler options (including `skipLibCheck`),
changes the include to **production `src` only**, and explicitly locates the held
Node type declarations. Test-runner types and test files are excluded, so this is
not a full plugin/test typecheck. There are no SDK path aliases. The compiler must
resolve the SDK entry and load SDK/shared/Zod declarations only from the reviewed
candidate closure; the report records those files and versions. Empty input,
diagnostics or held SDK declarations fail. A deliberately incorrect virtual source
must produce TS2322, proving that the checker is active.

After the positive check, the original first-party esbuild script runs with an
empty environment and the staged source as cwd. Its unchanged node22 syntax target
is **not** a candidate engine-compatibility claim. The newly rebuilt artifacts are
hashed and run through the same consumer/schema/counter/real-wire controls against
the candidate. Input bytes must stay unchanged. A JSON report is uploaded even on
a failed typecheck/build/wire step, retaining incomplete flags and diagnostics;
nonzero remains a failed job, never a compatibility pass.

At exact head `2766ecd0ee1fade2a2003b77dff326a186db2853`, the
[Insight job](https://github.com/TogetherWeOwn/paperclip-operator-toolkit/actions/runs/42613038100/job/129146466786)
and [model-selection job](https://github.com/TogetherWeOwn/paperclip-operator-toolkit/actions/runs/42613038100/job/129153065383)
passed. Completed logs contain `sourceTypechecked`, `brokenSourceRejected`,
`rebuilt` and `wireCompleted` all true, followed by source-report uploads. These
jobs also passed the held/candidate shared-schema and runtime subsets. Full CI
was still incomplete at inspection. This qualifies only that head's production
source experiment, not tests/test-runner compilation, stock execution, a Node22
candidate runtime or any later head. Production source engines/pins, release
selection and stock/migration qualification remain unchanged.

## Technical target disposition

The current technical disposition retains the advertised **Node >=22** floor,
node22 build targets and held SDK/shared pins. Node24 CI or one observed Node24
host is not authority to retire that support contract. A Node24-only migration
needs a durable support-scope record naming the covered consumers, exact host and
runtime identities, treatment of Node22 consumers, release boundary and rollback
obligations. Candidate experiments do not supply that decision.

The additional selected disposable stock target is Linux AMD64 image
`ghcr.io/paperclipai/paperclip@sha256:12ae7579165cbf11d8db71ef69cf01ff48660383e78541b6b2eba38939fa30c9`,
associated source `d69631b01b9c658f80bf8bed389863dce82643e1`, expected release
2026.1106.0. Image/source/npm/runtime/candidate identities remain separate. The
selection is preparation only, not permission to install the image early, a passed
stock lifecycle or any release verdict. The 1106 age/install and Security holds
still apply. No image is pulled or run by these candidate fixtures.

## Prepared stock driver — NOT enabled or executed

`stock-driver.mjs` prepares actual supported local-path install/disable/enable,
worker-health, host manifest-load refusal, config-save/test Ajv controls and
Insight's scoped API on the selected stock image. It accepts no endpoint argument,
requires the exact source/release/image evidence, private local-trusted mode and a
network-none namespace, and records the candidate workers' native ESM edges.
Those misuse guards are not approval. The image inspection record must come from
the future authorized Actions lifecycle; a driver receipt cannot establish its
own image authenticity, native-age acceptance, container mounts or approval.

The driver uses only synthetic companies, with polling **disabled**, no secrets
and empty lane lists. Config invalid-object/schema/missing-company controls must
leave persisted config unchanged. An API-version999 manifest in disposable storage
must fail the real loader with an API-version diagnostic and remain unregistered.
A same-company empty-usage control brackets missing-company and unconfigured-company
API refusals. This local-trusted board fixture is not a scoped-agent authorization
test or proof of zero unauthorized host-service calls.

The prepared scheduler observer waits at most six minutes for a new successful
`trigger: schedule` run after the job's published `nextRunAt`. It preserves the
five-minute production cron and the stock clock/DB, never calls the manual trigger
API or invokes `tick()` itself, and rejects manual, historical, foreign and
incomplete receipts. A successful run here would establish scheduled **no-op**
dispatch only; it cannot establish `poll_ok`, telemetry persistence, cancellation,
capability denial or complete containment. All those report flags stay false.
Container/volume removal on normal/failure paths and hosted-VM disposal remain
mandatory in the future lifecycle; the driver must never run against a managed
instance or serve as a standalone deployment instruction.

No workflow invokes the driver, pulls its image or installs stock packages.
`stock-source-controls` runs its syntax check and first-party bridge, config-oracle,
package-completeness, toolchain and receipt-unit controls in Actions, with no dependency
install. These controls do not execute stock callers. The existing age/install/Security
holds must clear before a separately reviewed lifecycle may execute anything stock-related.

The runtime-only wire consumer is not a stock-install package. After its wire check,
`built-candidate.mjs` prepares a separate `candidate/consumers/stock-<plugin>` tree.
`stock-package.mjs` reuses the existing model-selection `requiredPaths` and
`checkCompleteness` contract, copies each declared regular file/directory with byte
hashes (including `migrations/README.md`), and checks completeness again. The disabled
driver accepts only these complete trees and repeats validation before installation.
Staging is first-party source preparation, not stock execution or an install permission.

Config oracle controls use a distinct valid polling-disabled test value and compare
persisted configuration immediately after every rejected request and the valid test.
Synthetic regression controls deliberately persist rejected/test input and require
oracle failure; they are not passing host config-save/test evidence. Bridge deadline
expiry poisons health and pending requests, while refusal controls require structured
worker errors. The intentional plugin HTTP timeout remains a successful RPC plus
metrics/deferred-reply control, never a bridge deadline. Both plugin jobs retain npm
from pinned Node24.22.2 before switching to Node22; the exact npm11 assertion remains.

### Exact remaining fixture prerequisite

The read-only stock1106 source rejects loopback/private HTTP destinations in
`plugin-host-services.js:94-146` and pins DNS before the HTTP request;
`http.fetch` uses that path at `:1437-1451`. Insight's `onValidateConfig` also
refuses polling-enabled loopback or HTTP lanes (`worker.ts:889-915`). A loopback
HTTP adapter in a network-none namespace therefore cannot be the required
same-company telemetry positive. No supported HTTP injection seam was found in
that inspected host service. This is scoped source evidence, not proof that no
safe supported fixture topology exists. Do not disable SSRF, TLS, company gates,
change installed core, repoint to a real lane or treat another plugin's fixture
as success. A supported synthetic telemetry/service observation topology and a
scoped actor/capability fixture preserving these protections remain concrete
prerequisites. Source-only lifecycle preparation continues independently.

### Supported service contract — NOT QUALIFIED

The bounded technical contract confirms that the full positive/negative matrix is
not safely reachable with the currently evidenced network-none, loopback-only,
local-trusted fixture. This is not universal impossibility and not approval to
widen that fixture. `partialStockReport().unqualifiedControls` records each absent
observation as **not-exercised**, never a measured zero. Completing lifecycle,
config and scheduled no-op checks leaves every qualification flag false.

| Missing control | Required positive or denial evidence |
| --- | --- |
| Insight telemetry | Its unchanged five-minute scheduled poll, real company-A secret resolution, two bounded successful aggregate HTTPS reads, nonempty A snapshots and `poll_ok`, with no B activity. Use the real config save/test path; bootstrap config is not company binding. |
| Model-selection telemetry | Its own unchanged two-minute scheduled `pollLaneCapacity`, company-A lane-ledger observation and allowed read of that data. Keep advise mode, inference, mutations and dispatch off. Insight's result does not qualify this worker. |
| HTTP/secret capability denial | Separately labelled native factory/manager cases omit only the relevant capability and require native denial before actual HTTP-service or secret-resolver entry. Count earlier permitted config/secret reads and error metrics honestly. No installed permission-revocation interface has been established. |
| Invocation scope denial | A real-plugin call must reach the native host scope gate with mismatched/absent scope and produce zero target-service delegation. Plugin early refusal is not host scope denial; if no real-plugin trigger reaches it, this row stays inaccessible. |
| Scoped HTTP actor | The same read/tool route succeeds for restricted actor A against A, but rejects A against B and an unauthenticated request before worker dispatch. Local-trusted implicit board access and body/query actor fields cannot satisfy authentication. |

Three prerequisite receipts remain absent:

1. **Supported observation and trigger assembly.** Shipped constructor declarations
   for `createPluginWorkerManager`, `createPluginJobScheduler` and the SDK handler
   factory are source evidence, not proof that the selected image exports accessible
   modules. Server package subpaths are not public exports and the image uses a
   bundle. Verify accessibility and supported assembly before importing. An eventual
   observation adapter may transparently count calls around actual `buildHostServices`
   delegates, preserving arguments, context, values and errors. Never replace HTTP,
   secrets, config or state results, forge invocations, replace the scheduler/DB,
   or label constructor tests installed-app HTTP authorization.
2. **Authorized disposable resources.** No existing authorized routable synthetic
   HTTPS origin, company-bound secret material or restricted actor material has been
   demonstrated. Stock DNS pinning, address checks and certificate validation must
   remain unchanged. Any later topology needs exact path/method/byte budgets, narrow
   egress/DNS, bounded readiness/use, expiry and teardown, without idle recurring cost.
   Mapping a public-looking address to a private service, a forwarding proxy, transport
   replacement or a real lane key is not a workaround. Network widening, new credentials
   and paid resources are not authorized here.
3. **Exact-artifact execution release.** Existing installation/Security holds must
   explicitly clear. The 1106 age threshold is only a necessary native-policy condition,
   not sufficient authority. The driver remains disabled and no widened-network
   lifecycle is added. Operational adoption is outside this source-only experiment.

Any later service-effect ledger must identify plugin, company, invocation/job/run
and observation window; distinguish attempted gated calls from entries **after**
the gate into real HTTP, secret, config/state, activity/metrics and mutation services.
Include an allowed positive in the same observation setup to prove counters are live.
Missing observers, stale/skipped windows and unavailable triggers are unknown, not
zero. Permitted refusal metrics and scheduler bookkeeping are not unauthorized
telemetry/data effects. Neither an empty state snapshot nor an HTTP error establishes
this ledger. Timeout/signal behavior and unsupported opt-in dispatch stay separate.

REA angle: inspect the shipped factory/manager/loader/scheduler assembly to locate
real gates and supported seams, rather than constructing fake authority. If these
receipts cannot safely be obtained, retain NOT QUALIFIED and held pins, record the
exact inaccessible row, and choose a bounded compatible containment/migration
prerequisite through the existing technical and support-scope decision routes.
This is not vulnerability acceptance, permission for an installed core patch or a
passive wait for a vendor.

## Gates still open

- Minimal v4-native SDK/shared 2026.831.0 with Zod 4.6.7 is qualification-only,
  not release-selected. Both packages require Node >=24.11.0 and are **not a
  Node22 drop-in**. The lock review permits only the isolated Actions candidate
  lane after its native probes pass, not a source-pin change. Existing plugin
  install and build steps are unchanged.
- A 2026-11-09 read-only comparison corrects the earlier metadata discrepancy
  report for 2026.1106.0: registry and SHA-512-verified tarball metadata both declare
  Node >=24.11.0, and shared declares `three@0.185.1`. Six selected installed files
  (SDK manifest/root export/worker bridge/host-client factory; shared manifest/plugin
  validator) match their tar members byte-for-byte. This is not whole-tree,
  server/image/transitive integrity or candidate831/host1106 equivalence. The 1106
  pair remains barred from installation until after 2026-11-09T22:20:56.514Z and
  native age-policy acceptance, without exception. No 1106 package was installed,
  extracted, imported or executed for this read-only comparison.
- Prepare and, only after the installation/Security holds clear, exercise the
  selected disposable stock target through supported local-path lifecycle/APIs.
  Prove actual scheduler/worker-manager behavior, same-company success and
  denied-capability, missing-identity and cross-company zero unauthorized effects.
  If a required caller has no safely reachable trigger/readiness contract, record
  that exact prerequisite rather than replacing it with mocks or a core patch.
  This wire harness and another plugin's lifecycle results cannot substitute for it.
- Exercise actual host config-save/Ajv and manifest-load paths. Passing shared-schema
  or wire/signal probes cannot satisfy these caller boundaries. HTTP byte caps, a
  post-readline character guard, pre-JSON allocation, collection/key/depth bounds and
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
