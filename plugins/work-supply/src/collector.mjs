import { SCHEDULED_JOBS, SupplyError } from './policy.mjs';

const PAGE_SIZE = 100;
const ISSUE_LIST_LIMIT = 1000;
const MAX_NATIVE_ISSUES = 500;
const MAX_NATIVE_AGENTS = 500;
const MAX_PAGES = 100;
const READ_CONCURRENCY = 8;
const DAY = 24 * 60 * 60_000;
const RECENT_RUN_WINDOW = 20 * 60_000;
const RUN_HISTORY_LIMIT = 100;
const ISSUE_STATUSES = {
  backlogFloor: ['backlog', 'todo'],
  idleWake: ['todo', 'in_progress'],
};
const LIVE_RUNS = new Set(['queued', 'running', 'scheduled_retry']);
const FAILED_RUNS = new Set(['failed', 'errored', 'error', 'timed_out', 'timeout']);
const SETTLED_RUNS = new Set(['succeeded', 'interrupted', 'cancelled', 'canceled', 'expired', 'skipped']);
const RESOLVED_BLOCKER_STATUSES = new Set(['done']);
const AGENT_STATUSES = new Set(['active', 'paused', 'idle', 'running', 'error', 'pending_approval', 'terminated']);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(code = 'native-snapshot-incomplete') {
  throw new SupplyError(code);
}

function assertSnapshotFresh(asOf, config, clock) {
  const observedAt = clock();
  if (!Number.isSafeInteger(observedAt) || observedAt < asOf) fail('invalid-time');
  if (observedAt - asOf > config.maxSnapshotAgeMs) throw new SupplyError('stale-snapshot');
}

function timestamp(value) {
  const parsed = value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value
      : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function requiredTimestamp(value) {
  const parsed = timestamp(value);
  if (parsed === null) fail();
  return parsed;
}

export function nativeReadClientsAvailable(ctx) {
  try {
    return typeof ctx?.issues?.list === 'function'
      && typeof ctx?.issues?.relations?.get === 'function'
      && typeof ctx?.issues?.summaries?.getOrchestration === 'function'
      && typeof ctx?.issues?.listInteractions === 'function'
      && typeof ctx?.agents?.list === 'function';
  } catch {
    return false;
  }
}

async function readAll(fetchPage, input, assertFresh) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    assertFresh();
    const remaining = MAX_NATIVE_AGENTS - rows.length;
    const limit = Math.min(PAGE_SIZE, remaining + 1);
    const batch = await fetchPage({ ...input, limit, offset: rows.length });
    if (!Array.isArray(batch) || batch.length > limit || batch.length > remaining) fail();
    rows.push(...batch);
    if (rows.length >= MAX_NATIVE_AGENTS) fail();
    if (batch.length < limit) return rows;
  }
  fail();
}

async function readProjectIssues(ctx, project, companyId, job, remaining, assertFresh) {
  const rows = [];
  for (const status of ISSUE_STATUSES[job]) {
    assertFresh();
    const available = remaining - rows.length;
    const limit = Math.min(ISSUE_LIST_LIMIT, available + 1);
    const batch = await ctx.issues.list({ companyId, projectId: project.id, status,
      limit, offset: 0 });
    if (!Array.isArray(batch) || batch.length >= limit || rows.length + batch.length >= remaining
        || batch.some(issue => !record(issue) || issue.status !== status)) fail();
    rows.push(...batch);
  }
  return rows;
}

async function readAllProjectIssues(ctx, projects, companyId, job, assertFresh) {
  const rows = [];
  for (const project of projects) {
    const group = await readProjectIssues(ctx, project, companyId, job,
      MAX_NATIVE_ISSUES - rows.length, assertFresh);
    rows.push(...group);
  }
  return rows;
}

async function mapLimit(values, fn) {
  const result = new Array(values.length);
  let index = 0;
  let failed = false;
  let failure;
  const worker = async () => {
    while (!failed) {
      const current = index++;
      if (current >= values.length) return;
      try { result[current] = await fn(values[current]); }
      catch (error) { failed = true; failure = error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, values.length) }, worker));
  if (failed) throw failure;
  return result;
}

