import { JOBS, MAX_CONFIG_PROJECTS, SCHEDULED_JOBS } from './policy.mjs';

export const PLUGIN_ID = 'togetherweown.work-supply';
export const PLUGIN_VERSION = '0.3.0';
const count = { type: 'integer', minimum: 0, maximum: 1000 };
const cap = { type: 'object', additionalProperties: false, required: ['perRun', 'perHour'],
  properties: { perRun: count, perHour: count } };

// Official API v1: doc/plugins/PLUGIN_AUTHORING_GUIDE.md and packages/plugins/sdk/src/types.ts
// in https://github.com/paperclipai/paperclip. No action, secret, HTTP or agent-tool capability.
export const manifest = {
  id: PLUGIN_ID, apiVersion: 1, version: PLUGIN_VERSION,
  displayName: 'Work Supply (Shadow)', author: 'TogetherWeOwn', categories: ['automation'],
  description: 'Native backlog and idle-wake shadow decisions; no core effects or timer-retirement authority.',
  capabilities: ['jobs.schedule', 'plugin.state.read', 'plugin.state.write', 'issues.read',
    'agents.read', 'issue.relations.read', 'issues.orchestration.read', 'issue.interactions.read'],
  entrypoints: { worker: './src/worker.mjs' },
  jobs: SCHEDULED_JOBS.map(jobKey => ({ jobKey, displayName: jobKey,
    description: 'Observe only with complete native inputs and verified healthy host pressure.', schedule: '3-59/5 * * * *' })),
  instanceConfigSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      mode: { type: 'string', enum: ['shadow'], default: 'shadow' },
      pause: { type: 'boolean', default: true, description: 'PAUSE: no collection or ledger I/O.' },
      hostPressureScopeVerified: { type: 'boolean', default: false,
        description: 'Operator verified /proc/pressure, / and /home describe the actual host, not container-only mounts.' },
      floor: { ...count, default: 40 },
      maxSnapshotAgeMs: { type: 'integer', minimum: 1, default: 60000 },
      cooldownMs: { type: 'integer', minimum: 1, default: 21600000 },
      maxLedgerEntries: { type: 'integer', minimum: 1, default: 10000 },
      projects: { type: 'array', default: [], maxItems: MAX_CONFIG_PROJECTS, items: { type: 'object', additionalProperties: false,
        required: ['id', 'name', 'rank', 'admitted', 'assigneeAgentId'], properties: {
          id: { type: 'string', minLength: 1, maxLength: 256 },
          name: { type: 'string', minLength: 1, maxLength: 256 }, rank: { type: 'integer', minimum: 0 },
          admitted: { type: 'boolean' }, assigneeAgentId: { type: ['string', 'null'], minLength: 1, maxLength: 256 },
        } } },
      repositories: { type: 'array', default: [], items: { type: 'object', additionalProperties: false,
        required: ['repo', 'projectId'], properties: {
          repo: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
          projectId: { type: 'string', minLength: 1, maxLength: 256 },
        } } },
      caps: { type: 'object', additionalProperties: false, required: [...JOBS],
        properties: Object.fromEntries(JOBS.map(job => [job, cap])),
        default: Object.fromEntries(JOBS.map(job => [job, { perRun: 10, perHour: 40 }])),
      },
    },
  },
};
export default manifest;
