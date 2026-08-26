/**
 * omniroute-broker — test suite (TOG-391).
 *
 * No network, no credential, no host. That is what makes it CI-able, the same
 * property that got gh-token-broker's 46 tests into CI.
 *
 * Run:  node --test test/broker.test.mjs
 * (Pass the FILE, not the directory — on Node 24 `node --test test/` resolves
 * `test` as a module specifier and dies before running anything.)
 *
 * Every security invariant in the README has at least one test here, and the
 * assertions are written against the SOURCE OF TRUTH rather than against a local
 * restatement of it wherever possible — enumerating cases from a mirror's own
 * keys is how a deleted row silently deletes its own test.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

/** The committed TOG-178 plan. CI and a fresh clone must exercise the same corpus. */
const TOG_178_PLAN = new URL("../../../tests/fixtures/tog178/TOG-178-mapping-plan.json", import.meta.url);

import {
  APPROVAL,
  PAID_TRAFFIC_KEYS,
  VERBS,
  VerbError,
  assertPlainJson,
  buildRequest,
  classifyApproval,
  resolveVerb,
  touchesPaidTraffic,
  assertMappingCreate,
} from "../dist/verbs.js";
import {
  FIELD_ALLOWLIST,
  RedactionError,
  assertNoResidualSecret,
  maskForAudit,
  redactResponse,
} from "../dist/redact.js";
import { OPERABLE_ISSUE_STATUSES, OwnershipError, assertOperationOwnership } from "../dist/ownership.js";
import {
  ApprovalError,
  PROPOSAL_STATE,
  canonicalize,
  consumeProposal,
  createProposal,
  digestOperation,
} from "../dist/approvals.js";
import { UnrecordedMutationError, buildRecord, commit, preflight } from "../dist/audit.js";
import { OmniRouteError, callManagement, mapUpstreamStatus, normalizeBaseUrl } from "../dist/omniroute.js";
import { manifest } from "../dist/manifest.js";

const sha256Hex = (input) => createHash("sha256").update(input, "utf8").digest("hex");

const AGENT_A = "agent-aaaa";
const AGENT_B = "agent-bbbb";
const RUN_A = "run-1111";
const RUN_B = "run-2222";

const actor = (agentId, runId) => ({ actorType: "agent", agentId, runId });
const issueRow = (over = {}) => ({
  id: "issue-1",
  status: "in_progress",
  assigneeAgentId: AGENT_A,
  checkoutRunId: RUN_A,
  ...over,
});

// ───────────────────────── verb table: deny by default ─────────────────────

test("credential mint, reveal and regeneration verbs are absent and refused", () => {
  for (const name of [
    "keys.create",
    "keys.reveal",
    "keys.regenerate",
    "keys.rotate",
    "cli.tokens.create",
    "cli.tokens.mint",
  ]) {
    assert.equal(Object.hasOwn(VERBS, name), false, `${name} must not exist in the allowlist`);
    assert.throws(
      () => resolveVerb(name),
      (e) => e instanceof VerbError && e.status === 404,
      `${name} must fail closed`,
    );
  }
});

test("an unknown verb is refused, not forwarded", () => {
  assert.throws(() => resolveVerb("providers.list.extra"), (e) => e.status === 404);
  assert.throws(() => resolveVerb(""), (e) => e.status === 400);
  assert.throws(() => resolveVerb(null), (e) => e.status === 400);
});

test("verb lookup is exact equality, not prefix or substring", () => {
  // The TOG-151 lesson: substring matching on a namespace is how 14 Claude ids
  // containing neither "claude" nor "anthropic" slipped a filter.
  assert.throws(() => resolveVerb("providers"), (e) => e.status === 404);
  assert.throws(() => resolveVerb("PROVIDERS.LIST"), (e) => e.status === 404);
  assert.throws(() => resolveVerb(" providers.list"), (e) => e.status === 404);
});

test("prototype properties are not resolvable as verbs", () => {
  for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    assert.throws(() => resolveVerb(name), (e) => e instanceof VerbError, `"${name}" must not resolve`);
  }
});

test("no verb reaches a key-management, auth or lifecycle route", () => {
  // Enumerated from the verb table itself, so a verb added later is covered
  // without editing this test.
  const forbidden = ["/api/keys", "/api/cli/tokens", "/api/oauth", "/api/auth", "/api/policy", "/api/services", "/api/mcp", "/api/shutdown", "/api/settings/database"];
  for (const [name, verb] of Object.entries(VERBS)) {
    for (const prefix of forbidden) {
      assert.ok(
        verb.path !== prefix && !verb.path.startsWith(`${prefix}/`),
        `verb "${name}" targets forbidden surface ${verb.path}`,
      );
    }
    assert.ok(verb.path.startsWith("/api/"), `verb "${name}" has a non-/api path`);
  }
});

