# Plugin dependency security maintenance

## Compatible patch group (2026-11-09)

Only these lock entries are updated, using npm 11.19.0's native resolver:

| Package | Workspace | Before | After |
| --- | --- | --- | --- |
| source-map-js | cliproxy-insight, model-selection | 1.2.1 | 1.2.2 |
| fast-uri | cliproxy-insight | 3.1.8 | 3.1.9 |

`postcss` accepts source-map-js `^1.2.1`; `ajv` accepts fast-uri `^3.0.1`.
No manifest dependency range, override or other lock entry changes. This was
checked by comparing every package entry (including nested copies, versions,
resolved URLs and integrity fields) against the base commit. npm also refreshed
the root lock license metadata; that unrelated change was restored.

### Installation controls and script inventory

Both workspace-local `.npmrc` files set `min-release-age=3` (days) and
`ignore-scripts=true`. The update tool reported effective values `3` and `true`.
The patches were published on 2026-09-30 and 2026-10-19 respectively, so neither
needs an age exception. Use npm 11.19.0 or a version verified to enforce the age
setting for future resolution; an older npm warning is not age enforcement.
Frozen installation alone is not a retrospective provenance check.

Neither workspace has root preinstall/install/postinstall/prepare/pack hooks.
The locked install-hook candidates are esbuild 0.24.2, Vite's nested esbuild
0.21.5, and optional fsevents 2.3.3. All remain unchanged and their lifecycle
scripts stay disabled, with **no exceptions**. Neither patched package declares
an install hook. Their registry metadata records SHA-512 integrity in the locks.
Named first-party commands remain explicit; existing CI uses
`npm ci --include=dev --ignore-scripts` in both workspaces. CLIProxy Insight then
runs typecheck, tests and build; model-selection runs tests and build, but does not
run `npm run typecheck`. Do not enable all install scripts to repair a build.
Clean install, full suites and builds are verified in GitHub Actions, not on the
shared development host.

### Held pins

The exact host SDK and shared package remain `2026.824.1`, including the SDK's
exact shared dependency edge. The exact Vitest family edges stay `2.1.9`, Rollup's
`@types/estree` edge stays `1.0.9`, and `stackback` stays `0.0.2`. CLIProxy
Insight's reviewed `vitest.tinypool=2.1.2` override and its regression remain
unchanged. All other packages, including nested esbuild copies and runtime Zod,
are held, not silently refreshed. The existing tests contained no installed-version
assertion for the two patch targets. New dependency-security tests check the
reviewed versions in the lock and the installed root copy, all nested lock copies,
the native install controls, and the retained SDK/security pins.

## Advisory disposition

The paginated default-branch Dependabot response contained **36 open alert
records** on 2026-11-09. Records are not unique vulnerabilities, package counts or
proof of runtime exploitation. All advisory families were reviewed; selecting the
first patched version of Vitest would leave later advisories unresolved.

| Advisory | Disposition |
| --- | --- |
| [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) | source-map-js indexed-map offset resource exhaustion: patch to 1.2.2 in both locks. |
| [GHSA-w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg) | fast-uri percent-encoded scheme spoofing: patch to 3.1.9. |
| [GHSA-xhq7-xmqj-769h](https://github.com/advisories/GHSA-xhq7-xmqj-769h) | fast-uri relative-path equivalence: patch to 3.1.9. |
| [GHSA-wjr9-j795-jxcr](https://github.com/advisories/GHSA-wjr9-j795-jxcr) | fast-uri host canonicalization confusion: patch to 3.1.9. |
| [GHSA-333x-w4r6-6crp](https://github.com/advisories/GHSA-333x-w4r6-6crp) | fast-uri suffix-reference scheme injection: patch to 3.1.9. |
| [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp) | Vitest UI server file read/execution: 3.2.6 minimum is outside the current 2.x range, and insufficient for the newer mocker advisories. Bounded toolchain migration required. |
| [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) | Vitest/mocker redirect file read: 4.1.11 minimum, outside 2.x. Bounded migration required. |
| [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8) | Unauthenticated manual mock registration code injection: mocker 4.1.12 minimum, outside 2.x. Bounded migration required. |
| [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9) | Vite optimized-dependency map traversal: 6.4.2 minimum, outside Vitest's Vite 5.x edge. |
| [GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff) | Vite Windows fs.deny bypass: 6.4.3 minimum, outside 5.x. |
| [GHSA-v6wh-96g9-6wx3](https://github.com/advisories/GHSA-v6wh-96g9-6wx3) | Editor UNC-path credential disclosure on Windows: Vite 6.4.3 minimum, outside 5.x. |
| [GHSA-698v-4r3x-3vcv](https://github.com/advisories/GHSA-698v-4r3x-3vcv) | Editor Windows percent escaping: Vite 6.4.4 minimum, outside 5.x. |
| [GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm) | Editor Windows existence-check bypass: Vite 6.4.4 minimum, outside 5.x. |
| [GHSA-r825-w8mm-5pxw](https://github.com/advisories/GHSA-r825-w8mm-5pxw) | Editor CLI flag interpretation: Vite 6.4.4 minimum, outside 5.x. |
| [GHSA-rq7h-c2jc-7f22](https://github.com/advisories/GHSA-rq7h-c2jc-7f22) | Vite fs.allow path collision on non-Windows: 6.4.4 minimum, outside 5.x. |
| [GHSA-9jrq-w75r-8gcw](https://github.com/advisories/GHSA-9jrq-w75r-8gcw) | Vite custom middleware cross-origin script execution: 6.4.4 minimum, outside 5.x. |
| [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) | esbuild development-server cross-origin read: 0.25.0 minimum crosses both 0.24.x direct and 0.21.x nested ranges. Include both in toolchain migration. |
| [GHSA-5gmw-xhrv-c9v3](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3), [GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr) | Tinypool inherited worker/task options: 2.1.2 covers both. CLIProxy Insight is already pinned; model-selection's 1.1.1 needs a bounded cross-major migration/override qualification. |
| [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | Runtime Zod constrained-collection memory exhaustion: 4.6.6 minimum conflicts with the held SDK's ^3.24.2 edge. Requires SDK/validator compatibility analysis; no blind Zod4 override or host upgrade. |

The compatible group targets six alert records, leaving **30 records for bounded
follow-up**, not acceptance or dismissal. The accountable engineering owners and
UTC deadlines are recorded in the source task's follow-up cards. Do not expose
Vitest UI, mocker, Vite or esbuild development servers to untrusted clients; that
is a precaution, not proof these packages are safe or that the runtime Zod issue
is mitigated. No production exploitability claim was made by this maintenance.

Post-update `npm audit --package-lock-only --include=dev --json` still exits 1:
CLIProxy Insight reports 8 affected package entries (1 critical), model-selection
9 (2 critical). Neither report contains source-map-js or fast-uri. These npm
aggregate counts are not interchangeable with GitHub's alert-record counts.
Default-branch alert closure is not established until merge and graph refresh.

Rollback is a reviewed revert of this patch group; it restores known vulnerable
versions and requires an explicit security decision. No plugin installation,
provider/authentication change, host SDK update or deployment is authorized.

REA angle: use upstream advisories and the package manager's shipped dependency
and lock resolution behavior, not a replacement resolver or installer wrapper.
