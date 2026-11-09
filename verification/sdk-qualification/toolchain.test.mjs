import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('both plugin jobs capture candidate npm from the pinned Node distribution', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  let node;
  let controls = 0;
  for (const line of workflow.split('\n')) {
    const version = line.match(/^\s+node-version: '([^']+)'$/);
    if (version) node = version[1];
    if (line.includes('- name: Retain npm11 for the isolated candidate engine negative control')) {
      assert.equal(node, '24.22.2', 'Retained npm must not come from a floating distribution');
      controls++;
    }
  }
  assert.equal(controls, 2, 'Both plugin engine controls must be checked');
});