test("every verb declares an approval class and a resource with an allowlist", () => {
  for (const [name, verb] of Object.entries(VERBS)) {
    assert.ok(Object.values(APPROVAL).includes(verb.approval), `${name} has no valid approval class`);
    // A verb whose resource has no allowlist would return an unscrubbed payload.
    assert.ok(FIELD_ALLOWLIST[verb.resource], `${name} resource "${verb.resource}" has no field allowlist`);
  }
});

// ───────────────────────── approval classification ─────────────────────────

test("reads are ungated; create/update single; delete dual", () => {
  assert.equal(classifyApproval(resolveVerb("providers.list"), {}).approval, APPROVAL.NONE);
  assert.equal(classifyApproval(resolveVerb("providers.create"), {}).approval, APPROVAL.SINGLE);
  assert.equal(classifyApproval(resolveVerb("providers.delete"), {}).approval, APPROVAL.DUAL);
  assert.equal(classifyApproval(resolveVerb("combos.delete"), {}).approval, APPROVAL.DUAL);
});

test("the paid-traffic tripwire escalates single to dual", () => {
  const verb = resolveVerb("providers.update");
  const plain = classifyApproval(verb, { name: "x" });
  assert.equal(plain.approval, APPROVAL.SINGLE);
  assert.equal(plain.escalated, false);

  const paid = classifyApproval(verb, { priority: 1 });
  assert.equal(paid.approval, APPROVAL.DUAL);
  assert.equal(paid.escalated, true);
});

test("every declared paid-traffic key escalates, including when nested", () => {
  // Enumerated from PAID_TRAFFIC_KEYS itself — removing a key removes its case
  // only by removing it from the control, which is visible in review.
  const verb = resolveVerb("providers.update");
  for (const key of PAID_TRAFFIC_KEYS) {
    assert.equal(classifyApproval(verb, { [key]: 1 }).approval, APPROVAL.DUAL, `top-level ${key}`);
    assert.equal(
      classifyApproval(verb, { config: { nested: { [key]: 1 } } }).approval,
      APPROVAL.DUAL,
      `nested ${key}`,
    );
    assert.equal(classifyApproval(verb, { list: [{ [key]: 1 }] }).approval, APPROVAL.DUAL, `array ${key}`);
  }
});

test("the tripwire fires on key presence, not on a truthy value", () => {
  // Disabling the provider that currently serves paid traffic is exactly as
  // consequential as enabling one.
  const verb = resolveVerb("providers.update");
  assert.equal(classifyApproval(verb, { enabled: false }).approval, APPROVAL.DUAL);
  assert.equal(classifyApproval(verb, { priority: 0 }).approval, APPROVAL.DUAL);
  assert.equal(classifyApproval(verb, { enabled: null }).approval, APPROVAL.DUAL);
});

test("classification can only ever raise, never lower", () => {
  // A dual verb cannot be talked down to single by any body.
  const del = resolveVerb("providers.delete");
  for (const body of [{}, { name: "x" }, { approval: "single" }, { priority: 1 }]) {
    assert.equal(classifyApproval(del, body).approval, APPROVAL.DUAL);
  }
});

test("a caller cannot choose its own approval class via the body", () => {
  const verb = resolveVerb("providers.create");
  // "approval" is not consulted; only the table and the tripwire are.
  assert.equal(classifyApproval(verb, { approval: "none" }).approval, APPROVAL.SINGLE);
  assert.equal(classifyApproval(verb, { approvalClass: "none" }).approval, APPROVAL.SINGLE);
});

test("touchesPaidTraffic terminates on deep and self-referential input", () => {
  const deep = {};
  let cursor = deep;
  for (let i = 0; i < 50; i += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  assert.equal(touchesPaidTraffic(deep), false);
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => touchesPaidTraffic(cyclic));
});

// ───────────────────────── request construction ────────────────────────────

test("the caller supplies no method and no path", () => {
  const verb = resolveVerb("providers.get");
  const request = buildRequest(verb, { params: { id: "abc-123" } });
  assert.equal(request.method, "GET");
  assert.equal(request.path, "/api/providers/abc-123");
});

test("path params are validated, so traversal and injection cannot escape the template", () => {
  const verb = resolveVerb("providers.get");
  for (const bad of ["../keys", "a/../../x", "a?b=c", "a b", "", "a#f", "/api/keys", "a".repeat(129)]) {
    assert.throws(() => buildRequest(verb, { params: { id: bad } }), (e) => e instanceof VerbError, `"${bad}"`);
  }
});

test("a missing path param is refused rather than producing a literal ':id' path", () => {
  assert.throws(() => buildRequest(resolveVerb("providers.get"), { params: {} }), (e) => e.status === 400);
});

test("a read verb refuses a body", () => {
  assert.throws(
    () => buildRequest(resolveVerb("providers.list"), { body: { name: "x" } }),
    (e) => e instanceof VerbError && e.status === 400,
  );
});

