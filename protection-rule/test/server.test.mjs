// Offline entrypoint coverage: fake file reader and serve adapter; no host
// files, listener, key import, GitHub request or board request is used here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { main } from '../src/server.js'
import { TRUSTED_CONFIG, freshConfig } from './trusted-fixture.mjs'

const ENV = {
  PROTECTION_RULE_CONFIG_FILE: '/synthetic/operator-config',
  PROTECTION_RULE_WEBHOOK_SECRET: 'synthetic-webhook-not-real',
  PROTECTION_RULE_APP_ID: '9000',
  PROTECTION_RULE_KEY_FILE: '/synthetic/key-not-real',
  PROTECTION_RULE_BOARD_TOKEN: 'synthetic-board-not-real',
  PROTECTION_RULE_BOARD_ORIGIN: 'https://board.example.invalid',
}
async function startup(config, envOverrides = {}) {
  const reads = []
  const serves = []
  const readText = async (path) => {
    reads.push(path)
    if (path === ENV.PROTECTION_RULE_CONFIG_FILE) return JSON.stringify(config)
    if (path === ENV.PROTECTION_RULE_KEY_FILE) return 'synthetic-PRIVATE KEY-marker-not-real'
    throw new Error('unexpected file read')
  }
  const result = await main({ ...ENV, ...envOverrides }, async (args) => {
    serves.push(args)
    return 'stub-served'
  }, readText)
  return { result, reads, serves }
}

test('valid explicit configuration reaches only the injected serve adapter', async () => {
  const { result, reads, serves } = await startup(TRUSTED_CONFIG)
  assert.equal(result, 'stub-served')
  assert.deepEqual(reads, [ENV.PROTECTION_RULE_CONFIG_FILE, ENV.PROTECTION_RULE_KEY_FILE])
  assert.equal(serves.length, 1)
  assert.equal(serves[0].port, 8788)
  const response = await serves[0].app(new Request('https://receiver.example.invalid/health'))
  assert.equal(response.status, 200)
})
for (const field of ['policies', 'approverAgentId', 'reviewedPlanRepositories', 'installationIds']) {
  test(`startup refuses missing ${field} before key read or serving`, async () => {
    const config = freshConfig()
    delete config[field]
    const { result, reads, serves } = await startup(config)
    assert.equal(result, 2)
    assert.deepEqual(reads, [ENV.PROTECTION_RULE_CONFIG_FILE])
    assert.deepEqual(serves, [])
  })
}
test('startup refuses invalid authority configuration before key read or serving', async () => {
  for (const config of [
    { ...TRUSTED_CONFIG, policies: [] },
    { ...TRUSTED_CONFIG, approverAgentId: 'caller-input' },
    { ...TRUSTED_CONFIG, reviewedPlanRepositories: ['ForeignOrg/unreviewed'] },
    { ...TRUSTED_CONFIG, reviewedPlanRepositories: [] },
    { ...TRUSTED_CONFIG, installationIds: [0] },
    { ...TRUSTED_CONFIG, issueId: TRUSTED_CONFIG.policies[0].goIssueId },
  ]) {
    const { result, reads, serves } = await startup(config)
    assert.equal(result, 2)
    assert.deepEqual(reads, [ENV.PROTECTION_RULE_CONFIG_FILE])
    assert.deepEqual(serves, [])
  }
})
test('startup has no config-file fallback even when credentials are supplied', async () => {
  const { result, reads, serves } = await startup(TRUSTED_CONFIG, { PROTECTION_RULE_CONFIG_FILE: undefined })
  assert.equal(result, 2)
  assert.deepEqual(reads, [])
  assert.deepEqual(serves, [])
})
test('startup refuses every missing required host input before reading files', async () => {
  for (const field of Object.keys(ENV)) {
    const { result, reads, serves } = await startup(TRUSTED_CONFIG, { [field]: '' })
    assert.equal(result, 2)
    assert.deepEqual(reads, [])
    assert.deepEqual(serves, [])
  }
})
test('startup refuses unreadable, malformed JSON or non-object config without serving', async () => {
  for (const text of [null, '{broken', '[]', 'null', '"config"']) {
    let serves = 0
    let reads = 0
    const result = await main(ENV, () => { serves++ }, async () => {
      reads++
      if (text === null) throw new Error('unreadable')
      return text
    })
    assert.equal(result, 2)
    assert.equal(reads, 1)
    assert.equal(serves, 0)
  }
})
test('startup refuses invalid board origins before reading the key', async () => {
  for (const origin of ['http://board.example.invalid', 'https://board.example.invalid/path', 'https://user@board.example.invalid', 'not-an-origin']) {
    const { result, reads, serves } = await startup(TRUSTED_CONFIG, { PROTECTION_RULE_BOARD_ORIGIN: origin })
    assert.equal(result, 2)
    assert.deepEqual(reads, [ENV.PROTECTION_RULE_CONFIG_FILE])
    assert.deepEqual(serves, [])
  }
})
test('startup refuses invalid ports before reading files or serving', async () => {
  for (const port of ['0', '65536', '1.1', 'abc']) {
    const { result, reads, serves } = await startup(TRUSTED_CONFIG, { PROTECTION_RULE_PORT: port })
    assert.equal(result, 2)
    assert.deepEqual(reads, [])
    assert.deepEqual(serves, [])
  }
})
test('startup key read errors return 2 rather than terminating an importing process', async () => {
  for (const key of [null, 'not-a-key']) {
    let serves = 0
    const result = await main(ENV, () => { serves++ }, async (path) => {
      if (path === ENV.PROTECTION_RULE_CONFIG_FILE) return JSON.stringify(TRUSTED_CONFIG)
      if (key === null) throw new Error('unreadable')
      return key
    })
    assert.equal(result, 2)
    assert.equal(serves, 0)
  }
})
