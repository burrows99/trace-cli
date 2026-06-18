import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CliCommand } from "./CliCommand.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

/** SchemaCommand — prints the output JSON Schema (the contract every command's Trace conforms to). */
export class SchemaCommand extends CliCommand<void, string> {
  run(): string {
    return readFileSync(join(moduleDirectory, "../../shared/trace.schema.json"), "utf8");
  }
}
