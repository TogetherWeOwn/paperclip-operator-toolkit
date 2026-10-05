// GitHub webhook signature verification.
//
// The receiver's URL is public by construction — GitHub has to be able to reach
// it, so anyone else can too. Signature verification is therefore the ONLY thing
// separating a real delivery from a forged one. Every path through this module
// that does not end in `{ ok: true }` must end in a rejection; there is no
// "accept on doubt" branch and one must never be added.
//
// Default-is-refusal: the function
// returns a rejection for every input shape it does not explicitly recognise,
// including the case where no secret is configured at all. An unconfigured
// deployment rejects everything rather than storing unverified bytes.

export const SIGNATURE_HEADER = 'x-hub-signature-256'
export const DELIVERY_HEADER = 'x-github-delivery'
export const EVENT_HEADER = 'x-github-event'

const PREFIX = 'sha256='
const HEX_64 = /^[0-9a-f]{64}$/

// Rejection reasons. These are stable identifiers, not prose: the rejection
// counters and authenticated API consumers are keyed on them,
// so rewording one is a breaking change. Assert on these, never on a message.
export const REJECT = {
  NO_SECRET: 'secret_unconfigured',
  MISSING: 'signature_missing',
  MALFORMED: 'signature_malformed',
  MISMATCH: 'signature_mismatch',
}

/**
 * Compare two equal-length byte sequences without leaking the position of the
 * first difference through timing.
 *
 * Prefers the runtime's own primitive (`crypto.subtle.timingSafeEqual` exists on
 * workerd) and falls back to an XOR accumulator that always visits every byte.
 * The fallback is best-effort — JS gives no hard guarantee — which is why the
 * caller only ever reaches it with two 32-byte digests of a *validated* hex
 * string, so length is never itself a signal.
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false
  const subtle = globalThis.crypto?.subtle
  if (subtle && typeof subtle.timingSafeEqual === 'function') {
    return subtle.timingSafeEqual(a, b)
  }
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/**
 * Decode exactly 64 lowercase hex characters into 32 bytes.
 * Returns null for anything else — strictness here is what keeps
 * `timingSafeEqual` from ever seeing a length mismatch.
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
 * Verify an `X-Hub-Signature-256` header against the raw request body.
 *
 * The body MUST be the bytes exactly as received. Re-serialising the JSON —
 * even `JSON.stringify(JSON.parse(body))` — changes the digest and every
 * delivery starts failing, which is a debugging afternoon nobody needs.
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

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, body))

  return timingSafeEqual(expected, provided) ? { ok: true } : { ok: false, reason: REJECT.MISMATCH }
}

/**
 * Hex-encoded SHA-256 of the raw body. Stored on every record so a truncated
 * row still identifies which payload it was, and so the store can be
 * re-verified end to end later against the original raw bytes and signature.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  let out = ''
  for (const b of digest) out += b.toString(16).padStart(2, '0')
  return out
}
