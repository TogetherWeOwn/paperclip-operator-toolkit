// Run under Node22 with the same npm11 CLI used for the Node24 install.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

assert.equal(process.argv.length, 3);
assert.equal(Number(process.versions.node.split('.')[0]), 22);
const root = resolve(process.argv[2]);
const npm = process.env.NPM_CLI;
assert(npm, 'Node24 npm CLI path must be retained across setup-node');
assert.equal(execFileSync(process.execPath, [npm, '--version'], { encoding: 'utf8' }).trim(), '11.19.1');
const before = await readFile(join(root, 'package-lock.json'), 'utf8');
await assert.rejects(access(join(root, 'node_modules')), { code: 'ENOENT' });
let failure;
try {
  execFileSync(process.execPath, [npm, 'ci', '--ignore-scripts', '--json'], { cwd: root, encoding: 'utf8', timeout: 30000 });
} catch (error) { failure = error; }
assert(failure && failure.status !== 0 && !failure.signal, 'Node22 must be rejected by native engine-strict');
const result = JSON.parse(failure.stdout);
assert.equal(result.error.code, 'EBADENGINE');
assert.equal(await readFile(join(root, 'package-lock.json'), 'utf8'), before);
await assert.rejects(access(join(root, 'node_modules')), { code: 'ENOENT' });
console.log(JSON.stringify({ node: process.versions.node, npm: '11.19.1', nativeEngineRefusal: result.error.code,
  candidateInstalled: false, node22DropIn: false }, null, 2));
