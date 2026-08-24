#!/usr/bin/env node
// ===========================================================================
// org-request-mcp — the host-side MCP transport for org_request_queue.sh
// TOG-196 / epic TOG-194.
// ---------------------------------------------------------------------------
// WHAT THIS IS
//   A thin HTTP MCP server that runs ON THE HOST as the operator user and
//   forwards exactly two tool calls into org_request_queue.sh. It exists
//   because a `local_stdio` MCP server is spawned from the Paperclip server
//   process, which runs INSIDE the container — a container with no podman
//   socket and one mounted host path. It therefore cannot run the CLIs at all.
//   See docs/transport-identity.md for the verification behind that.
//
// WHAT THIS IS NOT
//   It is NOT an authorization boundary. Who may request what, who may approve
//   it, separation of duties, delegation ceilings, TOCTOU re-validation — all
//   of that lives in org_request_queue.sh and none of it is duplicated here.
//   If you are about to add a rule to this file that decides whether a caller
//   MAY do something, stop: it belongs in the queue, and two copies of an
//   authorization rule drift.
//
//   The distinction this file does draw, and the only one it draws:
//     * AUTHENTICATION  — who is calling. Established here, from headers the
//                         control plane stamps and the caller cannot forge.
//     * AUTHORIZATION   — what they may do. Established in the queue script.
//   Everything below is authentication, tenancy, and input hygiene.
//
// THE IDENTITY CHAIN, END TO END
//   agent (model)
//     └─ cannot influence any of the following ───────────────────────────┐
//   Paperclip tool gateway (in container)                                 │
//     stamps x-paperclip-agent-id / -company-id / -run-id from a database  │
//     row in tool_gateway_sessions. Caller-supplied x-paperclip-* headers  │
//     are classified sensitive and dropped before dispatch, and the        │
//     stamped values are written last regardless.                         ─┘
//     └─ https, Bearer credential resolved from Paperclip's secret store
//   Caddy on the host (TLS, bearer check, source restriction)
//     └─ 127.0.0.1
//   THIS SERVER
//     verifies the bearer again, requires the identity headers, and
//     corroborates (agent, run, company) against heartbeat_runs before it
//     will run anything. See requireIdentity().
//     └─ execFile, argv array, no shell
//   org_request_queue.sh   ← every authorization decision happens here
//
// FAIL-CLOSED, AND WHY IT MATTERS MOST HERE
//   The gateway forwards metadata headers only when the connection opts in via
//   config.headerPolicy.metadata.forward. THE DEFAULT IS THE EMPTY LIST. A
//   connection registered the "obvious" way — url and nothing else — sends NO
//   identity header, with no error and no health degradation. That is silent
//   anonymity, which is the exact failure the epic exists to prevent. So a
//   missing header here is a hard 403 on tools/call, never a fallback and
//   never an anonymous submit. If the connection is misconfigured, this server
//   is loud about it on the first call.
//
// WHY tools/list IS ANONYMOUS AND tools/call IS NOT
//   The gateway's catalog refresh / health check (tool-access.ts remoteTools)
//   POSTs tools/list with CREDENTIAL HEADERS ONLY — no session, so no identity
//   headers. Requiring identity on tools/list would make the connection
//   permanently unhealthy and unregisterable. Discovery is public-with-bearer;
//   execution requires a principal. That asymmetry is deliberate, and it is
//   safe because tools/list reveals only the two tool schemas.
//
// NO SECRET IN argv (/proc/*/cmdline is world-readable on a shared host) and
// no secret in the config file either: the config stores the SHA-256 of the
// bearer, never the bearer. A host-file read does not yield a usable token.
//
// Zero dependencies, deliberately: this runs as the operator user with podman
// access, and an npm tree next to that is a supply-chain surface we are not
// taking on for an HTTP server this small.
// ===========================================================================

import http from "node:http";
import { execFile } from "node:child_process";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { readFileSync, appendFileSync, statSync, realpathSync } from "node:fs";
import path from "node:path";

const SERVER_NAME = "org-request-mcp";
const SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);

