# omniroute-broker

Performs a **fixed set of narrow OmniRoute management operations** on behalf of
agent runs. The management credential is resolved inside the host process and
never enters an agent's address space.

Built for **TOG-391**, to unblock **TOG-352** (register the CLIProxy as a
provider). Modelled directly on `gh-token-broker` (TOG-174/TOG-309), which is
the working reference for this shape on this instance.

> **This Ops Tooling directory is the authoritative copy.** The broker moved
> here from `paperclip-model-router` under TOG-537 because it is an operation
> broker, not model-routing product code. Model Router is not a fallback source
> and must contain no active OmniRoute broker, bridge test or calibration hook.
>
> If an operator stages a copy anywhere else, run
> `TOG473_BROKER_DIR=<that directory> node scripts/tog473-mapping-guard-calibration.mjs`
> from the Ops Tooling root before installing it. The check fails on any
> `dist/` divergence rather than certifying one copy and installing another.

---

## Status

| | |
|---|---|
| Code | complete — 8 modules, `dist/` |
| Tests | focused broker and calibration suites, no network, no credential, CI-enforced |
| Manifest | validated against the **host's own** install-time validators — `pluginManifestV1Schema` PASS, `validateManifestCapabilities` → `{allowed:true, missing:[]}` |
| Installed | **no** — install is board-gated and needs an operator |
| Exercised live | **no** — no mutation has run against OmniRoute. See "Not proven" |

---

## Verification of the claims TOG-391 was built on

The issue instructed that every inherited fact be re-derived rather than
trusted. Done, on 2026-08-25. **Two claims were wrong.** Both corrections
changed the build.

| # | Claim as written | Verdict | Evidence |
|---|---|---|---|
| 1 | Agent key `403` on `/api/providers` | ✅ **confirmed**, with a sharper reason | `GET http://omniroute:20128/api/providers` with `$OMNIROUTE_API_KEY` → `403 {"error":{"code":"AUTH_001","message":"Invalid management token"}}`. Note it is *invalid token class*, not *insufficient scope* — an inference key is not a management credential at all, so no scope grant on it could ever help. |
| 2 | "No narrow scope exists ⇒ provider registration requires full `manage`" | ⚠️ **WRONG as stated — conclusion survives, for a stronger reason** | See below. |
| 3 | `manage` grants `/api/keys/[id]/reveal`, i.e. other keys' plaintext | ✅ **confirmed**, with one mitigation the issue did not know about | See below. |
| 4 | `gh-token-broker` is the right template | ✅ **confirmed** | Read in full. Invariants carried over module by module. |
| 5 | `required-for-agent-in-progress` skips the ownership check | ✅ **confirmed verbatim against the running build** — but the issue's *prescribed fix* is stale | See "checkoutPolicy". |
| 6 | `TOG-151-omniroute_combo_cli.sh` solves the audit-logging problem | ✅ **confirmed and reused** | `[RESOLVED-8]`, carried into `dist/audit.js`. |
| 7 | OmniRoute bills Claude to OpenRouter PAYG | 🟡 **partially confirmed — I could not close it** | See "What I could not verify". |

### Claim 2 — the claim the whole design rests on

**The issue says no narrow scope exists. That is wrong: OmniRoute has three
credential classes, and one of them is genuinely scoped.**

```
src/lib/accessTokens/scopes.ts       ACCESS_SCOPES = ["read","write","admin"]   (admin ⊃ write ⊃ read)
src/server/authz/accessScopes.ts     inferRequiredScope(method, path)
src/shared/constants/managementScopes.ts
                                     MANAGEMENT_API_KEY_SCOPES = Set{"manage","admin"}
```

The `oma_`-prefixed CLI access token — flagged **UNVERIFIED** in TOG-151
`[RESOLVED-2]`, which explicitly said *"Read what it grants before switching"* —
is real, and this is that read. It is a 3-level hierarchy, not a single
all-or-nothing `manage` bit.

