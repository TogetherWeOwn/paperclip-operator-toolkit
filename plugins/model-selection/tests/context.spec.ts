import { describe, expect, it } from "vitest";

import {
  ANCILLARY_MODEL_ENV_KEYS,
  CONTEXT_LIMIT_ENV_KEY,
  PIN_ENV_ALLOWLIST,
  PIN_LANE_MODEL_ENV_KEYS,
  estimateIssueContext,
  modelOverrideForContext,
  PIN_PROVENANCE_ENV_KEY,
  readPinProvenance,
} from "../src/engine/context.js";

const narrowModel = { id: "glm-5.3", contextWindow: 200_000 };
const fleetModel = { id: "claude-opus-5", contextWindow: 1_000_000 };

/**
 * The six model-valued sub-call surfaces every pin now carries ():
 * the four main-lane keys at the pinned model, the two haiku-class keys at
 * the resolved cheap pick (which defaults to the pin — the same fallback
 * `modelOverrideForContext` applies when no healthy T3 model exists).
 *
 * Key names are spelled LITERALLY, not derived from the production constants:
 * dropping a key from `PIN_LANE_MODEL_ENV_KEYS`/`ANCILLARY_MODEL_ENV_KEYS`
 * must turn this suite red, not shrink the expectation to match.
 */
const subCalls = (modelId: string, cheapModelId: string = modelId) => ({
  PAPERCLIP_ASSIGNED_MODEL: { type: "plain", value: modelId },
  CLAUDE_CODE_SUBAGENT_MODEL: { type: "plain", value: modelId },
  ANTHROPIC_DEFAULT_OPUS_MODEL: { type: "plain", value: modelId },
  ANTHROPIC_DEFAULT_SONNET_MODEL: { type: "plain", value: modelId },
  ANTHROPIC_DEFAULT_HAIKU_MODEL: { type: "plain", value: cheapModelId },
  ANTHROPIC_SMALL_FAST_MODEL: { type: "plain", value: cheapModelId },
});

