# Blocker-ledger classes 4–7 adoption: one caller line per repo

Destination: this whole `blocker-classes47/` directory lands in
`TogetherWeOwn/.github` (each `*-gate.yml` at `.github/workflows/`, the
`blocker_*_checks.py` logic beside them, `ADOPTION.md` next to those).
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
  or a sibling `<same-stem>.down.sql`; the gate reads the PR diff, so both
  files must be in the change.

## Rollout: warn 24h, then required

1. Land the callers in `warn` (default). The workflows never fail the run
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
