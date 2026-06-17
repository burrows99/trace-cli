import type { NextConfig } from "next";

/**
 * Static export — `next build` emits a self-contained `out/` (HTML/CSS/JS) with no Node server.
 * The trace collector (src/collector/Collector.ts) serves that `out/` at `/` alongside the
 * /api/* + SSE endpoints, so `trace serve` stays a single process. All data is fetched
 * client-side from those endpoints, so no SSR/route-handler features are used here.
 */
const nextConfig: NextConfig = {
  output: "export",
  // Single-page app: keep clean asset paths (no per-route .html rewrites needed).
  trailingSlash: false,
  // No next/image optimizer at runtime in a static export.
  images: { unoptimized: true },
  // This app is nested inside trace-cli (which has its own lockfile); pin the root
  // to this dir so Turbopack doesn't infer the parent workspace.
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