// The bind address is NOT configurable. "Bind loopback only" is a stated
// non-negotiable of TOG-196, and a constraint that lives in a config file is a
// constraint one edit away from being gone. Caddy is the only thing that
// listens publicly; this process cannot be made to, short of editing source.
const BIND_ADDRESS = "127.0.0.1";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_CONCURRENT_REQUESTS = 16;
const CLI_TIMEOUT_MS = 120_000;
const CLI_MAX_BUFFER = 4 * 1024 * 1024;
const RUN_CHECK_TIMEOUT_MS = 15_000;
// A short cache, not a long one. The gateway re-checks the run on every call
// anyway; this only stops a burst from becoming one `podman exec` per request.
const RUN_CHECK_TTL_MS = 10_000;
const RUN_CHECK_CACHE_MAX = 512;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEMPLATE_RE = /^[A-Za-z0-9_]{1,64}$/;
const REQUEST_ID_RE = /^REQ-[0-9]{3,9}$/;

// ---------------------------------------------------------------------------
// Identity is never a tool argument.
//
// The gateway does not sanitise tool arguments and SHOULD not — arguments are
// tool data, and a `requester` field would arrive here verbatim, exactly as the
// model wrote it. So the schemas below have no identity field, and this list
// makes the refusal LOUD rather than silent: an argument named `requester` is
// an error naming the rule, not a key quietly dropped. A silent drop would let
// a caller believe it had acted as someone else right up until it read the
// audit log.
//
// `additionalProperties: false` plus strict validation already rejects every
// name here. The list is kept so the message is specific, and so that anyone
// adding a field to a schema has to walk past it.
// ---------------------------------------------------------------------------
const FORBIDDEN_ARGUMENT_NAMES = new Set([
  "requester", "requesterAgentId", "requester_agent_id",
  "reviewer", "reviewerAgentId", "reviewer_agent_id",
  "agent", "agent_id", "agentId",
  "company", "company_id", "companyId",
  "run", "run_id", "runId",
  "reports_to", "reportsTo", "parent",
  "author", "caller", "principal", "identity", "as", "on_behalf_of", "onBehalfOf",
  "user", "user_id", "userId", "actor", "sub", "impersonate",
]);

// Exported so an injected dependency (a test's corroborator, a future one) can
// raise a refusal the handler treats as a refusal. Without this, a dependency
// throwing a plain Error becomes a 500 — an authentication failure reported as
// a server fault, which is the wrong signal in the wrong log.
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function loadConfig(configPath) {
  const raw = readFileSync(configPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`config ${configPath} is not valid JSON: ${error.message}`);
  }
  return normalizeConfig(parsed, configPath);
}

export function normalizeConfig(input, configPath = "(inline)") {
  const cfg = { ...input };
  const problems = [];

  if (typeof cfg.companyId !== "string" || !UUID_RE.test(cfg.companyId)) {
    problems.push("companyId must be a uuid");
  }
  if (typeof cfg.bearerSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(cfg.bearerSha256)) {
    // Deliberately the digest and not the token. See the header: a read of this
    // file must not hand anyone a working credential.
    problems.push("bearerSha256 must be the lowercase sha256 hex digest of the shared bearer");
  }
  if (typeof cfg.queueScript !== "string" || !path.isAbsolute(cfg.queueScript)) {
    problems.push("queueScript must be an absolute path to org_request_queue.sh");
  }
  const port = Number(cfg.port ?? 8391);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push("port must be an integer 1-65535");
  }
  if (problems.length > 0) {
    throw new Error(`invalid config ${configPath}:\n  - ${problems.join("\n  - ")}`);
  }

  return {
    companyId: cfg.companyId,
    bearerSha256: cfg.bearerSha256.toLowerCase(),
    queueScript: cfg.queueScript,
    port,
    dbContainer: typeof cfg.dbContainer === "string" ? cfg.dbContainer : "paperclip-db",
    // Corroborating (agent, run, company) against heartbeat_runs is the control
    // that turns "a header says so" into "the database agrees". It is on by
    // default and the only sanctioned reason to disable it is an offline test.
    requireLiveRun: cfg.requireLiveRun !== false,
    auditLog: typeof cfg.auditLog === "string" ? cfg.auditLog : null,
    // Optional passthroughs to the queue's own test seams. Never a secret.
    queueEnv: isPlainObject(cfg.queueEnv) ? { ...cfg.queueEnv } : {},
  };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The config holds a credential verifier, so a mode that lets another local
