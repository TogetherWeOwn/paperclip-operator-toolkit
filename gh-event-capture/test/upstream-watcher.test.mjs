// network, no board credentials. Every test pins either exactly one digest,
// or — just as important — silence or unknown where a wake must not happen.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  watcherPolicy, normalizeSnapshot, decideUpstreamWatch,
  renderWriterProposal, renderWatchdogSection,
  writerMarkerForDigest, duplicateDelivered,
} from '../src/upstream-watcher.js'

const T0 = 1_758_000_000_000 // 2026-09-12T00:00:00Z
const HOUR = 3_600_000
const HEAD_A = 'a'.repeat(40)
const HEAD_B = 'b'.repeat(40)
const HASH_A = 'aa'.repeat(16)
const HASH_B = 'bb'.repeat(16)

const TRACKING = Object.freeze({
  repository: 'example-upstream/project',
  number: 42,
  issueId: 'task-upstream-1',
  identifier: 'TASK-7',
  cardOpen: true,
})

function snapshot(overrides = {}) {
  return {
    repository: 'example-upstream/project',
    number: 42,
    state: 'open',
    merged: false,
    headSha: HEAD_A,
    ci: { rollup: 'green', sinceMs: null },
    mergeable: 'mergeable',
    reviewDecision: 'review_required',
    threads: [],
    comments: [],
    lastOurResponseAtMs: null,
    lastMaintainerAtMs: T0 - HOUR,
    fetchedAtMs: T0,
    readOk: true,
    ...overrides,
  }
}

function thread(overrides = {}) {
  return {
    id: 'thread-1', createdAtMs: T0 - 2 * HOUR, updatedAtMs: T0 - 2 * HOUR, bodyHash: HASH_A,
    resolved: false, ...overrides,
  }
}

function comment(overrides = {}) {
  return {
    id: 'comment-1', authorKind: 'human', createdAtMs: T0 - 2 * HOUR, updatedAtMs: T0 - 2 * HOUR,
    bodyHash: HASH_A, ...overrides,
  }
}

const decide = (args) => decideUpstreamWatch({ tracking: TRACKING, policy: {}, nowMs: T0, ...args })

function baselineAck(nextOverrides = {}, tracking = TRACKING, nowMs = T0) {
  const first = decide({ prev: null, next: snapshot(nextOverrides), tracking, nowMs })
  assert.equal(first.action, 'baseline')
  return first.nextAck
}

// --- silence and first sight -------------------------------------------------

test('an unchanged snapshot is silent: zero wakes, ack untouched', () => {
  const ack = baselineAck()
  const again = decide({ prev: ack, next: snapshot() })
  assert.equal(again.action, 'silent')
})

test('first sight persists a baseline with zero wakes', () => {
  const first = decide({ prev: null, next: snapshot() })
  assert.equal(first.action, 'baseline')
  assert.equal(first.nextAck.sla.response, 'ok')
  assert.equal(first.nextAck.closedSeen, false)
  assert.ok(first.nextAck.signature)
})

test('a malformed snapshot throws instead of resolving to nothing to do', () => {
  assert.throws(() => decide({ prev: null, next: snapshot({ headSha: 'zzz' }) }), /headSha/)
  assert.throws(() => decide({ prev: null, next: snapshot({ threads: [{ id: 'x' }] }) }), /thread/)
})

// --- one changed field -> one precise digest ---------------------------------

test('a new head produces exactly one digest with the head change', () => {
  const ack = baselineAck()
  const out = decide({ prev: ack, next: snapshot({ headSha: HEAD_B }) })
  assert.equal(out.action, 'digest')
  assert.deepEqual(out.changes.map((change) => change.kind), ['head'])
  assert.equal(out.issueId, 'task-upstream-1')
  assert.equal(out.identifier, 'TASK-7')
  assert.ok(out.dedupeKey.startsWith('upstream-digest:example-upstream/project#42:'))
})

test('CI, review and mergeable flips each produce one precise digest', () => {
  const ack = baselineAck({ ci: { rollup: 'green', sinceMs: null } })
  for (const [field, value, kind] of [
    ['ci', { rollup: 'red', sinceMs: T0 - HOUR }, 'ci'],
    ['reviewDecision', 'approved', 'review'],
    ['mergeable', 'conflicting', 'mergeable'],
  ]) {
    const out = decide({ prev: ack, next: snapshot({ [field]: value }) })
    assert.equal(out.action, 'digest', field)
    assert.deepEqual(out.changes.map((change) => change.kind), [kind], field)
  }
})

