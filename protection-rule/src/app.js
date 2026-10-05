// Routing and policy. Runtime-agnostic on purpose: takes secrets, config and
// transports and returns a `fetch`-shaped function, so the whole surface is
// testable under `node --test` with stub transports, and `server.js` is a thin
// adapter that supplies the host environment.
//
// Two rules govern every route below, inherited from the capture service this
// endpoint is modelled on:
//
//   FAIL CLOSED. A missing secret is a 503, never a 200 and never an
//   unverified write. An unconfigured deployment approves nothing and rejects
//   nothing — it answers 503 without touching GitHub or the board, because a
//   verdict posted with a half-read configuration would be worse than none.
//
//   DEFAULT IS REJECTION. Unknown path, unknown method, wrong event, wrong
//   environment: all end in a posted `rejected` (for recognised protection-rule
//   deliveries) or an HTTP error (for everything else). There is no branch on
//   which uncertainty becomes an approval.

import { verifySignature, REJECT, SIGNATURE_HEADER, DELIVERY_HEADER, EVENT_HEADER } from './verify.js'
import { mintInstallationToken, createGithubReader } from './github.js'
import { scanChiefGo, scanChiefGoShas } from './board.js'
import { verifyPlan, readApplyClaim } from './evidence.js'
import { decide, EVENT, REASON } from './decide.js'
import { postVerdict, extractCallbackRunId } from './callback.js'
import { findPolicy, scopedRepositories, validateTrustedConfig } from './environments.js'

// GitHub's own documented ceiling for a webhook payload. Anything larger did
// not come from GitHub; refuse it before spending a HMAC on it.
export const MAX_ACCEPTED_BODY_BYTES = 25 * 1024 * 1024

const SHA40 = /^[0-9a-f]{40}$/

/**
 * @param {any} body
 * @param {number} status
 * @returns {Response}
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2) + '\n', {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Nothing here should ever be cached by an intermediary.
      'cache-control': 'no-store',
    },
  })
}

function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function requireCallbackRun({ callbackUrl, repository, runId }) {
  const urlRunId = extractCallbackRunId({ callbackUrl, repository })
  if (urlRunId !== runId) throw new Error('callback URL names a different run')
}

/**
 * @param {object} config
 * @param {string | undefined | null} config.webhookSecret  App webhook secret; fail-closed when absent
 * @param {string | undefined | null} config.appId           GitHub App id for JWT minting
 * @param {string | undefined | null} config.appPrivateKey   App RSA key PEM; env-inherited, never logged
 * @param {string | undefined | null} config.boardToken      Paperclip credential; header only, never logged
 * @param {string} config.boardOrigin  board origin for the GO scan
 * @param {object} config.trustedConfig  operator-reviewed authority configuration; NEVER request input
 * @param {(url: string, init?: object) => Promise<Response>} [config.fetchImpl]
 * @param {() => number} [config.now]
 * @param {typeof mintInstallationToken} [config.mintToken]
 *   injectable only so tests can stub the JWT mint; production always uses the
 *   real minter bound to the configured App identity.
 * @returns {(request: Request) => Promise<Response>}
 */
