import { describe, expect, it } from "vitest";

import { planApply, selectionWritesAllowed } from "../src/actuate/apply.js";
import { selectModel } from "../src/engine/select.js";
import { NO_ESCALATION, NOW, PROFILES, config } from "./fixtures.js";

const base = { profiles: PROFILES, signals: NO_ESCALATION, now: NOW };
const clean = { hasExistingOverride: false, hasExistingTierLabel: false, status: "in_progress" };

function decide(descriptor: Parameters<typeof selectModel>[0]["descriptor"], enforce = true) {
  return selectModel({ ...base, descriptor, config: config({ enforcementEnabled: enforce }) });
}

describe("write policy", () => {
  it("writes the model as an arbitrary pin, never as modelProfile cheap", () => {
    // modelProfile "cheap" carries effort: "" and the merge puts the adapter
    // default first (heartbeat.ts:3523-3525) — the known ACP effort outage path.
    const plan = planApply(decide({ issueId: "i1", labelNames: ["tier:T1"] }), clean, "i1");
    expect(plan.write).toBe(true);
    expect(plan.modelId).toBe("claude-opus-5");
    expect(JSON.stringify(plan)).not.toContain("modelProfile");
  });

  it("writes nothing in advisory mode", () => {
    const plan = planApply(decide({ issueId: "i1", labelNames: ["tier:T1"] }, false), clean, "i1");
    expect(plan.write).toBe(false);
    expect(plan.reason).toContain("advisory");
  });

  it("never re-pins an issue that already has an override", () => {
    // Re-pinning mid-flight resets the session and discards the prompt cache.
    // A wrong tier is a finding for the NEXT issue, not a reason to re-pin.
    const plan = planApply(
      decide({ issueId: "i1", labelNames: ["tier:T1"] }),
      { ...clean, hasExistingOverride: true },
      "i1",
    );
    expect(plan.write).toBe(false);
    expect(plan.reason).toContain("prompt cache");
  });

  it("pins capability-excluded work to the selected T1 model", () => {
    const plan = planApply(
      decide({
        issueId: "i1",
        agentFloorModelId: "claude-haiku-4-5-20251001",
        exclusion: { excluded: true, reasons: ["spends money"] },
      }),
      clean,
      "i1",
    );
    expect(plan.write).toBe(true);
    expect(plan.modelId).toBe("claude-opus-5");
    expect(plan.labelName).toBe("tier:T1");
  });

  it("does not touch finished work", () => {
    for (const status of ["done", "cancelled"]) {
      const plan = planApply(decide({ issueId: "i1", labelNames: ["tier:T1"] }), { ...clean, status }, "i1");
      expect(plan.write).toBe(false);
      expect(plan.reason).toContain(status);
    }
  });

  it("attaches the tier label alongside the override when one is missing", () => {
    const plan = planApply(decide({ issueId: "i1", agentFloorModelId: "claude-sonnet-5" }), clean, "i1");
    expect(plan.write).toBe(true);
    expect(plan.labelName).toBe("tier:T2");
  });

  it("does not duplicate a tier label the issue already carries", () => {
    const plan = planApply(
      decide({ issueId: "i1", labelNames: ["tier:T1"] }),
      { ...clean, hasExistingTierLabel: true },
      "i1",
    );
    expect(plan.labelName).toBeNull();
  });

  it("writes nothing when the engine held at the floor", () => {
    const held = selectModel({
      ...base,
      profiles: PROFILES.map((p) => ({ ...p, sampleCount: 1 })),
      descriptor: { issueId: "i1", labelNames: ["tier:T1"] },
      config: config({ enforcementEnabled: true }),
    });
    const plan = planApply(held, clean, "i1");
    expect(plan.write).toBe(false);
    expect(plan.reason).toContain("held-at-floor");
  });

  it("TOG-12431: selectionWritesAllowed is true only for enabled + enforce", () => {
    // The single gate every router-owned pin site checks. Both conjuncts
    // matter: advise mode computes without writing, and selection disabled
    // writes nothing regardless of mode.
    expect(selectionWritesAllowed({ selection: { enabled: true, mode: "enforce" } })).toBe(true);
    expect(selectionWritesAllowed({ selection: { enabled: true, mode: "advise" } })).toBe(false);
    expect(selectionWritesAllowed({ selection: { enabled: false, mode: "enforce" } })).toBe(false);
    expect(selectionWritesAllowed({ selection: { enabled: false, mode: "advise" } })).toBe(false);
  });

  it("TOG-3210: never writes a wake-scoped decision, even in enforce mode — the card's real tier survives untouched", () => {
    const wakeScoped = selectModel({
      ...base,
      descriptor: { issueId: "i1", labelNames: ["tier:T1"], wakeReason: "monitor" },
      config: config({
        enforcementEnabled: true,
        wakeScopedFloor: { enabled: true, wakeReasons: ["monitor"], floorTier: "T3" },
      }),
    });
    expect(wakeScoped.modelId).toBe("claude-haiku-4-5-20251001");
    const plan = planApply(wakeScoped, clean, "i1");
    expect(plan.write).toBe(false);
    expect(plan.reason).toContain("advisory");
  });
});
