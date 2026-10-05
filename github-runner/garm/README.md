# GARM source-only preparation contracts

**HOLD: synthetic/offline preparation, NOT a runnable host migration packet.**

## Scope and durable disposition

This bundle contains image-role contracts, a build-input/receipt contract, offline pure-Python checkers, explicitly fabricated fixtures, and drain/canary proposal notes. It contains no live builder, workflow, GARM/LXD API client, host-command adapter, installer, dispatch, migration or authorization function. No network/library dependencies beyond Python's standard library. It does not query GitHub or inspect hosts. Each CLI reads only its explicitly supplied nonsecret fixture file (bounded to 1 MiB). This does not release routing or host execution, and review of this source-only bundle is not execution permission. Landing remains a separate exact-head review + green-CI + non-author squash merge step. A source merge does not authorize or establish deployment, host admission or static retirement.

## Files and offline reproduction

- `validate_receipt.py`: strict nested field/type checks, duplicate-key/non-finite JSON rejection, safe diagnostics, two separate role policies. Accepts **synthetic receipts only**; explicitly rejects claims of operator/live evidence.
- `fixture-privileged.json`, `fixture-isolated.json`: **fabricated** IDs, versions, distinct per-role image/profile/input digests, timestamps, predicates and selector. `fixture-garm-host-b-exclusive` is not an installed tag or a proposal to add one. `two-ephemeral` is intentionally shared in the fabricated inventory and fails the one-host selector check.
- `role-contracts.json`: machine-readable export of the checker role requirements; NOT GARM/provider configuration. Null actual-build inputs remain HOLD.
- `toolchain-isolated.json`: pinned isolated-profile toolchain (psql, Node 24, runner; no floating tags). Output fingerprints stay null HOLD; no build/pool/migration authority.
- `validate_toolchain.py`: offline pin checker (exact versions, major guards, disabled-extension/build-authority rejection, duplicate-key/non-finite rejection, CLI pass/fail without echo).
- `isolated-image-profile.json`: isolated-role image/profile definition — non-root runtime, no sudo, no Docker surface, metadata/host/production-network deny, pinned toolchain (`psql` on PATH, Node 24, `cc`, runner; PHP/Composer/extensions absent by design), eligible `[self-hosted, two-isolated]` with `two-ephemeral` / `two-selfhosted` explicitly ineligible, bounded 2 vCPU / 4096 MiB / 20 GiB with safe admission <=1. All real build inputs null (HOLD); NOT GARM/provider configuration.
- `validate_isolated_profile.py`: offline isolated-profile checker plus **pair-distinctness** mode (`checker <a> <b>`), closing the documented single-receipt limitation — two synthetic receipts must differ in all three of fingerprint/profile/inputs. Accepts **synthetic receipts only**.
- `fixture-isolated-profile.json`: **fabricated** isolated-profile receipt with a third digest trio, pairwise distinct from both rehearsal fixtures.
- `test-class-image-profile.json`: test-role image/profile definition — non-root runtime, no sudo, no Docker surface, no privileged mode, metadata/host/production-network deny, pinned toolchain, eligible `[self-hosted, two-test]` with `two-ephemeral` / `two-selfhosted` / `two-isolated` explicitly ineligible, bounded 2 vCPU / 4096 MiB / 20 GiB with safe admission <=1, ephemeral one-job-per-VM lifecycle, image/workspace/log caps. Public/untrusted PR jobs stay on standard GitHub-hosted runners. All real build inputs null (HOLD); NOT GARM/provider configuration. Does not touch the isolated role, the generic role, or the build class.
- `validate_test_profile.py`: offline test-profile checker plus **pair-distinctness** mode, proving the test image differs in all three of fingerprint/profile/inputs from every other checked-in role image. Accepts **synthetic receipts only**.
- `fixture-test-profile.json`: **fabricated** test-profile receipt with a new digest trio, pairwise distinct from every other checked-in trio.
- `canary-pool-spec.json`: canary pool shape — one host only, distinct runner prefix, `[self-hosted, garm-managed]` marker, `two-ephemeral` / `two-isolated` / `two-selfhosted` explicitly forbidden on the pool, pinned flavor, min-idle 0, max 1, provider versions pinned. Phase A generic image proves pool mechanics only; phase B pinned isolated digest proves the full profile. Provider/install names null (HOLD); NOT GARM/provider configuration.
- `validate_canary_pool.py`: offline canary-pool-spec checker. Accepts **synthetic specs only**; every success returns `image_pinned:false`, `admission_authorized:false`, `host_verified:false`, `migration_complete:false`.
- `isolated-image-build-manifest.json`: isolated-image build manifest — ubuntu-24.04, PostgreSQL 16 server+client, Node series 24, `cc`, runner pinned by SHA-256, non-root `runner` user, no Docker surface, 2 vCPU / 4096 MiB / 20 GiB. All real build inputs null (HOLD); NOT a built image.
- `validate_build_manifest.py`: offline build-manifest checker with runner-pin cross-check (`--runner-env`, default `github-runner/actions-runner.env`). Accepts **synthetic manifests only**; every success returns `image_built:false`, `admission_authorized:false`, `host_verified:false`, `migration_complete:false`.
- `generic-image-profile.json`: generic-role image/profile definition — non-root runner user with sudo, local Docker daemon (no cross-host relay, no remote DOCKER_HOST), metadata/host/production-network deny, pinned toolchain (runner, Node 24, PHP + extensions, Composer, psql on PATH, Docker), eligible `[self-hosted, two-ephemeral]` with `two-isolated` / `two-selfhosted` explicitly ineligible, bounded 4 vCPU / 8192 MiB / 40 GiB with safe admission <=1, ephemeral one-job-per-VM lifecycle, image/workspace/log caps. All real build inputs null (HOLD); NOT GARM/provider configuration. Does not touch the isolated role.
- `validate_generic_profile.py`: offline generic-profile checker plus **pair-distinctness** mode, proving the generic image differs in all three of fingerprint/profile/inputs from the privileged image it replaces. Accepts **synthetic receipts only**.
- `fixture-generic-profile.json`: **fabricated** generic-profile receipt with a fourth digest trio, pairwise distinct from the privileged trio.
- `Dockerfile.isolated`, `GRACEFUL-DRAIN.md` (+ `drain-contracts.json` / `validate_drain.py`), `MINIMAL-BASE.md`: source-only image definition, drain proposal + contracts, and minimal-base policy. See each file for its own verification commands.
- `check_first_pickup.py` + `fixture-first-pickup-pass.json`: offline PASS/FAIL/UNKNOWN verdict over canary first-pickup reports. Exit 0 PASS, 2 FAIL (SLO miss), 3 UNKNOWN (no usable sample), 1 usage/validation. A FAIL means "no ephemeral VM picked up work within SLO" and licenses no cap, label, or routing change. Stdlib only, no network.
- `post_job_cleanup.py`: offline post-job residue sweep + isolation-probe checks over marked synthetic fixture directories only. Refuses unmarked directories (exit 2), never follows symlinks, never touches a host path.
- `storage_auto_reclaim.py`: offline storage-reclaim planner; emits a dry-run plan only. Every output carries `host_mutation_authorized:false` and `delete_authorized:false`; any write-intent flag is refused (exit 2).

