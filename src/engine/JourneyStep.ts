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
export function parseStep(rawStep: string): Step {
  const colonIndex = rawStep.indexOf(":");
  const action = (colonIndex === -1 ? rawStep : rawStep.slice(0, colonIndex)).trim() as StepAction;
  const rest = colonIndex === -1 ? "" : rawStep.slice(colonIndex + 1);
  if (action === "type") {
    const equalsIndex = rest.indexOf("=");
    return { action, arg: equalsIndex === -1 ? rest : rest.slice(0, equalsIndex), value: equalsIndex === -1 ? "" : rest.slice(equalsIndex + 1) };
  }
  return rest ? { action, arg: rest } : { action };
}
