# protection-rule

A generic, fail-closed custom deployment protection rule. It answers GitHub
`deployment_protection_rule` webhooks using fresh run/artifact reads and narrow
`GO` markers on a configured Paperclip issue. It has **no built-in policy,
approver identity, installation allowlist or reviewed plan repository scope**.
Missing or invalid trusted configuration refuses construction and server startup.

This is source tooling, not an installed service or an authorization grant.
Synthetic test configuration authorizes **no live deployment**. Never copy a
fixture into an operator configuration or infer authority from webhook fields.

## Decision modes

An operator-reviewed policy maps an exact `(repository, environment)` pair to
one mode and one approval issue UUID:

- `plan`: a fresh apply-job claim names a plan run and manifest SHA-256. The plan
  must be on the same commit; downloaded manifest bytes must match the claimed
  hash; the configured approver must have posted `GO <64 lowercase hex>` for that
  exact hash on this policy's issue.
- `sha`: a fresh run read establishes the head SHA. The configured approver must
  have posted `GO <40 lowercase hex>` for that exact commit on this policy's issue.
  There is no plan/artifact fallback.

The approver is a configured **agent UUID**, not a caller-selected author. A
comment contributes only if `authorAgentId` matches and `authorUserId` is exactly
`null`. Human-authored comments, other agents, ordinary prose and a GO on another
issue do not approve. Plan and SHA marker patterns are disjoint; a 64-hex marker
never grants approval for its 40-hex prefix. Marker hex is case-normalized to
lowercase, preserving the existing recognition contract.

The reason IDs retain the existing wire contract, including the historical
`ceo_go_*` names. These names do not select an identity or confer a role.

## Trusted configuration contract

`createApp` requires `trustedConfig`. The host adapter reads it as JSON from
`PROTECTION_RULE_CONFIG_FILE`, validates it before reading the key or starting
HTTP, and makes a detached immutable snapshot. There is no default/fallback file,
policy or identity and no legacy issue-selector override.

Required fields (unknown fields also refuse):

| Field | Validation and meaning |
| --- | --- |
| `policies` | Nonempty array of `{ repository, environment, mode, goIssueId }`. Repository is `owner/name`; environment is an exact, nonempty name up to 128 characters, with no surrounding whitespace/control characters; mode is `plan` or `sha`; issue selector is a lowercase UUID. Duplicate pairs, including repository case aliases, refuse. |
| `approverAgentId` | Explicit lowercase UUID of the approved agent principal. No identity is inferred from comments or deliveries. |
| `reviewedPlanRepositories` | Explicit array of unique repository names, exactly matching the repositories with plan-mode policies. An SHA-only configuration supplies `[]`; omission is not equivalent to empty. Evidence readers independently require and enforce this scope. |
| `installationIds` | Nonempty allowlist of unique positive safe-integer GitHub App installation IDs. The signed delivery's installation must belong to it before any mint or read. |

The repository/environment fields in a webhook are selectors within this trusted
configuration, not permission to extend it. The callback is routing only; it
must be the HTTPS GitHub API review endpoint for this repository and run, with
no credentials, nonstandard port, query or fragment. Run identity is verified
again from fresh GitHub state before a verdict is posted. Foreign repositories,
installations and callbacks receive an HTTP error and no verdict/credential use.

**Trust is an operator boundary, not a property of JSON validation.** The
operator must own and review the file, its parent path and the startup
configuration. Do not place it in a request-writable or shared caller-controlled
path. This package does not authenticate configuration ownership, select approvers
for an organization, or supply a live policy table. Changes to that trusted input
require the operator's review and a restart.

## External producer contract for plan mode

Plan mode is usable only with a separately reviewed workflow that implements all
of this contract. No producer workflow or deployment transport is shipped here.

1. The apply job exposes its claimed binding in a job **step name**:
   `migrate-plan-binding: sha256=<64hex> run=<positive decimal plan run id>`.
   The reader inspects jobs on the fresh apply run (`per_page=100`) and uses the
   first matching marker. Producers must emit one unambiguous marker; missing
   markers cannot authorize a default plan. The inherited run-ID marker captures
   at most ten decimal digits and does not validate the entire step name. Producers
   must emit canonical IDs within that bound; longer IDs require separately
   reviewed producer/verifier protocol work, not an assumed compatible deployment.
