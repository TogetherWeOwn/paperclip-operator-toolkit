#!/usr/bin/env bash
# ===========================================================================
# gh_push_preflight.sh — will a `git push` on this issue be able to get a
# credential?  Answered BEFORE the work, not after the commit.  (TOG-918.)
# ---------------------------------------------------------------------------
# THE DEFECT CLASS THIS CLOSES.
#
# The gh-token-broker derives a repository scope server-side from the issue the
# caller demonstrably holds.  Its two sources are the `GH_APP_REPOS` pinned on
# the issue's PROJECT, and the issue's primary-workspace `repoUrl` as a
# fallback.  An issue with no project has NEITHER -- the host's
# getWorkspaceForIssue returns null outright on a null projectId
# (/app/server/dist/services/plugin-host-services.js:1499), so both sources are
# null together.  The broker then refuses with 409, correctly: minting without
# a repository scope would grant every repo in the installation, which is the
# entire blast radius TOG-174 exists to remove.
#
# The refusal is right.  The TIMING is the defect.  Nothing consults it until
# the credential helper runs, which is at `git push` -- so an agent does the
# whole job, commits, pushes, and gets exit 128 on the box that produced the
# work.  That is what stranded TOG-291.  The broker already emits the exact fix
# string; this surfaces it at start-of-work instead.
#
# WHAT THIS IS NOT.  It mints nothing, signs nothing, and needs no GitHub
# credential.  It cannot widen a scope because it never asks for one -- it is a
# read plus a pure function.  The CISO constraint on TOG-918 (no new path may
# mint broader than one repo) is satisfied by construction, and
# ./test_gh_push_preflight.sh asserts it against the kernel's record of argv.
#
# THE ORACLE IS THE BROKER'S OWN CODE.
#
# The verdict comes from `resolveScope()` in the broker's real scope.js, loaded
# from the DEPLOYED package by preference.  It is deliberately not a
# reimplementation: a second copy of the derivation would drift from the one
# that actually decides, and would then report "you are fine" about a mint that
# refuses -- a false green in the exact place this tool exists to prevent.
# When the deployed copy and the in-repo copy disagree, that is reported as a
# finding rather than silently resolved, because the deployed bytes are what
# runs and the repo is what was reviewed.
#
# THE LIFECYCLE TERM DECIDES, IT IS NOT A FOOTNOTE.
#
# A derivable scope is necessary but not sufficient: the broker also refuses on
# issue status (MINTABLE_ISSUE_STATUSES), and that refusal kills a push the
# same way exit 128 does.  A comment-woken run on a `done` issue with a healthy
# project scope would otherwise read "PASS" over a mint the broker provably
# refuses -- the exact false green this tool exists to prevent, one gate later.
# So a lifecycle refusal is exit 1 with the fix named, and an ownership module
# that cannot be loaded is exit 2: an unreadable deciding term may never stand
# in for a measured one.  The broker's run-identity and assignment terms are
# NOT modeled here; those refusals name their own fix at mint time.
#
#   ./gh_push_preflight.sh                      # this run's issue
#   ./gh_push_preflight.sh --issue <uuid>       # any issue in this company
#   ./gh_push_preflight.sh --json
#
# Exit status:  0 a single-repo scope is derivable AND the issue status is mintable
#               1 no scope is derivable, or lifecycle refuses -- message names the fix
#               2 usage, config, or an unreadable control plane or oracle
#                 (NOTHING measured)
#
# Exit 2 is never "clean".  A preflight that cannot read the board must not
# report a pass, or it becomes a green light produced by an outage.
#
# Requires bash, curl, jq, node.  No GitHub credential.
# ===========================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT=table
ISSUE_ID=""

DEPLOYED_SCOPE="${GH_BROKER_DEPLOYED_DIR:-/opt/paperclip-plugin-packages/gh-token-broker}/dist/scope.js"
REPO_SCOPE="$HERE/plugins/gh-token-broker/dist/scope.js"
# Overridable so the test suite can prove an unreadable ownership module is
# exit 2, never a pass (the lifecycle term decides the exit code now).
REPO_OWNERSHIP="${GH_BROKER_OWNERSHIP_JS:-$HERE/plugins/gh-token-broker/dist/ownership.js}"

