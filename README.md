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
| `gh-app-token.js` | The in-container git credential helper. Mints a fresh scoped token per git call. | `test_gh_app_token.sh` |
| `omniroute_combo_cli.sh` | Constrained OmniRoute combo/mapping manager. Deny-by-default Claude containment. | `selftest` subcommand |
| `gh-event-capture/` | Self-hosted GitHub webhook store — the partial stand-in for the org audit log GitHub Free does not provide. **Read its README § 1 before relying on it: it is a monitoring aid, not evidence.** | `npm test`, `test/test_scripts.sh` |
| `ROLLBACK.md` | Rollback procedures. |

## Running the suites

```bash
# Offline — no credentials, no network, no database. These are what CI runs.
./test_gh_app_token.sh
./omniroute_combo_cli.sh selftest

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
  unscoped mint fails rather than silently returning a ceiling token.
- **Back up before mutating, and verify the backup** — `gzip -t` plus a row count, not just exit 0.
- **Assert on exit status, not printed output.** A validator that printed `REFUSED` and exited 0
  shipped once; the tests now pin exit codes.

## Why this repo exists

Until 2026-08-23 all of this lived in one directory on one VPS with no version control, no review and
no CI — including a credential minter. The `--help` minting bug is exactly what a test suite catches.
This is also dogfooding: PaperclipAI agents maintain the tooling that runs PaperclipAI.
