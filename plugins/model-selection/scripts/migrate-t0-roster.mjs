#!/usr/bin/env node
/**
 * Guarded T0 roster migration: move the three approved S-tier
 * identities from the interim encoding (T1 + `fallbackOnly: true`) to regular
 * T0 rows, and change nothing else.
 *
 * Why this is a guarded identity update and not `assemble-additive-config`:
 * the deployed roster is not the repo's `reviewed-roster.json` (124 rows with
 * lane bindings against 83 rows with none, and `claude-opus-5-5` exists only
 * in the deployed config). Assembling from the repo would overwrite live lane
 * bindings and drop that row. This script starts from the LIVE config, requires
 * the sanitized receipt that reconciled it, and edits exactly two fields on
 * exactly three rows.
 *
 * It is pure: it reads two files and writes the artifact files you name. It
 * never calls Paperclip and never writes the live config — an operator applies
 * the artifact through the board API after the T0-aware build is deployed (the
 * previous build rejects `tier: "T0"` as an unknown tier).
 *
 * Usage:
 *   migrate-t0-roster.mjs --live <config.json> --receipt <receipt.json> \
 *       --out <migrated.json> [--rollback <rollback.json>] [--receipt-sha256 <hex>]
 *   migrate-t0-roster.mjs --verify --live <config.json> --receipt <receipt.json>
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Exact roster ids, never a substring match: `devin/gpt-6-astra` and
 * `devin/claude-fable-5-1` are separate deployed rows that the approved plan
 * does not name, so they stay where they are until a decision says otherwise.
 */
export const T0_MIGRATION_TARGETS = Object.freeze(["gpt-6-astra", "claude-opus-5-5", "claude-fable-5-1"]);

const RECEIPT_SCHEMA = "sanitized-roster-receipt-v1";
const INTERIM = Object.freeze({ tier: "T1", fallbackOnly: true });
const MIGRATED = Object.freeze({ tier: "T0", fallbackOnly: false });
const MIN_SHA_PREFIX = 12;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function receiptRowFor(receipt, id) {
  const rows = receipt.rows.filter((row) => isRecord(row) && isRecord(row.fields) && row.fields.id === id);
  if (rows.length !== 1) {
    throw new Error(`receipt carries ${rows.length} rows with exact id ${id}; the guarded migration needs exactly 1`);
  }
  return rows[0];
}

function checkReceiptShape(receipt) {
  if (!isRecord(receipt) || receipt.schema !== RECEIPT_SCHEMA || !Array.isArray(receipt.rows)) {
    throw new Error(`receipt is not a ${RECEIPT_SCHEMA} document`);
  }
  if (receipt.opus55Attestation?.distinctRosterRowExists !== true) {
    throw new Error("receipt does not attest a distinct claude-opus-5-5 roster row; do not guess its identity");
  }
}

function checkLiveShape(live) {
  if (!isRecord(live) || !Array.isArray(live.models)) {
    throw new Error("live config has no models array");
  }
}

/** The single live row for an exact id, with its position in `models`. */
function liveRowFor(live, id) {
  const hits = [];
  live.models.forEach((model, ordinal) => {
    if (isRecord(model) && model.id === id) hits.push({ model, ordinal });
  });
  if (hits.length !== 1) {
    throw new Error(`live config has ${hits.length} rows with exact id ${id}; the guarded migration needs exactly 1`);
  }
  return hits[0];
}

/**
 * Every field the receipt recorded must still match the live row. A row that
 * drifted since the capture (a different lane, a changed capability set) has
 * not been reconciled, so it is refused rather than moved.
 */
function driftAgainstReceipt(model, receiptRow, ignore) {
  return Object.entries(receiptRow.fields)
    .filter(([key, value]) => !ignore.includes(key) && !sameValue(model[key], value))
    .map(([key]) => key);
}

/**
 * Plan the migration. Returns the migrated config, the per-row changes and a
 * rollback patch; throws (writing nothing) on any guard failure.
 */
export function planT0Migration(live, receipt, options = {}) {
  const targets = options.targets ?? T0_MIGRATION_TARGETS;
  checkLiveShape(live);
  checkReceiptShape(receipt);

  const config = structuredClone(live);
  const changes = [];
  const alreadyMigrated = [];
  const refusals = [];

  for (const id of targets) {
    const { model, ordinal } = liveRowFor(config, id);
    const receiptRow = receiptRowFor(receipt, id);

    const drift = driftAgainstReceipt(model, receiptRow, ["tier", "fallbackOnly"]);
    if (drift.length > 0) {
      refusals.push(`${id}: live row drifted from the receipt on ${drift.join(", ")}`);
      continue;
    }
    if (typeof model.laneId !== "string" || model.laneId.length === 0) {
      refusals.push(`${id}: no laneId; the migration preserves lane bindings and will not invent one`);
      continue;
    }
    if (model.tier === MIGRATED.tier && model.fallbackOnly === MIGRATED.fallbackOnly) {
      alreadyMigrated.push(id);
      continue;
    }
    if (model.tier !== INTERIM.tier || model.fallbackOnly !== INTERIM.fallbackOnly) {
      refusals.push(
        `${id}: live row is tier=${JSON.stringify(model.tier)} fallbackOnly=${JSON.stringify(model.fallbackOnly)}, ` +
          `not the interim ${INTERIM.tier}/fallbackOnly=${INTERIM.fallbackOnly} the receipt recorded`,
      );
      continue;
    }

    const before = { tier: model.tier, fallbackOnly: model.fallbackOnly };
    model.tier = MIGRATED.tier;
    model.fallbackOnly = MIGRATED.fallbackOnly;
    changes.push({ id, ordinal, laneId: model.laneId, before, after: { ...MIGRATED } });
  }

  if (refusals.length > 0) {
    throw new Error(`refusing to migrate: ${refusals.join("; ")}`);
  }

  assertOnlyExpectedChanges(live, config, changes);
  const rollback = changes.map(({ id, ordinal, before }) => ({ id, ordinal, set: { ...before } }));
  return { config, changes, alreadyMigrated, rollback };
}

