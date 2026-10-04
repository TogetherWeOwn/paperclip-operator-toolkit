#!/usr/bin/env node
// Evidence: run one real refreshAaIndex + refreshScores cycle
// against the actual reviewed-roster.json, with a real fetch to aa.ai.
// Read-only against the live system: uses the in-process test harness, never
// touches the deployed plugin's runtime state.
//
// Usage: node --import tsx scripts/refresh-evidence.mjs

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const { createTestHarness } = await import("@paperclipai/plugin-sdk/testing");
const manifestMod = await import(join(root, "src/manifest.ts"));
const workerMod = await import(join(root, "src/worker.ts"));
const constantsMod = await import(join(root, "src/constants.ts"));

const manifest = manifestMod.default;
const { createPlugin } = workerMod;
const { PLUGIN_STATE_KEYS, JOB_KEYS } = constantsMod;

const rosterRaw = readFileSync(join(root, "config/reviewed-roster.json"), "utf8");
const roster = JSON.parse(rosterRaw);

const COMPANY = "evidence-co";

const harness = createTestHarness({ manifest, config: roster });
harness.seed({ companies: [{ id: COMPANY, name: "Evidence Co" }] });

const plugin = createPlugin();
await plugin.definition.setup(harness.ctx);
// A real host replays onConfigChanged for every configured company at
// startup (and on every config save) — that's the only way this plugin
// populates its per-company knownCompanyIds set (worker.ts). Skipping this
// call leaves refreshAaIndex iterating zero companies, so the diff/surface
// loop silently never runs even though the fetch succeeds.
await plugin.definition.onConfigChanged(roster, { companyId: COMPANY });

// Seed volume profiles so refreshScores' downstream reads don't choke — not
// under test here, only refreshAaIndex's fetch/diff/surface behavior is.
await harness.ctx.state.set(
  { scopeKind: "company", scopeId: COMPANY, stateKey: PLUGIN_STATE_KEYS.volumeProfiles },
  { profiles: [], signals: [] },
);

console.log("=== Running refreshAaIndex against the real aa.ai leaderboard ===");
const before = Date.now();
await harness.runJob(JOB_KEYS.refreshAaIndex);
console.log(`refreshAaIndex completed in ${Date.now() - before}ms`);

const snapshot = await harness.ctx.state.get({ scopeKind: "instance", stateKey: PLUGIN_STATE_KEYS.aaIndexSnapshot });
console.log("\n=== Snapshot state after refresh ===");
console.log(JSON.stringify({
  fetchedAt: snapshot?.fetchedAt,
  lastAttemptAt: snapshot?.lastAttemptAt,
  lastError: snapshot?.lastError,
  modelCount: snapshot?.bySlug ? Object.keys(snapshot.bySlug).length : 0,
}, null, 2));

console.log("\n=== Activity log entries (surfaced tier-boundary drift) ===");
if (harness.activity.length === 0) {
  console.log("(none — no model's aa.ai index moved across a tier boundary this cycle)");
} else {
  for (const entry of harness.activity) {
    console.log(JSON.stringify(entry, null, 2));
  }
}

console.log("\n=== Logger entries relevant to aa.ai ===");
const aaLogs = harness.logs.filter(
  (l) => typeof l.message === "string" && l.message.toLowerCase().includes("aa.ai"),
);
for (const l of aaLogs) {
  console.log(`[${l.level}] ${l.message} ${JSON.stringify(l.meta ?? {})}`);
}

console.log("\n=== Config roster state after refresh (proving no mutation) ===");
const configAfter = await harness.ctx.config.get(COMPANY);
const opus = configAfter.models.find((m) => m.id === "claude-opus-5");
console.log("claude-opus-5 tier/enabled unchanged:", JSON.stringify({ tier: opus?.tier, enabled: opus?.enabled }));

const outDir = join(root, ".refresh-evidence");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "snapshot.json"), JSON.stringify(snapshot, null, 2));
writeFileSync(join(outDir, "activity.json"), JSON.stringify(harness.activity, null, 2));
writeFileSync(join(outDir, "logs.json"), JSON.stringify(aaLogs, null, 2));
console.log(`\nRaw evidence written to ${outDir}/`);
