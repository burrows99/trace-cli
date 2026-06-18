import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT_MARKERS = ["tsconfig.json", "jsconfig.json", "package.json", ".git"];

/** Auto-detect the project root: the nearest ancestor of `file` containing a project marker, else its dir. */
export function findProjectRoot(file: string): string {
  const startDirectory = dirname(file);
  let directory = startDirectory;
  for (;;) {
    if (ROOT_MARKERS.some((marker) => existsSync(join(directory, marker)))) return directory;
    const parentDirectory = dirname(directory);
    if (parentDirectory === directory) return startDirectory; // reached the filesystem root with no marker
    directory = parentDirectory;
  }
}
