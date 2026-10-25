import { describe, expect, it } from "vitest";

import {
  driftActive,
  emptyShadowWindow,
  parseShadowWindow,
  recordShadowOutcome,
  SHADOW_WINDOW_MAX,
  shadowStats,
  type ShadowOutcome,
} from "../src/engine/classifier-shadow.js";

const T1: ShadowOutcome = { t: "T1", b: null, a: null };
const AGREE: ShadowOutcome = { t: "T2", b: "T2", a: true };
const DISAGREE: ShadowOutcome = { t: "T1", b: "T2", a: false };

describe("classifier shadow window", () => {
  it("appends outcomes and caps the window at 50, dropping the oldest", () => {
    expect(SHADOW_WINDOW_MAX).toBe(50);
    let window = emptyShadowWindow();
    window = recordShadowOutcome(window, DISAGREE);
    for (let i = 0; i < 60; i += 1) {
      window = recordShadowOutcome(window, AGREE);
    }
    expect(window.outcomes).toHaveLength(50);
    // The first outcome (the disagreement) fell off the front.
    expect(window.outcomes.every((o) => o.a === true)).toBe(true);
  });

  it("does not mutate the input window", () => {
    const before = emptyShadowWindow();
    const after = recordShadowOutcome(before, AGREE);
    expect(before.outcomes).toHaveLength(0);
    expect(after.outcomes).toHaveLength(1);
  });

  it("parses stored state fail-open", () => {
    expect(parseShadowWindow(null)).toEqual({ outcomes: [] });
    expect(parseShadowWindow({})).toEqual({ outcomes: [] });
    expect(parseShadowWindow({ outcomes: "nope" })).toEqual({ outcomes: [] });
    expect(parseShadowWindow({ outcomes: [{ t: "T9", b: "T2", a: true }, AGREE, null] })).toEqual({
      outcomes: [AGREE],
    });
    // Over-long stored windows are trimmed to the cap, keeping the newest.
    const long = { outcomes: Array.from({ length: 80 }, () => AGREE) };
    expect(parseShadowWindow(long).outcomes).toHaveLength(50);
  });

  it("counts stats with abstentions excluded from the agreement denominator", () => {
    let window = emptyShadowWindow();
    window = recordShadowOutcome(window, AGREE);
    window = recordShadowOutcome(window, DISAGREE);
    window = recordShadowOutcome(window, T1);
    expect(shadowStats(window)).toEqual({ n: 3, decisive: 2, agreed: 1, t1: 2 });
  });

  it("gates drift on a full window and the T1 share", () => {
    const full = (t1: number): ReturnType<typeof emptyShadowWindow> => {
      let window = emptyShadowWindow();
      for (let i = 0; i < t1; i += 1) window = recordShadowOutcome(window, T1);
      for (let i = t1; i < 50; i += 1) window = recordShadowOutcome(window, AGREE);
      return window;
    };
    // 42/50 = 84%: under the 0.85 bar, and above the measured 0.77 skew.
    expect(driftActive(full(42), 50, 0.85)).toBe(false);
    // 43/50 = 86%: drift.
    expect(driftActive(full(43), 50, 0.85)).toBe(true);
    // A short window never drifts, even all-T1.
    let short = emptyShadowWindow();
    for (let i = 0; i < 49; i += 1) short = recordShadowOutcome(short, T1);
    expect(driftActive(short, 50, 0.85)).toBe(false);
  });
});
