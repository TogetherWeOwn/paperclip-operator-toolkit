/**
 * Pure scope-resolution logic for the GitHub token broker.
 *
 * Kept free of I/O so the security invariants can be tested directly. The
 * invariants, in order of how badly they fail:
 *
 *  1. `repositories` is NEVER empty. GitHub treats an omitted or empty
 *     `repositories` array as "every repo in the installation" — which is the
 *     exact 7-repo blast radius TOG-174 exists to remove. An empty scope must
 *     raise, never mint.
 *  2. A caller can only ever NARROW the profile, never widen it. Requested
 *     permissions must be a subset of the profile at a level no higher than the
 *     profile grants.
 *  3. Nothing here ever touches the PEM.
 */

/** Ordered weakest-to-strongest. Index is the comparison rank. */
const PERMISSION_LEVELS = ["read", "write", "admin"];

/**
 * The default agent profile, per the operator's decision on TOG-174:
 * `workflows` is deliberately excluded and granted per project instead, because
 * GitHub rejects an entire ref push when a branch touches `.github/workflows/**`
 * without it — so it is not a safe global default in either direction.
 */
export const DEFAULT_PERMISSION_PROFILE = Object.freeze({
  contents: "write",
  pull_requests: "write",
  issues: "write",
  metadata: "read",
});

export class ScopeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ScopeError";
    this.status = status;
  }
}

function rank(level) {
  return PERMISSION_LEVELS.indexOf(level);
}

/**
 * Parse `owner/repo` out of a repo URL or a bare name.
 * Accepts https, ssh, and `git@` forms; returns just the repo name, which is
 * what the installation-token API expects in `repositories`.
 */
export function parseRepoName(input) {
  if (typeof input !== "string") return null;
  let value = input.trim();
  if (!value) return null;

  // Traversal has no legitimate meaning in a repo coordinate. Reject rather
  // than normalising, so a malformed value never resolves to *something*.
  if (value.includes("..")) return null;

  // Strip a trailing .git.
  value = value.replace(/\.git$/i, "");

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  const sshMatch = value.match(/^[^@/]+@[^:/]+:(.+)$/);

  if (hasScheme) {
    // https://host/owner/repo → owner/repo. A URL with no path (e.g.
    // "https://github.com/") must not fall through to the segment split, where
    // it would yield the hostname as the repo name.
    const urlMatch = value.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i);
    if (!urlMatch) return null;
    value = urlMatch[1];
  } else if (sshMatch) {
    // git@github.com:owner/repo → owner/repo
    value = sshMatch[1];
  }

  const segments = value.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  // Take the last segment: the repo name.
  const name = segments[segments.length - 1];
  return /^[A-Za-z0-9._-]+$/.test(name) ? name : null;
}

/** Parse `GH_APP_REPOS` — a comma/space separated literal set by the operator. */
export function parseRepoList(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    const names = raw.map(parseRepoName).filter(Boolean);
    return names.length ? [...new Set(names)] : null;
  }
  if (typeof raw !== "string") return null;
  const names = raw
    .split(/[\s,]+/)
    .map(parseRepoName)
    .filter(Boolean);
  return names.length ? [...new Set(names)] : null;
}

