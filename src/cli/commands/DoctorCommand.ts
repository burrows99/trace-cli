import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { Trace, TraceData } from "../../domain/Trace.js";
import { Diagnostic } from "../../domain/Diagnostic.js";
import { Code } from "../../shared/codes.js";
import { TraceCommand } from "./TraceCommand.js";

const execFileAsync = promisify(execFile);

interface ToolDef { name: string; pillar: string; purpose: string; cmd?: string; args?: string[]; chrome?: boolean; s3?: boolean; db?: boolean; moduleName?: string; }
export interface ToolStatus { name: string; pillar: string; purpose: string; present: boolean; version?: string; }

const TOOLS: ToolDef[] = [
  { name: "node", pillar: "engine", purpose: "Node --inspect (CDP) target", cmd: "node", args: ["--version"] },
  { name: "chrome", pillar: "frontend", purpose: "Chrome target / recording frames", chrome: true },
  { name: "ffmpeg", pillar: "frontend", purpose: "run --record video", cmd: "ffmpeg", args: ["-version"] },
  { name: "rg", pillar: "static", purpose: "static search (ripgrep)", cmd: "rg", args: ["--version"] },
  { name: "lizard", pillar: "static", purpose: "static complexity", cmd: "lizard", args: ["--version"] },
  { name: "tree-sitter", pillar: "static", purpose: "static symbols (AST)", cmd: "tree-sitter", args: ["--version"] },
  { name: "madge", pillar: "static", purpose: "static deps (JS/TS)", cmd: "madge", args: ["--version"] },
  { name: "typescript-language-server", pillar: "static", purpose: "code graph — `trace graph` default LSP server (wraps tsserver)", moduleName: "typescript-language-server" },
  { name: "otel-cli", pillar: "runtime", purpose: "exec spans (OTel)", cmd: "otel-cli", args: ["--version"] },
  { name: "playwright", pillar: "frontend", purpose: "web traces", cmd: "playwright", args: ["--version"] },
  { name: "s3", pillar: "storage", purpose: "upload recordings (S3_ENDPOINT)", s3: true },
  { name: "postgres", pillar: "storage", purpose: "persist sessions (DATABASE_URL) — required for `trace serve`", db: true },
];

/** DoctorCommand — probes every backing tool and reports presence + version, grouped by pillar. */
export class DoctorCommand extends TraceCommand {
  static chromePath(): string | null {
    if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    ];
    return candidates.find((candidatePath) => existsSync(candidatePath)) ?? null;
  }

  async #probe(tool: ToolDef): Promise<ToolStatus> {
    if (tool.s3) {
      const endpoint = process.env.S3_ENDPOINT || process.env.AWS_S3_ENDPOINT;
      return { name: tool.name, pillar: tool.pillar, purpose: tool.purpose, present: !!endpoint, version: endpoint ?? undefined };
    }
    if (tool.db) {
      const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
      // Redact credentials before surfacing the connection string.
      const redactedUrl = databaseUrl?.replace(/\/\/[^@/]*@/, "//***@");
      return { name: tool.name, pillar: tool.pillar, purpose: tool.purpose, present: !!databaseUrl, version: redactedUrl ?? undefined };
    }
    if (tool.chrome) {
      const chromePath = DoctorCommand.chromePath();
      return { name: tool.name, pillar: tool.pillar, purpose: tool.purpose, present: !!chromePath, version: chromePath ?? undefined };
    }
    if (tool.moduleName) {
      // A resolved package dependency (the bundled LSP server), not a CLI on PATH — read its package version.
      try {
        const requireFromHere = createRequire(import.meta.url);
        const packageJson = requireFromHere(`${tool.moduleName}/package.json`);
        return { name: tool.name, pillar: tool.pillar, purpose: tool.purpose, present: true, version: packageJson.version ? `${tool.moduleName} ${packageJson.version}` : "present" };
      } catch {
        return { name: tool.name, pillar: tool.pillar, purpose: tool.purpose, present: false };
      }
    }
    try {
      const { stdout, stderr } = await execFileAsync(tool.cmd!, tool.args!, { timeout: 5000 });
      const version = (stdout || stderr || "").trim().split("\n")[0] || "present";
      return { name: tool.name, pillar: tool.pillar, purpose: tool.purpose, present: true, version };
    } catch {
      return { name: tool.name, pillar: tool.pillar, purpose: tool.purpose, present: false };
    }
  }

  async run(): Promise<Trace> {
    const tools = await Promise.all(TOOLS.map((tool) => this.#probe(tool)));
    const toolVersions: Record<string, string> = {};
    for (const tool of tools) if (tool.present && tool.version) toolVersions[tool.name] = tool.version;
    const diagnostics = tools.filter((tool) => !tool.present).map((tool) => Diagnostic.warn(Code.TOOL_MISSING, `${tool.name} not found — ${tool.purpose} (pillar: ${tool.pillar})`));
    // Missing tools are warnings, never errors — doctor itself always succeeds (ok: true).
    return this.envelope({ command: "doctor", ok: true, data: new TraceData({ tools }), diagnostics, toolVersions });
  }

  render(trace: Trace): string {
    const tools = (trace.data.tools ?? []) as ToolStatus[];
    const pillars = [...new Set(tools.map((tool) => tool.pillar))];
    const lines = ["trace-cli doctor — backing tools"];
    for (const pillar of pillars) {
      lines.push(`\n  ${pillar}`);
      for (const tool of tools.filter((candidateTool) => candidateTool.pillar === pillar)) {
        const statusMark = tool.present ? "✅" : "⚠️ ";
        const versionLabel = tool.present ? (tool.version ? `  ${tool.version}` : "") : "  (missing)";
        lines.push(`    ${statusMark} ${tool.name.padEnd(12)}${versionLabel}`);
      }
    }
    const missingCount = tools.filter((tool) => !tool.present).length;
    lines.push(`\n  ${tools.length - missingCount}/${tools.length} present` + (missingCount ? `, ${missingCount} missing` : ""));
    return lines.join("\n");
  }
}
