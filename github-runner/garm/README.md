# GARM Wave-1 source-only preparation contracts

Prepared 2026-10-03.
**HOLD: synthetic/offline preparation, NOT a runnable host migration packet.**

## Scope and durable disposition

Installed GitHub tooling is reused; no separate GitHub setup step is needed. This bundle does not release routing or host execution. It records a transport HOLD, not agent-direct host authorization. The execution packet it prepares for is approved for source preparation ONLY. This landing needs its own exact-head review and green CI on the same review path; no duplicate survey, pilot, operator or review epic.

An earlier merged canary is reused as historical job evidence, not a reproducible-image, fleet-isolation or live-cleanup certification.

This bundle contains image-role contracts, a build-input/receipt contract, an offline pure-Python checker, two explicitly fabricated receipts, regression tests and an operator preparation runbook. It contains no live builder, workflow, GARM/LXD API client, host-command adapter, installer, dispatch, migration or authorization function. No network/library dependencies beyond Python's standard library. It does not query GitHub or inspect hosts. The CLI reads only its explicitly supplied nonsecret fixture file (bounded to 1 MiB); the tests spawn only the local checker.

These files are repository source preparation, not an installed builder or admission tool. The tests join the existing `test_isolated_*.py` offline discovery pattern; no workflow, job routing, runner label, permission, concurrency, pool or provider setting changes. Normal PR CI checks this source. Do not dispatch a migration rehearsal from a source-test result. Landing remains a separate exact-head review + green-CI + non-author squash merge step. A source merge does not authorize or establish deployment, host admission or static retirement.

All host, pool, selector and custom runner-label names in the examples are synthetic subjects, not installed identities or routing proposals. The rehearsal pins `fixture-host-a`; the separate canary spec pins `fixture-host-b`. `example-ephemeral`, `example-isolated`, `example-test` and `example-selfhosted` remain distinct trust classes; the shared ephemeral label is not a host-exclusive selector. The checker refuses `TogetherWeOwn/example-public-web` and `TogetherWeOwn/example-public-bot` case-insensitively even when their visibility is claimed private. These are denied example repositories, not a live repository inventory; all other trust claims still need independent evidence.

## Files and offline reproduction

- `validate_receipt.py`: strict nested field/type checks, duplicate-key/non-finite JSON rejection, safe diagnostics, two separate role policies. Accepts **synthetic receipts only**; explicitly rejects claims of operator/live evidence.
- `../test_isolated_garm_receipt.py`: two positive role controls, fixture-pair/generator consistency, explicitly unproved cross-role comparisons, missing/extra keys, ASCII clocks, safe parser/CLI errors and isolated trust/budget/selector/image/cleanup/privilege regression cases. Canary-spec tests also pin the synthetic host, forbidden trust labels, null build inputs, bounds and non-authorization outputs.
- `fixture-privileged-private.json`, `fixture-isolated-private.json`: **fabricated** IDs, versions, distinct per-role image/profile/input digests, timestamps, predicates and selector. `fixture-host-a-exclusive` is not an installed tag or a proposal to add one. `example-ephemeral` is intentionally shared in the fabricated inventory and fails the one-host selector check.
- `role-contracts.json`: machine-readable export of the checker role requirements; NOT GARM/provider configuration. Null actual-build inputs remain HOLD.
- `toolchain-isolated-private.json`: pinned isolated-profile toolchain (psql 16.15 on PATH, PHP 8.5.11, Composer 2.9.3, pdo_pgsql/zip/gd bundled at 8.5.11, pcov 1.0.12, Node 24.12.0, runner 2.330.0). No floating tags. Output fingerprints stay null HOLD; no build/pool/migration authority.
- `validate_toolchain.py` + `../test_isolated_toolchain_pin.py`: offline pin checker and regression tests (exact versions, major guards, disabled-extension/build-authority rejection, duplicate-key/non-finite rejection, CLI pass/fail without echo).
- `isolated-image-profile.json`: separate
  reviewed isolated-role image/profile definition — non-root runtime, no sudo,
  no Docker surface, metadata/host/production-network deny, pinned toolchain
  (`psql` on PATH, Node24, `cc`, runner; PHP/Composer/extensions absent by
  design), eligible `[self-hosted, example-isolated]` with `example-ephemeral` /
  `example-selfhosted` explicitly ineligible, bounded 2 vCPU / 4096 MiB / 20 GiB
  with safe admission <=1. All real build inputs null (HOLD); NOT GARM/provider
  configuration.
