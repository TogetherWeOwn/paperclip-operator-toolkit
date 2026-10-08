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
        return issues.filter(row => row.projectId === input.projectId && row.status === input.status)
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

// Isolate planner barriers in tests that cannot be measured from the native reader's unknown PR state.
function withNoPrEvidence(sample) {
  return { ...sample, issues: sample.issues.map(issue => ({ ...issue, prState: 'none', pullRequestIds: [] })) };
}

test('native reader queries relevant issue statuses and paginates agents through verified clients', async () => {
  const issues = Array.from({ length: 101 }, (_, i) => rawIssue(`issue-${String(i).padStart(3, '0')}`));
  const agents = Array.from({ length: 101 }, (_, i) => rawAgent(i === 0 ? 'agent-a' : `agent-${i}`));
  const reads = sdk({ issues, agents });
  const sample = await collect(reads);

  assert.equal(sample.complete, true);
  assert.equal(sample.issues.length, 101);
  assert.equal(sample.agents.length, 101);
  assert.equal(sample.prs, undefined);
  assert.equal(sample.intents, undefined);
  assert.equal(reads.calls.issues.length, 4);
  assert.ok(reads.calls.issues.every(call => call.limit > 0 && call.limit <= 501 && call.offset === 0));
  assert.deepEqual(reads.calls.issues.map(call => `${call.projectId}:${call.status}`).sort(), [
    'primary:backlog', 'primary:todo', 'secondary:backlog', 'secondary:todo',
  ]);
  assert.deepEqual(reads.calls.agents.map(call => call.offset), [0, 100]);
  assert.equal(reads.calls.relations.length, 101);
  assert.equal(reads.calls.interactions.length, 101);
  assert.equal(reads.calls.orchestration.length, 101);
  assert.ok(sample.issues.every(issue => issue.prState === 'unknown'));
  assert.deepEqual(planJob('backlogFloor', sample, config({ floor: 40 }), NOW), []);
});

test('issue collection avoids the host double-offset window and keeps every row', async () => {
  const issues = Array.from({ length: 250 }, (_, i) => rawIssue(`issue-${i}`));
  const reads = sdk({ issues });
  reads.ctx.issues.list = async input => {
    reads.calls.issues.push(input);
    const serviceRows = issues.filter(row => row.projectId === input.projectId && row.status === input.status)
      .slice(input.offset, input.offset + input.limit);
    return serviceRows.slice(input.offset, input.offset + input.limit);
  };

  const sample = await collect(reads);
  assert.equal(sample.complete, true);
  assert.equal(sample.issues.length, 250);
  assert.ok(reads.calls.issues.every(call => call.offset === 0));
});

test('issue collection fails closed when a status reaches the host list cap', async () => {
  const issues = Array.from({ length: 1000 }, (_, i) => rawIssue(`issue-${i}`));
  const reads = sdk({ issues });
  await assert.rejects(collect(reads), { code: 'native-snapshot-incomplete' });
  assert.equal(reads.calls.relations.length, 0);
});

test('issue collection applies one aggregate issue cap across the project map', async () => {
  const projects = Array.from({ length: 100 }, (_, i) => ({ id: `project-${i}`, name: `Project ${i}`,
    rank: i, admitted: true, assigneeAgentId: 'agent-a' }));
  const issues = projects.flatMap(project => Array.from({ length: 5 }, (_, i) =>
    rawIssue(`${project.id}-${i}`, 'backlog', { projectId: project.id })));
  const reads = sdk({ issues });

  await assert.rejects(collect(reads, 'backlogFloor', config({ projects, repositories: [] })), {
    code: 'native-snapshot-incomplete',
  });
  assert.equal(reads.calls.issues.length, 199);
  assert.equal(reads.calls.relations.length, 0);
});

test('agent collection fails closed at its aggregate cap before issue evidence reads', async () => {
  const agents = Array.from({ length: 500 }, (_, i) => rawAgent(i === 0 ? 'agent-a' : `agent-${i}`));
  const reads = sdk({ agents });

  await assert.rejects(collect(reads), { code: 'native-snapshot-incomplete' });
  assert.deepEqual(reads.calls.agents.map(call => call.offset), [0, 100, 200, 300, 400]);
  assert.equal(reads.calls.relations.length, 0);
});

