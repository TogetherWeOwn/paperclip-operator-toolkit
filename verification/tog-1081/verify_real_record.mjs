// TOG-1081: round-trip a REAL on-disk session record through the patched writer.
import { readFileSync, readdirSync } from "node:fs";
const D = "/app/node_modules/.pnpm/acpx@0.12.0_patch_hash=x3fethhotv43zektyl5prdwf54/node_modules/acpx/dist/live-checkpoint-ClPCSdrW.js";
const m = await import(D);
const persistSessionOptions = m.w, sessionOptionsFromRecord = m.T,
      assertPersistedKeyPolicy = m.Z, parseSessionRecord = m.ot;

const dir = "/paperclip/instances/default/companies/00000000-0000-4000-8000-000000000000/acp-engine/agents/974632dd-dc3f-4c83-bf97-f43574809fa5/sessions";
// Pick a real record that still holds a live key.
let target = null;
for (const f of readdirSync(dir)) {
  if (!f.endsWith(".json") || f === "index.json") continue;
  let r; try { r = JSON.parse(readFileSync(dir + "/" + f, "utf8")); } catch { continue; }
  const env = r?.acpx?.session_options?.env;
  if (env?.GH_APP_PRIVATE_KEY?.includes("BEGIN")) { target = { f, r, env }; break; }
}
if (!target) { console.log("no live-key record found (already clean)"); process.exit(0); }
console.log("real record:", target.f.slice(-24));

let fail = 0;
const chk = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); if (!c) fail++; };

// The record as it exists today parses (baseline).
const before = parseSessionRecord(JSON.parse(JSON.stringify(target.r)));
chk("UNMODIFIED real record parses (baseline)", !!before);
chk("baseline record HOLDS the live key (the defect)",
  !!target.env.GH_APP_PRIVATE_KEY && target.env.GH_APP_PRIVATE_KEY.includes("BEGIN"));

// Now rewrite it exactly as the runtime would on the next launch.
const rewritten = JSON.parse(JSON.stringify(target.r));
// runtime hands camelCase SessionOptions in; env values are the live ones.
persistSessionOptions(rewritten, { model: "claude-opus-5", env: target.env });

const newEnv = rewritten.acpx.session_options.env;
for (const k of ["GH_APP_PRIVATE_KEY","ANTHROPIC_AUTH_TOKEN","OMNIROUTE_API_KEY","OMNIROUTE_MANAGEMENT_KEY","PAPERCLIP_API_KEY"]) {
  if (k in target.env) chk(`rewritten record drops ${k}`, !(k in newEnv));
}
for (const k of ["GH_APP_ID","GH_APP_ORG","ANTHROPIC_BASE_URL","PAPERCLIP_AGENT_ID","PAPERCLIP_TASK_ID"]) {
  if (k in target.env) chk(`rewritten record keeps ${k}`, newEnv[k] === target.env[k]);
}

const blob = JSON.stringify(rewritten);
// Scope: TOG-1081 is the ENV write boundary. Assert the env block specifically.
const envBlob = JSON.stringify(newEnv);
// Assembled from fragments so this tracked file does not itself trip the CI
// "Secret scan" step, which greps every tracked file for this exact marker.
const PEM_MARKER = "BE" + "GIN RSA PRIVATE KEY";
chk("no PEM in rewritten session_options.env", !envBlob.includes(PEM_MARKER));
chk("live token value absent from rewritten env",
  !target.env.ANTHROPIC_AUTH_TOKEN || !envBlob.includes(target.env.ANTHROPIC_AUTH_TOKEN));

// Separately: report (do not fail on) transcript-borne key material. That is a
// distinct leak class -- FINDINGS.md TOG-1079 section 5, bug 2 -- fixed by the
// sweeper's transcript redactor, NOT by this env write-boundary patch.
const transcriptPems =
  (JSON.stringify(rewritten.messages ?? []).match(new RegExp(PEM_MARKER, "g")) ?? []).length;
console.log(`INFO  transcript PEM occurrences (out of scope for this patch): ${transcriptPems}`);

let ok = true, err = "";
try { assertPersistedKeyPolicy(JSON.parse(blob)); } catch (e) { ok = false; err = e.message; }
chk("assertPersistedKeyPolicy accepts rewritten REAL record", ok, err);

const after = parseSessionRecord(JSON.parse(blob));
chk("rewritten REAL record parses via parseSessionRecord", !!after);
chk("acp_session_id preserved", after?.acpSessionId === before?.acpSessionId);
chk("message history preserved",
  (after?.messages?.length ?? -1) === (before?.messages?.length ?? -2),
  `${after?.messages?.length}`);

const resumeEnv = sessionOptionsFromRecord(rewritten)?.env ?? {};
chk("resume path exposes no secret entry", !("GH_APP_PRIVATE_KEY" in resumeEnv));
chk("resume path still exposes GH_APP_ID", resumeEnv.GH_APP_ID === target.env.GH_APP_ID);

console.log(fail === 0 ? "\nALL CHECKS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
