import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

describe("dependency security maintenance", () => {
  it.each([
    ["source-map-js", "1.2.2"],
    ["fast-uri", "3.1.9"],
    ["vitest", "4.1.12"],
    ["@vitest/expect", "4.1.12"],
    ["@vitest/mocker", "4.1.12"],
    ["@vitest/pretty-format", "4.1.12"],
    ["@vitest/runner", "4.1.12"],
    ["@vitest/snapshot", "4.1.12"],
    ["@vitest/spy", "4.1.12"],
    ["@vitest/utils", "4.1.12"],
    ["vite", "6.4.5"],
    ["esbuild", "0.25.1"],
    ["tinypool", "2.1.2"],
  ])("locks all %s copies at the reviewed patch and installs the top-level copy", (name, version) => {
    const copies = Object.entries(lock.packages).filter(([path]) => path.endsWith(`/node_modules/${name}`) || path === `node_modules/${name}`);
    expect(copies.length).toBeGreaterThan(0);
    for (const [, entry] of copies) {
      expect((entry as { version: string }).version).toBe(version);
    }
    expect(require(`${name}/package.json`).version).toBe(version);
  });

  it("retains the exact host SDK and Tinypool security override", () => {
    const manifest = require("../package.json");
    expect(manifest.dependencies["@paperclipai/plugin-sdk"]).toBe("2026.824.1");
    expect(lock.packages["node_modules/@paperclipai/plugin-sdk"].version).toBe("2026.824.1");
    expect(lock.packages["node_modules/@paperclipai/shared"].version).toBe("2026.824.1");
    expect(lock.packages["node_modules/zod"].version).toBe("3.25.76");
    expect(manifest.overrides.vitest.tinypool).toBe("2.1.2");
    expect(lock.packages["node_modules/tinypool"].version).toBe("2.1.2");
  });

  it("keeps native release-age and lifecycle-script controls enabled", () => {
    const config = readFileSync(new URL("../.npmrc", import.meta.url), "utf8");
    expect(config).toMatch(/^min-release-age=3$/m);
    expect(config).toMatch(/^ignore-scripts=true$/m);
  });
});
