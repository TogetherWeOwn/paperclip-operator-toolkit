#!/usr/bin/env node
// Task-specific, one-shot gate for external disclosures (TOG-576).
//
// This tool does not mint credentials and never treats possession of one as
// authority. It reads the bearer from EXTERNAL_DISCLOSURE_TOKEN, proves the
// credential's runtime principal and destination access with read-only calls,
// separately proves exact equality with an immutable approval grant, claims the
// grant once, and only then sends the approved artifact bytes.

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const TOKEN_ENV = 'EXTERNAL_DISCLOSURE_TOKEN'
const TRUST_STORE = path.join(__dirname, 'external_disclosure_authorizers.json')
const LEVEL = { read: 1, write: 2, admin: 3 }

function die(message, code = 1) {
  process.stderr.write(`external-disclosure: ${message}\n`)
  process.exit(code)
}

function help() {
  process.stdout.write([
    'external_disclosure.js - task-specific external mutation gate',
    '',
    '  preflight --grant FILE --runtime FILE',
    '  submit    --grant FILE --runtime FILE --state-dir DIR',
    '  help',
    '',
    `The bearer credential is read only from ${TOKEN_ENV}; never put it on argv.`,
    'The runtime file names artifact files and credential metadata, but never embeds',
    'the private artifact body. submit writes <grant-sha256>.claim.json and',
    '<grant-sha256>.receipt.json beneath the state directory.',
    '',
  ].join('\n'))
}

function argsFor(mode) {
  const allowed = mode === 'submit'
    ? new Set(['--grant', '--runtime', '--state-dir'])
    : new Set(['--grant', '--runtime'])
  const out = {}
  for (let i = 3; i < process.argv.length; i += 2) {
    const key = process.argv[i]
    const value = process.argv[i + 1]
    if (!allowed.has(key)) die(`unknown option "${key || ''}"`, 2)
    if (!value || value.startsWith('--')) die(`${key} requires a value`, 2)
    if (Object.hasOwn(out, key)) die(`${key} was supplied twice`, 2)
    out[key] = value
  }
  for (const required of ['--grant', '--runtime']) {
    if (!out[required]) die(`${required} is required`, 2)
  }
  if (mode === 'submit' && !out['--state-dir']) die('--state-dir is required for one-shot consumption', 2)
  return out
}

