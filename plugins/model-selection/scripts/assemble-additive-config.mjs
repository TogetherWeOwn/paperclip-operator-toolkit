#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const LEGACY_WRAPPER = "cliproxy/";
const DEFAULT_MIN_LANE_BOUND_MODELS = 25;
const SUBSCRIPTION_EXCLUSIVE_ID = /^glm-/;

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function canonicalModelId(modelId) {
  return modelId.startsWith(LEGACY_WRAPPER)
    ? modelId.slice(LEGACY_WRAPPER.length)
    : modelId;
}

function modelKey(model) {
  return `${canonicalModelId(model.id)}\u0000${model.tier}`;
}

function isZeroCostZenModel(model) {
  const modelId = canonicalModelId(model.id);
  return model.enabled === true &&
    model.costPerMTokIn === 0 &&
    model.costPerMTokOut === 0 &&
    (modelId.endsWith("-free") || /(?:free Zen model|no Go quota)/i.test(model.note ?? ""));
}

/**
 * A bare `glm-*` row is served by the Z.ai subscription and by nothing else.
 * Preserving a live binding that puts one on the OpenCode Go lane bills Z.ai
 * traffic against Go's quota, so for these ids the inferred lane wins over the
 * live one rather than the other way round — and when no Z.ai pacing lane
 * exists the row is left unlaned, which the enabled-model guard below turns
 * into a refusal. Zero-cost `-free` rows are Zen rows, not subscription rows.
 *
 * The lane itself still comes from `laneForNewModel`, so the id -> lane map has
 * exactly one definition and this rule cannot drift away from it.
 */
function isSubscriptionExclusive(model) {
  return !isZeroCostZenModel(model) && SUBSCRIPTION_EXCLUSIVE_ID.test(canonicalModelId(model.id));
}

function exclusiveLaneFor(model, availableLaneIds) {
  return isSubscriptionExclusive(model) ? laneForNewModel(model, availableLaneIds) : null;
}

function laneForNewModel(model, availableLaneIds) {
  if (isZeroCostZenModel(model)) {
    return availableLaneIds.has("cliproxy-zen") ? "cliproxy-zen" : null;
  }
  const modelId = canonicalModelId(model.id);
  const candidates = [
    [/^claude-/, "cliproxy-claude"],
    [/^(?:gpt-|codex-)/, "cliproxy-codex"],
    [/^kimi-/, "cliproxy-kimi"],
    [/^glm-/, "cliproxy-zai"],
    // The bridge MUSE choice is the
    // subscription Meta route. The bare `muse-*` form (no `-free` suffix) is
    // never a zero-cost Zen row — `isZeroCostZenModel` above already returned
    // for those — so it lands on the first `cliproxy-meta` lane the live
    // config offers.
    [/^muse-/, "cliproxy-meta"],
    [
      /^(?:big-pickle|deepseek-|hy\d|minimax-|mimo-|nemotron-|ling-|longcat-|omen-|qwen)/,
      "cliproxy-opencode-go",
    ],
  ];
  const match = candidates.find(([pattern]) => pattern.test(modelId));
  const laneId = match?.[1] ?? null;
  return laneId && availableLaneIds.has(laneId) ? laneId : null;
}

function countConfig(config) {
  const models = Array.isArray(config.models) ? config.models : [];
  const pacing = config.pacing && typeof config.pacing === "object" ? config.pacing : {};
  const lanes = Array.isArray(pacing.lanes) ? pacing.lanes : [];
  return {
    models: models.length,
    enabled: models.filter((model) => model.enabled === true).length,
    withLaneId: models.filter((model) => typeof model.laneId === "string" && model.laneId.length > 0)
      .length,
    enabledWithLaneId: models.filter(
      (model) =>
        model.enabled === true && typeof model.laneId === "string" && model.laneId.length > 0,
    ).length,
    pacingLanes: lanes.length,
    pacingMode: typeof pacing.mode === "string" ? pacing.mode : null,
  };
}

function assertUniqueModels(models, label) {
  const seen = new Set();
  for (const model of models) {
    if (!model || typeof model !== "object" || typeof model.id !== "string") {
      throw new Error(`${label} contains a model without a string id`);
    }
    if (typeof model.tier !== "string") {
      throw new Error(`${label} contains model ${model.id} without a string tier`);
    }
    const key = modelKey(model);
    if (seen.has(key)) {
      throw new Error(
        `${label} contains duplicate canonical model+tier row: ${canonicalModelId(model.id)} ${model.tier}`,
      );
    }
    seen.add(key);
  }
}

