import { JOBS, ERROR_CODES, SupplyError, planJob, validateConfig, validateAction } from './policy.mjs';

const HOUR = 3_600_000;
const HASH = /^[a-f0-9]{64}$/;

function emptyLedger(companyId) {
  return { version: 1, companyId, entries: [], observations: [], health: {} };
}

function record(value) {
  return value !== null && typeof value === 'object'
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function shape(value, keys) {
  return record(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}

function validJobAction(job, proposal) {
  if (job === 'backlogFloor') return proposal.kind === 'promote_issue';
  if (job === 'intentSweep') return proposal.kind === 'inspect_intent';
  if (job === 'idleWake') return proposal.kind === 'wake_issue' && proposal.nextAction === 'continue_work';
  if (job === 'reviewReconcile') return proposal.kind === 'wake_issue' && ['request_review', 'merge'].includes(proposal.nextAction);
  return job === 'prSupply' && (proposal.kind === 'create_pr_owner'
    || (proposal.kind === 'wake_issue' && proposal.nextAction !== 'continue_work'));
}

function validateLedger(ledger, companyId, now) {
  const check = condition => { if (!condition) throw new SupplyError('invalid-ledger'); };
  const validTime = t => Number.isSafeInteger(t) && t >= 0 && t <= now;
  const count = n => Number.isSafeInteger(n) && n >= 0;
  check(shape(ledger, ['version', 'companyId', 'entries', 'observations', 'health'])
    && ledger.version === 1 && ledger.companyId === companyId && Array.isArray(ledger.entries)
    && Array.isArray(ledger.observations) && record(ledger.health));
  const entries = new Map();
  for (const entry of ledger.entries) {
    check(shape(entry, ['key', 'action', 'firstSeenAt', 'lastSeenAt'])
      && typeof entry.key === 'string' && HASH.test(entry.key) && !entries.has(entry.key)
      && validTime(entry.firstSeenAt) && validTime(entry.lastSeenAt) && entry.firstSeenAt <= entry.lastSeenAt);
    validateAction(entry.action, companyId, entry.firstSeenAt);
    check(entry.action.key === entry.key);
    entries.set(entry.key, entry);
  }
  const latestObserved = new Map();
  for (const observation of ledger.observations) {
    check(shape(observation, ['key', 'job', 'at']) && entries.has(observation.key)
      && JOBS.includes(observation.job) && validTime(observation.at));
    const entry = entries.get(observation.key);
    check(validJobAction(observation.job, entry.action)
      && observation.at >= entry.firstSeenAt && observation.at <= entry.lastSeenAt);
    latestObserved.set(observation.key, Math.max(latestObserved.get(observation.key) ?? 0, observation.at));
  }
  for (const entry of entries.values()) {
    check(now - entry.lastSeenAt >= HOUR || latestObserved.get(entry.key) === entry.lastSeenAt);
  }
  for (const [job, health] of Object.entries(ledger.health)) {
    check(JOBS.includes(job));
    if (health?.status === 'shadow') {
      check(shape(health, ['status', 'at', 'candidates', 'observed', 'capped']) && validTime(health.at)
        && count(health.candidates) && count(health.observed) && health.observed <= health.candidates
        && health.observed <= 1000 && typeof health.capped === 'boolean');
    } else {
      check(shape(health, ['status', 'at', 'code']) && health.status === 'error'
        && (health.at === null || validTime(health.at)) && ERROR_CODES.includes(health.code));
    }
  }
}

async function dependency(call) {
  try {
    return await call();
  } catch {
    // Dependency-owned error classes and codes are not trusted kernel diagnostics.
    throw new SupplyError('shadow-dependency-failed');
  }
}

// Shadow only. This in-process fence is deliberately NOT advertised as a durable/distributed claim.
// A native live executor must claim intents atomically before it can mutate any core resource.
export class ShadowRunner {
  #busy = new Set();

  constructor({ store, collect, clock = Date.now }) {
    this.store = store;
    this.collect = collect;
    this.clock = clock;
  }

  async run(job, config) {
    try {
      config = structuredClone(config);
    } catch {
      throw new SupplyError('invalid-config');
    }
    validateConfig(config);
    if (!JOBS.includes(job)) throw new SupplyError('unknown-job');
    if (config.pause) return { status: 'paused', observed: 0 }; // No collection or ledger I/O.
    const companyId = config.companyId;
    if (this.#busy.has(companyId)) return { status: 'busy', observed: 0 };
    this.#busy.add(companyId);
    let lastValidLedger;
    let now, startedAt;
    let writeStarted = false;
    try {
      now = await dependency(() => this.clock());
      if (!Number.isSafeInteger(now) || now < 0) throw new SupplyError('invalid-time');
      startedAt = now;
      const stored = await dependency(() => this.store.get(companyId));
      let ledger = stored === null ? emptyLedger(companyId) : stored;
      try {
        ledger = structuredClone(ledger);
      } catch {
        throw new SupplyError('invalid-ledger');
      }
      validateLedger(ledger, companyId, now);
      lastValidLedger = structuredClone(ledger);
      const snapshot = await dependency(() => this.collect(job, companyId, config));
      now = await dependency(() => this.clock());
      if (!Number.isSafeInteger(now) || now < startedAt) throw new SupplyError('invalid-time');
      const actions = planJob(job, snapshot, config, now);
      const cap = config.caps[job];
      ledger.observations = ledger.observations.filter(o => now - o.at < HOUR);
      const used = ledger.observations.filter(o => o.job === job).length;
      const budget = Math.min(cap.perRun, Math.max(0, cap.perHour - used));
      const selected = [];
      const entries = new Map(ledger.entries.map(e => [e.key, e]));
      const due = actions.filter(a => !entries.has(a.key) || now - entries.get(a.key).lastSeenAt >= config.cooldownMs);
      for (const proposal of due.slice(0, budget)) {
        const previous = entries.get(proposal.key);
        if (!previous && entries.size >= config.maxLedgerEntries) throw new SupplyError('ledger-full');
        const entry = { key: proposal.key, action: proposal, firstSeenAt: previous?.firstSeenAt ?? now, lastSeenAt: now };
        entries.set(proposal.key, entry);
        ledger.observations.push({ key: proposal.key, job, at: now });
        selected.push(proposal);
      }
      ledger.entries = [...entries.values()];
      ledger.health[job] = { status: 'shadow', at: now, candidates: actions.length,
        observed: selected.length, capped: due.length > budget };
      const result = { status: 'shadow', observed: selected.length, actions: structuredClone(selected) };
      writeStarted = true;
      await dependency(() => this.store.set(companyId, ledger));
      return result;
    } catch (error) {
      const code = error instanceof SupplyError && ERROR_CODES.includes(error.code)
        ? error.code : 'shadow-dependency-failed';
      // A throwing write can already have committed. Never replace that unknown outcome with older state.
      if (lastValidLedger && !writeStarted) {
        lastValidLedger.health[job] = { status: 'error',
          at: Number.isSafeInteger(now) && now >= startedAt ? now : null, code };
        try {
          await dependency(() => this.store.set(companyId, lastValidLedger));
        } catch {
          // Preserve the failure even when health persistence is unavailable.
        }
      }
      throw new SupplyError(code);
    } finally {
      this.#busy.delete(companyId);
    }
  }
}
