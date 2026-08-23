# Tool gateway identity verification (TOG-196)

`tog196-identity.test.ts` answers the question TOG-196 asserts but never verified:
**does Paperclip's tool gateway hand an `mcp_remote` server a per-agent,
non-spoofable principal?**

It answers it against the real gateway code path rather than by observation, so
it needs no operator, no second live agent and no registered `tool_connection` —
and unlike a host-side probe it never has to be reachable from anywhere.

Full analysis and the decisions that follow from it: [`docs/transport-identity.md`](../../docs/transport-identity.md).

## What it pins down

| # | Property | Why it matters |
|---|---|---|
| 1 | Two agents get two different `x-paperclip-agent-id` values, each the right one | Without this there is no requester, so no `reports_to` walk, so no reviewer |
| 2 | A caller-supplied `x-paperclip-agent-id` is dropped and the authenticated one stamped | The spoofing case a server-side observer **cannot** distinguish from a correct gateway |
| 3 | A `requester` tool argument arrives verbatim | Arguments are caller-controlled data; the TOG-196 server must never read identity from them |
| 4 | With no `headerPolicy.metadata.forward`, **no** identity header is sent | The default, and the trap — a connection registered the obvious way is silently anonymous |
| 5 | A `127.0.0.1` endpoint is refused under this instance's deployment settings | The issue's "bind loopback only" instruction cannot work here |
| 6 | `POST /api/tool-gateway/sessions` binds to the authenticated agent, not `body.agentId` | The header is only as good as the session it is read from |

Properties 2 and 6 are the two spoofing tests. They sit at different layers and
both have to hold: 6 is where identity is *decided*, 2 is where it is *transmitted*.

## Running it

The test imports Paperclip's own server internals, so it runs inside the
Paperclip container against that tree — it is not runnable from this repo alone.

```sh
cp verification/tool-gateway-identity/tog196-identity.test.ts \
   /app/server/src/__tests__/tog196-identity.probe.test.ts
cd /app/server && ./node_modules/.bin/vitest run src/__tests__/tog196-identity.probe.test.ts
```

It boots its own embedded Postgres and a loopback fake upstream, and cleans both
up. Nothing outside the test database is touched. Remove the copy when done —
we do not leave artifacts in the vendor tree.

Last run: see [`RESULT.txt`](./RESULT.txt) — 6/6 passing against
`PAPERCLIP_BUILD_VERSION=v2026.817.0-0-g213dabab4`.

## Re-run it when

- The Paperclip build version changes. Every property here is *their* behaviour,
  not ours; nothing stops it drifting in an upgrade, and properties 2, 4 and 6
  fail silently rather than loudly if it does.
- Before registering the TOG-196 `tool_connection` for real.

This is the upstream-candidate form of the test. Property 4 in particular is
arguably a defect worth reporting: a connection with no `headerPolicy` gets no
identity header, no warning and no error.