test('snapshot freshness is rechecked before issue evidence reads', async () => {
  let now = NOW;
  let listCalls = 0;
  const reads = sdk({ issues: [rawIssue('stale-evidence', 'todo')] });
  const list = reads.ctx.issues.list;
  reads.ctx.issues.list = async input => {
    const rows = await list(input);
    if (++listCalls === 4) now = NOW + 6;
    return rows;
  };

  await assert.rejects(collect(reads, 'idleWake', config({ maxSnapshotAgeMs: 5 }), () => now), {
    code: 'stale-snapshot',
  });
  assert.equal(listCalls, 4);
  assert.equal(reads.calls.relations.length, 0);
  assert.equal(reads.calls.interactions.length, 0);
  assert.equal(reads.calls.orchestration.length, 0);
});

test('backlog filters policy exclusions and recency while unknown PR state blocks proposals', async () => {
  const issues = [
    rawIssue('operator', 'backlog', { title: 'Operator: investigate' }),
    rawIssue('parked', 'backlog', { description: 'Parked until the dependency ships.' }),
    rawIssue('probe', 'backlog', { title: 'Probe coverage' }),
    rawIssue('canary', 'backlog', { labels: [{ name: 'canary' }] }),
    rawIssue('kofra-laravel', 'backlog', { title: 'Kofra Laravel migration' }),
    rawIssue('kofra-filament', 'backlog', { title: 'Filament cleanup' }),
    rawIssue('recent', 'backlog', { updatedAt: new Date(NOW - 60_000) }),
    rawIssue('description-truncated', 'backlog', { descriptionTruncated: true }),
    rawIssue('eligible'),
  ];
  const settings = config({ projects: config().projects.map(project => ({
    ...project, name: project.id === 'primary' ? 'Kofra' : project.name,
  })) });
  const sample = await collect(sdk({ issues }), 'backlogFloor', settings);
  const byId = new Map(sample.issues.map(issue => [issue.id, issue]));
  for (const id of issues.slice(0, -1).map(issue => issue.id)) assert.equal(byId.get(id).runnable, false, id);
  assert.equal(byId.get('eligible').runnable, true);
  assert.deepEqual(planJob('backlogFloor', sample, config({ floor: 1 }), NOW), []);
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
  assert.deepEqual(planJob('idleWake', withNoPrEvidence(sample), config(), NOW).map(action => action.issueId), ['ready']);
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
  assert.deepEqual(planJob('idleWake', withNoPrEvidence(sample), config(), NOW).map(action => action.issueId), ['two-failures']);
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
  assert.deepEqual(planJob('idleWake', withNoPrEvidence(sample), config(), NOW).map(action => action.issueId), ['second']);
});

test('host-only active and pending-approval agent states are valid but never wakeable', async () => {
  const agents = [rawAgent('agent-active', 'active'), rawAgent('agent-approval', 'pending_approval')];
  const issues = [rawIssue('active-ready', 'todo', { assigneeAgentId: 'agent-active' }),
    rawIssue('approval-ready', 'todo', { assigneeAgentId: 'agent-approval' })];
  const sample = await collect(sdk({ issues, agents }), 'idleWake');

  assert.deepEqual(sample.agents.map(agent => [agent.status, agent.canWake, agent.spareCapacity]), [
    ['active', false, 0], ['pending_approval', false, 0],
  ]);
  assert.deepEqual(planJob('idleWake', sample, config(), NOW), []);
});

test('issue updated during reads is validated against the end-of-read clock', async () => {
  let now = NOW;
  const reads = sdk({ issues: [rawIssue('updated-during-read', 'todo', { updatedAt: new Date(NOW + 1) })] });
  const list = reads.ctx.issues.list;
  reads.ctx.issues.list = async input => {
    const rows = await list(input);
    if (input.projectId === 'primary' && input.status === 'todo') now = NOW + 1;
    return rows;
  };

  const sample = await collect(reads, 'idleWake', config(), () => now);
  assert.equal(sample.capturedAt, NOW);
  assert.equal(sample.issues[0].updatedAt, NOW + 1);
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
