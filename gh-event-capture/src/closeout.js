// PR closeout v2: pure exception classifier.
//
// No I/O. This module turns ONE authoritative snapshot of a pull request, read
// from GitHub at flush time, into at most one exception class. Webhook
// deliveries are only hints that a snapshot is due; they never reach this file.
// That is what makes lost, duplicated and reordered deliveries cost latency and
// not correctness.
//
// SILENT ON THE HAPPY PATH, LOUD ON A MALFORMED SNAPSHOT. Open, pending, green,
// armed and re-run all resolve to `null`: nothing wakes the owning task. A
// snapshot this module cannot trust throws, because a swallowed bad read would
// look exactly like "nothing to do" and a PR would wait forever unnoticed.
import { createHash } from 'node:crypto'

export const CLOSEOUT_CLASSES = Object.freeze([
  'merged', 'closed_unmerged', 'conflict', 'changes_requested',
  'required_check_failed', 'required_check_missing', 'stalled',
])

// `.` and `..` are excluded so the rebuilt PR URL can never contain a dot segment.
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/
const SHA = /^[a-f0-9]{40}$/
// Only names that match this ever reach a comment; anything else is counted,
// never echoed. Policy requires it of every required check name, and the wake
// renderer re-checks it on whatever detail it is handed.
const SAFE_NAME = /^[A-Za-z0-9 ._()/-]{1,64}$/
const REVIEW_DECISIONS = new Set([null, 'REVIEW_REQUIRED', 'APPROVED', 'CHANGES_REQUESTED'])
const STATUSES = new Set(['queued', 'in_progress', 'completed'])
// The closed set of REST `mergeable_state` values. An unrecognised or differently
// cased state (GraphQL says DIRTY) must throw: read as "not a conflict" it would
// surface later as a misleading required_check_missing.
const MERGEABLE_STATES = new Set(['clean', 'dirty', 'unstable', 'blocked', 'behind', 'draft', 'has_hooks', 'unknown'])
// GitHub treats skipped and neutral as satisfying a required check.
const PASSING = new Set(['success', 'neutral', 'skipped'])
const FAILING = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'])
const MS_LIMIT = 8.64e15

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}
function isMs(value) {
  return Number.isInteger(value) && value >= 0 && value <= MS_LIMIT
}

/**
 * Validate and freeze the policy. Fails loudly: a policy typo that silently
 * required no checks would turn every PR into "nothing to do".
 *
 * @param {{ requiredChecks: string[], reviewCheck?: string | null,
 *   holdLabels?: string[], missingGraceMs: number, stalledGraceMs: number }} policy
 */
export function closeoutPolicy(policy) {
  requireValue(policy && typeof policy === 'object' && !Array.isArray(policy), 'closeout policy is required')
  const { requiredChecks, reviewCheck = null, holdLabels = ['hold'], missingGraceMs, stalledGraceMs } = policy
  requireValue(Array.isArray(requiredChecks) && requiredChecks.length > 0 &&
    requiredChecks.every((n) => typeof n === 'string' && SAFE_NAME.test(n)) &&
    new Set(requiredChecks).size === requiredChecks.length,
  'requiredChecks must be a non-empty list of unique, safe check names')
  requireValue(reviewCheck === null || (typeof reviewCheck === 'string' && SAFE_NAME.test(reviewCheck)),
    'reviewCheck must be null or a safe check name')
  requireValue(Array.isArray(holdLabels) && holdLabels.every((l) => typeof l === 'string' && l.length > 0),
    'holdLabels must be a list of label names')
  requireValue(isMs(missingGraceMs) && missingGraceMs > 0 && isMs(stalledGraceMs) && stalledGraceMs > 0,
    'grace periods must be positive millisecond counts')
  return Object.freeze({
    requiredChecks: Object.freeze([...requiredChecks]),
    reviewCheck,
    holdLabels: Object.freeze([...holdLabels]),
    missingGraceMs,
    stalledGraceMs,
  })
}

