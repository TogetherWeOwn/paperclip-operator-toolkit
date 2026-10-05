# GARM isolated-image minimal-base policy

Source-only policy note. This note records the minimal-base decision for
the isolated runner image defined in
`Dockerfile.isolated` (which expresses `isolated-image-profile.json` in
Dockerfile form). No live rebuild, no host execution, no registry push is
authorized from this source; every real build input stays null (HOLD) per
the README "Build-input and evidence contract" §2 until an operator
collects it through an installed authorized read/build path.

Enforced by the offline script `garm_image_lint.sh` (repo root), backed by
`garm_image_lint.py` using Python's standard library. It does not depend on
hadolint being installed. This is the GARM-specific structural policy subset,
not a claim to implement every hadolint rule or analyse arbitrary shell code.
Rule codes below are the linter's `GARM-*` codes.

This slice delivers the offline **script** form, not automatic CI wiring.
No existing required check is changed, removed or bypassed. Future CI wiring
must use the repo's changes-gated `ci-ok` contract (changes job, job-level
gates, full suite for dependencies/lockfiles/`.github` and main/nightly);
branch-protection changes remain separate.

## 1. Base: ubuntu 24.04, pinned at build (GARM-BASE-01, GARM-FORMAT-09)

- `FROM ubuntu:24.04` — matches the profile `distribution`. Full release,
  never `latest`, never a bare or major-only tag.
- The digest pin is an operator build-time input from the §2 base-image
  fingerprint, recorded in the preceding comment block as `# pinned-at-build:`.
  Both the source-only tag with that justification and the completed
  `ubuntu:24.04@sha256:<64-hex>` reference pass structural lint, even when
  the comment remains. The actual FROM repository/release must match the
  profile; a Debian base cannot pass by mentioning Ubuntu in header prose.
  A floating base tag never builds. `apt-get upgrade` inside the build is
  refused for the same reason: the release moves only by rebuilding from a
  fresh base.

## 2. What stays in the image, and why

| Kept                | Why (maps to profile `toolchain`)                        |
| ------------------- | -------------------------------------------------------- |
| `ca-certificates`   | TLS roots: the runner must verify GitHub + artifact URLs |
| `gcc`, `make`       | `cc` — the native-build smoke (`native_build` probe)     |
| `postgresql-client` | `psql` on PATH — native Postgres + role-setup smoke      |
| Node 24 (`/opt/node24`) | `node` series 24 — runner runtime + action support, with `runner_smoke` |
| GitHub runner (`/opt/runner`) | `runner` — ephemeral job execution |
| `runner` user, `USER runner` | `runtime_user`: non-root, no sudo, no login shell (GARM-USER-02) |

Runner + Node 24 arrive as `COPY`ed build-context artifacts with SHA-256
verification against the §2 download checksums — never by download inside
the build (GARM-COPY-05, GARM-FETCH-08). The runner archive has members rooted
at `bin/`; a standard Node Linux archive has one
`node-v24.<version>-linux-x64/` prefix. Extraction first creates `/opt/runner`
and `/opt/node24`, then removes the Node prefix with `--strip-components=1`
so PATH resolves `/opt/node24/bin/node`. The offline suite exercises these
commands using synthetic archives in scratch; it does not download archives
or attest real contents. `ENTRYPOINT` is a valid JSON string array so the
runner is PID 1 and receives signals (GARM-EXEC-06).

## 3. What is excluded, and why

| Excluded | Why |
| -------- | --- |
| sudo / any privilege escalation | Profile `runtime.sudo: false`; isolated jobs never run with sudo (GARM-PRIV-03) |
| Docker client, daemon, socket, `DOCKER_HOST`, TCP relay | Profile `docker.*: false`; no Docker surface on isolated (GARM-PRIV-03) |
| PHP, Composer, PHP extensions | `absent-by-design`; they live on the privileged role only |
| Remote piped installers (`curl … \| sh`) | Unverifiable floating code at build time (GARM-FETCH-08) |
| Unpinned apt packages, recommends, upgrade | Unresolved indexes float the image; every package carries an `=version` pin and installs with `--no-install-recommends`, lists cleaned (GARM-APT-04) |
| Credentials in ENV/ARG or flags | No secrets in the image definition, ever (GARM-SECRET-07) |

The `=version` pins in `Dockerfile.isolated` are shape placeholders the
gate checks structurally; the operator substitutes the exact versions from
the §2 package snapshot at build time. Unresolved pins never build.

## 4. Structural gate boundaries and verification

The parser joins Docker backslash continuations and skips only full-line
Docker comments **before** checking instructions. Each apt install needs
literal exact package pins, `--no-install-recommends`, and subsequent apt-list
cleanup in the same RUN layer. The final USER is checked before its optional
group (`root:root` and `0:0` are still root). Every ARG name, legacy ENV name
and name in multi-assignment ENV is inspected, without printing operand
values. Plain or copied Docker binaries and absolute-path/continued piped
shell installers are refused. ENTRYPOINT/CMD must be nonempty JSON arrays
of strings, not merely begin with `[`.

RUN supports literal shell commands joined by `&&`, `||`, `;` or pipelines.
Opaque forms (exec-form RUN, variables, substitutions, heredocs and shell
operators outside that subset) fail closed with GARM-FORMAT-09. Unknown
Docker instructions and malformed syntax also fail closed. This gate does
not prove archive checksums, native-library completeness, runtime writability
or isolation; those remain real-build/smoke evidence requirements under HOLD.

```sh
./garm_image_lint.sh github-runner/garm/Dockerfile.isolated
./test_garm_image_lint.sh
```

The suite pins all nine rules with refusal and positive controls, including
reviewer regressions on the actual multiline definition. Base/user gate-deletion
mutants prove those refusals are load-bearing. An independent instruction-only
assertion compares FROM and USER with `isolated-image-profile.json` and excludes
PHP/Composer/sudo/Docker. Synthetic archive layout tests kill missing-directory
and unstripped-Node-prefix mutants. Stub image/network tools must remain uncalled;
credential canaries and inherited environment values must not appear in output.
These are offline structural results, not permission to build or admit an image.
