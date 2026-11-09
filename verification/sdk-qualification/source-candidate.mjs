// Typecheck unchanged production source against the candidate declarations, then
// rebuild with the existing first-party build script. No install or pin rewrite.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

assert.equal(process.argv.length, 4, 'Usage: source-candidate.mjs <plugin-root> <installed-candidate-root>');
assert.equal(process.versions.node, '24.22.2');
const source = await realpath(process.argv[2]);
const candidate = await realpath(process.argv[3]);
const name = basename(source);
assert(['cliproxy-insight', 'model-selection'].includes(name));
const destination = join(candidate, 'consumers', 'source', name);
await assert.rejects(access(destination), { code: 'ENOENT' });
await mkdir(destination, { recursive: true });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inputs = [];
async function copyFile(path) {
  assert((await lstat(join(source, path))).isFile(), `Source input must be a regular file: ${path}`);
  const bytes = await readFile(join(source, path));
  await mkdir(dirname(join(destination, path)), { recursive: true });
  await writeFile(join(destination, path), bytes, { flag: 'wx' });
  assert.deepEqual(await readFile(join(destination, path)), bytes);
  inputs.push({ path, sha256: sha256(bytes) });
}
async function copyTree(path) {
  assert((await lstat(join(source, path))).isDirectory());
  for (const entry of (await readdir(join(source, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    assert(!entry.isSymbolicLink(), 'Do not follow source symlinks');
    if (entry.isDirectory()) await copyTree(join(path, entry.name));
    else await copyFile(join(path, entry.name));
  }
}
await copyFile('package.json');
await copyFile('tsconfig.json');
await copyFile('esbuild.config.mjs');
await copyTree('src');
await assert.rejects(access(join(destination, 'node_modules')), { code: 'ENOENT' });
const report = { plugin: name, node: process.versions.node, inputs,
  boundary: 'Unchanged production source only; tests excluded; held development tools, candidate declarations/runtime',
  sourceTypechecked: false, rebuilt: false, wireCompleted: false,
  stockHostQualified: false, migrationQualified: false, node22DropIn: false };
function command(args, timeout) {
  try {
    return execFileSync(process.execPath, args, { cwd: destination, env: {}, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
  } catch (error) {
    process.stdout.write(error.stdout ?? '');
    process.stderr.write(error.stderr ?? '');
    throw error;
  }
}
try {
  const policy = JSON.parse(await readFile(join(candidate, 'native-policy.json'), 'utf8'));
  assert.equal(policy.nativePolicyProbes.length, 6);
  const lock = JSON.parse(await readFile(join(candidate, 'package-lock.json'), 'utf8'));
  const compilerRoot = await realpath(join(source, 'node_modules/typescript'));
  const ts = (await import(pathToFileURL(join(compilerRoot, 'lib/typescript.js')).href)).default;
  const compilerManifest = JSON.parse(await readFile(join(compilerRoot, 'package.json'), 'utf8'));
  assert.equal(compilerManifest.version, ts.version);
  report.compiler = { version: ts.version, origin: 'Existing held consumer development install; no new tool install' };
  const config = ts.readConfigFile(join(destination, 'tsconfig.json'), ts.sys.readFile);
  assert.equal(config.error, undefined);
  // Keep production strictness/target/skipLibCheck, but do not import test-runner
  // types or held SDK declarations through tests. No paths or baseUrl aliases.
  assert.equal(config.config.compilerOptions.paths, undefined);
  assert.equal(config.config.compilerOptions.baseUrl, undefined);
  const parsed = ts.parseJsonConfigFileContent({ ...config.config, include: ['src/**/*.ts'],
    compilerOptions: { ...config.config.compilerOptions, typeRoots: [join(source, 'node_modules/@types')] } }, ts.sys, destination);
  assert.deepEqual(parsed.errors, []);
  assert(parsed.fileNames.length > 0);
  assert(parsed.fileNames.every((path) => relative(destination, path).startsWith('src/')));
  assert.equal(parsed.options.strict, true);
  assert.equal(parsed.options.noEmit, true);
  report.compilerOptions = parsed.options;
  const host = ts.createCompilerHost(parsed.options);
  const resolved = ts.resolveModuleName('@paperclipai/plugin-sdk', join(destination, 'src/worker.ts'), parsed.options, host).resolvedModule;
  assert(resolved, 'Candidate SDK types did not resolve');
  const sdkTypes = await realpath(resolved.resolvedFileName);
  assert(sdkTypes.startsWith(`${join(candidate, 'node_modules/@paperclipai/plugin-sdk')}/`), 'SDK types escaped candidate');
  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  report.declarations = [];
  const expected = { '@paperclipai/plugin-sdk': '2026.831.0', '@paperclipai/shared': '2026.831.0', zod: '4.6.7' };
  for (const [pkg, version] of Object.entries(expected)) {
    assert.equal(lock.packages[`node_modules/${pkg}`]?.version, version);
    const packageRoot = await realpath(join(candidate, 'node_modules', pkg));
    assert.equal(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version, version);
    const files = [];
    for (const file of program.getSourceFiles()) {
      const path = await realpath(file.fileName);
      if (path.includes(`/node_modules/${pkg}/`)) {
        assert(path.startsWith(`${packageRoot}/`), `Type graph loaded held ${pkg}`);
        files.push(relative(candidate, path));
      }
    }
    assert(files.length > 0, `No ${pkg} declarations loaded`);
    report.declarations.push({ package: pkg, version, files });
  }
  const diagnostics = ts.getPreEmitDiagnostics(program);
  report.diagnostics = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (file) => file, getCurrentDirectory: () => destination, getNewLine: () => '\n',
  }).replace(/\x1b\[[0-9;]*m/g, '');
  if (report.diagnostics) process.stderr.write(report.diagnostics);
  assert.equal(diagnostics.length, 0, 'Candidate production source typecheck failed');
  // Deliberately wrong first-party source proves the checker is not a no-op.
  const negativePath = join(destination, '__qualification_negative__.ts');
  const negativeHost = ts.createCompilerHost(parsed.options);
  const getSourceFile = negativeHost.getSourceFile.bind(negativeHost);
  negativeHost.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => path === negativePath
    ? ts.createSourceFile(path, 'const qualificationNegativeControl: string = 42; export {};', languageVersion)
    : getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
  const negative = ts.getPreEmitDiagnostics(ts.createProgram([...parsed.fileNames, negativePath], parsed.options, negativeHost));
  assert(negative.some((item) => item.code === 2322 && item.file?.fileName === negativePath), 'Broken-source control did not fail');
  report.brokenSourceRejected = true;
  report.sourceTypechecked = true;
  // Running the original script preserves its esbuild options, default-off opt-in
  // flag and held tool resolution; its cwd selects only the staged source inputs.
  report.buildOutput = command([join(source, 'esbuild.config.mjs')], 60000);
  report.artifacts = [];
  for (const path of ['dist/worker.js', 'dist/manifest.js']) {
    assert((await lstat(join(destination, path))).isFile());
    report.artifacts.push({ path, sha256: sha256(await readFile(join(destination, path))) });
  }
  report.rebuilt = true;
  const wire = fileURLToPath(new URL('./wire.mjs', import.meta.url));
  const wireReport = JSON.parse(command(['--experimental-import-meta-resolve', wire, destination, candidate], 45000));
  assert.equal(wireReport.candidate.installed, true);
  assert.equal(wireReport.stockHostQualified, false);
  assert.equal(wireReport.migrationQualified, false);
  wireReport.candidate.boundary = 'Fresh source typecheck/rebuild experiment; held source pins and support floor unchanged';
  report.wire = wireReport;
  report.wireCompleted = true;
  for (const input of inputs) {
    assert.equal(sha256(await readFile(join(source, input.path))), input.sha256, 'Held source changed');
    assert.equal(sha256(await readFile(join(destination, input.path))), input.sha256, 'Staged source changed');
  }
} catch (error) {
  report.failure = error.message;
  throw error;
} finally {
  await writeFile(join(candidate, `source-${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
