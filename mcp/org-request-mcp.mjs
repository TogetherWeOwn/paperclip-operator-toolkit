#!/usr/bin/env node
// ===========================================================================
// org-request-mcp — the host-side MCP transport for org_request_queue.sh
// ---------------------------------------------------------------------------
// WHAT THIS IS
//   A thin HTTP MCP server that runs ON THE HOST as the operator user and
//   forwards a fixed, enumerated set of tool calls into org_request_queue.sh
//   and capability_gate.sh — see the TOOLS array, which is the surface. It exists
//   because a `local_stdio` MCP server is spawned from the Paperclip server
//   process, which runs INSIDE the container — a container with no
//   container-engine socket and one mounted host path. It therefore cannot run
//   the CLIs at all.
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
//   safe because tools/list reveals only the tool SCHEMAS. No request, no
//   decision and no inbox is reachable without a corroborated principal.
//
// NO SECRET IN argv (/proc/*/cmdline is world-readable on a shared host) and
// no secret in the config file either: the config stores the SHA-256 of the
// bearer, never the bearer. A host-file read does not yield a usable token.
//
// Zero dependencies, deliberately: this runs as the operator user with
// container-engine (docker or podman) access, and an npm tree next to that is
// a supply-chain surface we are not taking on for an HTTP server this small.
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
// non-negotiable of the design, and a constraint that lives in a config file is a
// constraint one edit away from being gone. Caddy is the only thing that
// listens publicly; this process cannot be made to, short of editing source.
const BIND_ADDRESS = "127.0.0.1";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_CONCURRENT_REQUESTS = 16;
const CLI_TIMEOUT_MS = 120_000;
const CLI_MAX_BUFFER = 4 * 1024 * 1024;
const RUN_CHECK_TIMEOUT_MS = 15_000;
// A short cache, not a long one. The gateway re-checks the run on every call
// anyway; this only stops a burst from becoming one container exec per request.
const RUN_CHECK_TTL_MS = 10_000;
const RUN_CHECK_CACHE_MAX = 512;

