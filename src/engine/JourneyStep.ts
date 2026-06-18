/**
 * JourneyStep — the journey step vocabulary and its parser, in one lightweight module so the three things
 * that must agree on it can't drift: the {@link parseStep} parser, the input validation (CommandInputs'
 * `StepInput`, which rejects anything outside this set), and the runner's exhaustive switch. Keeping it free
 * of engine/CDP imports lets the CLI validation layer depend on it without pulling the whole tracer.
 */

/** The closed set of actions a `--step` can name. Single source of truth — the agent's full vocabulary. */
export const STEP_ACTIONS = ["goto", "click", "type", "wait", "waitfor", "newtab", "eval"] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

/** Actions whose `arg` is mandatory (a URL / selector / script). `wait` defaults to 1000ms; `newtab` takes none. */
export const STEP_ACTIONS_NEEDING_ARG = new Set<string>(["goto", "click", "type", "waitfor", "eval"]);

export interface Step { action: StepAction; arg?: string; value?: string; }

/**
 * Parse a `--step` string: `action`, `action:arg`, or `type:<selector>=<text>` (split on the first `=`, so the
 * value may contain `=`). The action is NOT validated here — it may be unknown; `StepInput` is the gate that
 * rejects an action outside {@link STEP_ACTIONS}.
 */
export function parseStep(raw: string): Step {
  const colon = raw.indexOf(":");
  const action = (colon === -1 ? raw : raw.slice(0, colon)).trim() as StepAction;
  const rest = colon === -1 ? "" : raw.slice(colon + 1);
  if (action === "type") {
    const eq = rest.indexOf("=");
    return { action, arg: eq === -1 ? rest : rest.slice(0, eq), value: eq === -1 ? "" : rest.slice(eq + 1) };
  }
  return rest ? { action, arg: rest } : { action };
}
