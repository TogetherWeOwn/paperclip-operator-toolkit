#!/usr/bin/env node
/**
 * The Stage 2 gate, as a script rather than a judgement call.
 *
 * TOG-768's shipping constraint is "do not switch enforcement on until Stage 2
 * (tier:T1/T2/T3 labels + narrow-slice rollout) is confirmed stable". That
 * sentence is not checkable by reading it. This script turns it into a number:
 * how many issues actually carry a `tier:*` label, applied by a human or agent
 * at assignment time.
 *
 * Creating the three labels is NOT Stage 2. Applying them is. On 2026-08-31 the
 * labels existed and the applied count was 0 of 300 — the gate fails, and it
 * fails on a count rather than on anybody's opinion.
 *
 * Exit status is the point: 0 = gate passes, 1 = gate fails, 2 = could not
 * measure. Wire it ahead of any config change that sets `mode: "enforce"`.
 *
 *   PAPERCLIP_API_URL=... PAPERCLIP_API_KEY=... PAPERCLIP_COMPANY_ID=... \
 *     node scripts/check-stage2-gate.mjs [--min 5] [--limit 300]
 */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

/**
 * Minimum number of deliberately-labelled issues before the narrow slice counts
 * as a slice at all. Default 5 matches the engine's own `sampleCount` floor for
 * trusting a volume profile — below that we would be reading noise either way.
 */
const minLabelled = Number(arg("min", "5"));
const limit = Number(arg("limit", "300"));

const rawBase = process.env.PAPERCLIP_API_URL;
const apiKey = process.env.PAPERCLIP_API_KEY;
const companyId = process.env.PAPERCLIP_COMPANY_ID;

if (!rawBase || !apiKey || !companyId) {
  console.error(
    "PAPERCLIP_API_URL, PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID must all be set. Refusing to guess.",
  );
  process.exit(2);
}

// The env var may or may not already end in /api; normalise before appending.
const base = rawBase.replace(/\/$/, "").replace(/\/api$/, "");

async function getJson(path) {
  const response = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`GET ${path} -> ${response.status} ${response.statusText}`);
  }
  return response.json();
}

const TIER_PREFIX = "tier:";

function labelNamesOf(issue) {
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  return labels
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter((name) => typeof name === "string");
}

try {
  const labels = await getJson(`/api/companies/${companyId}/labels`);
  const labelList = Array.isArray(labels) ? labels : (labels.labels ?? []);
  const tierLabels = labelList.filter((label) => String(label.name ?? "").startsWith(TIER_PREFIX));

  const issues = await getJson(`/api/companies/${companyId}/issues?limit=${limit}`);
  const issueList = Array.isArray(issues) ? issues : (issues.issues ?? []);

  const labelled = issueList.filter((issue) =>
    labelNamesOf(issue).some((name) => name.startsWith(TIER_PREFIX)),
  );

  const byTier = new Map();
  for (const issue of labelled) {
    for (const name of labelNamesOf(issue)) {
      if (name.startsWith(TIER_PREFIX)) byTier.set(name, (byTier.get(name) ?? 0) + 1);
    }
  }

  console.log(`tier labels defined : ${tierLabels.length} (${tierLabels.map((l) => l.name).sort().join(", ") || "none"})`);
  console.log(`issues inspected    : ${issueList.length}`);
  console.log(`issues tier-labelled: ${labelled.length}`);
  for (const [name, count] of [...byTier].sort()) console.log(`  ${name}: ${count}`);

  if (tierLabels.length === 0) {
    console.log(`\nGATE FAILS: no tier:* labels are defined. Stage 2 has not started.`);
    process.exit(1);
  }
  if (labelled.length < minLabelled) {
    console.log(
      `\nGATE FAILS: ${labelled.length} labelled issue(s), need >= ${minLabelled}.\n` +
        `Defining the labels is not Stage 2 — applying them is. Do not set mode: "enforce".`,
    );
    process.exit(1);
  }

  console.log(
    `\nGATE PASSES on count (${labelled.length} >= ${minLabelled}).\n` +
      `Count is necessary, not sufficient: also confirm the slice held across a\n` +
      `measurement window without re-labelling before enabling enforcement.`,
  );
  process.exit(0);
} catch (cause) {
  console.error(`Could not measure the gate: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(2);
}
