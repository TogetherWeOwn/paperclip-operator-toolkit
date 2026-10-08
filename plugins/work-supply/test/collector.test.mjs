import test from 'node:test';
import assert from 'node:assert/strict';
import { collectNativeSnapshot, nativeReadClientsAvailable } from '../src/collector.mjs';
import { planJob } from '../src/policy.mjs';
import { NOW, config } from './fixtures.mjs';

const emptyEvidence = () => ({ blockedBy: [], blocks: [] });
const orchestration = patch => ({ runs: [], approvals: [], openBudgetIncidents: [], invocationBlocks: [], ...patch });

function rawIssue(id, status = 'backlog', overrides = {}) {
  return {
    id, companyId: 'company-a', projectId: 'primary', title: `Issue ${id}`, description: null,
    status, priority: 'medium', createdAt: new Date(NOW - 3 * 86_400_000),
    updatedAt: new Date(NOW - 2 * 86_400_000), assigneeAgentId: null, assigneeUserId: null,
    activeRun: null, executionBlocker: null, activeRecoveryAction: null, unblockDescriptor: null,
    executionState: null, executionPolicy: null, monitorNextCheckAt: null, liveDescendantCount: 0,
    scheduledRetry: null, labels: [], ...overrides,
  };
}

function rawAgent(id = 'agent-a', status = 'idle', overrides = {}) {
  return {
    id, companyId: 'company-a', status, pauseReason: null, pausedAt: null,
    runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, ...overrides,
  };
}

function sdk({ issues = [], agents = [rawAgent()], relations = {}, interactions = {}, summaries = {} } = {}) {
  const calls = { issues: [], agents: [], relations: [], interactions: [], orchestration: [] };
  const ctx = {
    issues: {
      list: async input => {
        calls.issues.push(input);
        return issues.filter(row => row.projectId === input.projectId)
          .slice(input.offset, input.offset + input.limit);
      },
      relations: { get: async (issueId, companyId) => {
        calls.relations.push({ issueId, companyId });
        return relations[issueId] ?? emptyEvidence();
      } },
      listInteractions: async (issueId, companyId) => {
        calls.interactions.push({ issueId, companyId });
        return interactions[issueId] ?? [];
      },
      summaries: { getOrchestration: async input => {
        calls.orchestration.push(input);
        return orchestration({ issueId: input.issueId, companyId: input.companyId, ...summaries[input.issueId] });
      } },
    },
    agents: { list: async input => {
      calls.agents.push(input);
      return agents.slice(input.offset, input.offset + input.limit);
    } },
  };
  return { ctx, calls };
}

async function collect(reads, job = 'backlogFloor', settings = config(), clock = () => NOW) {
  return collectNativeSnapshot(reads.ctx, job, settings.companyId, settings, clock);
}

test('native reader paginates issues and agents through the verified read clients', async () => {
  const issues = Array.from({ length: 101 }, (_, i) => rawIssue(`issue-${String(i).padStart(3, '0')}`));
  const agents = Array.from({ length: 101 }, (_, i) => rawAgent(i === 0 ? 'agent-a' : `agent-${i}`));
  const reads = sdk({ issues, agents });
  const sample = await collect(reads);

  assert.equal(sample.complete, true);
  assert.equal(sample.issues.length, 101);
  assert.equal(sample.agents.length, 101);
  assert.equal(sample.prs, undefined);
  assert.equal(sample.intents, undefined);
  assert.deepEqual(reads.calls.issues.map(call => `${call.projectId}:${call.offset}`).sort(), [
    'primary:0', 'primary:100', 'secondary:0',
  ]);
  assert.deepEqual(reads.calls.agents.map(call => call.offset), [0, 100]);
  assert.equal(reads.calls.relations.length, 101);
  assert.equal(reads.calls.interactions.length, 101);
  assert.equal(reads.calls.orchestration.length, 101);
  assert.deepEqual(planJob('backlogFloor', sample, config({ floor: 40 }), NOW).length, 40);
});

test('backlog filters policy exclusions and conservatively suppresses recently updated backlog', async () => {
  const issues = [
    rawIssue('operator', 'backlog', { title: 'Operator: investigate' }),
    rawIssue('parked', 'backlog', { description: 'Parked until the dependency ships.' }),
    rawIssue('probe', 'backlog', { title: 'Probe coverage' }),
    rawIssue('canary', 'backlog', { labels: [{ name: 'canary' }] }),
    rawIssue('kofra-laravel', 'backlog', { title: 'Kofra Laravel migration' }),
    rawIssue('kofra-filament', 'backlog', { project: { name: 'Kofra' }, title: 'Filament cleanup' }),
    rawIssue('recent', 'backlog', { updatedAt: new Date(NOW - 60_000) }),
    rawIssue('description-truncated', 'backlog', { descriptionTruncated: true }),
    rawIssue('eligible'),
  ];
  const sample = await collect(sdk({ issues }));
  const byId = new Map(sample.issues.map(issue => [issue.id, issue]));
  for (const id of issues.slice(0, -1).map(issue => issue.id)) assert.equal(byId.get(id).runnable, false, id);
  assert.equal(byId.get('eligible').runnable, true);
  assert.deepEqual(planJob('backlogFloor', sample, config({ floor: 1 }), NOW).map(action => action.issueId), ['eligible']);
});

