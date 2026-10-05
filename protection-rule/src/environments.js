// Generic validators and exact-match resolvers. This module contains NO policy
// table, identity, installation or repository default. Configuration is trusted
// operator input, supplied before startup; webhook fields only select within it.

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
export const MODES = Object.freeze(['plan', 'sha'])

function invalid(message) {
  throw new Error(message)
}

function record(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${label} is invalid`)
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid(`${label} has an unknown field`)
  if (keys.some((key) => !Object.hasOwn(value, key))) invalid(`${label} has a missing field`)
}

export function validateRepository(repository) {
  if (typeof repository !== 'string' || !REPOSITORY.test(repository) ||
      ['.', '..'].includes(repository.split('/')[1])) invalid('repository is invalid')
  return repository
}

export function validateApproverAgentId(approverAgentId) {
  if (typeof approverAgentId !== 'string' || !UUID.test(approverAgentId)) invalid('approver identity is invalid')
  return approverAgentId
}

/** Nonempty, explicit repository scope; used independently by evidence readers. */
export function validateReviewedPlanRepositories(repositories) {
  if (!Array.isArray(repositories) || repositories.length === 0) invalid('reviewed plan repository scope is missing')
  const seen = new Set()
  for (const repository of repositories) {
    validateRepository(repository)
    if (seen.has(repository.toLowerCase())) invalid('reviewed plan repository scope holds a duplicate')
    seen.add(repository.toLowerCase())
  }
  return repositories
}

/** One trusted (repository, environment) mapping, with mode and approval card. */
export function validatePolicy(entry) {
  record(entry, ['repository', 'environment', 'mode', 'goIssueId'], 'protected environment entry')
  validateRepository(entry.repository)
  if (typeof entry.environment !== 'string' || entry.environment.length === 0 ||
      entry.environment.length > 128 || entry.environment.trim() !== entry.environment ||
      /[\u0000-\u001f\u007f]/.test(entry.environment)) invalid('protected environment name is invalid')
  if (!MODES.includes(entry.mode)) invalid('protected environment mode is invalid')
  if (typeof entry.goIssueId !== 'string' || !UUID.test(entry.goIssueId)) invalid('protected environment GO card is invalid')
}

/** Validate every row and reject duplicate pairs. No implicit policy table. */
export function validatePolicies(list) {
  if (!Array.isArray(list) || list.length === 0) invalid('protected environment table is empty')
  const seen = new Set()
  for (const entry of list) {
    validatePolicy(entry)
    const key = `${entry.repository.toLowerCase()}\0${entry.environment}`
    if (seen.has(key)) invalid('protected environment table holds a duplicate')
    seen.add(key)
  }
  return list
}

/**
 * Validate trusted configuration and return an immutable, detached snapshot.
 * The caller must obtain this from an operator-controlled source, NOT a request.
 * Syntax validation alone does not prove ownership or review of configuration.
 *
 * reviewedPlanRepositories must explicitly equal the repos served in plan mode.
 * A SHA-only deployment explicitly supplies []; omission is never inferred.
 */
export function validateTrustedConfig(config) {
  record(config, ['policies', 'approverAgentId', 'reviewedPlanRepositories', 'installationIds'], 'trusted configuration')
  validatePolicies(config.policies)
  validateApproverAgentId(config.approverAgentId)
  if (!Array.isArray(config.reviewedPlanRepositories)) invalid('reviewed plan repository scope is missing')
  if (config.reviewedPlanRepositories.length > 0) validateReviewedPlanRepositories(config.reviewedPlanRepositories)
  const planRepositories = new Set(config.policies.filter((policy) => policy.mode === 'plan').map((policy) => policy.repository))
  const reviewed = new Set(config.reviewedPlanRepositories)
  if (planRepositories.size !== reviewed.size || [...planRepositories].some((repository) => !reviewed.has(repository))) {
    invalid('reviewed plan repository scope does not match plan policy')
  }
  if (!Array.isArray(config.installationIds) || config.installationIds.length === 0 ||
      [...config.installationIds].some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(config.installationIds).size !== config.installationIds.length) invalid('installation allowlist is invalid')
  return Object.freeze({
    policies: Object.freeze(config.policies.map((policy) => Object.freeze({ ...policy }))),
    approverAgentId: config.approverAgentId,
    reviewedPlanRepositories: Object.freeze([...config.reviewedPlanRepositories]),
    installationIds: Object.freeze([...config.installationIds]),
  })
}

/** Exact match on both halves, never a prefix or case-normalized lookup. */
export function findPolicy({ repository, environment, policies }) {
  validatePolicies(policies)
  if (typeof repository !== 'string' || typeof environment !== 'string') return null
  return policies.find((policy) => policy.repository === repository && policy.environment === environment) ?? null
}

/** Repositories holding at least one explicitly configured environment. */
export function scopedRepositories(policies) {
  validatePolicies(policies)
  return new Set(policies.map((policy) => policy.repository))
}
