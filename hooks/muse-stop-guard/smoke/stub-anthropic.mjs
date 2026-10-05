#!/usr/bin/env node
// A local stand-in for the Anthropic Messages API, for the Stop guard smoke test only.
//
// It lets the real `claude` CLI run a real turn, fire the real Stop hook and honour the real
// block decision, with no network, no credential and no spend. It answers from a script, so the
// smoke test controls exactly what "the model" says and which model name the transcript records.
//
//   STUB_SCENARIO  announce-then-final | announce-forever | genuine
//   STUB_MODEL     the model name echoed in every response (what the transcript will record)
//   STUB_LOG       file the stub writes one JSON line per request to
//
// Prints `PORT <n>` on stdout once it is listening.

import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const scenario = process.env.STUB_SCENARIO ?? "announce-then-final";
const model = process.env.STUB_MODEL ?? "muse-spark-1.3-contributor";
const logPath = process.env.STUB_LOG;
if (logPath) writeFileSync(logPath, "");

const ANNOUNCE = "Running the focused tests now:";
const FINAL = "Tests pass. Card marked `done`.";

let mainCalls = 0;

function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== "user") continue;
    const content = messages[i].content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((block) => block?.text ?? block?.content ?? "").join("\n");
  }
  return "";
}

function replyFor(call) {
  if (scenario === "genuine") return FINAL;
  if (scenario === "announce-forever") return ANNOUNCE;
  return call === 1 ? ANNOUNCE : FINAL;
}

function sse(res, text) {
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  send("message_start", {
    type: "message_start",
    message: { id: `msg_stub_${mainCalls}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
  });
  send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      /* not a JSON request */
    }
    if (req.method === "POST" && req.url.startsWith("/v1/messages/count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 10 }));
      return;
    }
    if (req.method === "POST" && req.url.startsWith("/v1/messages")) {
      // Claude Code also sends small side requests (titles, topic checks) that carry no tools and
      // a system prompt of their own. Only the main conversation is scripted and counted.
      const isMain = Array.isArray(body?.tools) ? body.tools.length > 0 : false;
      const text = isMain ? replyFor((mainCalls += 1)) : "ok";
      if (logPath) {
        appendFileSync(
          logPath,
          `${JSON.stringify({ main: isMain, call: isMain ? mainCalls : null, stream: Boolean(body?.stream), lastUser: lastUserText(body).slice(0, 400) })}\n`,
        );
      }
      if (body?.stream) {
        sse(res, text);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "msg_stub", type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
      }
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`PORT ${server.address().port}\n`);
});
