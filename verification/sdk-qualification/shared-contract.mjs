import assert from 'node:assert/strict';

export async function sharedContract(shared, manifest, optInManifest) {
  const company = '11111111-1111-4111-8111-111111111111';
  const otherCompany = '22222222-2222-4222-8222-222222222222';
  const configCases = [
    ['valid-company', { companyId: company, configJson: {} }, true],
    ['valid-other-company-nested-value', { companyId: otherCompany, configJson: { fixture: { values: [1, 2, 3] } } }, true],
    ['missing-company', { configJson: {} }, false],
    ['invalid-company', { companyId: 'co-1', configJson: {} }, false],
    ['array-config', { companyId: company, configJson: [] }, false],
    ['null-config', { companyId: company, configJson: null }, false],
  ];
  const manifestCases = [
    ['actual-built-manifest', manifest, true],
    ['wrong-api-version', { ...manifest, apiVersion: 2 }, false],
    ['wrong-capability-shape', { ...manifest, capabilities: [1] }, false],
  ];
  if (optInManifest) {
    assert(optInManifest.capabilities.includes('run.model.resolve'));
    manifestCases.push(['unsupported-run-resolve', optInManifest, false]);
  }
  const results = [];
  async function check(schema, name, cases, mode, exactOutput) {
    assert.equal(typeof schema?.safeParse, 'function', `Missing public schema: ${name}`);
    assert.equal(typeof schema.safeParseAsync, 'function', `Missing async public schema: ${name}`);
    for (const [test, input, success] of cases) {
      const before = JSON.stringify(input);
      const result = mode === 'sync' ? schema.safeParse(input) : await schema.safeParseAsync(input);
      assert.equal(result.success, success, `${name}/${mode}/${test}`);
      assert.equal(JSON.stringify(input), before, 'Shared schema mutated input');
      if (success) {
        if (exactOutput) assert.deepEqual(result.data, input, 'Config envelope changed valid input');
        else {
          assert.equal(result.data.id, manifest.id);
          assert.equal(result.data.apiVersion, 1);
        }
      } else assert(result.error.issues.length > 0, 'Refusal must include an issue');
      results.push({ schema: name, mode, test, success });
    }
  }
  for (const mode of ['sync', 'async']) {
    await check(shared.pluginManifestV1Schema, 'pluginManifestV1Schema', manifestCases, mode, false);
    for (const name of ['upsertPluginConfigSchema', 'patchPluginConfigSchema']) {
      await check(shared[name], name, configCases, mode, true);
    }
  }
  assert.equal(results.length, 2 * (manifestCases.length + 2 * configCases.length));
  return { boundary: 'Published shared schemas only, not host loader/Ajv routes or authorization',
    companyGuids: [company, otherCompany], results,
    nestedConfigValueAccepted: true, configValueBoundsProven: false, stockHostQualified: false };
}
