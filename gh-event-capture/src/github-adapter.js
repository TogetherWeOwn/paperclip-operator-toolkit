// Host-side GitHub reads. Use the installed gh credential path, never shell
// interpolation or tokens in arguments. No polling or retries in this adapter.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const PR_QUERY = `query BridgePullRequest($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    pullRequest(number: $number) {
      number url title body state isDraft merged headRefName headRefOid reviewDecision
      author { __typename login }
      baseRepository { nameWithOwner }
    }
  }
}`
const OPEN_QUERY = `query BridgeOpenPullRequests($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    pullRequests(first: 100, after: $after, states: [OPEN], orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      nodes { number }
      pageInfo { hasNextPage endCursor }
    }
  }
}`
const VERDICTS = new Set([null, 'REVIEW_REQUIRED', 'APPROVED', 'CHANGES_REQUESTED'])
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/
// One read for the closeout snapshot (design §5.1: the decision is computed
// from a fresh read, never from delivery payloads). Lifecycle, head, labels,
// merge state, auto-merge flag and the head commit's check rollup come from a
// single GraphQL instant, so checks can never be attributed to a different head
// than the one returned. Commits are matched by oid, not position: last:10 is
// only a window, and a head outside it fails loudly instead of reading a
// sibling commit's checks.
const SNAPSHOT_QUERY = `query BridgeCloseoutSnapshot($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    pullRequest(number: $number) {
      number url title body state isDraft merged headRefName headRefOid reviewDecision
      mergeStateStatus baseRefName
      autoMergeRequest { enabledAt }
      author { __typename login }
      baseRepository { nameWithOwner }
      labels(first: 100) { nodes { name } pageInfo { hasNextPage } }
      commits(last: 10) {
        nodes { commit {
          oid pushedDate
          statusCheckRollup { contexts(first: 100) {
            nodes { __typename
              ... on CheckRun { name status conclusion completedAt }
              ... on StatusContext { context state createdAt } }
            pageInfo { hasNextPage } } } }
      }
    }
  }
}`
// GraphQL mergeStateStatus values; lowercased they are exactly the REST
// mergeable_state set closeout.js validates, so the mapping is case-folding.
const GRAPHQL_MERGE_STATE = new Set(['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNSTABLE', 'UNKNOWN'])
// CheckRun.status values that mean "not finished". Anything else unmapped
// throws: an unknown terminal state must never read as pending forever.
const RUN_QUEUED = new Set(['QUEUED', 'PENDING', 'REQUESTED', 'WAITING'])
// StatusContext has no run to watch: EXPECTED is queued, PENDING is running,
// and ERROR/FAILURE both mean the status did not pass, so both read as failure.
const MS_LIMIT = 8.64e15

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function prNumber(number) {
  // GraphQL Int is signed 32-bit, not the whole JavaScript safe-integer range.
  return Number.isInteger(number) && number > 0 && number <= 2147483647
}

function normalize(pr, repository, number) {
  requireValue(pr && pr.number === number && pr.baseRepository?.nameWithOwner === repository &&
    pr.url === `https://github.com/${repository}/pull/${number}`, 'GitHub PR identity is incomplete or mismatched')
  requireValue(typeof pr.headRefOid === 'string' && /^[a-f0-9]{40}$/.test(pr.headRefOid) &&
    typeof pr.headRefName === 'string' && pr.headRefName.length > 0, 'GitHub PR head is incomplete')
  requireValue(typeof pr.title === 'string' && pr.title.length > 0 && typeof pr.body === 'string',
    'GitHub PR text is incomplete')
  requireValue(['OPEN', 'CLOSED', 'MERGED'].includes(pr.state) && typeof pr.isDraft === 'boolean' &&
    typeof pr.merged === 'boolean' && pr.merged === (pr.state === 'MERGED'), 'GitHub PR lifecycle is incomplete or inconsistent')
  requireValue(Object.hasOwn(pr, 'reviewDecision') && VERDICTS.has(pr.reviewDecision),
    'GitHub reviewDecision is missing or unknown')
  // A deleted author is an explicit null, not a missing API field. Only Bot
  // actors receive the REST [bot] suffix; a User can never be promoted to Bot.
  let user = null
  if (pr.author !== null) {
    requireValue(pr.author && ['Bot', 'User'].includes(pr.author.__typename) &&
      typeof pr.author.login === 'string' && /^[A-Za-z0-9-]+(?:\[bot\])?$/.test(pr.author.login),
    'GitHub PR author is incomplete')
    const bot = pr.author.__typename === 'Bot'
    requireValue(bot || !pr.author.login.endsWith('[bot]'), 'GitHub PR author type is inconsistent')
    user = { type: bot ? 'Bot' : 'User', login: bot && !pr.author.login.endsWith('[bot]')
      ? `${pr.author.login}[bot]` : pr.author.login }
  }
  return {
    number, html_url: pr.url, title: pr.title, body: pr.body, user,
    state: pr.state === 'OPEN' ? 'open' : 'closed', draft: pr.isDraft, merged: pr.merged,
    head: { ref: pr.headRefName, sha: pr.headRefOid }, base: { repo: { full_name: repository } },
    reviewDecision: pr.reviewDecision,
  }
}

