// Trusted operator inputs only. Never obtain policy from a webhook, PR text or
// provider response. There are intentionally no prefix, bot or scope defaults.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/

export function trustedBridgePolicy(value) {
  if (!object(value) || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, 'trackerPrefix') || !Object.hasOwn(value, 'agentLogin') ||
      typeof value.trackerPrefix !== 'string' || !/^[A-Z][A-Z0-9]{0,15}$/.test(value.trackerPrefix) ||
      typeof value.agentLogin !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\[bot\]$/.test(value.agentLogin)) {
    throw new Error('explicit trusted bridge policy is missing or invalid')
  }
  return Object.freeze({ trackerPrefix: value.trackerPrefix, agentLogin: value.agentLogin })
}

export function trustedRepositories(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10000 ||
      !value.every(repository => typeof repository === 'string' && REPOSITORY.test(repository) &&
        !['.', '..'].includes(repository.split('/')[1])) || new Set(value).size !== value.length) {
    throw new Error('explicit unique repository scope is missing or invalid')
  }
  return Object.freeze([...value])
}

export function trustedVisibility(value, repositories) {
  const scope = trustedRepositories(repositories)
  if (!object(value) || Object.keys(value).length !== scope.length ||
      !scope.every(repository => Object.hasOwn(value, repository) && typeof value[repository] === 'boolean')) {
    throw new Error('explicit repository visibility is missing or invalid')
  }
  return Object.freeze(Object.fromEntries([...scope].sort().map(repository => [repository, value[repository]])))
}

// Positive canonical decimal numbers only, bounded to exact JS integer identity.
// Uppercase is required on authoritative identifiers; parsing PR text is case-insensitive.
export function normalizeIssueRef(text, policy, { caseInsensitive = false } = {}) {
  const { trackerPrefix } = trustedBridgePolicy(policy)
  if (typeof text !== 'string') return null
  const match = new RegExp(`^${trackerPrefix}-([1-9]\\d{0,15})$`, caseInsensitive ? 'i' : '').exec(text)
  return match && Number.isSafeInteger(Number(match[1])) ? `${trackerPrefix}-${match[1]}` : null
}

export function findIssueRef(text, policy) {
  const { trackerPrefix } = trustedBridgePolicy(policy)
  if (typeof text !== 'string') return null
  const pattern = new RegExp(`\\b${trackerPrefix}-([1-9]\\d{0,15})\\b`, 'ig')
  for (const match of text.matchAll(pattern)) {
    if (Number.isSafeInteger(Number(match[1]))) return `${trackerPrefix}-${match[1]}`
  }
  return null
}