- `validate_isolated_profile.py`: offline isolated-profile checker plus
  **pair-distinctness** mode (`checker <a> <b>`), closing the documented
  single-receipt limitation — two synthetic receipts must differ in all three
  of fingerprint/profile/inputs. Accepts **synthetic receipts only**.
- `fixture-isolated-profile.json`: **fabricated** isolated-profile receipt with
  a third digest trio (`9999…/8888…/7777…`), pairwise distinct from both
  rehearsal fixtures.
- `../test_isolated_profile.py`: positive control (never authorizes), checked-in
  fixture/generator consistency, definition/checker consistency, three-role
  digest distinctness, pair-gap closure, privilege/network/label/resource/
  toolchain regression cases, fail-closed parser, CLI exit-status/pair tests.
- `test-class-image-profile.json`: separate
  reviewed test-role image/profile definition — non-root runtime, no sudo, no
  Docker surface, no LXD privileged mode, metadata/host/production-network
  deny, pinned toolchain (runner, Node24, PHP 8.5 + `pdo_pgsql zip gd pcov`,
  Composer 2.x, `psql` on PATH, `cc`; Docker absent by design), eligible
  `[self-hosted, example-test]` with `example-ephemeral` / `example-selfhosted` /
  `example-isolated` explicitly ineligible, bounded 2 vCPU / 4096 MiB / 20 GiB
  with safe admission <=1, ephemeral one-job-per-VM lifecycle, image 20 GiB /
  workspace 20 GiB / 30-day log caps. Public repos are refused by the org
  runner group, so test labels route private-repo jobs only; public/untrusted
  PR jobs stay on standard GitHub-hosted runners. All real build inputs null
  (HOLD); NOT GARM/provider configuration. Does not touch the isolated
  role, the generic role, or the build class.
- `validate_test_profile.py`: offline test-profile checker plus
  **pair-distinctness** mode (`checker <a> <b>`), proving the test image
  differs in all three of fingerprint/profile/inputs from every other checked-in
  role image. Accepts **synthetic receipts only**.
- `fixture-test-profile.json`: **fabricated** test-profile receipt with
  a new digest trio (`bbbb…/cccc…/0000…`), pairwise distinct from every other
  checked-in trio.
- `../test_isolated_test_profile.py`: positive control (never authorizes),
  checked-in fixture/generator consistency, definition/checker consistency
  (including the non-privileged constraints block), test-vs-all-roles
  distinctness, pair-gap closure, non-privilege/network/label/resource/size/
  ephemeral/toolchain regression cases, fail-closed parser, CLI
  exit-status/pair tests.
- `canary-pool-spec.json`: reviewed
  synthetic canary pool shape — `fixture-host-b` only, distinct `garm-iso`
  prefix, marker `[self-hosted, garm-managed]`, `example-ephemeral` /
  `example-isolated` / `example-selfhosted` explicitly forbidden on the pool,
  `garm-isolated-2x4x20` flavor, min-idle 0, max 1, provider 0.1.3 pinned.
  Phase A generic image proves pool mechanics only; phase B pinned isolated
  digest proves the full profile. Provider/install names null (HOLD); NOT
  GARM/provider configuration.
- `validate_canary_pool.py`: offline canary-pool-spec checker. Accepts
  **synthetic specs only**; every success returns `image_pinned:false`,
  `admission_authorized:false`, `host_verified:false`,
  `migration_complete:false`.
