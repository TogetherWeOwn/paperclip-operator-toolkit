# `org-request-mcp` — the host-side MCP transport

**Issue:** TOG-196 · **Epic:** TOG-194 · **Design evidence:** [`docs/transport-identity.md`](../docs/transport-identity.md)

A small HTTP MCP server that runs **on the host** as the operator user and forwards
exactly two tool calls into `org_request_queue.sh`.

It is a **transport**. It decides *who is calling*. It decides nothing about
*what they may do* — that is `org_request_queue.sh`, and it is not duplicated
here. If you are about to add a rule to this server that decides whether a
caller *may* do something, it belongs in the queue. Two copies of an
authorization rule drift, and then there are two places to get it wrong.

---

## Why it is on the host at all

A `local_stdio` MCP server is spawned via `child_process.spawn` from the
**Paperclip server process**, which runs inside the container. That container
mounts one host path and has no podman socket. The CLIs reach the database via
`podman exec paperclip-db psql` and read `~/secure-drop`. A `local_stdio` tool
therefore cannot run them at all.

`mcp_remote` it is — but not loopback-only, for two independent reasons
verified in `docs/transport-identity.md`:

1. The gateway's SSRF guard (`assertPublicRemoteHttpEndpoint`) refuses loopback
   and RFC1918 on this deployment, on **every call**, with hostnames resolved
   first. `PAPERCLIP_DEPLOYMENT_MODE=authenticated` +
   `PAPERCLIP_DEPLOYMENT_EXPOSURE=public` ⇒ `allowPrivateRemoteEndpoints()` is
   false.
2. The gateway's `127.0.0.1` is the **container's** loopback, not the host's.
   The outbound `fetch` originates inside the container.

So the server binds loopback and Caddy fronts it on a public hostname — the
branch the issue's own *"behind the established Caddy pattern if it needs to be
reachable at all"* clause sanctions. Resolved by the Chief of Staff under
`board_or_agents` on 2026-08-24, with six conditions, all of which are
implemented and tested below.

---

## The identity chain

```
agent (model)
  │  cannot influence anything below this line
  ▼
Paperclip tool gateway (in container)
  stamps x-paperclip-agent-id / -company-id / -run-id from a row in
  tool_gateway_sessions. Caller-supplied x-paperclip-* headers are classified
  sensitive and dropped; stamped values are written last regardless.
  │  https + Bearer, resolved per call from Paperclip's secret store
  ▼
Caddy on the host — TLS, bearer termination, source restriction to the
  container's egress address. Not a naked passthrough.
  │  127.0.0.1:8391
  ▼
org-request-mcp
  requires the identity headers, and corroborates (agent, run, company)
  against heartbeat_runs before running anything.
  │  execFile, argv array, no shell
  ▼
org_request_queue.sh  ← every authorization decision happens here
```

### Three legs, and why the third exists

The bearer proves *this came from our gateway*. The agent header proves *the
gateway says it was this agent*. Those two alone mean *anyone holding the bearer
can name any agent* — the hostname is public, so that is not hypothetical.

The third leg closes it: the server queries `heartbeat_runs` and requires a
`running` run whose `id`, `agent_id` and `company_id` all match the headers.
Forging an identity then requires guessing a currently-live run id belonging to
the victim, not merely knowing their agent id. The status set mirrors the
gateway's own `ACTIVE_GATEWAY_RUN_STATUSES` (`running`) deliberately; if
upstream widens it, we narrow relative to the gateway, which fails closed.

A database we cannot reach is a **503**, never a fallback to trusting the
header. CI has a mutation that proves the suite rejects the fail-open version.

---

## The trap that silently voids the whole epic

`readHeaderPolicy` derives metadata headers from
`config.headerPolicy.metadata.forward`. **The default is the empty list.**

A connection registered the obvious way — `url` and nothing else, the Zapier
pattern the issue points at — forwards **no `x-paperclip-agent-id`**. No error,
no warning, no degraded health. The transport is silently anonymous, which is
the exact failure the epic exists to prevent.

Two consequences, both load-bearing:

- The connection **must** carry the `forward` list. See
  [`deploy/tool-connection.example.json`](deploy/tool-connection.example.json).
  It goes under `config`, not `transport_config` — `readHeaderPolicy` checks
  `config` first and falls back; do not rely on the fallback.
- The server **fails closed** on a missing agent header, so a misconfigured
  connection is loud on its first `tools/call` rather than silently anonymous.
  The 403 names the fix.

### Why `tools/list` is anonymous and `tools/call` is not

The gateway's catalog refresh and health check (`tool-access.ts` `remoteTools`)
POSTs `tools/list` with **credential headers only** — no session, therefore no
identity headers. Requiring identity there would make the connection
permanently unhealthy and unregisterable.