/** Parse `GH_APP_PERMISSIONS` — e.g. `contents=write,workflows=write`. */
export function parsePermissionSpec(raw) {
  if (raw == null) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const entries = Object.entries(raw).filter(([, v]) => rank(v) >= 0);
    return entries.length ? Object.fromEntries(entries) : null;
  }
  if (typeof raw !== "string") return null;

  const out = {};
  for (const part of raw.split(/[\s,]+/).filter(Boolean)) {
    const [key, level] = part.split("=");
    if (!key || !level) {
      throw new ScopeError(
        `Malformed permission spec "${part}" — expected name=level.`,
      );
    }
    if (rank(level) < 0) {
      throw new ScopeError(
        `Unknown permission level "${level}" for "${key}" — expected read, write, or admin.`,
      );
    }
    out[key] = level;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Intersect a caller request against the profile. The caller may drop
 * permissions or ask for a weaker level; anything else is refused outright
 * rather than silently clamped, so a caller never believes it got more than it
 * did.
 */
export function narrowPermissions(profile, requested) {
  if (requested == null) return { ...profile };

  const keys = Object.keys(requested);
  if (keys.length === 0) {
    throw new ScopeError(
      "Requested an empty permission set. Omit the field to take the project profile.",
    );
  }

  const out = {};
  for (const key of keys) {
    const want = requested[key];
    const have = profile[key];
    if (have == null) {
      throw new ScopeError(
        `Permission "${key}" is not in this project's profile (${Object.keys(profile).join(", ")}).`,
        403,
      );
    }
    if (rank(want) < 0) {
      throw new ScopeError(`Unknown permission level "${want}" for "${key}".`);
    }
    if (rank(want) > rank(have)) {
      throw new ScopeError(
        `Cannot escalate "${key}" from ${have} to ${want}.`,
        403,
      );
    }
    out[key] = want;
  }
  return out;
}

/**
 * Say which of the two derivation sources was consulted and what it yielded, so
 * the 409 names the one fix that applies instead of listing every fix.
 *
 * The three cases are genuinely different pieces of work by different owners:
 * attaching an issue to a project is an ordinary board edit any agent can do,
 * while setting `GH_APP_REPOS` is a project-env change. TOG-226 spent its first
 * pass working out which of these each refusal meant; the answer was always
 * present at the throw site, just not written down.
 */
function noScopeMessage({ projectId, hasProjectEnv, workspaceRepoUrl }) {
  const why = !projectId
    ? "This issue has no project, so there is no GH_APP_REPOS to read"
    : !hasProjectEnv
      ? `Project ${projectId} has no env, so there is no GH_APP_REPOS to read`
      : `Project ${projectId} has an env but no usable GH_APP_REPOS ` +
        "(a secret_ref or non-string binding is treated as absent — it must be a plain literal)";

  const workspace = workspaceRepoUrl
    ? `The issue's workspace repo URL (${workspaceRepoUrl}) did not parse to a repo name.`
    : "The issue has no workspace repo URL to fall back to.";

  const fix = !projectId
    ? "Fix: attach this issue to a project that pins GH_APP_REPOS."
    : "Fix: set GH_APP_REPOS on the project to the repos this project's work actually touches.";

  return (
    `Refusing to mint: no repository scope could be derived for this issue. ${why}. ` +
    `${workspace} ${fix} ` +
    "An unscoped token would grant every repo in the installation."
  );
}

/**
 * Resolve the repository ceiling and intersect the caller's request with it.
 *
 * The ceiling is whatever the operator pinned on the project (`GH_APP_REPOS`),
 * falling back to the repo the issue's own primary workspace points at. Both are
 * server-derived. If neither yields a repo we raise — minting unscoped is the
 * failure this issue is about.
 *
 * `projectId`/`hasProjectEnv` are diagnostic only: they never widen the ceiling,
 * and are read exclusively on the path that already decided to refuse.
 */
export function resolveRepositories({
  projectRepos = null,
  workspaceRepoUrl = null,
  requested = null,
  projectId = null,
  hasProjectEnv = false,
}) {
  const ceiling =
    projectRepos ??
    (parseRepoName(workspaceRepoUrl) ? [parseRepoName(workspaceRepoUrl)] : null);

  if (!ceiling || ceiling.length === 0) {
    throw new ScopeError(
      noScopeMessage({ projectId, hasProjectEnv, workspaceRepoUrl }),
      409,
    );
  }

  if (requested == null) return [...ceiling];

  const want = parseRepoList(requested);
  if (!want || want.length === 0) {
    throw new ScopeError(
      "Requested an empty repository set. Omit the field to take the project scope.",
    );
  }

  const outside = want.filter((r) => !ceiling.includes(r));
  if (outside.length > 0) {
    throw new ScopeError(
      `Repositories outside this issue's scope: ${outside.join(", ")}. Allowed: ${ceiling.join(", ")}.`,
      403,
    );
  }
  return want;
}

/**
 * Full server-side scope derivation. `projectEnv` is the project's env map as
 * the operator configured it; `workspaceRepoUrl` comes from the issue's primary
 * workspace. Neither is caller-supplied.
 */
export function resolveScope({
  projectEnv = null,
  workspaceRepoUrl = null,
  requestedRepositories = null,
  requestedPermissions = null,
  defaultPermissions = DEFAULT_PERMISSION_PROFILE,
  projectId = null,
}) {
  const env = projectEnv ?? {};

  // Only literal env values participate. A project's env is an `AgentEnvConfig`,
  // whose values are an `EnvBinding` union: a bare string, or one of the tagged
  // forms `plain` / `secret_ref` / `user_secret_ref`. Every GH-configured project
  // in this company uses the tagged `plain` form, so reading only the bare-string
  // case silently disables project scoping altogether.
  //
  // `secret_ref` and `user_secret_ref` resolve elsewhere and deliberately stay
  // absent here: scope must be derived from operator-visible literals, never from
  // a secret value stringified into a repo name.
  const literal = (key) => {
    const value = env[key];
    if (typeof value === "string") return value;
    if (
      value &&
      typeof value === "object" &&
      value.type === "plain" &&
      typeof value.value === "string"
    ) {
      return value.value;
    }
    return null;
  };

  const projectRepos = parseRepoList(literal("GH_APP_REPOS"));
  const projectPermissions = parsePermissionSpec(literal("GH_APP_PERMISSIONS"));

  const profile = projectPermissions ?? { ...defaultPermissions };

  const repositories = resolveRepositories({
    projectRepos,
    workspaceRepoUrl,
    requested: requestedRepositories,
    projectId,
    hasProjectEnv: Object.keys(env).length > 0,
  });

  const permissions = narrowPermissions(profile, requestedPermissions);

  if (Object.keys(permissions).length === 0) {
    throw new ScopeError("Refusing to mint a token with no permissions.");
  }

  return {
    repositories,
    permissions,
    profileSource: projectPermissions ? "project" : "default",
    repoSource: projectRepos ? "project" : "workspace",
  };
}
