import crypto from "node:crypto";

export class DisclosureError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "DisclosureError";
    this.status = status;
  }
}

const LEVEL = Object.freeze({ read: 1, write: 2, admin: 3 });
const MUTATING_ACTIONS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function fail(message, status = 400) {
  throw new DisclosureError(message, status);
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
}

function exactKeys(value, keys, label) {
  assertObject(value, label);
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} keys must be exactly: ${expected.join(", ")}; got: ${actual.join(", ") || "(none)"}.`);
  }
}

function nonempty(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string.`);
  return value.trim();
}

function iso(value, label) {
  const text = nonempty(value, label);
  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) fail(`${label} must be an ISO timestamp.`);
  return new Date(millis).toISOString();
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function same(left, right) {
  return canonical(left) === canonical(right);
}

function validateDestination(value) {
  exactKeys(value, ["provider", "apiOrigin", "repository", "endpoint"], "grant.destination");
  if (value.provider !== "github") fail('grant.destination.provider must be "github".');
  if (value.apiOrigin !== "https://api.github.com") {
    fail('grant.destination.apiOrigin must be exactly "https://api.github.com".');
  }
  const repository = nonempty(value.repository, "grant.destination.repository");
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)) {
    fail("grant.destination.repository must be one unencoded GitHub owner/name.");
  }
  const endpoint = nonempty(value.endpoint, "grant.destination.endpoint");
  const repositoryPrefix = `/repos/${repository}`;
  if (
    !endpoint.startsWith(`${repositoryPrefix}/`) ||
    endpoint.includes("?") || endpoint.includes("#") || endpoint.includes("%") ||
    endpoint.includes("\\") || endpoint.includes("//")
  ) {
    fail(`grant.destination.endpoint must be one unencoded canonical path beneath ${repositoryPrefix}/.`);
  }
  let parsed;
  try {
    parsed = new URL(endpoint, value.apiOrigin);
  } catch {
    fail("grant.destination.endpoint is not a valid URL path.");
  }
  if (parsed.origin !== value.apiOrigin || parsed.pathname !== endpoint || parsed.search || parsed.hash) {
    fail("grant.destination.endpoint must equal its canonical URL pathname.");
  }
  const segments = endpoint.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    fail("grant.destination.endpoint must not contain dot segments.");
  }
  return { provider: "github", apiOrigin: value.apiOrigin, repository, endpoint };
}

function validatePrincipal(value, label) {
  exactKeys(value, ["principalClass", "credentialClass", "principalId"], label);
  if (!['human', 'github_app'].includes(value.principalClass)) {
    fail(`${label}.principalClass must be human or github_app.`);
  }
  const expectedCredential = value.principalClass === "human"
    ? "github_user_token"
    : "github_app_installation_token";
  if (value.credentialClass !== expectedCredential) {
    fail(`${label}.credentialClass must be ${expectedCredential} for ${value.principalClass}.`);
  }
  return {
    principalClass: value.principalClass,
    credentialClass: value.credentialClass,
    principalId: nonempty(value.principalId, `${label}.principalId`),
  };
}

