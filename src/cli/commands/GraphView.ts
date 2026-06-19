import type { Trace } from "../../domain/Trace.js";
import type { CodeGraph, GraphEdge, GraphNode } from "../../codegraph/CodeGraphProvider.js";
import type { DepGraph } from "./DepsCommand.js"; // type-only: no runtime cycle (DepsCommand imports the renderer)

/** Header + stats + truncation note rendered above the graph. */
interface ForceMeta { title: string; h1: string; sub: string; stats: string; truncated?: string }
/** Node/edge payload handed to the inline force layout. `scope` drives node colour (local=blue, external=amber). */
interface ForcePayload {
  entry: string;
  nodes: { id: string; label: string; kind: string; file: string; line: number; scope: string }[];
  edges: { from: string; to: string; weight: number }[];
}

/**
 * GraphView — the human + HTML presentation of a built call/module graph, split out of {@link GraphCommand} and
 * {@link DepsCommand} so each command stays a thin use-case (build the graph, stamp the envelope) and the
 * rendering (a text flow-tree and a self-contained interactive SVG page, ~250 lines of CSS/JS strings) lives on
 * its own. A namespace of pure static renderers — no IO, no instance state — keyed off the graph/trace.
 */
export class GraphView {
  /**
   * Text view: the call graph unrolled into a flow tree, with shared callees, cycles and externals marked. A
   * traversal over the normalized graph — a node reached twice is marked `→ shared` and a back-edge `↻ cycle`
   * rather than re-expanded, so the tree terminates on recursion.
   */
  static tree(graph: CodeGraph): string {
    const nodesById = new Map<string, GraphNode>(graph.nodes.map((node) => [node.id, node]));
    const adjacency = new Map<string, GraphEdge[]>();
    for (const edge of graph.edges) (adjacency.get(edge.from) ?? adjacency.set(edge.from, []).get(edge.from)!).push(edge);

    const root = nodesById.get(graph.entry);
    const headerLines = [
      `graph — ${root?.label ?? graph.entry}  (${root?.location.file}:${root?.location.line})  via ${graph.provider}`,
      `  ${graph.stats.nodes} nodes · ${graph.stats.edges} edges · depth≤${graph.stats.maxDepth}` +
        (graph.stats.external ? ` · ${graph.stats.external} external` : "") +
        (graph.stats.truncated ? " · truncated" : ""),
      "",
    ];

    const lines: string[] = [];
    const onPath = new Set<string>();
    const emitted = new Set<string>();

    const formatLabel = (node: GraphNode, weight?: number): string => {
      const weightSuffix = weight && weight > 1 ? ` ×${weight}` : "";
      if (node.scope !== "local") return `${node.label}  ⊗ ${node.scope}${weightSuffix}`;
      return `${node.label}  ${node.location.file}:${node.location.line}${weightSuffix}`;
    };

    const walk = (id: string, prefix: string, connector: string, weight: number | undefined): void => {
      const node = nodesById.get(id);
      if (!node) return;
      const isCycle = onPath.has(id);
      const children = adjacency.get(id) ?? [];
      const isShared = emitted.has(id) && children.length > 0;
      const tag = isCycle ? "  ↻ cycle" : isShared ? "  → shared" : "";
      lines.push(`${prefix}${connector}${formatLabel(node, weight)}${tag}`);
      if (isCycle || isShared) return; // back-edge / already-expanded: reference only, don't recurse
      emitted.add(id);
      onPath.add(id);
      const childPrefix = connector ? prefix + (connector.startsWith("└") ? "   " : "│  ") : prefix;
      children.forEach((childEdge, index) => {
        const isLast = index === children.length - 1;
        walk(childEdge.to, childPrefix, isLast ? "└─ " : "├─ ", childEdge.weight);
      });
      onPath.delete(id);
    };

    walk(graph.entry, "", "", undefined);
    return headerLines.concat(lines).join("\n");
  }

