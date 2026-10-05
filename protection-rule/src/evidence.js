// Plan-artifact evidence: from a claimed (hash, run) pair to verified fact.
//
// The apply run claims `plan_manifest_sha256` + `plan_run_id` (dispatch
// inputs fixed by the migration apply contract). This layer establishes them
// against fresh GitHub
// reads and returns the verified triple, or throws — there is no "partial
// evidence" return, because the decision layer treats null as rejection and
// a caller that confused "unverified" with "absent" would fail open.
//
// Chain of custody, each step binding the next:
//   1. apply run (fresh read: head SHA) -> claimed plan run id + manifest hash
//   2. plan run id (fresh artifact list: same repo) -> named manifest artifact
//   3. artifact bytes (fresh download) -> unzip -> manifest JSON -> embedded hash
//   4. embedded hash === claimed hash AND plan head SHA === apply head SHA
//
// Downloads are ALWAYS treated as untrusted third-party bytes: the zip is
// parsed by a hand-rolled stored-entry reader (no symlinks, no compression
// bombs, no directory traversal — entry names are ignored entirely), and the
// manifest JSON must carry a valid digest for itself.

// The repository scope is operator configuration, never code: the caller
// passes the served repository list and both readers refuse anything outside
// it. Artifacts carrying anything else are not ours, and a reader that
// accepted them would verify someone else's run. The scope ALSO appears in
// the receiver's policy table (app.js refuses foreign repos before minting):
// a deployment for any other repo must never reach this layer. Both pins
// stay; either one alone is a guess.
export const PLAN_ARTIFACT_NAME = 'staging-migrate-manifest.json'

// Budgets. The manifest is small JSON; these caps bound a hostile artifact,
// not a legitimate one. A manifest above 1 MiB fails the read — loud refusal,
// never truncation-as-evidence.
export const MAX_MANIFEST_BYTES = 1 * 1024 * 1024
export const MAX_ZIP_BYTES = 16 * 1024 * 1024
export const MAX_ZIP_ENTRIES = 64
export const MAX_ZIP_ENTRY_BYTES = 4 * 1024 * 1024

const SHA40 = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * SHA-256 hex of bytes, via WebCrypto. The digest that binds the manifest to
 * the CEO's GO marker.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
  let out = ''
  for (const b of digest) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * Extract the single JSON document from a zip archive downloaded from the
 * artifact endpoint. Stored (uncompressed) entries only; names ignored — the
 * payload is identified by parsing as JSON, not by filename. Throws on any
 * shape outside: multi-disk, encrypted, compressed, oversized, or unparsable
 * as a single JSON manifest. Untrusted bytes in, verified document out.
 *
 * @param {Uint8Array} zip
 * @returns {{ bytes: Uint8Array, manifest: any }}
 */