// Environment names this server supplies to the queue itself. `queueEnv` is an
// operator seam for the queue's own test hooks; it is not a way to restate any
// of these. See normalizeConfig and makeQueueRunner — both refuse, in that
// order, because the second is what still holds if someone builds a cfg object
// without going through the first.
const RESERVED_QUEUE_ENV = new Set(["COMPANY_ID", "PATH", "HOME", "PAPERCLIP_DB_CTR", "CONTAINER_ENGINE", "PAPERCLIP_SQL_BACKEND"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEMPLATE_RE = /^[A-Za-z0-9_]{1,64}$/;
const REQUEST_ID_RE = /^REQ-[0-9]{3,9}$/;
// capability_gate.sh mints its ids with a CAP- prefix (REQ_ID_PREFIX="CAP"),
// deliberately distinct from the queue's REQ- so a request id can never be
// aimed at the wrong tool by accident. A capability tool that accepted a REQ-
// id would forward it to a script that has no such request.
const CAP_REQUEST_ID_RE = /^CAP-[0-9]{3,9}$/;
// A capability KEY as capability_gate.sh classifies it, e.g. `github.token` or
// `omniroute.key.self`. Dotted segments, no slashes, no spaces, no leading
// dash. The registry decides whether it is KNOWN — this only keeps a
// shell-hostile or identity-shaped value out of the argv.
const CAPABILITY_KEY_RE = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;
// The action verb (create, read, rotate, delete, …). Same hygiene.
const CAPABILITY_ACTION_RE = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;

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
// TWO CONTROLS, AND THE ORDER BETWEEN THEM MATTERS
//   The general control is assertKnownArguments(): any key absent from the
//   tool's own inputSchema.properties is refused. That is what
//   `additionalProperties: false` advertises to clients, and it is enforced
//   here because NOTHING ELSE ENFORCES IT — there is no JSON-Schema validator
//   in this process, and buildQueueArgs reads named arguments explicitly, so
//   an unlisted key would otherwise be dropped in silence.
//
//   This list is the SPECIFIC control, checked first so the message names the
//   actual rule. `requester` and `template_typo` are both unknown keys, but
//   only one of them is someone trying to be somebody else, and the operator
//   reading the audit log should be able to tell them apart at a glance.
//
//   Every name here is already an unknown key, so the list is now genuinely
//   redundant for SAFETY and load-bearing only for the MESSAGE. It was the
//   other way round before the general control existed, and the header
//   claimed otherwise. Keep it:
//   it also means anyone adding a field to a schema has to walk past it.
// ---------------------------------------------------------------------------
const FORBIDDEN_ARGUMENT_NAMES = new Set([
  "requester", "requesterAgentId", "requester_agent_id",
  "reviewer", "reviewerAgentId", "reviewer_agent_id",
  // The capability gate's third key. `custodian`/`decider` name principals the
  // server derives from the authenticated session exactly as it does the other
  // two; an argument by that name is the same attack wearing the custody hat.
  "custodian", "custodianAgentId", "custodian_agent_id", "decider",
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
  // capabilityScript is OPTIONAL: a deployment may front only the provisioning
  // queue. When present it must be an absolute path, and main() asserts its
  // basename is capability_gate.sh — the same guard queueScript gets. The
  // handler fails closed if a capability tool is called on a server that never
  // configured it, so a half-configured unit refuses rather than crashes.
  if (cfg.capabilityScript !== undefined && cfg.capabilityScript !== null
      && (typeof cfg.capabilityScript !== "string" || !path.isAbsolute(cfg.capabilityScript))) {
    problems.push("capabilityScript, when set, must be an absolute path to capability_gate.sh");
  }
  const port = Number(cfg.port ?? 8391);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push("port must be an integer 1-65535");
  }
  // queueEnv is an operator-owned test seam, but a config file that can set
  // COMPANY_ID is a config file that can lie about tenancy to the queue — and
  // one that can set PATH chooses which container engine and which `psql` run,
  // as do CONTAINER_ENGINE and PAPERCLIP_SQL_BACKEND directly. Refuse
  // at load, so it is a unit that will not start rather than a request that
  // quietly ran against the wrong company or the wrong database.
  // Some hosts run Docker only, so the engine this host answers to is config,
  // not source. Unset means the podman default; anything but docker or podman
  // is refused at load rather than failing per-request in execFile.
  if (cfg.containerEngine !== undefined && cfg.containerEngine !== "docker" && cfg.containerEngine !== "podman") {
    problems.push('containerEngine, when set, must be "docker" or "podman"');
  }
  const reservedEnv = Object.keys(isPlainObject(cfg.queueEnv) ? cfg.queueEnv : {})
    .filter((key) => RESERVED_QUEUE_ENV.has(key));
  if (reservedEnv.length > 0) {
    problems.push(
      `queueEnv may not set ${reservedEnv.join(", ")}: ${[...RESERVED_QUEUE_ENV].join(", ")} are supplied by this `
      + "server and a config that can override them can misdirect the queue's tenancy or its PATH",
    );
  }
  if (problems.length > 0) {
    throw new Error(`invalid config ${configPath}:\n  - ${problems.join("\n  - ")}`);
  }

  return {
    companyId: cfg.companyId,
    bearerSha256: cfg.bearerSha256.toLowerCase(),
    queueScript: cfg.queueScript,
    capabilityScript: typeof cfg.capabilityScript === "string" ? cfg.capabilityScript : null,
    port,
    dbContainer: typeof cfg.dbContainer === "string" ? cfg.dbContainer : "paperclip-db",
    containerEngine: typeof cfg.containerEngine === "string" ? cfg.containerEngine : "podman",
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

// The capability tools front capability_gate.sh and nothing else — the sibling
// of the queue, for asks whose object is a CAPABILITY rather than an org seat.
// Same guarantee, same reason: pin the basename at startup so a misconfigured
// unit refuses to launch rather than shelling out to whatever the path names.
// Never the provisioner or any grant-effecting tool; the gate DECIDES, it does
// not GRANT.
export function assertCapabilityScript(capabilityScript, realpathFn = realpathSync) {
  let resolved;
  try {
    resolved = realpathFn(capabilityScript);
  } catch {
    throw new Error(`capabilityScript ${capabilityScript} does not exist`);
  }
  const base = path.basename(resolved);
  if (base !== "capability_gate.sh") {
    throw new Error(
      `capabilityScript resolves to ${base}; the capability tools front capability_gate.sh and nothing else `
      + "(never the provisioner and never a grant-effecting tool — the gate decides, it does not grant)",
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

// The container binary this host answers to. Some hosts run Docker only, so
// the transport cannot hard-code `podman` here any more than the queue scripts
// can in lib/pcsql.sh. Config wins, then the environment, then the
// podman default — and the queue runners receive the same value as
// CONTAINER_ENGINE below, so corroboration and the queue never disagree.
export function containerEngineFor(cfg) {
  return cfg.containerEngine || process.env.CONTAINER_ENGINE || "podman";
}

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
        containerEngineFor(cfg),
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
// Tools — none takes an identity.
//
// Three front org_request_queue.sh (provisioning — "seat me an agent"); three
// front capability_gate.sh (capabilities — "hand me a token / an access").
//
// FIVE ARE WRITES AND ONE IS A READ, and the read is not a rounding error in
// that count: an agent principal has no shell on this host, so a surface of
// writes alone makes the decision record write-only to the very party the
// decision is about. See read_my_requests.
//
// Each tool carries a `script` field naming which CLI it forwards to; the
// handler picks the runner and the arg-builder from it, and a tool with no
// matching arm fails loudly rather than silently reaching the wrong script.
//
// The two scripts are SIBLINGS that differ in the only place that matters —
// WHO DECIDES. Provisioning derives authority from the delegation ceiling;
// capabilities from ownership of the domain plus a second custody key. Neither
// authority rule is duplicated here: this file is authentication and input
// hygiene, and the decision lives in the script. See capability_gate.sh's
// header for why the third (countersign) key exists.
// ---------------------------------------------------------------------------

/**
 * The three safer-alternative arguments (first added to the queue, then
 * extended to the capability gate), declared once and reused by every tool
 * that fronts a DECISION rather than a request.
 *
 * SHARED, NOT COPIED, for the same reason the shell side factored the gate
 * functions into one library instead of duplicating them: two copies of a decision surface become two
 * surfaces, and the divergence is invisible from either side. Here the copy
 * would also be caught mechanically — ci.yml's mutation gate requires each of
 * its needles to match `mcp/org-request-mcp.mjs` EXACTLY once, so a second
 * pasted copy of the argv-building block turns that gate red rather than blind.
 *
 * Only the approve-side clause differs, because only the approve-side RULE
 * differs: the queue reads a template's permission keys, `review` reads the
 * capability registry's class, and `countersign` is risky by construction.
 */
// The approve-side clause for each of the three decision tools, NAMED rather
// than inlined so that each call site below is a distinct single line. That is
// not cosmetic: ci.yml's mutation gate requires every needle to match this file
// exactly once, and two identical `...saferAlternativeProperties(` lines could
// not be mutated independently — the gate would silently report on whichever
// one came first, which is the blindness the uniqueness check in the mutation
// gate exists to catch. Same reason the capability-requester needle carries a leading space.
const RISKY_TEMPLATE_CLAUSE = "Required when the requested template is risky.";
const RISKY_CAPABILITY_CLAUSE =
  "Required when the requested capability is risky — class credential, spend or publish, derived "
  + "from the registry and never declared by the caller.";
const RISKY_COUNTERSIGN_CLAUSE =
  "ALWAYS required on an approval. A countersignature only ever hands over a credential, so there "
  + "is no routine branch — the record is unconditional.";

function saferAlternativeProperties(approveClause) {
  return {
    alternatives: {
      type: "array",
      maxItems: 10,
      items: { type: "string", maxLength: 4000 },
      description:
        "REJECT only. Safer routes that still FULLY unblock the requester's work. A denial must carry at "
        + "least one of these or `no_safer_alternative`. These reach the requester, so write them as "
        + "instructions someone can act on, not as categories.",
    },
    no_safer_alternative: {
      type: "string",
      maxLength: 4000,
      description:
        "REJECT only, and mutually exclusive with `alternatives`. The explicit finding that nothing safer "
        + "would unblock this work — what you considered and why none of it works. On a risky ask this "
        + "becomes an OPEN audit item until an independent auditor closes it.",
    },
    alternatives_considered: {
      type: "array",
      maxItems: 10,
      description:
        "APPROVE only. " + approveClause + " Each entry is a safer route you "
        + "weighed and the reason it did not fully unblock the work. This is the record the owner audits.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["alternative", "why_it_failed"],
        properties: {
          alternative:    { type: "string", maxLength: 4000, description: "The safer route you weighed." },
          why_it_failed:  { type: "string", maxLength: 4000, description: "Why it did not fully unblock the work." },
        },
      },
    },
  };
}

export const TOOLS = [
  {
    script: "queue",
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
    script: "queue",
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
        // SAFER-ALTERNATIVE-FIRST. These are not optional extras: the
        // queue REFUSES a denial that carries neither `alternatives` nor
        // `no_safer_alternative`, and refuses to grant a risky template without
        // `alternatives_considered`. They are declared here because this
        // transport enforces its own inputSchema — a key it does not declare is
        // refused, not dropped — so omitting them would leave every agent
        // reviewer hitting a refusal it had no way to satisfy. Fail-closed, but
        // a hard block on the only sanctioned agent path to the queue.
        ...saferAlternativeProperties(RISKY_TEMPLATE_CLAUSE),
      },
    },
  },

  // -------------------------------------------------------------------------
  // The READ. Every other tool on this transport is a write, and for
  // an agent principal that made the decision record write-only.
  //
  // The premise of this transport is that an agent has no shell on the queue
  // host. So before this tool, `review_provisioning_request`'s own schema could
  // promise that a reason is "recorded in the grant log and readable by the
  // requester, who may answer it" while no tool on this transport could read
  // it. Deny-with-reason was, over this door, a conversation with one speaker:
  // the denial reason, the approval and its seated agent id, and the expiry
  // were not merely undelivered but UNREACHABLE.
  //
  // TWO PROPERTIES THIS TOOL MUST KEEP, both from the design decision that
  // introduced the read:
  //
  //   1. READING IS NOT ACKING. There is no ack in the queue and this tool
  //      introduces none. A requester that never calls it cannot hold a request
  //      open, and calling it grants nobody anything — so acking can never
  //      become a precondition in the decision path.
  //   2. DELIVERY IS NOT A SECURITY CONTROL. This reads a record that already
  //      exists. It cannot block, alter, delay or re-target a decision: the
  //      only subcommand it can reach is `inbox`, which appends no decision row
  //      of any kind. (`inbox` does materialise elapsed expiry, exactly as
  //      `list` has always done — a DERIVED fact the queue's request_state()
  //      already computes whether or not it is written down, so it changes no
  //      outcome for anyone. See reap_expired's own header.)
  //
  // NO ARGUMENTS AT ALL, which is the strongest available form of "identity is
  // never a tool argument": the selector is the authenticated agent id and the
  // schema offers the model nothing to fill in, so there is no shape this call
  // can take that reads somebody else's decisions.
  // -------------------------------------------------------------------------
  {
    script: "queue",
    name: "read_my_requests",
    description:
      "Read the decisions on YOUR OWN provisioning requests — approved, rejected, expired or failed — each with "
      + "the reviewer's reason, the safer alternatives they offered, and what you can do next. You are identified "
      + "automatically by the Paperclip tool gateway: this tool takes NO arguments, so there is no way to read "
      + "another agent's decisions and no way to ask for anything but your own. A request you submitted that is "
      + "not listed here has not been decided yet. Reading is not acknowledging — calling this holds nothing "
      + "open, closes nothing, and changes no decision.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [],
      // Deliberately empty, and asserted empty by the suite. A property here
      // would be the only way this tool could ever be pointed at a principal
      // other than the caller, so adding one has to be a visible edit that
      // turns a named test red rather than a quiet convenience.
      properties: {},
    },
  },

  // -------------------------------------------------------------------------
  // Capability gate (capability_gate.sh). Three tools, mirroring the
  // gate's three commands. The risk class is DERIVED FROM THE REGISTRY, never
  // supplied here — there is no --risk field to declare and no way to assert an
  // ask is routine. The requester supplies FACTS and REASONING; the registry
  // supplies the CLASS; the gate keeps them apart. This transport supplies the
  // PRINCIPAL, from the authenticated session, on every call.
  // -------------------------------------------------------------------------
  {
    script: "capability",
    name: "submit_capability_request",
    description:
      "Ask for a CAPABILITY you do not hold — a credential, an access, an org action — stating the facts and the "
      + "reasoning. You are identified automatically by the Paperclip tool gateway; there is no way to ask on "
      + "another agent's behalf. The risk class is derived from the capability registry, never from your request: "
      + "there is no way to declare an ask routine, reversible, or owner-reserved. The gate routes it to the "
      + "domain owner (and, for a credential, a custodian second key) or, for a reserved matter, stops it for the "
      + "owner. Returns the request id (CAP-nnn) and who decides.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["capability", "action", "facts", "reasoning"],
      properties: {
        capability: {
          type: "string",
          description: "The capability key as the registry names it, e.g. github.token or omniroute.key.self.",
          pattern: CAPABILITY_KEY_RE.source,
          maxLength: 128,
        },
        action: {
          type: "string",
          description: "What you want to do with it, e.g. read, create, rotate, delete.",
          pattern: CAPABILITY_ACTION_RE.source,
          maxLength: 64,
        },
        facts: {
          type: "string",
          description:
            "What is TRUE — what you tried, what failed, what you measured. Audited later, so state it so someone "
            + "who was not there can check it. The gate enforces a minimum length.",
          maxLength: 8000,
        },
        reasoning: {
          type: "string",
          description: "WHY this capability unblocks the work. The gate enforces a minimum length.",
          maxLength: 8000,
        },
        title: { type: "string", description: "Short title for the ask.", maxLength: 200 },
      },
    },
  },
  {
    script: "capability",
    name: "review_capability_request",
    description:
      "Decide a pending capability request as its DOMAIN OWNER — the first of up to two keys. You are identified "
      + "automatically by the Paperclip tool gateway; there is no way to decide as another agent, and authority is "
      + "re-derived from live state, so a request is refused unless you own its domain and you can never decide "
      + "your own request. For a credential this approval moves the request to awaiting_custody, where a different "
      + "custodian must countersign; for a non-credential it is the only key. Every decision carries a reason, an "
      + "approval as much as a denial.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["request_id", "decision", "reason"],
      properties: {
        request_id: { type: "string", description: "The request to decide, e.g. CAP-nnn.", pattern: CAP_REQUEST_ID_RE.source },
        decision: { type: "string", enum: ["approve", "reject"], description: "The decision. Decisions are final." },
        reason: {
          type: "string",
          description: "Why. Recorded in the grant log and readable by the requester. Required for approvals too.",
          maxLength: 8000,
        },
        // Without these the gate is UNREACHABLE through this transport
        // on every path but one: `capability_gate.sh` refuses a denial that
        // carries neither `alternatives` nor `no_safer_alternative`, and
        // refuses to grant a risky ask — class credential, spend or publish —
        // without `alternatives_considered`. Measured against the real gate:
        // approve-non-risky was the only one of five decision paths that got
        // through. A schema this server enforces (`additionalProperties: false`
        // is real here, not a claim) is a schema an agent cannot work around,
        // so an undeclared argument is not an inconvenience — it is a closed
        // door with no handle on the agent's side.
        ...saferAlternativeProperties(RISKY_CAPABILITY_CLAUSE),
      },
    },
  },
  {
    script: "capability",
    name: "countersign_capability_request",
    description:
      "Countersign a capability request as its CUSTODIAN — the SECOND key, on a request the domain owner has "
      + "already approved (status awaiting_custody). You are identified automatically by the Paperclip tool "
      + "gateway; there is no way to countersign as another agent. Authority is re-derived from live state: you "
      + "are refused unless you hold custody of the credential, and you can be neither the requester nor the "
      + "domain owner — two keys means two principals. Every decision carries a reason.\n\n"
      + "TRANSPORT LIMIT, STATED PLAINLY: this server authenticates each call independently, so it makes 'one "
      + "shell typed both --reviewer and --custodian' impossible. It does NOT make the two authenticated agents "
      + "two INDEPENDENT principals — on this host a run's gateway credential is readable by any same-uid run, so "
      + "one actor can drive two corroborated sessions. The custody key is an organizational control on an absent "
      + "technical boundary until per-run credential isolation lands. Say so in the record; do not read two rows "
      + "as two keys.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["request_id", "decision", "reason"],
      properties: {
        request_id: { type: "string", description: "The request to countersign, e.g. CAP-nnn.", pattern: CAP_REQUEST_ID_RE.source },
        decision: { type: "string", enum: ["approve", "reject"], description: "The decision. Decisions are final." },
        reason: {
          type: "string",
          description: "Why. Recorded in the grant log alongside the domain owner's reason. Required for approvals too.",
          maxLength: 8000,
        },
        // This arm is the unconditional one. A countersignature
        // only ever runs on a custody request and custody is only ever reached
        // by class credential, so the ask is risky BY CONSTRUCTION: there is no
        // routine branch here, and an approval without the considered record is
        // refused every time, not sometimes.
        ...saferAlternativeProperties(RISKY_COUNTERSIGN_CLAUSE),
      },
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// WHAT THIS TRANSPORT ADVERTISES vs WHAT IT CAN RUN
//
// capabilityScript is optional, and makeScriptRunner fails closed when a
// capability tool reaches a server without one. That refusal is correct and it
// stays. But in an earlier version it was the ONLY control: tools/list
// advertised all six tools unconditionally, so every agent was shown three
// capability tools that could never run, and the agents' own instructions told
// them to route real asks through one. Every such ask died in a transport
// error the caller could not act on.
//
// A tool that is advertised and always fails is worse than one that is absent,
// because it consumes the attempt the instructions demand. So discovery is now
// derived from the SAME config the runner is bound to: a script binding with no
// configured path is not offered. The fail-closed runner is kept as defence in
// depth — these two must agree, and the suite pins that they do.
export function advertisedTools(cfg) {
  return TOOLS.filter((tool) => tool.script !== "capability" || Boolean(cfg.capabilityScript));
}

/**
 * Enforce the tool's own inputSchema: every key must be one it declares.
 *
 * The schemas say `additionalProperties: false`, but a schema is a CLAIM made
 * to the client — there is no JSON-Schema validator in this process and adding
 * one would mean an npm tree next to a container-capable operator account. So the
 * claim is enforced here instead, against the very same schema object that
 * tools/list hands out. Add a property to a schema and it is accepted
 * here; add it nowhere and it is refused. The two cannot drift.
 *
 * Refusing rather than dropping is the point. An unlisted key could never
 * reach the CLI either way — buildQueueArgs reads named arguments and nothing
 * else — but a silent drop lets a caller believe it acted as someone else
 * until it reads the audit log, which is the exact failure this whole file is
 * built to prevent. Whatever the caller thought it was saying, it must be told
 * we did not hear it.
 */
function assertKnownArguments(tool, args) {
  const declared = tool.inputSchema.properties;
  // Object.hasOwn, not `in`: `constructor` and `toString` are `in` every plain
  // object, so `in` would quietly admit exactly the keys a prototype-pollution
  // probe reaches for first.
  const unknown = Object.keys(args).find((key) => !Object.hasOwn(declared, key));
  if (unknown === undefined) return;
  // A tool may declare NO properties at all (read_my_requests), and "Accepted:"
  // followed by nothing reads as a truncated message rather than as the whole
  // answer. Say the actual thing: there is no argument to get right.
  const accepted = Object.keys(declared);
  throw new HttpError(
    400, "unknown_argument",
    `'${unknown}' is not an argument of ${tool.name}. This tool declares `
    + `additionalProperties: false and that is enforced, not merely advertised: an unrecognised key is `
    + "refused rather than dropped, so a caller is never left believing it said something this transport "
    + "never heard. "
    + (accepted.length === 0
      ? "This tool takes no arguments at all."
      : `Accepted: ${accepted.join(", ")}.`),
  );
}

/**
 * Refuse any argument that names a principal.
 *
 * Shared by both arg-builders so the rule lives in ONE place: `--requester`,
 * `--reviewer` and `--custodian` are ALL written from the authenticated
 * principal, and a tool argument by any of those names is the attack this whole
 * file exists to stop. Specific before general — assertKnownArguments would
 * also refuse these as undeclared keys, but only this refusal names the rule
 * that makes them interesting, so the audit log can tell `requester` (someone
 * trying to be somebody else) apart from `templat` (a typo).
 */
function assertNoIdentityArgument(args) {
  const bad = Object.keys(args).find((key) => FORBIDDEN_ARGUMENT_NAMES.has(key));
  if (bad) {
    throw new HttpError(
      400, "identity_argument_refused",
      `'${bad}' is not an argument of this tool. Identity is taken from the authenticated Paperclip principal `
      + "and can never be supplied as tool input; an identity the model can fill in voids every authorization "
      + "check below this transport.",
    );
  }
}

/**
 * Append the safer-alternative-first arguments to a decision's argv.
 *
 * Passed through to the CLI, which is where the RULE lives. Nothing here
 * decides whether a decision is allowed: this transport validates SHAPE
 * (string, length, pairing) and the script validates POLICY (a denial needs
 * one of the two, a risky grant needs the considered list). Re-implementing
 * the policy here would give the script two enforcement points that can
 * disagree, and the one an agent reaches would be the weaker of the two.
 *
 * Values are never interpolated into a shell — execFile takes this argv
 * array directly — so an entry beginning with `--` is consumed as the value
 * of the flag that precedes it, not as a flag of its own.
 *
 * SHARED by the queue's `review` and the capability gate's `review` and
 * `countersign`. The two scripts parse these flags with the same
 * five functions out of lib/reqrecord.sh — they were factored there rather
 * than copied — so the transport side is factored to match. One shape,
 * one place, whichever door the decision arrives at.
 */
function appendSaferAlternativeArgs(argv, args) {
  for (const alternative of optionalStringArrayArg(args, "alternatives", 10, 4000)) {
    argv.push("--alternative", alternative);
  }
  const noSafer = optionalStringArg(args, "no_safer_alternative", null, 4000);
  if (noSafer) argv.push("--no-safer-alternative", noSafer);

  // The pair is emitted ADJACENTLY because the CLI requires it: `--because`
  // must immediately follow its `--considered`. Building the argv from one
  // list of objects is what makes a mismatched pairing unrepresentable rather
  // than merely discouraged — two parallel arrays over the wire could arrive
  // at different lengths and silently pair alternative 1 with reason 2.
  const considered = args.alternatives_considered;
  if (considered !== undefined && considered !== null) {
    if (!Array.isArray(considered)) {
      throw new HttpError(400, "invalid_argument", "'alternatives_considered' must be an array");
    }
    if (considered.length > 10) {
      throw new HttpError(400, "invalid_argument", "'alternatives_considered' accepts at most 10 entries");
    }
    considered.forEach((entry, index) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new HttpError(400, "invalid_argument",
          `'alternatives_considered[${index}]' must be an object with 'alternative' and 'why_it_failed'`);
      }
      // Same rule as assertKnownArguments, one level down: the nested schema
      // also says additionalProperties:false, and that claim is enforced here
      // because nothing else walks into the array to enforce it.
      const unknown = Object.keys(entry).find((key) => key !== "alternative" && key !== "why_it_failed");
      if (unknown !== undefined) {
        throw new HttpError(400, "unknown_argument",
          `'${unknown}' is not a field of alternatives_considered[${index}]. Accepted: alternative, why_it_failed.`);
      }
      const alternative = requireStringArg(entry, "alternative", null, 4000);
      const whyItFailed = requireStringArg(entry, "why_it_failed", null, 4000);
      argv.push("--considered", alternative, "--because", whyItFailed);
    });
  }
  return argv;
}

/**
 * Translate validated tool arguments into an argv array for the queue script.
 *
 * The identity arguments are supplied HERE, from the authenticated principal,
 * and are structurally unreachable from the tool input. That is the whole
 * point of this function: `--requester` and `--reviewer` are written by the
 * server, from a header the caller cannot set, every single time.
 */
export function buildQueueArgs(toolName, args, identity) {
  const tool = TOOLS_BY_NAME.get(toolName);
  if (!tool) {
    throw new HttpError(400, "unknown_tool", `unknown tool: ${toolName}`);
  }

  assertNoIdentityArgument(args);
  assertKnownArguments(tool, args);

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
    appendSaferAlternativeArgs(argv, args);
    return argv;
  }

  if (toolName === "read_my_requests") {
    // `--for` is the AUTHENTICATED principal, written here exactly as
    // `--requester` is on submit. An inbox selector the model could fill in is
    // a way to read another agent's decisions, so there is none: this tool
    // declares no arguments, `args` is unread, and the subcommand is a literal.
    // `inbox` and not `list` — `list` shows every request in the company.
    return ["inbox", "--for", identity.agentId];
  }

  // Unreachable while TOOLS_BY_NAME and the arms above agree. It is here so
  // that adding a tool to TOOLS and forgetting its arm fails loudly instead of
  // returning undefined into execFile.
  throw new HttpError(400, "unknown_tool", `unknown tool: ${toolName}`);
}