  /**
   * Text view of a repo map: a per-file outline. Each file is a section; its symbols nest by the `contains`
   * relationship (class → method/field), in source order, and each symbol is annotated with its other edges —
   * `→ calls`, `extends`, `implements`. The structural backbone is containment; calls/inheritance hang off it,
   * so the output reads like a code outline with cross-references rather than a flat call tree.
   */
  static repoMap(graph: CodeGraph): string {
    const nodesById = new Map<string, GraphNode>(graph.nodes.map((node) => [node.id, node]));
    const containment = new Map<string, string[]>();  // parent id → child ids (the `contains` edges)
    const relations = new Map<string, GraphEdge[]>();  // node id → its non-containment outgoing edges
    for (const edge of graph.edges) {
      if (edge.kind === "contains") (containment.get(edge.from) ?? containment.set(edge.from, []).get(edge.from)!).push(edge.to);
      else (relations.get(edge.from) ?? relations.set(edge.from, []).get(edge.from)!).push(edge);
    }

    const kindSummary = Object.entries(graph.stats.edgeKinds ?? {}).map(([kind, count]) => `${kind}:${count}`).join(" · ");
    const headerLines = [
      `repo map — ${graph.root.split("/").pop() || graph.root}  via ${graph.provider}`,
      `  ${graph.stats.files ?? 0} files · ${graph.stats.nodes} symbols · ${graph.stats.edges} edges` +
        (kindSummary ? `  (${kindSummary})` : "") + (graph.stats.truncated ? " · truncated" : ""),
      "",
    ];

    const relationSuffix = (id: string): string => {
      const edgesOut = relations.get(id) ?? [];
      if (!edgesOut.length) return "";
      const byKind = new Map<string, string[]>();
      for (const edge of edgesOut) {
        const target = nodesById.get(edge.to);
        const label = target ? (target.scope === "local" ? target.label : `${target.label} ⊗`) : edge.to;
        (byKind.get(edge.kind) ?? byKind.set(edge.kind, []).get(edge.kind)!).push(label);
      }
      const verbFor: Record<string, string> = { calls: "→ calls", extends: "extends", implements: "implements", references: "← refs" };
      const parts = [...byKind].map(([kind, labels]) => `${verbFor[kind] ?? kind} ${labels.slice(0, 6).join(", ")}${labels.length > 6 ? ", …" : ""}`);
      return "   " + parts.join("  ·  ");
    };

    const childrenOf = (id: string): GraphNode[] =>
      (containment.get(id) ?? []).map((childId) => nodesById.get(childId)).filter((node): node is GraphNode => !!node).sort((a, b) => a.location.line - b.location.line);

    const lines: string[] = [];
    const walk = (node: GraphNode, prefix: string, connector: string): void => {
      const kindTag = node.kind && node.kind !== "file" && node.kind !== node.label ? `${node.kind} ` : "";
      lines.push(`${prefix}${connector}${kindTag}${node.label}${relationSuffix(node.id)}`);
      const children = childrenOf(node.id);
      const childPrefix = prefix + (connector.startsWith("└") ? "   " : "│  ");
      children.forEach((child, index) => walk(child, childPrefix, index === children.length - 1 ? "└─ " : "├─ "));
    };

    for (const file of graph.nodes.filter((node) => node.kind === "file").sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(file.id);
      const children = childrenOf(file.id);
      children.forEach((child, index) => walk(child, "", index === children.length - 1 ? "└─ " : "├─ "));
      lines.push("");
    }
    return headerLines.concat(lines).join("\n");
  }

