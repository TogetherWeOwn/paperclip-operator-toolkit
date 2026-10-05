// Verdict delivery to GitHub's deployment callback URL.
//
// The webhook tells us WHERE to answer (`deployment_callback_url`), never
// WHETHER to approve: the callback URL is routing, and the verdict comes only
// from `decide`. This module posts exactly one review per invocation —
// `{ environment_name, state, comment }` — and reports whether GitHub
// accepted it. A delivery that cannot be confirmed throws so the caller can
// distinguish "rejected" (answered, recorded) from "unknown" (unconfirmed).

const CALLBACK_HOST = 'api.github.com'
const CALLBACK_PATH = /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/deployment_protection_rule$/

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * Extract the run id a callback URL names, bound to one repository. Throws
 * unless the URL is the protection-rule review endpoint for that repo with no
 * query string. Shared by the verdict post and the receiver's up-front gate so
 * the URL shape is defined once.
 *
 * @param {object} args
 * @param {string} args.callbackUrl
 * @param {string} args.repository
 * @returns {number} the run id named in the URL path
 */
export function extractCallbackRunId({ callbackUrl, repository }) {
  requireValue(typeof callbackUrl === 'string' && callbackUrl.length > 0, 'callback URL is missing')
  requireValue(typeof repository === 'string' && repository.length > 0, 'repository is missing')
  const [owner, name] = repository.split('/')
  let target
  try {
    target = new URL(callbackUrl)
  } catch {
    throw new Error('callback URL is malformed')
  }
  requireValue(target.protocol === 'https:' && target.hostname === CALLBACK_HOST, 'callback URL is outside the GitHub API origin')
  const runMatch = CALLBACK_PATH.exec(target.pathname)
  requireValue(runMatch !== null, 'callback URL is not a protection-rule review endpoint')
  requireValue(runMatch[1] === owner && runMatch[2] === name, 'callback URL is outside the configured repository')
  requireValue(target.search === '', 'callback URL must not carry a query string')
  return Number(runMatch[3])
}

/**
 * Post the verdict to the callback URL from the webhook.
 *
 * @param {object} args
 * @param {(url: string, init?: object) => Promise<Response>} args.fetchImpl
 * @param {string} args.token            installation token; header only, never logged
 * @param {string} args.callbackUrl      `deployment_callback_url` from the verified webhook
 * @param {string} args.repository       `ExampleOrg/example-repo`
 * @param {number} args.runId            run under review; must equal the run id in the callback URL
 * @param {string} args.environment      environment under review
 * @param {'approved' | 'rejected'} args.state  verdict from `decide`
 * @param {string} args.reason           stable reason id from `decide`
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{ posted: true }>}
 */
export async function postVerdict({ fetchImpl, token, callbackUrl, repository, runId, environment, state, reason, timeoutMs = 30000 }) {
  requireValue(typeof fetchImpl === 'function', 'GitHub transport is required')
  requireValue(typeof token === 'string' && token.length > 0 && !/\s/.test(token), 'GitHub credential is missing')
  requireValue(typeof callbackUrl === 'string' && callbackUrl.length > 0, 'callback URL is missing')
  requireValue(typeof repository === 'string' && repository.length > 0, 'repository is missing')
  requireValue(state === 'approved' || state === 'rejected', 'verdict state is invalid')
  requireValue(typeof reason === 'string' && reason.length > 0 && reason.length <= 64 &&
    /^[a-z0-9_]+$/.test(reason), 'verdict reason is invalid')
  requireValue(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000, 'callback timeout is invalid')

  // The callback must be the protection-rule review endpoint for THIS run in
  // THIS repo. The run id in the URL must equal the run just reviewed: a
  // mismatched URL would post this run's verdict onto another run.
  requireValue(Number.isSafeInteger(runId) && runId > 0, 'reviewed run id is invalid')
  const urlRunId = extractCallbackRunId({ callbackUrl, repository })
  requireValue(urlRunId === runId, 'callback URL names a different run')
  const target = new URL(callbackUrl)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(target.toString(), {
      method: 'POST',
      signal: controller.signal,
      redirect: 'manual',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'protection-rule',
      },
      // The comment carries the stable reason id only: no hashes, no SHAs, no
      // run numbers beyond what the URL already names. Reviewable in the
      // GitHub UI without leaking anything the payload did not already say.
      body: JSON.stringify({ environment_name: environment, state, comment: `${environment} protection rule: ${state} (${reason})` }),
    })
    requireValue(response.status === 204, 'GitHub did not accept the verdict')
    return { posted: true }
  } finally {
    clearTimeout(timer)
  }
}