test('thread open, update and resolve each produce one precise digest', () => {
  const ack = baselineAck()
  const opened = decide({ prev: ack, next: snapshot({ threads: [thread()] }) })
  assert.deepEqual(opened.changes.map((change) => change.kind), ['thread-opened'])

  const ack2 = opened.nextAck
  const updated = decide({ prev: ack2, next: snapshot({ threads: [thread({ bodyHash: HASH_B, updatedAtMs: T0 })] }) })
  assert.deepEqual(updated.changes.map((change) => change.kind), ['thread-updated'])

  const resolved = decide({ prev: updated.nextAck, next: snapshot({ threads: [] }) })
  assert.deepEqual(resolved.changes.map((change) => change.kind), ['thread-resolved'])
})

test('a new comment and an edited comment each produce one precise digest', () => {
  const ack = baselineAck()
  const added = decide({ prev: ack, next: snapshot({ comments: [comment()] }) })
  assert.deepEqual(added.changes.map((change) => change.kind), ['comment'])

  const edited = decide({
    prev: added.nextAck,
    next: snapshot({ comments: [comment({ bodyHash: HASH_B, updatedAtMs: T0 })] }),
  })
  assert.deepEqual(edited.changes.map((change) => change.kind), ['comment-edited'])
})

// --- idempotent retry: duplicate deliveries wake once ------------------------

test('a duplicate retry yields the identical digest', () => {
  const ack = baselineAck()
  const first = decide({ prev: ack, next: snapshot({ headSha: HEAD_B }) })
  const retry = decide({ prev: ack, next: snapshot({ headSha: HEAD_B }) })
  assert.deepEqual(retry, first)
})

test('an unpersisted ack retries to the same digest after a delivery failure', () => {
  const ack = baselineAck()
  const lost = decide({ prev: ack, next: snapshot({ threads: [thread()] }) })
  assert.equal(lost.action, 'digest')
  // caller failed to persist lost.nextAck; the retry still sees the old ack
  const retry = decide({ prev: ack, next: snapshot({ threads: [thread()] }) })
  assert.deepEqual(retry, lost)
})

// --- unknown is never silence and never a close -------------------------------

test('failed, rate-limited and partial reads are unknown, never silent', () => {
  const ack = baselineAck()
  for (const broken of [
    { readOk: false },
    { rateLimited: true },
    { partial: true },
    { pages: { fetched: 1, total: 3 } },
  ]) {
    const out = decide({ prev: ack, next: snapshot(broken) })
    assert.equal(out.action, 'unknown', JSON.stringify(broken))
  }
})

test('a complete multi-page read is decided normally', () => {
  const ack = baselineAck()
  const out = decide({ prev: ack, next: snapshot({ pages: { fetched: 3, total: 3 }, headSha: HEAD_B }) })
  assert.equal(out.action, 'digest')
})

test('an unknown CI rollup is a signal change, not a silent green', () => {
  const ack = baselineAck()
  const out = decide({ prev: ack, next: snapshot({ ci: { rollup: 'unknown', sinceMs: null } }) })
  assert.equal(out.action, 'digest')
  assert.deepEqual(out.changes.map((change) => change.kind), ['ci'])
})

test('an unknown read of a closing PR never reports the close', () => {
  const ack = baselineAck()
  const out = decide({ prev: ack, next: snapshot({ state: 'closed', merged: true, readOk: false }) })
  assert.equal(out.action, 'unknown')
})

// --- one-shot SLA crossings ----------------------------------------------------

test('a 24h unanswered thread breaches once, then stays silent', () => {
  const ack = baselineAck({ threads: [thread({ createdAtMs: T0 - 25 * HOUR, updatedAtMs: T0 - 25 * HOUR })] })
  // baseline itself is silent even though the thread is already stale: the
  // breach fires on the first re-observation, exactly once.
  const breach = decide({
    prev: ack,
    next: snapshot({ threads: [thread({ createdAtMs: T0 - 25 * HOUR, updatedAtMs: T0 - 25 * HOUR })] }),
  })
  assert.equal(breach.action, 'digest')
  assert.deepEqual(breach.changes.map((change) => change.kind), ['sla-response-breach'])

  const settled = decide({ prev: breach.nextAck, next: snapshot({ threads: [thread({ createdAtMs: T0 - 25 * HOUR, updatedAtMs: T0 - 25 * HOUR })] }) })
  assert.equal(settled.action, 'silent')
})