  /**
   * HTML view: the call graph drawn as an actual node-and-edge diagram — a self-contained, zero-dependency
   * interactive page. Every `graph.nodes` entry is a circle, every `graph.edges` entry a directed arrow, laid
   * out by an inline force-directed simulation (SVG + vanilla JS). Pan (drag background), zoom (wheel), drag a
   * node to pin it, hover to spotlight a node's callers/callees, and filter by name/file. This is the whole
   * point of `--html`: see the codebase as a graph of calls, not a list of collapsible rows. The entry is
   * accented, externals are amber, hubs scale with degree, and recursion shows as a self-loop. Returns a
   * complete HTML document (no external assets) ready to write to a file.
   */
  static callGraphHtml(trace: Trace): string {
    const graph = trace.data.graph as CodeGraph | undefined;
    if (!graph || !graph.nodes?.length) {
      const errorDiagnostic = trace.diagnostics.find((diagnostic) => diagnostic.level === "error");
      const message = errorDiagnostic ? `graph failed: ${errorDiagnostic.message}` : "graph — no nodes";
      return GraphView.htmlDoc("trace-cli graph", `<p class="empty">${GraphView.escapeHtml(message)}</p>`);
    }

    // The graph IS the data: no traversal/dedup here — nodes and edges go to the force renderer verbatim. Cycles
    // are just edges that close a loop; a recursive call is a self-edge. Entry is accented, externals are amber.
    const isRepo = graph.mode === "repo";
    const root = graph.nodes.find((node) => node.id === graph.entry);
    const repoName = graph.root.split("/").pop() || graph.root;
    const stats = isRepo
      ? `${graph.stats.files ?? 0} files · ${graph.stats.nodes} symbols · ${graph.stats.edges} edges` +
        (graph.stats.external ? ` · ${graph.stats.external} external` : "") + (graph.stats.truncated ? " · truncated" : "")
      : `${graph.stats.nodes} nodes · ${graph.stats.edges} edges · depth≤${graph.stats.maxDepth}` +
        (graph.stats.external ? ` · ${graph.stats.external} external` : "") + (graph.stats.truncated ? " · truncated" : "");
    return GraphView.forceGraphDoc(
      {
        title: isRepo ? `repo map — ${repoName}` : `graph — ${root?.label ?? graph.entry}`,
        h1: isRepo ? repoName : (root?.label ?? graph.entry),
        sub: isRepo ? `${graph.stats.files ?? 0} files · via ${graph.provider}` : `${root?.location.file ?? ""}${root?.location.line ? ":" + root.location.line : ""} · via ${graph.provider}`,
        stats,
        truncated: graph.stats.truncated ? (isRepo ? "repo map truncated — narrow with --entry <subdir>, or raise --max-files" : "graph truncated — raise --depth for more, or pick a more specific entry") : undefined,
      },
      {
        entry: graph.entry,
        nodes: graph.nodes.map((node) => ({ id: node.id, label: node.label, kind: node.kind, file: node.location.file, line: node.location.line, scope: node.scope })),
        edges: graph.edges.map((edge) => ({ from: edge.from, to: edge.to, weight: edge.weight ?? 1 })),
      },
    );
  }

  /**
   * HTML view of the module-import graph (`deps`) — the whole repo as a graph, reusing the call-graph's
   * force-directed renderer. Each module is a node, each import a directed edge (importer → imported). Module
   * paths are long, so the node label is the basename and the full path lives in the hover title. madge gives no
   * call counts, so every edge has weight 1.
   */
  static depsHtml(trace: Trace): string {
    const depGraph = trace.data.deps as DepGraph | undefined;
    if (!depGraph || !depGraph.nodes?.length) {
      const errorDiagnostic = trace.diagnostics.find((diagnostic) => diagnostic.level === "error");
      const message = errorDiagnostic ? `deps failed: ${errorDiagnostic.message}` : "deps — no modules";
      return GraphView.htmlDoc("trace-cli deps", `<p class="empty">${GraphView.escapeHtml(message)}</p>`);
    }
    const stats = `${depGraph.stats.modules} modules · ${depGraph.stats.edges} imports` + (depGraph.stats.circular ? ` · ${depGraph.stats.circular} circular` : "");
    return GraphView.forceGraphDoc(
      {
        title: `deps — ${depGraph.stats.modules} modules`,
        h1: "module graph",
        sub: `${depGraph.entry ?? ""} · via madge`,
        stats,
      },
      {
        entry: depGraph.entry ?? "",
        // label = basename for a readable node; full path goes in the hover title (file). All in-repo → "local".
        nodes: depGraph.nodes.map((node) => ({ id: node.id, label: node.id.split("/").pop() || node.id, kind: "module", file: node.id, line: 0, scope: "local" })),
        edges: depGraph.edges.map((edge) => ({ from: edge.from, to: edge.to, weight: 1 })),
      },
    );
  }

