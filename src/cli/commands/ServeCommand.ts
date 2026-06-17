import { Collector } from "../../collector/Collector.js";
import { FileSessionStore } from "../../collector/FileSessionStore.js";

/** ServeCommand — runs the collector + realtime UI (a long-lived process). */
export class ServeCommand {
  run(opts: { port?: number; host?: string; dataDir?: string } = {}): void {
    const dataDir = opts.dataDir ?? process.env.TRACE_DATA ?? ".trace-data";
    new Collector(new FileSessionStore(dataDir), dataDir).listen({ port: opts.port, host: opts.host });
    // the listening server keeps the process alive — no exit here.
  }
}
