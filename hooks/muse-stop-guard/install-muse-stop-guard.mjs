#!/usr/bin/env node
// Installer for the Muse Stop guard. Operator-run; dry run by default.
//
//   node install-muse-stop-guard.mjs status
//   node install-muse-stop-guard.mjs install                         show the merged settings (dry run)
//   node install-muse-stop-guard.mjs install --apply --i-understand-this-reaches-every-agent
//   node install-muse-stop-guard.mjs uninstall --apply
//
// Flags: --settings <file>   default $HOME/.claude/settings.json (the file every agent on this box reads)
//        --script <file>     default muse-stop-guard.mjs beside this installer
//
// SCOPE. The default settings file is user scope: every claude_local agent reads it. That is
// intentional, because Muse agents do not have a settings file of their own, and it is safe
// because the hook allows every stop unless the run's model is `muse*`. It is still a fleet-wide
// change, so --apply on that file needs the explicit acknowledgement flag, as the dispatch gate
// installer does. Pass --settings to point at a pilot workspace's .claude/settings.json instead.
//
// WHAT IT TOUCHES. One thing: our entry under hooks.Stop. Every other hook event, every other Stop
// entry and every unrelated setting is left as it was; install proves that by comparing the file
// with our entry removed before and after. A settings file that is not valid JSON is refused, never
// overwritten.

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** How we recognise our own entry on re-install and uninstall. */
export const HOOK_MARKER = "muse-stop-guard.mjs";
/** Seconds. Larger than the hook's own 8 s deadline so the hook fails open on time, not the CLI. */
export const HOOK_TIMEOUT_SECONDS = 15;
export const ACK_FLAG = "i-understand-this-reaches-every-agent";

export function hookCommandFor(scriptPath) {
  return `node ${scriptPath}`;
}

const ownsEntry = (entry) =>
  (entry?.hooks ?? []).some((hook) => String(hook?.command ?? "").includes(HOOK_MARKER));

/** Merge our Stop entry in. Pure; re-installing replaces our entry instead of adding a second. */
export function mergeInstall(settings, command) {
  const next = structuredClone(settings ?? {});
  next.hooks ??= {};
  const current = Array.isArray(next.hooks.Stop) ? next.hooks.Stop : [];
  next.hooks.Stop = [
    ...current.filter((entry) => !ownsEntry(entry)),
    { hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }] },
  ];
  return next;
}

