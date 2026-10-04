import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const assistantUsage = (input: number, read = 0, creation = 0) => ({
  type: "assistant",
  message: {
    id: `msg-${input}-${read}-${creation}`,
    role: "assistant",
    usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: creation },
  },
});

export function runLog(events: unknown[]): string {
  const stdout = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  const split = Math.floor(stdout.length / 2);
  return [
    { ts: "2026-10-01T00:00:00Z", stream: "stdout", chunk: stdout.slice(0, split) },
    { ts: "2026-10-01T00:00:01Z", stream: "stderr", chunk: "diagnostic only\n" },
    { ts: "2026-10-01T00:00:02Z", stream: "stdout", chunk: stdout.slice(split) },
  ].map((envelope) => JSON.stringify(envelope)).join("\n") + "\n";
}

export async function contextLogFixture(log: string) {
  const root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "context-log-test-"));
  await mkdir(join(root, "co-1", "agent-1"), { recursive: true });
  const ref = "co-1/agent-1/run-prev.ndjson";
  await writeFile(join(root, ref), log);
  return {
    root,
    row: {
      id: "run-prev", agent_id: "agent-1", log_store: "local_file", log_ref: ref,
      log_bytes: Buffer.byteLength(log), log_sha256: createHash("sha256").update(log).digest("hex"),
      log_compressed: false,
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