test("assertPlainJson rejects prototype-polluting and oversized bodies", () => {
  assert.throws(() => assertPlainJson(JSON.parse('{"__proto__":{"x":1}}')), (e) => e.status === 400);
  assert.throws(() => assertPlainJson({ nested: JSON.parse('{"constructor":{}}') }), (e) => e.status === 400);
  assert.throws(() => assertPlainJson([1, 2]), (e) => e.status === 400);
  assert.throws(() => assertPlainJson({ big: "x".repeat(70_000) }), (e) => e.status === 413);
  assert.deepEqual(assertPlainJson(null), {});
});

// ───────────────────────── ownership (TOG-309 shape) ───────────────────────

test("a non-assignee is refused", () => {
  assert.throws(
    () => assertOperationOwnership(issueRow({ assigneeAgentId: AGENT_B }), actor(AGENT_A, RUN_A)),
    (e) => e instanceof OwnershipError && e.status === 403,
  );
});

test("a board actor is refused", () => {
  assert.throws(
    () => assertOperationOwnership(issueRow(), { actorType: "board", agentId: null }),
    (e) => e.status === 403,
  );
});

test("in_review and blocked are operable — the TOG-309 widening", () => {
  for (const status of OPERABLE_ISSUE_STATUSES) {
    const result = assertOperationOwnership(issueRow({ status }), actor(AGENT_A, RUN_A));
    assert.equal(result.status, status);
  }
});

test("terminal and not-started statuses are refused — the lifetime bound", () => {
  for (const status of ["done", "cancelled", "backlog", "todo"]) {
    assert.throws(
      () => assertOperationOwnership(issueRow({ status }), actor(AGENT_A, RUN_A)),
      (e) => e instanceof OwnershipError && e.status === 409,
      status,
    );
  }
});

test("an absent checkoutRunId fails closed rather than reading as an unheld lock", () => {
  const row = issueRow();
  delete row.checkoutRunId;
  assert.throws(() => assertOperationOwnership(row, actor(AGENT_A, RUN_A)), (e) => e.status === 409);
});

test("a null checkoutRunId is allowed and is recorded as such", () => {
  const result = assertOperationOwnership(issueRow({ checkoutRunId: null }), actor(AGENT_A, RUN_A));
  assert.equal(result.checkoutRunId, null);
});

test("a lock held by a different run of the same agent is refused", () => {
  assert.throws(
    () => assertOperationOwnership(issueRow({ checkoutRunId: RUN_B }), actor(AGENT_A, RUN_A)),
    (e) => e.status === 409,
  );
});

test("a missing or blank run id is refused", () => {
  assert.throws(() => assertOperationOwnership(issueRow(), actor(AGENT_A, "   ")), (e) => e.status === 403);
  assert.throws(() => assertOperationOwnership(issueRow(), actor(AGENT_A, null)), (e) => e.status === 403);
});

// ───────────────────────── two-key protocol ────────────────────────────────

const makeProposal = (over = {}) =>
  createProposal({
    id: "prop-1",
    digest: digestOperation({ issueId: "issue-1", verb: "providers.delete", params: { id: "p1" }, body: {} }, sha256Hex),
    issueId: "issue-1",
    verb: "providers.delete",
    params: { id: "p1" },
    body: {},
    proposer: { agentId: AGENT_A, runId: RUN_A },
    now: Date.now(),
    ...over,
  });

test("the proposer cannot be its own approver — the whole point of two keys", () => {
  const proposal = makeProposal();
  assert.throws(
    () =>
      consumeProposal({
        proposal,
        presentedDigest: proposal.digest,
        approver: actor(AGENT_A, RUN_B),
        now: Date.now(),
      }),
    (e) => e instanceof ApprovalError && e.status === 403,
  );
});

test("a different agent may approve", () => {
  const proposal = makeProposal();
  const consumed = consumeProposal({
    proposal,
    presentedDigest: proposal.digest,
    approver: actor(AGENT_B, RUN_B),
    now: Date.now(),
  });
  assert.equal(consumed.state, PROPOSAL_STATE.CONSUMED);
  assert.equal(consumed.approverAgentId, AGENT_B);
  assert.equal(consumed.proposerAgentId, AGENT_A);
});

test("a mismatched digest is refused — the operation cannot change between the keys", () => {
  const proposal = makeProposal();
  assert.throws(
    () =>
      consumeProposal({
        proposal,
        presentedDigest: sha256Hex("something else"),
        approver: actor(AGENT_B, RUN_B),
        now: Date.now(),
      }),
    (e) => e.status === 409,
  );
});

test("an absent digest is refused — approval by id alone is consent to something unread", () => {
  const proposal = makeProposal();
  for (const digest of [undefined, null, "", 123]) {
    assert.throws(
      () => consumeProposal({ proposal, presentedDigest: digest, approver: actor(AGENT_B, RUN_B), now: Date.now() }),
      (e) => e instanceof ApprovalError,
    );
  }
});

