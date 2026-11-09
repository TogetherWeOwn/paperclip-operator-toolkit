// Synthetic candidate consumer only, not either built plugin or stock services.
import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packageIdentity } from './consumer.mjs';
import { collectionCounters } from './zod-collection-counter.mjs';

assert.equal(process.argv.length, 3);
assert.equal(Number(process.versions.node.split('.')[0]), 24);
const root = await realpath(resolve(process.argv[2]));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const policy = JSON.parse(await readFile(join(root, 'native-policy.json'), 'utf8'));
assert.equal(policy.nativePolicyProbes.length, 6, 'Native policy probe must complete before candidate execution');
const expected = { '@paperclipai/plugin-sdk': '2026.831.0', '@paperclipai/shared': '2026.831.0', zod: '4.6.7' };
const edges = [];
async function edge(name, parent) {
  const entry = await realpath(fileURLToPath(import.meta.resolve(name, pathToFileURL(parent).href)));
  const identity = await packageIdentity(entry, name);
  const path = relative(root, identity.root).split('\\').join('/');
  assert.equal(path, `node_modules/${name}`, 'Synthetic candidate must not resolve from host or another install');
  assert.equal(identity.manifest.version, expected[name]);
  assert.equal(lock.packages[path].version, expected[name]);
  edges.push({ name, parent: relative(root, parent), entry: relative(root, entry), version: identity.manifest.version,
    integrity: lock.packages[path].integrity, engines: identity.manifest.engines ?? null });
  return entry;
}
const sdk = await edge('@paperclipai/plugin-sdk', join(root, 'synthetic-consumer.mjs'));
const shared = await edge('@paperclipai/shared', sdk);
const sdkZod = await edge('zod', sdk);
const sharedZod = await edge('zod', shared);
const sdkModule = await import(pathToFileURL(sdk).href);
assert.equal(typeof sdkModule.definePlugin, 'function');
assert.equal(typeof sdkModule.runWorker, 'function');
const sharedModule = await import(pathToFileURL(shared).href);
assert.equal(typeof sharedModule.pluginManifestV1Schema.safeParse, 'function');
const counters = [];
for (const entry of new Set([sdkZod, sharedZod])) {
  const { z } = await import(pathToFileURL(entry).href);
  counters.push({ entry: relative(root, entry), results: await collectionCounters(z, 0) });
}
const report = { boundary: 'Isolated synthetic candidate consumer; NOT a built plugin, stock caller or release qualification',
  node: process.versions.node, npm: policy.npm, edges, counters, installed: true,
  build: 'Published JavaScript imports only; no package build hooks needed or run',
  realPluginCompatibility: 'pending', stockHostQualified: false, migrationQualified: false };
await writeFile(join(root, 'candidate-contract.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
