import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JourneyRunner, type Step, type StepResult } from "../../engine/JourneyRunner.js";
import { Screencaster } from "../../engine/Screencaster.js";
import { Recorder } from "../../engine/Recorder.js";
import { BreakpointResolver } from "../../engine/BreakpointResolver.js";

export interface JourneyRequest {
  port: number;
  steps: Step[];
  out?: string;
  match?: string;
  width?: number;
  height?: number;
  breakpoints?: string[];
  root?: string;
  exprs?: string[];
  frames?: number;
  maxHits?: number;
  sessionId?: string;
}

export interface JourneyResult {
  ok: boolean;
  recording?: string;
  traced: boolean;
  hits: number;
  finalUrl?: string;
  frames: number;
  steps: StepResult[];
}

/**
 * JourneyCommand — records a scripted UI journey across one or more tabs as a single motion screencast.
 * Sibling to DynamicCommand: where `dynamic` traces what *code* runs behind one navigation, `journey`
 * captures what a *user* sees clicking through a flow (e.g. Pulse → Impersonate → the patient app → results).
 * With `--bp`, it also captures breakpoint hits during the flow and lays the trace panel beside the screen.
 */
export class JourneyCommand {
  /** Parse a `--step` string: `action`, `action:arg`, or `type:<selector>=<text>`. */
  static parseStep(raw: string): Step {
    const colon = raw.indexOf(":");
    const action = (colon === -1 ? raw : raw.slice(0, colon)).trim() as Step["action"];
    const rest = colon === -1 ? "" : raw.slice(colon + 1);
    if (action === "type") {
      const eq = rest.indexOf("=");
      return { action, arg: eq === -1 ? rest : rest.slice(0, eq), value: eq === -1 ? "" : rest.slice(eq + 1) };
    }
    return rest ? { action, arg: rest } : { action };
  }

  async run(req: JourneyRequest): Promise<JourneyResult> {
    const sessionId = req.sessionId ?? randomUUID();
    const out = req.out ?? join(tmpdir(), `journey-${sessionId}.mp4`);
    const cast = new Screencaster({ width: req.width, height: req.height });
    const bps = req.breakpoints?.length ? BreakpointResolver.resolveAll(req.breakpoints, req.root) : [];
    const trace = bps.length
      ? { bps, root: req.root, exprs: req.exprs ?? [], frames: req.frames ?? 6, maxHits: req.maxHits ?? 30 }
      : undefined;
    const runner = new JourneyRunner(req.port, cast, trace);
    let steps: StepResult[] = [];
    try {
      await runner.start(req.match);
      steps = await runner.run(req.steps);
    } finally {
      await cast.stop().catch(() => {});
      runner.close();
    }
    const frames = cast.frameCount();
    const recording = (runner.traced.length
      ? await Recorder.renderJourney(cast.frames(), runner.traced, out).catch(() => null)
      : await cast.render(out).catch(() => null)) ?? undefined;
    return { ok: steps.every((s) => s.ok), recording, traced: runner.traced.length > 0, hits: runner.traced.length, finalUrl: runner.finalUrl, frames, steps };
  }

  render(r: JourneyResult): string {
    const lines = [`journey — ${r.steps.length} steps, ${r.frames} frames${r.traced ? `, ${r.hits} breakpoint hits` : ""}${r.ok ? "" : " — SOME STEPS FAILED"}`];
    for (const s of r.steps) lines.push(`  ${s.ok ? "✓" : "✗"} #${s.seq} ${s.step}${s.note ? "  ⟂ " + s.note : ""}  (+${s.t}ms)`);
    if (r.finalUrl) lines.push(`final url: ${r.finalUrl}`);
    lines.push(r.recording ? `recording → ${r.recording}${r.traced ? " (screen + trace panel)" : ""}` : "recording → (no frames captured)");
    return lines.join("\n");
  }
}
