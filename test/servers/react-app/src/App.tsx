// Checkout cart rendered via React, traced through Chrome (CDP). The displayed total is computed by the
// buggy displayTotal() in ./price.ts, so the trace shows the cents being dropped per line item.

import React from "react";          // explicit import → classic JSX runtime works regardless of dev pre-bundling
import { displayTotal, type Line } from "./price";

const CART: Line[] = [
  { sku: "widget", qty: 2, lineTotal: 19.98 },
  { sku: "gadget", qty: 1, lineTotal: 24.50 },
  { sku: "trinket", qty: 3, lineTotal: 7.50 },
];

export function App() {
  const shown = displayTotal(CART);
  const correct = CART.reduce((s, i) => s + i.lineTotal, 0);
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 40 }}>
      <h1>Checkout</h1>
      <ul>
        {CART.map((it) => (
          <li key={it.sku}>{it.sku} ×{it.qty} — ${it.lineTotal.toFixed(2)}</li>
        ))}
      </ul>
      <p>
        <b>Total: ${shown}</b>{" "}
        <span style={{ color: "#c0392b" }}>(should be ${correct.toFixed(2)})</span>
      </p>
    </div>
  );
}
