// Complete first-party staging only, never installation or stock execution.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { checkCompleteness, requiredPaths } from '../../plugins/model-selection/scripts/verify-package-completeness.mjs';

async function filesUnder(root, rel) {
  assert(!rel.split('/').some(part => ['..', 'node_modules', ''].includes(part)), 'Unsafe declared package path');
  const stat = await lstat(join(root, rel));
  if (stat.isFile()) return [rel];
  assert(stat.isDirectory(), `Package input must be a regular file or directory: ${rel}`);
  const files = [];
  for (const entry of await readdir(join(root, rel))) files.push(...await filesUnder(root, `${rel}/${entry}`));
  return files;
}

export async function validateStockPackage(root, manifest) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const required = requiredPaths(pkg, manifest);
  assert(required.length > 0, 'No declared stock package paths');
  const files = new Set(['package.json']);
  for (const req of required) {
    const stat = await lstat(join(root, req.rel));
    assert(req.kind === 'dir' ? stat.isDirectory() : stat.isFile(), `Wrong package path type: ${req.rel}`);
    for (const file of await filesUnder(root, req.rel)) files.add(file);
  }
  assert.deepEqual(checkCompleteness(required, [...files]).missing, [], 'Incomplete stock-install package');
  return [...files].sort();
}

export async function stageStockPackage(source, destination, manifest) {
  const files = await validateStockPackage(source, manifest);
  await mkdir(destination, { recursive: false });
  const artifacts = [];
  for (const path of files) {
    const bytes = await readFile(join(source, path));
    await mkdir(dirname(join(destination, path)), { recursive: true });
    await writeFile(join(destination, path), bytes, { flag: 'wx' });
    assert.deepEqual(await readFile(join(destination, path)), bytes);
    artifacts.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  await validateStockPackage(destination, manifest);
  return { artifacts, complete: true, stockHostQualified: false };
}
