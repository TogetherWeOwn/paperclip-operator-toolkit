import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  rowAdmissionHeadroomMs,
  runRowWithinBudget,
  scanMarkAfterWalk,
  walkRowsWithinDeadline,
  type RowVerdict,
} from "../src/row-walk.js";

// TOG-11688: the shared hard-return walk. `Date` and timers are faked
// TOGETHER — production arms the race timer at row start for the remaining
// budget, so a Date-only jump would leave the timer far in the future.
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const BUDGET_MS = 200_000;
const SLICE_MS = 30_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

/** A row body that spends `costMs` of fake time, then reports `verdict`. */
function costing(costMs: number, verdict: RowVerdict = "settled") {
  return () => new Promise<RowVerdict>((resolve) => setTimeout(() => resolve(verdict), costMs));
}

describe("rowAdmissionHeadroomMs", () => {
  it("is the fixed slice before any row has run", () => {
    expect(rowAdmissionHeadroomMs(SLICE_MS, 0)).toBe(SLICE_MS);
  });

  it("is 1.5x the slowest row once that exceeds the slice", () => {
    expect(rowAdmissionHeadroomMs(SLICE_MS, 40_000)).toBe(60_000);
    expect(rowAdmissionHeadroomMs(SLICE_MS, 10_000)).toBe(SLICE_MS);
  });
});

