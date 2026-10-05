// Pure verdict for the protection-rule App.
//
// Two modes, selected per environment by the operator-owned policy table:
//   'plan' — APPROVE only when BOTH hold for the pending deployment:
//     (1) the apply run's claimed plan hash matches a plan artifact from a
//         plan run on the SAME commit, and
//     (2) the CEO posted GO for that exact hash on the environment's card.
//   'sha' — APPROVE only when the CEO posted GO for the exact head SHA of the
//     run under review on the environment's card. Production deploys carry no
//     plan artifact, so the GO binds the commit itself.
// REJECT everything else. There is no third outcome and no "approve on doubt"
// branch; every error shape below resolves to `rejected`.
//
// This module takes already-verified evidence and returns a verdict. It does
// no I/O, reads no secret, and approves nothing by itself — the caller posts
// the verdict to GitHub's callback URL. Keep it pure so the whole decision
// table is testable with no network, no credential and no clock.

export const EVENT = 'deployment_protection_rule'

// Verdict reasons. Stable identifiers, not prose: operators match on them and
// the GitHub callback comment carries them, so rewording one is a breaking
// change. Assert on these, never on a message.
export const REASON = {
  APPROVED: 'plan_and_go_verified',
  WRONG_EVENT: 'not_protection_rule_event',
  WRONG_ENVIRONMENT: 'wrong_environment',
  UNKNOWN_MODE: 'unknown_mode',
  CLAIM_MISSING: 'claim_unestablished',
  PLAN_NOT_FOUND: 'plan_not_found',
  SHA_MISMATCH: 'plan_commit_mismatch',
  HASH_MISMATCH: 'plan_hash_mismatch',
  GO_MISSING: 'ceo_go_missing',
  GO_SHA_MISSING: 'ceo_go_sha_missing',
}

const SHA256 = /^[0-9a-f]{64}$/
const SHA40 = /^[0-9a-f]{40}$/
const MODES = ['plan', 'sha']

function isClaim(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.planManifestSha256 === 'string' &&
    SHA256.test(value.planManifestSha256) &&
    Number.isSafeInteger(value.planRunId) &&
    value.planRunId > 0
  )
}

function isPlan(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Number.isSafeInteger(value.runId) &&
    value.runId > 0 &&
    typeof value.headSha === 'string' &&
    SHA40.test(value.headSha) &&
    typeof value.manifestSha256 === 'string' &&
    SHA256.test(value.manifestSha256)
  )
}

function isPolicy(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.environment === 'string' &&
    value.environment.length > 0 &&
    MODES.includes(value.mode)
  )
}

function isShaList(value) {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string' && SHA40.test(entry))
  )
}

/**
 * Decide the verdict for one pending deployment.
 *
 * @param {object} args
 * @param {string} args.event            GitHub event name from the webhook
 * @param {string} args.environment      environment named by the webhook
 * @param {object} args.policy           resolved policy for (repository, environment)
 * @param {string} args.headSha          run head SHA from a fresh API read
 * @param {object | null} [args.claim]   the apply run's claimed plan, or null (plan mode)
 * @param {object | null} [args.plan]    verified plan evidence, or null (plan mode)
 * @param {string[]} [args.goHashes]     CEO-GO'd plan hashes from the board scan (plan mode)
 * @param {string[]} [args.goShas]       CEO-GO'd head SHAs from the board scan (sha mode)
 * @returns {{ state: 'approved' | 'rejected', reason: string }}
 */
export function decide({ event, environment, policy, headSha, claim = null, plan = null, goHashes = [], goShas = [] }) {
  if (event !== EVENT) return { state: 'rejected', reason: REASON.WRONG_EVENT }
  if (!isPolicy(policy) || environment !== policy.environment) {
    return { state: 'rejected', reason: REASON.WRONG_ENVIRONMENT }
  }
  if (typeof headSha !== 'string' || !SHA40.test(headSha)) {
    return { state: 'rejected', reason: REASON.SHA_MISMATCH }
  }
  if (policy.mode === 'sha') {
    // No plan artifact on production deploys: the GO binds the commit itself.
    // A malformed GO set is a rejection, never a pass — without a readable
    // set there is nothing to bind the deployment to.
    if (!isShaList(goShas)) {
      return { state: 'rejected', reason: REASON.GO_MISSING }
    }
    if (!goShas.includes(headSha)) {
      return { state: 'rejected', reason: REASON.GO_SHA_MISSING }
    }
    return { state: 'approved', reason: REASON.APPROVED }
  }
  if (policy.mode !== 'plan') return { state: 'rejected', reason: REASON.UNKNOWN_MODE }
  // A malformed or absent claim is a rejection, never a pass: without a well-
  // formed (hash, run) pair there is nothing to bind the deployment to.
  if (!isClaim(claim)) return { state: 'rejected', reason: REASON.CLAIM_MISSING }
  if (!isPlan(plan)) return { state: 'rejected', reason: REASON.PLAN_NOT_FOUND }
  if (plan.runId !== claim.planRunId) return { state: 'rejected', reason: REASON.PLAN_NOT_FOUND }
  if (plan.headSha !== headSha) return { state: 'rejected', reason: REASON.SHA_MISMATCH }
  if (plan.manifestSha256 !== claim.planManifestSha256) {
    return { state: 'rejected', reason: REASON.HASH_MISMATCH }
  }
  if (!Array.isArray(goHashes) || !goHashes.includes(claim.planManifestSha256)) {
    return { state: 'rejected', reason: REASON.GO_MISSING }
  }
  return { state: 'approved', reason: REASON.APPROVED }
}
