// The same business logic as test/servers/{node-api,python-api}, in a plain .ts module (no JSX). Vite/
// esbuild transforms .ts → JS with a line-accurate source map, so a `trace dynamic --chrome` breakpoint
// here resolves cleanly back to price.ts — exactly the compiled-TS source-map path the engine handles.

const DISCOUNTS: Record<string, number> = { SAVE10: 0.10, HALF: 0.5 };

export function priceFor(qty: number, unit: number, code: string) {
  const subtotal = qty * unit;
  const rate = DISCOUNTS[code] ?? 0;
  const total = subtotal * (1 - rate);            // ← breakpoint target
  return { subtotal, rate, total: Math.round(total * 100) / 100 };
}
