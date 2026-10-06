#!/usr/bin/env node
// Verify that every file and directory path the evaluated plugin manifest
// declares is present in the distributable.
//
// Why this exists: the host reads manifest-declared paths unconditionally at
// install and upgrade. A checksum list that is self-consistent with an
// incomplete archive cannot catch a missing directory — the archive hashes
// fine and the upgrade still fails when the host reads the absent path. So
// this compares manifest-declared paths against actual archive contents.
//
// Required paths come from evaluated artifacts, never source text:
//   - package.json `paperclipPlugin.manifest` / `.worker` pointers, and
//   - the built manifest those pointers resolve to: every `entrypoints.*`
//     file and `database.migrationsDir` (a directory passes only when at
//     least one archived file lives under it, because the host reads the
//     directory itself).
//
// Archive contents come from one of:
//   - default: `npm pack --dry-run --json` (the normal pack path; no tarball
//     is written), or
//   - `--tarball <file.tgz>`: a real archive listed with `tar -tzf`
//     (covers release artifacts built from the pack output), or
//   - `--dir <path>`: a staged or extracted release directory.
//
// Exit 0 when every required path is present, 1 when anything is missing,
// 2 for harness errors. When a new path-bearing manifest key is added, extend
// `requiredPaths` below so the guard keeps covering it.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, "..");

// Fail by throwing, never by exiting: every function in this module is
// importable (unit tests run it without a built dist present), so only the
// CLI entrypoint below may convert a failure into a process exit code.
function failHarness(message) {
  throw new Error(message);
}

// Strip a manifest-style relative path (`./dist/worker.js`) to a
// package-relative posix path (`dist/worker.js`). Returns null for absolute
// paths and escapes: those never resolve inside an archive.
export function normalizeRel(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let p = raw.trim().replace(/\\/g, "/");
  if (p.startsWith("./")) p = p.slice(2);
  if (p.startsWith("/") || p === "" || p === ".") return null;
  const parts = p.split("/");
  let depth = 0;
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      depth -= 1;
    } else {
      depth += 1;
    }
    if (depth < 0) return null;
  }
  const clean = parts.filter((part) => part !== "" && part !== ".").join("/");
  return clean.length > 0 ? clean : null;
}

// Every manifest-declared file/dir the host reads from the installed package.
// `pkg` is the parsed package.json, `manifest` the evaluated built manifest.
export function requiredPaths(pkg, manifest) {
  const required = [];
  const seen = new Set();
  const add = (kind, rel, via) => {
    if (rel === null) return;
    const key = `${kind}:${rel}`;
    if (seen.has(key)) return;
    seen.add(key);
    required.push({ kind, rel, via });
  };

  const pointers = pkg?.paperclipPlugin ?? {};
  for (const key of ["manifest", "worker"]) {
    if (typeof pointers[key] === "string") {
      add("file", normalizeRel(pointers[key]), `package.json paperclipPlugin.${key}`);
    }
  }

  const entrypoints = manifest?.entrypoints ?? {};
  if (entrypoints && typeof entrypoints === "object") {
    for (const [key, value] of Object.entries(entrypoints)) {
      if (typeof value === "string") {
        add("file", normalizeRel(value), `manifest entrypoints.${key}`);
      }
    }
  }

  const migrationsDir = manifest?.database?.migrationsDir;
  if (typeof migrationsDir === "string") {
    add("dir", normalizeRel(migrationsDir), "manifest database.migrationsDir");
  }

  return required;
}

// Compare required paths against package-relative posix file paths from an
// archive or directory. A directory passes only when at least one file lives
// under it: an empty directory entry still fails the host's read.
export function checkCompleteness(required, packedFiles) {
  const packed = new Set(packedFiles);
  const missing = [];
  const found = [];
  for (const req of required) {
    let ok = false;
    if (req.kind === "file") {
      ok = packed.has(req.rel);
    } else {
      const prefix = `${req.rel}/`;
      for (const file of packed) {
        if (file.startsWith(prefix)) {
          ok = true;
          break;
        }
      }
    }
    if (ok) {
      found.push(req);
    } else {
      missing.push(req);
    }
  }
  return { missing, found };
}