describe("runRowWithinBudget", () => {
  it("returns the value when the work beats the deadline", async () => {
    const outcome = runRowWithinBudget(Promise.resolve("ok"), T0 + 1_000);
    await expect(outcome).resolves.toEqual({ timedOut: false, value: "ok" });
  });

  it("times out at the deadline and swallows a late rejection", async () => {
    const late = new Promise<string>((_, reject) => setTimeout(() => reject(new Error("late")), 5_000));
    const outcome = runRowWithinBudget(late, T0 + 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toEqual({ timedOut: true });
    // The loser rejects after the race settled: no unhandled rejection.
    await vi.advanceTimersByTimeAsync(5_000);
  });

  it("times out at once when the deadline already passed", async () => {
    const never = new Promise<string>(() => undefined);
    await expect(runRowWithinBudget(never, T0)).resolves.toEqual({ timedOut: true });
  });

  it("propagates a rejection that beats the deadline to the caller", async () => {
    await expect(runRowWithinBudget(Promise.reject(new Error("row failed")), T0 + 1_000)).rejects.toThrow("row failed");
  });
});

describe("walkRowsWithinDeadline", () => {
  it("returns by the deadline when a row outruns the budget, and leaves the row unexamined", async () => {
    const deadlineAt = T0 + BUDGET_MS;
    let resolvedAt: number | null = null;
    let finishedLate = false;
    const pending = walkRowsWithinDeadline(
      ["a", "b", "c"],
      { deadlineAt, rowTimeoutMs: SLICE_MS },
      async (row) => {
        if (row === "a") return costing(10_000)();
        await new Promise((resolve) => setTimeout(resolve, BUDGET_MS * 2));
        finishedLate = true;
        return "settled";
      },
    ).then((walk) => {
      resolvedAt = Date.now();
      return walk;
    });

    await vi.advanceTimersByTimeAsync(BUDGET_MS + 1);
    expect(resolvedAt).not.toBeNull();
    expect(resolvedAt as unknown as number).toBeLessThanOrEqual(deadlineAt);
    const walk = await pending;
    expect(walk.examined).toEqual(["a"]);
    expect(walk.settledPrefix).toBe(1);
    expect(walk.budgetExhausted).toBe(true);
    expect(walk.abandoned).toEqual({ row: "b", rowDurationMs: BUDGET_MS - 10_000 });
    expect(walk.slowestRowMs).toBe(BUDGET_MS - 10_000);
    // The abandoned body keeps running — callers gate their writes on it.
    expect(finishedLate).toBe(false);
    await vi.advanceTimersByTimeAsync(BUDGET_MS * 2);
    expect(finishedLate).toBe(true);
  });

  it("refuses a row when the remaining budget cannot cover 1.5x the slowest row", async () => {
    // Row a costs 40 s and leaves 45 s: the fixed 30 s slice alone would
    // admit b, but 1.5 x 40 s = 60 s headroom refuses it.
    const started: string[] = [];
    const pending = walkRowsWithinDeadline(
      ["a", "b"],
      { deadlineAt: T0 + 85_000, rowTimeoutMs: SLICE_MS },
      async (row) => {
        started.push(row);
        return costing(40_000)();
      },
    );
    await vi.advanceTimersByTimeAsync(40_000);
    const walk = await pending;
    expect(started).toEqual(["a"]);
    expect(walk.examined).toEqual(["a"]);
    expect(walk.slowestRowMs).toBe(40_000);
    expect(walk.budgetExhausted).toBe(true);
    expect(walk.abandoned).toBeNull();
  });

  it("admits a row the fixed slice covers when no row has been slow", async () => {
    const pending = walkRowsWithinDeadline(
      ["a", "b"],
      { deadlineAt: T0 + 85_000, rowTimeoutMs: SLICE_MS },
      async () => costing(10_000)(),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    const walk = await pending;
    expect(walk.examined).toEqual(["a", "b"]);
    expect(walk.budgetExhausted).toBe(false);
  });

  it("admits on the slowest row of the FIRING when seeded by an earlier company", async () => {
    // 85 s left covers the 30 s slice, but an earlier walk saw a 60 s row:
    // 1.5 x 60 s = 90 s headroom refuses the first row of this walk.
    const started: string[] = [];
    const walk = await walkRowsWithinDeadline(
      ["a"],
      { deadlineAt: T0 + 85_000, rowTimeoutMs: SLICE_MS, slowestRowMs: 60_000 },
      async (row) => {
        started.push(row);
        return "settled";
      },
    );
    expect(started).toEqual([]);
    expect(walk.budgetExhausted).toBe(true);
    expect(walk.slowestRowMs).toBe(60_000);
  });

  it("stops at the row cap without exhausting the budget", async () => {
    const walk = await walkRowsWithinDeadline(
      ["a", "b", "c"],
      { deadlineAt: T0 + BUDGET_MS, rowTimeoutMs: SLICE_MS, maxRows: 2 },
      async () => "settled",
    );
    expect(walk.examined).toEqual(["a", "b"]);
    expect(walk.settledPrefix).toBe(2);
    expect(walk.rowCapHit).toBe(true);
    expect(walk.budgetExhausted).toBe(false);
  });

  it("closes the settled prefix at the first unsettled row but walks on", async () => {
    const verdicts: Record<string, RowVerdict> = { a: "settled", b: "unsettled", c: "settled" };
    const walk = await walkRowsWithinDeadline(
      ["a", "b", "c"],
      { deadlineAt: T0 + BUDGET_MS, rowTimeoutMs: SLICE_MS },
      async (row) => verdicts[row] as RowVerdict,
    );
    expect(walk.examined).toEqual(["a", "b", "c"]);
    expect(walk.settledPrefix).toBe(1);
    expect(walk.unsettled).toBe(1);
  });

  it("ends the walk on `stop`, counting the stopping row as settled", async () => {
    const walk = await walkRowsWithinDeadline(
      ["a", "b", "c"],
      { deadlineAt: T0 + BUDGET_MS, rowTimeoutMs: SLICE_MS },
      async (row) => (row === "b" ? "stop" : "settled"),
    );
    expect(walk.examined).toEqual(["a", "b"]);
    expect(walk.settledPrefix).toBe(2);
    expect(walk.stoppedByCaller).toBe(true);
  });

  it("walks unbounded with a null deadline", async () => {
    vi.setSystemTime(T0 + 10 * BUDGET_MS);
    const pending = walkRowsWithinDeadline(
      ["a", "b"],
      { deadlineAt: null, rowTimeoutMs: SLICE_MS },
      async () => costing(BUDGET_MS)(),
    );
    await vi.advanceTimersByTimeAsync(2 * BUDGET_MS);
    const walk = await pending;
    expect(walk.examined).toEqual(["a", "b"]);
    expect(walk.budgetExhausted).toBe(false);
  });

  it("lets a row error that beats the deadline reach the caller", async () => {
    await expect(
      walkRowsWithinDeadline(["a"], { deadlineAt: T0 + BUDGET_MS, rowTimeoutMs: SLICE_MS }, () => {
        throw new Error("sync row error");
      }),
    ).rejects.toThrow("sync row error");
  });
});

describe("scanMarkAfterWalk", () => {
  const FIRING = T0 + 1_000_000;
  const at = (ms: number) => ({ updated_at: new Date(T0 + ms).toISOString() });

  it("jumps to the firing start when every row settled and the fetch drained", () => {
    expect(scanMarkAfterWalk([at(0), at(1_000)], 2, 10, FIRING)).toBe(FIRING);
  });

  it("stops at the last settled row before the first unpassed one", () => {
    expect(scanMarkAfterWalk([at(0), at(1_000), at(2_000)], 2, 10, FIRING)).toBe(T0 + 1_000);
  });

  it("backs off below an unpassed row that ties the last settled row", () => {
    // `updated_at > mark` would hide the tied, unsettled row.
    expect(scanMarkAfterWalk([at(0), at(1_000), at(1_000)], 2, 10, FIRING)).toBe(T0 + 999);
  });

  it("backs off below the last settled row of a capped fetch (its next row is unseen)", () => {
    expect(scanMarkAfterWalk([at(0), at(1_000)], 2, 2, FIRING)).toBe(T0 + 999);
  });

  it("leaves the mark unchanged when no row is settled", () => {
    expect(scanMarkAfterWalk([at(0), at(1_000)], 0, 10, FIRING)).toBeNull();
  });

  it("never moves the mark on rows without a parseable updated_at", () => {
    expect(scanMarkAfterWalk([{ updated_at: "nonsense" }, at(1_000)], 1, 10, FIRING)).toBeNull();
    expect(scanMarkAfterWalk([at(0), { updated_at: null }], 1, 10, FIRING)).toBe(T0 - 1);
  });

  it("accepts Date-typed updated_at from the driver", () => {
    const rows = [{ updated_at: new Date(T0) }, { updated_at: new Date(T0 + 5_000) }];
    expect(scanMarkAfterWalk(rows, 1, 10, FIRING)).toBe(T0);
  });
});
