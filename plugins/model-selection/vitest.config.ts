import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    environment: "node",
    // No results cache. node_modules resolves through a
    // root-owned shared install (package-root symlink chain), so the default
    // `node_modules/.vite/vitest/results.json` write dies EACCES even when
    // every test passes. The suites score from process exit, never from the
    // cache; CI (writable workspace) is unaffected either way.
    cache: false,
  },
});
