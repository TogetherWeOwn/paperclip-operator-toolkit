// First-party loopback registry only. Never run these synthetic hooks against
// downloaded packages or relax the real candidate's native policy.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

assert.equal(process.argv.length, 3, 'Usage: native-policy.mjs <candidate-root>');
const candidate = resolve(process.argv[2]);
assert.equal(execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(), '11.19.1');
const policy = await readFile(join(candidate, '.npmrc'), 'utf8');
const scratch = await mkdtemp(join(process.env.RUNNER_TEMP, 'sdk-native-policy-'));
const hookNames = ['preinstall', 'install', 'postinstall', 'prepare'];
const markers = hookNames.map((name) => `${name}.marker`);
const markerScript = "require('node:fs').writeFileSync(process.argv[1], 'synthetic-hook')";
const scripts = Object.fromEntries(hookNames.map((name) => [name, `node marker.cjs ${name}.marker`]));
const packages = new Map();
for (const version of ['1.0.0', '2.0.0']) {
  const directory = join(scratch, `source-${version}`);
  await mkdir(join(directory, 'package'), { recursive: true });
  await writeFile(join(directory, 'package/package.json'), JSON.stringify({ name: 'sdk-policy-fixture', version, scripts }));
  await writeFile(join(directory, 'package/marker.cjs'), markerScript);
  const tarball = execFileSync('tar', ['-czf', '-', '-C', directory, 'package'], { maxBuffer: 64 * 1024 });
  packages.set(version, { tarball, integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}` });
}
const requests = [];
const server = createServer((request, response) => {
  requests.push(request.url);
  if (request.url === '/sdk-policy-fixture') {
    const now = Date.now();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ name: 'sdk-policy-fixture', 'dist-tags': { latest: '2.0.0' },
      time: { created: new Date(now - 10 * 86400000).toISOString(), modified: new Date(now).toISOString(),
        '1.0.0': new Date(now - 10 * 86400000).toISOString(), '2.0.0': new Date(now - 3600000).toISOString() },
      versions: Object.fromEntries([...packages].map(([version, value]) => [version, {
        name: 'sdk-policy-fixture', version, scripts,
        dist: { tarball: `${registry}/sdk-policy-fixture/-/${version}.tgz`, integrity: value.integrity },
      }])) }));
  } else {
    const version = /^\/sdk-policy-fixture\/-\/(1\.0\.0|2\.0\.0)\.tgz$/.exec(request.url)?.[1];
    if (!version) { response.writeHead(404).end(); return; }
    response.setHeader('content-type', 'application/octet-stream');
    response.end(packages.get(version).tarball);
  }
});
await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
const registry = `http://127.0.0.1:${server.address().port}`;

async function absent(path) {
  await assert.rejects(access(path), { code: 'ENOENT' });
}
async function project(name, dependency, ignoreScripts = true) {
  const root = join(scratch, name);
  await mkdir(root);
  await writeFile(join(root, '.npmrc'), `${policy}\nregistry=${registry}\ncache=${join(root, 'cache')}\n`);
  await writeFile(join(root, 'marker.cjs'), markerScript);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: `synthetic-${name}`, version: '1.0.0',
    private: true, scripts: { ...scripts, marker: 'node marker.cjs explicit.marker' },
    dependencies: { 'sdk-policy-fixture': dependency } }));
  // The only script-enabled control uses our tiny first-party marker package,
  // from this loopback registry. It never touches the candidate root or registry.
  if (!ignoreScripts) await writeFile(join(root, '.npmrc'), `${policy}\nregistry=${registry}\ncache=${join(root, 'cache')}\nignore-scripts=false\n`);
  return root;
}
async function npm(root, args, success = true) {
  const child = spawn('npm', args, { cwd: root, env: { PATH: process.env.PATH, HOME: root, CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let stdout = '';
  let overflow = false;
  const collect = (chunk) => {
    output += chunk.toString();
    if (output.length > 256 * 1024) { overflow = true; child.kill('SIGKILL'); }
  };
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); collect(chunk); });
  child.stderr.on('data', collect);
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  try {
    const result = await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => accept({ code, signal }));
    });
    assert(!overflow && !result.signal, 'Native probe exceeded its budget');
    console.log(JSON.stringify({ probe: root.slice(scratch.length + 1), args, ...result, output }));
    assert.equal(result.code === 0, success, `Unexpected native npm result: ${output}`);
    return stdout;
  } finally { clearTimeout(timer); }
}

try {
  const old = await project('aged-and-script-refused', '^1.0.0');
  await npm(old, ['install', '--json']);
  assert.equal(JSON.parse(await readFile(join(old, 'node_modules/sdk-policy-fixture/package.json'))).version, '1.0.0');
  for (const marker of markers) {
    await absent(join(old, marker));
    await absent(join(old, 'node_modules/sdk-policy-fixture', marker));
  }
  // A named command still runs with ignore-scripts=true. Its pre/post commands
  // must not be inferred to run, and candidate package scripts are never invoked.
  await npm(old, ['run', 'marker']);
  assert.equal(await readFile(join(old, 'explicit.marker'), 'utf8'), 'synthetic-hook');

  const ranged = await project('fresh-range-filtered', '*');
  await npm(ranged, ['install', '--json']);
  assert.equal(JSON.parse(await readFile(join(ranged, 'package-lock.json'))).packages['node_modules/sdk-policy-fixture'].version, '1.0.0');
  const fresh = await project('fresh-exact-refused', '2.0.0');
  const freshOutput = await npm(fresh, ['install', '--json'], false);
  const error = JSON.parse(freshOutput.slice(freshOutput.indexOf('{'))).error;
  assert.equal(error.code, 'ETARGET', 'Failure must be native age resolution, not network or tool failure');
  await absent(join(fresh, 'node_modules/sdk-policy-fixture'));
  assert(!requests.includes('/sdk-policy-fixture/-/2.0.0.tgz'), 'Fresh synthetic tarball must not be fetched');

  const enabled = await project('synthetic-hooks-positive', '1.0.0', false);
  await npm(enabled, ['install', '--json']);
  for (const marker of markers) assert.equal(await readFile(join(enabled, marker), 'utf8'), 'synthetic-hook');
  for (const marker of ['preinstall.marker', 'install.marker', 'postinstall.marker']) {
    assert.equal(await readFile(join(enabled, 'node_modules/sdk-policy-fixture', marker), 'utf8'), 'synthetic-hook');
  }
  await absent(join(candidate, 'node_modules'));
  const report = { npm: '11.19.1', nativePolicyProbes: ['aged-install-positive', 'fresh-range-filtered',
    'fresh-exact-refused', 'root-and-dependency-scripts-refused', 'explicit-command-positive', 'synthetic-hooks-positive'],
    exceptions: [], boundary: 'First-party loopback native enforcement probes only; no downloaded package hooks enabled' };
  await writeFile(join(candidate, 'native-policy.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()));
}