Discovery is public-with-bearer; execution requires a principal. That asymmetry
is deliberate and safe: `tools/list` reveals only the two tool schemas.

---

## Secrets

| Where | What | Why it is safe |
|---|---|---|
| Paperclip secret store | the bearer | Injected per call as `authorization` by `resolveCredentialHeaders`. Held by the **gateway**, never in an agent's env, argv or workspace — there is nothing in agent-readable memory for a same-uid process to lift. |
| `/etc/caddy/org-request-mcp.env` | the bearer | 0600, root-owned. Read by systemd as Caddy's `EnvironmentFile`; this is where `{$ORG_MCP_BEARER}` in the site block is expanded from. One file, one consumer — an earlier draft also had the operator write a `.bearer` file that *nothing read* (TOG-341). |
| `/etc/org-request-mcp/config.json` | **sha256 of** the bearer | The server refuses to start if the mode has group or other bits. A read of this file does not yield a usable credential. |
| `transport_config.url` | **nothing** | The existing Zapier row carries its token in plaintext in the URL. That half of the pattern is deliberately not copied. |
| argv | **nothing** | `/proc/*/cmdline` is world-readable and every company on this box shares the host. The config *path* is an argument; the config *contents* are not. |

Leave `versionSelector` unset (`latest`). A pinned selector silently keeps
serving the old value through a rotation — so a bearer rotated *because it
leaked* would go on working.

---

## The two tools

Exactly two, per the issue and condition 5 of the approval. Neither takes an
identity, and there is no tool that runs the provisioner directly — the queue
is the only entry point, and CI asserts the string `org_provisioner` never
appears in the server source.

| Tool | Arguments | Becomes |
|---|---|---|
| `submit_provisioning_request` | `template`, `title`, `rationale?`, `supersedes?` | `submit --requester <authenticated agent> …` |
| `review_provisioning_request` | `request_id`, `decision`, `reason?`, `alternatives?`, `no_safer_alternative?`, `alternatives_considered?` | `review --reviewer <authenticated agent> …` |

`--requester` and `--reviewer` are written by the server from the authenticated
principal, every time. They are structurally unreachable from tool input.

**Safer-alternative-first (TOG-388).** The last three properties are not optional
extras. The queue *refuses* a denial carrying neither `alternatives` nor
`no_safer_alternative`, and refuses to grant a risky template without
`alternatives_considered`. They are declared here because this transport enforces
its own schema — an undeclared key is refused, not dropped — so leaving them out
would leave every agent reviewer hitting a refusal it had no way to satisfy: fail
closed, but a hard block on the only sanctioned agent path to the queue.

`alternatives_considered` is an array of `{alternative, why_it_failed}` **objects**
rather than two parallel arrays, and the server emits each pair adjacently as
`--considered X --because Y`. That shape is the control: two parallel arrays could
arrive at different lengths and silently pair alternative 1 with reason 2,
producing a record that is fully populated and entirely wrong — worse than a
missing one, because it reads as diligence to the auditor whose job is to read it.

This layer validates **shape** (type, length, pairing, no leading `-`, no NUL);
`org_request_queue.sh` validates **policy**. Re-implementing the policy here would
give the queue two enforcement points that can disagree, and the one an agent
reaches would be the weaker of the two.

**Unknown arguments are refused, not dropped.** Each schema says
`additionalProperties: false`, and since TOG-341 that is *enforced* rather than
merely advertised: any key the tool does not declare is a `unknown_argument`
refusal naming what the tool does accept. There is no JSON-Schema validator in
this process — deliberately, since an npm tree next to a podman-capable
operator account is a supply-chain surface — so the check reads the same schema
object `tools/list` hands out. Add a property to a schema and it is accepted;
add it nowhere and it is refused. The two cannot drift.

An argument named `requester`, `reviewer`, `reports_to`, `on_behalf_of` (and a
dozen more) is **refused by name**. That denylist is now genuinely redundant for
safety — every name on it is already an undeclared key — and load-bearing only
for the *message*: `requester` and `templat` are both unknown keys, but only one
of them is someone trying to be somebody else, and the audit log should say
which. Before TOG-341 it was the other way round, and the header claimed
otherwise.

Either way the refusal is loud. A silent drop would let a caller believe it had
acted as someone else right up until it read the audit log. CI mutates each of
these controls out in turn and requires the suite to go red.

The queue's own refusals (`REFUSED: template … is above the request ceiling`)
come back as MCP tool errors with the text intact, not as transport failures —
a denial the epic designed to be *answerable* must not arrive as an opaque 500.

Deferred to a follow-up, deliberately: `list`, `who`, `thread`, `comment`. The
issue says two tools initially and the approval repeats it.

