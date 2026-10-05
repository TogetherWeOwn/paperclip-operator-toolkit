import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    environment: "node",
    // no results cache. node_modules resolves through a
    // root-owned shared install, so the default
    // `node_modules/.vite/vitest/results.json` write dies EACCES even when
    // every test passes. The suite scores from process exit, never from the
    // cache; CI (writable workspace) is unaffected either way.
    cache: false,
  },
});
