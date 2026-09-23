#!/usr/bin/env node
/**
 * Fake Paperclip host for `dist/worker.js`.
 *
 * The vitest suite exercises the plugin against a hand-written `ctx` mock. That
 * mock is written by the same person as the plugin, so it agrees with the
 * plugin by construction — it cannot catch a case where the plugin's
 * assumption about the SDK is simply wrong. This harness removes that
 * agreement: it spawns the **built** worker as a real child process and speaks
 * the real newline-delimited JSON-RPC 2.0 protocol to it, so every `ctx.*` call
 * the plugin makes arrives here as a wire message.
 *
 * That is how the `AbortSignal` defect was found (TOG-811): the worker passed
 * `signal` to `ctx.http.fetch`, the suite's mock honoured it, and the real SDK
 * bridge silently drops it — a timeout that never fires.
 *
 * Usage:
 *   node worker_host_harness.mjs                 # run the built-in scenarios
 *   node worker_host_harness.mjs --json          # machine-readable result
 *
 * No credential, no network, no host access. The lane is simulated in-process.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, "..", "dist", "worker.js");
const COMPANY_ID = "11111111-2222-3333-4444-555555555555";
const LANE_KEY = "harness-not-a-real-key";

/**
 * Drives one worker process.
 *
 * `httpHandler({url, init})` returns `{status, statusText, headers, body}` or
 * throws to simulate a transport failure. `state` is the in-memory plugin
 * state store, returned so assertions can read what was persisted.
 */
async function runWorker({ config, httpHandler, secretValue = LANE_KEY }) {
  const child = spawn(process.execPath, [WORKER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test" },
  });

  const state = new Map();
  const metrics = [];
  const activity = [];
  const logs = [];
  const httpCalls = [];
  const stderr = [];
  child.stderr.on("data", (d) => stderr.push(String(d)));

  const pending = new Map();
  let nextId = 1;
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);

  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id: `h${id}`, method, params });
      pending.set(`h${id}`, pending.get(id));
    });

  const stateKeyOf = (p) => `${p.scopeKind}:${p.scopeId}:${p.stateKey}`;

  /** Answer a worker→host request. Mirrors the real host's method table. */
  async function handleFromWorker(method, params) {
    switch (method) {
      case "log":
        logs.push(params);
        return null;
      case "config.get":
        return config;
      case "companies.list":
        return [{ id: COMPANY_ID, name: "Harness Co" }];
      case "state.get":
        return state.has(stateKeyOf(params)) ? state.get(stateKeyOf(params)) : null;
      case "state.set":
        state.set(stateKeyOf(params), params.value);
        return null;
      case "state.delete":
        state.delete(stateKeyOf(params));
        return null;
      case "secrets.resolve":
        if (secretValue === null) throw new Error("secret not found");
        return secretValue;
      case "metrics.write":
        metrics.push(params);
        return null;
      case "activity.log":
        activity.push(params);
        return null;
      case "telemetry.track":
        return null;
      case "tools.register":
      case "jobs.register":
      case "api.routes.register":
      case "jobs.schedule":
      case "events.subscribe":
      case "data.register":
      case "actions.register":
        return null;
      case "http.fetch": {
        httpCalls.push(params);
        const res = await httpHandler(params);
        return {
          status: res.status,
          statusText: res.statusText ?? "",
          headers: res.headers ?? { "content-type": "application/json" },
          body: typeof res.body === "string" ? res.body : JSON.stringify(res.body),
        };
      }
      default:
        return null;
    }
  }

  const rl = createInterface({ input: child.stdout });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method) {
      // worker → host request (or notification, which has no id)
      let result = null;
      let error = null;
      try {
        result = await handleFromWorker(msg.method, msg.params ?? {});
      } catch (err) {
        error = { code: -32000, message: err instanceof Error ? err.message : String(err) };
      }
      if (msg.id !== undefined && msg.id !== null) {
        send(error ? { jsonrpc: "2.0", id: msg.id, error } : { jsonrpc: "2.0", id: msg.id, result });
      }
      return;
    }
    // host → worker response
    const waiter = pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
    }
  });

  const manifest = (await import(path.join(HERE, "..", "dist", "manifest.js"))).default;

  // A worker that dies (bad build, syntax error, missing export) answers
  // nothing, so every `await call(...)` below would hang forever and the
  // process would exit having run ZERO assertions — silently, and with no
  // failure printed. That is the classic "a down system scores perfect" trap.
  // Fail loudly instead: a child that exits before shutdown is a harness abort,
  // never a pass.
  let exitInfo = null;
  child.on("exit", (code, signal) => {
    exitInfo = { code, signal };
  });
  const guard = (label, promise) =>
    Promise.race([
      promise,
      new Promise((_resolve, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `worker did not answer "${label}" within 15s` +
                  (exitInfo ? ` — it exited (code=${exitInfo.code}, signal=${exitInfo.signal})` : "") +
                  (stderr.length ? `\nworker stderr:\n${stderr.join("")}` : ""),
              ),
            ),
          15000,
        ),
      ),
    ]);

  try {
    await guard("initialize", call("initialize", { manifest, config: {}, databaseNamespace: null }));
    await guard("configChanged", call("configChanged", { config, companyId: COMPANY_ID }));
    // `runJob` nests the job under `params.job` — the SDK reads
    // `params.job.jobKey` (worker-rpc-host.js:1403), not `params.jobKey`.
    await guard(
      "runJob",
      call("runJob", { job: { jobKey: "cliproxy-poll", runId: "harness-run", payload: {} } }),
    );
  } finally {
    child.kill();
  }
  return { state, metrics, activity, logs, httpCalls, stderr: stderr.join("") };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/**
 * Select metrics by name, refusing to answer if the field name is wrong.
 *
 * `metrics.write` carries `{ name, value, tags }` (protocol.d.ts:1199). An
 * earlier revision of this harness filtered on `metricKey`/`dimensions`, which
 * matched nothing — so "0 poll_ok" read as a passing assertion when in fact
 * the filter could never match anything. An absence-assertion is only evidence
 * if a presence-assertion over the same field would have matched, so this
 * throws when the run produced metrics but none carry a `name`.
 */
