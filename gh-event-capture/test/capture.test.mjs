// gh-event-capture offline suite.
//
// No credentials, no network, no Cloudflare account, no D1. Everything runs
// against the in-memory store, which mirrors the D1 adapter's observable
// semantics. `node --test`, nothing installed.
//
// The assertions pin STATUS CODES and BEHAVIOUR — whether a row reached the
// store, whether a second identical delivery created a second row — never
// human-readable message text, which drifts and takes the suite with it.
//
// Weakening any assertion in the first section weakens the only thing standing
// between a public URL and a store of forged rows. Read README § 1 first.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createApp } from '../src/app.js'
import { createMemoryStore } from '../src/store-memory.js'
import { verifySignature, REJECT, sha256Hex } from '../src/verify.js'
import { buildRecord, MAX_STORED_BODY_BYTES } from '../src/record.js'
import { parseQuery, MAX_LIMIT } from '../src/query.js'
import { seedClaim } from './bridge-fixtures.mjs'

const SECRET = 'test-webhook-secret-not-a-real-one'
const QUERY_TOKEN = 'test-query-token-not-a-real-one'
const URL_BASE = 'https://gh-event-capture.example.workers.dev'

// A fixed clock, so `received_at` is asserted against a literal rather than
// against a value recomputed the same wrong way as the code under test.
const T0 = Date.parse('2026-08-24T00:00:00.000Z')

/**
 * Sign a body the way GitHub does. Independent of `verify.js`'s comparison path
 * on purpose — if both sides shared a helper, a bug in the helper would verify
 * itself.
 */
async function sign(secret, body) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  let hex = ''
  for (const b of mac) hex += b.toString(16).padStart(2, '0')
  return `sha256=${hex}`
}

function harness({ webhookSecret = SECRET, queryToken = QUERY_TOKEN, now, rejectionFlushMs } = {}) {
  const store = createMemoryStore()
  const app = createApp({ store, webhookSecret, queryToken, now, rejectionFlushMs })
  return { store, app }
}

/** Build a webhook POST. Pass `signature: null` to send none at all. */
async function delivery(body, { event = 'push', id = 'd-1', signature = undefined, secret = SECRET } = {}) {
  const headers = new Headers({
    'content-type': 'application/json',
    'x-github-event': event,
    'x-github-delivery': id,
    'x-github-hook-id': '1234',
    'x-github-hook-installation-target-type': 'integration',
    'user-agent': 'GitHub-Hookshot/abc123',
  })
  const sig = signature === undefined ? await sign(secret, body) : signature
  if (sig !== null) headers.set('x-hub-signature-256', sig)
  return new Request(`${URL_BASE}/gh/webhook`, { method: 'POST', headers, body })
}

function pushPayload(overrides = {}) {
  return JSON.stringify({
    ref: 'refs/heads/main',
    repository: { full_name: 'ExampleOrg/example-repo' },
    organization: { login: 'ExampleOrg' },
    sender: { login: 'human-reviewer' },
    installation: { id: 155772577 },
    ...overrides,
  })
}

function read(path, token = QUERY_TOKEN) {
  const headers = token === null ? {} : { authorization: `Bearer ${token}` }
  return new Request(`${URL_BASE}${path}`, { headers })
}

// ---------------------------------------------------------------------------
// The property the whole control rests on: an unsigned payload is rejected.
// ---------------------------------------------------------------------------

test('an UNSIGNED delivery is rejected with 401 and stores nothing', async () => {
  const { store, app } = harness()

  const res = await app(await delivery(pushPayload(), { signature: null }))

  assert.equal(res.status, 401)
  assert.equal(store._size(), 0, 'an unsigned payload must not reach the store')

  const stats = await store.stats()
  assert.deepEqual(
    stats.rejections.map((r) => r.reason),
    [REJECT.MISSING],
  )
})