Sibling offline regression suites follow the existing `test_isolated_*.py` discovery pattern outside this slice. Normal PR CI checks this source. Do not dispatch a migration rehearsal from a source-test result.

From the repository root, on an offline workstation with Python 3.11 or newer:

```sh
python3 -B github-runner/garm/validate_receipt.py github-runner/garm/fixture-privileged.json --at 2026-10-03T03:30:00Z
python3 -B github-runner/garm/validate_receipt.py github-runner/garm/fixture-isolated.json --at 2026-10-03T03:30:00Z
python3 -B github-runner/garm/validate_canary_pool.py github-runner/garm/canary-pool-spec.json
python3 -B github-runner/garm/validate_build_manifest.py github-runner/garm/isolated-image-build-manifest.json --runner-env <pinned-runner-env>
python3 -B github-runner/garm/validate_toolchain.py github-runner/garm/toolchain-isolated.json
python3 -B github-runner/garm/validate_isolated_profile.py github-runner/garm/fixture-isolated-profile.json
python3 -B github-runner/garm/validate_isolated_profile.py github-runner/garm/fixture-isolated-profile.json github-runner/garm/fixture-isolated.json
python3 -B github-runner/garm/validate_generic_profile.py github-runner/garm/fixture-generic-profile.json
python3 -B github-runner/garm/validate_test_profile.py github-runner/garm/fixture-test-profile.json
python3 -B github-runner/garm/validate_drain.py github-runner/garm/drain-contracts.json
python3 -B github-runner/garm/check_first_pickup.py github-runner/garm/fixture-first-pickup-pass.json
```