/**
 * Translate validated tool arguments into an argv array for capability_gate.sh.
 *
 * Same contract as buildQueueArgs, one CLI over. The principal is written HERE
 * from the authenticated session as `--requester` / `--reviewer` / `--custodian`
 * and is structurally unreachable from tool input. capability_gate.sh's own
 * submit REFUSES `--risk`/`--reversible`/`--reviewer` etc., so even a future
 * regression here that tried to forward a class or a decider would be refused
 * by the script — but the transport does not offer the model any such field in
 * the first place.
 */
export function buildCapabilityArgs(toolName, args, identity) {
  const tool = TOOLS_BY_NAME.get(toolName);
  if (!tool) {
    throw new HttpError(400, "unknown_tool", `unknown tool: ${toolName}`);
  }

  assertNoIdentityArgument(args);
  assertKnownArguments(tool, args);

  if (toolName === "submit_capability_request") {
    const capability = requireStringArg(args, "capability", CAPABILITY_KEY_RE, 128);
    const action = requireStringArg(args, "action", CAPABILITY_ACTION_RE, 64);
    const facts = requireStringArg(args, "facts", null, 8000);
    const reasoning = requireStringArg(args, "reasoning", null, 8000);
    // --requester is the authenticated principal, never an argument. The gate
    // resolves it as an agent id (resolve_agent matches a.id::text as well as
    // an orgRoleId), exactly as the queue does.
    const argv = [
      "submit", "--requester", identity.agentId,
      "--capability", capability, "--action", action,
      "--facts", facts, "--reasoning", reasoning,
    ];
    const title = optionalStringArg(args, "title", null, 200);
    if (title) argv.push("--title", title);
    return argv;
  }

  if (toolName === "review_capability_request") {
    const requestId = requireStringArg(args, "request_id", CAP_REQUEST_ID_RE);
    const decision = requireStringArg(args, "decision", /^(approve|reject)$/);
    const reason = requireStringArg(args, "reason", null, 8000);
    const argv = [
      "review", "--reviewer", identity.agentId, "--request", requestId,
      decision === "approve" ? "--approve" : "--reject",
      "--reason", reason,
    ];
    return appendSaferAlternativeArgs(argv, args);
  }

  if (toolName === "countersign_capability_request") {
    const requestId = requireStringArg(args, "request_id", CAP_REQUEST_ID_RE);
    const decision = requireStringArg(args, "decision", /^(approve|reject)$/);
    const reason = requireStringArg(args, "reason", null, 8000);
    const argv = [
      "countersign", "--custodian", identity.agentId, "--request", requestId,
      decision === "approve" ? "--approve" : "--reject",
      "--reason", reason,
    ];
    return appendSaferAlternativeArgs(argv, args);
  }

  // Unreachable while TOOLS_BY_NAME and the arms above agree. Same guard as
  // buildQueueArgs: a capability tool added to TOOLS without an arm here fails
  // loudly rather than returning undefined into execFile.
  throw new HttpError(400, "unknown_tool", `unknown tool: ${toolName}`);
}

