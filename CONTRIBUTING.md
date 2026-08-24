# Contributing

This repo holds operator tooling that mints live credentials and provisions real agents against a
production company. Until 2026-08-23 it lived in one directory on one VPS with no version control,
no review and no CI. Everything below exists because something here already went wrong once.

## The non-negotiables

These are restated from [README.md](README.md). They are not style preferences; each was learned by
breaking something.

- **No secrets in this repo, ever.** Credentials live in `~/secure-drop/` at `0600` and are passed by
  inherited environment, never on `argv` — `/proc/*/cmdline` is world-readable and every company on
  this box shares the host. CI scans every tracked file for token-shaped strings and private key
  material, and asserts that `.gitignore` still covers `*.env`, `*.pem`, `*.key`, `*.jsonl` and
  `.gh-app-token.json`.
- **`gh-app-token.js` must never fall through to a mint.** An earlier version printed a real
  org-admin-capable installation token when invoked as `--help`. `test_gh_app_token.sh` now fails if
  any unrecognised argument produces anything token-shaped.
- **Scope every mint, on BOTH axes.** `GH_APP_PERMISSIONS` / `GH_APP_REPOS`, with
  `GH_APP_SCOPE_STRICT=1` — which requires both halves, not either one (TOG-238). If you touch
  `currentScope()`, re-run the mutation check in `test_gh_app_token.sh` §6: restore the old
  `Object.keys(scope).length > 0` condition and confirm the suite goes red. A strict-mode test that
  stays green against that mutation is asserting nothing.
- **Back up before mutating, and verify the backup** — `gzip -t` plus a row count, not just exit 0.
- **Assert on exit status, not printed output.** A validator that printed `REFUSED` and exited 0
  shipped once. Tests pin exit codes; they must not pin human-readable message text, which drifts.

## Branch and review

Work on a branch, open a pull request, never push to `main`.

This is a private repo on the free plan, so **branch protection is unavailable**. Nothing on GitHub
will stop a direct push to `main` or a self-merge. The discipline has to come from the process. That
is a deliberate, recorded trade-off, not an oversight — if the plan changes, turn on branch
protection and delete this paragraph.

Keep changes narrow enough to review. A test-only change that also fixes three unrelated things is
unreviewable; **if you find a bug while doing something else, file it rather than fixing it inline.**

## Running the suites

The suites below run anywhere and are what CI runs. Exactly two more need the VPS.

```bash
# Offline — no credentials, no network, no database. These are what CI runs.
./test_gh_app_token.sh              # credential-minter regression suite
./test_gh_token_argv.sh             # gh_token.sh: no credential on argv
./test_gh_token_dispatch.sh         # gh_token.sh: unknown subcommands refuse, non-zero
./omniroute_combo_cli.sh selftest   # containment logic, fixture catalogue
./test_responsible_leader.sh        # who may approve a provisioning request
./test_sql_backend.sh               # lib/pcsql.sh dispatch, against fake podman/psql
./test_tool_drift.sh                # tool_drift.sh: running-vs-reviewed detection
for f in *.sh lib/*.sh; do bash -n "$f"; done && for f in *.js; do node --check "$f"; done

# Operator-only — need COMPANY_ID and the live Postgres via `podman exec paperclip-db`.
# They create and delete real agents in that company as their method, so run them
# on the VPS, before a release, and read the teardown output.
export COMPANY_ID=<uuid>
./test_privilege_ceilings.sh
./test_request_queue.sh
./org_access_review.sh --allow-active   # 0 findings expected
```

**Gate on exit status, never on a test count.** Counts drift as suites grow, and three places in
this repo used to quote three different numbers for the same omniroute selftest. A count in a gate
turns ordinary growth into a red build; a count in prose is just wrong a month later. Neither the
docs nor CI assert one — if you add a suite, do not start.

## Is the copy that runs the copy that is reviewed?

Everything above tests what is *in this repo*. None of it tests whether that is what is actually
running on the VPS, and the import that created this repo was a snapshot — a snapshot is only the
source of truth until somebody edits the other copy.

TOG-212 is the first case, and it taught something sharper than "the VPS drifted". The omniroute
selftest reported 114 assertions here against 156 quoted elsewhere — later 181. The divergence was
real, and the reviewed copy was not the one containing Claude routing. But the larger copy was never
on the VPS. It was `/paperclip/operator-handoff/TOG-151-omniroute_combo_cli.sh` — v0.2.5, written by
an agent as a *proposal* into the outbound handoff channel, and never landed in git until the import
this paragraph documents.

So drift has two directions here, not one, and the second is the one actually happening:

- **Inbound** — somebody edits the running copy and the repo falls behind. This is the case the
  tooling was built for. Measured 2026-08-24 it had not yet occurred: the one genuinely
  operator-placed file in the channel, `REFERENCE-org_provisioner.sh` (root-owned, unlike every
  agent-authored drop), was *behind* `main`, not ahead — the import took, and the repo then improved
  on it.
- **Outbound** — an agent writes a newer tool into the handoff channel, the operator installs it
  from there, and nobody reviews it because it never becomes a PR. Measured the same day,
  **9 of the 11 executables in that channel existed in no git repo at all.**

Read the drop channel's own `README.md` before treating anything in it as evidence of what runs:
"Writing here is a proposal, not a deployment." A file there is an agent's outbound claim, not a
reading of the VPS. Ownership tells you the direction: root-owned is the operator's, `node`-owned is
an agent's.