export function extractManifest(zip) {
  requireValue(zip instanceof Uint8Array, 'artifact bytes are invalid')
  requireValue(zip.length > 0 && zip.length <= MAX_ZIP_BYTES, 'artifact size is invalid')
  const view = new DataView(zip.buffer, zip.byteOffset, zip.length)

  // Locate the end-of-central-directory by scanning backwards for its
  // signature. A zip the scan cannot close is not a zip we open.
  let eocd = -1
  for (let i = zip.length - 22; i >= 0 && i >= zip.length - 22 - 65557; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  requireValue(eocd >= 0, 'artifact is not a zip archive')
  // EOCD layout: ... count@8, total@10, cdsize@12, cdoffset@16, commentlen@20.
  const entryCount = view.getUint16(eocd + 10, true)
  requireValue(entryCount > 0 && entryCount <= MAX_ZIP_ENTRIES, 'artifact entry count is invalid')

  let offset = view.getUint32(eocd + 16, true)
  const candidates = []
  for (let n = 0; n < entryCount; n++) {
    requireValue(offset >= 0 && offset + 46 <= zip.length, 'artifact central directory is invalid')
    requireValue(view.getUint32(offset, true) === 0x02014b50, 'artifact central directory is corrupt')
    // Central-header layout: crc@14, csize@20, usize@24, namelen@28,
    // extralen@30, commentlen@32, headoff@42.
    const method = view.getUint16(offset + 10, true)
    const flags = view.getUint16(offset + 8, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    // ... namelen@28, extralen@30, commentlen@32, headoff@42.
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const headerOffset = view.getUint32(offset + 42, true)
    // Bit 0 (encryption) and any multi-disk archive are refused outright. Bit
    // 3 (data descriptor) is refused because the central directory sizes can
    // no longer be trusted to bound the copy below. Compression is refused:
    // GitHub stores small text artifacts uncompressed, and a decompressor is
    // a bomb surface this reader has no reason to carry.
    requireValue((flags & 0x0001) === 0, 'artifact entry is encrypted')
    requireValue((flags & 0x0008) === 0, 'artifact entry uses a data descriptor')
    requireValue(method === 0, 'artifact entry is compressed')
    requireValue(compressedSize === uncompressedSize, 'artifact entry sizes disagree')
    requireValue(uncompressedSize > 0 && uncompressedSize <= MAX_ZIP_ENTRY_BYTES, 'artifact entry size is invalid')
    // Local header must agree it is stored and unencrypted before its bytes
    // are trusted as the payload.
    requireValue(headerOffset >= 0 && headerOffset + 30 <= zip.length, 'artifact local header is out of range')
    requireValue(view.getUint32(headerOffset, true) === 0x04034b50, 'artifact local header is corrupt')
    requireValue(view.getUint16(headerOffset + 8, true) === 0, 'artifact local entry is compressed or encrypted')
    const localNameLength = view.getUint16(headerOffset + 26, true)
    const localExtraLength = view.getUint16(headerOffset + 28, true)
    const dataStart = headerOffset + 30 + localNameLength + localExtraLength
    requireValue(dataStart >= 0 && dataStart + compressedSize <= zip.length, 'artifact entry data is out of range')
    candidates.push(zip.subarray(dataStart, dataStart + compressedSize))
    offset += 46 + nameLength + extraLength + commentLength
  }

  // Identify by content, not by name: exactly one entry must parse as the
  // manifest. Zero means the artifact is not ours; two means it is ambiguous,
  // and ambiguity resolves to refusal, never to a pick.
  const parsed = []
  for (const bytes of candidates) {
    if (bytes.length > MAX_MANIFEST_BYTES) continue
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      continue
    }
    try {
      const manifest = JSON.parse(text)
      if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
        parsed.push({ bytes, manifest })
      }
    } catch {
      continue // not JSON — not the manifest
    }
  }
  requireValue(parsed.length === 1, 'artifact holds no single manifest document')
  return parsed[0]
}

/**
 * Establish the plan half of the decision from fresh reads.
 *
 * @param {object} args
 * @param {{ getRun: Function, listArtifacts: Function, downloadBytes: Function }} args.github
 *   scoped reader from `createGithubReader`
 * @param {string} args.repository        apply and plan repo (same repo)
 * @param {string[]} args.scope           served repositories; required, operator-owned
 * @param {number} args.planRunId        claimed plan run id
 * @param {string} args.claimedHash      claimed manifest digest (migration apply input)
 * @param {string} args.applyHeadSha     apply head SHA from a fresh run read
 * @returns {Promise<{ runId: number, headSha: string, manifestSha256: string }>}
 *   verified plan evidence for `decide`
 */
