import { describe, expect, it } from "vitest";

import type { AaHttpClient } from "../../src/aa-index/fetch.js";
import { fetchAaFreeList } from "../../src/aa-free/fetch.js";
import { parseAaFreeList } from "../../src/aa-free/parse.js";
import { projectDecisionInput } from "../../src/aa-free/project.js";
import { AaEffortRegistry, resolveEffectiveEffort, type AaBinding } from "../../src/aa-free/registry.js";
import { blendedPriorP, priorP } from "../../src/engine/scores.js";
import { legacyBody, legacyRow } from "./fixture.js";

const NOW = "2026-10-01T14:50:03Z";
const snap = (rows: unknown[]) => parseAaFreeList(legacyBody(rows), NOW)!;

describe("parseAaFreeList", () => {
  it("keeps all 18 evaluations, prices, medians, workload, version unknown", () => {
    const s = snap([legacyRow("m-high", 51)]);
    expect(s.sourceVersion).toBe("unknown");
    expect(s.workload).toEqual({ parallelQueries: 1, promptLength: 1000 });
    const r = s.rows[0]!;
    expect(r.aaIndex).toBe(51);
    expect(Object.keys(r.free.evaluations)).toHaveLength(18);
    expect(r.free.medianTimeToFirstAnswerTokenSeconds).toBe(3);
    expect(r.free.priceOutput1m).toBe(4);
    expect(r.optionalRich).toEqual({});
  });
  it("missing metrics are null, never zero; absent index stays null", () => {
    const s = snap([legacyRow("m", null, { pricing: undefined, median_output_tokens_per_second: "x" })]);
    const r = s.rows[0]!;
    expect(r.aaIndex).toBeNull();
    expect(r.free.priceInput1m).toBeNull();
    expect(r.free.medianOutputTokensPerSecond).toBeNull();
    expect(r.free.evaluations.hle).toBeNull();
  });
  it("fails closed on malformed/empty payloads", () => {
    for (const bad of ["", "{", "[]", '{"data":"x"}', '{"data":[]}', '{"data":[{"name":"no slug"}]}']) {
      expect(parseAaFreeList(bad, NOW)).toBeNull();
    }
  });
  it("records duplicate slugs and is deeply immutable", () => {
    const s = snap([legacyRow("dup", 40), legacyRow("dup", 51)]);
    expect(s.duplicateSlugs).toEqual(["dup"]);
    expect(Object.isFrozen(s.rows[0])).toBe(true);
    expect(Object.isFrozen(s.rows[0]!.free.evaluations)).toBe(true);
  });
});

const BINDINGS: AaBinding[] = [
  { candidateId: "sol-high", modelId: "gpt-5.6-sol", laneId: "lane-codex", evaluatedEffort: "high", aaSlug: "gpt-5-6-sol-high" },
  { candidateId: "sol-xhigh", modelId: "gpt-5.6-sol", laneId: "lane-codex", evaluatedEffort: "xhigh", aaSlug: "gpt-5-6-sol-xhigh" },
  { candidateId: "opus-max", modelId: "claude-opus-5-5", laneId: "lane-claude", evaluatedEffort: "max", aaSlug: "opus-max", observationalOnly: true },
  { candidateId: "opus-high", modelId: "claude-opus-5-5", laneId: "lane-claude", evaluatedEffort: "high", aaSlug: "opus-high" },
];
const rows = [legacyRow("gpt-5-6-sol-high", 51), legacyRow("gpt-5-6-sol-xhigh", 55), legacyRow("opus-high", 48)];

