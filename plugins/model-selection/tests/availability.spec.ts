import { describe, expect, it } from "vitest";

import { normalizeAvailability } from "../src/engine/availability.js";
import { selectModel } from "../src/engine/select.js";
import { LANED_MODELS, NOW, NO_ESCALATION, PROFILES, account, config, laneDoc } from "./fixtures.js";

const base = { profiles: PROFILES, signals: NO_ESCALATION, now: NOW };

/**
 * Acceptance criterion 5. Every test here is a PAIR: one lane state that must be
 * excluded, and one that must not. A gate with only the failing half passes
 * just as well when it excludes everything — which is exactly how a "working"
 * availability term takes the whole roster out and still reads as correct.
 *
 * Roster (fixtures): haiku = T3 alone on the `zai` lane; sonnet = T2 and
 * opus = T1 share the `claude` lane. A `tier:T3` card therefore picks haiku
 * when `zai` serves and escalates to sonnet when it does not.
 */

const HAIKU = "claude-haiku-4-5-20251001";
const HEALTHY_CLAUDE = [account("claude", "claude-a"), account("claude", "claude-b")];
const HEALTHY_ZAI = [account("zai", "zai-a"), account("zai", "zai-b")];

function snapshot(records: Array<Record<string, unknown>>, observedAt?: string) {
  return normalizeAvailability(laneDoc(records, observedAt), NOW);
}

function select(
  records: Array<Record<string, unknown>>,
  descriptor: Record<string, unknown> = {},
  configOverrides: Record<string, unknown> = {},
) {
  return selectModel({
    ...base,
    descriptor: { issueId: "i1", labelNames: ["tier:T3"], ...descriptor } as never,
    config: config({ models: LANED_MODELS, ...(configOverrides as object) }),
    availability: snapshot(records),
  });
}

describe("availability — quota exhaustion (the 2026-09-16 22:29Z shape)", () => {
  const exhaustedZai = HEALTHY_ZAI.map((record) =>
    account("zai", String(record.account_key), {
      windows: [
        {
          name: "five_hour",
          role: "serviceability",
          utilization: 1,
          resets_at: new Date(NOW + 3600_000).toISOString(),
          window_seconds: 18_000,
          allowance_weight: 1,
        },
        {
          name: "weekly",
          role: "allowance",
          utilization: 0.5,
          resets_at: new Date(NOW + 48 * 3600_000).toISOString(),
          window_seconds: 604_800,
          allowance_weight: 1,
        },
      ],
    }),
  );

  it("excludes a lane with a window at utilization 1.0, and escalates instead", () => {
    // Measured: a 5-hour window stood at 1.0 and 52 runs were refused while the
    // cheapest capable row on that lane was still the selector's obvious pick.
    const lanes = snapshot([...HEALTHY_CLAUDE, ...exhaustedZai]).lanes;
    expect(lanes.find((lane) => lane.laneId === "zai")?.state).toBe("unavailable");
    expect(lanes.find((lane) => lane.laneId === "zai")?.term).toBe("quota");

    const decision = select([...HEALTHY_CLAUDE, ...exhaustedZai]);
    expect(decision.modelId).toBe("claude-sonnet-5");
    expect(decision.rejections.filter((r) => r.stage === "lane-availability").map((r) => r.modelId)).toEqual([HAIKU]);
  });

  it("does not exclude a lane with headroom on every window", () => {
    // The positive control for the test above, on the same document shape.
    const lanes = snapshot([...HEALTHY_CLAUDE, ...HEALTHY_ZAI]).lanes;
    expect(lanes.map((lane) => lane.state)).toEqual(["available", "available"]);

    const decision = select([...HEALTHY_CLAUDE, ...HEALTHY_ZAI]);
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe(HAIKU);
    expect(decision.availability.excluded).toEqual([]);
  });

  it("excludes on a binding allowance with nothing left, by the controller's own rule", () => {
    // `cliproxy_quota_controller.py:140-145` — serviceable requires
    // `binding.remaining_allowance > 0`, where binding is the lowest
    // clear-rate `allowance`-role window. Two consumers disagreeing about
    // this is how a lane gets disabled on the host and still selected here.
    const spent = HEALTHY_ZAI.map((record) =>
      account("zai", String(record.account_key), {
        windows: [
          {
            name: "weekly",
            role: "allowance",
            utilization: 0.999999,
            resets_at: new Date(NOW + 48 * 3600_000).toISOString(),
            window_seconds: 604_800,
            allowance_weight: 0,
          },
        ],
      }),
    );
    expect(snapshot([...HEALTHY_CLAUDE, ...spent]).lanes.find((l) => l.laneId === "zai")?.term).toBe("quota");
  });
});