**But the conclusion holds, and for a worse reason than the issue gave.**
`accessScopes.ts` puts `/api/providers` in `ADMIN_MUTATION_PREFIXES`:

```js
export const ADMIN_MUTATION_PREFIXES = [
  "/api/providers",     // POST add provider / rotate key = admin; GET status = read
  "/api/cli-tools/apply",
];
```

So **registering a provider requires `admin` — the TOP of the hierarchy.** And
`admin` is a superset of everything, including `/api/cli/tokens` (mint more
access tokens), `/api/oauth`, `/api/auth` and `/api/policy`, all of which sit in
`ADMIN_SCOPE_PREFIXES`.

⇒ The narrowest credential that can register a provider can also **mint further
credentials**. That is *more* dangerous than the `manage` API key the issue was
worried about, not less. **Broker the operation. The conclusion is unchanged and
better supported.**

**And the key-groups lead is a dead end, definitively.** `/api/keys/groups/[id]/permissions`
is not a management-permission system at all. `src/lib/db/apiKeyGroups.ts:1-8`:

```
 * Tables: key_groups, group_model_permissions, key_group_members
 * Enables team-level API key management with model-level access control.

 export interface GroupModelPermission {
   modelPattern: string; provider: string | null; accessType: "allow" | "deny";
 }
```

It restricts **which models an inference key may call**. It is an inference-plane
allowlist and grants nothing on the management plane. It cannot yield a narrower
credential for provider registration, for any verb. **Recorded, as the issue asked.**

### Claim 3 — `reveal` returns plaintext

Confirmed. The compiled handler ends:

```js
let r = await getApiKeyById(id);
if (!r || typeof r.key !== "string") return 404;
return NextResponse.json({ key: r.key });     // plaintext
...
e.s(["GET", 0, c])                            // exported as GET
```

Two things the issue did not have:

1. **It is behind a feature flag.** `isApiKeyRevealEnabled()` →
   `ALLOW_API_KEY_REVEAL`, whose `defaultValue` is `"false"`
   (`featureFlagDefinitions.ts:97`, `warningLevel: "danger"`) and which fails
   closed on error. So on a default instance `reveal` returns
   `403 {"error":"API key reveal is disabled"}`. **Whether it is enabled on THIS
   box is a management read I do not hold** — treat the flag as unknown, not as
   off. The design does not depend on it either way.
2. **It is a `GET`, which makes it *cheaper* than the issue assumed.** Under
   `inferRequiredScope`, `/api/keys/...` matches no admin prefix, and
   `GET → "read"`. So for the `oma_` credential class, reveal sits at the
   **lowest** scope — a `read` token clears it. Any argument of the form "we will
   hand out a read-only token" has to answer this first.

### `checkoutPolicy` — claim 5, and where the issue's instruction is stale

The trap is real and confirmed against the running build,
`/app/server/dist/routes/plugins.js:394`:

```js
if (policy === "required-for-agent-in-progress") {
  if (issue.status !== "in_progress" ||
      issue.assigneeAgentId !== req.actor.agentId) return;   // skips assertCheckoutOwner
}
```

It skips the ownership check in exactly the case an attacker would choose. Never
use it.

**But TOG-391 instructs `checkoutPolicy: "always-for-agent"`, and that
instruction is out of date.** The reference plugin has since moved OFF that
policy (TOG-309), because `assertCheckoutOwner` hardcodes the status term —
`/app/server/dist/services/issues.js:6325`:

```js
if (candidate.status === "in_progress" &&
    candidate.assigneeAgentId === actorAgentId &&
    sameRunLock(candidate.checkoutRunId, actorRunId))
```

An agent acting on review feedback holds its checkout while the issue sits in
`in_review`, and gets `409`. Measured against the live GitHub broker, that 409
did not degrade — it killed the caller.

**So this plugin uses `checkoutPolicy: "none"` and gates in `dist/ownership.js`,
matching the current reference.** That is not a relaxation:

- the host still enforces `auth: "agent"` and, independently of checkoutPolicy,
  `assertCompanyAccess()` against the company resolved from the issue — so the
  **cross-company boundary does not depend on this plugin's code**;
- assignee, run lock and status are re-asserted in `ownership.js` before any
  secret is resolved, over the widened status set `in_progress | in_review |
  blocked`, with `done`/`cancelled`/`backlog`/`todo` refused to keep the
  lifetime bound.

The honest cost, same as the reference: there is no longer a second, independent
enforcement of assignee and run-lock behind that file. Hence it fails closed on
an absent field and is unit-tested directly.

---

## Design: broker the operation, not the credential

The caller **never supplies a method or a path** — only a **verb name**, looked
up by exact string equality in a deny-by-default table (`dist/verbs.js`).

If the broker forwarded caller-supplied method+path it would be the management
key with extra steps, and a caller could reach `GET /api/keys/<id>/reveal`.

Exact equality, no substrings or prefixes, is TOG-151's `gate_allowlist` rule,
adopted after Claude turned out to be reachable through 351 ids of which 14
contained neither "claude" nor "anthropic".

### Verb table and approval policy

| Verb | Upstream | Approval |
|---|---|---|
| `providers.list` / `providers.get` / `combos.list` / `models.list` / `mappings.list` | `GET` | **none** (ungated, scrubbed) |
| `providers.create` / `providers.update` / `combos.create` / `combos.update` | `POST`/`PUT` | **single** — the responsible agent |
| `providers.delete` / `combos.delete` / `providers.set-priority` | `DELETE`/`PUT` | **two keys** |
| `mappings.create` / `mappings.delete` | `POST`/`DELETE` | **two keys** + a body guard |

Deliberately absent, each an explicit decision: `/api/keys` and
`/api/keys/:id/reveal`, `/api/cli/tokens`, `/api/oauth`, `/api/auth`,
`/api/policy`, `/api/services`, `/api/mcp`, `/api/shutdown`,
`/api/settings/database`.

**The approval class is decided server-side**, in `classifyApproval()`. A caller
cannot choose it by picking a route or setting a field.

**The paid-traffic tripwire.** Any `create`/`update` whose body contains a key in
`PAID_TRAFFIC_KEYS` (`priority`, `weight`, `enabled`, `billing`, `quota`, …) is
escalated single → dual. It matches on **key presence, not value** — disabling
the provider that currently serves paid traffic is exactly as consequential as
enabling one. Like TOG-151's Claude tripwire it is one-way: it can only ever
require **more** approval, never less.

### Mapping verbs — why they are tighter than combos

A combo is inert configuration. The **mapping** is the object that actually moves
traffic, because it is what a bare model id resolves through. Without these verbs
the broker covers TOG-178's phase 5 (`POST /api/combos` ×52) and not its phase 6
(`POST /api/model-combo-mappings` ×52) — i.e. it would land 52 combos that carry
zero traffic, and route policy is pinned at install, so escaping that needs a
second board-gated action.

`mappings.create` is **two-key**, not single. The CISO's scope ruling proposed
single-key; that cannot be implemented as stated, because the same ruling requires
an explicit `priority`, and `priority` is a `PAID_TRAFFIC_KEY` — so the tripwire
escalates every conforming call to dual anyway. A `single` label that never
matches behaviour is worse than no label, so the verb declares what it does.

On top of the class, `assertMappingCreate()` enforces a **server-side body guard
with no opt-out flag**:

| Rule | Why |
|---|---|
| Body keys allowlisted to `pattern`, `comboId`, `priority`, `enabled`, `description` | Exactly the shipped route's zod contract. Deny-by-default, as everywhere else here. |
| No `*` or `?` in `pattern` | OmniRoute glob-matches case-insensitively, so one `*` can capture ids nobody enumerated — including ids that do not exist yet. |
| `pattern` must not match `/(claude\|sonnet\|opus\|haiku\|fable)/i` | Matched on **family**, not on the substring `claude`: TOG-237 was a bypass a `claude` check cleared, and 13 `aug/` ids contain no `claude` at all. |
| `priority` must be an explicit integer | The route defaults it to `0`. Mappings resolve `priority DESC`, so an omitted priority silently loses to every existing mapping — a routing decision nobody made. |

