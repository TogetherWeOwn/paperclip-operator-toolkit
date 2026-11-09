// Metadata/lock preparation only. Never import or install a downloaded package.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

assert.equal(process.argv.length, 4, 'Usage: prepare-candidate.mjs <inventory|lock> <candidate-root>');
const [mode, directory] = process.argv.slice(2);
assert(['inventory', 'lock'].includes(mode));
const root = resolve(directory);
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const source = await readJson(join(root, 'package.json'));
const expected = { '@paperclipai/plugin-sdk': '2026.831.0', '@paperclipai/shared': '2026.831.0', zod: '4.6.7' };
assert.deepEqual(source.dependencies, expected);
assert.deepEqual(source.scripts, {});
assert.equal(source.private, true);
assert.equal(source.engines.node, '>=24.11.0');
assert.equal(source.packageManager, 'npm@11.19.1');
assert.equal(execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(), '11.19.1');
const config = JSON.parse(execFileSync('npm', ['config', 'list', '--json'], { cwd: root, encoding: 'utf8' }));
assert.equal(config['min-release-age'], 3);
assert.equal(config['ignore-scripts'], true);
assert.equal(config['engine-strict'], true);
assert.deepEqual(config.omit, ['optional']);
for (const [key, value] of Object.entries(config)) {
  if (/min-release-age.*exclude/.test(key)) assert(!value || value.length === 0, 'No age exemptions permitted');
}
// Lock-only resolution must not materialize an SDK, even on a failed prior step.
await assert.rejects(access(join(root, 'node_modules')), { code: 'ENOENT' });

async function download(url, limit) {
  const target = new URL(url);
  assert.equal(target.origin, 'https://registry.npmjs.org');
  const response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, `Registry read failed: ${target.pathname}`);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    assert(bytes <= limit, 'Registry response exceeded fixture budget');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

if (mode === 'inventory') {
  const packages = [];
  const installHooks = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack'];
  for (const [name, version] of Object.entries(expected)) {
    // Each untrusted download has its own fresh directory, separate from scripts.
    const scratch = await mkdtemp(join(process.env.RUNNER_TEMP, 'sdk-metadata-'));
    const bytes = await download(`https://registry.npmjs.org/${encodeURIComponent(name)}`, 16 * 1024 * 1024);
    await writeFile(join(scratch, 'registry.json'), bytes);
    const registry = JSON.parse(bytes);
    const metadata = registry.versions[version];
    assert.equal(metadata.name, name);
    assert.equal(metadata.version, version);
    const publishedAt = registry.time[version];
    assert(Number.isFinite(Date.parse(publishedAt)), 'Missing publication timestamp');
    assert(Date.now() - Date.parse(publishedAt) >= 3 * 86400000, 'Metadata has not aged three days');
    const integrity = metadata.dist.integrity;
    assert.match(integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
    const tarball = await download(metadata.dist.tarball, 16 * 1024 * 1024);
    await writeFile(join(scratch, 'package.tgz'), tarball);
    assert.equal(`sha512-${createHash('sha512').update(tarball).digest('base64')}`, integrity);
    // Read one inert member to stdout; no archive extraction or package execution.
    const manifest = JSON.parse(execFileSync('tar', ['-xzOf', join(scratch, 'package.tgz'), 'package/package.json'],
      { cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 512 * 1024 }));
    for (const key of ['name', 'version', 'dependencies', 'engines', 'scripts', 'peerDependencies', 'peerDependenciesMeta']) {
      assert.deepEqual(manifest[key] ?? null, metadata[key] ?? null, `Published metadata differs from tarball: ${name} ${key}`);
    }
    assert.equal(manifest.optionalDependencies, undefined);
    assert.equal(manifest.bundleDependencies ?? manifest.bundledDependencies, undefined);
    for (const hook of installHooks) assert(!manifest.scripts?.[hook], `Unreviewed ${name} ${hook}`);
    const dependencies = name === '@paperclipai/plugin-sdk'
      ? { '@paperclipai/shared': '2026.831.0', zod: '^4.4.3' }
      : name === '@paperclipai/shared' ? { zod: '^4.4.3' } : {};
    assert.deepEqual(manifest.dependencies ?? {}, dependencies, 'Candidate dependency closure changed');
    if (name !== 'zod') assert.equal(manifest.engines.node, '>=24.11.0');
    if (name === '@paperclipai/plugin-sdk') {
      assert.deepEqual(manifest.peerDependenciesMeta, { react: { optional: true } });
      assert.deepEqual(Object.keys(manifest.peerDependencies), ['react']);
    } else {
      assert.equal(manifest.peerDependencies, undefined);
    }
    packages.push({ name, version, publishedAt, integrity, resolved: metadata.dist.tarball,
      dependencies, engines: manifest.engines ?? null, scripts: manifest.scripts ?? {},
      peerDependencies: manifest.peerDependencies ?? {}, peerDependenciesMeta: manifest.peerDependenciesMeta ?? {} });
  }
  const report = { boundary: 'Inert registry/tarball metadata; no candidate installation or qualification',
    npm: '11.19.1', nativePolicy: { minReleaseAge: 3, ignoreScripts: true, engineStrict: true, exceptions: [] },
    nativeEnforcementProbe: 'pending before clean installation', packages,
    installed: false, stockHostQualified: false, migrationQualified: false };
  await writeFile(join(root, 'inventory.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} else {
  const inventory = await readJson(join(root, 'inventory.json'));
  const lock = await readJson(join(root, 'package-lock.json'));
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[''].dependencies, expected);
  const paths = inventory.packages.map(({ name }) => `node_modules/${name}`);
  assert.deepEqual(Object.keys(lock.packages).sort(), ['', ...paths].sort(), 'Unexpected candidate lock copy or peer');
  for (const record of inventory.packages) {
    const locked = lock.packages[`node_modules/${record.name}`];
    assert.equal(locked.version, record.version);
    assert.equal(locked.integrity, record.integrity);
    assert.equal(locked.resolved, record.resolved);
    assert(!locked.hasInstallScript);
    assert.deepEqual(locked.dependencies ?? {}, record.dependencies);
    assert.deepEqual(locked.engines ?? null, record.engines);
    assert(!locked.link && !locked.inBundle);
  }
  console.log(JSON.stringify({ boundary: 'Candidate lock prepared for review, NOT approved for installation',
    lockSha256: createHash('sha256').update(await readFile(join(root, 'package-lock.json'))).digest('hex'),
    installed: false, stockHostQualified: false, migrationQualified: false }, null, 2));
}
