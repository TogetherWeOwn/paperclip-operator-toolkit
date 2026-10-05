#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This bounded oracle runs only the ownership fixtures, never the full mutation
// gate. Mutants live in run-owned scratch; the checkout's source stays untouched.
const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? process.env.RUNNER_TEMP;
assert(scratch, 'Set PAPERCLIP_RUN_SCRATCH_DIR, PAPERCLIP_SCRATCH_DIR or RUNNER_TEMP to run the alias oracle');
const source = await readFile(join(root, 'src/admission-simulator.ts'), 'utf8');
const mutants = [
  ['constructor-shallow-copy', 'this.input = structuredClone(input);', 'this.input = { ...input };'],
  ['evaluation-shallow-input', 'const input = structuredClone(this.input);', 'const input = { ...this.input };'],
  ['attempt-cache-alias', 'result: structuredClone(result) });', 'result: { ...result } });'],
  ['allocation-shallow-return',
    'return structuredClone(result);\n  }\n\n  commit(', 'return { ...result, reservation: result.reservation ? { ...result.reservation } : null };\n  }\n\n  commit('],
  ['attempt-replay-shallow-return',
    "throw new Error('idempotency-key-payload-mismatch');\n      return structuredClone(previous.result);",
    "throw new Error('idempotency-key-payload-mismatch');\n      return { ...previous.result, reservation: previous.result.reservation ? { ...previous.result.reservation } : null };"],
  ['snapshot-shallow-rows', 'return structuredClone([...this.reservations.values()]);', 'return [...this.reservations.values()].map(r => ({ ...r }));'],
  ['commit-shallow-return', 'return structuredClone(r);\n  }\n\n  cancelBeforeStart(', 'return { ...r };\n  }\n\n  cancelBeforeStart('],
  ['cancel-shallow-return', 'return structuredClone(r);\n  }\n\n  /** A confirmed end', 'return { ...r };\n  }\n\n  /** A confirmed end'],
  ['finish-shallow-return', 'return structuredClone(r);\n  }\n\n  reconcile(', 'return { ...r };\n  }\n\n  reconcile('],
  ['reconciliation-cache-alias', 'const result = structuredClone(r);', 'const result = { ...r };'],
  ['reconciliation-shallow-return', 'return structuredClone(result);\n  }\n\n  /** Advancing time', 'return { ...result };\n  }\n\n  /** Advancing time'],
  ['reconciliation-replay-shallow-return',
    "throw new Error('reconciliation-key-payload-mismatch');\n      return structuredClone(previous.result);",
    "throw new Error('reconciliation-key-payload-mismatch');\n      return { ...previous.result };"],
];
for (const [name, from] of mutants) {
  assert.equal(source.split(from).length - 1, 1, `${name}: mutation anchor must be unique`);
}

const copy = await mkdtemp(join(scratch, 'admission-alias-'));
try {
  await mkdir(join(copy, 'src'));
  await mkdir(join(copy, 'tests'));
  for (const file of ['src/admission-budget.ts', 'tests/admission-simulator.spec.ts']) {
    await writeFile(join(copy, file), await readFile(join(root, file)));
  }
  await symlink(join(root, 'node_modules'), join(copy, 'node_modules'), 'dir');
  await writeFile(join(copy, 'package.json'), '{"type":"module"}\n');
  const run = async (name, content) => {
    await writeFile(join(copy, 'src/admission-simulator.ts'), content);
    const result = spawnSync(process.execPath, [
      join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--root', copy,
      'tests/admission-simulator.spec.ts', '--testNamePattern', 'simulation-only object ownership',
      '--reporter=json', '--minWorkers=1', '--maxWorkers=1',
    ], { cwd: copy, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, `${name}: test process did not finish`);
    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      throw new Error(`${name}: no valid test report (exit ${result.status}): ${result.stderr}`);
    }
    const cases = report.testResults.flatMap(file => file.assertionResults);
    const passed = cases.filter(test => test.status === 'passed');
    const failed = cases.filter(test => test.status === 'failed');
    assert(passed.length + failed.length > 0, `${name}: no ownership tests executed`);
    return { exit: result.status, passed, failed };
  };
  const baseline = await run('baseline', source);
  assert.equal(baseline.exit, 0, 'The unmutated positive control must pass');
  assert.equal(baseline.failed.length, 0, 'The unmutated positive control must have no failures');
  console.log(`baseline: ${baseline.passed.length} ownership tests passed`);
  for (const [name, from, to] of mutants) {
    const result = await run(name, source.replace(from, to));
    assert.equal(result.exit, 1, `${name}: mutant survived or the test runner failed`);
    assert(result.failed.length > 0, `${name}: no failing test assertion; not a killed mutant`);
    assert.equal(result.passed.length + result.failed.length, baseline.passed.length, `${name}: incomplete test execution`);
    console.log(`${name}: killed by ${result.failed.length} ownership test(s)`);
  }
  console.log(`alias oracle: ${mutants.length}/${mutants.length} mutants killed; no checkout source modified`);
} finally {
  await rm(copy, { recursive: true, force: true });
}
