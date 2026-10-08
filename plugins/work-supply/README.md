# Work supply — native shadow package

**Version 0.2.0 adds a loadable Paperclip API-v1 manifest, worker and five scheduled handlers to the
shadow decision kernel. It is NOT parity-ready or a live replacement for host reconcilers.** The
complete native read adapter is unavailable on the inspected SDK; the actual worker fails closed
instead of manufacturing an empty census. Installing this package alone does not start meaningful
shadowing. `mode: "live"` and `mode: "apply"` remain rejected. Keep host reconcilers authoritative.

The kernel separates deterministic decisions from collection and execution. Initial policies are
derived from the requested behavior, **not verified parity with existing host scripts**. Native
collection, governed effects, source parity, independent review and rollout remain separate gates.
There is no HTTP client, shell collector, credential access, agent tool or core mutation method.

## Package and native scheduling

`package.json.paperclipPlugin` points to `src/manifest.mjs` and `src/worker.mjs`. Source modules are
shipped directly; no build step is required. Node 24 and the host's compatible API-v1
`@paperclipai/plugin-sdk` peer are required. The inspected SDK source identifies itself as 1.0.0;
compatibility with a different deployed build must be verified, not inferred from a package name.

```sh
npm pack ./plugins/work-supply --pack-destination "$PAPERCLIP_RUN_SCRATCH_DIR"
```

This creates a candidate package, not an installation receipt. Verify the tarball's paths,
checksum, SDK peer resolution and same-head review/CI before any Operator installation into a
**new versioned immutable package path**. Do not reuse an existing package path, POST configuration,
change tool policies or retire timers as a packaging shortcut.

All five manifest jobs fire every five minutes at an off-minute start. Their company-specific
callbacks are serialized so concurrent scheduled invocations cannot overwrite shadow state or
starve four jobs behind the kernel's busy fence. Different company queues start independently, so
one stalled company does not prevent the others from running. Company scope is taken only from host-delivered
`onConfigChanged` context; no company enumeration or caller-provided company identity is used.
The worker reloads each company's config with `ctx.config.get(companyId)` for each firing.

The ledger is stored in Paperclip's **plugin DB-backed state store**, with
`scopeKind: "company"`, `namespace: "work-supply"`, `stateKey: "shadow-ledger-v1"`. One plugin worker
owns this ledger. This is not a distributed CAS or a claim for core effects; do not run multiple
independent instances sharing it. An unavailable/failed write is a failed job, never success.
`ctx.data` exposes the scoped `shadow-ledger` read, and `onHealth` returns bounded per-job status;
job failures also throw and log allowlisted codes. Registry display of these diagnostics and real
host scheduling/storage remain unverified until deployment acceptance.

`createSupplyPlugin({ collect, pressure, clock })` is an offline integration seam, exercised with
fixtures in tests. The shipped `worker.mjs` supplies **no fake collector**: unpausing it produces
`native-snapshot-source-unavailable`. Paused firings and missing-source failures do not count toward
a 2–4-hour parity window. A reviewed supported native read adapter must land before that window.

## Host pressure guard

Every unpaused firing with an available collector reads fixed PSI paths under `/proc/pressure`
and filesystem statistics for `/` and `/home` before collecting or proposing any action:

- CPU `some avg10` > 30%, IO `some avg10` > 30%, or memory `full avg10` > 5%: suppress all proposals.
- Root used >= 93% or home used >= 95%: suppress all proposals. Filesystem usage follows `df`'s
  reserved-block-aware, rounded-up percentage; safe integer/BigInt arithmetic avoids overflow.
- Missing/malformed/out-of-range/stale/future metrics, a read failure or unverified mount provenance
  fail closed. Freshness is at most 60 seconds. CPU/memory limit equality is permitted; disk
  equality is held. The same sample is revalidated before/after snapshot collection and immediately
  before each state write; a slow dependency cannot consume observation budget using expired pressure.

`hostPressureScopeVerified` defaults false. The Operator must prove that these paths describe the
**actual host**, not a container-only filesystem, before setting it true through the sanctioned
configuration path. Reading files successfully does not establish that scope. Pressure-held
firings record zero observations without consuming the ledger/cooldown; they are not agreement
samples. PSI semantics: https://docs.kernel.org/accounting/psi.html. Filesystem API:
https://nodejs.org/api/fs.html#class-fsstatfs. Exact parity with an unavailable host helper is
unverified; the thresholds above implement the specified contract.

## Run

Node.js 24; no npm install, credentials, network, database or services:

```sh
node --test plugins/work-supply/test/*.test.mjs
```

CI runs the same command in the required Offline suites job while Node 24 is selected. The
first-party test runner is documented at https://nodejs.org/docs/latest-v24.x/api/test.html#running-tests-from-the-command-line.

