// Offline suite for the protection-rule verdict.
//
// No credentials, no network, no clock. `decide` is pure: every test pins a
// (state, reason) pair for one row of the decision table. Assertions pin the
// stable reason identifiers, never message text, which drifts.
//
// The mutations this suite must catch: any branch that turns a rejection into
// an approval, in either mode. Each rejection row below exists so that
// weakening it goes red.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decide, EVENT, REASON } from '../src/decide.js'

const HEAD = 'a'.repeat(40)
const OTHER_HEAD = 'd'.repeat(40)
const HASH_A = 'b'.repeat(64)
const HASH_B = 'c'.repeat(64)

const PLAN_POLICY = { repository: 'ExampleOrg/example-repo', environment: 'staging-migrate-apply', mode: 'plan' }
const SHA_POLICY = { repository: 'ExampleOrg/other-repo', environment: 'production', mode: 'sha' }

function claim(overrides = {}) {
  return { planManifestSha256: HASH_A, planRunId: 101, ...overrides }
}

function plan(overrides = {}) {
  return { runId: 101, headSha: HEAD, manifestSha256: HASH_A, ...overrides }
}

function planArgs(overrides = {}) {
  return {
    event: EVENT,
    environment: PLAN_POLICY.environment,
    policy: PLAN_POLICY,
    headSha: HEAD,
    claim: claim(),
    plan: plan(),
    goHashes: [HASH_A],
    ...overrides,
  }
}

function shaArgs(overrides = {}) {
  return {
    event: EVENT,
    environment: SHA_POLICY.environment,
    policy: SHA_POLICY,
    headSha: HEAD,
    goShas: [HEAD],
    ...overrides,
  }
}

// The two rows that approve. Everything below rejects.
test('plan mode: matching plan and CEO GO approves', () => {
  assert.deepEqual(decide(planArgs()), { state: 'approved', reason: REASON.APPROVED })
})

test('sha mode: CEO GO for the exact head SHA approves', () => {
  assert.deepEqual(decide(shaArgs()), { state: 'approved', reason: REASON.APPROVED })
})

test('wrong event rejects in both modes', () => {
  assert.deepEqual(decide(planArgs({ event: 'push' })).reason, REASON.WRONG_EVENT)
  assert.deepEqual(decide(shaArgs({ event: 'push' })).reason, REASON.WRONG_EVENT)
})

test('wrong environment rejects (policy does not match the delivery)', () => {
  assert.deepEqual(decide(planArgs({ environment: 'staging-migrate-plan' })).reason, REASON.WRONG_ENVIRONMENT)
  assert.deepEqual(decide(shaArgs({ environment: 'staging' })).reason, REASON.WRONG_ENVIRONMENT)
})

test('missing policy rejects', () => {
  assert.deepEqual(decide(planArgs({ policy: null })).reason, REASON.WRONG_ENVIRONMENT)
})

test('policy naming another environment rejects cross-environment approval', () => {
  // A plan-mode policy for staging must never approve a production delivery,
  // and a sha-mode policy must never approve by plan hash.
  assert.deepEqual(decide(planArgs({ environment: SHA_POLICY.environment, policy: SHA_POLICY })).reason, REASON.GO_SHA_MISSING)
  assert.deepEqual(decide(shaArgs({ environment: PLAN_POLICY.environment, policy: PLAN_POLICY })).reason, REASON.CLAIM_MISSING)
})

test('missing claim rejects in plan mode', () => {
  assert.equal(decide(planArgs({ claim: null })).reason, REASON.CLAIM_MISSING)
})

test('malformed claim rejects in plan mode', () => {
  assert.equal(decide(planArgs({ claim: { planManifestSha256: 'short', planRunId: 101 } })).reason, REASON.CLAIM_MISSING)
  assert.equal(decide(planArgs({ claim: { planManifestSha256: HASH_A } })).reason, REASON.CLAIM_MISSING)
  assert.equal(decide(planArgs({ claim: { planManifestSha256: HASH_A.toUpperCase(), planRunId: 101 } })).reason, REASON.CLAIM_MISSING)
})

test('missing plan rejects in plan mode', () => {
  assert.equal(decide(planArgs({ plan: null })).reason, REASON.PLAN_NOT_FOUND)
})

test('plan run id mismatch rejects', () => {
  assert.equal(decide(planArgs({ plan: plan({ runId: 102 }) })).reason, REASON.PLAN_NOT_FOUND)
})

test('plan on a different commit rejects', () => {
  assert.equal(decide(planArgs({ plan: plan({ headSha: OTHER_HEAD }) })).reason, REASON.SHA_MISMATCH)
})

test('invalid run head rejects in both modes', () => {
  assert.equal(decide(planArgs({ headSha: 'not-a-sha' })).reason, REASON.SHA_MISMATCH)
  assert.equal(decide(shaArgs({ headSha: 'not-a-sha' })).reason, REASON.SHA_MISMATCH)
})

test('hash mismatch rejects in plan mode', () => {
  assert.equal(decide(planArgs({ plan: plan({ manifestSha256: HASH_B }) })).reason, REASON.HASH_MISMATCH)
})

test('missing CEO GO rejects in plan mode', () => {
  assert.equal(decide(planArgs({ goHashes: [] })).reason, REASON.GO_MISSING)
  assert.equal(decide(planArgs({ goHashes: [HASH_B] })).reason, REASON.GO_MISSING)
  assert.equal(decide(planArgs({ goHashes: null })).reason, REASON.GO_MISSING)
})

test('GO for the exact hash approves among others', () => {
  assert.equal(decide(planArgs({ goHashes: [HASH_B, HASH_A] })).state, 'approved')
})

test('sha mode: GO for another SHA rejects', () => {
  assert.deepEqual(decide(shaArgs({ goShas: [OTHER_HEAD] })), { state: 'rejected', reason: REASON.GO_SHA_MISSING })
  assert.deepEqual(decide(shaArgs({ goShas: [] })), { state: 'rejected', reason: REASON.GO_SHA_MISSING })
})

test('sha mode: malformed GO set rejects (never a pass)', () => {
  assert.equal(decide(shaArgs({ goShas: null })).reason, REASON.GO_MISSING)
  assert.equal(decide(shaArgs({ goShas: ['not-a-sha'] })).reason, REASON.GO_MISSING)
})

test('sha mode: GO for the exact SHA approves among others', () => {
  assert.equal(decide(shaArgs({ goShas: [OTHER_HEAD, HEAD] })).state, 'approved')
})

test('sha mode: a plan-hash GO does not approve', () => {
  // Plan hashes (64hex) are not SHAs (40hex): they cannot appear in goShas,
  // and a GO set carrying one is malformed, which rejects.
  assert.equal(decide(shaArgs({ goShas: [HASH_A] })).reason, REASON.GO_MISSING)
})