function uniqueRows(rows) {
  const ids = new Set();
  for (const row of rows) {
    if (!record(row) || typeof row.id !== 'string' || !row.id || ids.has(row.id)) fail();
    ids.add(row.id);
  }
  return rows;
}

function normalizeAgent(agent, companyId) {
  if (!record(agent) || agent.companyId !== companyId || typeof agent.id !== 'string'
      || !AGENT_STATUSES.has(agent.status)) fail();
  const held = agent.pauseReason !== null && agent.pauseReason !== undefined
    || agent.pausedAt !== null && agent.pausedAt !== undefined;
  const canWake = !held && ['idle', 'running'].includes(agent.status);
  // The host marks an agent idle only after its running-run count reaches zero;
  // the pinned heartbeat policy clamps maxConcurrentRuns to at least one. The
  // idle-wake planner emits at most one proposal per idle agent.
  const spareCapacity = agent.status === 'idle' && !held ? 1 : 0;
  return { id: agent.id, companyId, status: agent.status, canWake, spareCapacity };
}

function issueExclusion(issue, projectName) {
  const title = issue.title;
  const description = typeof issue.description === 'string' ? issue.description : '';
  const labels = Array.isArray(issue.labels)
    ? issue.labels.map(label => typeof label?.name === 'string' ? label.name : '').join(' ')
    : '';
  if (title.startsWith('Operator:')) return true;
  if (issue.descriptionTruncated === true) return true;
  const searchable = `${title}\n${description}\n${projectName}\n${labels}`;
  if (/parked\s+until/i.test(searchable) || /\b(?:probe|canary)\b/i.test(searchable)) return true;
  return /\bkofra\b/i.test(searchable) && /\b(?:laravel|filament)\b/i.test(searchable);
}

function isLiveRun(run) {
  return record(run) && typeof run.status === 'string' && LIVE_RUNS.has(run.status.toLowerCase());
}

function monitorDeadline(issue) {
  const values = [issue.monitorNextCheckAt, issue.executionPolicy?.monitor?.nextCheckAt]
    .filter(value => value !== null && value !== undefined);
  if (!values.length) return { invalid: false, at: null };
  const parsed = values.map(timestamp);
  if (parsed.some(value => value === null)) return { invalid: true, at: null };
  return { invalid: false, at: Math.max(...parsed) };
}

function runEvidence(runs, now) {
  if (!Array.isArray(runs)) fail();
  let live = false;
  let recent = false;
  let unknown = false;
  const normalized = [];
  for (const run of runs) {
    if (!record(run) || typeof run.status !== 'string') {
      unknown = true;
      continue;
    }
    const createdAt = timestamp(run.createdAt);
    const startedAt = run.startedAt === null || run.startedAt === undefined ? null : timestamp(run.startedAt);
    if (createdAt === null || (run.startedAt !== null && run.startedAt !== undefined && startedAt === null)) {
      unknown = true;
      continue;
    }
    const status = run.status.toLowerCase();
    if (LIVE_RUNS.has(status)) live = true;
    if (!LIVE_RUNS.has(status) && !FAILED_RUNS.has(status) && !SETTLED_RUNS.has(status)) unknown = true;
    const activityAt = Math.max(createdAt, startedAt ?? createdAt);
    if (now - activityAt <= RECENT_RUN_WINDOW) recent = true;
    normalized.push({ status, createdAt });
  }
  const failures = normalized.filter(run => FAILED_RUNS.has(run.status)).length;
  return { live, recent, unknown, failureLimit: failures >= 3,
    truncated: runs.length >= RUN_HISTORY_LIMIT };
}

function unresolvedBlocker(relations) {
  if (!record(relations) || !Array.isArray(relations.blockedBy) || !Array.isArray(relations.blocks)) fail();
  return relations.blockedBy.some(blocker => !record(blocker) || typeof blocker.status !== 'string'
    || !RESOLVED_BLOCKER_STATUSES.has(blocker.status));
}

