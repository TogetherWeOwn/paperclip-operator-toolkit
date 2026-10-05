#!/usr/bin/env node
// Rewrite the compiled `convertOpenAINonStreamingToClaude` usage object inside the
// OmniRoute 3.8.49 prebuilt standalone output so it reports the two cache counters.
//
// WHY THIS EXISTS, and why the r1 package could never have worked.
//
// r1 shipped `COPY responseTranslator.ts` + `npm run build` on top of the published
// runtime image. Both halves are dead ends, and the operator's 2026-09-02 run proved
// the second one on the host:
//
//   * The runtime image ships a PRUNED next (no `dist/bin/`), so `npm run build`
//     cannot run there. Measured, deterministic, host-independent.
//   * The published npm tarball omniroute-3.8.49.tgz cannot rebuild either: it has
//     no next.config, no tsconfig, and `scripts/build/build-next-isolated.mjs`
//     statically imports `./assembleStandalone.mjs` and `./backendOnlyPages.mjs`,
//     neither of which is in the tarball's `files` list. So the "multi-stage build
//     from the pinned tgz" shape is ALSO unbuildable -- it just fails one stage later.
//   * The server executes the prebuilt turbopack chunks under `.build/next`. The
//     .ts is present only as a Next file-trace (`*.nft.json`) entry; overlaying it
//     changes nothing the server ever reads.
//
// So the only thing that can move runtime behaviour on the pinned digest is the
// compiled chunk. This script performs that edit as a pinned, verified rewrite:
// it matches ONE exact minified shape and refuses to guess.
//
// The replacement is a semantic transcription of the reviewed TS patch
// (translator SHA-256 5607403f...), and is proven equivalent to it by a
// differential fuzz in verify-compiled-patch.mjs -- run in CI and by
// verify-package.sh, with a negative control that fails if the expression ever
// collapses back to unpatched behaviour.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// The pre-patch compiled form. `n` is the minified toNumber helper and `u` the
// minified usage record; turbopack renames them per chunk, so they are captured
// rather than hardcoded. Backreferences force BOTH reads to use the same helper
// and the same source object -- that is what makes this a safe rewrite and not a
// substring hunt.
const PRE_PATCH = new RegExp(
  "stop_sequence:null,usage:\\{" +
    "input_tokens:(?<n>[A-Za-z_$][\\w$]*)\\((?<u>[A-Za-z_$][\\w$]*)\\.prompt_tokens,0\\)," +
    "output_tokens:\\k<n>\\(\\k<u>\\.completion_tokens,0\\)\\}",
  "g"
);

// Marker proving a chunk has already been rewritten, so --verify and reruns are
// idempotent rather than silently double-patching.
export const PATCH_MARKER = "__cacheUsagePatch";

export function buildReplacement(n, u) {
  return (
    `stop_sequence:null,usage:(()=>{` +
    `var _pd=(${u}&&typeof ${u}.prompt_tokens_details==="object"&&${u}.prompt_tokens_details)||{},` +
    `_id=(${u}&&typeof ${u}.input_tokens_details==="object"&&${u}.input_tokens_details)||{};` +
    // `firstPositiveNumber` in the reviewed TS coerces each candidate through
    // `toNumber` FIRST, so a numeric STRING ("40") counts as a positive number.
    // `n` is the image's own compiled `toNumber`, so routing through it here is
    // what makes this a transcription rather than a lookalike. An earlier draft
    // inlined `typeof v==="number"` instead and silently dropped string-valued
    // cache counters -- the exact shape some OpenAI-compatible providers emit.
    `var ${PATCH_MARKER}=function(){for(var i=0;i<arguments.length;i++){` +
    `var v=${n}(arguments[i],0);if(v>0)return v}return 0};` +
    `var _cr=${PATCH_MARKER}(${u}.cache_read_input_tokens,_pd.cached_tokens,_id.cached_tokens);` +
    `var _cc=${PATCH_MARKER}(${u}.cache_creation_input_tokens,_pd.cache_creation_tokens,_id.cache_creation_tokens);` +
    // Mirrors `usesPromptDetails` in the reviewed TS: when the provider speaks the
    // details shape, prompt_tokens already excludes creation, so it must NOT be
    // subtracted again. Legacy top-level counters are inclusive, so it must.
    `var _upd=(_pd.cached_tokens!==undefined||_pd.cache_creation_tokens!==undefined` +
    `||_id.cached_tokens!==undefined||_id.cache_creation_tokens!==undefined);` +
    `var _pt=${n}(${u}.prompt_tokens,0);` +
    `return{input_tokens:Math.max(0,_pt-_cr-(_upd?0:_cc)),` +
    `output_tokens:${n}(${u}.completion_tokens,0),` +
    `cache_creation_input_tokens:_cc,cache_read_input_tokens:_cr}})()`
  );
}

export function patchSource(source) {
  let sites = 0;
  const out = source.replace(PRE_PATCH, (...args) => {
    const groups = args[args.length - 1];
    sites += 1;
    return buildReplacement(groups.n, groups.u);
  });
  return { out, sites };
}

function* walkJs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJs(full);
    else if (entry.isFile() && entry.name.endsWith(".js")) yield full;
  }
}

function main(argv) {
  const verifyOnly = argv.includes("--verify");
  const rootArg = argv.find((a) => !a.startsWith("--"));
  const root = path.resolve(rootArg ?? "/app/.build/next/server");
  if (!fs.existsSync(root)) {
    console.error(`ERROR: build output not found: ${root}`);
    return 2;
  }

  let patchedFiles = 0;
  let patchedSites = 0;
  let alreadyPatched = 0;
  const receipts = [];

  for (const file of walkJs(root)) {
    const source = fs.readFileSync(file, "utf8");
    if (!source.includes("stop_sequence:null,usage:{")) continue;
    if (source.includes(PATCH_MARKER)) {
      alreadyPatched += 1;
      continue;
    }
    const { out, sites } = patchSource(source);
    if (sites === 0) continue;
    patchedFiles += 1;
    patchedSites += sites;
    if (!verifyOnly) fs.writeFileSync(file, out);
    receipts.push({
      file: path.relative(root, file),
      sites,
      sha256: crypto.createHash("sha256").update(out).digest("hex"),
    });
  }

  const total = patchedFiles + alreadyPatched;
  if (verifyOnly) {
    // After a real patch run every candidate must be on the patched side.
    if (patchedFiles > 0) {
      console.error(
        `ERROR: ${patchedFiles} chunk(s) still carry the unpatched translator usage site`
      );
      return 1;
    }
    if (alreadyPatched === 0) {
      console.error("ERROR: no patched chunk found -- the translator patch is absent");
      return 1;
    }
    console.log(`OK: ${alreadyPatched} chunk(s) carry the cache usage patch`);
    return 0;
  }

  if (total === 0) {
    console.error("ERROR: translator usage site not found -- image layout drifted");
    return 1;
  }
  for (const r of receipts) console.log(`patched ${r.file} sites=${r.sites} sha256=${r.sha256}`);
  console.log(
    `OK: patched ${patchedSites} site(s) across ${patchedFiles} chunk(s); ${alreadyPatched} already patched`
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
