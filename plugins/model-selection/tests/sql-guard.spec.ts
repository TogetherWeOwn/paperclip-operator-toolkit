import { describe, expect, it } from "vitest";

import {
  ACTIVE_ROUTED_RUN_MODELS_SQL,
  CREATION_PIN_LIVE_RUNS_SQL,
  LANE_EVIDENCE_RUNS_SQL,
  LAST_RUN_CONTEXT_USAGE_SQL,
  PREVIOUS_RUN_DECISION_SQL,
  REFRESH_SCORE_CLOSING_RUNS_SQL,
  REFRESH_SCORE_RUNS_SQL,
} from "../src/sql.js";

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
    // TOG-3132: the lane-evidence aggregate runs on the same path and is
    // alias-free for the same reason.
    ["lane evidence runs", LANE_EVIDENCE_RUNS_SQL],
    // TOG-11632: the creation pin's queued-PK read and running-runs UNION
    // run on the same path and are alias-free for the same reason.
    ["creation-pin live runs", CREATION_PIN_LIVE_RUNS_SQL],
    // TOG-11793: the run-scoped decision's database fallback and its live
    // routed-run read share the same alias-free shape.
    ["previous run decision", PREVIOUS_RUN_DECISION_SQL],
    ["active routed run models", ACTIVE_ROUTED_RUN_MODELS_SQL],
  ])("accepts the exact scheduled %s query", (_name, query) => {
    expect(() => validateLikeHost(query, "plugin_model_selection_test")).not.toThrow();
  });

  // TOG-3132: the success status on `heartbeat_runs` is `succeeded`, not
  // `completed`. A query that counts `completed` finds zero successes for every
  // lane, so every lane reads proven-dead and the term excludes the whole
  // roster. Nothing else in the suite reads this string, so assert it here.
  it("counts the lane-evidence numerator on the real success status", () => {
    expect(LANE_EVIDENCE_RUNS_SQL).toContain("status = 'succeeded'");
    expect(LANE_EVIDENCE_RUNS_SQL).not.toContain("'completed'");
    // The denominator side must stay a failure list, not a catch-all: a
    // cancelled or interrupted run is a fleet/operator action, not lane health.
    expect(LANE_EVIDENCE_RUNS_SQL).toContain("status in ('failed','timed_out')");
  });

  it("reproduces the v0.3.1 alias failure", () => {
    const oldQuery = "select extract(epoch from r.finished_at) from heartbeat_runs r";
    expect(() => validateLikeHost(oldQuery, "plugin_model_selection_test")).toThrow(
      'ctx.db.query cannot read schema "r"',
    );
  });
});
