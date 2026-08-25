# paperclip-ops-tooling

Operator tooling for PaperclipAI companies on the `example.net` VPS.

**Most of these are operator-run CLIs. `org_request_queue.sh` is not — agents drive it.**

This reverses what this file said until 2026-08-23, and the reversal is the point rather than a
correction of a typo. The old statement was "agents cannot execute any of this; agents propose
changes and the operator applies them." The owner decided (TOG-194) that the responsible leadership
agent must be able to *run* the provisioning path: a subordinate requests and makes its case, the
responsible leader evaluates, and an approval **executes**. The leader is accountable for the
decision; it is explicitly not a rubber stamp.

What has NOT changed is why the constraint existed. The `paperclip` container still mounts exactly
one host path (`~/.local/share/paperclip -> /paperclip`) and none of this tooling is on it, so an
agent still cannot execute these scripts directly, and a `local_stdio` MCP server — spawned from the
server process, inside that container — cannot either. Agents reach the queue over a host-side
`mcp_remote` MCP server running as the operator user, which is the only sanctioned transport.

That transport carries one requirement that the entire authorization design rests on: **it must
derive requester and reviewer identity from the authenticated agent principal supplied by Paperclip's
tool gateway, and must never accept either as a tool argument.** An identity the model can fill in
makes every check below decorative.

Who decides a request is derived from the reporting chain, not a fixed pair of roles — see
[docs/responsible-leader.md](docs/responsible-leader.md).

The standing authority set (`P4_PROVISIONING_STEWARD`, `P1_PRESIDENT_COO`) is retained as an
escalation floor and a break-glass path, so a dormant leader cannot deadlock its subtree. A
break-glass decision taken *over* a derivable leader is recorded **and surfaced**: the reviewer is
told at decision time, `org_request_queue.sh overrides` lists the open ones and exits non-zero,
`list` carries an `OVERRIDE` column, and check 10 of `org_access_review.sh` turns each unacknowledged
one into a finding. It stays open until an auditor who did *not* take it clears it with a written
note (`ack-override`). A bypass nobody reads is the same as a bypass nobody logged.

**The requester is told.** Every terminal transition — approved, rejected, expired, failed — notifies
the agent that submitted the request: the reason on a denial, the seated agent's id on an approval,
and the fact of expiry, which previously woke nobody at all. Delivery is an outbox and never a gate:
the decision is committed before delivery is attempted, a failed delivery is logged rather than
retried into a different recipient, and `inbox --for <ROLE>` works with no transport, no credential
and no network. Push makes a decision timely; pull is what makes it reliable. See
[docs/responsible-leader.md](docs/responsible-leader.md) and `notify_paperclip_issue.sh`.

**Capabilities are a different question with a different answer (TOG-387).** The queue above brokers
org seats and derives authority from the delegation ceiling. `capability_gate.sh` brokers
*capabilities* — a credential, a tool scope, a root action — and no ceiling says who may hand out a
GitHub token, so it derives authority from **ownership of the domain**, with the CISO's
countersignature as an independent second key on anything credential-class. It has **no break-glass
path**, deliberately: the queue's override is bounded (an agent seated a level early), a capability's
is not. Four classes of ask — real money, deleting or rotating a credential, anything published
outside the company, anything with no rollback — stop for the owner and no agent may decide them,
including the President & COO. The class is derived from a registry in the file and cannot be
declared by the requester. See [docs/capability-gate.md](docs/capability-gate.md).

**That tool inherits the same identity gap, and it is not closed yet.** `--requester`, `--reviewer`
and `--custodian` are unauthenticated flags, measured rather than assumed: in one shell session an
agent submitted a request as the CTO and approved it as the President & COO. Both tools are safe
only behind the transport described above. Until `capability_gate.sh` is reachable through it, it is
operator-run.

## What is here

