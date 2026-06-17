// CLI layer (commander). Target is Node (--port, default 9229) unless --chrome is given. The trigger is
// --curl (Node) or --url navigate/reload (Chrome). Exit: 0 ok · 1 runtime · 2 usage.

import { Command, CommanderError } from "commander";
import { writeFileSync } from "node:fs";

import { traceNode, traceChrome, checkBreakpoint } from "./trace.js";
import { parseBpSpec } from "./breakpoints.js";
import { renderTrace } from "./render.js";

const int = (v) => parseInt(v, 10);
const collect = (v, acc) => { acc.push(v); return acc; };

function buildProgram() {
  return new Command()
    .name("trace")
    .description("Execution tracer over the Chrome DevTools Protocol — breakpoints + a trigger → a full trace.")
    .version("0.1.0")
    .option("--port <n>", "Node --inspect port (Node target; default 9229)", int)
    .option("--chrome <n>", "Chrome --remote-debugging-port (selects the Chrome target)", int)
    .option("--curl <cmd>", "Node trigger: a curl command run once breakpoints are set")
    .option("--url <url>", "Chrome trigger: page URL to navigate to + reload")
    .option("--bp <file:line>", "breakpoint, repeatable: file:line or file@substring", collect, [])
    .option("--expr <js>", "expression evaluated at every hit, repeatable", collect, [])
    .option("--steps <list>", "step plan at the first hit, e.g. over,into,out")
    .option("--root <dir>", "root for resolving relative --bp files / substrings (default cwd)")
    .option("--frames <n>", "stack frames captured per hit", int, 6)
    .option("--max-hits <n>", "stop after N hits", int, 25)
    .option("--timeout-ms <n>", "per-pause wait timeout", int)
    .option("--req-timeout-ms <n>", "curl trigger timeout, Node target", int, 60000)
    .option("--shot <png>", "Chrome: write a screenshot to this path")
    .option("--json <path>", "write the machine-readable trace JSON")
    .option("--ws <url>", "connect to an explicit CDP WebSocket URL (advanced; skips discovery)")
    .option("--url-match <s>", "pick the target whose URL contains this substring")
    .option("--title-match <s>", "pick the target whose title contains this substring")
    .option("--check", "resolve + verify the first --bp binds, then exit (0 bound · 2 not)")
    .showHelpAfterError("(add --help for usage)");
}

function commonOpts(o) {
  return {
    breakpoints: o.bp, root: o.root, exprs: o.expr,
    steps: (o.steps || "").split(",").map((s) => s.trim()).filter(Boolean),
    frames: o.frames, maxHits: o.maxHits, wsUrl: o.ws, urlMatch: o.urlMatch, titleMatch: o.titleMatch,
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
  };
}

const usage = (msg) => { process.stderr.write(`trace: ${msg}\n`); process.exit(2); };

export async function run(argv = process.argv) {
  const program = buildProgram().exitOverride();
  let o;
  try { program.parse(argv); o = program.opts(); }
  catch (err) {
    if (err instanceof CommanderError) {
      if (["commander.help", "commander.helpDisplayed", "commander.version"].includes(err.code)) process.exit(0);
      process.exit(2);
    }
    throw err;
  }

  const isChrome = o.chrome != null;
  try {
    if (o.check) {
      if (!o.bp.length) usage("--check needs a --bp");
      const { file, lineSpec } = parseBpSpec(o.bp[0]);
      const r = await checkBreakpoint({
        kind: isChrome ? "chrome" : "node", port: isChrome ? o.chrome : (o.port ?? 9229),
        wsUrl: o.ws, url: o.url, file, lineSpec, root: o.root,
      });
      process.stdout.write(`${r.file}:${r.line} → ${r.bound ? "BOUND ✅" : "not bound ⚠"}${r.mapped ? " (mapped)" : ""}${r.scriptUrl ? "  " + r.scriptUrl : ""}\n`);
      process.exit(r.bound ? 0 : 2);
    }

    if (!o.bp.length) usage("need at least one --bp (file:line or file@substring)");

    let result;
    if (isChrome) {
      if (!o.url) usage("Chrome target needs --url");
      result = await traceChrome({ port: o.chrome, url: o.url, shot: o.shot, ...commonOpts(o) });
    } else {
      result = await traceNode({ port: o.port ?? 9229, curl: o.curl, reqTimeoutMs: o.reqTimeoutMs, ...commonOpts(o) });
    }

    if (o.json) writeFileSync(o.json, JSON.stringify(result, null, 2));
    process.stdout.write(renderTrace(result) + "\n");
    if (o.json) process.stderr.write(`[trace] full JSON → ${o.json}\n`);
    process.exit(result.fatal ? 1 : 0);
  } catch (e) {
    process.stderr.write(`trace: ${e?.message || e}\n`);
    process.exit(1);
  }
}