function validatePermissionMap(value, label) {
  assertObject(value, label);
  const entries = Object.entries(value);
  if (entries.length === 0) fail(`${label} must not be empty.`);
  const out = {};
  for (const [name, level] of entries) {
    nonempty(name, `${label} permission name`);
    if (!Object.hasOwn(LEVEL, level)) fail(`${label}.${name} must be read, write, or admin.`);
    out[name] = level;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function unsignedGrant(grant) {
  const { signature, ...payload } = grant;
  return payload;
}

export function validateGrant(value) {
  exactKeys(value, [
    "version", "destination", "channel", "action", "artifacts",
    "authenticatingPrincipal", "authorizingPrincipal", "approvalRecord",
    "approvedAt", "expiresAt", "allowedIssueId", "allowedRunId",
    "requiredPermissions", "signature",
  ], "grant");
  if (value.version !== 1) fail("grant.version must be 1.");
  const action = nonempty(value.action, "grant.action").toUpperCase();
  if (!MUTATING_ACTIONS.has(action)) fail("grant.action must be POST, PUT, PATCH, or DELETE.");
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) {
    fail("grant.artifacts must be a non-empty array.");
  }
  const ids = new Set();
  const artifacts = value.artifacts.map((artifact, index) => {
    exactKeys(artifact, ["id", "sha256"], `grant.artifacts[${index}]`);
    const id = nonempty(artifact.id, `grant.artifacts[${index}].id`);
    if (ids.has(id)) fail(`grant.artifacts contains duplicate id "${id}".`);
    ids.add(id);
    if (!isSha256(artifact.sha256)) fail(`grant.artifacts[${index}].sha256 must be 64 lowercase hex characters.`);
    return { id, sha256: artifact.sha256 };
  }).sort((a, b) => a.id.localeCompare(b.id));
  exactKeys(value.authorizingPrincipal, ["principalClass", "principalId"], "grant.authorizingPrincipal");
  exactKeys(value.approvalRecord, ["id", "source", "sha256"], "grant.approvalRecord");
  if (!isSha256(value.approvalRecord.sha256)) fail("grant.approvalRecord.sha256 must be 64 lowercase hex characters.");
  exactKeys(value.signature, ["algorithm", "keyId", "value"], "grant.signature");
  if (value.signature.algorithm !== "ed25519") fail("grant.signature.algorithm must be ed25519.");
  const approvedAt = iso(value.approvedAt, "grant.approvedAt");
  const expiresAt = iso(value.expiresAt, "grant.expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(approvedAt)) fail("grant.expiresAt must be after grant.approvedAt.");
  return {
    version: 1,
    destination: validateDestination(value.destination),
    channel: nonempty(value.channel, "grant.channel"),
    action,
    artifacts,
    authenticatingPrincipal: validatePrincipal(value.authenticatingPrincipal, "grant.authenticatingPrincipal"),
    authorizingPrincipal: {
      principalClass: nonempty(value.authorizingPrincipal.principalClass, "grant.authorizingPrincipal.principalClass"),
      principalId: nonempty(value.authorizingPrincipal.principalId, "grant.authorizingPrincipal.principalId"),
    },
    approvalRecord: {
      id: nonempty(value.approvalRecord.id, "grant.approvalRecord.id"),
      source: nonempty(value.approvalRecord.source, "grant.approvalRecord.source"),
      sha256: value.approvalRecord.sha256,
    },
    approvedAt,
    expiresAt,
    allowedIssueId: nonempty(value.allowedIssueId, "grant.allowedIssueId"),
    allowedRunId: nonempty(value.allowedRunId, "grant.allowedRunId"),
    requiredPermissions: validatePermissionMap(value.requiredPermissions, "grant.requiredPermissions"),
    signature: {
      algorithm: "ed25519",
      keyId: nonempty(value.signature.keyId, "grant.signature.keyId"),
      value: nonempty(value.signature.value, "grant.signature.value"),
    },
  };
}

function parseAuthorizers(value) {
  if (!Array.isArray(value)) fail("Broker externalDisclosureAuthorizers must be an array.", 503);
  const keys = new Map();
  value.forEach((entry, index) => {
    exactKeys(entry, ["keyId", "algorithm", "authorizingPrincipal", "publicKeyPem"], `authorizer[${index}]`);
    if (entry.algorithm !== "ed25519") fail(`authorizer[${index}].algorithm must be ed25519.`, 503);
    exactKeys(entry.authorizingPrincipal, ["principalClass", "principalId"], `authorizer[${index}].authorizingPrincipal`);
    const keyId = nonempty(entry.keyId, `authorizer[${index}].keyId`);
    if (keys.has(keyId)) fail(`Broker has duplicate authorizer keyId "${keyId}".`, 503);
    const authorizingPrincipal = {
      principalClass: nonempty(entry.authorizingPrincipal.principalClass, `authorizer[${index}].authorizingPrincipal.principalClass`),
      principalId: nonempty(entry.authorizingPrincipal.principalId, `authorizer[${index}].authorizingPrincipal.principalId`),
    };
    const publicKeyPem = nonempty(entry.publicKeyPem, `authorizer[${index}].publicKeyPem`);
    try {
      if (crypto.createPublicKey(publicKeyPem).asymmetricKeyType !== "ed25519") {
        fail(`authorizer[${index}].publicKeyPem is not an Ed25519 key.`, 503);
      }
    } catch (error) {
      if (error instanceof DisclosureError) throw error;
      fail(`authorizer[${index}].publicKeyPem is invalid.`, 503);
    }
    keys.set(keyId, { authorizingPrincipal, publicKeyPem });
  });
  return keys;
}

export function verifyGrantSignature(grant, authorizers) {
  const trusted = parseAuthorizers(authorizers).get(grant.signature.keyId);
  if (!trusted) fail(`Grant signature keyId "${grant.signature.keyId}" is not trusted.`, 403);
  if (!same(trusted.authorizingPrincipal, grant.authorizingPrincipal)) {
    fail("Grant authorizingPrincipal does not equal the principal bound to its trusted signing key.", 403);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(grant.signature.value)) fail("grant.signature.value must be base64.");
  const signature = Buffer.from(grant.signature.value, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== grant.signature.value) {
    fail("grant.signature.value must be one canonical padded Ed25519 signature.");
  }
  const ok = crypto.verify(null, Buffer.from(canonical(unsignedGrant(grant))), trusted.publicKeyPem, signature);
  if (!ok) fail("Grant signature is invalid; the grant is not an approved immutable object.", 403);
}

function validateArtifacts(value) {
  if (!Array.isArray(value) || value.length === 0) fail("artifacts must be a non-empty array.");
  const ids = new Set();
  return value.map((artifact, index) => {
    exactKeys(artifact, ["id", "body"], `artifacts[${index}]`);
    const id = nonempty(artifact.id, `artifacts[${index}].id`);
    if (ids.has(id)) fail(`artifacts contains duplicate id "${id}".`);
    ids.add(id);
    if (typeof artifact.body !== "string") fail(`artifacts[${index}].body must be a string.`);
    const bytes = Buffer.from(artifact.body, "utf8");
    return { id, body: artifact.body, sha256: sha256(bytes) };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function validateRequestBody(body, requirePreflightId) {
  const keys = ["grant", "approvalRecord", "artifacts"];
  if (requirePreflightId) keys.push("preflightId");
  exactKeys(body, keys, "request body");
  if (typeof body.approvalRecord !== "string") fail("approvalRecord must be a string.");
  return {
    grant: validateGrant(body.grant),
    approvalRecord: body.approvalRecord,
    artifacts: validateArtifacts(body.artifacts),
    ...(requirePreflightId ? { preflightId: nonempty(body.preflightId, "preflightId") } : {}),
  };
}

export function validateDisclosureRequest(body) {
  return validateRequestBody(body, false);
}

export function validateDisclosureSubmission(body) {
  return validateRequestBody(body, true);
}

export function disclosureRequestHash(request) {
  return sha256(canonical({
    grantId: grantId(request.grant),
    approvalRecordSha256: sha256(Buffer.from(request.approvalRecord, "utf8")),
    artifacts: request.artifacts.map(({ id, sha256: digest }) => ({ id, sha256: digest })),
  }));
}

export function proveAuthority({ request, issue, actorRunId, now = Date.now() }) {
  const { grant, approvalRecord, artifacts } = request;
  if (now < Date.parse(grant.approvedAt) || now >= Date.parse(grant.expiresAt)) {
    fail("Authority refused: the grant is outside its approval/expiry window.", 403);
  }
  const comparisons = [
    ["issue ID", grant.allowedIssueId, issue.identifier],
    ["run ID", grant.allowedRunId, actorRunId],
    ["artifact set", grant.artifacts, artifacts.map(({ id, sha256: digest }) => ({ id, sha256: digest }))],
    ["approval record hash", grant.approvalRecord.sha256, sha256(Buffer.from(approvalRecord, "utf8"))],
  ];
  for (const [label, expected, actual] of comparisons) {
    if (!same(expected, actual)) fail(`Authority refused: current ${label} does not equal the immutable grant.`, 403);
  }
  return {
    ok: true,
    approvalId: grant.approvalRecord.id,
    approvalRecord: grant.approvalRecord,
    approvedAt: grant.approvedAt,
    expiresAt: grant.expiresAt,
    allowedIssueId: grant.allowedIssueId,
    allowedRunId: grant.allowedRunId,
    authorizingPrincipal: grant.authorizingPrincipal,
    artifactHashes: grant.artifacts,
  };
}

export function assertAppPrincipal(grant, appId) {
  const observed = {
    principalClass: "github_app",
    credentialClass: "github_app_installation_token",
    principalId: `github-app:${appId}`,
  };
  if (!same(grant.authenticatingPrincipal, observed)) {
    fail("Authority refused: this broker can satisfy only the exact configured GitHub App principal.", 403);
  }
  return observed;
}

export function grantId(grant) {
  return sha256(canonical({ keyId: grant.signature.keyId, authorization: unsignedGrant(grant) }));
}

export function assertPermissionGrant(required, effective) {
  for (const [name, level] of Object.entries(required)) {
    const actual = effective?.[name];
    if (!actual || LEVEL[actual] < LEVEL[level]) {
      fail(`Capability refused: effective permission ${name}=${actual || "none"} is below required ${level}.`, 403);
    }
  }
}

export function responseIdentifier(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  for (const key of ["ghsa_id", "id", "number", "html_url", "url"]) {
    const value = body[key];
    if (typeof value === "string" || typeof value === "number") return { field: key, value: String(value) };
  }
  return null;
}
