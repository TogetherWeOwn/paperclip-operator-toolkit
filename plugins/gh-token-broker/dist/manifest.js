/**
 * gh-token-broker — manifest.
 *
 * TOG-174. The App PEM currently projects into agent run environments as a plain
 * env var, where any run that reads untrusted input can exfiltrate it (and, per
 * TOG-191, any same-uid process can read it out of /proc regardless of grants).
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
    // Derive scope server-side from the issue the caller actually holds.
    "issues.read",
    "projects.read",
    "project.workspaces.read",
    // Audit every mint. Never records the token or the PEM.
    "activity.log.write",
  ],

  entrypoints: {
    worker: "./dist/worker.js",
  },

  apiRoutes: [
    {
      // Step 1 of the operator's de-risk order: prove that agent-authenticated
      // plugin API routes dispatch at all, and that the host hands the worker a
      // server-derived runId. Deliberately does nothing else — no secrets, no
      // outbound calls — so it is safe to leave installed.
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
      // checkoutPolicy MUST be "always-for-agent", not
      // "required-for-agent-in-progress". Read the host enforcement in
      // server/dist/routes/plugins.js before changing this:
      //
      //   if (policy === "required-for-agent-in-progress") {
      //     if (issue.status !== "in_progress" ||
      //         issue.assigneeAgentId !== req.actor.agentId) return;
      //   }
      //
      // That policy *skips* assertCheckoutOwner in exactly the case an attacker
      // would pick — an issue the caller does not own. It would let any agent
      // mint a repo-scoped token for any project in the company by naming a
      // stale issue in that project. "always-for-agent" calls
      // assertCheckoutOwner unconditionally, which requires status
      // in_progress + assignee == caller + matching run lock.
      routeKey: "mint",
      method: "POST",
      path: "/issues/:issueId/github-token",
      auth: "agent",
      capability: "api.routes.register",
      checkoutPolicy: "always-for-agent",
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
    },
  },
};

export default manifest;
