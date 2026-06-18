import type { Trace } from "../../domain/Trace.js";
import type { CodeGraph, GraphEdge, GraphNode } from "../../codegraph/CodeGraphProvider.js";

/**
 * graphView — the human + HTML presentation of a built call graph, split out of {@link GraphCommand} so the
 * command stays a thin use-case (build the graph, stamp the envelope) and the rendering (a text flow-tree and
 * a self-contained interactive SVG page, ~250 lines of CSS/JS strings) lives on its own. Pure functions of the
 * graph/trace — no IO, no command state.
 */

const esc = (s: unknown): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Text view: the call graph unrolled into a flow tree, with shared callees, cycles and externals marked. A
 * traversal over the normalized graph — a node reached twice is marked `→ shared` and a back-edge `↻ cycle`
 * rather than re-expanded, so the tree terminates on recursion.
 */
export function renderGraphTree(graph: CodeGraph): string {
  const byId = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));
  const adj = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e);

  const root = byId.get(graph.entry);
  const head = [
    `graph — ${root?.label ?? graph.entry}  (${root?.loc.file}:${root?.loc.line})  via ${graph.provider}`,
    `  ${graph.stats.nodes} nodes · ${graph.stats.edges} edges · depth≤${graph.stats.maxDepth}` +
      (graph.stats.external ? ` · ${graph.stats.external} external` : "") +
      (graph.stats.truncated ? " · truncated" : ""),
    "",
  ];

  const lines: string[] = [];
  const onPath = new Set<string>();
  const emitted = new Set<string>();

  const label = (n: GraphNode, weight?: number): string => {
    const w = weight && weight > 1 ? ` ×${weight}` : "";
    if (n.scope !== "local") return `${n.label}  ⊗ ${n.scope}${w}`;
    return `${n.label}  ${n.loc.file}:${n.loc.line}${w}`;
  };

  const walk = (id: string, prefix: string, connector: string, weight: number | undefined): void => {
    const n = byId.get(id);
    if (!n) return;
    const cycle = onPath.has(id);
    const kids = adj.get(id) ?? [];
    const shared = emitted.has(id) && kids.length > 0;
    const tag = cycle ? "  ↻ cycle" : shared ? "  → shared" : "";
    lines.push(`${prefix}${connector}${label(n, weight)}${tag}`);
    if (cycle || shared) return; // back-edge / already-expanded: reference only, don't recurse
    emitted.add(id);
    onPath.add(id);
    const childPrefix = connector ? prefix + (connector.startsWith("└") ? "   " : "│  ") : prefix;
    kids.forEach((e, i) => {
      const last = i === kids.length - 1;
      walk(e.to, childPrefix, last ? "└─ " : "├─ ", e.weight);
    });
    onPath.delete(id);
  };

  walk(graph.entry, "", "", undefined);
  return head.concat(lines).join("\n");
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
export function renderGraphHtml(trace: Trace): string {
  const graph = trace.data.graph as CodeGraph | undefined;
  if (!graph || !graph.nodes?.length) {
    const err = trace.diagnostics.find((d) => d.level === "error");
    const msg = err ? `graph failed: ${err.message}` : "graph — no nodes";
    return htmlDoc("trace-cli graph", `<p class="empty">${esc(msg)}</p>`);
  }

  // The graph IS the data: no traversal/dedup here — nodes and edges go to the page verbatim and the
  // force layout positions them. Cycles are just edges that close a loop; a recursive call is a self-edge.
  const payload = {
    entry: graph.entry,
    nodes: graph.nodes.map((n) => ({ id: n.id, label: n.label, kind: n.kind, file: n.loc.file, line: n.loc.line, scope: n.scope })),
    edges: graph.edges.map((e) => ({ from: e.from, to: e.to, weight: e.weight ?? 1 })),
  };
  // Inline JSON safely: neutralize "<" (so "</script>" can't terminate the block) and the JS line separators.
  const dataJson = JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028")
    .replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");

  const root = graph.nodes.find((n) => n.id === graph.entry);
  const stats =
    `${graph.stats.nodes} nodes · ${graph.stats.edges} edges · depth≤${graph.stats.maxDepth}` +
    (graph.stats.external ? ` · ${graph.stats.external} external` : "") +
    (graph.stats.truncated ? " · truncated" : "");
  const truncated = graph.stats.truncated
    ? `<div class="warn">graph truncated — raise --depth for more, or pick a more specific entry</div>`
    : "";

  const body =
    `<header>` +
      `<h1>${esc(root?.label ?? graph.entry)}</h1>` +
      `<div class="sub">${esc(root?.loc.file ?? "")}${root?.loc.line ? ":" + root.loc.line : ""} · via ${esc(graph.provider)}</div>` +
      `<div class="stats">${esc(stats)}</div>` +
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

  return htmlDoc(`graph — ${root?.label ?? graph.entry}`, body, {
    style: GRAPH_CSS,
    script: GRAPH_JS.replace("__DATA__", () => dataJson),
  });
}

