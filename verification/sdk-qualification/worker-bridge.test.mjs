import assert from 'node:assert/strict';
import test from 'node:test';
import { workerBridge } from './worker-bridge.mjs';

const worker = `
  const lines = require('node:readline').createInterface({ input: process.stdin });
  lines.on('line', line => {
    const request = JSON.parse(line);
    if (request.method === 'drop') return;
    const response = request.method === 'refuse'
      ? { error: { code: -32000, message: 'Expected worker refusal' } }
      : { result: { ok: true } };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }) + '\\n');
  });
`;
const bridge = () => workerBridge('', process.cwd(), async () => assert.fail('Unexpected service'), ['-e', worker]);

test('a live worker dropping a request poisons bridge health and all pending requests', async () => {
  const child = bridge();
  try {
    assert.deepEqual(await child.request('initialize'), { ok: true });
    const first = child.request('drop', {}, 30);
    const second = child.request('drop', {}, 1000);
    await Promise.all([first, second].map(request => assert.rejects(request, { code: 'SDK_FIXTURE_RPC_TIMEOUT' })));
    assert.throws(() => child.assertHealthy(), { code: 'SDK_FIXTURE_RPC_TIMEOUT' });
    await assert.rejects(child.request('health'), { code: 'SDK_FIXTURE_RPC_TIMEOUT' });
  } finally {
    await child.close();
  }
});

test('an actual JSON-RPC refusal is distinct from a deadline and leaves the bridge healthy', async () => {
  const child = bridge();
  try {
    await assert.rejects(child.request('refuse'), { name: 'WorkerRpcError', code: -32000 });
    assert.deepEqual(await child.request('health'), { ok: true });
    child.assertHealthy();
  } finally {
    await child.close();
  }
});