function metricsNamed(run, metricName) {
  if (run.metrics.length > 0 && !run.metrics.some((m) => typeof m.name === "string")) {
    throw new Error(
      `metrics.write params carry no 'name' field (saw keys: ${[
        ...new Set(run.metrics.flatMap((m) => Object.keys(m))),
      ].join(",")}) — this harness's filter is wrong, not the plugin`,
    );
  }
  return run.metrics.filter((m) => m.name === metricName);
}

const baseConfig = {
  pollingEnabled: true,
  laneApiKeySecretRef: { kind: "env", name: "CLIPROXY_USAGE_LANE_KEY" },
  baseUrl: "https://router.example.net/telemetry/cliproxy",
  requestTimeoutMs: 1500,
  // v0.3.0 polls per-lane documents by default and the aggregates only on
  // request. Both paths run here, over the real wire protocol, because both
  // ship.
  laneFiles: ["zai.json", "claude.json"],
  legacyAggregateFiles: true,
};

/** Far enough ahead that a slow run cannot let the cooldown expire mid-check. */
const COOLING_UNTIL = new Date(Date.now() + 3600_000).toISOString();

const ZAI_LANE = {
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  staleAfterSeconds: 300,
  records: [
    {
      lane: "zai-lane-1",
      health: "healthy",
      plan: "pro",
      governing_window: "weekly",
      weekly_utilization: 0.438,
      exhausted_until: COOLING_UNTIL,
      exhausted_reason: "conservative rate-limit cooldown",
    },
  ],
};

const CLAUDE_LANE = {
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  staleAfterSeconds: 300,
  records: [{ lane: "claude-lane-1", health: "healthy", seven_day_utilization: 0.85 }],
};

const REQUEST_RATES = {
  observedAt: "2026-09-05T03:00:00.000Z",
  providers: {
    claude: { success: 120, failed: 3 },
    codex: { success: 44, failed: 0 },
    kimi: { success: 0, failed: 17, exhausted: true },
  },
};

const MODEL_USAGE = {
  schemaVersion: 1,
  observedAt: "2026-09-05T03:00:00.000Z",
  staleAfterSeconds: 300,
  telemetry: "available",
  reasonCode: null,
  models: {
    "cliproxy/claude-opus-5": {
      serviceable: true,
      utilization: 0.24,
      state: "available",
    },
  },
};

const jsonFor = (params) => {
  if (params.url.endsWith("request-rates.json")) return { status: 200, body: REQUEST_RATES };
  if (params.url.endsWith("model-usage-v1.json")) return { status: 200, body: MODEL_USAGE };
  if (params.url.endsWith("zai.json")) return { status: 200, body: ZAI_LANE };
  if (params.url.endsWith("claude.json")) return { status: 200, body: CLAUDE_LANE };
  return { status: 404, body: { error: "not found" } };
};

