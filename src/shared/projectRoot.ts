import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT_MARKERS = ["tsconfig.json", "jsconfig.json", "package.json", ".git"];

/** Auto-detect the project root: the nearest ancestor of `file` containing a project marker, else its dir. */
export function findProjectRoot(file: string): string {
  const start = dirname(file);
  let dir = start;
  for (;;) {
    if (ROOT_MARKERS.some((m) => existsSync(join(dir, m)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start; // reached the filesystem root with no marker
    dir = parent;
  }
}
