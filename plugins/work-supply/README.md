# Work supply — shadow decision kernel

**This is the first, offline-only slice, not an installable Paperclip plugin.** It has no worker,
manifest, scheduler registration, network client, credential access or core mutation method. It
cannot replace a host reconciler. `mode: "live"` is rejected, even when passed by a caller that
intends to apply the returned actions. Keep existing reconcilers authoritative.

The kernel separates deterministic decisions from collection and execution so a future native
plugin can compare intended actions without duplicating live writes. Initial policies are derived
from the requested work-supply behavior, **not verified parity with existing host scripts**.
Source parity, the native integration, independent review and rollout are separate gates.

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

## Native integration requirements — still unimplemented

Official Paperclip source: https://github.com/paperclipai/paperclip

Authoring guidance: `doc/plugins/PLUGIN_AUTHORING_GUIDE.md`, particularly "Plugin database
declarations"; SDK contracts: `packages/plugins/sdk/src/types.ts`.

Verified SDK/runtime design constraints in the inspected source:

1. Declare all five `jobs[]` and register each handler through `ctx.jobs.register`. Scheduled context
   has no agent identity. Restrict proactive company access to explicitly configured company scopes;
   listing companies is not authorization.
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
