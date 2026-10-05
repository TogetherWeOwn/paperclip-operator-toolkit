#!/usr/bin/env node
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { validateBridgeConfig } from "./assemble-additive-config.mjs";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

async function snapshot(path) {
  const bytes = await readFile(path);
  return { config: JSON.parse(bytes.toString("utf8")), sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function main() {
  const livePath = argument("live");
  const artifactPath = argument("artifact");
  const readbackPath = argument("readback");
  if (!livePath || !artifactPath || (process.argv.includes("--readback") && !readbackPath)) {
    throw new Error("usage: verify-bridge-config.mjs --live <BEFORE.json> --artifact <artifact.json> [--readback <AFTER.json>]");
  }
  const [before, artifact] = await Promise.all([snapshot(livePath), snapshot(artifactPath)]);
  validateBridgeConfig(before.config, artifact.config);
  let readback = null;
  if (readbackPath) {
    readback = await snapshot(readbackPath);
    validateBridgeConfig(before.config, readback.config);
    if (!isDeepStrictEqual(readback.config, artifact.config)) {
      throw new Error("live readback differs from the validated artifact");
    }
  }
  console.log(JSON.stringify({
    phase: readback ? "readback" : "preflight",
    beforeSha256: before.sha256,
    artifactSha256: artifact.sha256,
    readbackSha256: readback?.sha256 ?? null,
    liveModels: before.config.models.length,
    artifactModels: artifact.config.models.length,
    liveEnabled: before.config.models.filter((row) => row.enabled === true).length,
    artifactEnabled: artifact.config.models.filter((row) => row.enabled === true).length,
    selectionPreserved: true,
    pacingPreserved: true,
    liveRowsPreserved: true,
    enabledWithoutLane: [],
  }, null, 2));
}

main().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
});