describe("availability — cooldown (the 2026-09-17 00:39Z shape)", () => {
  it("excludes a lane in cooldown even when it publishes health: healthy", () => {
    // That refusal came from the `subscription-pool` plugin's own rate-limit
    // cooldown, at weekly 0.46 / 5h 0.60. Both quota fractions were true and
    // neither one was the binding state.
    const cooling = HEALTHY_ZAI.map((record) =>
      account("zai", String(record.account_key), {
        health: "healthy",
        cooldown: {
          until: new Date(NOW + 4 * 60_000).toISOString(),
          reason: "conservative rate-limit cooldown",
        },
      }),
    );
    const lane = snapshot([...HEALTHY_CLAUDE, ...cooling]).lanes.find((l) => l.laneId === "zai");
    expect(lane?.state).toBe("unavailable");
    expect(lane?.term).toBe("cooldown");
    expect(lane?.reason).toContain("conservative rate-limit cooldown");

    const decision = select([...HEALTHY_CLAUDE, ...cooling]);
    expect(decision.modelId).toBe("claude-sonnet-5");
    expect(decision.availability.excluded.map((note) => note.term)).toEqual(["cooldown"]);
  });

  it("does not exclude a lane whose cooldown has already expired", () => {
    const expired = HEALTHY_ZAI.map((record) =>
      account("zai", String(record.account_key), {
        cooldown: { until: new Date(NOW - 60_000).toISOString(), reason: "expired" },
      }),
    );
    expect(snapshot([...HEALTHY_CLAUDE, ...expired]).lanes.find((l) => l.laneId === "zai")?.state).toBe("available");
    expect(select([...HEALTHY_CLAUDE, ...expired]).modelId).toBe(HAIKU);
  });

  it("excludes on health: cooldown, which the router's normalizer only down-ranks", () => {
    // Measured against the real `router/src/capacity/normalize.ts`:
    // "cooldown" lands in that module's *degraded* bucket, `postureFor` turns
    // degraded into `avoid`, and an avoided lane stays selectable. Here every
    // value that is not positively `healthy` takes the lane out.
    for (const value of ["cooldown", "cooling_down", "exhausted", "unavailable", "a-value-from-the-future"]) {
      const records = HEALTHY_ZAI.map((record) => account("zai", String(record.account_key), { health: value }));
      const lane = snapshot([...HEALTHY_CLAUDE, ...records]).lanes.find((l) => l.laneId === "zai");
      expect(lane?.state, value).toBe("unavailable");
    }
    // Positive control: the one value that does NOT exclude.
    const healthy = HEALTHY_ZAI.map((record) => account("zai", String(record.account_key), { health: "healthy" }));
    expect(snapshot([...HEALTHY_CLAUDE, ...healthy]).lanes.find((l) => l.laneId === "zai")?.state).toBe("available");
  });

  it("buckets cooldown health under the cooldown term, not the health term", () => {
    // The term is what an operator acts on: a cooldown is a four-minute wait,
    // an exhausted window is a five-hour one, and reporting the wrong one
    // sends someone to the wrong dashboard (AC-6).
    const cooling = HEALTHY_ZAI.map((r) => account("zai", String(r.account_key), { health: "cooldown" }));
    const dead = HEALTHY_ZAI.map((r) => account("zai", String(r.account_key), { health: "unavailable" }));
    expect(snapshot([...HEALTHY_CLAUDE, ...cooling]).lanes.find((l) => l.laneId === "zai")?.term).toBe("cooldown");
    expect(snapshot([...HEALTHY_CLAUDE, ...dead]).lanes.find((l) => l.laneId === "zai")?.term).toBe("health");
  });

  it("excludes a cooldown record that carries no utilization window at all", () => {
    // The fail-open trap. A pure cooldown record is the natural producer shape
    // — a cooldown is not a utilization — it yields zero evidence rows in the
    // router's collector, and a consumer with zero evidence fails open. Evaluating the cooldown off the RECORD rather than off the
    // windows is what closes it.
    const bare = [
      {
        account_key: "zai-a",
        auth_key: "zai-a-auth",
        provider: "zai",
        health: "healthy",
        stale_after_seconds: 3600,
        cooldown: { until: new Date(NOW + 240_000).toISOString(), reason: "rate limit" },
      },
    ];
    const lane = snapshot([...HEALTHY_CLAUDE, ...bare]).lanes.find((l) => l.laneId === "zai");
    expect(lane?.state).toBe("unavailable");
    expect(lane?.term).toBe("cooldown");

    // Control, same missing-windows shape without the cooldown: that IS a gap
    // in the telemetry, so it is UNKNOWN — not available, and not excluded.
    const noCooldown = [{ ...bare[0], cooldown: undefined }];
    expect(snapshot([...HEALTHY_CLAUDE, ...noCooldown]).lanes.find((l) => l.laneId === "zai")?.state).toBe("unknown");
  });
});

