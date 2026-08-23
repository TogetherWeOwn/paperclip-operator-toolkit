# paperclip-ops-tooling

Operator tooling for PaperclipAI companies on the `example.net` VPS.

**These are operator-run CLIs, not agent tools.** Agents cannot execute them: the `paperclip` container
mounts exactly one host path (`~/.local/share/paperclip -> /paperclip`), and none of this is on it.
Agents propose changes through `org_request_queue.sh`; the operator applies them.

## What is here

| Tool | Purpose | Suite |
|---|---|---|
| `org_provisioner.sh` | Constrained agent provisioning. Enforces the report §8.2 privilege invariants. | `test_privilege_ceilings.sh` |
| `org_request_queue.sh` | Approval-gated `org.request_descendant` / `org.review_request`. | `test_request_queue.sh` |
| `org_access_review.sh` | Standing least-privilege audit. Read-only, non-zero exit on findings — cron/CI-able. | — |
| `skills.sh` | Role-aware skill provisioning: who may author, who may equip whom. | — |
| `gh_token.sh` | GitHub App JWT + installation-token minting, with down-scoping. | — |
| `gh_access.sh` | Two-key GitHub eligibility policy. | — |
| `gh-app-token.js` | The in-container git credential helper. Asks `gh-token-broker` for a scoped token per git call; the local PEM is the fallback. | `test_gh_app_token.sh`, `test/gh-app-token.test.mjs` |
| `plugins/gh-token-broker` | Control-plane token broker. Resolves the App PEM host-side, so the signing key never enters an agent. | `plugins/gh-token-broker/test/` |
| `omniroute_combo_cli.sh` | Constrained OmniRoute combo/mapping manager. Deny-by-default Claude containment. | `selftest` subcommand |
| `ROLLBACK.md` | Rollback procedures (company bootstrap). |
| `GH-CREDENTIAL-CUTOVER.md` | Deploy/verify/rollback for the broker cutover, and the `GH_APP_PRIVATE_KEY` unbind sequence. |

## Running the suites

```bash
# Offline — no credentials, no network, no database. These are what CI runs.
./test_gh_app_token.sh
node --test test/gh-app-token.test.mjs   # pass the FILE, not the directory
./omniroute_combo_cli.sh selftest
(cd plugins/gh-token-broker && npm ci --include=dev --ignore-scripts && npm test)

# Operator-only — need COMPANY_ID and the live Postgres on the VPS.
export COMPANY_ID=<uuid>
./test_privilege_ceilings.sh
./test_request_queue.sh
./org_access_review.sh --allow-active   # 0 findings expected
```

**Pass/fail is the exit status, never a test count.** Counts drift as suites grow — this file
carried `104` for the omniroute selftest long after it had passed that — and a count baked into a
gate turns ordinary growth into a red build. Nothing in CI or in these docs asserts one.

`--allow-active` is required once any agent has `wakeOnDemand=true`; without it the review
reports each wakeable agent as a finding.

## Non-negotiables

These are load-bearing and were each learned by breaking something:

- **No secrets in this repo, ever.** Credentials live in `~/secure-drop/` at 0600 and are passed by
  inherited environment, never on `argv` — `/proc/*/cmdline` is world-readable and every company on
  this box shares the host.
- **`gh-app-token.js` must never fall through to a mint.** It emits a live credential; an earlier
  version minted a real org-admin token when invoked as `--help`. Unrecognised arguments are refused.
- **Scope every mint.** `GH_APP_PERMISSIONS` / `GH_APP_REPOS`, with `GH_APP_SCOPE_STRICT=1` so an
  unscoped mint fails rather than silently returning a ceiling token. On the broker path the scope
  is derived server-side from the issue the caller holds, and a caller may only narrow it.
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