The 114-vs-156 gap was noticed by eye, from a number a human happened to quote in a different issue.
That is not a detection mechanism.

`tool_drift.sh` is. Run this whenever you have shell on the VPS, and before any release:

```bash
# 1. On the VPS, in the directory the tools actually run from.
#    Needs bash + coreutils only — no git, no clone, no network, no credential.
./tool_drift.sh fingerprint > /tmp/vps.fp

# 2. Bring /tmp/vps.fp to a clone, and compare against the ref you believe in.
./tool_drift.sh compare /tmp/vps.fp --ref main
```

Exit `0` no drift · `2` refused · `3` drift found. It reports three things, and the middle one is
the one that should stop you: **DRIFT** (same path, different content), **UNVERSIONED** (a tool at
the source that was never imported at all), and **NOT DEPLOYED** (informational — the VPS has no
reason to hold every test file; `--strict` makes it count).

Two design points, both deliberate and both worth keeping:

- **It compares content, not counts or sizes.** A count collides and drifts innocently, which is
  precisely why 114-vs-156 sat unnoticed. The fingerprint is the git blob hash, computed with
  `sha1sum` so the VPS side needs no git, and the CI mutation gate fails if anyone "simplifies" it
  back into a size check.
- **There is no committed manifest of expected hashes.** `compare` reads the ref directly. A
  committed manifest would be stale the first time anyone landed a PR, and a drift detector that
  cries wolf gets muted — at which point it is indistinguishable from a deleted one.

**CI cannot run the actual comparison** and never will: the thing to compare against is a directory
no runner can reach. A green badge means the detector works, not that there is no drift. Only
running step 1 on the VPS answers that.

`test_responsible_leader.sh` needs `jq` and nothing else. It fabricates the whole world it tests:
a TSV org fixture read through the `ORG_SNAPSHOT` seam instead of the database, and a stub
provisioner injected through `PROV`. The stub *extracts* the delegation ceiling from
`org_provisioner.sh` rather than carrying a copy, so a ceiling change cannot leave the suite green
against a stale fixture. Both seams are load-bearing — removing either takes the only CI coverage of
the authorization logic with it.

`test_gh_app_token.sh` needs `node` and nothing else. It fabricates its whole credential environment:
a throwaway RSA key generated per run, a stub GitHub API on `127.0.0.1`, and token-shaped canaries
that are not real tokens. It invokes the tool under `env -i`, so a live `GH_APP_PRIVATE_KEY` exported
in your shell cannot leak into a test run. Nothing it writes leaves `mktemp -d`.

`test_sql_backend.sh` needs `bash` and nothing else. It tests a dispatcher — which command
`lib/pcsql.sh` builds, and what lands on that command's `argv` — so it puts *recording fakes* for
`podman` and `psql` on `PATH` rather than requiring either. Fake, do not skip: a suite that skips
the psql path when `psql` is absent passes on every runner in the world while that path is broken.
Both fakes are always present, so both backends always execute.

If you touch `lib/pcsql.sh`, the two mutations CI runs against it are the ones to keep working:
passing `$DATABASE_URL` to `psql` instead of decomposing it into `PG*` (which publishes the database
password through `/proc/*/cmdline`), and auto-selecting the psql backend whenever `DATABASE_URL`
happens to be set (which silently retargets the provisioner). Both are things a reasonable person
would write. Neither may go green.

## What "done" means for a change to a credential-handling tool

`gh-app-token.js`, `gh_token.sh`, `gh_access.sh` and anything else that touches a secret. Meeting
"the tests pass" is necessary and not sufficient.

1. **The default is refusal.** Any input the tool does not explicitly recognise must be refused with
   a non-zero exit. Never let an unhandled case reach the code that emits a credential — that is the
   exact shape of the 2026-08-23 bug, and it was one missing `if`.
2. **A new argument means a new test.** Adding a mode, flag or verb without adding a case to
   `test_gh_app_token.sh` is not done. The fuzz section covers arguments nobody anticipated; it does
   not cover a real mode you forgot to constrain.
3. **The test must be able to fail.** Prove it by reintroducing the bug in a *throwaway copy* and
   watching the suite go red. CI does this on every run — see the last step of
   `.github/workflows/ci.yml`. A green suite that cannot fail is worse than no suite, because it is
   believed.
4. **Assert on shape and on behaviour, not on prose.** Match the credential *pattern*, and assert the
   tool did not even *request* one from the API. Both survive rewording; a `grep "Refusing"` does not.
5. **No credential on `argv`, and none in a log.** Check what you pass to `curl`, what you `echo`,
   and what ends up in an error path. `omniroute_combo_cli.sh` writes its `Authorization` header into
   a `curl --config` file for this reason — copy that pattern rather than inventing another.
6. **Test without credentials.** If a change can only be tested against real GitHub, it is not
   testable and it will stop being tested. The seams that make this possible today are `GH_API_URL`
   and `GH_APP_TOKEN_CACHE`; they are load-bearing for the suite, so removing either breaks CI on
   purpose.
7. **State the blast radius in the PR.** If a token could be minted, printed, cached or widened by
   the change, say so explicitly. If a credential was exposed at any point while developing, revoke
   it first, confirm the revocation (`DELETE /installation/token`, then prove reuse returns 401), and
   record that in the PR.
8. **Keep CI honest.** If you add a suite CI cannot run, say so in `.github/workflows/ci.yml` and say
   why. Silently narrowing what CI covers, while the badge stays green, is the failure this repo was
   created to prevent.
