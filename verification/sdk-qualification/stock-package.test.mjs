import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageStockPackage, validateStockPackage } from './stock-package.mjs';

const pkg = { paperclipPlugin: { manifest: './dist/manifest.js', worker: './dist/worker.js' } };
const manifest = { entrypoints: { worker: './dist/worker.js' }, database: { migrationsDir: './migrations' } };

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'sdk-stock-package-'));
  try {
    const source = join(root, 'source');
    await mkdir(join(source, 'dist'), { recursive: true });
    await writeFile(join(source, 'package.json'), JSON.stringify(pkg));
    await writeFile(join(source, 'dist/manifest.js'), 'export default {};\n');
    await writeFile(join(source, 'dist/worker.js'), '// inert first-party test artifact\n');
    await fn(source, join(root, 'destination'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('runtime-only stock staging is refused when a declared migrations directory is missing or empty', async () => {
  await fixture(async source => {
    await assert.rejects(validateStockPackage(source, manifest));
    await mkdir(join(source, 'migrations'));
    await assert.rejects(validateStockPackage(source, manifest));
  });
});

test('separate stock staging preserves every declared path and rejects later omissions', async () => {
  await fixture(async (source, destination) => {
    await mkdir(join(source, 'migrations'));
    await writeFile(join(source, 'migrations/README.md'), 'Required nonempty directory.\n');
    const staged = await stageStockPackage(source, destination, manifest);
    assert(staged.artifacts.some(file => file.path === 'migrations/README.md'));
    assert.equal(await readFile(join(destination, 'migrations/README.md'), 'utf8'), 'Required nonempty directory.\n');
    await validateStockPackage(destination, manifest);
    await rm(join(destination, 'migrations'), { recursive: true });
    await assert.rejects(validateStockPackage(destination, manifest));
  });
});
