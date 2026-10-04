#!/usr/bin/env node

// Decide whether a change can alter the outcome of this plugin's mutation
// gate, so CI skips the ~300-mutant sweep for PRs and pushes that cannot
// affect it. The gate is by far the most expensive job in the repo and until
// now ran on every run, including ones that never touched the plugin.
//
// FAIL SAFE IS THE WHOLE DESIGN. "Impacted" is the safe answer, so every path
// that is not a positive proof of "unaffected" resolves to impacted=true: an
// unknown event, a missing or all-zero base (new branch), a force-push whose
// previous head is gone, a base commit that cannot be fetched, a failing
// `git diff`, an unparseable event payload. Skipping the gate wrongly would
// turn a required check green on code that was never mutation-tested; running
// it needlessly only costs minutes. The one thing this script never does is
// guess "not impacted" from an error.
//
// What can change a mutant's verdict is exactly what the gate copies into its
// scratch tree: the plugin directory plus the repo files its specs read from
// outside it (MUTATION_TREE_REPO_FIXTURES, the single source of truth, which a
// spec already proves complete), and the workflow that wires the gate, which
// one spec reads and whose own edits must re-prove the gate.

import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { MUTATION_TREE_REPO_FIXTURES } from "./mutation-gate-runtime.mjs";

export const MUTATION_IMPACT_PREFIXES = Object.freeze(["plugins/model-selection/"]);
export const MUTATION_IMPACT_FILES = Object.freeze([...new Set([...MUTATION_TREE_REPO_FIXTURES, ".github/workflows/ci.yml"])]);

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ZERO_SHA = /^0+$/;

function normalise(path) {
  if (typeof path !== "string") throw new TypeError(`changed file is not a string: ${JSON.stringify(path)}`);
  return path.replace(/^(?:\.\/)+/, "");
}

export function impactedFiles(changedFiles) {
  if (!Array.isArray(changedFiles)) throw new TypeError("changedFiles must be an array of repo-relative paths");
  return changedFiles
    .map(normalise)
    .filter((path) => path !== "")
    .filter(
      (path) =>
        MUTATION_IMPACT_FILES.includes(path) || MUTATION_IMPACT_PREFIXES.some((prefix) => path.startsWith(prefix)),
    );
}

export function isImpacted(changedFiles) {
  return impactedFiles(changedFiles).length > 0;
}

function validSha(value) {
  return typeof value === "string" && SHA.test(value) && !ZERO_SHA.test(value);
}

// Returns { base } for an event whose diff range is knowable, else { reason }.
// The head is always the checked-out HEAD: for pull_request that is the merge
// commit, for merge_group the queue entry, for push the pushed commit.
export function resolveDiffBase(eventName, event) {
  if (typeof event !== "object" || event === null) return { reason: "event payload unreadable" };
  let base;
  switch (eventName) {
    case "pull_request":
      base = event.pull_request?.base?.sha;
      break;
    case "push":
      base = event.before;
      break;
    case "merge_group":
      base = event.merge_group?.base_sha;
      break;
    default:
      return { reason: `event ${JSON.stringify(eventName)} has no known diff base` };
  }
  if (!validSha(base)) return { reason: `${eventName} has no usable base commit (new branch or missing sha)` };
  return { base };
}

function defaultGit(args) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function decideImpact({ eventName, event, git = defaultGit }) {
  const resolved = resolveDiffBase(eventName, event);
  if (resolved.base === undefined) return { impacted: true, reason: resolved.reason, matched: [] };
  const { base } = resolved;

  // The diff is a tree comparison, so a depth-1 fetch of the base commit is
  // enough: the checkout stays shallow and no history is walked.
  if (git(["cat-file", "-e", `${base}^{commit}`]).status !== 0) {
    git(["fetch", "--no-tags", "--depth=1", "origin", base]);
    if (git(["cat-file", "-e", `${base}^{commit}`]).status !== 0) {
      return { impacted: true, reason: `base ${base} is unavailable (force-push or fetch failure)`, matched: [] };
    }
  }

  // -z: NUL-separated, never quoted. --no-renames lists BOTH sides of a move,
  // so a file moved out of the plugin still counts as touching it.
  const diff = git(["diff", "--name-only", "-z", "--no-renames", base, "HEAD", "--"]);
  if (diff.status !== 0) {
    return { impacted: true, reason: `git diff ${base}..HEAD failed`, matched: [] };
  }
  const changed = diff.stdout.split("\0").filter((path) => path !== "");
  const matched = impactedFiles(changed);
  return matched.length > 0
    ? { impacted: true, reason: `${matched.length} of ${changed.length} changed file(s) can affect the mutants`, matched }
    : { impacted: false, reason: `none of ${changed.length} changed file(s) can affect the mutants`, matched };
}

function main(env = process.env) {
  let result;
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? "", "utf8"));
    result = decideImpact({ eventName: env.GITHUB_EVENT_NAME, event });
  } catch (error) {
    result = { impacted: true, reason: `impact check failed (${error.message})`, matched: [] };
  }
  const shown = result.matched.slice(0, 10).map((path) => `\n  ${path}`).join("");
  console.log(`mutation impact: impacted=${result.impacted} — ${result.reason}${shown}`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `impacted=${result.impacted}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
