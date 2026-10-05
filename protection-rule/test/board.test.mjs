// Offline suite for the configured approver-GO board scanners.
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
import { APPROVER_AGENT_ID, OTHER_AGENT_ID, PLAN_POLICY } from './trusted-fixture.mjs'

const BOARD_ORIGIN = 'https://board.example.invalid'
const BOARD_TOKEN = 'test-board-token-not-a-real-one'
const ISSUE = PLAN_POLICY.goIssueId

const HEAD_A = 'a'.repeat(40)
const HEAD_B = 'd'.repeat(40)
const HASH_A = 'b'.repeat(64)
const HASH_B = 'c'.repeat(64)

function ceoComment(body, overrides = {}) {
  return { id: 'c1', authorAgentId: APPROVER_AGENT_ID, authorUserId: null, body, ...overrides }
}

function transport(comments) {
  const fetchImpl = async (url, init = {}) => {
    assert.ok(String(url).includes('/api/issues/'))
    assert.equal(init.method ?? 'GET', 'GET')
    return Response.json(comments)
  }
  return { fetchImpl, boardOrigin: BOARD_ORIGIN, token: BOARD_TOKEN, issueId: ISSUE, approverAgentId: APPROVER_AGENT_ID }
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

test('non-configured approver authorship counts for nothing in either mode', async () => {
  const comments = [
    ceoComment(`GO ${HASH_A} and GO ${HEAD_A}`, { authorAgentId: OTHER_AGENT_ID }),
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
  await assert.rejects(scanChiefGo({ fetchImpl, boardOrigin: BOARD_ORIGIN, token: BOARD_TOKEN, issueId: ISSUE, approverAgentId: APPROVER_AGENT_ID }))
  await assert.rejects(scanChiefGoShas({ fetchImpl, boardOrigin: BOARD_ORIGIN, token: BOARD_TOKEN, issueId: ISSUE, approverAgentId: APPROVER_AGENT_ID }))
})

test('unconfigured approver cannot authorize a GO marker or reach transport', async () => {
  for (const approverAgentId of [undefined, null, '', 'caller-selected']) {
    let calls = 0
    const args = {
      boardOrigin: BOARD_ORIGIN, token: BOARD_TOKEN, issueId: ISSUE, approverAgentId,
      // Intentionally permissive: deleting validation must not be masked by a
      // stub error. A matching invalid/absent author would otherwise yield GO.
      fetchImpl: async () => {
        calls++
        return Response.json([{ authorAgentId: approverAgentId, authorUserId: null, body: `GO ${HASH_A} and GO ${HEAD_A}` }])
      },
    }
    await assert.rejects(scanChiefGo(args), { name: 'Error' }, 'unconfigured approver must not yield plan approval')
    await assert.rejects(scanChiefGoShas(args), { name: 'Error' }, 'unconfigured approver must not yield SHA approval')
    assert.equal(calls, 0, 'unconfigured approval identity must refuse before board read')
  }
})
test('agent authorship without an explicitly null user field does not authorize', async () => {
  const comments = [ceoComment(`GO ${HASH_A} and GO ${HEAD_A}`, { authorUserId: undefined })]
  assert.deepEqual(await scanChiefGo(transport(comments)), [])
  assert.deepEqual(await scanChiefGoShas(transport(comments)), [])
})
test('marker normalizes hex case without crossing digest widths', async () => {
  const comments = [ceoComment(`GO ${HASH_A.toUpperCase()} and GO ${HEAD_A.toUpperCase()}`)]
  assert.deepEqual(await scanChiefGo(transport(comments)), [HASH_A])
  assert.deepEqual(await scanChiefGoShas(transport(comments)), [HEAD_A])
})
test('board transport is bound to the configured issue and never follows redirects', async () => {
  const args = {
    boardOrigin: BOARD_ORIGIN, token: BOARD_TOKEN, issueId: ISSUE, approverAgentId: APPROVER_AGENT_ID,
    fetchImpl: async (url, init) => {
      assert.equal(url, `${BOARD_ORIGIN}/api/issues/${ISSUE}/comments?order=asc`)
      assert.equal(init.headers.authorization, `Bearer ${BOARD_TOKEN}`)
      assert.equal(init.redirect, 'manual')
      return new Response(null, { status: 302, headers: { location: 'https://foreign.example.invalid/' } })
    },
  }
  await assert.rejects(scanChiefGo(args))
  await assert.rejects(scanChiefGoShas(args))
})
