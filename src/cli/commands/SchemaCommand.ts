import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** SchemaCommand — prints the output JSON Schema (the contract every command's Trace conforms to). */
export class SchemaCommand {
  run(): string {
    return readFileSync(join(here, "../../shared/trace.schema.json"), "utf8");
  }
}
