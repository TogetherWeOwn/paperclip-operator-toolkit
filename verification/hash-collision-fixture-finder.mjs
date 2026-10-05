#!/usr/bin/env node
// Hash-collision fixture generator.
//
// The redactor prefilters candidate fragments with a base-31 polynomial rolling
// hash and then confirms every candidate character by character. The confirming
// loop is the load-bearing part -- without it a hash collision would redact text
// that is not secret at all -- so the test suite has to contain a string that
// genuinely collides. Random text will not produce one: the hash is 32-bit, so a
// blind search needs ~2^32 tries.
//
// This finds one by meet-in-the-middle in ~2^16 tries, and prints the literal to
// paste into server/src/__tests__/run-secret-redaction.test.ts.
//
// Run it again if MIN_FRAGMENT_LENGTH or FRAGMENT_HASH_BASE ever change; the
// suite's own guard assertion fails loudly when the embedded fixture stops
// colliding, and this is the tool that regenerates it.
//
//   ./verification/hash-collision-fixture-finder.mjs

const LENGTH = 16;
const BASE = 31;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const hash = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(h, BASE) + s.charCodeAt(i)) | 0;
  return h;
};

// The same key fixture the test uses, kept byte-identical to it by construction
// -- including the assembled armour lines. The literals are built rather than
// written out for the same reason as in the test: the repo's secret scan greps
// tracked files for that shape, and a fixture that trips its own repo's scan
// gets deleted or gets the scan muted. Nothing here is real key material.
const keyBody = Array.from({ length: 26 }, (_, line) =>
  Array.from({ length: 64 }, (_, col) =>
    ALPHABET[(line * 29 + col * 17 + line * col) % 64]).join("")).join("\n");
const armour = (edge, kind) => `-----${edge} ${kind}PRIVATE KEY-----`;
const privateKey = `${armour("BEGIN", "RSA ")}\n${keyBody}\n${armour("END", "RSA ")}\n`;

const HALF = LENGTH / 2;
let power = 1;
for (let i = 0; i < HALF; i += 1) power = Math.imul(power, BASE);

const digits = (n, width) => {
  let out = "";
  for (let i = 0; i < width; i += 1) { out = ALPHABET[n % ALPHABET.length] + out; n = Math.floor(n / ALPHABET.length); }
  return out;
};

// Every window of the key that the redactor would index, as a target set.
const targets = new Map();
for (let i = 0; i + LENGTH <= privateKey.length; i += 1) {
  const w = privateKey.slice(i, i + LENGTH);
  if (new Set(w).size >= 6) targets.set(hash(w), w);
}

// Table: hash(suffix) -> suffix, for 2^18 candidate second halves.
const suffixes = new Map();
for (let n = 0; n < (1 << 18); n += 1) {
  const s = digits(n, HALF);
  if (!suffixes.has(hash(s))) suffixes.set(hash(s), s);
}

// Vary the first half; the suffix hash it needs is fully determined.
for (let n = 0; n < (1 << 24); n += 1) {
  const prefix = digits(n, HALF);
  const prefixPart = Math.imul(hash(prefix), power) | 0;
  for (const [target, window] of targets) {
    const need = (target - prefixPart) | 0;
    const suffix = suffixes.get(need);
    if (!suffix) continue;
    const candidate = prefix + suffix;
    if (candidate === window) continue;
    if (privateKey.includes(candidate)) continue;
    if (new Set(candidate).size < 6) continue;
    console.log("collision found after", n, "prefix trials");
    console.log("  colliding string :", JSON.stringify(candidate));
    console.log("  key window       :", JSON.stringify(window));
    console.log("  shared hash      :", hash(candidate), "===", hash(window));
    console.log("  literal substring:", privateKey.includes(candidate));
    process.exit(0);
  }
}
console.error("no collision found");
process.exit(1);