test('a delivery signed with the WRONG secret is rejected with 401 and stores nothing', async () => {
  const { store, app } = harness()

  const res = await app(await delivery(pushPayload(), { secret: 'not-the-configured-secret' }))

  assert.equal(res.status, 401)
  assert.equal(store._size(), 0)
  assert.deepEqual(
    (await store.stats()).rejections.map((r) => r.reason),
    [REJECT.MISMATCH],
  )
})

test('a TAMPERED body fails the signature that was valid for the original', async () => {
  const { store, app } = harness()
  const original = pushPayload()
  const signature = await sign(SECRET, original)

  // Same signature, one byte of the payload changed. This is the attack the
  // header exists to stop, so it gets its own case rather than being implied
  // by the wrong-secret test.
  const tampered = original.replace('refs/heads/main', 'refs/heads/evil')
  assert.notEqual(tampered, original)

  const res = await app(await delivery(tampered, { signature }))

  assert.equal(res.status, 401)
  assert.equal(store._size(), 0)
})

test('a MALFORMED signature header is rejected without being treated as a mismatch', async () => {
  for (const header of ['', 'sha256=', 'sha1=abc', 'sha256=nothex'.padEnd(71, 'z'), 'sha256=' + 'a'.repeat(63)]) {
    const { store, app } = harness()
    const res = await app(await delivery(pushPayload(), { signature: header }))
    assert.equal(res.status, 401, `header ${JSON.stringify(header)} must be refused`)
    assert.equal(store._size(), 0)
  }
})

test('every 401 looks identical, so probing cannot distinguish the failure', async () => {
  const bodies = []
  for (const opts of [{ signature: null }, { signature: 'sha256=' + 'a'.repeat(64) }, { secret: 'wrong' }]) {
    const { app } = harness()
    const res = await app(await delivery(pushPayload(), opts))
    assert.equal(res.status, 401)
    bodies.push(await res.text())
  }
  assert.equal(new Set(bodies).size, 1, 'the three rejection reasons must not be distinguishable by response')
})

// ---------------------------------------------------------------------------
// Fail closed.
// ---------------------------------------------------------------------------

test('with NO secret configured the receiver refuses everything with 503', async () => {
  const { store, app } = harness({ webhookSecret: null })

  // Correctly signed for *some* secret. An unconfigured receiver must not
  // accept it: storing bytes it cannot attribute is worse than storing nothing.
  const res = await app(await delivery(pushPayload(), { secret: 'anything' }))

  assert.equal(res.status, 503)
  assert.equal(store._size(), 0)
})

test('with no secret configured, verifySignature refuses rather than throwing', async () => {
  for (const secret of [undefined, null, '']) {
    const v = await verifySignature({ secret, body: new Uint8Array([1]), header: 'sha256=' + 'a'.repeat(64) })
    assert.equal(v.ok, false)
    assert.equal(v.reason, REJECT.NO_SECRET)
  }
})

test('with NO query token configured the read API is 503, not open', async () => {
  const { app } = harness({ queryToken: null })
  for (const path of ['/events', '/stats', '/events/d-1']) {
    const res = await app(read(path, null))
    assert.equal(res.status, 503, `${path} must fail closed`)
  }
})

// ---------------------------------------------------------------------------
// The happy path, and what lands in the store.
// ---------------------------------------------------------------------------

test('a correctly signed delivery is stored with its raw body and indexed fields', async () => {
  const { store, app } = harness({ now: () => T0 })
  const body = pushPayload()

  const res = await app(await delivery(body, { id: 'abc-123', event: 'push' }))
  assert.equal(res.status, 200)

  const json = await res.json()
  assert.equal(json.stored, true)
  assert.equal(json.duplicate, false)

  const row = await store.get('abc-123')
  assert.equal(row.event, 'push')
  assert.equal(row.repository, 'ExampleOrg/example-repo')
  assert.equal(row.organization, 'ExampleOrg')
  assert.equal(row.sender, 'human-reviewer')
  assert.equal(row.installation_id, 155772577)
  assert.equal(row.received_ms, T0)
  assert.equal(row.received_at, '2026-08-24T00:00:00.000Z')

  // The raw body, byte for byte. Re-serialising it would break the digest and
  // any later re-verification of the store.
  assert.equal(row.body, body)
  assert.equal(row.body_bytes, new TextEncoder().encode(body).length)
  assert.equal(row.body_truncated, 0)
  assert.equal(row.body_sha256, await sha256Hex(new TextEncoder().encode(body)))
})