---

## Running the tests

```sh
node --test mcp/test/org-request-mcp.test.mjs
```

Zero dependencies, fully offline — a stub queue script, a stubbed corroborator,
a real HTTP server on an ephemeral loopback port. No podman, no database, no
company. That is a design constraint on the server, not a convenience: a
transport whose refusals can only be tested against production is a transport
whose refusals are not tested.

CI runs it on Node 24 (the host's major, not the runner default) in the
`mcp-suite` job, plus five mutation guards and a source-surface check. Each
guard proves the unmutated copy passes in the staging directory first, asserts
its needle matches exactly once (`String.replace` takes only the first match, so
a duplicated site would silently mutate the wrong one), and checks the mutant
still parses — a mutation that fails to parse fails the suite for the wrong
reason, which reads exactly like success.

---

## Install

See [`../operator-handoff/TOG-196-mcp-install-runbook.md`](deploy/) — or
`/paperclip/operator-handoff/TOG-196-mcp-install-runbook.md` on this box.
Artifacts live in [`deploy/`](deploy/):

- `config.example.json` — the server config, and how to generate the bearer/digest pair
- `Caddyfile.snippet` — TLS, bearer termination, source restriction
- `org-request-mcp.service` — systemd unit, runs as the operator user
- `tool-connection.example.json` — the registration payload, with the `forward` list
- `acceptance_live.sh` — **runbook step 9, as a script.** Run it on the VPS
  after step 8. See below.
- `acceptance_live_selftest.sh` — proves that script is not vacuous. Runs in CI.

### Step 9 — `acceptance_live.sh` (TOG-365)

```sh
sudo -v
./mcp/deploy/acceptance_live.sh --url https://MCP_HOSTNAME/mcp
```

Three things make it a script rather than the four pasted `curl`s the runbook
originally carried.

**The refusal codes do not discriminate.** Step 9(1) sends a call with *no*
identity headers and asserts `403` / `identity_header_missing`. The missing-agent,
missing-company and missing-run arms all raise that one code, so the assertion
holds even against a server that resolves a missing agent id to some principal —
which is the exact bug the container suite found by mutation. Phase 3 of the
self-test reproduces that: the old assertion stays green against the mutant.
Section 3 of the new suite omits **exactly one** header and asserts on the
message.

**Every negative needs a positive control.** With `requireLiveRun` ON, a control
call needs a real `(agent, run, company)` triple that `heartbeat_runs` will
corroborate, so section 1 queries the database for a RUNNING one instead of
inventing it. Section 2 then proves that call is *admitted* — note "admitted",
not "created": a queue-level authorization refusal arrives as HTTP 200 and means
the transport let the call through, which is what makes sections 3 and 6
attributable. If the baseline is red the suite stops rather than reporting
refusals that would have happened anyway.

**Ordering.** The `requester`-argument refusal lives in `buildQueueArgs`, which
runs *after* identity and *after* corroboration. Sent without valid headers it
would be refused earlier and the "appends nothing" line count would hold for a
reason unrelated to argument handling — so section 4 carries the full live
identity, and checks the spoofed id appears nowhere in the queue as well as
checking the count.

Sections 8 (Caddy's `remote_ip` restriction, needs a different host) and 9 (the
gateway stamping the header, needs an agent with a real session) are reported as
`SKIP` and never as `PASS`; the summary names them. Any *other* skip exits
non-zero — an assertion that could not run must not read as one that passed.

---

## Residual risks

1. **A leaked bearer plus a known live run id.** The three legs make this hard,
   not impossible. Mitigated by the Caddy source restriction (condition 5 — not
   optional) and by the bearer never existing in agent-readable space. This is
   the risk to re-examine first if anything here changes.
2. **The gateway session token.** Everything rests on agent X not holding agent
   Y's session token. Both minting paths derive the agent from the database,
   tokens are hashed at rest, expiring, revocable, and re-checked against a live
   run. What could not be traced from inside the container is where the token is
   *delivered* to an agent. **Re-check at registration time** — that is the
   moment it becomes observable, and it is a step in the runbook.
3. **The opt-in default.** One config edit from an anonymous transport, failing
   open and silent on the gateway's side. Control 3 is what makes it loud on
   ours. Do not remove it on the grounds that the header "is always there".
4. **Upstream drift.** Every gateway property relied on here is Paperclip's
   behaviour, not ours. Re-run `verification/tool-gateway-identity/` on every
   build change.
5. **`201` on a rejected identity claim.** `POST /api/tool-gateway/sessions`
   silently overrides a body `agentId` rather than rejecting it. Correct
   outcome, misleading signal — anyone probing by hand reads that 201 as a
   successful spoof. Worth reporting upstream as a `403`.