export function createApp({
  webhookSecret,
  appId,
  appPrivateKey,
  boardToken,
  boardOrigin,
  trustedConfig,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  mintToken = mintInstallationToken,
}) {
  // Missing/invalid authority input refuses construction, before any request or
  // transport. Snapshot it so later caller mutation cannot change live scope.
  const { policies, approverAgentId, reviewedPlanRepositories, installationIds } = validateTrustedConfig(trustedConfig)
  const repositories = scopedRepositories(policies)
  const installations = new Set(installationIds)
  /**
   * POST /protection-rule — the only webhook write path in the service.
   * @param {Request} request
   */
  async function receive(request) {
    if (typeof webhookSecret !== 'string' || webhookSecret.length === 0) {
      return json({ error: 'receiver is not configured', reason: REJECT.NO_SECRET }, 503)
    }
    if (typeof appId !== 'string' || appId.length === 0 ||
        typeof appPrivateKey !== 'string' || !appPrivateKey.includes('PRIVATE KEY') ||
        typeof boardToken !== 'string' || boardToken.length === 0 ||
        typeof boardOrigin !== 'string' || boardOrigin.length === 0) {
      return json({ error: 'receiver is not configured', reason: REJECT.NO_SECRET }, 503)
    }

    // Reject before hashing. Above GitHub's own documented payload ceiling, so
    // this cannot be a real delivery; refusing early means an oversized body
    // never costs us a HMAC over 25MB+.
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_ACCEPTED_BODY_BYTES) {
      return json({ error: 'payload too large' }, 413)
    }

    const bodyBytes = new Uint8Array(await request.arrayBuffer())
    if (bodyBytes.length > MAX_ACCEPTED_BODY_BYTES) {
      return json({ error: 'payload too large' }, 413)
    }

    const signature = request.headers.get(SIGNATURE_HEADER)
    const verdict = await verifySignature({ secret: webhookSecret, body: bodyBytes, header: signature })
    if (!verdict.ok) {
      // Same status and same body for missing, malformed and mismatched. A
      // caller probing the endpoint learns only "not authorised" — not which
      // part of their forgery was wrong.
      return json({ error: 'unauthorized' }, 401)
    }

    const deliveryId = request.headers.get(DELIVERY_HEADER)
    const event = request.headers.get(EVENT_HEADER)
    if (!deliveryId || !event) {
      // Signed, so it came from someone holding the secret, but it is not a
      // shape we can route. 400 rather than 401: the signature was fine, the
      // envelope was not.
      return json({ error: 'missing X-GitHub-Delivery or X-GitHub-Event' }, 400)
    }

    let payload = null
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes))
    } catch {
      payload = null // signed but unparseable — rejectable, never approvable
    }

    // Fast-path refusals that need no credential: wrong event, wrong
    // environment, or an envelope that cannot name a run to review. Each posts
    // `rejected` to the callback so the deployment does not hang, EXCEPT when
    // there is no trustworthy callback URL — then the only safe answer is the
    // HTTP error, and GitHub's own retry/expiry closes the deployment.
    const environment = payload && typeof payload === 'object' ? str(payload.environment) : null
    const callbackUrl = payload && typeof payload === 'object' ? str(payload.deployment_callback_url) : null
    const runId = payload && typeof payload === 'object' && payload.deployment &&
      typeof payload.deployment === 'object' ? payload.deployment.run_id ?? null : null
    const repository = payload && typeof payload === 'object' && payload.repository &&
      typeof payload.repository === 'object' ? str(payload.repository.full_name) : null
    const installationId = payload && typeof payload === 'object' && payload.installation &&
      typeof payload.installation === 'object' && Number.isSafeInteger(payload.installation.id)
      ? payload.installation.id : null

    // The delivery only names an installation inside the trusted allowlist; it
    // cannot choose which App installation we are willing to answer as.
    if (!installations.has(installationId)) {
      return json({ error: 'installation is outside the configured scope' }, 400)
    }

    // A foreign repo's delivery is answered with the HTTP error, never with
    // a verdict: posting a review into a repo outside our scope would spend
    // this App's authority where it was never granted.
    if (repository !== null && !repositories.has(repository)) {
      return json({ error: 'repository is outside the configured scope' }, 400)
    }
    const policy = findPolicy({ repository, environment, policies })
    if (event !== EVENT || policy === null) {
      const reason = event !== EVENT ? REASON.WRONG_EVENT : REASON.WRONG_ENVIRONMENT
      // Without a resolved policy there is no scoped repo to answer as. The
      // repository pin above already refused foreign repos, but an unserved
      // environment on a KNOWN repo still leaves no trustworthy callback
      // target — answer with the HTTP error, and GitHub's own retry/expiry
      // closes the deployment.
      if (policy === null || repository === null || !repositories.has(repository)) {
        return json({ error: 'protection-rule delivery names no reviewable run' }, 400)
      }
      let posted = false
      try {
        posted = await tryPost({
          fetchImpl, mintToken, appId, appPrivateKey, installationId,
          callbackUrl, repository, runId,
          environment: environment ?? 'unknown',
          state: 'rejected', reason,
        })
      } catch {
        return json({ error: 'protection-rule delivery names no reviewable run' }, 400)
      }
      return json({ ok: true, state: 'rejected', reason, callback_posted: posted })
    }
    if (!Number.isSafeInteger(runId) || runId <= 0 || !callbackUrl ||
        !installationId) {
      return json({ error: 'protection-rule delivery names no reviewable run' }, 400)
    }
    // The callback URL must name the claimed run, in this repo, with no query
    // string — before any credential is minted. A mismatched URL would post
    // this run's verdict onto another run, so it is refused, not answered.
    try {
      requireCallbackRun({ callbackUrl, repository, runId })
    } catch {
      return json({ error: 'protection-rule delivery names no reviewable run' }, 400)
    }

    // Slow path: mint ONE installation token for THIS installation only, then
    // establish every decision input from fresh reads. Any evidence failure —
    // mint, run read, claim read, plan chain, GO scan — resolves to
    // `rejected` with the reason naming the failed link. A callback failure is
    // reported as its own outcome (`callback_failed`), never folded into a
    // decision reason: the verdict GitHub holds and the reason we name must
    // never disagree. No credential is ever substituted: a mint failure
    // throws, it never falls through to another identity.
    try {
      const token = await mintToken({
        fetchImpl, appId, privateKeyPem: appPrivateKey, installationId, nowMs: now(),
      })
      const github = createGithubReader({ fetchImpl, token, allowedRepositories: [repository] })
      const run = await github.getRun(repository, runId)
      let claim = null
      let plan = null
      let goHashes = []
      let goShas = []
      if (policy.mode === 'plan') {
        claim = await readApplyClaim({ github, repository, reviewedPlanRepositories, applyRunId: run.id })
        if (claim !== null) {
          try {
            plan = await verifyPlan({
              github, repository, reviewedPlanRepositories, planRunId: claim.planRunId,
              claimedHash: claim.planManifestSha256, applyHeadSha: run.headSha,
            })
          } catch {
            plan = null // unverified plan is no plan; decide() rejects it
          }
        }
        goHashes = await scanChiefGo({ fetchImpl, boardOrigin, token: boardToken, issueId: policy.goIssueId, approverAgentId })
      } else {
        goShas = await scanChiefGoShas({ fetchImpl, boardOrigin, token: boardToken, issueId: policy.goIssueId, approverAgentId })
      }
      const decision = decide({
        event, environment, policy, headSha: run.headSha, claim, plan, goHashes, goShas,
      })
      try {
        // Bind to the FRESH-READ run id, not the payload claim: getRun already
        // proved run.id === runId, so this names the verified run.
        await postVerdict({
          fetchImpl, token, callbackUrl, repository, runId: run.id,
          environment, state: decision.state, reason: decision.reason,
        })
      } catch {
        return json({ ok: false, state: decision.state, reason: decision.reason, callback_posted: false, error: 'verdict not delivered' }, 502)
      }
      return json({ ok: true, state: decision.state, reason: decision.reason, callback_posted: true })
    } catch {
      // Best-effort rejection post: the deployment must not hang on our
      // failure. If this too fails, the HTTP 200 below still reports the
      // verdict truthfully with callback_posted: false — and the reason stays
      // the evidence failure, never the callback failure. The reason is the
      // approval that could not be established: the plan claim in plan mode,
      // the configured approver GO in sha mode (production deploys have no claim concept, so
      // naming it would lie to the operator reading the callback comment).
      const failureReason = policy.mode === 'sha' ? REASON.GO_MISSING : REASON.CLAIM_MISSING
      let posted = false
      try {
        // Bind to the payload-claimed run: no verified run exists on this
        // path, but the URL must still agree with the claim, or nothing posts.
        await tryPost({
          fetchImpl, mintToken, appId, appPrivateKey, installationId,
          callbackUrl, repository, runId, environment, state: 'rejected',
          reason: failureReason,
        })
        posted = true
      } catch {
        posted = false
      }
      return json({ ok: true, state: 'rejected', reason: failureReason, callback_posted: posted })
    }
  }

  return async function fetch(request) {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (path === '/protection-rule') {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)
      return await receive(request)
    }

    // Unauthenticated, and deliberately says nothing about configuration. `GET
    // /health` returning 200 means THIS SERVICE is up. It does not mean the
    // App is subscribed, the secrets are set, or any deployment was reviewed.
    if (path === '/health') {
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405)
      return json({ ok: true, service: 'protection-rule' })
    }

    return json({ error: 'not found' }, 404)
  }
}

/**
 * Best-effort rejection for the fast path and the failure path: mint a token
 * for the claimed installation and post `rejected`. Throws when there is
 * nothing trustworthy to post with (no installation, no callback) so the
 * caller answers with the HTTP error instead of a verdict it cannot deliver.
 */
async function tryPost({ fetchImpl, mintToken, appId, appPrivateKey, installationId, callbackUrl, repository, runId, environment, state, reason }) {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error('no installation to answer as')
  if (typeof callbackUrl !== 'string' || callbackUrl.length === 0) throw new Error('no callback to answer on')
  requireCallbackRun({ callbackUrl, repository, runId })
  const token = await mintToken({ fetchImpl, appId, privateKeyPem: appPrivateKey, installationId })
  await postVerdict({ fetchImpl, token, callbackUrl, repository, runId, environment, state, reason })
  return true
}

export { SHA40 }
