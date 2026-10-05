// Cloudflare Worker entry point. Deliberately thin: it binds D1 and the
// environment to `createApp` and does nothing else, so that everything worth
// testing lives in modules the offline suite can reach.
//
// `WEBHOOK_SECRET` and `QUERY_TOKEN` are Wrangler SECRETS, never `[vars]` in
// `wrangler.toml` — that file is committed. A deploy that forgets them fails
// closed (503) rather than accepting unverified deliveries; see README § Deploy.

import { createApp } from './app.js'
import { createD1Store } from './store-d1.js'
import { trustedBridgePolicy, trustedRepositories } from './trusted-policy.js'

// Trusted operator scope, read from the environment on every request so a
// config change takes effect without a redeploy. `BRIDGE_POLICY` is JSON
// `{"trackerPrefix": "...", "agentLogin": "...[bot]"}` and
// `ALLOWED_REPOSITORIES` is a comma-separated `owner/name` list; both are
// Wrangler `[vars]`, committed nowhere. A deploy that forgets them fails
// closed (the request throws) rather than running with a default scope.
function trustedScope(env) {
  let bridgePolicy
  try {
    bridgePolicy = trustedBridgePolicy(JSON.parse(env.BRIDGE_POLICY))
  } catch {
    throw new Error('BRIDGE_POLICY env is missing or invalid')
  }
  const allowedRepositories = trustedRepositories(
    String(env.ALLOWED_REPOSITORIES ?? '').split(',').map((s) => s.trim()).filter(Boolean))
  return { bridgePolicy, allowedRepositories }
}

export default {
  /**
   * @param {Request} request
   * @param {any} env
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    const app = createApp({
      store: createD1Store(env.EVENTS_DB),
      webhookSecret: env.WEBHOOK_SECRET,
      queryToken: env.QUERY_TOKEN,
      ...trustedScope(env),
    })
    return await app(request)
  },
}
