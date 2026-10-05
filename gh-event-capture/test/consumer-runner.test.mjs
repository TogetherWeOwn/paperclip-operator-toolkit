import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, chmod, symlink, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { EventEmitter } from 'node:events'
import { createPassBudget, runProductPass, runnerLimits, executeGithub } from '../src/consumer-runner.js'
import { loadConsumerConfig } from '../src/consumer-config.js'
import { main } from '../src/consumer-cli.js'
import { createApp } from '../src/app.js'
import { createMemoryStore } from '../src/store-memory.js'
import { ingest, agentPr, repository } from './bridge-fixtures.mjs'

const repo = repository.full_name
const companyId = '12345678-1234-4234-8234-123456789abc'
const issueId = 'd37131fa-924c-41b6-a4ad-e51811045faa'
const productId = '36fdb328-3f1b-451a-9016-208504920a7e'
const runId = 'b844b06e-3da5-4a47-8635-1af82108d3a0'
const secret = 'PRIVATE-TEST-KEY'
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
// A virtual clock for the pass budget. Wall-clock deadlines race the pass's own setup
// under a loaded parallel suite: the budget can expire before the instrumented fetch is
// ever reached, so the test asserts settlement on a pass that performed no I/O. Here the
// deadline advances only when the test says so, from inside the fetch it means to abort.
function virtualClock() {
  let time = 0
  let nextId = 1
  const timers = new Map()
  return {
    now: () => time,
    setTimer: (fn, ms) => { timers.set(nextId, { at: time + ms, fn }); return nextId++ },
    clearTimer: (id) => { timers.delete(id) },
    advance(ms) {
      time += ms
      for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn() }
    },
  }
}
async function harness(t) {
  const root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'product-pass-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = { version: 1, mode: 'products-only-v1', captureOrigin: 'https://capture.test',
    boardOrigin: 'https://board.test', companyId, allowedRepositories: [repo], stateDirectory: join(root, 'state'),
    captureTokenFile: join(root, 'capture.key'), boardTokenFile: join(root, 'board.key'), limits: {} }
  const configPath = join(root, 'config.json')
  await writeFile(config.captureTokenFile, secret + '\n', { mode: 0o600 })
  await writeFile(config.boardTokenFile, secret, { mode: 0o600 })
  const h = { root, config, configPath, products: [], calls: [], losesCreate: false }
  h.save = () => writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
  await h.save()
  const store = createMemoryStore()
  const app = createApp({ store, webhookSecret: 'test', queryToken: secret, now: () => 1000 })
  const pr = { ...agentPr, title: 'Runner PR', body: '', head: { ref: 'task-3552-runner', sha: 'a'.repeat(40) },
    state: 'open', draft: false, merged: false }
  h.ingest = (id, event = 'pull_request') => ingest(app, event, id, event === 'pull_request'
    ? { repository, action: 'opened', pull_request: pr }
    : { repository, action: 'completed', check_suite: { status: 'completed', head_sha: pr.head.sha, pull_requests: [{ number: pr.number }] } })
  h.fetch = async (url, init) => {
    h.calls.push([init.method, url])
    assert.equal(init.signal.aborted, false)
    assert.equal(init.headers.authorization, 'Bearer '+secret)
    if (url.startsWith(config.captureOrigin)) {
      assert.equal(init.method, 'GET', 'product-only runner cannot claim')
      return app(new Request(url, init))
    }
    const path = new URL(url).pathname
    if (init.method === 'GET' && path === '/api/issues/TASK-3552') return json({ id: issueId, identifier: 'TASK-3552', companyId })
    if (init.method === 'GET' && path === `/api/issues/${issueId}/work-products`) return json(h.products)
    const body = init.body && JSON.parse(init.body)
    if (init.method === 'POST' && path === `/api/issues/${issueId}/work-products`) {
      const p = { ...body, id: productId, issueId, companyId }
      h.products.push(p)
      if (h.losesCreate) { h.losesCreate = false; throw new Error(secret) }
      return json(p, 201)
    }
    if (init.method === 'PATCH' && path === `/api/work-products/${productId}`) {
      Object.assign(h.products[0], body)
      return json(h.products[0])
    }
    assert.fail('unexpected route')
  }
  h.run = async (file, args, options) => {
    h.calls.push(['gh', args])
    assert.equal(file, 'gh')
    assert.equal(options.shell, false)
    assert.equal(options.signal.aborted, false)
    assert.ok(options.timeout > 0 && options.timeout <= 30000)
    assert.equal(args.join().includes(secret), false)
    // The sweep shares the same gh transport: answer the open-PR list query
    // with an empty complete scan so the default harness exercises steady state.
    if (String(args[5]).includes('BridgeOpenPullRequests')) {
      return { stdout: JSON.stringify({ data: { repository: { nameWithOwner: repo, pullRequests: {
        totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }) }
    }
    return { stdout: JSON.stringify({ data: { repository: { nameWithOwner: repo, pullRequest: {
      number: pr.number, url: pr.html_url, title: pr.title, body: '', state: 'OPEN', isDraft: false, merged: false,
      headRefName: pr.head.ref, headRefOid: pr.head.sha, reviewDecision: 'APPROVED',
      author: { __typename: 'Bot', login: 'togetherweown' }, baseRepository: { nameWithOwner: repo },
    } } } }) }
  }
  h.pass = (overrides = {}) => runProductPass({ config, captureToken: secret, boardToken: secret },
    { fetchImpl: h.fetch, run: h.run, ...overrides })
  h.state = async () => JSON.parse(await readFile(join(config.stateDirectory, 'receipts.json'), 'utf8'))
  return h
}

test('runtime-supplied gh executable is used for event reads and both sweep scans, not PATH', async (t) => {
  const h = await harness(t)
  await h.ingest('pinned-read')
  const githubExecutable = join(h.root, 'approved-bin', 'gh')
  const files = []
  const result = await runProductPass({ config: h.config, captureToken: secret, boardToken: secret, githubExecutable }, {
    fetchImpl: h.fetch,
    run: async (file, args, options) => { files.push(file); return h.run('gh', args, options) },
  })
  assert.equal(result.ok, true)
  assert.equal(h.products.length, 1)
  assert.equal(files.length, 3)
  assert.deepEqual(files, Array(3).fill(githubExecutable))
})

test('capture history exhaustion is loud, but cannot starve sweeps on every pass', async (t) => {
  const h = await harness(t)
  await h.ingest('a'); await h.ingest('b'); await h.ingest('c')
  h.config.limits = { pageSize: 1, maxPages: 1 }
  const first = await h.pass()
  assert.equal(first.ok, false)
  assert.equal(first.reason, 'cycle-failed')
  assert.equal(first.events, null)
  assert.equal(h.calls.some(([method]) => method === 'gh'), false)
  const second = await h.pass()
  assert.equal(second.ok, false)
  assert.equal(second.events, null)
  assert.equal(second.sweeps.ok, true)
  assert.equal((await h.state()).completed.length, 0)
  assert.equal(h.products.length, 0)
  // Repair capacity, never apply a timestamp cutoff or mark unseen rows done.
  h.config.limits = { pageSize: 10, maxPages: 10 }
  const recovered = await h.pass()
  assert.equal(recovered.ok, true)
  assert.equal(recovered.events.completed, 3)
  assert.equal((await h.state()).completed.length, 3)
})

test('shared budget alternates starting streams after an exhausted pass', async (t) => {
  const h = await harness(t)
  await h.ingest('a')
  h.config.limits.maxRequests = 2
  assert.equal((await h.pass()).reason, 'request-budget')
  assert.equal(h.calls.some(([method]) => method === 'gh'), false)
  const second = await h.pass()
  assert.equal(second.reason, 'request-budget')
  assert.equal(second.requests, 2)
  assert.equal(second.sweeps.ok, true)
  assert.equal(h.calls.filter(([method]) => method === 'gh').length, 2)
  assert.equal(h.products.length, 0)
})

test('runner persists only complete multi-page GitHub snapshots and resumes their drain', async (t) => {
  const h = await harness(t)
  const original = h.run
  let lists = 0
  const reads = []
  h.run = async (file, args, options) => {
    if (String(args[5]).includes('BridgeOpenPullRequests')) {
      lists++
      const last = args.includes('after=page-2')
      return { stdout: JSON.stringify({ data: { repository: { nameWithOwner: repo, pullRequests: {
        totalCount: 2, nodes: [{ number: agentPr.number + (last ? 1 : 0) }],
        pageInfo: { hasNextPage: !last, endCursor: last ? null : 'page-2' },
      } } } }) }
    }
    const number = Number(args.find(arg => arg.startsWith('number=')).slice(7))
    reads.push(number)
    const result = JSON.parse((await original(file, args, options)).stdout)
    const pr = result.data.repository.pullRequest
    pr.number = number
    pr.url = `https://github.com/${repo}/pull/${number}`
    // Unlinked as well as human-authored: S2 resolves by task link, not
    // authorship, so the decoy PR must carry no branch or trailer ref either.
    if (number !== agentPr.number) {
      pr.author = { __typename: 'User', login: 'human' }
      pr.headRefName = 'feature-work'
    }
    return { stdout: JSON.stringify(result) }
  }
  h.config.limits = { maxPages: 1, maxSweepItems: 1 }
  assert.equal((await h.pass()).ok, false)
  await assert.rejects(readFile(join(h.config.stateDirectory, 'sweeps.json')), { code: 'ENOENT' })
  assert.deepEqual(reads, [])
  h.config.limits.maxPages = 2
  const second = await h.pass()
  assert.equal(second.sweeps.deferred, 1)
  assert.equal(h.products.length, 1)
  const saved = JSON.parse(await readFile(join(h.config.stateDirectory, 'sweeps.json'), 'utf8'))
  assert.deepEqual(saved.repos[repo].backfill.refs, [agentPr.number, agentPr.number + 1])
  assert.equal(lists, 3)
  const third = await h.pass()
  assert.equal(third.sweeps.repos[repo].backfill.phase, 'complete')
  assert.deepEqual(reads, [agentPr.number, agentPr.number + 1])
  assert.equal(lists, 3, 'saved snapshot must not re-list the first page')
  assert.equal(h.products.length, 1, 'human PR must not produce a product')
})

test('runner wires real adapters, capture/core/receipts and counts every request across restarts', async (t) => {
  const h = await harness(t)
  await h.ingest('pr'); await h.ingest('suite', 'check_suite')
  const first = await h.pass()
  assert.equal(first.ok, true)
  assert.equal(first.mode, 'products-only-v1')
  assert.equal(first.events.completed, 2)
  assert.equal(first.requests, h.calls.length)
  assert.equal(h.products.length, 1)
  assert.equal(h.products[0].reviewState, 'approved')
  assert.equal((await h.state()).completed.length, 2)
  const second = await h.pass()
  assert.equal(second.events.skipped, 2)
  assert.equal(second.requests, 2)
  assert.equal(h.calls.some(([method, url]) => method !== 'gh' && /comments|wakeup|bridge\/claim/.test(url)), false)
  assert.equal((await readdir(h.config.stateDirectory)).includes('lock'), false)
})

test('request budget spans capture pagination, GitHub and board; no unconfirmed receipts', async (t) => {
  const h = await harness(t)
  await h.ingest('pr')
  // Seven event calls (two scans, body, gh, issue, products, create) then the
  // shared sweep snapshot must not start: backfill and review list through the
  // same gh transport and total budget.
  h.config.limits.maxRequests = 8
  const stopped = await h.pass()
  assert.equal(stopped.ok, false)
  assert.equal(stopped.reason, 'request-budget')
  assert.equal(stopped.requests, 8)
  assert.equal(h.calls.length, 8)
  // A stop during sweeps leaves committed event work receipted, not rolled
  // back; only the unfinished sweep refuses to advance.
  assert.equal(h.products.length, 1)
  assert.equal((await h.state()).completed.length, 1)
  h.config.limits.maxRequests = 9 // exact budget succeeds, no off-by-one false failure
  assert.equal((await h.pass()).ok, true)
  assert.equal(h.products.length, 1)
})

test('incomplete event budget is non-success; persisted successes allow the next batch', async (t) => {
  const h = await harness(t)
  await h.ingest('a'); await h.ingest('b')
  h.config.limits.maxDeliveries = 1
  const first = await h.pass()
  assert.equal(first.reason, 'incomplete')
  assert.equal(first.events.completed, 1)
  assert.equal(first.events.deferred, 1)
  assert.equal((await h.pass()).ok, true)
  assert.equal(h.products.length, 1)
})

test('ambiguous create remains unreceipted and recovers by listing, not blind create retry', async (t) => {
  const h = await harness(t)
  await h.ingest('a'); h.losesCreate = true
  const first = await h.pass()
  assert.equal(first.ok, false)
  assert.equal(first.events.completed, 0)
  assert.equal(h.products.length, 1)
  assert.equal((await h.pass()).ok, true)
  assert.equal(h.products.length, 1)
  assert.equal(h.calls.filter(([method]) => method === 'POST').length, 1)
  assert.equal(JSON.stringify(first).includes(secret), false)
})

test('cycle deadline aborts header and body I/O; lock releases only after settlement', async (t) => {
  for (const phase of ['headers', 'body']) {
    const h = await harness(t)
    const clock = virtualClock()
    h.config.limits.durationMs = 30
    let invoked = 0
    let settled = false
    // Expire the budget once this I/O is in flight, never before it: setImmediate runs
    // after the caller is parked on the header promise or the half-read body.
    const expire = () => setImmediate(() => clock.advance(h.config.limits.durationMs))
    const fetchImpl = async (url, { signal }) => {
      invoked++
      const fail = (reject) => signal.addEventListener('abort', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        assert.ok((await readdir(h.config.stateDirectory)).includes('lock'))
        settled = true; reject(new Error(secret))
      }, { once: true })
      if (phase === 'headers') return new Promise((resolve, reject) => { fail(reject); expire() })
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{'))
        fail((error) => controller.error(error))
        expire()
      } }), { headers: { 'content-type': 'application/json' } })
    }
    const result = await h.pass({ fetchImpl, clock })
    // Without this the pass can expire during its own setup and the settlement
    // assertions below would pass vacuously, on a pass that performed no I/O.
    assert.equal(invoked, 1)
    assert.equal(result.reason, 'deadline')
    assert.equal(result.ok, false)
    assert.equal(settled, true)
    assert.equal((await h.state()).completed.length, 0)
    assert.equal((await readdir(h.config.stateDirectory)).includes('lock'), false)
  }
})