test("a consumed proposal cannot be replayed", () => {
  const proposal = makeProposal();
  const consumed = consumeProposal({
    proposal,
    presentedDigest: proposal.digest,
    approver: actor(AGENT_B, RUN_B),
    now: Date.now(),
  });
  assert.throws(
    () =>
      consumeProposal({
        proposal: consumed,
        presentedDigest: consumed.digest,
        approver: actor(AGENT_B, RUN_B),
        now: Date.now(),
      }),
    (e) => e.status === 409,
  );
});

test("an expired proposal is refused", () => {
  const now = Date.now();
  const proposal = makeProposal({ now: now - 10_000, ttlMs: 1_000 });
  assert.throws(
    () => consumeProposal({ proposal, presentedDigest: proposal.digest, approver: actor(AGENT_B, RUN_B), now }),
    (e) => e.status === 409,
  );
});

test("a missing proposal is a 404, never an implicit approval", () => {
  assert.throws(
    () => consumeProposal({ proposal: null, presentedDigest: "x", approver: actor(AGENT_B, RUN_B), now: Date.now() }),
    (e) => e.status === 404,
  );
});

test("the digest is stable under key order and sensitive to every operation field", () => {
  const base = { issueId: "i1", verb: "providers.delete", params: { id: "p1" }, body: { a: 1, b: 2 } };
  const reordered = { body: { b: 2, a: 1 }, params: { id: "p1" }, verb: "providers.delete", issueId: "i1" };
  assert.equal(digestOperation(base, sha256Hex), digestOperation(reordered, sha256Hex));

  for (const mutation of [
    { ...base, issueId: "i2" },
    { ...base, verb: "combos.delete" },
    { ...base, params: { id: "p2" } },
    { ...base, body: { a: 1, b: 3 } },
  ]) {
    assert.notEqual(digestOperation(base, sha256Hex), digestOperation(mutation, sha256Hex));
  }
});

test("canonicalize sorts nested keys", () => {
  assert.equal(canonicalize({ b: { d: 1, c: 2 }, a: 3 }), '{"a":3,"b":{"c":2,"d":1}}');
});

// ───────────────────────── redaction ───────────────────────────────────────

test("a provider record's credential fields never survive scrubbing", () => {
  const upstream = {
    providers: [
      {
        id: "p1",
        name: "cliproxy",
        type: "openai-compatible",
        enabled: true,
        apiKey: "sk-livesecretvalue123456",
        connections: [{ apiKey: "sk-anotherlivesecret9999" }],
        customHeaders: { authorization: "Bearer tc-abcdefghijklmno" },
      },
    ],
  };
  const { records, count } = redactResponse(upstream, "provider");
  assert.equal(count, 1);
  assert.deepEqual(records[0], { id: "p1", name: "cliproxy", type: "openai-compatible", enabled: true });
  // Nothing credential-shaped anywhere in the output.
  assert.doesNotThrow(() => assertNoResidualSecret(records));
  assert.ok(!JSON.stringify(records).includes("sk-"));
});

test("scrubbing handles every envelope shape OmniRoute uses", () => {
  const record = { id: "p1", name: "n" };
  for (const payload of [
    [record],
    { providers: [record] },
    { data: [record] },
    { combos: [record], total: 1 },
    record,
  ]) {
    const { records } = redactResponse(payload, "provider");
    assert.equal(records[0].id, "p1");
  }
});

test("an unknown resource refuses rather than passing the payload through", () => {
  assert.throws(
    () => redactResponse({ data: [{ id: 1, apiKey: "sk-xxxxxxxxxxxxxxxx" }] }, "keys"),
    (e) => e instanceof RedactionError && e.status === 500,
  );
});

test("the residual check catches a credential smuggled inside an allowlisted field", () => {
  // `name` is allowlisted, but its VALUE here carries a key. This is the case
  // the allowlist alone cannot catch, and it must fail the whole response.
  assert.throws(
    () => redactResponse({ data: [{ id: "p1", name: "sk-livesecretvalue123456" }] }, "provider"),
    (e) => e instanceof RedactionError && e.status === 500,
  );
});

test("the residual check recognises every credential class on this box", () => {
  // Assemble scanner-shaped canaries at runtime so the repository-wide secret
  // scan remains meaningful: a literal fake token trains the scanner to flag
  // this test file on every clean build.
  const join = (...parts) => parts.join("");
  for (const secret of [
    join("sk", "-", "abcdefghijklmnopqrst"),
    join("oma", "_live_", "abcdefghijklmnop"),
    join("gh", "s_", "abcdefghijklmnopqrstuvwxyz12"),
    join("tc", "-", "abcdefghijklmnopqrst"),
    join("gh", "p_", "abcdefghijklmnopqrstuvwxyz12"),
    join("Bear", "er ", "abcdefghijklmnopqrst"),
    join("-----BEGIN ", "RSA PRIVATE ", "KEY-----"),
  ]) {
    assert.throws(() => assertNoResidualSecret({ field: secret }), (e) => e instanceof RedactionError, secret);
  }
});

