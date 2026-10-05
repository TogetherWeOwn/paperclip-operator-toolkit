// Generic policy helpers tested ONLY with explicit synthetic authority input.
// No assertion about a live table or deployment belongs in this public suite.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findPolicy, scopedRepositories, validatePolicy, validatePolicies,
  validateTrustedConfig, validateReviewedPlanRepositories } from '../src/environments.js'
import { PLAN_POLICY, SHA_POLICY, SAME_REPO_SHA_POLICY, TRUSTED_CONFIG, freshConfig } from './trusted-fixture.mjs'

const policies = TRUSTED_CONFIG.policies
const resolve = (repository, environment) => findPolicy({ repository, environment, policies })

test('the explicit synthetic table validates', () => {
  assert.deepEqual(validatePolicies(policies), policies)
})
test('explicit plan policy resolves its mode and repository', () => {
  const policy = resolve(PLAN_POLICY.repository, PLAN_POLICY.environment)
  assert.equal(policy?.mode, 'plan')
  assert.equal(policy?.repository, PLAN_POLICY.repository)
})
test('explicit SHA policies bind each environment to its own card', () => {
  for (const expected of [SHA_POLICY, SAME_REPO_SHA_POLICY]) {
    const policy = resolve(expected.repository, expected.environment)
    assert.equal(policy?.mode, 'sha')
    assert.equal(policy?.goIssueId, expected.goIssueId)
  }
})
test('exact match only: near-misses resolve to null', () => {
  assert.equal(resolve(PLAN_POLICY.repository, PLAN_POLICY.environment + ' '), null)
  assert.equal(resolve(SHA_POLICY.repository, SHA_POLICY.environment.toUpperCase()), null)
  assert.equal(resolve(PLAN_POLICY.repository.toLowerCase(), PLAN_POLICY.environment), null)
  assert.equal(resolve(null, SHA_POLICY.environment), null)
  assert.equal(resolve(PLAN_POLICY.repository, null), null)
})
test('unserved environment on a known repo resolves to null', () => {
  assert.equal(resolve(PLAN_POLICY.repository, 'fixture-unserved'), null)
})
test('scoped repositories cover all explicit synthetic rows', () => {
  assert.deepEqual([...scopedRepositories(policies)].sort(), [PLAN_POLICY.repository, SHA_POLICY.repository].sort())
})
test('validator refuses an empty table', () => {
  assert.throws(() => validatePolicies([]))
})
test('validator refuses a duplicate pair including repository case aliases', () => {
  assert.throws(() => validatePolicies([PLAN_POLICY, PLAN_POLICY]))
  assert.throws(() => validatePolicies([PLAN_POLICY, { ...PLAN_POLICY, repository: PLAN_POLICY.repository.toLowerCase() }]))
})
test('validator refuses a bad mode, repository, card or environment', () => {
  for (const entry of [
    { ...SHA_POLICY, mode: 'plan-plus' },
    { ...SHA_POLICY, repository: 'not a repo' },
    { ...SHA_POLICY, repository: 'FixtureOrg/..' },
    { ...SHA_POLICY, goIssueId: 'not-a-uuid' },
    { ...SHA_POLICY, environment: '' },
    { ...SHA_POLICY, environment: ' ' },
    { ...SHA_POLICY, environment: 'fixture-release\n' },
    { ...SHA_POLICY, environment: 'x'.repeat(129) },
  ]) assert.throws(() => validatePolicy(entry))
})
test('policy helpers have no default scope even for invalid selectors', () => {
  for (const list of [undefined, null, [], {}, '[]']) {
    assert.throws(() => validatePolicies(list))
    assert.throws(() => scopedRepositories(list))
    assert.throws(() => findPolicy({ repository: null, environment: null, policies: list }))
  }
})
test('trusted configuration yields a detached immutable authority snapshot', () => {
  const supplied = freshConfig()
  const pinned = validateTrustedConfig(supplied)
  supplied.policies[0].goIssueId = SHA_POLICY.goIssueId
  supplied.policies[0].repository = 'ForeignOrg/not-reviewed'
  supplied.installationIds[0] = 9002
  supplied.reviewedPlanRepositories[0] = 'ForeignOrg/not-reviewed'
  supplied.approverAgentId = '00000000-0000-4000-8000-000000000099'
  assert.deepEqual(pinned, TRUSTED_CONFIG)
  assert.ok(Object.isFrozen(pinned))
  assert.ok(Object.isFrozen(pinned.policies))
  assert.ok(pinned.policies.every(Object.isFrozen))
  assert.ok(Object.isFrozen(pinned.installationIds))
  assert.ok(Object.isFrozen(pinned.reviewedPlanRepositories))
})
for (const field of ['policies', 'approverAgentId', 'reviewedPlanRepositories', 'installationIds']) {
  test(`trusted configuration refuses missing ${field}`, () => {
    const supplied = freshConfig()
    delete supplied[field]
    assert.throws(() => validateTrustedConfig(supplied))
    assert.throws(() => validateTrustedConfig({ ...TRUSTED_CONFIG, [field]: undefined }))
    assert.throws(() => validateTrustedConfig({ ...TRUSTED_CONFIG, [field]: null }))
  })
}
test('trusted configuration refuses malformed or empty approver identity', () => {
  for (const approverAgentId of ['', 'some-agent', 9001, {}, []]) {
    assert.throws(() => validateTrustedConfig({ ...TRUSTED_CONFIG, approverAgentId }))
  }
})
test('trusted configuration refuses unreviewed, foreign or malformed plan scope', () => {
  for (const reviewedPlanRepositories of [
    [], 'FixtureOrg/sample-apply', ['ForeignOrg/unreviewed'],
    [PLAN_POLICY.repository, SHA_POLICY.repository],
    [PLAN_POLICY.repository, PLAN_POLICY.repository], [null], ['invalid'],
  ]) assert.throws(() => validateTrustedConfig({ ...TRUSTED_CONFIG, reviewedPlanRepositories }))
})
test('SHA-only configuration explicitly declares no plan scope; omission is not inferred', () => {
  const supplied = { ...TRUSTED_CONFIG, policies: [SHA_POLICY], reviewedPlanRepositories: [] }
  assert.deepEqual(validateTrustedConfig(supplied).reviewedPlanRepositories, [])
  delete supplied.reviewedPlanRepositories
  assert.throws(() => validateTrustedConfig(supplied))
})
test('evidence scope validator never supplies a default', () => {
  for (const scope of [undefined, null, [], ['invalid'], [PLAN_POLICY.repository, PLAN_POLICY.repository]]) {
    assert.throws(() => validateReviewedPlanRepositories(scope))
  }
})
test('trusted configuration refuses missing, duplicate, sparse or invalid installation allowlist', () => {
  for (const installationIds of [[], [0], [-1], [1.1], [Number.MAX_SAFE_INTEGER + 1], ['9001'], [9001, 9001], Array(1), [null], '9001']) {
    assert.throws(() => validateTrustedConfig({ ...TRUSTED_CONFIG, installationIds }))
  }
})
test('unknown configuration or policy fields refuse rather than silently authorize', () => {
  assert.throws(() => validateTrustedConfig({ ...TRUSTED_CONFIG, issueId: SHA_POLICY.goIssueId }))
  assert.throws(() => validateTrustedConfig({ ...TRUSTED_CONFIG, approverAgentID: TRUSTED_CONFIG.approverAgentId }))
  assert.throws(() => validatePolicies([{ ...PLAN_POLICY, trustedRepo: PLAN_POLICY.repository }]))
  assert.throws(() => validateTrustedConfig(Object.create(TRUSTED_CONFIG)))
  for (const config of [undefined, null, [], 'config']) assert.throws(() => validateTrustedConfig(config))
})