function readJson(file, label) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    die(`could not read ${label}: ${error.code || error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    die(`${label} is not valid JSON`)
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) die(`${label} must be an object`)
}

function exactKeys(value, keys, label) {
  assertObject(value, label)
  const expected = [...keys].sort()
  const actual = Object.keys(value).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    die(`${label} keys must be exactly: ${expected.join(', ')}; got: ${actual.join(', ') || '(none)'}`)
  }
}

function nonempty(value, label) {
  if (typeof value !== 'string' || !value.trim()) die(`${label} must be a non-empty string`)
  return value.trim()
}

function iso(value, label) {
  nonempty(value, label)
  const millis = Date.parse(value)
  if (!Number.isFinite(millis)) die(`${label} must be an ISO timestamp`)
  return new Date(millis).toISOString()
}

function sha(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) return false
  return true
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function fileSha256(file, label) {
  try {
    return sha256(fs.readFileSync(file))
  } catch (error) {
    die(`could not read ${label}: ${error.code || error.message}`)
  }
}

function same(a, b) {
  return canonical(a) === canonical(b)
}

function unsignedGrant(grant) {
  const { signature, ...payload } = grant
  return payload
}

function readTrustStore() {
  const value = readJson(TRUST_STORE, 'external-disclosure authorizer trust store')
  exactKeys(value, ['version', 'keys'], 'external-disclosure authorizer trust store')
  if (value.version !== 1) die('external-disclosure authorizer trust store.version must be 1')
  if (!Array.isArray(value.keys)) die('external-disclosure authorizer trust store.keys must be an array')
  const keys = new Map()
  value.keys.forEach((entry, index) => {
    exactKeys(entry, ['keyId', 'algorithm', 'authorizingPrincipal', 'publicKeyPem'], `authorizer key[${index}]`)
    if (entry.algorithm !== 'ed25519') die(`authorizer key[${index}].algorithm must be ed25519`)
    exactKeys(entry.authorizingPrincipal, ['principalClass', 'principalId'], `authorizer key[${index}].authorizingPrincipal`)
    const keyId = nonempty(entry.keyId, `authorizer key[${index}].keyId`)
    if (keys.has(keyId)) die(`authorizer trust store contains duplicate keyId "${keyId}"`)
    const authorizingPrincipal = {
      principalClass: nonempty(entry.authorizingPrincipal.principalClass, `authorizer key[${index}].authorizingPrincipal.principalClass`),
      principalId: nonempty(entry.authorizingPrincipal.principalId, `authorizer key[${index}].authorizingPrincipal.principalId`),
    }
    const publicKeyPem = nonempty(entry.publicKeyPem, `authorizer key[${index}].publicKeyPem`)
    try {
      const key = crypto.createPublicKey(publicKeyPem)
      if (key.asymmetricKeyType !== 'ed25519') die(`authorizer key[${index}].publicKeyPem is not an Ed25519 key`)
    } catch (error) {
      die(`authorizer key[${index}].publicKeyPem is invalid: ${error.message}`)
    }
    keys.set(keyId, { authorizingPrincipal, publicKeyPem })
  })
  return keys
}

function verifyGrantSignature(grant) {
  const key = readTrustStore().get(grant.signature.keyId)
  if (!key) die(`grant signature keyId "${grant.signature.keyId}" is not trusted`)
  if (!same(key.authorizingPrincipal, grant.authorizingPrincipal)) {
    die('grant authorizingPrincipal does not equal the principal bound to its trusted signing key')
  }
  let signature
  try {
    signature = Buffer.from(grant.signature.value, 'base64')
  } catch {
    die('grant.signature.value is not valid base64')
  }
  if (signature.length !== 64) die('grant.signature.value is not an Ed25519 signature')
  if (signature.toString('base64') !== grant.signature.value) {
    die('grant.signature.value must use canonical padded base64 encoding')
  }
  const message = Buffer.from(canonical(unsignedGrant(grant)))
  let ok = false
  try {
    ok = crypto.verify(null, message, key.publicKeyPem, signature)
  } catch (error) {
    die(`could not verify grant signature: ${error.message}`)
  }
  if (!ok) die('grant signature is invalid; grant content is not an approved immutable object')
}

function validateDestination(value, label) {
  exactKeys(value, ['provider', 'apiOrigin', 'repository', 'endpoint'], label)
  if (value.provider !== 'github') die(`${label}.provider must be "github"`)
  const origin = nonempty(value.apiOrigin, `${label}.apiOrigin`).replace(/\/+$/, '')
  let url
  try {
    url = new URL(origin)
  } catch {
    die(`${label}.apiOrigin is not a URL`)
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    die(`${label}.apiOrigin must use https (http is accepted only on loopback for offline tests)`)
  }
  if (url.pathname !== '/' || url.search || url.hash) die(`${label}.apiOrigin must be an origin with no path/query/fragment`)
  const repository = nonempty(value.repository, `${label}.repository`)
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) die(`${label}.repository must be owner/name`)
  const endpoint = nonempty(value.endpoint, `${label}.endpoint`)
  if (!endpoint.startsWith('/') || endpoint.includes('?') || endpoint.includes('#')) {
    die(`${label}.endpoint must be an absolute API path without query or fragment`)
  }
  const repositoryPrefix = `/repos/${repository}`
  if (endpoint !== repositoryPrefix && !endpoint.startsWith(`${repositoryPrefix}/`)) {
    die(`${label}.endpoint must be beneath the named repository (${repositoryPrefix}/...)`)
  }
  return { provider: 'github', apiOrigin: origin, repository, endpoint }
}

function validatePrincipal(value, label) {
  exactKeys(value, ['principalClass', 'credentialClass', 'principalId'], label)
  if (!['human', 'github_app'].includes(value.principalClass)) {
    die(`${label}.principalClass must be human or github_app`)
  }
  const expectedCredential = value.principalClass === 'human'
    ? 'github_user_token'
    : 'github_app_installation_token'
  if (value.credentialClass !== expectedCredential) {
    die(`${label}.credentialClass must be ${expectedCredential} for ${value.principalClass}`)
  }
  return {
    principalClass: value.principalClass,
    credentialClass: value.credentialClass,
    principalId: nonempty(value.principalId, `${label}.principalId`),
  }
}

function validatePermissionMap(value, label) {
  assertObject(value, label)
  const out = {}
  for (const [name, level] of Object.entries(value)) {
    nonempty(name, `${label} permission name`)
    if (!Object.hasOwn(LEVEL, level)) die(`${label}.${name} must be read, write, or admin`)
    out[name] = level
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

function validateGrant(value) {
  exactKeys(value, [
    'version', 'destination', 'channel', 'action', 'artifacts',
    'authenticatingPrincipal', 'authorizingPrincipal', 'approvalRecord',
    'approvedAt', 'expiresAt', 'allowedIssueId', 'allowedRunId',
    'requiredPermissions', 'signature',
  ], 'grant')
  if (value.version !== 1) die('grant.version must be 1')
  const destination = validateDestination(value.destination, 'grant.destination')
  const channel = nonempty(value.channel, 'grant.channel')
  const action = nonempty(value.action, 'grant.action').toUpperCase()
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(action)) die('grant.action must be POST, PUT, PATCH, or DELETE')
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) die('grant.artifacts must be a non-empty array')
  const artifactIds = new Set()
  const artifacts = value.artifacts.map((artifact, index) => {
    exactKeys(artifact, ['id', 'sha256'], `grant.artifacts[${index}]`)
    const id = nonempty(artifact.id, `grant.artifacts[${index}].id`)
    if (artifactIds.has(id)) die(`grant.artifacts contains duplicate id "${id}"`)
    artifactIds.add(id)
    if (!sha(artifact.sha256)) die(`grant.artifacts[${index}].sha256 must be 64 lowercase hex characters`)
    return { id, sha256: artifact.sha256 }
  }).sort((a, b) => a.id.localeCompare(b.id))
  const authenticatingPrincipal = validatePrincipal(value.authenticatingPrincipal, 'grant.authenticatingPrincipal')
  exactKeys(value.authorizingPrincipal, ['principalClass', 'principalId'], 'grant.authorizingPrincipal')
  const authorizingPrincipal = {
    principalClass: nonempty(value.authorizingPrincipal.principalClass, 'grant.authorizingPrincipal.principalClass'),
    principalId: nonempty(value.authorizingPrincipal.principalId, 'grant.authorizingPrincipal.principalId'),
  }
  exactKeys(value.approvalRecord, ['id', 'source', 'sha256'], 'grant.approvalRecord')
  if (!sha(value.approvalRecord.sha256)) die('grant.approvalRecord.sha256 must be 64 lowercase hex characters')
  const approvalRecord = {
    id: nonempty(value.approvalRecord.id, 'grant.approvalRecord.id'),
    source: nonempty(value.approvalRecord.source, 'grant.approvalRecord.source'),
    sha256: value.approvalRecord.sha256,
  }
  exactKeys(value.signature, ['algorithm', 'keyId', 'value'], 'grant.signature')
  if (value.signature.algorithm !== 'ed25519') die('grant.signature.algorithm must be ed25519')
  const signature = {
    algorithm: 'ed25519',
    keyId: nonempty(value.signature.keyId, 'grant.signature.keyId'),
    value: nonempty(value.signature.value, 'grant.signature.value'),
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature.value)) die('grant.signature.value must be base64')
  const approvedAt = iso(value.approvedAt, 'grant.approvedAt')
  const expiresAt = iso(value.expiresAt, 'grant.expiresAt')
  if (Date.parse(expiresAt) <= Date.parse(approvedAt)) die('grant.expiresAt must be after grant.approvedAt')
  return {
    version: 1,
    destination,
    channel,
    action,
    artifacts,
    authenticatingPrincipal,
    authorizingPrincipal,
    approvalRecord,
    approvedAt,
    expiresAt,
    allowedIssueId: nonempty(value.allowedIssueId, 'grant.allowedIssueId'),
    allowedRunId: nonempty(value.allowedRunId, 'grant.allowedRunId'),
    requiredPermissions: validatePermissionMap(value.requiredPermissions, 'grant.requiredPermissions'),
    signature,
  }
}

function validateRuntime(value) {
  exactKeys(value, [
    'version', 'destination', 'channel', 'action', 'artifacts', 'principal',
    'approvalRecordPath', 'credentialMetadataPath', 'issueId', 'runId', 'sessionId',
  ], 'runtime')
  if (value.version !== 1) die('runtime.version must be 1')
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) die('runtime.artifacts must be a non-empty array')
  const ids = new Set()
  const artifacts = value.artifacts.map((artifact, index) => {
    exactKeys(artifact, ['id', 'path'], `runtime.artifacts[${index}]`)
    const id = nonempty(artifact.id, `runtime.artifacts[${index}].id`)
    if (ids.has(id)) die(`runtime.artifacts contains duplicate id "${id}"`)
    ids.add(id)
    return { id, path: nonempty(artifact.path, `runtime.artifacts[${index}].path`) }
  }).sort((a, b) => a.id.localeCompare(b.id))
  return {
    version: 1,
    destination: validateDestination(value.destination, 'runtime.destination'),
    channel: nonempty(value.channel, 'runtime.channel'),
    action: nonempty(value.action, 'runtime.action').toUpperCase(),
    artifacts,
    principal: validatePrincipal(value.principal, 'runtime.principal'),
    approvalRecordPath: nonempty(value.approvalRecordPath, 'runtime.approvalRecordPath'),
    credentialMetadataPath: nonempty(value.credentialMetadataPath, 'runtime.credentialMetadataPath'),
    issueId: nonempty(value.issueId, 'runtime.issueId'),
    runId: nonempty(value.runId, 'runtime.runId'),
    sessionId: nonempty(value.sessionId, 'runtime.sessionId'),
  }
}

function validateCredentialMetadata(value, principalClass) {
  exactKeys(value, [
    'tokenIssuedAt', 'tokenExpiresAt', 'installationId', 'repositorySelection',
    'repositories', 'effectivePermissions',
  ], 'credential metadata')
  const tokenIssuedAt = iso(value.tokenIssuedAt, 'credential metadata.tokenIssuedAt')
  const tokenExpiresAt = iso(value.tokenExpiresAt, 'credential metadata.tokenExpiresAt')
  if (Date.parse(tokenExpiresAt) <= Date.parse(tokenIssuedAt)) {
    die('credential metadata.tokenExpiresAt must be after tokenIssuedAt')
  }
  if (principalClass === 'github_app' && (typeof value.installationId !== 'string' && typeof value.installationId !== 'number')) {
    die('credential metadata.installationId is required for a GitHub App token')
  }
  if (principalClass === 'human' && value.installationId !== null) {
    die('credential metadata.installationId must be null for a human token')
  }
  if (principalClass === 'github_app' && !['selected', 'all'].includes(value.repositorySelection)) {
    die('credential metadata.repositorySelection must be selected or all for a GitHub App token')
  }
  if (principalClass === 'human' && value.repositorySelection !== null) {
    die('credential metadata.repositorySelection must be null for a human token')
  }
  if (!Array.isArray(value.repositories) || value.repositories.some((item) => typeof item !== 'string' || !item.trim())) {
    die('credential metadata.repositories must be an array of repository names')
  }
  return {
    tokenIssuedAt,
    tokenExpiresAt,
    installationId: value.installationId === null ? null : String(value.installationId),
    repositorySelection: value.repositorySelection,
    repositories: [...new Set(value.repositories.map((item) => item.trim()))].sort(),
    effectivePermissions: validatePermissionMap(value.effectivePermissions, 'credential metadata.effectivePermissions'),
  }
}

function computeArtifacts(runtime) {
  return runtime.artifacts.map((artifact) => {
    let body
    try {
      // One read is load-bearing. The same immutable bytes are hashed, authorized,
      // sent, and named in the receipt; reopening the path after async capability
      // probes would permit a hash-then-replace substitution.
      body = fs.readFileSync(artifact.path)
    } catch (error) {
      die(`could not read artifact "${artifact.id}": ${error.code || error.message}`)
    }
    return {
      id: artifact.id,
      path: artifact.path,
      body,
      sha256: sha256(body),
    }
  }).sort((a, b) => a.id.localeCompare(b.id))
}

async function fetchJson(url, token) {
  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'paperclip-external-disclosure/1',
      },
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    die(`capability probe could not reach ${new URL(url).pathname}: ${error.name || 'network error'}`)
  }
  let body = null
  try {
    body = JSON.parse(await response.text())
  } catch {
    body = null
  }
  return { status: response.status, ok: response.ok, body }
}

async function proveCapability(grant, runtime, metadata, token, now) {
  if (now < Date.parse(metadata.tokenIssuedAt) || now >= Date.parse(metadata.tokenExpiresAt)) {
    die('capability refused: credential is not inside its recorded issue/expiry window')
  }
  const required = grant.requiredPermissions
  for (const [name, level] of Object.entries(required)) {
    const actual = metadata.effectivePermissions[name]
    if (!actual || LEVEL[actual] < LEVEL[level]) {
      die(`capability refused: effective permission ${name}=${actual || 'none'} is below required ${level}`)
    }
  }

  const origin = grant.destination.apiOrigin
  const installation = await fetchJson(`${origin}/installation`, token)
  let observed
  if (installation.ok) {
    const installationId = installation.body?.id === undefined ? null : String(installation.body.id)
    const appSlug = installation.body?.app_slug
    if (!installationId || !appSlug) die('capability probe returned an incomplete GitHub installation identity')
    observed = {
      principalClass: 'github_app',
      credentialClass: 'github_app_installation_token',
      principalId: `github-app:${appSlug}`,
      installationId,
    }
  } else {
    const user = await fetchJson(`${origin}/user`, token)
    if (!user.ok || !user.body?.login) {
      die(`capability refused: credential is neither a readable installation token nor a readable human token (installation ${installation.status}, user ${user.status})`)
    }
    observed = {
      principalClass: 'human',
      credentialClass: 'github_user_token',
      principalId: `github-user:${user.body.login}`,
      installationId: null,
    }
  }

  if (!same(observed.principalClass, runtime.principal.principalClass) ||
      !same(observed.credentialClass, runtime.principal.credentialClass) ||
      observed.principalId !== runtime.principal.principalId) {
    die(`capability refused: probed principal ${observed.principalClass}/${observed.credentialClass}/${observed.principalId} does not equal runtime principal`)
  }
  if (observed.installationId !== metadata.installationId) {
    die('capability refused: probed installation ID does not equal credential metadata')
  }

  const repository = await fetchJson(`${origin}/repos/${grant.destination.repository.split('/').map(encodeURIComponent).join('/')}`, token)
  if (!repository.ok) die(`capability refused: destination repository probe returned HTTP ${repository.status}`)
  const observedRepo = repository.body?.full_name
  if (observedRepo && observedRepo.toLowerCase() !== grant.destination.repository.toLowerCase()) {
    die(`capability refused: repository probe returned ${observedRepo}, not ${grant.destination.repository}`)
  }
  const repoName = grant.destination.repository.split('/')[1]
  const metadataHasRepo = metadata.repositories.some((item) =>
    item.toLowerCase() === repoName.toLowerCase() || item.toLowerCase() === grant.destination.repository.toLowerCase())
  if (!metadataHasRepo) die('capability refused: credential metadata does not include the destination repository')

  return {
    ok: true,
    destinationAccessible: true,
    observedPrincipal: observed,
    tokenIssuedAt: metadata.tokenIssuedAt,
    tokenExpiresAt: metadata.tokenExpiresAt,
    installationId: metadata.installationId,
    repositorySelection: metadata.repositorySelection,
    repositories: metadata.repositories,
    effectivePermissions: metadata.effectivePermissions,
  }
}

function proveAuthority(grant, runtime, artifacts, approvalHash, now) {
  if (now < Date.parse(grant.approvedAt) || now >= Date.parse(grant.expiresAt)) {
    die('authority refused: grant is not inside its approval/expiry window')
  }
  const comparisons = [
    ['destination', grant.destination, runtime.destination],
    ['channel', grant.channel, runtime.channel],
    ['action', grant.action, runtime.action],
    ['authenticating principal', grant.authenticatingPrincipal, runtime.principal],
    ['issue ID', grant.allowedIssueId, runtime.issueId],
    ['run ID', grant.allowedRunId, runtime.runId],
    ['artifact set', grant.artifacts, artifacts.map(({ id, sha256 }) => ({ id, sha256 }))],
    ['approval record hash', grant.approvalRecord.sha256, approvalHash],
  ]
  for (const [label, expected, actual] of comparisons) {
    if (!same(expected, actual)) die(`authority refused: runtime ${label} does not equal the immutable grant`)
  }
  return {
    ok: true,
    approvalId: grant.approvalRecord.id,
    approvalRecord: grant.approvalRecord,
    approvedAt: grant.approvedAt,
    expiresAt: grant.expiresAt,
    allowedIssueId: grant.allowedIssueId,
    allowedRunId: grant.allowedRunId,
    authorizingPrincipal: grant.authorizingPrincipal,
    artifactHashes: grant.artifacts,
  }
}

async function preflight(grantPath, runtimePath) {
  const rawGrant = readJson(grantPath, 'grant')
  const rawRuntime = readJson(runtimePath, 'runtime')
  const grant = validateGrant(rawGrant)
  verifyGrantSignature(grant)
  const runtime = validateRuntime(rawRuntime)
  const metadata = validateCredentialMetadata(
    readJson(runtime.credentialMetadataPath, 'credential metadata'),
    runtime.principal.principalClass,
  )
  const token = process.env[TOKEN_ENV]
  if (!token) die(`${TOKEN_ENV} is not set; capability cannot be proved anonymously`)
  const artifacts = computeArtifacts(runtime)
  const approvalHash = fileSha256(runtime.approvalRecordPath, 'approval record')
  const now = Date.now()
  const capability = await proveCapability(grant, runtime, metadata, token, now)
  const authority = proveAuthority(grant, runtime, artifacts, approvalHash, now)
  return {
    grant,
    runtime,
    metadata,
    artifacts,
    token,
    // Replay identity is the signed authorization + trusted key identity, never
    // the textual signature representation. Even if a decoder ever accepts two
    // spellings of one signature, they must resolve to the same one-shot grant.
    grantId: sha256(canonical({
      keyId: grant.signature.keyId,
      authorization: unsignedGrant(grant),
    })),
    report: {
      preflightVersion: 1,
      capability,
      authority,
      mutation: {
        destination: grant.destination,
        channel: grant.channel,
        action: grant.action,
        principal: runtime.principal,
        artifacts: grant.artifacts,
        approvalId: grant.approvalRecord.id,
      },
    },
  }
}

function prepareStateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) die('state directory must be a real directory, not a symlink')
  fs.chmodSync(dir, 0o700)
}

function claimGrant(stateDir, result) {
  prepareStateDir(stateDir)
  const claimPath = path.join(stateDir, `${result.grantId}.claim.json`)
  const receiptPath = path.join(stateDir, `${result.grantId}.receipt.json`)
  if (fs.existsSync(receiptPath)) die(`grant ${result.grantId} has already produced a receipt; replay refused`)
  const claim = {
    version: 1,
    grantId: result.grantId,
    approvalId: result.grant.approvalRecord.id,
    issueId: result.runtime.issueId,
    runId: result.runtime.runId,
    sessionId: result.runtime.sessionId,
    claimedAt: new Date().toISOString(),
  }
  try {
    fs.writeFileSync(claimPath, `${JSON.stringify(claim, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code === 'EEXIST') die(`grant ${result.grantId} has already been claimed; replay refused`)
    die(`could not claim grant: ${error.code || error.message}`)
  }
  return { claim, claimPath, receiptPath }
}

