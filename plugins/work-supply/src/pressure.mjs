import { readFile, statfs } from 'node:fs/promises';

export const PRESSURE_LIMITS = Object.freeze({ cpuSome: 30, ioSome: 30, memoryFull: 5, rootUsed: 93, homeUsed: 95 });

// PSI avg10 is a percentage: https://docs.kernel.org/accounting/psi.html
export function psiAvg10(text, kind) {
  const lines = String(text).trim().split('\n').filter(line => line.startsWith(`${kind} `));
  if (lines.length !== 1) throw new Error('pressure-invalid-psi');
  const fields = lines[0].trim().split(/\s+/).slice(1);
  const values = fields.filter(field => field.startsWith('avg10='));
  if (values.length !== 1 || !/^avg10=\d+(?:\.\d+)?$/.test(values[0])) throw new Error('pressure-invalid-psi');
  const value = Number(values[0].slice(6));
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('pressure-invalid-psi');
  return value;
}

// Match df's unprivileged usage percentage, including reserved blocks and ceil.
// https://nodejs.org/api/fs.html#class-fsstatfs
export function diskUsedPercent(stats) {
  const { blocks, bfree, bavail } = stats;
  if (![blocks, bfree, bavail].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      || blocks === 0 || bfree > blocks || bavail > bfree) throw new Error('pressure-invalid-disk');
  const used = blocks - bfree;
  const denominator = used + bavail;
  if (denominator === 0) throw new Error('pressure-invalid-disk');
  return Number((100n * BigInt(used) + BigInt(denominator) - 1n) / BigInt(denominator));
}

export function pressureGate(sample, now, maxAgeMs = 60_000) {
  const observedAt = Date.parse(sample?.observedAt);
  const reasons = [];
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0
      || !Number.isFinite(observedAt) || observedAt > now || now - observedAt > maxAgeMs) reasons.push('pressure-stale');
  if (sample?.scope !== 'host') reasons.push('pressure-host-scope-unverified');
  for (const [name, limit] of Object.entries(PRESSURE_LIMITS)) {
    const value = sample?.[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) reasons.push(`pressure-invalid-${name}`);
    else if (name.endsWith('Used') ? value >= limit : value > limit) reasons.push(`pressure-high-${name}`);
  }
  return { allowed: reasons.length === 0, reasons };
}

export async function readPressure({ hostScopeVerified = false, read = readFile, disk = statfs, clock = Date.now } = {}) {
  // Fixed paths only. Isolation/mount provenance must be verified by the Operator;
  // successfully reading container-local files does not prove host pressure.
  const observedAt = new Date(clock()).toISOString();
  const [cpu, io, memory, root, home] = await Promise.all([
    read('/proc/pressure/cpu', 'utf8'), read('/proc/pressure/io', 'utf8'), read('/proc/pressure/memory', 'utf8'),
    disk('/'), disk('/home'),
  ]);
  return {
    observedAt, scope: hostScopeVerified === true ? 'host' : 'unverified',
    cpuSome: psiAvg10(cpu, 'some'), ioSome: psiAvg10(io, 'some'), memoryFull: psiAvg10(memory, 'full'),
    rootUsed: diskUsedPercent(root), homeUsed: diskUsedPercent(home),
  };
}
