/**
 * A small stale-while-revalidate cache for the run-scoped decision
 * path: data on that path is served from memory, refreshed off
 * it, and served STALE when a refresh fails — never fetched inline on a warm
 * hit, and never allowed to hold the caller past its budget on a cold one.
 *
 * - Fresh entry: returned as is.
 * - Stale entry: returned immediately; one refresh runs in the background
 *   (single flight per key). A refresh that throws leaves the stale value in
 *   place and is recorded, so a broken source degrades to old data rather
 *   than to no decision.
 * - Missing entry: the loader runs (single flight); the caller waits at most
 *   `budgetMs`, then gets {@link HotCacheTimeout}. The loader keeps going and
 *   fills the cache for the next caller.
 */
export class HotCacheTimeout extends Error {
  constructor(readonly key: string, readonly budgetMs: number) {
    super(`hot cache load for "${key}" exceeded ${budgetMs} ms`);
    this.name = "HotCacheTimeout";
  }
}

interface Entry<V> {
  value: V;
  loadedAtMs: number;
}

export interface HotCacheOptions {
  ttlMs: number; // mutable via setTtl
  /** Oldest entries are evicted past this many keys. */
  maxEntries: number;
  now?: () => number;
  /** Called with every refresh failure; the cache itself never throws for them. */
  onRefreshError?: (key: string, error: unknown) => void;
}

export class HotCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly inflight = new Map<string, Promise<V>>();
  private readonly now: () => number;

  constructor(private readonly options: HotCacheOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Applies a config-driven TTL to entries already held and to future reads. */
  setTtl(ttlMs: number): void {
    this.options.ttlMs = ttlMs;
  }

  /** Cached value or `undefined`; never triggers a load. */
  peek(key: string): { value: V; ageMs: number } | undefined {
    const entry = this.entries.get(key);
    return entry ? { value: entry.value, ageMs: this.now() - entry.loadedAtMs } : undefined;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, loadedAtMs: this.now() });
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  private load(key: string, loader: () => Promise<V>): Promise<V> {
    const running = this.inflight.get(key);
    if (running) return running;
    const started = loader().then((value) => {
      this.set(key, value);
      return value;
    });
    const tracked = started.finally(() => {
      if (this.inflight.get(key) === tracked) this.inflight.delete(key);
    });
    this.inflight.set(key, tracked);
    // A background refresh nobody awaits must not become an unhandled rejection.
    tracked.catch(() => {});
    return tracked;
  }

  async get(
    key: string,
    loader: () => Promise<V>,
    budgetMs: number,
  ): Promise<{ value: V; ageMs: number; stale: boolean }> {
    const cached = this.peek(key);
    if (cached) {
      if (cached.ageMs < this.options.ttlMs) return { ...cached, stale: false };
      this.load(key, loader).catch((error: unknown) => this.options.onRefreshError?.(key, error));
      return { ...cached, stale: true };
    }
    const pending = this.load(key, loader);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HotCacheTimeout(key, budgetMs)), Math.max(0, budgetMs));
    });
    try {
      const value = await Promise.race([pending, budget]);
      return { value, ageMs: 0, stale: false };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Awaitable refresh used by the warm-up job; failures keep the stale entry. */
  async refresh(key: string, loader: () => Promise<V>): Promise<boolean> {
    try {
      await this.load(key, loader);
      return true;
    } catch (error) {
      this.options.onRefreshError?.(key, error);
      return false;
    }
  }
}

/** Resolves with `fallback` when `promise` has not settled within `ms`. Never rejects on its own. */
export async function withinMs<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), Math.max(0, ms));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
