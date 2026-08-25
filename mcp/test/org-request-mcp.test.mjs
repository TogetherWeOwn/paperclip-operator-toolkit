// ===========================================================================
// org-request-mcp regression suite — TOG-196.
//
// WHAT THIS SUITE IS FOR
//   Every non-negotiable in the issue is an assertion here, and the DoD test
//   the epic asked for is `submit called with requester: "O1" by an agent that
//   is not O1 records against the AUTHENTICATED principal` — see the
//   "identity is not an argument" block.
//
//   The suite runs fully offline: a stub queue script that records its argv, a
//   stubbed run corroborator, and a real HTTP server on 127.0.0.1. No podman,
//   no database, no company. That is a deliberate design constraint on the
//   server, not a convenience: a transport whose refusals can only be tested
//   against production is a transport whose refusals are not tested.
//
// TEST SEAM DISCIPLINE
//   Where a control depends on a credential or an identity, the test supplies
//   a FAKE one rather than omitting it. Omitting the input tests a different
//   code path from the one that ships, and a suite that passes because the
//   input was missing passes against the bug too.
// ===========================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TOOLS,
  normalizeConfig,
  assertConfigPermissions,
  assertQueueScript,
  assertCapabilityScript,
  bearerMatches,
  readIdentityHeaders,
  buildQueueArgs,
  buildCapabilityArgs,
  buildArgsForTool,
  makeQueueRunner,
  makeCapabilityRunner,
  makeRunCorroborator,
  createServer,
  HttpError,
  _resetRunCheckCache,
} from "../org-request-mcp.mjs";

// --- fixtures --------------------------------------------------------------

const BEARER = "test-bearer-not-a-real-credential";
const BEARER_SHA = createHash("sha256").update(BEARER, "utf8").digest("hex");

const COMPANY = "00000000-0000-4000-8000-000000000000";
const CALLER = "6a02a7ed-c2f9-4638-bd44-b453c589cbb1";  // the agent actually calling
const VICTIM = "70f9e158-e8c6-4be4-bc0f-6ad5770a3f44";  // the agent it will try to be
const RUN = "11111111-2222-3333-4444-555555555555";

function scratch() {
  return mkdtempSync(path.join(tmpdir(), "org-mcp-test-"));
}

// A stub org_request_queue.sh. It must be NAMED that: the server refuses to
// front anything else, and a stub called something else would test around it.
function stubQueue(dir, body) {
  const file = path.join(dir, "org_request_queue.sh");
  writeFileSync(
    file,
    body ?? `#!/bin/sh
# Record argv one-per-line so a test can assert on exact argument boundaries
# rather than on a joined string, where an injected space would hide.
: > "$(dirname "$0")/argv.txt"
for a in "$@"; do printf '%s\\n' "$a" >> "$(dirname "$0")/argv.txt"; done
printf 'COMPANY_ID=%s\\n' "$COMPANY_ID" > "$(dirname "$0")/env.txt"
env | grep -c BEARER >> "$(dirname "$0")/env.txt" 2>/dev/null || true
echo "SUBMITTED REQ-001"
`,
    { mode: 0o700 },
  );
  return file;
}

function recordedArgv(dir) {
  const file = path.join(dir, "argv.txt");
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
}

// A stub capability_gate.sh — same discipline as stubQueue. It MUST be named
// capability_gate.sh (the server refuses to front anything else), and it
// records to cap-argv.txt so a config that stages BOTH stubs in one dir can
// tell which script a call reached — that is how the routing test proves a
// capability tool never lands on the queue and vice versa.
function stubCapability(dir, body) {
  const file = path.join(dir, "capability_gate.sh");
  writeFileSync(
    file,
    body ?? `#!/bin/sh
: > "$(dirname "$0")/cap-argv.txt"
for a in "$@"; do printf '%s\\n' "$a" >> "$(dirname "$0")/cap-argv.txt"; done
echo "SUBMITTED CAP-001"
`,
    { mode: 0o700 },
  );
  return file;
}

function recordedCapArgv(dir) {
  const file = path.join(dir, "cap-argv.txt");
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
}

// A config fronting a stub capability_gate.sh (and the queue stub, since
// queueScript is required). Used by the transport-contract tests, which assert
// what reaches the CLI without needing the real gate's org resolution.
function capabilityConfigFor(dir, { queueBody, capabilityBody, ...overrides } = {}) {
  return normalizeConfig({
    companyId: COMPANY,
    bearerSha256: BEARER_SHA,
    queueScript: stubQueue(dir, queueBody),
    capabilityScript: stubCapability(dir, capabilityBody),
    requireLiveRun: false,
    ...overrides,
  });
}

// The REAL capability_gate.sh, two directories up from this test. The
// end-to-end acceptance drives it — not a stub — so the two-key record is
// produced by the same code an operator runs.
//
// The CI mutation harness copies ONLY mcp/ into a staging dir and runs this
// suite there, so the sibling gate is absent in that copy. The real-gate
// acceptance skips when it is missing rather than failing the baseline — the
// SAME assertions run for real in the primary `mcp-suite` job, where the whole
// repo is checked out. The three capability mutations are caught by the
// stub-based section-8 tests, which need no sibling file, so this skip does not
// blind any mutation guard.
const REAL_CAPABILITY_GATE = fileURLToPath(new URL("../../capability_gate.sh", import.meta.url));
const GATE_PRESENT = existsSync(REAL_CAPABILITY_GATE);
const skipIfNoGate = GATE_PRESENT
  ? false
  : "capability_gate.sh absent in this staging copy; the real-gate acceptance runs in the primary mcp-suite job";

// `queueBody` rather than a `queueScript` override: both stubs write to the
// same filename (they must — the server refuses to front anything not called
// org_request_queue.sh), so an override evaluated by the caller gets silently
// overwritten by the default written here. That ordering trap cost a test its
// assertion once already.
function configFor(dir, { queueBody, ...overrides } = {}) {
  return normalizeConfig({
    companyId: COMPANY,
    bearerSha256: BEARER_SHA,
    queueScript: stubQueue(dir, queueBody),
    // No `port` here on purpose: withServer listens on an ephemeral loopback
    // port of its own, and a config port of 0 is exactly the misconfiguration
    // normalizeConfig is supposed to reject.
    requireLiveRun: false,
    ...overrides,
  });
}

const IDENTITY_HEADERS = {
  "x-paperclip-agent-id": CALLER,
  "x-paperclip-company-id": COMPANY,
  "x-paperclip-run-id": RUN,
};

