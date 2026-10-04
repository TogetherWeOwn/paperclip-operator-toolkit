import { symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MAX_CONTEXT_LOG_BYTES, peakFromRunLog, readRunContextEvidence } from "../src/context-evidence.js";
import { assistantUsage, contextLogFixture, runLog } from "./context-log-fixture.js";

describe("durable request context evidence", () => {
  it("reassembles chunks and takes the maximum, not cumulative, average or last", () => {
    const events = [
      assistantUsage(20_000, 80_000, 10_000),
      assistantUsage(30_000, 110_000, 10_000),
      assistantUsage(10_000, 40_000),
      { type: "result", usage: { input_tokens: 2_700_000, cache_read_input_tokens: 2_000_000 } },
    ];
    expect(peakFromRunLog(runLog(events))).toBe(150_000);
  });

  it("counts disjoint Claude read AND creation cache once for a single request", () => {
    expect(peakFromRunLog(runLog([assistantUsage(20_000, 100_000, 30_000)]))).toBe(150_000);
  });

  it("does not add OpenAI cached tokens, or claim a tool-loop total is a request peak", () => {
    const codex = { type: "turn.completed", usage: { input_tokens: 2_700_000, cached_input_tokens: 2_500_000 } };
    expect(peakFromRunLog(runLog([codex]))).toBeNull();
  });

  it("does not treat ACPX normalized accumulated input plus cache as request usage", () => {
    expect(peakFromRunLog(runLog([
      { type: "usage_update", usage: { inputTokens: 100_000, cacheReadTokens: 2_600_000 } },
    ]))).toBeNull();
  });

  it.each([undefined, null, -1, "20000", 1.5, Infinity])(
    "rejects incomplete or malformed assistant usage (%s), not just the bad record",
    (input) => {
      const bad = assistantUsage(10_000);
      bad.message.usage.input_tokens = input as number;
      expect(peakFromRunLog(runLog([assistantUsage(120_000), bad]))).toBeNull();
    },
  );

  it.each([
    "{broken", runLog([{ type: "result", usage: { input_tokens: 2_700_000 } }]),
    runLog([assistantUsage(0)]),
    JSON.stringify({ stream: "stdout", chunk: '[paperclip truncated run log chunk: omitted 99 chars]' }),
  ])("returns no observed peak for missing/truncated/malformed data", (log) => {
    expect(peakFromRunLog(log)).toBeNull();
  });

  it("reads only the complete finalized identity-bound file, with provenance", async () => {
    const fixture = await contextLogFixture(runLog([assistantUsage(120_000)]));
    try {
      expect(await readRunContextEvidence(fixture.row, "co-1", fixture.root)).toEqual({
        lastRunPeakTokens: 120_000, history: "run-found", runId: "run-prev",
        evidence: "local-file/claude-assistant-usage",
      });
    } finally { await fixture.cleanup(); }
  });

  it("refuses missing configuration and cross-company/traversal log references", async () => {
    const fixture = await contextLogFixture(runLog([assistantUsage(120_000)]));
    try {
      expect(await readRunContextEvidence(fixture.row, "co-1", null))
        .toMatchObject({ lastRunPeakTokens: null, evidence: "log-root-unconfigured" });
      for (const ref of ["../co-1/agent-1/run-prev.ndjson", "other/agent-1/run-prev.ndjson", "co-1/agent-1/other.ndjson"]) {
        expect(await readRunContextEvidence({ ...fixture.row, log_ref: ref }, "co-1", fixture.root))
          .toMatchObject({ lastRunPeakTokens: null, evidence: "log-identity-mismatch" });
      }
    } finally { await fixture.cleanup(); }
  });

  it("fails honestly on hash/length mismatch, unsupported store, or oversized log", async () => {
    const fixture = await contextLogFixture(runLog([assistantUsage(120_000)]));
    try {
      for (const patch of [
        { log_sha256: "f".repeat(64) }, { log_bytes: fixture.row.log_bytes + 1 },
        { log_bytes: MAX_CONTEXT_LOG_BYTES + 1 }, { log_store: "object_store" },
        { log_compressed: true }, { log_sha256: null },
      ]) {
        expect(await readRunContextEvidence({ ...fixture.row, ...patch }, "co-1", fixture.root))
          .toMatchObject({ lastRunPeakTokens: null, history: "run-found" });
      }
    } finally { await fixture.cleanup(); }
  });

  it("does not follow a log symlink out of its configured root", async () => {
    const fixture = await contextLogFixture(runLog([assistantUsage(120_000)]));
    const other = await contextLogFixture(runLog([assistantUsage(180_000)]));
    try {
      await unlink(join(fixture.root, fixture.row.log_ref));
      await symlink(join(other.root, other.row.log_ref), join(fixture.root, fixture.row.log_ref));
      expect(await readRunContextEvidence(fixture.row, "co-1", fixture.root))
        .toMatchObject({ lastRunPeakTokens: null, evidence: "log-outside-root" });
    } finally { await fixture.cleanup(); await other.cleanup(); }
  });

  it("does not use the remaining good usage when a complete file contains malformed data", async () => {
    const log = runLog([assistantUsage(120_000)]) + "{bad envelope\n";
    const fixture = await contextLogFixture(log);
    try {
      expect(await readRunContextEvidence(fixture.row, "co-1", fixture.root))
        .toMatchObject({ lastRunPeakTokens: null, evidence: "missing-or-invalid-request-usage" });
      await writeFile(join(fixture.root, fixture.row.log_ref), "shortened");
      expect(await readRunContextEvidence(fixture.row, "co-1", fixture.root))
        .toMatchObject({ lastRunPeakTokens: null, evidence: "log-integrity-mismatch" });
    } finally { await fixture.cleanup(); }
  });
});
