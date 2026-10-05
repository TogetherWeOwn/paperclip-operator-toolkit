#!/usr/bin/env node
// Prove the compiled rewrite in patch-compiled-translator.mjs is semantically
// identical to the reviewed TypeScript patch -- WITHOUT needing podman, the image,
// or the host. This is the gate r1 never had: r1 was hash-reviewed and never
// test-built, so a defect that made it unbuildable survived two approvals and was
// only found by an operator on the VPS.
//
// Three checks, in increasing strength:
//   1. STRUCTURAL  -- the injected expression parses, and applies to a realistic
//                     minified pre-image exactly once.
//   2. DIFFERENTIAL -- the injected expression and a direct transcription of the
//                     reviewed TS agree on every field across a large randomized
//                     corpus of hostile usage objects (undefined/null/NaN/Infinity/
//                     negative/string/array/missing-details).
//   3. NEGATIVE CONTROL -- the patched semantics must actually DIFFER from the
//                     unpatched ones on a cache-bearing input. Without this, an
//                     expression that silently collapsed back to `prompt_tokens`
//                     would pass check 2 against a reference that had the same bug.
//
// Exit 0 only if all three pass.

import assert from "node:assert";
import vm from "node:vm";
import { patchSource, PATCH_MARKER } from "./patch-compiled-translator.mjs";

// Transcribed from responseTranslator.ts lines 12-37, INCLUDING the numeric-string
// branch in `toNumber`. An earlier draft of this file simplified that to a bare
// `typeof v === "number"` check, which made the reference carry the same defect as
// the candidate: the fuzz below reported 0/200000 mismatches while BOTH sides
// silently dropped string-valued cache counters. A reference that is only morally
// the reviewed code proves nothing. Keep this a line-for-line transcription.
const toNumber = (value, fallback = 0) => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};
const toRecord = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const firstPositiveNumber = (...values) => {
  for (const value of values) {
    const parsed = toNumber(value, 0);
    if (parsed > 0) return parsed;
  }
  return 0;
};

// Direct transcription of the reviewed patched responseTranslator.ts
// (SHA-256 5607403fe030f2db445ce9c9afa0e99a9f1cae8b423d00fc0d23f31290a16110).
function reference(usageSrc) {
  const promptDetails = toRecord(usageSrc.prompt_tokens_details);
  const inputDetails = toRecord(usageSrc.input_tokens_details);
  const cacheReadInputTokens = firstPositiveNumber(
    usageSrc.cache_read_input_tokens,
    promptDetails.cached_tokens,
    inputDetails.cached_tokens
  );
  const cacheCreationInputTokens = firstPositiveNumber(
    usageSrc.cache_creation_input_tokens,
    promptDetails.cache_creation_tokens,
    inputDetails.cache_creation_tokens
  );
  const promptTokens = toNumber(usageSrc.prompt_tokens, 0);
  const usesPromptDetails =
    promptDetails.cached_tokens !== undefined ||
    promptDetails.cache_creation_tokens !== undefined ||
    inputDetails.cached_tokens !== undefined ||
    inputDetails.cache_creation_tokens !== undefined;
  const uncachedInputTokens = Math.max(
    0,
    promptTokens - cacheReadInputTokens - (usesPromptDetails ? 0 : cacheCreationInputTokens)
  );
  return {
    input_tokens: uncachedInputTokens,
    output_tokens: toNumber(usageSrc.completion_tokens, 0),
    cache_creation_input_tokens: cacheCreationInputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
  };
}

function unpatched(usageSrc) {
  return {
    input_tokens: toNumber(usageSrc.prompt_tokens, 0),
    output_tokens: toNumber(usageSrc.completion_tokens, 0),
  };
}

// A faithful stand-in for the real chunk: same minified shape, same helper/record
// renaming turbopack performs (`l` and `h` in the shipped 3.8.49 chunks).
const PRE_IMAGE =
  'x={id:"m",type:"message",stop_reason:z,' +
  "stop_sequence:null,usage:{input_tokens:l(h.prompt_tokens,0),output_tokens:l(h.completion_tokens,0)}};";