function pendingInteraction(interactions) {
  if (!Array.isArray(interactions)) fail();
  return interactions.some(interaction => !record(interaction) || interaction.status === 'pending'
    || typeof interaction.status !== 'string');
}

function budgetOrInvocationHold(summary, companyId, projectId, agentId) {
  if (!Array.isArray(summary.openBudgetIncidents) || !Array.isArray(summary.invocationBlocks)) fail();
  const budgetHold = summary.openBudgetIncidents.some(incident => {
    if (!record(incident) || typeof incident.scopeType !== 'string' || typeof incident.scopeId !== 'string') return true;
    if (incident.scopeType === 'company') return incident.scopeId === companyId;
    if (incident.scopeType === 'project') return incident.scopeId === projectId;
    if (incident.scopeType === 'agent') return incident.scopeId === agentId;
    return true;
  });
  const invocationHold = summary.invocationBlocks.some(block => {
    if (!record(block) || typeof block.scopeType !== 'string' || typeof block.scopeId !== 'string') return true;
    return block.agentId === agentId
      || (block.scopeType === 'company' && block.scopeId === companyId)
      || (block.scopeType === 'project' && block.scopeId === projectId)
      || (block.scopeType === 'agent' && block.scopeId === agentId);
  });
  return budgetHold || invocationHold;
}

function hasPendingApproval(approvals) {
  if (!Array.isArray(approvals)) fail();
  return approvals.some(approval => !record(approval) || typeof approval.status !== 'string'
    || !['approved', 'rejected', 'cancelled', 'canceled', 'expired'].includes(approval.status.toLowerCase()));
}

function normalizeIssue(issue, config, agents, job, asOf, observedAt, evidence) {
  if (!record(issue) || issue.companyId !== config.companyId || typeof issue.id !== 'string'
      || typeof issue.projectId !== 'string' || typeof issue.title !== 'string'
      || !ISSUE_STATUSES[job].includes(issue.status)) fail();
  if (issue.assigneeAgentId !== null && issue.assigneeAgentId !== undefined && typeof issue.assigneeAgentId !== 'string') fail();
  if (issue.assigneeUserId !== null && issue.assigneeUserId !== undefined && typeof issue.assigneeUserId !== 'string') fail();
  const createdAt = requiredTimestamp(issue.createdAt);
  const updatedAt = requiredTimestamp(issue.updatedAt);
  if (createdAt > updatedAt || updatedAt > observedAt) fail();
  const priority = issue.priority;
  if (!['critical', 'high', 'medium', 'low'].includes(priority)) fail();

  const project = config.projects.find(item => item.id === issue.projectId && item.admitted);
  const ownerId = issue.assigneeAgentId ?? project?.assigneeAgentId ?? null;
  const owner = ownerId ? agents.get(ownerId) : null;
  const excluded = issueExclusion(issue, project?.name ?? '');
  const recentBacklogUpdate = job === 'backlogFloor' && issue.status === 'backlog'
    && asOf - updatedAt < DAY;
  const deadline = monitorDeadline(issue);
  const relationBlocked = unresolvedBlocker(evidence.relations);
  const runs = runEvidence(evidence.orchestration.runs, asOf);
  const blocked = issue.status === 'blocked' || relationBlocked
    || Number(issue.blockerAttention?.unresolvedBlockerCount ?? 0) > 0
    || Boolean(issue.blockedInboxAttention && issue.blockedInboxAttention.state !== 'clear');
  const awaitingInput = pendingInteraction(evidence.interactions)
    || hasPendingApproval(evidence.orchestration.approvals)
    || issue.executionState?.currentParticipant?.type === 'user'
    || issue.conversationState === 'waiting' || issue.externalConversationState === 'waiting';
  const held = issue.executionBlocker != null || issue.activeRecoveryAction != null
    || Boolean(issue.unblockDescriptor) || deadline.invalid
    || (job === 'idleWake' && deadline.at !== null && deadline.at > asOf)
    || budgetOrInvocationHold(evidence.orchestration, config.companyId, issue.projectId, ownerId)
    || runs.unknown || runs.truncated
    || (job === 'idleWake' && (runs.recent || runs.failureLimit));
  const hasLiveRun = isLiveRun(issue.activeRun) || runs.live
    || Number(issue.liveDescendantCount ?? 0) > 0
    || ['queued', 'running', 'scheduled_retry'].includes(issue.scheduledRetry?.status);
  const runnable = !excluded && !recentBacklogUpdate && !held && !blocked && !awaitingInput && !hasLiveRun
    && issue.assigneeUserId == null && owner?.canWake === true;

  return {
    id: issue.id, companyId: config.companyId, projectId: issue.projectId, status: issue.status,
    priority, createdAt, updatedAt, assigneeAgentId: issue.assigneeAgentId ?? null,
    assigneeUserId: issue.assigneeUserId ?? null, held, blocked, awaitingInput, liveRun: hasLiveRun, runnable,
    prState: 'unknown', pullRequestIds: null,
  };
}

