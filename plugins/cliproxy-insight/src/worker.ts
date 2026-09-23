/**
 * Plugin worker.
 *
 * Reads the sanitized CLIProxy telemetry lane (TOG-952) and turns it into
 * durable Paperclip history. CLIProxy's own usage aggregation is in-memory and
 * resets on container restart; the lane's static files are overwritten every 2
 * minutes and keep no history either. Persisting them here is the deliverable.
 *
 * A job context carries no `companyId`. Only host `configChanged` delivery
 * establishes the single configured identity; each firing reads its current
 * scoped config. Missing or conflicting identities leave polling inert.
 */

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, PluginJobContext } from "@paperclipai/plugin-sdk";

import { validateSecretRefShape } from "./config/secret-ref.js";
import {
  DEFAULT_LANE_FILES,
  JOB_KEYS,
  LANE_AUTH_HEADER,
  LANE_COOLDOWN_FIELDS,
  LANE_COOLDOWN_REASON_FIELDS,
  LANE_PATHS,
  LANE_UNSERVICEABLE_HEALTH,
  MAX_COOLDOWN_EVENTS_PER_PROVIDER,
  PLUGIN_VERSION,
  REQUEST_RATE_FIELDS,
  ROUTE_KEYS,
  SEED_PROVIDER_ORDER,
  STATE_KEYS,
  SUPPORTED_SCHEMA_VERSION,
  TOOL_NAMES,
} from "./constants.js";

interface ResolvedConfig {
  pollingEnabled: boolean;
  baseUrl: string;
  laneApiKeySecretRef: unknown;
  requestTimeoutMs: number;
  maxCooldownEventsPerProvider: number;
  staleAfterSeconds: number;
  laneFiles: string[];
  legacyAggregateFiles: boolean;
}

const DEFAULT_BASE_URL = "https://router.example.net/telemetry/cliproxy";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstNumber(record: Record<string, unknown>, fields: readonly string[]): number | null {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function resolveConfig(raw: unknown): ResolvedConfig {
  const r = asRecord(raw);
  return {
    pollingEnabled: r.pollingEnabled === true,
    baseUrl:
      typeof r.baseUrl === "string" && r.baseUrl.length > 0
        ? r.baseUrl.replace(/\/+$/, "")
        : DEFAULT_BASE_URL,
    laneApiKeySecretRef: r.laneApiKeySecretRef ?? null,
    requestTimeoutMs: typeof r.requestTimeoutMs === "number" ? r.requestTimeoutMs : 10000,
    maxCooldownEventsPerProvider:
      typeof r.maxCooldownEventsPerProvider === "number"
        ? r.maxCooldownEventsPerProvider
        : MAX_COOLDOWN_EVENTS_PER_PROVIDER,
    staleAfterSeconds: typeof r.staleAfterSeconds === "number" ? r.staleAfterSeconds : 600,
    // An explicitly empty array means "poll no lane documents" and is honoured;
    // only an absent or non-array value falls back to the default set.
    laneFiles: Array.isArray(r.laneFiles)
      ? r.laneFiles.filter((f): f is string => typeof f === "string" && f.length > 0)
      : [...DEFAULT_LANE_FILES],
    legacyAggregateFiles: r.legacyAggregateFiles === true,
  };
}

/** Per-provider request counters, persisted with observation time. */
interface ProviderRecord {
  schemaVersion: 1;
  provider: string;
  polledAt: string;
  /** Producer's own observation time when it publishes one; else our poll time. */
  observedAt: string;
  success: number | null;
  failed: number | null;
  /** Whatever else the lane published for this provider, kept verbatim. */
  raw: unknown;
}

interface CooldownEvent {
  at: string;
  provider: string;
  reason: string;
  raw: unknown;
}

interface FetchOk {
  ok: true;
  status: number;
  body: unknown;
}
interface FetchFail {
  ok: false;
  status: number | null;
  reason: string;
}

/** Sentinel resolved by the timeout race; never observable outside this module. */
const TIMED_OUT = Symbol("cliproxy-insight:timeout");

/**
 * Reads one static file from the containment lane.
 *
 * The lane authenticates with `x-api-key` (Caddy `header X-Api-Key {env...}`),
 * which is also what the Model Router's reader sends. `Authorization: Bearer`
 * is not read by the lane and 401s.  GET only; the lane 404s every other verb.
 *
 * ## Why the timeout is a race and not an `AbortSignal`
 *
 * `ctx.http.fetch` is NOT `globalThis.fetch`. It is an RPC shim: the worker
 * serializes the request, the host performs it, and the response comes back
 * over stdio. The shim copies **only** `method`, `headers` and `body` out of
 * `init` (plugin-sdk `worker-rpc-host.js`, the `http.fetch` branch) — `signal`
 * has no wire representation and is dropped before the request leaves the
 * worker.
 *
 * So passing `signal: controller.signal`, which is what this function used to
 * do, aborts nothing. Against a lane that accepts the connection and never
 * answers, the `await` never settles: the poll hangs, the scheduled job never
 * returns, and no subsequent firing runs. This was measured, not reasoned —
 * `deploy/worker_host_harness.mjs` scenario 2 drives the built worker against a
 * host that never replies and asserts the poll still returns. It failed at
 * 6000ms with `requestTimeoutMs: 1000` before this change.
 *
 * Racing a timer is therefore the only mechanism available here. The caveat is
 * real and worth stating: the underlying host request is *not* cancelled, it is
 * merely no longer awaited. That is acceptable for a GET of a small static
 * file, and it is strictly better than hanging forever.
 */
async function fetchLaneFile(
  ctx: PluginContext,
  config: ResolvedConfig,
  fileName: string,
  apiKey: string,
): Promise<FetchOk | FetchFail> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raced = await Promise.race([
      ctx.http.fetch(`${config.baseUrl}/${fileName}`, {
        method: "GET",
        headers: { [LANE_AUTH_HEADER]: apiKey },
      }),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), config.requestTimeoutMs);
      }),
    ]);

    if (raced === TIMED_OUT) {
      return { ok: false, status: null, reason: "timeout" };
    }
    const response = raced;

    if (response.status !== 200) {
      return { ok: false, status: response.status, reason: `http_${response.status}` };
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      return { ok: false, status: response.status, reason: "malformed_json" };
    }
    return { ok: true, status: response.status, body };
  } catch {
    // The upstream error string is deliberately not propagated — this value is
    // persisted and logged, and upstream messages routinely embed URLs and IDs.
    return { ok: false, status: null, reason: "network" };
  } finally {
    // Without this the timer keeps the event loop alive for the full timeout
    // after a fast response, delaying worker shutdown by up to requestTimeoutMs.
    clearTimeout(timer);
  }
}

