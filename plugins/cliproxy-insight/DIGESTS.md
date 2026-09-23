# Pinned digests — cliproxy-insight

TOG-811 hard gate: *published with a pinned digest table before any operator
install* (TOG-809 precedent). An operator installs the artifact whose digest is
listed here for the version they were asked to install, and nothing else. A
mismatch is a stop, not a warning — the point of the pin is that the reviewed
bytes and the installed bytes are the same bytes.

## v0.3.0 — commit `890c8b7fe62a5d8fa0c51bcf721d7e1e8f0ee534`

Branch `tog811-lane-consumer`, pushed and confirmed on the remote.
`dist/` is committed and is built from exactly the `src/` listed below
(`npm run build`, esbuild, no post-processing).

| sha256 | file | bytes |
|---|---|---|
| `ddbba83d217c420f2e1b313d0d9a0dbe978e3824018d3ea64182781663ce42ca` | `dist/manifest.js` | 7375 |
| `989a72c2e24407b7ac480c12a7edfd5effad503bd88cfa6b8ad2d2999d3f96c4` | `dist/worker.js` | 28517 |
| `77eab3e8549100d3a657f3f1847ef393512f4982cda56e620dbae97d9d71cfe6` | `src/manifest.ts` | 5444 |
| `9441d5750b7c6a1db1895cdad9f134ef3b31abcb9f7fef5c3a87595284974e5c` | `src/worker.ts` | 37229 |
| `6335b036a9a8f1a033f97fa9c69810e5fee569c0f8de07ff45d5739d5771776f` | `src/constants.ts` | 5694 |
| `acc684a391a5f3c7b31cc0b29b3914939e95e43ddf6c4f27853741a1d71c1bb0` | `src/config/schema.ts` | 4961 |

Verify before installing:

```sh
cd paperclip-ops-tooling/plugins/cliproxy-insight
# The digests, not HEAD: this file is itself a later commit, so a HEAD check
# would go stale on every edit and be re-derived by whoever noticed.
sha256sum dist/manifest.js dist/worker.js src/manifest.ts src/worker.ts \
          src/constants.ts src/config/schema.ts
npm run verify                        # typecheck + 82 tests + rebuild
node deploy/worker_host_harness.mjs   # 9 checks against the BUILT worker
```

`npm run build` is deterministic here: rebuilding reproduces both `dist/`
digests above — verified, not assumed. If a digest does not match, the tree is
not the reviewed one; stop and say so rather than installing.

## Credential this version needs

One, and it is not the CLIProxy management key: `cliproxy-usage-lane-key`, the
telemetry-lane bearer, sent as `x-api-key`. It reads allowlisted static JSON and
reaches nothing else; `/v0/management/*` is not routable through the lane, and
`onValidateConfig` refuses a `baseUrl` naming it. The management key stays on
the host and never enters Paperclip — see README, "the gate is dissolved".

## v0.2.0

Not published with a digest table and never installed. It polls two files the
lane no longer serves; **do not install it.** Superseded by v0.3.0.
