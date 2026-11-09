// Run with --experimental-import-meta-resolve: the parent is the built consumer,
// not this script, the CLI host, NODE_PATH, or a CommonJS resolver.
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectionCounters } from './zod-collection-counter.mjs';

export async function packageIdentity(entry, expectedName) {
  for (let root = dirname(entry); ; root = dirname(root)) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (manifest?.name === expectedName) return { root, manifest };
    assert.notEqual(dirname(root), root, `No ${expectedName} manifest above ${entry}`);
  }
}

export async function inspectConsumer(pluginRoot, candidateRoot) {
  const root = await realpath(pluginRoot);
  const lockRoot = candidateRoot ? await realpath(candidateRoot) : root;
  if (candidateRoot) {
    assert.equal(Number(process.versions.node.split('.')[0]), 24);
    assert(relative(lockRoot, root).startsWith(`consumers/`), 'Candidate artifact must be staged inside its isolated install');
    const policy = JSON.parse(await readFile(join(lockRoot, 'native-policy.json'), 'utf8'));
    assert.equal(policy.nativePolicyProbes.length, 6);
  }
  const worker = await realpath(join(root, 'dist/worker.js'));
  const lock = JSON.parse(await readFile(join(lockRoot, 'package-lock.json'), 'utf8'));
  const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(source.dependencies['@paperclipai/plugin-sdk'], '2026.824.1', 'Held source pin changed');
  const expected = candidateRoot
    ? { '@paperclipai/plugin-sdk': '2026.831.0', '@paperclipai/shared': '2026.831.0', zod: '4.6.7' }
    : { '@paperclipai/plugin-sdk': '2026.824.1', '@paperclipai/shared': '2026.824.1', zod: '3.25.76' };
  const edges = [];
  async function edge(name, parent) {
    const entry = await realpath(fileURLToPath(import.meta.resolve(name, pathToFileURL(parent).href)));
    const identity = await packageIdentity(entry, name);
    const lockPath = relative(lockRoot, identity.root).split('\\').join('/');
    assert(lockPath.startsWith('node_modules/') && !lockPath.split('/').includes('..'), 'Resolution escaped consumer install');
    if (candidateRoot) assert.equal(lockPath, `node_modules/${name}`, 'Candidate must resolve only its reviewed closure');
    assert.equal(identity.manifest.version, expected[name], `Unexpected ${name} consumer version`);
    assert.equal(lock.packages[lockPath]?.version, expected[name], 'Installed version differs from this consumer lock');
    const integrity = lock.packages[lockPath].integrity ?? null;
    // The held Insight lock omits these fields. Record that adverse baseline;
    // do not manufacture provenance or silently relax the other consumer's gate.
    if (!candidateRoot && source.name === '@togetherweown/paperclip-cliproxy-insight') {
      assert.equal(integrity, null, 'Held Insight lock metadata changed; review its provenance separately');
    } else {
      assert.match(integrity ?? '', /^sha512-/, 'Missing registry integrity');
    }
    edges.push({ name, parent: relative(root, parent), entry: relative(root, entry),
      lockPath, version: identity.manifest.version, engines: identity.manifest.engines ?? null,
      integrity });
    return entry;
  }
  const sdk = await edge('@paperclipai/plugin-sdk', worker);
  const shared = await edge('@paperclipai/shared', sdk);
  const sdkZod = await edge('zod', sdk);
  const sharedZod = await edge('zod', shared);
  // Scan every held lock copy, not just the hoisted instances reached above.
  for (const [path, record] of Object.entries(lock.packages)) {
    for (const [name, version] of Object.entries(expected)) {
      if (path.endsWith(`/node_modules/${name}`) || path === `node_modules/${name}`) {
        assert.equal(record.version, version, `Unreviewed held lock copy: ${path}`);
      }
    }
  }
  const manifestModule = await import(pathToFileURL(join(root, 'dist/manifest.js')).href);
  const manifest = manifestModule.default;
  assert.equal(manifest.apiVersion, 1);
  assert(!manifest.capabilities.includes('run.model.resolve'), 'Stock qualification must not enable the opt-in capability');
  const { pluginManifestV1Schema } = await import(pathToFileURL(shared).href);
  const parsed = pluginManifestV1Schema.safeParse(manifest);
  assert(parsed.success, `Actual shared manifest validator refused built manifest: ${JSON.stringify(parsed.error?.issues)}`);
  if (manifestModule.buildManifest) {
    const optIn = manifestModule.buildManifest(true);
    assert(optIn.capabilities.includes('run.model.resolve'));
    assert.equal(pluginManifestV1Schema.safeParse(optIn).success, false, 'Resolved shared schema unexpectedly accepts the opt-in fork capability');
  }
  const counters = [];
  for (const entry of new Set([sdkZod, sharedZod])) {
    const { z } = await import(pathToFileURL(entry).href);
    counters.push({ entry: relative(root, entry), version: expected.zod,
      results: await collectionCounters(z, candidateRoot ? 0 : 3) });
  }
  return { root, worker, manifest, sdk, report: { plugin: source.name, node: process.versions.node,
    buildTarget: 'node22 (unchanged)', sourceEngine: source.engines.node, edges, counters,
    lockIntegrityFieldsComplete: edges.every(({ integrity }) => integrity !== null),
    manifestValidated: true, stockHostQualified: false, migrationQualified: false,
    candidate: { sdk: '2026.831.0', shared: '2026.831.0', zod: '4.6.7',
      node22DropIn: false, requiredNode: '>=24.11.0', installed: Boolean(candidateRoot),
      boundary: candidateRoot ? 'Byte-identical held build staged against isolated candidate runtime; no candidate typecheck or source migration'
        : 'Held consumer baseline; candidate not installed in this consumer' } } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3, 'Usage: node --experimental-import-meta-resolve consumer.mjs <plugin-root>');
  const { report } = await inspectConsumer(process.argv[2]);
  console.log(JSON.stringify(report, null, 2));
}