usage() {
  cat >&2 <<'EOF'
usage: gh_push_preflight.sh [--issue UUID] [--json]

  --issue UUID  the issue to check (default: $PAPERCLIP_TASK_ID)
  --json        machine-readable verdict

Answers "can a git push on this issue obtain a credential?" without minting.
Exit 0 = yes.  1 = no, with the fix.  2 = could not measure.
EOF
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue) ISSUE_ID="${2:-}"; [[ -n "$ISSUE_ID" ]] || usage; shift 2 ;;
    --json)  OUTPUT=json; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

fail2() { echo "PREFLIGHT ERROR: $*" >&2; exit 2; }

for dep in curl jq node; do
  command -v "$dep" >/dev/null 2>&1 || fail2 "missing dependency: $dep"
done

: "${PAPERCLIP_API_URL:?PREFLIGHT ERROR: PAPERCLIP_API_URL is not set}"
: "${PAPERCLIP_API_KEY:?PREFLIGHT ERROR: PAPERCLIP_API_KEY is not set}"
: "${PAPERCLIP_COMPANY_ID:?PREFLIGHT ERROR: PAPERCLIP_COMPANY_ID is not set}"

ISSUE_ID="${ISSUE_ID:-${PAPERCLIP_TASK_ID:-}}"
[[ -n "$ISSUE_ID" ]] || fail2 "no issue id: pass --issue or set PAPERCLIP_TASK_ID"

API_BASE="${PAPERCLIP_API_URL%/}"; API_BASE="${API_BASE%/api}"

CFG_DIR="${PAPERCLIP_RUN_SCRATCH_DIR:-${PAPERCLIP_SCRATCH_DIR:-${TMPDIR:-/tmp}}}"
mkdir -p "$CFG_DIR" 2>/dev/null || true
WORK="$(umask 077; mktemp -d "$CFG_DIR/preflight.XXXXXXXX")" \
  || fail2 "could not create a scratch directory"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# The bearer goes into a 0600 `curl --config` file, never onto argv:
# /proc/<pid>/cmdline is world-readable and every agent on this host shares uid
# `node` (TOG-191/TOG-200).  Asserted by the test suite against /proc.
curl_authed() {
  local url="$1" cfg rc
  cfg="$(umask 077; mktemp "$WORK/curlcfg.XXXXXXXX")" || fail2 "could not create a curl config file"
  chmod 0600 "$cfg"
  {
    printf 'url = "%s"\n' "$url"
    printf 'request = "GET"\n'
    printf 'header = "Authorization: Bearer %s"\n' "$PAPERCLIP_API_KEY"
    printf 'silent\nshow-error\n'
  } > "$cfg"
  curl --config "$cfg"
  rc=$?
  rm -f "$cfg"
  return $rc
}

# --- read the control plane -------------------------------------------------
# Both reads are plain GETs. A failure here is exit 2, never a pass.

ISSUE_JSON="$WORK/issue.json"
curl_authed "$API_BASE/api/issues/$ISSUE_ID" > "$ISSUE_JSON" \
  || fail2 "could not read issue $ISSUE_ID from the control plane"
jq -e '.id? // .issue.id?' "$ISSUE_JSON" >/dev/null 2>&1 \
  || fail2 "issue $ISSUE_ID did not resolve (response: $(head -c 200 "$ISSUE_JSON" | tr -d '\n'))"

PROJECTS_JSON="$WORK/projects.json"
curl_authed "$API_BASE/api/companies/$PAPERCLIP_COMPANY_ID/projects" > "$PROJECTS_JSON" \
  || fail2 "could not read the project list from the control plane"
