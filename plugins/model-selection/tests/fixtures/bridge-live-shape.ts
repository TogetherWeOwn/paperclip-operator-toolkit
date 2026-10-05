import { readFileSync } from "node:fs";

export const reviewedRoster = JSON.parse(
  readFileSync(new URL("../../config/reviewed-roster.json", import.meta.url), "utf8"),
);

export const missingZen = [
  "big-pickle", "deepseek-v4-flash-free", "mimo-v2.5-free",
  "nemotron-3-ultra-free", "nemotron-3.5-lightning-free", "ling-3.0-flash-fin-free",
];

// Sanitized equivalent of the host's 124/16/106 rejection, not a live snapshot.
// The six Zen rows are roster-only; the two approved bridge additions are absent.
export function bridgeLiveShape() {
  const absent = new Set([...missingZen, "muse-spark-1.3-contributor"]);
  const models = reviewedRoster.models
    .filter((row: any) => !absent.has(row.id) && !(row.id === "claude-sonnet-5-5" && row.tier === "T2"))
    .map((row: any) => ({ ...row, enabled: false }));
  while (models.length < 124) {
    models.push({ id: `sanitized-live-only-${models.length}`, tier: "T3", enabled: false });
  }
  const sol = models.find((row: any) => row.id === "gpt-6.1-sol" && row.tier === "T1");
  sol.enabled = true;
  sol.laneId = "cliproxy-codex";
  let enabled = 1;
  let bound = 1;
  for (const row of models) {
    if (row === sol) continue;
    if (bound < 106) {
      row.laneId = row.id.startsWith("glm-") ? "cliproxy-zai" : "cliproxy-claude";
      bound++;
      if (enabled < 16) { row.enabled = true; enabled++; }
    } else {
      delete row.laneId;
    }
  }
  return {
    models,
    selection: { mode: "advise", fleetContextCeilingTokens: 456789, compactionRatio: 0.62 },
    shadowEmit: { enabled: true, directory: "sanitized-shadow-path" },
    liveOnlySection: { keep: ["verbatim"] },
    pacing: {
      mode: "shadow",
      lanes: ["claude", "codex", "meta", "kimi", "zai", "opencode-go"].map((name) => ({
        laneId: `cliproxy-${name}`,
        statusUrl: `https://status.example/${name}`,
        apiKeySecretRef: { type: "secret_ref", secretId: `sanitized-${name}` },
        windows: [{ name: "weekly", role: "allowance", utilizationFields: ["used"] }],
      })),
    },
  };
}