/**
 * Wrap a rendered body in a complete, self-contained HTML document. `extra.style` is appended after the base
 * chrome CSS and `extra.script` injected before </body> — the graph view passes the SVG styles + force-layout
 * JS this way, while the empty/error page uses neither.
 */
function htmlDoc(title: string, body: string, extra?: { style?: string; script?: string }): string {
  const t = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<style>
${HTML_BASE_CSS}${extra?.style ? "\n" + extra.style : ""}
</style>
</head>
<body>
${body}${extra?.script ? `\n<script>\n${extra.script}\n</script>` : ""}
</body>
</html>`;
}

/** Shared page chrome (header, controls, legend, empty state) — light/dark aware via the `--bg`/`--fg` vars. */
const HTML_BASE_CSS = `  :root { color-scheme: light dark; --bg: #fbfbfd; --fg: #1d1d1f; }
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
const GRAPH_CSS = `  #graph { width: 100%; height: 76vh; border: 1px solid #8883; border-radius: 10px; touch-action: none; cursor: grab; display: block; overflow: hidden;
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
const GRAPH_JS = `(function () {
  var DATA = __DATA__;
  var NS = "http://www.w3.org/2000/svg";
  var svg = document.getElementById("graph");
  var vp = document.getElementById("viewport");
  var gE = document.getElementById("edges");
  var gN = document.getElementById("nodes");

  var nodes = DATA.nodes.map(function (n) {
    return { id: n.id, label: n.label, kind: n.kind, file: n.file, line: n.line, scope: n.scope, x: 0, y: 0, vx: 0, vy: 0, deg: 0 };
  });
  var idx = new Map(); nodes.forEach(function (n) { idx.set(n.id, n); });
  var edges = [];
  DATA.edges.forEach(function (e) {
    var s = idx.get(e.from), t = idx.get(e.to);
    if (!s || !t) return;
    edges.push({ source: s, target: t, weight: e.weight || 1, self: s === t });
    s.deg++; t.deg++;
  });
  var nbr = new Map(); nodes.forEach(function (n) { nbr.set(n.id, new Set()); });
  edges.forEach(function (e) { nbr.get(e.source.id).add(e.target.id); nbr.get(e.target.id).add(e.source.id); });

  var N = nodes.length;
  // Deterministic golden-angle spiral seed so the first frame is already spread out (no Math.random clump).
  nodes.forEach(function (n, i) {
    var a = i * 2.399963, r = 30 + 26 * Math.sqrt(i + 1);
    n.x = Math.cos(a) * r; n.y = Math.sin(a) * r;
  });
  var entry = idx.get(DATA.entry); if (entry) { entry.x = 0; entry.y = 0; }

  function rOf(n) { return 6 + Math.min(Math.sqrt(n.deg) * 2.4, 14); }

  edges.forEach(function (e) {
    var el = document.createElementNS(NS, e.self ? "path" : "line");
    el.setAttribute("class", "edge" + (e.weight > 1 ? " heavy" : ""));
    el.setAttribute("marker-end", "url(#arrow)");
    el.style.strokeWidth = Math.min(1 + (e.weight - 1) * 0.7, 4.5);
    gE.appendChild(el); e.el = el;
  });
  nodes.forEach(function (n) {
    n.r = rOf(n);
    var g = document.createElementNS(NS, "g");
    g.setAttribute("class", "node" + (n.id === DATA.entry ? " entry" : "") + (n.scope !== "local" ? " ext" : ""));
    var c = document.createElementNS(NS, "circle"); c.setAttribute("r", n.r);
    var tx = document.createElementNS(NS, "text"); tx.setAttribute("x", n.r + 4); tx.setAttribute("y", 4); tx.textContent = n.label;
    var ti = document.createElementNS(NS, "title");
    ti.textContent = n.label + (n.scope === "local" ? ("  " + n.file + ":" + n.line) : ("  external: " + n.scope));
    g.appendChild(c); g.appendChild(tx); g.appendChild(ti);
    gN.appendChild(g); n.el = g;
    g.addEventListener("pointerdown", function (ev) { startDrag(ev, n); });
    g.addEventListener("mouseenter", function () { focus(n); });
    g.addEventListener("mouseleave", unfocus);
  });

  // --- cooling force simulation ---
  var alpha = 1, REP = 4200, LINK = 78, LINKK = 0.04, DIR = 0.06, CENTER = 0.012;
  var decay = N > 500 ? 0.965 : 0.99;
  function tick() {
    var i, j, a, b, dx, dy, d2, d, f, ux, uy;
    for (i = 0; i < N; i++) {
      a = nodes[i];
      for (j = i + 1; j < N; j++) {
        b = nodes[j];
        dx = a.x - b.x; dy = a.y - b.y; d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = ((i * 13 + 7) % 17) - 8; dy = ((j * 7 + 3) % 17) - 8; d2 = dx * dx + dy * dy + 0.01; }
        d = Math.sqrt(d2); f = (REP / d2) * alpha; ux = dx / d; uy = dy / d;
        a.vx += f * ux; a.vy += f * uy; b.vx -= f * ux; b.vy -= f * uy;
      }
    }
    for (var k = 0; k < edges.length; k++) {
      var e = edges[k]; if (e.self) continue;
      dx = e.target.x - e.source.x; dy = e.target.y - e.source.y; d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      f = (d - LINK) * LINKK; ux = dx / d; uy = dy / d;
      e.source.vx += f * ux; e.source.vy += f * uy; e.target.vx -= f * ux; e.target.vy -= f * uy;
      var sep = (LINK - (e.target.y - e.source.y)) * DIR; e.target.vy += sep; e.source.vy -= sep; // callee below caller
    }
    for (i = 0; i < N; i++) { a = nodes[i]; a.vx -= a.x * CENTER; a.vy -= a.y * CENTER; }
    for (i = 0; i < N; i++) {
      a = nodes[i];
      if (a.fixed) { a.vx = 0; a.vy = 0; continue; }
      a.vx *= 0.84; a.vy *= 0.84;
      var sp = Math.sqrt(a.vx * a.vx + a.vy * a.vy); if (sp > 30) { a.vx = a.vx / sp * 30; a.vy = a.vy / sp * 30; }
      a.x += a.vx; a.y += a.vy;
    }
    alpha *= decay;
  }

  function draw() {
    for (var k = 0; k < edges.length; k++) {
      var e = edges[k];
      if (e.self) {
        var n = e.source, r = n.r;
        e.el.setAttribute("d", "M " + (n.x - r * 0.6) + " " + (n.y - r * 0.8) + " C " + (n.x - r * 3.2) + " " + (n.y - r * 4) + ", " + (n.x + r * 3.2) + " " + (n.y - r * 4) + ", " + (n.x + r * 0.6) + " " + (n.y - r * 0.8));
      } else {
        var dx = e.target.x - e.source.x, dy = e.target.y - e.source.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
        var sx = e.source.x + dx / d * e.source.r, sy = e.source.y + dy / d * e.source.r;
        var tx = e.target.x - dx / d * (e.target.r + 6), ty = e.target.y - dy / d * (e.target.r + 6);
        e.el.setAttribute("x1", sx); e.el.setAttribute("y1", sy); e.el.setAttribute("x2", tx); e.el.setAttribute("y2", ty);
      }
    }
    for (var m = 0; m < N; m++) { var nn = nodes[m]; nn.el.setAttribute("transform", "translate(" + nn.x + "," + nn.y + ")"); }
  }

  // --- pan / zoom ---
  var view = { x: 0, y: 0, k: 1 };
  function applyView() { vp.setAttribute("transform", "translate(" + view.x + "," + view.y + ") scale(" + view.k + ")"); }
  function size() { var r = svg.getBoundingClientRect(); return { w: r.width, h: r.height, left: r.left, top: r.top }; }
  function fit() {
    if (!N) return;
    var minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    nodes.forEach(function (n) { minx = Math.min(minx, n.x - n.r); miny = Math.min(miny, n.y - n.r); maxx = Math.max(maxx, n.x + n.r); maxy = Math.max(maxy, n.y + n.r); });
    var s = size(), pad = 70, gw = Math.max(maxx - minx, 1), gh = Math.max(maxy - miny, 1);
    var k = Math.max(0.1, Math.min((s.w - pad) / gw, (s.h - pad) / gh, 2.2));
    view.k = k; view.x = s.w / 2 - (minx + maxx) / 2 * k; view.y = s.h / 2 - (miny + maxy) / 2 * k;
    applyView();
  }

  var raf = null, refitOnSettle = true;
  function loop() {
    if (alpha > 0.02) { tick(); draw(); raf = requestAnimationFrame(loop); }
    else { draw(); if (refitOnSettle) { refitOnSettle = false; fit(); } raf = null; }
  }
  function reheat(a) { alpha = Math.max(alpha, a || 0.6); if (!raf) raf = requestAnimationFrame(loop); }

  // --- interaction ---
  function screenToGraph(ev) { var s = size(); return { x: (ev.clientX - s.left - view.x) / view.k, y: (ev.clientY - s.top - view.y) / view.k }; }
  var drag = null, pan = null;
  function startDrag(ev, n) { ev.stopPropagation(); ev.preventDefault(); drag = { n: n }; n.fixed = true; svg.setPointerCapture(ev.pointerId); svg.classList.add("grabbing"); }
  svg.addEventListener("pointerdown", function (ev) {
    if (drag) return;
    pan = { px: ev.clientX, py: ev.clientY, ox: view.x, oy: view.y }; svg.setPointerCapture(ev.pointerId); svg.classList.add("grabbing");
  });
  svg.addEventListener("pointermove", function (ev) {
    if (drag) { var p = screenToGraph(ev); drag.n.x = p.x; drag.n.y = p.y; drag.n.vx = 0; drag.n.vy = 0; reheat(0.3); draw(); }
    else if (pan) { view.x = pan.ox + (ev.clientX - pan.px); view.y = pan.oy + (ev.clientY - pan.py); applyView(); }
  });
  function endPtr() { if (drag) { drag.n.fixed = false; drag = null; } pan = null; svg.classList.remove("grabbing"); }
  svg.addEventListener("pointerup", endPtr);
  svg.addEventListener("pointercancel", endPtr);
  svg.addEventListener("wheel", function (ev) {
    ev.preventDefault();
    var s = size(), mx = ev.clientX - s.left, my = ev.clientY - s.top;
    var nk = Math.max(0.08, Math.min(view.k * Math.exp(-ev.deltaY * 0.0015), 4));
    view.x = mx - (mx - view.x) * (nk / view.k); view.y = my - (my - view.y) * (nk / view.k); view.k = nk; applyView();
  }, { passive: false });

  // --- hover spotlight + name/file filter ---
  function focus(n) {
    if (drag || pan) return;
    var keep = nbr.get(n.id);
    nodes.forEach(function (m) { var on = (m === n) || keep.has(m.id); m.el.classList.toggle("faded", !on); m.el.classList.toggle("hl", m === n); });
    edges.forEach(function (e) { var on = (e.source === n || e.target === n); e.el.classList.toggle("faded", !on); e.el.classList.toggle("hl", on); });
  }
  function unfocus() { nodes.forEach(function (m) { m.el.classList.remove("faded", "hl"); }); edges.forEach(function (e) { e.el.classList.remove("faded", "hl"); }); }
  function doFilter(q) {
    q = (q || "").trim().toLowerCase();
    if (!q) { nodes.forEach(function (n) { n.el.classList.remove("dim", "match"); }); edges.forEach(function (e) { e.el.classList.remove("dim"); }); return; }
    var matched = new Set();
    nodes.forEach(function (n) {
      var hit = (n.label + " " + (n.file || "") + " " + (n.scope || "")).toLowerCase().indexOf(q) >= 0;
      n.el.classList.toggle("match", hit); n.el.classList.toggle("dim", !hit); if (hit) matched.add(n.id);
    });
    edges.forEach(function (e) { e.el.classList.toggle("dim", !(matched.has(e.source.id) && matched.has(e.target.id))); });
  }

  document.getElementById("fit").addEventListener("click", fit);
  document.getElementById("relayout").addEventListener("click", function () { refitOnSettle = true; reheat(1); });
  var frozen = false;
  document.getElementById("freeze").addEventListener("click", function (ev) {
    frozen = !frozen; ev.target.textContent = frozen ? "resume" : "freeze";
    if (frozen) { alpha = 0; } else { reheat(0.4); }
  });
  document.getElementById("filter").addEventListener("input", function (ev) { doFilter(ev.target.value); });

  var s0 = size(); view.x = s0.w / 2; view.y = s0.h / 2; applyView();
  reheat(1);
})();`;
