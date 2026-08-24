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

The point is that **none of those values are caller-supplied**; the host derives
them from the run token.

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
  "scope": { "repoSource": "project", "profileSource": "default" }
}
```

## How scope is derived

Entirely server-side, from the issue the caller demonstrably holds:

1. **Repositories** — `GH_APP_REPOS` on the issue's project, falling back to the
   repo URL of the issue's primary workspace. All seven projects now pin it; see
   the table below.
2. **Permissions** — `GH_APP_PERMISSIONS` on the project, falling back to the
   default profile: `contents:write`, `pull_requests:write`, `issues:write`,
   `metadata:read`.

A project's `GH_APP_PERMISSIONS` **replaces** the default profile rather than
intersecting with it. That is deliberate: a project must be able to grant
`workflows:write` (Ops Tooling does) *and* to narrow below the default, and
intersection would quietly make the second case impossible.

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
| `repositories` is never empty | GitHub reads an omitted/empty array as **every repo in the installation** — the exact blast radius this issue exists to remove. An underivable scope raises `409`, it does not mint. |
| Callers may only narrow | Requesting a repo outside scope, a permission outside the profile, or a higher level is refused with `403` rather than silently clamped. |
| The PEM never leaves the host | Resolved at mint time, passed straight to the signer, never returned, logged, or persisted. Asserted directly in the mint test. |
| Nothing is shelled out | The JWT and token exist only as in-process strings passed to `ctx.http.fetch`, so neither lands in `/proc/<pid>/cmdline` (the **TOG-200** class of bug). |
| Internal errors are not echoed | Only our own error classes carry caller-visible text; anything else becomes `"Internal broker error."`. |

### ⚠️ `checkoutPolicy` must stay `always-for-agent`

This is the non-obvious one, and it was a real bug in the first draft of this
plugin. The host enforcement in `server/dist/routes/plugins.js` reads:

```js
if (policy === "required-for-agent-in-progress") {
  if (issue.status !== "in_progress" ||
      issue.assigneeAgentId !== req.actor.agentId) return;   // skips the check
}
```

`required-for-agent-in-progress` **skips `assertCheckoutOwner` in exactly the
case an attacker would choose** — an issue the caller does not own. With that
policy, any agent could mint a repo-scoped token for any project in the company
by naming a stale issue in it.

`always-for-agent` calls `assertCheckoutOwner` unconditionally, which requires
`status == in_progress` **and** `assigneeAgentId == caller` **and** a matching
run lock. The worker re-checks the first two itself as defence in depth.

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
   dispatch and that the host supplies run identity. Nothing on this instance
   had exercised that path before.
4. Then mint against a real in-progress issue and assert the acceptance
   criterion from TOG-174 — no `organization_*` key in `permissions`, and
   `repositories` a single repo rather than all 7.

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
