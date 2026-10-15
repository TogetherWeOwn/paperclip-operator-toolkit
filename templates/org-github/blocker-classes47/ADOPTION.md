# Blocker-ledger classes 4–7 adoption: one caller line per repo

Destination: this whole `blocker-classes47/` directory lands in
`TogetherWeOwn/.github` (each `*-gate.yml` at `.github/workflows/`, the
`blocker_*_checks.py` logic at repo-root `blocker-classes47/` — the gates
check out the org repo and import from `<checkout>/blocker-classes47`,
so logic beside the workflows would `ModuleNotFoundError` —
`ADOPTION.md` next to those).
Private reusable workflows are unreachable from public callers and private
repos have no Actions minutes, so the org `.github` repo — public — is the
only home that serves every repo.

## Caller snippets (copy-paste, one job per gate)

```yaml
jobs:
  migration:
    name: migration
    uses: TogetherWeOwn/.github/.github/workflows/blocker-migration-gate.yml@<pinned-sha>
    with:
      mode: warn # flip to enforce per gate once its FP rate is <5% over 20 PRs
    permissions:
      contents: read
  api-contract:
    name: api-contract
    uses: TogetherWeOwn/.github/.github/workflows/blocker-api-contract-gate.yml@<pinned-sha>
    with:
      mode: warn # flip to enforce per gate once its FP rate is <5% over 20 PRs
    permissions:
      contents: read
  concurrency:
    name: concurrency
    uses: TogetherWeOwn/.github/.github/workflows/blocker-concurrency-gate.yml@<pinned-sha>
    with:
      mode: warn # flip to enforce per gate once its FP rate is <5% over 20 PRs
    permissions:
      contents: read
  lockfile:
    name: lockfile
    uses: TogetherWeOwn/.github/.github/workflows/blocker-lockfile-gate.yml@<pinned-sha>
    with:
      mode: warn # flip to enforce per gate once its FP rate is <5% over 20 PRs
    permissions:
      contents: read
```

Migration logic requires Python 3.11+ for stdlib `tomllib`; the staged
`ubuntu-latest` runner supplies it. No third-party parser is needed by
the deployed gate. Local acceptance suites also need PyYAML (CI reuses
the hash-pinned static-label-guard installation).

Cross-repo `uses:` needs a pinned SHA, never a branch name. Replace
`<pinned-sha>` with the org adoption commit. `timeout-minutes` is rejected
on `uses:` jobs by GitHub schema — each gate sets its own per-job timeouts
internally.

## Single-context wiring

Each gate job keeps its bare gate name (`migration`, `api-contract`,
`concurrency`, `lockfile`) as its one check context: job `name` and id are
byte-identical so a future org ruleset can require the context directly.
Wire exactly these four contexts into the repo's required aggregator
(`needs:` list) — never wire an individual gate step. In `warn` mode the
jobs always pass; findings land in the step summary as `::warning::`
annotations.

## Repo-owned extension points (adopt to enable, never required to land)

- `docs/api-schema.json` — the wire schema for the api-contract gate:
  endpoint key `"METHOD /path"` mapping to `req_required` /
  `resp_required` field lists. Without it the api-contract gate reports its
  absence and skips. Additive changes (new endpoints, new response fields,
  fewer required request fields) pass; removals fail in enforce mode.
- Safety ack — a migration file containing `safety: acknowledged`
  (case-insensitive) waives destructive-DDL findings for that file after
  explicit human review. Non-concurrent `CREATE INDEX` and `USING`-less
  `ALTER COLUMN .. TYPE` still report.
- Down path — every changed `*.sql` migration carries a `-- DOWN` marker
  or a sibling down file (`<same-stem>.down.sql`, or the golang-migrate
  `<stem>.up.sql` / `<stem>.down.sql` pair); the gate diffs with
  `--diff-filter=d`, so deleted files are never flagged but both files of
  a pair must be in the change.
