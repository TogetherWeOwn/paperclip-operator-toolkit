#!/usr/bin/env node
// Single-shot entrypoint. Scheduling/alerts and installation are separate work.
import { pathToFileURL } from 'node:url'
import { loadConsumerConfig } from './consumer-config.js'
import { runProductPass } from './consumer-runner.js'

export async function main(args, { env = process.env, output = (line) => console.log(line),
  load = loadConsumerConfig, pass = runProductPass, signals = process } = {}) {
  if (args.length !== 2 || args[0] !== 'events') {
    output(JSON.stringify({ ok: false, reason: 'usage: consumer-cli.js events /absolute/config.json' }))
    return 2
  }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  signals.on('SIGINT', cancel)
  signals.on('SIGTERM', cancel)
  try {
    const settings = await load(args[1])
    // Only the audit identity is inherited. API keys/origins in an agent shell
    // must never silently become long-lived host service credentials/config.
    const result = await pass({ ...settings, runId: env.PAPERCLIP_RUN_ID ?? null }, { signal: controller.signal })
    output(JSON.stringify(result))
    return result.ok ? 0 : 1
  } catch {
    output(JSON.stringify({ ok: false, reason: 'configuration-or-runner-failed' }))
    return 1
  } finally {
    signals.removeListener('SIGINT', cancel)
    signals.removeListener('SIGTERM', cancel)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