function validateSnapshot(s) {
  requireValue(s && typeof s === 'object' && !Array.isArray(s), 'snapshot is required')
  requireValue(typeof s.repository === 'string' && REPOSITORY.test(s.repository), 'snapshot repository is invalid')
  requireValue(Number.isSafeInteger(s.number) && s.number > 0, 'snapshot PR number is invalid')
  requireValue(typeof s.headSha === 'string' && SHA.test(s.headSha), 'snapshot head sha is invalid')
  requireValue(s.state === 'open' || s.state === 'closed', 'snapshot state is unknown')
  requireValue(typeof s.merged === 'boolean' && typeof s.draft === 'boolean' && typeof s.autoMerge === 'boolean',
    'snapshot lifecycle is incomplete')
  requireValue(!(s.merged && s.state !== 'closed'), 'snapshot lifecycle is inconsistent')
  requireValue(Array.isArray(s.labels) && s.labels.every((l) => typeof l === 'string'), 'snapshot labels are invalid')
  requireValue(MERGEABLE_STATES.has(s.mergeableState), 'snapshot mergeableState is missing or unknown')
  // An explicit null is "no decision"; a missing field is NOT, because a dropped
  // field would otherwise read as an unreviewed PR.
  requireValue(REVIEW_DECISIONS.has(s.reviewDecision), 'snapshot reviewDecision is missing or unknown')
  requireValue(isMs(s.headPushedMs) && isMs(s.nowMs) && s.nowMs >= s.headPushedMs, 'snapshot times are invalid')
  requireValue(Array.isArray(s.checks), 'snapshot checks are missing')
  const names = new Set()
  for (const c of s.checks) {
    requireValue(c && typeof c.name === 'string' && c.name.length > 0 && STATUSES.has(c.status),
      'snapshot check is malformed')
    // One entry per name: the adapter picks the latest run. Two entries would
    // make "which one counts" a coin flip decided by array order.
    requireValue(!names.has(c.name), 'snapshot has duplicate check names')
    names.add(c.name)
    if (c.status === 'completed') {
      requireValue(typeof c.conclusion === 'string' && c.conclusion.length > 0 && isMs(c.completedMs),
        'completed check has no conclusion or completion time')
    }
  }
}

/**
 * @param {object} snapshot  one authoritative read of one PR (see validateSnapshot)
 * @param {ReturnType<typeof closeoutPolicy>} policy
 * @returns {null | { class: string, repository: string, number: number, headSha: string,
 *   detail: { checks: string[] } }}
 */
export function classifyCloseout(snapshot, policy) {
  validateSnapshot(snapshot)
  const p = closeoutPolicy(policy)
  const out = (cls, names = []) => ({
    class: cls, repository: snapshot.repository, number: snapshot.number, headSha: snapshot.headSha,
    // Required names are validated by closeoutPolicy, so every name here is safe.
    detail: { checks: [...names].sort() },
  })

  // Terminal first: the owning task must learn the PR ended either way.
  if (snapshot.state === 'closed') return out(snapshot.merged ? 'merged' : 'closed_unmerged')

  // A draft or a held PR is parked by its author or by a business gate. Neither
  // is an exception and neither may be woken, armed or counted as stalled.
  if (snapshot.draft || snapshot.labels.some((l) => p.holdLabels.includes(l))) return null

  // GitHub does not run pull_request workflows on a conflicting PR, so a
  // conflict also explains absent checks. Report the cause, not the symptom.
  if (snapshot.mergeableState === 'dirty') return out('conflict')

  const byName = new Map(snapshot.checks.map((c) => [c.name, c]))

  if (snapshot.reviewDecision === 'CHANGES_REQUESTED') return out('changes_requested')
  const review = p.reviewCheck === null ? undefined : byName.get(p.reviewCheck)
  if (review?.status === 'completed' && review.conclusion === 'failure') return out('changes_requested')

  const failed = []
  const missing = []
  const pending = []
  const settled = []
  for (const name of p.requiredChecks) {
    const check = byName.get(name)
    if (!check) { missing.push(name); continue }
    if (check.status !== 'completed') { pending.push(name); continue }
    if (FAILING.has(check.conclusion)) { failed.push(name); continue }
    // An unrecognised conclusion is neither a pass nor a known failure. Treat it
    // as pending rather than guess; the repair sweep will see it again.
    if (PASSING.has(check.conclusion)) settled.push(check.completedMs)
    else pending.push(name)
  }
  if (failed.length > 0) return out('required_check_failed', failed)

  const sinceHead = snapshot.nowMs - snapshot.headPushedMs
  if (missing.length > 0) {
    // A required check that never reports is a gate-hygiene fault, but only
    // after a grace period: checks legitimately appear a little after a push.
    return sinceHead >= p.missingGraceMs ? out('required_check_missing', missing) : null
  }
  if (pending.length > 0) return null

  // Everything required is green. Stalled means merge-ready yet not merged.
  // The review check, when configured, is part of "ready"; absent or pending it
  // is a review-latency problem, which is not this module's exception.
  if (p.reviewCheck !== null) {
    if (review === undefined || review.status !== 'completed' || !PASSING.has(review.conclusion)) return null
    settled.push(review.completedMs)
  }
  if (snapshot.reviewDecision === 'REVIEW_REQUIRED') return null
  if (snapshot.mergeableState === 'unknown') return null
  const readySinceMs = Math.max(snapshot.headPushedMs, ...settled)
  return snapshot.nowMs - readySinceMs >= p.stalledGraceMs ? out('stalled') : null
}