// account read it is a finding, not a preference. Refuse rather than warn:
// a warning in a systemd journal is a warning nobody reads.
export function assertConfigPermissions(configPath, statFn = statSync) {
  const mode = statFn(configPath).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `config ${configPath} is mode ${mode.toString(8)}; it holds a credential verifier and must be 0600 (chmod 600 ${configPath})`,
    );
  }
}

// The queue is the only entry point. Never the provisioner — that is the whole
// design, and the cheapest place to guarantee it is at startup, before a
// misconfigured unit file can ever accept a request.
export function assertQueueScript(queueScript, realpathFn = realpathSync) {
  let resolved;
  try {
    resolved = realpathFn(queueScript);
  } catch {
    throw new Error(`queueScript ${queueScript} does not exist`);
  }
  const base = path.basename(resolved);
  if (base !== "org_request_queue.sh") {
    throw new Error(
      `queueScript resolves to ${base}; this transport fronts org_request_queue.sh and nothing else `
      + "(never the provisioner — the queue is the only entry point)",
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export function bearerMatches(presented, expectedSha256Hex) {
  if (typeof presented !== "string" || presented.length === 0) return false;
  // Hash both sides so the comparison is over two fixed-length buffers and
  // cannot leak the credential's length through timing.
  const presentedDigest = createHash("sha256").update(presented, "utf8").digest();
  const expectedDigest = Buffer.from(expectedSha256Hex, "hex");
  if (expectedDigest.length !== presentedDigest.length) return false;
  return timingSafeEqual(presentedDigest, expectedDigest);
}

function headerValue(headers, name) {
  const value = headers[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

function requireBearer(req, cfg) {
  const authorization = headerValue(req.headers, "authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match || !bearerMatches(match[1].trim(), cfg.bearerSha256)) {
    // NOTE: no WWW-Authenticate header on this 401, and that is not an
    // oversight. The gateway treats `401` + a WWW-Authenticate mentioning
    // bearer/oauth as a signal to go discover OAuth endpoints on us
    // (tool-access.ts remoteTools). We are not an OAuth server; sending it
    // would send the gateway down a discovery path that cannot succeed and
    // would bury the real cause — a wrong bearer — under a protocol error.
    throw new HttpError(401, "unauthorized", "invalid or missing bearer credential");
  }
}

/**
 * Establish WHO is calling. Everything below the transport depends on this
 * being right, so it is the one place the server is deliberately strict.
 *
 * Returns { agentId, companyId, runId, correlationId }.
 */
export function readIdentityHeaders(headers, cfg) {
  const agentId = headerValue(headers, "x-paperclip-agent-id");
  const companyId = headerValue(headers, "x-paperclip-company-id");
  const runId = headerValue(headers, "x-paperclip-run-id");

  if (!agentId) {
    // The opt-in trap, made loud. See the file header.
    throw new HttpError(
      403, "identity_header_missing",
      "no x-paperclip-agent-id on this request. This transport never acts anonymously. "
      + "The tool_connection must set config.headerPolicy.metadata.forward to include "
      + '"agent_id", "company_id" and "run_id" — the gateway forwards NO metadata headers by default.',
    );
  }
  if (!UUID_RE.test(agentId)) {
    // A non-uuid would still resolve in the queue script, which matches an org
    // ROLE id as well as a uuid. Pinning the format keeps a role name from ever
    // being smuggled through the identity channel.
    throw new HttpError(403, "identity_header_malformed", "x-paperclip-agent-id is not a uuid");
  }
  if (!companyId || !UUID_RE.test(companyId)) {
    throw new HttpError(403, "identity_header_missing", "no valid x-paperclip-company-id on this request");
  }
  // Tenancy, not authorization: this endpoint has a public hostname and every
  // company on this box shares the host, so another tenant's gateway can reach
  // it. This server fronts exactly one company's queue.
  if (companyId !== cfg.companyId) {
    throw new HttpError(
      403, "wrong_company",
      "this transport serves a single company and the caller belongs to another",
    );
  }
  if (!runId || !UUID_RE.test(runId)) {
    throw new HttpError(
      403, "identity_header_missing",
      'no valid x-paperclip-run-id on this request; add "run_id" to config.headerPolicy.metadata.forward',
    );
  }
  return {
    agentId,
    companyId,
    runId,
    correlationId: headerValue(headers, "x-paperclip-correlation-id") ?? null,
  };
}

// ---------------------------------------------------------------------------
// Run corroboration — the control that makes the bearer non-sufficient.
//
// The bearer proves "this came from our gateway". The agent header proves
// "the gateway says it was this agent". Alone, that means anyone holding the
// bearer can name any agent. This query is the third leg: the database must
// agree that this run exists, is RUNNING, and belongs to this agent in this
// company. Forging an identity then requires guessing a currently-live run id
// belonging to the victim, not merely knowing their agent id.
//
// The status set mirrors the gateway's own ACTIVE_GATEWAY_RUN_STATUSES
// (`running`) deliberately. If upstream widens it, this narrows relative to
// the gateway — which fails closed, the right direction.
// ---------------------------------------------------------------------------

const runCheckCache = new Map();

export function makeRunCorroborator(cfg, exec = execFileAsync, now = () => Date.now()) {
  return async function corroborateRun(identity) {
    if (!cfg.requireLiveRun) return;
    const key = `${identity.runId}:${identity.agentId}`;
    const cached = runCheckCache.get(key);
    if (cached && cached.expiresAt > now()) {
      if (cached.ok) return;
      throw new HttpError(403, "run_not_live", cached.message);
    }

    const sql =
      "SELECT 1 FROM heartbeat_runs "
      + "WHERE id = :'run_id'::uuid AND agent_id = :'agent_id'::uuid "
      + "AND company_id = :'company_id'::uuid AND status = 'running' LIMIT 1;";

    let stdout = "";
    let failure = null;
    try {
      // Ids travel in the environment, not argv. They are not secrets, but the
      // queue script's own pcsql() does the same and the habit is the point:
      // nothing this process runs puts a caller-influenced value on a command
      // line that /proc exposes to every account on the box.
      const result = await exec(
        "podman",
        [
          "exec", "-i",
          "-e", "PGV_RUN_ID", "-e", "PGV_AGENT_ID", "-e", "PGV_COMPANY_ID",
          cfg.dbContainer,
          "sh", "-c",
          'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atq -v ON_ERROR_STOP=1 '
          + '-v run_id="$PGV_RUN_ID" -v agent_id="$PGV_AGENT_ID" -v company_id="$PGV_COMPANY_ID" -f -',
        ],
        {
          input: sql,
          timeout: RUN_CHECK_TIMEOUT_MS,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: process.env.HOME ?? "/",
            PGV_RUN_ID: identity.runId,
            PGV_AGENT_ID: identity.agentId,
            PGV_COMPANY_ID: identity.companyId,
          },
        },
      );
      stdout = result.stdout;
    } catch (error) {
      failure = error;
    }

    // A database we cannot reach is not a licence to accept the header. This
    // control fails closed like every other one here.
    if (failure) {
      throw new HttpError(
        503, "run_check_unavailable",
        "could not corroborate the calling agent against heartbeat_runs; refusing rather than trusting the header alone",
      );
    }

    const ok = stdout.trim() === "1";
    const message =
      "the calling agent has no RUNNING heartbeat run matching x-paperclip-run-id. "
      + "Either the run ended mid-call, or the identity headers did not come from this company's gateway.";
    rememberRunCheck(key, ok, message, now());
    if (!ok) throw new HttpError(403, "run_not_live", message);
  };
}

function rememberRunCheck(key, ok, message, nowMs) {
  if (runCheckCache.size >= RUN_CHECK_CACHE_MAX) {
    // Cheap bound. Order is insertion order, so this drops the oldest.
    const oldest = runCheckCache.keys().next();
    if (!oldest.done) runCheckCache.delete(oldest.value);
  }
  runCheckCache.set(key, { ok, message, expiresAt: nowMs + RUN_CHECK_TTL_MS });
}

export function _resetRunCheckCache() {
  runCheckCache.clear();
}

// ---------------------------------------------------------------------------
// Tools — exactly two, and neither takes an identity.
// ---------------------------------------------------------------------------

export const TOOLS = [
  {
    name: "submit_provisioning_request",
    description:
      "Submit an approval-gated request to provision a new descendant agent. You are identified automatically "
      + "by the Paperclip tool gateway; there is no way to submit on another agent's behalf, and placement is "
      + "derived from your position in the reporting chain rather than supplied. The request is decided by your "
      + "responsible leader (the nearest live ancestor whose delegation ceiling already contains the template). "
      + "Returns the request id and names the leader who will be woken.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["template", "title"],
      properties: {
        template: {
          type: "string",
          description: "Permission template for the requested agent, e.g. E4_AUDIT_ANALYST.",
          pattern: TEMPLATE_RE.source,
        },
        title: { type: "string", description: "Short title for the requested role.", maxLength: 200 },
        rationale: { type: "string", description: "Why this agent is needed. Read by the approver.", maxLength: 4000 },
        supersedes: {
          type: "string",
          description: "A rejected or expired request id this one amends, e.g. REQ-004. Only your own.",
          pattern: REQUEST_ID_RE.source,
        },
      },
    },
  },
  {
    name: "review_provisioning_request",
    description:
      "Approve or reject a pending provisioning request. You are identified automatically by the Paperclip tool "
      + "gateway; there is no way to review as another agent. Authority is re-derived from live state at decision "
      + "time, so a request is refused unless you are its responsible leader or hold standing authority, and you "
      + "can never decide your own request. Approval runs the provisioner with the ORIGINAL requester as caller.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["request_id", "decision"],
      properties: {
        request_id: { type: "string", description: "The request to decide, e.g. REQ-004.", pattern: REQUEST_ID_RE.source },
        decision: { type: "string", enum: ["approve", "reject"], description: "The decision. Decisions are final." },
        reason: {
          type: "string",
          description: "Why. Recorded in the grant log and readable by the requester, who may answer it.",
          maxLength: 4000,
        },
      },
    },
  },
];

/**
 * Translate validated tool arguments into an argv array for the queue script.
 *
 * The identity arguments are supplied HERE, from the authenticated principal,
 * and are structurally unreachable from the tool input. That is the whole
 * point of this function: `--requester` and `--reviewer` are written by the
 * server, from a header the caller cannot set, every single time.
 */
export function buildQueueArgs(toolName, args, identity) {
  const bad = Object.keys(args).find((key) => FORBIDDEN_ARGUMENT_NAMES.has(key));
  if (bad) {
    throw new HttpError(
      400, "identity_argument_refused",
      `'${bad}' is not an argument of this tool. Identity is taken from the authenticated Paperclip principal `
      + "and can never be supplied as tool input; an identity the model can fill in voids every authorization "
      + "check below this transport.",
    );
  }

  if (toolName === "submit_provisioning_request") {
    const template = requireStringArg(args, "template", TEMPLATE_RE);
    const title = requireStringArg(args, "title", null, 200);
    const argv = ["submit", "--requester", identity.agentId, "--template", template, "--title", title];
    const rationale = optionalStringArg(args, "rationale", null, 4000);
    if (rationale) argv.push("--rationale", rationale);
    const supersedes = optionalStringArg(args, "supersedes", REQUEST_ID_RE);
    if (supersedes) argv.push("--supersedes", supersedes);
    return argv;
  }

  if (toolName === "review_provisioning_request") {
    const requestId = requireStringArg(args, "request_id", REQUEST_ID_RE);
    const decision = requireStringArg(args, "decision", /^(approve|reject)$/);
    const argv = [
      "review", "--reviewer", identity.agentId, "--request", requestId,
      decision === "approve" ? "--approve" : "--reject",
    ];
    const reason = optionalStringArg(args, "reason", null, 4000);
    if (reason) argv.push("--reason", reason);
    return argv;
  }

  throw new HttpError(400, "unknown_tool", `unknown tool: ${toolName}`);
}

function requireStringArg(args, name, pattern, maxLength) {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, "invalid_argument", `'${name}' is required and must be a non-empty string`);
  }
  return checkStringArg(name, value, pattern, maxLength);
}

