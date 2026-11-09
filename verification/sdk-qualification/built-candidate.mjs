// Copy only our already-built ESM artifacts, never a plugin node_modules tree.
// Native npm installation/preflight are separate visible Actions steps.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stageStockPackage } from './stock-package.mjs';

assert.equal(process.argv.length, 4, 'Usage: built-candidate.mjs <built-plugin-root> <installed-candidate-root>');
const source = await realpath(process.argv[2]);
const candidate = await realpath(process.argv[3]);
const name = basename(source);
assert(['cliproxy-insight', 'model-selection'].includes(name));
const destination = join(candidate, 'consumers', name);
await assert.rejects(access(destination), { code: 'ENOENT' });
await mkdir(join(destination, 'dist'), { recursive: true });
const artifacts = [];
for (const path of ['package.json', 'dist/worker.js', 'dist/manifest.js']) {
  assert((await lstat(join(source, path))).isFile(), `Built input must be a regular file: ${path}`);
  const bytes = await readFile(join(source, path));
  await writeFile(join(destination, path), bytes, { flag: 'wx' });
  assert.deepEqual(await readFile(join(destination, path)), bytes);
  artifacts.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await assert.rejects(access(join(destination, 'node_modules')), { code: 'ENOENT' });
const wire = fileURLToPath(new URL('./wire.mjs', import.meta.url));
let output;
try {
  output = execFileSync(process.execPath, ['--experimental-import-meta-resolve', wire, destination, candidate], {
    env: {}, encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024,
  });
} catch (error) {
  process.stdout.write(error.stdout ?? '');
  process.stderr.write(error.stderr ?? '');
  throw error;
}
const wireReport = JSON.parse(output);
assert.equal(wireReport.candidate.installed, true);
assert.equal(wireReport.stockHostQualified, false);
assert.equal(wireReport.migrationQualified, false);
// Keep the deliberately runtime-only wire consumer separate from the package
// that a future authorized stock lifecycle may install. No stock code is run.
const manifest = (await import(pathToFileURL(join(destination, 'dist/manifest.js')).href)).default;
const stockPackage = await stageStockPackage(source, join(candidate, 'consumers', `stock-${name}`), manifest);
const report = { artifacts, stockPackage, ...wireReport };
await writeFile(join(candidate, `built-${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