async function readIssueEvidence(ctx, issue, companyId) {
  const [relations, interactions, orchestration] = await Promise.all([
    ctx.issues.relations.get(issue.id, companyId),
    ctx.issues.listInteractions(issue.id, companyId),
    ctx.issues.summaries.getOrchestration({ issueId: issue.id, companyId }),
  ]);
  if (!record(orchestration) || !Array.isArray(orchestration.runs)
      || !Array.isArray(orchestration.approvals) || !Array.isArray(orchestration.openBudgetIncidents)
      || !Array.isArray(orchestration.invocationBlocks)) fail();
  return { relations, interactions, orchestration };
}

export async function collectNativeSnapshot(ctx, job, companyId, config, clock = Date.now) {
  if (!SCHEDULED_JOBS.includes(job)) throw new SupplyError('host-only-job');
  if (!nativeReadClientsAvailable(ctx)) throw new SupplyError('native-read-client-unavailable');
  if (typeof clock !== 'function') fail('invalid-time');
  const asOf = clock();
  if (!Number.isSafeInteger(asOf) || asOf < 0) fail('invalid-time');
  try {
    const projects = config.projects.filter(project => project.admitted).sort((a, b) => a.rank - b.rank);
    const assertFresh = () => assertSnapshotFresh(asOf, config, clock);
    const [rawIssues, rawAgents] = await Promise.all([
      readAllProjectIssues(ctx, projects, companyId, job, assertFresh),
      readAll(input => ctx.agents.list(input), { companyId }, assertFresh),
    ]);
    const allIssues = uniqueRows(rawIssues);
    const allAgents = uniqueRows(rawAgents);
    if (allAgents.some(agent => agent.companyId !== companyId)) fail();
    const agents = allAgents.map(agent => normalizeAgent(agent, companyId));
    const agentsById = new Map(agents.map(agent => [agent.id, agent]));
    const selected = allIssues.filter(issue => {
      if (!record(issue) || issue.companyId !== companyId) fail();
      if (!projects.some(project => project.id === issue.projectId)) fail();
      return ISSUE_STATUSES[job].includes(issue.status);
    });
    const evidence = await mapLimit(selected, issue => {
      assertFresh();
      return readIssueEvidence(ctx, issue, companyId);
    });
    const endedAt = clock();
    if (!Number.isSafeInteger(endedAt) || endedAt < asOf) fail('invalid-time');
    if (endedAt - asOf > config.maxSnapshotAgeMs) throw new SupplyError('stale-snapshot');
    const issues = selected.map((issue, index) => normalizeIssue(issue, config, agentsById,
      job, asOf, endedAt, evidence[index]));
    return { companyId, capturedAt: asOf, complete: true, issues, agents };
  } catch (error) {
    if (error instanceof SupplyError) throw error;
    throw new SupplyError('native-snapshot-incomplete');
  }
}