// --- 1. structural -----------------------------------------------------------
const { out, sites } = patchSource(PRE_IMAGE);
assert.strictEqual(sites, 1, `expected exactly 1 rewritten site, got ${sites}`);
assert.ok(out.includes(PATCH_MARKER), "patch marker missing from rewritten source");
assert.ok(!/input_tokens:l\(h\.prompt_tokens,0\)/.test(out), "pre-patch site survived");
// Idempotence: a second pass must not double-patch.
assert.strictEqual(patchSource(out).sites, 0, "patch is not idempotent");
console.log("OK  structural: exactly one site rewritten, marker present, idempotent");

// Build the injected expression into a callable, in an isolated context. The
// expression is compiled ONCE and then invoked per case, so the fuzz measures the
// expression itself rather than repeated compilation.
const EXPR = out.match(/usage:(\(\(\)=>\{[\s\S]*?\}\)\(\))/)[1];
const candidate = new vm.Script(`(function(l,h){return ${EXPR};})`).runInNewContext({});
const callCandidate = (usage) => candidate(toNumber, usage);

// --- 2. differential fuzz ----------------------------------------------------
const VALUES = [undefined, null, 0, -1, 1, 7, 64, 1234, NaN, Infinity, -Infinity, "12", {}, []];
const DETAILS = (pick) => [
  undefined,
  null,
  {},
  { cached_tokens: pick() },
  { cache_creation_tokens: pick() },
  { cached_tokens: pick(), cache_creation_tokens: pick() },
  [],
  "nope",
];

let seed = 0x2bf79cf1 >>> 0; // deterministic: same corpus every run
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const pickVal = () => pick(VALUES);

const CASES = 200000;
let mismatches = 0;
const histogram = Object.create(null);
const examples = [];

for (let i = 0; i < CASES; i++) {
  const usage = {
    prompt_tokens: pickVal(),
    completion_tokens: pickVal(),
    cache_read_input_tokens: pickVal(),
    cache_creation_input_tokens: pickVal(),
  };
  if (rnd() < 0.6) usage.prompt_tokens_details = pick(DETAILS(pickVal));
  if (rnd() < 0.6) usage.input_tokens_details = pick(DETAILS(pickVal));

  const expected = reference(usage);
  const actual = callCandidate(usage);
  for (const key of Object.keys(expected)) {
    // Object.is, not !==, so a -0/+0 divergence cannot hide.
    if (!Object.is(expected[key], actual[key])) {
      mismatches += 1;
      histogram[key] = (histogram[key] || 0) + 1;
      if (examples.length < 3)
        examples.push({ usage, key, expected: expected[key], actual: actual[key] });
      break;
    }
  }
}

if (mismatches > 0) {
  console.error(`FAIL differential: ${mismatches}/${CASES} mismatches`, histogram);
  for (const e of examples) console.error("  ", JSON.stringify(e));
  process.exit(1);
}
console.log(`OK  differential: ${CASES} cases, 0 mismatches vs reviewed TS semantics`);

// --- 3. negative control -----------------------------------------------------
// The whole point of the patch is that these two DISAGREE. If they ever agree,
// the rewrite has collapsed into a no-op and check 2 would still pass.
const controls = [
  { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } },
  { prompt_tokens: 100, completion_tokens: 5, cache_creation_input_tokens: 30 },
  { prompt_tokens: 80, completion_tokens: 2, input_tokens_details: { cached_tokens: 20 } },
];
for (const c of controls) {
  const patched = callCandidate(c);
  const before = unpatched(c);
  assert.notDeepStrictEqual(
    { input_tokens: patched.input_tokens, output_tokens: patched.output_tokens },
    before,
    `negative control collapsed to unpatched behaviour for ${JSON.stringify(c)}`
  );
  assert.ok(
    patched.cache_creation_input_tokens > 0 || patched.cache_read_input_tokens > 0,
    `negative control produced no cache counters for ${JSON.stringify(c)}`
  );
}
console.log(`OK  negative control: ${controls.length} cache-bearing inputs differ from unpatched`);
console.log("SUCCESS: compiled patch is equivalent to the reviewed translator patch.");
