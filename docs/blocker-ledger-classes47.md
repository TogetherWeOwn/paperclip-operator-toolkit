# Blocker-ledger classes 4–7: deterministic pre-review gates

Four warn-first gates that run before any review model is involved. Logic
lives once at org level (`templates/org-github/blocker-classes47/`); this
repo holds thin callers (`.github/workflows/blocker-*.yml`). Never hand-edit
a staged copy: fix the repo-root module, then re-copy byte-identical.

## Migration (`blocker_migration_checks.py`)

Flags destructive DDL (`DROP TABLE/COLUMN`, `TRUNCATE`) without the
case-insensitive `safety: acknowledged` marker, `CREATE INDEX` without
`CONCURRENTLY`, `ALTER COLUMN .. TYPE` without `USING`, and `*.sql`
migrations with neither a `-- DOWN` marker nor a sibling down file.
Index/alter checks run per `;`-separated statement on comment-stripped
SQL (single-pass quote-aware removal of `--` line comments and
nesting-aware `/* */` blocks: `/*` inside a string literal is kept, so
seed rows with glob patterns never eat sibling statements; Postgres
nested comments are removed by depth; an unterminated block is kept
fail-closed), USING checked per ALTER COLUMN clause (top-level comma
split, so one guarded clause never masks an unguarded sibling).
`ALTER [COLUMN] .. TYPE` matches the TYPE keyword right after the column
identifier (`COLUMN` is optional, as are `IF EXISTS` / `SET DATA`). Each
action is anchored after the `ALTER TABLE` prefix, so a table or column
named `type` or a `'type'` default literal never reports. Only an exact
`-- down` marker line ends the up-section: a prose comment such as
`-- down-sizing ...` never hides later statements. The down
check accepts the golang-migrate `<stem>.up.sql` / `<stem>.down.sql`
pair, and deleted files are never flagged (gate diffs with
`--diff-filter=d`). The down check is postgres-only: D1 migrations are
forward-only, so `dialect="sqlite"` skips it.
Down-section statements are not findings. Ack waives destructive-DDL only
after explicit human review.
Dialect: `postgres` enforces CONCURRENTLY/USING; `sqlite` (Cloudflare D1)
skips CONCURRENTLY/USING and the down check because SQLite rejects that
syntax (plain `CREATE INDEX` passes, destructive-DDL still reports);
`postgres-transactional` (forward-only single-transaction Postgres
runner) skips CONCURRENTLY and the down check but keeps USING and
destructive-DDL. There is no per-file CONCURRENTLY skip:
`-- no-transaction` (sqlx: this file does NOT run in a transaction)
still requires CONCURRENTLY. The same-file `CREATE INDEX` exemption is
strict: full qualified name (a qualified side never matches an
unqualified side), never `TEMP`, never `IF NOT EXISTS`, never inside
string literals or `DO`/function bodies. The
gate takes `dialect: auto|postgres|sqlite|postgres-transactional`
(default `auto`): explicit `postgres`/`sqlite`/`postgres-transactional`
always wins and any other value (including
`Postgres`) is rejected instead of falling back to auto; `auto` selects
sqlite only when a wrangler config read from the BASE commit (never the
PR checkout, so a PR-added `wrangler.toml` cannot flip the result)
declares `d1_databases` in uncommented code AND that D1 config's
`migrations_dir` (per root or env-scoped D1 binding, default `migrations`,
resolved relative to the config's own directory with `..` normalised;
quoted TOML environment names, JSON keys and leading `./` accepted)
covers a changed `.sql` migration path (tested `detect_migration_dialect`;
only `.sql` paths count, so a README under a D1 directory never flips the
result). TOML uses stdlib `tomllib` (Python 3.11+). JSONC line/block comments
and trailing commas are removed outside double-quoted strings before
stdlib JSON parsing; apostrophes in comments cannot hide a binding.
All root and environment bindings are scanned independently. A legacy
scope-level `migrations_dir` fallback stays in that scope; otherwise each
binding keeps its own declared/default directory. Invalid configs retain
Postgres checks, never a guessed SQLite exemption. Only in `auto` does the
gate resolve the dialect per migration file (tested
`dialect_for_migration_path`); explicit pins govern both safety and down
checks for every file. The required wrapper falls back to
the `BLOCKER_MIGRATION_DIALECT` repo variable on `pull_request`
(where `workflow_call` inputs are empty), so mixed repos pin
`postgres` without hand-editing the wrapper.