// Route a tool to its arg-builder by the `script` field it declares. A tool
// that names a script with no builder is a programming error, not a caller
// error, so it throws a 500-class fault rather than a refusal.
export function buildArgsForTool(toolName, args, identity) {
  const tool = TOOLS_BY_NAME.get(toolName);
  if (!tool) {
    throw new HttpError(400, "unknown_tool", `unknown tool: ${toolName}`);
  }
  if (tool.script === "capability") return buildCapabilityArgs(toolName, args, identity);
  if (tool.script === "queue") return buildQueueArgs(toolName, args, identity);
  throw new Error(`tool ${toolName} declares no known script binding`);
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

// An optional array of strings, validated element by element. Returns [] when
// absent, so callers can iterate unconditionally. Bounded on BOTH axes: an
// unbounded array is an unbounded argv, and execve has a hard limit that would
// surface as an opaque E2BIG from the CLI rather than as an argument error here.
function optionalStringArrayArg(args, name, maxItems, maxLength) {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(400, "invalid_argument", `'${name}' must be an array of strings`);
  }
  if (value.length > maxItems) {
    throw new HttpError(400, "invalid_argument", `'${name}' accepts at most ${maxItems} entries`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new HttpError(400, "invalid_argument", `'${name}[${index}]' must be a non-empty string`);
    }
    return checkStringArg(`${name}[${index}]`, entry, null, maxLength);
  });
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