function parseTime(value, message) {
  requireValue(typeof value === 'string', message)
  const ms = Date.parse(value)
  requireValue(Number.isInteger(ms) && ms >= 0 && ms <= MS_LIMIT, message)
  return ms
}

function normalizeCheck(node) {
  requireValue(node && typeof node === 'object', 'GitHub check entry is malformed')
  if (node.__typename === 'CheckRun') {
    requireValue(typeof node.name === 'string' && node.name.length > 0, 'GitHub check run has no name')
    if (node.status === 'COMPLETED') {
      requireValue(typeof node.conclusion === 'string' && node.conclusion.length > 0, 'completed check run has no conclusion')
      // Forward-compat: conclusions pass through lowercased (TIMED_OUT ->
      // timed_out). Unknown ones are closeout's call, which reads them as
      // pending rather than guessing.
      return { name: node.name, status: 'completed', conclusion: node.conclusion.toLowerCase(), completedMs: parseTime(node.completedAt, 'completed check run has no completion time') }
    }
    requireValue(node.status === 'IN_PROGRESS' || RUN_QUEUED.has(node.status), 'GitHub check run status is unknown')
    return { name: node.name, status: node.status === 'IN_PROGRESS' ? 'in_progress' : 'queued' }
  }
  if (node.__typename === 'StatusContext') {
    requireValue(typeof node.context === 'string' && node.context.length > 0, 'GitHub status has no context name')
    if (node.state === 'SUCCESS') return { name: node.context, status: 'completed', conclusion: 'success', completedMs: parseTime(node.createdAt, 'completed status has no creation time') }
    if (node.state === 'ERROR' || node.state === 'FAILURE') return { name: node.context, status: 'completed', conclusion: 'failure', completedMs: parseTime(node.createdAt, 'completed status has no creation time') }
    requireValue(node.state === 'EXPECTED' || node.state === 'PENDING', 'GitHub status state is unknown')
    return { name: node.context, status: node.state === 'PENDING' ? 'in_progress' : 'queued' }
  }
  throw new Error('GitHub check entry type is unknown')
}