// Start the real HTTP server on an ephemeral loopback port and talk to it over
// the wire. In-process assertions on exported helpers are useful, but the
// controls that matter are the ones a request actually traverses.
async function withServer(cfg, deps, fn) {
  const server = createServer(cfg, deps);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const call = async (bodyObj, headers = {}, method = "POST") => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${BEARER}`,
        ...headers,
      },
      body: method === "POST" ? JSON.stringify(bodyObj) : undefined,
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null };
  };
  try {
    await fn(call, port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const rpc = (method, params, id = 1) => ({ jsonrpc: "2.0", id, method, params });

// ===========================================================================
// 1. Identity is not an argument.  ← the epic's definition-of-done test
// ===========================================================================

test("DoD: a forged requester argument never becomes the recorded requester", async () => {
  const dir = scratch();
  await withServer(configFor(dir), {}, async (call) => {
    const response = await call(
      rpc("tools/call", {
        name: "submit_provisioning_request",
        // The attack, verbatim from the epic: the caller names someone else.
        arguments: { requester: VICTIM, template: "E4_AUDIT_ANALYST", title: "audit analyst" },
      }),
      IDENTITY_HEADERS,
    );

    assert.equal(response.status, 200);
    assert.equal(response.json.result.isError, true, "a forged requester must be refused, not accepted");
    assert.match(response.json.result.content[0].text, /identity_argument_refused/);
    // Refused LOUDLY. A silent drop would let the caller believe it had acted
    // as the victim until it read the log.
    assert.match(response.json.result.content[0].text, /never be supplied as tool input/);
    // And the queue was never reached at all.
    assert.equal(recordedArgv(dir), null, "the queue script must not run for a refused call");
  });
});

test("DoD: the queue is invoked with the AUTHENTICATED principal as --requester", async () => {
  const dir = scratch();
  await withServer(configFor(dir), {}, async (call) => {
    const response = await call(
      rpc("tools/call", {
        name: "submit_provisioning_request",
        arguments: { template: "E4_AUDIT_ANALYST", title: "audit analyst" },
      }),
      IDENTITY_HEADERS,
    );
    assert.equal(response.json.result.isError, false, response.json.result.content?.[0]?.text);

    const argv = recordedArgv(dir);
    assert.deepEqual(argv, [
      "submit", "--requester", CALLER, "--template", "E4_AUDIT_ANALYST", "--title", "audit analyst",
    ]);
    // Explicit, because this is the property the whole epic rests on.
    assert.ok(!argv.includes(VICTIM), "the victim's id must appear nowhere in the argv");
  });
});

test("every identity-shaped argument name is refused by name, on both tools", () => {
  const identity = { agentId: CALLER, companyId: COMPANY, runId: RUN };
  const names = [
    "requester", "reviewer", "agent_id", "agentId", "reports_to", "reportsTo",
    "parent", "on_behalf_of", "author", "caller", "principal", "as", "impersonate",
  ];
  for (const name of names) {
    for (const tool of ["submit_provisioning_request", "review_provisioning_request"]) {
      const args = tool === "submit_provisioning_request"
        ? { template: "E4_AUDIT_ANALYST", title: "t", [name]: VICTIM }
        : { request_id: "REQ-001", decision: "approve", [name]: VICTIM };
      assert.throws(
        () => buildQueueArgs(tool, args, identity),
        (error) => error.code === "identity_argument_refused" && error.message.includes(`'${name}'`),
        `${tool} accepted an identity argument named '${name}'`,
      );
    }
  }
});

test("neither tool schema declares an identity property", () => {
  for (const tool of TOOLS) {
    for (const property of Object.keys(tool.inputSchema.properties)) {
      assert.ok(
        !/requester|reviewer|agent|company|run|parent|reports|author|caller|principal|behalf/i.test(property),
        `${tool.name} declares an identity-shaped property '${property}'`,
      );
    }
    // Without this, an unknown key would reach the CLI rather than be refused.
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} allows additional properties`);
  }
});

// A schema property that no arm of buildQueueArgs reads is the SAME failure as
// an unknown key, arriving from the other direction: the tool advertises it,
// the caller supplies it, and it goes nowhere. The fixture is asserted to cover
// exactly the declared keys, so adding a property to a schema and forgetting to
// consume it fails here rather than in production.
const EVERY_ARGUMENT = {
  submit_provisioning_request: {
    template: "E4_AUDIT_ANALYST", title: "audit analyst", rationale: "because", supersedes: "REQ-004",
  },
  review_provisioning_request: {
    request_id: "REQ-004", decision: "approve", reason: "fine",
    // TOG-388. These are policy-exclusive at the CLI — a denial cannot carry
    // both `alternatives` and `no_safer_alternative`, and an approval carries
    // neither — but buildQueueArgs deliberately enforces SHAPE and not POLICY,
    // so one fixture carrying all of them is the right way to prove that every
    // advertised property reaches the argv.
    alternatives: ["broker it instead"],
    no_safer_alternative: "nothing narrower reaches the connection API",
    alternatives_considered: [{ alternative: "read-only access", why_it_failed: "the drift is a write" }],
  },
  submit_capability_request: {
    capability: "github.token", action: "read",
    facts: "measured on 2026-08-25 that the run has no GH_APP binding",
    reasoning: "the audit cannot read check-runs without a token",
    title: "read a scoped github token",
  },
  review_capability_request: {
    request_id: "CAP-004", decision: "approve", reason: "the domain owner agrees",
  },
  countersign_capability_request: {
    request_id: "CAP-004", decision: "approve", reason: "custody agrees",
  },
};

// Every leaf string a fixture carries, in order. TOG-388 gave one tool array-
// and object-valued properties, and the flat `argv.includes(value)` this used
// to do would have compared an argv of strings against an Array and an Object
// — never equal, so the assertion would have failed for the wrong reason, or
// (had it been written with a truthiness guard) passed without checking
// anything. Flattening keeps the question the same: did every value the caller
// supplied actually reach the command line, or was some of it silently dropped?
function leafStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(leafStrings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(leafStrings);
  return [];
}