test("the residual check refuses a secret-named field regardless of value", () => {
  assert.throws(() => assertNoResidualSecret({ apiKey: "harmless" }), (e) => e instanceof RedactionError);
  assert.throws(() => assertNoResidualSecret({ nested: { token: "x" } }), (e) => e instanceof RedactionError);
  assert.throws(() => assertNoResidualSecret([{ customHeaders: {} }]), (e) => e instanceof RedactionError);
});

test("object-valued fields are dropped rather than descended into", () => {
  const { records } = redactResponse({ data: [{ id: "p1", status: { nested: "sk-aaaaaaaaaaaaaaaa" } }] }, "provider");
  assert.deepEqual(records[0], { id: "p1" });
});

test("combo members survive as scalars only", () => {
  const { records } = redactResponse(
    { combos: [{ id: "c1", name: "n", members: ["m1", "m2", { apiKey: "sk-aaaaaaaaaaaaaaaa" }] }] },
    "combo",
  );
  assert.deepEqual(records[0].members, ["m1", "m2"]);
});

test("audit masking redacts but does not throw — a record must still be written", () => {
  const masked = maskForAudit({ name: "x", apiKey: "sk-aaaaaaaaaaaaaaaa", nested: { token: "t" }, keep: 1 });
  assert.equal(masked.apiKey, "[redacted]");
  assert.equal(masked.nested.token, "[redacted]");
  assert.equal(masked.name, "x");
  assert.equal(masked.keep, 1);
});

test("audit masking catches a secret VALUE under an innocuous key", () => {
  assert.equal(maskForAudit({ baseUrl: "https://x/?key=sk-aaaaaaaaaaaaaaaa" }).baseUrl, "[redacted]");
});

// ───────────────────────── the credential never escapes ────────────────────

function fakeFetch(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { impl, calls };
}

const okResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

test("the credential rides in a header, never in the URL, and is resolved exactly once", async () => {
  const { impl, calls } = fakeFetch(okResponse({ providers: [] }));
  let resolveCount = 0;
  await callManagement(impl, {
    baseUrl: "http://omniroute:20128",
    method: "GET",
    path: "/api/providers",
    body: null,
    resolveKey: async () => {
      resolveCount += 1;
      return "sk-thisisatestsecret123";
    },
  });
  assert.equal(resolveCount, 1);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].url.includes("sk-"), "credential must not appear in the URL");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-thisisatestsecret123");
});

