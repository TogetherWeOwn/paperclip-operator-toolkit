// Turn a verified delivery into the row that gets appended to the store.
//
// Nothing in here decides whether to accept a delivery — by the time this runs
// the signature has already passed. Its only job is to extract the handful of
// fields worth indexing, and to do that WITHOUT ever letting a parse failure
// discard the payload: a body that is signed but malformed is still a real
// delivery and still belongs in the store, with null columns and the raw bytes
// intact.

import { sha256Hex } from './verify.js'

// D1 rejects oversized values, and a `push` to a repo with a large diff can
// carry a payload well past anything worth putting in a row. Bodies above this
// are stored truncated with `body_truncated = 1`; `body_sha256` and
// `body_bytes` always describe the FULL body, so a truncated row can still be
// matched against a complete copy from elsewhere.
export const MAX_STORED_BODY_BYTES = 768 * 1024

// GitHub's own documented ceiling for a webhook payload. Anything larger did
// not come from GitHub; refuse it before spending a HMAC on it.
export const MAX_ACCEPTED_BODY_BYTES = 25 * 1024 * 1024

// Headers worth keeping. Deliberately an allowlist: `Authorization` and cookies
// must never reach the store, and an allowlist cannot be widened by accident
// the way a denylist can.
const KEPT_HEADERS = [
  'x-github-event',
  'x-github-delivery',
  'x-github-hook-id',
  'x-github-hook-installation-target-id',
  'x-github-hook-installation-target-type',
  'content-type',
  'user-agent',
]

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function str(v) {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * @param {unknown} v
 * @returns {number | null}
 */
function int(v) {
  return Number.isInteger(v) ? /** @type {number} */ (v) : null
}

/**
 * Build the stored record for a delivery whose signature has already verified.
 *
 * @param {object} args
 * @param {Uint8Array} args.bodyBytes    raw body, exactly as received
 * @param {Headers} args.headers         request headers
 * @param {string} args.signature        the `X-Hub-Signature-256` value that verified
 * @param {number} args.receivedMs       receipt time, epoch ms
 * @returns {Promise<object>} a row ready for `store.append()`
 */
export async function buildRecord({ bodyBytes, headers, signature, receivedMs }) {
  const bodySha256 = await sha256Hex(bodyBytes)
  const truncated = bodyBytes.length > MAX_STORED_BODY_BYTES
  const kept = truncated ? bodyBytes.subarray(0, MAX_STORED_BODY_BYTES) : bodyBytes

  // Non-fatal decoding: a truncation can land mid-codepoint and produce U+FFFD.
  // That is a cosmetic wound on a row already flagged `body_truncated`, and it
  // is strictly better than throwing away a delivery we can never get again.
  const body = new TextDecoder('utf-8', { fatal: false }).decode(kept)

  /** @type {any} */
  let parsed = null
  if (!truncated) {
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = null // signed but unparseable — keep the bytes, index nothing
    }
  }

  /** @type {Record<string, string>} */
  const headerSubset = {}
  for (const name of KEPT_HEADERS) {
    const v = headers.get(name)
    if (v !== null) headerSubset[name] = v
  }

  return {
    delivery_id: headers.get('x-github-delivery') ?? '',
    event: headers.get('x-github-event') ?? '',
    received_ms: receivedMs,
    received_at: new Date(receivedMs).toISOString(),

    action: parsed ? str(parsed.action) : null,
    sender: parsed?.sender ? str(parsed.sender.login) : null,
    repository: parsed?.repository ? str(parsed.repository.full_name) : null,
    organization: parsed?.organization ? str(parsed.organization.login) : null,
    installation_id: parsed?.installation ? int(parsed.installation.id) : null,

    hook_id: headers.get('x-github-hook-id'),
    target_type: headers.get('x-github-hook-installation-target-type'),

    // The signature is an HMAC, not a secret: it cannot be reversed into the
    // shared secret, and keeping it is what makes the store re-verifiable.
    signature,
    body_sha256: bodySha256,
    body_bytes: bodyBytes.length,
    body_truncated: truncated ? 1 : 0,
    body,
    headers_json: JSON.stringify(headerSubset),
  }
}