jq -e 'if type=="array" then true else (.projects|type=="array") end' "$PROJECTS_JSON" >/dev/null 2>&1 \
  || fail2 "project list did not parse as expected"

# --- decide, using the broker's own resolveScope ----------------------------

DEPLOYED_SCOPE="$DEPLOYED_SCOPE" REPO_SCOPE="$REPO_SCOPE" \
REPO_OWNERSHIP="$REPO_OWNERSHIP" ISSUE_FILE="$ISSUE_JSON" \
PROJECTS_FILE="$PROJECTS_JSON" TARGET_ISSUE="$ISSUE_ID" \
OUTPUT_MODE="$OUTPUT" \
node --input-type=module -e '
import fs from "node:fs";
import crypto from "node:crypto";

const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const sha = (p) => { try { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0,16); } catch { return null; } };

const deployedPath = process.env.DEPLOYED_SCOPE;
const repoPath     = process.env.REPO_SCOPE;

// Prefer the DEPLOYED bytes: they are what actually decides a live mint. The
// in-repo copy is the reviewed artifact and is the fallback. Disagreement is a
// reported finding, not something to resolve silently.
const dHash = sha(deployedPath), rHash = sha(repoPath);
let scopeMod = null, oracleSource = null;
for (const [p, name] of [[deployedPath, "deployed"], [repoPath, "repo"]]) {
  try { scopeMod = await import(p); oracleSource = name; break; } catch {}
}
if (!scopeMod) {
  console.error("PREFLIGHT ERROR: could not load the broker scope module from either\n" +
    `  deployed: ${deployedPath}\n  repo:     ${repoPath}\n` +
    "Refusing to guess the derivation: a hand-rolled copy would drift from the\n" +
    "code that actually decides, and report a pass for a mint that refuses.");
  process.exit(2);
}
const oracleDrift = (dHash && rHash) ? dHash !== rHash : null;

let ownershipMod = null;
try { ownershipMod = await import(process.env.REPO_OWNERSHIP); } catch {}

const raw = read(process.env.ISSUE_FILE);
const issue = raw.issue ?? raw;
const projectsRaw = read(process.env.PROJECTS_FILE);
const projects = Array.isArray(projectsRaw) ? projectsRaw : (projectsRaw.projects ?? []);

const projectId = issue.projectId ?? null;
const project = projectId ? projects.find((p) => p.id === projectId) ?? null : null;
const projectEnv = project?.env ?? null;

// Mirror the host: getWorkspaceForIssue returns null when projectId is null,
// so the workspace fallback is unavailable to a project-less issue by
// construction -- it is not merely "usually unset".
const workspaceRepoUrl = projectId ? (project?.primaryWorkspace?.repoUrl ?? null) : null;

const findings = [];
let repositories = null, repoSource = null, scopeError = null;

try {
  const scope = scopeMod.resolveScope({
    projectEnv,
    projectId,
    workspaceRepoUrl,
  });
  repositories = scope.repositories;
  repoSource = scope.repoSource;
} catch (e) {
  scopeError = { status: e.status ?? null, message: e.message };
}

// The lifecycle term. A derivable scope is necessary but not sufficient: the
// broker also refuses on issue status (MINTABLE_ISSUE_STATUSES), and that
// refusal kills a push the same way. It DECIDES the exit code, it is not a
// footnote: a `done` issue with a healthy scope would otherwise read PASS over
// a mint the broker provably refuses.
const mintable = ownershipMod?.MINTABLE_ISSUE_STATUSES;
if (!mintable) {
  console.error(
    "PREFLIGHT ERROR: the ownership module did not load or exports no " +
    "MINTABLE_ISSUE_STATUSES, so the lifecycle term cannot be measured:\n" +
    `  ${process.env.REPO_OWNERSHIP}\n` +
    "The lifecycle term decides the verdict, so an unreadable one is exit 2 " +
    "rather than a pass measured on the scope term alone.");
  process.exit(2);
}
const lifecycle = {
  status: issue.status ?? null,
  mintable: mintable.includes(issue.status),
  allowed: mintable,
};

