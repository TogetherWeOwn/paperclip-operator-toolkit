// Upstream PR watcher, change-only intake.
//
// No I/O. This module turns ONE compact read of one upstream pull request
// (upstream PRs authored by the bot identity or fork heads) plus the
// persisted acknowledgement for that PR into at most one change digest. The
// caller feeds the digest to the single recovery writer, which
// updates/wakes the canonical tracking task, and persists the returned
// acknowledgement ONLY after durable delivery.
//
// SILENT UNLESS CHANGED. An unchanged snapshot resolves to `silent`: zero
// wakes, acknowledgement untouched. A malformed snapshot throws: a swallowed
// bad read would look exactly like "nothing to do" and a stall would wait
// forever. A failed, rate-limited or partial read resolves to `unknown` —
// never to `silent` and never to a close: unknown is not zero findings and
// not a closed PR.
//
// ONE-SHOTS LATCH. SLA breaches and the reopen-mismatch report once: the ack
// carries the latched outcomes, so the tick after stays silent. If the ack
// persist races a delivered writer comment (ack-loss), the retry converges
// instead of re-emitting: the collector passes the tracking task's writer
// markers (`recovery-writer:<fp>` comment strings) as `cardMarkers`, a hit
// on this digest's expected marker resolves to `latched` (zero wakes, persist
// the returned ack), and no second identical board comment is ever posted.
//
// READ-ONLY. Nothing here publishes replies, resolves threads, re-requests
// reviews, merges or force-pushes. Upstream text stays with the operator and
// the approved identity path.
//
// SAFETY. PR titles, bodies, branch names, thread bodies and comment bodies
// from the upstream repo are never accepted here at all: snapshots carry only
// validated SHAs, fixed-vocabulary states, opaque thread/comment ids and
// content hashes. Digests and writer notes carry fixed words plus the
// validated repository, PR number and change kinds.
//
// COLLECTION CONTRACT (caller-owned, host-side). The platform scheduler runs
// a read-only collection every 15 minutes: GraphQL compact snapshots for the
// tracked PRs, REST conditional requests only where the endpoint supports
// them (GraphQL POST has no ETag support — do not invent it), every page
// fetched (pages.fetched must equal pages.total or the read is partial).
// Rate-limit backoff and retry are the collector's job; this module only
// classifies what the collector hands it.

import { createHash } from 'node:crypto'

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/
const SHA40 = /^[0-9a-f]{40}$/
const HEX = /^[0-9a-f]+$/
const OPAQUE_ID = /^[A-Za-z0-9_:\/-]{1,200}$/
const MS_LIMIT = 8.64e15

const STATES = Object.freeze(['open', 'closed'])
const CI_ROLLUPS = Object.freeze(['green', 'red', 'pending', 'unknown'])
const MERGEABLES = Object.freeze(['mergeable', 'conflicting', 'behind', 'unknown'])
const REVIEWS = Object.freeze(['approved', 'changes_requested', 'review_required', 'unknown'])
const AUTHOR_KINDS = Object.freeze(['human', 'bot'])
const CHANGE_KINDS = Object.freeze([
  'head', 'ci', 'mergeable', 'review',
  'thread-opened', 'thread-resolved', 'thread-updated',
  'comment', 'comment-edited',
  'closed', 'reopened', 'reopen-mismatch',
  'sla-response-breach', 'sla-redci-breach', 'sla-ping-eligible',
])
// Must stay within the recovery writer allowlist plus "none": the writer
// refuses anything else, so an incompatible digest would die silently.
const WRITER_MUTATION = 'operator_decision'

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function isMs(value) {
  return Number.isInteger(value) && value >= 0 && value <= MS_LIMIT
}

function isMsOrNull(value) {
  return value === null || isMs(value)
}

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
}

function signatureOf(normalized) {
  return createHash('sha256').update(stable(normalized)).digest('hex')
}

/**
 * Validate and freeze the watcher policy. SLA bounds are positive
 * millisecond counts; the defaults encode the standard playbook: respond
 * within 24h, fix red CI within 24h, one polite ping after 7 days of
 * maintainer silence.
 */
