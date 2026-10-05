#!/usr/bin/env node
/**
 * Selector-vs-bridge agreement (, productized under ).
 *
 * Joins the selector's shadow stream (`writer: "plugin-shadow"` decisions of
 * schema paired-decision-v1) to the live host bridge's log
 * (`fleet-quota-balancer.log`, one JSON line per evaluation) and reports how
 * often the model the selector would pick is the model the bridge has set.
 * Each decision is compared with the LAST bridge line at or before its `ts`.
 *
 * Read-only: it opens the shadow files and the bridge log for reading and
 * writes nothing. `host`-writer records are skipped on purpose: `host` and
 * `plugin-shadow` both project one `advise()` call, so their agreement says
 * nothing about the bridge ( measured 100% on 2,494 pairs).
 *
 * Models are compared by class, not by id, because the bridge sets a model and
 * the selector picks a roster row:
 *   MUSE      muse-spark-1.3-contributor, any effort suffix, never a `free` row
 *   PRIMARY   claude-sonnet-5-5
 *   FALLBACK  gpt-6.1-sol
 *   OTHER     anything else; a selector pick of OTHER is reported apart from a
 *             plain disagreement, because it is a roster/tie-break question
 *             rather than a policy one
 *
 * `expressible` answers a different question from `agree`: could the selector
 * have picked the bridge's model at all? It is the count of decisions whose
 * usable candidates include the bridge's class. An agreement figure below 100%
 * with expressible at 100% is a policy gap; with expressible below 100% it is
 * a roster gap.
 */
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

export const DEFAULT_BRIDGE_LOG = "./fleet-quota-balancer.log";
const HOURLY_FILE = /^decisions-\d{4}-\d{2}-\d{2}-\d{2}Z\.jsonl$/;

/** @param {string | null | undefined} model */
export function classifyModel(model) {
  if (typeof model !== "string" || model.length === 0) return null;
  if (model.startsWith("muse-spark-1.3-contributor") && !model.includes("free")) return "MUSE";
  if (model === "claude-sonnet-5-5") return "PRIMARY";
  if (model === "gpt-6.1-sol") return "FALLBACK";
  return "OTHER";
}

/**
 * Timestamps are compared on their first 19 characters, `YYYY-MM-DDTHH:MM:SS`.
 * Both sides are UTC (`Z` on the shadow stream, `+00:00` on the bridge log), so
 * the prefix orders correctly and the offset spelling never matters.
 * @param {string} value
 */
const secondOf = (value) => String(value).slice(0, 19);

/**
 * The last bridge line at or before `ts`, or null before the log begins.
 * @param {Array<{ at: string }>} bridgeLog sorted ascending by `at`
 * @param {string} ts
 */
export function bridgeAt(bridgeLog, ts) {
  const key = secondOf(ts);
  let low = 0;
  let high = bridgeLog.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (secondOf(bridgeLog[mid].at) <= key) low = mid + 1;
    else high = mid;
  }
  return low > 0 ? bridgeLog[low - 1] : null;
}

const bump = (map, key, field) => {
  const row = map.get(key) ?? { agree: 0, disagree: 0, selOTHER: 0 };
  row[field] += 1;
  map.set(key, row);
};

const percent = (part, whole) => (whole === 0 ? null : Math.round((part / whole) * 1000) / 10);

/**
 * @param {object} input
 * @param {Iterable<object>} input.records shadow decisions
 * @param {Array<{ at: string, model: string, reason: string }>} input.bridgeLog
 * @param {string | null} [input.tier] only this tier; null or "all" for every tier
 * @param {string | null} [input.since] ISO instant, inclusive
 * @param {string | null} [input.until] ISO instant, exclusive
 */