## API contract (`blocker_api_contract_checks.py`)

Compares `docs/api-schema.json` (base vs head): removed endpoints, newly
required request fields, removed required response fields. Additive changes
pass. Without the schema file the gate skips — adopting the schema is a
follow-up, never a failure (the base-commit read is recorded before the
`{}` placeholder is written, so the skip branch stays reachable).

## Concurrency (`blocker_concurrency_checks.py`)

Flags workflow files that run migrations (whole command tokens:
`migrate`/`db:migrate`, `alembic upgrade`, `migrations apply`, including
`npx wrangler d1 migrations apply`; `cargo test`/`selftest`/`echo`/`git`
lines and `staging_migrate_db`/`unmigrated`/`migrated` prose never count)
without
a serialising `concurrency:` group: a top-level `concurrency:` (column 0)
or a `concurrency:` block directly under EACH job key whose steps run
migrations (direct-child indent derived from the block, so 2-space and
4-space workflows match; quoted job keys accepted). A `concurrency:` on a
non-migrating job or a `with:` step input does not satisfy the check, and
one serialised migrating job never covers a second migrating job without
its own group. "Migrating" is decided from step `run:`/`uses:`/`with:`
text (`job_step_blocks` + `step_runs_migrations` per job) plus a
job-level `uses:` (reusable-workflow calls have no `steps:`): a
wrangler-action `command: d1 migrations apply`, a `run-migrations`
composite, or a `migrate.yml` call counts, while a `needs: migrate`,
a job/step name, or a comment mentioning migrate never makes a
non-migrating job count as migrating. Isolated migration steps followed by a separate seed step
(seed outside the mutex) also report.
The gate parses each job's `steps:` via the lib `job_step_blocks`
(including literal/folded `run:` and `with:` blocks such as `command: |`,
`postCommands: >-`, or `script: |`, and compact `- ` lists at the `steps:`
indent). Scalar capture stops at its dedent, never consuming a sibling
input, step or job. The seed check runs per job; single-step
migrate-and-seed passes.

## Lockfile (`blocker_lockfile_checks.py`)

Flags changed manifests (`package.json`, `Cargo.toml`, `pyproject.toml`,
`go.mod`, `Gemfile`) with no accepted lockfile basename in the change or
the tree, and empty/corrupt lockfiles (content-free `package-lock.json`,
version-less `pnpm-lock.yaml`, package-less `Cargo.lock`). Presence, not
freshness: an already-vendored lockfile satisfies the gate even when the
manifest changes without it, and matching is by basename (any lockfile
anywhere satisfies any manifest). Stale-lockfile and directory-scoped
detection are follow-ups.

## Rollout

Warn mode default; enforce per gate after FP rate <5% over 20 PRs. Local
verification requires Python 3.11+ and PyYAML for delivered-workflow
acceptance (CI reuses its hash-pinned parser installation):
`python3 -B -m unittest test_blocker_migration_checks
test_blocker_api_contract_checks test_blocker_concurrency_checks
test_blocker_lockfile_checks test_blocker_classes47_org_template
test_blocker_classes47_round2_regression
test_blocker_classes47_round3_regression
test_blocker_classes47_round4_regression
test_blocker_classes47_round5_regression
test_blocker_classes47_review_acceptance
test_blocker_classes47_round6_regression
test_blocker_classes47_round7_regression`
plus YAML/JSON parse. The blind review-acceptance module exercises the
actual migration heredoc, missing-schema API skip and required-wrapper
mapping, not comments containing their names. Every `*-gate.yml` runs
`python3 -I -` (PR-root
modules can never shadow stdlib); migration/lockfile gates diff with
`--diff-filter=d` (deleted paths never flagged).