const ok = repositories !== null && repositories.length > 0;
const pass = ok && lifecycle.mintable;

// A scope that resolves to more than one repo is not a failure of this check --
// a project may legitimately pin several. Surfaced so the reader sees the real
// blast radius of the credential the push will use.
if (ok && repositories.length > 1) {
  findings.push(`scope spans ${repositories.length} repos: ${repositories.join(", ")}`);
}
if (oracleDrift) {
  findings.push(
    "the deployed broker scope.js and the in-repo copy DIFFER " +
    `(deployed ${dHash}, repo ${rHash}). This verdict used the ${oracleSource} copy. ` +
    "The deployed bytes decide a live mint; the repo copy is what was reviewed.");
}

const verdict = {
  issueId: process.env.TARGET_ISSUE,
  projectId,
  projectName: project?.name ?? null,
  workspaceRepoUrl,
  canDeriveScope: ok,
  pass,
  repositories,
  repoSource,
  refusal: scopeError,
  lifecycle,
  oracle: { source: oracleSource, deployedSha256: dHash, repoSha256: rHash, drift: oracleDrift },
  findings,
  mintedAnything: false,
};

// The fix wording mirrors explainStatus() in the ownership module, which is
// not exported.  This is display text only: the DECISION uses the real
// MINTABLE_ISSUE_STATUSES the broker exports, so this copy cannot drift a
// verdict.
const lifecycleFix = (status) => {
  if (status === "done" || status === "cancelled")
    return "the issue is finished, and an assignment that outlives the work is not a standing credential — route the work to a live card instead";
  if (status === "todo" || status === "backlog")
    return "work has not started, so no run holds a checkout — move the issue to in_progress first";
  return "no run holds a checkout in this state";
};

if (process.env.OUTPUT_MODE === "json") {
  process.stdout.write(JSON.stringify(verdict, null, 2) + "\n");
} else {
  const L = (s) => process.stdout.write(s + "\n");
  L("gh push preflight — issue " + verdict.issueId);
  L("  project        : " + (projectId ? `${verdict.projectName} (${projectId})` : "NONE"));
  L("  workspace repo : " + (workspaceRepoUrl ?? "none"));
  L("  scope oracle   : broker scope.js (" + oracleSource + ")");
  if (ok) {
    L("  repositories   : " + repositories.join(", ") + "  [from " + repoSource + "]");
  }
  if (!ok) {
    L("");
    L("  FAIL — no repository scope can be derived. A git push on this issue will");
    L("         fail with exit 128 AFTER the work is done. The broker will answer:");
    L("");
    for (const line of (scopeError?.message ?? "").split(". ").filter(Boolean)) {
      L("    " + line.trim() + (line.trim().endsWith(".") ? "" : "."));
    }
    if (!lifecycle.mintable) {
      // Both terms are broken. Show both, or the caller fixes the scope, pushes,
      // and hits the lifecycle refusal at the same delayed place as before.
      L("");
      L("  ALSO — the issue status is \"" + lifecycle.status + "\"; the broker mints only");
      L("         for " + lifecycle.allowed.join(", ") + ". Fix that too:");
      L("    " + lifecycleFix(lifecycle.status) + ".");
    }
  } else if (!lifecycle.mintable) {
    L("");
    L("  FAIL — the scope is derivable, but the issue status is \"" + lifecycle.status + "\";");
    L("         the broker mints only for " + lifecycle.allowed.join(", ") + ". A git push");
    L("         on this issue will fail with exit 128 AFTER the work is done.");
    L("    Fix: " + lifecycleFix(lifecycle.status) + ".");
  } else {
    L("");
    L("  PASS — a repo-scoped credential is derivable and the issue status is mintable;");
    L("         git push can authenticate.");
  }
  for (const f of findings) L("  NOTE — " + f);
}

process.exit(pass ? 0 : 1);
'
rc=$?
[[ $rc -eq 2 ]] && exit 2
exit $rc
