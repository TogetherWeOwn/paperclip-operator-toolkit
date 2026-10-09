# Verified-result policy (source-only)

Status: source-only. The checker reads the JSON printed by `gh attestation verify --format json` and applies pinned identity checks. It does not verify signatures, certificate chains, transparency-log entries, or artifact bytes. Every verdict reports `authenticity: not_established` and `hold_cleared: false`. Nothing in this unit runs the verifier, acquires roots, binaries, or image layers, or builds an image.

## Files

- `verify_result_policy.py`: checker CLI (`main`), bounded parser, and `capture()`, a bounded helper that runs one caller-pinned executable and returns its stdout. It writes no files. Neither CI nor the CLI calls `capture()`; an operator-authorized caller supplies argv and the expected executable SHA-256.
- `test_verify_result_policy.py`: offline unit tests, including a binding test against `manifest.json` `base`. The `offline-suites` job runs them in the `execution-image source-only carrier suite` step whenever change detection sets `heavy=true`: any `.github/**` change or any non-doc change. A docs-only change skips that step.

## Use

```sh
python3 -B execution-image/verify_result_policy.py saved-verify-output.json
```

Prints one JSON verdict. Exit 0 means `satisfied`, 1 means `refused`, 2 means a usage or I/O error. The input must be a regular file: a FIFO, device, or directory exits 2 without blocking.

## Operator-run verifier (documented, not run here)

```sh
gh attestation verify oci://ghcr.io/paperclipai/paperclip@sha256:95cc19e5fdd7804b9fd8699fbe33a7202ae6a26e2b42dc5e6fdf4785f213deed \
  --repo paperclipai/paperclip \
  --signer-workflow paperclipai/paperclip/.github/workflows/docker.yml \
  --source-ref refs/heads/master \
  --source-digest e4b39da6f6304c18d40dff13a5c7d224b3bf50fd \
  --predicate-type https://slsa.dev/provenance/v1 \
  --format json
```

This matches `execution-image/README.md:124-129`, with `--predicate-type` added explicitly (it is the gh default, `verify.go:249`). Save stdout to a file and pass that file to the checker. The `--signer-workflow` value omits `@refs/heads/master`; see the ledger.

## Policy rules

Each rule refuses with the code in the first column. Checks run in this order and stop at the first refusal.

| Code | Requirement |
|---|---|
| `result_count` | Top-level JSON array has exactly one element. |
| `result_shape` | Element has a `verificationResult` object. |
| `media_type` | `mediaType` starts with `application/vnd.dev.sigstore.bundle.` (prefix only). |
| `statement_shape` | `statement` is an object. |
| `statement_type` | `_type` is `https://in-toto.io/Statement/v1`. |
| `predicate_type` | `predicateType` is `https://slsa.dev/provenance/v1`. |
| `subject_shape`, `subject_count` | `subject` is a list of exactly one object with `name` and `digest`. |
| `subject_name` | `subject[0].name` is `ghcr.io/paperclipai/paperclip`. |
| `subject_digest` | `subject[0].digest.sha256` is `95cc19e5fdd7804b9fd8699fbe33a7202ae6a26e2b42dc5e6fdf4785f213deed`. |
| `certificate_shape` | `signature.certificate` is an object. |
| `issuer` | Certificate `issuer` is `https://token.actions.githubusercontent.com`. |
| `signer_identity` | `subjectAlternativeName` is `https://github.com/paperclipai/paperclip/.github/workflows/docker.yml@refs/heads/master`. |
| `build_signer` | `buildSignerURI` is the same signer identity. |
| `source_uri` | `sourceRepositoryURI` is `https://github.com/paperclipai/paperclip`. |
| `source_ref` | `sourceRepositoryRef` is `refs/heads/master`. |
| `source_digest` | `sourceRepositoryDigest` is `e4b39da6f6304c18d40dff13a5c7d224b3bf50fd`. |
| `run_invocation` | `runInvocationURI` is `https://github.com/paperclipai/paperclip/actions/runs/37717359076/attempts/N`, where N has 1 to 9 digits and no leading zero. |
| `timestamps` | `verifiedTimestamps` is a non-empty list. Each entry has non-empty string `type`, `uri`, and `timestamp`. |

Parse refusals, raised before any rule: `input_too_large` (over 4 MiB), `invalid_encoding` (not UTF-8), `invalid_json`, `duplicate_key`, `non_finite_number` (NaN, Infinity, or a number literal that overflows to infinity such as `1e999`), `too_deep` (over 64 levels), `too_many_nodes` (over 100,000 nodes).

Depth and node counts are checked after parsing, so peak memory scales with the 4 MiB input and Python object overhead. On Python builds with the integer-string conversion limit (3.11 and later), integer literals over 4300 digits are refused as `invalid_json`. Other builds accept them, so their conversion time is bounded only by the input cap.

Capture refusals (`capture()` only): `argv`, `executable_path`, `executable_sha256`, `spawn`, `output_limit` (over 4 MiB of stdout), `timeout` (120 s default), `exit_status` (non-zero).

## Capture contract

- POSIX only. argv is a list of strings. argv[0] is an absolute, readable, executable regular file whose SHA-256 matches the caller's pin.
- `shell=False`; stdin and stderr go to DEVNULL; PATH and the environment are not changed; stdout is capped at 4 MiB; one attempt, no retry, no daemon.
- The child starts in a new session. Any path that leaves the leader unreaped (timeout, output cap, or an error) sends SIGKILL to the whole process group before the helper returns.
- The child inherits the full environment, including any credential variables the caller holds. Passing an allowlist is an operator decision; this unit does not choose one.
- Residual: the hash is checked before exec, so a file replaced between the check and the exec is not caught. This is not closed here. A future option is to hash and execute through the same descriptor (`/dev/fd/N` with `pass_fds`).