// A runner for ONE CLI. The queue and the capability gate each get their own
// (they are separate append-only JSONL files, so each serialises against its
// own next-id race and not the other's). The environment is built ONCE here so
// there is a single place a config could ever misdirect tenancy — the queueEnv
// ordering guarantee below is not duplicated per script.
export function makeScriptRunner(scriptPath, cfg, exec = execFileAsync) {
  const serialize = makeSerializer();
  return function runScript(argv) {
    return serialize(async () => {
      if (!scriptPath) {
        // Fail closed: a capability tool reached a server that never configured
        // capabilityScript. Better an explicit refusal than execFile(undefined).
        return {
          ok: false,
          text: "this transport is not configured to front that script (capabilityScript is unset in its config)",
          exitCode: null,
        };
      }
      try {
        const { stdout, stderr } = await exec(scriptPath, argv, {
          timeout: CLI_TIMEOUT_MS,
          maxBuffer: CLI_MAX_BUFFER,
          // A deliberately minimal environment. The parent process holds
          // nothing the queue needs, and inheriting an environment wholesale is
          // how a credential ends up somewhere nobody expected it.
          //
          // queueEnv is spread FIRST, so the values this server owns are
          // written last and win. normalizeConfig already refuses a config that
          // names one of them; this ordering is what still holds for a cfg
          // object built by hand, and it is one line. A config file must never
          // be able to tell the queue it is a different company.
          env: {
            ...cfg.queueEnv,
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: process.env.HOME ?? "/",
            COMPANY_ID: cfg.companyId,
            PAPERCLIP_DB_CTR: cfg.dbContainer,
            CONTAINER_ENGINE: containerEngineFor(cfg),
          },
        });
        return { ok: true, text: (stdout + stderr).trim(), exitCode: 0 };
      } catch (error) {
        // The scripts' refusals are exit 2 with "REFUSED: ..." on stderr. Those
        // are a legitimate ANSWER, not a transport failure: the caller needs to
        // read them. Surface as an MCP tool error so the model sees the reason.
        const text = [error.stdout ?? "", error.stderr ?? ""].join("").trim();
        return {
          ok: false,
          text: text || `the request script failed: ${error.message}`,
          exitCode: typeof error.code === "number" ? error.code : null,
        };
      }
    });
  };
}

