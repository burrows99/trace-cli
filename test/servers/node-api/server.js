// A tiny zero-dependency Node API to trace. Run under the inspector and point `trace dynamic --node` at it:
//
//   node --inspect=9229 test/servers/node-api/server.js
//   trace dynamic --node \
//     --curl 'curl -s "http://localhost:3000/price?qty=3&code=SAVE10"' \
//     --bp test/servers/node-api/server.js@'const total' \
//     --expr 'rate' --expr 'subtotal'
//
// The business logic mirrors test/servers/python-api/server.py line-for-line so the SAME trace shape works
// across languages — a demo of protocol-pluggable, language-agnostic backend tracing (CDP here, DAP there).

import { createServer } from "node:http";

const DISCOUNTS = { SAVE10: 0.10, HALF: 0.5 };

function discount(code) {
  return DISCOUNTS[code] ?? 0;
}

function priceFor(qty, unit, code) {
  const subtotal = qty * unit;
  const rate = discount(code);
  const total = subtotal * (1 - rate);
  return { subtotal, rate, total: Math.round(total * 100) / 100 };
}

// A loop that accumulates a cart total — `total` MUTATES across iterations. Breakpoint the inner line with
// --max-hits and watch `total`/`count` to see mutation lineage (value-over-time), e.g.:
//   trace dynamic --node <port> --max-hits 10 \
//     --curl 'curl -s "http://127.0.0.1:3100/cart?items=9.99,4.50,2.00"' \
//     --bp "test/servers/node-api/server.js@total = total + price" --expr total --expr count
function cartTotal(prices) {
  let total = 0;
  let count = 0;
  for (const price of prices) {
    total = total + price;          // ← breakpoint: hits once per item, total grows each time
    count = count + 1;
  }
  return { total: Math.round(total * 100) / 100, count };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/price") {
    const qty = Number(url.searchParams.get("qty") || 1);
    const code = url.searchParams.get("code") || "";
    const result = priceFor(qty, 9.99, code);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
    return;
  }
  if (url.pathname === "/cart") {
    const prices = (url.searchParams.get("items") || "9.99,4.50,2.00").split(",").map(Number);
    const result = cartTotal(prices);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.error(`[node-api] http://localhost:${port}`));