test("nothing is shelled out — the request is a fetch, so no /proc/<pid>/cmdline exposure", async () => {
  // Structural assertion: callManagement's only outbound effect is the injected
  // fetch. If it ever grew a child_process path, this call would need more than
  // an injected fetch to succeed.
  const { impl, calls } = fakeFetch(okResponse({}));
  await callManagement(impl, {
    baseUrl: "http://omniroute:20128",
    method: "POST",
    path: "/api/providers",
    body: { name: "x" },
    resolveKey: async () => "sk-test1234567890abc",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.body, JSON.stringify({ name: "x" }));
});

test("a transport failure does not echo the error message, which could quote the header", async () => {
  const impl = async () => {
    throw new Error("connect ECONNREFUSED with Authorization: Bearer sk-leak1234567890");
  };
  await assert.rejects(
    () =>
      callManagement(impl, {
        baseUrl: "http://omniroute:20128",
        method: "GET",
        path: "/api/providers",
        body: null,
        resolveKey: async () => "sk-leak1234567890",
      }),
    (e) => e instanceof OmniRouteError && !e.message.includes("sk-") && !e.message.includes("Authorization"),
  );
});

test("an upstream error body is never quoted back to the caller", async () => {
  const { impl } = fakeFetch(
    okResponse({ error: { code: "AUTH_001", message: "key sk-secret1234567890", correlation_id: "cid-1" } }, 403),
  );
  await assert.rejects(
    () =>
      callManagement(impl, {
        baseUrl: "http://omniroute:20128",
        method: "GET",
        path: "/api/providers",
        body: null,
        resolveKey: async () => "sk-test1234567890abc",
      }),
    (e) => e.message.includes("AUTH_001") && e.message.includes("cid-1") && !e.message.includes("sk-secret"),
  );
});

test("an upstream 401/403 becomes 503 — it is our misconfiguration, not the caller's fault", () => {
  assert.equal(mapUpstreamStatus(401), 503);
  assert.equal(mapUpstreamStatus(403), 503);
  assert.equal(mapUpstreamStatus(404), 404);
  assert.equal(mapUpstreamStatus(409), 409);
  assert.equal(mapUpstreamStatus(422), 400);
  assert.equal(mapUpstreamStatus(500), 502);
});

test("an unresolvable credential refuses before any request is issued", async () => {
  const { impl, calls } = fakeFetch(okResponse({}));
  await assert.rejects(
    () =>
      callManagement(impl, {
        baseUrl: "http://omniroute:20128",
        method: "GET",
        path: "/api/providers",
        body: null,
        resolveKey: async () => "",
      }),
    (e) => e instanceof OmniRouteError && e.status === 503,
  );
  assert.equal(calls.length, 0, "no request may be issued without a credential");
});

test("a path outside /api/ is refused before the credential is resolved", async () => {
  let resolved = false;
  await assert.rejects(
    () =>
      callManagement(async () => okResponse({}), {
        baseUrl: "http://omniroute:20128",
        method: "GET",
        path: "/etc/passwd",
        body: null,
        resolveKey: async () => {
          resolved = true;
          return "sk-x1234567890abcdef";
        },
      }),
    (e) => e instanceof OmniRouteError && e.status === 500,
  );
  assert.equal(resolved, false, "the credential must not be resolved for a refused path");
});

test("base URL normalisation refuses non-http and query-bearing values", () => {
  assert.equal(normalizeBaseUrl("http://omniroute:20128/"), "http://omniroute:20128");
  assert.equal(normalizeBaseUrl(" http://omniroute:20128 "), "http://omniroute:20128");
  for (const bad of ["", null, "file:///etc", "ftp://x", "http://x?y=1", "not a url"]) {
    assert.throws(() => normalizeBaseUrl(bad), (e) => e instanceof OmniRouteError, String(bad));
  }
});

// ───────────────────────── audit discipline ────────────────────────────────

const auditFixture = () => ({
  companyId: "co-1",
  issueId: "issue-1",
  verb: resolveVerb("providers.create"),
  request: { method: "POST", path: "/api/providers", body: { name: "x", apiKey: "sk-aaaaaaaaaaaaaaaa" } },
  approval: { approval: APPROVAL.SINGLE, escalated: false, reason: "r" },
  ownership: { agentId: AGENT_A, runId: RUN_A, status: "in_progress", checkoutRunId: RUN_A },
  phase: "applied",
});

test("the audit record masks a credential submitted in the body", () => {
  const record = buildRecord(auditFixture());
  assert.equal(record.metadata.body.apiKey, "[redacted]");
  assert.equal(record.metadata.body.name, "x");
});

test("the audit record carries the approval class and the lifecycle terms", () => {
  const record = buildRecord(auditFixture());
  assert.equal(record.metadata.approvalClass, APPROVAL.SINGLE);
  assert.equal(record.metadata.issueStatus, "in_progress");
  assert.equal(record.metadata.checkoutRunId, RUN_A);
  assert.equal(record.metadata.agentId, AGENT_A);
});

test("preflight proves the log by WRITING to it, and refuses the mutation when it cannot", async () => {
  const written = [];
  await preflight({ activity: { log: async (r) => written.push(r) } }, buildRecord(auditFixture()));
  assert.equal(written.length, 1, "preflight must actually write, not probe a permission bit");
  assert.equal(written[0].metadata.phase, "attempt");

  await assert.rejects(
    () =>
      preflight(
        { activity: { log: async () => { throw new Error("read-only"); } } },
        buildRecord(auditFixture()),
      ),
    (e) => e.status === 503 && e.message.includes("No change has been made"),
  );
});

test("an audit failure AFTER a mutation is loud and names the applied mutation", async () => {
  const ctx = { activity: { log: async () => { throw new Error("disk full"); } } };
  const record = buildRecord(auditFixture());
  await assert.rejects(
    () => commit(ctx, record, { applied: true }),
    (e) =>
      e instanceof UnrecordedMutationError &&
      e.message.includes("THE MUTATION WAS APPLIED AND IS NOT IN THE LOG") &&
      e.record === record,
  );
});

test("an audit failure BEFORE a mutation is an ordinary refusal, not the disaster", async () => {
  const ctx = { activity: { log: async () => { throw new Error("disk full"); } } };
  await assert.rejects(
    () => commit(ctx, buildRecord(auditFixture()), { applied: false }),
    (e) => !(e instanceof UnrecordedMutationError) && e.status === 503,
  );
});

test("the audit write is never best-effort — a throw propagates", async () => {
  // The [RESOLVED-8] rule: `|| true` on the append is what let an unrecorded
  // mutation look like a normal error.
  let threw = false;
  try {
    await commit({ activity: { log: async () => { throw new Error("x"); } } }, buildRecord(auditFixture()), {
      applied: false,
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, true);
});

// ───────────────────────── manifest ────────────────────────────────────────

test("no route uses the checkoutPolicy that skips the ownership check", () => {
  for (const route of manifest.apiRoutes) {
    assert.notEqual(
      route.checkoutPolicy,
      "required-for-agent-in-progress",
      `route "${route.routeKey}" uses the policy that skips assertCheckoutOwner for unowned issues`,
    );
  }
});

test("every route is agent-authenticated — a board session cannot drive the broker", () => {
  for (const route of manifest.apiRoutes) {
    assert.equal(route.auth, "agent", `route "${route.routeKey}"`);
  }
});

test("every mutating route resolves its company from the issue, not from the caller", () => {
  for (const route of manifest.apiRoutes) {
    if (route.routeKey === "whoami") continue;
    assert.equal(route.companyResolution.from, "issue", `route "${route.routeKey}"`);
  }
});

test("the manifest declares no capability it does not need, and none that hands out credentials", () => {
  assert.ok(manifest.capabilities.includes("secrets.read-ref"));
  // A broker that could register agent tools or write grants would be a
  // different, much larger blast radius.
  for (const forbidden of ["agent.tools.register", "authorization.grants.write", "access.members.write", "agents.managed"]) {
    assert.ok(!manifest.capabilities.includes(forbidden), `must not declare ${forbidden}`);
  }
});

test("the config schema pins the secret-ref shape rather than trusting format: secret-ref", () => {
  // TOG-228: the host registers `secret-ref` as a format that validates nothing,
  // so a pasted plaintext key would otherwise be accepted and stored verbatim.
  const ref = manifest.instanceConfigSchema.properties.managementKeyRef;
  assert.equal(ref.type, "object");
  assert.equal(ref.additionalProperties, false);
  assert.deepEqual(ref.required, ["type", "secretId"]);
  assert.equal(ref.properties.type.const, "secret_ref");
});

test("the management base URL default targets the management port via the container alias", () => {
  const url = manifest.instanceConfigSchema.properties.managementBaseUrl.default;
  assert.ok(url.includes(":20128"), "must be the management port, not the :20129 inference port");
  assert.ok(!url.includes("127.0.0.1"), "127.0.0.1 is the worker itself from inside a container");
});

/* ────────────────────────────────────────────────────────────────────────────
 * Mapping verbs (added after the CISO's scope ruling on cbcc170b).
 *
 * A mapping is not another combo: a combo is inert, the mapping is the object
 * that moves traffic. These tests pin the class, the guard, and the two places
 * the guard could have been dodged.
 * ──────────────────────────────────────────────────────────────────────────── */

const MAPPING_OK = Object.freeze({
  pattern: "gpt-4o-mini",
  comboId: "combo-123",
  priority: 100,
  enabled: true,
  description: "TOG-178 phase 6.",
});

test("every mapping verb exists and targets the mapping route", () => {
  for (const name of ["mappings.list", "mappings.create", "mappings.delete"]) {
    const verb = resolveVerb(name);
    assert.ok(
      verb.path.startsWith("/api/model-combo-mappings"),
      `${name} must target the mapping route, got ${verb.path}`,
    );
    assert.equal(verb.resource, "mapping");
  }
});

test("mappings.list is an ungated read; both mutations are two-key", () => {
  assert.equal(resolveVerb("mappings.list").approval, APPROVAL.NONE);
  assert.equal(classifyApproval(resolveVerb("mappings.create"), MAPPING_OK).approval, APPROVAL.DUAL);
  assert.equal(classifyApproval(resolveVerb("mappings.delete"), {}).approval, APPROVAL.DUAL);
});

test("mappings.create could not have been SINGLE: its required body trips the paid-traffic wire", () => {
  // This is the contradiction that decided the class. The route's own contract
  // requires `priority`, and the guard requires it explicitly — and `priority`
  // is a PAID_TRAFFIC_KEY. So a SINGLE declaration would have escalated to DUAL
  // on every conforming call, i.e. the label would never have matched behaviour.
  assert.ok(PAID_TRAFFIC_KEYS.includes("priority"));
  assert.ok(touchesPaidTraffic(MAPPING_OK));
});

test("every mapping resource has a redaction allowlist, so the output re-check cannot refuse it", () => {
  for (const name of Object.keys(VERBS)) {
    const resource = VERBS[name].resource;
    assert.ok(
      Object.hasOwn(FIELD_ALLOWLIST, resource),
      `verb ${name} declares resource "${resource}" with no field allowlist`,
    );
  }
});

test("a mapping list response is unwrapped from its {mappings:[...]} envelope", () => {
  // Without "mappings" in LIST_KEYS this returns count 1 of an empty object —
  // a silently wrong answer rather than an error.
  const { records, count } = redactResponse(
    { mappings: [{ id: "m1", pattern: "gpt-4o-mini", comboId: "c1", priority: 100, enabled: true }], total: 1 },
    "mapping",
  );
  assert.equal(count, 1);
  assert.equal(records[0].pattern, "gpt-4o-mini");
  assert.equal(records[0].priority, 100);
});

test("mappings.create refuses wildcard patterns", () => {
  for (const pattern of ["gpt-4*", "gpt-4?", "*"]) {
    assert.throws(
      () => buildRequest(resolveVerb("mappings.create"), { body: { ...MAPPING_OK, pattern } }),
      (error) => error instanceof VerbError && error.status === 400 && /wildcard/i.test(error.message),
      `pattern ${pattern} must be refused`,
    );
  }
});

test("mappings.create refuses the protected model families, by family and not by substring", () => {
  // Each of these carries a family name but NOT necessarily the substring
  // "claude" — the TOG-237 bypass class. Mythos is not in today's live catalogue,
  // so this unit case makes the new Claude family fail closed on first appearance.
  for (const pattern of ["aug/opus-5", "sonnet-5", "haiku-4-5", "fable-5", "mythos-5", "claude-opus-5"]) {
    assert.throws(
      () => buildRequest(resolveVerb("mappings.create"), { body: { ...MAPPING_OK, pattern } }),
      (error) => error instanceof VerbError && error.status === 403,
      `pattern ${pattern} must be refused`,
    );
  }
});

test("mappings.create refuses blended ids whose Claude-ness is not in the id", () => {
  // `aug/prism-a` is `"name": "Prism (Claude + Gemini)"` in the live catalogue.
  // Nothing in the ID says Claude, and this guard only ever sees the caller's
  // pattern string — it never holds the catalogue record — so no id-shaped rule
  // can derive this. The token must be enumerated. A 480-id fixture missed it and
  // certified "0 escaped"; the live 1432-id run found it (2026-08-25).
  //
  // prism-b is "Prism (GPT + Kimi)" and carries no Claude. It is refused anyway,
  // because the two are indistinguishable by id. That over-block is deliberate:
  // TOG-178 names neither, so it costs nothing addressable.
  for (const pattern of ["aug/prism-a", "aug/prism-b"]) {
    assert.throws(
      () => buildRequest(resolveVerb("mappings.create"), { body: { ...MAPPING_OK, pattern } }),
      (error) => error instanceof VerbError && error.status === 403,
      `pattern ${pattern} must be refused`,
    );
  }
});

test("mappings.create requires an explicit integer priority", () => {
  for (const priority of [undefined, null, "100", 1.5, Number.NaN]) {
    const body = { ...MAPPING_OK };
    if (priority === undefined) delete body.priority;
    else body.priority = priority;
    assert.throws(
      () => buildRequest(resolveVerb("mappings.create"), { body }),
      (error) => error instanceof VerbError && /priority/.test(error.message),
      `priority ${String(priority)} must be refused`,
    );
  }
});

test("mappings.create refuses a body key the shipped route does not accept", () => {
  assert.throws(
    () => buildRequest(resolveVerb("mappings.create"), { body: { ...MAPPING_OK, isActive: false } }),
    (error) => error instanceof VerbError && error.status === 400 && /unknown key/i.test(error.message),
  );
});

test("a conforming TOG-178-shaped mapping is accepted and forwarded verbatim", () => {
  const request = buildRequest(resolveVerb("mappings.create"), { body: MAPPING_OK });
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/api/model-combo-mappings");
  assert.deepEqual(request.body, MAPPING_OK);
});

test("the guard cannot be dodged via the approve path", () => {
  // handleApprove rebuilds the request from the STORED body with buildRequest.
  // Wiring the guard into the operate handler alone would have left a hole where
  // a body stored as a proposal executes unchecked. Same call, same refusal.
  assert.throws(
    () => buildRequest(resolveVerb("mappings.create"), { body: { ...MAPPING_OK, pattern: "claude-opus*" } }),
    (error) => error instanceof VerbError,
  );
});

test("mappings.delete substitutes its id and takes no body constraint", () => {
  const request = buildRequest(resolveVerb("mappings.delete"), { params: { id: "m-42" } });
  assert.equal(request.method, "DELETE");
  assert.equal(request.path, "/api/model-combo-mappings/m-42");
});

test("the guard accepts all 52 real TOG-178 mapping patterns", { skip: existsSync(TOG_178_PLAN) ? false : "plan file not present" }, () => {
  // The point of the guard is to be strictly narrower than the operator path
  // WITHOUT blocking the work it exists to enable. That is an empirical claim
  // about a specific 52-row plan, so it is tested against the real file rather
  // than against a restatement of it.
  const plan = JSON.parse(readFileSync(TOG_178_PLAN, "utf8"));
  assert.equal(plan.length, 52);
  for (const mapping of plan) {
    assertMappingCreate({
      pattern: mapping.pattern,
      comboId: "resolved-at-runtime",
      priority: mapping.priority,
      enabled: true,
      description: `TOG-178 exact-pattern mapping -> ${mapping.comboName}`,
    });
  }
});