/** Sections assembled by explicit rule, exempt from the additive section merge. */
const EXPLICIT_SECTIONS = new Set(["models", "pacing"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function assembleAdditiveConfig(roster, live, options = {}) {
  const minimumLaneBoundModels =
    options.minimumLaneBoundModels ?? DEFAULT_MIN_LANE_BOUND_MODELS;
  const rosterModels = Array.isArray(roster.models) ? roster.models : [];
  const liveModels = Array.isArray(live.models) ? live.models : [];

  assertUniqueModels(rosterModels, "roster");
  assertUniqueModels(liveModels, "live config");

  if (!live.pacing || typeof live.pacing !== "object" || Array.isArray(live.pacing)) {
    throw new Error("live config has no pacing object to preserve");
  }
  const liveLanes = Array.isArray(live.pacing.lanes) ? live.pacing.lanes : [];
  const availableLaneIds = new Set(
    liveLanes
      .map((lane) => (lane && typeof lane.laneId === "string" ? lane.laneId : null))
      .filter(Boolean),
  );

  const liveByKey = new Map(liveModels.map((model) => [modelKey(model), model]));
  const rosterKeys = new Set(rosterModels.map(modelKey));
  const mergedModels = rosterModels.map((rosterModel) => {
    const id = canonicalModelId(rosterModel.id);
    const liveModel = liveByKey.get(modelKey(rosterModel));
    const preservedLaneId =
      liveModel && typeof liveModel.laneId === "string" && liveModel.laneId.length > 0
        ? liveModel.laneId
        : null;
    const rosterLaneId =
      typeof rosterModel.laneId === "string" && rosterModel.laneId.length > 0
        ? rosterModel.laneId
        : null;
    const inferredLaneId = laneForNewModel(rosterModel, availableLaneIds);
    const migrateZenFromGo =
      preservedLaneId === "cliproxy-opencode-go" && inferredLaneId === "cliproxy-zen";
    const laneId = isSubscriptionExclusive(rosterModel)
      ? inferredLaneId
      : (migrateZenFromGo ? null : preservedLaneId) ?? rosterLaneId ?? inferredLaneId;
    const enabled = liveModel?.enabled === true ? true : rosterModel.enabled;
    return {
      ...rosterModel,
      id,
      enabled,
      ...(laneId ? { laneId } : {}),
    };
  });

  for (const liveModel of liveModels) {
    if (rosterKeys.has(modelKey(liveModel))) continue;
    const merged = { ...liveModel, id: canonicalModelId(liveModel.id) };
    // The subscription-exclusive rule is an invariant about which subscription
    // pays, so it binds live-only rows too. Applying it on the reviewed path
    // alone would leave the identical defect reachable through the unreviewed
    // one.
    if (isSubscriptionExclusive(merged)) {
      const exclusiveLaneId = laneForNewModel(merged, availableLaneIds);
      if (exclusiveLaneId) merged.laneId = exclusiveLaneId;
      else delete merged.laneId;
    }
    mergedModels.push(merged);
  }

  // `...roster` over `...live` REPLACES a top-level object wholesale, it does
  // not add to it. A live `selection: {mode:"enforce", fleetContextCeilingTokens,
  // compactionRatio}` plus a reviewed roster carrying only `{mode:"advise"}`
  // assembled to `{mode:"advise"}` — the context-fit settings vanished and
  // `resolveConfig` silently restored its defaults (1_000_000 / 0.75). An
  // "additive" assembly must never drop a live setting the roster does not
  // mention, so every plain-object section is merged key-wise with roster
  // precedence. `models` and `pacing` are handled explicitly and excluded here.
  const assembled = {
    ...live,
    ...roster,
    models: mergedModels,
    pacing: live.pacing,
  };
  for (const [key, liveSection] of Object.entries(live)) {
    if (EXPLICIT_SECTIONS.has(key)) continue;
    if (!isPlainObject(liveSection) || !isPlainObject(roster[key])) continue;
    assembled[key] = { ...liveSection, ...roster[key] };
  }
  // Non-vacuity guard: the merge above is the only thing standing between a
  // roster refresh and a silently reset live setting, so assert the outcome
  // rather than trusting the spread order. Any live section or section field
  // missing from the assembled config is a dropped setting, and the assembly
  // fails loudly instead of shipping a config that resolves to defaults.
  const droppedLiveSettings = [];
  for (const [key, liveSection] of Object.entries(live)) {
    if (EXPLICIT_SECTIONS.has(key)) continue;
    if (!(key in assembled)) {
      droppedLiveSettings.push(key);
      continue;
    }
    if (!isPlainObject(liveSection)) continue;
    if (!isPlainObject(assembled[key])) {
      droppedLiveSettings.push(key);
      continue;
    }
    for (const field of Object.keys(liveSection)) {
      if (!(field in assembled[key])) droppedLiveSettings.push(`${key}.${field}`);
    }
  }
  if (droppedLiveSettings.length > 0) {
    throw new Error(
      `assembled config dropped live settings: ${droppedLiveSettings.join(", ")}`,
    );
  }
  assertUniqueModels(assembled.models, "assembled config");

  for (const model of assembled.models) {
    if (model.id.startsWith(LEGACY_WRAPPER)) {
      throw new Error(`assembled config retained legacy model id: ${model.id}`);
    }
  }

  for (const liveModel of liveModels) {
    const assembledModel = assembled.models.find((model) => modelKey(model) === modelKey(liveModel));
    if (!assembledModel) {
      throw new Error(
        `assembled config dropped live model+tier row: ${canonicalModelId(liveModel.id)} ${liveModel.tier}`,
      );
    }
    if (
      typeof liveModel.laneId === "string" &&
      liveModel.laneId.length > 0 &&
      assembledModel.laneId !== liveModel.laneId
    ) {
      const reviewedModel = rosterModels.find((model) => modelKey(model) === modelKey(liveModel));
      const approvedZenMigration = liveModel.laneId === "cliproxy-opencode-go" &&
        assembledModel.laneId === "cliproxy-zen" &&
        reviewedModel &&
        isZeroCostZenModel(reviewedModel);
      const exclusiveLaneId = exclusiveLaneFor(assembledModel, availableLaneIds);
      const approvedExclusiveMigration =
        exclusiveLaneId !== null && assembledModel.laneId === exclusiveLaneId;
      if (isSubscriptionExclusive(assembledModel) && !approvedExclusiveMigration) {
        throw new Error(
          `assembled config cannot serve subscription-exclusive model ${assembledModel.id} ` +
            `${assembledModel.tier} on ${liveModel.laneId}; no subscription pacing lane is configured`,
        );
      }
      if (!approvedZenMigration && !approvedExclusiveMigration) {
        throw new Error(
          `assembled config changed lane binding for ${assembledModel.id} ${assembledModel.tier}`,
        );
      }
    }
    if (liveModel.enabled === true && assembledModel.enabled !== true) {
      throw new Error(
        `assembled config disabled live enabled model: ${assembledModel.id} ${assembledModel.tier}`,
      );
    }
  }

  if (stableJson(assembled.pacing) !== stableJson(live.pacing)) {
    throw new Error("assembled config changed the live pacing object");
  }

  const before = countConfig(live);
  const after = countConfig(assembled);
  if (after.withLaneId < minimumLaneBoundModels) {
    throw new Error(
      `assembled config has ${after.withLaneId} lane-bound models; minimum is ${minimumLaneBoundModels}`,
    );
  }
  if (after.withLaneId < before.withLaneId) {
    throw new Error(
      `assembled config reduced lane-bound models from ${before.withLaneId} to ${after.withLaneId}`,
    );
  }

  const enabledWithoutLane = assembled.models
    .filter(
      (model) =>
        model.enabled === true && !(typeof model.laneId === "string" && model.laneId.length > 0),
    )
    .map((model) => `${model.id}:${model.tier}`);
  if (live.pacing.mode !== "off" && enabledWithoutLane.length > 0) {
    throw new Error(
      `assembled config has enabled models outside pacing lanes: ${enabledWithoutLane.join(", ")}`,
    );
  }

  return {
    config: assembled,
    counts: {
      liveBefore: before,
      artifactAfter: after,
      preservedLaneBindings: liveModels.filter(
        (model) => typeof model.laneId === "string" && model.laneId.length > 0,
      ).length,
      inferredLaneBindings: assembled.models.filter((model) => {
        if (!(typeof model.laneId === "string" && model.laneId.length > 0)) return false;
        const liveModel = liveByKey.get(modelKey(model));
        return !liveModel || !liveModel.laneId;
      }).length,
      enabledWithoutLane,
      guard: `block if artifactAfter.withLaneId < ${minimumLaneBoundModels}, any live enabled model is disabled, any live lane binding changes, pacing changes, or an enabled model is unlaned`,
    },
  };
}

async function main() {
  const rosterPath = argument("roster");
  const livePath = argument("live");
  const outputPath = argument("out");
  const countsPath = argument("counts");
  const minimumArg = argument("min-lane-bound");
  if (!rosterPath || !livePath || !outputPath || !countsPath) {
    throw new Error(
      "usage: assemble-additive-config.mjs --roster <json> --live <json> --out <json> --counts <json> [--min-lane-bound 25]",
    );
  }
  const minimumLaneBoundModels = minimumArg
    ? Number.parseInt(minimumArg, 10)
    : DEFAULT_MIN_LANE_BOUND_MODELS;
  if (!Number.isInteger(minimumLaneBoundModels) || minimumLaneBoundModels < 0) {
    throw new Error("--min-lane-bound must be a non-negative integer");
  }

  const [roster, live] = await Promise.all([
    readFile(resolve(rosterPath), "utf8").then(JSON.parse),
    readFile(resolve(livePath), "utf8").then(JSON.parse),
  ]);
  const result = assembleAdditiveConfig(roster, live, { minimumLaneBoundModels });
  await Promise.all([
    writeFile(resolve(outputPath), `${JSON.stringify(result.config, null, 2)}\n`),
    writeFile(resolve(countsPath), `${JSON.stringify(result.counts, null, 2)}\n`),
  ]);
  console.log(
    `assembled ${result.counts.artifactAfter.models} models; ` +
      `${result.counts.artifactAfter.enabled} enabled; ` +
      `${result.counts.artifactAfter.withLaneId} lane-bound; ` +
      `${result.counts.artifactAfter.pacingLanes} pacing lanes`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
}