function optionalStringArg(args, name, pattern, maxLength) {
  const value = args[name];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_argument", `'${name}' must be a string`);
  }
  return checkStringArg(name, value, pattern, maxLength);
}

function checkStringArg(name, value, pattern, maxLength) {
  if (maxLength && value.length > maxLength) {
    throw new HttpError(400, "invalid_argument", `'${name}' exceeds ${maxLength} characters`);
  }
  if (pattern && !pattern.test(value)) {
    throw new HttpError(400, "invalid_argument", `'${name}' has an invalid format`);
  }
  // Values reach the CLI as discrete argv elements, so a leading dash cannot
  // become a separate flag — the script consumes it as the value of the flag
  // that precedes it. This rejects it anyway on the free-text fields, because
  // relying on a downstream parser's `shift 2` is a load-bearing assumption
  // about someone else's code, and this costs nothing.
  if (!pattern && value.startsWith("-")) {
    throw new HttpError(400, "invalid_argument", `'${name}' may not begin with '-'`);
  }
  // Bash reads NUL-terminated argv; an embedded NUL would truncate silently.
  if (value.includes("\0")) {
    throw new HttpError(400, "invalid_argument", `'${name}' contains a NUL byte`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }
  });
}

// The queue is an append-only JSONL file and next_id() counts the lines in it,
// so two concurrent submits can collide on an id. Serialising CLI invocations
// is the smallest correct fix and costs nothing at this call volume. This is
// transport hygiene, not an authorization decision.
function makeSerializer() {
  let tail = Promise.resolve();
  return function serialize(fn) {
    const result = tail.then(fn, fn);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

export function makeQueueRunner(cfg, exec = execFileAsync) {
  const serialize = makeSerializer();
  return function runQueue(argv) {
    return serialize(async () => {
      try {
        const { stdout, stderr } = await exec(cfg.queueScript, argv, {
          timeout: CLI_TIMEOUT_MS,
          maxBuffer: CLI_MAX_BUFFER,
          // A deliberately minimal environment. The parent process holds
          // nothing the queue needs, and inheriting an environment wholesale is
          // how a credential ends up somewhere nobody expected it.
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: process.env.HOME ?? "/",
            COMPANY_ID: cfg.companyId,
            PAPERCLIP_DB_CTR: cfg.dbContainer,
            ...cfg.queueEnv,
          },
        });
        return { ok: true, text: (stdout + stderr).trim(), exitCode: 0 };
      } catch (error) {
        // The queue's refusals are exit 2 with "REFUSED: ..." on stderr. Those
        // are a legitimate ANSWER, not a transport failure: the caller needs to
        // read them. Surface as an MCP tool error so the model sees the reason.
        const text = [error.stdout ?? "", error.stderr ?? ""].join("").trim();
        return {
          ok: false,
          text: text || `the request queue failed: ${error.message}`,
          exitCode: typeof error.code === "number" ? error.code : null,
        };
      }
    });
  };
}

// ---------------------------------------------------------------------------
// Audit — transport-level only. The queue keeps the authoritative grant log;
// this records who reached the transport and what happened, and NEVER the
// bearer, and never argument values (which would put a rationale in a second
// place for no benefit).
// ---------------------------------------------------------------------------

function makeAuditor(cfg) {
  return function audit(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    if (cfg.auditLog) {
      try {
        appendFileSync(cfg.auditLog, line + "\n", { mode: 0o600 });
      } catch {
        // Never let an audit write failure take the transport down; the line
        // still reaches the journal below.
      }
    }
    process.stdout.write(line + "\n");
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC / MCP
// ---------------------------------------------------------------------------

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

export function createHandler(cfg, deps = {}) {
  const runQueue = deps.runQueue ?? makeQueueRunner(cfg);
  const corroborateRun = deps.corroborateRun ?? makeRunCorroborator(cfg);
  const audit = deps.audit ?? makeAuditor(cfg);

  async function handleRpc(message, req) {
    const { id, method, params } = message;

    if (method === "initialize") {
      const requested = params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Two tools, both acting as YOU. Identity comes from the Paperclip tool gateway and is never an argument. "
          + "Approval authority is decided by org_request_queue.sh, not by this transport.",
      });
    }

    if (method === "ping") return rpcResult(id, {});

    // Anonymous by necessity — this is the gateway's catalog refresh and health
    // check, which carries credentials but no session. See the file header.
    if (method === "tools/list") return rpcResult(id, { tools: TOOLS });

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments ?? {};
      if (!isPlainObject(args)) {
        throw new HttpError(400, "invalid_argument", "params.arguments must be an object");
      }
      if (!TOOLS.some((tool) => tool.name === toolName)) {
        // Named explicitly so nobody reads a typo as a missing capability, and
        // so an attempt to reach anything else is recorded rather than guessed.
        throw new HttpError(
          400, "unknown_tool",
          `unknown tool '${toolName}'. This transport exposes exactly two: `
          + TOOLS.map((tool) => tool.name).join(", ")
          + ". There is no tool that runs the provisioner; the queue is the only entry point.",
        );
      }

      // Identity is established AFTER the tool is known and BEFORE anything
      // runs. Ordering matters: an unknown tool must not consume a database
      // round trip, and a known tool must never execute without a principal.
      const identity = readIdentityHeaders(req.headers, cfg);
      await corroborateRun(identity);

      const argv = buildQueueArgs(toolName, args, identity);
      const started = Date.now();
      const result = await runQueue(argv);
      audit({
        event: "tool.call",
        tool: toolName,
        agentId: identity.agentId,
        runId: identity.runId,
        correlationId: identity.correlationId,
        // Keys only. Values live in the queue's own log, which is authoritative.
        argumentKeys: Object.keys(args).sort(),
        outcome: result.ok ? "success" : "refused_or_failed",
        exitCode: result.exitCode,
        durationMs: Date.now() - started,
      });
      return rpcResult(id, {
        content: [{ type: "text", text: result.text }],
        isError: !result.ok,
      });
    }

    return rpcError(id, -32601, `method not found: ${method}`);
  }

  return async function handle(req, body) {
    if (req.method !== "POST") {
      // No SSE stream to open, so a GET has nothing to return. 405 is the
      // spec's answer for a server that does not offer the streaming leg.
      throw new HttpError(405, "method_not_allowed", "this endpoint accepts POST only");
    }

    requireBearer(req, cfg);

    let message;
    try {
      message = JSON.parse(body);
    } catch {
      return { status: 400, payload: rpcError(null, -32700, "parse error") };
    }
    if (Array.isArray(message)) {
      // Batching was removed from MCP in 2025-06-18 and supporting it here
      // would mean deciding identity once for several calls.
      return { status: 400, payload: rpcError(null, -32600, "JSON-RPC batching is not supported") };
    }
    if (!isPlainObject(message) || typeof message.method !== "string") {
      return { status: 400, payload: rpcError(null, -32600, "invalid request") };
    }

    // A notification (no id) gets no body — 202 per the Streamable HTTP spec.
    const isNotification = message.id === undefined || message.id === null;
    if (isNotification) {
      return { status: 202, payload: null };
    }

    try {
      return { status: 200, payload: await handleRpc(message, req) };
    } catch (error) {
      if (error instanceof HttpError) {
        // A refusal ABOUT the caller is an HTTP status, so the gateway records
        // it as a connection-level failure rather than a tool answer the model
        // might paper over.
        if (error.status >= 401) {
          audit({
            event: "request.refused",
            code: error.code,
            status: error.status,
            tool: message.params?.name ?? null,
            // Recorded so a misconfigured connection is diagnosable, but never
            // trusted: this is the unverified claim, which is why it is refused.
            claimedAgentId: headerValue(req.headers, "x-paperclip-agent-id") ?? null,
          });
          throw error;
        }
        // A refusal about the ARGUMENTS is the caller's answer to read.
        audit({
          event: "tool.rejected",
          code: error.code,
          tool: message.params?.name ?? null,
          argumentKeys: Object.keys(message.params?.arguments ?? {}).sort(),
        });
        return {
          status: 200,
          payload: rpcResult(message.id, {
            content: [{ type: "text", text: `REFUSED (${error.code}): ${error.message}` }],
            isError: true,
          }),
        };
      }
      audit({ event: "request.error", message: String(error?.message ?? error) });
      return { status: 500, payload: rpcError(message.id, -32603, "internal error") };
    }
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

export function createServer(cfg, deps = {}) {
  const handle = deps.handle ?? createHandler(cfg, deps);
  let inFlight = 0;

  return http.createServer((req, res) => {
    const requestId = randomUUID();
    res.setHeader("x-request-id", requestId);

    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/mcp") {
      // No health endpoint, no index, no error detail. The hostname is public;
      // an unauthenticated probe learns only that something answers on 404.
      sendJson(res, 404, { error: "not found" });
      return;
    }

    // The endpoint is public-facing through Caddy, so an unbounded number of
    // concurrent `podman exec` children is a real failure mode even with a
    // valid bearer.
    if (inFlight >= MAX_CONCURRENT_REQUESTS) {
      sendJson(res, 503, { error: "busy" });
      return;
    }
    inFlight += 1;

    readBody(req, MAX_BODY_BYTES)
      .then(async (body) => {
        const { status, payload } = await handle(req, body);
        if (payload === null) {
          res.writeHead(status);
          res.end();
          return;
        }
        sendJson(res, status, payload);
      })
      .catch((error) => {
        const status = error instanceof HttpError ? error.status : 500;
        const code = error instanceof HttpError ? error.code : "internal_error";
        const message = error instanceof HttpError ? error.message : "internal error";
        // See requireBearer: no WWW-Authenticate on a 401, ever.
        sendJson(res, status, { error: { code, message } });
        // Drain whatever the caller is still sending. A rejection decided from
        // Content-Length alone leaves an unread request stream, and node holds
        // the socket open until it ends — the caller sees the 413 only after a
        // multi-second stall, which reads like a hang rather than a refusal.
        req.resume();
      })
      .finally(() => {
        inFlight -= 1;
      });
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    // Reject on the declared length FIRST, before a byte is read. Destroying a
    // socket mid-upload makes the peer see ECONNRESET rather than the 413, and
    // the gateway then records an opaque network failure instead of the actual
    // reason. The gateway always sends a fixed JSON body, so this is the path
    // an oversized request really takes.
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, "payload_too_large", "request body too large"));
      return;
    }

    const chunks = [];
    let size = 0;
    let overflowed = false;
    req.on("data", (chunk) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > limit) {
        // Backstop for a chunked request with no declared length. Keep draining
        // rather than destroying, so the response still reaches the caller.
        overflowed = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflowed) {
        reject(new HttpError(413, "payload_too_large", "request body too large"));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(argv) {
  // The config PATH on the command line is fine; the config CONTENTS are not
  // on the command line, and the file itself holds a digest rather than a
  // token. /proc/*/cmdline stays boring.
  const configPath = argv[0] ?? process.env.ORG_MCP_CONFIG ?? "/etc/org-request-mcp/config.json";
  assertConfigPermissions(configPath);
  const cfg = loadConfig(configPath);
  assertQueueScript(cfg.queueScript);

  const server = createServer(cfg);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, BIND_ADDRESS, resolve);
  });
  process.stdout.write(JSON.stringify({
    ts: new Date().toISOString(),
    event: "listening",
    address: `${BIND_ADDRESS}:${cfg.port}`,
    companyId: cfg.companyId,
    queueScript: cfg.queueScript,
    requireLiveRun: cfg.requireLiveRun,
    tools: TOOLS.map((tool) => tool.name),
  }) + "\n");

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`org-request-mcp: ${error.message}\n`);
    process.exit(1);
  });
}