The guard is wired into `buildRequest()`, **not** into the operate handler, because
`buildRequest` is on both the propose and the approve path. Wiring it into the
handler alone would leave a hole where a body stored as a proposal executes
unchecked on approval. There is a test for exactly that.

**This makes the broker path strictly narrower than the operator path it
replaces** — a hand-run `apply.sh` trusts its input file and enforces none of the
above. Verified, not asserted: all **52** real patterns in
`/paperclip/operator-handoff/TOG-178-mapping-plan.json` pass the guard (0 refused),
and their priorities are explicit integers `1000…949`. That check is a test.

**Known limitation, accepted deliberately.** The family rule is an absolute
refusal, not an escalation, so the TOG-153 class of work — pinning bare Claude ids
to the subscription lane, whose patterns are both wildcarded (`claude-opus*`) and
Claude-family — **cannot** go through this broker at any approval level. Claude
routing stays an explicit operator action. That is the intended trade; it is
recorded here so nobody rediscovers it as a bug.

**The guard is id-shaped, and that is a structural limit — not a tuning knob.**
It only ever sees the caller's pattern *string*; it never holds the catalogue
record. So it cannot reason about any model whose Claude-ness lives somewhere
other than the id. That is not hypothetical: `aug/prism-a` is
`"name": "Prism (Claude + Gemini)"` and carries no family token in its id at all.
`prism` is therefore **enumerated** in `MAPPING_PROTECTED_FAMILY`, not derived.
`mythos` is also enumerated: it is a current Claude family name even though the
live OmniRoute catalogue exposes no Mythos id today. A future alias such as
`aug/mythos5` must be refused on first appearance, not after the next live
calibration discovers it. Any future blended id of the Prism shape must be added
the same way — it will not announce itself.

⚠️ **How it was found, because the method matters more than the fix.** This
escaped a 480-id catalogue fixture, which reported "350/350 blocked, 0 escaped"
— green, and wrong. The live catalogue is **1432** ids and contains the bypass.
A fixture certifies the fixture. Run
`node scripts/tog473-mapping-guard-calibration.mjs` from Ops Tooling **live**
(it needs `OMNIROUTE_API_KEY`) before trusting any calibration claim; it imports
this guard from `dist/` so a copy cannot drift and then certify itself. Live
result after the fix: **352/352 blocked, 0
escaped**, and all 52 TOG-178 patterns still pass unchanged.

**Accepted over-block:** `aug/prism-b` is `"Prism (GPT + Kimi)"`, carries no
Claude, and is refused anyway — the two are indistinguishable by id. TOG-178
names neither, so the cost against real intent is zero. Blocking a non-Claude
model is a recoverable annoyance; passing Claude traffic is the failure this
guard exists to prevent.

### What "two keys" actually enforces

A second approval is theatre unless all four hold. Each has a test.

1. **Two distinct agents** — approver ≠ proposer, compared on host-derived
   `agentId`. This is the property being bought.
2. **The operation cannot change between the keys** — a proposal is identified by
   a SHA-256 **digest** over its canonical form, and the approver must present
   that digest. Approval by opaque id alone would be consent to something unread.
3. **Single use** — a consumed proposal cannot be replayed into a second delete.
4. **It expires** — default 60 min. An approval that never expires is a standing
   grant held by whoever finds the id.

The approver must itself hold an issue, so the second key is a real agent doing
real work, not an anonymous token.

### Redaction — the invariant `gh-token-broker` does not need

