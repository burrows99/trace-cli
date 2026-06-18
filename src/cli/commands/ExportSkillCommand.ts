import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ExportSkillRequest {
  dir?: string;     // target project root (default: cwd)
  force?: boolean;  // overwrite an existing .claude/skills/trace
}

export interface ExportSkillResult { src: string; dest: string }

/**
 * ExportSkillCommand — copy the bundled `trace` skill into a project's `.claude/skills/trace/`, so Claude
 * Code in that project picks it up automatically. The skill ships with the package (see package.json
 * `files`), so this is a self-install: anyone who has the CLI can drop the skill into their repo without
 * cloning this one. Source resolution tolerates every run mode (compiled dist, plugin install, repo).
 */
export class ExportSkillCommand {
  static readonly SKILL_NAME = "trace";

  /** Locate the bundled `skills/trace` dir across run modes (dist build, plugin, repo cwd). */
  #resolveSource(): string {
    const candidates = [
      // dist/cli/commands/ExportSkillCommand.js → package root → skills/trace
      fileURLToPath(new URL("../../../skills/trace", import.meta.url)),
      ...(process.env.CLAUDE_PLUGIN_ROOT ? [join(process.env.CLAUDE_PLUGIN_ROOT, "skills", "trace")] : []),
      join(process.cwd(), "skills", "trace"),
    ];
    const found = candidates.find((p) => existsSync(join(p, "SKILL.md")));
    if (!found) throw new Error(`bundled '${ExportSkillCommand.SKILL_NAME}' skill not found (looked in: ${candidates.join(", ")})`);
    return found;
  }

  run(req: ExportSkillRequest = {}): ExportSkillResult {
    const src = this.#resolveSource();
    const projectRoot = resolve(req.dir ?? process.cwd());
    const skillsDir = join(projectRoot, ".claude", "skills");
    const dest = join(skillsDir, ExportSkillCommand.SKILL_NAME);
    if (existsSync(dest) && !req.force) {
      throw new Error(`${dest} already exists — pass --force to overwrite`);
    }
    mkdirSync(skillsDir, { recursive: true });
    cpSync(src, dest, { recursive: true, force: true });
    return { src, dest };
  }
}