// A throw anywhere below (worker died, guard timeout, metricsNamed rejecting a
// wrong field name) must exit non-zero. Node's default for an unhandled
// rejection under top-level await is a warning and exit code 0 — which would
// report a harness that ran nothing as a clean run.
process.on("unhandledRejection", (err) => {
  console.error(`\nHARNESS ABORTED — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(70);
});
process.on("uncaughtException", (err) => {
  console.error(`\nHARNESS ABORTED — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(70);
});

// --- 1. Happy path over the real protocol ----------------------------------
{
  const r = await runWorker({ config: baseConfig, httpHandler: jsonFor });
  const keys = [...r.state.keys()];
  const claude = r.state.get(`company:${COMPANY_ID}:cliproxy-insight:provider:claude`);
  check(
    "1a. real worker persists a provider record over the wire",
    claude?.success === 120 && claude?.failed === 3,
    `claude=${JSON.stringify(claude?.success)}/${JSON.stringify(claude?.failed)}`,
  );
  check(
    "1b. model-usage snapshot persisted",
    Boolean(r.state.get(`company:${COMPANY_ID}:cliproxy-insight:model-usage`)),
    `${keys.length} state keys`,
  );
  check(
    "1c. cooldown transition recorded for the exhausted provider",
    Array.isArray(r.state.get(`company:${COMPANY_ID}:cliproxy-insight:cooldown-events:kimi`)),
    "kimi",
  );
  check(
    "1e. lane snapshot persisted per lane document, over the wire",
    r.state.get(`company:${COMPANY_ID}:cliproxy-insight:lane:zai.json`)?.records?.[0]?.lane ===
      "zai-lane-1",
    `index=${JSON.stringify(r.state.get(`company:${COMPANY_ID}:cliproxy-insight:lane-index`))}`,
  );
  // The owner's 2026-09-17 ask, end to end: a cooldown carried only in a flat
  // record field reaches durable state and the cooling gauge.
  check(
    "1f. an active lane cooldown is logged and counted",
    r.state.get(`company:${COMPANY_ID}:cliproxy-insight:cooldown-events:zai-lane-1`)?.[0]
      ?.raw?.until === COOLING_UNTIL &&
      metricsNamed(r, "cliproxy_insight.lane_accounts_cooling").at(-1)?.value === 1,
    `cooling=${JSON.stringify(
      metricsNamed(r, "cliproxy_insight.lane_accounts_cooling").at(-1)?.value,
    )}`,
  );
  check(
    "1d. lane auth header is x-api-key, never Authorization",
    r.httpCalls.every(
      (c) =>
        c.init?.headers?.["x-api-key"] === LANE_KEY &&
        !("Authorization" in (c.init?.headers ?? {})),
    ),
    `${r.httpCalls.length} calls`,
  );
}

// --- 2. THE DEFECT: does the request timeout actually bound the poll? -------
// The SDK bridge serializes only { method, headers, body }. An AbortSignal
// passed in `init` is dropped before the request leaves the worker, so a lane
// that accepts the connection and never answers hangs the poll forever.
{
  const started = Date.now();
  let timedOut = false;
  const hangForever = () => new Promise(() => {}); // never resolves, never rejects

  const r = await Promise.race([
    runWorker({
      config: { ...baseConfig, requestTimeoutMs: 1000 },
      httpHandler: hangForever,
    }),
    new Promise((resolve) =>
      setTimeout(() => {
        timedOut = true;
        resolve(null);
      }, 6000),
    ),
  ]);
  const elapsed = Date.now() - started;
  check(
    "2. requestTimeoutMs bounds a hanging lane",
    !timedOut && r !== null,
    timedOut
      ? `poll still hanging after ${elapsed}ms with requestTimeoutMs=1000 — the abort never fired`
      : `poll returned in ${elapsed}ms`,
  );
}

// --- 3. Non-JSON 200 (a lane misconfigured to serve HTML) ------------------
{
  const r = await runWorker({
    config: baseConfig,
    httpHandler: () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<html>login</html>",
    }),
  });
  const errs = metricsNamed(r, "cliproxy_insight.poll_errors");
  check(
    "3. an HTML 200 is an error, not a stored empty snapshot",
    errs.length >= 2 && !r.state.get(`company:${COMPANY_ID}:cliproxy-insight:model-usage`),
    `${errs.length} poll_errors, reasons=${[...new Set(errs.map((e) => e.tags?.reason))].join(",")}`,
  );
}

// --- 4. poll_ok must not be written when nothing was read ------------------
// Guarded by `metricsNamed`, which refuses to report "0 matches" unless it saw
// metric traffic under the expected field name. Without that guard this
// assertion passes on a typo'd field name, on a worker that emits no metrics
// at all, and on a worker that crashed at startup — three ways to be green
// while proving nothing.
{
  const r = await runWorker({
    config: baseConfig,
    httpHandler: () => ({ status: 503, body: { error: "down" } }),
  });
  const ok = metricsNamed(r, "cliproxy_insight.poll_ok");
  check(
    "4. a fully-down lane never reports poll_ok",
    ok.length === 0,
    `${ok.length} poll_ok among ${r.metrics.length} metrics on an all-503 lane`,
  );
}

const failed = results.filter((r) => !r.pass);
console.log(`\npass ${results.length - failed.length}  fail ${failed.length}`);
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ results }, null, 2));
}
process.exit(failed.length === 0 ? 0 : 1);