In the GitHub broker, a secret crossing back **is** the product. Here the
opposite holds: **nothing secret may cross**. OmniRoute's management plane embeds
live upstream credentials in ordinary responses, so `GET /api/providers` — an
"ungated read" — is a credential disclosure unless scrubbed.

`dist/redact.js` uses a **per-resource field allowlist**, not a denylist of
secret-looking names. A denylist is wrong for the reason TOG-151 already paid
for: the thing being filtered has more spellings than you can enumerate
(`apiKey`, `api_key`, `key`, `token`, `secret`, `clientSecret`, …) and a miss is
silent. A field OmniRoute adds tomorrow is invisible until someone adds it here
on purpose — the correct failure direction.

`assertNoResidualSecret()` then re-checks the **output** and refuses the whole
response if anything credential-shaped survived. Not redundant: it catches an
*allowlisted* field whose **value** carries a credential (a `baseUrl` with a key
in the query string is the real case).

### Audit — TOG-151 `[RESOLVED-8]`, carried over

1. **Prove the audit path by using it, before the mutation** — `preflight()`
   writes a real record. A permission probe is not a proof.
2. **Build the record before the mutation is issued.**
3. **Never best-effort.** The original says it plainly: `|| true` on the append is
   what let an unrecorded mutation look like a normal error. There is no
   swallowed catch in `audit.js`.
4. **On a post-mutation audit failure, be loud** — `UnrecordedMutationError`
   carries `THE MUTATION WAS APPLIED AND IS NOT IN THE LOG`, `mutationApplied:
   true`, and `recordToAddByHand` with the exact JSON line.

The symlink/umask rules of the shell original have no analogue on
`ctx.activity.log` and are deliberately not simulated. Everything about ordering
and loudness transfers, and does.

---

## Order of operations

Steps 1–5 all run **before the credential is resolved**, so a refused request
never touches the secret.

```
1. host          auth:"agent" + assertCompanyAccess      (cross-company)
2. ownership.js  assignee + status + run lock            (who / when)
3. verbs.js      verb lookup + approval classification   (what)
4. approvals.js  second key, if the class demands one    (how many)
5. audit.js      preflight — PROVE the log writable      (before anything)
6. omniroute.js  resolve credential, issue the call      (the only mutation)
7. audit.js      commit — loud if it fails after (6)
8. redact.js     scrub whatever comes back
```

## Security invariants

| Invariant | Why it matters |
|---|---|
| The caller supplies no method and no path | Otherwise the broker is the management key with extra steps, and `/api/keys/:id/reveal` is reachable. |
| Unknown verb ⇒ `404`, never a pass-through | Deny-by-default. Exact equality, no prefix matching. |
| The credential is resolved once, as late as possible, and rides in a header | Never in a URL, never in state, never in an error message. |
| **Nothing is shelled out** | The call is `ctx.http.fetch`, so the key never lands in `/proc/<pid>/cmdline` — the TOG-200 class. It is also why TOG-151's shell CLI needed a `0600 curl --config` file; a plugin must not reintroduce that problem. |
| A transport error's message is never echoed | The caught error can quote `init`, which holds the `Authorization` header. Only the error *name* propagates. |
| An upstream `401`/`403` becomes `503` | It means the **broker's** credential is wrong. Returning 403 would tell the agent "you are not allowed" — false, and the kind of misleading refusal that costs a run. |
| Reads are scrubbed by allowlist, output re-checked | A provider record embeds the upstream credential in the clear. |
| Audit metadata is masked | Otherwise the audit trail becomes the disclosure channel. |

## Address traps

⚠️ **Ports.** `:20128` is **management**; `:20129` is **inference**. A swap does
not look like a swap — `/api/combos` on `:20129` returns
`404 {"error":"not_found","message":"API port only serves OpenAI-compatible routes."}`.

⚠️ **Host, and this corrects a note in TOG-391 and in my own memory.** The right
address depends on where you are:

- from the **host**: published ports are on loopback; `omniroute` does not
  resolve. TOG-151's `127.0.0.1` default is correct **for that tool**.
