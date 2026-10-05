// Synthetic TRUSTED test inputs. These wrappers keep original behavior tests
// readable while passing explicit policy at every production boundary. Never
// import this fixture from production, and never derive policy from a payload.
import * as bridge from '../src/bridge.js'
import * as index from '../src/pr-task-index.js'
import { createApp as app } from '../src/app.js'
import { createConsumer as consumer } from '../src/consumer.js'
import { createCaptureAdapter as capture } from '../src/capture-adapter.js'
import { createPaperclipAdapter as board } from '../src/paperclip-adapter.js'
import { receiptNamespace as namespace } from '../src/receipt-cycle.js'
import { runProductPass as pass } from '../src/consumer-runner.js'
import { parseBridgeQuery as query } from '../src/query.js'

export const TEST_POLICY = Object.freeze({ trackerPrefix: 'TASK', agentLogin: 'capture-agent[bot]' })
export const TEST_REPOSITORIES = Object.freeze(['example-owner/project', 'example-owner/z-other', 'example-owner/new-repo'])
export const AGENT_LOGIN = TEST_POLICY.agentLogin
export const visibilityFor = repositories => Object.fromEntries(repositories.map(repository => [repository, true]))
export const trustedConfig = config => ({ bridgePolicy: TEST_POLICY,
  repositoryVisibility: visibilityFor(config.allowedRepositories), ...config })

export const extractIssueRef = (text, policy = TEST_POLICY) => bridge.extractIssueRef(text, policy)
export const classifyPullRequestEvent = (payload, policy = TEST_POLICY) => bridge.classifyPullRequestEvent(payload, policy)
export const classifyCheckSuiteEvent = (payload, evidence = [], policy = TEST_POLICY) => bridge.classifyCheckSuiteEvent(payload, evidence, policy)
export const claimKey = bridge.claimKey
export const extractRefsTrailer = (text, policy = TEST_POLICY) => index.extractRefsTrailer(text, policy)
export const buildPrTaskIndex = (entries, policy = TEST_POLICY) => index.buildPrTaskIndex(entries, policy)
export const resolvePrTask = options => index.resolvePrTask({ bridgePolicy: TEST_POLICY, isPrivate: true, ...options })
export const createApp = options => app({ bridgePolicy: TEST_POLICY, allowedRepositories: TEST_REPOSITORIES, ...options })
export const createConsumer = options => consumer({ bridgePolicy: TEST_POLICY, mode: 'full-v1',
  isPrivateRepository: repository => Object.hasOwn(visibilityFor(options.allowedRepositories), repository) ? true : undefined,
  ...options })
export const createCaptureAdapter = options => capture({ bridgePolicy: TEST_POLICY, ...options })
export const createPaperclipAdapter = options => board({ bridgePolicy: TEST_POLICY, ...options })
export const receiptNamespace = config => namespace(trustedConfig(config))
export const runProductPass = (input, dependencies) => pass({ ...input, config: trustedConfig(input.config) }, dependencies)
export const parseBridgeQuery = (params, policy = TEST_POLICY) => query(params, policy)
export { runReceiptCycle, deliveryFingerprint } from '../src/receipt-cycle.js'
export { executeGithub, runnerLimits, createPassBudget } from '../src/consumer-runner.js'
export { parseQuery, MAX_LIMIT, DEFAULT_LIMIT, nextCursor } from '../src/query.js'
