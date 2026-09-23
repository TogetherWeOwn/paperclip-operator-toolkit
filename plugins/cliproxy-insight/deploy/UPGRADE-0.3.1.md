# Immutable replacement packet — cliproxy-insight 0.3.1

For the existing **[TOG-3152](/TOG/issues/TOG-3152)** host step only, returned
through [TOG-4170](/TOG/issues/TOG-4170) and [TOG-811](/TOG/issues/TOG-811).
This is engineering handoff, not authority to install/re-enable now. No duplicate
operator card, Caddy work, router edits, management credentials or new grants.
The historical RUNBOOK's vhost/collector setup is not part of this replacement.

## Immutable source and gates

Payload commit: `273b84b75e924c7339c8c436de9d51f5dbacdb3d` in
`TogetherWeOwn/paperclip-ops-tooling`, path `plugins/cliproxy-insight`.
`../DIGESTS.md` pins six source/artifact files plus both maps and the lockfile.
The later packet/digest commit changes documentation only. Before any install,
TOG-4170 must record the final reviewed PR head, Code Reviewer PASS naming that
head, green CI on that head, and a **non-author** merge. Download the actual
merged SHA's immutable archive, not branch HEAD. Verify the pinned bytes are
unchanged from the payload commit. Stop on a mismatch.

Current installed identity (verify from the live row before touching files):

- plugin ID `83f42cfd-9795-44de-93b2-30bed90f33e9`, key
  `togetherweown.cliproxy-insight`;
- recorded package path `/paperclip/plugin-packages-root/cliproxy-insight-0.3.0-1ae5cccf`;
- status **disabled**, TogetherWeOwn config `pollingEnabled:false`, one config row;
- scheduled job `799c2b66-9146-4de1-8e61-7d5cef989275` (`cliproxy-poll`, */5);
- existing telemetry ref `153ddc6c-4d7d-4ad8-b71d-882d6cfd5ad4`; no value retrieval,
  creation, rotation, widening or new grant.

## Actual upgrade delta

| Surface | Change |
|---|---|
| Version | 0.3.0 → 0.3.1 |
| API version, SDK lock | unchanged: API 1, SDK 2026.824.1 |
| Capabilities | **remove `companies.read`**, add none; remaining capabilities unchanged |
| Company behavior | host-delivered configured identity; zero → inert, one → scoped polling, second distinct ID → all polling latched off until corrected/restarted |
| Lifecycle | adds `onConfigChanged`; `multiCompanyConfig:true` permits observing/refusing conflicting deliveries, not multi-company execution |
| Storage | no migrations; existing company state keys and payload schema unchanged |
| Secrets | same reference shape, scoped resolve and `configPath:laneApiKeySecretRef`; no cached value |
| Network | same HTTPS lane/base URL, six lane defaults, optional aggregate files, GET only; bounded timeout and no retries unchanged |
| Errors | config lookup is caught; config/secret failures log bounded reasons, not raw exception text |
| Scope refusal | `cliproxy_insight.company_scope_refused` records `multiple_companies` or `missing_company_id`; unattributed config returns without throwing but latches polling/reads inert until corrected/restarted |
| Read guards | tool and API re-check company binding after the scoped config await, before reading state |

## Preflight (isolated staging, before activation)

Inside the newly extracted plugin directory:

```sh
NODE_ENV=development npm ci --ignore-scripts --no-audit --no-fund
sha256sum dist/manifest.js dist/worker.js src/manifest.ts src/worker.ts \
  src/constants.ts src/config/schema.ts dist/manifest.js.map dist/worker.js.map package-lock.json
# Compare every row with DIGESTS.md; abort if any differs.
sha256sum dist/manifest.js dist/worker.js dist/manifest.js.map dist/worker.js.map > /tmp/insight-before.sha256
npm run verify
sha256sum -c /tmp/insight-before.sha256
node deploy/worker_host_harness.mjs
PAPERCLIP_ROOT=/app node --import /app/server/node_modules/tsx/dist/loader.mjs \
  deploy/stock_contract_harness.mjs
```

Expected: typecheck; **95 cases** (82 original + 13 scope cases, counting each
`it.each` row); **four reproduced dist files**; **nine** old wire checks;
**nine** stock integration scenario groups. The latter uses source from
the installed Paperclip tree and prints its hashes. Compare them to
`COMPANY-SCOPE-CONTRACT.md`; a changed host contract needs revalidation, not a
skipped test. Our sandbox ran Node 24.21.0/npm 11.19.0; the previous host was Node
22.23.2/npm 10.9.8, so host preflight is required. No test reads live secrets,
queries the live database or sends requests to the real telemetry lane.

## Disabled local-package replacement

Do not call `POST /api/plugins/:id/upgrade` against this disabled plugin: stock
`plugin-lifecycle.ts:639–647` rejects disabled status, and that route accepts only
`version`, not an arbitrary local path. Do not enable the old failing worker just
to make that endpoint pass. Retain the disabled plugin identity and package path;
replace its **complete package tree** atomically while stopped, then the existing
operator enable step can activate the new manifest from that same local path.

