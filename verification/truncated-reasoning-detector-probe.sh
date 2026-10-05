#!/usr/bin/env bash
# Does OmniRoute's non-stream detector 502 a valid truncated
# reasoning response?
#
# WHY THIS IS A SCRIPT AND NOT A PARAGRAPH
#
# This probe was written against omniroute@3.8.49 and asserts two gaps in
# `detectMalformedNonStream` (open-sse/utils/diagnostics.ts). Between the
# writing and the fix, **3.8.50 was published (2026-08-28)** and it changes
# exactly this function. Re-deciding that by eye, per run, is how an earlier
# finding drifted in the first place. This runs the REAL shipped function from
# whichever versions you name and prints a table.
#
# It never modifies a shipped byte and it never touches live omniroute: the
# package is fetched from the registry into a temp dir and the exported
# function is imported and called directly. No network to the gateway, no key,
# no management surface. Safe to run from any agent container.
#
# THE ONE TRICK IN HERE
#
# The package ships unminified TypeScript whose imports use the `@/` alias and
# extensionless relative specifiers. Node 24 strips types natively but resolves
# neither, so a resolver hook maps `@/x` -> `<pkg>/src/x` and appends the right
# extension. The hook only RESOLVES; it rewrites no source.
#
# Usage:
#   verification/truncated-reasoning-detector-probe.sh [version ...]   # default: 3.8.49 3.8.50
#
# Exit 0 = every named version behaved as this script's expectations say.
# Exit 1 = at least one version disagreed -> read the table, then update the
#          expectations here in the same commit that explains why.

set -uo pipefail

VERSIONS=("$@")
if [ ${#VERSIONS[@]} -eq 0 ]; then VERSIONS=(3.8.49 3.8.50); fi

command -v node >/dev/null || { echo "FATAL: node not found"; exit 2; }
command -v npm  >/dev/null || { echo "FATAL: npm not found";  exit 2; }

# Node >= 22.6 for --experimental-strip-types.
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "FATAL: node >= 22.6 required for --experimental-strip-types (have $(node --version))"
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK" || exit 2

# ---------------------------------------------------------------- resolver --
cat > loader.mjs <<'EOF'
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
const SRC = pathToFileURL(`${process.env.PKG_ROOT}/src/`).href;
const addExt = (u) => {
  if (/\.(ts|mts|js|mjs|json)$/.test(u)) return u;
  for (const e of [".ts", ".mts", ".js", "/index.ts"]) {
    if (existsSync(new URL(u + e))) return u + e;
  }
  return u + ".ts";
};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith("@/")) return { url: addExt(SRC + spec.slice(2)), shortCircuit: true };
  if (spec.startsWith(".") && !/\.(ts|mts|js|mjs|json)$/.test(spec)) {
    return { url: addExt(new URL(spec, ctx.parentURL).href), shortCircuit: true };
  }
  return next(spec, ctx);
}
EOF

cat > register.mjs <<'EOF'
import { register } from "node:module";
import { pathToFileURL } from "node:url";
register("./loader.mjs", pathToFileURL(`${process.cwd()}/`));
EOF

# ------------------------------------------------------------------- probe --
# Expectations encode the CORRECT behaviour, not any one version's behaviour.
# A truncated reasoning-only completion is a valid 200. A genuinely empty
# terminal completion is still a 502.
cat > probe.mjs <<'EOF'
const { detectMalformedNonStream } = await import(
  `${process.env.PKG_ROOT}/open-sse/utils/diagnostics.ts`
);

const mk = (msg, finish) => ({
  id: "x", object: "chat.completion", model: "openrouter/openai/gpt-oss-20b",
  choices: [{ index: 0, message: { role: "assistant", ...msg }, finish_reason: finish }],
});

// [label, body, expected]  expected null = HTTP 200, "empty_choices" = HTTP 502
const CASES = [
  ["A  reasoning (OpenRouter field name)", mk({ content: "",   reasoning: "We must say ok." },              "length"), null],
  ["A  reasoning_content (legacy name)",   mk({ content: "",   reasoning_content: "We must say ok." },      "length"), null],
  ["A  reasoning_details[] only",          mk({ content: "",   reasoning_details: [{ type: "t", text: "x" }] }, "length"), null],
  ["A  reasoning + content:null",          mk({ content: null, reasoning: "We must say ok." },              "length"), null],
  ["B  no reasoning field at all",         mk({ content: "" },                                              "length"), null],
  ["R  normal text",                       mk({ content: "ok" }),                                                      null],
  ["R  genuinely empty, terminal stop",    mk({ content: "" },                                              "stop"),   "empty_choices"],
  ["R  tool_calls turn",                   mk({ content: "", tool_calls: [{ id: "1" }] },                   "tool_calls"), null],
];

let bad = 0;
for (const [label, body, want] of CASES) {
  const got = detectMalformedNonStream(body);
  const ok = got === want;
  if (!ok) bad++;
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${label.padEnd(38)} -> HTTP ${got === null ? "200" : "502"}` +
    (ok ? "" : `  (expected HTTP ${want === null ? "200" : "502"})`)
  );
}
process.exit(bad === 0 ? 0 : 1);
EOF

# ------------------------------------------------------------------- drive --
echo "detectMalformedNonStream against a truncated reasoning response"
echo "A = reasoning field-name gap   B = missing finish_reason:\"length\" exemption"
echo "R = regression control (must not change)"
echo

rc=0
for v in "${VERSIONS[@]}"; do
  echo "=== omniroute@$v ==="
  tb=$(npm view "omniroute@$v" dist.tarball 2>/dev/null)
  if [ -z "$tb" ]; then echo "  FATAL: no tarball for $v (unpublished?)"; rc=2; continue; fi
  mkdir -p "x$v"
  if ! curl -fsSL --max-time 300 "$tb" | tar xz -C "x$v" 2>/dev/null; then
    echo "  FATAL: fetch/extract failed for $v"; rc=2; continue
  fi
  export PKG_ROOT="$WORK/x$v/package"
  [ -f "$PKG_ROOT/open-sse/utils/diagnostics.ts" ] || {
    echo "  FATAL: diagnostics.ts absent — package layout changed"; rc=2; continue; }
  node --experimental-strip-types --import ./register.mjs probe.mjs \
    2>&1 | grep -vE 'ExperimentalWarning|Use `node --trace'
  [ "${PIPESTATUS[0]}" -ne 0 ] && rc=1
  echo
done

if [ "$rc" -eq 0 ]; then
  echo "RESULT: every named version returns HTTP 200 for a truncated reasoning response."
else
  echo "RESULT: at least one version still 502s a valid truncated reasoning response (rc=$rc)."
fi
exit "$rc"
