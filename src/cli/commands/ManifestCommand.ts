import type { Argument, Command, Option } from "commander";

import { VERSION } from "../../shared/version.js";
import { CliCommand } from "./CliCommand.js";

/** One option, flattened to the public Commander metadata that defines it. */
export interface ManifestOption {
  flags: string;
  description: string;
  required: boolean; // value mandatory when the flag is present: --x <v>
  optional: boolean; // value optional when present:            --x [v]
  variadic: boolean;
  negate: boolean; // a --no-x boolean toggle
  default?: unknown;
  choices?: string[];
  envVar?: string;
}

/** One positional argument. */
export interface ManifestArgument {
  name: string;
  description: string;
  required: boolean;
  variadic: boolean;
  default?: unknown;
  choices?: string[];
}

/** One command node; `commands` recurses into subcommands so the whole tree is one object. */
export interface ManifestCommandNode {
  name: string;
  aliases: string[];
  description: string;
  usage: string;
  arguments: ManifestArgument[];
  options: ManifestOption[];
  commands: ManifestCommandNode[];
}

export interface Manifest {
  tool: string;
  version: string;
  command: ManifestCommandNode;
}

/**
 * ManifestCommand — emits a deterministic, self-describing JSON of the entire CLI by walking
 * Commander's parsed Command tree, i.e. the SAME `.option()`/`.argument()`/`.command()` definitions
 * that parse argv. It is *generated*, never hand-written: a new flag or subcommand shows up here the
 * moment it's registered, so it can't drift.
 *
 * This is the input-side contract, mirroring `SchemaCommand` (the output-side contract: every Trace).
 * Same pattern as Click's `Context.to_info_dict()`, oclif's `oclif.manifest.json`, and cobra's
 * `doc.GenYamlTree` — the command definition is the single source of truth; the reference is derived.
 *
 * Deterministic: definition order is preserved (no map iteration, no timestamps, no randomness), so a
 * given build always produces byte-identical output.
 */
export class ManifestCommand extends CliCommand<Command, Manifest> {
  run(program: Command): Manifest {
    return { tool: "trace", version: VERSION, command: this.#command(program) };
  }

  #command(cmd: Command): ManifestCommandNode {
    return {
      name: cmd.name(),
      aliases: cmd.aliases(),
      description: cmd.description(),
      usage: cmd.usage(),
      arguments: cmd.registeredArguments.map((a) => this.#argument(a)),
      options: cmd.options.filter((o) => !o.hidden).map((o) => this.#option(o)),
      commands: cmd.commands.map((c) => this.#command(c)),
    };
  }

  #option(o: Option): ManifestOption {
    const out: ManifestOption = {
      flags: o.flags,
      description: o.description,
      required: o.required,
      optional: o.optional,
      variadic: o.variadic,
      negate: o.negate,
    };
    if (o.defaultValue !== undefined) out.default = o.defaultValue;
    if (o.argChoices) out.choices = o.argChoices;
    if (o.envVar) out.envVar = o.envVar;
    return out;
  }

  #argument(a: Argument): ManifestArgument {
    const out: ManifestArgument = {
      name: a.name(),
      description: a.description,
      required: a.required,
      variadic: a.variadic,
    };
    if (a.defaultValue !== undefined) out.default = a.defaultValue;
    if (a.argChoices) out.choices = a.argChoices;
    return out;
  }
}