The operator must first verify the recorded `plugins.package_path` and disabled
status. If either differs, stop and reconcile on TOG-3152. Stage a full verified
package (including runtime node_modules) on the **same filesystem** as that path,
not over the active directory. Use the existing namespace-aware ownership method
(`podman unshare`, mapped 1000:1000 as in the original install), never real-root
chown. These are filesystem paths as visible in the approved container/namespace;
resolve the existing host mount using the original operator procedure, not a
new guessed host location.

After placing the verified tree at `STAGED`, and while the plugin is disabled:

```sh
PACKAGE=/paperclip/plugin-packages-root/cliproxy-insight-0.3.0-1ae5cccf
STAGED=/paperclip/plugin-packages-root/cliproxy-insight-0.3.1-273b84b7.staged
BACKUP=/paperclip/plugin-packages-root/cliproxy-insight-0.3.0-1ae5cccf.rollback-4170
# Inspect all three paths first; STAGED must contain the verified full package.
# Refuse to overwrite an existing rollback directory.
test -d "$PACKAGE" && test -d "$STAGED" && test ! -e "$BACKUP" || exit 1
mv "$PACKAGE" "$BACKUP" || exit 1
if ! mv "$STAGED" "$PACKAGE"; then
  mv "$BACKUP" "$PACKAGE"
  exit 1
fi
```

This preserves the original package tree intact. Do not use an in-place overlay
or partial `dist` replacement; do not uninstall or delete retained plugin data.
Do not expose raw admin responses: they may contain live credentials. Record
only IDs, status, version, digest counts, timestamps and sanitized outcomes.

## Same-card canary, only after operator authorization

1. Verify exactly **one** configured company (TogetherWeOwn), existing secret ref,
   unchanged lane defaults and `pollingEnabled:false`. Keep it false during
   activation. Use the supported admin enable action for the existing plugin;
   verify runtime/manifest version 0.3.1 and ready status. Stop/rollback on mismatch.
2. Verify one genuine scheduled firing succeeds while disabled in config, with
   no outbound lane calls. A manually triggered job is not a substitute.
3. Set `pollingEnabled:true` for that one company via the supported config API,
   preserving all other config fields. Verify two real */5 scheduled firings:
   no scope mismatch, fresh lane timestamps and scoped plugin state, no credential
   fields in persistence/log evidence. No retry loop or multi-company rollout.
4. If any delivery has a second configured company (even identical config) or
   lacks company identity, polling and reads must remain inert. Inspect the bounded
   `company_scope_refused` reason, not raw config/secret data. Do not loosen the
   tenant guard or secret scope. Correct the erroneous configuration/delivery
   under existing authority, then restart the plugin/replay; these in-memory
   latches intentionally cannot be cleared by another config save. A missing-ID
   delivery returns without throwing; a successful delivery alone is not proof
   that the worker is ready to poll. No whole-host restart is authorized.

## Rollback (stop first; never return to polling 0.3.0)

On first failure: persist `pollingEnabled:false`, then supported
`POST /api/plugins/83f42cfd-9795-44de-93b2-30bed90f33e9/disable` through the
operator's existing authenticated session. Verify disabled and stopped scheduler.
If config save fails, disable immediately rather than wait for another firing.
No uninstall, secret rotation/deletion, state cleanup or host restart.

If files must be restored, while disabled and in the same approved namespace:

```sh
PACKAGE=/paperclip/plugin-packages-root/cliproxy-insight-0.3.0-1ae5cccf
BACKUP=/paperclip/plugin-packages-root/cliproxy-insight-0.3.0-1ae5cccf.rollback-4170
FAILED=/paperclip/plugin-packages-root/cliproxy-insight-0.3.1-273b84b7.failed
# Inspect paths and verify disabled status before these moves.
test -d "$PACKAGE" && test -d "$BACKUP" && test ! -e "$FAILED" || exit 1
mv "$PACKAGE" "$FAILED" || exit 1
if ! mv "$BACKUP" "$PACKAGE"; then
  mv "$FAILED" "$PACKAGE"
  exit 1
fi
```

Retain the failed tree for diagnosis; confirm restored 0.3.0 pins and **keep it
disabled**. It is the known safe containment state, not a working polling
fallback. No migration rollback is needed. The commands and rollback have not
been executed on the host by this agent; record their actual outcome on TOG-3152.

## Future acceptance, not satisfied by local tests

Record deployment time and subsequent live evidence on the same host card.
After seven days, query scheduled `plugin_job_runs` joined to `plugin_jobs` and
`plugins`, filtered by plugin key and deployment time: company-scope mismatch
failures must equal zero. Also require expected successful firings and fresh
lane state so a disabled/inert worker cannot score a false green. Neither this
metric nor live installation/rollback is accepted by this packet alone.
