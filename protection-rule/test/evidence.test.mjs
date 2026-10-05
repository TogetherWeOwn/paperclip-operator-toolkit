// Offline suite for plan-artifact evidence.
//
// No credentials, no network. The GitHub reader is a stub scripted per test;
// the zip bytes come from the shared fixture builder, which shares no code
// with the reader. Assertions pin the verified triple or the throw — never
// message text. The rows that carry this suite:
//
//   * a manifest whose bytes digest to the claimed hash verifies;
//   * a manifest whose bytes digest elsewhere is refused even when its
//     embedded field names the claimed hash (bytes bind, not fields);
//   * a plan run on another commit is refused;
//   * a missing manifest artifact is refused;
//   * a manifest whose embedded field contradicts its bytes is refused;
//   * a manifest with no digest field still verifies when bytes match;
//   * two JSON documents in one archive refuse as ambiguous;
//   * a claim step that is absent reads as no claim, never a default.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractManifest, verifyPlan, readApplyClaim, sha256Hex,
  PLAN_ARTIFACT_NAME } from '../src/evidence.js'
import { zipOf, zipOfTexts } from './zip-fixture.mjs'
import { PLAN_POLICY, TRUSTED_CONFIG } from './trusted-fixture.mjs'
const REPOSITORY = PLAN_POLICY.repository
const reviewedPlanRepositories = TRUSTED_CONFIG.reviewedPlanRepositories

const HEAD = 'a'.repeat(40)
const OTHER_HEAD = 'e'.repeat(40)
const PLAN_RUN_ID = 101
const APPLY_RUN_ID = 777
const DOWNLOAD_URL = 'https://api.github.com/dl/zip'

async function digest(text) {
  return sha256Hex(new TextEncoder().encode(text))
}

function reader({ planHead = HEAD, manifestText = null, manifestName = PLAN_ARTIFACT_NAME, jobsName = null, jobsNull = false } = {}) {
  const zip = manifestText === null ? null : zipOf(manifestText)
  return {
    async getRun(repository, runId) {
      assert.equal(repository, REPOSITORY)
      if (runId === PLAN_RUN_ID) return { id: runId, headSha: planHead, event: 'workflow_dispatch', htmlUrl: 'https://x' }
      throw new Error('unexpected run read')
    },
    async listArtifacts(repository, runId) {
      assert.equal(repository, REPOSITORY)
      assert.equal(runId, PLAN_RUN_ID)
      if (manifestText === null) return []
      return [{ id: 9, name: manifestName, expired: false, downloadUrl: DOWNLOAD_URL }]
    },
    async downloadBytes(url, maxBytes) {
      assert.equal(url, DOWNLOAD_URL)
      assert.ok(maxBytes > 0)
      return zip
    },
    async api(path) {
      assert.ok(path.includes(`/actions/runs/${APPLY_RUN_ID}/jobs`))
      if (jobsNull) return { status: 200, json: async () => ({ jobs: [] }) }
      return { status: 200, json: async () => ({ jobs: [{ steps: [{ name: jobsName }] }] }) }
    },
  }
}

test('bytes matching the claim verify', async () => {
  const bodyText = JSON.stringify({ nonce: 'fixed-bytes' })
  const claimed = await digest(bodyText)
  const text = JSON.stringify({ plan_manifest_sha256: claimed, nonce: 'fixed-bytes' })
  // The embedded field documents the digest but the bytes differ by
  // construction; verification binds bytes-digest == claimed, so serve the
  // body bytes whose digest the claim carries with the digest alongside.
  void text
  const documented = bodyText
  const github = reader({ manifestText: documented })
  const plan = await verifyPlan({ github, reviewedPlanRepositories, repository: REPOSITORY, planRunId: PLAN_RUN_ID, claimedHash: claimed, applyHeadSha: HEAD })
  assert.deepEqual(plan, { runId: PLAN_RUN_ID, headSha: HEAD, manifestSha256: claimed })
})