| Tool | Purpose | Suite |
|---|---|---|
| `org_provisioner.sh` | Constrained agent provisioning. Enforces the report §8.2 privilege invariants. | `test_privilege_ceilings.sh` |
| `org_request_queue.sh` | Approval-gated `org.request_descendant` / `org.review_request`, decided by the responsible leader, and the decision is delivered back to the requester. | `test_responsible_leader.sh`, `test_request_record_integrity.sh`, `test_decision_notify.sh` (offline), `test_request_queue.sh` (live) |
| `capability_gate.sh` | The sibling of the queue above, for asks whose object is a **capability** rather than an org seat. Domain owner decides, the CISO countersigns anything credential-class, and four classes of ask stop for the owner whatever any agent says. The risk class is derived from a registry in the file, never declared by the requester — there is no `--risk` flag and passing one is a refusal. A denial at **either** key must leave the requester somewhere to go (`--alternative`, or an explicit `--no-safer-alternative`), and a countersignature is always a risky grant so it always carries the `--considered/--because` record — a contract **shared byte-identically** with `org_request_queue.sh` through `lib/reqrecord.sh` rather than copied. `comment` lets a decider ask for a fact instead of guessing at an alternative. Approving is a **decision record, not a grant**. See [`docs/capability-gate.md`](docs/capability-gate.md). | `test_capability_gate.sh`, `test_reqrecord_shared.sh` (offline) |
| `notify_paperclip_issue.sh` | Reference `REQUEST_NOTIFY_CMD` transport: posts a decision to the requester as an issue comment. Treats its payload as untrusted: two of its fields are written by the requester. | `test_notify_transport.sh` |
| `interaction_route.sh` | Where an ask belongs — the **owner**, an **agent**, or an **operator runbook** — and whether the interaction could be answered at all once created. `check` audits pending interactions against the seven gates the server actually enforces. Refuses to emit an envelope that would be inert: 42 of this company's 49 pending asks are blocked by the creator bar alone, whatever their kind or policy. Review-verdict eligibility fails **closed**, and `addresseeAgentId` only routes on an **unassigned** issue (TOG-395) — the one zero-code agent-to-agent question channel. See [`docs/interaction-routing.md`](docs/interaction-routing.md). | `test_interaction_route.sh` (offline) |
| `queue_liveness.sh` | Whether the agent a request was routed at can actually receive the decision, and whether a queue has stopped deciding. Read-only, distinct exit codes (`3` alarm, `4` do-not-route, `5` **could not measure — not clean**) — cron/CI-able. Reports `undetermined` rather than guessing when it cannot tell a throttled agent from a disabled one. | `test_queue_liveness.sh` |
| `quota_brake.sh` | Holds weekly quota to pace by lowering `maxConcurrentRuns`, which **queues** work, instead of clearing `wakeOnDemand`, which **discards** it. Dry-run by default; nothing writes without `--yes`. Exemptions (`quota_brake_exempt.txt`) are read before the candidate set is built, so no brake level can reach the Chief of Staff. Baselines live in each agent's own record, so `restore` needs no state file. `verify` exits `3` if any agent is unwakeable; `refusals` turns the platform's already-recorded dropped wakes into a number and exits `3` over threshold. Refuses to write a daily cap — those drop wakes too, while leaving a roster check green. See [`docs/quota-brake.md`](docs/quota-brake.md). | `test_quota_brake.sh` (offline) |
| `org_access_review.sh` | Standing least-privilege audit. Read-only, non-zero exit on findings — cron/CI-able. | — |
| `credential_chain_audit.sh` | Standing check that no agent uid can get code into git's credential-helper chain (TOG-310). Audits every config git reads, not just the helper, because git runs a helper named by any of them. `--staged` additionally checks scripts staged for an operator to root-run against their reviewed source here. | `test_credential_chain_audit.sh`, `test_credential_chain_pin_gate.sh` |
| `credential_chain_lockdown.sh` | The **operator-run** remediation for the above: root-owns the four links the audit reports. Refuses `--apply` until the runner confirms this copy matches `origin/main` — see below. | — |
| `skills.sh` | Role-aware skill provisioning: who may author, who may equip whom. | — |
| `gh_token.sh` | GitHub App JWT + installation-token minting, with down-scoping. | `test_gh_token_argv.sh`, `test_gh_token_dispatch.sh` |
| `gh_access.sh` | Two-key GitHub eligibility policy. | — |
| `gh-app-token.js` | The in-container git credential helper. Asks `gh-token-broker` for a scoped token per git call; the local PEM is the fallback. `scope-check` reports whether strict mode accepts an environment, without minting. | `test_gh_app_token.sh`, `test/gh-app-token.test.mjs` |
| `plugins/gh-token-broker` | Control-plane token broker. Resolves the App PEM host-side, so the signing key never enters an agent. | `plugins/gh-token-broker/test/` |
| `plugin_manifest_gate.sh` | Does activating a plugin package change what it is **allowed to do**? Compares the evaluated authorization surface — `capabilities`, and each route's `auth` / `checkoutPolicy` / `companyResolution` — against a reviewed git ref, so comments and formatting are invisible to it and a changed `auth` is not. Unrecognised manifest keys fail closed. Run it before any activation; see `docs/plugin-package-path.md` for why. | `test_plugin_manifest_gate.sh` |
| `gh_ci_status.sh` | Four-state CI status reader. Reports `unknown` — never `pass` — when CI could not be observed, and `non-started` (exit 5) when GitHub reports `completed/failure` for jobs it never actually ran. That last one is an **escalation, not a red build**: there is nothing in the diff to fix, and no CI-enforced gate in this repo is being enforced while it lasts. | `test_gh_ci_status.sh` |
| `agent_endpoint_preflight.sh` | Cutover gate for the agents' model endpoint (TOG-358). Run it **from inside an agent container** before repointing `ANTHROPIC_BASE_URL`: exit 0 only if the endpoint is reachable *from there*, authorized, speaks the Anthropic messages dialect, still reports cache accounting, and is not a pay-per-token lane. | `test_agent_endpoint_preflight.sh` |
| `omniroute_combo_cli.sh` | Constrained OmniRoute combo/mapping manager. Deny-by-default Claude containment. | `selftest` subcommand |
| `lib/pcsql.sh` | The one place that decides how the tools above reach PostgreSQL. Sourced, never run. | `test_sql_backend.sh` |
| `gh-event-capture/` | Self-hosted GitHub webhook store — the partial stand-in for the org audit log GitHub Free does not provide. **Read its README § 1 before relying on it: it is a monitoring aid, not evidence.** | `npm test`, `test/test_scripts.sh` |
| `ROLLBACK.md` | Rollback procedures (company bootstrap). |
| `GH-CREDENTIAL-CUTOVER.md` | Deploy/verify/rollback for the broker cutover, and the `GH_APP_PRIVATE_KEY` unbind sequence. |
| `docs/plugin-package-path.md` | Why `gh-token-broker` shipping from an agent workspace makes deploying code and re-declaring authority the same write (TOG-349), and the operator steps to move it to a host-owned path. |
| `docs/upstream/` | Six unfiled defect reports against the **Paperclip host**. No agent can reach an upstream tracker; filing them is an operator action. Newest — `agent-run-credential-isolation.md` — is the one that blocks TOG-393's design: agent runs share a uid and a PID namespace, so no two-agent control on this box is technical. |
| `docs/adr-root-action-runner.md` | **Design only — ships no executable path.** Whether to build a gated root-action runner (TOG-393). Concludes: build a read-only *unprivileged* host phase; do **not** build an agent-approved root write path, because two keys between two agents is not implementable on this box — one agent's live credentials are readable from another's `/proc`. Read § 4 before proposing any host-side execution. |
| `docs/teamclaude-big-model-stall.md` | Why teamclaude `:3456` stalls (TOG-378). **Read this before sending anything to that endpoint:** one non-Haiku request blocks the model endpoint for every agent on the box for ~60 s, and giving up early does not release it. |

