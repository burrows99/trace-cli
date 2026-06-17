import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { Trace, TraceMeta, TraceData } from "../../domain/Trace.js";
import { Diagnostic } from "../../domain/Diagnostic.js";
import { VERSION } from "../../shared/version.js";

const pexec = promisify(execFile);

interface ToolDef { name: string; pillar: string; purpose: string; cmd?: string; args?: string[]; chrome?: boolean; s3?: boolean; db?: boolean; }
export interface ToolStatus { name: string; pillar: string; purpose: string; present: boolean; version?: string; }

const TOOLS: ToolDef[] = [
  { name: "node", pillar: "engine", purpose: "Node --inspect (CDP) target", cmd: "node", args: ["--version"] },
  { name: "python3", pillar: "engine", purpose: "Python (DAP) target", cmd: "python3", args: ["--version"] },
  { name: "debugpy", pillar: "engine", purpose: "Python DAP adapter", cmd: "python3", args: ["-c", "import debugpy,sys;sys.stdout.write(debugpy.__version__)"] },
  { name: "chrome", pillar: "frontend", purpose: "Chrome target / recording frames", chrome: true },
  { name: "ffmpeg", pillar: "frontend", purpose: "dynamic --record video", cmd: "ffmpeg", args: ["-version"] },
  { name: "rg", pillar: "static", purpose: "static search (ripgrep)", cmd: "rg", args: ["--version"] },
  { name: "lizard", pillar: "static", purpose: "static complexity", cmd: "lizard", args: ["--version"] },
  { name: "tree-sitter", pillar: "static", purpose: "static symbols (AST)", cmd: "tree-sitter", args: ["--version"] },
  { name: "madge", pillar: "static", purpose: "static deps (JS/TS)", cmd: "madge", args: ["--version"] },
  { name: "otel-cli", pillar: "runtime", purpose: "exec spans (OTel)", cmd: "otel-cli", args: ["--version"] },
  { name: "playwright", pillar: "frontend", purpose: "web traces", cmd: "playwright", args: ["--version"] },
  { name: "s3", pillar: "storage", purpose: "upload recordings (S3_ENDPOINT)", s3: true },
  { name: "postgres", pillar: "storage", purpose: "persist sessions (DATABASE_URL) — required for `trace serve`", db: true },
];

/** DoctorCommand — probes every backing tool and reports presence + version, grouped by pillar. */
export class DoctorCommand {
  static chromePath(): string | null {
    if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    ];
    return candidates.find((p) => existsSync(p)) ?? null;
  }

  async #probe(t: ToolDef): Promise<ToolStatus> {
    if (t.s3) {
      const ep = process.env.S3_ENDPOINT || process.env.AWS_S3_ENDPOINT;
      return { name: t.name, pillar: t.pillar, purpose: t.purpose, present: !!ep, version: ep ?? undefined };
    }
    if (t.db) {
      const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
      // Redact credentials before surfacing the connection string.
      const shown = url?.replace(/\/\/[^@/]*@/, "//***@");
      return { name: t.name, pillar: t.pillar, purpose: t.purpose, present: !!url, version: shown ?? undefined };
    }
    if (t.chrome) {
      const p = DoctorCommand.chromePath();
      return { name: t.name, pillar: t.pillar, purpose: t.purpose, present: !!p, version: p ?? undefined };
    }
    try {
      const { stdout, stderr } = await pexec(t.cmd!, t.args!, { timeout: 5000 });
      const version = (stdout || stderr || "").trim().split("\n")[0] || "present";
      return { name: t.name, pillar: t.pillar, purpose: t.purpose, present: true, version };
    } catch {
      return { name: t.name, pillar: t.pillar, purpose: t.purpose, present: false };
    }
  }

  async run(): Promise<Trace> {
    const tools = await Promise.all(TOOLS.map((t) => this.#probe(t)));
    const toolVersions: Record<string, string> = {};
    for (const t of tools) if (t.present && t.version) toolVersions[t.name] = t.version;
    const diagnostics = tools.filter((t) => !t.present).map((t) => Diagnostic.warn("TOOL_MISSING", `${t.name} not found — ${t.purpose} (pillar: ${t.pillar})`));
    return new Trace({
      version: VERSION, command: "doctor", ok: true,
      meta: new TraceMeta({ at: new Date().toISOString(), toolVersions }),
      data: new TraceData({ tools }),
      diagnostics,
    });
  }

  render(trace: Trace): string {
    const tools = (trace.data.tools ?? []) as ToolStatus[];
    const pillars = [...new Set(tools.map((t) => t.pillar))];
    const lines = ["trace doctor — backing tools"];
    for (const pillar of pillars) {
      lines.push(`\n  ${pillar}`);
      for (const t of tools.filter((x) => x.pillar === pillar)) {
        const mark = t.present ? "✅" : "⚠️ ";
        const ver = t.present ? (t.version ? `  ${t.version}` : "") : "  (missing)";
        lines.push(`    ${mark} ${t.name.padEnd(12)}${ver}`);
      }
    }
    const missing = tools.filter((t) => !t.present).length;
    lines.push(`\n  ${tools.length - missing}/${tools.length} present` + (missing ? `, ${missing} missing` : ""));
    return lines.join("\n");
  }
}
