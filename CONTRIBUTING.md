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