These checkers use fabricated data only; no production CI dispatch or privileged-host rehearsal is authorized. Success is named `offline_contract_valid`; even success returns `admission_authorized:false`, `host_verified:false` and `migration_complete:false`. Invalid input exits nonzero and never prints raw values. Do not feed credentials/private configs to a checker. A checker is not a general-purpose secret scanner.

The `--at` value is an explicit evaluation clock for deterministic checks, not independently attested current time. All timestamps are UTC `Z`. Budget samples have a **draft fixture horizon of 15 minutes**; that is a test policy, not a newly approved operating SLA. Historical <=1 admission and configured max2 are preserved in the fixtures; a checker never writes either value.

## Two image-role contracts (do not collapse into one privileged image)

### `privileged` — service-container builds

Only a verified trusted repository/ref admitted by the actual runner-group policy. Public/untrusted PR jobs stay on standard GitHub-hosted runners. Sudo/Docker may be present for this role only, under a separately reviewed job boundary; those predicates do NOT grant credentials or reachability.

Pinned-input receipt must cover exact runner version, Node 24 runtime/action smoke, PHP patch + required extensions, Composer exact version, PostgreSQL client exact version and Docker exact version. Missing runtime/extension evidence is HOLD even if this fixture checker passes: the checker requires version strings and predicates, not executable extension enforcement.

Positive smoke: native build and disposable CI-service PostgreSQL readiness/SQL; service-container ports reachable on the job's intended loopback path and not exposed across a cohort/host boundary. Metadata and host-service denials need positive controls.

### `isolated` — native no-sudo/no-Docker suites

A future live isolated image must have a distinct image fingerprint/profile and dedicated job identity, no sudo capability, no Docker daemon/socket/TCP relay access, no sibling runner data/registration material, no escalatable SUID/capabilities. Native compiler/PostgreSQL smoke and Node 24/runner runtime checks must succeed. No production/shared PostgreSQL endpoint. Do not admit this role using a historically privileged canary image.

The two checked-in fixtures use distinct fabricated image/profile/input digests, enforced by a fixture-pair regression check. **The single-receipt checker cannot compare roles or reject a claimed isolated image that reuses a privileged image digest.** Its role booleans and fingerprints are self-claims; a regression check deliberately demonstrates this limitation and still denies admission/host proof. Independent cross-role image inspection and trusted build provenance remain mandatory live HOLD gates.

For every denial claim require an independently reachable/present controlled target and a successful authorized positive control; nonexistent fixtures, daemon absence, timeout, missing tools, failed privilege drop or unknown endpoint inventories are NOT proof of denied access. This checker represents those requirements as synthetic predicates; it cannot certify enforcement.

Both roles require dedicated disposable CI/test data, metadata-IP and host-service containment, fresh VM per job, natural job/artifact completion, external runner-log retention and correlated VM + runner-registration cleanup.

## Build-input and evidence contract

Before an operator packet is executable, obtain a **nonsecret** pinned manifest and retained logs through an installed authorized read/build path:

1. **Source/package:** exact 40-character source revision; SHA-256 of the reviewed bundle. No branch-tip deployment. Reviewer identity and exact target digest recorded separately.
2. **Base/install inputs:** base-image full fingerprint/digest; distribution release + package snapshot/index identity; package names and exact versions; download artifact SHA-256/checksum verification; image-builder source revision; provisioning payload digest (not payload/secrets); deterministic input-manifest hash. No `latest`, unresolved apt indexes, floating aliases, credentials or private auth material in public receipts.
3. **Output/profile:** full 64-character image fingerprint, profile content hash, selected role, two clean-build/rebuild receipts (inputs and explicit image differences explained), actual tool/runtime/extension smoke log references. Reproducible inputs are required; equality of VM filesystem fingerprints is not inferred from a single build.
4. **Provider:** installed GARM/provider/LXD version receipts and configured provider identity. No provider upgrade/restart from this bundle.
5. **Selectors:** complete enabled-pool tag inventory + group admission; matching set for the one-host selector contains exactly the target pool/provider. Generic `two-ephemeral` is not exclusive. If a selector does not exist, design/review a separate idle-safe change with backups and rollback; do not invent/publish it.
6. **Admission:** UTC CPU/RAM/disk/IO/PSI/load and non-CI reservations; active jobs/VMs + pending replacements/reservations accounted; requested resources fit measured surplus; historical <=1 vs configured max2 resolved explicitly by accountable host/operator policy. Relevant filesystem >=95%, pressure incident, missing/unknown reservations means STOP. No count-to-VM mapping, cap increase, purchase, repurpose or cleanup from queued count.
7. **Trust/workflow:** actual repository/group/ref/contributor policy and required check identities; public PR exclusion; natural-completion concurrency handling; gate/test unchanged; disposable DB/service target. Any required source correction has its own reviewed/green exact head before execution.
8. **Lifecycle:** run -> runner -> pool/provider/host -> image/VM mapping; successful normal job/artifact completion timestamp; later absence of that exact VM and registration; external runner-log retention references. Runner registration absence alone is NOT VM reclamation.
9. **Window/approval:** existing coordination route, lock owner, reviewed exact host commands and installed versions, before/after/rollback references, independent reviewer and explicit execution authority. Unknown command syntax/transport identities are blockers, never filled from examples.

The fixture schema implements representative fail-closed consistency checks, not the complete signed provenance/reproducibility, runtime extension inventory, listener enumeration, log retention or host approval requirements above. Its input facts can all be fabricated (and deliberately are). It is **not** a generic live receipt/admission verifier. Do not turn its exit code into CI routing, deployment or migration approval. A future live evidence adapter would need separately reviewed semantics, authentic evidence provenance and operator authorization; no such adapter exists here.

## Operator HOLD gates — no live command authorization

**Current HOLD gates:** installed transport, actual exclusive selector, exact role image/build inputs/tools, fresh reserved hardware, verified trust/check policy and ordinary-job-to-VM destruction proof. No agent-direct executor exists in this bundle.

Live rollout procedure (windows, rehearsal jobs, drain/migration sequencing, service retirement) is installation-specific and stays outside this source-only slice. Source-only rollback: before merge revise the same landing branch/PR; after merge revert the exact source-only squash commit through normal review/CI. Nothing is installed, so there is no host runtime state to revert. This document deliberately supplies no mutating CLI commands.

## First-pickup canary verdict

- `check_first_pickup.py`: offline PASS/FAIL/UNKNOWN verdict over canary report files. Exit 0 PASS, 2 FAIL (SLO miss), 3 UNKNOWN (no usable sample), 1 usage/validation. A FAIL means "no ephemeral VM picked up work within SLO" and licenses no cap, label, or routing change. Stdlib only, no network.
- `fixture-first-pickup-pass.json`: **fabricated** PASS report (synthetic runner, clocks, wait); not live evidence.

```sh
python3 -B github-runner/garm/check_first_pickup.py github-runner/garm/fixture-first-pickup-pass.json
```

## Evidence sources and limits

- GitHub ephemeral runner documentation: https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/autoscaling-with-self-hosted-runners — ephemeral registration processes one job and deregisters; wiping the environment is separate automation. External log retention and runner updates remain required.
- Python regex syntax: https://docs.python.org/3/library/re.html#regular-expression-syntax — `\d` accepts Unicode decimal digits in string patterns; receipt clocks instead require `[0-9]` in every position.
- Python JSON decoder: https://docs.python.org/3/library/json.html#json.loads — integer conversion is length-limited since Python 3.11; parser `ValueError` is translated into a non-echoing structured rejection while specific duplicate-key/non-finite rejections are preserved.

No additional permission/credential, image generation, runtime isolation, admission, provider compatibility or fleet cleanup was tested. Repository visibility/ref/group claims still require independent live verification. After all entry gates close and authorized routing lands: at least 24h plus adequate ordinary matched attempts; static drain follows separately. Source-only review can happen now.