// Back-compat wrapper: the queue runner is a script runner bound to queueScript.
// Kept as a named export because the suite and deps injection reference it.
export function makeQueueRunner(cfg, exec = execFileAsync) {
  return makeScriptRunner(cfg.queueScript, cfg, exec);
}

// The capability runner, bound to capabilityScript (which may be null; the
// runner fails closed in that case).
export function makeCapabilityRunner(cfg, exec = execFileAsync) {
  return makeScriptRunner(cfg.capabilityScript, cfg, exec);
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
  const runCapability = deps.runCapability ?? makeCapabilityRunner(cfg);
  const corroborateRun = deps.corroborateRun ?? makeRunCorroborator(cfg);
  const audit = deps.audit ?? makeAuditor(cfg);
  // Pick the runner by the tool's declared script binding. Kept beside the
  // dispatch so a new script binding is one line in two places, not a switch
  // scattered through the handler.
  const runnerFor = (tool) => (tool.script === "capability" ? runCapability : runQueue);

  async function handleRpc(message, req) {
    const { id, method, params } = message;

    if (method === "initialize") {
      const requested = params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Every tool acts as YOU. Identity comes from the Paperclip tool gateway and is never an argument. "
          + "Provisioning authority is decided by org_request_queue.sh and capability authority by "
          + "capability_gate.sh, not by this transport.",
      });
    }

    if (method === "ping") return rpcResult(id, {});

    // Anonymous by necessity — this is the gateway's catalog refresh and health
    // check, which carries credentials but no session. See the file header.
    if (method === "tools/list") return rpcResult(id, { tools: advertisedTools(cfg) });

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments ?? {};
      if (!isPlainObject(args)) {
        throw new HttpError(400, "invalid_argument", "params.arguments must be an object");
      }
      const tool = TOOLS_BY_NAME.get(toolName);
      if (!tool) {
        // Named explicitly so nobody reads a typo as a missing capability, and
        // so an attempt to reach anything else is recorded rather than guessed.
        throw new HttpError(
          400, "unknown_tool",
          `unknown tool '${toolName}'. This transport exposes: `
          + advertisedTools(cfg).map((t) => t.name).join(", ")
          + ". There is no tool that runs the provisioner or effects a grant; the queue and the gate are the only "
          + "entry points, and they DECIDE — they do not GRANT.",
        );
      }

      // Identity is established AFTER the tool is known and BEFORE anything
      // runs. Ordering matters: an unknown tool must not consume a database
      // round trip, and a known tool must never execute without a principal.
      const identity = readIdentityHeaders(req.headers, cfg);
      await corroborateRun(identity);

      const argv = buildArgsForTool(toolName, args, identity);
      const started = Date.now();
      const result = await runnerFor(tool)(argv);
      audit({
        event: "tool.call",
        tool: toolName,
        agentId: identity.agentId,
        runId: identity.runId,
        correlationId: identity.correlationId,
        // Keys only. Values live in the script's own log, which is authoritative.
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
  // Only assert the capability script's basename when one is configured. A
  // deployment fronting only the provisioning queue leaves it null, and the
  // handler fails closed if a capability tool is nonetheless called.
  if (cfg.capabilityScript) assertCapabilityScript(cfg.capabilityScript);

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
    capabilityScript: cfg.capabilityScript,
    requireLiveRun: cfg.requireLiveRun,
    tools: advertisedTools(cfg).map((tool) => tool.name),
    // Loud on the line the operator actually reads. An install that meant to
    // front the gate and left capabilityScript unset is a silent three-tool
    // hole otherwise — advertised-but-unrunnable tools went unnoticed for days
    // before this line existed.
    capabilityToolsAdvertised: Boolean(cfg.capabilityScript),
  }) + "\n");
  if (!cfg.capabilityScript) {
    process.stdout.write(JSON.stringify({
      ts: new Date().toISOString(),
      event: "capability_tools_withheld",
      reason: "capabilityScript is unset in " + configPath + ", so the three capability tools are NOT advertised. "
        + "Agents will not see them rather than seeing tools that always fail. If this deployment is meant to front "
        + "the capability gate, set capabilityScript to capability_gate.sh and restart.",
    }) + "\n");
  }

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
