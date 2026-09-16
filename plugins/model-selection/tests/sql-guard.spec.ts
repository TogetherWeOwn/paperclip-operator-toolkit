import { describe, expect, it } from "vitest";

import { LAST_RUN_CONTEXT_USAGE_SQL, REFRESH_SCORE_CLOSING_RUNS_SQL, REFRESH_SCORE_RUNS_SQL } from "../src/sql.js";

type SqlRef = { schema: string; table: string; keyword: string };

function extractQualifiedRefs(statement: string): SqlRef[] {
  const refs: SqlRef[] = [];
  const pattern = /\b(from|join|references|into|update)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi;
  for (const match of statement.matchAll(pattern)) {
    refs.push({ keyword: match[1]!.toLowerCase(), schema: match[2]!, table: match[3]! });
  }
  return refs;
}

function validateLikeHost(query: string, namespace: string): void {
  for (const ref of extractQualifiedRefs(query)) {
    if (ref.schema === namespace || ref.schema === "public") continue;
    throw new Error(`ctx.db.query cannot read schema "${ref.schema}"`);
  }
}

describe("scheduled SQL namespace guard", () => {
  it.each([
    ["score runs", REFRESH_SCORE_RUNS_SQL],
    ["closing runs", REFRESH_SCORE_CLOSING_RUNS_SQL],
    // TOG-2862: the union'd context lookup must clear the same guard. Its two
    // branches are alias-free precisely so no dotted reference can follow a
    // `from`/`join` token and be mistaken for a schema qualifier.
    ["last-run context usage", LAST_RUN_CONTEXT_USAGE_SQL],
  ])("accepts the exact scheduled %s query", (_name, query) => {
    expect(() => validateLikeHost(query, "plugin_model_selection_test")).not.toThrow();
  });

  it("reproduces the v0.3.1 alias failure", () => {
    const oldQuery = "select extract(epoch from r.finished_at) from heartbeat_runs r";
    expect(() => validateLikeHost(oldQuery, "plugin_model_selection_test")).toThrow(
      'ctx.db.query cannot read schema "r"',
    );
  });
});
