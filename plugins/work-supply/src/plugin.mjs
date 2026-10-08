import { JOBS, ERROR_CODES, validateConfig } from './policy.mjs';
import { ShadowRunner } from './shadow.mjs';
import { readPressure, pressureGate } from './pressure.mjs';
import { manifest } from './manifest.mjs';

const CONFIG_KEYS = new Set(Object.keys(manifest.instanceConfigSchema.properties));
const safeCompany = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const ledgerKey = companyId => ({ scopeKind: 'company', scopeId: companyId, namespace: 'work-supply', stateKey: 'shadow-ledger-v1' });
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
  const health = new Map();
  const tails = new Map();
  const collectorAvailable = typeof collect === 'function';
  const healthKey = (companyId, job) => JSON.stringify([companyId, job]);

  async function run(companyId, job) {
    const key = healthKey(companyId, job.jobKey);
    try {
      const config = resolveConfig(companyId, await ctx.config.get(companyId));
      let result;
      if (config.pause) result = { status: 'paused', observed: 0 };
      else if (!collectorAvailable) throw new Error('native-snapshot-source-unavailable');
      else {
        let sample;
        try { sample = await pressure({ hostScopeVerified: config.hostPressureScopeVerified, clock }); }
        catch { throw new Error('pressure-unavailable'); }
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
              get: id => ctx.state.get(ledgerKey(id)),
              set: (id, ledger) => { checkPressure(); return ctx.state.set(ledgerKey(id), ledger); },
            },
            collect: async (key, id) => {
              checkPressure();
              const snapshot = await collect(key, id);
              checkPressure();
              return snapshot;
            }, clock,
          });
          try { result = await runner.run(job.jobKey, config); }
          catch (error) { if (gate.allowed) throw error; }
        }
        if (!gate.allowed) result = { status: 'pressure-held', observed: 0, reasons: gate.reasons };
      }
      const summary = { companyId, jobKey: job.jobKey, runId: job.runId, status: result.status, observed: result.observed };
      if (result.reasons) summary.reasons = result.reasons;
      health.set(key, summary);
      ctx.logger.info('work-supply: shadow firing', summary);
    } catch (error) {
      const code = [...ERROR_CODES, 'native-snapshot-source-unavailable', 'pressure-unavailable'].includes(error?.message)
        ? error.message : 'shadow-dependency-failed';
      health.set(key, { companyId, jobKey: job.jobKey, runId: job.runId, status: 'error', code });
      ctx.logger.error('work-supply: shadow firing failed', { companyId, jobKey: job.jobKey, runId: job.runId, code });
      throw new Error(code);
    }
  }

  async function queuedRun(companyId, job) {
    // Scheduled callbacks may overlap. Serialize all five jobs per company so
    // a permanently identical schedule cannot starve four jobs behind one fence.
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
      for (const jobKey of JOBS) ctx.jobs.register(jobKey, async job => {
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
      resolveConfig(context.companyId, raw);
      configured.add(context.companyId);
    },
    async onValidateConfig(raw) {
      try { resolveConfig('validation-only', raw); return { ok: true }; }
      catch { return { ok: false, errors: ['invalid-shadow-config'] }; }
    },
    async onHealth() {
      const firings = [...health.values()].map(value => structuredClone(value));
      return { status: !collectorAvailable || !configured.size || firings.some(f => f.status === 'error' || f.status === 'pressure-held')
        ? 'degraded' : 'ok',
      message: collectorAvailable ? 'Shadow only; no core effects.' : 'Native snapshot source unavailable; not parity-ready.',
      details: { collectorAvailable, configuredCompanies: configured.size, firings } };
    },
  };
}