export function watcherPolicy(policy = {}) {
  requireValue(policy && typeof policy === 'object' && !Array.isArray(policy), 'watcher policy is required')
  const {
    responseSlaMs = 24 * 3_600_000,
    redCiSlaMs = 24 * 3_600_000,
    silencePingMs = 7 * 24 * 3_600_000,
  } = policy
  requireValue(isMs(responseSlaMs) && responseSlaMs > 0, 'responseSlaMs must be a positive millisecond count')
  requireValue(isMs(redCiSlaMs) && redCiSlaMs > 0, 'redCiSlaMs must be a positive millisecond count')
  requireValue(isMs(silencePingMs) && silencePingMs > 0, 'silencePingMs must be a positive millisecond count')
  return Object.freeze({ responseSlaMs, redCiSlaMs, silencePingMs })
}

function validateThread(thread) {
  requireValue(thread && typeof thread === 'object' && !Array.isArray(thread), 'thread is required')
  requireValue(typeof thread.id === 'string' && OPAQUE_ID.test(thread.id), 'thread id is invalid')
  requireValue(isMs(thread.createdAtMs), 'thread createdAtMs is invalid')
  requireValue(isMs(thread.updatedAtMs) && thread.updatedAtMs >= thread.createdAtMs, 'thread updatedAtMs is invalid')
  requireValue(typeof thread.bodyHash === 'string' && HEX.test(thread.bodyHash), 'thread bodyHash is invalid')
  requireValue(thread.resolved === false, 'only unresolved threads belong in the snapshot')
}

function validateComment(comment) {
  requireValue(comment && typeof comment === 'object' && !Array.isArray(comment), 'comment is required')
  requireValue(typeof comment.id === 'string' && OPAQUE_ID.test(comment.id), 'comment id is invalid')
  requireValue(typeof comment.authorKind === 'string' && AUTHOR_KINDS.includes(comment.authorKind),
    'comment authorKind is invalid')
  requireValue(isMs(comment.createdAtMs), 'comment createdAtMs is invalid')
  requireValue(isMs(comment.updatedAtMs) && comment.updatedAtMs >= comment.createdAtMs, 'comment updatedAtMs is invalid')
  requireValue(typeof comment.bodyHash === 'string' && HEX.test(comment.bodyHash), 'comment bodyHash is invalid')
}

function validateTracking(tracking) {
  requireValue(tracking && typeof tracking === 'object' && !Array.isArray(tracking), 'tracking entry is required')
  requireValue(typeof tracking.repository === 'string' && REPOSITORY.test(tracking.repository),
    'tracking repository is invalid')
  requireValue(Number.isSafeInteger(tracking.number) && tracking.number > 0, 'tracking PR number is invalid')
  requireValue(typeof tracking.issueId === 'string' && tracking.issueId.length > 0, 'tracking issueId is required')
  requireValue(typeof tracking.identifier === 'string' && tracking.identifier.length > 0,
    'tracking identifier is required')
  requireValue(typeof tracking.cardOpen === 'boolean', 'tracking cardOpen is required')
}

/**
 * Validate one compact collector read and freeze its normalized form. Throws
 * on malformed shape; transport problems travel as readOk:false (or partial /
 * rateLimited / short pages), which decide() maps to `unknown`, not silence.
 */
