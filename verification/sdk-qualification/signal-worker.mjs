// Synthetic SDK transport probe, not a plugin build or stock host service.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

assert.equal(process.argv.length, 3, 'Expected the consumer-resolved SDK entry');
const { definePlugin, runWorker } = await import(pathToFileURL(process.argv[2]).href);
let context;
const plugin = definePlugin({
  async setup(ctx) { context = ctx; },
  async onApiRequest({ mode }) {
    assert(['normal', 'pre-aborted', 'abort-after-send'].includes(mode));
    const controller = new AbortController();
    if (mode === 'pre-aborted') controller.abort();
    const pending = context.http.fetch('https://fixture.invalid/signal', {
      method: 'POST', headers: { 'content-type': 'text/plain' },
      body: 'tiny-signal-control', signal: controller.signal,
    });
    if (mode === 'abort-after-send') controller.abort();
    const response = await pending;
    return { status: response.status, body: await response.text(), aborted: controller.signal.aborted };
  },
});
runWorker(plugin, import.meta.url);
