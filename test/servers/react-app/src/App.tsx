// A React component traced via the Chrome (CDP) target. The traceable price logic lives in ./price.ts so
// its breakpoint resolves through a clean esbuild source map; App.tsx just renders the result.

import { priceFor } from "./price";

export function App({ qty, code }: { qty: number; code: string }) {
  const { subtotal, rate, total } = priceFor(qty, 9.99, code);
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 40 }}>
      <h1>Price</h1>
      <p>qty {qty} · code {code}</p>
      <p>subtotal {subtotal} · rate {rate} · <b>total {total}</b></p>
    </div>
  );
}
