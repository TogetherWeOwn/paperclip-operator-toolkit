import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export interface ContextUsage {
  lastRunPeakTokens: number | null;
  history: "run-found" | "no-history" | "unavailable";
  runId: string | null;
  evidence: string;
}

export const MAX_CONTEXT_LOG_BYTES = 8 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Paperclip local_file NDJSON envelopes contain stdout chunks, not necessarily
 * whole provider lines. Only Claude's assistant.message.usage is request-sized:
 * input_tokens excludes both cache-read and cache-creation tokens. Terminal
 * result/usage_json and Codex turn.completed usage are cumulative, not peaks.
 */
export function peakFromRunLog(log: string): number | null {
  if (log.includes("[paperclip truncated run log chunk")) return null;
  let stdout = "";
  try {
    for (const line of log.split("\n")) {
      if (!line.trim()) continue;
      const envelope = record(JSON.parse(line));
      if (typeof envelope.chunk !== "string" ||
          (envelope.stream !== "stdout" && envelope.stream !== "stderr")) return null;
      if (envelope.stream === "stdout") stdout += envelope.chunk;
    }
    let peak = 0;
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const event = record(JSON.parse(line));
      // OpenAI cache tokens are already inside input. More importantly, this
      // adapter receipt sums a whole tool loop, so NEVER add/cache-count it here.
      if (event.type === "turn.completed") return null;
      if (event.type !== "assistant") continue;
      const message = record(event.message);
      const usage = record(message.usage);
      const parts = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens]
        .map(count);
      // Incomplete assistant usage cannot prove the maximum of the run.
      if (parts.some((part) => part === null)) return null;
      const tokens = (parts as number[]).reduce((sum, part) => sum + part, 0);
      if (!Number.isSafeInteger(tokens)) return null;
      peak = Math.max(peak, tokens);
    }
    return peak > 0 ? peak : null;
  } catch {
    return null;
  }
}

/** Read only the finalized, identity-bound log named by this company's run row. */
export async function readRunContextEvidence(
  row: unknown,
  companyId: string,
  logRoot: string | null,
): Promise<ContextUsage> {
  const run = record(row);
  const runId = typeof run.id === "string" ? run.id : null;
  const fallback = (evidence: string): ContextUsage => ({
    lastRunPeakTokens: null, history: "run-found", runId, evidence,
  });
  if (!runId) return fallback("malformed-run-row");
  if (!logRoot || !isAbsolute(logRoot)) return fallback("log-root-unconfigured");
  if (run.log_store !== "local_file" || run.log_compressed !== false)
    return fallback("unsupported-log-store");
  const agentId = typeof run.agent_id === "string" ? run.agent_id : "";
  const safeId = /^[a-zA-Z0-9_-]+$/;
  if (![companyId, agentId, runId].every((id) => safeId.test(id)))
    return fallback("invalid-log-identity");
  const expectedRef = `${companyId}/${agentId}/${runId}.ndjson`;
  if (run.log_ref !== expectedRef) return fallback("log-identity-mismatch");
  const expectedBytes = typeof run.log_bytes === "string" ? Number(run.log_bytes) : run.log_bytes;
  if (count(expectedBytes) === null || (expectedBytes as number) > MAX_CONTEXT_LOG_BYTES ||
      typeof run.log_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(run.log_sha256))
    return fallback("missing-or-oversized-log-integrity");
  try {
    const root = await realpath(logRoot);
    const path = await realpath(join(root, expectedRef));
    const within = relative(root, path);
    if (!within || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`))
      return fallback("log-outside-root");
    if (path !== join(root, expectedRef)) return fallback("log-noncanonical-path");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== expectedBytes) return fallback("log-integrity-mismatch");
      // Bounded even if the file grows after stat. Never return log text or paths.
      const buffer = Buffer.alloc((expectedBytes as number) + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await file.read(buffer, length, buffer.length - length, null);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      const bytes = buffer.subarray(0, length);
      if (length !== expectedBytes || createHash("sha256").update(bytes).digest("hex") !== run.log_sha256)
        return fallback("log-integrity-mismatch");
      const peak = peakFromRunLog(bytes.toString("utf8"));
      return peak === null ? fallback("missing-or-invalid-request-usage") : {
        lastRunPeakTokens: peak, history: "run-found", runId,
        evidence: "local-file/claude-assistant-usage",
      };
    } finally {
      await file.close();
    }
  } catch {
    return fallback("log-unreadable");
  }
}
