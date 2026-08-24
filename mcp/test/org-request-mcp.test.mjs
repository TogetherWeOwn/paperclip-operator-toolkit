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

import {
  TOOLS,
  normalizeConfig,
  assertConfigPermissions,
  assertQueueScript,
  bearerMatches,
  readIdentityHeaders,
  buildQueueArgs,
  makeQueueRunner,
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
  review_provisioning_request: { request_id: "REQ-004", decision: "approve", reason: "fine" },
};

test("every property a schema advertises is actually read onto the queue's argv", () => {
  const identity = { agentId: CALLER, companyId: COMPANY, runId: RUN };
  for (const tool of TOOLS) {
    const args = EVERY_ARGUMENT[tool.name];
    assert.deepEqual(
      Object.keys(args).sort(),
      Object.keys(tool.inputSchema.properties).sort(),
      `${tool.name}: the advertised schema and this fixture disagree; one of them was changed alone`,
    );
    const argv = buildQueueArgs(tool.name, args, identity);
    for (const [name, value] of Object.entries(args)) {
      // `decision` is the one property that becomes a flag rather than a value.
      const expected = name === "decision" ? "--approve" : value;
      assert.ok(
        argv.includes(expected),
        `${tool.name} advertises '${name}' but nothing puts it on the argv — it is silently dropped`,
      );
    }
  }
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
// 5. Exactly two tools, and never the provisioner.
// ===========================================================================

test("tools/list advertises exactly the two sanctioned tools", async () => {
  const dir = scratch();
  await withServer(configFor(dir), {}, async (call) => {
    const response = await call(rpc("tools/list", {}));
    assert.equal(response.status, 200);
    const names = response.json.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["review_provisioning_request", "submit_provisioning_request"]);
  });
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
    assert.equal(response.json.result.tools.length, 2);
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