describe("context fit", () => {
  // The pin carries only plugin-owned keys. The agent's bindings
  // (KEEP_AGENT, its own ceiling) stay on the agent record and reach the run
  // through the base env under the per-key merge — they are never copied here.
  it("stamps the floored compaction ceiling for a narrow model and drops a stale override key", () => {
    const patch = modelOverrideForContext({
      model: narrowModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {
        KEEP_AGENT: { type: "plain", value: "agent" },
        [CONTEXT_LIMIT_ENV_KEY]: { type: "plain", value: "1000000" },
      },
      // A non-plugin key left on the pin by an earlier repin. : it is
      // not this plugin's to re-assert, and the current agent env is the source
      // of truth, so it must not survive.
      existingOverrideEnv: { STALE_ISSUE: { type: "plain", value: "issue" } },
    });

    expect(patch).toEqual({
      assigneeAdapterOverrides: {
        adapterConfig: {
          model: "glm-5.3",
          env: {
            [CONTEXT_LIMIT_ENV_KEY]: { type: "plain", value: "200000" },
            ...subCalls("glm-5.3"),
          },
        },
      },
    });
  });

  it("drops the issue compaction ceiling when the new model reaches the fleet ceiling", () => {
    const patch = modelOverrideForContext({
      model: fleetModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {
        KEEP_AGENT: { type: "plain", value: "agent" },
        [CONTEXT_LIMIT_ENV_KEY]: { type: "plain", value: "1000000" },
      },
      existingOverrideEnv: {
        STALE_ISSUE: { type: "plain", value: "issue" },
        [CONTEXT_LIMIT_ENV_KEY]: { type: "plain", value: "150000" },
      },
    });

    // The stale override key is dropped; the inherited ceiling is cleared
    // because the wide model no longer needs it. The agent's own keys are
    // never copied into the pin ().
    expect(patch.assigneeAdapterOverrides.adapterConfig.env).toEqual(
      subCalls("claude-opus-5"),
    );
  });

  it("writes the sub-call pins when clearing the sole inherited compaction ceiling", () => {
    const patch = modelOverrideForContext({
      model: fleetModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {
        [CONTEXT_LIMIT_ENV_KEY]: { type: "plain", value: "150000" },
      },
    });

    expect(patch).toEqual({
      assigneeAdapterOverrides: {
        adapterConfig: {
          model: "claude-opus-5",
          env: subCalls("claude-opus-5"),
        },
      },
    });
  });

  it("omits env entirely when the agent env is unknown and there is nothing to clear", () => {
    const patch = modelOverrideForContext({
      model: fleetModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
    });

    expect(patch).toEqual({
      assigneeAdapterOverrides: {
        adapterConfig: { model: "claude-opus-5" },
      },
    });
  });

  // The previous pin's env is a snapshot taken under whatever
  // assignment held when it was written. Spreading it forward wholesale
  // reassigns agent A's secret refs onto agent B, and every run on that card
  // then fails `configuration_incomplete` while B succeeds everywhere else.
  it("does not carry a previous assignee's env forward onto the current known assignee", () => {
    const previousAssigneeEnv = {
      COOLIFY_API_TOKEN_DEPLOY: { type: "secret_ref", key: "coolify_api_token_deploy" },
      DISCORD_CLIENT_SECRET: { type: "secret_ref", key: "discord_client_secret" },
      CF_ACCESS_STAGING_CLIENT_ID: { type: "secret_ref", key: "cf_access_staging_client_id" },
      [CONTEXT_LIMIT_ENV_KEY]: { type: "plain", value: "150000" },
    };

    const patch = modelOverrideForContext({
      model: narrowModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      // The card was reassigned to an agent that binds none of those secrets.
      agentEnv: { B_ONLY: { type: "plain", value: "b" } },
      existingOverrideEnv: previousAssigneeEnv,
    });

    const env = patch.assigneeAdapterOverrides.adapterConfig.env ?? {};
    for (const strandedKey of Object.keys(previousAssigneeEnv)) {
      if (strandedKey === CONTEXT_LIMIT_ENV_KEY) continue;
      expect(env).not.toHaveProperty(strandedKey);
    }
    // ...and the plugin still does its own job: the plugin key still carries
    // and the narrow model still gets its compaction ceiling. : B's
    // own bindings are NOT copied into the pin — they reach the run through
    // the base env under the per-key merge.
    expect(env).toEqual({
      [CONTEXT_LIMIT_ENV_KEY]: { type: "plain", value: "200000" },
      ...subCalls("glm-5.3"),
    });
  });

  // The  shape: an agent with no bindings inherits a poisoned pin. A
  // wide-model repin for that known-but-empty agent must write only the pin's
  // own keys (the sub-call surfaces), never the stranded foreign secret refs.
  it("strands a poisoned pin's foreign refs when repinned for a known-but-empty agent", () => {
    const patch = modelOverrideForContext({
      model: fleetModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {},
      existingOverrideEnv: {
        COOLIFY_API_TOKEN_DEPLOY: { type: "secret_ref", key: "coolify_api_token_deploy" },
        TWO_BOT_STAGING_DATABASE_URL: { type: "secret_ref", key: "two/bot/staging/database-url" },
      },
    });

    expect(patch.assigneeAdapterOverrides.adapterConfig.env).toEqual(subCalls("claude-opus-5"));
  });

  // Unbinding a secret on the agent record must actually take effect: the pin's
  // copy of the dead ref must not resurrect it on the next pass. :
  // the agent's live bindings are never copied into the pin at all — the run
  // reads them from the base env — so neither the dead ref NOR the live one
  // appears here.
  it("lets an unbound agent secret disappear instead of resupplying it from the pin", () => {
    const patch = modelOverrideForContext({
      model: narrowModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      // REVOKED_REF was removed from the agent record; only the pin still has it.
      agentEnv: { STILL_BOUND: { type: "secret_ref", key: "still_bound" } },
      existingOverrideEnv: { REVOKED_REF: { type: "secret_ref", key: "revoked_ref" } },
    });

    expect(patch.assigneeAdapterOverrides.adapterConfig.env).toEqual({
      [CONTEXT_LIMIT_ENV_KEY]: { type: "plain", value: "200000" },
      ...subCalls("glm-5.3"),
    });
  });

  it("uses the observed single-turn peak, not a ceiling-clamped billing total", () => {
    expect(estimateIssueContext({
      lastRunPeakTokens: 120_000,
      history: "run-found",
      fleetCeilingTokens: 200_000,
    })).toEqual({ tokens: 120_000, source: "last-run-peak" });
    expect(estimateIssueContext({
      lastRunPeakTokens: 230_000,
      history: "run-found",
      fleetCeilingTokens: 200_000,
    })).toEqual({ tokens: 230_000, source: "last-run-peak" });
  });

  it.each(["run-found", "unavailable"] as const)(
    "labels a conservative fleet fallback when history is %s but has no peak",
    (history) => {
      expect(estimateIssueContext({ history, fleetCeilingTokens: 200_000 }))
        .toEqual({ tokens: 200_000, source: "fleet-ceiling-fallback" });
    },
  );

  it("does not invent historical context for a verified first run", () => {
    expect(estimateIssueContext({ history: "no-history", fleetCeilingTokens: 200_000 }))
      .toEqual({ tokens: null, source: "none" });
  });

  it("preserves an uncapped explicit requirement ahead of any history", () => {
    expect(estimateIssueContext({
      explicitTokens: 500_000,
      lastRunPeakTokens: 120_000,
      fleetCeilingTokens: 200_000,
    })).toEqual({ tokens: 500_000, source: "explicit" });
  });

  it.each([NaN, Infinity, -1, 0])("does not report malformed peak %s as observed", (peak) => {
    expect(estimateIssueContext({
      lastRunPeakTokens: peak,
      history: "run-found",
      fleetCeilingTokens: 200_000,
    })).toEqual({ tokens: 200_000, source: "fleet-ceiling-fallback" });
  });
});