/** Remove our entry and any container it leaves empty, so uninstall is byte-comparable with the start. */
export function removeInstall(settings) {
  const next = structuredClone(settings ?? {});
  if (!next.hooks) return next;
  const foreign = (Array.isArray(next.hooks.Stop) ? next.hooks.Stop : []).filter((entry) => !ownsEntry(entry));
  if (foreign.length > 0) next.hooks.Stop = foreign;
  else delete next.hooks.Stop;
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

export function isInstalled(settings) {
  return Array.isArray(settings?.hooks?.Stop) && settings.hooks.Stop.some(ownsEntry);
}

/** A fleet-wide hook must not point into one agent's workspace; the gate would silently die with it. */
export function isAgentOwnedPath(scriptPath) {
  return /[/\\]instances[/\\][^/\\]+[/\\](workspaces|worktrees)[/\\]/.test(resolve(scriptPath));
}

export function isUserScope(settingsFile, home = homedir()) {
  return resolve(settingsFile) === resolve(join(home, ".claude", "settings.json"));
}

/**
 * True when this process looks like an agent run rather than the operator's
 * host shell. A fleet-wide hook entry was once written from an
 * agent-run context, so user-scope --apply refuses here.
 * Tripwire-grade, not a boundary: the real boundary is host file ownership
 * (operator follow-up). `env` is a parameter so the check stays testable.
 */
export function isAgentRunContext(env = process.env) {
  return Boolean(env.PAPERCLIP_RUN_ID || env.PAPERCLIP_AGENT_ID);
}

/** Refusal text when an agent run targets the user-scope file, else null. */
export function agentContextRefusal({ settingsFile, home, agentRun }) {
  if (agentRun && isUserScope(settingsFile, home)) {
    return (
      `${settingsFile} is read by every agent on this box, and this looks like an agent run ` +
      `(PAPERCLIP_RUN_ID/PAPERCLIP_AGENT_ID is set). Fleet-wide hook changes run from the ` +
      `operator/host shell, never from an agent run. Dry run and status still work here.`
    );
  }
  return null;
}

/** Every refusal that must clear before a write. Pure, so each is testable without a real file. */
export function checkApply({ settingsFile, scriptPath, acknowledged, scriptExists, home, agentRun = false }) {
  const problems = [];
  const contextRefusal = agentContextRefusal({ settingsFile, home, agentRun });
  if (contextRefusal) problems.push(contextRefusal);
  if (isUserScope(settingsFile, home) && !acknowledged) {
    problems.push(`${settingsFile} is read by every agent on this box. Re-run with --${ACK_FLAG} if that is the intent.`);
  }
  if (isAgentOwnedPath(scriptPath)) {
    problems.push(`${scriptPath} lives inside one agent's workspace. Copy the package to a shared path and pass --script.`);
  }
  if (!scriptExists) problems.push(`${scriptPath} does not exist; the hook would fail open and guard nothing.`);
  return { ok: problems.length === 0, problems };
}

/** Everything except our own Stop entry, so install/uninstall can prove they touched nothing else. */
export function withoutOurEntry(settings) {
  return removeInstall(settings);
}

function readSettings(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${error.message}); refusing to overwrite it`);
  }
}

function parseArgs(argv) {
  const [command = "status", ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (!rest[i].startsWith("--")) continue;
    const key = rest[i].slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      i += 1;
    }
  }
  return { command, flags };
}

function writeAtomic(file, rendered) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let backup = null;
  if (existsSync(file)) {
    backup = `${file}.pre-muse-stop-guard-${stamp}.bak`;
    copyFileSync(file, backup);
  }
  const temporary = `${file}.muse-stop-guard-tmp`;
  writeFileSync(temporary, rendered, { mode: 0o644 });
  JSON.parse(readFileSync(temporary, "utf8"));
  renameSync(temporary, file);
  return backup;
}

function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const settingsFile = resolve(
    typeof flags.settings === "string" ? flags.settings : join(homedir(), ".claude", "settings.json"),
  );
  const scriptPath = typeof flags.script === "string" ? resolve(flags.script) : join(HERE, "muse-stop-guard.mjs");
  const apply = flags.apply === true;
  const current = readSettings(settingsFile);
  const out = (value) => process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);

  if (command === "status") {
    out({
      settingsFile,
      scope: isUserScope(settingsFile) ? "user" : "project",
      installed: isInstalled(current),
      stopEntries: (current.hooks?.Stop ?? []).length,
      otherHookEvents: Object.keys(current.hooks ?? {}).filter((event) => event !== "Stop"),
      script: scriptPath,
      scriptExists: existsSync(scriptPath),
      killSwitchPresent: existsSync(join(dirname(scriptPath), "DISABLED")),
    });
    return;
  }

  if (command !== "install" && command !== "uninstall") {
    process.stderr.write(`unknown command ${command}; use status, install or uninstall\n`);
    process.exit(2);
  }

  const next = command === "install" ? mergeInstall(current, hookCommandFor(scriptPath)) : removeInstall(current);
  // Prove we changed nothing but our own entry.
  if (JSON.stringify(withoutOurEntry(next)) !== JSON.stringify(withoutOurEntry(current))) {
    throw new Error("refusing to write: the merge would change something other than our own Stop entry");
  }
  const rendered = `${JSON.stringify(next, null, 2)}\n`;

  if (!apply) {
    out(rendered);
    process.stderr.write(`dry run: nothing written to ${settingsFile}; add --apply to write it\n`);
    return;
  }

  if (command === "install") {
    const verdict = checkApply({
      settingsFile,
      scriptPath,
      acknowledged: flags[ACK_FLAG] === true,
      scriptExists: existsSync(scriptPath),
      home: homedir(),
      agentRun: isAgentRunContext(),
    });
    if (!verdict.ok) {
      for (const problem of verdict.problems) process.stderr.write(`refused: ${problem}\n`);
      process.exit(1);
    }
  }

  const backup = writeAtomic(settingsFile, rendered);
  const verified = readSettings(settingsFile);
  if (isInstalled(verified) !== (command === "install")) {
    throw new Error(`${command} did not survive settings read-back; restore ${backup ?? "the original"}`);
  }
  out({ [command === "install" ? "installed" : "uninstalled"]: settingsFile, backup });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