describe("availability — account count (AC-3)", () => {
  const soloZai = [...HEALTHY_CLAUDE, account("zai", "zai-solo")];

  it("excludes a single-account lane from fleet-default traffic at any quota level", () => {
    // 0.46 weekly is plenty of quota. It is still one credential, and the
    // limiter is requests-per-window PER ACCOUNT: ~25 agents arriving at once
    // is what actually refused, not the percentage.
    const decision = select(soloZai, { trafficScale: "fleet-default" });
    expect(decision.availability.excluded.map((note) => [note.modelId, note.term])).toEqual([[HAIKU, "accounts"]]);
    expect(decision.modelId).toBe("claude-sonnet-5");
  });

  it("does not exclude the same single-account lane from issue-scale traffic", () => {
    // The positive control that keeps the rule from degenerating into "one
    // account is always ineligible".
    const decision = select(soloZai);
    expect(decision.modelId).toBe(HAIKU);
    expect(decision.availability.excluded).toEqual([]);
  });

  it("does not exclude a two-account lane from fleet-default traffic", () => {
    const decision = select([...HEALTHY_CLAUDE, ...HEALTHY_ZAI], { trafficScale: "fleet-default" });
    expect(decision.modelId).toBe(HAIKU);
    expect(decision.availability.excluded).toEqual([]);
  });

  it("counts only SERVICEABLE accounts toward the fleet-default rule", () => {
    // Two accounts on the lane, one of them exhausted, is ONE usable account.
    // Counting rows rather than serviceable rows is the subtle version of this
    // bug and it survives every other assertion in this file.
    const halfDead = [account("zai", "zai-a"), account("zai", "zai-b", { health: "exhausted" })];
    const lane = snapshot([...HEALTHY_CLAUDE, ...halfDead]).lanes.find((l) => l.laneId === "zai");
    expect(lane?.state).toBe("available");
    expect(lane?.accountCount).toBe(2);
    expect(lane?.serviceableAccountCount).toBe(1);

    expect(select([...HEALTHY_CLAUDE, ...halfDead], { trafficScale: "fleet-default" }).availability.excluded[0]?.term)
      .toBe("accounts");
    // Control: the same lane still serves ordinary issue-scale traffic.
    expect(select([...HEALTHY_CLAUDE, ...halfDead]).modelId).toBe(HAIKU);
  });
});