/**
 * The pin env allowlist: every key a pin may carry once the fork
 * merges override env per key (). Written env is checked against
 * this list, and the list itself is checked against the production write
 * constants — so a new written key that forgets the allowlist goes red here,
 * not silent into production.
 */
describe(" pin env allowlist", () => {
  it("holds exactly the compaction stamp, the provenance stamp, and the six model-valued sub-call surfaces", () => {
    // Spelled LITERALLY, not derived: adding a written key must turn this red.
    const expected = [
      "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
      "MODEL_SELECTION_PIN_PROVENANCE",
      "PAPERCLIP_ASSIGNED_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_SMALL_FAST_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ];
    expect([...PIN_ENV_ALLOWLIST].sort()).toEqual([...expected].sort());
    expect([...PIN_ENV_ALLOWLIST]).toEqual([
      CONTEXT_LIMIT_ENV_KEY,
      PIN_PROVENANCE_ENV_KEY,
      ...PIN_LANE_MODEL_ENV_KEYS,
      ...ANCILLARY_MODEL_ENV_KEYS,
    ]);
  });

  it("writes no key outside the allowlist, fed an agent env full of secrets and arbitrary keys", () => {
    const patch = modelOverrideForContext({
      model: narrowModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {
        GH_APP_PRIVATE_KEY: { type: "secret_ref", secretId: "gh-key", version: "latest" },
        GH_APP_REPOS: { type: "plain", value: "paperclip-ops-tooling" },
        PAPERCLIP_API_KEY: { type: "user_secret_ref", key: "paperclip_api_key", version: "latest" },
        SOME_BARE_STRING: "kept-verbatim",
        RANDOM_PLAIN: { type: "plain", value: "nope" },
      },
      existingOverrideEnv: {
        STALE_SECRET: { type: "secret_ref", secretId: "stale", version: "latest" },
        STALE_PLAIN: { type: "plain", value: "stale" },
      },
    });

    const env = patch.assigneeAdapterOverrides.adapterConfig.env ?? {};
    const allowed = new Set(PIN_ENV_ALLOWLIST);
    for (const key of Object.keys(env)) {
      expect(allowed.has(key), key).toBe(true);
    }
    // And positively: nothing the agent carried leaked in.
    for (const key of ["GH_APP_PRIVATE_KEY", "GH_APP_REPOS", "PAPERCLIP_API_KEY", "SOME_BARE_STRING", "RANDOM_PLAIN", "STALE_SECRET", "STALE_PLAIN"]) {
      expect(env, key).not.toHaveProperty(key);
    }
    // The pin still does its own job.
    expect(env[CONTEXT_LIMIT_ENV_KEY]).toEqual({ type: "plain", value: "200000" });
  });
});

/**
 * The per-pin `CLAUDE_CODE_MAX_CONTEXT_TOKENS` stamp compares
 * against the AGENT-level cap (`selection.agentEnvContextTokens`), split from
 * the admission ceiling (`selection.fleetContextCeilingTokens`, held at 200k
 * for glm-5.3) that `estimateIssueContext` still takes separately.
 *
 * Stamps are floored at `MIN_STAMPED_CONTEXT_TOKENS` (thrash incident
 * 2026-09-19/20): `max(floor(window*ratio), min(window, 250000))`.
 */
describe(" agent-env cap split", () => {
  const solModel = { id: "gpt-5.6-sol", contextWindow: 272_000 };
  const museModel = { id: "muse-spark", contextWindow: 1_048_576 };

  it("stamps glm-5.3's 200k window at the 250k floor when the agent-env cap is 1M", () => {
    const patch = modelOverrideForContext({
      model: narrowModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {},
    });
    expect(patch.assigneeAdapterOverrides.adapterConfig.env?.[CONTEXT_LIMIT_ENV_KEY]).toEqual({
      type: "plain",
      value: "200000",
    });
  });

  it("stamps Sol's 272k window at 250000, not floor(272k * 0.75)", () => {
    const patch = modelOverrideForContext({
      model: solModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {},
    });
    expect(patch.assigneeAdapterOverrides.adapterConfig.env?.[CONTEXT_LIMIT_ENV_KEY]).toEqual({
      type: "plain",
      value: "250000",
    });
  });

  it("removes the key for a 1M window at or above the agent-env cap", () => {
    const patch = modelOverrideForContext({
      model: fleetModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {
        [CONTEXT_LIMIT_ENV_KEY]: { type: "plain", value: "200000" },
      },
    });
    expect(patch.assigneeAdapterOverrides.adapterConfig.env).not.toHaveProperty(
      CONTEXT_LIMIT_ENV_KEY,
    );
  });

  it("removes the key for Muse's 1,048,576 window once the operator sets the 1M agent-env cap", () => {
    const patch = modelOverrideForContext({
      model: museModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {
        [CONTEXT_LIMIT_ENV_KEY]: { type: "plain", value: "200000" },
      },
    });
    expect(patch.assigneeAdapterOverrides.adapterConfig.env).not.toHaveProperty(
      CONTEXT_LIMIT_ENV_KEY,
    );
  });

  it("stamps narrow windows against the agent-env cap even when the admission ceiling is 200k", () => {
    // Admission (estimateIssueContext) still falls back to the 200k fleet
    // ceiling for glm-5.3 while the pin stamps against the 1M agent-env cap.
    expect(
      estimateIssueContext({
        history: "run-found",
        fleetCeilingTokens: 200_000,
      }),
    ).toEqual({ tokens: 200_000, source: "fleet-ceiling-fallback" });
    const patch = modelOverrideForContext({
      model: narrowModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {},
    });
    expect(patch.assigneeAdapterOverrides.adapterConfig.env?.[CONTEXT_LIMIT_ENV_KEY]).toEqual({
      type: "plain",
      value: "200000",
    });
  });

  it("keeps today's no-stamp semantics when contextWindow is missing", () => {
    const patch = modelOverrideForContext({
      model: { id: "unknown-window" } as { id: string; contextWindow: number },
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {},
    });
    expect(patch.assigneeAdapterOverrides.adapterConfig.env ?? {}).not.toHaveProperty(
      CONTEXT_LIMIT_ENV_KEY,
    );
  });
});

/**
 *  +. The repin must evacuate the haiku-class sub-call
 * surfaces along with the main model, and it must do so WITHOUT dropping
 * anything else off the agent's env — the host replaces the whole env object,
 * so a two-key write is a fleet-wide secret wipe for the duration of the run.
 *  extends the evacuation to the four main-lane surfaces the 00:0xZ
 * sweep found frozen on the exhausted Codex lane across 118 open cards.
 */
describe("sub-call surface pins", () => {
  const exhaustedLane = { type: "plain", value: "cliproxy/gpt-5.6-luna" };

  it("repoints both sub-call surfaces off an exhausted lane onto the pinned model", () => {
    const patch = modelOverrideForContext({
      model: fleetModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {
        ANTHROPIC_SMALL_FAST_MODEL: exhaustedLane,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: exhaustedLane,
      },
    });

    expect(patch.assigneeAdapterOverrides.adapterConfig).toEqual({
      model: "claude-opus-5",
      env: subCalls("claude-opus-5"),
    });
  });

  it("repoints the four main-lane surfaces  found frozen on the exhausted lane", () => {
    const patch = modelOverrideForContext({
      model: fleetModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {
        PAPERCLIP_ASSIGNED_MODEL: exhaustedLane,
        CLAUDE_CODE_SUBAGENT_MODEL: exhaustedLane,
        ANTHROPIC_DEFAULT_OPUS_MODEL: exhaustedLane,
        ANTHROPIC_DEFAULT_SONNET_MODEL: exhaustedLane,
      },
    });

    expect(patch.assigneeAdapterOverrides.adapterConfig).toEqual({
      model: "claude-opus-5",
      env: subCalls("claude-opus-5"),
    });
  });

  // The pin carries ONLY plugin-owned keys: no agent binding —
  // secret or plain, relevant or not — is ever copied in. Fed an agent env
  // holding secret_refs, user_secret_refs, plain values and bare strings, the
  // written env holds nothing outside the allowlist. The run reads the
  // agent's bindings from the base env under the per-key merge.
  it("copies no agent env binding, including secrets, into the pin", () => {
    const patch = modelOverrideForContext({
      model: narrowModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {
        GH_APP_PRIVATE_KEY: { type: "secret_ref", key: "gh_app_private_key" },
        GH_APP_REPOS: { type: "plain", value: "paperclip-ops-tooling" },
        PAPERCLIP_API_KEY: { type: "user_secret_ref", key: "paperclip_api_key" },
        SOME_BARE_STRING: "kept-verbatim",
        ANTHROPIC_SMALL_FAST_MODEL: exhaustedLane,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: exhaustedLane,
      },
      // a non-plugin key left on the pin by an earlier repin is not
      // re-asserted for a known agent; the agent env is the source of truth.
      existingOverrideEnv: { STALE_ISSUE: { type: "plain", value: "issue" } },
    });

    const env = patch.assigneeAdapterOverrides.adapterConfig.env ?? {};
    // The two exhausted plain values are re-derived onto the pin (plain agent
    // values are this plugin's routing surface — ); the bindings that
    // are NOT this plugin's surface never enter the pin.
    expect(env).toEqual({
      [CONTEXT_LIMIT_ENV_KEY]: { type: "plain", value: "200000" },
      ...subCalls("glm-5.3"),
    });
    for (const key of ["GH_APP_PRIVATE_KEY", "GH_APP_REPOS", "PAPERCLIP_API_KEY", "SOME_BARE_STRING", "STALE_ISSUE"]) {
      expect(env, key).not.toHaveProperty(key);
    }
  });

  it("writes only the pin's own surfaces for an agent that carried unrelated keys", () => {
    const patch = modelOverrideForContext({
      model: fleetModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: { UNRELATED: { type: "plain", value: "x" } },
    });

    // UNRELATED stays on the agent record; the pin carries the six surfaces.
    expect(patch.assigneeAdapterOverrides.adapterConfig.env).toEqual(
      subCalls("claude-opus-5"),
    );
  });

  it("writes the surfaces for a known-but-empty agent env", () => {
    const patch = modelOverrideForContext({
      model: fleetModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {},
    });

    expect(patch.assigneeAdapterOverrides.adapterConfig.env).toEqual(subCalls("claude-opus-5"));
  });

  // The guard that makes this safe on an unreadable agent row. `null` is
  // "unknown", and an env map built from an unknown base would REPLACE the
  // agent's real bindings with just these two keys for the whole run.
  it("writes no env at all when the agent env is unknown", () => {
    for (const agentEnv of [null, undefined]) {
      const patch = modelOverrideForContext({
        model: fleetModel,
        agentEnvContextTokens: 1_000_000,
        compactionRatio: 0.75,
        agentEnv,
      });
      expect(patch.assigneeAdapterOverrides.adapterConfig).toEqual({ model: "claude-opus-5" });
    }
  });

  it("still preserves an existing issue-level env when the agent env is unknown", () => {
    const patch = modelOverrideForContext({
      model: fleetModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: null,
      existingOverrideEnv: { ISSUE_SCOPED: { type: "plain", value: "issue" } },
    });

    expect(patch.assigneeAdapterOverrides.adapterConfig.env).toEqual({
      ISSUE_SCOPED: { type: "plain", value: "issue" },
    });
    for (const key of ANCILLARY_MODEL_ENV_KEYS) {
      expect(patch.assigneeAdapterOverrides.adapterConfig.env).not.toHaveProperty(key);
    }
  });

  // The pin no longer carries the agent's values, so a secret-bound
  // agent surface vetoes the plain pin for that key: writing one would shadow
  // the agent's live binding for the run under the per-key merge. The key is
  // left OUT of the pin (not copied in) — the run resolves it from the base
  // env. The other surfaces are still pinned.
  it("leaves a secret-bound agent surface out of the pin instead of shadowing it", () => {
    const patch = modelOverrideForContext({
      model: fleetModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {
        ANTHROPIC_SMALL_FAST_MODEL: { type: "secret_ref", key: "small_fast_model" },
        ANTHROPIC_DEFAULT_HAIKU_MODEL: exhaustedLane,
      },
    });

    const env = patch.assigneeAdapterOverrides.adapterConfig.env ?? {};
    expect(env).not.toHaveProperty("ANTHROPIC_SMALL_FAST_MODEL");
    expect(env).toEqual({
      PAPERCLIP_ASSIGNED_MODEL: { type: "plain", value: "claude-opus-5" },
      CLAUDE_CODE_SUBAGENT_MODEL: { type: "plain", value: "claude-opus-5" },
      ANTHROPIC_DEFAULT_OPUS_MODEL: { type: "plain", value: "claude-opus-5" },
      ANTHROPIC_DEFAULT_SONNET_MODEL: { type: "plain", value: "claude-opus-5" },
      ANTHROPIC_DEFAULT_HAIKU_MODEL: { type: "plain", value: "claude-opus-5" },
    });
  });

  it("leaves a secret-bound main-lane agent surface out of the pin too", () => {
    const patch = modelOverrideForContext({
      model: fleetModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {
        CLAUDE_CODE_SUBAGENT_MODEL: { type: "secret_ref", key: "subagent_model" },
        PAPERCLIP_ASSIGNED_MODEL: exhaustedLane,
      },
    });

    const env = patch.assigneeAdapterOverrides.adapterConfig.env ?? {};
    expect(env).not.toHaveProperty("CLAUDE_CODE_SUBAGENT_MODEL");
    expect(env).toEqual({
      PAPERCLIP_ASSIGNED_MODEL: { type: "plain", value: "claude-opus-5" },
      ANTHROPIC_DEFAULT_OPUS_MODEL: { type: "plain", value: "claude-opus-5" },
      ANTHROPIC_DEFAULT_SONNET_MODEL: { type: "plain", value: "claude-opus-5" },
      ANTHROPIC_SMALL_FAST_MODEL: { type: "plain", value: "claude-opus-5" },
      ANTHROPIC_DEFAULT_HAIKU_MODEL: { type: "plain", value: "claude-opus-5" },
    });
  });

  it("lets an explicit issue-level sub-call pin be repointed, not frozen", () => {
    // `existingOverrideEnv` is this plugin's OWN prior write, so a stale value
    // there must follow the new pin — otherwise the first repin freezes the
    // sub-calls on whatever lane the first pin chose.
    const patch = modelOverrideForContext({
      model: narrowModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {},
      existingOverrideEnv: { ANTHROPIC_SMALL_FAST_MODEL: { type: "plain", value: "claude-opus-5" } },
    });

    expect(patch.assigneeAdapterOverrides.adapterConfig.env).toEqual({
      [CONTEXT_LIMIT_ENV_KEY]: { type: "plain", value: "200000" },
      ...subCalls("glm-5.3"),
    });
  });

  /**
   * The haiku-class keys are NOT the main pin: pointing
   * `ANTHROPIC_SMALL_FAST_MODEL` at a T1 model prices every background
   * haiku-class call at T1 rates. They follow the resolved cheapest healthy
   * T3 model instead.
   */
  it("points the cheap keys at the resolved T3 pick, not the pin", () => {
    const patch = modelOverrideForContext({
      model: fleetModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: {},
      cheapModelId: "cliproxy/claude-haiku-4-5-20251001",
    });

    expect(patch.assigneeAdapterOverrides.adapterConfig.env).toEqual(
      subCalls("claude-opus-5", "cliproxy/claude-haiku-4-5-20251001"),
    );
  });

  it("falls back to the pin for the cheap keys when no healthy T3 model resolved", () => {
    for (const cheapModelId of [null, undefined, ""]) {
      const patch = modelOverrideForContext({
        model: fleetModel,
        agentEnvContextTokens: 1_000_000,
        compactionRatio: 0.75,
        agentEnv: {},
        cheapModelId,
      });
      expect(patch.assigneeAdapterOverrides.adapterConfig.env).toEqual(subCalls("claude-opus-5"));
    }
  });

  //  (c). The unknown-assignee branch preserves the snapshot because
  // it cannot rebuild from an unseen base — but the model-owned surfaces are
  // still re-derived against the NEW model. Here the old pin was written for
  // the wide model (no ceiling) pointing sub-calls at the dead lane; the
  // repin moves to the narrow model and all six surfaces must follow it.
  // The snapshot carries every model-owned key frozen on the dead lane, so
  // the unknown-carry rule re-derives each one; keys the snapshot never had
  // are still never invented (next tests).
  it("re-derives model-owned env surfaces against the new model when the agent env is unknown", () => {
    const patch = modelOverrideForContext({
      model: narrowModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: null,
      existingOverrideEnv: {
        ISSUE_SCOPED: { type: "plain", value: "issue" },
        PAPERCLIP_ASSIGNED_MODEL: { type: "plain", value: "cliproxy/gpt-5.6-luna" },
        CLAUDE_CODE_SUBAGENT_MODEL: { type: "plain", value: "cliproxy/gpt-5.6-luna" },
        ANTHROPIC_DEFAULT_OPUS_MODEL: { type: "plain", value: "cliproxy/gpt-5.6-luna" },
        ANTHROPIC_DEFAULT_SONNET_MODEL: { type: "plain", value: "cliproxy/gpt-5.6-luna" },
        ANTHROPIC_SMALL_FAST_MODEL: { type: "plain", value: "cliproxy/gpt-5.6-luna" },
        ANTHROPIC_DEFAULT_HAIKU_MODEL: { type: "plain", value: "cliproxy/gpt-5.6-luna" },
      },
    });

    expect(patch.assigneeAdapterOverrides.adapterConfig.env).toEqual({
      ISSUE_SCOPED: { type: "plain", value: "issue" },
      [CONTEXT_LIMIT_ENV_KEY]: { type: "plain", value: "200000" },
      ...subCalls("glm-5.3"),
    });
  });

  //  (c). The ceiling half of the same rule: the old pin's ceiling
  // was derived from the narrow model, the repin moves to the wide one, and
  // the stale ceiling must be cleared, not carried. The snapshot never had
  // sub-call surfaces, so none are invented — the "does not invent" test
  // below pins that half; this one pins the ceiling half.
  it("clears a stale compaction ceiling from the snapshot when the new model reaches the fleet ceiling", () => {
    const patch = modelOverrideForContext({
      model: fleetModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: null,
      existingOverrideEnv: {
        ISSUE_SCOPED: { type: "plain", value: "issue" },
        [CONTEXT_LIMIT_ENV_KEY]: { type: "plain", value: "200000" },
      },
    });

    expect(patch.assigneeAdapterOverrides.adapterConfig.env).toEqual({
      ISSUE_SCOPED: { type: "plain", value: "issue" },
    });
    expect(patch.assigneeAdapterOverrides.adapterConfig.env).not.toHaveProperty(CONTEXT_LIMIT_ENV_KEY);
  });

  //  (c). Unknown-assignee must not INVENT sub-call surfaces the
  // snapshot never had — a card pinned before  (or by another
  // writer) gains them only through the known-assignee rebuild, never by
  // snapshot surgery.
  it("does not invent sub-call surfaces an unknown-assignee snapshot never had", () => {
    const patch = modelOverrideForContext({
      model: fleetModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: null,
      existingOverrideEnv: { ISSUE_SCOPED: { type: "plain", value: "issue" } },
    });

    expect(patch.assigneeAdapterOverrides.adapterConfig.env).toEqual({
      ISSUE_SCOPED: { type: "plain", value: "issue" },
    });
    for (const key of ANCILLARY_MODEL_ENV_KEYS) {
      expect(patch.assigneeAdapterOverrides.adapterConfig.env).not.toHaveProperty(key);
    }
  });

  //  (c). The secret-binding rule survives the unknown branch: a
  // secret-bound sub-call surface in the snapshot is never overwritten.
  it("never overwrites a secret-bound sub-call surface from an unknown-assignee snapshot", () => {
    const secretBound = { type: "secret_ref", key: "small_fast_model" };
    const patch = modelOverrideForContext({
      model: narrowModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: null,
      existingOverrideEnv: {
        ANTHROPIC_SMALL_FAST_MODEL: secretBound,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: { type: "plain", value: "cliproxy/gpt-5.6-luna" },
      },
    });

    expect(patch.assigneeAdapterOverrides.adapterConfig.env).toEqual({
      ANTHROPIC_SMALL_FAST_MODEL: secretBound,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: { type: "plain", value: "glm-5.3" },
      [CONTEXT_LIMIT_ENV_KEY]: { type: "plain", value: "200000" },
    });
  });
});

describe(" fallback pin provenance stamp", () => {
  const stamp = { decisionId: "d-1", agentId: "agent-a", fallback: true as const, decidedAt: "2026-09-10T12:00:00.000Z" };
  const stampKey = "MODEL_SELECTION_PIN_PROVENANCE";

  it("writes the stamp as a plain JSON value that reads back unchanged", () => {
    const patch = modelOverrideForContext({
      model: narrowModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: { KEEP: { type: "secret_ref", key: "keep" } },
      provenance: stamp,
    });
    const env = patch.assigneeAdapterOverrides.adapterConfig.env as Record<string, unknown>;
    expect(env[stampKey]).toEqual({ type: "plain", value: JSON.stringify(stamp) });
    expect(PIN_PROVENANCE_ENV_KEY).toBe(stampKey);
    expect(readPinProvenance(env)).toEqual(stamp);
    // the pin carries the stamp but NOT the agent's binding — KEEP
    // stays on the agent record and reaches the run through the base env.
    expect(env).not.toHaveProperty("KEEP");
  });

  it("drops an earlier pin's stamp when this pin carries none", () => {
    for (const agentEnv of [{}, null]) {
      const patch = modelOverrideForContext({
        model: narrowModel,
        agentEnvContextTokens: 1_000_000,
        compactionRatio: 0.75,
        agentEnv,
        existingOverrideEnv: {
          KEEP: { type: "plain", value: "x" },
          [stampKey]: { type: "plain", value: JSON.stringify(stamp) },
        },
      });
      const env = (patch.assigneeAdapterOverrides.adapterConfig.env ?? {}) as Record<string, unknown>;
      expect(env[stampKey]).toBeUndefined();
      expect(readPinProvenance(env)).toBeNull();
    }
  });

  it("never writes a stamp-only env over an unknown assignee's env", () => {
    // The fleet-wide window writes no context limit, so the stamp would be
    // the env's only key.
    const patch = modelOverrideForContext({
      model: fleetModel,
      agentEnvContextTokens: 1_000_000,
      compactionRatio: 0.75,
      agentEnv: null,
      provenance: stamp,
    });
    expect(patch.assigneeAdapterOverrides.adapterConfig).toEqual({ model: "claude-opus-5" });
  });

  it("reads a malformed stamp as absent", () => {
    const plain = (value: unknown) => ({ [stampKey]: { type: "plain", value: JSON.stringify(value) } });
    expect(readPinProvenance({ [stampKey]: JSON.stringify(stamp) })).toEqual(stamp);
    expect(readPinProvenance(undefined)).toBeNull();
    expect(readPinProvenance({ [stampKey]: { type: "plain", value: "{not json" } })).toBeNull();
    expect(readPinProvenance({ [stampKey]: { type: "secret_ref", key: JSON.stringify(stamp) } })).toBeNull();
    expect(readPinProvenance(plain({ ...stamp, decisionId: "" }))).toBeNull();
    expect(readPinProvenance(plain({ ...stamp, fallback: false }))).toBeNull();
    expect(readPinProvenance(plain({ ...stamp, decidedAt: "never" }))).toBeNull();
    expect(readPinProvenance(plain({ ...stamp, agentId: 7 }))).toEqual({ ...stamp, agentId: null });
  });
});