test("every property a schema advertises is actually read onto the argv", () => {
  const identity = { agentId: CALLER, companyId: COMPANY, runId: RUN };
  for (const tool of TOOLS) {
    const args = EVERY_ARGUMENT[tool.name];
    assert.ok(args, `${tool.name} has no EVERY_ARGUMENT fixture; a new tool was added without one`);
    assert.deepEqual(
      Object.keys(args).sort(),
      Object.keys(tool.inputSchema.properties).sort(),
      `${tool.name}: the advertised schema and this fixture disagree; one of them was changed alone`,
    );
    // Route through buildArgsForTool so each tool reaches the arg-builder for
    // the script it binds to — a capability tool must not be built as a queue
    // call, and vice versa.
    const argv = buildArgsForTool(tool.name, args, identity);
    for (const [name, value] of Object.entries(args)) {
      // `decision` is the one property that becomes a flag rather than a value.
      const expected = name === "decision" ? ["--approve"] : leafStrings(value);
      assert.ok(
        expected.length > 0,
        `${tool.name}: the fixture for '${name}' carries no string to look for, so this case checks nothing`,
      );
      for (const leaf of expected) {
        assert.ok(
          argv.includes(leaf),
          `${tool.name} advertises '${name}' but '${leaf}' never reaches the argv — it is silently dropped`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// TOG-388: the safer-alternatives arguments, and the one property of them that
// a flat "did it reach the argv" check cannot see.
//
// The CLI requires `--because` to IMMEDIATELY follow its `--considered`. If
// this transport emitted the alternatives and the reasons as two runs of flags,
// every value would still be present on the argv — the test above would pass —
// and the queue would pair alternative 1 with reason 2. That produces a record
// that is fully populated and entirely wrong, which is worse than a missing one
// because it reads as diligence. Adjacency is therefore asserted directly.
test("TOG-388: considered/because pairs reach the argv ADJACENTLY, never as two runs", () => {
  const identity = { agentId: CALLER, companyId: COMPANY, runId: RUN };
  const argv = buildQueueArgs("review_provisioning_request", {
    request_id: "REQ-009", decision: "approve", reason: "measured",
    alternatives_considered: [
      { alternative: "alt-one", why_it_failed: "why-one" },
      { alternative: "alt-two", why_it_failed: "why-two" },
    ],
  }, identity);
  const tail = argv.slice(argv.indexOf("--considered"));
  assert.deepEqual(tail, [
    "--considered", "alt-one", "--because", "why-one",
    "--considered", "alt-two", "--because", "why-two",
  ], "the pairs must interleave; two runs of flags would mis-pair every entry after the first");
});

test("TOG-388: a denial's alternatives and no-safer finding reach the argv", () => {
  const identity = { agentId: CALLER, companyId: COMPANY, runId: RUN };
  assert.deepEqual(
    buildQueueArgs("review_provisioning_request", {
      request_id: "REQ-010", decision: "reject", reason: "too broad",
      alternatives: ["narrower template", "broker the operation"],
    }, identity),
    ["review", "--reviewer", CALLER, "--request", "REQ-010", "--reject", "--reason", "too broad",
     "--alternative", "narrower template", "--alternative", "broker the operation"],
  );
  assert.deepEqual(
    buildQueueArgs("review_provisioning_request", {
      request_id: "REQ-011", decision: "reject", reason: "no route",
      no_safer_alternative: "every narrower grant leaves the work blocked",
    }, identity),
    ["review", "--reviewer", CALLER, "--request", "REQ-011", "--reject", "--reason", "no route",
     "--no-safer-alternative", "every narrower grant leaves the work blocked"],
  );
});

test("TOG-388: a malformed alternatives_considered entry is refused, not partially built", () => {
  const identity = { agentId: CALLER, companyId: COMPANY, runId: RUN };
  const build = (considered) => () => buildQueueArgs("review_provisioning_request", {
    request_id: "REQ-012", decision: "approve", reason: "r", alternatives_considered: considered,
  }, identity);
  // The nested schema also says additionalProperties:false, and nothing else
  // walks into the array to enforce that claim.
  assert.throws(build([{ alternative: "a", why_it_failed: "b", reviewer: "someone-else" }]), /not a field/);
  assert.throws(build([{ alternative: "a" }]), /required/);
  assert.throws(build([{ why_it_failed: "b" }]), /required/);
  assert.throws(build(["a string, not a pair"]), /must be an object/);
  assert.throws(build("not an array"), /must be an array/);
  assert.throws(build(Array.from({ length: 11 }, () => ({ alternative: "a", why_it_failed: "b" }))), /at most 10/);
});

test("TOG-388: a flag-shaped value in the new fields is refused, like every other free-text field", () => {
  // The transport's existing free-text rule — a value may not begin with '-' —
  // has to reach INSIDE the new array and object properties, not just the flat
  // string ones. It does, because they route through checkStringArg like
  // everything else; this pins that they were not given a private path around
  // it. Two layers agree here and the redundancy is deliberate: execFile takes
  // the argv array directly so nothing is re-parsed by a shell, and the CLI
  // consumes the token after each flag positionally — but relying on a
  // downstream parser's `shift 2` is a load-bearing assumption about someone
  // else's code, which is the reason the rule exists at all.
  const identity = { agentId: CALLER, companyId: COMPANY, runId: RUN };
  const build = (args) => () => buildQueueArgs("review_provisioning_request",
    { request_id: "REQ-013", decision: "reject", reason: "r", ...args }, identity);
  assert.throws(build({ alternatives: ["--approve"] }), /may not begin with '-'/);
  assert.throws(build({ no_safer_alternative: "--approve" }), /may not begin with '-'/);
  assert.throws(
    build({ alternatives_considered: [{ alternative: "--approve", why_it_failed: "b" }] }),
    /may not begin with '-'/,
  );
  assert.throws(
    build({ alternatives_considered: [{ alternative: "a", why_it_failed: "--approve" }] }),
    /may not begin with '-'/,
  );
  // And the NUL rule reaches in too — bash reads NUL-terminated argv, so an
  // embedded NUL would truncate the alternative the requester is meant to read.
  assert.throws(build({ alternatives: ["safe er"] }), /NUL byte/);
});

test("review is invoked with the authenticated principal as --reviewer", async () => {
  const dir = scratch();
  await withServer(configFor(dir), {}, async (call) => {
    await call(
      rpc("tools/call", {
        name: "review_provisioning_request",
        arguments: { request_id: "REQ-004", decision: "reject", reason: "no" },
      }),
      IDENTITY_HEADERS,
    );
    assert.deepEqual(recordedArgv(dir), [
      "review", "--reviewer", CALLER, "--request", "REQ-004", "--reject", "--reason", "no",
    ]);
  });
});

// ===========================================================================
// 2. Fail closed on identity. The opt-in trap is the whole reason this exists.
// ===========================================================================

test("tools/call with NO agent header is refused, and says how to fix the connection", async () => {
  const dir = scratch();
  await withServer(configFor(dir), {}, async (call) => {
    const response = await call(
      rpc("tools/call", {
        name: "submit_provisioning_request",
        arguments: { template: "E4_AUDIT_ANALYST", title: "t" },
      }),
      // A valid bearer and NO identity headers — precisely what a connection
      // registered the "obvious" way (url only) produces.
      {},
    );
    assert.equal(response.status, 403, "a missing principal must be a hard refusal, never an anonymous submit");
    assert.equal(response.json.error.code, "identity_header_missing");
    // The message has to name the actual fix, or the operator debugs the wrong
    // layer: the gateway forwards nothing by default and reports no error.
    assert.match(response.json.error.message, /headerPolicy\.metadata\.forward/);
    assert.equal(recordedArgv(dir), null);
  });
});

test("a non-uuid agent header is refused, so an org ROLE cannot ride the identity channel", async () => {
  const dir = scratch();
  await withServer(configFor(dir), {}, async (call) => {
    const response = await call(
      rpc("tools/call", {
        name: "submit_provisioning_request",
        arguments: { template: "E4_AUDIT_ANALYST", title: "t" },
      }),
      // The queue script resolves an org role id as readily as a uuid, so an
      // unvalidated header could name a ROLE and be honoured.
      { ...IDENTITY_HEADERS, "x-paperclip-agent-id": "P1_PRESIDENT_COO" },
    );
    assert.equal(response.status, 403);
    assert.equal(response.json.error.code, "identity_header_malformed");
    assert.equal(recordedArgv(dir), null);
  });
});

test("a missing run header is refused even when the agent header is present", async () => {
  const dir = scratch();
  await withServer(configFor(dir), {}, async (call) => {
    const response = await call(
      rpc("tools/call", { name: "submit_provisioning_request", arguments: { template: "E4_AUDIT_ANALYST", title: "t" } }),
      { "x-paperclip-agent-id": CALLER, "x-paperclip-company-id": COMPANY },
    );
    assert.equal(response.status, 403);
    assert.match(response.json.error.message, /run_id/);
  });
});

test("another tenant's gateway cannot reach this company's queue", async () => {
  const dir = scratch();
  await withServer(configFor(dir), {}, async (call) => {
    const response = await call(
      rpc("tools/call", { name: "submit_provisioning_request", arguments: { template: "E4_AUDIT_ANALYST", title: "t" } }),
      { ...IDENTITY_HEADERS, "x-paperclip-company-id": "00000000-0000-4000-8000-000000000000" },
    );
    assert.equal(response.status, 403);
    assert.equal(response.json.error.code, "wrong_company");
    assert.equal(recordedArgv(dir), null);
  });
});

test("readIdentityHeaders rejects a duplicated agent header rather than picking one", () => {
  // node lower-cases and, for most headers, joins duplicates. An array here
  // means the caller sent two; choosing either would be a guess.
  assert.throws(
    () => readIdentityHeaders(
      { "x-paperclip-agent-id": [CALLER, VICTIM], "x-paperclip-company-id": COMPANY, "x-paperclip-run-id": RUN },
      { companyId: COMPANY },
    ),
    (error) => error.code === "identity_header_missing",
  );
});

// ===========================================================================
// 3. Run corroboration — the control that makes a leaked bearer insufficient.
// ===========================================================================

test("a live RUNNING run for this agent corroborates the identity", async () => {
  _resetRunCheckCache();
  let sawSql = "";
  let sawEnv = null;
  const corroborate = makeRunCorroborator(
    { requireLiveRun: true, dbContainer: "paperclip-db" },
    async (file, args, options) => {
      sawSql = options.input;
      sawEnv = options.env;
      assert.equal(file, "podman");
      return { stdout: "1\n", stderr: "" };
    },
  );
  await corroborate({ agentId: CALLER, companyId: COMPANY, runId: RUN });

  assert.match(sawSql, /FROM heartbeat_runs/);
  // All three legs, or the check proves less than it appears to.
  assert.match(sawSql, /status = 'running'/);
  assert.match(sawSql, /agent_id = :'agent_id'/);
  assert.match(sawSql, /company_id = :'company_id'/);
  // Ids travel in the environment, never on a world-readable command line.
  assert.equal(sawEnv.PGV_AGENT_ID, CALLER);
  assert.equal(sawEnv.PGV_RUN_ID, RUN);
});

test("a run that is not RUNNING refuses the call", async () => {
  _resetRunCheckCache();
  const corroborate = makeRunCorroborator(
    { requireLiveRun: true, dbContainer: "paperclip-db" },
    async () => ({ stdout: "", stderr: "" }),  // no row
  );
  await assert.rejects(
    () => corroborate({ agentId: CALLER, companyId: COMPANY, runId: RUN }),
    (error) => error.status === 403 && error.code === "run_not_live",
  );
});

test("an unreachable database refuses rather than trusting the header alone", async () => {
  _resetRunCheckCache();
  const corroborate = makeRunCorroborator(
    { requireLiveRun: true, dbContainer: "paperclip-db" },
    async () => { throw new Error("podman: command not found"); },
  );
  // The tempting bug is to let this through "so the transport keeps working".
  // That converts an outage into an authentication bypass.
  await assert.rejects(
    () => corroborate({ agentId: CALLER, companyId: COMPANY, runId: RUN }),
    (error) => error.status === 503 && error.code === "run_check_unavailable",
  );
});

test("corroboration runs before the queue, and a failure keeps the CLI from running", async () => {
  _resetRunCheckCache();
  const dir = scratch();
  const cfg = configFor(dir, { requireLiveRun: true });
  await withServer(
    cfg,
    { corroborateRun: async () => { throw new HttpError(403, "run_not_live", "no live run"); } },
    async (call) => {
      const response = await call(
        rpc("tools/call", { name: "submit_provisioning_request", arguments: { template: "E4_AUDIT_ANALYST", title: "t" } }),
        IDENTITY_HEADERS,
      );
      assert.equal(response.status, 403);
      assert.equal(recordedArgv(dir), null, "the queue ran despite an uncorroborated identity");
    },
  );
});

// ===========================================================================
// 4. Transport credential.
// ===========================================================================

test("a request with no bearer is rejected before anything else is considered", async () => {
  const dir = scratch();
  await withServer(configFor(dir), {}, async (call) => {
    const response = await call(
      rpc("tools/call", { name: "submit_provisioning_request", arguments: { template: "E4_AUDIT_ANALYST", title: "t" } }),
      { ...IDENTITY_HEADERS, authorization: "" },
    );
    assert.equal(response.status, 401);
  });
});

test("a wrong bearer is rejected, and the 401 carries no WWW-Authenticate", async () => {
  const dir = scratch();
  await withServer(configFor(dir), {}, async (call) => {
    const response = await call(rpc("tools/list", {}), { authorization: "Bearer wrong" });
    assert.equal(response.status, 401);
    // Not cosmetic: the gateway reads `401` + a bearer/oauth WWW-Authenticate
    // as "go discover OAuth endpoints", which buries the real cause.
    assert.equal(response.headers.get("www-authenticate"), null);
  });
});

test("bearerMatches is exact and rejects prefixes, suffixes and the empty string", () => {
  assert.equal(bearerMatches(BEARER, BEARER_SHA), true);
  assert.equal(bearerMatches(BEARER + "x", BEARER_SHA), false);
  assert.equal(bearerMatches(BEARER.slice(0, -1), BEARER_SHA), false);
  assert.equal(bearerMatches("", BEARER_SHA), false);
  assert.equal(bearerMatches(undefined, BEARER_SHA), false);
});

test("the config stores a digest, and a raw token in that field is refused", () => {
  assert.throws(
    () => normalizeConfig({ companyId: COMPANY, bearerSha256: BEARER, queueScript: "/x/org_request_queue.sh" }),
    /sha256 hex digest/,
  );
});

test("a group- or world-readable config is refused at startup", () => {
  const dir = scratch();
  const file = path.join(dir, "config.json");
  writeFileSync(file, "{}");
  chmodSync(file, 0o644);
  assert.throws(() => assertConfigPermissions(file), /must be 0600/);
  chmodSync(file, 0o640);
  assert.throws(() => assertConfigPermissions(file), /must be 0600/);
  chmodSync(file, 0o600);
  assert.doesNotThrow(() => assertConfigPermissions(file));
});

test("the bearer is never passed into the queue script's environment", async () => {
  const dir = scratch();
  const cfg = configFor(dir);
  process.env.SHOULD_NOT_LEAK_BEARER = BEARER;
  try {
    const run = makeQueueRunner(cfg);
    await run(["submit", "--requester", CALLER, "--template", "E4_AUDIT_ANALYST", "--title", "t"]);
    const env = readFileSync(path.join(dir, "env.txt"), "utf8");
    assert.match(env, new RegExp(`COMPANY_ID=${COMPANY}`));
    // The child gets a constructed environment, not an inherited one.
    assert.match(env, /^0$/m, "a BEARER-named variable reached the child environment");
  } finally {
    delete process.env.SHOULD_NOT_LEAK_BEARER;
  }
});

// TOG-341: queueEnv is an operator seam for the queue's own test hooks. It is
// not a way to restate a value this server owns. Two independent controls,
// because they fail independently — the config one is loud at startup, the
// ordering one still holds for a cfg object nobody normalized.

test("a config whose queueEnv restates a reserved name is refused at load", () => {
  for (const key of ["COMPANY_ID", "PATH", "HOME", "PAPERCLIP_DB_CTR"]) {
    assert.throws(
      () => normalizeConfig({
        companyId: COMPANY,
        bearerSha256: BEARER_SHA,
        queueScript: "/x/org_request_queue.sh",
        queueEnv: { [key]: "anything" },
      }),
      (error) => error.message.includes("queueEnv may not set") && error.message.includes(key),
      `queueEnv was allowed to set ${key}`,
    );
  }
  // The seam itself still works — this refuses reserved names, not the feature.
  assert.doesNotThrow(() => normalizeConfig({
    companyId: COMPANY,
    bearerSha256: BEARER_SHA,
    queueScript: "/x/org_request_queue.sh",
    queueEnv: { ORG_QUEUE_FIXTURE_DIR: "/tmp/fixture" },
  }));
});

test("the tenancy the queue sees comes from the server, not from queueEnv", async () => {
  const dir = scratch();
  // Deliberately NOT via normalizeConfig: that path already refuses this. The
  // property under test is that the spread order alone is enough, so the
  // control survives a cfg object assembled some other way.
  const cfg = {
    ...configFor(dir),
    queueEnv: { COMPANY_ID: "00000000-0000-4000-8000-000000000000", PAPERCLIP_DB_CTR: "not-our-db" },
  };
  const run = makeQueueRunner(cfg);
  await run(["submit", "--requester", CALLER, "--template", "E4_AUDIT_ANALYST", "--title", "t"]);
  const env = readFileSync(path.join(dir, "env.txt"), "utf8");
  assert.match(
    env, new RegExp(`COMPANY_ID=${COMPANY}`),
    "a config key overrode the tenancy value handed to the queue",
  );
});

// ===========================================================================
// 5. Exactly the sanctioned tools, and never the provisioner.
// ===========================================================================

test("tools/list advertises exactly the sanctioned tools, and each binds to a known script", async () => {
  const dir = scratch();
  await withServer(configFor(dir), {}, async (call) => {
    const response = await call(rpc("tools/list", {}));
    assert.equal(response.status, 200);
    const names = response.json.result.tools.map((tool) => tool.name).sort();
    // Two provisioning tools (org_request_queue.sh) + three capability tools
    // (capability_gate.sh). Pinned literally so a SIXTH tool appearing here is
    // a deliberate edit to this line, never a silent addition.
    assert.deepEqual(names, [
      "countersign_capability_request",
      "review_capability_request",
      "review_provisioning_request",
      "submit_capability_request",
      "submit_provisioning_request",
    ]);
    // Every tool the catalogue advertises must bind to a script the handler
    // knows how to run. A tool with no binding would reach the "no known script
    // binding" fault at call time — better to catch it in discovery.
    for (const tool of TOOLS) {
      assert.ok(["queue", "capability"].includes(tool.script), `${tool.name} has no known script binding`);
    }
  });
});

// The queue tools front org_request_queue.sh; the capability tools front
// capability_gate.sh. This split is what the handler dispatches on, so pin it.
test("each tool binds to the correct script", () => {
  const byName = new Map(TOOLS.map((tool) => [tool.name, tool.script]));
  assert.equal(byName.get("submit_provisioning_request"), "queue");
  assert.equal(byName.get("review_provisioning_request"), "queue");
  assert.equal(byName.get("submit_capability_request"), "capability");
  assert.equal(byName.get("review_capability_request"), "capability");
  assert.equal(byName.get("countersign_capability_request"), "capability");
});

test("no tool reaches the provisioner or the template controls", async () => {
  const dir = scratch();
  await withServer(configFor(dir), {}, async (call) => {
    for (const name of [
      "provision", "org_provisioner", "run_provisioner", "create_agent",
      "disable_template", "enable_template", "disable-template", "log", "exec", "shell",
    ]) {
      const response = await call(
        rpc("tools/call", { name, arguments: {} }),
        IDENTITY_HEADERS,
      );
      assert.equal(response.json.result.isError, true, `'${name}' was not refused`);
      assert.match(response.json.result.content[0].text, /unknown_tool/);
    }
    assert.equal(recordedArgv(dir), null);
  });
});

test("an unknown tool is refused BEFORE identity is checked, so it costs no database round trip", async () => {
  const dir = scratch();
  let corroborated = false;
  await withServer(
    configFor(dir),
    { corroborateRun: async () => { corroborated = true; } },
    async (call) => {
      const response = await call(rpc("tools/call", { name: "provision", arguments: {} }), IDENTITY_HEADERS);
      assert.equal(response.json.result.isError, true);
      assert.equal(corroborated, false);
    },
  );
});

test("the server refuses at startup to front anything but org_request_queue.sh", () => {
  const dir = scratch();
  const provisioner = path.join(dir, "org_provisioner.sh");
  writeFileSync(provisioner, "#!/bin/sh\n", { mode: 0o700 });
  assert.throws(() => assertQueueScript(provisioner), /never the provisioner/);
  assert.doesNotThrow(() => assertQueueScript(stubQueue(scratch())));
});

// ===========================================================================
// 6. Argument hygiene.
// ===========================================================================

test("a template that is not a template is refused, including flag-shaped values", async () => {
  const dir = scratch();
  await withServer(configFor(dir), {}, async (call) => {
    for (const template of ["--reports-to", "E4; rm -rf /", "E4 --parent P1", "$(id)", "`id`", "E4\nsubmit"]) {
      const response = await call(
        rpc("tools/call", { name: "submit_provisioning_request", arguments: { template, title: "t" } }),
        IDENTITY_HEADERS,
      );
      assert.equal(response.json.result.isError, true, `template '${template}' was accepted`);
    }
    assert.equal(recordedArgv(dir), null);
  });
});

test("shell metacharacters in free text stay inside one argv element", async () => {
  const dir = scratch();
  await withServer(configFor(dir), {}, async (call) => {
    const nasty = 'need an analyst; $(touch /tmp/pwned) `id` && echo "x" | tee /tmp/y';
    const response = await call(
      rpc("tools/call", {
        name: "submit_provisioning_request",
        arguments: { template: "E4_AUDIT_ANALYST", title: "audit analyst", rationale: nasty },
      }),
      IDENTITY_HEADERS,
    );
    assert.equal(response.json.result.isError, false);
    const argv = recordedArgv(dir);
    // execFile with an argv array, no shell: the whole string is one element.
    assert.equal(argv[argv.indexOf("--rationale") + 1], nasty);
    assert.equal(existsSync("/tmp/pwned"), false);
  });
});

test("a request id must look like one, on both tools", () => {
  const identity = { agentId: CALLER, companyId: COMPANY, runId: RUN };
  for (const bad of ["REQ", "../../etc/passwd", "REQ-001; id", "--approve", "REQ-0001111111"]) {
    assert.throws(
      () => buildQueueArgs("review_provisioning_request", { request_id: bad, decision: "approve" }, identity),
      (error) => error.code === "invalid_argument",
      `request_id '${bad}' was accepted`,
    );
  }
  assert.doesNotThrow(
    () => buildQueueArgs("review_provisioning_request", { request_id: "REQ-001", decision: "approve" }, identity),
  );
});

test("decision is a closed set; nothing else becomes a flag", () => {
  const identity = { agentId: CALLER, companyId: COMPANY, runId: RUN };
  for (const bad of ["--approve", "APPROVE", "approve --reason x", "", "yes"]) {
    assert.throws(
      () => buildQueueArgs("review_provisioning_request", { request_id: "REQ-001", decision: bad }, identity),
      (error) => error.code === "invalid_argument",
      `decision '${bad}' was accepted`,
    );
  }
  assert.deepEqual(
    buildQueueArgs("review_provisioning_request", { request_id: "REQ-001", decision: "approve" }, identity),
    ["review", "--reviewer", CALLER, "--request", "REQ-001", "--approve"],
  );
});

// ---------------------------------------------------------------------------
// TOG-341: the inputSchema is ENFORCED, not merely advertised.
//
// Before this, `additionalProperties: false` was a claim made to clients that
// nothing in this process checked. An unlisted key could not reach the CLI —
// buildQueueArgs reads named arguments and nothing else — but it was dropped in
// silence, which is precisely the failure mode the identity denylist exists to
// avoid. These assert the refusal, not the drop.
// ---------------------------------------------------------------------------

test("an argument the schema does not declare is refused, not silently dropped", () => {
  const identity = { agentId: CALLER, companyId: COMPANY, runId: RUN };
  for (const [tool, args] of [
    ["submit_provisioning_request", { template: "E4_AUDIT_ANALYST", title: "t", notify: "x" }],
    ["submit_provisioning_request", { template: "E4_AUDIT_ANALYST", title: "t", reason: "wrong tool" }],
    ["review_provisioning_request", { request_id: "REQ-001", decision: "approve", rationale: "wrong tool" }],
    ["review_provisioning_request", { request_id: "REQ-001", decision: "approve", force: true }],
  ]) {
    assert.throws(
      () => buildQueueArgs(tool, args, identity),
      (error) => error.code === "unknown_argument" && error.status === 400,
      `${tool} silently accepted an undeclared argument`,
    );
  }
});

// The exact call measured in the TOG-336 review of PR #9, which returned
// ["submit","--requester",A,"--template","E4_X","--title","x"] and dropped the
// other three keys without a word.
test("the review's measured silent-drop case is now a refusal", () => {
  const identity = { agentId: CALLER, companyId: COMPANY, runId: RUN };
  // `submitter` is not on the identity denylist — deliberately, because that is
  // the point: the schema check has to stand on its own, without the denylist
  // happening to cover the name.
  assert.throws(
    () => buildQueueArgs(
      "submit_provisioning_request",
      { template: "E4_X", title: "x", submitter: VICTIM },
      identity,
    ),
    (error) => error.code === "unknown_argument" && error.message.includes("submitter"),
    "a caller naming a submitter still gets no error",
  );
});

test("a denylisted identity name is still refused BY NAME, not as a generic unknown key", () => {
  // Both checks would refuse `requester`; the specific one has to win, or the
  // audit log stops distinguishing a typo from an impersonation attempt.
  const identity = { agentId: CALLER, companyId: COMPANY, runId: RUN };
  assert.throws(
    () => buildQueueArgs(
      "submit_provisioning_request",
      { template: "E4_AUDIT_ANALYST", title: "t", requester: VICTIM },
      identity,
    ),
    (error) => error.code === "identity_argument_refused",
  );
});

test("prototype keys are unknown keys, not inherited ones", () => {
  const identity = { agentId: CALLER, companyId: COMPANY, runId: RUN };
  // `"constructor" in {}` is true, so an `in` check here would admit exactly the
  // names a prototype-pollution probe reaches for first.
  for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    // Parsed, not an object literal: `{__proto__: "x"}` sets the prototype and
    // leaves no own key, while JSON.parse defines a real own property — and
    // JSON.parse is how these arguments actually arrive.
    const args = JSON.parse(`{"template":"E4_AUDIT_ANALYST","title":"t",${JSON.stringify(key)}:"x"}`);
    assert.ok(Object.keys(args).includes(key), `the fixture did not actually carry '${key}'`);
    assert.throws(
      () => buildQueueArgs("submit_provisioning_request", args, identity),
      (error) => error.code === "unknown_argument",
      `'${key}' was treated as a declared property`,
    );
  }
});

test("an undeclared argument is refused over the wire, and the queue never runs", async () => {
  const dir = scratch();
  await withServer(configFor(dir), {}, async (call) => {
    const response = await call(
      rpc("tools/call", {
        name: "submit_provisioning_request",
        arguments: { template: "E4_AUDIT_ANALYST", title: "t", submitter: VICTIM },
      }),
      IDENTITY_HEADERS,
    );
    assert.equal(response.status, 200);
    assert.equal(response.json.result.isError, true, "an undeclared argument was accepted");
    assert.match(response.json.result.content[0].text, /unknown_argument/);
    // The message has to name what IS accepted, or the caller retries blind.
    assert.match(response.json.result.content[0].text, /Accepted: template, title, rationale, supersedes/);
    assert.equal(recordedArgv(dir), null, "the queue ran for a call carrying an undeclared argument");
  });
});

test("the enforcement reads the SAME schema object that tools/list advertises", async () => {
  const dir = scratch();
  await withServer(configFor(dir), {}, async (call) => {
    const response = await call(rpc("tools/list", {}));
    const advertised = response.json.result.tools
      .find((tool) => tool.name === "submit_provisioning_request");
    assert.equal(advertised.inputSchema.additionalProperties, false);
    const identity = { agentId: CALLER, companyId: COMPANY, runId: RUN };
    // Every advertised property is accepted...
    assert.doesNotThrow(
      () => buildQueueArgs("submit_provisioning_request", EVERY_ARGUMENT.submit_provisioning_request, identity),
    );
    // ...and a name one character off is not. The schema is the whole list.
    for (const name of Object.keys(advertised.inputSchema.properties)) {
      assert.throws(
        () => buildQueueArgs(
          "submit_provisioning_request",
          { template: "E4_AUDIT_ANALYST", title: "t", [name + "s"]: "x" },
          identity,
        ),
        (error) => error.code === "unknown_argument",
        `'${name}s' was accepted; the check is not reading the advertised property list`,
      );
    }
  });
});

test("an argument that is not a string is refused rather than coerced", () => {
  const identity = { agentId: CALLER, companyId: COMPANY, runId: RUN };
  for (const title of [{ toString: () => "x" }, ["x"], 42, true, null]) {
    assert.throws(
      () => buildQueueArgs("submit_provisioning_request", { template: "E4_AUDIT_ANALYST", title }, identity),
      (error) => error.code === "invalid_argument",
    );
  }
});

// ===========================================================================
// 7. Protocol and exposure.
// ===========================================================================

test("tools/list works WITHOUT identity headers, or the connection can never go healthy", async () => {
  const dir = scratch();
  await withServer(configFor(dir), {}, async (call) => {
    // The gateway's catalog refresh (tool-access.ts remoteTools) sends
    // credential headers only — no session, so no identity. Requiring identity
    // here would make the connection permanently unhealthy.
    const response = await call(rpc("tools/list", {}), {});
    assert.equal(response.status, 200);
    // Pinned to the TOOLS export rather than a magic number, so adding a tool
    // updates this in one place. The gateway must see the full catalogue with
    // credential headers alone; requiring identity here would make the
    // connection permanently unhealthy.
    assert.deepEqual(
      response.json.result.tools.map((tool) => tool.name).sort(),
      TOOLS.map((tool) => tool.name).sort(),
    );
    assert.equal(response.json.result.tools.length, TOOLS.length);
  });
});

test("initialize negotiates a protocol version and advertises tools", async () => {
  const dir = scratch();
  await withServer(configFor(dir), {}, async (call) => {
    const response = await call(rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {} }));
    assert.equal(response.status, 200);
    assert.equal(response.json.result.protocolVersion, "2025-03-26");
    assert.ok(response.json.result.capabilities.tools);
    assert.equal(response.json.result.serverInfo.name, "org-request-mcp");
  });
});

test("a notification gets 202 and no body", async () => {
  const dir = scratch();
  await withServer(configFor(dir), {}, async (call) => {
    const response = await call({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(response.status, 202);
    assert.equal(response.json, null);
  });
});

test("JSON-RPC batching is refused rather than deciding identity once for many calls", async () => {
  const dir = scratch();
  await withServer(configFor(dir), {}, async (call) => {
    const response = await call([rpc("tools/list", {}), rpc("tools/list", {}, 2)]);
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, -32600);
  });
});

test("only /mcp answers, and only to POST", async () => {
  const dir = scratch();
  await withServer(configFor(dir), {}, async (call, port) => {
    const get = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "GET",
      headers: { authorization: `Bearer ${BEARER}` },
    });
    assert.equal(get.status, 405);
    for (const p of ["/", "/health", "/healthz", "/metrics", "/.env", "/mcp/"]) {
      const probe = await fetch(`http://127.0.0.1:${port}${p}`, {
        method: "POST",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(probe.status, 404, `${p} answered ${probe.status}`);
    }
  });
});

// This case takes ~3s of wall clock and that is the CLIENT, not the server:
// undici keeps writing the upload after the server has already answered 413.
// Measured with a raw socket, the first response byte arrives in ~11ms. Do not
// "fix" the slowness by loosening the limit or by destroying the request
// socket — destroying it is what makes the peer see ECONNRESET instead of the
// refusal, which is the bug this rejection path was rewritten to avoid.
test("an oversized body is rejected without being buffered into a tool call", async () => {
  const dir = scratch();
  await withServer(configFor(dir), {}, async (call) => {
    const response = await call(
      rpc("tools/call", {
        name: "submit_provisioning_request",
        arguments: { template: "E4_AUDIT_ANALYST", title: "t", rationale: "x".repeat(400 * 1024) },
      }),
      IDENTITY_HEADERS,
    );
    assert.equal(response.status, 413);
    assert.equal(recordedArgv(dir), null);
  });
});

test("the listener is loopback-only and the address is not configurable", async () => {
  const source = readFileSync(new URL("../org-request-mcp.mjs", import.meta.url), "utf8");
  // "Bind loopback only" is a stated non-negotiable. A configurable bind
  // address is that constraint one config edit away from gone, so the suite
  // asserts the constant rather than trusting a default.
  assert.match(source, /const BIND_ADDRESS = "127\.0\.0\.1"/);
  assert.ok(
    !/cfg\.(bind|host|address)/.test(source),
    "the bind address became configurable; loopback-only is a non-negotiable of TOG-196",
  );
});

// ===========================================================================
// 8. The queue's own refusals must reach the caller intact.
// ===========================================================================

test("a REFUSED from the queue is returned as a readable tool error, not a 500", async () => {
  const dir = scratch();
  const cfg = configFor(dir, {
    queueBody: `#!/bin/sh
echo "REFUSED: template 'P1_PRESIDENT_COO' is above the request ceiling of 'E4_AUDIT_ANALYST'." >&2
exit 2
`,
  });
  await withServer(cfg, {}, async (call) => {
    const response = await call(
      rpc("tools/call", { name: "submit_provisioning_request", arguments: { template: "P1_PRESIDENT_COO", title: "t" } }),
      IDENTITY_HEADERS,
    );
    assert.equal(response.status, 200);
    assert.equal(response.json.result.isError, true);
    // The reason has to survive the transport verbatim, or a denial the epic
    // designed to be answerable becomes an opaque failure.
    assert.match(response.json.result.content[0].text, /above the request ceiling/);
  });
});

test("concurrent submits are serialised so the queue's line-counted ids cannot collide", async () => {
  const dir = scratch();
  const cfg = configFor(dir, {
    // Record a start and an end marker around a sleep. If two invocations ever
    // overlap, the markers interleave as start,start,... instead of strictly
    // alternating start,end,start,end.
    queueBody: `#!/bin/sh
d="$(dirname "$0")"
printf 'start\\n' >> "$d/marks"
sleep 0.1
printf 'end\\n' >> "$d/marks"
echo ok
`,
  });
  const run = makeQueueRunner(cfg);
  await Promise.all(Array.from({ length: 5 }, () =>
    run(["submit", "--requester", CALLER, "--template", "E4_AUDIT_ANALYST", "--title", "t"])));

  const marks = readFileSync(path.join(dir, "marks"), "utf8").split("\n").filter(Boolean);
  assert.equal(marks.length, 10, "not every invocation ran");
  const expected = Array.from({ length: 5 }, () => ["start", "end"]).flat();
  assert.deepEqual(marks, expected, "queue invocations overlapped; ids counted from the queue file can collide");
});

// ===========================================================================
// 8. Capability tools — the transport contract (TOG-399).
//
// The same property the provisioning tools carry, one CLI over: the principal
// is the AUTHENTICATED session and is structurally unreachable from tool input.
// These run against a STUB capability_gate.sh, so they assert exactly what
// reaches the argv without needing the gate's org resolution. Section 9 then
// drives the REAL gate end to end.
// ===========================================================================

test("TOG-399: submit_capability_request forwards --requester from the authenticated principal", async () => {
  const dir = scratch();
  await withServer(capabilityConfigFor(dir), {}, async (call) => {
    const response = await call(
      rpc("tools/call", {
        name: "submit_capability_request",
        arguments: {
          capability: "github.token", action: "read",
          facts: "the audit run holds no GH_APP binding, measured 2026-08-25",
          reasoning: "reading check-runs needs a scoped installation token and there is none",
          title: "read a scoped token",
        },
      }),
      IDENTITY_HEADERS,
    );
    assert.equal(response.json.result.isError, false, response.json.result.content?.[0]?.text);
    assert.deepEqual(recordedCapArgv(dir), [
      "submit", "--requester", CALLER,
      "--capability", "github.token", "--action", "read",
      "--facts", "the audit run holds no GH_APP binding, measured 2026-08-25",
      "--reasoning", "reading check-runs needs a scoped installation token and there is none",
      "--title", "read a scoped token",
    ]);
    // The queue script must NOT have run — a capability call routes to the gate.
    assert.equal(recordedArgv(dir), null, "a capability tool reached the provisioning queue");
  });
});

test("TOG-399: review and countersign forward --reviewer / --custodian from the principal", async () => {
  for (const [name, flag, verb] of [
    ["review_capability_request", "--reviewer", "review"],
    ["countersign_capability_request", "--custodian", "countersign"],
  ]) {
    const dir = scratch();
    await withServer(capabilityConfigFor(dir), {}, async (call) => {
      const response = await call(
        rpc("tools/call", { name, arguments: { request_id: "CAP-004", decision: "approve", reason: "agrees" } }),
        IDENTITY_HEADERS,
      );
      assert.equal(response.json.result.isError, false, response.json.result.content?.[0]?.text);
      assert.deepEqual(recordedCapArgv(dir), [
        verb, flag, CALLER, "--request", "CAP-004", "--approve", "--reason", "agrees",
      ]);
    });
  }
});

test("TOG-399: a caller naming itself as custodian/decider is refused before the gate", () => {
  const identity = { agentId: CALLER, companyId: COMPANY, runId: RUN };
  // The three provisioning identity names PLUS the capability gate's own.
  const names = ["custodian", "custodianAgentId", "custodian_agent_id", "decider", "requester", "reviewer"];
  for (const name of names) {
    for (const tool of ["submit_capability_request", "review_capability_request", "countersign_capability_request"]) {
      const args = tool === "submit_capability_request"
        ? { capability: "github.token", action: "read", facts: "x".repeat(40), reasoning: "y".repeat(40), [name]: VICTIM }
        : { request_id: "CAP-004", decision: "approve", reason: "r", [name]: VICTIM };
      assert.throws(
        () => buildCapabilityArgs(tool, args, identity),
        (error) => error.code === "identity_argument_refused" && error.message.includes(`'${name}'`),
        `${tool} accepted an identity argument named '${name}'`,
      );
    }
  }
});

test("TOG-399: a self-naming argument reaches the gate NOWHERE, over the wire", async () => {
  const dir = scratch();
  await withServer(capabilityConfigFor(dir), {}, async (call) => {
    const response = await call(
      rpc("tools/call", {
        name: "submit_capability_request",
        arguments: {
          capability: "github.token", action: "read", facts: "x".repeat(40), reasoning: "y".repeat(40),
          custodian: VICTIM,
        },
      }),
      IDENTITY_HEADERS,
    );
    assert.equal(response.json.result.isError, true);
    assert.match(response.json.result.content[0].text, /identity_argument_refused/);
    assert.equal(recordedCapArgv(dir), null, "the gate ran despite a refused identity argument");
  });
});

test("TOG-399: a capability request id must be CAP-nnn, never a queue REQ-nnn", () => {
  const identity = { agentId: CALLER, companyId: COMPANY, runId: RUN };
  for (const bad of ["REQ-004", "cap-004", "CAP-", "CAP-4", "004", "CAP-004; rm -rf /"]) {
    assert.throws(
      () => buildCapabilityArgs("review_capability_request", { request_id: bad, decision: "approve", reason: "r" }, identity),
      (error) => error.code === "invalid_argument",
      `review_capability_request accepted a malformed request id '${bad}'`,
    );
  }
  // The valid shape builds.
  const argv = buildCapabilityArgs(
    "review_capability_request", { request_id: "CAP-004", decision: "reject", reason: "no" }, identity);
  assert.deepEqual(argv, ["review", "--reviewer", CALLER, "--request", "CAP-004", "--reject", "--reason", "no"]);
});

test("TOG-399: capability tools fail CLOSED when the server never configured a capability script", async () => {
  const dir = scratch();
  // A config with NO capabilityScript. normalizeConfig makes it null; the
  // handler must refuse rather than execFile(undefined).
  const cfg = normalizeConfig({
    companyId: COMPANY, bearerSha256: BEARER_SHA, queueScript: stubQueue(dir), requireLiveRun: false,
  });
  await withServer(cfg, {}, async (call) => {
    const response = await call(
      rpc("tools/call", {
        name: "submit_capability_request",
        arguments: { capability: "github.token", action: "read", facts: "x".repeat(40), reasoning: "y".repeat(40) },
      }),
      IDENTITY_HEADERS,
    );
    // Still authenticated and built (the tool is known and identity is present),
    // but the runner has no script to reach.
    assert.equal(response.json.result.isError, true);
    assert.match(response.json.result.content[0].text, /not configured to front that script/);
  });
});

test("TOG-399: a provisioning call never reaches the capability gate", async () => {
  const dir = scratch();
  await withServer(capabilityConfigFor(dir), {}, async (call) => {
    const response = await call(
      rpc("tools/call", {
        name: "submit_provisioning_request",
        arguments: { template: "E4_AUDIT_ANALYST", title: "analyst" },
      }),
      IDENTITY_HEADERS,
    );
    assert.equal(response.json.result.isError, false, response.json.result.content?.[0]?.text);
    // It reached the QUEUE stub, not the capability stub.
    assert.ok(recordedArgv(dir), "the provisioning call did not reach the queue");
    assert.equal(recordedCapArgv(dir), null, "a provisioning call reached the capability gate");
  });
});

test("assertCapabilityScript refuses a script that is not capability_gate.sh", () => {
  const dir = scratch();
  const notTheGate = stubQueue(dir); // named org_request_queue.sh
  assert.throws(
    () => assertCapabilityScript(notTheGate),
    (error) => /capability_gate\.sh and nothing else/.test(error.message),
  );
  // And accepts the real one, when it is present in this checkout.
  if (GATE_PRESENT) {
    assert.equal(path.basename(assertCapabilityScript(REAL_CAPABILITY_GATE)), "capability_gate.sh");
  }
});

// ===========================================================================
// 9. THE ACCEPTANCE (TOG-399): a request SUBMITTED by one authenticated agent
//    and COUNTERSIGNED by a DIFFERENT authenticated agent, principals derived
//    from the transport and unsuppliable by either caller — driven through the
//    REAL capability_gate.sh, not a stub.
// ===========================================================================

// Three distinct principals. Each reaches the gate ONLY because a different set
// of identity headers was on the wire; none of them is ever a tool argument.
const REQUESTER  = "aaaaaaaa-0000-0000-0000-000000000001";  // asks
const DOMAIN_OWNER = "bbbbbbbb-0000-0000-0000-000000000002"; // key 1 (orgRole T0)
const CUSTODIAN  = "cccccccc-0000-0000-0000-000000000003";  // key 2 (B3_SECURITY_CHIEF)

function headersFor(agentId) {
  return { "x-paperclip-agent-id": agentId, "x-paperclip-company-id": COMPANY, "x-paperclip-run-id": RUN };
}

// A minimal org: a requester, the T0 domain owner of github.token, and the
// B3_SECURITY_CHIEF custodian. Tab-separated: id, orgRoleId, template, status,
// reportsTo, title — the format capability_gate.sh's ORG_SNAPSHOT seam reads.
function writeOrgSnapshot(dir) {
  const file = path.join(dir, "org.tsv");
  const rows = [
    [REQUESTER, "E4_ANALYST", "E4_AUDIT_ANALYST", "active", DOMAIN_OWNER, "Requester"],
    [DOMAIN_OWNER, "T0", "T0_TECH_OWNER", "active", "", "Domain Owner"],
    [CUSTODIAN, "B3", "B3_SECURITY_CHIEF", "active", DOMAIN_OWNER, "Custodian"],
  ];
  writeFileSync(file, rows.map((r) => r.join("\t")).join("\n") + "\n");
  return file;
}

// Config fronting the REAL gate, with its offline seams (ORG_SNAPSHOT and
// scratch queue/log paths) passed through queueEnv. requireLiveRun is off:
// the corroboration leg is proven in section 4; here the point is that three
// DIFFERENT header identities become three different recorded principals.
function realGateConfig(dir) {
  const queuePath = path.join(dir, "cap-queue.jsonl");
  const logPath = path.join(dir, "cap-grant.jsonl");
  const cfg = normalizeConfig({
    companyId: COMPANY,
    bearerSha256: BEARER_SHA,
    queueScript: stubQueue(dir),
    capabilityScript: REAL_CAPABILITY_GATE,
    requireLiveRun: false,
    queueEnv: {
      ORG_SNAPSHOT: writeOrgSnapshot(dir),
      CAPABILITY_QUEUE: queuePath,
      CAPABILITY_LOG: logPath,
    },
  });
  return { cfg, queuePath };
}

test("TOG-399 ACCEPTANCE: two DIFFERENT authenticated agents, principals from the transport", { skip: skipIfNoGate }, async () => {
  const dir = scratch();
  const { cfg, queuePath } = realGateConfig(dir);
  await withServer(cfg, {}, async (call) => {
    // --- agent A submits, identified only by its headers -------------------
    const submit = await call(
      rpc("tools/call", {
        name: "submit_capability_request",
        arguments: {
          capability: "github.token", action: "read",
          facts: "the audit run holds no GH_APP binding, measured from /proc on 2026-08-25",
          reasoning: "reading check-runs needs a scoped installation token and this run has none",
        },
      }),
      headersFor(REQUESTER),
    );
    assert.equal(submit.json.result.isError, false, submit.json.result.content?.[0]?.text);
    const text = submit.json.result.content[0].text;
    const reqId = (/\b(CAP-\d{3,})\b/.exec(text) || [])[1];
    assert.ok(reqId, `no CAP id in the submit response: ${text}`);
    // Two keys, because github.token is a credential.
    assert.match(text, /TWO KEYS/);

    // --- agent B (the domain owner) turns key 1 ----------------------------
    const review = await call(
      rpc("tools/call", {
        name: "review_capability_request",
        arguments: { request_id: reqId, decision: "approve", reason: "owner agrees, scoped read only" },
      }),
      headersFor(DOMAIN_OWNER),
    );
    assert.equal(review.json.result.isError, false, review.json.result.content?.[0]?.text);
    assert.match(review.json.result.content[0].text, /awaiting_custody|KEY 1/i);

    // --- agent C (the custodian) turns key 2 -------------------------------
    const counter = await call(
      rpc("tools/call", {
        name: "countersign_capability_request",
        arguments: { request_id: reqId, decision: "approve", reason: "custody agrees, scoped and revocable" },
      }),
      headersFor(CUSTODIAN),
    );
    assert.equal(counter.json.result.isError, false, counter.json.result.content?.[0]?.text);
    assert.match(counter.json.result.content[0].text, /APPROVED|two keys/i);

    // --- THE RECORD: principals are the transport's, and all three differ --
    const rows = readFileSync(queuePath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const submitted = rows.find((r) => r.event === "request.submitted");
    const reviewed = rows.find((r) => r.event === "request.reviewed");
    const countersigned = rows.find((r) => r.event === "request.countersigned");

    assert.equal(submitted.requesterAgentId, REQUESTER, "the recorded requester is not the authenticated submitter");
    assert.equal(reviewed.reviewer, DOMAIN_OWNER, "the recorded domain-owner key is not the authenticated reviewer");
    assert.equal(countersigned.custodian, CUSTODIAN, "the recorded custody key is not the authenticated countersigner");
    assert.equal(countersigned.domainOwner, DOMAIN_OWNER);
    assert.equal(countersigned.status, "approved");
    // Two keys means two principals, and neither is the requester.
    assert.notEqual(reviewed.reviewer, countersigned.custodian);
    assert.notEqual(countersigned.custodian, submitted.requesterAgentId);
  });
});

test("TOG-399 ACCEPTANCE: the requester cannot countersign its own request, even authenticated", { skip: skipIfNoGate }, async () => {
  const dir = scratch();
  const { cfg } = realGateConfig(dir);
  await withServer(cfg, {}, async (call) => {
    const submit = await call(
      rpc("tools/call", {
        name: "submit_capability_request",
        arguments: {
          capability: "github.token", action: "read",
          facts: "the audit run holds no GH_APP binding, measured on 2026-08-25",
          reasoning: "reading check-runs needs a scoped installation token and this run has none",
        },
      }),
      headersFor(REQUESTER),
    );
    const reqId = (/\b(CAP-\d{3,})\b/.exec(submit.json.result.content[0].text) || [])[1];
    // Domain owner turns key 1 so the request is awaiting_custody.
    await call(
      rpc("tools/call", {
        name: "review_capability_request",
        arguments: { request_id: reqId, decision: "approve", reason: "owner agrees" },
      }),
      headersFor(DOMAIN_OWNER),
    );
    // Now the REQUESTER tries to be the second key. The transport authenticates
    // it as the requester (it cannot pretend otherwise), and the gate refuses
    // on separation of duties — the reply carries the reason, not a 500.
    const counter = await call(
      rpc("tools/call", {
        name: "countersign_capability_request",
        arguments: { request_id: reqId, decision: "approve", reason: "let me approve my own ask" },
      }),
      headersFor(REQUESTER),
    );
    assert.equal(counter.json.result.isError, true, "the requester was allowed to countersign its own request");
    assert.match(counter.json.result.content[0].text, /custodian|requester cannot|does not hold custody/i);
  });
});
