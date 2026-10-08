import { JOBS } from '../src/policy.mjs';

export const NOW = 1_800_000_000_000;
export function config(overrides = {}) {
  return { companyId: 'company-a', mode: 'shadow', pause: false, floor: 40,
    maxSnapshotAgeMs: 60_000, cooldownMs: 6 * 3_600_000, maxLedgerEntries: 10_000,
    projects: [{ id: 'primary', name: 'Primary Product', rank: 0, admitted: true, assigneeAgentId: 'agent-a' },
      { id: 'secondary', name: 'Secondary Product', rank: 1, admitted: true, assigneeAgentId: 'agent-b' },
      { id: 'legacy', name: 'Legacy', rank: 2, admitted: false, assigneeAgentId: 'agent-a' }],
    repositories: [{ repo: 'example/primary', projectId: 'primary' }],
    caps: Object.fromEntries(JOBS.map(job => [job, { perRun: 10, perHour: 40 }])), ...overrides };
}
export function issue(id = 'issue-a', overrides = {}) {
  return { id, companyId: 'company-a', projectId: 'primary', status: 'backlog', priority: 'medium',
    createdAt: NOW - 100_000, updatedAt: NOW - 10_000, assigneeAgentId: 'agent-a', assigneeUserId: null,
    held: false, blocked: false, awaitingInput: false, liveRun: false, runnable: true,
    prState: 'none', pullRequestIds: [], ...overrides };
}
export function agent(id = 'agent-a', overrides = {}) {
  return { id, companyId: 'company-a', status: 'idle', canWake: true, spareCapacity: 1, ...overrides };
}
export function pr(overrides = {}) {
  return { id: 'pr-a', companyId: 'company-a', repo: 'example/primary', state: 'open',
    createdAt: NOW - 100_000, headSha: 'head-a', draft: false, ciState: 'success',
    reviewState: 'approved', reviewHeadSha: 'head-a', reviewScore: 5, mergeable: true, ...overrides };
}
export function snapshot(overrides = {}) {
  return { companyId: 'company-a', capturedAt: NOW, complete: true, issues: [],
    agents: [agent(), agent('agent-b')], prs: [], intents: [], ...overrides };
}
export function memoryStore() {
  const values = new Map();
  const reads = [], writes = [];
  return { values, reads, writes,
    async get(companyId) { reads.push(companyId); return values.get(companyId) ?? null; },
    async set(companyId, value) { writes.push(companyId); values.set(companyId, structuredClone(value)); } };
}
