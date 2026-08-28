/**
 * GitHub App minting.
 *
 * Note on TOG-200: nothing here shells out. The App JWT and the minted token
 * exist only as in-process strings passed to `ctx.http.fetch`, so neither ever
 * lands on a command line where `/proc/<pid>/cmdline` would expose it.
 */

import { createSign } from "node:crypto";

const GITHUB_API = "https://api.github.com";

const API_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "paperclip-gh-token-broker/0.1.0",
};

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

/**
 * Sign a short-lived App JWT (RS256). GitHub rejects anything over 10 minutes;
 * we ask for 9 and backdate 30s to absorb clock skew.
 *
 * @param {string} appId
 * @param {string} privateKeyPem - resolved server-side; never logged or returned
 * @param {number} [nowSeconds]
 */
export function createAppJwt(appId, privateKeyPem, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!appId) throw new GitHubError("Missing GitHub App ID.", 500);
  if (!privateKeyPem || !privateKeyPem.includes("PRIVATE KEY")) {
    throw new GitHubError("App private key did not resolve to a PEM.", 500);
  }

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: nowSeconds - 30,
    exp: nowSeconds + 9 * 60,
    iss: String(appId),
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer
    .sign(privateKeyPem)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `${signingInput}.${signature}`;
}

async function readError(response) {
  let detail = "";
  try {
    const text = await response.text();
    // Surface GitHub's message but never echo request material back.
    try {
      detail = JSON.parse(text)?.message ?? text.slice(0, 200);
    } catch {
      detail = text.slice(0, 200);
    }
  } catch {
    detail = "";
  }
  return detail;
}

/** Look up the installation id for an org. */
export async function getInstallationId(fetchImpl, org, jwt) {
  const response = await fetchImpl(`${GITHUB_API}/orgs/${encodeURIComponent(org)}/installation`, {
    method: "GET",
    headers: { ...API_HEADERS, Authorization: `Bearer ${jwt}` },
  });

  if (!response.ok) {
    throw new GitHubError(
      `Could not resolve installation for org "${org}": ${response.status} ${await readError(response)}`,
      502,
    );
  }
  const body = await response.json();
  if (!body?.id) throw new GitHubError("Installation lookup returned no id.", 502);
  return body.id;
}

/**
 * Mint a down-scoped installation token.
 *
 * `repositories` must be non-empty — an omitted array means every repo in the
 * installation. `scope.js` guarantees this, and we assert it again here because
 * getting it wrong silently reintroduces the whole finding.
 */
export async function mintInstallationToken(fetchImpl, installationId, jwt, { repositories, permissions }) {
  if (!Array.isArray(repositories) || repositories.length === 0) {
    throw new GitHubError(
      "Refusing to mint: empty repository scope would grant the whole installation.",
      500,
    );
  }
  if (!permissions || Object.keys(permissions).length === 0) {
    throw new GitHubError("Refusing to mint: empty permission set.", 500);
  }

  const response = await fetchImpl(
    `${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: "POST",
      headers: {
        ...API_HEADERS,
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ repositories, permissions }),
    },
  );

  if (response.status !== 201) {
    throw new GitHubError(
      `Mint failed: ${response.status} ${await readError(response)}`,
      response.status === 422 ? 400 : 502,
    );
  }

  const body = await response.json();
  if (!body?.token) throw new GitHubError("Mint returned no token.", 502);

  return {
    token: body.token,
    issuedAt: new Date().toISOString(),
    expiresAt: body.expires_at ?? null,
    installationId: String(installationId),
    repositorySelection: body.repository_selection ?? (Array.isArray(body.repositories) ? "selected" : null),
    // Echo back what GitHub actually granted, not what we asked for. If these
    // diverge, the App's own ceiling is narrower than the profile and the
    // caller should see the truth.
    permissions: body.permissions ?? null,
    repositories: Array.isArray(body.repositories)
      ? body.repositories.map((r) => r?.name).filter(Boolean)
      : null,
  };
}

export async function submitRepositoryMutation(fetchImpl, token, destination, action, body) {
  const response = await fetchImpl(
    `${destination.apiOrigin}${destination.endpoint}`,
    {
      method: action,
      headers: {
        ...API_HEADERS,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
      redirect: "error",
    },
  );

  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { status: response.status, ok: response.ok, body: parsed };
}
