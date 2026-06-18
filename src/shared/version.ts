import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

/** The package version, read from package.json at runtime (dist/shared → ../../package.json). */
export const VERSION: string = JSON.parse(
  readFileSync(join(moduleDirectory, "../../package.json"), "utf8"),
).version;
