import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: ["@paperclipai/plugin-sdk"],
  // TOG-11793: the manifest declares `run.model.resolve` only in a build made
  // for the fork host. The default artifact installs on a host without the hook.
  define: {
    __MODEL_SELECTION_RUN_RESOLVE__: JSON.stringify(process.env.MODEL_SELECTION_RUN_RESOLVE === "1"),
  },
};

await build({ ...shared, entryPoints: ["src/manifest.ts"], outfile: "dist/manifest.js" });
await build({ ...shared, entryPoints: ["src/worker.ts"], outfile: "dist/worker.js" });

console.log("built dist/manifest.js and dist/worker.js");
