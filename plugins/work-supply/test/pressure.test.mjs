import test from 'node:test';
import assert from 'node:assert/strict';
import { psiAvg10, diskUsedPercent, pressureGate, readPressure } from '../src/pressure.mjs';
import { NOW } from './fixtures.mjs';

const sample = patch => ({ observedAt: new Date(NOW).toISOString(), scope: 'host', cpuSome: 0, ioSome: 0,
  memoryFull: 0, rootUsed: 40, homeUsed: 40, ...patch });

test('PSI reads the named avg10 percentage only', () => {
  assert.equal(psiAvg10('some avg10=30.01 avg60=0 total=4\nfull avg10=2.00 avg60=0 total=1\n', 'some'), 30.01);
  assert.equal(psiAvg10('some avg10=30.01\nfull avg10=2.00\n', 'full'), 2);
});
for (const text of ['', 'some avg10=NaN', 'some avg10=Infinity', 'some avg10=-1', 'some avg10=101',
  'some avg10=3junk', 'some avg10=3 avg10=4', 'some avg10=1\nsome avg10=2', 'some avg10=1e1']) {
  test(`invalid PSI fails closed: ${JSON.stringify(text)}`, () => assert.throws(() => psiAvg10(text, 'some'), /pressure-invalid-psi/));
}
test('disk percentage matches df rounding and reserved blocks', () => {
  assert.equal(diskUsedPercent({ blocks: 1000, bfree: 100, bavail: 50 }), 95);
  assert.equal(diskUsedPercent({ blocks: 10000, bfree: 701, bavail: 701 }), 93);
  assert.equal(diskUsedPercent({ blocks: 1000, bfree: 1000, bavail: 1000 }), 0);
  assert.equal(diskUsedPercent({ blocks: Number.MAX_SAFE_INTEGER, bfree: 0, bavail: 0 }), 100);
});
for (const stats of [{ blocks: 0, bfree: 0, bavail: 0 }, { blocks: 100, bfree: 101, bavail: 0 },
  { blocks: 100, bfree: 1, bavail: 2 }, { blocks: 100, bfree: -1, bavail: 0 },
  { blocks: 100, bfree: 100, bavail: 0 }, { blocks: '100', bfree: 1, bavail: 1 },
  { blocks: Infinity, bfree: 0, bavail: 0 }]) {
  test(`invalid disk fails closed: ${JSON.stringify(stats)}`, () => assert.throws(() => diskUsedPercent(stats), /pressure-invalid-disk/));
}
for (const [field, limit, inclusive] of [['cpuSome', 30, false], ['ioSome', 30, false], ['memoryFull', 5, false],
  ['rootUsed', 93, true], ['homeUsed', 95, true]]) {
  test(`${field} threshold preserves strict/inclusive boundary`, () => {
    assert.equal(pressureGate(sample({ [field]: limit - .01 }), NOW).allowed, true);
    assert.equal(pressureGate(sample({ [field]: limit }), NOW).allowed, !inclusive);
    assert.equal(pressureGate(sample({ [field]: limit + .01 }), NOW).allowed, false);
    for (const value of [undefined, null, '0', NaN, Infinity, -1, 101])
      assert.equal(pressureGate(sample({ [field]: value }), NOW).allowed, false);
  });
}
test('pressure rejects stale, future, invalid clocks and unverified scope', () => {
  assert.equal(pressureGate(sample(), NOW + 60_000).allowed, true);
  assert.equal(pressureGate(sample(), NOW + 60_001).allowed, false);
  assert.equal(pressureGate(sample(), NOW - 1).allowed, false);
  assert.equal(pressureGate(sample({ observedAt: 'bad' }), NOW).allowed, false);
  assert.equal(pressureGate(sample({ scope: 'unverified' }), NOW).allowed, false);
  assert.equal(pressureGate(sample(), NaN).allowed, false);
  assert.equal(pressureGate(sample(), NOW, -1).allowed, false);
});
test('slow collection cannot relabel an old pressure reading as fresh', async () => {
  let now = NOW;
  const reading = await readPressure({ hostScopeVerified: true, clock: () => now,
    read: async () => 'some avg10=1\nfull avg10=1',
    disk: async () => { now = NOW + 60_001; return { blocks: 100, bfree: 50, bavail: 50 }; } });
  assert.equal(reading.observedAt, new Date(NOW).toISOString());
  assert.equal(pressureGate(reading, now).allowed, false);
});
test('reader uses fixed paths and never assumes host mount provenance', async () => {
  const files = [], disks = [];
  const options = { clock: () => NOW,
    read: async path => { files.push(path); return 'some avg10=3\nfull avg10=2'; },
    disk: async path => { disks.push(path); return { blocks: 100, bfree: 50, bavail: 50 }; } };
  const unverified = await readPressure(options);
  assert.equal(unverified.scope, 'unverified');
  assert.deepEqual(files.sort(), ['/proc/pressure/cpu', '/proc/pressure/io', '/proc/pressure/memory']);
  assert.deepEqual(disks.sort(), ['/', '/home']);
  assert.equal(pressureGate(unverified, NOW).allowed, false);
  assert.equal(pressureGate(await readPressure({ ...options, hostScopeVerified: true }), NOW).allowed, true);
  await assert.rejects(readPressure({ ...options, read: async () => { throw new Error('unreadable'); } }));
});
