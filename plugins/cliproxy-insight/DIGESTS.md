# Pinned digests — cliproxy-insight

TOG-811 hard gate: *published with a pinned digest table before any operator
install* (TOG-809 precedent). An operator installs the artifact whose digest is
listed here for the version they were asked to install, and nothing else. A
mismatch is a stop, not a warning — the point of the pin is that the reviewed
bytes and the installed bytes are the same bytes.

## v0.3.1 — payload commit `273b84b75e924c7339c8c436de9d51f5dbacdb3d`

The final reviewed PR head also contains this digest table and the operator
packet; their later documentation commit does not alter these payload bytes.
Install only after independent exact-head review, green CI and non-author merge.
The archive must be pinned to the actual merged SHA recorded on TOG-4170, never
a moving branch. See `deploy/UPGRADE-0.3.1.md`.

| sha256 | file | bytes |
|---|---|---|
| `a3d24d1660b5815147de5c7238668cb6e42862c95b145f538df372ed25c2f173` | `dist/manifest.js` | 7238 |
| `a2146476cc1125ba2bda270ba14d58c3b7001e7611c89f7986e40ce47567e7e1` | `dist/worker.js` | 29970 |
| `eca1e5ec18787242435ba1338b3e0a84ac1476da8b9022c46d7d70d3e244c081` | `src/manifest.ts` | 5307 |
| `abe2bf55ceb60ee8352b333357d3208e435f2ecefa968bce9afa912532e8648b` | `src/worker.ts` | 39411 |
| `0140a151722b86d0b5e0d014d45c0fc89aea7fea43e4ca3f631154d33382d3a7` | `src/constants.ts` | 5694 |
| `acc684a391a5f3c7b31cc0b29b3914939e95e43ddf6c4f27853741a1d71c1bb0` | `src/config/schema.ts` | 4961 |

All four distribution files reproduced from a fresh locked install:

| sha256 | file | bytes |
|---|---|---|
| `6d74e927c55ed0ec819b508beb1fd6de64bb7eb0f4d198f5a596a542b045f5f2` | `dist/manifest.js.map` | 19055 |
| `054d19c081aa57f16993310e28adfea02a7ac09add79374ec89cd112362c7bb5` | `dist/worker.js.map` | 68075 |
| `d4e24899f11c995eafb18eca909ee451008b51d01a66632ad6b3b41f48712715` | `package-lock.json` | 56081 |

Clean verification: locked install, typecheck, **95/95** cases across four files
(82 original + 13 scope cases, counting each `it.each` row separately), build,
**9/9** rebuilt-worker checks, **9/9** stock-runtime contract scenario groups.
Two old-worker reproduction scenarios fail with the exact expected scope error.
The earlier second-company-refusal mutant and four review-revision mutants
(tool/API post-await guards, missing-ID throw, refusal metric) are killed.
See `deploy/COMPANY-SCOPE-CONTRACT.md` for exact case-count arithmetic.
None of this is live deployment acceptance; keep the installed 0.3.0 disabled.

## v0.3.0 — historical, disabled after failed canary — commit `890c8b7fe62a5d8fa0c51bcf721d7e1e8f0ee534`

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