- Migration `dialect:` (`auto` default, explicit
  `postgres`|`sqlite`|`postgres-transactional` always wins, anything
  else rejected) — sqlite (Cloudflare D1) skips the CONCURRENTLY/USING
  checks SQLite rejects plus the down-path check (D1 is forward-only).
  `postgres-transactional` is a forward-only Postgres runner applying
  each file in one transaction: CONCURRENTLY (unrunnable inside a
  transaction) and the down-path check are skipped, USING and
  destructive-DDL still report. `auto` selects sqlite only when a
  wrangler config read from the BASE commit (a PR-added `wrangler.toml`
  cannot flip the result) declares `d1_databases` in uncommented code
  AND that D1 config's `migrations_dir` (per root/env binding,
  config-relative, `..` normalised; quoted TOML env names, JSON keys and
  `./` accepted) covers a changed `.sql` migration path (tested
  `detect_migration_dialect`; non-SQL files never flip the result).
  JSONC comments/trailing commas are parsed without treating comment
  apostrophes as quotes. Invalid configs keep Postgres checks. Only
  `auto` resolves dialect per migration file (tested
  `dialect_for_migration_path`); explicit pins apply to safety and
  down-path checks alike. Mixed repos pin `dialect: postgres` with the
  `BLOCKER_MIGRATION_DIALECT` repo variable (the required wrapper falls
  back to it on `pull_request`, where `workflow_call` inputs are empty);
  an explicit caller `with:` still wins when present.
- Migration per-file carve-outs (plain `postgres` only): a `CREATE INDEX`
  on a table created at top level in the same up-section never reports
  (brand-new persistent table, no concurrent writers, including the
  idempotent `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`
  pair) — the match is strict (full qualified name, never `TEMP`,
  never inside string literals or `DO`/function bodies, never a
  statement-opening `EXECUTE`); a file
  carrying `-- forward-only` (or `forward-only: acknowledged`) skips the
  down-path check for that file. There is deliberately no per-file
  CONCURRENTLY skip: `-- no-transaction` (sqlx: this file does NOT run
  in a transaction) is exactly where CONCURRENTLY works, so it still
  requires it — transactional runners pin `postgres-transactional`
  instead. `ALTER ... TYPE` inside `DO $$`, function bodies, and
  `EXECUTE '...'` strings still reports (searched, not start-anchored).
- Concurrency callers are never self-flagging: the gate's own
  `blocker-*-gate.yml` refs never count as migrating, and only
  command-carrying `with:` inputs (`command`/`args`/`run`/`script`/
  `preCommands`/`postCommands`/`entrypoint`) are scanned — `ref`/`name`/
  cache-`key` values mentioning `migrate` do not make a job migrating.
  Step `run:` text matches path/word segments only (`migrate`,
  `migrate-prod`, `db-migrate`, `migrate_db`, `alembic upgrade`,
  `migrations apply`): chained `&&`/`||`/`;`/`|` segments are judged
  alone, so `git pull && npm run migrate` flags, while `cargo test`,
  `selftest`, `echo`, and `git` segments and `unmigrated` / `migrated`
  prose never flag.
- Lockfile recognised sets (presence, not freshness): npm accepts
  `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`,
  `npm-shrinkwrap.json`, `bun.lock`, `bun.lockb`; Python accepts
  `poetry.lock`, `pdm.lock`, `uv.lock`, `Pipfile.lock`,
  `requirements.txt` and `requirements-*.txt`. A `pyproject.toml` with
  no dependency table (`[project]`, `[tool.poetry]`, `[tool.pdm]`,
  `[tool.uv]`) is tool config, not a manifest; a library crate
  (`src/lib.rs` without `src/main.rs`) never reports. A manifest
  containing `lockfile: none` or listed in `ignore_manifests` opts out.

## Rollout: adopt, activate, warn 24h, then required

0. The repo callers land inert (`workflow_dispatch` only): the org
   reusable does not exist until step 1, and an unresolvable `uses:`
   fails the run at parse time (`continue-on-error` cannot help).
1. Adoption follow-up (one Operator PR to `TogetherWeOwn/.github`):
   land this directory (gates at `.github/workflows/`, logic at
   repo-root `blocker-classes47/`), repin every caller and gate `ref:`
   to the adoption commit, and flip the repo callers to `pull_request`
   + `merge_group` in `warn` (default). The workflows never fail the run
   for their own findings.
2. After 24h, read the step summaries across PRs. A gate whose
   false-positive rate over the last 20 PRs measures under 5% flips to
   `mode: enforce` (whole gate first).
3. The org ruleset (`../rulesets/blocker-classes47-*.json`) requires the
   four contexts on every active repo, so the gates ride the existing
   required checks — no branch-protection edit per repo.

## Per-repo adoption checklist (one PR per repo)

- [ ] Caller jobs added with pinned SHA, `mode: warn`
- [ ] The four gate contexts in the repo's required-aggregator `needs:` list
- [ ] No `paths:`/`paths-ignore:` on the caller workflow
- [ ] `docs/api-schema.json` added when the repo has a wire API
- [ ] After 24h green: flip to enforce on measured evidence, then confirm
      the org ruleset shows the repo compliant