function responseIdentifier(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  for (const key of ['ghsa_id', 'id', 'number', 'html_url', 'url']) {
    const value = body[key]
    if (typeof value === 'string' || typeof value === 'number') return { field: key, value: String(value) }
  }
  return null
}

async function mutateOne(result, artifact) {
  let response
  try {
    response = await fetch(`${result.grant.destination.apiOrigin}${result.grant.destination.endpoint}`, {
      method: result.grant.action,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${result.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'paperclip-external-disclosure/1',
      },
      body: artifact.body,
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    return {
      id: artifact.id,
      artifactSha256: artifact.sha256,
      responseStatus: null,
      responseIdentifier: null,
      outcome: 'network_error',
      errorClass: error.name || 'Error',
    }
  }
  let parsed = null
  try {
    parsed = JSON.parse(await response.text())
  } catch {
    parsed = null
  }
  return {
    id: artifact.id,
    artifactSha256: artifact.sha256,
    responseStatus: response.status,
    responseIdentifier: responseIdentifier(parsed),
    outcome: response.ok ? 'accepted' : 'rejected',
  }
}

function writeReceipt(receiptPath, receipt) {
  try {
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    die(`mutation was claimed but receipt could not be written: ${error.code || error.message}`)
  }
}

async function submit(result, stateDir) {
  // This is intentionally the final stdout before the external write. It contains
  // no token and no artifact body; it is the exact capability/authority render an
  // operator can retain next to the redacted receipt.
  process.stdout.write(`${JSON.stringify(result.report)}\n`)
  const { claim, receiptPath } = claimGrant(stateDir, result)
  const entries = []
  for (const artifact of result.artifacts) {
    const entry = await mutateOne(result, artifact)
    entries.push(entry)
    if (entry.outcome !== 'accepted') break
  }
  const success = entries.length === result.artifacts.length && entries.every((entry) => entry.outcome === 'accepted')
  const receipt = {
    version: 1,
    grantId: result.grantId,
    approvalId: result.grant.approvalRecord.id,
    approvalRecordSha256: result.grant.approvalRecord.sha256,
    approvedAt: result.grant.approvedAt,
    claimedAt: claim.claimedAt,
    completedAt: new Date().toISOString(),
    destination: result.grant.destination,
    channel: result.grant.channel,
    action: result.grant.action,
    issueId: result.runtime.issueId,
    runId: result.runtime.runId,
    sessionId: result.runtime.sessionId,
    authenticatingPrincipal: result.runtime.principal,
    authorizingPrincipal: result.grant.authorizingPrincipal,
    tokenIssuedAt: result.metadata.tokenIssuedAt,
    tokenExpiresAt: result.metadata.tokenExpiresAt,
    installationId: result.metadata.installationId,
    repositorySelection: result.metadata.repositorySelection,
    repositories: result.metadata.repositories,
    effectivePermissions: result.metadata.effectivePermissions,
    artifacts: entries,
    success,
  }
  writeReceipt(receiptPath, receipt)
  process.stdout.write(`${JSON.stringify({ receipt: receiptPath, grantId: result.grantId, success })}\n`)
  if (!success) process.exitCode = 1
}

async function main() {
  const mode = process.argv[2]
  if (mode === 'help' || mode === '--help' || mode === '-h') return help()
  if (!['preflight', 'submit'].includes(mode)) {
    die(`unknown command "${mode || ''}"; expected preflight, submit, or help`, 2)
  }
  const args = argsFor(mode)
  const result = await preflight(args['--grant'], args['--runtime'])
  if (mode === 'preflight') {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`)
    return
  }
  await submit(result, args['--state-dir'])
}

main().catch((error) => die(error && error.stack ? error.stack : String(error)))