## Upstream pins

Hashes were computed on source files fetched at the commits below.

| Upstream (commit) | File | SHA-256 | Used for |
|---|---|---|---|
| cli/cli v2.102.0 (`fc4b137cdef0a6bd28fd461b7cf9c84a5812a8cd`) | `pkg/cmd/attestation/verification/attestation.go` | `6a0ffd037d583a0344e717f35814c9679f7a5c59589d4ebbbd34e1f979b0f875` | `SLSAPredicateV1` (line 18) |
| | `pkg/cmd/attestation/verification/sigstore.go` | `33e776307f070e0d32722055bf5e42118555305c8eaf50fe092629acca39f212` | JSON element keys `attestation`, `verificationResult` (lines 29-30) |
| | `pkg/cmd/attestation/verify/verify.go` | `8394f4b550a3b776dd846656a1f67130a6622f7023fc9cc30477d943b4dd1661` | `--predicate-type` default (line 249); JSON output (lines 309-313) |
| sigstore/sigstore-go v1.3.0 (`22d3691c7b8e0c5530fae3c05577690bfef5cd00`) | `pkg/verify/signed_entity.go` | `5b48207ed260898f09d74d72689ce7ada0b983aad93a3c51b82fec998d337bca` | `VerificationResult` keys `mediaType`, `statement`, `signature.certificate`, `verifiedTimestamps` (lines 254-269); protojson statement (lines 278-302) |
| | `pkg/fulcio/certificate/extensions.go` | `a4929b9d278c6e810c597a8e98256fd1301c08590a01fc48227896b45f753a35` | Certificate keys `issuer`, `buildSignerURI`, `sourceRepositoryURI`, `sourceRepositoryDigest`, `sourceRepositoryRef`, `runInvocationURI` (lines 71, 99, 108, 111, 114, 135) |
| | `pkg/fulcio/certificate/summarize.go` | `c4e1d487f9feaded5e206b7028f6d303f0757db4d99cdab1d65888a1fbb0e500` | `subjectAlternativeName` (line 28); `certificateIssuer` is the CA DN and is not used |
| in-toto/attestation v1.2.0 (`df02077bf97218a8860a5c534eff1f1381f56984`) | `go/v1/statement.go` | `aec9e8ae6d6fefdcb3c202744baa1f7a774686010213118782699dbfe35c42b9` | `StatementTypeUri` = `https://in-toto.io/Statement/v1` (lines 11-13) |
| | `go/v1/statement.pb.go` | `6a27a8b6de02c33b382949820b24e676d32cb050271d43fa40bccf41a602f21b` | JSON names `_type` (line 31), `subject` (line 32), `predicateType` (line 33), `predicate` (line 34) |
| | `go/v1/resource_descriptor.pb.go` | `328985e6621f2598f917036511e999dadf2039ad1f1808cbbb200f4455fee014` | Subject `name` (line 30), `digest` (line 32) |

The gh test fixture `tests/gh-pkg_cmd_attestation_verification_extensions_test.go:18` uses the same OIDC issuer literal. The sigstore-go fixture `pkg/verify/tlog_test.go:38` uses the statement key shape `_type`, `predicateType`, `subject[].name`, `subject[].digest.sha256`, and `predicate`.

## Capability ledger

| Item | State | What would move it |
|---|---|---|
| Statement key spelling (`_type`, `predicateType`, `subject[].name`, `subject[].digest.sha256`) | Supported by the pinned protobuf tags, sigstore-go `MarshalJSON`, and the sigstore-go statement fixture. Not yet observed in a real `gh attestation verify --format json` output. | One real verifier output, passed through the checker. |
| Real subject name and digest | Pinned to `manifest.json` `base` and checked by the binding test. Not checked against a live attestation. | Operator-run verifier output. |
| `runInvocationURI` present for this producer; `buildSignerURI` equals the signer identity | Unconfirmed. Absence refuses. | Certificate fields from the operator-run output. |
| Accepted `mediaType` values | Prefix check only. The exact set is not pinned. | Pin the set from the first real output and the upstream bundle spec. |
| `--signer-workflow` form | `execution-image/README.md:127` omits `@refs/heads/master`. The checker reads certificate fields and does not depend on this flag. | Operator confirms the flag form in an authorized run. |
| gh binary SHA-256 | Not pinned. The caller supplies it. No binary was acquired. | Operator provides the approved binary hash. |
| Hash-to-exec window in `capture()` | Open residual. | Hash and execute through the same descriptor. |
| Environment inherited by the capture child | Full environment passed through, including credential variables. No allowlist. | Operator decision on an allowlist, then an authorized run that uses it. |
| Descendants that outlive a successful exit | Not killed. Timeout, output-cap and error paths kill the group. | Run the caller inside a cgroup or container that is torn down on exit. |
| Signature, Fulcio chain, Rekor inclusion, artifact bytes | Not verified by this unit. | Authorized verifier run with separate security acceptance. |
| Authenticity and HOLD | Not established. Not cleared. | Security acceptance of the bound artifact. |

## Operator decisions (routed, not made here)

1. Authorize a verifier run in the separately authorized environment, and supply the approved gh binary SHA-256. The command is above. The output is read-only, and deleting the saved file is the rollback.
2. After the first real output, decide whether to pin the accepted `mediaType` set, and confirm the `--signer-workflow` form and whether `runInvocationURI` is present for this producer.
3. A `satisfied` verdict does not clear any HOLD. Artifact-specific security acceptance remains a separate decision.
4. Decide whether the capture child receives an environment allowlist before any authorized run uses `capture()`.
