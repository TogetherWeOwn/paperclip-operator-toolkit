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

/**
 * The permissions that make CI observable, and the endpoint each one unlocks.
 * None is in the default profile, so by default a minted token can see none of
 * this — which is the whole of TOG-247.
 *
 * `statuses` is listed separately from `checks` on purpose: they are distinct
 * permissions, and granting `checks:read` does NOT make the combined commit
 * status endpoint readable. Measured against the live installation on
 * 2026-08-24 — a token holding actions:read + checks:read still gets 403 from
 * `/commits/{ref}/status`. A repo whose CI posts commit statuses instead of
 * check runs is therefore invisible to a checks-only grant.
 */
const CI_SOURCES = Object.freeze({
  checks: "check runs (GET /repos/{o}/{r}/commits/{ref}/check-runs)",
  actions: "workflow runs (GET /repos/{o}/{r}/actions/runs)",
  statuses: "commit statuses (GET /repos/{o}/{r}/commits/{ref}/status)",
});

/**
 * Report which CI sources this grant can actually read (TOG-247).
 *
 * A minted token that cannot see CI is not, by itself, a problem — the operator
 * may well decide that humans verify before merge. The problem is a token that
 * cannot see CI and does not SAY so, because the failure mode is silent: a
 * caller pulls `check_runs` out of a 403 body, finds nothing, and concludes
 * "no CI configured" rather than "you may not look".
 *
 * Deliberately advisory, and it carries no enforcement. This changes what the
 * caller KNOWS, never what the token can do — the grant is decided by the
 * profile and by GitHub, and duplicating that decision here would be a second
 * source of truth for the blast radius.
 */
export function describeCiVisibility(permissions) {
  const perms = permissions ?? {};
  const readable = Object.keys(CI_SOURCES).filter((key) => perms[key] != null);
  const blind = Object.keys(CI_SOURCES).filter((key) => perms[key] == null);

  return {
    observable: readable.length > 0,
    readable,
    blind,
    // Present only when it is needed, so a caller that CAN see CI is not handed
    // a standing warning it has to learn to ignore.
    warning:
      readable.length > 0
        ? null
        : "This token cannot read CI status: every source returns 403. A client " +
          "that reads the result array out of the error body sees nothing, which " +
          "looks like 'no CI configured' rather than 'denied'. Do not treat the " +
          "absence of failing checks as a pass. Missing: " +
          blind.map((key) => `${key}:read for ${CI_SOURCES[key]}`).join("; ") +
          ".",
  };
}

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
 * Resolve the repository ceiling and intersect the caller's request with it.
 *
 * The ceiling is whatever the operator pinned on the project (`GH_APP_REPOS`),
 * falling back to the repo the issue's own primary workspace points at. Both are
 * server-derived. If neither yields a repo we raise — minting unscoped is the
 * failure this issue is about.
 */
export function resolveRepositories({
  projectRepos = null,
  workspaceRepoUrl = null,
  requested = null,
}) {
  const ceiling =
    projectRepos ??
    (parseRepoName(workspaceRepoUrl) ? [parseRepoName(workspaceRepoUrl)] : null);

  if (!ceiling || ceiling.length === 0) {
    throw new ScopeError(
      "Refusing to mint: no repository scope could be derived for this issue. " +
        "Set GH_APP_REPOS on the project, or attach a workspace with a repo URL. " +
        "An unscoped token would grant every repo in the installation.",
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