/**
 * The migrated config differs from the live one by exactly the planned
 * tier/fallbackOnly edits: same keys, same rows in the same order, nothing
 * outside `models`, and no other field on a changed row.
 */
export function assertOnlyExpectedChanges(before, after, changes) {
  const changed = new Map(changes.map((change) => [change.ordinal, change]));
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (key === "models") continue;
    if (!sameValue(before[key], after[key])) throw new Error(`migration altered non-roster key ${key}`);
  }
  if (before.models.length !== after.models.length) throw new Error("migration changed the roster length");
  before.models.forEach((row, ordinal) => {
    const next = after.models[ordinal];
    const change = changed.get(ordinal);
    if (!change) {
      if (!sameValue(row, next)) throw new Error(`migration altered unplanned row ${ordinal} (${row?.id})`);
      return;
    }
    const rowKeys = new Set([...Object.keys(row), ...Object.keys(next)]);
    for (const key of rowKeys) {
      if (key === "tier" || key === "fallbackOnly") continue;
      if (!sameValue(row[key], next[key])) throw new Error(`migration altered ${change.id}.${key}`);
    }
  });
}

/**
 * Post-migration verification of a LIVE config (the parent's final three-row
 * check): every target is a regular T0 row on its receipt lane, and the rows the
 * migration must not touch still read what the receipt recorded. Returns the
 * list of problems; empty means verified.
 */
export function verifyT0Roster(live, receipt, options = {}) {
  const targets = options.targets ?? T0_MIGRATION_TARGETS;
  checkLiveShape(live);
  checkReceiptShape(receipt);
  const problems = [];
  for (const id of targets) {
    let row;
    try {
      row = liveRowFor(live, id);
      const receiptRow = receiptRowFor(receipt, id);
      const drift = driftAgainstReceipt(row.model, receiptRow, ["tier", "fallbackOnly"]);
      if (drift.length > 0) problems.push(`${id}: ${drift.join(", ")} no longer match the receipt`);
    } catch (cause) {
      problems.push(cause instanceof Error ? cause.message : String(cause));
      continue;
    }
    if (row.model.tier !== MIGRATED.tier) problems.push(`${id}: tier is ${JSON.stringify(row.model.tier)}, expected T0`);
    if (row.model.fallbackOnly !== MIGRATED.fallbackOnly) {
      problems.push(`${id}: fallbackOnly is ${JSON.stringify(row.model.fallbackOnly)}, expected false`);
    }
  }
  // The rows the plan deliberately does not name must still be where the
  // receipt found them (T1, fallback-only duplicates on the devin lane).
  for (const row of receipt.rows) {
    const id = row.fields.id;
    if (targets.includes(id)) continue;
    const hits = live.models.filter((model) => isRecord(model) && model.id === id);
    if (hits.length !== 1) {
      problems.push(`${id}: live config has ${hits.length} rows, receipt recorded 1`);
      continue;
    }
    for (const key of ["tier", "fallbackOnly", "laneId"]) {
      if (!sameValue(hits[0][key], row.fields[key])) problems.push(`${id}: unplanned change to ${key}`);
    }
  }
  return problems;
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readJson(path, label, expectedSha) {
  const raw = await readFile(resolve(path));
  if (expectedSha) {
    const actual = sha256Hex(raw);
    if (expectedSha.length < MIN_SHA_PREFIX || !actual.startsWith(expectedSha.toLowerCase())) {
      throw new Error(`${label} sha256 ${actual.slice(0, MIN_SHA_PREFIX)}… does not match --${label}-sha256 ${expectedSha}`);
    }
  }
  return JSON.parse(raw.toString("utf8"));
}

async function main() {
  const livePath = argument("live");
  const receiptPath = argument("receipt");
  const verify = process.argv.includes("--verify");
  const outPath = argument("out");
  if (!livePath || !receiptPath || (!verify && !outPath)) {
    throw new Error(
      "usage: migrate-t0-roster.mjs --live <json> --receipt <json> --out <json> [--rollback <json>] [--receipt-sha256 <hex>]\n" +
        "       migrate-t0-roster.mjs --verify --live <json> --receipt <json> [--receipt-sha256 <hex>]",
    );
  }
  const live = await readJson(livePath, "live");
  const receipt = await readJson(receiptPath, "receipt", argument("receipt-sha256"));

  if (verify) {
    const problems = verifyT0Roster(live, receipt);
    if (problems.length > 0) {
      console.error(`T0 roster NOT verified:\n- ${problems.join("\n- ")}`);
      process.exitCode = 1;
      return;
    }
    console.log(`T0 roster verified: ${T0_MIGRATION_TARGETS.join(", ")} are regular T0 rows on their receipt lanes`);
    return;
  }

  if (resolve(outPath) === resolve(livePath)) throw new Error("--out must not overwrite --live");
  const plan = planT0Migration(live, receipt);
  await writeFile(resolve(outPath), `${JSON.stringify(plan.config, null, 2)}\n`);
  const rollbackPath = argument("rollback");
  if (rollbackPath) await writeFile(resolve(rollbackPath), `${JSON.stringify(plan.rollback, null, 2)}\n`);
  console.log(
    `planned ${plan.changes.length} change(s), ${plan.alreadyMigrated.length} already migrated: ` +
      plan.changes.map((change) => `${change.id} (${change.laneId}) T1/fallbackOnly -> T0/regular`).join("; "),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
}