test('our reply after the thread resets the unanswered clock', () => {
  const ack = baselineAck({ threads: [thread({ createdAtMs: T0 - 25 * HOUR, updatedAtMs: T0 - 25 * HOUR })] })
  const answered = decide({
    prev: ack,
    next: snapshot({
      threads: [thread({ createdAtMs: T0 - 25 * HOUR, updatedAtMs: T0 - 25 * HOUR })],
      lastOurResponseAtMs: T0 - HOUR,
    }),
  })
  assert.equal(answered.action, 'silent')
})

test('red CI past 24h breaches once, then stays silent', () => {
  const ack = baselineAck()
  const breach = decide({
    prev: ack, next: snapshot({ ci: { rollup: 'red', sinceMs: T0 - 25 * HOUR } }),
  })
  assert.equal(breach.action, 'digest')
  assert.ok(breach.changes.map((change) => change.kind).includes('sla-redci-breach'))

  const settled = decide({
    prev: breach.nextAck, next: snapshot({ ci: { rollup: 'red', sinceMs: T0 - 26 * HOUR } }),
  })
  assert.equal(settled.action, 'silent')
})

test('seven days of maintainer silence yields one ping eligibility, never spam', () => {
  const ack = baselineAck({ lastMaintainerAtMs: T0 - 8 * 24 * HOUR })
  const ping = decide({ prev: ack, next: snapshot({ lastMaintainerAtMs: T0 - 8 * 24 * HOUR }) })
  assert.equal(ping.action, 'digest')
  assert.deepEqual(ping.changes.map((change) => change.kind), ['sla-ping-eligible'])

  const settled = decide({
    prev: ping.nextAck, next: snapshot({ lastMaintainerAtMs: T0 - 9 * 24 * HOUR }),
  })
  assert.equal(settled.action, 'silent')
})

// --- tracking reuse and closed-card/open-PR reconciliation --------------------

test('the digest reuses the canonical tracking task', () => {
  const ack = baselineAck()
  const out = decide({ prev: ack, next: snapshot({ headSha: HEAD_B }) })
  assert.equal(out.issueId, TRACKING.issueId)
  assert.equal(out.identifier, TRACKING.identifier)
})

test('a closed card with an open PR reconciles the mismatch without duplicating', () => {
  const closed = { ...TRACKING, cardOpen: false }
  const ack = baselineAck({}, closed)
  const out = decide({ prev: ack, next: snapshot(), tracking: closed })
  assert.equal(out.action, 'digest')
  assert.equal(out.reopen, true)
  assert.deepEqual(out.changes.map((change) => change.kind), ['reopen-mismatch'])
  assert.equal(out.issueId, TRACKING.issueId)
})

test('the reopen latch fires once: the latched tick stays silent', () => {
  const closed = { ...TRACKING, cardOpen: false }
  const ack = baselineAck({}, closed)
  const first = decide({ prev: ack, next: snapshot(), tracking: closed })
  assert.equal(first.action, 'digest')

  // Persisted ack: the latch holds, no second digest, no marker needed.
  const settled = decide({ prev: first.nextAck, next: snapshot(), tracking: closed })
  assert.equal(settled.action, 'silent')

  // Lost ack WITHOUT a card marker is a plain retry: identical digest, so
  // the writer claim still dedupes it to one wake rather than inventing
  // a new one.
  const retry = decide({ prev: ack, next: snapshot(), tracking: closed })
  assert.deepEqual({ ...retry, nextAck: null }, { ...first, nextAck: null })

  // Lost ack WITH the delivered marker converges: latched, zero wakes, and
  // persisting the latched ack keeps the tick after silent.
  const marker = writerMarkerForDigest(first)
  assert.equal(duplicateDelivered([`Recovery decision \`${marker}\`.`], first), true)
  assert.equal(duplicateDelivered([], first), false)
  const converged = decide({ prev: ack, next: snapshot(), tracking: closed, cardMarkers: [marker] })
  assert.equal(converged.action, 'latched')
  assert.equal(converged.swallowed, first.dedupeKey)
  const after = decide({ prev: converged.nextAck, next: snapshot(), tracking: closed })
  assert.equal(after.action, 'silent')
})

