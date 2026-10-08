import { JOBS, SCHEDULED_JOBS, ERROR_CODES, validateConfig } from './policy.mjs';
import { collectNativeSnapshot, nativeReadClientsAvailable } from './collector.mjs';
import { ShadowRunner } from './shadow.mjs';
import { readPressure, pressureGate } from './pressure.mjs';
import { manifest } from './manifest.mjs';

const CONFIG_KEYS = new Set(Object.keys(manifest.instanceConfigSchema.properties));
const safeCompany = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const LEDGER_SLOT = 'shadow-ledger-v1';
const ledgerKey = companyId => ({ scopeKind: 'company', scopeId: companyId, namespace: 'work-supply', stateKey: LEDGER_SLOT });
const defaults = () => ({ mode: 'shadow', pause: true, hostPressureScopeVerified: false, floor: 40,
  maxSnapshotAgeMs: 60000, cooldownMs: 21600000, maxLedgerEntries: 10000, projects: [], repositories: [],
  caps: Object.fromEntries(JOBS.map(job => [job, { perRun: 10, perHour: 40 }])) });

export function resolveConfig(companyId, raw) {
  if (!safeCompany(companyId) || !raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).some(key => !CONFIG_KEYS.has(key))) throw new Error('invalid-config');
  const config = structuredClone({ ...defaults(), ...raw, companyId });
  if (typeof config.hostPressureScopeVerified !== 'boolean') throw new Error('invalid-config');
  validateConfig(config);
  return config;
}