test('idle wake respects monitor deadlines, blocker edges, waits, live runs, and recent runs', async () => {
  const issues = [
    rawIssue('monitor', 'in_progress', { assigneeAgentId: 'agent-a', monitorNextCheckAt: new Date(NOW + 60_000) }),
    rawIssue('blocked', 'in_progress', { assigneeAgentId: 'agent-a' }),
    rawIssue('cancelled-blocked', 'todo', { assigneeAgentId: 'agent-a' }),
    rawIssue('waiting', 'todo', { assigneeAgentId: 'agent-a' }),
    rawIssue('running', 'in_progress', { assigneeAgentId: 'agent-a' }),
    rawIssue('recent', 'todo', { assigneeAgentId: 'agent-a' }),
    rawIssue('ready', 'in_progress', { assigneeAgentId: 'agent-a' }),
  ];
  const reads = sdk({
    issues,
    relations: {
      blocked: { blockedBy: [{ status: 'todo' }], blocks: [] },
      'cancelled-blocked': { blockedBy: [{ status: 'cancelled' }], blocks: [] },
    },
    interactions: { waiting: [{ status: 'pending' }] },
    summaries: {
      running: { runs: [{ status: 'running', createdAt: new Date(NOW - 60_000), startedAt: new Date(NOW - 60_000) }] },
      recent: { runs: [{ status: 'succeeded', createdAt: new Date(NOW - 20 * 60_000), startedAt: new Date(NOW - 20 * 60_000) }] },
    },
  });
  const sample = await collect(reads, 'idleWake');
  const byId = new Map(sample.issues.map(issue => [issue.id, issue]));
  assert.equal(byId.get('monitor').held, true);
  assert.equal(byId.get('blocked').blocked, true);
  assert.equal(byId.get('cancelled-blocked').blocked, true);
  assert.equal(byId.get('waiting').awaitingInput, true);
  assert.equal(byId.get('running').liveRun, true);
  assert.equal(byId.get('recent').held, true);
  assert.deepEqual(planJob('idleWake', sample, config(), NOW).map(action => action.issueId), ['ready']);
});

test('idle wake enforces the three-failure limit and fails closed at the 100-run cap', async () => {
  const issues = [
    rawIssue('three-failures', 'todo', { assigneeAgentId: 'agent-a' }),
    rawIssue('history-cap', 'todo', { assigneeAgentId: 'agent-a' }),
    rawIssue('two-failures', 'todo', { assigneeAgentId: 'agent-a' }),
  ];
  const old = offset => new Date(NOW - 60 * 60_000 - offset);
  const reads = sdk({ issues, summaries: {
    'three-failures': { runs: [0, 1, 2].map(i => ({ status: 'failed', createdAt: old(i * 1000), startedAt: old(i * 1000) })) },
    'history-cap': { runs: Array.from({ length: 100 }, (_, i) => ({ status: 'succeeded', createdAt: old(i), startedAt: old(i) })) },
    'two-failures': { runs: [
      { status: 'failed', createdAt: old(0), startedAt: old(0) },
      { status: 'failed', createdAt: old(1000), startedAt: old(1000) },
      { status: 'succeeded', createdAt: old(2000), startedAt: old(2000) },
    ] },
  } });
  const sample = await collect(reads, 'idleWake');
  const byId = new Map(sample.issues.map(issue => [issue.id, issue]));
  assert.equal(byId.get('three-failures').held, true);
  assert.equal(byId.get('history-cap').held, true);
  assert.deepEqual(planJob('idleWake', sample, config(), NOW).map(action => action.issueId), ['two-failures']);
});

test('idle wake requires a per-agent spare slot and proposes at most one issue per idle agent', async () => {
  const issues = [
    rawIssue('first', 'todo', { assigneeAgentId: 'agent-a' }),
    rawIssue('second', 'in_progress', { assigneeAgentId: 'agent-a' }),
    rawIssue('running-agent', 'todo', { assigneeAgentId: 'agent-b' }),
  ];
  const reads = sdk({ issues, agents: [rawAgent('agent-a', 'idle'), rawAgent('agent-b', 'running', {
    runtimeConfig: { heartbeat: { maxConcurrentRuns: 4 } },
  })] });
  const sample = await collect(reads, 'idleWake');
  assert.equal(sample.agents.find(agent => agent.id === 'agent-a').spareCapacity, 1);
  assert.equal(sample.agents.find(agent => agent.id === 'agent-b').spareCapacity, 0);
  assert.deepEqual(planJob('idleWake', sample, config(), NOW).map(action => action.issueId), ['second']);
});

test('unresolved budget incidents hold only matching project, agent, or company scopes', async () => {
  const issues = [rawIssue('held', 'todo', { assigneeAgentId: 'agent-a' }),
    rawIssue('free', 'in_progress', { assigneeAgentId: 'agent-a' })];
  const reads = sdk({ issues, summaries: {
    held: { openBudgetIncidents: [{ scopeType: 'project', scopeId: 'primary' }] },
  } });
  const sample = await collect(reads, 'idleWake');
  const byId = new Map(sample.issues.map(issue => [issue.id, issue]));
  assert.equal(byId.get('held').held, true);
  assert.equal(byId.get('free').held, false);
});

test('collector rejects unsupported jobs and incomplete SDK surfaces without fabricating census rows', async () => {
  const reads = sdk();
  assert.equal(nativeReadClientsAvailable(reads.ctx), true);
  await assert.rejects(collect(reads, 'prSupply'), { code: 'host-only-job' });
  await assert.rejects(collect({ ctx: { issues: {}, agents: {} } }), { code: 'native-read-client-unavailable' });
  const malformed = sdk({ issues: [rawIssue('bad')] });
  malformed.ctx.issues.relations.get = async () => ({ blockedBy: [], blocks: [] });
  malformed.ctx.issues.listInteractions = async () => [];
  malformed.ctx.issues.summaries.getOrchestration = async () => ({ runs: [], approvals: [] });
  await assert.rejects(collect(malformed), { code: 'native-snapshot-incomplete' });
});