export function summarize({ records, bridgeLog, tier = "T1", since = null, until = null }) {
  const firstBridge = bridgeLog.length > 0 ? secondOf(bridgeLog[0].at) : null;
  const totals = { agree: 0, disagree: 0, selOTHER: 0 };
  const byRegime = new Map();
  const byTier = new Map();
  const byHour = new Map();
  const expressible = { bridge_model_usable_candidate: 0, bridge_model_not_candidate: 0 };
  const skipped = { notShadowWriter: 0, otherTier: 0, outsideWindow: 0, beforeBridgeLog: 0 };

  for (const record of records) {
    if (record?.writer !== "plugin-shadow") { skipped.notShadowWriter += 1; continue; }
    if (tier && tier !== "all" && record.tier !== tier) { skipped.otherTier += 1; continue; }
    if ((since && secondOf(record.ts) < secondOf(since)) || (until && secondOf(record.ts) >= secondOf(until))) {
      skipped.outsideWindow += 1;
      continue;
    }
    const bridge = firstBridge !== null && secondOf(record.ts) >= firstBridge ? bridgeAt(bridgeLog, record.ts) : null;
    if (!bridge) { skipped.beforeBridgeLog += 1; continue; }

    const selected = classifyModel(record.pickedModel);
    const wanted = classifyModel(bridge.model);
    const outcome = selected === wanted ? "agree" : selected === "OTHER" ? "selOTHER" : "disagree";
    totals[outcome] += 1;
    bump(byRegime, `${wanted}/${bridge.reason}`, outcome);
    bump(byTier, record.tier ?? "(none)", outcome);
    bump(byHour, String(record.ts).slice(0, 13), outcome);

    const usable = new Set(
      (Array.isArray(record.candidates) ? record.candidates : []).filter((c) => c?.usable).map((c) => classifyModel(c.model)),
    );
    expressible[usable.has(wanted) ? "bridge_model_usable_candidate" : "bridge_model_not_candidate"] += 1;
  }

  const n = totals.agree + totals.disagree + totals.selOTHER;
  const rows = (map) =>
    [...map.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, row]) => {
        const count = row.agree + row.disagree + row.selOTHER;
        return { key, n: count, ...row, agreementPct: percent(row.agree, count) };
      });
  return {
    tier: tier ?? "all",
    records: n,
    totals,
    agreementPct: percent(totals.agree, n),
    expressible,
    expressiblePct: percent(expressible.bridge_model_usable_candidate, n),
    byRegime: rows(byRegime),
    byTier: rows(byTier),
    byHour: rows(byHour),
    skipped,
  };
}

/** @param {string} file */
export async function* readJsonLines(file, counters = { malformed: 0 }) {
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    // The shadow files are large; skip the cheap way before parsing.
    if (line.length === 0 || !line.includes('"plugin-shadow"')) continue;
    try {
      yield JSON.parse(line);
    } catch {
      counters.malformed += 1;
    }
  }
}

/** @param {string} file */
export async function readBridgeLog(file) {
  const text = await readFile(file, "utf8");
  const lines = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.at === "string") lines.push(parsed);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  lines.sort((left, right) => (secondOf(left.at) < secondOf(right.at) ? -1 : secondOf(left.at) > secondOf(right.at) ? 1 : 0));
  return { lines, malformed };
}

/** @param {string} dir @param {boolean} includeLegacy */
export async function shadowFiles(dir, includeLegacy) {
  const names = (await readdir(dir)).filter((name) => HOURLY_FILE.test(name)).sort();
  return [...(includeLegacy ? ["decisions.jsonl"] : []), ...names].map((name) => join(dir, name));
}

function defaultShadowDir(env) {
  if (env.MODEL_SELECTION_SHADOW_DIR) return env.MODEL_SELECTION_SHADOW_DIR;
  if (env.PAPERCLIP_COMPANY_ID) {
    return `${env.MODEL_SELECTION_STATE_ROOT ?? "/var/lib"}/companies/${env.PAPERCLIP_COMPANY_ID}/plugin-local/model-selection/shadow-decisions`;
  }
  return null;
}

const USAGE = `usage: bridge-agreement.mjs [--shadow-dir DIR] [--bridge-log FILE] [--tier T1|T2|T3|all]
                           [--include-legacy] [--since ISO] [--until ISO] [--json]

  --shadow-dir      the shadow-decisions directory (default: $MODEL_SELECTION_SHADOW_DIR, else
                    derived from $PAPERCLIP_COMPANY_ID)
  --bridge-log      fleet-quota-balancer.log (default: ${DEFAULT_BRIDGE_LOG})
  --tier            tier to compare (default T1, the tier whose pick is the fleet-default question)
  --include-legacy  also read decisions.jsonl, the pre-rotation file
  --since / --until bound the comparison window (since inclusive, until exclusive)
  --json            print the summary as JSON instead of text
`;