export function normalizeSnapshot(snapshot) {
  requireValue(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot), 'snapshot is required')
  requireValue(typeof snapshot.repository === 'string' && REPOSITORY.test(snapshot.repository),
    'snapshot repository is invalid')
  requireValue(Number.isSafeInteger(snapshot.number) && snapshot.number > 0, 'snapshot PR number is invalid')
  requireValue(typeof snapshot.state === 'string' && STATES.includes(snapshot.state), 'snapshot state is invalid')
  requireValue(typeof snapshot.merged === 'boolean', 'snapshot merged is required')
  requireValue(typeof snapshot.headSha === 'string' && SHA40.test(snapshot.headSha), 'snapshot headSha is invalid')
  const ci = snapshot.ci
  requireValue(ci && typeof ci === 'object' && !Array.isArray(ci), 'snapshot ci is required')
  requireValue(typeof ci.rollup === 'string' && CI_ROLLUPS.includes(ci.rollup), 'snapshot ci.rollup is invalid')
  requireValue(isMsOrNull(ci.sinceMs), 'snapshot ci.sinceMs is invalid')
  requireValue(typeof snapshot.mergeable === 'string' && MERGEABLES.includes(snapshot.mergeable),
    'snapshot mergeable is invalid')
  requireValue(typeof snapshot.reviewDecision === 'string' && REVIEWS.includes(snapshot.reviewDecision),
    'snapshot reviewDecision is invalid')
  requireValue(Array.isArray(snapshot.threads), 'snapshot threads must be an array')
  requireValue(Array.isArray(snapshot.comments), 'snapshot comments must be an array')
  snapshot.threads.forEach(validateThread)
  snapshot.comments.forEach(validateComment)
  requireValue(isMsOrNull(snapshot.lastOurResponseAtMs), 'snapshot lastOurResponseAtMs is invalid')
  requireValue(isMsOrNull(snapshot.lastMaintainerAtMs), 'snapshot lastMaintainerAtMs is invalid')
  requireValue(isMs(snapshot.fetchedAtMs), 'snapshot fetchedAtMs is invalid')
  requireValue(typeof snapshot.readOk === 'boolean', 'snapshot readOk is required')
  const partial = snapshot.partial === true
  const rateLimited = snapshot.rateLimited === true
  const pages = snapshot.pages
  if (pages !== undefined) {
    requireValue(pages && typeof pages === 'object' && !Array.isArray(pages), 'snapshot pages is invalid')
    requireValue(Number.isSafeInteger(pages.fetched) && pages.fetched >= 0, 'snapshot pages.fetched is invalid')
    requireValue(pages.total === null || (Number.isSafeInteger(pages.total) && pages.total >= 0),
      'snapshot pages.total is invalid')
  }
  const threads = snapshot.threads
    .map((thread) => Object.freeze({ ...thread }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const comments = snapshot.comments
    .map((comment) => Object.freeze({ ...comment }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const normalized = Object.freeze({
    repository: snapshot.repository,
    number: snapshot.number,
    state: snapshot.state,
    merged: snapshot.merged,
    headSha: snapshot.headSha,
    ci: Object.freeze({ rollup: ci.rollup, sinceMs: ci.sinceMs }),
    mergeable: snapshot.mergeable,
    reviewDecision: snapshot.reviewDecision,
    threads: Object.freeze(threads),
    comments: Object.freeze(comments),
    lastOurResponseAtMs: snapshot.lastOurResponseAtMs,
    lastMaintainerAtMs: snapshot.lastMaintainerAtMs,
    fetchedAtMs: snapshot.fetchedAtMs,
    readOk: snapshot.readOk,
    partial,
    rateLimited,
    pages: pages === undefined ? null : Object.freeze({ fetched: pages.fetched, total: pages.total }),
  })
  // fetchedAtMs is read metadata, not PR state: two reads of an unchanged PR
  // must share one signature, or every 15-minute tick would look like change.
  const { fetchedAtMs: _readAt, ...stablePart } = normalized
  return { snapshot: normalized, signature: signatureOf(stablePart) }
}

function validateAck(ack) {
  requireValue(ack && typeof ack === 'object' && !Array.isArray(ack), 'ack is required')
  requireValue(typeof ack.signature === 'string' && HEX.test(ack.signature), 'ack signature is invalid')
  requireValue(ack.snapshot && typeof ack.snapshot === 'object', 'ack snapshot is required')
  const sla = ack.sla
  requireValue(sla && typeof sla === 'object' && !Array.isArray(sla), 'ack sla is required')
  requireValue(['ok', 'breached'].includes(sla.response), 'ack sla.response is invalid')
  requireValue(['ok', 'breached'].includes(sla.redCi), 'ack sla.redCi is invalid')
  requireValue(['pending', 'sent'].includes(sla.ping), 'ack sla.ping is invalid')
  requireValue(typeof ack.closedSeen === 'boolean', 'ack closedSeen is required')
  // Latched one-shot state: once delivered, the next tick must not re-emit
  // the same transition. An ack that predates a latched digest (lost persist
  // racing a writer-applied delivery) still converges: the live card carries
  // the writer marker, and the latch below refuses the duplicate.
  requireValue(typeof ack.reopenReported === 'boolean', 'ack reopenReported is required')
  requireValue(isMs(ack.firstSeenMs), 'ack firstSeenMs is invalid')
}

/**
 * The writer marker a delivered digest leaves on the tracking task. The
 * writer posts `Recovery decision \`recovery-writer:<fp>\`` per applied
 * `operator_decision` proposal, where fp mirrors
 * recovery_writer.Decision.fingerprint: sha256 over the canonical
 * {issueId, reason, mutation, targetAgentId, sourceId} JSON, first 24 hex.
 * renderWriterProposal binds every field from the digest, so the marker is
 * a pure function of the digest. If the writer scheme ever changes, the
 * pinned cross-language vector in the suite fails loudly.
 */
export function writerMarkerForDigest(digest) {
  requireValue(digest && digest.action === 'digest', 'digest is required')
  const proposal = renderWriterProposal(digest)
  const material = stable({
    issueId: proposal.issueId,
    reason: proposal.reason,
    mutation: proposal.mutation,
    targetAgentId: null,
    sourceId: proposal.sourceId,
  })
  return `recovery-writer:${createHash('sha256').update(material).digest('hex').slice(0, 24)}`
}

/**
 * Live-card guard against ack-loss duplicates. The caller passes the writer
 * markers already on the tracking task (`recovery-writer:<fp>` strings from
 * its comments); a hit on this digest's expected marker means the delivery
 * already landed and the lost ack must latch forward, not re-emit.
 *
 * @param {string[]} cardMarkers  writer markers already on the tracking task.
 * @param {object} digest  the digest that would be emitted.
 */
export function duplicateDelivered(cardMarkers, digest) {
  requireValue(Array.isArray(cardMarkers), 'cardMarkers must be an array')
  requireValue(digest && digest.action === 'digest', 'digest is required')
  const expected = writerMarkerForDigest(digest)
  return cardMarkers.some((marker) => typeof marker === 'string' && marker.includes(expected))
}

function diffSnapshots(prev, next) {
  const changes = []
  if (next.state !== prev.state || next.merged !== prev.merged) {
    changes.push({ kind: next.state === 'closed' ? 'closed' : 'reopened', detail: `state:${prev.state}->${next.state}` })
    // A close is one change, not a cascade: head/CI/review deltas on a
    // closed PR are retirement bookkeeping, already covered by `closed`.
    if (next.state === 'closed') return { changes, closed: true }
  }
  if (next.headSha !== prev.headSha) changes.push({ kind: 'head', detail: `head:${prev.headSha.slice(0, 12)}->${next.headSha.slice(0, 12)}` })
  if (next.ci.rollup !== prev.ci.rollup) {
    changes.push({ kind: 'ci', detail: `ci:${prev.ci.rollup}->${next.ci.rollup}` })
  }
  if (next.mergeable !== prev.mergeable) {
    changes.push({ kind: 'mergeable', detail: `mergeable:${prev.mergeable}->${next.mergeable}` })
  }
  if (next.reviewDecision !== prev.reviewDecision) {
    changes.push({ kind: 'review', detail: `review:${prev.reviewDecision}->${next.reviewDecision}` })
  }
  const prevThreads = new Map(prev.threads.map((thread) => [thread.id, thread]))
  const nextThreads = new Map(next.threads.map((thread) => [thread.id, thread]))
  for (const [id, thread] of nextThreads) {
    const before = prevThreads.get(id)
    if (!before) changes.push({ kind: 'thread-opened', detail: `thread:${id}` })
    else if (before.bodyHash !== thread.bodyHash || before.updatedAtMs !== thread.updatedAtMs) {
      changes.push({ kind: 'thread-updated', detail: `thread:${id}` })
    }
  }
  for (const id of prevThreads.keys()) {
    if (!nextThreads.has(id)) changes.push({ kind: 'thread-resolved', detail: `thread:${id}` })
  }
  const prevComments = new Map(prev.comments.map((comment) => [comment.id, comment]))
  const nextComments = new Map(next.comments.map((comment) => [comment.id, comment]))
  for (const [id, comment] of nextComments) {
    const before = prevComments.get(id)
    if (!before) changes.push({ kind: 'comment', detail: `comment:${id}` })
    else if (before.bodyHash !== comment.bodyHash || before.updatedAtMs !== comment.updatedAtMs) {
      changes.push({ kind: 'comment-edited', detail: `comment:${id}` })
    }
  }
  for (const change of changes) {
    requireValue(CHANGE_KINDS.includes(change.kind), 'change kind is unknown')
  }
  return { changes, closed: false }
}

function slaTransitions(prevAck, next, policy, nowMs) {
  const transitions = []
  const answeredAfter = (atMs) => next.lastOurResponseAtMs !== null && next.lastOurResponseAtMs >= atMs
  const oldestUnanswered = next.threads
    .filter((thread) => !answeredAfter(thread.createdAtMs))
    .map((thread) => thread.createdAtMs)
    .sort((a, b) => a - b)[0]
  if (oldestUnanswered !== undefined
    && nowMs - oldestUnanswered > policy.responseSlaMs
    && prevAck.sla.response !== 'breached') {
    transitions.push({ kind: 'sla-response-breach', detail: `unanswered-since:${oldestUnanswered}` })
  }
  if (next.ci.rollup === 'red' && next.ci.sinceMs !== null
    && nowMs - next.ci.sinceMs > policy.redCiSlaMs
    && prevAck.sla.redCi !== 'breached') {
    transitions.push({ kind: 'sla-redci-breach', detail: `red-since:${next.ci.sinceMs}` })
  }
  if (next.lastMaintainerAtMs !== null
    && nowMs - next.lastMaintainerAtMs > policy.silencePingMs
    && prevAck.sla.ping !== 'sent') {
    transitions.push({ kind: 'sla-ping-eligible', detail: `silent-since:${next.lastMaintainerAtMs}` })
  }
  return transitions
}

/**
 * @param {object|null} prev  persisted ack for this PR, or null on first sight.
 * @param {object} nextRaw  one compact collector read.
 * @param {object} tracking  canonical tracking task ({ repository, number,
 *   issueId, identifier, cardOpen }). No tracking entry means the orphan
 *   intake owns creation — the watcher never mints a task.
 * @param {object} policy  watcherPolicy() value.
 * @param {number} nowMs  collector clock.
 * @param {string[]} cardMarkers  writer markers already on the tracking
 *   task (default []). Consulted only for latched one-shots; a hit means
 *   the delivery already landed and the digest is swallowed to a latch
 *   advance (zero wakes), never re-emitted.
 * @returns exactly one of:
 *   { action:'silent' } — unchanged: zero wakes, ack untouched.
 *   { action:'baseline', nextAck } — first sight: persist, zero wakes.
 *   { action:'unknown', detail } — failed/rate-limited/partial read: zero
 *     wakes, ack untouched, back off and retry; never a close.
 *   { action:'untracked', repository, number } — no canonical task:
 *     diagnostic for the orphan intake; zero wakes.
 *   { action:'digest', dedupeKey, repository, number, issueId, identifier,
 *     changes, reopen, nextAck } — exactly one digest. Persist nextAck only
 *     after durable delivery to the writer; a retry with the same prev
 *     yields the identical digest.
 *   { action:'latched', nextAck } — the digest already landed on the card
 *     (marker hit): zero wakes, persist nextAck to converge the lost ack.
 */
export function decideUpstreamWatch({ prev, next: nextRaw, tracking, policy, nowMs, cardMarkers = [] }) {
  requireValue(Array.isArray(cardMarkers), 'cardMarkers must be an array')
  requireValue(isMs(nowMs), 'nowMs is invalid')
  const p = watcherPolicy(policy ?? {})
  const { snapshot: next, signature: nextSignature } = normalizeSnapshot(nextRaw)

  if (next.readOk !== true || next.rateLimited || next.partial
    || (next.pages !== null && next.pages.total !== null && next.pages.fetched < next.pages.total)) {
    return {
      action: 'unknown',
      repository: next.repository,
      number: next.number,
      detail: next.rateLimited ? 'rate-limited'
        : !next.readOk ? 'read-failed'
          : 'partial-page',
    }
  }

  if (tracking === null || tracking === undefined) {
    return { action: 'untracked', repository: next.repository, number: next.number }
  }
  validateTracking(tracking)
  requireValue(tracking.repository === next.repository && tracking.number === next.number,
    'tracking entry does not match the snapshot PR')

  if (prev === null || prev === undefined) {
    return {
      action: 'baseline',
      repository: next.repository,
      number: next.number,
      nextAck: Object.freeze({
        signature: nextSignature,
        snapshot: next,
        sla: Object.freeze({ response: 'ok', redCi: 'ok', ping: 'pending' }),
        closedSeen: next.state === 'closed',
        reopenReported: false,
        firstSeenMs: nowMs,
      }),
    }
  }
  validateAck(prev)

  const { changes, closed } = diffSnapshots(prev.snapshot, next)
  const transitions = next.state === 'open' ? slaTransitions(prev, next, p, nowMs) : []
  // Latched one-shot: a reopen-mismatch reports once. While the card stays
  // closed the digest would otherwise re-emit byte-identically every tick,
  // and the writer posts one comment per proposal — a second identical
  // board comment for zero new information.
  const reopen = tracking.cardOpen === false && next.state === 'open' && !prev.reopenReported
  if (reopen) changes.push({ kind: 'reopen-mismatch', detail: 'closed-card-open-pr' })

  // A retired close stays silent: the merge already produced its digest,
  // and fork-delta retirement owns what follows.
  if (changes.length === 0 && transitions.length === 0) return { action: 'silent' }
  if (closed && prev.closedSeen) return { action: 'silent' }

  const allChanges = [...changes, ...transitions]
  const sla = {
    response: prev.sla.response === 'breached' || transitions.some((change) => change.kind === 'sla-response-breach')
      ? 'breached' : 'ok',
    redCi: prev.sla.redCi === 'breached' || transitions.some((change) => change.kind === 'sla-redci-breach')
      ? 'breached' : 'ok',
    ping: prev.sla.ping === 'sent' || transitions.some((change) => change.kind === 'sla-ping-eligible')
      ? 'sent' : 'pending',
  }
  // The digest identity folds the one-shot outcomes in: an SLA-only tick
  // after ack-loss can no longer re-emit the same digest, because the
  // latched sla markers distinguish "about to breach" from "breached".
  const digestSignature = signatureOf({
    next: nextSignature,
    changes: allChanges.map((change) => change.kind),
    sla,
    reopenReported: prev.reopenReported || reopen,
  })
  const digest = {
    action: 'digest',
    // Stable per resulting state: a duplicate retry yields the identical
    // digest, so the writer claim dedupes it to one wake.
    dedupeKey: `upstream-digest:${next.repository}#${next.number}:${digestSignature.slice(0, 16)}`,
    repository: next.repository,
    number: next.number,
    issueId: tracking.issueId,
    identifier: tracking.identifier,
    changes: Object.freeze(allChanges.map((change) => Object.freeze({ ...change }))),
    reopen,
    nextAck: Object.freeze({
      signature: nextSignature,
      snapshot: next,
      sla: Object.freeze(sla),
      closedSeen: prev.closedSeen || closed,
      reopenReported: prev.reopenReported || reopen,
      firstSeenMs: prev.firstSeenMs,
    }),
  }
  // Ack-loss convergence: the ack persist raced a delivered writer comment.
  // The card already carries this digest's marker, so re-emitting would post
  // a second identical comment. Swallow to a latch advance: zero wakes, and
  // persisting nextAck converges the lost ack so the tick after stays silent.
  if (duplicateDelivered(cardMarkers, digest)) {
    return {
      action: 'latched',
      repository: next.repository,
      number: next.number,
      swallowed: digest.dedupeKey,
      nextAck: digest.nextAck,
    }
  }
  return digest
}

/**
 * Render one writer-compatible proposal for a digest. The mutation is the
 * existing `operator_decision` verb: the writer posts the digest to the
 * canonical tracking task, which updates/wakes it. Fixed words plus the
 * validated repository, number and change kinds only — never upstream text.
 */
export function renderWriterProposal(digest) {
  requireValue(digest && digest.action === 'digest', 'digest is required')
  requireValue(typeof digest.issueId === 'string' && digest.issueId.length > 0, 'digest issueId is required')
  requireValue(typeof digest.identifier === 'string' && digest.identifier.length > 0, 'digest identifier is required')
  requireValue(typeof digest.dedupeKey === 'string' && digest.dedupeKey.length > 0, 'digest dedupeKey is required')
  requireValue(Array.isArray(digest.changes) && digest.changes.length > 0, 'digest changes are required')
  for (const change of digest.changes) {
    requireValue(change && CHANGE_KINDS.includes(change.kind), 'digest change kind is unknown')
    requireValue(typeof change.detail === 'string' && change.detail.length > 0, 'digest change detail is required')
  }
  const kinds = digest.changes.map((change) => change.kind).join(',')
  return Object.freeze({
    detector: 'watcher/upstream',
    reason: 'upstream-change',
    mutation: WRITER_MUTATION,
    issueId: digest.issueId,
    identifier: digest.identifier,
    sourceId: digest.dedupeKey,
    before: Object.freeze({ repository: digest.repository, number: digest.number }),
    after: Object.freeze({ repository: digest.repository, number: digest.number, changes: kinds }),
    note: `Upstream ${digest.repository}#${digest.number} changed (${kinds}).`
      + (digest.reopen ? ' Tracking card is closed while the PR is open: reconcile, do not duplicate.' : ''),
  })
}

/**
 * Render one watchdog snapshot section row per tracked PR: open count, age,
 * response latency, unresolved threads and red CI. The watchdog detectors
 * threshold these; this function only measures, in fixed
 * vocabulary, from already-validated snapshots.
 */
export function renderWatchdogSection(entries, nowMs) {
  requireValue(isMs(nowMs), 'nowMs is invalid')
  requireValue(Array.isArray(entries), 'entries must be an array')
  return Object.freeze(entries.map((entry) => {
    const { snapshot } = normalizeSnapshot(entry.snapshot)
    const openedMs = entry.openedMs
    requireValue(isMs(openedMs) && openedMs <= nowMs, 'entry openedMs is invalid')
    const awaitingSinceMs = snapshot.threads
      .filter((thread) => snapshot.lastOurResponseAtMs === null || snapshot.lastOurResponseAtMs < thread.createdAtMs)
      .map((thread) => thread.createdAtMs)
      .sort((a, b) => a - b)[0] ?? null
    return Object.freeze({
      repo: snapshot.repository,
      number: snapshot.number,
      state: snapshot.state,
      merged: snapshot.merged,
      ageMin: Math.round((nowMs - openedMs) / 60_000),
      ciRollup: snapshot.ci.rollup,
      redCiMin: snapshot.ci.rollup === 'red' && snapshot.ci.sinceMs !== null
        ? Math.round((nowMs - snapshot.ci.sinceMs) / 60_000) : null,
      reviewDecision: snapshot.reviewDecision,
      unresolvedThreads: snapshot.threads.length,
      awaitingResponseMin: awaitingSinceMs !== null ? Math.round((nowMs - awaitingSinceMs) / 60_000) : null,
      pingSent: entry.pingSent === true,
    })
  }))
}