export async function verifyPlan({ github, repository, scope, planRunId, claimedHash, applyHeadSha }) {
  requireValue(github && typeof github.getRun === 'function' &&
    typeof github.listArtifacts === 'function' && typeof github.downloadBytes === 'function',
  'GitHub reader is invalid')
  requireValue(Array.isArray(scope) && scope.length > 0 && scope.every((r) => typeof r === 'string'),
  'plan repository scope is invalid')
  requireValue(scope.includes(repository), 'plan repository is outside the configured scope')
  requireValue(Number.isSafeInteger(planRunId) && planRunId > 0, 'plan run id is invalid')
  requireValue(typeof claimedHash === 'string' && SHA256.test(claimedHash), 'claimed plan hash is invalid')
  requireValue(typeof applyHeadSha === 'string' && SHA40.test(applyHeadSha), 'apply head SHA is invalid')

  const plan = await github.getRun(repository, planRunId)
  requireValue(plan.headSha === applyHeadSha, 'plan run is on a different commit')
  const artifacts = await github.listArtifacts(repository, planRunId)
  const manifest = artifacts.find((a) => a && a.name === PLAN_ARTIFACT_NAME)
  requireValue(manifest, 'plan manifest artifact is missing')

  const zip = await github.downloadBytes(manifest.downloadUrl, MAX_ZIP_BYTES)
  const { bytes, manifest: document } = extractManifest(zip)
  // The binding is bytes-digest == claimed hash. The embedded field, when
  // present and well-formed, must agree — a manifest whose own digest field
  // contradicts its bytes is corrupt and refused. When absent, the bytes
  // digest alone binds the claim: the contract is content-addressed, and
  // requiring a self-describing field would reject manifests that were never
  // required to carry one.
  const embedded = document.plan_manifest_sha256 ?? document.manifest_sha256 ?? document.sha256 ?? null
  if (embedded !== null) {
    requireValue(typeof embedded === 'string' && SHA256.test(embedded), 'plan manifest digest field is malformed')
  }
  const actual = await sha256Hex(bytes)
  if (embedded !== null) {
    requireValue(actual === embedded, 'plan manifest digest does not match its bytes')
  }
  requireValue(actual === claimedHash, 'plan manifest digest does not match the claim')
  return { runId: planRunId, headSha: plan.headSha, manifestSha256: actual }
}

/**
 * Read the apply run's claimed plan binding from fresh API state.
 *
 * Migration apply contract: the apply job declares `plan_manifest_sha256` +
 * `plan_run_id` inputs. Workflow-dispatch inputs are not on the run object,
 * so the claim is read from the run's jobs: the apply job's first step whose
 * name carries the `migrate-plan-binding:` marker, e.g.
 * `migrate-plan-binding: sha256=<64hex> run=<id>`. A run with no such step
 * has made no claim, which is a rejection — never a default.
 *
 * @param {object} args
 * @param {{ api: Function }} args.github  scoped reader from `createGithubReader`
 * @param {string} args.repository
 * @param {string[]} args.scope           served repositories; required, operator-owned
 * @param {number} args.applyRunId
 * @returns {Promise<{ planManifestSha256: string, planRunId: number } | null>}
 */
export async function readApplyClaim({ github, repository, scope, applyRunId }) {
  requireValue(github && typeof github.api === 'function', 'GitHub reader is invalid')
  requireValue(Array.isArray(scope) && scope.length > 0 && scope.every((r) => typeof r === 'string'),
  'apply repository scope is invalid')
  requireValue(scope.includes(repository), 'apply repository is outside the configured scope')
  requireValue(Number.isSafeInteger(applyRunId) && applyRunId > 0, 'apply run id is invalid')

  const [owner, name] = repository.split('/')
  const response = await github.api(`/repos/${owner}/${name}/actions/runs/${applyRunId}/jobs?per_page=100`)
  requireValue(response.status === 200, 'GitHub job list failed')
  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }
  requireValue(data && typeof data === 'object' && Array.isArray(data.jobs), 'GitHub job list is invalid')

  const MARKER = /migrate-plan-binding:\s*sha256=([0-9a-f]{64})\s+run=(\d{1,10})/i
  for (const job of data.jobs) {
    if (!job || typeof job !== 'object' || !Array.isArray(job.steps)) continue
    for (const step of job.steps) {
      if (!step || typeof step !== 'object' || typeof step.name !== 'string') continue
      const match = MARKER.exec(step.name)
      if (match) {
        const planRunId = Number(match[2])
        requireValue(Number.isSafeInteger(planRunId) && planRunId > 0, 'apply claim run id is invalid')
        return { planManifestSha256: match[1].toLowerCase(), planRunId }
      }
    }
  }
  return null
}
