import { Collector } from "../../collector/Collector.js";
import { createSessionStore } from "../../collector/createSessionStore.js";
import { CliCommand } from "./CliCommand.js";

export interface ServeOptions { port?: number; host?: string; databaseUrl?: string }

/** ServeCommand — runs the collector + realtime UI (a long-lived process), backed by Postgres. */
export class ServeCommand extends CliCommand<ServeOptions, void> {
  run(opts: ServeOptions = {}): void {
    const store = createSessionStore({ databaseUrl: opts.databaseUrl });
    new Collector(store).listen({ port: opts.port, host: opts.host });
    // the listening server keeps the process alive — no exit here.
  }
}
