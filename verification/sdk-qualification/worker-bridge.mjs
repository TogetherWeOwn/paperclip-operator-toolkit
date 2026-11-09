// A real subprocess/SDK transport with inert service replies, NOT the stock
// scheduler, worker manager, capability dispatcher or authorization services.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function workerBridge(worker, cwd, service, args = [worker]) {
  const child = spawn(process.execPath, args, { cwd, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let sequence = 0;
  let failure;
  let stopping = false;
  let stderr = '';
  const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  function fail(error) {
    failure ??= error;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(failure);
    }
    pending.clear();
  }
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('exit', (code, signal) => {
    if (!stopping) fail(new Error(`Worker exited early (${code ?? signal}); ${stderr}`));
  });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    void (async () => {
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, '2.0');
      if (typeof message.method === 'string') {
        if (!Object.hasOwn(message, 'id')) {
          assert.equal(message.method, 'log', 'Unexpected worker notification');
          return;
        }
        // The callback may deliberately defer a reply beyond the plugin timeout.
        await service(message, (result) => send({ jsonrpc: '2.0', id: message.id, result }));
      } else {
        const entry = pending.get(message.id);
        assert(entry, 'Unexpected or duplicate worker response');
        clearTimeout(entry.timer);
        pending.delete(message.id);
        if (message.error) entry.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
        else entry.resolve(message.result);
      }
    })().catch(fail);
  });
  return {
    request(method, params = {}, timeoutMs = 6000) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const id = `fixture-${++sequence}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Worker RPC timed out: ${method}; ${stderr}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        send({ jsonrpc: '2.0', id, method, params });
      });
    },
    assertHealthy() { if (failure) throw failure; },
    async close() {
      stopping = true;
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try {
        child.stdin.end();
        child.kill('SIGTERM');
        await exited;
      } finally {
        clearTimeout(timer);
        lines.close();
        for (const entry of pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new Error('Fixture closed'));
        }
        pending.clear();
      }
    },
  };
}
