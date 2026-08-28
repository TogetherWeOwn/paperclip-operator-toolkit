# gh-token-broker

Mints least-privilege, repo-scoped GitHub App installation tokens for agent runs.
The App private key is resolved **inside the host process** and never enters an
agent's address space.

Built for **TOG-174**. Decision record: the operator's answers on interaction
`803f518f` — control-plane broker, delivered as a plugin rather than a core
patch, because `api.routes.register` + `secrets.read-ref` + `http.outbound`
supply every piece needed and we run a pinned image.

## Why

`GH_APP_PRIVATE_KEY` currently projects into agent run environments as a plain
env var. That key mints a token with ~81 permissions across all 7 org repos,
including `organization_administration: write` and `members: write`. Per
**TOG-191**, every same-uid process can also read it out of `/proc`, so the
per-agent binding list is not a boundary.

This broker inverts the flow: the agent asks the host for a token, and only a
narrow, short-lived, repo-scoped token crosses back.

## Routes

Both are `auth: "agent"` — a board session cannot call either.

### `GET /api/plugins/gh-token-broker/api/whoami?companyId=<uuid>`

De-risk probe. Echoes the host-derived actor and does nothing else — no secret
resolution, no outbound call. Safe to leave installed.

```json
{ "ok": true, "actorType": "agent", "agentId": "…", "runId": "…", "companyId": "…" }
```

