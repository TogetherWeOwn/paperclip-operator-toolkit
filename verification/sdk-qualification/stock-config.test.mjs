import assert from 'node:assert/strict';
import test from 'node:test';
import { checkConfigRoutes } from './stock-config.mjs';

const config = { pollingEnabled: false, laneFiles: [], legacyAggregateFiles: false, requestTimeoutMs: 1000 };

// Oracle regression controls only, not execution of stock config routes.
function fixture({ persistValidTest = false, persistRejected = false } = {}) {
  let saved = structuredClone(config);
  const calls = [];
  return { calls, api: async (path, body, status = 200) => {
    calls.push({ path, body, status });
    if (!body) return { configJson: structuredClone(saved) };
    if (status === 400) {
      if (persistRejected) saved = body.configJson;
      return { error: 'Invalid configuration', fieldErrors: [{ path: 'pollingEnabled' }] };
    }
    assert.equal(path, '/plugin/config/test');
    assert.notDeepEqual(body.configJson, config);
    assert.equal(body.configJson.pollingEnabled, false);
    if (persistValidTest) saved = body.configJson;
    return { valid: true };
  } };
}

test('config oracle uses a differential valid test and reads immediately after every request', async () => {
  const { api, calls } = fixture();
  await checkConfigRoutes(api, '/plugin', 'fixture-company', config);
  assert.equal(calls.length, 15);
  for (let index = 2; index < calls.length; index += 2) {
    assert.equal(calls[index].body, undefined);
    assert.equal(calls[index].path, '/plugin/config?companyId=fixture-company');
  }
});

test('config oracle rejects a valid test that persists its different input', async () => {
  await assert.rejects(checkConfigRoutes(fixture({ persistValidTest: true }).api, '/plugin', 'fixture-company', config),
    { code: 'ERR_ASSERTION' });
});

test('config oracle detects rejected writes before later tests can overwrite them', async () => {
  const { api, calls } = fixture({ persistRejected: true });
  await assert.rejects(checkConfigRoutes(api, '/plugin', 'fixture-company', config), { code: 'ERR_ASSERTION' });
  assert.equal(calls.length, 3);
  assert(!calls.some(call => call.path === '/plugin/config/test'));
});
