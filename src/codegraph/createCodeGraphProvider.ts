import type { CodeGraphProvider } from "./CodeGraphProvider.js";
import { LspCodeGraphProvider } from "./LspCodeGraphProvider.js";

/** Known provider ids — the closed set the factory, `--provider`, and `doctor` agree on. */
export const CODEGRAPH_PROVIDERS = ["lsp"] as const;
export type CodeGraphProviderName = (typeof CODEGRAPH_PROVIDERS)[number];

/**
 * createCodeGraphProvider — build a CodeGraphProvider from a name (or env). Mirrors createSessionStore: an
 * explicit switch with a hard, fail-fast error on an unknown id (no silent fallback). The only provider for
 * now is `lsp` (the standard Language Server Protocol call-hierarchy path — what IDEs use); the switch keeps
 * the seam so additional analyzers (e.g. an SCIP indexer) can be added behind the same interface.
 */
export function createCodeGraphProvider(name?: string): CodeGraphProvider {
  const n = (name ?? process.env.TRACE_CODEGRAPH_PROVIDER ?? "lsp").toLowerCase();
  switch (n) {
    case "lsp":
      return new LspCodeGraphProvider();
    default:
      throw new Error(`unknown code-graph provider "${n}" — known: ${CODEGRAPH_PROVIDERS.join(", ")}`);
  }
}
