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
split, so one guarded clause never masks an unguarded sibling). The down
check accepts the golang-migrate `<stem>.up.sql` / `<stem>.down.sql`
pair, and deleted files are never flagged (gate diffs with
`--diff-filter=d`). The down check is postgres-only: D1 migrations are
forward-only, so `dialect="sqlite"` skips it.
Down-section statements are not findings. Ack waives destructive-DDL only
after explicit human review.
Dialect: `postgres` enforces CONCURRENTLY/USING; `sqlite` (Cloudflare D1)
skips CONCURRENTLY/USING and the down check because SQLite rejects that
syntax (plain `CREATE INDEX` passes, destructive-DDL still reports). The
gate takes `dialect: auto|postgres|sqlite` (default `auto`): explicit
`postgres`/`sqlite` always wins and any other value (including
`Postgres`) is rejected instead of falling back to auto; `auto` selects
sqlite only when a wrangler config read from the BASE commit (never the
PR checkout, so a PR-added `wrangler.toml` cannot flip the result)
declares `d1_databases` in uncommented code AND that D1 config's
`migrations_dir` (default `migrations`, resolved relative to the
config's own directory; quoted JSON keys and leading `./` accepted)
covers a changed migration path (tested `detect_migration_dialect`;
the required wrapper passes `dialect` through so mixed repos pin
`postgres`).

## API contract (`blocker_api_contract_checks.py`)

Compares `docs/api-schema.json` (base vs head): removed endpoints, newly
required request fields, removed required response fields. Additive changes
pass. Without the schema file the gate skips — adopting the schema is a
follow-up, never a failure.

## Concurrency (`blocker_concurrency_checks.py`)

Flags workflow files that run migrations (`migrate`, `alembic upgrade`,
`migrations apply`, including `npx wrangler d1 migrations apply`) without
a serialising `concurrency:` group: a top-level `concurrency:` (column 0)
or a `concurrency:` block directly under EACH job key whose steps run
migrations (direct-child indent derived from the block, so 2-space and
4-space workflows match; quoted job keys accepted). A `concurrency:` on a
non-migrating job or a `with:` step input does not satisfy the check, and
one serialised migrating job never covers a second migrating job without
its own group. "Migrating" is decided from step `run:` text only
(`job_step_blocks` + `step_runs_migrations` per job): a `needs: migrate`,
a job/step name, or a comment mentioning migrate never makes a
non-migrating job count as migrating. Isolated migration steps followed by a separate seed step
(seed outside the mutex) also report.
The gate parses each job's `steps:` via the lib `job_step_blocks`
(including `run: |` blocks and compact `- ` lists at the `steps:` indent)
and runs the seed check per job. Single-step migrate-and-seed passes.

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
proof: `python3 -B -m unittest test_blocker_migration_checks
test_blocker_api_contract_checks test_blocker_concurrency_checks
test_blocker_lockfile_checks test_blocker_classes47_org_template
test_blocker_classes47_round2_regression
test_blocker_classes47_round3_regression
test_blocker_classes47_round4_regression` (65 frozen + 22 + 27 + 17 regression)
plus YAML/JSON parse. Every `*-gate.yml` runs `python3 -I -` (PR-root
modules can never shadow stdlib); migration/lockfile gates diff with
`--diff-filter=d` (deleted paths never flagged).