function normalizeSnapshot(pr, repository, number, nowMs) {
  requireValue(pr && pr.number === number && pr.baseRepository?.nameWithOwner === repository &&
    pr.url === `https://github.com/${repository}/pull/${number}`, 'GitHub PR identity is incomplete or mismatched')
  requireValue(typeof pr.headRefOid === 'string' && /^[a-f0-9]{40}$/.test(pr.headRefOid) &&
    typeof pr.headRefName === 'string' && pr.headRefName.length > 0, 'GitHub PR head is incomplete')
  requireValue(['OPEN', 'CLOSED', 'MERGED'].includes(pr.state) && typeof pr.isDraft === 'boolean' &&
    typeof pr.merged === 'boolean' && pr.merged === (pr.state === 'MERGED'), 'GitHub PR lifecycle is incomplete or inconsistent')
  requireValue(Object.hasOwn(pr, 'reviewDecision') && VERDICTS.has(pr.reviewDecision),
    'GitHub reviewDecision is missing or unknown')
  // An explicit null is "no auto-merge"; a missing field is a dropped read.
  requireValue(Object.hasOwn(pr, 'autoMergeRequest') &&
    (pr.autoMergeRequest === null || (typeof pr.autoMergeRequest === 'object' && pr.autoMergeRequest !== null)),
  'GitHub auto-merge flag is missing')
  requireValue(typeof pr.baseRefName === 'string' && pr.baseRefName.length > 0, 'GitHub PR base is incomplete')
  requireValue(typeof pr.mergeStateStatus === 'string' && GRAPHQL_MERGE_STATE.has(pr.mergeStateStatus),
    'GitHub merge state is missing or unknown')
  requireValue(pr.labels && Array.isArray(pr.labels.nodes) &&
    pr.labels.nodes.every((l) => typeof l?.name === 'string' && l.name.length > 0) &&
    pr.labels.pageInfo?.hasNextPage === false, 'GitHub PR labels are incomplete or truncated')
  requireValue(pr.commits && Array.isArray(pr.commits.nodes) && pr.commits.nodes.length > 0,
    'GitHub PR commits are missing')
  const head = pr.commits.nodes.find((n) => n?.commit?.oid === pr.headRefOid)
  requireValue(head, 'GitHub head commit is outside the snapshot window; the PR moved during the read')
  const headPushedMs = parseTime(head.commit.pushedDate, 'GitHub head push time is missing or invalid')
  // A null rollup means no checks have ever reported, not a failed read: it
  // becomes an empty set, which closeout reports as missing after its grace
  // period. Inventing entries here would be the silent direction.
  const rollup = head.commit.statusCheckRollup ?? null
  requireValue(rollup === null || (typeof rollup === 'object' &&
    (rollup.contexts === null || rollup.contexts === undefined ||
    (Array.isArray(rollup.contexts?.nodes) && rollup.contexts.pageInfo?.hasNextPage === false))),
  'GitHub check rollup is incomplete or truncated')
  const checks = []
  const seen = new Set()
  for (const node of rollup?.contexts?.nodes ?? []) {
    const check = normalizeCheck(node)
    // One entry per name: the rollup already carries the latest per context.
    // Two entries would make "which one counts" a coin flip on array order.
    requireValue(!seen.has(check.name), 'GitHub check rollup has duplicate check names')
    seen.add(check.name)
    checks.push(check)
  }
  requireValue(Number.isInteger(nowMs) && nowMs >= 0 && nowMs <= MS_LIMIT, 'snapshot clock is invalid')
  requireValue(nowMs >= headPushedMs, 'snapshot clock precedes the head push')
  return {
    repository, number, headSha: pr.headRefOid, baseRef: pr.baseRefName,
    state: pr.state === 'OPEN' ? 'open' : 'closed', merged: pr.merged, draft: pr.isDraft,
    autoMerge: pr.autoMergeRequest !== null,
    labels: pr.labels.nodes.map((l) => l.name),
    mergeableState: pr.mergeStateStatus.toLowerCase(),
    reviewDecision: pr.reviewDecision, headPushedMs, nowMs, checks,
  }
}