test('embedded field naming the claim does not override bytes', async () => {
  // The manifest NAMES the claimed hash but its BYTES digest elsewhere: the
  // bytes bind, so verification refuses. (Claimed hash is the digest of
  // different bytes; the embedded field is a liar.)
  const otherBytes = new TextEncoder().encode(JSON.stringify({ nonce: 'other-bytes' }))
  const claimed = await sha256Hex(otherBytes)
  const text = JSON.stringify({ plan_manifest_sha256: claimed, nonce: 'these-bytes-differ' })
  const github = reader({ manifestText: text })
  await assert.rejects(
    verifyPlan({ github, reviewedPlanRepositories, repository: REPOSITORY, planRunId: PLAN_RUN_ID, claimedHash: claimed, applyHeadSha: HEAD }),
  )
})

test('plan on another commit is refused', async () => {
  const text = JSON.stringify({ nonce: 'fixed-bytes' })
  const claimed = await digest(text)
  const github = reader({ manifestText: text, planHead: OTHER_HEAD })
  await assert.rejects(
    verifyPlan({ github, reviewedPlanRepositories, repository: REPOSITORY, planRunId: PLAN_RUN_ID, claimedHash: claimed, applyHeadSha: HEAD }),
  )
})

test('missing manifest artifact is refused', async () => {
  const text = JSON.stringify({ nonce: 'fixed-bytes' })
  const claimed = await digest(text)
  const github = reader({ manifestText: null })
  await assert.rejects(
    verifyPlan({ github, reviewedPlanRepositories, repository: REPOSITORY, planRunId: PLAN_RUN_ID, claimedHash: claimed, applyHeadSha: HEAD }),
  )
})

test('wrong artifact name is refused', async () => {
  const text = JSON.stringify({ nonce: 'fixed-bytes' })
  const claimed = await digest(text)
  const github = reader({ manifestText: text, manifestName: 'other-name.json' })
  await assert.rejects(
    verifyPlan({ github, reviewedPlanRepositories, repository: REPOSITORY, planRunId: PLAN_RUN_ID, claimedHash: claimed, applyHeadSha: HEAD }),
  )
})

test('contradictory embedded field is refused', async () => {
  const text = JSON.stringify({ plan_manifest_sha256: 'f'.repeat(64), nonce: 'fixed-bytes' })
  const claimed = await digest(text) // bytes digest, not the embedded lie
  const github = reader({ manifestText: text })
  await assert.rejects(
    verifyPlan({ github, reviewedPlanRepositories, repository: REPOSITORY, planRunId: PLAN_RUN_ID, claimedHash: claimed, applyHeadSha: HEAD }),
  )
})

test('manifest without a digest field verifies on bytes alone', async () => {
  const documented = JSON.stringify({ nonce: 'no-digest-field', plan: 'fixture-plan' })
  const claimed = await digest(documented)
  const github = reader({ manifestText: documented })
  const plan = await verifyPlan({ github, reviewedPlanRepositories, repository: REPOSITORY, planRunId: PLAN_RUN_ID, claimedHash: claimed, applyHeadSha: HEAD })
  assert.equal(plan.manifestSha256, claimed)
})

test('two JSON documents refuse as ambiguous', async () => {
  const zip = zipOfTexts([JSON.stringify({ a: 1 }), JSON.stringify({ b: 2 })])
  assert.throws(() => extractManifest(zip))
})

test('claim marker on the apply job reads the binding', async () => {
  const claimed = 'b'.repeat(64)
  const github = reader({ jobsName: `migrate-plan-binding: sha256=${claimed} run=${PLAN_RUN_ID}` })
  assert.deepEqual(
    await readApplyClaim({ github, reviewedPlanRepositories, repository: REPOSITORY, applyRunId: APPLY_RUN_ID }),
    { planManifestSha256: claimed, planRunId: PLAN_RUN_ID },
  )
})

test('absent claim marker reads as no claim', async () => {
  const github = reader({ jobsNull: true })
  assert.equal(await readApplyClaim({ github, reviewedPlanRepositories, repository: REPOSITORY, applyRunId: APPLY_RUN_ID }), null)
})

test('foreign repository never reaches the reader', async () => {
  const github = reader({})
  await assert.rejects(readApplyClaim({ github, reviewedPlanRepositories, repository: 'SomeoneElse/other', applyRunId: APPLY_RUN_ID }))
  await assert.rejects(verifyPlan({
    github, reviewedPlanRepositories, repository: 'SomeoneElse/other', planRunId: PLAN_RUN_ID,
    claimedHash: 'b'.repeat(64), applyHeadSha: HEAD,
  }))
})

