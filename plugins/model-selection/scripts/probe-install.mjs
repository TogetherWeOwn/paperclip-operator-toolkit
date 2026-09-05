#!/usr/bin/env node
// Probe whether togetherweown.model-selection is installed, and in which mode.
//
// Why this exists (TOG-813): a bare 404 from the plugin API is ambiguous. The host
// returns 404 for BOTH "plugin not installed" and "plugin installed but exposes no
// scoped API routes", and it does so BEFORE auth -- so an unauthenticated caller sees
// the same status as an authorized one. The only reliable discriminator is the error
// *string*, which differs per failure stage in server/src/routes/plugins.ts:
//
//   "Plugin not found"                          -> resolution failed  => NOT installed
//   "Plugin does not expose scoped API routes"  -> resolved OK        => installed
//   503 / 2xx / other                           -> resolved OK        => installed
//
// Controls are probed on every run so the discriminator is re-proven, not assumed.
//
// Usage: node scripts/probe-install.mjs
// Env:   PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID
// Exit:  0 = installed, 1 = not installed, 2 = probe inconclusive / harness error

const BASE = String(process.env.PAPERCLIP_API_URL || "")
  .replace(/\/$/, "")
  .replace(/\/api$/, "");
const KEY = process.env.PAPERCLIP_API_KEY;
const COMPANY = process.env.PAPERCLIP_COMPANY_ID;

const PLUGIN_ID = "togetherweown.model-selection"; // src/constants.ts:1
const ADVISE = "/advise"; // src/manifest.ts:118 -- NOT /invoke (that is paperclip-model-router)

// Known-installed ids, from /paperclip/.paperclip/plugins/package.json. None declare
// apiRoutes, so each must answer "does not expose scoped API routes".
const INSTALLED_CONTROLS = [
  "paperclip-plugin-discord",
  "paperclip-plugin-hindsight",
  "paperclip.exe-dev-sandbox-provider",
];
const ABSENT_CONTROL = "zzz.does-not-exist-probe";

const NOT_FOUND = "Plugin not found";
const NO_ROUTES = "Plugin does not expose scoped API routes";

if (!BASE || !KEY) {
  console.error("FATAL: PAPERCLIP_API_URL and PAPERCLIP_API_KEY must be set");
  process.exit(2);
}

async function probe(pluginId, path = ADVISE) {
  const url = `${BASE}/api/plugins/${pluginId}/api${path}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const text = (await res.text()).slice(0, 400);
    let error = null;
    try {
      error = JSON.parse(text).error ?? null;
    } catch {
      /* non-JSON body is fine; we fall back to status */
    }
    return { status: res.status, error, text };
  } catch (err) {
    return { status: 0, error: `network: ${err.message}`, text: "" };
  }
}

// Resolved means the host got past plugin lookup, whatever it did next.
const isResolved = (r) => !(r.status === 404 && r.error === NOT_FOUND);

async function main() {
  const stamp = new Date().toISOString();
  console.log(`# model-selection install probe @ ${stamp}`);
  console.log(`# base=${BASE}`);
  console.log("");

  const target = await probe(
    PLUGIN_ID,
    COMPANY ? `${ADVISE}?companyId=${COMPANY}` : ADVISE,
  );
  const absent = await probe(ABSENT_CONTROL);
  const installed = [];
  for (const id of INSTALLED_CONTROLS) installed.push([id, await probe(id)]);

  const row = (label, r) =>
    console.log(
      `  ${label.padEnd(42)} HTTP:${String(r.status).padEnd(4)} ${r.error ?? r.text.slice(0, 80)}`,
    );

  console.log("TARGET");
  row(PLUGIN_ID, target);
  console.log("\nCONTROLS (installed, expect: does not expose scoped API routes)");
  for (const [id, r] of installed) row(id, r);
  console.log("\nCONTROL (absent, expect: Plugin not found)");
  row(ABSENT_CONTROL, absent);
  console.log("");

  // Validate the discriminator before trusting the target result.
  const controlsSane =
    absent.status === 404 &&
    absent.error === NOT_FOUND &&
    installed.every(([, r]) => isResolved(r) || r.error === NO_ROUTES);

  if (!controlsSane) {
    console.log(
      "RESULT: INCONCLUSIVE -- controls did not behave as expected; the 404 discriminator does not hold on this host.",
    );
    process.exit(2);
  }

  if (!isResolved(target)) {
    console.log(`RESULT: NOT INSTALLED (${PLUGIN_ID})`);
    console.log("  Target is indistinguishable from the absent control, and");
    console.log("  distinguishable from all installed controls.");
    process.exit(1);
  }

  console.log(`RESULT: INSTALLED (${PLUGIN_ID})`);
  console.log(`  Target resolved: HTTP ${target.status} ${target.error ?? ""}`);
  if (target.status === 503) {
    console.log("  NOTE: 503 = resolved but worker not ready; re-probe shortly.");
  }
  console.log("");
  console.log("  MODE IS NOT VERIFIED BY THIS PROBE. selection.mode defaults to");
  console.log('  "advise" (src/config/schema.ts:27) and is only non-default if the');
  console.log("  operator set plugin_config at install. Confirm mode separately");
  console.log("  against the install record before closing TOG-813 criterion 3.");
  process.exit(0);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(2);
});
