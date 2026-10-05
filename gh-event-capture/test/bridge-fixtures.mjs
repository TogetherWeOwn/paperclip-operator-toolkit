import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'

export const repository = { full_name: 'example-owner/project' }
export const agentPr = {
  number: 42,
  html_url: 'https://github.com/example-owner/project/pull/42',
  user: { type: 'Bot', login: 'capture-agent[bot]' },
  head: { ref: 'task-3552-bridge', sha: 'abc123' },
  base: { repo: repository },
  draft: false,
}

export async function ingest(app, event, id, payload, secret = 'test') {
  const body = JSON.stringify(payload)
  const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
  const res = await app(new Request('https://capture.test/gh/webhook', {
    method: 'POST',
    headers: { 'x-github-event': event, 'x-github-delivery': id, 'x-hub-signature-256': signature },
    body,
  }))
  assert.equal(res.status, 200)
  assert.equal((await res.json()).stored, true)
}

// Seed real signed deliveries for a claim, including independent author evidence
// for the slim PR references in a check_suite delivery.
export async function seedClaim(app, claim, secret = 'test') {
  const pr = { ...agentPr, head: { ref: claim.issue_ref.toLowerCase() + '-bridge', sha: claim.head_sha },
    html_url: claim.pr_url ?? agentPr.html_url }
  if (claim.pr_url) {
    const url = new URL(claim.pr_url)
    const match = /^\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)$/.exec(url.pathname)
    assert.ok(url.origin === 'https://github.com' && match, 'fixture requires a canonical synthetic PR URL')
    pr.number = Number(match[2])
    pr.base = { repo: { full_name: match[1] } }
  }
  if (claim.kind === 'check_suite_completed') {
    claim.pr_delivery_id = claim.delivery_id + '-pr'
    await ingest(app, 'pull_request', claim.pr_delivery_id, { action: 'opened', repository, pull_request: pr }, secret)
    await ingest(app, 'check_suite', claim.delivery_id, {
      action: 'completed', repository,
      check_suite: { status: 'completed', head_sha: claim.head_sha, pull_requests: [{ number: pr.number }] },
    }, secret)
  } else {
    const action = claim.action ?? 'closed'
    await ingest(app, 'pull_request', claim.delivery_id, {
      action, repository, pull_request: { ...pr, merged: action === 'closed' },
    }, secret)
  }
}