2. That plan run is in an explicitly reviewed plan repository and on the same
   head commit as the apply run. The policy repository gate and evidence scope
   gate both stay in place; neither is inferred from the claim.
3. The artifact name is exactly `staging-migrate-manifest.json`. This fixed name
   and the `migrate-plan-binding:` step marker are producer protocol identifiers,
   **not live environment mappings**. Changing either requires coordinated
   producer and verifier changes, plus fixtures proving the new contract.
4. The downloaded archive uses stored/uncompressed, unencrypted ZIP entries,
   with no data descriptor. It must contain exactly one JSON object document.
   Producer ZIPs must be single-disk. Entry names are not used as paths or
   selectors. The reader bounds archive, entry and manifest sizes; unsupported
   flags/methods or ambiguous JSON refuse. It is not a general ZIP validator:
   it does not check CRCs or multi-disk metadata.
5. The approval hash is SHA-256 of the exact JSON document bytes inside the ZIP,
   not of the ZIP or a reserialized object. A digest field is optional; if
   `plan_manifest_sha256`, `manifest_sha256` or `sha256` is present, the selected
   field must be well-formed and agree with those bytes. Producers can omit it
   to avoid attempting a self-referential digest. Claimed hash and GO must both
   match the actual bytes digest.

This package does not prove a workflow meets that contract. Successful synthetic
fixtures prove verifier behavior only, not live authorization or producer review.

## Receiver and host adapter

The signature authenticates possession of the webhook secret, not that GitHub
itself requested the deployment: anyone holding that secret can forge a delivery.
Decision evidence is recomputed from API reads. Guard the secret as a credential.
Unsigned/forged deliveries get 401; unconfigured credential inputs get 503;
oversized bodies get 413, before credential use. Unknown scopes fail closed.

The minter uses only the configured App identity; no alternate credential is tried.
API tokens are headers, never argv or logs. Artifact redirects are HTTPS-only,
bounded, and strip the token off-origin (including a nondefault API port). Callback
posts do not follow redirects. Failed evidence yields rejection; failed verdict
delivery is reported separately and is never presented as a delivered approval.

For an independently authorized operator deployment, the host adapter requires:

- `PROTECTION_RULE_CONFIG_FILE` — operator-controlled trusted JSON described above
- `PROTECTION_RULE_WEBHOOK_SECRET` — App webhook secret
- `PROTECTION_RULE_APP_ID` — GitHub App identity
- `PROTECTION_RULE_KEY_FILE` — protected App RSA key file, read once
- `PROTECTION_RULE_BOARD_TOKEN` — board credential
- `PROTECTION_RULE_BOARD_ORIGIN` — HTTPS origin (or loopback HTTP), no path/query/auth
- optional `PROTECTION_RULE_PORT` — valid port, default 8788; binds loopback only

Secrets travel by inherited environment, never argv or the trusted JSON. Keep the
key file restricted to the operator (0600). Start with `node src/server.js` only
after the operator has supplied and independently reviewed the configuration and
external integration. Configuration errors exit 2 before serving. Importing the
entrypoint does not start it.

`GET /health` reports liveness only; it does not prove webhook registration,
producer compliance, reviews or any approvals. A down endpoint makes deployments
wait for GitHub expiry, not approve. Registration, installation permissions,
transport, secret custody, deployment and rollout review are operator responsibilities
and are deliberately outside this generic port.

## Offline verification

The package declares Node 20 or newer; local verification used Node 24.21.0 and
the ported CI job selects Node 24. Node 20 has not been independently exercised.
There are no package dependencies or install steps. `npm run check` parses all
modules/tests; `npm test` runs all suites with an offline
preload that refuses actual network I/O and socket binding. Run with a clean
inherited environment (`env -i PATH="$PATH" npm test`) so no API/credential variables
enter the process. Tests inject all reads, mints and callback posts; the mint suite
uses a freshly generated throwaway key and an in-memory API response.

Tests cover both decision modes, missing/invalid trusted configuration, startup
refusal, immutable scope, author/user gates, cross-card approval, digest separation,
foreign repositories/installations, callback identity/run binding, off-origin token
stripping, plan hashes/artifacts/markers, and signature forgery/tampering. Passing
these tests is not independent security approval, deployment approval or permission
to publish.