function parseArgs(argv) {
  const options = { tier: "T1", includeLegacy: false, json: false, shadowDir: null, bridgeLog: null, since: null, until: null };
  const takesValue = new Map([
    ["--shadow-dir", "shadowDir"],
    ["--bridge-log", "bridgeLog"],
    ["--tier", "tier"],
    ["--since", "since"],
    ["--until", "until"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--include-legacy") options.includeLegacy = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else if (takesValue.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) return { error: `${arg} needs a value` };
      options[takesValue.get(arg)] = value;
      index += 1;
    } else return { error: `unknown argument ${arg}` };
  }
  for (const key of ["since", "until"]) {
    if (options[key] !== null && Number.isNaN(Date.parse(options[key]))) return { error: `--${key} is not a timestamp: ${options[key]}` };
  }
  return { options };
}

const pad = (value, width) => String(value ?? "-").padEnd(width);

export function formatText(summary) {
  const out = [];
  const line = (row) => `${pad(row.key, 44)} n=${pad(row.n, 5)} agree=${pad(row.agree, 5)} disagree=${pad(row.disagree, 5)} selOTHER=${pad(row.selOTHER, 4)} ${row.agreementPct === null ? "-" : `${row.agreementPct}%`}`;
  out.push(`tier ${summary.tier}: ${summary.records} records, agreement ${summary.agreementPct === null ? "-" : `${summary.agreementPct}%`} ` +
    `(agree ${summary.totals.agree}, disagree ${summary.totals.disagree}, selector-OTHER ${summary.totals.selOTHER})`);
  out.push(`expressible: bridge model among usable candidates in ${summary.expressible.bridge_model_usable_candidate}/${summary.records}` +
    ` (${summary.expressiblePct === null ? "-" : `${summary.expressiblePct}%`})`);
  const skipped = Object.entries(summary.skipped).filter(([, count]) => count > 0).map(([name, count]) => `${name}=${count}`);
  if (skipped.length > 0) out.push(`skipped: ${skipped.join(" ")}`);
  out.push("", "by bridge regime (bridge class/reason)", ...summary.byRegime.map(line));
  out.push("", "by tier", ...summary.byTier.map(line));
  out.push("", "by hour (UTC)", ...summary.byHour.map(line));
  return `${out.join("\n")}\n`;
}

/**
 * @param {string[]} argv
 * @param {{ stdout?: { write(text: string): unknown }, stderr?: { write(text: string): unknown }, env?: Record<string, string | undefined> }} [io]
 * @returns {Promise<number>} the process exit code
 */
export async function runCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  const parsed = parseArgs(argv);
  if (parsed.help) { stdout.write(USAGE); return 0; }
  if (parsed.error) { stderr.write(`${parsed.error}\n${USAGE}`); return 2; }
  const options = parsed.options;
  const shadowDir = options.shadowDir ?? defaultShadowDir(env);
  if (!shadowDir) { stderr.write(`no shadow directory: pass --shadow-dir or set MODEL_SELECTION_SHADOW_DIR\n${USAGE}`); return 2; }

  let bridge;
  let files;
  try {
    bridge = await readBridgeLog(options.bridgeLog ?? DEFAULT_BRIDGE_LOG);
    files = await shadowFiles(shadowDir, options.includeLegacy);
  } catch (error) {
    stderr.write(`cannot read input: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (bridge.lines.length === 0) { stderr.write("the bridge log has no readable lines; nothing to compare against\n"); return 2; }
  if (files.length === 0) { stderr.write(`no decision files in ${shadowDir}\n`); return 2; }

  const counters = { malformed: 0 };
  const records = [];
  try {
    // Keep only what `summarize` reads: a decision carries every roster row's
    // explanation, and the legacy file holds months of them.
    for (const file of files) {
      for await (const record of readJsonLines(file, counters)) {
        records.push({
          writer: record.writer,
          tier: record.tier,
          ts: record.ts,
          pickedModel: record.pickedModel,
          candidates: Array.isArray(record.candidates)
            ? record.candidates.map((c) => ({ model: c?.model, usable: c?.usable }))
            : [],
        });
      }
    }
  } catch (error) {
    stderr.write(`cannot read input: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const summary = {
    ...summarize({ records, bridgeLog: bridge.lines, tier: options.tier, since: options.since, until: options.until }),
    inputs: { decisionFiles: files.length, bridgeLines: bridge.lines.length, malformedShadowLines: counters.malformed, malformedBridgeLines: bridge.malformed },
  };
  stdout.write(options.json ? `${JSON.stringify(summary, null, 2)}\n` : formatText(summary));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
