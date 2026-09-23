#!/usr/bin/env node
// TOG-811 -- a stand-in for the Caddy lane, for acceptance_insight_lane_selftest.sh.
//
// This is NOT a second implementation of the containment policy to be trusted.
// It exists so the acceptance suite can be watched going RED, one control at a
// time, before an operator ever runs it against the real edge. The real control
// is Caddyfile.snippet; this file's only job is to be breakable.
//
// It serves BOTH names the suite talks to, on one port, discriminated by the
// Host header -- the same way Caddy discriminates vhosts:
//   lane   -> the bearer-terminated read-only lane   (block B)
//   public -> the general CLIProxy vhost             (block A)
//
// MUTATIONS, via the MUTATE env var. Each removes exactly ONE control, and the
// suite must go red in exactly the named section:
//   none            baseline, everything correct
//   www-auth        add a WWW-Authenticate header to the 401   -> section 1
//   authfiles       let /v0/management/auth-files through      -> section 2
//   verbs           accept POST/PUT/DELETE on the lane path    -> section 3
//   public-open     public /v0/management/* answers 401        -> section 4
//   dead            refuse everything, including the baseline  -> abort, not pass
//
// `dead` is the important one. It is not a control being removed -- it is the
// whole lane being down, which refuses every negative assertion and would score
// a perfect run on any suite that forgot its baseline.
import { createServer } from "node:http";

const MUTATE = process.env.MUTATE || "none";
const BEARER = process.env.LANE_BEARER || "test-bearer";
const MGMT = process.env.LANE_MGMT_KEY || "real-management-key";
const LANE_HOST = process.env.LANE_HOST || "lane.test";
const PUBLIC_HOST = process.env.PUBLIC_HOST || "public.test";
const LANE_PATH = process.env.LANE_PATH || "/claude.json";

// Recorded so the self-test can assert the real management key was injected
// toward the origin and never sent back to the client.
const injected = [];

const send = (res, code, body = "", headers = {}) => {
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(body);
};

const server = createServer((req, res) => {
  const host = (req.headers.host || "").split(":")[0];
  const url = new URL(req.url, "http://x");
  const path = url.pathname;

  if (MUTATE === "dead") return send(res, 502, '{"error":"lane down"}');

  // --- Block A: the general public vhost. --------------------------------
  if (host === PUBLIC_HOST) {
    if (path === "/v0/management" || path.startsWith("/v0/management/")) {
      // public-open reproduces the state the CISO measured live on
      // 2026-09-03: CLIProxy itself answering through the public route.
      if (MUTATE === "public-open") {
        return send(res, 401, '{"error":"missing management key"}');
      }
      return send(res, 404, '{"error":"not found"}');
    }
    return send(res, 200, '{"ok":true}');
  }

  // --- Block B: the insight lane. ----------------------------------------
  if (host !== LANE_HOST) return send(res, 404, '{"error":"unknown host"}');

  // 1. Method allowlist, then path allowlist -- both BEFORE the bearer check,
  //    so a scanner cannot map the route space by error code.
  const verbOk = req.method === "GET" || MUTATE === "verbs";
  if (!verbOk) return send(res, 404, '{"error":"not found"}');

  const pathOk =
    path === LANE_PATH ||
    (MUTATE === "authfiles" && path === "/v0/management/auth-files");
  if (!pathOk) return send(res, 404, '{"error":"not found"}');

  // 2. Source restriction is not simulated: the self-test runs over loopback,
  //    where every request has the same source. Section 5 SKIPs there for the
  //    same structural reason it SKIPs on the real host.

  // 3. Lane-key termination: the worker sends the lane key as x-api-key.
  const key = req.headers["x-api-key"] || "";
  if (key !== BEARER) {
    const headers =
      MUTATE === "www-auth" ? { "www-authenticate": 'Bearer realm="cliproxy"' } : {};
    return send(res, 401, "", headers);
  }

  // 4. Origin: the real management key is injected here and only here. The
  //    response body deliberately does not echo it -- if this fixture ever
  //    leaks it to the client, the self-test's leak assertion should catch it.
  injected.push({ path, key: MGMT });
  if (path === "/v0/management/auth-files") {
    return send(res, 200, '{"accounts":["would-be-credentials"]}');
  }
  return send(res, 200, JSON.stringify({ providers: { claude: { used: 1 } } }));
});

server.listen(Number(process.env.LANE_PORT || 0), "127.0.0.1", () => {
  // The self-test reads this line to learn the port.
  process.stdout.write(`LANE_SIM_PORT=${server.address().port}\n`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
