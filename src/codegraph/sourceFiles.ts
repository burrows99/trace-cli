import { readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { findProjectRoot } from "../shared/projectRoot.js";

/** Extensions the bundled TypeScript server understands — the default scan set for a repo map. */
export const DEFAULT_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Directories never worth walking: dependencies, build output, VCS metadata, caches. */
const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".turbo", ".cache",
  "coverage", "vendor", "__pycache__", ".venv", "venv",
]);

/** True if `path` exists and is a directory (false for a file or a missing path — never throws). */
export function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/**
 * Resolve the directory a repo map should cover: a directory is used as-is; anything else (a file, or a marker
 * inside a project) resolves to the nearest project root (tsconfig/package.json/.git ancestor). Absolute path.
 */
export function resolveRepoRoot(path: string): string {
  const absolute = resolve(path);
  return isDirectory(absolute) ? absolute : findProjectRoot(absolute);
}

export interface DiscoverOptions {
  /** Extensions to include (lower-cased on compare). Defaults to {@link DEFAULT_SOURCE_EXTENSIONS}. */
  extensions?: string[];
  /** Stop after this many files — keeps a huge repo bounded; `truncated` reports when the cap was hit. */
  maxFiles: number;
}

export interface Discovery {
  /** Absolute paths to the source files found, in a deterministic (sorted) order. */
  files: string[];
  /** True if the scan stopped at `maxFiles` (more files exist than were returned). */
  truncated: boolean;
}

/**
 * Recursively collect source files under `root`: extension-filtered, skipping dependency/build/VCS directories,
 * hidden entries (dot-files/dirs) and `.d.ts` declaration files (no implementation symbols to map). Deterministic
 * order (directories walked in sorted order) and bounded by `maxFiles`, so a repo map is reproducible and finite.
 */
export function discoverSourceFiles(root: string, options: DiscoverOptions): Discovery {
  const extensions = new Set((options.extensions ?? DEFAULT_SOURCE_EXTENSIONS).map((extension) => extension.toLowerCase()));
  const files: string[] = [];
  let truncated = false;

  const walk = (directory: string): void => {
    if (files.length >= options.maxFiles) { truncated = true; return; }
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue; // hidden files/dirs (.git, .vscode, dot-configs)
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(fullPath);
      } else if (entry.isFile() && !entry.name.endsWith(".d.ts") && extensions.has(extname(entry.name).toLowerCase())) {
        if (files.length >= options.maxFiles) { truncated = true; return; }
        files.push(fullPath);
      }
    }
  };

  walk(resolve(root));
  return { files, truncated };
}