describe("effort identity + registry (selection -> invocation)", () => {
  const reg = new AaEffortRegistry(BINDINGS);
  const s = snap(rows);

  it("scores the effort the invocation will run, per effort", () => {
    for (const [eff, id, idx] of [["high", "sol-high", 51], ["xhigh", "sol-xhigh", 55]] as const) {
      const identity = resolveEffectiveEffort({ adapterType: "codex_local", modelId: "gpt-5.6-sol", requestedEffort: eff });
      const ev = reg.lookup(s, { modelId: "gpt-5.6-sol", laneId: "lane-codex", identity });
      expect(ev.status).toBe("matched");
      if (ev.status === "matched") {
        expect(ev.candidateId).toBe(id);
        expect(ev.row.aaIndex).toBe(idx);
      }
    }
  });
  it("no max->high borrowing: claude_local clamps max to high, evidence is the HIGH row", () => {
    const identity = resolveEffectiveEffort({ adapterType: "claude_local", modelId: "claude-opus-5-5", requestedEffort: "max" });
    expect(identity.requestedEffort).toBe("max");
    expect(identity.effectiveEffort).toBe("high");
    expect(identity.observedServedEffort).toBeNull();
    const ev = reg.lookup(s, { modelId: "claude-opus-5-5", laneId: "lane-claude", identity });
    expect(ev.status === "matched" && ev.candidateId).toBe("opus-high");
  });
  it("observational-only variants are never eligible", () => {
    const identity = { requestedEffort: "max", effectiveEffort: "max", observedServedEffort: null } as const;
    const ev = reg.lookup(s, { modelId: "claude-opus-5-5", laneId: "lane-claude", identity });
    expect(ev).toMatchObject({ status: "ineligible", reason: "observational-only" });
  });
  it("unknown/default effort, no binding, absent or duplicate slug are ineligible, never fallback", () => {
    const mk = (effectiveEffort: any) => ({ requestedEffort: "unknown", effectiveEffort, observedServedEffort: null }) as const;
    expect(reg.lookup(s, { modelId: "gpt-5.6-sol", laneId: "lane-codex", identity: mk("default") })).toMatchObject({ reason: "effort-unknown" });
    expect(reg.lookup(s, { modelId: "gpt-5.6-sol", laneId: "lane-codex", identity: mk("low") })).toMatchObject({ reason: "no-binding" });
    expect(reg.lookup(s, { modelId: "gpt-5.6-sol", laneId: "other-lane", identity: mk("high") })).toMatchObject({ reason: "no-binding" });
    expect(reg.lookup(snap([legacyRow("x", 1)]), { modelId: "gpt-5.6-sol", laneId: "lane-codex", identity: mk("high") })).toMatchObject({ reason: "slug-absent-from-snapshot" });
    const dup = snap([legacyRow("gpt-5-6-sol-high", 40), legacyRow("gpt-5-6-sol-high", 51)]);
    expect(reg.lookup(dup, { modelId: "gpt-5.6-sol", laneId: "lane-codex", identity: mk("high") })).toMatchObject({ reason: "slug-ambiguous" });
  });
  it("effort resolver: adapter without effort surface is unknown, no roster effort is default", () => {
    expect(resolveEffectiveEffort({ adapterType: "http", modelId: "m", requestedEffort: "high" }).effectiveEffort).toBe("unknown");
    expect(resolveEffectiveEffort({ adapterType: "codex_local", modelId: "m" }).effectiveEffort).toBe("default");
  });
  it("rejects duplicate bindings at construction", () => {
    expect(() => new AaEffortRegistry([BINDINGS[0]!, BINDINGS[0]!])).toThrow(/duplicate/);
  });
});

