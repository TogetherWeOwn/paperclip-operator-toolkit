import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { INDEXED_RUN_CONTEXT_EXPRESSIONS, LAST_RUN_CONTEXT_USAGE_SQL } from "../src/sql.js";

/**
 * Regression gate for the `balancePass` RPC-wall timeout.
 *
 * The defect was not a slow query in the abstract: it was a predicate —
 * `coalesce(context_snapshot->>'issueId', context_snapshot->>'taskId') = $2` —
 * that no `heartbeat_runs` index covers, executed once per scanned candidate.
 * On a fresh install with no hand-made expression index that is a sequential
 * scan of the company's entire run history, and the pass never finished inside
 * the host's 300 s wall.
 *
 * This gate is deliberately anchored on the REAL schema rather than on a
 * constant in this package: it reads `test/fixtures/orgdb/schema.sql`, derives
 * which `context_snapshot` expressions actually have an index, and asserts
 * every predicate in the shipped query is one of them. If someone drops the
 * index, or reintroduces a wrapped expression, this fails here instead of in
 * production.
 */
const SCHEMA_PATH = new URL("../../../test/fixtures/orgdb/schema.sql", import.meta.url);

/** Whitespace is not semantic in SQL; compare expressions with it removed. */
function canon(expression: string): string {
  return expression.replace(/\s+/g, "");
}

/**
 * The `context_snapshot` expressions carrying a `heartbeat_runs` index, read
 * out of the schema itself.
 */
function indexedContextExpressionsFromSchema(): string[] {
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  const found = new Set<string>();
  for (const index of schema.matchAll(/CREATE\s+INDEX\s+\w+\s+ON\s+heartbeat_runs\s*\(([\s\S]*?)\);/gi)) {
    for (const expression of index[1]!.matchAll(/context_snapshot\s*->>\s*'([A-Za-z0-9_]+)'/g)) {
      found.add(canon(`context_snapshot->>'${expression[1]!}'`));
    }
  }
  return [...found].sort();
}

/**
 * Every conjunct of a WHERE clause that mentions `context_snapshot`, reduced to
 * the expression on the left of its comparison. A predicate is index-matching
 * only if that expression is *exactly* an indexed one — wrapping it in
 * `coalesce(...)`, `lower(...)` or a cast produces a different expression that
 * the planner cannot match to the index, which is precisely the regression.
 */