/**
 * Pulls per-provider counters out of `request-rates.json`.
 *
 * The provider set comes from the payload, never from a local list: the lane
 * serves whichever providers the host collector found, and a hardcoded
 * allowlist silently drops the rest. Accepts either a bare map of provider →
 * counters or the same map nested under `providers`.
 */
export function extractProviderRecords(
  body: unknown,
  polledAt: string,
): { observedAt: string; records: Omit<ProviderRecord, "schemaVersion">[] } {
  const root = asRecord(body);
  const nested = asRecord(root.providers);
  const source = Object.keys(nested).length > 0 ? nested : root;
  const observedAt =
    typeof root.observedAt === "string"
      ? root.observedAt
      : typeof root.generatedAt === "string"
        ? root.generatedAt
        : polledAt;

  const records: Omit<ProviderRecord, "schemaVersion">[] = [];
  for (const [provider, value] of Object.entries(source)) {
    // Envelope fields sit beside provider entries when the map is not nested;
    // only object-valued keys are providers.
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    records.push({
      provider,
      polledAt,
      observedAt,
      success: firstNumber(record, REQUEST_RATE_FIELDS.success),
      failed: firstNumber(record, REQUEST_RATE_FIELDS.failed),
      raw: value,
    });
  }
  return { observedAt, records };
}

/**
 * Whether a provider's observed state is an exhaustion/cooldown signal.
 *
 * Returns a bounded reason code, never an upstream message — this value is
 * persisted, and upstream strings carry connection IDs and URLs.
 */
export function cooldownReason(raw: unknown): string | null {
  const r = asRecord(raw);
  if (r.exhausted === true) return "exhausted_flag";
  if (typeof r.cooldownUntil === "string" || typeof r.cooldown_until === "string") {
    return "cooldown_until";
  }
  if (typeof r.exhaustedAt === "string") return "exhausted_at";
  const state = typeof r.state === "string" ? r.state.toLowerCase() : null;
  if (state === "exhausted" || state === "unavailable") return `state_${state}`;
  if (r.serviceable === false) return "not_serviceable";
  return null;
}

/** One lane document, persisted as published plus our poll time. */
interface LaneSnapshot {
  schemaVersion: 1;
  laneFile: string;
  polledAt: string;
  observedAt: string;
  staleAfterSeconds: number | null;
  records: Record<string, unknown>[];
}

