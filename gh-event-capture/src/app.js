// Routing and policy. Runtime-agnostic on purpose: it takes a store and two
// secrets and returns a `fetch`-shaped function, so the whole surface is
// testable with an in-memory store. Deployment adapters are not included.
//
// Two rules govern every route below.
//
//   FAIL CLOSED. A missing secret is a 503, never a 200 and never an
//   unverified write. An unconfigured deployment must store nothing rather than
//   store bytes it cannot attribute — a store containing one forged row is
//   worse than an empty store, because the empty one does not mislead anyone.
//
//   DEFAULT IS REFUSAL. Unknown path, unknown method, unknown query parameter:
//   all rejected. Anonymous callers cannot widen the service's query policy.

import { verifySignature, REJECT, SIGNATURE_HEADER, DELIVERY_HEADER, EVENT_HEADER } from './verify.js'
import { buildRecord, MAX_ACCEPTED_BODY_BYTES } from './record.js'
import { parseQuery, parseBridgeQuery, nextCursor } from './query.js'
import { claimKey as bridgeClaimKey, classifyPullRequestEvent, classifyCheckSuiteEvent } from './bridge.js'
import { createRejectionCounter, FLUSH_INTERVAL_MS } from './rejection-counter.js'

import { trustedBridgePolicy, trustedRepositories, normalizeIssueRef } from './trusted-policy.js'

const WEBHOOK_PATH = '/gh/webhook'

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

/**
 * Constant-time-ish bearer check for the read API.
 *
 * The read API is not the security boundary the signature check is — it guards
 * a metadata store, not signature attribution — and shares the public service
 * surface, so it gets a comparison rather than `===`.
 *
 * @param {Request} request
 * @param {string | undefined | null} expected
 * @returns {boolean}
 */