## Running the suites

```bash
# Offline — no credentials, no network, no database. These are what CI runs.
./test_gh_app_token.sh
node --test test/gh-app-token.test.mjs   # pass the FILE, not the directory
./test_gh_token_argv.sh
./test_gh_ci_status.sh
./test_agent_endpoint_preflight.sh
./omniroute_combo_cli.sh selftest
./test_responsible_leader.sh
./test_credential_chain_audit.sh
./test_plugin_manifest_gate.sh
./test_sql_backend.sh
./test_suite_preconditions.sh
(cd plugins/gh-token-broker && npm ci --include=dev --ignore-scripts && npm test)

# Operator-only — need COMPANY_ID and the live Postgres on the VPS.
# Both exit 3 ("could not run") if the backend is unreachable, rather than
# reporting refusals that came from the missing database as enforcement. See
# TOG-402 and test_suite_preconditions.sh.
export COMPANY_ID=<uuid>
./test_privilege_ceilings.sh
./test_request_queue.sh
./org_access_review.sh --allow-active   # 0 findings expected
```

## Which database the tools talk to

`org_provisioner.sh`, `org_request_queue.sh`, `org_access_review.sh` and the two operator suites all
reach PostgreSQL through `lib/pcsql.sh`. It offers two backends:

```bash
# Default. Unchanged from before lib/pcsql.sh existed; you need not set anything.
podman exec -i "$PAPERCLIP_DB_CTR" psql ...      # PAPERCLIP_DB_CTR defaults to paperclip-db

# A plain psql, for a throwaway database that is not the VPS.
export PAPERCLIP_SQL_BACKEND=psql
export DATABASE_URL=postgres://user:pass@host:5432/db    # or export the libpq PG* variables
```

