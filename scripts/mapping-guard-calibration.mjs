#!/usr/bin/env node
// mapping-guard-calibration.mjs — is omniroute-broker's mapping guard still
// calibrated against the real catalogue?
//
// WHY THIS EXISTS: `mappings.create` is the only broker verb that MOVES TRAFFIC. A combo
// is inert configuration; a mapping is what a bare model id actually resolves through. So
// it carries a server-side pattern guard the caller cannot opt out of (verbs.js
// `assertMappingCreate`), and the whole security argument for that guard rests on ONE
// empirical claim:
//
//     the family regex /(claude|sonnet|opus|haiku|fable|mythos|prism)/i blocks EVERY Claude-bearing id
//     in the catalogue, and blocks NONE of the ids the combo set legitimately needs to re-point.
//
// That claim is about data, not code. It was true on 2026-08-25 (352/352 blocked, 0/130
// over-blocked). It can rot silently the moment OmniRoute's catalogue churns — a new
// Anthropic-served id under some future prefix that spells none of the protected family names
// would pass the guard, and the guard would still look green because every unit test in
// the broker suite asserts against hand-written strings.
//
// An earlier escape is the precedent and the reason the regex is a FAMILY match, not a
// `claude` substring: 14 ids under `aug/` carry no `claude` string at all, and a substring check
// clears every one of them. That bug shipped because the test oracle had the same blind
// spot as the code. This script exists so the oracle is the catalogue instead.
//
// A follow-up incident was the second-order version of that same defect, and it lived HERE. Check 1's
// wide net counts a family-name match AS Claude-bearing, so while the committed fixture
// stored the `aug/` ids as bare `{id}` records, the guard was scoring its own exam:
// delete a token from MAPPING_PROTECTED_FAMILY and the ids it used to match simply stop
// being counted as Claude-bearing, so "0 escaped" stays green. Measured on 63ac24ef —
// removing `prism` still reported "all 350 Claude-bearing ids are blocked" and exited 0,
// while `mappings.create` would then have accepted `aug/prism-a`, which is live Claude
// capacity. The fix is in the DATA, not here: the fixture now carries `aug/prism-a` and its
// catalogue `name`, "Prism (Claude + Gemini)" — corroboration the guard cannot manufacture,
// transcribed from the combo spec rather than inferred from the id.
// `test-mapping-guard-calibration.mjs` pins it by mutating the GUARD rather than the catalogue —
// the only mutation that can detect a circular oracle.
//
// That one `name` is carrying the whole check, and the fixture says so rather than hiding
// it: the other `aug/` ids are stored WITHOUT a name because no capture in this repo
// records one, and a name guessed from the id would be the same circularity wearing a
// disguise. A live run reads all 14 real names and is worth strictly more than this.
//
// The rule that incident established, stated here because it outlives this script: NO
// NAME-SHAPED REGEX IS A SOUND CLAUDE-CONTAINMENT CONTROL ON THIS INSTANCE. Against the
// 351-id corpus in the recorded Claude-surface capture, `claude|anthropic` misses 14 ids and
// `(claude|sonnet|opus|haiku|fable)` misses `aug/prism-a`. Nor is it sound in the other
// direction: `aug/prism-b` is "Prism (GPT + Kimi)" and carries no Claude at all. An id is
// not a reliable statement about what serves it. This guard is id-shaped because it only
// ever sees a caller's pattern string (see the broker README) — that is a structural
// limit, and this script exists to keep saying so when the catalogue drifts past it.
//
// READ-ONLY, BY CONSTRUCTION. One HTTP call at most, a GET of the model catalogue on the
// INFERENCE plane. It never touches :20128/api/* (the management plane the broker exists
// to keep out of agent address space), never writes, never echoes a credential. It does
// not need — and must not be given — a manage-scoped key.
//
// EXIT: 0 = the guard is still calibrated; the combo mapping set is still deployable.
//       1 = calibration FAILED. Either a Claude-bearing id slipped the family regex (a
//           real bypass — fix MAPPING_PROTECTED_FAMILY before any install), or the guard
//           over-blocks an id the combo set needs (the plan must be regenerated). Read the FAIL
//           lines; never widen the guard to make a plan fit.
//       2 = could not run the check at all (bad input, unreachable catalogue, broker not
//           found). NOT a pass, and deliberately distinct from 1 so a broken harness can
//           never be mistaken for a calibrated guard.
//
// ENV:
//   OMNIROUTE_MODELS_URL  default http://omniroute:20129/v1/models
//                         (from an agent container only the 'omniroute' alias resolves;
//                          127.0.0.1 is the HOST's view and the two are not interchangeable)
//   OMNIROUTE_API_KEY     ordinary read key. Required, unless a fixture is used.
//   MAPPING_GUARD_CATALOGUE_FIXTURE
//         Path to a saved /v1/models JSON body, used INSTEAD of the live GET. A fixture
//         run is NOT a live check and says so, loudly, in the banner and the RESULT line.
//   MAPPING_GUARD_BROKER_DIR     default: the authoritative broker at
//                         plugins/omniroute-broker in THIS Ops Tooling repo. The guard is
//                         imported FROM THE BROKER, never re-implemented here — a copy of
//                         the regex would drift and this script would then certify itself
//                         rather than the shipped code.
//
//                         An out-of-repo copy is an install candidate only. When supplied,
//                         its dist/ fingerprint must equal the authoritative source or the
//                         run FAILS. Divergence is never a warning.
//   COMBO_MAP_DIR         default tests/fixtures/combo-mapping (the committed 52-mapping plan)

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