function bearerOk(request, expected) {
  const header = request.headers.get('authorization')
  if (typeof expected !== 'string' || expected.length === 0) return false
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const provided = header.slice('Bearer '.length)
  if (provided.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

/**
 * @param {number} ms
 * @returns {string} `YYYY-MM-DD` in UTC
 */
function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * @param {object} deps
 * @param {any} deps.store
 * @param {string | undefined | null} deps.webhookSecret
 * @param {string | undefined | null} deps.queryToken
 * @param {() => number} [deps.now]
 * @param {number} [deps.rejectionFlushMs]  see `rejection-counter.js`
 * @returns {(request: Request) => Promise<Response>}
 */
export function createApp({
  store,
  bridgePolicy,
  allowedRepositories,
  webhookSecret,
  queryToken,
  now = () => Date.now(),
  rejectionFlushMs = FLUSH_INTERVAL_MS,
}) {
  const policy = trustedBridgePolicy(bridgePolicy)
  const repositories = new Set(trustedRepositories(allowedRepositories))
  // Rejection counting goes through a coalescing buffer rather than straight to
  // the store. The webhook route takes anonymous traffic, so a write per
  // rejected request would turn an anonymous flood into storage write volume.
  // The bound is per counter instance, not a global abuse limit.
  const rejections = createRejectionCounter({ store, now, intervalMs: rejectionFlushMs })
  /**
   * POST /gh/webhook — the only unauthenticated write path in the service.
   * @param {Request} request
   */
  async function receive(request) {
    const receivedMs = now()

    if (typeof webhookSecret !== 'string' || webhookSecret.length === 0) {
      // Do NOT count this as a rejection: it is our misconfiguration, not a
      // caller's forgery, and mixing the two would make the counters lie about
      // whether anyone is probing the endpoint.
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
      await rejections.note(utcDay(receivedMs), verdict.reason)
      // Same status and same body for missing, malformed and mismatched. A
      // caller probing the endpoint learns only "not authorised" — not which
      // part of their forgery was wrong.
      return json({ error: 'unauthorized' }, 401)
    }

    // Only past this line does anything reach the store.
    const deliveryId = request.headers.get(DELIVERY_HEADER)
    const event = request.headers.get(EVENT_HEADER)
    if (!deliveryId || !event) {
      // Signed, so it came from someone holding the secret, but it is not a
      // shape we can index or de-duplicate. 400 rather than 401: the signature
      // was fine, the envelope was not.
      await rejections.note(utcDay(receivedMs), 'envelope_incomplete')
      return json({ error: 'missing X-GitHub-Delivery or X-GitHub-Event' }, 400)
    }

    const record = await buildRecord({ bodyBytes, headers: request.headers, signature, receivedMs })
    const { inserted } = await store.append(record)

    // 200 on a duplicate too, and this matters: GitHub retries anything that is
    // not 2xx, so answering 409 would turn every retry into a permanent one.
    return json({
      ok: true,
      delivery_id: deliveryId,
      event,
      stored: inserted,
      duplicate: !inserted,
      body_truncated: record.body_truncated === 1,
    })
  }

  /**
   * GET /events — the query surface.
   * @param {Request} request
   * @param {URL} url
   */
  async function listEvents(request, url) {
    const parsed = parseQuery(url.searchParams)
    if (!parsed.ok) return json({ error: parsed.error }, 400)

    const rows = await store.list(parsed.filters)
    return json({
      count: rows.length,
      next_cursor: nextCursor(rows, parsed.filters.limit),
      events: rows,
    })
  }

  /**
   * POST /bridge/claim: the store must atomically enforce unique claim keys.
   * Only immutable signed evidence establishes an effect, never the selector.
   */
  async function claimBridge(request) {
    /** @type {any} */
    let body
    try {
      body = await request.json()
    } catch {
      return json({ error: 'body is not JSON' }, 400)
    }
    const { issue_ref: issueRef, head_sha: headSha, kind, delivery_id: deliveryId } = body ?? {}
    if (normalizeIssueRef(issueRef, policy) === null) {
      return json({ error: 'issue_ref does not match the trusted tracker policy' }, 400)
    }
    if (headSha !== null && headSha !== undefined && typeof headSha !== 'string') {
      return json({ error: 'head_sha must be a string or null' }, 400)
    }
    if (typeof kind !== 'string' || kind.length === 0) {
      return json({ error: 'kind is required' }, 400)
    }
    if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
      return json({ error: 'delivery_id is required' }, 400)
    }

    let claimKey
    try {
      claimKey = bridgeClaimKey({ issueRef, headSha, kind, deliveryId, url: body.pr_url, action: body.action })
    } catch (error) {
      return json({ error: error.message }, 400)
    }
    // The caller supplies a selector, not evidence. Recompute the effect from
    // immutable, signature-verified deliveries BEFORE consuming its unique key.
    const delivery = await store.get(deliveryId)
    if (delivery === null) return json({ error: 'delivery not found' }, 404)
    let prDelivery = null
    if (delivery.event === 'check_suite') {
      if (typeof body.pr_delivery_id !== 'string' || !body.pr_delivery_id) {
        return json({ error: 'pr_delivery_id is required for suite claims' }, 400)
      }
      prDelivery = await store.get(body.pr_delivery_id)
      if (prDelivery === null) return json({ error: 'PR delivery not found' }, 404)
      if (prDelivery.event !== 'pull_request' || prDelivery.body_truncated !== 0) {
        return json({ error: 'PR evidence must be a complete pull_request delivery' }, 400)
      }
    }
    if (delivery.body_truncated !== 0) return json({ error: 'delivery body is truncated' }, 400)
    let candidates = []
    try {
      const payload = JSON.parse(delivery.body)
      if (!repositories.has(payload?.repository?.full_name) || payload.repository.full_name !== delivery.repository) {
        return json({ error: 'stored delivery is outside configured scope' }, 400)
      }
      if (delivery.event === 'pull_request') {
        const pr = payload.pull_request
        if (pr?.base?.repo?.full_name !== delivery.repository || !Number.isSafeInteger(pr.number) || pr.number <= 0 ||
            pr.html_url !== `https://github.com/${delivery.repository}/pull/${pr.number}`) {
          return json({ error: 'stored PR identity does not match repository scope' }, 400)
        }
        const effect = classifyPullRequestEvent(payload, policy)
        if (effect) {
          candidates.push(effect)
          if (effect.wake) candidates.push({ ...effect, kind: 'pull_request_merged' })
        }
      } else if (delivery.event === 'check_suite') {
        const evidence = JSON.parse(prDelivery.body)
        if (prDelivery.repository !== delivery.repository || evidence?.repository?.full_name !== delivery.repository) {
          return json({ error: 'stored PR evidence is outside configured scope' }, 400)
        }
        candidates = classifyCheckSuiteEvent(payload, [evidence?.pull_request], policy)
      }
      if (!candidates.some((c) => bridgeClaimKey({ ...c, deliveryId }) === claimKey)) {
        return json({ error: 'claim does not match stored delivery effect' }, 400)
      }
    } catch {
      return json({ error: 'stored delivery cannot establish claim identity' }, 400)
    }
    const result = await store.claimBridge({
      claimKey,
      issueRef,
      headSha: headSha ?? null,
      kind,
      deliveryId,
      claimedMs: now(),
    })
    // 200 either way, mirroring the webhook route's duplicate handling: the
    // caller's job is "make sure this is claimed", and a false claim (someone
    // beat you to it) is a normal, successful outcome — never an error.
    return json({ ok: true, claim_key: claimKey, claimed: result.claimed })
  }

  /**
   * GET /bridge/claims — authenticated read side of the claim ledger.
   * @param {URL} url
   */
  async function listBridgeClaims(url) {
    const parsed = parseBridgeQuery(url.searchParams, policy)
    if (!parsed.ok) return json({ error: parsed.error }, 400)
    const claims = await store.listBridgeClaims(parsed.filters)
    return json({ count: claims.length, claims })
  }

  return async function fetch(request) {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (path === WEBHOOK_PATH) {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)
      return await receive(request)
    }

    // Unauthenticated, and deliberately says nothing about the store's
    // contents. `GET /health` returning 200 means THIS SERVICE is up. It does
    // not mean events are arriving, and it is not evidence that the App is
    // still subscribed. Subscription checks are an external responsibility.
    if (path === '/health') {
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405)
      return json({
        ok: true,
        service: 'gh-event-capture',
        webhook_secret_configured: typeof webhookSecret === 'string' && webhookSecret.length > 0,
        query_token_configured: typeof queryToken === 'string' && queryToken.length > 0,
      })
    }

    // Everything below reads or writes the store behind the same bearer.
    if (path === '/events' || path.startsWith('/events/') || path === '/stats' || path.startsWith('/bridge/')) {
      if (typeof queryToken !== 'string' || queryToken.length === 0) {
        return json({ error: 'query API is not configured' }, 503)
      }
      if (!bearerOk(request, queryToken)) {
        return json({ error: 'unauthorized' }, 401)
      }

      if (path === '/bridge/claim') {
        if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)
        return await claimBridge(request)
      }
      if (path === '/bridge/claims') {
        if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405)
        return await listBridgeClaims(url)
      }
      if (path.startsWith('/bridge/')) return json({ error: 'not found' }, 404)

      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405)

      if (path === '/events') return await listEvents(request, url)
      if (path === '/stats') {
        // Settle the rejection buffer first, so the authenticated read reports a
        // current number instead of one lagging by up to the flush interval.
        // Safe to write from a read path only because getting here costs a
        // valid QUERY_TOKEN — an anonymous caller cannot use this to force
        // writes, which is the whole point of the buffer.
        await rejections.flush()
        return json(await store.stats())
      }

      const deliveryId = decodeURIComponent(path.slice('/events/'.length))
      if (!deliveryId) return json({ error: 'missing delivery id' }, 400)
      const row = await store.get(deliveryId)
      if (row === null) return json({ error: 'not found' }, 404)
      return json(row)
    }

    return json({ error: 'not found' }, 404)
  }
}