- `isolated-image-build-manifest.json`:
  reviewed isolated-image build manifest — ubuntu-24.04, PostgreSQL 16
  server+client, Node series 24, `cc`, runner 2.337.0 pinned by SHA-256
  against the runner pin file (see `--runner-env` below), non-root `runner` user, no Docker
  surface, 2 vCPU / 4096 MiB / 20 GiB. All real build inputs null
  (HOLD); NOT a built image.
- `validate_build_manifest.py`: offline build-manifest checker with runner
  pin cross-check (`--runner-env`, default `../actions-runner.env`).
  Accepts **synthetic manifests only**; every success returns
  `image_built:false`, `admission_authorized:false`,
  `host_verified:false`, `migration_complete:false`.
- `generic-image-profile.json`: separate
  reviewed generic-role image/profile definition — non-root runner user with
  sudo, local Docker daemon (no cross-host relay, no remote DOCKER_HOST),
  metadata/host/production-network deny, pinned toolchain (runner, Node24,
  PHP 8.5 + `pdo_pgsql zip gd pcov`, Composer 2.x, psql on PATH, Docker),
  eligible `[self-hosted, example-ephemeral]` with `example-isolated` /
  `example-selfhosted` explicitly ineligible, bounded 4 vCPU / 8192 MiB / 40 GiB
  with safe admission <=1, ephemeral one-job-per-VM lifecycle, image 30 GiB /
  workspace 20 GiB / 30-day log caps. All real build inputs null (HOLD); NOT
  GARM/provider configuration. Does not touch the isolated role.
- `validate_generic_profile.py`: offline generic-profile checker plus
  **pair-distinctness** mode (`checker <a> <b>`), proving the generic image
  differs in all three of fingerprint/profile/inputs from the privileged
  canary image it replaces. Accepts **synthetic receipts only**.
- `fixture-generic-profile.json`: **fabricated** generic-profile receipt with
  a fourth digest trio (`4444…/5555…/6666…`), pairwise distinct from the
  privileged canary trio.
- `../test_isolated_generic_profile.py`: positive control (never authorizes),
  checked-in fixture/generator consistency, definition/checker consistency,
  generic-vs-canary distinctness, pair-gap closure, capability/network/label/
  resource/size/ephemeral/toolchain regression cases, fail-closed parser, CLI
  exit-status/pair tests.

From the repository root, on an offline workstation with Python 3.11 or newer:

```sh
python3 -B -m unittest discover -s github-runner -p 'test_isolated_garm_receipt.py' -v
python3 -B github-runner/garm/validate_receipt.py github-runner/garm/fixture-privileged-private.json --at 2026-10-03T03:30:00Z
python3 -B github-runner/garm/validate_receipt.py github-runner/garm/fixture-isolated-private.json --at 2026-10-03T03:30:00Z
python3 -B github-runner/garm/validate_canary_pool.py github-runner/garm/canary-pool-spec.json
python3 -B github-runner/garm/validate_build_manifest.py github-runner/garm/isolated-image-build-manifest.json
# Offline CI uses this broader discovery command, unchanged:
python3 -B -m unittest discover -s github-runner -p 'test_isolated_*.py'
```

If the default `actions-runner.env` pin file is absent from a source-only checkout, the build-manifest CLI refuses. Supply an independently reviewed local pin file with `--runner-env`; never synthesize that file from the manifest being checked, which would make the drift check vacuous.

These tests use fabricated data only; no production CI dispatch or privileged-host rehearsal is authorized. Success is named `offline_contract_valid`; even success returns `admission_authorized:false`, `host_verified:false` and `migration_complete:false`. Invalid input exits 1 and never prints raw values. Test subprocesses have a 10-second deadline. Do not feed credentials/private configs to the checker. It is not a general-purpose secret scanner.

The `--at` value is an explicit evaluation clock for deterministic tests, not independently attested current time. All timestamps are UTC `Z`. Budget samples have a **draft fixture horizon of 15 minutes**; that is a test policy, not a newly approved operating SLA. The `fixture-host-a` receipt preserves safe admission <=1 and configured max2; the checker never writes either value.

