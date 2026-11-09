import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

describe("dependency security maintenance", () => {
  it("locks and installs the reviewed source-map-js patch, including nested copies", () => {
    const copies = Object.entries(lock.packages).filter(([path]) => path.endsWith("/node_modules/source-map-js") || path === "node_modules/source-map-js");
    expect(copies.length).toBeGreaterThan(0);
    for (const [, entry] of copies) {
      expect((entry as { version: string }).version).toBe("1.2.2");
    }
    expect(require("source-map-js/package.json").version).toBe("1.2.2");
  });

  it("retains the exact host SDK pin", () => {
    expect(require("../package.json").dependencies["@paperclipai/plugin-sdk"]).toBe("2026.824.1");
    expect(lock.packages["node_modules/@paperclipai/plugin-sdk"].version).toBe("2026.824.1");
  });

  it("keeps native release-age and lifecycle-script controls enabled", () => {
    const config = readFileSync(new URL("../.npmrc", import.meta.url), "utf8");
    expect(config).toMatch(/^min-release-age=3$/m);
    expect(config).toMatch(/^ignore-scripts=true$/m);
  });
});