describe("availability — staleness is tri-state, and the UNKNOWN is said", () => {
  it("reports UNKNOWN past the shared 120-minute cutoff, and does not call it available", () => {
    const records = [...HEALTHY_CLAUDE, ...HEALTHY_ZAI].map((r) => ({ ...r, stale_after_seconds: 86_400 }));
    const stale = normalizeAvailability(laneDoc(records, new Date(NOW - 121 * 60_000).toISOString()), NOW);
    expect(stale.lanes.map((lane) => lane.state)).toEqual(["unknown", "unknown"]);
    expect(stale.lanes[0]?.term).toBe("staleness");

    // Positive control: 119 minutes, same records, still readable.
    const fresh = normalizeAvailability(laneDoc(records, new Date(NOW - 119 * 60_000).toISOString()), NOW);
    expect(fresh.lanes.map((lane) => lane.state)).toEqual(["available", "available"]);
  });

  it("honours a record's own tighter stale_after_seconds", () => {
    // 120 minutes is a floor for every consumer, not a ceiling for any of them.
    const records = [...HEALTHY_CLAUDE, ...HEALTHY_ZAI].map((r) => ({ ...r, stale_after_seconds: 300 }));
    const stale = normalizeAvailability(laneDoc(records, new Date(NOW - 10 * 60_000).toISOString()), NOW);
    expect(stale.lanes.every((lane) => lane.state === "unknown")).toBe(true);

    const fresh = normalizeAvailability(laneDoc(records, new Date(NOW - 60_000).toISOString()), NOW);
    expect(fresh.lanes.every((lane) => lane.state === "available")).toBe(true);
  });

  it("says UNKNOWN on the decision rather than passing quietly", () => {
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
      config: config({ models: LANED_MODELS }),
      availability: normalizeAvailability(
        laneDoc([...HEALTHY_CLAUDE, ...HEALTHY_ZAI], new Date(NOW - 200 * 60_000).toISOString()),
        NOW,
      ),
    });
    // The decision still lands — the agent floor is itself a cliproxy lane, so
    // a dead feed must not take every selection out — but it is not silent.
    expect(decision.outcome).toBe("selected");
    expect(decision.availability.selectedOnUnknownLane).toBe(true);
    expect(decision.availability.unknown.map((note) => note.term)).toContain("staleness");
    expect(decision.trace.some((line) => line.includes("availability UNKNOWN"))).toBe(true);

    // Positive control: a fresh document selects the same model and says nothing.
    const live = select([...HEALTHY_CLAUDE, ...HEALTHY_ZAI]);
    expect(live.modelId).toBe(decision.modelId);
    expect(live.availability.selectedOnUnknownLane).toBe(false);
    expect(live.trace.some((line) => line.includes("availability UNKNOWN"))).toBe(false);
  });

  it("holds at the floor on UNKNOWN when the operator asks it to, rather than reporting exhaustion", () => {
    const stale = normalizeAvailability(
      laneDoc([...HEALTHY_CLAUDE, ...HEALTHY_ZAI], new Date(NOW - 200 * 60_000).toISOString()),
      NOW,
    );
    const held = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
      config: config({ models: LANED_MODELS, holdOnUnknownAvailability: true }),
      availability: stale,
    });
    // NOT `tier-exhausted`: a blind instrument is not a capacity dead end, and
    // reporting it as one sends an operator to the quota dashboards.
    expect(held.outcome).toBe("held-at-floor");
    expect(held.heldReason).toContain("UNKNOWN");

    // Positive control: the same policy with a readable document selects.
    const seen = select([...HEALTHY_CLAUDE, ...HEALTHY_ZAI], {}, { holdOnUnknownAvailability: true });
    expect(seen.outcome).toBe("selected");
  });

  it("treats an unreadable document as UNKNOWN for every lane, never as healthy", () => {
    const bad: unknown[] = [
      null,
      "nope",
      {},
      { observedAt: "not-a-date", records: [] },
      { observedAt: new Date(NOW).toISOString() },
      { observedAt: new Date(NOW).toISOString(), records: [] },
    ];
    for (const value of bad) {
      const result = normalizeAvailability(value, NOW);
      expect(result.lanes).toEqual([]);
      expect(result.unreadableReason).toBeTruthy();
    }
    // Positive control: the well-formed document reads.
    expect(normalizeAvailability(laneDoc(HEALTHY_ZAI), NOW).unreadableReason).toBeNull();
  });

  it("reports a model with no laneId as UNKNOWN, not as available", () => {
    // Otherwise the gate silently enforces on nothing: every model passes and
    // the term looks healthy precisely because it is reading nothing.
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
      config: config(), // default MODELS declare no lane at all
      availability: snapshot([...HEALTHY_CLAUDE, ...HEALTHY_ZAI]),
    });
    expect(decision.availability.unknown.map((note) => note.term)).toContain("unmapped");
    expect(decision.availability.excluded).toEqual([]);
    expect(decision.outcome).toBe("selected");
  });

  it("reports a lane absent from the snapshot as UNKNOWN rather than available", () => {
    const decision = select(HEALTHY_CLAUDE); // no `zai` records at all
    expect(decision.availability.unknown.map((note) => [note.modelId, note.term])).toEqual([[HAIKU, "unmapped"]]);
    expect(decision.modelId).toBe(HAIKU);
  });
});