test('the stored signature still verifies against the stored body', async () => {
  // This is what makes the store re-verifiable end to end rather than merely
  // verified once at receipt time.
  const { store, app } = harness()
  const body = pushPayload()
  await app(await delivery(body, { id: 'reverify-1' }))

  const row = await store.get('reverify-1')
  const v = await verifySignature({
    secret: SECRET,
    body: new TextEncoder().encode(row.body),
    header: row.signature,
  })
  assert.equal(v.ok, true)
})

test('only allowlisted headers are stored — no authorization, no cookies', async () => {
  const { store, app } = harness()
  const body = pushPayload()
  const req = await delivery(body, { id: 'hdr-1' })
  req.headers.set('authorization', 'Bearer super-secret-value')
  req.headers.set('cookie', 'session=super-secret-value')

  await app(req)

  const stored = (await store.get('hdr-1')).headers_json
  assert.ok(!stored.includes('super-secret-value'), 'a credential header reached the store')
  assert.ok(!/authorization|cookie/i.test(stored))
  assert.equal(JSON.parse(stored)['x-github-event'], 'push')
})

test('a signed but UNPARSEABLE body is still stored, with null index columns', async () => {
  // A delivery we can never get again must not be discarded because one field
  // did not parse. The signature already proved where it came from.
  const { store, app } = harness()
  const res = await app(await delivery('this is not json', { id: 'bad-json' }))

  assert.equal(res.status, 200)
  const row = await store.get('bad-json')
  assert.equal(row.body, 'this is not json')
  assert.equal(row.repository, null)
  assert.equal(row.sender, null)
})

test('an oversized body is truncated but the digest and length describe the FULL body', async () => {
  const filler = 'x'.repeat(MAX_STORED_BODY_BYTES + 4096)
  const body = JSON.stringify({ repository: { full_name: 'ExampleOrg/example-repo' }, filler })
  const full = new TextEncoder().encode(body)

  const record = await buildRecord({
    bodyBytes: full,
    headers: new Headers({ 'x-github-delivery': 'big-1', 'x-github-event': 'push' }),
    signature: 'sha256=' + 'a'.repeat(64),
    receivedMs: 0,
  })

  assert.equal(record.body_truncated, 1)
  assert.equal(record.body_bytes, full.length, 'body_bytes must describe the full body')
  assert.equal(record.body_sha256, await sha256Hex(full), 'the digest must be of the full body')
  assert.ok(record.body.length < body.length)
})

test('a signed delivery with no X-GitHub-Delivery is a 400, not a stored row', async () => {
  const { store, app } = harness()
  const body = pushPayload()
  const headers = new Headers({
    'x-github-event': 'push',
    'x-hub-signature-256': await sign(SECRET, body),
  })
  const res = await app(new Request(`${URL_BASE}/gh/webhook`, { method: 'POST', headers, body }))

  assert.equal(res.status, 400)
  assert.equal(store._size(), 0)
})

// ---------------------------------------------------------------------------
// De-duplication. GitHub retries.
// ---------------------------------------------------------------------------

test('a retried delivery is de-duplicated and still answered 200', async () => {
  const { store, app } = harness()
  const body = pushPayload()

  const first = await app(await delivery(body, { id: 'retry-me' }))
  const second = await app(await delivery(body, { id: 'retry-me' }))

  assert.equal(first.status, 200)
  assert.equal((await first.json()).stored, true)

  // 200, not 409: GitHub retries anything that is not 2xx, so a "conflict"
  // status would make every retry permanent.
  assert.equal(second.status, 200)
  const j = await second.json()
  assert.equal(j.stored, false)
  assert.equal(j.duplicate, true)

  assert.equal(store._size(), 1)
})