function contextPredicateExpressions(sql: string): string[] {
  const expressions: string[] = [];
  for (const clause of sql.split(/\band\b/i)) {
    if (!/context_snapshot/.test(clause)) continue;
    const comparison = clause.split(/(?:=|<>|!=|\bis\b|\bin\b)/i)[0]!;
    expressions.push(canon(comparison.replace(/^[\s(]+/, "")));
  }
  return expressions;
}

describe("Last-run context lookup is index-matching", () => {
  const indexed = indexedContextExpressionsFromSchema();

  it("finds the schema's indexed context expressions", () => {
    // Guards the gate itself: a parse that silently matched nothing would make
    // every assertion below vacuously true.
    expect(indexed).toEqual([
      canon("context_snapshot->>'issueId'"),
      canon("context_snapshot->>'taskId'"),
      canon("context_snapshot->>'taskKey'"),
    ]);
  });

  it("keeps the exported expression list in step with the schema", () => {
    expect(INDEXED_RUN_CONTEXT_EXPRESSIONS.map(canon).sort()).toEqual(indexed);
  });

  it("filters heartbeat_runs only on indexed context expressions", () => {
    const predicates = contextPredicateExpressions(LAST_RUN_CONTEXT_USAGE_SQL);
    // Non-vacuity: the query must actually filter on the context at all.
    expect(predicates.length).toBeGreaterThan(0);
    for (const predicate of predicates) {
      expect(indexed).toContain(predicate);
    }
  });

  it("covers both the issueId and the taskId index", () => {
    // A run records the card under either key depending on its entry point;
    // dropping a branch would silently lose half the estimates.
    const predicates = contextPredicateExpressions(LAST_RUN_CONTEXT_USAGE_SQL);
    expect(predicates).toContain(canon("context_snapshot->>'issueId'"));
    expect(predicates).toContain(canon("context_snapshot->>'taskId'"));
  });

  it("orders each branch on created_at desc and takes one row", () => {
    // Without the per-branch `order by ... limit 1` the index scan cannot stop
    // early, and the branch degrades to reading every run for the issue.
    const branches = LAST_RUN_CONTEXT_USAGE_SQL.match(/order\s+by\s+created_at\s+desc\s+limit\s+1/gi) ?? [];
    expect(branches).toHaveLength(3); // two index branches + the outer pick
  });

  // Positive control. A gate that only ever sees a passing input proves
  // nothing — this asserts the SAME extractor rejects the exact predicate that
  // caused the incident.
  it("rejects the v0.3.1 coalesce predicate that caused the timeout", () => {
    const regressed = `select 1 from heartbeat_runs
       where company_id = $1
         and coalesce(context_snapshot->>'issueId', context_snapshot->>'taskId') = $2`;
    const predicates = contextPredicateExpressions(regressed);
    expect(predicates).toHaveLength(1);
    expect(indexed).not.toContain(predicates[0]);
  });
});

/**
 * Review blocker: making the query index-matching must not change
 * WHICH run it attributes to a card.
 *
 * `coalesce(issueId, taskId) = $2` gives a non-null `issueId` precedence — a
 * run stamped `{issueId: "A", taskId: "B"}` belongs to A and is invisible to a
 * lookup of B. Two independent UNION branches lose that precedence unless the
 * task branch is guarded with `issueId is null`, and `context_snapshot` is
 * unconstrained JSONB so nothing stops a mismatched pair from existing.
 *
 * There is no Postgres in this suite, so rather than assert the guard's
 * presence as a string — which would pass for a guard on the wrong column, or
 * in the wrong branch — this derives each branch's conditions FROM the shipped
 * SQL and evaluates them against synthetic rows, comparing branch-by-branch to
 * `coalesce` over the whole truth table.
 */
type ContextRow = { issueId: string | null; taskId: string | null };
type Condition = { key: keyof ContextRow; kind: "eq" | "isNull" };

/** Each UNION branch's `context_snapshot` conditions, read out of the SQL. */
function branchConditions(sql: string): Condition[][] {
  return sql.split(/\bunion\s+all\b/i).map((branch) => {
    const conditions: Condition[] = [];
    for (const match of branch.matchAll(/context_snapshot\s*->>\s*'(\w+)'\s*(=\s*\$2|is\s+null)/gi)) {
      conditions.push({
        key: match[1] as keyof ContextRow,
        kind: /is\s+null/i.test(match[2]!) ? "isNull" : "eq",
      });
    }
    return conditions;
  });
}

/** Does any branch match this row when looking up `param`? */
function matchesBranches(branches: Condition[][], row: ContextRow, param: string): boolean {
  return branches.some((conditions) =>
    conditions.length > 0 &&
    conditions.every((condition) =>
      condition.kind === "isNull" ? row[condition.key] === null : row[condition.key] === param,
    ),
  );
}

/** The semantics the UNION replaced. */
function matchesCoalesce(row: ContextRow, param: string): boolean {
  return (row.issueId ?? row.taskId) === param;
}

const IDS: Array<string | null> = [null, "A", "B"];
const TRUTH_TABLE: Array<{ row: ContextRow; param: string }> = IDS.flatMap((issueId) =>
  IDS.flatMap((taskId) => ["A", "B"].map((param) => ({ row: { issueId, taskId }, param }))),
);

describe("The index-matching rewrite preserves coalesce attribution", () => {
  const branches = branchConditions(LAST_RUN_CONTEXT_USAGE_SQL);

  it("parses two guarded branches out of the shipped SQL", () => {
    // Non-vacuity: an empty parse would make every row below match nothing and
    // agree with nothing, so the equivalence test would pass while proving it.
    expect(branches).toHaveLength(2);
    expect(branches[0]).toEqual([{ key: "issueId", kind: "eq" }]);
    expect(branches[1]).toEqual([
      { key: "taskId", kind: "eq" },
      { key: "issueId", kind: "isNull" },
    ]);
  });

  it("agrees with coalesce on every null/match/mismatch combination", () => {
    expect(TRUTH_TABLE).toHaveLength(18);
    for (const { row, param } of TRUTH_TABLE) {
      expect({ row, param, matched: matchesBranches(branches, row, param) }).toEqual({
        row,
        param,
        matched: matchesCoalesce(row, param),
      });
    }
  });

  it("does not attribute a run to the taskId card when it carries another issueId", () => {
    // The specific mismatched pair from the review: one run must never be
    // attributed to two different cards.
    const row: ContextRow = { issueId: "A", taskId: "B" };
    expect(matchesBranches(branches, row, "A")).toBe(true);
    expect(matchesBranches(branches, row, "B")).toBe(false);
  });

  // Positive control: the unguarded form this replaced must FAIL the above.
  it("catches the unguarded task branch that reviewed as a semantics change", () => {
    const unguarded = branchConditions(
      LAST_RUN_CONTEXT_USAGE_SQL.replace(/\s*and\s+context_snapshot\s*->>\s*'issueId'\s+is\s+null/i, ""),
    );
    expect(unguarded[1]).toEqual([{ key: "taskId", kind: "eq" }]);
    expect(matchesBranches(unguarded, { issueId: "A", taskId: "B" }, "B")).toBe(true);
    expect(
      TRUTH_TABLE.some(({ row, param }) => matchesBranches(unguarded, row, param) !== matchesCoalesce(row, param)),
    ).toBe(true);
  });
});
