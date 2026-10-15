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
SQL (`--` line and `/* */` block comments removed quote-aware, so prose
containing CONCURRENTLY/USING never masks code), USING checked per
ALTER COLUMN clause (top-level comma split, so one guarded clause never
masks an unguarded sibling). The down check accepts the
golang-migrate `<stem>.up.sql` / `<stem>.down.sql` pair, and deleted
files are never flagged (gate diffs with `--diff-filter=d`).
Down-section statements are not findings. Ack waives destructive-DDL only
after explicit human review.
Dialect: `postgres` (default) enforces CONCURRENTLY/USING;
`sqlite` (Cloudflare D1) skips them because SQLite rejects that syntax
(plain `CREATE INDEX` passes, destructive-DDL still reports). The gate
takes `dialect: postgres|sqlite` (default postgres) and auto-selects
sqlite when a wrangler config declares `d1_databases`.

## API contract (`blocker_api_contract_checks.py`)

Compares `docs/api-schema.json` (base vs head): removed endpoints, newly
required request fields, removed required response fields. Additive changes
pass. Without the schema file the gate skips — adopting the schema is a
follow-up, never a failure.

## Concurrency (`blocker_concurrency_checks.py`)

Flags workflow files that run migrations (`migrate`, `alembic upgrade`,
`migrations apply`, including `npx wrangler d1 migrations apply`) without
a serialising `concurrency:` group: a top-level `concurrency:` (column 0)
or a `concurrency:` block directly under the job key whose steps run the
migration (job-key indent + 2). A `concurrency:` on an unrelated job or a
`with:` step input does not satisfy the check. Isolated migration steps
followed by a separate seed step (seed outside the mutex) also report.
The gate parses each job's `steps:` via the lib `job_step_blocks`
(including `run: |` blocks) and runs the seed check per job. Single-step
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
proof: `python3 -B -m unittest test_blocker_migration_checks
test_blocker_api_contract_checks test_blocker_concurrency_checks
test_blocker_lockfile_checks test_blocker_classes47_org_template
test_blocker_classes47_round2_regression` (65 frozen + 22 regression)
plus YAML/JSON parse. Every `*-gate.yml` runs `python3 -I -` (PR-root
modules can never shadow stdlib); migration/lockfile gates diff with
`--diff-filter=d` (deleted paths never flagged).