test('a retry does not overwrite the first receipt time', async () => {
  const store = createMemoryStore()
  let clock = 1000
  const app = createApp({ store, webhookSecret: SECRET, queryToken: QUERY_TOKEN, now: () => clock })

  await app(await delivery(pushPayload(), { id: 'stable' }))
  clock = 999_000
  await app(await delivery(pushPayload(), { id: 'stable' }))

  assert.equal((await store.get('stable')).received_ms, 1000)
})

// ---------------------------------------------------------------------------
// The store is queryable — "a store nobody can search is not a control".
// ---------------------------------------------------------------------------

async function seeded() {
  const store = createMemoryStore()
  let clock = T0
  const app = createApp({ store, webhookSecret: SECRET, queryToken: QUERY_TOKEN, now: () => clock })

  const rows = [
    ['e1', 'push', { repository: { full_name: 'ExampleOrg/example-repo' }, sender: { login: 'human-reviewer' } }],
    ['e2', 'push', { repository: { full_name: 'ExampleOrg/example-second' }, sender: { login: 'human-reviewer' } }],
    ['e3', 'repository', { action: 'created', repository: { full_name: 'ExampleOrg/new-repo' } }],
    ['e4', 'installation_repositories', { action: 'added', installation: { id: 155772577 } }],
    ['e5', 'member', { action: 'added', sender: { login: 'someone-else' } }],
  ]
  for (const [id, event, payload] of rows) {
    clock += 60_000
    await app(await delivery(JSON.stringify(payload), { id, event }))
  }
  return { store, app, lastClock: clock }
}

test('the read API requires a bearer token', async () => {
  const { app } = await seeded()
  assert.equal((await app(read('/events', null))).status, 401)
  assert.equal((await app(read('/events', 'wrong-token'))).status, 401)
  assert.equal((await app(read('/events', QUERY_TOKEN))).status, 200)
})

test('events come back newest first', async () => {
  const { app } = await seeded()
  const j = await (await app(read('/events'))).json()
  assert.deepEqual(
    j.events.map((e) => e.delivery_id),
    ['e5', 'e4', 'e3', 'e2', 'e1'],
  )
})

test('filters narrow the result — by event, repository and sender', async () => {
  const { app } = await seeded()

  const byEvent = await (await app(read('/events?event=push'))).json()
  assert.deepEqual(byEvent.events.map((e) => e.delivery_id).sort(), ['e1', 'e2'])

  const byRepo = await (await app(read('/events?repository=ExampleOrg%2Fexample-repo'))).json()
  assert.deepEqual(byRepo.events.map((e) => e.delivery_id), ['e1'])

  const bySender = await (await app(read('/events?sender=someone-else'))).json()
  assert.deepEqual(bySender.events.map((e) => e.delivery_id), ['e5'])

  // The one this whole issue was filed for: a repo silently joining the
  // org-admin installation announces itself on installation_repositories.
  const joined = await (await app(read('/events?event=installation_repositories&action=added'))).json()
  assert.deepEqual(joined.events.map((e) => e.delivery_id), ['e4'])
})

test('the body is withheld unless include_body is asked for', async () => {
  const { app } = await seeded()

  const without = await (await app(read('/events?limit=1'))).json()
  assert.equal(without.events[0].body, undefined)

  const with_ = await (await app(read('/events?limit=1&include_body=1'))).json()
  assert.equal(typeof with_.events[0].body, 'string')
})

