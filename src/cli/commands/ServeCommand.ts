import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliCommand } from "./CliCommand.js";
import { DEFAULT_COLLECTOR_PORT } from "../../shared/defaults.js";
import { logger } from "../../shared/logger.js";

const log = logger.child({ component: "serve" });
const moduleDir = dirname(fileURLToPath(import.meta.url));
// The Next.js standalone dashboard, emitted by the build into dist/dashboard/ (see package.json `build:ui`).
// From dist/cli/commands/ServeCommand.js → dist/dashboard/ui/server.js.
const SERVER_ENTRY = join(moduleDir, "../../dashboard/ui/server.js");

export interface ServeOptions { port?: number; host?: string; databaseUrl?: string }

/**
 * ServeCommand — launches the hosted dashboard: the standalone Next.js server (`ui/`, built to
 * dist/dashboard) that serves the UI + same-origin API (ingest, sessions, SSE), backed by Postgres.
 * It supersedes the old in-process node:http collector. A long-lived side effect — the child keeps the
 * process alive; SIGINT/SIGTERM are forwarded for a clean shutdown.
 */
export class ServeCommand extends CliCommand<ServeOptions, void> {
  run(opts: ServeOptions = {}): void {
    const port = opts.port ?? DEFAULT_COLLECTOR_PORT;
    const host = opts.host ?? "0.0.0.0";
    const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
    if (!databaseUrl) {
      throw new Error(
        "no Postgres connection string — set DATABASE_URL (or POSTGRES_URL), or pass --db.\n" +
        "  e.g. DATABASE_URL=postgres://user:pass@localhost:5432/trace",
      );
    }
    if (!existsSync(SERVER_ENTRY)) {
      throw new Error(`dashboard not built — run \`npm run build\` (expected ${SERVER_ENTRY}).`);
    }

    log.info("starting dashboard", { url: `http://localhost:${port}`, host });
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      stdio: "inherit",
      env: { ...process.env, PORT: String(port), HOSTNAME: host, DATABASE_URL: databaseUrl },
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  }
}
