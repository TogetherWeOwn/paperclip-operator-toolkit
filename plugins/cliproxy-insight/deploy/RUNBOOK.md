# cliproxy-insight — operator runbook

Standing up the read-only CLIProxy lane and enabling the plugin. Every step is
a script or a file in this directory; nothing here asks you to improvise.

**Read this first:** the plugin ships inert and stays inert until step 6. Steps
1–5 change the *edge*, not Paperclip. If you stop after step 4, you have
strictly improved security (the public `/v0/management/*` exposure is closed)
and changed nothing about the plugin.

## Status of the gates

| Gate | State |
|---|---|
| CISO containment review | **cleared** 2026-09-03 (TOG-817), conditional on 5 required changes — all implemented in `Caddyfile.snippet`, each marked `[REQUIRED CHANGE n]` |
| Real endpoint list (TOG-816 recon) | **done** 2026-09-05 by the operator — and it changed the design; see below |
| Sanitizer (the lane's origin) | **open** — TOG-975's producer half. This is now the critical path |
| Owner-reserved secret placement | **open** — see step 5, and it is cheaper than it was: the ask is a *Paperclip-minted bearer* only |

## ⚠️ What the recon changed

The operator measured CLIProxy **v7.2.140** on 2026-09-05. Two findings
invalidated the original design and are why this lane no longer proxies
CLIProxy at all:

1. **There is no usage endpoint in this build.** `/usage`,
   `/usage/statistics`, `/usage-statistics`, `/usage/summary`, `/quota`,
   `/request-statistics`, `/logs/summary` — all 404. The plugin's guessed
   `/usage-summary` does not exist upstream.
2. **The one counter-bearing route is identity-bearing.**
   `/v0/management/auth-files` carries the per-provider counters we want
   (`success`/`failed`, `status`/`disabled`, `weight`, `last_refresh`, and 20 ×
   10-minute `recent_requests` buckets) — but also `email`, `account`, `path`,
   `id`, `auth_index`, `project_id`, and a codex `id_token`. The same key also
   opens `/v0/management/api-keys` (an inference key **in clear**) and
   `/v0/management/config`.

So a path allowlist over CLIProxy's own API cannot contain this: the only
useful path is itself the thing we are withholding. **The boundary moved one
hop back.** A host-side sanitizer holds the management key, reads `auth-files`,
strips every identity field, and serves only derived counters. Caddy does the
edge controls in front of *that*.

Consequence worth stating plainly: **Caddy no longer needs the management key
at all.** Do not put `CLIPROXY_MGMT_KEY` in its environment.

Also not available from CLIProxy at any path: subscription-window utilization
and reset times (Claude 5-hour/weekly, Codex weekly). Those require calling
each provider's own usage endpoint with that auth file's token — host-side
collection, TOG-975's deployment half, not a CLIProxy call.

## What the containment buys

- **`CLIPROXY_INSIGHT_BEARER`** — the lane key (secret `cliproxy-usage-lane-key`)
  minted by us, held in Paperclip's secret store and in Caddy's environment. The
  worker sends it as the `x-api-key` header, and Caddy validates that header
  (`Caddyfile.snippet` section 3). Rotating it is `systemctl restart caddy`;
  no CLIProxy involvement, no owner involvement.
- **The real management key** — held by the sanitizer process only. Never in
  Caddy's config, never in Paperclip, never forwarded over this lane.

So the credential Paperclip holds cannot reach `auth-files`, `api-keys`, or
`config` — not because the plugin is well-behaved, but because no route to them
exists through the lane. `acceptance_insight_lane.sh` section 2 asserts all
three return 404 *while holding a valid bearer*.

---

## Step 0 — before touching the host (container-side, already done)

```bash
./acceptance_insight_lane_selftest.sh
```

Proves the acceptance suite is not vacuous: it mutation-tests each control
against `lane_sim.mjs` and requires each assertion to go red for its own
reason. **Last run: 9/9 green** (2026-09-05, TOG-952). Re-run it if you change
either script.

You do not need to run this on the host. It is here so that you are not the
first person to ever execute the acceptance suite.

### Also already done: the suite has been run against a REAL Caddy

TOG-952 stood up `Caddyfile.snippet` under **caddy v2.11.4** in a container,
against stand-in origins, and ran this suite through actual Caddy matchers
rather than the node sim. Result: **15 pass / 0 fail / 0 skip** — all six of
this issue's acceptance criteria, including the source-IP restriction, which
was provable because that host had a second local address to bind.

So step 4 on the host re-confirms on the real edge; it is not a first
discovery. What the container run could NOT cover, and you still are: TLS/ACME,
the real `CONTAINER_EGRESS` value, and the real sanitizer origin.

Three defects were found and fixed by that run; they are why this directory
changed. Measurements are on the TOG-952 thread:

1. **The logging block did not do what its own comment claimed.** It said
   "Caddy does not log headers by default." False — a bare `log` block logs the
   full request header map. `Authorization` and `Cookie` happen to be redacted
   by a Caddy default, so the bearer was never actually exposed, but any *other*
   credential-bearing header would have been logged in clear (measured:
   `X-Api-Key` appeared verbatim). Now fixed with an explicit `format filter`,
   which drops the fields entirely rather than relying on that default.
2. **The suite never tested HEAD or OPTIONS**, though the Caddyfile claimed to
   refuse them and this issue's criterion 4 names them. Both now tested and
   both return 404. (`curl -X HEAD` hangs; the suite uses `-I`.)
3. **Section 5 always skipped.** It now runs whenever the host has a second
   source address, and additionally proves the IP check precedes the bearer
   check — otherwise the lane is a bearer-validity oracle for an off-network
   scanner.

## Step 1 — recon ✅ done

Done by the operator on 2026-09-05; results on TOG-816 and summarised above.
`cliproxy_mgmt_recon.sh` remains here as the re-run tool: run it again after any
CLIProxy upgrade, because "no usage endpoint exists" is a fact about v7.2.140,
not a permanent property. If a future build adds one, the sanitizer may be able
to read a non-identity-bearing route directly and this design gets simpler.

## Step 2 — build the sanitizer (blocking, TOG-975)

**This is the critical path.** The lane has nothing to proxy until it exists.

Contract it must satisfy:

- Holds the management key. Reads `GET /v0/management/auth-files` on loopback.
- Emits **only** derived, non-identity fields: per-provider `success`/`failed`
  counters, `status`/`disabled`/`unavailable`, `weight`, `last_refresh`, and
  the `recent_requests` buckets.
- **Strips** `email`, `account`, `path`, `id`, `auth_index`, `project_id`, and
  the codex `id_token`. Keys by opaque model id per TOG-975's contract — never
  by account identity.
- Serves the plugin's per-lane files as read-only GETs on `127.0.0.1:8318`
  (adjust the `reverse_proxy` line in `Caddyfile.snippet` if you pick another
  port). v0.3 polls one file per lane -- `claude.json`, `codex.json`,
  `kimi.json`, `opencode-go.json`, `zai.json`, `antigravity.json` by default
  (the plugin's `laneFiles`) -- each an `{schemaVersion, observedAt, records[]}`
  document. There is no `/usage-summary` endpoint. The Caddy allowlist in
  `Caddyfile.snippet` section 1 must list exactly the files you serve here.
- Never exposes `/v0/management/*` in any form.

Provider subscription-window utilization (Claude 5-hour/weekly, Codex weekly)
is a separate collection loop in the same process — it needs each auth file's
token against the provider's own usage endpoint, e.g. Codex
`GET https://chatgpt.com/backend-api/wham/usage` with the access_token and
`ChatGPT-Account-Id` from `codex-*.json`. Those tokens live in the
`cliproxy-auth` volume and must never transit the lane.

## Step 3 — install the vhost

Substitute `CONTAINER_EGRESS` (from
`podman inspect -f '{{.NetworkSettings.IPAddress}}' <paperclip-container>`),
then place the bearer — and **only** the bearer — in Caddy's environment:

```bash
umask 077
printf 'CLIPROXY_INSIGHT_BEARER=%s\n' "$paperclip_bearer" \
  | sudo tee /etc/caddy/cliproxy-insight.env >/dev/null
sudo chmod 600 /etc/caddy/cliproxy-insight.env
sudo chown root:root /etc/caddy/cliproxy-insight.env
sudo systemctl edit caddy     # EnvironmentFile=/etc/caddy/cliproxy-insight.env
sudo systemctl restart caddy  # RESTART — reload does not re-read unit env
```

Mint `$paperclip_bearer` as a long random string (`openssl rand -hex 32`). It
is ours; it has no meaning to CLIProxy.

The management key does **not** go in this file. It belongs to the sanitizer
process from step 2. If you find yourself adding `CLIPROXY_MGMT_KEY` here, the
lane is being pointed back at CLIProxy and the containment is gone.

**Block A of the snippet closes the existing public `/v0/management/*`
exposure.** That is required change 3 and it lands in this same step, not
later — a narrow lane beside an open one is containment theater. If an existing
consumer breaks, report it on TOG-811; it is a finding, not a reason to reopen.

## Step 4 — accept the lane

```bash
export CLIPROXY_INSIGHT_BEARER=...
./acceptance_insight_lane.sh \
    --lane   https://cliproxy-insight.example.net \
    --public https://cliproxy.example.net
```

Exit 0 means accepted. Read the last lines, because there are two shapes of
success and they are not equivalent:

- **`pass 15 fail 0 skip 0`** — all six controls proven here, section 5
  included. Nothing further to do.
- **`pass 13 fail 0 skip 1`** — section 5 could not run, because this host
  offered no second source address. The summary says so explicitly. Source-IP
  restriction is then UNPROVEN: run the one-liner the suite prints from any
  other box and confirm 403 before step 5. If it returns 200 or 401, required
  change 1 is missing and a leaked bearer is usable from the internet.

If the host has a second address the suite does not find, pass it explicitly:
`INSIGHT_ALT_SOURCE=10.x.x.x ./acceptance_insight_lane.sh ...`

The suite aborts (exit 70) rather than reporting passes if the baseline is red,
because every other assertion is a refusal and a down lane refuses everything.
A baseline `403` specifically means you are running from a source the allowlist
does not name — expected if you are not on the container egress.

## Step 5 — the owner-reserved ask

Only now. The ask is: place the **Paperclip-minted lane bearer** (not the
CLIProxy management key) in the secret store. Evidence to attach: this runbook,
the green acceptance output from step 4, and the CISO sign-off on TOG-817.

Raised by the President & COO on the owner's behalf. Do not proceed past here
without it.

## Step 6 — enable, one company first

Set `laneApiKeySecretRef` to the new secret (the schema permits only this key;
`managementApiKeySecretRef` is rejected) and `pollingEnabled: true` on **one**
company. If you point the plugin at this self-hosted vhost rather than the
default edge, also set `baseUrl` to `https://cliproxy-insight.example.net`.
Watch `cliproxy_insight.poll_ok` and `poll_errors` for two firings (20 minutes).
Then roll out.

## Rollback

| Situation | Action |
|---|---|
| Plugin misbehaving | `pollingEnabled: false`. Takes effect next firing; no host access needed. |
| Bearer suspected leaked | Rotate `CLIPROXY_INSIGHT_BEARER` in the env file, `systemctl restart caddy`. The real management key is unaffected, and CLIProxy is not involved at all. |
| Lane suspected compromised | Remove the `cliproxy-insight.example.net` block and restart Caddy. Leave block A's 404 in place — that one is a security improvement independent of this feature. |
| Sanitizer emitting an identity field | Stop the sanitizer. The lane then 502s and the plugin logs poll errors, which is the correct failure. Do **not** repoint `reverse_proxy` at `127.0.0.1:8317` to "restore service" — that hands Paperclip `auth-files` directly and is the exact breach the lane exists to prevent. |
| Management key suspected leaked | Not a lane action. The key lives only in the sanitizer process (step 2); rotate it in CLIProxy and in the sanitizer's environment. Caddy, Paperclip, and this runbook's env file never held it. |

Note the asymmetry: only the last row touches the real management key, and it
is the one situation that is not about this lane. Everything the lane itself
can go wrong with is fixed by restarting a process we own. That is the point of
the bearer substitution, and it is what moving the boundary back to the
sanitizer preserved.