  /** HTML-escape a value for safe interpolation into page text/attributes. */
  private static escapeHtml(value: unknown): string {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /**
   * Shared force-graph page builder: serialize the payload safely, assemble the header/controls/SVG scaffold, and
   * wrap it in the self-contained document. Both the call graph and the module-import graph render through here —
   * one layout + interaction implementation, two data sources.
   */
  private static forceGraphDoc(meta: ForceMeta, payload: ForcePayload): string {
    // Inline JSON safely: neutralize "<" (so "</script>" can't terminate the block) and the JS line separators.
    const dataJson = JSON.stringify(payload)
      .replace(/</g, "\\u003c")
      .replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028")
      .replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");
    const truncated = meta.truncated ? `<div class="warn">${GraphView.escapeHtml(meta.truncated)}</div>` : "";
    const body =
      `<header>` +
        `<h1>${GraphView.escapeHtml(meta.h1)}</h1>` +
        `<div class="sub">${GraphView.escapeHtml(meta.sub)}</div>` +
        `<div class="stats">${GraphView.escapeHtml(meta.stats)}</div>` +
        truncated +
      `</header>` +
      `<div class="controls">` +
        `<button id="fit" type="button">fit</button>` +
        `<button id="relayout" type="button">re-layout</button>` +
        `<button id="freeze" type="button">freeze</button>` +
        `<input id="filter" type="search" placeholder="filter functions…">` +
        `<span class="legend"><i class="dot entry"></i>entry<i class="dot local"></i>local<i class="dot ext"></i>external<span class="hint">drag · scroll-zoom · hover</span></span>` +
      `</div>` +
      `<svg id="graph">` +
        `<defs>` +
          `<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrow" d="M0,0 L10,5 L0,10 z"></path></marker>` +
        `</defs>` +
        `<g id="viewport"><g id="edges"></g><g id="nodes"></g></g>` +
      `</svg>`;
    return GraphView.htmlDoc(meta.title, body, { style: GraphView.GRAPH_CSS, script: GraphView.GRAPH_JS.replace("__DATA__", () => dataJson) });
  }

  /**
   * Wrap a rendered body in a complete, self-contained HTML document. `extra.style` is appended after the base
   * chrome CSS and `extra.script` injected before </body> — the graph view passes the SVG styles + force-layout
   * JS this way, while the empty/error page uses neither.
   */
  private static htmlDoc(title: string, body: string, extra?: { style?: string; script?: string }): string {
    const escapedTitle = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapedTitle}</title>
<style>
${GraphView.HTML_BASE_CSS}${extra?.style ? "\n" + extra.style : ""}
</style>
</head>
<body>
${body}${extra?.script ? `\n<script>\n${extra.script}\n</script>` : ""}
</body>
</html>`;
  }

  /** Shared page chrome (header, controls, legend, empty state) — light/dark aware via the `--bg`/`--fg` vars. */
  private static readonly HTML_BASE_CSS = `  :root { color-scheme: light dark; --bg: #fbfbfd; --fg: #1d1d1f; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161618; --fg: #e6e6e8; } }
  body { font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin: 0; padding: 1.25rem 1.5rem; background: var(--bg); color: var(--fg); }
  header h1 { margin: 0; font-size: 1.15rem; }
  .sub { opacity: .7; margin-top: .2rem; }
  .stats { opacity: .55; margin-top: .15rem; font-size: .85em; }
  .warn { margin-top: .5rem; color: #b26a00; }
  .empty { opacity: .6; }
  .controls { margin: 1rem 0 .6rem; display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
  .controls button { font: inherit; cursor: pointer; border: 1px solid currentColor; background: transparent; color: inherit; opacity: .7; border-radius: 6px; padding: .2rem .6rem; }
  .controls button:hover { opacity: 1; }
  #filter { font: inherit; padding: .25rem .5rem; border: 1px solid #8884; border-radius: 6px; background: transparent; color: inherit; min-width: 14rem; }
  .legend { display: inline-flex; align-items: center; opacity: .7; font-size: .85em; margin-left: auto; }
  .legend .dot { width: .7rem; height: .7rem; border-radius: 50%; display: inline-block; margin: 0 .3rem 0 .7rem; }
  .legend .hint { margin-left: 1rem; opacity: .8; }
  .dot.entry { background: #e8543f; } .dot.local { background: #5b8def; } .dot.ext { background: #caa45a; }`;

  /** Graph-view styles: the SVG canvas, edges (arrows), and nodes (circles + labels) with hover/filter states. */
  private static readonly GRAPH_CSS = `  #graph { width: 100%; height: 76vh; border: 1px solid #8883; border-radius: 10px; touch-action: none; cursor: grab; display: block; overflow: hidden;
    background: radial-gradient(circle at 1px 1px, #8881 1px, transparent 0) 0 0 / 22px 22px, var(--bg); }
  #graph.grabbing { cursor: grabbing; }
  .edge { stroke: #8b94a3; stroke-opacity: .5; fill: none; }
  .edge.heavy { stroke-opacity: .8; }
  .arrow { fill: #8b94a3; }
  .node { cursor: pointer; }
  .node circle { fill: #5b8def; stroke: var(--bg); stroke-width: 1.5; }
  .node.entry circle { fill: #e8543f; }
  .node.ext circle { fill: #caa45a; }
  .node text { fill: var(--fg); font-size: 11px; paint-order: stroke; stroke: var(--bg); stroke-width: 3px; stroke-linejoin: round; opacity: .92; pointer-events: none; user-select: none; }
  .node.hl circle { stroke: var(--fg); stroke-width: 2.5; }
  .node.hl text { opacity: 1; font-weight: 600; }
  .node.faded { opacity: .12; }
  .edge.faded { stroke-opacity: .05; }
  .edge.hl { stroke: #e8543f; stroke-opacity: .95; }
  .node.dim { opacity: .16; }
  .node.match circle { stroke: #e8543f; stroke-width: 2.6; }
  .edge.dim { stroke-opacity: .04; }`;

  /**
   * Force-directed layout + interaction for the graph view, as a plain-JS IIFE (no build step, no deps). It
   * receives the node/edge payload at the `__DATA__` placeholder, builds the SVG, runs a cooling simulation
   * (repulsion + link springs + a gentle caller-above-callee bias), then idles. Intentionally template-free
   * (string concatenation, no backticks / ${}) so it embeds cleanly inside the document template literal.
   */
  private static readonly GRAPH_JS = `(function () {
  var graphData = __DATA__;
  var svgNamespace = "http://www.w3.org/2000/svg";
  var svg = document.getElementById("graph");
  var viewport = document.getElementById("viewport");
  var edgesGroup = document.getElementById("edges");
  var nodesGroup = document.getElementById("nodes");

  var nodes = graphData.nodes.map(function (node) {
    return { id: node.id, label: node.label, kind: node.kind, file: node.file, line: node.line, scope: node.scope, x: 0, y: 0, vx: 0, vy: 0, deg: 0 };
  });
  var nodesById = new Map(); nodes.forEach(function (node) { nodesById.set(node.id, node); });
  var edges = [];
  graphData.edges.forEach(function (edge) {
    var sourceNode = nodesById.get(edge.from), targetNode = nodesById.get(edge.to);
    if (!sourceNode || !targetNode) return;
    edges.push({ source: sourceNode, target: targetNode, weight: edge.weight || 1, self: sourceNode === targetNode });
    sourceNode.deg++; targetNode.deg++;
  });
  var neighbors = new Map(); nodes.forEach(function (node) { neighbors.set(node.id, new Set()); });
  edges.forEach(function (edge) { neighbors.get(edge.source.id).add(edge.target.id); neighbors.get(edge.target.id).add(edge.source.id); });

  var nodeCount = nodes.length;
  // Deterministic golden-angle spiral seed so the first frame is already spread out (no Math.random clump).
  nodes.forEach(function (node, index) {
    var angle = index * 2.399963, radius = 30 + 26 * Math.sqrt(index + 1);
    node.x = Math.cos(angle) * radius; node.y = Math.sin(angle) * radius;
  });
  var entryNode = nodesById.get(graphData.entry); if (entryNode) { entryNode.x = 0; entryNode.y = 0; }

  function radiusOf(node) { return 6 + Math.min(Math.sqrt(node.deg) * 2.4, 14); }

  edges.forEach(function (edge) {
    var element = document.createElementNS(svgNamespace, edge.self ? "path" : "line");
    element.setAttribute("class", "edge" + (edge.weight > 1 ? " heavy" : ""));
    element.setAttribute("marker-end", "url(#arrow)");
    element.style.strokeWidth = Math.min(1 + (edge.weight - 1) * 0.7, 4.5);
    edgesGroup.appendChild(element); edge.el = element;
  });
  nodes.forEach(function (node) {
    node.r = radiusOf(node);
    var group = document.createElementNS(svgNamespace, "g");
    group.setAttribute("class", "node" + (node.id === graphData.entry ? " entry" : "") + (node.scope !== "local" ? " ext" : ""));
    var circle = document.createElementNS(svgNamespace, "circle"); circle.setAttribute("r", node.r);
    var textNode = document.createElementNS(svgNamespace, "text"); textNode.setAttribute("x", node.r + 4); textNode.setAttribute("y", 4); textNode.textContent = node.label;
    var titleNode = document.createElementNS(svgNamespace, "title");
    var metaText = node.scope === "local" ? (node.file ? ("  " + node.file + (node.line ? ":" + node.line : "")) : "") : ("  external: " + node.scope);
    titleNode.textContent = node.label + metaText;
    group.appendChild(circle); group.appendChild(textNode); group.appendChild(titleNode);
    nodesGroup.appendChild(group); node.el = group;
    group.addEventListener("pointerdown", function (event) { startDrag(event, node); });
    group.addEventListener("mouseenter", function () { focus(node); });
    group.addEventListener("mouseleave", unfocus);
  });

  // --- cooling force simulation ---
  var alpha = 1, REP = 4200, LINK = 78, LINKK = 0.04, DIR = 0.06, CENTER = 0.012;
  var decay = nodeCount > 500 ? 0.965 : 0.99;
  function tick() {
    var indexA, indexB, nodeA, nodeB, deltaX, deltaY, distanceSquared, distance, force, unitX, unitY;
    for (indexA = 0; indexA < nodeCount; indexA++) {
      nodeA = nodes[indexA];
      for (indexB = indexA + 1; indexB < nodeCount; indexB++) {
        nodeB = nodes[indexB];
        deltaX = nodeA.x - nodeB.x; deltaY = nodeA.y - nodeB.y; distanceSquared = deltaX * deltaX + deltaY * deltaY;
        if (distanceSquared < 0.01) { deltaX = ((indexA * 13 + 7) % 17) - 8; deltaY = ((indexB * 7 + 3) % 17) - 8; distanceSquared = deltaX * deltaX + deltaY * deltaY + 0.01; }
        distance = Math.sqrt(distanceSquared); force = (REP / distanceSquared) * alpha; unitX = deltaX / distance; unitY = deltaY / distance;
        nodeA.vx += force * unitX; nodeA.vy += force * unitY; nodeB.vx -= force * unitX; nodeB.vy -= force * unitY;
      }
    }
    for (var edgeIndex = 0; edgeIndex < edges.length; edgeIndex++) {
      var edge = edges[edgeIndex]; if (edge.self) continue;
      deltaX = edge.target.x - edge.source.x; deltaY = edge.target.y - edge.source.y; distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY) || 0.01;
      force = (distance - LINK) * LINKK; unitX = deltaX / distance; unitY = deltaY / distance;
      edge.source.vx += force * unitX; edge.source.vy += force * unitY; edge.target.vx -= force * unitX; edge.target.vy -= force * unitY;
      var separation = (LINK - (edge.target.y - edge.source.y)) * DIR; edge.target.vy += separation; edge.source.vy -= separation; // callee below caller
    }
    for (indexA = 0; indexA < nodeCount; indexA++) { nodeA = nodes[indexA]; nodeA.vx -= nodeA.x * CENTER; nodeA.vy -= nodeA.y * CENTER; }
    for (indexA = 0; indexA < nodeCount; indexA++) {
      nodeA = nodes[indexA];
      if (nodeA.fixed) { nodeA.vx = 0; nodeA.vy = 0; continue; }
      nodeA.vx *= 0.84; nodeA.vy *= 0.84;
      var speed = Math.sqrt(nodeA.vx * nodeA.vx + nodeA.vy * nodeA.vy); if (speed > 30) { nodeA.vx = nodeA.vx / speed * 30; nodeA.vy = nodeA.vy / speed * 30; }
      nodeA.x += nodeA.vx; nodeA.y += nodeA.vy;
    }
    alpha *= decay;
  }

  function draw() {
    for (var edgeIndex = 0; edgeIndex < edges.length; edgeIndex++) {
      var edge = edges[edgeIndex];
      if (edge.self) {
        var node = edge.source, radius = node.r;
        edge.el.setAttribute("d", "M " + (node.x - radius * 0.6) + " " + (node.y - radius * 0.8) + " C " + (node.x - radius * 3.2) + " " + (node.y - radius * 4) + ", " + (node.x + radius * 3.2) + " " + (node.y - radius * 4) + ", " + (node.x + radius * 0.6) + " " + (node.y - radius * 0.8));
      } else {
        var deltaX = edge.target.x - edge.source.x, deltaY = edge.target.y - edge.source.y, distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY) || 1;
        var startX = edge.source.x + deltaX / distance * edge.source.r, startY = edge.source.y + deltaY / distance * edge.source.r;
        var endX = edge.target.x - deltaX / distance * (edge.target.r + 6), endY = edge.target.y - deltaY / distance * (edge.target.r + 6);
        edge.el.setAttribute("x1", startX); edge.el.setAttribute("y1", startY); edge.el.setAttribute("x2", endX); edge.el.setAttribute("y2", endY);
      }
    }
    for (var index = 0; index < nodeCount; index++) { var node = nodes[index]; node.el.setAttribute("transform", "translate(" + node.x + "," + node.y + ")"); }
  }

  // --- pan / zoom ---
  var view = { x: 0, y: 0, k: 1 };
  function applyView() { viewport.setAttribute("transform", "translate(" + view.x + "," + view.y + ") scale(" + view.k + ")"); }
  function size() { var rect = svg.getBoundingClientRect(); return { w: rect.width, h: rect.height, left: rect.left, top: rect.top }; }
  function fit() {
    if (!nodeCount) return;
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    nodes.forEach(function (node) { minX = Math.min(minX, node.x - node.r); minY = Math.min(minY, node.y - node.r); maxX = Math.max(maxX, node.x + node.r); maxY = Math.max(maxY, node.y + node.r); });
    var viewportSize = size(), padding = 70, graphWidth = Math.max(maxX - minX, 1), graphHeight = Math.max(maxY - minY, 1);
    var scale = Math.max(0.1, Math.min((viewportSize.w - padding) / graphWidth, (viewportSize.h - padding) / graphHeight, 2.2));
    view.k = scale; view.x = viewportSize.w / 2 - (minX + maxX) / 2 * scale; view.y = viewportSize.h / 2 - (minY + maxY) / 2 * scale;
    applyView();
  }

  var animationFrame = null, refitOnSettle = true;
  function loop() {
    if (alpha > 0.02) { tick(); draw(); animationFrame = requestAnimationFrame(loop); }
    else { draw(); if (refitOnSettle) { refitOnSettle = false; fit(); } animationFrame = null; }
  }
  function reheat(targetAlpha) { alpha = Math.max(alpha, targetAlpha || 0.6); if (!animationFrame) animationFrame = requestAnimationFrame(loop); }

  // --- interaction ---
  function screenToGraph(event) { var viewportSize = size(); return { x: (event.clientX - viewportSize.left - view.x) / view.k, y: (event.clientY - viewportSize.top - view.y) / view.k }; }
  var drag = null, pan = null;
  function startDrag(event, node) { event.stopPropagation(); event.preventDefault(); drag = { n: node }; node.fixed = true; svg.setPointerCapture(event.pointerId); svg.classList.add("grabbing"); }
  svg.addEventListener("pointerdown", function (event) {
    if (drag) return;
    pan = { px: event.clientX, py: event.clientY, ox: view.x, oy: view.y }; svg.setPointerCapture(event.pointerId); svg.classList.add("grabbing");
  });
  svg.addEventListener("pointermove", function (event) {
    if (drag) { var point = screenToGraph(event); drag.n.x = point.x; drag.n.y = point.y; drag.n.vx = 0; drag.n.vy = 0; reheat(0.3); draw(); }
    else if (pan) { view.x = pan.ox + (event.clientX - pan.px); view.y = pan.oy + (event.clientY - pan.py); applyView(); }
  });
  function endPtr() { if (drag) { drag.n.fixed = false; drag = null; } pan = null; svg.classList.remove("grabbing"); }
  svg.addEventListener("pointerup", endPtr);
  svg.addEventListener("pointercancel", endPtr);
  svg.addEventListener("wheel", function (event) {
    event.preventDefault();
    var viewportSize = size(), pointerX = event.clientX - viewportSize.left, pointerY = event.clientY - viewportSize.top;
    var nextScale = Math.max(0.08, Math.min(view.k * Math.exp(-event.deltaY * 0.0015), 4));
    view.x = pointerX - (pointerX - view.x) * (nextScale / view.k); view.y = pointerY - (pointerY - view.y) * (nextScale / view.k); view.k = nextScale; applyView();
  }, { passive: false });

  // --- hover spotlight + name/file filter ---
  function focus(node) {
    if (drag || pan) return;
    var neighborIds = neighbors.get(node.id);
    nodes.forEach(function (other) { var isOn = (other === node) || neighborIds.has(other.id); other.el.classList.toggle("faded", !isOn); other.el.classList.toggle("hl", other === node); });
    edges.forEach(function (edge) { var isOn = (edge.source === node || edge.target === node); edge.el.classList.toggle("faded", !isOn); edge.el.classList.toggle("hl", isOn); });
  }
  function unfocus() { nodes.forEach(function (node) { node.el.classList.remove("faded", "hl"); }); edges.forEach(function (edge) { edge.el.classList.remove("faded", "hl"); }); }
  function doFilter(query) {
    query = (query || "").trim().toLowerCase();
    if (!query) { nodes.forEach(function (node) { node.el.classList.remove("dim", "match"); }); edges.forEach(function (edge) { edge.el.classList.remove("dim"); }); return; }
    var matched = new Set();
    nodes.forEach(function (node) {
      var isHit = (node.label + " " + (node.file || "") + " " + (node.scope || "")).toLowerCase().indexOf(query) >= 0;
      node.el.classList.toggle("match", isHit); node.el.classList.toggle("dim", !isHit); if (isHit) matched.add(node.id);
    });
    edges.forEach(function (edge) { edge.el.classList.toggle("dim", !(matched.has(edge.source.id) && matched.has(edge.target.id))); });
  }

  document.getElementById("fit").addEventListener("click", fit);
  document.getElementById("relayout").addEventListener("click", function () { refitOnSettle = true; reheat(1); });
  var frozen = false;
  document.getElementById("freeze").addEventListener("click", function (event) {
    frozen = !frozen; event.target.textContent = frozen ? "resume" : "freeze";
    if (frozen) { alpha = 0; } else { reheat(0.4); }
  });
  document.getElementById("filter").addEventListener("input", function (event) { doFilter(event.target.value); });

  var initialSize = size(); view.x = initialSize.w / 2; view.y = initialSize.h / 2; applyView();
  reheat(1);
})();`;
}
