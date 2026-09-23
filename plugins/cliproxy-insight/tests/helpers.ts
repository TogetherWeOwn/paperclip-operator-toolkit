import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function readFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(here, "fixtures", `${name}.json`), "utf8"));
}

/** A secret-ref shape the picker would actually submit. */
export const SECRET_REF = {
  type: "secret_ref",
  secretId: "11111111-1111-4111-8111-111111111111",
};
