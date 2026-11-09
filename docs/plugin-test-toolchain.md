# Patched plugin test toolchain

## Bounded replacement

Both model-selection and CLIProxy Insight use exact dev-toolchain pins:

| Package | Replacement | Reason |
| --- | --- | --- |
| Vitest and all seven `@vitest/*` packages | 4.1.12 | Covers the UI-server advisory and both newer mocker advisories. |
| Vite | 6.4.5 | Smallest supported major with fixes for the original eight advisories **and** the 6.4.4 backport regression. |
| esbuild and its optional platform packages | 0.25.1 | Covers the cross-origin development-server advisory; replaces both original esbuild versions. |
| Tinypool (CLIProxy Insight standalone regression) | 2.1.2 | Preserves the existing reviewed security pin and regression. |

Vitest 3.2.6 is insufficient: [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)
requires 4.1.11, and [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8)
requires mocker 4.1.12. Vitest 4.1.12 also covers
[GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp).

Vite 6.4.4 covers the original advisory group:
[4w7w](https://github.com/advisories/GHSA-4w7w-66w2-5vf9),
[fx2h](https://github.com/advisories/GHSA-fx2h-pf6j-xcff),
[v6wh](https://github.com/advisories/GHSA-v6wh-96g9-6wx3),
[698v](https://github.com/advisories/GHSA-698v-4r3x-3vcv),
[587h](https://github.com/advisories/GHSA-587h-7wmj-h5pm),
[r825](https://github.com/advisories/GHSA-r825-w8mm-5pxw),
[rq7h](https://github.com/advisories/GHSA-rq7h-c2jc-7f22), and
[9jrq](https://github.com/advisories/GHSA-9jrq-w75r-8gcw).
But [GHSA-8g5g-mxqh-grgj](https://github.com/advisories/GHSA-8g5g-mxqh-grgj)
affects **exactly 6.4.4**, so that candidate was rejected after lock-only audit.
The corrected pin is 6.4.5.

esbuild 0.25.1 covers [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99).
The advisory minimum is 0.25.0, but its Android ARM artifact's immutable
registry SHA-512 contains a substring matched by the repository's disclosure
scanner. The initial Actions run rejected that lockfile. Rather than weakening
the scanner, omitting a platform, or altering/obfuscating integrity, use the next
patch 0.25.1 and qualify it normally. This is the smallest candidate satisfying
the existing disclosure contract; it is not a claim that 0.25.0 is unpatched.
Tinypool 2.1.2 covers both
[GHSA-5gmw-xhrv-c9v3](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3) and
[GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr).
The CLIProxy Insight `vitest.tinypool=2.1.2` override and standalone regression
remain. Vitest 4 no longer uses Tinypool; an explicit dev dependency keeps the
regression runnable without relying on Vitest's former transitive dependency.
model-selection no longer needs or locks Tinypool.

## Resolution allowlist and installation controls

The migration replaces the Vitest/Vite/esbuild graph, not the host SDK. Native
npm overrides tie **all** Vite and esbuild resolutions to their exact direct
pins, avoiding a second vulnerable nested copy. Registry resolution used npm
11.19.0 with workspace-local `min-release-age=3` and `ignore-scripts=true`.
The core replacements were published more than three days before resolution.

The reviewed version-change/addition allowlist is:

- `vitest`, `@vitest/expect`, `@vitest/mocker`, `@vitest/pretty-format`,
  `@vitest/runner`, `@vitest/snapshot`, `@vitest/spy`, `@vitest/utils`: 4.1.12.
- `vite`: 6.4.5; `esbuild` and every `@esbuild/*` optional platform package: 0.25.1.
- Vitest's new dependency edges: `@standard-schema/spec` 1.1.0,
  `@types/chai` 5.2.3, `@types/deep-eql` 4.0.2, `chai` 6.3.0,
  `convert-source-map` 2.0.0, `es-module-lexer` 2.3.2, `obug` 2.2.1,
  `pathe` 2.0.3, `std-env` 4.3.0, `tinyexec` 1.3.1, `tinyrainbow` 3.2.0.
- Vite's new glob dependency edges: `fdir` 6.5.0, `picomatch` 4.0.7,
  `tinyglobby` 0.2.17.
- Obsolete Vitest/Vite dependencies removed: `cac`, `check-error`, `debug`,
  `deep-eql`, `loupe`, `ms`, `pathval`, `tinyspy`, `vite-node`, model-selection's
  Tinypool 1.1.1, and Vite's nested esbuild 0.21.5/platform copies.
- CLIProxy Insight retains Tinypool 2.1.2. npm fills previously absent registry
  URL/integrity metadata for retained tooling entries, without changing their
  versions: `@jridgewell/sourcemap-codec`, `assertion-error`, `estree-walker`,
  and `magic-string`.

New/changed artifact integrity values were compared with exact-version registry
metadata. Every previously locked runtime package entry is unchanged, including
SDK/shared 2026.824.1 and transitive Zod. Unrelated exact edges such as Rollup's
`@types/estree` 1.0.9 and `stackback` 0.0.2 are retained. Compatible source-map-js
and fast-uri patches are separate source work, not duplicated by this migration.

Neither root has install/prepare/pack hooks. The new lock's install-hook
candidates are esbuild 0.25.1 (`node install.js`) and unchanged optional macOS
fsevents 2.3.3. esbuild's reviewed installer can invoke npm or fetch a platform
binary: it remains **disabled**, using the packaged optional platform binary
instead. tinyexec declares `prepare: npm run build`; registry installation uses
its published artifact, with scripts still disabled. **Lifecycle exception
allowlist: empty.** Do not enable scripts to repair a failed build.

`npm ci` is frozen installation, not a retrospective release-age check. Older
npm versions may not support age filtering; do not claim they enforce it merely
because they read the key. Resolution uses the verified native npm version;
Actions must record its actual install tool version and keep script refusal.
No plugin installation, host-package update, credential or provider change is
part of this migration. SDK/Zod advisories remain unresolved by this work.

## Pool and mutation API qualification

[Vitest's pool migration](https://vitest.dev/guide/migration#pool-rework) removes
`poolOptions`, `minWorkers`, and the old pool-specific limit environment variables.
The gate keeps accepting legacy `VITEST_MAX_FORKS`/`VITEST_MAX_THREADS` inputs,
then translates one resolved cap into `--pool=forks`, `--maxWorkers`, and
`VITEST_MAX_WORKERS`. The latter is overwritten in the child environment because
Vitest resolves it after CLI options; a conflicting inherited value must not
silently defeat the cap. Nested Vitest runs inherit the same bound.

The alias oracle uses supported flags, a one-worker environment, and the JSON
reporter. It still requires a passing unmodified baseline, assertion failures
for every mutant, and complete execution. The main mutation gate retains its
CI-only refusal, two-worker default, cache refusal, per-run timeout/output bound,
isolated baseline and completed-summary checks. Runner errors are not mutant
kills.

GitHub Actions is the qualification authority. The
`plugin-toolchain-qualification` job is part of the required `ci-ok` dependency graph:

- Node 22 and 24, both plugins: script-free clean install, observed fork/thread
  pool selection and concurrent worker bound, typecheck, full suite, build.
- model-selection on both runtimes: alias mutation JSON-reporting controls.
- Existing Node 24 matrix: every named mutation shard and required aggregator.
- Existing CLIProxy Insight test command: unchanged standalone Tinypool
  regression before the Vitest suite.

`qualify-vitest-pools.mjs` writes four harmless fixture files, requires each to
complete in the requested native pool, checks a conflicting inherited worker
limit cannot bypass the cap, and cleans up in `finally`. Passing a config-string
comparison alone is not pool qualification. Record exact-head Actions run/job
links and conclusions before claiming acceptance. No local full suite or build
is a substitute.

REA angle: registry dependency edges, shipped CLI/config/pool code and the
upstream migration guide define the compatibility contract. No replacement pool,
resolver, test runner or host SDK fork is introduced.
