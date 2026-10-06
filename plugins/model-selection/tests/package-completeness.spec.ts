import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  checkCompleteness,
  loadPackageInputs,
  normalizeRel,
  requiredPaths,
  type RequiredPath,
} from "../scripts/verify-package-completeness.mjs";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");

// The evaluated package inputs: package.json pointers plus the built manifest
// they resolve to — the same source the guard checks.
const { pkg, manifest } = await loadPackageInputs();

// Tarball contents observed from the pre-fix packaging, which shipped
// config, dist and README.md but no migrations directory. The evaluated
// manifest already declared database.migrationsDir then, so the host's
// unconditional directory read failed on the installed package.
const PRE_FIX_PACKED_FILES = [
  "README.md",
  "config/reviewed-roster.json",
  "dist/manifest.js",
  "dist/manifest.js.map",
  "dist/worker.js",
  "dist/worker.js.map",
  "package.json",
];

const asRef = (req: RequiredPath): string => `${req.kind}:${req.rel}`;

describe("package completeness guard", () => {
  it("derives the migrations directory from the evaluated manifest", () => {
    const required = requiredPaths(pkg, manifest);
    const dirs = required.filter((req: RequiredPath) => req.kind === "dir").map(asRef);
    expect(dirs).toContain("dir:migrations");
    expect(normalizeRel("./migrations")).toBe("migrations");
  });

  it("fails the pre-fix file set: the omitted directory is reported missing", () => {
    const required = requiredPaths(pkg, manifest);
    expect(required.length).toBeGreaterThan(0);
    const { missing } = checkCompleteness(required, PRE_FIX_PACKED_FILES);
    expect(missing.map(asRef)).toContain("dir:migrations");
  });

  it(
    "passes the normal pack path with the corrected file set",
    { timeout: 120000 },
    () => {
      const out = execFileSync(
        "node",
        ["scripts/verify-package-completeness.mjs"],
        { cwd: pkgDir, encoding: "utf8", timeout: 120000 },
      );
      expect(out).toContain("COMPLETE");
      expect(out).toContain("migrations/");
    },
  );

  it(
    "passes a real archive: npm pack output contains every manifest-declared path",
    { timeout: 180000 },
    () => {
      const stage = mkdtempSync(join(tmpdir(), "model-selection-pack-"));
      try {
        execFileSync("npm", ["pack", "--silent", "--pack-destination", stage], {
          cwd: pkgDir,
          encoding: "utf8",
          timeout: 120000,
        });
        const tarballs = readdirSync(stage).filter((name) => name.endsWith(".tgz"));
        expect(tarballs).toHaveLength(1);
        const tarball = join(stage, tarballs[0]!);
        const listing = execFileSync("tar", ["-tzf", tarball], {
          encoding: "utf8",
          timeout: 60000,
        });
        expect(listing).toContain("package/migrations/README.md");
        const out = execFileSync(
          "node",
          ["scripts/verify-package-completeness.mjs", "--tarball", tarball],
          { cwd: pkgDir, encoding: "utf8", timeout: 120000 },
        );
        expect(out).toContain("COMPLETE");
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
    },
  );
});