## Two image-role contracts (do not collapse into one privileged image)

### `privileged-private` — candidate private service-container builds

Only a verified trusted private repository/ref admitted by the actual runner-group policy. Public and untrusted PR jobs stay on standard GitHub-hosted runners. Sudo/Docker may be present for this role only, under the separately reviewed private-job boundary; those predicates do NOT grant credentials or reachability.

Pinned-input receipt must cover exact runner version, Node24 runtime/action smoke, PHP 8.5 patch + required extensions, Composer exact version, PostgreSQL client exact version and Docker exact version. The broad intentionally red test and blocking port gate remain unchanged. Missing runtime/extension evidence is HOLD even if this fixture checker passes: the checker requires version strings and predicates, not executable extension enforcement.

Positive smoke: native build and disposable CI-service PostgreSQL readiness/SQL; service-container ports reachable on the job's intended loopback path and not exposed across a cohort/host boundary. Metadata and host-service denials need positive controls. Private visibility and a ref named main are NOT trust proof.

### `isolated-private` — native no-sudo/no-Docker suites

A future live isolated image must have a distinct image fingerprint/profile and dedicated job identity, no sudo capability, no Docker daemon/socket/TCP relay access, no sibling runner data/registration material, no escalatable SUID/capabilities. Native compiler/PostgreSQL smoke and Node24/runner runtime checks must succeed. No production/shared PostgreSQL endpoint. Do not admit this role using the privileged fixture canary image.

The two checked-in fixtures now use distinct fabricated image/profile/input digests, enforced by a fixture-pair regression test. **The single-receipt checker cannot compare roles or reject a claimed isolated image that reuses a privileged image digest.** Its role booleans and fingerprints are self-claims; a regression test deliberately demonstrates this limitation and still denies admission/host proof. Independent cross-role image inspection and trusted build provenance remain mandatory live HOLD gates.

For every denial claim require an independently reachable/present controlled target and a successful authorized positive control; nonexistent fixtures, daemon absence, timeout, missing tools, failed privilege drop or unknown endpoint inventories are NOT proof of denied access. Inventories must include relevant Unix/TCP/IPv6 listeners and nonstandard relays. Observe actual credentials/effective isolation, not just unit text. This checker represents those requirements as synthetic predicates; it cannot certify enforcement.

Both roles require dedicated disposable CI/test data, metadata-IP and host-service containment, fresh VM per job, natural job/artifact completion, external runner-log retention and correlated VM + runner-registration cleanup.

## Build-input and evidence contract

Before an operator packet is executable, obtain a **nonsecret** pinned manifest and privately retained logs through an installed authorized read/build path:

1. **Source/package:** exact 40-character source revision; SHA-256 of the reviewed bundle. No branch-tip deployment. Reviewer identity and exact target digest recorded separately.
2. **Base/install inputs:** base-image full fingerprint/digest; distribution release + package snapshot/index identity; package names and exact versions; download artifact SHA-256/checksum verification; image-builder source revision; provisioning/cloud-init payload digest (not payload/secrets); deterministic input-manifest hash. No `latest`, unresolved apt indexes, floating aliases, credentials or private auth material in public receipts.
3. **Output/profile:** full 64-character image fingerprint, profile content hash, selected role, two clean-build/rebuild receipts (inputs and explicit image differences explained), actual tool/runtime/extension smoke log references. Reproducible inputs are required; equality of VM filesystem fingerprints is not inferred from a single build.
4. **Provider:** installed GARM/provider/LXD version receipts and configured provider identity; current source records GARM 0.2.1, provider **0.1.3 remains pinned**, LXD 5.21 compatibility unproved for newer provider. No provider upgrade/restart from this bundle.
5. **Selectors:** complete enabled-pool tag inventory + group admission; matching set for the one-host selector contains exactly the approved target pool/provider (`fixture-host-a` in the fabricated receipt only). Generic `example-ephemeral` is not exclusive. If a selector does not exist, design/review a separate idle-safe change with backups and rollback; do not invent/publish it.
6. **Admission:** UTC CPU/RAM/disk/IO/PSI/load and non-CI reservations; active jobs/VMs + pending replacements/reservations accounted; requested resources fit measured surplus; historical <=1 vs configured max2 resolved explicitly by accountable host/operator policy. Relevant filesystem >=95%, pressure incident, missing/unknown reservations means STOP. No count-to-VM mapping, cap increase, purchase, CLIProxy repurpose or cleanup from queued count.
7. **Trust/workflow:** actual repository/group/ref/contributor policy and required check identities; public PR exclusion; natural-completion concurrency handling; gate/test unchanged; disposable DB/service target. Any required source correction has its own reviewed/green exact head before execution.
8. **Lifecycle:** run -> runner -> pool/provider/host -> image/VM mapping; successful normal job/artifact completion timestamp; later absence of that exact VM and registration; external runner-log retention references. Runner registration absence alone is NOT VM reclamation.
9. **Window/approval:** existing coordination route, lock owner, reviewed exact host commands and installed versions, before/after/rollback references, independent reviewer and explicit execution authority. UNKNOWN command syntax/transport identities are blockers, never filled from examples.

