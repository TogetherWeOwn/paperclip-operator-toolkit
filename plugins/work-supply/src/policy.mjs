import { createHash } from 'node:crypto';

export const JOBS = Object.freeze(['prSupply', 'backlogFloor', 'idleWake', 'reviewReconcile', 'intentSweep']);
const HOUR = 3_600_000;
const PRIORITY = { critical: 0, high: 1, medium: 2, low: 3 };
const OPEN = new Set(['backlog', 'todo', 'in_progress', 'in_review']);

export const ERROR_CODES = Object.freeze(['invalid-config', 'shadow-only', 'invalid-time',
  'invalid-snapshot', 'stale-snapshot', 'unknown-job', 'invalid-ledger', 'ledger-full', 'shadow-dependency-failed']);

export class SupplyError extends Error {
  constructor(code) {
    const safeCode = ERROR_CODES.includes(code) ? code : 'shadow-dependency-failed';
    super(safeCode);
    this.name = 'SupplyError';
    this.code = safeCode;
  }
}

function requireValue(condition, code = 'invalid-snapshot') {
  if (!condition) throw new SupplyError(code);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function identifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function timestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validateConfig(config) {
  requireValue(record(config) && identifier(config.companyId), 'invalid-config');
  requireValue(typeof config.pause === 'boolean' && config.mode === 'shadow', 'shadow-only');
  requireValue(Array.isArray(config.projects) && Array.isArray(config.repositories), 'invalid-config');
  requireValue(Number.isSafeInteger(config.floor) && config.floor >= 0 && config.floor <= 1000, 'invalid-config');
  for (const key of ['maxSnapshotAgeMs', 'cooldownMs', 'maxLedgerEntries']) {
    requireValue(Number.isSafeInteger(config[key]) && config[key] > 0, 'invalid-config');
  }
  const projects = new Set();
  for (const p of config.projects) {
    requireValue(record(p) && identifier(p.id) && !projects.has(p.id) && Number.isSafeInteger(p.rank)
      && p.rank >= 0 && typeof p.admitted === 'boolean', 'invalid-config');
    requireValue(p.assigneeAgentId === null || identifier(p.assigneeAgentId), 'invalid-config');
    projects.add(p.id);
  }
  const repositories = new Set();
  for (const r of config.repositories) {
    requireValue(record(r) && typeof r.repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.repo)
      && !repositories.has(r.repo.toLowerCase()) && projects.has(r.projectId), 'invalid-config');
    repositories.add(r.repo.toLowerCase());
  }
  for (const job of JOBS) {
    const cap = config.caps?.[job];
    requireValue(cap && ['perRun', 'perHour'].every(k => Number.isSafeInteger(cap[k])
      && cap[k] >= 0 && cap[k] <= 1000), 'invalid-config');
  }
}