describe("decision invariance: rich fields have zero decision weight", () => {
  const decide = (row: { aaIndex: number | null }) => {
    const input = projectDecisionInput(row);
    return { p: priorP(input.aaIndex), blended: blendedPriorP(input.aaIndex, null) };
  };
  it("identical decision with optionalRich absent/null/conflicting/invalid, and free observations varied", () => {
    const base = snap([legacyRow("m", 51)]).rows[0]!;
    const variants = [
      base,
      { ...base, optionalRich: { cost: null } },
      { ...base, optionalRich: { aaIndex: 1, cost_per_task: "bogus", nested: { x: NaN } } },
      { ...base, free: { ...base.free, priceInput1m: null, medianOutputTokensPerSecond: 9999, evaluations: { ...base.free.evaluations, gpqa: null } } },
    ];
    for (const v of variants) expect(decide(v)).toEqual(decide(base));
  });
  it("projection reads aaIndex only (trap fields throw if touched)", () => {
    const trap = new Proxy({ aaIndex: 51 } as Record<string, unknown>, {
      get(t, k) {
        if (k === "aaIndex") return 51;
        throw new Error(`projection read ${String(k)}`);
      },
    });
    expect(() => projectDecisionInput(trap as any)).not.toThrow();
  });
  it("absent aaIndex uses the existing 0.8 prior, not zero", () => {
    expect(decide({ aaIndex: null }).p).toBe(0.8);
  });
});

function http(status: number, body = "", headers: Record<string, string> = {}, redirected = false): AaHttpClient {
  return { fetch: async () => ({ status, redirected, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, text: async () => body }) };
}
const F = { apiKey: "test-key", timeoutMs: 100, maxResponseBytes: 1000 };

describe("fetchAaFreeList", () => {
  it("returns body on 200 and sends the key only as a header", async () => {
    let seen: any;
    const client: AaHttpClient = { fetch: async (u, init) => { seen = { u, init }; return { status: 200, redirected: false, headers: { get: () => null }, text: async () => "{}" }; } };
    const r = await fetchAaFreeList({ ...F, http: client });
    expect(r).toEqual({ ok: true, text: "{}" });
    expect(seen.u).not.toContain("test-key");
    expect(seen.init.headers["x-api-key"]).toBe("test-key");
  });
  it("401/403 stop with no retry; no key never calls out", async () => {
    expect(await fetchAaFreeList({ ...F, http: http(401) })).toMatchObject({ error: "aa-access-denied", retryable: false });
    expect(await fetchAaFreeList({ ...F, http: http(403) })).toMatchObject({ error: "aa-access-denied", status: 403 });
    let called = false;
    const spy: AaHttpClient = { fetch: async () => { called = true; throw new Error("x"); } };
    expect(await fetchAaFreeList({ ...F, apiKey: "", http: spy })).toMatchObject({ error: "aa-access-denied" });
    expect(called).toBe(false);
  });
  it("429 surfaces Retry-After; 5xx retryable; 4xx not; redirect/oversize/network handled", async () => {
    expect(await fetchAaFreeList({ ...F, http: http(429, "", { "retry-after": "120" }) })).toMatchObject({ error: "aa-rate-limited", retryAfterSeconds: 120 });
    expect(await fetchAaFreeList({ ...F, http: http(429) })).toMatchObject({ retryAfterSeconds: null });
    expect(await fetchAaFreeList({ ...F, http: http(503) })).toMatchObject({ error: "aa-http-failed", retryable: true });
    expect(await fetchAaFreeList({ ...F, http: http(404) })).toMatchObject({ retryable: false });
    expect(await fetchAaFreeList({ ...F, http: http(302) })).toMatchObject({ error: "aa-redirect-refused" });
    expect(await fetchAaFreeList({ ...F, http: http(200, "x".repeat(2000)) })).toMatchObject({ error: "aa-response-too-large" });
    const boom: AaHttpClient = { fetch: async () => { throw new Error("net"); } };
    expect(await fetchAaFreeList({ ...F, http: boom })).toMatchObject({ error: "aa-request-failed", retryable: true });
    expect(await fetchAaFreeList({ ...F, url: "http://x.test/", http: http(200) })).toMatchObject({ error: "aa-url-rejected" });
  });
  it("same body parses to equal snapshots (idempotent)", () => {
    const b = legacyBody([legacyRow("a", 40)]);
    expect(parseAaFreeList(b, NOW)).toEqual(parseAaFreeList(b, NOW));
  });
});
