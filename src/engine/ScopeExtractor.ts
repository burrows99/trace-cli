import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// typescript ships CommonJS; load it through createRequire so it works under NodeNext ESM (same as SourceMaps).
const ts: typeof import("typescript") = require("typescript");

/**
 * ScopeExtractor — recovers the in-scope variable names at a breakpoint *statically*, from the generated
 * source the runtime actually executes. This is what lets a non-pausing logpoint capture "all locals"
 * automatically: a paused frame can enumerate its scope chain, but a logpoint condition can only reference
 * names it was given — so we parse the enclosing function and hand it the list.
 *
 * Names returned are everything visible at the target offset: parameters of every enclosing function, plus
 * variable/function/class/loop/catch bindings declared *before* the breakpoint inside an enclosing scope.
 * (Block-scoped `let`/`const` declared after the line are omitted — they'd be in the temporal dead zone and
 * throw on reference.) Destructuring patterns are flattened to their leaf identifiers. Minified code yields
 * mangled names (`a`,`e`,`t`) — correct, just not useful; that's the one degraded case.
 */
export class ScopeExtractor {
  /** In-scope identifier names at (line1, column0) of `source`. Best-effort: returns [] on a parse failure. */
  static inScopeNames(source: string, line1: number, column0: number): string[] {
    try {
      const sf = ts.createSourceFile("bp.js", source, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
      const target = Math.max(0, Math.min(source.length, ts.getPositionOfLineAndCharacter(sf, line1 - 1, column0)));
      const node = ScopeExtractor.#nodeAt(sf, target);
      if (!node) return [];
      const ancestors = new Set<import("typescript").Node>();
      for (let n: import("typescript").Node | undefined = node; n; n = n.parent) ancestors.add(n);

      const names = new Set<string>();
      const visit = (n: import("typescript").Node): void => {
        // A parameter is in scope for its whole function body — include it whenever that function encloses
        // the target, regardless of position.
        if (ts.isParameter(n) && n.parent && ancestors.has(n.parent)) ScopeExtractor.#collectBindingNames(n.name, names);
        else if (ScopeExtractor.#isDeclaration(n) && n.getStart(sf) < target && ScopeExtractor.#enclosingScopeInAncestors(n, ancestors)) {
          ScopeExtractor.#collectDeclNames(n, names);
        }
        n.forEachChild(visit);
      };
      visit(sf);
      names.delete("arguments");
      return [...names];
    } catch {
      return [];
    }
  }

  /** The deepest node whose span contains `pos`. */
  static #nodeAt(sf: import("typescript").Node, pos: number): import("typescript").Node | null {
    let found: import("typescript").Node | null = null;
    const walk = (n: import("typescript").Node): void => {
      if (pos >= n.getStart(sf as import("typescript").SourceFile) && pos <= n.getEnd()) {
        found = n;
        n.forEachChild(walk);
      }
    };
    sf.forEachChild(walk);
    return found;
  }

  static #isDeclaration(n: import("typescript").Node): boolean {
    return ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isBindingElement(n) || ts.isCatchClause(n);
  }

  /**
   * True if this declaration's owning scope is an enclosing *function* on the path to the target — i.e. it's
   * one of the target's own function-body locals, not a sibling-function local. Module/global-scope
   * declarations are excluded (they'd bury the real locals under every top-level import/const/function);
   * this mirrors the old pausing engine, which only surfaced `local`/`block`/`catch` scopes.
   */
  static #enclosingScopeInAncestors(n: import("typescript").Node, ancestors: Set<import("typescript").Node>): boolean {
    for (let p: import("typescript").Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isFunctionLike(p)) return ancestors.has(p);
      if (ts.isSourceFile(p)) return false; // module/global scope — exclude
    }
    return false;
  }

  static #collectDeclNames(n: import("typescript").Node, out: Set<string>): void {
    if (ts.isCatchClause(n)) { if (n.variableDeclaration) ScopeExtractor.#collectBindingNames(n.variableDeclaration.name, out); return; }
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) { out.add(n.name.text); return; }
    if (ts.isVariableDeclaration(n) || ts.isBindingElement(n)) ScopeExtractor.#collectBindingNames(n.name, out);
  }

  /** Flatten a binding name — a plain identifier, or an object/array destructuring pattern — to leaf names. */
  static #collectBindingNames(name: import("typescript").BindingName, out: Set<string>): void {
    if (ts.isIdentifier(name)) { out.add(name.text); return; }
    for (const el of name.elements) {
      if (ts.isOmittedExpression(el)) continue;
      ScopeExtractor.#collectBindingNames(el.name, out);
    }
  }
}
