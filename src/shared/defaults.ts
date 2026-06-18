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

/**
 * Chrome: idle wait budget AFTER the page's `load` event, before we stop capturing. Sized to outlast a
 * data-driven render — an SPA route that paints, then fetches (e.g. a backend that round-trips an upstream
 * API for several seconds) and only mounts the real content once that resolves. Too small and the capture
 * (and the screencast) stop on the loading spinner, missing both the breakpoint and the rendered result.
 */
export const DEFAULT_POST_LOAD_IDLE_MS = 6000;