The backend is **selected explicitly and never sniffed**. Setting `DATABASE_URL` alone does not
switch it: the provisioner creates and deletes real agents, and an operator who happens to have that
variable exported for an unrelated reason must not silently retarget it.

`DATABASE_URL` is decomposed into libpq's `PG*` variables rather than passed to `psql`, because a
connection URI carries a password and `/proc/*/cmdline` is world-readable on a host every company on
this box shares. Unrecognised URL parameters are refused rather than dropped — silently discarding
`?sslmode=require` would downgrade the connection while the URL still claimed otherwise.

This seam exists so the privilege-ceiling suites can eventually run against a disposable database
(TOG-202). **It is not sufficient on its own**: those suites drive `org_provisioner.sh`, which
creates and terminates agents through the Paperclip *API*, so they still need a live server as well
as a seeded database. `.github/workflows/ci.yml` lists exactly what is still missing.

**Pass/fail is the exit status, never a test count.** Counts drift as suites grow — this file
carried `104` for the omniroute selftest long after it had passed that — and a count baked into a
gate turns ordinary growth into a red build. Nothing in CI or in these docs asserts one.

`--allow-active` is required once any agent has `wakeOnDemand=true`; without it the review
reports each wakeable agent as a finding.

## Applying the credential-chain lockdown (operator, root)

`credential_chain_lockdown.sh --apply` is the only tool here that an operator runs as **root**, so
how it gets to them is part of its threat model.

```bash
# From the checkout, as root. Verify provenance first -- the script demands it.
git -C <checkout> fetch origin
git -C <checkout> diff --stat origin/main -- credential_chain_lockdown.sh   # expect: empty
podman exec -u root paperclip <checkout>/credential_chain_lockdown.sh --dry-run
podman exec -u root paperclip <checkout>/credential_chain_lockdown.sh --apply --i-have-verified-this-copy
podman exec -u root paperclip <checkout>/credential_chain_lockdown.sh --verify
```

**Do not root-run a copy staged under `/paperclip/operator-handoff`.** That directory is `1777` and
every file in it is owned by the shared agent uid `node`, so any agent can rewrite a script sitting
there between staging and execution. TOG-310's own first remediation was staged exactly that way:
the finding is an agent→agent escalation, and root-running an agent-writable fix would have been
agent→root, which is worse than the bug. The script refuses `--apply` until you confirm the copy in
front of you matches `origin/main`, because git — a reviewed PR — is the only tamper-evident record
in this container. No mode bit substitutes for that: there is no directory here `node` cannot write.

`staged_root_scripts.txt` lists staged mirrors and `credential_chain_audit.sh --staged` reports
`DRIFT` when one stops matching its source. That is detection, not prevention — an agent that can
edit the mirror can edit the manifest too. Its value is that a swap has to be loud, which is
precisely what was missing when the live credential helper was silently replaced on 2026-08-24.