- from a **container** (where this worker runs): `127.0.0.1` is the worker
  itself and is refused; the podman alias **`omniroute` resolves and answers**.

Measured 2026-08-25 from an agent container:

```
http://omniroute:20128/api/providers  -> 403 AUTH_001   (reached, rejected on credential)
http://omniroute:20129/v1/models      -> 200            (1432 ids)
http://127.0.0.1:20128/api/providers  -> connection refused
http://127.0.0.1:3456/                -> connection refused
```

**This overturns the prior note that OmniRoute is unreachable from agent
containers.** That note tested `host.containers.internal`, `localhost` and
`172.17.0.1` — but never the bare service alias. The catalogue **is** readable
from an agent run.

## Install

Board-gated; an operator must do it. Install only from this repository or from a
staged copy whose `dist/` fingerprint the calibration command above matched.

1. Install this directory into the instance plugin root
   (`/paperclip/.paperclip/plugins/omniroute-broker`).
2. Config: `managementBaseUrl` = `http://omniroute:20128`, and bind
   `managementKeyRef` to the OmniRoute management key **as a secret ref**, never
   the key itself.
   > The schema pins `{type:"secret_ref", secretId:<uuid>}` with
   > `additionalProperties:false`. Per TOG-228 the host registers
   > `format:"secret-ref"` as `validate: () => true` — it checks **nothing** — so
   > a pasted plaintext key would otherwise be accepted and stored verbatim in
   > the config row.
3. De-risk with `whoami` first (no secret, no outbound call):
   ```bash
   curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
     "$PAPERCLIP_API_URL/api/plugins/omniroute-broker/api/whoami?companyId=$PAPERCLIP_COMPANY_ID"
   ```
4. Then `providers.list` (read, scrubbed), then the TOG-352 `providers.create`.

## Tests

```bash
node --test plugins/omniroute-broker/test/broker.test.mjs
node --test test_tog473_mapping_guard.mjs
```

Run these from the Ops Tooling root. Pass the broker test **file**, not the
directory — on Node 24 `node --test test/` resolves
`test` as a module specifier and dies before running anything.

## What I could not verify, and what it would take

Stated as loudly as what I did verify.

- **Claim 7 — that OmniRoute bills Claude to OpenRouter PAYG today.**
  Partially confirmed only. The live catalogue does show OpenRouter carrying
  Claude: of 1432 ids, 1005 are `owned_by: "openrouter"` and 337 are Claude ids,
  118 of them under the `openrouter/` prefix. So the paid path exists and is
  live. What I **could not** establish is which provider actually serves the
  *default* Claude route — `auto/claude-opus` is a server-side combo whose
  membership is only readable through `GET /api/combos` on the management plane,
  which is precisely the 403 this broker exists to work around. **Circular by
  construction: the first real use of the broker can close it.** The two-key rule
  for paid-traffic changes does not depend on the answer, so nothing in the build
  is blocked on it.
- **Whether `ALLOW_API_KEY_REVEAL` is enabled on this instance.** Default is
  `false`, but reading the effective value needs a management read. Treated as
  unknown; the design does not rely on it.
- **That a `manage` key returns `200` on `/api/providers`.** I confirmed my own
  `403`. The `200` half needs someone holding the credential — unchanged from
  what the issue itself said.
- **Anything about live behaviour.** No mutation has run against OmniRoute
  through this code. Every test is a fixture. Until the first live operation, the
  correct description is *"the gates are unit-proven and the manifest is
  host-validated"*, never *"the broker works"*.

## Not solved by this plugin

- It does not remove `OMNIROUTE_API_KEY` from agent environments. That key is an
  inference credential (403 on management) so it is not the same exposure, but it
  is still a projected secret and unbinding it is separate work.
- It does not narrow OmniRoute's own scope model. `admin` remains a superset that
  includes token minting. That ceiling is upstream and is not ours to change —
  which is the argument for the broker, not an argument against it.
