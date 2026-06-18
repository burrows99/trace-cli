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
      const sourceFile = ts.createSourceFile("bp.js", source, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
      const targetOffset = Math.max(0, Math.min(source.length, ts.getPositionOfLineAndCharacter(sourceFile, line1 - 1, column0)));
      const targetNode = ScopeExtractor.#nodeAt(sourceFile, targetOffset);
      if (!targetNode) return [];
      const ancestors = new Set<import("typescript").Node>();
      for (let ancestorNode: import("typescript").Node | undefined = targetNode; ancestorNode; ancestorNode = ancestorNode.parent) ancestors.add(ancestorNode);

      const names = new Set<string>();
      const visit = (node: import("typescript").Node): void => {
        // A parameter is in scope for its whole function body — include it whenever that function encloses
        // the target, regardless of position.
        if (ts.isParameter(node) && node.parent && ancestors.has(node.parent)) ScopeExtractor.#collectBindingNames(node.name, names);
        else if (ScopeExtractor.#isDeclaration(node) && node.getStart(sourceFile) < targetOffset && ScopeExtractor.#enclosingScopeInAncestors(node, ancestors)) {
          ScopeExtractor.#collectDeclNames(node, names);
        }
        node.forEachChild(visit);
      };
      visit(sourceFile);
      names.delete("arguments");
      return [...names];
    } catch {
      return [];
    }
  }

  /** The deepest node whose span contains `pos`. */
  static #nodeAt(sourceFile: import("typescript").Node, position: number): import("typescript").Node | null {
    let found: import("typescript").Node | null = null;
    const walk = (node: import("typescript").Node): void => {
      if (position >= node.getStart(sourceFile as import("typescript").SourceFile) && position <= node.getEnd()) {
        found = node;
        node.forEachChild(walk);
      }
    };
    sourceFile.forEachChild(walk);
    return found;
  }

  static #isDeclaration(node: import("typescript").Node): boolean {
    return ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isBindingElement(node) || ts.isCatchClause(node);
  }

  /**
   * True if this declaration's owning scope is an enclosing *function* on the path to the target — i.e. it's
   * one of the target's own function-body locals, not a sibling-function local. Module/global-scope
   * declarations are excluded (they'd bury the real locals under every top-level import/const/function);
   * this mirrors the old pausing engine, which only surfaced `local`/`block`/`catch` scopes.
   */
  static #enclosingScopeInAncestors(node: import("typescript").Node, ancestors: Set<import("typescript").Node>): boolean {
    for (let parent: import("typescript").Node | undefined = node.parent; parent; parent = parent.parent) {
      if (ts.isFunctionLike(parent)) return ancestors.has(parent);
      if (ts.isSourceFile(parent)) return false; // module/global scope — exclude
    }
    return false;
  }

  static #collectDeclNames(node: import("typescript").Node, collectedNames: Set<string>): void {
    if (ts.isCatchClause(node)) { if (node.variableDeclaration) ScopeExtractor.#collectBindingNames(node.variableDeclaration.name, collectedNames); return; }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) { collectedNames.add(node.name.text); return; }
    if (ts.isVariableDeclaration(node) || ts.isBindingElement(node)) ScopeExtractor.#collectBindingNames(node.name, collectedNames);
  }

  /** Flatten a binding name — a plain identifier, or an object/array destructuring pattern — to leaf names. */
  static #collectBindingNames(name: import("typescript").BindingName, collectedNames: Set<string>): void {
    if (ts.isIdentifier(name)) { collectedNames.add(name.text); return; }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      ScopeExtractor.#collectBindingNames(element.name, collectedNames);
    }
  }
}
