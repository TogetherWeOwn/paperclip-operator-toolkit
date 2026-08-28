#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const checkoutDir = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = new URL("./omniroute/rehearsal/responseTranslator.ts", import.meta.url);
const source = fs.readFileSync(sourcePath, "utf8");
const withoutImports = (() => {
  const lines = source.split("\n");
  const kept = [];
  let dropping = false;
  for (const line of lines) {
    if (!dropping && line.startsWith("import ")) dropping = true;
    if (dropping) {
      if (line.trimEnd().endsWith(";")) dropping = false;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
})();
const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), "tog554-cache-translation-"));
const sourceFile = path.join(moduleDir, "responseTranslator.ts");
const compiledFile = path.join(moduleDir, "responseTranslator.js");
fs.writeFileSync(
  sourceFile,
  [
    'const FORMATS = { OPENAI: "openai", OPENAI_RESPONSES: "openai-responses", CLAUDE: "claude", GEMINI: "gemini", ANTIGRAVITY: "antigravity" };',
    "const buildGeminiThoughtSignatureKey = () => '';",
    "const storeGeminiThoughtSignature = () => {};",
    "const normalizeOpenAICompatibleFinishReasonString = (reason) => reason;",
    "const containsTextualToolCallMarker = () => false;",
    'const getAnyReasoningValue = (message) => message.reasoning_content ?? message.reasoning ?? "";',
    withoutImports,
  ].join("\n"),
);

const compiler = process.env.TSC_BIN ?? path.join(
  checkoutDir,
  "node_modules",
  "typescript",
  "bin",
  "tsc",
);
const result = spawnSync(process.execPath, [
  compiler,
  sourceFile,
  "--target", "ES2022",
  "--module", "ES2022",
  "--skipLibCheck",
  "--outDir", moduleDir,
], { encoding: "utf8" });
if (!fs.existsSync(compiledFile)) {
  throw new Error(`tsc did not emit responseTranslator.js:\n${result.stdout}\n${result.stderr}`);
}
const {
  convertOpenAINonStreamingToClaude,
  translateNonStreamingResponse,
} = await import(pathToFileURL(compiledFile));

const response = (usage) => ({
  id: "msg_test",
  object: "chat.completion",
  model: "claude-sonnet-5",
  choices: [{
    index: 0,
    message: { role: "assistant", content: "OK" },
    finish_reason: "stop",
  }],
  usage,
});

test("preserves uncached, creation, read, and output tokens across a Claude round trip", () => {
  const native = {
    id: "msg_native",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "text", text: "OK" }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 2,
    },
  };

  const openai = translateNonStreamingResponse(native, "claude", "openai");
  assert.deepEqual(openai.usage, {
    prompt_tokens: 130,
    completion_tokens: 2,
    total_tokens: 132,
    prompt_tokens_details: {
      cached_tokens: 30,
      cache_creation_tokens: 20,
    },
  });

  const roundTrip = translateNonStreamingResponse(openai, "openai", "claude");
  assert.deepEqual(roundTrip.usage, native.usage);
});

test("translates an empty Claude content array and its cache usage", () => {
  const result = translateNonStreamingResponse({
    id: "msg_prewarm",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [],
    stop_reason: "max_tokens",
    usage: {
      input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 0,
    },
  }, "claude", "openai");

  assert.equal(result.object, "chat.completion");
  assert.equal(result.choices.length, 1);
  assert.deepEqual(result.choices[0], {
    index: 0,
    message: { role: "assistant", content: "" },
    finish_reason: "length",
  });
  assert.deepEqual(result.usage, {
    prompt_tokens: 130,
    completion_tokens: 0,
    total_tokens: 130,
    prompt_tokens_details: {
      cached_tokens: 30,
      cache_creation_tokens: 20,
    },
  });
});

test("clamps malformed excessive cache reads at zero uncached input", () => {
  const result = convertOpenAINonStreamingToClaude(response({
    prompt_tokens: 10,
    completion_tokens: 1,
    cache_creation_input_tokens: 8,
    cache_read_input_tokens: 17,
  }));

  assert.equal(result.usage.input_tokens, 0);
  assert.equal(result.usage.cache_creation_input_tokens, 8);
  assert.equal(result.usage.cache_read_input_tokens, 17);
});

test("subtracts both top-level cache buckets from inclusive external prompt tokens", () => {
  const result = convertOpenAINonStreamingToClaude(response({
    prompt_tokens: 150,
    completion_tokens: 2,
    cache_creation_input_tokens: 20,
    cache_read_input_tokens: 30,
  }));

  assert.deepEqual(result.usage, {
    input_tokens: 100,
    output_tokens: 2,
    cache_creation_input_tokens: 20,
    cache_read_input_tokens: 30,
  });
});

test("keeps uncached-only usage unchanged", () => {
  const result = convertOpenAINonStreamingToClaude(response({
    prompt_tokens: 11,
    completion_tokens: 1,
  }));

  assert.deepEqual(result.usage, {
    input_tokens: 11,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });
});
