# `org-request-mcp` — authenticated CLI transport

A dependency-free HTTP MCP server that forwards requests to
`org_request_queue.sh` and `capability_gate.sh`.

The transport establishes **who is calling**, validates input and selects a
CLI. Authorization stays in the CLIs. Do not duplicate delegation ceilings,
capability risk classification or custody policy in this server.

## Identity and trust boundary

The expected path is an authenticated Paperclip tool gateway, a TLS reverse
proxy, this loopback-bound server, then a CLI invoked with `execFile` and an argv
array rather than a shell.

Configure the connection's `config.headerPolicy.metadata.forward` to include
`agent_id`, `company_id` and `run_id`. An empty forwarding list does not provide
an execution identity. Verify the gateway strips caller-supplied identity
headers and stamps its authenticated principal on the deployed revision.

For `tools/call`, the server:

- checks the bearer credential;
- requires UUID-shaped `x-paperclip-agent-id`, `x-paperclip-company-id` and
  `x-paperclip-run-id` headers;
- restricts the company to the configured tenant;
- corroborates the tuple against a `running` row in `heartbeat_runs` when live
  run checking is enabled; results have a bounded ten-second cache;
- refuses with `503` if corroboration cannot be measured, rather than trusting
  headers alone.

`tools/list` needs the bearer but no agent identity. It exposes schemas, not a
request inbox or a decision record. Catalog refreshes can therefore discover
tools without acquiring authority to execute them.

The server binds `127.0.0.1`. Remote access needs a separately reviewed TLS and
source-restricted proxy. Reachability, private-endpoint policy and container
networking depend on the deployment; this directory ships no deployment units
or assurance that a particular host is configured safely.

## Tools

| Tool | CLI operation |
|---|---|
| `submit_provisioning_request` | Queue `submit` |
| `review_provisioning_request` | Queue `review` |
| `read_my_requests` | Queue `inbox` for the authenticated principal |
| `submit_capability_request` | Capability `submit` |
| `review_capability_request` | Capability `review` |
| `countersign_capability_request` | Capability `countersign` |

No tool takes requester, reviewer, custodian, company or run identity as an
argument. Unknown arguments are refused, not silently dropped. Identity flags
are derived from the principal before forwarding. Provisioning and capability
request identifiers remain distinct so a request cannot be sent to the wrong
CLI accidentally.

Decision tools share paired `{alternative, why_it_failed}` records for safer
alternatives. Shape validation belongs here; whether a decision requires those
records belongs in the receiving CLI. Reading an inbox is neither acknowledging
nor delaying its decisions.

## Credential handling

The protected server config stores the bearer **digest**, not its value. It
must not have group or other permission bits. The gateway and proxy need
separately protected credential storage. Keep credentials out of URLs, argv,
logs and source control. The container engine used for corroboration and queue
execution must agree; `containerEngine` in config takes precedence over
`CONTAINER_ENGINE`, then the default is `podman`.

A bearer and a corroborated run are not proof that two agents are independent
security principals. If runtimes share credentials, files or a process
namespace, organizational separation of duties is not a technical isolation
boundary. Review that boundary before exposing credential-class decisions.

## Tests

```sh
node --test mcp/test/org-request-mcp.test.mjs
```

Tests use stub CLIs, a stubbed corroborator and an ephemeral loopback HTTP
server. They need no live company, database or credential. The MCP CI job also
checks mutation anchors: a mutant must parse, its unmutated baseline must pass,
and the intended assertion must reject it.

Deployment acceptance is separate from these tests. Verify gateway stamping,
proxy restrictions, protected config ownership, live-run refusal and both
positive and negative authorization controls on an explicitly approved target.
A local test result is not deployment evidence.
