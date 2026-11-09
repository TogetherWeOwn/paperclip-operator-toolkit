// Receipt checks only. These helpers never start a host or substitute for one.
import assert from 'node:assert/strict';

export const STOCK_SOURCE = 'd69631b01b9c658f80bf8bed389863dce82643e1';
export const STOCK_IMAGE = 'ghcr.io/paperclipai/paperclip@sha256:12ae7579165cbf11d8db71ef69cf01ff48660383e78541b6b2eba38939fa30c9';
export const STOCK_RELEASE = '2026.1106.0';

export function scheduledCompletion(runs, job, priorIds, observationStartedAt) {
  assert(Array.isArray(runs));
  assert.equal(job.status, 'active');
  assert.equal(job.schedule, '*/5 * * * *', 'Do not accelerate the production cron');
  const due = Date.parse(job.nextRunAt);
  assert(Number.isFinite(due) && due >= observationStartedAt, 'Missing future schedule readiness');
  const matches = runs.filter(run => !priorIds.includes(run.id) && run.jobId === job.id
    && run.pluginId === job.pluginId && run.trigger === 'schedule' && run.status === 'succeeded'
    && Date.parse(run.startedAt) >= due && Date.parse(run.finishedAt) >= Date.parse(run.startedAt)
    && typeof run.durationMs === 'number' && run.durationMs >= 0);
  assert(matches.length <= 1, 'Unexpected multiple completed ticks in one observation window');
  return matches[0] ?? null;
}

export function assertEmptyUsage(body) {
  assert.deepEqual(body.providers, []);
  assert.deepEqual(body.snapshots, {});
  assert.deepEqual(body.lanes, []);
  assert.deepEqual(body.laneSnapshots, {});
  assert.equal(body.accountsCooling, 0);
  assert.equal(body.modelUsage, null);
}

export function partialStockReport() {
  return {
    boundary: 'Disposable stock local-path lifecycle/config/API and scheduled no-op dispatch only',
    expectedImage: STOCK_IMAGE, expectedSource: STOCK_SOURCE, expectedRelease: STOCK_RELEASE,
    lifecycleCompleted: false, configRoutesCompleted: false, scheduledDispatchObserved: false,
    telemetryPositive: false, runtimeCapabilityDenial: false, unauthorizedServiceEffectsMeasured: false,
    stockHostQualified: false, migrationQualified: false,
    prerequisites: [
      'Installation/age and Security holds must clear before any image pull or driver execution.',
      'A supported synthetic telemetry/service observation path preserving stock SSRF, HTTPS and company gates is still required.',
      'A scoped actor/capability fixture must measure actual stock denial and zero unauthorized service effects; local-trusted board access is not that proof.',
    ], checks: [],
  };
}
