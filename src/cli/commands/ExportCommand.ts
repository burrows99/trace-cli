import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "../../shared/logger.js";
import { CliCommand } from "./CliCommand.js";
import { GraphCommand } from "./GraphCommand.js";
import { DepsCommand } from "./DepsCommand.js";

const log = logger.child({ component: "export" });
const GRAPH_DEPTH = 6; // rooted-mode knob; unused in the repo map but GraphRequest requires it

export interface ExportRequest {
  dir?: string;     // target project root (default: cwd) — also the project the maps are built from
  force?: boolean;  // overwrite an existing export directory (.claude/skills/trace)
}

/** One generated map written into the export directory. `ok` is false when the analysis degraded (page still written). */
export interface ExportedMap { kind: "graph" | "deps"; path: string; ok: boolean }
export interface ExportResult { src: string; dest: string; maps: ExportedMap[] }

/**
 * ExportCommand — provision a project's **export directory** (`<dir>/.claude/skills/trace/`) with everything
 * trace-cli hands off: the bundled `trace` skill (so Claude Code picks it up) AND interactive HTML maps of the
 * project built right then — the whole-repo LSP map (`graph.html`) and the module-import graph (`deps.html`).
 * One command, "get everything." The skill copy is the must-succeed step; each map is best-effort (a failed or
 * empty analysis still writes a page and is reported via `ok`, never aborting the export).
 */
export class ExportCommand extends CliCommand<ExportRequest, ExportResult> {
  static readonly SKILL_NAME = "trace";

  /** Locate the bundled `skills/trace` dir across run modes (dist build, plugin, repo cwd). */
  #resolveSource(): string {
    const candidatePaths = [
      // dist/cli/commands/ExportCommand.js → package root → skills/trace
      fileURLToPath(new URL("../../../skills/trace", import.meta.url)),
      ...(process.env.CLAUDE_PLUGIN_ROOT ? [join(process.env.CLAUDE_PLUGIN_ROOT, "skills", "trace")] : []),
      join(process.cwd(), "skills", "trace"),
    ];
    const foundPath = candidatePaths.find((candidatePath) => existsSync(join(candidatePath, "SKILL.md")));
    if (!foundPath) throw new Error(`bundled '${ExportCommand.SKILL_NAME}' skill not found (looked in: ${candidatePaths.join(", ")})`);
    return foundPath;
  }

  /** Build one HTML map into the export directory; degrade to a written page (ok:false) rather than throwing. */
  async #writeMap(kind: ExportedMap["kind"], exportDir: string, build: () => Promise<{ html: string; ok: boolean }>): Promise<ExportedMap> {
    const path = join(exportDir, `${kind}.html`);
    try {
      const { html, ok } = await build();
      writeFileSync(path, html);
      return { kind, path, ok };
    } catch (error) {
      log.warn(`${kind} map failed`, { err: String((error as Error)?.message ?? error).split("\n")[0] });
      return { kind, path, ok: false };
    }
  }

  async run(request: ExportRequest = {}): Promise<ExportResult> {
    const sourcePath = this.#resolveSource();
    const projectRoot = resolve(request.dir ?? process.cwd());
    const skillsDirectory = join(projectRoot, ".claude", "skills");
    const exportDir = join(skillsDirectory, ExportCommand.SKILL_NAME);
    if (existsSync(exportDir) && !request.force) {
      throw new Error(`${exportDir} already exists — pass --force to overwrite`);
    }

    // 1. the skill (must succeed) — Claude Code discovers it at .claude/skills/trace.
    mkdirSync(skillsDirectory, { recursive: true });
    cpSync(sourcePath, exportDir, { recursive: true, force: true });

    // 2. the maps of THIS project, built into the same export directory (best-effort).
    const maps = [
      await this.#writeMap("graph", exportDir, async () => {
        const trace = await new GraphCommand().run({ repo: true, root: projectRoot, maxDepth: GRAPH_DEPTH });
        return { html: new GraphCommand().renderHtml(trace), ok: trace.ok };
      }),
      await this.#writeMap("deps", exportDir, async () => {
        const command = new DepsCommand();
        const trace = await command.run({ entry: projectRoot, root: projectRoot, args: { entry: projectRoot } });
        return { html: command.renderHtml(trace), ok: trace.ok };
      }),
    ];

    return { src: sourcePath, dest: exportDir, maps };
  }
}