test('cancellation during GitHub settles before release and sends no board request', async (t) => {
  const h = await harness(t)
  await h.ingest('a')
  const controller = new AbortController()
  const run = async (file, args, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error(secret)), { once: true })
    controller.abort()
  })
  assert.equal((await h.pass({ run, signal: controller.signal })).reason, 'cancelled')
  assert.equal(h.products.length, 0)
  assert.equal(h.calls.filter(([, url]) => typeof url === 'string' && url.startsWith(h.config.boardOrigin)).length, 0)
  assert.equal((await h.state()).completed.length, 0)
})

test('pre-cancelled pass does not create state or perform I/O', async (t) => {
  const h = await harness(t)
  assert.equal((await h.pass({ signal: AbortSignal.abort() })).reason, 'cancelled')
  assert.equal(h.calls.length, 0)
  await assert.rejects(h.state(), { code: 'ENOENT' })
})

test('deadline is monotonic, shared across child calls and checked after child completion', async () => {
  let time = 0
  const b = createPassBudget({ maxRequests: 2, durationMs: 1000, now: () => time })
  try {
    await b.run(async (file, args, options) => {
      assert.equal(options.timeout, 1000, 'omitted timeout still has a finite shared deadline')
      return { stdout: '{}' }
    })('gh', [])
    const run = b.run(async (file, args, options) => {
      assert.equal(options.timeout, 600)
      time = 1001
      return { stdout: '{}' }
    })
    time = 400
    await assert.rejects(run('gh', [], { timeout: 30000 }))
    assert.equal(b.snapshot().reason, 'deadline')
    assert.equal(b.snapshot().requests, 2)
    await assert.rejects(b.fetch(() => assert.fail('called'))('https://test', { signal: AbortSignal.abort() }))
  } finally { b.close() }
})

