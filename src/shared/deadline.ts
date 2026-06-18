/**
 * withDeadline — reject if `p` does not settle within `ms`, with an actionable message built lazily by
 * `onTimeout` (so the hint can fold in whatever the caller learned while waiting). Attach/connect steps in a
 * debugger client must never wait forever: a target that accepts the socket but never speaks the protocol
 * (e.g. a port that is open but is not a DevTools endpoint, or a target mid-crash) would otherwise hang
 * with no output. This converts that silent stall into a fast, diagnosable failure.
 *
 * The original `p` keeps its own settle handlers attached, so a late rejection after the deadline fired is
 * already handled (no unhandled-rejection noise) and simply becomes a no-op on the settled outer promise.
 */
export function withDeadline<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(onTimeout())), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** DeadlineError — distinguishes a withDeadline timeout from the underlying op's own rejection. */
export class DeadlineError extends Error {
  constructor(message: string) { super(message); this.name = "DeadlineError"; }
}
