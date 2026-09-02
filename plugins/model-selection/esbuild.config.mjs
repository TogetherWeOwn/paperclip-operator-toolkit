import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: ["@paperclipai/plugin-sdk"],
};

await build({ ...shared, entryPoints: ["src/manifest.ts"], outfile: "dist/manifest.js" });
await build({ ...shared, entryPoints: ["src/worker.ts"], outfile: "dist/worker.js" });

console.log("built dist/manifest.js and dist/worker.js");
