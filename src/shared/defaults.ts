/**
 * Default ports, viewport and connection budgets shared across the CLI, engine and domain. Centralized so
 * code and the `--help` text that documents these defaults can't silently drift apart.
 */

/** Node `--inspect` default debugger port. */
export const DEFAULT_NODE_PORT = 9229;

/** Chrome `--remote-debugging-port` default. */
export const DEFAULT_CHROME_PORT = 9222;

/** `trace-cli serve` collector default port. */
export const DEFAULT_COLLECTOR_PORT = 4000;

/** Screencast viewport pinned for stable frame dimensions. */
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;

/** Budget for the debugger attach/connect handshake before failing fast. */
export const DEFAULT_ATTACH_TIMEOUT_MS = 8000;