## Five decision functions

| Job | Shadow proposal | Guardrails |
| --- | --- | --- |
| `prSupply` | Create an owner intent for an unowned open PR; otherwise suggest its next action. | Configured/admitted repository only; no duplicate/ambiguous owner; holds, blocked owners, human waits and live runs are barriers. |
| `backlogFloor` | Promote enough existing eligible backlog cards to fill the configured runnable todo deficit. | Project rank and fallback assignee come from config; skips non-admitted projects, closed-PR cards, unavailable agents and every barrier above. |
| `idleWake` | Continue one best runnable card per idle agent. | Existing in-progress work first; then project rank, issue priority, age and ID. Native admission evidence must permit waking. |
| `reviewReconcile` | Suggest rereview for missing/error/stale-head/less-than-5 review, or merge when all known gates pass. | Same-head 5/5, successful required CI, non-draft and positively mergeable are all required for a merge suggestion. Pending/unknown CI alone does not trigger a wake to poll. |
| `intentSweep` | Inspect pending intent IDs only. | **No rejection/acceptance policy yet.** The original evidence predicates and a governed native autonomous-decline operation are required before implementing one. Free text cannot authorize a credential decision. |

A PR at least 14 days old carries `finishOrClose: true` on its owning-card wake suggestion.
The kernel never closes a PR or merges it. Drafts, conflicts, red checks and requested changes
produce corresponding next-action hints. Supply and review produce identical fingerprints for
identical PR wake intents, allowing shared cooldown suppression.

Ownership is determined only from explicit native work-product associations normalized as
`pullRequestIds`; title/comment/body matching is deliberately absent. A blocked owner is still an
owner: its barrier must never be bypassed by creating another card. Closed cards do not own open
work; a still-open PR may require a new owning-card intent. Native collectors/executors must
reconcile prior plugin-origin ownership intents before any creation.

## Boundary contract

Use `planJob(job, snapshot, config, now)` as the validated public planning entrypoint. Exported
individual planners and `nextPrAction` expect already-validated normalized records. All timestamps
are safe nonnegative integer milliseconds, never human-readable date strings. Unknown evidence
must not be normalized into a false barrier or successful gate.

Configuration starts from `config.example.json`: paused, shadow-only, no admitted projects or
repositories. Project entries are `{ id, rank, admitted, assigneeAgentId }`; an assignee can be null.
Repository entries are `{ repo: "owner/name", projectId }`. Each job has separate per-run and
rolling-hour caps. Lower project rank wins. Project or assignee maps contain no company-specific
values in code. The kernel does not decide routing, model placement, budgets or admission.

A snapshot has:

- `companyId`, `capturedAt`, `complete: true` and arrays `issues`, `agents`, `prs`, `intents`.
  All pages and applicable repositories must have been read successfully. A truncated list,
  denied source, missing collection, foreign company, duplicate identity or stale/future timestamp
  fails closed. Empty complete arrays are valid; a source failure is not an empty array.
- Issues: `id`, `companyId`, `projectId`, `status`, `priority`, `createdAt`, `updatedAt`, nullable
  `assigneeAgentId` and `assigneeUserId`, explicit booleans `held`, `blocked`, `awaitingInput`,
  `liveRun`, `runnable`, `prState: "none" | "open" | "closed"`, and `pullRequestIds`.
  Collectors must include native tree holds, blockers, interactions/review waits, queued/running
  invocations and quota/admission barriers in these fields. `runnable` is positive native evidence,
  not merely the absence of a visible error.
- Agents: `id`, `companyId`, `status: "idle" | "running" | "paused" | "error" | "terminated"`,
  and `canWake`, derived from native budget/admission/hold evidence. Running agents can own supplied
  todo cards but cannot receive an `idleWake` suggestion.
- PRs: `id`, `companyId`, `repo`, `state: "open" | "closed" | "merged"`, `createdAt`, `headSha`,
  `draft`, `ciState: "success" | "failure" | "pending" | "unknown"`,
  `reviewState: "missing" | "error" | "pending" | "changes_requested" | "approved"`, nullable
  `reviewHeadSha`, nullable `reviewScore` (0–5), and nullable boolean `mergeable`.
  CI success must mean all required checks for `headSha`, not one green check. Review evidence must
  name that head. PR IDs must be stable, repository-qualified or globally unique.
- Intents: `id`, `companyId`, `issueId`, `status: "pending" | "resolved"`. Other text is ignored.
  The collector must narrow this collection to the applicable connection-intent type; the kernel
  cannot infer its type from wording.