// Git ref hygiene for a branch interpolated into a REST path: rejects control
// characters, ref-metacharacters git itself forbids, and `..`, so `.`/`..`
// segments can never walk the path. encodeURIComponent applies on top.
function branchName(branch) {
  return typeof branch === 'string' && branch.length > 0 && branch.length <= 255 &&
    !/[\0-\x1f\x7f ~^:?*\[\\]/.test(branch) && !/(^|\/)\.\.(\/|$)/.test(branch) &&
    !/^[/.]/.test(branch) && !/[/.]$/.test(branch)
}

export function createGithubAdapter({ allowedRepositories, run = execute, maxPages = 100 }) {
  requireValue(Array.isArray(allowedRepositories) && allowedRepositories.length > 0 &&
    allowedRepositories.every((repo) => typeof repo === 'string' && REPOSITORY.test(repo)),
  'an explicit valid GitHub repository allowlist is required')
  requireValue(Number.isInteger(maxPages) && maxPages > 0 && maxPages <= 1000, 'GitHub page budget is invalid')
  const repositories = new Set(allowedRepositories)

  async function query(repository, document, variables = []) {
    requireValue(repositories.has(repository), 'GitHub repository is outside the configured scope')
    const [owner, name] = repository.split('/')
    let result
    try {
      const { stdout } = await run('gh', ['api', '--hostname', 'github.com', 'graphql',
        '-f', `query=${document}`, '-f', `owner=${owner}`, '-f', `name=${name}`, ...variables], {
        encoding: 'utf8', shell: false, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      })
      result = JSON.parse(stdout)
    } catch {
      // Child errors include stdout/stderr (potentially credentials or private
      // response bodies). Do not retain a cause or expose either stream.
      throw new Error('GitHub query failed: transport, timeout, output limit or invalid JSON')
    }
    requireValue(result && typeof result === 'object' && !Array.isArray(result) &&
      (!Object.hasOwn(result, 'errors') || (Array.isArray(result.errors) && result.errors.length === 0)),
    'GitHub query returned errors or an incomplete response')
    const repo = result.data?.repository
    requireValue(repo && repo.nameWithOwner === repository, 'GitHub repository response is incomplete or mismatched')
    return repo
  }

  async function getPullRequest(repository, number) {
    requireValue(prNumber(number), 'GitHub PR number is invalid')
    // Lifecycle, head, issue-binding text, author and aggregate review decision
    // come from one PR query, never independently timed REST + review reads.
    const repo = await query(repository, PR_QUERY, ['-F', `number=${number}`])
    return normalize(repo.pullRequest, repository, number)
  }

  async function getCloseoutSnapshot(repository, number, options = {}) {
    requireValue(prNumber(number), 'GitHub PR number is invalid')
    // One authoritative read per flush (design §5.1). No polling, no retries:
    // a read that cannot complete throws and the caller leaves its cursor
    // unadvanced. nowMs is injectable only so tests can pin the clock.
    const { nowMs = Date.now() } = options ?? {}
    const repo = await query(repository, SNAPSHOT_QUERY, ['-F', `number=${number}`])
    return normalizeSnapshot(repo.pullRequest, repository, number, nowMs)
  }

  async function rest(repository, path) {
    requireValue(repositories.has(repository), 'GitHub repository is outside the configured scope')
    const [owner, name] = repository.split('/')
    let result
    try {
      const { stdout } = await run('gh', ['api', '--hostname', 'github.com', `repos/${owner}/${name}/${path}`], {
        encoding: 'utf8', shell: false, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      })
      result = JSON.parse(stdout)
    } catch {
      // As in query(): child streams may carry credentials or private bodies.
      throw new Error('GitHub request failed: transport, timeout, output limit or invalid JSON')
    }
    requireValue(result && typeof result === 'object' && !Array.isArray(result), 'GitHub response is incomplete')
    return result
  }

  async function getRequiredChecks(repository, branch) {
    requireValue(branchName(branch), 'GitHub branch is invalid')
    // Legacy branch-protection read, one call, no retries. A branch with no
    // protection 404s, which surfaces as a failure here: a ruleset-only repo
    // must never silently read as "no required checks". required_status_checks
    // itself null means protection without named checks, which is truthfully [].
    const protection = await rest(repository, `branches/${encodeURIComponent(branch)}/protection`)
    requireValue(Object.hasOwn(protection, 'required_status_checks'), 'GitHub branch protection is incomplete')
    const required = protection.required_status_checks
    if (required === null) return []
    requireValue(typeof required === 'object' && !Array.isArray(required) &&
      Array.isArray(required.contexts) && Array.isArray(required.checks), 'GitHub required checks are incomplete')
    const names = new Set()
    for (const context of required.contexts) {
      requireValue(typeof context === 'string' && context.length > 0, 'GitHub required check name is invalid')
      names.add(context)
    }
    for (const check of required.checks) {
      requireValue(check && typeof check.context === 'string' && check.context.length > 0, 'GitHub required check name is invalid')
      names.add(check.context)
    }
    // Never filter here: an oddly named required check must reach the policy,
    // which rejects unsafe names loudly, rather than being silently dropped.
    return [...names].sort()
  }

  async function listOpenPullRequests(repository) {
    const references = []
    const seenNumbers = new Set()
    const seenCursors = new Set()
    let after = null
    let total = null
    for (let page = 0; page < maxPages; page++) {
      const repo = await query(repository, OPEN_QUERY, after === null ? [] : ['-f', `after=${after}`])
      const connection = repo.pullRequests
      requireValue(connection && Array.isArray(connection.nodes) && connection.nodes.length <= 100 &&
        Number.isSafeInteger(connection.totalCount) && connection.totalCount >= 0 &&
        typeof connection.pageInfo?.hasNextPage === 'boolean' &&
        (connection.pageInfo.endCursor === null || typeof connection.pageInfo.endCursor === 'string'),
      'GitHub open PR page is incomplete')
      if (total === null) total = connection.totalCount
      requireValue(total === connection.totalCount, 'GitHub open PR set changed during pagination; retry the scan')
      for (const node of connection.nodes) {
        requireValue(prNumber(node?.number) && !seenNumbers.has(node.number), 'GitHub open PR page contains invalid or duplicate identities')
        seenNumbers.add(node.number)
        references.push({ repository, number: node.number })
      }
      requireValue(references.length <= total, 'GitHub open PR count is inconsistent')
      if (!connection.pageInfo.hasNextPage) {
        requireValue(references.length === total, 'GitHub open PR scan is incomplete')
        return references
      }
      const cursor = connection.pageInfo.endCursor
      requireValue(connection.nodes.length > 0 && typeof cursor === 'string' && cursor.length > 0 &&
        !seenCursors.has(cursor), 'GitHub open PR cursor did not advance')
      seenCursors.add(cursor)
      after = cursor
    }
    // Never return a truncated backfill as a completed scan.
    throw new Error('GitHub open PR page budget exceeded; scan is incomplete')
  }

  return { getPullRequest, listOpenPullRequests, getCloseoutSnapshot, getRequiredChecks }
}
