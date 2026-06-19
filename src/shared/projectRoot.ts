import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT_MARKERS = ["tsconfig.json", "jsconfig.json", "package.json", ".git"];

/** Auto-detect the project root from a directory: the nearest self-or-ancestor with a project marker, else `dir`. */
export function findProjectRootFrom(dir: string): string {
  let directory = dir;
  for (;;) {
    if (ROOT_MARKERS.some((marker) => existsSync(join(directory, marker)))) return directory;
    const parentDirectory = dirname(directory);
    if (parentDirectory === directory) return dir; // reached the filesystem root with no marker
    directory = parentDirectory;
  }
}

/** Auto-detect the project root: the nearest ancestor of `file` containing a project marker, else its dir. */
export function findProjectRoot(file: string): string {
  return findProjectRootFrom(dirname(file));
}