function tuple(repository, number, headSha, cls) {
  requireValue(typeof repository === 'string' && REPOSITORY.test(repository), 'claim repository is invalid')
  requireValue(Number.isSafeInteger(number) && number > 0, 'claim PR number is invalid')
  requireValue(typeof headSha === 'string' && SHA.test(headSha), 'claim head sha is invalid')
  requireValue(CLOSEOUT_CLASSES.includes(cls), 'claim class is unknown')
  return JSON.stringify(['closeout', repository, number, headSha, cls])
}

/**
 * Identity of one wake: a class on one head of one PR. JSON tuple encoding
 * keeps delimiters inside external strings unambiguous.
 */
export function closeoutClaimKey({ repository, number, headSha, class: cls }) {
  return tuple(repository, number, headSha, cls)
}

/**
 * The same identity shaped for the host-local receipt store, whose ids may only
 * contain `[A-Za-z0-9._:-]` and whose fingerprints are SHA-256 hex.
 */
export function closeoutReceiptId(decision) {
  const key = closeoutClaimKey(decision)
  const digest = (text) => createHash('sha256').update(text).digest('hex')
  return { id: `closeout:${digest(key).slice(0, 48)}`, fingerprint: digest(`fingerprint:${key}`) }
}

const LABELS = Object.freeze({
  merged: 'merged',
  closed_unmerged: 'closed without merging',
  conflict: 'has merge conflicts',
  changes_requested: 'has requested changes',
  required_check_failed: 'has failing required checks',
  required_check_missing: 'has required checks that never reported',
  stalled: 'is ready but has not merged',
})

/**
 * The only text a closeout wake may carry: fixed words, a URL rebuilt from the
 * validated repository and number, the full head sha, and check names that
 * passed SAFE_NAME. PR titles, bodies and review prose are untrusted and are
 * not accepted here at all.
 */
export function renderCloseoutWake(decision) {
  const { repository, number, headSha, class: cls, detail } = decision
  tuple(repository, number, headSha, cls)
  const url = `https://github.com/${repository}/pull/${number}`
  // `detail` is a caller-built object, so re-validate rather than trust it.
  const all = Array.isArray(detail?.checks) ? detail.checks : []
  const names = all.filter((n) => typeof n === 'string' && SAFE_NAME.test(n))
  const omitted = all.length - names.length
  const checks = names.length > 0 || omitted > 0
    ? ` Checks: ${[...names.map((n) => `\`${n}\``), ...(omitted ? [`${omitted} more`] : [])].join(', ')}.`
    : ''
  return `PR closeout: [PR #${number}](${url}) ${LABELS[cls]} at head \`${headSha}\`.${checks}`
}