function listPackedFromDryRun() {
  let stdout;
  try {
    stdout = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: pkgDir,
      encoding: "utf8",
      timeout: 120000,
    });
  } catch (err) {
    failHarness(`npm pack --dry-run --json failed: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    failHarness("npm pack --dry-run --json printed unparseable output");
  }
  const files = parsed?.[0]?.files;
  if (!Array.isArray(files)) failHarness("npm pack JSON has no files list");
  return files.map((entry) => entry.path).filter((p) => typeof p === "string");
}

function listPackedFromTarball(tarball) {
  const resolved = path.resolve(tarball);
  if (!fs.existsSync(resolved)) failHarness(`tarball not found: ${tarball}`);
  let stdout;
  try {
    stdout = execFileSync("tar", ["-tzf", resolved], { encoding: "utf8", timeout: 120000 });
  } catch (err) {
    failHarness(`tar -tzf failed: ${err.message}`);
  }
  return stdout
    .split("\n")
    .map((line) => line.trim().replace(/^\.\//, "").replace(/^package\//, ""))
    .filter((line) => line.length > 0 && !line.endsWith("/"));
}

function listPackedFromDir(dir) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    failHarness(`not a directory: ${dir}`);
  }
  const out = [];
  const walk = (current) => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile()) {
        out.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };
  walk(root);
  return out;
}

export async function loadPackageInputs() {
  const pkgPath = path.join(pkgDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const manifestPtr = pkg?.paperclipPlugin?.manifest;
  if (typeof manifestPtr !== "string") failHarness("package.json has no paperclipPlugin.manifest pointer");
  const manifestPath = path.resolve(pkgDir, normalizeRel(manifestPtr) ?? manifestPtr);
  if (!fs.existsSync(manifestPath)) failHarness(`built manifest not found: ${manifestPath} (run npm run build first)`);
  const mod = await import(pathToFileURL(manifestPath).href);
  const manifest = mod.default ?? mod.manifest;
  if (!manifest || typeof manifest !== "object") failHarness("built manifest has no default export");
  return { pkg, manifest };
}

async function main() {
  const args = process.argv.slice(2);
  let mode = "dry-run";
  let operand = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tarball" && i + 1 < args.length) {
      mode = "tarball";
      operand = args[++i];
    } else if (args[i] === "--dir" && i + 1 < args.length) {
      mode = "dir";
      operand = args[++i];
    } else {
      failHarness(`usage: verify-package-completeness.mjs [--tarball <file.tgz> | --dir <path>]`);
    }
  }

  const { pkg, manifest } = await loadPackageInputs();
  const required = requiredPaths(pkg, manifest);
  if (required.length === 0) failHarness("no manifest-declared paths found; the guard is blind");

  const packedFiles =
    mode === "tarball"
      ? listPackedFromTarball(operand)
      : mode === "dir"
        ? listPackedFromDir(operand)
        : listPackedFromDryRun();

  const { missing, found } = checkCompleteness(required, packedFiles);
  for (const req of found) {
    console.log(`FOUND   ${req.kind === "dir" ? `${req.rel}/` : req.rel}  (${req.via})`);
  }
  for (const req of missing) {
    console.log(`MISSING ${req.kind === "dir" ? `${req.rel}/` : req.rel}  (${req.via})`);
  }
  console.log(
    `package completeness: ${found.length}/${required.length} manifest-declared paths present in ${mode}`,
  );
  if (missing.length > 0) {
    console.error(
      `INCOMPLETE: ${missing.length} manifest-declared path(s) absent from the ${mode} distributable`,
    );
    process.exit(1);
  }
  console.log("COMPLETE");
}

// Run the CLI only when executed directly; importing this module (unit tests,
// release tooling) must not shell out to npm as an import side effect, and
// must never hard-exit the importing process.
const invokedDirectly =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    await main();
  } catch (err) {
    console.error(`FATAL: ${err.message}`);
    process.exit(2);
  }
}
