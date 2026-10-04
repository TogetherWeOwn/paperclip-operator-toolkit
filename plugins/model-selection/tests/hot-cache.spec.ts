import { describe, expect, it, vi } from "vitest";

import { HotCache, HotCacheTimeout, withinMs } from "../src/hot-cache.js";

/** A clock the test owns, so TTL behavior never depends on the wall. */
function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

describe("HotCache (TOG-11793)", () => {
  it("serves a fresh entry without running the loader again", async () => {
    const time = clock();
    const cache = new HotCache<string>({ ttlMs: 1000, maxEntries: 10, now: time.now });
    const loader = vi.fn(async () => "v1");
    await cache.get("k", loader, 100);
    time.advance(999);
    const read = await cache.get("k", loader, 100);
    expect(read).toMatchObject({ value: "v1", stale: false });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("serves a stale entry immediately and refreshes it once in the background", async () => {
    const time = clock();
    const cache = new HotCache<string>({ ttlMs: 1000, maxEntries: 10, now: time.now });
    const gate = deferred<string>();
    let calls = 0;
    const loader = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? "old" : gate.promise;
    });
    await cache.get("k", loader, 100);
    time.advance(1500);
    const first = await cache.get("k", loader, 100);
    const second = await cache.get("k", loader, 100);
    expect(first).toMatchObject({ value: "old", stale: true });
    expect(second).toMatchObject({ value: "old", stale: true });
    // Single flight: two stale reads, one refresh.
    expect(loader).toHaveBeenCalledTimes(2);
    gate.resolve("new");
    await vi.waitFor(() => expect(cache.peek("k")?.value).toBe("new"));
  });

  it("keeps serving the stale value when the refresh fails, and reports the failure", async () => {
    const time = clock();
    const errors: string[] = [];
    const cache = new HotCache<string>({
      ttlMs: 1000,
      maxEntries: 10,
      now: time.now,
      onRefreshError: (key, error) => errors.push(`${key}:${String(error)}`),
    });
    await cache.get("k", async () => "old", 100);
    time.advance(5000);
    const read = await cache.get(
      "k",
      async () => {
        throw new Error("boom");
      },
      100,
    );
    expect(read).toMatchObject({ value: "old", stale: true });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(cache.peek("k")?.value).toBe("old");
  });

  it("times a cold load out at the budget, while the loader keeps running and fills the cache", async () => {
    const cache = new HotCache<string>({ ttlMs: 1000, maxEntries: 10 });
    const gate = deferred<string>();
    await expect(cache.get("k", () => gate.promise, 20)).rejects.toBeInstanceOf(HotCacheTimeout);
    expect(cache.peek("k")).toBeUndefined();
    gate.resolve("late");
    await vi.waitFor(() => expect(cache.peek("k")?.value).toBe("late"));
  });

  it("shares one in-flight cold load between concurrent callers", async () => {
    const cache = new HotCache<string>({ ttlMs: 1000, maxEntries: 10 });
    const gate = deferred<string>();
    const loader = vi.fn(() => gate.promise);
    const reads = [cache.get("k", loader, 200), cache.get("k", loader, 200)];
    gate.resolve("v");
    expect((await Promise.all(reads)).map((read) => read.value)).toEqual(["v", "v"]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("evicts the oldest entry past the cap and honors invalidate", async () => {
    const cache = new HotCache<number>({ ttlMs: 1000, maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.peek("a")).toBeUndefined();
    expect(cache.peek("b")?.value).toBe(2);
    cache.invalidate("b");
    expect(cache.peek("b")).toBeUndefined();
  });

  it("setTtl changes freshness for entries already held", async () => {
    const time = clock();
    const cache = new HotCache<string>({ ttlMs: 10_000, maxEntries: 10, now: time.now });
    await cache.get("k", async () => "v", 100);
    time.advance(2000);
    cache.setTtl(1000);
    const loader = vi.fn(async () => "v2");
    expect((await cache.get("k", loader, 100)).stale).toBe(true);
  });

  it("refresh() reports failure without throwing and leaves the entry", async () => {
    const cache = new HotCache<string>({ ttlMs: 1000, maxEntries: 10 });
    cache.set("k", "kept");
    const ok = await cache.refresh("k", async () => {
      throw new Error("down");
    });
    expect(ok).toBe(false);
    expect(cache.peek("k")?.value).toBe("kept");
  });
});

describe("withinMs", () => {
  it("returns the fallback when the promise has not settled in time, and the value otherwise", async () => {
    expect(await withinMs(new Promise<string>(() => {}), 10, "late")).toBe("late");
    expect(await withinMs(Promise.resolve("fast"), 50, "late")).toBe("fast");
  });
});
