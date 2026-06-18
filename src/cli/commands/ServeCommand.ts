import { Collector } from "../../collector/Collector.js";
import { createSessionStore } from "../../collector/createSessionStore.js";
import { CliCommand } from "./CliCommand.js";

export interface ServeOptions { port?: number; host?: string; databaseUrl?: string }

/** ServeCommand — runs the collector + realtime UI (a long-lived process), backed by Postgres. */
export class ServeCommand extends CliCommand<ServeOptions, void> {
  run(options: ServeOptions = {}): void {
    const store = createSessionStore({ databaseUrl: options.databaseUrl });
    new Collector(store).listen({ port: options.port, host: options.host });
    // the listening server keeps the process alive — no exit here.
  }
}