test('paging with the cursor walks the whole store without repeating a row', async () => {
  const { app } = await seeded()
  const seen = []
  let cursor = null

  for (let page = 0; page < 10; page++) {
    const q = `/events?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const j = await (await app(read(q))).json()
    seen.push(...j.events.map((e) => e.delivery_id))
    cursor = j.next_cursor
    if (cursor === null) break
  }

  assert.deepEqual(seen, ['e5', 'e4', 'e3', 'e2', 'e1'])
  assert.equal(new Set(seen).size, seen.length, 'a row was returned twice')
})

test('a single delivery can be fetched by id, and a missing one is 404', async () => {
  const { app } = await seeded()

  const found = await app(read('/events/e3'))
  assert.equal(found.status, 200)
  const row = await found.json()
  assert.equal(row.delivery_id, 'e3')
  assert.equal(typeof row.body, 'string', 'the single-record view always includes the body')

  assert.equal((await app(read('/events/does-not-exist'))).status, 404)
})

test('stats summarise the store and the rejection counters', async () => {
  const { app } = await seeded()
  await app(await delivery(pushPayload(), { signature: null }))
  await app(await delivery(pushPayload(), { signature: null }))

  const s = await (await app(read('/stats'))).json()
  assert.equal(s.deliveries, 5)
  assert.equal(s.by_event.find((e) => e.event === 'push').count, 2)

  const missing = s.rejections.find((r) => r.reason === REJECT.MISSING)
  assert.equal(missing.count, 2, 'rejections are counted, not stored as rows')
})

// ---------------------------------------------------------------------------
// An anonymous flood must not become write volume.
//
// Counting per (day, reason) bounds how many ROWS a passer-by can create. On
// its own it does NOT bound how many WRITES they cause — the version of this
// service reviewed on 2026-08-24 issued one D1 `INSERT ... ON CONFLICT` per
// rejected request, on an account whose D1 allowance is shared with the
// production `routeware-shadow-api` Worker. Flooding the security control would
// have degraded an unrelated service.
//
// These assert on CALL COUNT, not on the totals. A test that only checked the
// totals passes identically against the unbounded version.
// ---------------------------------------------------------------------------

test('a flood of forged deliveries is coalesced into a bounded number of writes', async () => {
  let clock = T0
  const { app, store } = harness({ now: () => clock })

  const FLOOD = 500
  for (let i = 0; i < FLOOD; i++) {
    const res = await app(await delivery(pushPayload(), { id: `flood-${i}`, signature: null }))
    assert.equal(res.status, 401)
  }

  // One write for the first rejection — a lone probe against a quiet endpoint
  // must be visible immediately — and nothing more while the window is open.
  assert.equal(store._noteRejectionCalls(), 1, `${FLOOD} forged requests must not cost ${FLOOD} writes`)
  assert.equal(store._size(), 0, 'and not one of them reached the deliveries table')

  // Nothing is lost, only deferred: the authenticated read settles the buffer.
  const s = await (await app(read('/stats'))).json()
  assert.equal(s.rejections.find((r) => r.reason === REJECT.MISSING).count, FLOOD)
  assert.equal(store._noteRejectionCalls(), 2, 'settling the whole flood is one further write')
})

test('the first rejection is written immediately, without waiting for a reader', async () => {
  // The case worth seeing: one probe, against an endpoint nobody is watching.
  // Buffering it would mean it never lands at all.
  let clock = T0
  const { app, store } = harness({ now: () => clock })

  await app(await delivery(pushPayload(), { signature: null }))
  assert.equal(store._noteRejectionCalls(), 1)
  assert.equal((await store.stats()).rejections.find((r) => r.reason === REJECT.MISSING).count, 1)
})

test('the buffer settles once per interval, and crossing the boundary loses nothing', async () => {
  let clock = T0
  const { app, store } = harness({ now: () => clock, rejectionFlushMs: 10_000 })

  for (let i = 0; i < 10; i++) await app(await delivery(pushPayload(), { id: `w1-${i}`, signature: null }))
  assert.equal(store._noteRejectionCalls(), 1, 'first window: one write')

  clock = T0 + 10_001 // past the flush boundary
  for (let i = 0; i < 10; i++) await app(await delivery(pushPayload(), { id: `w2-${i}`, signature: null }))
  assert.equal(store._noteRejectionCalls(), 2, 'second window: exactly one more write, not eleven')

  const s = await (await app(read('/stats'))).json()
  assert.equal(
    s.rejections.find((r) => r.reason === REJECT.MISSING).count,
    20,
    'coalescing defers writes; it must never drop a count it already accepted',
  )
})

test('a rejection counter that cannot write still answers 401, never 500', async () => {
  // A 5xx would be worse than a lost counter twice over: it tells a prober
  // their forgery broke something, and GitHub retries a 5xx forever.
  let clock = T0
  const store = createMemoryStore()
  store.noteRejection = async () => {
    throw new Error('D1 unavailable')
  }
  const app = createApp({ store, webhookSecret: SECRET, queryToken: QUERY_TOKEN, now: () => clock })

  const res = await app(await delivery(pushPayload(), { signature: null }))
  assert.equal(res.status, 401)
  assert.deepEqual(await res.json(), { error: 'unauthorized' })
})

// ---------------------------------------------------------------------------
// Default is refusal.
// ---------------------------------------------------------------------------

test('an unknown query parameter is a 400, never a silently widened query', async () => {
  const { app } = await seeded()
  // The failure this prevents: a typo'd filter is dropped, MORE rows come
  // back, and the caller reads that as "nothing was excluded".
  const res = await app(read('/events?repositry=ExampleOrg%2Fexample-repo'))
  assert.equal(res.status, 400)
})

test('malformed query values are refused', async () => {
  for (const q of [
    '/events?limit=0',
    `/events?limit=${MAX_LIMIT + 1}`,
    '/events?limit=abc',
    '/events?since=yesterday',
    '/events?since=2026-08-24&until=2026-08-01',
    '/events?cursor=nonsense',
    '/events?include_body=maybe',
  ]) {
    const { app } = await seeded()
    assert.equal((await app(read(q))).status, 400, `${q} must be refused`)
  }
})

test('unknown paths and wrong methods are refused', async () => {
  const { app } = await seeded()

  assert.equal((await app(read('/'))).status, 404)
  assert.equal((await app(read('/admin'))).status, 404)
  assert.equal((await app(new Request(`${URL_BASE}/gh/webhook`))).status, 405)
  assert.equal(
    (await app(new Request(`${URL_BASE}/events`, { method: 'POST', headers: { authorization: `Bearer ${QUERY_TOKEN}` } })))
      .status,
    405,
  )
})

// ---------------------------------------------------------------------------
// /bridge/claim and /bridge/claims — TASK-3552's at-most-once wake ledger.
// ---------------------------------------------------------------------------

function claimRequest(body, token = QUERY_TOKEN) {
  const headers = { 'content-type': 'application/json' }
  if (token !== null) headers.authorization = `Bearer ${token}`
  return new Request(`${URL_BASE}/bridge/claim`, { method: 'POST', headers, body: JSON.stringify(body) })
}

test('claiming a fresh key succeeds; claiming it again reports it was already taken', async () => {
  const { app } = harness()
  const body = { issue_ref: 'TASK-3552', head_sha: 'abc123', kind: 'check_suite_completed', delivery_id: 'd-1' }

  await seedClaim(app, body, SECRET)
  const first = await app(claimRequest(body))
  assert.equal(first.status, 200)
  const firstJson = await first.json()
  assert.equal(firstJson.claimed, true)
  assert.equal(firstJson.claim_key, 'TASK-3552|abc123|check_suite_completed')

  const retry = { ...body, delivery_id: 'd-2' }
  await seedClaim(app, retry, SECRET)
  const second = await app(claimRequest(retry))
  assert.equal(second.status, 200)
  assert.equal((await second.json()).claimed, false)
})

test('a null head sha still produces a stable claim key', async () => {
  const { app } = harness()
  const body = { issue_ref: 'TASK-3552', head_sha: null, kind: 'work_product_create', delivery_id: 'd-1',
    pr_url: 'https://github.com/ExampleOrg/example-repo/pull/42', action: 'opened' }
  await seedClaim(app, body, SECRET)
  const res = await app(claimRequest(body))
  assert.equal(res.status, 200)
  assert.equal((await res.json()).claimed, true)
  assert.equal((await (await app(claimRequest(body))).json()).claimed, false)
})

test('/bridge/claim requires a bearer token, like every other read/write route', async () => {
  const { app } = harness()
  const body = { issue_ref: 'TASK-3552', head_sha: 'abc123', kind: 'check_suite_completed', delivery_id: 'd-1' }
  assert.equal((await app(claimRequest(body, null))).status, 401)
  assert.equal((await app(claimRequest(body, 'wrong-token'))).status, 401)
})

test('/bridge/claim rejects malformed bodies without touching the store', async () => {
  const { store, app } = harness()
  const base = { issue_ref: 'TASK-3552', head_sha: 'abc123', kind: 'check_suite_completed', delivery_id: 'd-1' }

  assert.equal((await app(claimRequest({ ...base, issue_ref: 'not-an-issue' }))).status, 400)
  assert.equal((await app(claimRequest({ ...base, head_sha: 42 }))).status, 400)
  assert.equal((await app(claimRequest({ ...base, kind: '' }))).status, 400)
  assert.equal((await app(claimRequest({ ...base, delivery_id: '' }))).status, 400)
  assert.equal((await app(claimRequest({ ...base, head_sha: null }))).status, 400)
  assert.equal((await app(claimRequest({ ...base, kind: 'unknown' }))).status, 400)
  const work = { ...base, kind: 'work_product_update', action: 'closed', pr_url: 'https://github.com/o/r/pull/1' }
  for (const field of ['pr_url', 'action', 'delivery_id']) {
    assert.equal((await app(claimRequest({ ...work, [field]: undefined }))).status, 400)
  }

  const notJson = await app(
    new Request(`${URL_BASE}/bridge/claim`, {
      method: 'POST',
      headers: { authorization: `Bearer ${QUERY_TOKEN}`, 'content-type': 'application/json' },
      body: 'not json',
    }),
  )
  assert.equal(notJson.status, 400)

  assert.equal((await store.listBridgeClaims({ limit: 50 })).length, 0)
})

test('GET /bridge/claim and POST /bridge/claims are wrong-method 405s, not silently accepted', async () => {
  const { app } = harness()
  assert.equal((await app(read('/bridge/claim'))).status, 405)
  assert.equal(
    (await app(new Request(`${URL_BASE}/bridge/claims`, { method: 'POST', headers: { authorization: `Bearer ${QUERY_TOKEN}` } })))
      .status,
    405,
  )
})

test('an unknown /bridge/ path is a 404 behind the same auth gate', async () => {
  const { app } = harness()
  assert.equal((await app(read('/bridge/nonsense', null))).status, 401) // no token: auth checked first
  assert.equal((await app(read('/bridge/nonsense', QUERY_TOKEN))).status, 404)
})

test('GET /bridge/claims lists claims newest first and can be scoped to one issue', async () => {
  // A controlled, strictly-increasing clock: two claims made within the same
  // wall-clock millisecond would otherwise make the DESC ordering ambiguous.
  let clock = T0
  const store = createMemoryStore()
  const app = createApp({ store, webhookSecret: SECRET, queryToken: QUERY_TOKEN, now: () => clock++ })

  const claims = [
    { issue_ref: 'TASK-3552', head_sha: 'sha1', kind: 'check_suite_completed', delivery_id: 'd-1' },
    { issue_ref: 'TASK-3552', head_sha: 'sha2', kind: 'check_suite_completed', delivery_id: 'd-2' },
    { issue_ref: 'TASK-9', head_sha: 'sha3', kind: 'work_product_create', delivery_id: 'd-3',
      pr_url: 'https://github.com/ExampleOrg/example-repo/pull/42', action: 'opened' },
  ]
  for (const c of claims) {
    // eslint-disable-next-line no-await-in-loop -- ordering matters: claimed_ms must strictly increase
    await seedClaim(app, c, SECRET)
    assert.equal((await app(claimRequest(c))).status, 200)
  }

  const all = await (await app(read('/bridge/claims'))).json()
  assert.deepEqual(
    all.claims.map((c) => c.delivery_id),
    ['d-3', 'd-2', 'd-1'],
  )

  const scoped = await (await app(read('/bridge/claims?issue_ref=TASK-3552'))).json()
  assert.deepEqual(
    scoped.claims.map((c) => c.delivery_id),
    ['d-2', 'd-1'],
  )
})

test('GET /bridge/claims validates issue_ref and limit the same way /events does', async () => {
  const { app } = harness()
  assert.equal((await app(read('/bridge/claims?issue_ref=not-an-issue'))).status, 400)
  assert.equal((await app(read('/bridge/claims?limit=not-a-number'))).status, 400)
})

test('health discloses no store CONTENTS, but does disclose arming state', async () => {
  // Renamed on TASK-340. The previous name, 'discloses nothing about the store',
  // was accurate about contents and broader than anything asserted below —
  // /health is unauthenticated and does tell any caller whether this receiver
  // is armed. README § 6 documents that rather than closing it, because the
  // same fact reaches the same anonymous caller two other ways (pinned at the
  // bottom of this test), so gating these two fields would hide the disclosure
  // without removing it.
  const { app } = await seeded()
  const res = await app(new Request(`${URL_BASE}/health`))

  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(j.ok, true)
  assert.equal(j.webhook_secret_configured, true)
  // A 200 here means the service is up. It is not evidence that events are
  // arriving, and it must never start reporting a count that could be read as
  // "all quiet". See README § "What this does not tell you".
  assert.equal(j.deliveries, undefined)
  assert.equal(j.newest_received_at, undefined)

  // The disclosure itself, pinned so it stays a decision rather than becoming
  // an accident. If a later change closes it, this fails and sends the reader
  // to the README paragraph that argues the trade.
  const { app: blind } = harness({ webhookSecret: '', queryToken: '' })
  const b = await (await blind(new Request(`${URL_BASE}/health`))).json()
  assert.equal(b.ok, true, 'a blind receiver still reports itself up')
  assert.equal(b.webhook_secret_configured, false)
  assert.equal(b.query_token_configured, false)
  assert.notDeepEqual(j, b, 'armed and blind are distinguishable to an anonymous caller')

  // The two corroborating channels. Closing /health alone would leave both, so
  // the honest fix is all three at once or none.
  assert.equal(
    (await blind(new Request(`${URL_BASE}/gh/webhook`, { method: 'POST', body: '{}' }))).status,
    503,
    'an unconfigured receiver says so a second way',
  )
  assert.equal((await blind(read('/events', null))).status, 503)
  assert.equal(
    (await app(read('/events', null))).status,
    401,
    'armed answers 401 where blind answers 503 — a third way to learn the same fact',
  )
})

test('no tracked source file contains a NUL byte', async () => {
  // Not cosmetic. git classifies a file with a NUL byte as BINARY, and CI's
  // secret scan is `git grep -I`, which SKIPS binary files. A stray NUL in a
  // source file therefore removes that file from the scan silently, while the
  // check stays green — exactly the "CI looks like it tests everything"
  // failure this repo was created to prevent. One reached src/store-memory.js
  // during TASK-289 and was caught only because `git show --stat` printed
  // "Bin 0 -> 4831 bytes" instead of a line count.
  const { readdirSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const root = new URL('..', import.meta.url).pathname

  const offenders = []
  for (const dir of ['src', 'test', 'scripts', '']) {
    const full = join(root, dir)
    for (const name of readdirSync(full, { withFileTypes: true })) {
      if (!name.isFile()) continue
      if (!/\.(js|mjs|sh|sql|json|toml|md)$/.test(name.name)) continue
      const bytes = readFileSync(join(full, name.name))
      if (bytes.includes(0)) offenders.push(join(dir, name.name))
    }
  }
  assert.deepEqual(offenders, [], 'a NUL byte makes git treat these as binary, hiding them from the secret scan')
})

test('parseQuery defaults are conservative', async () => {
  const parsed = parseQuery(new URLSearchParams(''))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.filters.includeBody, false)
  assert.ok(parsed.filters.limit <= MAX_LIMIT)
})