// This reader deliberately accepts ANY repository and serves valid evidence.
// Gate-deletion mutants must fail an assertion, not a stub's incidental error.
async function permissiveEvidence() {
  const text = JSON.stringify({ fixture: 'scope-control' })
  const claimedHash = await digest(text)
  let calls = 0
  return {
    claimedHash,
    calls: () => calls,
    github: {
      async getRun() { calls++; return { id: PLAN_RUN_ID, headSha: HEAD } },
      async listArtifacts() { calls++; return [{ name: PLAN_ARTIFACT_NAME, downloadUrl: DOWNLOAD_URL }] },
      async downloadBytes() { calls++; return zipOf(text) },
      async api() {
        calls++
        return Response.json({ jobs: [{ steps: [{ name: `migrate-plan-binding: sha256=${claimedHash} run=${PLAN_RUN_ID}` }] }] })
      },
    },
  }
}
test('unconfigured reviewed plan scope cannot authorize evidence or reach a reader', async () => {
  for (const scope of [undefined, null, [], 'caller-selected', ['invalid']]) {
    const fixture = await permissiveEvidence()
    await assert.rejects(verifyPlan({
      github: fixture.github, repository: REPOSITORY, reviewedPlanRepositories: scope,
      planRunId: PLAN_RUN_ID, claimedHash: fixture.claimedHash, applyHeadSha: HEAD,
    }), { name: 'Error' }, 'unconfigured scope must not establish verified plan')
    await assert.rejects(readApplyClaim({
      github: fixture.github, repository: REPOSITORY, reviewedPlanRepositories: scope, applyRunId: APPLY_RUN_ID,
    }), { name: 'Error' }, 'unconfigured scope must not establish apply claim')
    assert.equal(fixture.calls(), 0, 'missing scope must refuse before evidence reads')
  }
})
test('foreign repository cannot authorize even with otherwise valid evidence', async () => {
  const fixture = await permissiveEvidence()
  await assert.rejects(verifyPlan({
    github: fixture.github, repository: 'ForeignOrg/unreviewed', reviewedPlanRepositories,
    planRunId: PLAN_RUN_ID, claimedHash: fixture.claimedHash, applyHeadSha: HEAD,
  }), { name: 'Error' }, 'foreign repository must not yield a verified plan')
  await assert.rejects(readApplyClaim({
    github: fixture.github, repository: 'ForeignOrg/unreviewed', reviewedPlanRepositories, applyRunId: APPLY_RUN_ID,
  }), { name: 'Error' }, 'foreign repository must not yield an apply claim')
  assert.equal(fixture.calls(), 0, 'foreign repository must refuse before evidence reads')
})
test('malformed or zero-run claim markers cannot establish a binding', async () => {
  const malformed = reader({ jobsName: `migrate-plan-binding: sha256=short run=${PLAN_RUN_ID}` })
  assert.equal(await readApplyClaim({ github: malformed, repository: REPOSITORY, reviewedPlanRepositories, applyRunId: APPLY_RUN_ID }), null)
  const zeroRun = reader({ jobsName: `migrate-plan-binding: sha256=${'b'.repeat(64)} run=0` })
  await assert.rejects(readApplyClaim({ github: zeroRun, repository: REPOSITORY, reviewedPlanRepositories, applyRunId: APPLY_RUN_ID }))
})
test('compressed, encrypted or descriptor ZIP entries remain refused', () => {
  for (const [field, value] of [[10, 8], [8, 1], [8, 8]]) {
    const zip = zipOf(JSON.stringify({ fixture: 'archive-control' }))
    const view = new DataView(zip.buffer)
    const end = zip.length - 22
    const central = view.getUint32(end + 16, true)
    view.setUint16(central + field, value, true)
    assert.throws(() => extractManifest(zip))
  }
})
test('claimed bytes digest mismatch refuses a manifest without an embedded field', async () => {
  const github = reader({ manifestText: JSON.stringify({ fixture: 'different-content' }) })
  await assert.rejects(verifyPlan({
    github, repository: REPOSITORY, reviewedPlanRepositories,
    planRunId: PLAN_RUN_ID, claimedHash: 'b'.repeat(64), applyHeadSha: HEAD,
  }), { name: 'Error' }, 'bytes digest must bind the claimed hash independently of embedded fields')
})