interface LaneCooldown {
  /** ISO instant the account leaves cooldown, or null when only health says so. */
  until: string | null;
  /** Bounded reason code or the producer's own short reason string. */
  reason: string;
}

function firstString(record: Record<string, unknown>, fields: readonly string[]): string | null {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * Parses one lane document (TOG-2693 collector contract).
 *
 * Refuses an unimplemented `schemaVersion` outright rather than best-effort
 * parsing it — same rule as `model-usage-v1.json` above, and for the same
 * reason: a future shape stored under v1 meaning is read back as v1 forever.
 * `records` is carried verbatim; this plugin is a historian, and dropping
 * fields it does not understand is how the next contract addition becomes
 * invisible (the nested-vs-flat defect, TOG-3131).
 */
export function extractLaneDocument(
  body: unknown,
  laneFile: string,
  polledAt: string,
): LaneSnapshot | null {
  const root = asRecord(body);
  if (root.schemaVersion !== SUPPORTED_SCHEMA_VERSION) return null;
  const records = Array.isArray(root.records)
    ? root.records.filter(
        (r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r),
      )
    : [];
  return {
    schemaVersion: 1,
    laneFile,
    polledAt,
    observedAt: typeof root.observedAt === "string" ? root.observedAt : polledAt,
    staleAfterSeconds:
      typeof root.staleAfterSeconds === "number" ? root.staleAfterSeconds : null,
    records,
  };
}

/**
 * The cooldown state of one lane account, or null when it is serving.
 *
 * Reads the flat instant first (`exhausted_until` and its accepted aliases —
 * the names `model-selection`'s normalizer looks for) and the nested
 * `cooldown: {until, reason}` second, because the quota contract publishes
 * both and a reader that knows only one of them sees a healthy account during
 * a live cooldown. An instant in the past is NOT a cooldown: an expired record
 * left in the document would otherwise park a credential that is already free.
 *
 * `health: exhausted | unavailable` is a cooldown with no known end. `cooldown`
 * as a health value is deliberately not accepted here — the Router maps it to
 * `degraded`, which still selects the lane (measured 2026-09-17).
 */
export function laneCooldown(record: unknown, nowMs: number): LaneCooldown | null {
  const r = asRecord(record);
  const nested = asRecord(r.cooldown);
  const until =
    firstString(r, LANE_COOLDOWN_FIELDS) ??
    (typeof nested.until === "string" ? nested.until : null);

  if (until) {
    const untilMs = Date.parse(until);
    // An unparseable instant is reported rather than dropped: the producer
    // said something is wrong, and silently discarding it fails open.
    if (!Number.isFinite(untilMs)) return { until, reason: "cooldown_unparseable_until" };
    if (untilMs > nowMs) {
      const reason =
        firstString(r, LANE_COOLDOWN_REASON_FIELDS) ??
        (typeof nested.reason === "string" && nested.reason.length > 0
          ? nested.reason
          : "cooldown_until");
      return { until, reason: reason.slice(0, 120) };
    }
  }

  const health = typeof r.health === "string" ? r.health.toLowerCase() : null;
  if (health && (LANE_UNSERVICEABLE_HEALTH as readonly string[]).includes(health)) {
    return { until: null, reason: `health_${health}` };
  }
  return null;
}

/** Stable per-account identity within a lane document. */
export function laneAccountId(record: Record<string, unknown>, laneFile: string): string {
  const lane = record.lane;
  return typeof lane === "string" && lane.length > 0 ? lane : laneFile.replace(/\.json$/i, "");
}

/** True when `observedAt` is older than the effective staleness budget. */
export function isStale(observedAt: unknown, staleAfterSeconds: number, nowMs: number): boolean {
  if (typeof observedAt !== "string") return true;
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return true;
  return nowMs - observedMs > staleAfterSeconds * 1000;
}

/**
 * The lane half of both read surfaces (agent tool and `usage-summary` route),
 * written once so the two cannot drift — a consumer that sees a cooldown on one
 * surface and not the other is worse than one that sees it on neither.
 *
 * Cooldown is evaluated at READ time, not carried from the poll: a snapshot
 * persisted while an account was cooling must stop reporting a cooldown once
 * that instant passes, even if no poll has run since.
 */
async function laneSummary(
  read: (stateKey: string) => Promise<unknown>,
  config: ResolvedConfig,
  nowMs: number,
): Promise<{ lanes: string[]; laneSnapshots: Record<string, unknown>; accountsCooling: number }> {
  const storedIndex = await read(STATE_KEYS.laneIndex);
  const lanes = Array.isArray(storedIndex)
    ? storedIndex.filter((l): l is string => typeof l === "string")
    : [];

  const laneSnapshots: Record<string, unknown> = {};
  let accountsCooling = 0;

  for (const laneFile of lanes) {
    const snapshot = (await read(STATE_KEYS.lane(laneFile))) as LaneSnapshot | null;
    if (!snapshot) {
      laneSnapshots[laneFile] = null;
      continue;
    }
    const accounts = (snapshot.records ?? []).map((record) => {
      const cooldown = laneCooldown(record, nowMs);
      if (cooldown) accountsCooling += 1;
      return {
        account: laneAccountId(record, laneFile),
        health: typeof record.health === "string" ? record.health : null,
        cooldown,
        record,
      };
    });
    laneSnapshots[laneFile] = {
      ...snapshot,
      stale: isStale(
        snapshot.observedAt,
        typeof snapshot.staleAfterSeconds === "number"
          ? snapshot.staleAfterSeconds
          : config.staleAfterSeconds,
        nowMs,
      ),
      accounts,
    };
  }

  return { lanes, laneSnapshots, accountsCooling };
}

export function createPlugin() {
  let context: PluginContext | null = null;
  // The stock loader replays configured-company IDs via configChanged. A job
  // carries no company scope: enumerating companies includes unauthorized rows.
  // Receiving multiple configs is supported only so we can refuse ALL polling,
  // including byte-identical configs the SDK's default tenant guard permits.
  const configuredCompanies = new Set<string>();
  let missingCompanyIdentity = false;
  const isConfiguredCompany = (companyId: string) =>
    !missingCompanyIdentity && configuredCompanies.size === 1 && configuredCompanies.has(companyId);

  return definePlugin({
    multiCompanyConfig: true,

    async onConfigChanged(_config, change) {
      if (!change?.companyId?.trim()) {
        // An unattributed delivery cannot safely update an existing binding.
        // Stay inert until corrected/restarted, without failing config delivery.
        missingCompanyIdentity = true;
        await context?.metrics.write("cliproxy_insight.company_scope_refused", 1, {
          reason: "missing_company_id",
        });
        return;
      }
      configuredCompanies.add(change.companyId);
      if (configuredCompanies.size !== 1) {
        await context?.metrics.write("cliproxy_insight.company_scope_refused", 1, {
          reason: "multiple_companies",
        });
        throw new Error("cliproxy-insight requires exactly one configured company; polling stopped");
      }
    },
    async setup(ctx) {
      context = ctx;

      const key = (companyId: string, stateKey: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey,
      });

      /** Plugin state offers no scan, so the observed provider set is itself state. */
      const readProviderIndex = async (companyId: string): Promise<string[]> => {
        const stored = await ctx.state.get(key(companyId, STATE_KEYS.providerIndex));
        return Array.isArray(stored) ? stored.filter((p): p is string => typeof p === "string") : [];
      };

      const orderProviders = (providers: string[]): string[] => {
        const rank = (p: string) => {
          const index = (SEED_PROVIDER_ORDER as readonly string[]).indexOf(p);
          return index === -1 ? SEED_PROVIDER_ORDER.length : index;
        };
        return [...new Set(providers)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
      };

      const pollOneCompany = async (companyId: string, config: ResolvedConfig): Promise<void> => {
        if (!config.pollingEnabled) {
          await ctx.metrics.write("cliproxy_insight.poll_skipped_disabled", 1, { companyId });
          return;
        }
        if (!config.laneApiKeySecretRef) {
          await ctx.metrics.write("cliproxy_insight.poll_skipped_no_secret", 1, { companyId });
          return;
        }

        let apiKey: string;
        try {
          apiKey = await ctx.secrets.resolve(config.laneApiKeySecretRef as never, {
            companyId,
            configPath: "laneApiKeySecretRef",
          });
        } catch {
          ctx.logger.warn("cliproxy-insight: could not resolve the lane bearer", {
            companyId,
            reason: "secret_resolve_failed",
          });
          await ctx.metrics.write("cliproxy_insight.poll_errors", 1, {
            companyId,
            reason: "secret_resolve_failed",
          });
          return;
        }

        // A second company's config can arrive while the secret read awaits.
        // Never send the bearer after that single-company binding is invalidated.
        if (!isConfiguredCompany(companyId)) return;
        const polledAt = new Date().toISOString();
        const nowMs = Date.parse(polledAt);

        // One firing, never retried within it. A tight retry loop is how a
        // poller gets itself IP-banned (TOG-811 recon, measured twice); the
        // next scheduled firing IS the retry.
        const [laneResults, rates, modelUsage] = await Promise.all([
          Promise.all(
            config.laneFiles.map(async (laneFile) => ({
              laneFile,
              result: await fetchLaneFile(ctx, config, laneFile, apiKey),
            })),
          ),
          config.legacyAggregateFiles
            ? fetchLaneFile(ctx, config, LANE_PATHS.requestRates, apiKey)
            : null,
          config.legacyAggregateFiles
            ? fetchLaneFile(ctx, config, LANE_PATHS.modelUsage, apiKey)
            : null,
        ]);

        let anySucceeded = false;

        // ---- <lane>.json: per-account capacity, health and cooldown -------
        const lanesStored: string[] = [];
        let accountsCooling = 0;

        for (const { laneFile, result } of laneResults) {
          if (!result.ok) {
            await ctx.metrics.write("cliproxy_insight.poll_errors", 1, {
              companyId,
              file: laneFile,
              reason: result.reason,
            });
            continue;
          }
          const snapshot = extractLaneDocument(result.body, laneFile, polledAt);
          if (!snapshot) {
            await ctx.metrics.write("cliproxy_insight.poll_errors", 1, {
              companyId,
              file: laneFile,
              reason: "unsupported_schema_version",
            });
            await ctx.activity.log({
              companyId,
              message: `CLIProxy insight: ${laneFile} is not schemaVersion ${SUPPORTED_SCHEMA_VERSION}; snapshot not stored.`,
            });
            continue;
          }

          anySucceeded = true;
          lanesStored.push(laneFile);

          const previous = (await ctx.state.get(
            key(companyId, STATE_KEYS.lane(laneFile)),
          )) as LaneSnapshot | null;
          await ctx.state.set(
            key(companyId, STATE_KEYS.lane(laneFile)),
            snapshot as unknown as Record<string, unknown>,
          );

          const previousByAccount = new Map<string, Record<string, unknown>>();
          for (const record of previous?.records ?? []) {
            previousByAccount.set(laneAccountId(record, laneFile), record);
          }

          for (const record of snapshot.records) {
            const accountId = laneAccountId(record, laneFile);
            const cooldown = laneCooldown(record, nowMs);
            if (cooldown) accountsCooling += 1;

            // Log the transition INTO cooldown only — a still-cooling account
            // observed every firing would fill the capped log and evict every
            // other account's history. A new `until` counts as a new event:
            // an extended cooldown is a fact the history should carry.
            const previousCooldown = laneCooldown(previousByAccount.get(accountId), nowMs);
            const isTransition =
              !!cooldown &&
              (!previousCooldown ||
                previousCooldown.until !== cooldown.until ||
                previousCooldown.reason !== cooldown.reason);
            if (!isTransition) continue;

            const eventKey = key(companyId, STATE_KEYS.cooldownEvents(accountId));
            const existing = await ctx.state.get(eventKey);
            const events: CooldownEvent[] = Array.isArray(existing)
              ? (existing as CooldownEvent[])
              : [];
            events.unshift({
              at: polledAt,
              provider: accountId,
              reason: cooldown.reason,
              raw: { laneFile, until: cooldown.until, health: record.health ?? null },
            });
            await ctx.state.set(eventKey, events.slice(0, config.maxCooldownEventsPerProvider));
            await ctx.activity.log({
              companyId,
              message: `CLIProxy insight: ${accountId} entered cooldown (${cooldown.reason}${
                cooldown.until ? `, until ${cooldown.until}` : ""
              })`,
            });
          }
        }

        if (config.laneFiles.length > 0) {
          // Union with what we have seen before, same rule as the provider
          // index: a lane missing from one publish is not evidence it is gone.
          const storedIndex = await ctx.state.get(key(companyId, STATE_KEYS.laneIndex));
          const knownLanes = Array.isArray(storedIndex)
            ? storedIndex.filter((l): l is string => typeof l === "string")
            : [];
          await ctx.state.set(
            key(companyId, STATE_KEYS.laneIndex),
            [...new Set([...knownLanes, ...lanesStored])].sort(),
          );
          await ctx.metrics.write("cliproxy_insight.lanes_observed", lanesStored.length, {
            companyId,
          });
          // Written every firing that read any lane, including when it is zero:
          // a gauge that stops being written reads as a healthy zero.
          await ctx.metrics.write("cliproxy_insight.lane_accounts_cooling", accountsCooling, {
            companyId,
          });
        }

        // ---- request-rates.json: per-provider counters --------------------
        if (rates === null) {
          // legacyAggregateFiles is off: not polled, nothing to report.
        } else if (!rates.ok) {
          await ctx.metrics.write("cliproxy_insight.poll_errors", 1, {
            companyId,
            file: LANE_PATHS.requestRates,
            reason: rates.reason,
          });
          await ctx.activity.log({
            companyId,
            message: `CLIProxy insight: ${LANE_PATHS.requestRates} unavailable (${rates.reason}). Not retrying within this firing.`,
          });
        } else {
          anySucceeded = true;
          const { records } = extractProviderRecords(rates.body, polledAt);
          const seen = orderProviders(records.map((r) => r.provider));
          let changed = 0;

          for (const record of records) {
            const stateKey = key(companyId, STATE_KEYS.provider(record.provider));
            const previous = (await ctx.state.get(stateKey)) as ProviderRecord | null;
            const next: ProviderRecord = { schemaVersion: 1, ...record };
            if (JSON.stringify(previous?.raw) !== JSON.stringify(next.raw)) changed += 1;
            await ctx.state.set(stateKey, next as unknown as Record<string, unknown>);

            // Log a cooldown only on the transition into it, not on every
            // firing that observes a still-cooling provider — otherwise one
            // exhausted account fills the capped event log and evicts the
            // history of every other provider.
            const reason = cooldownReason(record.raw);
            const previousReason = cooldownReason(previous?.raw);
            if (reason && reason !== previousReason) {
              const eventKey = key(companyId, STATE_KEYS.cooldownEvents(record.provider));
              const existing = await ctx.state.get(eventKey);
              const events: CooldownEvent[] = Array.isArray(existing)
                ? (existing as CooldownEvent[])
                : [];
              events.unshift({ at: polledAt, provider: record.provider, reason, raw: record.raw });
              await ctx.state.set(eventKey, events.slice(0, config.maxCooldownEventsPerProvider));
              await ctx.activity.log({
                companyId,
                message: `CLIProxy insight: ${record.provider} entered cooldown (${reason})`,
              });
            }
          }

          // Union with what we have seen before: a provider missing from one
          // publish is not evidence it no longer exists.
          const index = orderProviders([...(await readProviderIndex(companyId)), ...seen]);
          await ctx.state.set(key(companyId, STATE_KEYS.providerIndex), index);

          await ctx.metrics.write("cliproxy_insight.providers_observed", seen.length, { companyId });
          if (changed > 0) {
            await ctx.activity.log({
              companyId,
              message: `CLIProxy insight: ${changed} provider(s) changed`,
            });
          }
        }

        // ---- model-usage-v1.json: per-model capacity windows --------------
        if (modelUsage === null) {
          // legacyAggregateFiles is off: not polled, nothing to report.
        } else if (!modelUsage.ok) {
          await ctx.metrics.write("cliproxy_insight.poll_errors", 1, {
            companyId,
            file: LANE_PATHS.modelUsage,
            reason: modelUsage.reason,
          });
        } else {
          const body = asRecord(modelUsage.body);
          const version = body.schemaVersion;
          if (version !== SUPPORTED_SCHEMA_VERSION) {
            // Reject an unimplemented version rather than best-effort parse it
            // (model-usage-telemetry-v1 §3.1). Storing it would let a future
            // shape later be read with v1 meaning.
            await ctx.metrics.write("cliproxy_insight.poll_errors", 1, {
              companyId,
              file: LANE_PATHS.modelUsage,
              reason: "unsupported_schema_version",
            });
            await ctx.activity.log({
              companyId,
              message: `CLIProxy insight: ${LANE_PATHS.modelUsage} reports schemaVersion ${String(version)}; this plugin implements ${SUPPORTED_SCHEMA_VERSION}. Snapshot not stored.`,
            });
          } else {
            anySucceeded = true;
            const models = asRecord(body.models);
            await ctx.state.set(key(companyId, STATE_KEYS.modelUsage), {
              schemaVersion: 1,
              polledAt,
              observedAt: typeof body.observedAt === "string" ? body.observedAt : polledAt,
              staleAfterSeconds:
                typeof body.staleAfterSeconds === "number" ? body.staleAfterSeconds : null,
              telemetry: typeof body.telemetry === "string" ? body.telemetry : "unavailable",
              reasonCode: typeof body.reasonCode === "string" ? body.reasonCode : null,
              models,
            });
            await ctx.metrics.write("cliproxy_insight.models_observed", Object.keys(models).length, {
              companyId,
            });
          }
        }

        // Written every firing that got anything, unconditionally (dispatch
        // precedent): a gauge that stops being written is indistinguishable
        // from a healthy zero.
        if (anySucceeded) {
          await ctx.metrics.write("cliproxy_insight.poll_ok", 1, { companyId });
        }
      };

      // ---- agent tool: get_provider_usage -----------------------------
      ctx.tools.register(
        TOOL_NAMES.getProviderUsage,
        {
          displayName: "Get provider usage",
          description:
            "Read the most recently persisted CLIProxy usage/cooldown state. Read-only; consults stored history, never calls CLIProxy.",
          parametersSchema: { type: "object", required: ["companyId"] },
        },
        async (params) => {
          const input = asRecord(params);
          const companyId = typeof input.companyId === "string" ? input.companyId : "";
          if (!companyId) return { error: "companyId is required" };
          if (!isConfiguredCompany(companyId)) return { error: "company is not configured" };

          const config = resolveConfig(await ctx.config.get(companyId));
          if (!isConfiguredCompany(companyId)) return { error: "company is not configured" };
          const nowMs = Date.now();
          const requested = typeof input.provider === "string" ? input.provider : null;
          const providers = requested ? [requested] : await readProviderIndex(companyId);

          const snapshots: Record<string, unknown> = {};
          for (const provider of providers) {
            const record = (await ctx.state.get(
              key(companyId, STATE_KEYS.provider(provider)),
            )) as ProviderRecord | null;
            snapshots[provider] = record
              ? { ...record, stale: isStale(record.observedAt, config.staleAfterSeconds, nowMs) }
              : null;
          }

          const modelUsage = asRecord(await ctx.state.get(key(companyId, STATE_KEYS.modelUsage)));
          const hasModelUsage = Object.keys(modelUsage).length > 0;
          const lane = await laneSummary(
            (stateKey) => ctx.state.get(key(companyId, stateKey)),
            config,
            nowMs,
          );

          return {
            data: {
              version: PLUGIN_VERSION,
              providers,
              snapshots,
              lanes: lane.lanes,
              laneSnapshots: lane.laneSnapshots,
              accountsCooling: lane.accountsCooling,
              modelUsage: hasModelUsage
                ? {
                    ...modelUsage,
                    stale: isStale(
                      modelUsage.observedAt,
                      typeof modelUsage.staleAfterSeconds === "number"
                        ? modelUsage.staleAfterSeconds
                        : config.staleAfterSeconds,
                      nowMs,
                    ),
                  }
                : null,
            },
          };
        },
      );

      // ---- scheduled poll ----------------------------------------------
      ctx.jobs.register(JOB_KEYS.poll, async (_job: PluginJobContext) => {
        if (missingCompanyIdentity || configuredCompanies.size !== 1) {
          await ctx.metrics.write("cliproxy_insight.poll_skipped_company_scope", 1);
          return;
        }
        const companyId = [...configuredCompanies][0];
        if (!companyId) return;
        try {
          // Keep this a real scoped read on each firing, not a cached config or
          // invented invocation: the host can revoke proactive company access.
          const config = resolveConfig(await ctx.config.get(companyId));
          if (!isConfiguredCompany(companyId)) return;
          await pollOneCompany(companyId, config);
        } catch {
          ctx.logger.warn("cliproxy-insight: poll failed for company", {
            companyId,
            reason: "unhandled",
          });
          await ctx.metrics.write("cliproxy_insight.poll_errors", 1, {
            companyId,
            reason: "unhandled",
          });
        }
      });

      ctx.logger.info("CLIProxy Insight worker ready", { version: PLUGIN_VERSION });
    },

    async onHealth() {
      return { status: "ok", message: `CLIProxy Insight ${PLUGIN_VERSION}` };
    },

    /**
     * Note what this is NOT: the persisting write, `POST /plugins/:id/config`,
     * validates against `instanceConfigSchema` with Ajv and never calls this
     * hook — only `POST /plugins/:id/config/test` (a dry run) reaches it. So
     * this is an operator-facing check, not a gate; anything that must
     * actually be refused at write time has to live in `src/config/schema.ts`.
     * The secret-ref shape guard below is the one exception that matters:
     * duplicated in spirit by the schema's `type: ["object","null"]`, but the
     * host's `format:"secret-ref"` validator is a documented no-op, so this
     * hook is the only place a malformed secret-ref is ever actually caught
     * before persistence, same as the Model Router (ADR-0004).
     */
    async onValidateConfig(config: Record<string, unknown>) {
      const errors: string[] = [];
      const warnings: string[] = [];
      const resolved = resolveConfig(config);

      const secretRefError = validateSecretRefShape(
        config.laneApiKeySecretRef,
        "laneApiKeySecretRef",
      );
      if (secretRefError) errors.push(secretRefError);

      if (resolved.pollingEnabled && !resolved.laneApiKeySecretRef) {
        errors.push(
          "pollingEnabled is true but laneApiKeySecretRef is not set — polling would resolve no key and every firing would skip. Reference the cliproxy-usage-lane-key secret, or leave pollingEnabled false.",
        );
      }
      if (resolved.pollingEnabled && /127\.0\.0\.1|localhost|\[::1\]/i.test(resolved.baseUrl)) {
        errors.push(
          "baseUrl points at loopback. CLIProxy binds host-loopback only (TOG-352) and is unreachable from any plugin worker; baseUrl must be the public HTTPS telemetry lane (TOG-952).",
        );
      }
      // The management API is never a valid target for this plugin: it returns
      // api-keys, config and id_tokens in clear. Refuse it explicitly rather
      // than let a plausible-looking URL through.
      if (/\/v0\/management/i.test(resolved.baseUrl)) {
        errors.push(
          "baseUrl points at the CLIProxy management API. That surface returns credentials in clear and is never read by this plugin — use the sanitized telemetry lane (TOG-952).",
        );
      }
      // Polling on with nothing to poll is a job that fires forever and reads
      // nothing, while `poll_ok` simply stops being written — the failure mode
      // this plugin exists to remove, reproduced in its own config.
      if (
        resolved.pollingEnabled &&
        resolved.laneFiles.length === 0 &&
        !resolved.legacyAggregateFiles
      ) {
        errors.push(
          "pollingEnabled is true but laneFiles is empty and legacyAggregateFiles is false — every firing would fetch nothing. List the lane documents to poll (default: claude.json, codex.json, kimi.json, opencode-go.json, zai.json, antigravity.json).",
        );
      }
      if (resolved.pollingEnabled && resolved.baseUrl.startsWith("http://")) {
        errors.push("baseUrl must be https — the lane bearer would otherwise be sent in clear.");
      }

      return { ok: errors.length === 0, errors, warnings };
    },

    async onApiRequest(input) {
      if (!context) return { status: 503, body: { error: "worker is not initialised" } };
      if (input.routeKey !== ROUTE_KEYS.usageSummary) {
        return { status: 404, body: { error: `unknown route ${input.routeKey}` } };
      }

      const companyId = input.companyId;
      if (!isConfiguredCompany(companyId)) {
        return { status: 403, body: { error: "company is not configured" } };
      }
      const config = resolveConfig(await context.config.get(companyId));
      if (!isConfiguredCompany(companyId)) {
        return { status: 403, body: { error: "company is not configured" } };
      }
      const nowMs = Date.now();
      const scope = (stateKey: string) => ({
        scopeKind: "company" as const,
        scopeId: companyId,
        stateKey,
      });

      const stored = await context.state.get(scope(STATE_KEYS.providerIndex));
      const providers = Array.isArray(stored)
        ? stored.filter((p): p is string => typeof p === "string")
        : [];

      const snapshots: Record<string, unknown> = {};
      for (const provider of providers) {
        const record = (await context.state.get(
          scope(STATE_KEYS.provider(provider)),
        )) as ProviderRecord | null;
        snapshots[provider] = record
          ? { ...record, stale: isStale(record.observedAt, config.staleAfterSeconds, nowMs) }
          : null;
      }

      const modelUsage = asRecord(await context.state.get(scope(STATE_KEYS.modelUsage)));
      const hasModelUsage = Object.keys(modelUsage).length > 0;
      const lane = await laneSummary(
        (stateKey) => context!.state.get(scope(stateKey)),
        config,
        nowMs,
      );

      return {
        status: 200,
        body: {
          version: PLUGIN_VERSION,
          providers,
          snapshots,
          lanes: lane.lanes,
          laneSnapshots: lane.laneSnapshots,
          accountsCooling: lane.accountsCooling,
          modelUsage: hasModelUsage
            ? {
                ...modelUsage,
                stale: isStale(
                  modelUsage.observedAt,
                  typeof modelUsage.staleAfterSeconds === "number"
                    ? modelUsage.staleAfterSeconds
                    : config.staleAfterSeconds,
                  nowMs,
                ),
              }
            : null,
        },
      };
    },
  });
}

const plugin = createPlugin();

export default plugin;

runWorker(plugin, import.meta.url);
