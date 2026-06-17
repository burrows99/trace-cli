// `trace doctor` — probe every backing tool the CLI can orchestrate and report presence + version.
// Each subcommand degrades with a TOOL_MISSING diagnostic rather than crashing; doctor is the one-shot
// view of what's installed, grouped by pillar.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { makeEnvelope } from "../schema/envelope.js";
import { s3Configured } from "../storage/s3.js";

const pexec = promisify(execFile);

// name, cmd+args to get a version, the pillar it serves, and what it's for.
const TOOLS = [
  { name: "node",        pillar: "engine",   purpose: "Node --inspect (CDP) target",  cmd: "node",    args: ["--version"] },
  { name: "python3",     pillar: "engine",   purpose: "Python (DAP) target",          cmd: "python3", args: ["--version"] },
  { name: "debugpy",     pillar: "engine",   purpose: "Python DAP adapter",           cmd: "python3", args: ["-c", "import debugpy,sys;sys.stdout.write(debugpy.__version__)"] },
  { name: "chrome",      pillar: "frontend", purpose: "Chrome remote-debugging target / recording frames", chrome: true },
  { name: "ffmpeg",      pillar: "frontend", purpose: "dynamic --record video",       cmd: "ffmpeg",  args: ["-version"] },
  { name: "rg",          pillar: "static",   purpose: "static search (ripgrep)",      cmd: "rg",      args: ["--version"] },
  { name: "lizard",      pillar: "static",   purpose: "static complexity",            cmd: "lizard",  args: ["--version"] },
  { name: "tree-sitter", pillar: "static",   purpose: "static symbols (AST)",         cmd: "tree-sitter", args: ["--version"] },
  { name: "madge",       pillar: "static",   purpose: "static deps (JS/TS)",          cmd: "madge",   args: ["--version"] },
  { name: "otel-cli",    pillar: "runtime",  purpose: "exec spans (OTel)",            cmd: "otel-cli", args: ["--version"] },
  { name: "playwright",  pillar: "frontend", purpose: "web traces",                   cmd: "playwright", args: ["--version"] },
  { name: "s3",          pillar: "storage",  purpose: "upload recordings (S3_ENDPOINT)", s3: true },
];

// chromePath() → an installed Chrome/Chromium binary path, or null. Honors $CHROME_BIN.
export function chromePath() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

async function probe(t) {
  if (t.s3) {
    const ep = process.env.S3_ENDPOINT || process.env.AWS_S3_ENDPOINT;
    return { name: t.name, pillar: t.pillar, purpose: t.purpose, present: s3Configured(), version: ep || undefined };
  }
  if (t.chrome) {
    const p = chromePath();
    return { name: t.name, pillar: t.pillar, purpose: t.purpose, present: !!p, version: p || undefined };
  }
  try {
    const { stdout, stderr } = await pexec(t.cmd, t.args, { timeout: 5000 });
    const version = (stdout || stderr || "").trim().split("\n")[0] || "present";
    return { name: t.name, pillar: t.pillar, purpose: t.purpose, present: true, version };
  } catch {
    return { name: t.name, pillar: t.pillar, purpose: t.purpose, present: false };
  }
}

// runDoctor(args) → envelope. data.tools[] = { name, pillar, purpose, present, version? }.
export async function runDoctor(args = {}) {
  const startedAtMs = performance.now();
  const tools = await Promise.all(TOOLS.map(probe));
  const toolVersions = Object.fromEntries(tools.filter((t) => t.present && t.version).map((t) => [t.name, t.version]));
  const diagnostics = tools.filter((t) => !t.present)
    .map((t) => ({ level: "warn", code: "TOOL_MISSING", message: `${t.name} not found — ${t.purpose} (pillar: ${t.pillar})` }));
  return makeEnvelope({ command: "doctor", target: null, data: { tools }, args, diagnostics, startedAtMs, toolVersions });
}

// renderDoctor(env) → a compact human table grouped by pillar.
export function renderDoctor(env) {
  const tools = env.data.tools;
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
