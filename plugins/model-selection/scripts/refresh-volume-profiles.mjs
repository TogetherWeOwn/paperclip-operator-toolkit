#!/usr/bin/env node
/**
 * Measure per-model token volume from this company's own `heartbeat_runs` and
 * print the numbers the config's `models` and the engine's volume profiles are
 * built from.
 *
 * This is the OFFLINE twin of the plugin's `refreshVolumeProfiles` job. The job
 * is the thing that runs in production; this script exists so an operator can
 * check the same numbers before turning enforcement on, and so the fixtures in
 * `tests/fixtures.ts` can be re-derived rather than trusted.
 *
 * Reads DATABASE_URL from the environment and prints nothing but aggregates —
 * no credential is echoed, and no per-run row leaves the process.
 *
 *   node scripts/refresh-volume-profiles.mjs [--days 7] [--company <uuid>]
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const days = Number(arg("days", "7"));
const companyId = arg("company", null);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Refusing to guess a connection string.");
  process.exit(1);
}

// `pg` is not a dependency of this plugin — it ships with the host. Resolve it
// from there rather than adding a runtime dep the plugin does not otherwise need.
let Client;
try {
  ({ Client } = require("/app/node_modules/.pnpm/pg@8.18.0/node_modules/pg"));
} catch {
  try {
    ({ Client } = require("pg"));
  } catch {
    console.error("Could not resolve the 'pg' driver. Run this from a host that has it installed.");
    process.exit(1);
  }
}

const SQL = `
  select usage_json->>'model' as model,
         count(*)::int as runs,
         avg((usage_json->>'inputTokens')::numeric)::bigint as avg_input,
         avg((usage_json->>'cachedInputTokens')::numeric)::bigint as avg_cache_read,
         avg((usage_json->>'outputTokens')::numeric)::bigint as avg_output,
         avg((usage_json->>'costUsd')::numeric) as avg_cost_usd
    from heartbeat_runs
   where started_at > now() - ($1 || ' days')::interval
     and status = 'succeeded'
     and (usage_json->>'costUsd')::numeric > 0
     and ($2::uuid is null or company_id = $2::uuid)
   group by 1
   having count(*) > 0
   order by avg_cost_usd desc nulls last
`;

const client = new Client({ connectionString: url });
await client.connect();
try {
  const { rows } = await client.query(SQL, [String(days), companyId]);
  if (rows.length === 0) {
    // A run that finishes having produced nothing is a silent failure. Say so.
    console.error(`No succeeded runs with usage in the last ${days}d. Nothing measured.`);
    process.exit(2);
  }
  console.log(`Volume profile, last ${days}d${companyId ? ` (company ${companyId})` : ""}:\n`);
  for (const r of rows) {
    const cacheRatio = Number(r.avg_input) > 0 ? Number(r.avg_cache_read) / Number(r.avg_input) : 0;
    console.log(`  ${r.model}`);
    console.log(`    runs            ${r.runs}`);
    console.log(`    avgInputTokens  ${r.avg_input}`);
    console.log(`    avgCacheRead    ${r.avg_cache_read}  (${cacheRatio.toFixed(1)}x input)`);
    console.log(`    avgOutputTokens ${r.avg_output}`);
    console.log(`    avg $/run       ${Number(r.avg_cost_usd).toFixed(4)}`);
    console.log("");
  }
  console.log("Cache read is the volume term the reference engine has no term for (ADR-0002).");
} finally {
  await client.end();
}