`actorType`, `agentId` and `companyId` are **host-derived on every auth path** —
the caller cannot influence them. **`runId` is the exception**, and an earlier
revision of this file said otherwise. See
[what a mint record proves about `runId`](#what-a-mint-record-proves-about-runid).

### `POST /api/plugins/gh-token-broker/api/issues/:issueId/external-disclosures/preflight`

Read-only production preflight for the task-specific external mutation gate
added after
[`TOG-574`](../../docs/incidents/TOG-574-unauthorized-private-vendor-disclosure.md).
The request carries one signed immutable grant, the exact approval-record text,
and the exact artifact bodies. The broker:

1. verifies the signature and exact approval/artifact hashes;
2. requires the host-propagated actor source to be `agent_jwt` (current hosts do
   not propagate it yet, so production fails closed until that host change lands),
   then resolves the signed run against `public.heartbeat_runs`, requiring a
   current `running` row for the calling agent and route issue;
3. retains the host-recorded session ID rather than copying the run ID;
4. mints the configured GitHub App token to the signed repository/permission
   subset and verifies GitHub's actual returned grant; and
5. renders separate `capability`, `authority`, and `mutation` objects before any
   external mutation, then records a five-minute one-shot `preflightId` bound to
   the canonical grant and request hashes.

### `POST /api/plugins/gh-token-broker/api/issues/:issueId/external-disclosures`

The submit body is the same exact request plus the returned `preflightId`.
The broker recomputes every capability and authority check, then atomically
changes the server-side grant row from `preflighted` to `claimed` only when the
confirmation is present, unexpired, unconsumed, and bound to the same request.
Missing, expired, replayed, or substituted confirmations fail before the
external request. It then performs the mutation inside the broker and finalizes
the same row as the redacted receipt.

The receipt retains the response status/identifier, preflight/approval IDs,
approval and artifact hashes, host-derived issue/run/actual session identity,
token issue/expiry, installation ID, repository selection/list and effective
permissions. It never retains or returns the token, App private key, approval
text, private artifact body, or remote response body.

Production supports only the exact configured GitHub App principal. A human
principal grant is deliberately refused; human-token handling exists only in the
offline protocol fixture to prove principal substitution fails closed.

The checked-in repository provisions no real authorizer public key. Operators
must independently add a legitimate Ed25519 authorizer entry to the broker's
`externalDisclosureAuthorizers` config before any real grant can pass. The test
suite generates a fresh fixture keypair at runtime.

### `POST /api/plugins/gh-token-broker/api/issues/:issueId/github-token`

Mints the token. Request body is optional; both fields may only *narrow* the
scope the server derived:

```jsonc
{
  "repositories": ["nntune"],                 // optional, must be within scope
  "permissions": { "contents": "write" }      // optional, must be within profile
}
```

Response:

```jsonc
{
  "token": "ghs_…",
  "expiresAt": "2026-08-23T18:00:00Z",
  "repositories": ["nntune"],
  "permissions": { "contents": "write", "…": "…" },
  "scope": { "repoSource": "project", "profileSource": "default" },
  "ciVisibility": {                            // advisory; see below
    "observable": true,
    "readable": ["checks", "statuses"],
    "blind": [],
    "withheld": { "actions": "withheld by decision: actions:read also grants …" },
    "warning": null
  }
}
```

### `ciVisibility` — what the mint can and cannot see (TOG-247)

The default profile grants `checks:read` and `statuses:read`, so a token minted
from it **can** observe whether its own PR passed. It does **not** grant
`actions:read`, and that absence is a decision — see below.

This matters because the natural way to ask "did CI pass" fails *green* in two
directions, and one of them survives granting the permission:

| what happens | HTTP | what a naive gate concludes |
|---|---|---|
| token lacks `checks:read` | `403` | parses `.check_runs` out of the error body, gets nothing, reads it as "no CI configured" |
| token has `checks:read`, ref has no runs yet | `200`, `total_count: 0` | "all zero runs succeeded" — vacuously true |

So the mint response states its own visibility outright rather than leaving the
caller to discover it at a merge gate. It is **advisory only**: it changes what
the caller knows, never what the token can do. The grant is decided by the
profile and by GitHub, and re-deciding it here would be a second source of truth
for the blast radius.

`observable` is computed from **what GitHub actually granted**, not from what was
requested — if the App's own ceiling is narrower than the profile, the caller is
told it is blind based on the real grant.

#### Why `actions:read` is refused

`blind` and `withheld` are separate fields on purpose. `blind` is a gap someone
might reasonably close; `withheld` is a decision they should not.

Measured against the live installation, 2026-08-24:

| token permissions | `check-runs` | `actions/runs` | `commits/{sha}/status` | `runs/{id}/logs` |
|---|---|---|---|---|
| `contents,pull_requests,issues,metadata` (the old default) | `403` | `403` | `403` | `403` |
| … `+ workflows:write` (what Ops Tooling has) | `403` | `403` | `403` | `403` — `workflows` does not help |
| … `+ checks:read, statuses:read` (**the default**) | `200` | `403` | `200` | `403` |
| … `+ actions:read, checks:read` | `200` | `200` | `403` | `200` — 47 KB zip |

That last cell is the whole decision. `actions:read` also grants full workflow
**log** download, and logs carry whatever CI printed, including an accidentally
echoed secret; check-run *conclusions* do not. Under TOG-191 every agent on this
host shares uid 1000 and can read every other agent's environment, so granting
the fleet a log-download capability to answer "is my PR green" is a bad trade
when the conclusions already answer it.

The accepted cost, stated plainly: a red check shows as red with **no reason
attached**, and whoever picks it up reproduces the failure locally. That is a
real recurring inconvenience, and it was chosen over a standing exfiltration
path. Do not add `actions:read` back as a convenience.

Note `statuses` is a **separate** permission from `checks`: a token holding
`actions:read` and `checks:read` still gets `403` from `/commits/{ref}/status`,
so a repo whose CI posts commit statuses rather than check runs stays invisible
to a checks-only grant. Both are granted, and `ciVisibility` reports the three
sources separately for that reason.

Both new permissions are **read**, never write. `checks` and `statuses` exist as
`write` on this App, and granting at that level would let any agent POST a
fabricated check run or commit status — that is, mark its own PR green.

The consuming side of this contract is [`gh_ci_status.sh`](../../gh_ci_status.sh)
at the repo root, which turns the three sources into a three-state verdict and
exits non-zero on `unknown`.

## How scope is derived

Entirely server-side, from the issue the caller demonstrably holds:

1. **Repositories** — `GH_APP_REPOS` on the issue's project, falling back to the
   repo URL of the issue's primary workspace. All seven projects now pin it; see
   the table below.
2. **Permissions** — `GH_APP_PERMISSIONS` on the project, falling back to the
   default profile: `contents:write`, `pull_requests:write`, `issues:write`,
   `metadata:read`, `checks:read`, `statuses:read`.

A project's `GH_APP_PERMISSIONS` **replaces** the default profile rather than
intersecting with it. That is deliberate: a project must be able to grant
`workflows:write` (Ops Tooling does) *and* to narrow below the default, and
intersection would quietly make the second case impossible.

> **Consequence, and it bites.** A project that pins `GH_APP_PERMISSIONS` does
> **not** inherit later additions to the default profile. When TOG-247 added
> `checks:read` and `statuses:read`, Ops Tooling was the one project with a pin
> — so it would have stayed CI-blind while the six unpinned projects gained
> visibility, in the very repo the issue was found in. Its pin was updated by
> hand at the same time. **If you add a permission to the default profile, audit
> the pinned projects in the same change**, or the change is a silent no-op
> exactly where someone already cared enough to pin.

`workflows:write` is deliberately **not** in the default profile and is granted
per project. GitHub rejects an entire ref push when a branch touches
`.github/workflows/**` without it, so it is not a safe global default in either
direction.

### Env binding shape

Project `env` values are an `EnvBinding` union — a bare string, or a tagged
`plain` / `secret_ref` / `user_secret_ref` object. **Every GH-configured project
in this company uses the tagged `plain` form.** Reading only the bare-string case
makes project scoping silently inert: repos fall through to the workspace URL and
Ops Tooling loses `workflows:write`, while `profileSource` still reports
`"default"` in the audit log.

`secret_ref` and `user_secret_ref` are treated as **absent**, never resolved and
never stringified. Scope is derived from operator-visible literals only; a secret
value must never become a repo name. An underivable scope is a `409`, not a
broad mint.

### The repo pins (TOG-226)

The App is installed on **eight** repos, so an unscoped token would grant all
eight. Every project pins the subset its work actually touches:

| Project | `GH_APP_REPOS` |
|---|---|
| Ops Tooling | `paperclip-ops-tooling` |
| Model Router Plugin | `paperclip-model-router` |
| Routeware Shadow API | `routeware-shadow-api` |
| NNTune | `nntune` |
| Kofra | `kofra` |
| Community Platform | `two-web,two-bot,two-design` |
| Onboarding | `two-bot` |

Community Platform and Onboarding shipped with no `env` at all, so the broker
refused for all 55 issues on them. Both do real git work — Community Platform
owns the three repos transferred out of the TWO-Gaming org, Onboarding owns the
Discord bot — so the fix was a pin, not a "does no git work" note. Onboarding is
pinned to `two-bot` alone; widening it to the other two would be a regression.

### Project-less issues

An issue with no project has no `GH_APP_REPOS` to read and gets a `409`. That is
the **correct** outcome for the large majority of them, which do no git work at
all — the remedy is to attach the repo-bearing ones to a project, not to give the
broker a company-wide default repo list, which would re-widen exactly the scope
TOG-174 narrowed.

Two derivation sources were considered and rejected on measurement:

- **Inherit the parent issue's project.** Zero project-less issues have a
  project-bearing ancestor — their parents are project-less too. It closes
  nothing.
- **Fall back to the run's checkout workspace.** Zero project-less issues carry
  an `executionWorkspaceId` or `projectWorkspaceId`. Also nothing.

So the `409` names which of the two real fixes applies — *attach a project* when
there is none, *set `GH_APP_REPOS`* when there is one — rather than listing both
and leaving the caller to work it out.

### A `409` is usually correct, and counting them badly is how this looks worse than it is

Not every project-less issue with git-ish words in it is a gap. Sort them by
whether the code they name is **in the installation**:

| class | example | is it residue? |
|---|---|---|
| names a repo we hold | `paperclip-ops-tooling`, `two-bot` | **yes** — attach it to the project that pins that repo |
| names the Paperclip control plane | `server/src/services/secrets.ts` | no — no token in this installation reaches it |
| names an upstream vendor | `omniroute@3.8.49`, `open-sse/…` | no — same |
| names an operator-side file | `/paperclip/operator-handoff/…` | no — not version-controlled here |
| no git work at all | a hiring issue | no |

Scanning open project-less issues for git-ish words flags ~25 of 63; only a
handful are real. Attaching the rest would mint tokens nothing can use, and
treating them as a broker defect sends you looking for a fix that cannot exist.

### The residue regenerates — this is a standing check, not a migration

The 2026-08-23 sweep drove the count to zero. Within five hours it was four
again: TOG-289 and TOG-290 were filed project-less, and TOG-289 had already
pushed a branch to `paperclip-ops-tooling`. Every issue filed without a project
re-opens the gap, so a number measured once says nothing about the next unbind.

`../../gh_scope_residue.sh` is that check as a command. It mints nothing — it
reads the board, and optionally asks GitHub for `tog-<n>-*` branches using a
token the caller already has. It is the board-side half of the pair; the
configuration-side half is `gh-app-token.js scope-check` (TOG-238), which
reports whether an environment survives strict mode, also without minting.

Two things about it are worth knowing before you trust a zero:

- **Text scanning alone misses the case that motivated it.** TOG-289 names no
  repository anywhere in its title or body and had a branch pushed. That is why
  there is a branch detector, and why a text-only run reports `partial` and
  exits `3` rather than `0`.
- **No agent can run the full sweep.** Each agent's token is scoped to its own
  project's `GH_APP_REPOS`, so it can list branches in those repos and gets
  *Resource not accessible* on the rest — measured from an Ops Tooling run
  against `kofra`. A token that could read all eight is the org-wide blast
  radius TOG-174 removes. So the full sweep belongs host-side, an agent runs
  `--repos <its own>`, and the union of slices is the gate. Partial coverage
  never exits `0`.

Even a full sweep is a floor, not a proof: an issue that will do git work, names
no repo, and has not pushed yet is invisible to both detectors.

## Security invariants

Each is covered by a test in `test/broker.test.mjs`.

| Invariant | Why it matters |
|---|---|
| Only the assignee, on a live checkout, can mint | Since `checkoutPolicy` became `none` (TOG-309) this is enforced solely by `assertMintOwnership`. Assignee and run lock are unchanged from the host gate; the status set is widened to the states that hold a checkout, and still refuses the terminal ones. |
| `repositories` is never empty | GitHub reads an omitted/empty array as **every repo in the installation** — the exact blast radius this issue exists to remove. An underivable scope raises `409`, it does not mint. |
| Callers may only narrow | Requesting a repo outside scope, a permission outside the profile, or a higher level is refused with `403` rather than silently clamped. |
| The PEM never leaves the host | Resolved at mint time, passed straight to the signer, never returned, logged, or persisted. Asserted directly in the mint test. |
| Nothing is shelled out | The JWT and token exist only as in-process strings passed to `ctx.http.fetch`, so neither lands in `/proc/<pid>/cmdline` (the **TOG-200** class of bug). |
| Internal errors are not echoed | Only our own error classes carry caller-visible text; anything else becomes `"Internal broker error."`. |

### ⚠️ `checkoutPolicy` is `none`, and the gate lives in the worker

This is the non-obvious one. `none` reads like "unprotected" and is not.

**`required-for-agent-in-progress` is forbidden, permanently.** The host
enforcement in `server/dist/routes/plugins.js` reads:

```js
if (policy === "required-for-agent-in-progress") {
  if (issue.status !== "in_progress" ||
      issue.assigneeAgentId !== req.actor.agentId) return;   // skips the check
}
```

It **skips `assertCheckoutOwner` in exactly the case an attacker would choose** —
an issue the caller does not own. With that policy, any agent could mint a
repo-scoped token for any project in the company by naming a stale issue in it.

**`always-for-agent` is what this route used to be, and TOG-309 measured it
breaking git.** It calls `assertCheckoutOwner` unconditionally, which is the
right shape, but that function hardcodes:

```js
status === "in_progress" && assigneeAgentId === caller && runLockMatches
```

An agent acting on review feedback holds its checkout while the issue sits in
`in_review`, and got `409 Issue run ownership conflict`. Because `gh-app-token.js`
correctly treats a 409 as a *definitive* refusal and will not retry it with the
org-admin PEM, that 409 does not degrade to a slower path — it kills git.

Measured board-wide on 2026-08-24, over the 99 issues assigned to an agent in a
non-terminal status:

| | issues that could mint |
|---|---|
| `always-for-agent` (before) | **4** — `in_progress` only |
| this change | **51** — `in_progress` 4 + `in_review` 9 + `blocked` 38 |
| still refused, deliberately | 48 `todo`/`backlog`, plus all `done`/`cancelled` |

#### Why widening the status term is not a weakening

Of the three terms `assertCheckoutOwner` requires, two are authorization and one
is not:

- `assigneeAgentId` answers **who** — this work belongs to the calling agent.
- `checkoutRunId` answers **which run** — mutual exclusion between the agent's
  own concurrent runs.
- `status` answers **when**. It identifies nobody. What it actually buys is a
  *lifetime bound*: without it, an agent still assigned a long-finished issue
  could mint a repo token for that project indefinitely.

So `MINTABLE_ISSUE_STATUSES` in `dist/ownership.js` is `in_progress`,
`in_review`, `blocked` — the states in which a run legitimately holds a
checkout — and the lifetime bound is kept by continuing to refuse `done` and
`cancelled`. `backlog`/`todo` are refused too: work has not started, so no run
holds a checkout, and moving the issue to `in_progress` is the honest signal.

The host cannot express that set, and patching the control plane is not this
repo's to do. So under `none` the host still enforces `auth: "agent"` and —
independently of `checkoutPolicy`, at `plugins.js:1481` — `assertCompanyAccess`
against the company resolved from the issue. Cross-company is closed either way.
What remains is asserted by `assertMintOwnership`, before any secret is resolved
and before any outbound call.

#### The honest cost

There is no longer a second, independent enforcement of the assignee and
run-lock terms behind the worker. That is why `ownership.js`:

- re-asserts both terms verbatim rather than trusting the host,
- **fails closed** when `checkoutRunId` is absent from the record, instead of
  reading a missing field as "no lock held",
- refuses when the host supplied no `runId` — `none` means nothing else will,
- is unit-tested directly, not only through the route.

Each of those is covered by a mutation-checked test: reverting the status set,
dropping either term, or treating an absent `checkoutRunId` as unlocked all turn
the suite red against a baseline that passes in the same staging directory.

#### `issues.checkout` is held for a side effect, not as the gate

The worker still calls `ctx.issues.assertCheckoutOwner`, best-effort, and
ignores the result. It is called for the two things the host does *before* it
evaluates its status term: it clears a checkout lock whose holding run has
terminated, and it adopts an unowned lock for the caller. Without that call, an
issue whose previous run crashed keeps a dead lock forever and the run-lock term
refuses every later mint — the same "git stops working" failure in a new place.
A throw from it is expected (for `in_review` it always conflicts) and swallowed;
the issue is re-read afterwards and `assertMintOwnership` makes the decision.

A permissive answer from it cannot override a broker refusal. There is a test.

### What a mint record proves about `runId`

**TOG-216. Read this before quoting the mint log as evidence of who minted.**

Every mint writes an activity entry carrying `agentId`, `runId` and
`checkoutRunId`. For a credential broker, "who minted this" is the entire value
of that log, so it is worth being exact about which of those fields is proof and
which is testimony.

`runId` reaches a plugin API route by two mechanisms with two different trust
properties, and **the host does not tell the plugin which one applied**:

| auth path | where `runId` comes from | trust |
|---|---|---|
| agent JWT | the signed `run_id` claim; a mismatched `X-Paperclip-Run-Id` header is rejected `422` and audited (`server/dist/middleware/auth.js:232`, `:256`) | **proved** |
| long-lived agent key | the raw `X-Paperclip-Run-Id` header, unvalidated (`server/dist/middleware/auth.js:302`) | **asserted** |

The board-key and unauthenticated paths take the header unvalidated too
(`:190`, `:159`, `:128`), but neither can reach these routes — both are
`auth: "agent"`.

Measured against the live install on the agent-JWT path, which is how a normal
run calls: omitting the run header entirely still returned the correct `runId`
(so it is not header-derived), and a fabricated header returned `422
agent_jwt_run_id_mismatch` (so it is checked rather than trusted). Those two
results are specific to that path. The agent-key path is established by reading
`auth.js:302`, not by that probe.

**So `agentId` is proof and `runId` is not.** `agentId` comes from the JWT claim
or from the agent-key record on every path; a caller cannot move it. A holder of
a long-lived agent key can put any string in `runId`.

#### The run-lock term does not launder it

It is tempting to argue that `assertMintOwnership` corroborates `runId` by
comparing it to `issue.checkoutRunId`. It does not, in the case that matters:

```js
if (checkoutRunId !== null && checkoutRunId !== runId) { /* 409 */ }
```

When the lock is **null**, the comparison is skipped and any `runId` satisfies
the term — that is the `an unheld checkout (null) is accepted` test, and it is
deliberate. When the lock is non-null, `checkoutRunId` is a plain readable field
on `GET /api/issues/{id}`, so matching it demonstrates the caller read the issue,
which they had to be the assignee to mint against anyway.

Neither branch turns an asserted `runId` into a proved one. **The run-lock term
is mutual exclusion between an agent's own concurrent runs. It was never an
identity check, and this section exists because two comments in this package
had drifted into describing it as one.**

#### What this is, and what it is not

**It is not a privilege escalation, and it is not exploitable for scope.** All
three ownership terms that decide *whether* to mint — assignee, status, and the
lock comparison above — either ignore `runId` or are already satisfied by
whoever holds the assignee agent's key. Scope is derived from the issue's
project, never from `runId`. A forged `runId` widens nothing.

What it costs is narrower and still real: **a mint record cannot distinguish a
`runId` the host proved from one the caller asserted.** Anyone reading the log to
answer "which run took this credential" is reading a field that is authoritative
on one auth path and self-reported on another, with nothing in the record saying
which.

#### Why the obvious fix is wrong

Refusing when `checkoutRunId` is null — "make the lock mandatory, then `runId`
is always corroborated" — **re-breaks TOG-309 exactly.** The host adopts an
unowned lock only for an issue in `in_progress`
(`server/dist/services/issues.js`, `adoptUnownedCheckoutRun`), so an issue in
`in_review` or `blocked` keeps a null lock however legitimate the caller is.
Those are two of the three mintable statuses, and `in_review` is the state whose
`409` killed git and caused TOG-309. Do not make the lock mandatory.

#### What would actually close it

The host already computes the distinguishing value.
`getActorInfo` (`server/dist/routes/authz.js:166`) resolves an `actorSource` —
for an agent caller it is exactly `agent_jwt` or `agent_key`, the two rows of the
table above. The plugin API handler then drops it when it builds the actor it
hands to a plugin (`server/dist/routes/plugins.js:1501`, which passes
`actorType`, `actorId`, `agentId`, `userId` and `runId`, and no source).
Passing it through is a one-line host change:

```js
actorSource: actor.actorSource,   // add to the plugin API actor input
```

**That is upstream-only.** We run a pinned image and do not fork it, the same
wall that stopped TOG-154 and TOG-175. **When `actorSource` becomes available,
record it beside `runId` in the mint metadata** so every record states its own
trust level instead of leaving a reader to assume the better of the two.

#### Also worth knowing before you query the log

On the first real mint (measured 2026-08-23) the activity row's **top-level**
actor columns were `agentId: null`, `runId: null`, with the true values in
`details`, `actorId` set to the plugin id and `responsibleUserId` set to the
operator. Querying activity by the top-level `agentId`/`runId` columns — the
natural way to ask "what did this agent mint?" — therefore returns nothing and
attributes the mint to the plugin. Read `details`.

### Git operations with no issue context

**The broker does not mint, and that is a decision rather than a gap** (TOG-309
asked for it to be settled here).

There is nothing to authorize and nothing to scope: the repository ceiling is
derived from the issue's project, so with no issue there is no non-empty
`repositories` list — and an empty list means *every repo in the installation*,
the exact blast radius TOG-174 exists to remove. A caller with no issue also
presents no assignee and no run lock, so all three ownership terms are vacuous.

`gh-app-token.js` already fails closed here: with neither `GH_APP_BROKER_ISSUE`
nor `PAPERCLIP_TASK_ID` set it names the missing variable rather than minting. An
agent that needs git for work not driven by an issue should open one — that is
cheap, and it is also the only way the mint lands in an audit trail that says
what the credential was for.

## Configuration

Instance config for the plugin:

| Key | Required | Notes |
|---|---|---|
| `appId` | yes | `4685085` |
| `org` | yes | `TogetherWeOwn` |
| `privateKeyRef` | yes | secret ref to the App PEM — **not** the PEM itself |
| `installationId` | no | saves one lookup per mint |
| `defaultPermissions` | no | overrides the built-in 4-permission profile |

## Install

Install is board-gated (`POST /api/plugins/install` returns
`403 Board access required` to an agent token), so an operator has to do this.

1. Install the package into the instance plugin root
   (`/paperclip/.paperclip/plugins`), the same place `paperclip-plugin-discord`
   and the others live.
2. Set the config above, binding `privateKeyRef` to the existing
   `GH_APP_PRIVATE_KEY` secret.
3. Verify the de-risk probe first:

   ```bash
   curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
     "$PAPERCLIP_API_URL/api/plugins/gh-token-broker/api/whoami?companyId=$PAPERCLIP_COMPANY_ID"
   ```

   A `runId` in the response proves agent-authenticated plugin API routes
   dispatch and that the host populates the actor. Nothing on this instance had
   exercised that path before. It does **not** prove the `runId` is
   server-derived — that depends on which auth path the caller used, and this
   route cannot tell you which. See
   [what a mint record proves about `runId`](#what-a-mint-record-proves-about-runid).
4. Then mint against a real issue the caller holds and assert the acceptance
   criterion from TOG-174 — no `organization_*` key in `permissions`, and
   `repositories` a single repo rather than all 7.
5. **The TOG-309 acceptance check.** Do step 4 again on an issue in `in_review`,
   and follow it with a real `git ls-remote` using the minted token. That is the
   exact case that returned `409 Issue run ownership conflict` before this
   change, and the case in which the helper kills git rather than degrading. A
   green suite does not prove it; the live mint does.

## Tests

No network and no credential are required to run the suite — which is what makes
it CI-able, the same property that got `test_gh_app_token.sh` into CI. It runs on
every push here; see `.github/workflows/ci.yml`.

### On the instance (agent workspace, VPS)

```bash
ln -s /paperclip/.paperclip/plugins/node_modules node_modules   # once, per checkout
node --test test/broker.test.mjs
```

> **`NODE_PATH` does not work here, however much it looks like it should.**
> `NODE_PATH` is a CommonJS resolution mechanism and the ESM loader ignores it
> outright, so `NODE_PATH=/paperclip/.paperclip/plugins/node_modules node --test
> test/broker.test.mjs` fails `ERR_MODULE_NOT_FOUND` on `@paperclipai/shared`
> even though the package is sitting at exactly that path. This suite is `.mjs`.
> The symlink is what makes local runs work; the env var only makes the failure
> confusing. Earlier revisions of this file recommended the env var — it was
> never the reliable form.

### On a machine without the instance plugin root (CI, a laptop)

```bash
npm ci --include=dev --ignore-scripts
npm test
```

The two `@paperclipai` packages are published on npm and pinned in
`devDependencies` to the version the instance actually runs. Bump that pin when
the instance is upgraded — otherwise the manifest test below is asserting against
a schema the host no longer uses, which is the one way this suite can go green
and still be wrong.

> **`--include=dev` is not optional, and not redundant.** npm implies
> `--omit=dev` whenever `NODE_ENV=production`, which is exactly what the
> Paperclip instance sets. Without the flag, `npm ci` installs nothing, prints
> `up to date`, **exits 0**, and every test then fails `ERR_MODULE_NOT_FOUND` —
> a passing install step followed by a suite that looks broken for an unrelated
> reason. CI passes the flag and then asserts the packages actually landed.

**Two invocation traps, both of which look like a broken suite and are not:**

- Without either a `node_modules` symlink to the instance plugin root *or* a
  local `npm install`, every test fails with `ERR_MODULE_NOT_FOUND` for
  `@paperclipai/shared`. Reach for the symlink in the agent workspace and
  `npm ci` everywhere else — **not** `NODE_PATH`, which the ESM loader ignores
  (see the box above). The symlink is deliberately not committed here;
  `.gitignore` lists `node_modules` both with and without a trailing slash so
  that the symlink is actually covered, not just the directory.
- Pass the **file**, not the directory. On Node 24 `node --test test/` resolves
  `test` as a module specifier and dies with a single `MODULE_NOT_FOUND` failure
  before running anything. The `npm test` script passes the file for this reason
  — it read `node --test test/` when this plugin was imported, so `npm test` was
  a guaranteed failure that looked exactly like a broken suite.

This suite is gated on **exit status, never on a test count**, matching the rest
of the repo — see the header of `.github/workflows/ci.yml` for why.

The manifest test validates against the host's own `pluginManifestV1Schema`, so a
manifest that would be rejected at install time fails here first.

## Not solved by this plugin

- **TOG-191** — the PEM stays readable via `/proc` for as long as
  `GH_APP_PRIVATE_KEY` is still bound to the 8 agents. This broker makes those
  bindings *removable*; it does not remove them. Unbinding is the follow-up.
- **App-level narrowing** — the installation still declares ~81 permissions.
  That ceiling is a UI-only operation on the App settings page and remains
  owner-owned. Until it is narrowed, describe the posture as *"the default mint
  is one repo instead of seven,"* never as least privilege.