`credential_chain_pins.txt` is the same kind of control for the helper itself, and it asks one
question: **is the live build the one that is supposed to be running** — not "have we reviewed this
build at some point". The difference is the whole control. The 03:32 swap installed `49cfcd95`, a
build this repo had shipped and reviewed, so a flat known-good list scores that incident clean;
downgrade *is* the attack. One `expected` line names the build that should be live, `reviewed` lines
name superseded ones so the report can say which wrong build is running (`STALE`) rather than
confusing it with a file nobody has ever seen (`DRIFT`). CI asserts the `expected` line is the
sha256 of `gh-app-token.js` in the checkout, so changing the helper without repinning fails in the
PR that changed it — the alternative is a detector that cries wolf on the correct state and gets
muted. `test_credential_chain_pin_gate.sh` re-introduces each of those defects into throwaway copies
and requires the named assertions to go red.

## Non-negotiables

These are load-bearing and were each learned by breaking something:

- **No secrets in this repo, ever.** Credentials live in `~/secure-drop/` at 0600 and are passed by
  inherited environment, never on `argv` — `/proc/*/cmdline` is world-readable and every company on
  this box shares the host. A bearer token that must reach `curl` goes into a 0600 `curl --config`
  file, never `-H`. `gh_token.sh` violated this until TOG-200; `test_gh_token_argv.sh` now asserts it
  from `/proc` rather than trusting the source to keep reading correctly.
- **`gh-app-token.js` must never fall through to a mint.** It emits a live credential; an earlier
  version minted a real org-admin token when invoked as `--help`. Unrecognised arguments are refused.
- **A catch-all arm refuses, and refusing means a non-zero exit.** `gh_token.sh` printed usage on
  *stdout* and exited **0** for any unrecognised subcommand until TOG-201, so
  `tok="$(gh_token.sh tokne)" && use "$tok"` proceeded with usage text in `$tok`. Usage errors now go
  to stderr with exit 2; only `help` / `--help` / `-h` succeed, and they answer *above* the
  credential preamble so asking a tool how to use it never requires the credentials it sets up.
  Pinned by `test_gh_token_dispatch.sh`, which asserts exit status and which stream — never wording.
- **Scope every mint, on BOTH axes.** `GH_APP_PERMISSIONS` / `GH_APP_REPOS`, with
  `GH_APP_SCOPE_STRICT=1` so an unscoped mint fails rather than silently returning a ceiling token.
  Strict mode requires both halves as of 2026-08-24 (TOG-238) — it used to accept either, so a
  permissions-only scope passed the check while still minting across every repo in the installation.
  Narrowing *what* a token may do is not a substitute for narrowing *where* it may do it. On the
  broker path the scope is derived server-side from the issue the caller holds, and a caller may
  only narrow it.
- **A safety gate must be keyed on the path taken, not the mode requested.** Strict mode gates the
  PEM, so gating it on `GH_APP_TOKEN_SOURCE === 'pem'` looks right and isn't: the default `auto`
  falls back to the PEM on a broker outage, which switched the gate off for the one path that mints
  a ceiling token. It is asserted where the signing key is actually used.
- **A cached token is only valid for a credential we still hold.** Keying the cache on the App ID
  alone meant unbinding `GH_APP_PRIVATE_KEY` revoked nothing — the agent kept authenticating from
  cache. Entries carry a fingerprint of what minted them, and nothing is written outside per-run
  scratch: every agent shares uid `node`, so `0600` in a shared tmpdir separates nothing.
- **A credential helper must fail loudly, not silently.** git discards a helper's exit status and
  falls through to its own prompt, so a failure has to emit `quit=1` or the last line the operator
  sees is git's unattributable `could not read Username`.
- **Back up before mutating, and verify the backup** — `gzip -t` plus a row count, not just exit 0.
- **Assert on exit status, not printed output.** A validator that printed `REFUSED` and exited 0
  shipped once; the tests now pin exit codes.

## Why this repo exists

Until 2026-08-23 all of this lived in one directory on one VPS with no version control, no review and
no CI — including a credential minter. The `--help` minting bug is exactly what a test suite catches.
This is also dogfooding: PaperclipAI agents maintain the tooling that runs PaperclipAI.
