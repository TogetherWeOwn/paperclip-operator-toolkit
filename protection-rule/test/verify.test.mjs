// Offline suite for webhook signature verification.
//
// No credentials, no network. The property the whole control rests on: an
// unsigned or forged delivery is rejected. Assertions pin status-shape
// behaviour (`ok` true/false plus the stable reason id), never message text.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { verifySignature, REJECT } from '../src/verify.js'

const SECRET = 'test-webhook-secret-not-a-real-one'
const BODY = new TextEncoder().encode('{"action":"requested"}')

/**
 * Sign a body the way GitHub does. Independent of `verify.js`'s comparison
 * path on purpose — if both sides shared a helper, a bug in the helper would
 * verify itself.
 */
async function sign(secret, body) {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, body))
  let hex = ''
  for (const b of mac) hex += b.toString(16).padStart(2, '0')
  return `sha256=${hex}`
}

test('a valid signature verifies', async () => {
  const header = await sign(SECRET, BODY)
  assert.deepEqual(await verifySignature({ secret: SECRET, body: BODY, header }), { ok: true })
})

test('a missing secret rejects without verifying', async () => {
  const header = await sign(SECRET, BODY)
  for (const secret of [undefined, null, '']) {
    assert.deepEqual(await verifySignature({ secret, body: BODY, header }), { ok: false, reason: REJECT.NO_SECRET })
  }
})

test('a missing signature rejects', async () => {
  for (const header of [undefined, null, '']) {
    assert.deepEqual(await verifySignature({ secret: SECRET, body: BODY, header }), { ok: false, reason: REJECT.MISSING })
  }
})

test('a malformed signature rejects without being a mismatch', async () => {
  for (const header of ['sha256=xyz', 'sha256=' + 'g'.repeat(64), 'bearer abc', 'sha256=' + 'A'.repeat(63)]) {
    assert.deepEqual(await verifySignature({ secret: SECRET, body: BODY, header }), { ok: false, reason: REJECT.MALFORMED })
  }
})

test('a wrong-secret signature rejects as mismatch', async () => {
  const header = await sign('another-secret-not-a-real-one', BODY)
  assert.deepEqual(await verifySignature({ secret: SECRET, body: BODY, header }), { ok: false, reason: REJECT.MISMATCH })
})

test('a tampered body fails the original signature', async () => {
  const header = await sign(SECRET, BODY)
  const tampered = new TextEncoder().encode('{"action":"requested","extra":1}')
  assert.deepEqual(await verifySignature({ secret: SECRET, body: tampered, header }), { ok: false, reason: REJECT.MISMATCH })
})

test('uppercase hex verifies (GitHub case tolerance)', async () => {
  const lower = await sign(SECRET, BODY)
  assert.deepEqual(
    await verifySignature({ secret: SECRET, body: BODY, header: lower.replace('sha256=', 'sha256=').toUpperCase().replace('SHA256=', 'sha256=') }),
    { ok: true },
  )
})
