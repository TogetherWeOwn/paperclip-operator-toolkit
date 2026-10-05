#!/usr/bin/env node
'use strict';
// Mutate only a private staged copy, never the shared checkout.
// Every mutation must parse and fail its NAMED regression, not merely exit red.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const sourcePath = 'scripts/parked_backlog_guard.js';
const source = fs.readFileSync(path.join(root, sourcePath), 'utf8');
const stage = fs.mkdtempSync(path.join(
  process.env.PAPERCLIP_RUN_SCRATCH_DIR || os.tmpdir(), 'parked-mutation-'));
const mutants = [
  ['only newest comment considered',
    'for (const comment of comments || []) {',
    'for (const comment of (comments || []).slice(0, 1)) {',
    'agent park survives unrelated agent note'],
  ['description fallback removed',
    'if (descMarkers.length > 0) {', 'if (false) {',
    'description park survives agent note independently'],
  ['user prose counted as park',
    'comment.authorType !== "agent"', 'false',
    'user park quotation alone does not park'],
  ['deleted park counted as evidence',
    '!comment || comment.deletedAt ||', '!comment ||',
    'deleted agent park is not evidence'],
  ['malformed evidence no longer refuses',
    'if (report.unknown && report.unknown.length > 0) {', 'if (false) {',
    'fail safe: bad body'],
  ['empty candidate read allowed',
    'if (report.checked === 0) {', 'if (false) {',
    'zero backlog cards -> UNKNOWN, exit 5'],
  ['another candidate covers missing evidence',
    'if (!comments.some((c) => !c.deletedAt)) {', 'if (false) {',
    'fail safe: another card cannot cover missing evidence'],
  ['topic-only words treated as park',
    'const PARK_MARKERS = [', 'const PARK_MARKERS = ["non-product",',
    'ordinary topic-only progress is not a park'],
  ['JSON grants promotion authority',
    'promotionAuthorized: false,', 'promotionAuthorized: true,',
    'machine report never authorizes promotion'],
  ['no-signal verdict becomes clean',
    'verdict: "NO_PARK_SIGNAL"', 'verdict: "clean"',
    'machine verdict is not scheduling approval'],
  ['source failure becomes a usage error',
    'emitReport(report, process.argv.includes("--json"));',
    'fail("source unavailable", 2);',
    'source failure is UNKNOWN'],
  ['source stderr leaks',
    'stdio: ["ignore", "pipe", "pipe"]',
    'stdio: ["ignore", "pipe", "inherit"]',
    'source failure redacts stderr and command'],
];
function suite() {
  const result = spawnSync('bash', [path.join(stage, 'test_parked_backlog_guard.sh')],
    { encoding: 'utf8', timeout: 60000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, 'suite terminated by signal');
  return { code: result.status, output: result.stdout + result.stderr };
}
function green(label) {
  const result = suite();
  assert.equal(result.code, 0, `${label}:\n${result.output}`);
  assert.match(result.output, /RESULT: [1-9][0-9]* passed, 0 failed/);
  assert.match(result.output, /Preservation\/evidence: [1-9][0-9]*\/[1-9][0-9]* passed/);
  console.log(`PASS ${label}`);
}
try {
  for (const file of [sourcePath, 'test_parked_backlog_guard.sh',
    'test/parked_backlog_guard_preservation.cjs']) {
    const target = path.join(stage, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
  }
  green('unmutated staged baseline');
  for (const [name, before, after, expectedCase] of mutants) {
    assert.equal(source.split(before).length - 1, 1, `${name}: target must occur exactly once`);
    const mutated = source.replace(before, after);
    assert.notEqual(mutated, source, `${name}: mutation must change bytes`);
    fs.writeFileSync(path.join(stage, sourcePath), mutated);
    const syntax = spawnSync(process.execPath, ['--check', path.join(stage, sourcePath)],
      { encoding: 'utf8', timeout: 10000 });
    assert.ifError(syntax.error);
    assert.equal(syntax.status, 0, `${name}: syntax failure is not a killed mutant`);
    const result = suite();
    assert.equal(result.code, 1, `${name}: expected test failure, got ${result.code}`);
    const failures = result.output.split('\n').map(line => line.trim().replace(/^FAIL\s+/, 'FAIL '));
    assert(failures.some(line => line === `FAIL ${expectedCase}` ||
      line.startsWith(`FAIL ${expectedCase}:`)),
    `${name}: named case did not fail: ${expectedCase}\n${result.output}`);
    console.log(`PASS killed: ${name} — ${expectedCase}`);
  }
  fs.writeFileSync(path.join(stage, sourcePath), source);
  green('restored staged baseline');
  assert.equal(fs.readFileSync(path.join(root, sourcePath), 'utf8'), source,
    'shared source changed during gate; do not overwrite concurrent edits');
  console.log(`Mutation gate: ${mutants.length}/${mutants.length} killed; baseline and restoration green`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
