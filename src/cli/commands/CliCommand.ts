/**
 * CliCommand — the root of the command hierarchy. Every command the shell (`Cli`) dispatches to is a
 * `CliCommand<Req, Res>`: one testable use-case object with a single entry point, `run(req)`, decoupled from
 * argv parsing and stdout (those live in `Cli`). Most commands are pure (input → result/Trace); a few
 * (e.g. `serve`) are long-lived side effects, hence `Res` can be `void`.
 *
 * `Req`/`Res` are typed per command and default to `void` for the no-input / no-result cases (`doctor`,
 * `schema`, `serve`). Trace-producing commands extend the richer {@link TraceCommand} subclass, which adds
 * the shared envelope-stamping and a `render(trace)` contract; everything else extends this base directly.
 */
export abstract class CliCommand<Req = void, Res = void> {
  abstract run(request: Req): Res | Promise<Res>;
}
