import { describe, expect, it } from "vitest";

import {
  AUTO_QUARANTINE_SECONDS,
  autoQuarantineFor,
  laneExhaustionFromRunFailure,
  mergeLaneOutage,
} from "../src/lane-capacity/run-failure.js";
import type { ModelEntry } from "../src/engine/types.js";

function model(id: string, laneId: string | null): ModelEntry {
  return {
    id,
    tier: "T2",
    enabled: true,
    costPerMTokIn: 1,
    costPerMTokOut: 1,
    costPerMTokCacheRead: 1,
    capabilities: ["tools"],
    contextWindow: 200_000,
    aaIndex: null,
    releasedAt: "1970-01-01",
    fallbackOnly: false,
    note: "",
    earnIn: null,
    ...(laneId ? { laneId } : {}),
  };
}

const ROSTER: ModelEntry[] = [
  model("gpt-5.6-sol", "cliproxy-codex"),
  model("gpt-5.6-luna", "cliproxy-codex"),
  model("claude-sonnet-5", "cliproxy-claude"),
  model("glm-5.3", "cliproxy-zai"),
  model("laneless-model", null),
];

/**
 * The exact string the 2026-09-16 16:40Z outage wrote to
 * `heartbeat_runs.error`, copied from TOG-3012's own failed run. This is the
 * one input the whole feature exists to recognise, so it is asserted verbatim
 * rather than paraphrased.
 */
const LIVE_429 =
  "API Error: Request rejected (429) · All credentials for model gpt-5.6-sol are cooling down "
  + "(last error: usage_limit_reached: The usage limit has been reached)";

describe("laneExhaustionFromRunFailure", () => {
  it("attributes the live 2026-09-16 rejection to the codex lane, from the error text alone", () => {
    const verdict = laneExhaustionFromRunFailure({ error: LIVE_429, models: ROSTER });
    expect(verdict).not.toBeNull();
    expect(verdict!.laneId).toBe("cliproxy-codex");
    expect(verdict!.modelId).toBe("gpt-5.6-sol");
    expect(verdict!.modelFromErrorText).toBe(true);
  });

  it("accepts the cliproxy/-qualified form of the same id", () => {
    const verdict = laneExhaustionFromRunFailure({
      error: "All credentials for model cliproxy/glm-5.3 are cooling down",
      models: ROSTER,
    });
    expect(verdict?.laneId).toBe("cliproxy-zai");
  });

  it("does NOT quarantine on a bare 429 — that is per-request throttling on a healthy lane", () => {
    expect(
      laneExhaustionFromRunFailure({
        error: "API Error: Request rejected (429) · Too many requests, retry in 20s",
        models: ROSTER,
        fallbackModelId: "gpt-5.6-sol",
      }),
    ).toBeNull();
  });

  it("does not quarantine on unrelated failures even with a fallback model supplied", () => {
    for (const error of [
      "Internal error: ECONNRESET",
      "Stream idle timeout",
      "sandbox gone",
      "API Error: Request rejected (400) · not supported for format",
      "",
    ]) {
      expect(
        laneExhaustionFromRunFailure({ error, models: ROSTER, fallbackModelId: "gpt-5.6-sol" }),
      ).toBeNull();
    }
  });

  it("reads usage_limit_reached out of errorCode when the message carries no phrase", () => {
    const verdict = laneExhaustionFromRunFailure({
      error: "Internal error",
      errorCode: "usage_limit_reached",
      models: ROSTER,
      fallbackModelId: "gpt-5.6-sol",
    });
    expect(verdict?.laneId).toBe("cliproxy-codex");
    expect(verdict?.modelFromErrorText).toBe(false);
  });

  it("prefers the model named in the error over the caller's fallback", () => {
    const verdict = laneExhaustionFromRunFailure({
      error: LIVE_429,
      models: ROSTER,
      fallbackModelId: "glm-5.3",
    });
    expect(verdict?.modelId).toBe("gpt-5.6-sol");
    expect(verdict?.laneId).toBe("cliproxy-codex");
  });

  it("refuses to guess when the named model is not on the roster and no fallback resolves", () => {
    expect(
      laneExhaustionFromRunFailure({
        error: "All credentials for model some-unknown-model are cooling down",
        models: ROSTER,
      }),
    ).toBeNull();
  });

  it("refuses a model that has no lane — there is nothing to quarantine", () => {
    expect(
      laneExhaustionFromRunFailure({
        error: "All credentials for model laneless-model are cooling down",
        models: ROSTER,
      }),
    ).toBeNull();
  });
});

describe("mergeLaneOutage", () => {
  const now = "2026-09-16T17:00:00.000Z";

  it("creates the record when none exists", () => {
    const merged = mergeLaneOutage(null, { lanes: ["cliproxy-codex"], models: [], until: "2026-09-16T17:15:00.000Z", reason: "auto" }, now);
    expect(merged.lanes).toEqual(["cliproxy-codex"]);
    expect(merged.until).toBe("2026-09-16T17:15:00.000Z");
  });

  it("never shortens a longer operator-declared outage", () => {
    const operator = { lanes: ["cliproxy-opencode-go"], models: [], until: "2026-09-17T06:00:00.000Z", reason: "MissingSessionID" };
    const merged = mergeLaneOutage(operator, { lanes: ["cliproxy-codex"], models: [], until: "2026-09-16T17:15:00.000Z", reason: "auto" }, now);
    expect(merged.until).toBe("2026-09-17T06:00:00.000Z");
    expect([...merged.lanes].sort()).toEqual(["cliproxy-codex", "cliproxy-opencode-go"]);
    expect(merged.reason).toContain("MissingSessionID");
    expect(merged.reason).toContain("auto");
  });

  it("extends when the addition outlives the existing record", () => {
    const existing = { lanes: ["cliproxy-codex"], models: [], until: "2026-09-16T17:05:00.000Z" };
    const merged = mergeLaneOutage(existing, { lanes: ["cliproxy-codex"], models: [], until: "2026-09-16T17:20:00.000Z" }, now);
    expect(merged.until).toBe("2026-09-16T17:20:00.000Z");
    expect(merged.lanes).toEqual(["cliproxy-codex"]);
  });

  it("treats an expired record as absent rather than resurrecting its lanes", () => {
    const stale = { lanes: ["cliproxy-zai"], models: ["glm-5.3"], until: "2026-09-15T00:00:00.000Z", reason: "yesterday" };
    const merged = mergeLaneOutage(stale, { lanes: ["cliproxy-codex"], models: [], until: "2026-09-16T17:15:00.000Z" }, now);
    expect(merged.lanes).toEqual(["cliproxy-codex"]);
    expect(merged.models).toEqual([]);
    expect(merged.reason).toBeUndefined();
  });
});

describe("autoQuarantineFor", () => {
  it("quarantines the lane, not the single model, for the documented TTL", () => {
    const at = Date.parse("2026-09-16T16:40:00.000Z");
    const addition = autoQuarantineFor(
      { modelId: "gpt-5.6-sol", laneId: "cliproxy-codex", matchedPhrase: "x", modelFromErrorText: true },
      at,
    );
    expect(addition.lanes).toEqual(["cliproxy-codex"]);
    expect(addition.models).toEqual([]);
    expect(addition.until).toBe(new Date(at + AUTO_QUARANTINE_SECONDS * 1_000).toISOString());
    expect(addition.reason).toContain("cliproxy-codex");
  });
});