// Collectors must normalize native evidence. Titles, comments and PR bodies are never policy inputs.
export function validateSnapshot(snapshot, config, now) {
  requireValue(timestamp(now), 'invalid-time');
  requireValue(snapshot?.companyId === config.companyId && snapshot.complete === true);
  requireValue(timestamp(snapshot.capturedAt) && snapshot.capturedAt <= now
    && now - snapshot.capturedAt <= config.maxSnapshotAgeMs, 'stale-snapshot');
  for (const collection of ['issues', 'agents', 'prs', 'intents']) {
    requireValue(Array.isArray(snapshot[collection]));
    const ids = new Set();
    for (const item of snapshot[collection]) {
      requireValue(record(item) && item.companyId === config.companyId && identifier(item.id) && !ids.has(item.id));
      ids.add(item.id);
    }
  }
  for (const i of snapshot.issues) {
    requireValue(identifier(i.projectId) && Object.hasOwn(PRIORITY, i.priority)
      && ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'].includes(i.status));
    requireValue(['held', 'blocked', 'awaitingInput', 'liveRun', 'runnable'].every(k => typeof i[k] === 'boolean'));
    requireValue(timestamp(i.createdAt) && timestamp(i.updatedAt) && i.createdAt <= i.updatedAt && i.updatedAt <= now);
    requireValue(i.assigneeAgentId === null || identifier(i.assigneeAgentId));
    requireValue(i.assigneeUserId === null || identifier(i.assigneeUserId));
    requireValue(['none', 'open', 'closed'].includes(i.prState) && Array.isArray(i.pullRequestIds)
      && Array.from(i.pullRequestIds).every(identifier));
  }
  for (const a of snapshot.agents) {
    requireValue(['idle', 'running', 'paused', 'error', 'terminated'].includes(a.status)
      && typeof a.canWake === 'boolean');
  }
  for (const pr of snapshot.prs) {
    requireValue(typeof pr.repo === 'string' && identifier(pr.headSha)
      && ['open', 'closed', 'merged'].includes(pr.state) && typeof pr.draft === 'boolean');
    requireValue(timestamp(pr.createdAt) && pr.createdAt <= now);
    requireValue(['success', 'failure', 'pending', 'unknown'].includes(pr.ciState));
    requireValue(['missing', 'error', 'pending', 'changes_requested', 'approved'].includes(pr.reviewState));
    requireValue(pr.reviewHeadSha === null || identifier(pr.reviewHeadSha));
    requireValue(pr.reviewScore === null || (Number.isInteger(pr.reviewScore) && pr.reviewScore >= 0 && pr.reviewScore <= 5));
    requireValue(pr.mergeable === null || typeof pr.mergeable === 'boolean');
  }
  for (const i of snapshot.intents) {
    requireValue(identifier(i.issueId) && ['pending', 'resolved'].includes(i.status));
  }
}

function project(config, id) {
  return config.projects.find(p => p.id === id && p.admitted);
}

function eligible(issue, config) {
  return Boolean(project(config, issue.projectId)) && OPEN.has(issue.status)
    && !issue.held && !issue.blocked && !issue.awaitingInput && !issue.liveRun
    && issue.assigneeUserId === null && issue.runnable && issue.prState !== 'closed';
}

function ownerId(issue, config) {
  return issue.assigneeAgentId ?? project(config, issue.projectId)?.assigneeAgentId ?? null;
}

function availableAgent(snapshot, id) {
  return snapshot.agents.find(a => a.id === id && a.canWake && ['idle', 'running'].includes(a.status));
}

function order(config) {
  return (a, b) => project(config, a.projectId).rank - project(config, b.projectId).rank
    || PRIORITY[a.priority] - PRIORITY[b.priority] || a.createdAt - b.createdAt || compare(a.id, b.id);
}

function action(kind, fields) {
  // Sorted keys avoid accidental payload-order changes to a stable intent key.
  const canonical = JSON.stringify([kind, Object.entries(fields).sort(([a], [b]) => compare(a, b))]);
  return { kind, ...fields, key: createHash('sha256').update(canonical).digest('hex') };
}

export function validateAction(proposal, companyId, now) {
  const check = condition => requireValue(condition, 'invalid-ledger');
  check(record(proposal) && proposal.companyId === companyId && identifier(companyId));
  let fields;
  switch (proposal.kind) {
    case 'create_pr_owner':
      fields = ['projectId', 'assigneeAgentId', 'prId'];
      break;
    case 'promote_issue':
      fields = ['issueId', 'assigneeAgentId', 'expectedUpdatedAt'];
      break;
    case 'inspect_intent':
      fields = ['issueId', 'intentId'];
      break;
    case 'wake_issue':
      fields = ['issueId', 'assigneeAgentId', 'expectedUpdatedAt', 'nextAction'];
      if (proposal.nextAction !== 'continue_work') {
        check(['resolve_conflicts', 'fix_checks', 'address_review', 'request_review', 'finish_draft', 'merge']
          .includes(proposal.nextAction));
        fields.push('prId', 'headSha', 'finishOrClose');
      }
      break;
    default:
      throw new SupplyError('invalid-ledger');
  }
  const keys = ['kind', 'companyId', 'key', ...fields];
  check(Object.keys(proposal).length === keys.length && keys.every(k => Object.hasOwn(proposal, k)));
  for (const field of fields) {
    if (field === 'expectedUpdatedAt') check(timestamp(proposal[field]) && proposal[field] <= now);
    else if (field === 'finishOrClose') check(typeof proposal[field] === 'boolean');
    else check(identifier(proposal[field]));
  }
  const { kind, key, ...payload } = proposal;
  check(typeof key === 'string' && key === action(kind, payload).key);
}

export function nextPrAction(pr) {
  if (pr.state !== 'open') return null;
  if (pr.mergeable === false) return 'resolve_conflicts';
  if (pr.ciState === 'failure') return 'fix_checks';
  if (['missing', 'error'].includes(pr.reviewState)
    || (pr.reviewHeadSha !== null && pr.reviewHeadSha !== pr.headSha)
    || (pr.reviewState === 'approved' && (pr.reviewHeadSha === null || pr.reviewScore !== 5))) return 'request_review';
  if (pr.reviewState === 'changes_requested') return 'address_review';
  if (pr.draft) return 'finish_draft';
  if (pr.ciState === 'success' && pr.reviewState === 'approved' && pr.reviewHeadSha === pr.headSha
    && pr.reviewScore === 5 && pr.mergeable === true) return 'merge';
  return null; // Pending/unknown CI is not a reason to wake an agent to poll it.
}

function prActions(snapshot, config, now, reviewOnly) {
  const result = [];
  for (const pr of [...snapshot.prs].sort((a, b) => a.createdAt - b.createdAt || compare(a.id, b.id))) {
    const mapping = config.repositories.find(r => r.repo.toLowerCase() === pr.repo.toLowerCase());
    const p = mapping && project(config, mapping.projectId);
    if (!p || pr.state !== 'open') continue;
    const owners = snapshot.issues.filter(i => (OPEN.has(i.status) || i.status === 'blocked') && i.pullRequestIds.includes(pr.id));
    // Ambiguous ownership is not permission to choose a second doer.
    if (owners.length > 1) continue;
    const nextAction = nextPrAction(pr);
    if (!owners.length) {
      if (!reviewOnly && availableAgent(snapshot, p.assigneeAgentId)) {
        result.push(action('create_pr_owner', { companyId: config.companyId, projectId: p.id,
          assigneeAgentId: p.assigneeAgentId, prId: pr.id }));
      }
      continue;
    }
    const issue = owners[0];
    if (issue.projectId !== p.id || !eligible(issue, config) || !nextAction
      || !availableAgent(snapshot, ownerId(issue, config))) continue;
    if (reviewOnly && !['request_review', 'merge'].includes(nextAction)) continue;
    result.push(action('wake_issue', { companyId: config.companyId, issueId: issue.id,
      expectedUpdatedAt: issue.updatedAt, assigneeAgentId: ownerId(issue, config), prId: pr.id, headSha: pr.headSha, nextAction,
      finishOrClose: now - pr.createdAt >= 14 * 24 * HOUR }));
  }
  return result;
}

export function planPrSupply(snapshot, config, now) {
  return prActions(snapshot, config, now, false);
}

export function planBacklogFloor(snapshot, config) {
  const runnable = i => eligible(i, config) && Boolean(availableAgent(snapshot, ownerId(i, config)));
  const count = snapshot.issues.filter(i => i.status === 'todo' && runnable(i)).length;
  return snapshot.issues.filter(i => i.status === 'backlog' && runnable(i)).sort(order(config))
    .slice(0, Math.max(0, config.floor - count))
    .map(i => action('promote_issue', { companyId: config.companyId, issueId: i.id,
      assigneeAgentId: ownerId(i, config), expectedUpdatedAt: i.updatedAt }));
}

export function planIdleWake(snapshot, config) {
  const result = [];
  for (const agent of [...snapshot.agents].sort((a, b) => compare(a.id, b.id))) {
    if (agent.status !== 'idle' || !agent.canWake) continue;
    const candidates = snapshot.issues.filter(i => ['todo', 'in_progress'].includes(i.status)
      && i.assigneeAgentId === agent.id && eligible(i, config))
      .sort((a, b) => Number(b.status === 'in_progress') - Number(a.status === 'in_progress') || order(config)(a, b));
    if (candidates.length) result.push(action('wake_issue', { companyId: config.companyId,
      issueId: candidates[0].id, expectedUpdatedAt: candidates[0].updatedAt,
      assigneeAgentId: agent.id, nextAction: 'continue_work' }));
  }
  return result;
}

export function planReviewReconcile(snapshot, config, now) {
  return prActions(snapshot, config, now, true);
}

export function planIntentSweep(snapshot) {
  // Exact host evidence predicates are not available yet. Observe candidates; never auto-decline.
  return snapshot.intents.filter(i => i.status === 'pending').sort((a, b) => compare(a.id, b.id))
    .map(i => action('inspect_intent', { companyId: snapshot.companyId, issueId: i.issueId, intentId: i.id }));
}

const PLANNERS = { prSupply: planPrSupply, backlogFloor: planBacklogFloor, idleWake: planIdleWake,
  reviewReconcile: planReviewReconcile, intentSweep: planIntentSweep };

export function planJob(job, snapshot, config, now) {
  validateConfig(config);
  requireValue(JOBS.includes(job), 'unknown-job');
  if (config.pause) return [];
  validateSnapshot(snapshot, config, now);
  return PLANNERS[job](snapshot, config, now);
}
