// Webhook signature verification for the protection-rule endpoint.
//
// The receiver's URL is public by construction — GitHub has to reach it, so
// anyone else can too. Signature verification is therefore the ONLY thing
// separating a real delivery from a forged approval. Every path through this
// module that does not end in `{ ok: true }` ends in a rejection; there is no
// "accept on doubt" branch and one must never be added.
//
// Default-is-refusal: the function rejects every input shape it does not
// explicitly recognise, including a missing secret. An unconfigured deployment
// rejects everything rather than approving unverified deployments.

export const SIGNATURE_HEADER = 'x-hub-signature-256'
export const DELIVERY_HEADER = 'x-github-delivery'
export const EVENT_HEADER = 'x-github-event'

const PREFIX = 'sha256='
const HEX_64 = /^[0-9a-f]{64}$/

// Rejection reasons. Stable identifiers, not prose: operators match on them,
// so rewording one is a breaking change. Assert on these, never on a message.
export const REJECT = {
  NO_SECRET: 'secret_unconfigured',
  MISSING: 'signature_missing',
  MALFORMED: 'signature_malformed',
  MISMATCH: 'signature_mismatch',
}

/**
 * Compare two equal-length byte sequences without leaking the position of the
 * first difference through timing. Falls back to an XOR accumulator that
 * always visits every byte. The caller only ever reaches it with two 32-byte
 * digests of a validated hex string, so length is never itself a signal.
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/**
 * Decode exactly 64 lowercase hex characters into 32 bytes. Returns null for
 * anything else — strictness here keeps `timingSafeEqual` from ever seeing a
 * length mismatch.
 *
 * @param {string} hex
 * @returns {Uint8Array | null}
 */
function decodeHex64(hex) {
  if (!HEX_64.test(hex)) return null
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

/**
 * Verify an `X-Hub-Signature-256` header against the raw request body. The body
 * MUST be the bytes exactly as received: re-serialising the JSON changes the
 * digest and every delivery starts failing.
 *
 * @param {object} args
 * @param {string | undefined | null} args.secret   shared secret from App settings
 * @param {Uint8Array} args.body                    raw request body bytes
 * @param {string | undefined | null} args.header   the header value as sent
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function verifySignature({ secret, body, header }) {
  if (typeof secret !== 'string' || secret.length === 0) {
    return { ok: false, reason: REJECT.NO_SECRET }
  }
  if (typeof header !== 'string' || header.length === 0) {
    return { ok: false, reason: REJECT.MISSING }
  }
  if (!header.startsWith(PREFIX)) {
    return { ok: false, reason: REJECT.MALFORMED }
  }
  const provided = decodeHex64(header.slice(PREFIX.length).toLowerCase())
  if (provided === null) {
    return { ok: false, reason: REJECT.MALFORMED }
  }

  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const expected = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, body))

  return timingSafeEqual(expected, provided) ? { ok: true } : { ok: false, reason: REJECT.MISMATCH }
}
