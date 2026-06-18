import path from "node:path";
import type { NextConfig } from "next";

/**
 * Hosted dashboard — `output: "standalone"` emits a self-contained Node server (`.next/standalone/.../server.js`)
 * that serves the UI *and* the same-origin API (app/api/*: sessions, the SSE stream, and /v1/traces ingest).
 * This single process supersedes the old node:http collector. Route Handlers reuse the CLI's SessionStore +
 * Trace via the `trace-cli/server` subpath export — hence:
 *   - both the Turbopack root and outputFileTracingRoot are pinned to the repo root so module resolution (dev)
 *     and file tracing (build) reach the `trace-cli` package — symlinked into ui/node_modules at build time
 *     (see package.json `build:ui`) — and trace its node-only deps (`pg`, …) into the standalone output.
 *   - serverExternalPackages keeps node-only / decorator-heavy packages external (not bundled by Turbopack).
 */
const REPO_ROOT = path.join(import.meta.dirname, "..");

/**
 * Content-Security-Policy. `'unsafe-inline'` on script/style is required without a nonce pipeline (Next's
 * hydration bootstrap + React inline-style attributes); tighten to nonces via middleware later. `media-src`
 * stays origin-broad because trace recordings stream from S3/MinIO whose host is runtime-configurable
 * (S3_PUBLIC_URL) and `headers()` is evaluated at build time.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' https: http: blob:",
  "connect-src 'self'", // same-origin fetch + SSE
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: REPO_ROOT,
  // `trace-cli` is our own (tsc-compiled) code — let Turbopack bundle it into the server so there's no
  // runtime `require("trace-cli")` to resolve from the symlinked node_modules. Its native / decorator-heavy
  // transitive deps stay external (don't bundle: pg does dynamic requires; class-validator/-transformer +
  // reflect-metadata rely on runtime decorator metadata).
  serverExternalPackages: [
    "pg",
    "class-validator",
    "class-transformer",
    "reflect-metadata",
    "@aws-sdk/client-s3",
  ],
  poweredByHeader: false,
  // The app + its `file:..` trace-cli dep span the repo; pin Turbopack's root there (silences multi-lockfile
  // inference and lets the parent package resolve).
  turbopack: { root: REPO_ROOT },
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      // Disable proxy/server buffering so the SSE stream flushes immediately (see self-hosting guide).
      { source: "/api/stream", headers: [{ key: "X-Accel-Buffering", value: "no" }] },
    ];
  },
};

export default nextConfig;
