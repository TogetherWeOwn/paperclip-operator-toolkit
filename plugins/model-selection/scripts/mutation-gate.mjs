#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);

const mutants = [
  {
    name: "old-inverted-tier-order",
    file: "src/constants.ts",
    from: 'export const TIER_ORDER: readonly Tier[] = ["T3", "T2", "T1"];',
    to: "export const TIER_ORDER: readonly Tier[] = TIERS;",
  },
  {
    name: "re-enable-disabled-fallback-row",
    file: "src/engine/select.ts",
    from: "    if (!model.enabled) {",
    to: "    if (!model.enabled && !model.fallbackOnly) {",
  },
  {
    name: "remove-released-at-tie-break",
    file: "src/engine/select.ts",
    from:
      "    const releaseOrder = Date.parse(right.releasedAt) - Date.parse(left.releasedAt);\n" +
      "    if (releaseOrder !== 0) return releaseOrder;\n",
    to: "",
  },
];

function runTests() {
  return spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run"], {
    cwd: root,
    encoding: "utf8",
  });
}

const baseline = runTests();
if (baseline.status !== 0) {
  process.stderr.write("BROKEN GATE: baseline suite is red\n");
  process.stderr.write(baseline.stdout);
  process.stderr.write(baseline.stderr);
  process.exit(1);
}

const scratch = await mkdtemp(join(tmpdir(), "model-selection-mutants-"));
let failures = 0;
try {
  for (const mutant of mutants) {
    const path = join(root, mutant.file);
    const original = await readFile(path, "utf8");
    const occurrences = original.split(mutant.from).length - 1;
    if (occurrences !== 1) {
      console.error(`BROKEN GATE: ${mutant.name} matched ${occurrences} times in ${mutant.file}`);
      failures += 1;
      continue;
    }

    await writeFile(join(scratch, mutant.name), original);
    await writeFile(path, original.replace(mutant.from, mutant.to));
    const result = runTests();
    await writeFile(path, original);

    if (result.status === 0) {
      console.error(`SURVIVED: ${mutant.name}`);
      failures += 1;
    } else {
      console.log(`KILLED: ${mutant.name}`);
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

if (failures > 0) process.exit(1);
console.log(`mutation gate: ${mutants.length}/${mutants.length} killed`);