test('an SLA-only tick after ack-loss converges on the marker, not a second comment', () => {
  const stale = { threads: [thread({ createdAtMs: T0 - 25 * HOUR, updatedAtMs: T0 - 25 * HOUR })] }
  const ack = baselineAck(stale)
  const breach = decide({ prev: ack, next: snapshot(stale) })
  assert.equal(breach.action, 'digest')
  assert.deepEqual(breach.changes.map((change) => change.kind), ['sla-response-breach'])

  // The ack persist raced the delivered writer comment. The retry must not
  // re-emit: the marker proves delivery landed.
  const marker = writerMarkerForDigest(breach)
  const retry = decide({ prev: ack, next: snapshot(stale), cardMarkers: [marker] })
  assert.equal(retry.action, 'latched')
  assert.equal(retry.nextAck.sla.response, 'breached')

  // ...and the converged ack stays silent afterwards: one breach, one wake.
  const settled = decide({ prev: retry.nextAck, next: snapshot(stale) })
  assert.equal(settled.action, 'silent')
})

test('the writer marker byte-matches the recovery-writer fingerprint scheme', () => {
  // Cross-language pin: this exact marker was computed independently with
  // Python hashlib over the writer's canonical JSON
  // (sort_keys, separators) for the head-change digest of PR #42.
  // If recovery_writer.Decision.fingerprint changes, this fails loudly.
  const ack = baselineAck()
  const digest = decide({ prev: ack, next: snapshot({ headSha: HEAD_B }) })
  assert.equal(digest.dedupeKey, 'upstream-digest:example-upstream/project#42:49c997be2c0c7a30')
  assert.equal(writerMarkerForDigest(digest), 'recovery-writer:054eb6f55b861af7a883f073')
})

test('a PR with no tracking task is untracked: the orphan intake owns creation', () => {
  const ack = baselineAck()
  const out = decide({ prev: ack, next: snapshot(), tracking: null })
  assert.equal(out.action, 'untracked')
})

test('an upstream merge produces one close digest, then retires silent', () => {
  const ack = baselineAck()
  const merged = decide({ prev: ack, next: snapshot({ state: 'closed', merged: true }) })
  assert.equal(merged.action, 'digest')
  assert.deepEqual(merged.changes.map((change) => change.kind), ['closed'])
  assert.equal(merged.nextAck.closedSeen, true)

  const retired = decide({ prev: merged.nextAck, next: snapshot({ state: 'closed', merged: true }) })
  assert.equal(retired.action, 'silent')
})

// --- writer proposal and watchdog section ---------------------------------------

test('the writer proposal uses the existing operator_decision verb', () => {
  const ack = baselineAck()
  const digest = decide({ prev: ack, next: snapshot({ headSha: HEAD_B }) })
  const proposal = renderWriterProposal(digest)
  assert.equal(proposal.detector, 'watcher/upstream')
  assert.equal(proposal.mutation, 'operator_decision')
  assert.equal(proposal.issueId, TRACKING.issueId)
  assert.equal(proposal.sourceId, digest.dedupeKey)
  assert.match(proposal.note, /example-upstream\/project#42/)
  // never upstream text: fixed words, validated repo#number, change kinds
  assert.match(proposal.note, /\(head\)/)
})

test('the watchdog section exposes age, latency, threads and red CI', () => {
  const rows = renderWatchdogSection([{
    openedMs: T0 - 3 * 24 * HOUR,
    pingSent: false,
    snapshot: snapshot({
      threads: [thread({ createdAtMs: T0 - 25 * HOUR, updatedAtMs: T0 - 25 * HOUR })],
      ci: { rollup: 'red', sinceMs: T0 - 2 * HOUR },
    }),
  }], T0)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].ageMin, 3 * 24 * 60)
  assert.equal(rows[0].unresolvedThreads, 1)
  assert.equal(rows[0].awaitingResponseMin, 25 * 60)
  assert.equal(rows[0].redCiMin, 120)
  assert.equal(rows[0].ciRollup, 'red')
})

test('policy bounds are validated loudly', () => {
  assert.throws(() => watcherPolicy({ responseSlaMs: -1 }), /responseSlaMs/)
  assert.throws(() => watcherPolicy({ silencePingMs: 0 }), /silencePingMs/)
  const defaults = watcherPolicy()
  assert.equal(defaults.responseSlaMs, 24 * HOUR)
  assert.equal(defaults.silencePingMs, 7 * 24 * HOUR)
})