describe("availability — the gate excludes rather than down-ranks", () => {
  const deadZai = HEALTHY_ZAI.map((r) => account("zai", String(r.account_key), { health: "exhausted" }));

  it("does not keep a sticky model whose lane will not serve", () => {
    // Sticky returned before any availability gate ran. A warm prompt cache on
    // a lane that returns 500 is worth nothing.
    const decision = select([...HEALTHY_CLAUDE, ...deadZai], { stickyModelId: HAIKU });
    expect(decision.modelId).not.toBe(HAIKU);
    expect(decision.trace.some((line) => line.includes("sticky") && line.includes("availability"))).toBe(true);

    // Positive control: the same sticky model on a live lane is kept.
    const kept = select([...HEALTHY_CLAUDE, ...HEALTHY_ZAI], { stickyModelId: HAIKU });
    expect(kept.modelId).toBe(HAIKU);
    expect(kept.trace.some((line) => line.includes("switching would reset the session"))).toBe(true);
  });

  it("reports tier-exhausted when every lane fails, instead of picking the least-bad one", () => {
    // Not `no-eligible-model`: that reads as a config/capability gap and would
    // report a capacity outage to the wrong owner. `tier-exhausted` is the
    // outcome `worker.ts` escalates to an operator.
    const allDead = [...HEALTHY_CLAUDE, ...HEALTHY_ZAI].map((r) =>
      account(String(r.provider), String(r.account_key), { health: "exhausted" }),
    );
    const decision = select(allDead);
    expect(decision.outcome).toBe("tier-exhausted");
    expect(decision.modelId).toBeNull();
    expect(decision.availability.excluded).toHaveLength(3);
    expect(decision.trace.some((line) => line.startsWith("lane availability excluded 3"))).toBe(true);
  });

  it("records which term excluded each candidate, for the decision stream", () => {
    // AC-6: a closed vocabulary on the record, so "why did this card not get
    // opus" is answerable without grepping prose out of the trace.
    const cooling = HEALTHY_CLAUDE.map((r) =>
      account("claude", String(r.account_key), {
        cooldown: { until: new Date(NOW + 60_000).toISOString(), reason: "rate limit" },
      }),
    );
    const decision = select([...cooling, ...HEALTHY_ZAI], { labelNames: ["tier:T2"] });
    expect(decision.availability.excluded).toEqual([
      {
        modelId: "claude-sonnet-5",
        laneId: "claude",
        term: "cooldown",
        reason: expect.stringContaining("in cooldown until"),
      },
      {
        modelId: "claude-opus-5",
        laneId: "claude",
        term: "cooldown",
        reason: expect.stringContaining("in cooldown until"),
      },
    ]);
    expect(decision.rejections.filter((r) => r.stage === "lane-availability")).toHaveLength(2);
  });

  it("leaves every existing decision unchanged when no availability input is supplied", () => {
    // The backwards-compatibility control: the term is enabled by supplying a
    // snapshot, and an unconfigured gate still SAYS that it is unconfigured.
    const decision = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"] },
      config: config({ models: LANED_MODELS }),
    });
    expect(decision.modelId).toBe(HAIKU);
    expect(decision.availability.configured).toBe(false);
    expect(decision.availability.excluded).toEqual([]);
    expect(decision.trace.some((line) => line.includes("no lane input supplied"))).toBe(true);
  });
});

describe("availability — the agent floor is covered too", () => {
  // An earlier change (on main) added a second exit that hands the run back to the agent
  // floor when the volume profile is untrusted, and made that exit lane-aware
  // against the PACE predicates only. Those are gated on `pacingMode`; the
  // availability term is not. With pacing off — the default in `config()` —
  // the pace half of `floorLaneDead` cannot fire at all, so these two tests
  // isolate the availability half exactly.
  const thin = PROFILES.map((profile) => ({ ...profile, sampleCount: 1 }));
  const exhaustedZai = HEALTHY_ZAI.map((record) =>
    account("zai", String(record.account_key), {
      windows: [
        {
          name: "five_hour",
          role: "serviceability",
          utilization: 1,
          resets_at: new Date(NOW + 3600_000).toISOString(),
          window_seconds: 18_000,
          allowance_weight: 1,
        },
      ],
    }),
  );

  function floorSelect(records: Array<Record<string, unknown>>) {
    return selectModel({
      ...base,
      profiles: thin,
      descriptor: { issueId: "i1", labelNames: ["tier:T3"], agentFloorModelId: HAIKU },
      config: config({ models: LANED_MODELS }),
      availability: snapshot(records),
    });
  }

  it("declines to hold at a floor whose lane the availability term calls unavailable", () => {
    const decision = floorSelect([...HEALTHY_CLAUDE, ...exhaustedZai]);
    expect(decision.outcome).toBe("selected");
    expect(decision.modelId).toBe("claude-sonnet-5");
    // AC-6: the floor never entered the candidate loop, so its exclusion is
    // only answerable after the fact if the floor check records it by term.
    expect(decision.availability.excluded.map((note) => [note.modelId, note.term])).toContainEqual([HAIKU, "quota"]);
    expect(decision.trace.some((line) => line.includes("held-at-floor declined") && line.includes("[quota:"))).toBe(
      true,
    );
  });

  it("still holds at that same floor when its lane is serviceable", () => {
    // The positive control. Identical descriptor, config and profiles; only the
    // lane document differs. Without it, a floor check that excluded on every
    // input would pass the test above just as well.
    const decision = floorSelect([...HEALTHY_CLAUDE, ...HEALTHY_ZAI]);
    expect(decision.outcome).toBe("held-at-floor");
    expect(decision.heldReason).toContain("not trusted");
    expect(decision.availability.excluded).toEqual([]);
    expect(decision.trace.some((line) => line.includes("held-at-floor declined"))).toBe(false);
  });
});
