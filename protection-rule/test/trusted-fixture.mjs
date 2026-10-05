// SYNTHETIC TEST CONFIGURATION ONLY. These mappings and identities authorize no
// live installation, repository, environment or board card. Runtime modules
// never import this fixture; operators must supply independently reviewed config.
export const APPROVER_AGENT_ID = '00000000-0000-4000-8000-000000000001'
export const OTHER_AGENT_ID = '00000000-0000-4000-8000-000000000002'
export const INSTALLATION_ID = 9001
export const PLAN_POLICY = Object.freeze({
  repository: 'FixtureOrg/sample-apply',
  environment: 'fixture-apply',
  mode: 'plan',
  goIssueId: '00000000-0000-4000-8000-000000000011',
})
export const SHA_POLICY = Object.freeze({
  repository: 'FixtureOrg/sample-release',
  environment: 'fixture-release',
  mode: 'sha',
  goIssueId: '00000000-0000-4000-8000-000000000012',
})
export const SAME_REPO_SHA_POLICY = Object.freeze({
  repository: PLAN_POLICY.repository,
  environment: 'fixture-release',
  mode: 'sha',
  goIssueId: '00000000-0000-4000-8000-000000000013',
})
export const TRUSTED_CONFIG = Object.freeze({
  policies: Object.freeze([PLAN_POLICY, SHA_POLICY, SAME_REPO_SHA_POLICY]),
  approverAgentId: APPROVER_AGENT_ID,
  reviewedPlanRepositories: Object.freeze([PLAN_POLICY.repository]),
  installationIds: Object.freeze([INSTALLATION_ID]),
})
export function freshConfig() {
  return structuredClone(TRUSTED_CONFIG)
}
