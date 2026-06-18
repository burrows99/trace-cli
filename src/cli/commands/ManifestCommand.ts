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

  #command(command: Command): ManifestCommandNode {
    return {
      name: command.name(),
      aliases: command.aliases(),
      description: command.description(),
      usage: command.usage(),
      arguments: command.registeredArguments.map((argument) => this.#argument(argument)),
      options: command.options.filter((option) => !option.hidden).map((option) => this.#option(option)),
      commands: command.commands.map((subcommand) => this.#command(subcommand)),
    };
  }

  #option(option: Option): ManifestOption {
    const manifestOption: ManifestOption = {
      flags: option.flags,
      description: option.description,
      required: option.required,
      optional: option.optional,
      variadic: option.variadic,
      negate: option.negate,
    };
    if (option.defaultValue !== undefined) manifestOption.default = option.defaultValue;
    if (option.argChoices) manifestOption.choices = option.argChoices;
    if (option.envVar) manifestOption.envVar = option.envVar;
    return manifestOption;
  }

  #argument(argument: Argument): ManifestArgument {
    const manifestArgument: ManifestArgument = {
      name: argument.name(),
      description: argument.description,
      required: argument.required,
      variadic: argument.variadic,
    };
    if (argument.defaultValue !== undefined) manifestArgument.default = argument.defaultValue;
    if (argument.argChoices) manifestArgument.choices = argument.argChoices;
    return manifestArgument;
  }
}