The fixture schema implements representative fail-closed consistency checks, not the complete signed provenance/reproducibility, runtime extension inventory, listener enumeration, log retention or host approval requirements above. Its input facts can all be fabricated (and deliberately are). It is **not** a generic live receipt/admission verifier. Do not turn its exit code into CI routing, deployment or migration approval. A future live evidence adapter would need separately reviewed semantics, authentic evidence provenance and operator authorization; no such adapter exists here.

## Operator preparation runbook — no live command authorization

**Current HOLD gates:** installed transport, a verified host-exclusive selector (never a fabricated example name), exact role image/build inputs/tools, fresh reserved hardware, verified trust/check policy and ordinary-job-to-VM destruction proof. Nothing here establishes an agent-direct executor. Reuse existing read-path work and existing operator-coordinated windows. Do not reopen the same survey absent changed capability.

1. **Prepare:** collect the pinned manifests/evidence above using approved transport; verify tool/version-specific CLI syntax in official docs + installed help; record it in the existing packet. No root/provider restart, image build, GARM mutation or new credentials yet. Missing capability is escalated to the accountable owner, not worked around.
2. **Review:** independent review of the exact packet/images/commands and trust boundary. Review of this source-only bundle is not execution permission. Request a single coordinated window only when missing facts are supplied. Do not overlap undocumented operator actions.
3. **Rehearse, only after explicit execution release:** one disposable synthetic/CI-service job on the approved exact image/host/selector. Verify service readiness, role-specific positive and denial controls, Node24/runtime/tools, actual run/runner/VM mapping and logs. Do not mutate a running VM's profile/image, probe production DB/Worker targets, share test service ports, cancel work or reroute public PRs. Record fresh reservations before new admission.
4. **Observe normal finish:** allow all running jobs and artifact uploads to finish naturally. On timeout/failure halt NEW admissions using only the reviewed idle-safe mechanism; preserve evidence. A timeout is a HOLD, never permission to stop/kill jobs/agents, wipe workspaces or delete live VMs. Record and hand back to the existing operator/oncall owner.
5. **Cleanup evidence:** observe provider-managed cleanup after the normal finish. Correlate VM and registration absence on both sides with timestamps. Failed/inconclusive cleanup stays HOLD; manual deletion needs separate reviewed scoped operator action. Do not treat registration absence as destroyed VM evidence.
6. **Trial, later:** only after rehearsal + review/authorization + exact-source CI/merge, retain numerical go/no-go: >=24h and >=10 matched completed attempts per arm, inclusive outage/failure accounting and sample adequacy, else INCONCLUSIVE. Review agreed measurement targets before execution. Rehearsal fixtures are not trial samples.
7. **Static drain, later separate packet/window:** prove replacement pickup/completion/capacity; preserve private registration/labels/service/config backups + tested rollback. Stop new assignments using an actually verified reviewed mechanism; let old active work/artifacts finish. Unregister/remove only confirmed idle static services one host/cohort at a time. Retirement of the legacy static-host orchestrator stays held until capacity exists elsewhere; do not add load there. Converting a remaining static worker host needs its bounded cleanup/budget proof. An excluded inaccessible host remains excluded.
8. **Routing rollback, later:** restore only the reviewed one-job routing/config/label backup, in its approved scope, for future eligible private jobs. Keep active VM/image profiles and running jobs untouched. Pool caps, quota/manual model pins and admission policy unchanged. Do not blindly stop a provider to effect rollback. No automatic rollback that restores privileged access for isolated jobs.

