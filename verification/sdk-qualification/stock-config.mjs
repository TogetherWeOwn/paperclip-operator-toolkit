import assert from 'node:assert/strict';

export async function checkConfigRoutes(api, pluginPath, companyId, config) {
  const configPath = `${pluginPath}/config?companyId=${companyId}`;
  const before = await api(configPath);
  assert.deepEqual(before.configJson, config);
  const different = { ...config, requestTimeoutMs: 2000 };
  assert.notDeepEqual(different, before.configJson, 'Valid test input must differ from persisted configuration');
  assert.equal(different.pollingEnabled, false);
  const unchanged = async () => assert.deepEqual((await api(configPath)).configJson, before.configJson,
    'Rejected/test configs persisted a change');
  for (const route of ['/config', '/config/test']) {
    await api(`${pluginPath}${route}`, { configJson: different }, 400);
    await unchanged();
    await api(`${pluginPath}${route}`, { companyId, configJson: [] }, 400);
    await unchanged();
    const invalid = await api(`${pluginPath}${route}`, { companyId, configJson: { pollingEnabled: 'yes' } }, 400);
    assert(Array.isArray(invalid.fieldErrors) && invalid.fieldErrors.length > 0, 'Missing actual Ajv diagnostics');
    await unchanged();
  }
  const tested = await api(`${pluginPath}/config/test`, { companyId, configJson: different });
  assert.equal(tested.valid, true);
  await unchanged();
}