// The Ops Tooling copy is authoritative: it is the only one under version control, the
// only one CI can see, and the only one a reviewer should diff. Model Router is not a
// fallback or an install source after the broker cutover; an alternate copy must be named explicitly.
const AUTHORITATIVE_BROKER = resolve(REPO, 'plugins', 'omniroute-broker')

const MODELS_URL = process.env.OMNIROUTE_MODELS_URL || 'http://omniroute:20129/v1/models'
const KEY = process.env.OMNIROUTE_API_KEY
const FIXTURE = process.env.MAPPING_GUARD_CATALOGUE_FIXTURE
const BROKER_DIR = process.env.MAPPING_GUARD_BROKER_DIR || AUTHORITATIVE_BROKER
const COMBO_MAP_DIR = process.env.COMBO_MAP_DIR || resolve(REPO, 'tests', 'fixtures', 'combo-mapping')

let failures = 0
const fail = (msg) => { failures++; console.log(`FAIL  ${msg}`) }
const pass = (msg) => console.log(`ok    ${msg}`)
const info = (msg) => console.log(`      ${msg}`)

function die(msg) {
  console.log(`\nRESULT: COULD NOT CHECK — ${msg}`)
  console.log('This is not a pass. Exit 2.')
  process.exit(2)
}

// ── Check 0: no two brokers may disagree. ────────────────────────────────────────────
// Fingerprint dist/*.js by content, sorted by name so the hash is order-independent.
// Returns null when the directory has no dist/ — "absent" and "different" are not the
// same answer and must not collapse into one.
function fingerprintDist(dir) {
  const distDir = join(dir, 'dist')
  if (!existsSync(distDir)) return null
  const files = readdirSync(distDir).filter((f) => f.endsWith('.js')).sort()
  if (files.length === 0) return null
  const h = createHash('sha256')
  for (const f of files) {
    h.update(f)
    h.update('\0')
    h.update(readFileSync(join(distDir, f)))
    h.update('\0')
  }
  return { hash: h.digest('hex'), count: files.length }
}

const authoritativePrint = fingerprintDist(AUTHORITATIVE_BROKER)
if (!authoritativePrint) {
  die(`no authoritative broker at ${AUTHORITATIVE_BROKER}. Ops Tooling must contain the source it asks an operator to install.`)
}
info(`authoritative broker: ${authoritativePrint.count} dist file(s), sha256 ${authoritativePrint.hash.slice(0, 16)}`)

