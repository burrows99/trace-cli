// Interactive checkout cart, traced through Chrome (CDP). The displayed total is computed by the buggy
// displayTotal() in ./price.ts (parseInt drops the cents), so the trace shows the cents going missing per
// line item. Each "Add" button re-renders → re-runs displayTotal → re-fires the breakpoint, so a scripted
// journey can drive the bug live and watch it compound as items pile up.

import React, { useState } from "react";
import { displayTotal, type Line } from "./price";

const BASE_CART: Line[] = [
  { sku: "widget", qty: 2, lineTotal: 19.98 },
  { sku: "gadget", qty: 1, lineTotal: 24.50 },
  { sku: "trinket", qty: 3, lineTotal: 7.50 },
];

// Add-ons the journey clicks in. Each has fat cents, so the parseInt bug visibly widens the gap.
const ADDONS: Record<string, Line> = {
  headphones: { sku: "headphones", qty: 1, lineTotal: 99.95 },
  cables: { sku: "cables", qty: 3, lineTotal: 14.97 },
};

const money = (n: number) => `$${n.toFixed(2)}`;

export function App() {
  const [cart, setCart] = useState<Line[]>(BASE_CART);
  const add = (key: keyof typeof ADDONS) => setCart((c) => (c.some((l) => l.sku === key) ? c : [...c, ADDONS[key]]));

  const shown = displayTotal(cart);                              // ← BUG: parseInt(lineTotal) drops the cents
  const correct = cart.reduce((s, i) => s + i.lineTotal, 0);
  const lost = correct - shown;

  return (
    <div style={S.page}>
      <div style={S.card}>
        <div style={S.brand}>ACME&nbsp;STORE</div>
        <h1 style={S.h1}>Checkout</h1>

        <ul style={S.list}>
          {cart.map((it) => (
            <li key={it.sku} style={S.li}>
              <span>{it.sku} <span style={S.qty}>× {it.qty}</span></span>
              <span style={S.price}>{money(it.lineTotal)}</span>
            </li>
          ))}
        </ul>

        <div style={S.actions}>
          <button style={S.btn} onClick={() => add("headphones")}>Add headphones — {money(ADDONS.headphones.lineTotal)}</button>
          <button style={S.btn} onClick={() => add("cables")}>Add cables — {money(ADDONS.cables.lineTotal)}</button>
        </div>

        <div style={S.totalRow}>
          <span style={S.totalLabel}>Total</span>
          <span style={S.totalValue}>${shown}</span>
        </div>
        <div style={S.warn}>
          should be {money(correct)} — <b>off by {money(lost)}</b>
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(160deg,#eef2f7,#dbe4ee)", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", padding: 28, boxSizing: "border-box" },
  card: { width: "100%", maxWidth: 560, background: "#fff", borderRadius: 20, boxShadow: "0 20px 60px rgba(20,40,80,.18)", padding: "40px 44px" },
  brand: { color: "#8a94a6", fontSize: 13, fontWeight: 700, letterSpacing: ".22em" },
  h1: { margin: "6px 0 26px", fontSize: 40, fontWeight: 800, color: "#16202e" },
  list: { listStyle: "none", margin: 0, padding: 0, borderTop: "1px solid #eef1f5" },
  li: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 2px", borderBottom: "1px solid #eef1f5", fontSize: 21, color: "#2b3645" },
  qty: { color: "#9aa4b2", fontSize: 17 },
  price: { fontVariantNumeric: "tabular-nums", color: "#1d6fe0", fontWeight: 600 },
  actions: { display: "flex", gap: 12, margin: "26px 0 30px" },
  btn: { flex: 1, padding: "14px 12px", fontSize: 16, fontWeight: 600, color: "#fff", background: "#1d6fe0", border: 0, borderRadius: 12, cursor: "pointer", boxShadow: "0 6px 16px rgba(29,111,224,.3)" },
  totalRow: { display: "flex", justifyContent: "space-between", alignItems: "baseline", paddingTop: 14, borderTop: "2px solid #16202e" },
  totalLabel: { fontSize: 24, fontWeight: 700, color: "#16202e" },
  totalValue: { fontSize: 46, fontWeight: 800, color: "#16202e", fontVariantNumeric: "tabular-nums" },
  warn: { marginTop: 10, textAlign: "right", color: "#c0392b", fontSize: 19, fontWeight: 500 },
};