Source-only rollback: before merge revise the same landing branch/PR; after merge revert the exact source-only squash commit through normal review/CI. Nothing is installed, so there is no host runtime state to revert. Future live rollback needs its own target-specific privately retained backups and verified command syntax; this document deliberately supplies no guessed mutating CLI commands.

Scaler design and Beszel/Gatus/lifecycle/on-call ownership stay with their existing owners; zero VMs is healthy only when no eligible work awaits admission. Full migration requires 0 owned static registrations/services, all owned jobs using fresh cleanly reclaimed GARM VMs with role isolation, public hosted CI intact, no aborted active work, measured queue/throughput/pressure and tested recovery. None of that is asserted complete by this artifact.

## First-pickup canary verdict

- `check_first_pickup.py`: offline PASS/FAIL/UNKNOWN verdict over
  canary report files (`first-pickup-report` artifacts from a canary
  workflow, or hand-recorded shapes). Exit 0 PASS,
  2 FAIL (SLO miss), 3 UNKNOWN (no usable sample), 1 usage/validation.
  A FAIL means "no ephemeral VM picked up work within SLO" and licenses
  no cap, label, or routing change. Stdlib only, no network.
- `fixture-first-pickup-pass.json`: **fabricated** PASS report (synthetic
  runner, clocks, wait); not live evidence.
- `../test_isolated_first_pickup.py`: boundary, UNKNOWN-on-missing-wait,
  runner/label/clock/SLO cross-checks, fail-closed parser, CLI exit codes.
  Joins the existing `test_isolated_*.py` discovery.

```sh
python3 -B github-runner/garm/check_first_pickup.py github-runner/garm/fixture-first-pickup-pass.json
python3 -B -m unittest discover -s github-runner -p 'test_isolated_first_pickup.py'
```

## Evidence sources and limits

Repository source and notes inspected (not included in this directory):

- A static isolated-runner service template (no-new-privileges, capability and socket masks, namespace constraints). STATIC service template; not a GARM image builder or installed isolation proof.
- Migration notes covering positive controls, native test-data smoke and no inference from missing targets; source fixtures stay separate from host acceptance.
- Version evidence: provider 0.1.3 stays held pending LXD 5.21 compatibility proof. Historical source assertion, not live installation verification.
- GitHub official ephemeral runner documentation (retrieved 2026-10-03): https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/autoscaling-with-self-hosted-runners — ephemeral registration processes one job and deregisters; wiping the environment is separate automation. External log retention and runner updates remain required. The first attempted newer URL returned HTTP404; this official legacy URL succeeded.

- Python official regex syntax: https://docs.python.org/3/library/re.html#regular-expression-syntax — `\d` accepts Unicode decimal digits in string patterns; receipt clocks instead require `[0-9]` in every position.
- Python official JSON decoder: https://docs.python.org/3/library/json.html#json.loads — integer conversion is length-limited since Python 3.11; parser `ValueError` is translated into a non-echoing structured rejection while specific duplicate-key/non-finite rejections are preserved.

No additional permission/credential, image generation, runtime isolation, admission, provider compatibility or fleet cleanup was tested. Denied public example repository names are rejected even if a receipt calls them private, but other repository visibility/ref/group claims still require independent live verification. No defensible first-routing date yet. After all entry gates close and authorized routing lands: at least 24h plus adequate ordinary matched attempts; static drain follows separately. Source-only review can happen now.
