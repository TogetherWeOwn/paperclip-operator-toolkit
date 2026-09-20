export const REFRESH_SCORE_RUNS_SQL = `select usage_json->>'model' as model,
       status as status,
       coalesce(context_snapshot->>'issueId','') as issue_id,
       coalesce(error_code,'') as error_code,
       left(coalesce(error,''),200) as error,
       coalesce(usage_json->>'costUsd','') as cost_usd,
       extract(epoch from (finished_at - started_at))/60.0 as mins,
       extract(epoch from (now() - created_at))/86400.0 as age_days
  from heartbeat_runs
 where company_id = $1
   and created_at > now() - ($2 || ' days')::interval
   and usage_json ? 'model'
   and status in ('succeeded','failed','timed_out')
   and usage_json->>'model' not in ('unknown','auto/best-coding')
   and finished_at is not null`;

/**
 * TOG-2862. The most recent heartbeat run's context usage for ONE issue.
 *
 * Deliberately two index-matching branches rather than the single
 * `coalesce(context_snapshot->>'issueId', context_snapshot->>'taskId') = $2`
 * predicate this replaced. `heartbeat_runs` carries three *separate*
 * expression indexes — `(company_id, (context_snapshot->>'issueId'),
 * created_at DESC)` and the matching `'taskId'`/`'taskKey'` pair
 * (`test/fixtures/orgdb/schema.sql`). A `coalesce(...)` over two of those
 * expressions is a fourth expression that no index covers, so Postgres fell
 * back to a sequential scan of the whole company's run history — once per
 * scanned candidate, which is what walked `balancePass` into the host's
 * 300 s RPC wall on a fresh install with no hand-made index.
 *
 * Each branch below is a bare indexed expression with the same leading
 * `company_id` and the same `created_at desc` ordering, so each is an
 * index-only descending scan stopping at the first row. The outer query then
 * picks the newer of (at most) two rows.
 *
 * The `usage_json ? ...` filter stays *inside* each branch: it is not in the
 * index, so it is applied as a recheck while walking the issue's own runs
 * newest-first — bounded by that issue's run count, never by the company's.
 *
 * Keep both branches alias-free. A dotted reference immediately after a
 * `from`/`join` token — including the `from` inside `extract(epoch from
 * r.created_at)` — is read by the host's namespace guard as a schema
 * qualifier and rejected with `cannot read schema "r"`.
 *
 * The `context_snapshot->>'issueId' is null` guard on the SECOND branch is
 * what keeps this equivalent to the `coalesce(...)` it replaced, and is not
 * optional. `coalesce` gives a non-null `issueId` *precedence*: a run stamped
 * `{issueId: "A", taskId: "B"}` is attributed to A only, and is invisible to a
 * lookup of B. Splitting the coalesce into two independent branches loses that
 * precedence — the bare `taskId` branch would also match that run when looking
 * up B, so one run could be attributed to two different cards and a card could
 * inherit another card's context estimate. `context_snapshot` is unconstrained
 * JSONB, so nothing in the schema forbids the mismatched pair. The guard
 * re-imposes the precedence; `tests/context-lookup.spec.ts` proves branch-wise
 * equivalence to `coalesce` over the full null/match/mismatch truth table and
 * carries the unguarded form as its positive control.
 */
export const LAST_RUN_CONTEXT_USAGE_SQL = `select input_tokens, cached_input_tokens
  from ((select (usage_json->>'inputTokens')::numeric as input_tokens,
                (usage_json->>'cachedInputTokens')::numeric as cached_input_tokens,
                created_at as created_at
           from heartbeat_runs
          where company_id = $1
            and context_snapshot->>'issueId' = $2
            and (usage_json ? 'inputTokens' or usage_json ? 'cachedInputTokens')
          order by created_at desc
          limit 1)
        union all
        (select (usage_json->>'inputTokens')::numeric as input_tokens,
                (usage_json->>'cachedInputTokens')::numeric as cached_input_tokens,
                created_at as created_at
           from heartbeat_runs
          where company_id = $1
            and context_snapshot->>'taskId' = $2
            and context_snapshot->>'issueId' is null
            and (usage_json ? 'inputTokens' or usage_json ? 'cachedInputTokens')
          order by created_at desc
          limit 1)) matches
 order by created_at desc
 limit 1`;

/**
 * The indexed `heartbeat_runs` context expressions, as the schema declares
 * them. `tests/context-lookup.spec.ts` asserts every `heartbeat_runs`
 * predicate in {@link LAST_RUN_CONTEXT_USAGE_SQL} is one of these, so a future
 * edit that reintroduces an unindexed expression fails the suite instead of
 * the production database.
 */
export const INDEXED_RUN_CONTEXT_EXPRESSIONS = [
  "context_snapshot->>'issueId'",
  "context_snapshot->>'taskId'",
  "context_snapshot->>'taskKey'",
] as const;

export const REFRESH_SCORE_CLOSING_RUNS_SQL = `select coalesce(context_snapshot->>'issueId','') as issue_id,
       usage_json->>'model' as model,
       coalesce(agent_id::text,'') as agent_id,
       coalesce(usage_json->>'costUsd','') as cost_usd,
       extract(epoch from finished_at) * 1000 as finished_at_ms
  from heartbeat_runs
 where company_id = $1
   and status = 'succeeded'
   and finished_at > now() - ($2 || ' days')::interval
   and usage_json ? 'model'`;

/**
 * TOG-3132: per-model run outcomes, the input to the lane-evidence term.
 * Aggregated to lanes in `worker.ts`, because the model -> lane map lives in
 * config and not in the database.
 *
 * `succeeded` is the success value — `completed` does not exist on this table.
 *
 * `cancelled` and `interrupted` are deliberately NOT counted as failures: they
 * are fleet or operator actions, not a lane refusing to serve, and counting
 * them would let one busy deploy window mark every lane dead. Measured
 * 2026-09-17, no row in either status carries `usage_json ? 'model'` anyway.
 *
 * Alias-free on purpose: the host rejects a dotted reference after `from` as a
 * cross-schema read (`tests/sql-guard.spec.ts`, the v0.3.1 failure).
 */
export const LANE_EVIDENCE_RUNS_SQL = `select usage_json->>'model' as model,
       count(*) filter (where status = 'succeeded')::int as succeeded,
       count(*) filter (where status in ('failed','timed_out'))::int as failed
  from heartbeat_runs
 where company_id = $1
   and created_at > now() - ($2 || ' hours')::interval
   and usage_json ? 'model'
 group by 1`;