Proposal keys are SHA256 of canonical intent fields, not of an attempt timestamp. A changed PR
head/next action or issue version is a different wake/promotion intent. Wake and promotion proposals
include `expectedUpdatedAt`; pending reviews bound to an obsolete head request current-head review.
A native executor must re-read the target, verify current head/version, ownership, admission and
barriers immediately before applying.

## Shadow ledger contract

`ShadowRunner({ store, collect, clock })` has one `run(job, config)` entrypoint. `store.get(companyId)`
returns null or a persisted version-1 ledger; undefined is rejected. `store.set(companyId, ledger)`
must durably replace it or throw. A throwing write can still have committed: the runner never
attempts a compensating overwrite and re-reads persisted state on the next invocation.
`collect(job, companyId)` returns a complete normalized snapshot or throws. `clock()` is injectable
for deterministic tests. There is deliberately **no apply callback**.

- Pause does no collection or ledger I/O. Configuration is captured per invocation before its first
  await; changing a caller's object cannot redirect writes, change that run's policy or strand a fence.
- One runner instance fences all overlapping jobs per company, before any I/O. Different companies
  remain independent. A busy callback returns `status: "busy"`; it does not steal work.
- Proposal records persist across runner restarts with cooldown dedupe, first/last observation time,
  per-job rolling-hour observation counts, and bounded health results. Core resources are untouched.
- Ledger keys are retained, not silently evicted. Reaching `maxLedgerEntries` fails loudly. A native
  retention/reconciliation policy must be specified before deployment; this is not a TTL-based
  exactly-once claim.
- Errors are thrown as stable codes. Every dependency boundary normalizes even dependency-owned
  `SupplyError` values. Health stores allowlisted codes/counts/times only, never raw upstream bodies,
  credentials or stack traces. Corrupt/foreign state, mismatched payload fingerprints, unknown
  persisted fields and invalid observation/health records are rejected without rewriting them.
- Failed ledger writes are not success. Error-health persistence is attempted only before any
  observation write starts; it may be unavailable. The native job wrapper must surface the thrown
  failure even if ledger health cannot be written. Unknown committed writes are never rolled back
  to an older ledger. Returned proposals are detached from the value handed to the store.

**The process-local fence is not a distributed durable claim.** Multiple runner instances must not
share a read-modify-write store. No claim of exactly-once writes is made: this runner writes shadow
observations only. Live actions require a unique plugin-DB claim, payload binding, a persisted
in-flight/unknown state before mutation and reconciliation after an ambiguous outcome. A timeout
must never become permission to retry an unknown effect.

## Native integration gates — remaining before parity and cutover

Official Paperclip source: https://github.com/paperclipai/paperclip

Authoring guidance: `doc/plugins/PLUGIN_AUTHORING_GUIDE.md`, particularly "Plugin database
declarations"; SDK contracts: `packages/plugins/sdk/src/types.ts`.

Verified SDK/runtime design constraints in the inspected source:

1. All five `jobs[]` declarations and `ctx.jobs.register` handlers are packaged. Scheduled context
   has no agent identity. The worker uses explicitly host-configured company scopes; listing
   companies is not authorization. Verify real scheduled invocation/scope behavior on the exact
   installed host build before counting a shadow window.
2. Use `manifest.database` migrations and the plugin SQL namespace for atomic unique claims.
   `ctx.state.set` is a blind JSON upsert, not CAS. A single conditional SQL statement can claim an
   intent; there is no transaction spanning that claim and native issue creation. Reconcile plugin
   origin IDs after a crash. See the authoring guide's "Plugin database declarations" section.
3. Use native issue create/update/wake and orchestration summaries. A plugin job run ID is not a
   heartbeat run ID; do not impersonate checkout ownership or invent a recovery run.
4. Supply a supported existing-connection GitHub bridge and native work-product access. The inspected
   `PluginContext` has no `connections` or `workProducts` client. The agent connection-token broker
   requires an active agent heartbeat; it is not a scheduled-plugin credential source. Do not route
   around this with raw credentials, direct core DB access, a localhost fetch or host shell.
5. Preserve interaction authorization. The inspected plugin interaction response method needs an
   authenticated human actor; a sweeper must not fabricate that identity. Keep `intentSweep`
   inspection-only until an explicit governed evidence-based operation exists.
6. Export per-job health through a supported plugin-status surface. The existence of worker
   `onHealth` does not prove the current registry health route displays those diagnostics.
7. Install only a reviewed versioned package, with no configuration POST shortcut. Any changed tool
   policies need their security gate. Shadow alongside host reconcilers for a few hours, compare
   actions, approve cutover, and only then retire each corresponding timer/watchdog entry. Pause or
   restore host authority is the rollback; never dual-enable mutation owners.

This slice does not perform any of those installation, activation or retirement steps.
