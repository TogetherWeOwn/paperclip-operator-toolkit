# Compiler-bearing execution-image source carrier

**Unbuilt recipe, not a compiler/runtime receipt or change authorization.** This
packet adds native C compiler, linker/archive tools, libc headers and pkg-config
at a later, separately authorized image creation. Nothing installs at startup.
There is no image build, publication, install, restart or deployment workflow.

## Exact inputs and what they prove

`manifest.json` binds the immutable standard-production **base candidate**, its
canonical full source revision, producer log/attestation references, application
wrapper/toolchain source pins, and SHA-256 of every other carrier file. The
manifest cannot hash itself: use its exact Git blob/bytes plus the delivered
commit as the external packet identity. `carrier_base_revision` is the toolkit
baseline, **not** the future carrier commit. The validator's canonical manifest
hash is a semantic-content hash, not the exact-file hash or a signature.

The observed base candidate is
`ghcr.io/paperclipai/paperclip@sha256:95cc19e5fdd7804b9fd8699fbe33a7202ae6a26e2b42dc5e6fdf4785f213deed`.
[Canonical producer run](https://github.com/paperclipai/paperclip/actions/runs/37717359076)
and [attestation reference](https://github.com/paperclipai/paperclip/attestations/53785733)
record that digest and source revision
`e4b39da6f6304c18d40dff13a5c7d224b3bf50fd`. This was read from producer logs;
**independent signature verification remains UNESTABLISHED**. The local `gh`
wrapper reports `unknown command "attestation" for "gh"`; no verifier was installed
or credential substituted. A log is not an independent signature-verification
receipt. That missing capability is an image-creation prerequisite, not permission
to select another base. Mutable SHA lookup tags are never consumed by the recipe.

The supported route is the [standard-production contract](https://github.com/paperclipai/paperclip/blob/e4b39da6f6304c18d40dff13a5c7d224b3bf50fd/doc/standard-image-contract.md#standard-production-image-provenance):
verify source repository `paperclipai/paperclip`, ref `refs/heads/master`, full
source SHA, signer workflow and subject digest, then consume that digest. A
compiler-bearing derivative is a **new artifact**, not the upstream standard image
or a claim that its signature covers our additions. Record and independently
review/verify the derivative's own complete build provenance and immutable digest.

`native-packages.json` selects Linux amd64 / Debian trixie and exact package
versions observed in the [dated Debian index](https://snapshot.debian.org/archive/debian/20261007T000000Z/dists/trixie/main/binary-amd64/Packages.xz).
The snapshot constrains transitive package selection; exact installed dependency
closure, archive hashes and compatibility remain future build receipts. The
recipe uses only that signed snapshot for its update/install, with Debian's
archive keyring. It does not modify inherited default APT source files, bypass
signature/freshness checks, permit downgrades or use arbitrary package URLs. If
APT refuses expiry, unavailable versions or compatibility, stop and review a new
source pin; do not add a bypass flag. A dated snapshot can require a reviewed
security refresh; reproducibility is not ongoing vulnerability acceptance.

GCC supplies `/usr/bin/cc` and `/usr/bin/gcc`; binutils supplies `/usr/bin/ld` and
`/usr/bin/ar`; libc6-dev supplies headers; pkg-config/pkgconf supports native
dependency discovery. Native ring/rustls compilation motivates this minimum;
there is no OpenSSL/C++ addition or unrelated product-builder substitution.
Rust 1.98.1 is the inspected application's package-owned selection, **not a claim
of an installed runtime toolchain**. This carrier neither installs Rust nor
changes PATH, CC, linker selectors, model/env pins or the bounded Cargo wrapper.
Verify the existing toolchain independently at future runtime acceptance.

## Source-only validation (safe now)

From the toolkit root:

```sh
python3 -B execution-image/test_manifest.py
python3 -B execution-image/validate.py execution-image/manifest.json
git diff --check
```

The Linux validator is byte-bounded, duplicate-key/non-finite/unknown-field
rejecting, and read-only. Non-regular files and symlinks are refused; nonblocking
open and descriptor checks also refuse FIFO swaps without waiting for a writer. It binds source bytes and compares the recipe to a narrow permitted
form: one fixed base, root only during image creation, signed pinned APT native
additions, and final `USER 1000:1000`. No runtime command/entrypoint/env override is
allowed. A successful result is `source_packet_consistent`, **never build-ready,
installed, trusted or accepted**. It cannot verify external signatures, contents
of unavailable upstream objects, a live mount, capacity, processes or policy.
Fixture mutations and CLI refusal tests prove those source checks can go red.
No Docker, compiler, package manager, Cargo or network tool is invoked by them.

After an intentional reviewed carrier-file change, update the corresponding
manifest SHA-256. Rebinding hashes does not waive semantic checks. A pushed commit,
independent exact-head review and external manifest/file hashes identify the
accepted packet; local mutable files or a consistency result alone do not.

## Controlled future handoff — commands are UNEXECUTED

The original runtime executor retains ownership. Deliver this source packet for
artifact-specific independent security acceptance **before any image-creation or
host-execution handoff**. Source review does not clear the runtime HOLD. No new
pool, package-install task or duplicate generic HOLD review is implied.

### 1. Review and immutable provenance, before image creation

The following are an instruction envelope, not an automated workflow. An
independently authorized executor must fill the approved carrier revision,
immutable output destination and receipt directory in their own authorized
workspace. Do not use an agent worktree as a production source/mount.

```sh
# Read-only source/provenance checks in the separately authorized environment.
git rev-parse HEAD
git status --porcelain
sha256sum execution-image/manifest.json execution-image/Dockerfile \
  execution-image/native.sources execution-image/native-packages.json \
  execution-image/runtime-contract.json execution-image/validate.py \
  execution-image/test_manifest.py execution-image/README.md
python3 -B execution-image/validate.py execution-image/manifest.json
# Requires approved gh attestation capability and existing approved registry access.
# The attestation command is unavailable in this source run; no login/token workaround.
gh attestation verify \
  oci://ghcr.io/paperclipai/paperclip@sha256:95cc19e5fdd7804b9fd8699fbe33a7202ae6a26e2b42dc5e6fdf4785f213deed \
  --repo paperclipai/paperclip \
  --signer-workflow paperclipai/paperclip/.github/workflows/docker.yml \
  --source-ref refs/heads/master \
  --source-digest e4b39da6f6304c18d40dff13a5c7d224b3bf50fd --format json
```

Require a successful independent verifier result and inspect its signed predicate
for the exact full source SHA, subject name/digest, source repository/ref and
signer. Do not infer source-SHA agreement from the lookup tag or from exit status
alone. Bind the raw verifier receipt, approved carrier commit and file hashes to
artifact-specific security acceptance. Confirm candidate-base application,
plugins, migration compatibility and uid/gid/startup compatibility against the
current controller before creating/adopting a derivative; none is established by
this source task. If the supported candidate is not compatible, stop: review the
correct source/base delta in its owning repository rather than patching live `/app`.

### 2. Separately authorized image creation/publication and artifact receipt

Only after independent exact-source acceptance and explicit image-creation and
publication authority, an authorized executor may use this command envelope:

```sh
# UNEXECUTED. Approved variables must be concrete; no defaults or credentials here.
# Source checkout must be clean at the independently accepted exact commit.
docker buildx build --platform linux/amd64 --provenance=mode=max \
  --metadata-file "$RECEIPT_DIR/build.json" \
  --tag "$APPROVED_DESTINATION" --push \
  --file execution-image/Dockerfile execution-image
```

This is not authorized by merging the source packet. Never publish as the
upstream standard image or retarget its tag. Record actual derivative digest,
base/architecture, exact carrier revision/byte hashes, builder identity, complete
installed package/archive inventory and its own independently verified signed
provenance. Do not invent an output digest from the recipe hash. Check executable
compiler/linker/header/pkg-config visibility as uid/gid 1000:1000 in the **produced
image** and later in the **actual wrapper runtime**. Build-time checks are not an
exact-runtime compiler receipt. Keep those receipts outside this permanently
source-only manifest; changing its null outputs to a fabricated receipt is refused.

### 3. Existing runtime adoption gates and controlled rollback

Bind a separately reviewed deployment/configuration delta to the produced
immutable digest, exact current application worktree revisions, wrapper SHA,
Rust selection and accepted current policy bytes/identity. Preserve inherited
tini/entrypoint/command, read-only root/no writable `/app`, execution uid/gid,
existing protected finite filesystem, target/scratch/external output locations,
lease/process ownership, network/secret boundaries and monitors. Do not copy the
wrapper into this image or substitute a private target/ or another compiler path.

The existing 32 GiB/four-slot finite pool and namespace mapping are credited.
This recipe does not create, resize, reserve, mount, measure or accept it. Full
backing reservation, four-slot/current-wrapper adoption and excess-invocation
refusal, scratch/layer/external-output/process coverage, protected mount lifetime,
headroom/monitor protection and authoritative current-configuration/security
acceptance remain required. Sampled slot budgets are not hard per-slot quotas.
Do not repeat the historical same-mechanism refusal proof or fill the live pool.
Unknown, live and shared output remains intact.

The original runtime executor obtains applicable current-configuration/security
receipts and the separate drained-change/go-live decision. **No host switch or
restart command is prescribed here**: the approved installed carrier/control
route and rollback command must be pinned on that executor's existing runtime
leaf before action. Do not assume Docker, Compose or a service name. The exact
current host controller/configuration was intentionally not inspected here.

The approved change must drain owned work and prove no live leases/processes;
capture the previous immutable image and configuration byte hashes; preserve
pool/output mounts; apply only the accepted image/configuration delta; and check
readiness plus compiler/wrapper identity before admitting work. Any provenance,
identity, compiler, policy, capacity, boundary or readiness failure retains HOLD.
Rollback through the same approved controller after draining: restore the prior
verified immutable image/configuration only, preserving pool and every output.
Do not clean caches/history, remap mounts, repair allocation or alter credentials.
Receipt delivery is an event, not permission to execute those operations.

## Official source references

- [Docker digest pinning, APT and USER](https://docs.docker.com/build/building/best-practices/)
- [Debian timestamped snapshots](https://snapshot.debian.org/)
- [GitHub artifact-attestation verification](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/verifying-the-provenance-of-an-artifact)
- [Canonical base Dockerfile](https://github.com/paperclipai/paperclip/blob/e4b39da6f6304c18d40dff13a5c7d224b3bf50fd/Dockerfile)
- [Unprivileged startup contract](https://github.com/paperclipai/paperclip/blob/e4b39da6f6304c18d40dff13a5c7d224b3bf50fd/scripts/docker-entrypoint.sh)
