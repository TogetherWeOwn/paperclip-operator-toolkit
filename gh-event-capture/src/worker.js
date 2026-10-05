// Cloudflare Worker entry point. Deliberately thin: it binds D1 and the
// environment to `createApp` and does nothing else, so that everything worth
// testing lives in modules the offline suite can reach.
//
// `WEBHOOK_SECRET` and `QUERY_TOKEN` are Wrangler SECRETS, never `[vars]` in
// `wrangler.toml` — that file is committed. A deploy that forgets them fails
// closed (503) rather than accepting unverified deliveries; see README § Deploy.

import { createApp } from './app.js'
import { createD1Store } from './store-d1.js'

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
    })
    return await app(request)
  },
}
