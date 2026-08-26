/**
 * omniroute-broker — manifest (TOG-391).
 *
 * OmniRoute's management credential can register a provider AND read every
 * other key's plaintext, across every company on this box. No narrower
 * credential exists that can do the first without the second (README, "The
 * claim the design rests on"). So the credential is not handed out at all: the
 * host holds it, and agents are given narrow VERBS instead.
 */

export const manifest = {
  id: "omniroute-broker",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "OmniRoute Operation Broker",
  description:
    "Performs a fixed set of narrow OmniRoute management operations on behalf of agent runs. The management credential stays server-side and is never returned.",
  author: "CTO & Chief AI Officer (Paperclip)",
  categories: ["connector"],

  capabilities: [
    "api.routes.register",
    // Resolve the management key server-side. The whole point.
    "secrets.read-ref",
    // Reach the OmniRoute management port.
    "http.outbound",
    // Derive authority server-side from the issue the caller demonstrably holds.
    "issues.read",
    // Held for its side effects only — see reconcileCheckoutLock in worker.js.
    "issues.checkout",
    // Two-key proposals live here. Never holds a credential.
    "plugin.state.read",
    "plugin.state.write",
    // Audit every operation. Never records the credential.
    "activity.log.write",
  ],

  entrypoints: { worker: "./dist/worker.js" },

  apiRoutes: [
    {
      // De-risk probe, mirroring gh-token-broker's. Does nothing but echo the
      // host-derived actor: no secret resolution, no outbound call. Safe to
      // leave installed, and it is what proves agent-authenticated plugin routes
      // dispatch on this instance before anything riskier is tried.
      routeKey: "whoami",
      method: "GET",
      path: "/whoami",
      auth: "agent",
      capability: "api.routes.register",
      checkoutPolicy: "none",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      // Ungated reads. Still ownership-checked (an agent must hold the issue) —
      // "ungated" in the owner's policy means "no approval ceremony", not
      // "unauthenticated". Responses are scrubbed by redact.js.
      routeKey: "read",
      method: "POST",
      path: "/issues/:issueId/read",
      auth: "agent",
      capability: "api.routes.register",
      checkoutPolicy: "none",
      companyResolution: { from: "issue", param: "issueId" },
    },
    {
      // Single-approval mutations, and the PROPOSE half of a two-key operation.
      // Which one it is is decided server-side by classifyApproval(), not by the
      // caller: a caller cannot opt out of the second key by choosing a route.
      routeKey: "operate",
      method: "POST",
      path: "/issues/:issueId/operate",
      auth: "agent",
      capability: "api.routes.register",
      checkoutPolicy: "none",
      companyResolution: { from: "issue", param: "issueId" },
    },
    {
      // The APPROVE half. Called by a DIFFERENT agent, under its own issue.
      routeKey: "approve",
      method: "POST",
      path: "/issues/:issueId/approve",
      auth: "agent",
      capability: "api.routes.register",
      checkoutPolicy: "none",
      companyResolution: { from: "issue", param: "issueId" },
    },
    {
      // Lets a would-be approver READ what it is being asked to approve before
      // it approves it. Without this, the second key is consent to an opaque id,
      // which is not consent.
      routeKey: "proposals",
      method: "GET",
      path: "/issues/:issueId/proposals",
      auth: "agent",
      capability: "api.routes.register",
      checkoutPolicy: "none",
      companyResolution: { from: "issue", param: "issueId" },
    },
  ],

  // ── Why every route above is checkoutPolicy: "none"
  //
  // This reads like a relaxation and is not one. Re-verified against the running
  // build at /app on 2026-08-25:
  //
  //   "required-for-agent-in-progress" — NEVER USE.
  //       server/dist/routes/plugins.js:394
  //         if (policy === "required-for-agent-in-progress") {
  //           if (issue.status !== "in_progress" ||
  //               issue.assigneeAgentId !== req.actor.agentId) return;
  //         }
  //       It SKIPS assertCheckoutOwner in exactly the case an attacker would
  //       choose — an issue the caller does not own.
  //
  //   "always-for-agent" — what TOG-391's issue text asks for. That instruction
  //       is STALE. It calls assertCheckoutOwner unconditionally, and that
  //       function hardcodes the status term (server/dist/services/issues.js:6325
  //       requires status === "in_progress"), so it refuses an agent working its
  //       own issue in in_review. TOG-309 measured that against the live GitHub
  //       broker and it killed the caller. The reference plugin has since moved
  //       OFF this policy for exactly this reason.
  //
  //   "none" — the host still enforces auth: "agent" and, independently of this
  //       setting, assertCompanyAccess() against the company resolved from the
  //       issue, so the CROSS-COMPANY boundary does not depend on our code. What
  //       is left — assignee, run lock, status — is asserted in ownership.js
  //       before any secret is resolved and before any outbound call.

  instanceConfigSchema: {
    type: "object",
    required: ["managementBaseUrl", "managementKeyRef"],
    additionalProperties: false,
    properties: {
      managementBaseUrl: {
        type: "string",
        title: "OmniRoute management base URL",
        description:
          "MANAGEMENT port (:20128), not the inference port (:20129). From a container use the network alias, e.g. http://omniroute:20128 — 127.0.0.1 is the worker itself and is refused.",
        default: "http://omniroute:20128",
      },
      managementKeyRef: {
        // Pinned to the host's secret-ref shape rather than left open. Per
        // TOG-228, `format: "secret-ref"` validates NOTHING — the host registers
        // it as `ajv.addFormat("secret-ref", {validate: () => true})` — so the
        // shape has to be pinned here or a pasted plaintext key would be
        // accepted and stored verbatim in the config row.
        type: "object",
        title: "Management credential (secret reference)",
        description:
          "Secret ref for the OmniRoute management key. Resolved server-side per operation and never returned to a caller. Must be a ref, never the key itself.",
        additionalProperties: false,
        required: ["type", "secretId"],
        properties: {
          type: { const: "secret_ref" },
          secretId: { type: "string", format: "uuid" },
        },
      },
      proposalTtlMinutes: {
        type: "number",
        title: "Two-key proposal lifetime (minutes)",
        description:
          "How long a pending dual-approval proposal stays approvable. An approval that never expires is a standing grant.",
        default: 60,
        minimum: 1,
        maximum: 1440,
      },
      requestTimeoutMs: {
        type: "number",
        title: "Upstream request timeout (ms)",
        default: 20000,
        minimum: 1000,
        maximum: 120000,
      },
    },
  },
};

export default manifest;