// The authoritative guard is only authoritative if it is actually COMMITTED. A guard that
// exists only on one developer's filesystem is the exact defect an earlier hardening change was meant to end.
try {
  const { execFileSync } = await import('node:child_process')
  const tracked = execFileSync('git', ['ls-files', '-z', '--', 'plugins/omniroute-broker/dist'], {
    cwd: REPO,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((p) => p.endsWith('.js'))
  if (tracked.length === 0) {
    fail(`the authoritative broker's dist/ is NOT tracked by git — it exists on disk only.`)
    info(`\`git check-ignore -v plugins/omniroute-broker/dist/verbs.js\` will name the rule.`)
  } else if (tracked.length !== authoritativePrint.count) {
    fail(`git tracks ${tracked.length} broker dist file(s) but ${authoritativePrint.count} are on disk — some are untracked.`)
    info(`untracked guard files are invisible to CI and to every other checkout.`)
  } else {
    pass(`all ${tracked.length} authoritative broker dist file(s) are tracked by git`)
  }
} catch {
  info(`could not consult git (not a checkout, or git unavailable) — tracked-ness NOT verified.`)
}

// An explicitly named install candidate must be byte-identical to the reviewed source.
let comparedAny = false
if (process.env.MAPPING_GUARD_BROKER_DIR) {
  const otherDir = resolve(process.env.MAPPING_GUARD_BROKER_DIR)
  if (otherDir !== AUTHORITATIVE_BROKER) {
    const otherPrint = fingerprintDist(otherDir)
    if (!otherPrint) die(`no broker dist/ at explicit install candidate ${otherDir}`)
    comparedAny = true
    if (otherPrint.hash !== authoritativePrint.hash) {
      fail(`BROKER DIVERGENCE — the install candidate is not byte-identical to Ops Tooling.`)
      info(`authoritative: ${AUTHORITATIVE_BROKER}`)
      info(`  ${authoritativePrint.count} file(s), sha256 ${authoritativePrint.hash}`)
      info(`candidate:     ${otherDir}`)
      info(`  ${otherPrint.count} file(s), sha256 ${otherPrint.hash}`)
      info(`Whatever this run certifies may not be what gets installed. Reconcile them first:`)
      info(`  diff -ru "${AUTHORITATIVE_BROKER}/dist" "${otherDir}/dist"`)
      info(`The Ops Tooling copy wins unless a reviewed change is moved back into this repo.`)
    } else {
      pass(`the install candidate at ${otherDir} is byte-identical to the authoritative broker`)
    }
  }
}
if (!comparedAny) {
  // Say so out loud. A check that quietly compared nothing is indistinguishable in the
  // output from one that compared and agreed — that is how vacuous gates ship green.
  info(`no separate install candidate named — divergence check COMPARED NOTHING (not a pass).`)
  info(`before installing a staged copy, re-run with MAPPING_GUARD_BROKER_DIR=<that directory>.`)
}

// ── Load the guard from the broker itself. Never re-implement it here. ───────────────
const verbsPath = join(BROKER_DIR, 'dist', 'verbs.js')
if (!existsSync(verbsPath)) {
  die(`no broker at ${verbsPath}. Set MAPPING_GUARD_BROKER_DIR to the omniroute-broker checkout.`)
}

let verbs
try {
  verbs = await import(pathToFileURL(verbsPath).href)
} catch (err) {
  die(`could not import the broker's verb table: ${err.message}`)
}

const { resolveVerb, buildRequest, classifyApproval, MAPPING_PROTECTED_FAMILY, MAPPING_WILDCARD } = verbs

if (typeof resolveVerb !== 'function' || typeof buildRequest !== 'function') {
  die('the broker verb table does not export resolveVerb/buildRequest — has its shape changed?')
}
if (!(MAPPING_PROTECTED_FAMILY instanceof RegExp)) {
  die('the broker no longer exports MAPPING_PROTECTED_FAMILY. The guard may have been removed — investigate before installing.')
}

let mappingCreate
try {
  mappingCreate = resolveVerb('mappings.create')
} catch {
  die('the broker has no `mappings.create` verb. This is the mapping-creation gap itself: installing this build buys a half-apply of the combo set.')
}

console.log('omniroute-broker mapping-guard calibration')
console.log(`broker:  ${verbsPath}`)
console.log(`family:  ${MAPPING_PROTECTED_FAMILY}`)
console.log(`wildcard: ${MAPPING_WILDCARD ?? '(not exported)'}`)

// ── Load the catalogue. ──────────────────────────────────────────────────────────────
let raw
let live = false
if (FIXTURE) {
  console.log(`source:  FIXTURE ${FIXTURE}  << NOT A LIVE CHECK >>`)
  try {
    raw = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  } catch (err) {
    die(`could not read the catalogue fixture: ${err.message}`)
  }
} else {
  if (!KEY) die('OMNIROUTE_API_KEY is required for a live check (or set MAPPING_GUARD_CATALOGUE_FIXTURE).')
  console.log(`source:  LIVE ${MODELS_URL}`)
  try {
    const res = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${KEY}` } })
    if (!res.ok) die(`catalogue GET returned ${res.status}`)
    raw = await res.json()
    live = true
  } catch (err) {
    // Never interpolate the key into an error path.
    die(`catalogue GET failed: ${err.message}`)
  }
}

const models = Array.isArray(raw) ? raw : (raw.data || raw.models || [])
if (!Array.isArray(models) || models.length === 0) die('catalogue contained no models')
console.log(`models:  ${models.length}\n`)

// ── Check 1: no Claude-bearing id escapes the family regex. ──────────────────────────
//
// "Claude-bearing" is deliberately decided by a WIDER net than the guard itself: any model
// whose serialized record mentions anthropic or claude anywhere (owner, provider, id,
// metadata), OR whose id matches the family regex. If the wide net catches something the
// guard does not, that difference IS the bypass.
const isClaudeBearing = (m) => {
  const blob = JSON.stringify(m).toLowerCase()
  return blob.includes('anthropic') || blob.includes('claude') || MAPPING_PROTECTED_FAMILY.test(m.id || '')
}

const claudeBearing = models.filter(isClaudeBearing)
const escaped = claudeBearing.filter((m) => !MAPPING_PROTECTED_FAMILY.test(m.id || ''))

if (escaped.length > 0) {
  fail(`${escaped.length} Claude-bearing id(s) are NOT blocked by the family regex — this is a live bypass:`)
  for (const m of escaped.slice(0, 20)) info(`  ${m.id}`)
  if (escaped.length > 20) info(`  … and ${escaped.length - 20} more`)
  info('Do NOT widen anything to make this pass. Extend MAPPING_PROTECTED_FAMILY in the')
  info('broker so these ids are covered, then re-run.')
} else {
  pass(`all ${claudeBearing.length} Claude-bearing ids are blocked by the family regex (0 escaped)`)
}

// ── Check 2 (ADVISORY, not a gate): what the regex catches on the family name alone. ──
//
// This deliberately does NOT fail the run, and the reason is worth stating because the
// obvious version of this check is a tautology. "Over-blocked" would naturally mean
// "matched the regex but is not Claude-bearing" — except the wide net above counts a
// family-name match AS Claude-bearing, so that set is empty by construction and the check
// would be permanently, uselessly green.
//
// The honest question is "is this id actually Anthropic-served?", and the id alone cannot
// answer it: the `aug/` ids spell sonnet/opus/haiku/fable and nothing else, they ARE
// Anthropic capacity, and they are exactly the ids the earlier escape proved a `claude` substring
// check clears. So a family match with no corroborating string is the NORMAL case here,
// not a defect.
//
// The catalogue CAN answer it, via the `name` field — `aug/opus4.8` is only "Opus 4.8",
// but `aug/prism-a` is "Prism (Claude + Gemini)" and `aug/prism-b` is "Prism (GPT + Kimi)",
// two ids one character apart on opposite sides of the containment line. That field is the
// only independent evidence in this file, which is why the committed fixture now carries
// the three names that are actually recorded somewhere checkable (see above) and why a live
// run — which sees all 14 — is worth more than a fixture run.
//
// What over-blocking actually costs us is decided by check 4: does the guard refuse a
// mapping the combo set genuinely needs? That is a real gate. This one is a review aid — if the
// list below grows unfamiliar entries, someone should look at them.
const noCorroboration = models.filter(
  (m) => MAPPING_PROTECTED_FAMILY.test(m.id || '') && !/anthropic|claude/i.test(JSON.stringify(m)),
)
info(`note: ${noCorroboration.length} id(s) match the family regex on the family name alone,`)
info('      with no "anthropic"/"claude" string to corroborate (the bare-aug-id shape — expected).')
if (noCorroboration.length > 0 && noCorroboration.length <= 20) {
  info(`      ${noCorroboration.map((m) => m.id).join(', ')}`)
}
info('      Whether the guard is too broad is decided by check 4, not by this list.')

// ── Check 3: the wildcard ban costs nothing real. ────────────────────────────────────
// An exact-pattern-only guard is only viable if no real id needs a wildcard to address it.
if (MAPPING_WILDCARD instanceof RegExp) {
  const wild = models.filter((m) => MAPPING_WILDCARD.test(m.id || ''))
  if (wild.length > 0) {
    fail(`${wild.length} catalogue id(s) contain a wildcard character and are unaddressable under the ban:`)
    for (const m of wild.slice(0, 10)) info(`  ${m.id}`)
  } else {
    pass('no catalogue id contains "*" or "?" — the wildcard ban blocks nothing addressable')
  }
}

// ── Check 4: every mapping the combo set intends to create still passes the real guard. ─────
//
// This runs the ACTUAL buildRequest, not a re-implementation, so it exercises the unknown-key
// check, the pattern rules and the integer-priority requirement exactly as the broker will.
const planPath = join(COMBO_MAP_DIR, 'mapping-plan.json')
if (!existsSync(planPath)) {
  info(`(skipped) no combo mapping plan at ${planPath}`)
} else {
  let plan
  try {
    const parsed = JSON.parse(readFileSync(planPath, 'utf8'))
    plan = Array.isArray(parsed) ? parsed : (parsed.mappings || parsed.plan || [])
  } catch (err) {
    die(`could not read the combo mapping plan: ${err.message}`)
  }

  const rejected = []
  let dual = 0
  for (const m of plan) {
    const body = {
      pattern: m.pattern,
      comboId: `c-${m.comboName ?? 'placeholder'}`,
      priority: m.priority,
      description: `exact-pattern combo mapping -> ${m.comboName}`,
    }
    try {
      buildRequest(mappingCreate, { body })
    } catch (err) {
      rejected.push([m.pattern, err.message])
      continue
    }
    if (typeof classifyApproval === 'function' && classifyApproval(mappingCreate, body).approval === 'dual') dual++
  }

  if (rejected.length > 0) {
    fail(`${rejected.length} of ${plan.length} planned combo mappings are REFUSED by the guard:`)
    for (const [p, msg] of rejected.slice(0, 10)) info(`  ${p} — ${msg}`)
    info('The plan must be regenerated. Widening the guard to fit a plan defeats its purpose.')
  } else {
    pass(`all ${plan.length} planned combo mappings pass the guard unchanged`)
  }

  // Not a failure — an operational fact the runbook must carry. Every mapping create
  // trips the paid-traffic tripwire (`priority` is a PAID_TRAFFIC_KEY and is mandatory),
  // so phase 6 is 52 two-key ceremonies, not 52 single-key calls.
  if (dual > 0) {
    info(`note: ${dual} of ${plan.length} mapping creates classify as TWO-KEY (dual approval).`)
    info('      Phase 6 needs a second distinct approver agent; proposals expire in 1h.')
  }
}

// ── Verdict. ─────────────────────────────────────────────────────────────────────────
const mode = live ? 'LIVE' : 'FIXTURE (not a live check)'
console.log('')
if (failures === 0) {
  console.log(`RESULT: CALIBRATED — ${mode}. The mapping guard covers the catalogue as claimed.`)
  process.exit(0)
}
console.log(`RESULT: ${failures} CHECK(S) FAILED — ${mode}. Do not install or apply until resolved.`)
process.exit(1)
