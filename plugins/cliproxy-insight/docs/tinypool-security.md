# Tinypool security pin

This package overrides **only Vitest's Tinypool dependency** to `2.1.2`.
The lockfile records the registry tarball and SHA-512 integrity. Runtime plugin
code, the host SDK, Vitest itself, and other dependency families are unchanged.
Tinypool's Node requirement is compatible with this package's Node `>=22` floor.

## Why an override

Vitest 2.1.9 requests Tinypool `^1.0.1`; the old lock resolves `1.1.1`.
Two critical advisories affect that version:

- [GHSA-5gmw-xhrv-c9v3](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3):
  inherited worker `env` / `execArgv` options, patched in `2.1.1`.
- [GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr):
  inherited per-task `filename`, patched in `2.1.2`.

These are prototype-pollution **gadgets**, not evidence that the plugin contains
an attacker-controlled pollution source. Tinypool is a development dependency;
Vitest constructs it and passes per-run options. A polluted `Object.prototype`
could redirect a test worker. No production exploit or reachable remote entry
point is claimed. Vitest supplies explicit worker environment/arguments, but its
per-run options omit `filename`, leaving that conditional gadget relevant.

The scoped override crosses Tinypool's declared major range. It avoids an
unrelated Vitest/toolchain upgrade. Compatibility was verified with all 101
existing tests in both default (fork) and thread modes, plus typecheck and build
on Node 24.22.1. This is not a promise about every future Vitest pool API.

## Offline regression

From this package directory:

```sh
npm ci --include=dev --ignore-scripts
npm run verify
npm test -- --pool=threads
```

`npm test` runs `scripts/tinypool-security-regression.mjs` before Vitest, so the
existing CI job's `npm test` invocation enforces it without workflow changes.
Eight checks cover inherited `env`, inherited `execArgv`, inherited per-run
`filename`, and explicit-option positive controls in both pool runtimes.
Each check uses one worker in a fresh subprocess, a 10-second subprocess timeout,
a 64-KiB output limit, temporary benign workers, and prototype restoration.
No executable injection payload, network request, credential or live service is
used. Timeout signalling targets the probe process, not a guaranteed process tree;
these benign fixtures do not intentionally hang or exhaust resources.

Against Tinypool 1.1.1: six inherited-option checks fail, two explicit-option
controls pass. Against 2.1.2: all eight pass.

## Remaining work and rollback

This is **not a clean dependency-audit claim**. Other findings in this package
and the separate model-selection lockfile remain. Run `npm audit --include=dev`
to include the test toolchain; the environment may otherwise omit development
dependencies. GitHub default-branch alerts cannot close until the fix merges and
the dependency graph is refreshed; local results do not establish closure.

Rollback is a reviewed revert of the manifest, lockfile, regression and this note.
That restores known vulnerable test tooling and requires a recorded security
trade-off; do not remove the regression alone to make an older install pass.