test('native child adapter waits for close after abort, including a SIGTERM-ignoring child', async (t) => {
  const h = await harness(t)
  const pidFile = join(h.root, 'child.pid')
  const controller = new AbortController()
  const script = `require('node:fs').writeFileSync(process.argv[1], String(process.pid));
    process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`
  const child = executeGithub(process.execPath, ['-e', script, pidFile], { encoding: 'utf8', shell: false,
    timeout: 3000, maxBuffer: 4096, signal: controller.signal })
  void child.catch(() => {})
  let pid
  try {
    for (let i = 0; i < 100; i++) {
      try { pid = Number(await readFile(pidFile, 'utf8')); break } catch (error) {
        if (error.code !== 'ENOENT') throw error
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    assert.ok(pid > 0, 'child reached its ready point')
  } finally { controller.abort() }
  let forced = false
  const safety = setTimeout(() => {
    forced = true
    try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }, 2000)
  try {
    await assert.rejects(child)
    assert.equal(forced, false, 'adapter must reap without the test safety kill')
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  } finally { clearTimeout(safety) }
  assert.equal((await executeGithub(process.execPath, ['-e', 'process.stdout.write("ok")'],
    { encoding: 'utf8', shell: false, timeout: 1000, maxBuffer: 4096 })).stdout, 'ok')
})

test('overlapping passes fail closed before I/O; original pass retains ownership', async (t) => {
  const h = await harness(t)
  const original = h.fetch
  let checked = false
  h.fetch = async (...args) => {
    if (!checked) {
      checked = true
      const other = await h.pass({ fetchImpl: () => assert.fail('second owner performed I/O') })
      assert.equal(other.reason, 'cycle-failed')
      assert.equal(other.requests, 0)
    }
    return original(...args)
  }
  assert.equal((await h.pass()).ok, true)
})

test('unsafe modes and unknown/excessive limits refuse without effects', async (t) => {
  for (const value of [{ maxRequests: 0 }, { durationMs: 300001 }, { maxDeliveries: 1.5 },
    { unexpected: 1 }, { maxReceiptBytes: 1 }, null, []]) assert.throws(() => runnerLimits(value))
  const h = await harness(t)
  for (const mode of [undefined, 'full-v1', 'products-only']) {
    h.config.mode = mode
    await assert.rejects(h.pass(), /explicit products-only/)
  }
  assert.equal(h.calls.length, 0)
})

test('config loads private files, canonicalizes paths and never uses token environment variables', async (t) => {
  const h = await harness(t)
  const settings = await loadConsumerConfig(h.configPath)
  assert.equal(settings.captureToken, secret)
  assert.equal(settings.boardToken, secret)
  assert.equal(settings.config.limits.maxRequests, 300)
  const output = []
  const signals = new EventEmitter()
  const status = await main(['events', h.configPath], { signals, env: { PAPERCLIP_RUN_ID: runId,
    PAPERCLIP_API_KEY: 'not-the-host-key', GH_TOKEN: 'not-consumed' }, output: (v) => output.push(JSON.parse(v)),
  pass: async (input, { signal }) => {
    assert.equal(input.runId, runId)
    assert.equal(input.boardToken, secret)
    signals.emit('SIGTERM')
    assert.equal(signal.aborted, true)
    return { ok: false, reason: 'cancelled' }
  } })
  assert.equal(status, 1)
  assert.equal(signals.listenerCount('SIGTERM'), 0)
  assert.deepEqual(output, [{ ok: false, reason: 'cancelled' }])
})

test('config rejects symlinks, public/oversized files, unsafe origins and credentials in config', async (t) => {
  const h = await harness(t)
  for (const patch of [{ mode: 'full-v1' }, { captureOrigin: 'http://capture.test' },
    { boardOrigin: 'https://user:'+secret+'@board.test' }, { token: secret },
    { stateDirectory: h.root }, { version: 2 }, { allowedRepositories: [repo, repo] }]) {
    await writeFile(h.configPath, JSON.stringify({ ...h.config, ...patch }), { mode: 0o600 })
    await assert.rejects(loadConsumerConfig(h.configPath), (e) => !e.message.includes(secret))
  }
  await h.save()
  await chmod(h.config.boardTokenFile, 0o644)
  await assert.rejects(loadConsumerConfig(h.configPath), /invalid/)
  await chmod(h.config.boardTokenFile, 0o600)
  await writeFile(h.config.boardTokenFile, secret.repeat(2000))
  await assert.rejects(loadConsumerConfig(h.configPath), /invalid/)
  await rm(h.config.boardTokenFile)
  await symlink(h.config.captureTokenFile, h.config.boardTokenFile)
  await assert.rejects(loadConsumerConfig(h.configPath), /invalid/)
})

test('CLI exit codes distinguish success, incomplete pass, invalid config and invalid invocation', async () => {
  for (const ok of [true, false]) {
    const output = []
    assert.equal(await main(['events', '/private/config.json'], { load: async () => ({}),
      pass: async () => ({ ok }), output: (v) => output.push(v) }), ok ? 0 : 1)
    assert.deepEqual(output, [JSON.stringify({ ok })])
  }
  const output = []
  assert.equal(await main(['events', '/private/config.json'], { load: async () => { throw new Error(secret) },
    output: (v) => output.push(v) }), 1)
  assert.equal(output.join().includes(secret), false)
  assert.equal(await main(['events', '/path', secret], { load: () => assert.fail('loaded'),
    output: (v) => assert.equal(v.includes(secret), false) }), 2)
})

test('executable fails sanitized and nonzero without config; real config drives an offline pass', async (t) => {
  const exec = promisify(execFile)
  const cli = new URL('../src/consumer-cli.js', import.meta.url).pathname
  await assert.rejects(exec(process.execPath, [cli, 'events', '/nonexistent/'+secret]), (e) => {
    assert.equal(e.code, 1)
    assert.equal(e.stderr, '')
    assert.equal(e.stdout.includes(secret), false)
    return true
  })
  const h = await harness(t)
  await h.ingest('a')
  const output = []
  assert.equal(await main(['events', h.configPath], { output: (v) => output.push(JSON.parse(v)),
    env: {}, pass: (input) => runProductPass(input, { fetchImpl: h.fetch, run: h.run }) }), 0)
  assert.equal(output[0].events.completed, 1)
})
