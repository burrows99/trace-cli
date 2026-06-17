// Breakpoint specs: "file:line" (a line number) or "file:<unique substring>" / "file@<substring>".
// A substring is resolved against the on-disk file (relative to --root or cwd, or an absolute path).

import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";

// parseBpSpec(spec) → { file, lineSpec }. Prefers an explicit '@' separator (use it when the substring
// itself contains ':'); otherwise splits on the LAST ':'.
export function parseBpSpec(spec) {
  const at = spec.indexOf("@");
  let file, lineSpec;
  if (at >= 0) { file = spec.slice(0, at); lineSpec = spec.slice(at + 1); }
  else {
    const c = spec.lastIndexOf(":");
    if (c < 0) throw new Error(`bad --bp ${JSON.stringify(spec)} — need file:line or file@substring`);
    file = spec.slice(0, c); lineSpec = spec.slice(c + 1);
  }
  file = file.trim(); lineSpec = lineSpec.trim();
  if (!file || !lineSpec) throw new Error(`bad --bp ${JSON.stringify(spec)} — need file:line or file@substring`);
  return { file, lineSpec };
}

function findLineBySubstring(absFile, substr) {
  const lines = readFileSync(absFile, "utf8").split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(substr)) hits.push(i + 1);
  if (!hits.length) throw new Error(`no line in ${absFile} contains ${JSON.stringify(substr)}`);
  if (hits.length > 1) throw new Error(`${JSON.stringify(substr)} matches ${hits.length} lines (${hits.join(", ")}) in ${absFile} — be more specific`);
  return hits[0];
}

// resolveLine({ file, lineSpec }, root) → a 1-based line number.
export function resolveLine({ file, lineSpec }, root) {
  if (/^\d+$/.test(lineSpec)) return Number(lineSpec);
  const abs = isAbsolute(file) ? file : join(root || process.cwd(), file);
  if (!existsSync(abs)) {
    throw new Error(`--bp "${file}:${lineSpec}" uses a substring but ${abs} is not readable — pass a line number or set --root`);
  }
  return findLineBySubstring(abs, lineSpec);
}

// parseBreakpoints(specs, root) → [{ file, lineSpec, line, raw }]
export function parseBreakpoints(specs, root) {
  return specs.map((s) => { const p = parseBpSpec(s); return { ...p, line: resolveLine(p, root), raw: s }; });
}
