/**
 * gh-token-broker — manifest.
 *
 * The App PEM currently projects into agent run environments as a plain
 * env var, where any run that reads untrusted input can exfiltrate it (and, per
 * Any same-uid process can read it out of /proc regardless of grants).
 *
 * This plugin moves minting to the control plane: the agent asks the host for a
 * token, the host resolves the PEM server-side, and only a narrow, repo-scoped,
 * short-lived installation token crosses back. The signing key never enters an
 * agent's address space.
 */

export const manifest = {
  id: "gh-token-broker",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "GitHub Token Broker",
  description:
    "Mints least-privilege, repo-scoped GitHub App installation tokens for agent runs. The App private key stays server-side and is never returned.",
  author: "Chief Security & Trust Officer (Paperclip)",
  categories: ["connector"],

  capabilities: [
    // Expose the broker routes.
    "api.routes.register",
    // Resolve the App PEM server-side. This is the whole point: the key is
    // resolved inside the host process and never handed to a run.
    "secrets.read-ref",
    // Call api.github.com to mint.
    "http.outbound",
    // Persist disclosure grant consumption and signed receipts server-side.
    "database.namespace.read",
    "database.namespace.write",
    "database.namespace.migrate",
    // Derive scope server-side from the issue the caller actually holds.
    "issues.read",
    // Held for its *side effects*, not as the gate: the host's
    // assertCheckoutOwner clears a checkout lock left behind by a terminated run
    // before it evaluates anything, and adopts an unowned lock for the caller.
    // The broker calls it best-effort so that behaviour survives the move to
    // checkoutPolicy "none". A conflict from it is not fatal — its status term
    // is precisely what ownership.js widens.
    "issues.checkout",
    "projects.read",
    "project.workspaces.read",
    // Audit every mint. Never records the token or the PEM.
    "activity.log.write",
  ],

  entrypoints: {
    worker: "./dist/worker.js",
  },

  database: {
    namespaceSlug: "gh_token_broker",
    migrationsDir: "./migrations",
    coreReadTables: ["heartbeat_runs"],
  },

  apiRoutes: [
    {
      routeKey: "disclosure-preflight",
      method: "POST",
      path: "/issues/:issueId/external-disclosures/preflight",
      auth: "agent",
      capability: "api.routes.register",
      checkoutPolicy: "none",
      companyResolution: { from: "issue", param: "issueId" },
    },
    {
      routeKey: "disclose",
      method: "POST",
      path: "/issues/:issueId/external-disclosures",
      auth: "agent",
      capability: "api.routes.register",
      checkoutPolicy: "none",
      companyResolution: { from: "issue", param: "issueId" },
    },
    {
      // Step 1 of the operator's de-risk order: prove that agent-authenticated
      // plugin API routes dispatch at all, and that the host hands the worker an
      // actor. Deliberately does nothing else — no secrets, no outbound calls —
      // so it is safe to leave installed.
      //
      // It does NOT prove the runId is server-derived, and an earlier
      // revision of this comment said it did. `actorType`, `agentId` and
      // `companyId` are host-derived on every auth path; `runId` is signed only
      // on the agent-JWT path and is an unvalidated request header on the
      // long-lived agent-key path. See the runId provenance section in
      // README.md.
      routeKey: "whoami",
      method: "GET",
      path: "/whoami",
      auth: "agent",
      capability: "api.routes.register",
      checkoutPolicy: "none",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      // Step 2: the actual broker.
      //
      // checkoutPolicy is "none" and the gate lives in the worker
      // (dist/ownership.js). That reads like a relaxation and is not one. The
      // three host policies are:
      //
      //   "required-for-agent-in-progress" — NEVER USE. The host reads:
      //       if (policy === "required-for-agent-in-progress") {
      //         if (issue.status !== "in_progress" ||
      //             issue.assigneeAgentId !== req.actor.agentId) return;
      //       }
      //     It *skips* assertCheckoutOwner in exactly the case an attacker would
      //     pick — an issue the caller does not own — so any agent could mint for
      //     any project in the company by naming a stale issue in it.
      //
      //   "always-for-agent" — what this route used to be. Asserts ownership
      //     unconditionally, but hardcodes status == in_progress, which refuses
      //     an agent working its own issue in in_review. Because the credential
      //     helper correctly treats the resulting 409 as definitive and will not
      //     fall back to the org-admin PEM, that refusal kills git.
      //     The host cannot express a wider status set, and patching the control
      //     plane is not ours to do.
      //
      //   "none" — the host still enforces auth: "agent" and, independently of
      //     this setting, assertCompanyAccess() against the company resolved
      //     from the issue below. So cross-company is closed either way. What is
      //     left — assignee, run lock, status — is asserted in
      //     assertMintOwnership() before any secret is resolved.
      //
      // The honest cost: there is no longer a second, independent enforcement of
      // the assignee and run-lock terms behind the worker. That is why
      // ownership.js re-asserts both verbatim, fails closed on an absent field,
      // and is unit-tested directly.
      routeKey: "mint",
      method: "POST",
      path: "/issues/:issueId/github-token",
      auth: "agent",
      capability: "api.routes.register",
      checkoutPolicy: "none",
      companyResolution: { from: "issue", param: "issueId" },
    },
  ],

  instanceConfigSchema: {
    type: "object",
    required: ["appId", "org", "privateKeyRef"],
    properties: {
      appId: {
        type: "string",
        title: "GitHub App ID",
        description: "Numeric App ID, e.g. 4685085.",
      },
      org: {
        type: "string",
        title: "Organization login",
        description: "Org the App is installed on, e.g. TogetherWeOwn.",
      },
      privateKeyRef: {
        type: "object",
        title: "App private key (secret reference)",
        description:
          "Secret ref for the App PEM. Resolved server-side at mint time and never returned to a caller.",
      },
      installationId: {
        type: "number",
        title: "Installation ID (optional)",
        description:
          "Skips an installation lookup per mint. Discovered from org when omitted.",
      },
      tokenTtlMinutes: {
        type: "number",
        title: "Requested token lifetime (minutes)",
        description:
          "Advisory. GitHub caps installation tokens at 60 minutes and ignores longer requests.",
        default: 60,
      },
      defaultPermissions: {
        type: "object",
        title: "Default permission profile",
        description:
          "Applied when a project does not set GH_APP_PERMISSIONS. Defaults to contents/pull_requests/issues write plus metadata read.",
      },
      externalDisclosureAuthorizers: {
        type: "array",
        title: "External disclosure authorizers",
        description:
          "Trusted Ed25519 public keys and their authorizing principals. Empty or omitted fails closed.",
        default: [],
        items: {
          type: "object",
          required: ["keyId", "algorithm", "authorizingPrincipal", "publicKeyPem"],
          additionalProperties: false,
          properties: {
            keyId: { type: "string" },
            algorithm: { type: "string", enum: ["ed25519"] },
            authorizingPrincipal: {
              type: "object",
              required: ["principalClass", "principalId"],
              additionalProperties: false,
              properties: {
                principalClass: { type: "string" },
                principalId: { type: "string" },
              },
            },
            publicKeyPem: { type: "string" },
          },
        },
      },
    },
  },
};

export default manifest;
