// Offline suite for the CEO-GO board scanners.
//
// No credentials, no network, no clock. The board transport is a stub serving
// one scripted comment list; assertions pin the recognised digest sets. The
// rows that carry this suite:
//
//   * the 64-hex marker feeds plan-mode GOs and never the SHA set;
//   * the 40-hex marker feeds sha-mode GOs and never the hash set;
//   * the two markers are disjoint (a bare SHA never reads as a hash prefix
//     and vice versa);
//   * identity gates both: owner, operator and human-authored markers count
//     for nothing in either mode.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { scanChiefGo, scanChiefGoShas } from '../src/board.js'

const BOARD_ORIGIN = 'https://board.example.invalid'
const BOARD_TOKEN = 'test-board-token-not-a-real-one'
const CEO_AGENT_ID = '11111111-2222-4333-8444-555555555555'
const ISSUE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

const HEAD_A = 'a'.repeat(40)
const HEAD_B = 'd'.repeat(40)
const HASH_A = 'b'.repeat(64)
const HASH_B = 'c'.repeat(64)

function ceoComment(body, overrides = {}) {
  return { id: 'c1', authorAgentId: CEO_AGENT_ID, authorUserId: null, body, ...overrides }
}

function transport(comments) {
  const fetchImpl = async (url, init = {}) => {
    assert.ok(String(url).includes('/api/issues/'))
    assert.equal(init.method ?? 'GET', 'GET')
    return Response.json(comments)
  }
  return { fetchImpl, boardOrigin: BOARD_ORIGIN, token: BOARD_TOKEN, issueId: ISSUE, ceoAgentId: CEO_AGENT_ID }
}

test('hash scanner collects 64-hex markers in first-seen order', async () => {
  const comments = [ceoComment(`first GO ${HASH_A} then GO ${HASH_B} then GO ${HASH_A} again`)]
  assert.deepEqual(await scanChiefGo(transport(comments)), [HASH_A, HASH_B])
})

test('sha scanner collects 40-hex markers in first-seen order', async () => {
  const comments = [ceoComment(`deploying GO ${HEAD_A} and GO ${HEAD_B}, repeat GO ${HEAD_A}`)]
  assert.deepEqual(await scanChiefGoShas(transport(comments)), [HEAD_A, HEAD_B])
})

test('the two markers are disjoint', async () => {
  // A bare SHA never feeds the hash set, and a 64-hex hash never feeds the
  // SHA set — not even its first 40 characters.
  const comments = [ceoComment(`GO ${HEAD_A}`), ceoComment(`GO ${HASH_A}`)]
  assert.deepEqual(await scanChiefGo(transport(comments)), [HASH_A])
  assert.deepEqual(await scanChiefGoShas(transport(comments)), [HEAD_A])
})

test('hashes without the marker contribute nothing to either set', async () => {
  const comments = [ceoComment(`discussing ${HASH_A} and ${HEAD_A} without approval`)]
  assert.deepEqual(await scanChiefGo(transport(comments)), [])
  assert.deepEqual(await scanChiefGoShas(transport(comments)), [])
})

test('non-CEO authorship counts for nothing in either mode', async () => {
  const comments = [
    ceoComment(`GO ${HASH_A} and GO ${HEAD_A}`, { authorAgentId: '00000000-0000-4000-8000-000000000001' }),
    ceoComment(`GO ${HASH_A} and GO ${HEAD_A}`, { authorUserId: 'some-human' }),
  ]
  assert.deepEqual(await scanChiefGo(transport(comments)), [])
  assert.deepEqual(await scanChiefGoShas(transport(comments)), [])
})

test('marker is case-insensitive on the word only', async () => {
  const comments = [ceoComment(`go ${HEAD_A}`)]
  assert.deepEqual(await scanChiefGoShas(transport(comments)), [HEAD_A])
})

test('a failed board read throws (fail closed, never an empty approval)', async () => {
  const fetchImpl = async () => new Response('{}', { status: 500 })
  await assert.rejects(scanChiefGo({ fetchImpl, boardOrigin: BOARD_ORIGIN, token: BOARD_TOKEN, issueId: ISSUE, ceoAgentId: CEO_AGENT_ID }))
  await assert.rejects(scanChiefGoShas({ fetchImpl, boardOrigin: BOARD_ORIGIN, token: BOARD_TOKEN, issueId: ISSUE, ceoAgentId: CEO_AGENT_ID }))
})

test('a missing CEO identity throws instead of scanning as anyone', async () => {
  const { fetchImpl, boardOrigin, token, issueId } = transport([])
  await assert.rejects(scanChiefGo({ fetchImpl, boardOrigin, token, issueId }))
  await assert.rejects(scanChiefGoShas({ fetchImpl, boardOrigin, token, issueId }))
})
