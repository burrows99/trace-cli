// Node order-API / BFF for the end-to-end demo. It validates a cart, applies a coupon, computes tax, and
// returns the order total. Several bugs are planted on purpose so the tracer has something to reveal — see
// the BUG comments. Run under the inspector:
//   PORT=3100 node --inspect=9230 test/servers/node-api/server.js
import { createServer } from "node:http";

const CATALOG = {
  widget: { price: 9.99, stock: 100 },
  gadget: { price: 24.5, stock: 3 },
  gizmo: { price: 4.0, stock: 0 },          // out of stock
};
const COUPONS = { SAVE10: 0.10, HALF: 0.5, VIP: 0.2 };

// ---- original price demo (kept) ---------------------------------------------------------------
const DISCOUNTS = { SAVE10: 0.10, HALF: 0.5 };
function discount(code) { return DISCOUNTS[code] ?? 0; }
function priceFor(qty, unit, code) {
  const subtotal = qty * unit;
  const rate = discount(code);
  const total = subtotal * (1 - rate);
  return { subtotal, rate, total: Math.round(total * 100) / 100 };
}
function cartTotal(prices) {
  let total = 0;
  let count = 0;
  for (const price of prices) {
    total = total + price;
    count = count + 1;
  }
  return { total: Math.round(total * 100) / 100, count };
}

// ---- order pipeline (the e2e demo) ------------------------------------------------------------

// lineItems(cart): cart is ["widget:2", "gadget:1"] → priced line items. Throws on an unknown sku.
function lineItems(cart) {
  const items = [];
  for (const part of cart) {
    const [sku, qtyStr] = part.split(":");
    const product = CATALOG[sku];
    if (!product) throw new Error(`unknown sku: ${sku}`);
    const qty = Number(qtyStr || 1);
    const lineTotal = product.price * qty;
    items.push({ sku, qty, price: product.price, lineTotal });
  }
  return items;
}

// applyCoupon(subtotal, code): BUG — subtracts the discount RATE as a flat dollar amount instead of a
// percentage. A $44.48 cart with SAVE10 should drop $4.45, but this only takes off $0.10.
function applyCoupon(subtotal, code) {
  const rate = COUPONS[code] || 0;
  const discounted = subtotal - rate;          // BUG: should be subtotal * (1 - rate)
  return { rate, discounted: Math.round(discounted * 100) / 100 };
}

// taxFor(amount, region): local tax table. Throws on an unknown region (→ 502 cascade in /checkout).
const RATES = { US: 0.07, EU: 0.20, CA: 0.12 };
function taxFor(amount, region) {
  const rate = RATES[region];                  // unknown region → undefined → throws below
  if (rate === undefined) throw new Error(`unknown region: ${region}`);
  return Math.round(amount * rate * 100) / 100;
}

function checkout(cart, coupon, region) {
  const items = lineItems(cart);
  let subtotal = 0;
  for (const it of items) {
    subtotal += it.lineTotal;          // own line → breakpoint here hits once per item (mutation lineage)
  }
  const { rate, discounted } = applyCoupon(subtotal, coupon);
  const tax = taxFor(discounted, region);
  const total = Math.round((discounted + tax) * 100) / 100;
  return { items, subtotal, rate, discounted, tax, total };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const json = (code, obj) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };

  if (url.pathname === "/price") {
    const qty = Number(url.searchParams.get("qty") || 1);
    const code = url.searchParams.get("code") || "";
    return json(200, priceFor(qty, 9.99, code));
  }
  if (url.pathname === "/cart") {
    const prices = (url.searchParams.get("items") || "9.99,4.50,2.00").split(",").map(Number);
    return json(200, cartTotal(prices));
  }
  if (url.pathname === "/checkout") {
    const cart = (url.searchParams.get("cart") || "widget:2,gadget:1").split(",");
    const coupon = url.searchParams.get("coupon") || "";
    const region = url.searchParams.get("region") || "US";
    try { return json(200, checkout(cart, coupon, region)); }
    catch (e) { return json(502, { error: e.message }); }   // cascades an unknown-region failure
  }
  json(404, { error: "not found" });
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.error(`[node-api] http://localhost:${port}`));