// The SDK has no supported complete work-product/PR/connection-intent reader.
// This is deliberately NOT an empty complete snapshot, private HTTP, token broker,
// shell collector or fictional SDK method. A reviewed native read adapter is required.
export function createSupplyPlugin({ collect, pressure = readPressure, clock = Date.now } = {}) {
  let ctx;
  const configured = new Set();
  const configErrors = new Map();
  const configVersions = new Map();
  const health = new Map();
  const tails = new Map();
  const injectedCollector = typeof collect === 'function';
  let collectorAvailable = injectedCollector;
  const healthKey = (companyId, job) => JSON.stringify([companyId, job]);

  async function run(companyId, job) {
    const key = healthKey(companyId, job.jobKey);
    const version = configVersions.get(companyId);
    const checkConfig = () => {
      if (configVersions.get(companyId) !== version) {
        throw new Error(configErrors.has(companyId) ? 'invalid-config' : 'config-changed');
      }
    };
    try {
      // Notifications can arrive out of order; persisted config is authoritative.
      let raw;
      try { raw = await ctx.config.get(companyId); }
      catch {
        checkConfig();
        throw new Error('config-read-failed');
      }
      checkConfig();
      let config;
      try { config = resolveConfig(companyId, raw); }
      catch { configErrors.set(companyId, 'invalid-config'); throw new Error('invalid-config'); }
      configErrors.delete(companyId);
      let result;
      if (config.pause) result = { status: 'paused', observed: 0 };
      else if (!collectorAvailable) throw new Error('native-snapshot-source-unavailable');
      else {
        let sample;
        try { sample = await pressure({ hostScopeVerified: config.hostPressureScopeVerified, clock }); }
        catch { checkConfig(); throw new Error('pressure-unavailable'); }
        checkConfig();
        const scopedSample = { ...sample, scope: config.hostPressureScopeVerified ? sample?.scope : 'unverified' };
        let gate = pressureGate(scopedSample, clock());
        const checkPressure = () => {
          gate = pressureGate(scopedSample, clock());
          if (!gate.allowed) throw new Error('pressure-held');
        };
        if (gate.allowed) {
          // Queues serialize each company; guards bracket collection and precede
          // every write, including the kernel's error-health persistence attempt.
          const runner = new ShadowRunner({
            store: {
              get: id => { checkConfig(); return ctx.state.get(ledgerKey(id)); },
              set: (id, ledger) => { checkConfig(); checkPressure(); return ctx.state.set(ledgerKey(id), ledger); },
            },
            collect: async (key, id, runConfig) => {
              checkConfig(); checkPressure();
              const snapshot = injectedCollector
                ? await collect(key, id, runConfig)
                : await collectNativeSnapshot(ctx, key, id, runConfig, clock);
              checkConfig(); checkPressure();
              return snapshot;
            }, clock,
          });
          try { result = await runner.run(job.jobKey, config); }
          catch (error) { checkConfig(); if (gate.allowed) throw error; }
        }
        if (!gate.allowed) result = { status: 'pressure-held', observed: 0, reasons: gate.reasons };
      }
      checkConfig();
      const summary = { companyId, jobKey: job.jobKey, runId: job.runId, status: result.status, observed: result.observed };
      if (result.reasons) summary.reasons = result.reasons;
      health.set(key, summary);
      ctx.logger.info('work-supply: shadow firing', summary);
    } catch (error) {
      const code = [...ERROR_CODES, 'native-snapshot-source-unavailable', 'pressure-unavailable', 'config-changed'].includes(error?.message)
        ? error.message : 'shadow-dependency-failed';
      health.set(key, { companyId, jobKey: job.jobKey, runId: job.runId, status: 'error', code });
      ctx.logger.error('work-supply: shadow firing failed', { companyId, jobKey: job.jobKey, runId: job.runId, code });
      throw new Error(code);
    }
  }

  async function queuedRun(companyId, job) {
    // Scheduled callbacks may overlap. Serialize both native jobs per company
    // so one firing cannot overwrite shadow state while the other is running.
    const previous = tails.get(companyId) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => run(companyId, job));
    tails.set(companyId, pending);
    try { await pending; }
    finally { if (tails.get(companyId) === pending) tails.delete(companyId); }
  }

  return {
    multiCompanyConfig: true,
    async setup(context) {
      ctx = context;
      collectorAvailable = injectedCollector || nativeReadClientsAvailable(context);
      for (const jobKey of SCHEDULED_JOBS) ctx.jobs.register(jobKey, async job => {
        // Host-delivered company configs authorize scopes; no global company census.
        // Independent company queues start together; one stalled scope cannot
        // prevent the others from running. Rejections remain loud after settlement.
        const results = await Promise.allSettled([...configured].sort()
          .map(companyId => queuedRun(companyId, { ...job, jobKey })));
        if (results.some(result => result.status === 'rejected')) throw new Error('work-supply-job-failed');
      });
      ctx.data.register('shadow-ledger', async ({ companyId }) => {
        if (!configured.has(companyId)) throw new Error('company-not-configured');
        return ctx.state.get(ledgerKey(companyId));
      });
    },
    async onConfigChanged(raw, context) {
      // Company identity comes only from the host context, never from config JSON.
      if (!safeCompany(context?.companyId)) throw new Error('company-context-required');
      // The host persists before notification and treats rejection as non-fatal:
      // Source: https://github.com/paperclipai/paperclip at 5717523,
      // server/src/routes/plugins.ts:2358-2408.
      // Keep every host-delivered scope visible, including invalid stored configs.
      const companyId = context.companyId;
      configured.add(companyId);
      configVersions.set(companyId, Symbol());
      // A valid notification may be stale too; only a validated stored read
      // clears a rejection. The version fences every outstanding firing.
      try { resolveConfig(companyId, raw); }
      catch {
        configErrors.set(companyId, 'invalid-config');
        ctx.logger.error('work-supply: config rejected', { companyId, code: 'invalid-config' });
        throw new Error('invalid-config');
      }
    },
    async onValidateConfig(raw) {
      try { resolveConfig('validation-only', raw); return { ok: true }; }
      catch { return { ok: false, errors: ['invalid-shadow-config'] }; }
    },
    async onHealth() {
      const firings = [...health.values()].map(value => structuredClone(value));
      const rejectedConfigs = [...configErrors].map(([companyId, code]) => ({ companyId, code }));
      return { status: !collectorAvailable || !configured.size || configErrors.size || firings.some(f => f.status === 'error' || f.status === 'pressure-held')
        ? 'degraded' : 'ok',
      message: collectorAvailable ? 'Shadow only; no core effects.' : 'Native snapshot source unavailable; not parity-ready.',
      details: { collectorAvailable, configuredCompanies: configured.size, configErrors: rejectedConfigs, firings } };
    },
  };
}
