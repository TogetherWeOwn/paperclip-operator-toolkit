#!/usr/bin/env node
'use strict';
// Maintained QA regressions from TOG-3726. Optional module path supports mutants.
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildReport, verdictFor } = require(path.resolve(
  process.argv[2] || path.join(__dirname, '../scripts/parked_backlog_guard.js')));
const card = { identifier: 'TEST-1', description: 'Follow up on routing accuracy.' };
const park = {
  id: 'park', issueIdentifier: card.identifier, authorType: 'agent',
  authorAgentId: 'fixture-agent', createdAt: '2026-09-17T10:42:50Z',
  body: 'Parked to backlog under the CTO burn cap. No work until the cap is lifted.',
};
const progress = {
  ...park, id: 'progress', createdAt: '2026-09-20T05:24:23Z',
  body: 'Added a reference link; no scheduling decision.',
};
const operator = { ...progress, authorType: 'user', authorAgentId: null,
  authorUserId: 'fixture-user' };
const parkedDescription = { ...card,
  description: 'Why backlog, not todo: parked under the CTO burn cap until explicitly lifted.' };
const cases = [
  ['positive control: latest agent park', card, [park], 1, 'comment'],
  ['positive control: ordinary queue', card,
    [{ ...park, body: 'Queued for implementation.' }], 0, null],
  ['unrelated operator note preserves agent park', card, [park, operator], 1, 'comment'],
  ['unrelated agent note preserves description park (original QA)',
    parkedDescription, [park, progress], 1, 'comment'],
  ['description park survives agent note independently',
    parkedDescription, [progress], 1, 'description'],
  ['agent park survives unrelated agent note', card, [park, progress], 1, 'comment'],
  ['generic promotion is not an unpark', card,
    [park, { ...operator, body: 'Operator sweep: get work moving; promoted from backlog to todo.' }],
    1, 'comment'],
  ['user park quotation alone does not park', card,
    [{ ...operator, body: 'This was parked before; adding a reference.' }], 0, null],
  ['deleted agent park is not evidence', card,
    [{ ...park, deletedAt: '2026-09-19T00:00:00Z' }, progress], 0, null],
  ['unrelated input order does not erase park', card, [operator, park], 1, 'comment'],
  ['ordinary topic-only progress is not a park', card,
    [{ ...progress, body: 'Implementing the approved non-product run-minutes metric; burn cap and lane optimization analysis.' }], 0, null],
  ['ordinary topic-only description is not a park',
    { ...card, description: 'Measure non-product burn-cap spend against the standing cap.' },
    [progress], 0, null],
  ['explicit-looking user note is not verified authority', card,
    [park, { ...operator, body: 'CTO approved: cap lifted, resume work.' }], 1, 'comment'],
  ['claimed CTO identity is not verified authority', card,
    [park, { ...progress, authorAgentId: 'cto', body: 'Cap lifted, resume work.' }], 1, 'comment'],
  ['operator metadata is not verified authority', card,
    [park, { ...operator, runId: null, authorizationReason: 'allow_board_actor',
      body: 'Promoted from backlog to todo.' }], 1, 'comment'],
  ['agent parking mention remains conservatively flagged', card,
    [{ ...progress, body: 'Not parked; this is just a discussion of the policy.' }], 1, 'comment'],
];
function assertDetectorOnly(report) {
  assert.equal(report.mode, 'detector-only');
  assert.equal(report.promotionAuthorized, false);
  assert.equal(report.schedulingEvidence, 'not-verified');
}
let failed = 0;
for (const [label, candidate, comments, code, evidence] of cases) {
  try {
    const report = buildReport({ backlog: [candidate], comments });
    assertDetectorOnly(report);
    assert.equal(verdictFor(report).code, code);
    assert.equal(verdictFor(report).verdict, code === 1 ? 'PARKED' : 'NO_PARK_SIGNAL');
    assert.equal(report.parked.length, code === 1 ? 1 : 0);
    if (evidence) assert.equal(report.parked[0].evidence, evidence);
    console.log(`PASS ${label}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${label}: ${error.message}`);
  }
}
const invalidCases = [
  ['missing comments', { backlog: [card] }],
  ['missing backlog', { comments: [progress] }],
  ['null candidate', { backlog: [null], comments: [progress] }],
  ['bad description', { backlog: [{ ...card, description: {} }], comments: [progress] }],
  ['bad body', { backlog: [card], comments: [{ ...progress, body: {} }] }],
  ['bad timestamp', { backlog: [card], comments: [{ ...progress, createdAt: 'invalid' }] }],
  ['missing agent identity', { backlog: [card], comments: [{ ...progress, authorAgentId: null }] }],
  ['another card cannot cover missing evidence', {
    backlog: [card, { ...card, identifier: 'TEST-2' }], comments: [progress],
  }],
  ['duplicate candidate', { backlog: [card, card], comments: [progress] }],
  ['only deleted evidence', { backlog: [card], comments: [{ ...park, deletedAt: park.createdAt }] }],
];
for (const [label, doc] of invalidCases) {
  try {
    const report = buildReport(doc);
    assertDetectorOnly(report);
    const result = verdictFor(report);
    assert.equal(result.code, 5);
    assert.equal(result.verdict, 'UNKNOWN');
    console.log(`PASS fail safe: ${label}`);
  } catch (error) {
    failed++;
    console.error(`FAIL fail safe: ${label}: ${error.message}`);
  }
}
const total = cases.length + invalidCases.length;
console.log(`Preservation/evidence: ${total - failed}/${total} passed`);
process.exitCode = failed ? 1 : 0;
