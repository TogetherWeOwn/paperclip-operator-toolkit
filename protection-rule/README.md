# protection-rule

Custom deployment protection rule, one Org App endpoint serving several
environments. It answers GitHub `deployment_protection_rule` webhooks and
**approves** only on a recorded CEO GO for the exact artifact under review. It
**rejects** everything else.

Two decision modes, selected per environment by the operator-owned policy
table (a JSON file the server reads at startup — see section 3):

- `plan` mode (migration apply): the apply run's plan artifact hash matches a
  plan run on the same commit **and** the CEO posted `GO <64hex plan hash>`
  on the environment's card.
- `sha` mode (production deploys): the CEO posted `GO <40hex head SHA>` for
  the exact commit under review on the environment's card. Production deploys
  carry no plan artifact, so the GO binds the commit itself.

The GO card is part of the approval key: a GO posted anywhere else approves
nothing. Adding an environment is a reviewed configuration change on purpose
— scope that moves without review is how an approver starts approving the
wrong thing.

## 1. Read this before you rely on it

**This is a closed-loop approver, not a monitor.** A silent endpoint does not
mean "no deployments pending" — it means nothing was answered. If this service
is down, deployments hang until GitHub's protection-rule timeout expires and
fails them closed. Watch the service, not the absence of approvals.

**A row of approval proves the secret was held, not that GitHub asked.** The
webhook signature proves possession of the App webhook secret. Anyone holding
that secret can forge a delivery that approves a deployment that was never
requested. The decision inputs are therefore recomputed from fresh API reads
(run, artifacts, comments) — never from delivery payloads — but the trigger
itself is still trust in the secret. Guard it like a credential, because it is
one.

**CEO GO is board text matched by narrow markers.** A comment counts only
when authored by the CEO agent identity and naming a digest bound to the
literal `GO` marker (`GO <64hex>` for plan hashes, `GO <40hex>` for deploy
SHAs). The two markers are disjoint by construction. Ordinary discussion never
approves. If the marker convention changes, update `src/board.js` and its
suite together — a scanner that matches more than the convention says is an
approval forged by prose.

## 2. How it decides

For each `deployment_protection_rule` delivery:

1. Verify the webhook signature (fail-closed: 401 unsigned, 503 unconfigured,
   413 oversized — all before any credential is used).
2. Resolve the (repository, environment) pair against the policy table.
   Foreign repos get the HTTP error, never a verdict; unserved environments
   on known repos get the HTTP error too, so the deployment never hangs on an
   answer this App cannot deliver.
3. Mint ONE installation token for THIS installation only, from the
   configured App identity. On any mint failure the verdict is REJECT; no
   other credential is ever tried (never substitute credentials).
4. Plan mode: fresh-read the apply run (head SHA), its claimed plan binding
   (`migrate-plan-binding: sha256=<hash> run=<id>` on the apply job, fixed by
   the migration apply contract), and the plan artifact chain (artifact list
   → zip download → manifest bytes → digest). SHA mode: fresh-read the run's
   head SHA only — there is no plan artifact to chase.
5. Scan the environment's Paperclip card for CEO GO markers on that exact
   digest.
6. `POST` the verdict to `deployment_callback_url`: `{ environment_name,
   state: approved|rejected, comment }`. The comment carries the stable
   reason id only — no hashes, no SHAs.

`src/decide.js` is the pure decision table; every other module establishes
one of its inputs. `decide` approves exactly two rows (verified plan + GO,
exact-SHA GO) and rejects every other shape, including every error shape.

## 3. Run it (operator)

Secrets travel by inherited environment, never argv. All are required; the
server refuses to start half-configured (exit 2):

- `PROTECTION_RULE_WEBHOOK_SECRET` — App webhook secret
- `PROTECTION_RULE_APP_ID` — GitHub App id for installation-token minting
- `PROTECTION_RULE_KEY_FILE` — path to the App RSA key (0600, read once)
- `PROTECTION_RULE_BOARD_TOKEN` — Paperclip credential for the CEO-GO scan
- `PROTECTION_RULE_BOARD_ORIGIN` — board origin, e.g. `https://board.example`
- `PROTECTION_RULE_POLICIES_FILE` — path to the operator-owned policy-table
  JSON file (read once; validated at startup)
- `PROTECTION_RULE_CEO_AGENT_ID` — CEO agent UUID for the GO scan
- `PROTECTION_RULE_PORT` — listen port (default 8788, loopback only)

The protected scope — (repository, environment) pairs plus each pair's GO
card — is operator-owned configuration, not code: it lives in the policies
file as a JSON array of `{ repository, environment, mode, goIssueId }`
objects (`mode` is `plan` or `sha`, `goIssueId` a UUID). The table is
validated at startup and an invalid table refuses to start, so an operator
can never run a scope the service did not accept.

```bash
node src/server.js
```

`GET /health` reports liveness only — never configuration or review history.
`POST /protection-rule` is the webhook route. Unknown paths are 404.

Register the endpoint as a custom deployment protection rule on each served
environment: the App needs Deployments read+write and the
`deployment_protection_rule` event subscription, installed on every served
repository.

## 4. Test it

```bash
npm run check   # parse every module and test
npm test        # offline suite, no network, no credential, no clock
```

Mutation-proven: a force-approve mutant (missing GO approves) goes red on the
GO rows, and an unverifying-receiver mutant goes red on the signature row —
verified by hand before pushing (see the PR body).
